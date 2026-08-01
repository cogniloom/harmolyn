// Xorein Tree mode: custom bounded epoch-based group E2EE. This data plane is
// not an RFC 9420 MLS implementation.
// Byte-compatible with Go oracle: pkg/v0_1/mode/tree/tree.go.
import { gcm as aesGcm } from '@noble/ciphers/aes.js';
import { deriveKey } from '../seal/kdf.js';

const LABEL_TREE_EXPORTER  = 'xorein/tree/v1/exporter';
const LABEL_TREE_EPOCH_ROOT = 'xorein/tree/v1/epoch-root';

export const MAX_MEMBERS        = 50;
export const MAX_EPOCH_MESSAGES = 1000;
export const LEGACY_WINDOW_SIZE = 2;
const MAX_ID_BYTES = 256;
const MAX_PLAINTEXT_BYTES = 1 << 20;

// ── Types ──────────────────────────────────────────────────────────────────

export interface Member {
  peerId: string;
  edPub?: Uint8Array;
  mldsaPub?: Uint8Array;
  joinedAt: number; // epoch index when joined
}

export interface EpochState {
  epochId: number;
  epochKey: Uint8Array; // 32 B; used in full by AES-256-GCM
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
  ct: Uint8Array;     // AES-256-GCM ciphertext + 16-B tag
}

export interface Commit {
  epochId: number;
  addedPeers: string[];
  removedPeers: string[];
}

// ── Group creation ─────────────────────────────────────────────────────────

