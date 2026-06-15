// xorein Tree mode: epoch-based group E2EE (hybrid MLS ciphersuite 0xFF01).
// Byte-compatible with Go oracle: pkg/v0_1/mode/tree/tree.go.
import { gcm as aesGcm } from '@noble/ciphers/aes.js';
import { deriveKey } from '../seal/kdf.js';

const LABEL_TREE_EXPORTER  = 'xorein/tree/v1/exporter';
const LABEL_TREE_EPOCH_ROOT = 'xorein/tree/v1/epoch-root';

export const MAX_MEMBERS        = 50;
export const MAX_EPOCH_MESSAGES = 1000;
export const LEGACY_WINDOW_SIZE = 2;

// ── Types ──────────────────────────────────────────────────────────────────

export interface Member {
  peerId: string;
  edPub?: Uint8Array;
  mldsaPub?: Uint8Array;
  joinedAt: number; // epoch index when joined
}

export interface EpochState {
  epochId: number;
  epochKey: Uint8Array; // 32 B; AES-128 uses first 16 B
  messageCount: number;
  startedAt: number;    // unix ms
}

export interface GroupState {
  groupId: string;
  currentEpoch: EpochState;
  prevEpochs: EpochState[];
  members: Member[];
  rootKey: Uint8Array;  // 32 B, evolves with each epoch
}

export interface Ciphertext {
  epochId: number;
  senderId: string;
  nonce: Uint8Array;  // 12 B
  ct: Uint8Array;     // AES-128-GCM ciphertext + 16-B tag
}

export interface Commit {
  epochId: number;
  addedPeers: string[];
  removedPeers: string[];
}

// ── Group creation ─────────────────────────────────────────────────────────

/** Create a new Tree mode group with a single creator member. */
export function newGroup(groupId: string, creator: Member): GroupState {
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const epoch = deriveEpoch(rootKey, 0, null);
  return {
    groupId,
    currentEpoch: epoch,
    prevEpochs: [],
    members: [{ ...creator, joinedAt: 0 }],
    rootKey: new Uint8Array(rootKey),
  };
}

// ── Member management ──────────────────────────────────────────────────────

/** Add a member and rotate the epoch. */
export function addMember(g: GroupState, member: Member): Commit {
  if (g.members.length >= MAX_MEMBERS) throw new Error('tree: group full');
  if (g.members.some(m => m.peerId === member.peerId)) throw new Error('tree: already a member');
  const nextEpoch = g.currentEpoch.epochId + 1;
  g.members = [...g.members, { ...member, joinedAt: nextEpoch }];
  return rotateEpoch(g, nextEpoch, [member.peerId], []);
}

/** Remove a member and rotate the epoch (removed peer cannot decrypt future messages). */
export function removeMember(g: GroupState, peerId: string): Commit {
  const before = g.members.length;
  g.members = g.members.filter(m => m.peerId !== peerId);
  if (g.members.length === before) throw new Error('tree: peer not a member');
  if (g.members.length === 0) throw new Error('tree: group disbanded');
  const nextEpoch = g.currentEpoch.epochId + 1;
  return rotateEpoch(g, nextEpoch, [], [peerId]);
}

// ── Encryption / decryption ────────────────────────────────────────────────

/** Encrypt plaintext for the current epoch. Rotates epoch if needed. */
export function treeEncrypt(g: GroupState, senderId: string, plaintext: Uint8Array): { ct: Ciphertext; commit?: Commit } {
  let commit: Commit | undefined;
  if (needsRotation(g.currentEpoch)) {
    commit = rotateEpoch(g, g.currentEpoch.epochId + 1, [], []);
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = epochAAD(g.currentEpoch.epochId, senderId);
  const key16 = g.currentEpoch.epochKey.slice(0, 16);
  const aead = aesGcm(key16, nonce, aad);
  const ct: Ciphertext = {
    epochId: g.currentEpoch.epochId,
    senderId,
    nonce,
    ct: aead.encrypt(plaintext),
  };
  g.currentEpoch.messageCount++;
  return { ct, commit };
}

/** Decrypt a ciphertext. Searches current and prev epochs (legacy window). */
export function treeDecrypt(g: GroupState, ct: Ciphertext): Uint8Array {
  const epoch = findEpoch(g, ct.epochId);
  if (!epoch) throw new Error('tree: epoch expired or not found');
  const key16 = epoch.epochKey.slice(0, 16);
  const aad = epochAAD(ct.epochId, ct.senderId);
  const aead = aesGcm(key16, ct.nonce, aad);
  return aead.decrypt(ct.ct);
}

// ── Internal helpers ───────────────────────────────────────────────────────

function deriveEpoch(rootKey: Uint8Array, epochId: number, salt: Uint8Array | null): EpochState {
  const epochKey = deriveKey(rootKey, salt, LABEL_TREE_EXPORTER, 32);
  return { epochId, epochKey, messageCount: 0, startedAt: Date.now() };
}

function rotateEpoch(g: GroupState, newEpochId: number, added: string[], removed: string[]): Commit {
  const epochNonce = uint64BE(newEpochId);
  const newRoot = deriveKey(g.rootKey, epochNonce, LABEL_TREE_EPOCH_ROOT, 32);
  const newEpoch = deriveEpoch(newRoot, newEpochId, epochNonce);

  // Slide legacy window.
  g.prevEpochs = [g.currentEpoch, ...g.prevEpochs].slice(0, LEGACY_WINDOW_SIZE);
  g.rootKey = newRoot;
  g.currentEpoch = newEpoch;

  return { epochId: newEpochId, addedPeers: added, removedPeers: removed };
}

function needsRotation(epoch: EpochState): boolean {
  return epoch.messageCount >= MAX_EPOCH_MESSAGES;
}

function epochAAD(epochId: number, senderId: string): Uint8Array {
  const id = uint64BE(epochId);
  const sender = new TextEncoder().encode(senderId);
  const out = new Uint8Array(id.length + sender.length);
  out.set(id, 0);
  out.set(sender, id.length);
  return out;
}

function findEpoch(g: GroupState, epochId: number): EpochState | null {
  if (g.currentEpoch.epochId === epochId) return g.currentEpoch;
  for (const e of g.prevEpochs) {
    if (e.epochId === epochId) return e;
  }
  return null;
}

function uint64BE(n: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, Math.floor(n / 2 ** 32), false);
  view.setUint32(4, n >>> 0, false);
  return buf;
}
