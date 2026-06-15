// xorein Crowd mode: epoch-based sender-keyed broadcast E2EE.
// Byte-compatible with Go oracle: pkg/v0_1/mode/crowd/crowd.go.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { deriveKey } from '../seal/kdf.js';

const LABEL_CROWD_EPOCH_ROOT = 'xorein/crowd/v1/epoch-root';
const LABEL_CROWD_SENDER_KEY = 'xorein/crowd/v1/sender-key'; // append peerID

export const MAX_EPOCH_MESSAGES = 1000;
export const EPOCH_TTL_MS = 7 * 24 * 3600 * 1000;
export const LEGACY_WINDOW_SIZE = 2;

// ── Types ──────────────────────────────────────────────────────────────────

export interface CrowdEpoch {
  epochId: number;
  epochRoot: Uint8Array; // 32 B
  senderKeys: Map<string, Uint8Array>; // peerID → 32-B ChaCha key
  messageCount: number;
  startedAt: number; // ms
}

export interface CrowdState {
  scopeId: string;
  currentEpoch: CrowdEpoch;
  prevEpochs: CrowdEpoch[];
}

export interface CrowdCiphertext {
  epochId: number;
  senderId: string;
  nonce: Uint8Array; // 12 B
  ct: Uint8Array;    // ChaCha20-Poly1305 ciphertext + 16-B tag
}

// ── Group creation ─────────────────────────────────────────────────────────

export function newCrowdGroup(scopeId: string): CrowdState {
  const root = crypto.getRandomValues(new Uint8Array(32));
  return {
    scopeId,
    currentEpoch: epochFromRoot(root, 0),
    prevEpochs: [],
  };
}

/**
 * Construct a CrowdState from a SHARED epoch root distributed out-of-band to all
 * members (over the authenticated P2P join stream). Every member that seeds the
 * same root derives identical per-sender keys, enabling broadcast E2EE without
 * the support node ever seeing the root or any plaintext.
 */
export function newCrowdGroupFromRoot(scopeId: string, root: Uint8Array): CrowdState {
  return {
    scopeId,
    currentEpoch: epochFromRoot(root, 0),
    prevEpochs: [],
  };
}

// ── Key derivation ─────────────────────────────────────────────────────────

/** Derive the next epoch root from the current root (deterministic rotation). */
export function deriveEpochRoot(current: Uint8Array): Uint8Array {
  return deriveKey(current, null, LABEL_CROWD_EPOCH_ROOT, 32);
}

/** Derive a per-sender key from the epoch root. */
export function deriveSenderKey(epochRoot: Uint8Array, peerId: string): Uint8Array {
  return deriveKey(epochRoot, null, LABEL_CROWD_SENDER_KEY + peerId, 32);
}

/** Register (pre-derive) a sender key in the current epoch. */
export function addSender(g: CrowdState, peerId: string): void {
  const sk = deriveSenderKey(g.currentEpoch.epochRoot, peerId);
  g.currentEpoch.senderKeys.set(peerId, sk);
}

/** Rotate epoch on membership change using a FRESH random root (spec 13 §6.2). */
export function rotateEpochMembership(g: CrowdState): void {
  const freshRoot = crypto.getRandomValues(new Uint8Array(32));
  const nextId = g.currentEpoch.epochId + 1;
  g.prevEpochs = [g.currentEpoch, ...g.prevEpochs].slice(0, LEGACY_WINDOW_SIZE);
  g.currentEpoch = epochFromRoot(freshRoot, nextId);
}

// ── Encryption / decryption ────────────────────────────────────────────────

/** Encrypt a message with the sender's ChaCha20-Poly1305 key. Auto-rotates epoch if needed. */
export function crowdEncrypt(g: CrowdState, senderId: string, plaintext: Uint8Array): CrowdCiphertext {
  if (needsRotation(g.currentEpoch)) rotateEpochDeterministic(g);

  let sk = g.currentEpoch.senderKeys.get(senderId);
  if (!sk) { sk = deriveSenderKey(g.currentEpoch.epochRoot, senderId); }

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = epochAAD(g.currentEpoch.epochId, senderId);
  const aead = chacha20poly1305(sk, nonce, aad);
  const ct = aead.encrypt(plaintext);
  g.currentEpoch.messageCount++;
  return { epochId: g.currentEpoch.epochId, senderId, nonce, ct };
}

/** Decrypt a Crowd mode ciphertext. */
export function crowdDecrypt(g: CrowdState, ct: CrowdCiphertext): Uint8Array {
  const epoch = findEpoch(g, ct.epochId);
  if (!epoch) throw new Error('crowd: epoch expired or not found');
  let sk = epoch.senderKeys.get(ct.senderId);
  if (!sk) { sk = deriveSenderKey(epoch.epochRoot, ct.senderId); }
  const aad = epochAAD(ct.epochId, ct.senderId);
  const aead = chacha20poly1305(sk, ct.nonce, aad);
  return aead.decrypt(ct.ct);
}

// ── Internal ───────────────────────────────────────────────────────────────

function epochFromRoot(root: Uint8Array, epochId: number): CrowdEpoch {
  return { epochId, epochRoot: new Uint8Array(root), senderKeys: new Map(), messageCount: 0, startedAt: Date.now() };
}

function rotateEpochDeterministic(g: CrowdState): void {
  const nextRoot = deriveEpochRoot(g.currentEpoch.epochRoot);
  const nextId = g.currentEpoch.epochId + 1;
  g.prevEpochs = [g.currentEpoch, ...g.prevEpochs].slice(0, LEGACY_WINDOW_SIZE);
  g.currentEpoch = epochFromRoot(nextRoot, nextId);
}

function needsRotation(e: CrowdEpoch): boolean {
  return e.messageCount >= MAX_EPOCH_MESSAGES || Date.now() - e.startedAt > EPOCH_TTL_MS;
}

function findEpoch(g: CrowdState, epochId: number): CrowdEpoch | null {
  if (g.currentEpoch.epochId === epochId) return g.currentEpoch;
  for (const e of g.prevEpochs) { if (e.epochId === epochId) return e; }
  return null;
}

function epochAAD(epochId: number, senderId: string): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, Math.floor(epochId / 2 ** 32), false);
  view.setUint32(4, epochId >>> 0, false);
  const sender = new TextEncoder().encode(senderId);
  const out = new Uint8Array(8 + sender.length);
  out.set(buf, 0); out.set(sender, 8);
  return out;
}