/** Create a new Tree mode group with a single creator member. */
export function newGroup(groupId: string, creator: Member): GroupState {
  if (!validId(groupId) || !validMember(creator)) throw new Error('tree: invalid group or creator');
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

/**
 * Construct a Tree data-plane state from the owner-distributed shared epoch
 * root. Membership authorization remains in the signed server roster; this
 * state only performs channel payload encryption/decryption.
 */
export function newGroupFromRoot(groupId: string, root: Uint8Array, epochId = 0): GroupState {
  if (!validId(groupId) || root.length !== 32 || !Number.isSafeInteger(epochId) || epochId < 0) {
    throw new Error('tree: invalid external epoch root');
  }
  const epoch = deriveEpoch(root, epochId, epochId === 0 ? null : uint64BE(epochId));
  return {
    groupId,
    currentEpoch: epoch,
    prevEpochs: [],
    members: [],
    rootKey: new Uint8Array(root),
  };
}

// ── Member management ──────────────────────────────────────────────────────

/** Add a member and rotate the epoch. */
export function addMember(g: GroupState, member: Member): Commit {
  assertGroupState(g);
  if (!validMember(member)) throw new Error('tree: invalid member');
  if (g.members.length >= MAX_MEMBERS) throw new Error('tree: group full');
  if (g.members.some(m => m.peerId === member.peerId)) throw new Error('tree: already a member');
  const nextEpoch = checkedNextEpoch(g.currentEpoch.epochId);
  const newRoot = deriveKey(g.rootKey, uint64BE(nextEpoch), LABEL_TREE_EPOCH_ROOT, 32);
  const newEpoch = deriveEpoch(newRoot, nextEpoch, uint64BE(nextEpoch));
  g.members = [...g.members, cloneMember({ ...member, joinedAt: nextEpoch })];
  installDerivedEpoch(g, newRoot, newEpoch);
  return { epochId: nextEpoch, addedPeers: [member.peerId], removedPeers: [] };
}

/**
 * Remove a member and rotate the epoch with a FRESH random root.
 *
 * FORWARD SECRECY: the removed peer holds the current `rootKey`, and every
 * derivation-based rotation (`HKDF(rootKey, epochId)`) is computable from it
 * offline, forever. So a membership-removal rotation must NOT derive — it mints
 * fresh entropy the removed peer never sees (mirrors Crowd's
 * `rotateEpochMembership`, spec 13 §6.2). The returned `epochRoot` is SECRET key
 * material: the caller must distribute it to the REMAINING members over the
 * authenticated E2EE channel (never to the removed peer, never in the plaintext
 * Commit); they apply it with `installEpochRoot(g, commit.epochId, epochRoot)`.
 */
export function removeMember(g: GroupState, peerId: string): { commit: Commit; epochRoot: Uint8Array } {
  assertGroupState(g);
  if (!validId(peerId)) throw new Error('tree: invalid peer id');
  const nextMembers = g.members.filter(m => m.peerId !== peerId).map(cloneMember);
  if (nextMembers.length === g.members.length) throw new Error('tree: peer not a member');
  if (nextMembers.length === 0) throw new Error('tree: group disbanded');
  const nextEpoch = checkedNextEpoch(g.currentEpoch.epochId);
  const freshRoot = crypto.getRandomValues(new Uint8Array(32));
  const nextState = deriveEpoch(freshRoot, nextEpoch, uint64BE(nextEpoch));
  g.members = nextMembers;
  installDerivedEpoch(g, freshRoot, nextState);
  return { commit: { epochId: nextEpoch, addedPeers: [], removedPeers: [peerId] }, epochRoot: freshRoot };
}

/**
 * Install an EXTERNALLY-supplied epoch root (received from the remover over the
 * authenticated channel after a membership-removal rotation) as the new current
 * epoch. Monotonic: an epoch not strictly newer than the current one is ignored,
 * so a replayed or stale rotation can neither roll the group back nor desync it.
 * The previous epoch stays in the legacy window so in-flight messages under it
 * still decrypt.
 */
export function installEpochRoot(g: GroupState, epochId: number, root: Uint8Array): void {
  assertGroupState(g);
  if (root.length !== 32 || !Number.isSafeInteger(epochId) || epochId < 0) {
    throw new Error('tree: invalid external epoch root');
  }
  if (epochId <= g.currentEpoch.epochId) return; // stale / duplicate — never roll back
  g.prevEpochs = [g.currentEpoch, ...g.prevEpochs].slice(0, LEGACY_WINDOW_SIZE);
  g.rootKey = new Uint8Array(root);
  g.currentEpoch = deriveEpoch(g.rootKey, epochId, uint64BE(epochId));
}

// ── Encryption / decryption ────────────────────────────────────────────────

/** Encrypt plaintext for the current epoch. Rotates epoch if needed. */
export function treeEncrypt(g: GroupState, senderId: string, plaintext: Uint8Array): { ct: Ciphertext; commit?: Commit } {
  assertMessageInput(g, senderId, plaintext);
  let commit: Commit | undefined;
  if (needsRotation(g.currentEpoch)) {
    commit = rotateEpoch(g, g.currentEpoch.epochId + 1, [], []);
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = epochAAD(g.groupId, g.currentEpoch.epochId, senderId);
  const aead = aesGcm(g.currentEpoch.epochKey, nonce, aad);
  const ct: Ciphertext = {
    epochId: g.currentEpoch.epochId,
    senderId,
    nonce,
    ct: aead.encrypt(plaintext),
  };
  g.currentEpoch.messageCount++;
  return { ct, commit };
}

/**
 * Encrypt without a local count-based epoch rotation.
 *
 * A broadcast group has no globally consistent per-process message counter:
 * if each sender independently rotated after 1,000 local messages, peers would
 * derive different roots and silently desynchronize. Harmolyn therefore uses
 * owner-authored fresh-root rotations and this managed-epoch send primitive.
 */
export function treeEncryptManaged(g: GroupState, senderId: string, plaintext: Uint8Array): Ciphertext {
  assertMessageInput(g, senderId, plaintext);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = epochAAD(g.groupId, g.currentEpoch.epochId, senderId);
  const aead = aesGcm(g.currentEpoch.epochKey, nonce, aad);
  const ct: Ciphertext = {
    epochId: g.currentEpoch.epochId,
    senderId,
    nonce,
    ct: aead.encrypt(plaintext),
  };
  g.currentEpoch.messageCount++;
  return ct;
}

/** Decrypt a ciphertext. Searches current and prev epochs (legacy window). */
export function treeDecrypt(g: GroupState, ct: Ciphertext): Uint8Array {
  assertGroupState(g);
  if (!validCiphertext(ct)) throw new Error('tree: invalid ciphertext');
  const epoch = findEpoch(g, ct.epochId);
  if (!epoch) throw new Error('tree: epoch expired or not found');
  if (epoch.epochKey.length !== 32) throw new Error('tree: invalid epoch key');
  const aad = epochAAD(g.groupId, ct.epochId, ct.senderId);
  const aead = aesGcm(epoch.epochKey, ct.nonce, aad);
  return aead.decrypt(ct.ct);
}

// ── Internal helpers ───────────────────────────────────────────────────────

function deriveEpoch(rootKey: Uint8Array, epochId: number, salt: Uint8Array | null): EpochState {
  const epochKey = deriveKey(rootKey, salt, LABEL_TREE_EXPORTER, 32);
  return { epochId, epochKey, messageCount: 0, startedAt: Date.now() };
}

/**
 * Derivation-based rotation: next root = HKDF(current root). ONLY safe when no
 * member was removed — anyone holding the current root can compute every future
 * derived root, so membership REMOVALS must go through the fresh-random-root path
 * in `removeMember` instead. Used for member adds (the added peer receives the
 * post-add state and cannot invert HKDF to read pre-add epochs) and for
 * count-based rotations where membership is unchanged.
 */
function rotateEpoch(g: GroupState, newEpochId: number, added: string[], removed: string[]): Commit {
  assertGroupState(g);
  if (newEpochId !== checkedNextEpoch(g.currentEpoch.epochId)) throw new Error('tree: invalid epoch progression');
  const epochNonce = uint64BE(newEpochId);
  const newRoot = deriveKey(g.rootKey, epochNonce, LABEL_TREE_EPOCH_ROOT, 32);
  const newEpoch = deriveEpoch(newRoot, newEpochId, epochNonce);

  installDerivedEpoch(g, newRoot, newEpoch);

  return { epochId: newEpochId, addedPeers: added, removedPeers: removed };
}

function needsRotation(epoch: EpochState): boolean {
  return epoch.messageCount >= MAX_EPOCH_MESSAGES;
}

function epochAAD(groupId: string, epochId: number, senderId: string): Uint8Array {
  const prefix = new TextEncoder().encode('xorein/tree/v2/message\0');
  const group = new TextEncoder().encode(groupId);
  const sender = new TextEncoder().encode(senderId);
  return concat(prefix, uint16BE(group.length), group, uint64BE(epochId), uint16BE(sender.length), sender);
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

function uint16BE(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n, false);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function validId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || containsControl(value)) return false;
  return new TextEncoder().encode(value).length <= MAX_ID_BYTES;
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validMember(member: Member): boolean {
  return !!member && validId(member.peerId) && Number.isSafeInteger(member.joinedAt) && member.joinedAt >= 0
    && (member.edPub === undefined || member.edPub.length === 32)
    && (member.mldsaPub === undefined || member.mldsaPub.length === 1952);
}

function cloneMember(member: Member): Member {
  return {
    ...member,
    ...(member.edPub ? { edPub: new Uint8Array(member.edPub) } : {}),
    ...(member.mldsaPub ? { mldsaPub: new Uint8Array(member.mldsaPub) } : {}),
  };
}

function assertGroupState(g: GroupState): void {
  if (!g || !validId(g.groupId) || !g.currentEpoch || g.rootKey.length !== 32
    || g.currentEpoch.epochKey.length !== 32 || !Number.isSafeInteger(g.currentEpoch.epochId)
    || g.currentEpoch.epochId < 0 || g.prevEpochs.length > LEGACY_WINDOW_SIZE
    || g.members.length > MAX_MEMBERS || !g.members.every(validMember)) {
    throw new Error('tree: invalid group state');
  }
}

function assertMessageInput(g: GroupState, senderId: string, plaintext: Uint8Array): void {
  assertGroupState(g);
  if (!validId(senderId) || !isByteArray(plaintext) || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error('tree: invalid message');
  }
}

function validCiphertext(ct: Ciphertext): boolean {
  return !!ct && Number.isSafeInteger(ct.epochId) && ct.epochId >= 0 && validId(ct.senderId)
    && isByteArray(ct.nonce) && ct.nonce.length === 12
    && isByteArray(ct.ct) && ct.ct.length >= 16 && ct.ct.length <= MAX_PLAINTEXT_BYTES + 16;
}

function isByteArray(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function checkedNextEpoch(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error('tree: epoch counter exhausted');
  }
  return current + 1;
}

function installDerivedEpoch(g: GroupState, root: Uint8Array, epoch: EpochState): void {
  g.prevEpochs = [g.currentEpoch, ...g.prevEpochs].slice(0, LEGACY_WINDOW_SIZE);
  g.rootKey = new Uint8Array(root);
  g.currentEpoch = epoch;
}
