// xorein Crowd mode: epoch-based sender-keyed broadcast E2EE.
// Byte-compatible with Go oracle: pkg/v0_1/mode/crowd/crowd.go.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { deriveKey } from '../seal/kdf.js';

const LABEL_CROWD_EPOCH_ROOT = 'xorein/crowd/v1/epoch-root';
const LABEL_CROWD_SENDER_KEY = 'xorein/crowd/v1/sender-key'; // append peerID

export const MAX_EPOCH_MESSAGES = 1000;
export const EPOCH_TTL_MS = 7 * 24 * 3600 * 1000;
export const LEGACY_WINDOW_SIZE = 2;
const MAX_ID_BYTES = 256;
const MAX_PLAINTEXT_BYTES = 1 << 20;

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
  if (!validId(scopeId)) throw new Error('crowd: invalid scope id');
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
 *
 * `epochId` lets a late joiner start at the group's CURRENT epoch (the one the
 * owner advertises alongside the root) rather than always at 0, so their message
 * epoch ids line up with everyone else's.
 */
export function newCrowdGroupFromRoot(scopeId: string, root: Uint8Array, epochId = 0): CrowdState {
  if (!validId(scopeId) || root.length !== 32 || !Number.isSafeInteger(epochId) || epochId < 0) {
    throw new Error('crowd: invalid external epoch root');
  }
  return {
    scopeId,
    currentEpoch: epochFromRoot(root, epochId),
    prevEpochs: [],
  };
}

// ── Key derivation ─────────────────────────────────────────────────────────

/** Derive the next epoch root from the current root (deterministic rotation). */
export function deriveEpochRoot(current: Uint8Array): Uint8Array {
  if (current.length !== 32) throw new Error('crowd: invalid epoch root');
  return deriveKey(current, null, LABEL_CROWD_EPOCH_ROOT, 32);
}

/** Derive a per-sender key from the epoch root. */
export function deriveSenderKey(epochRoot: Uint8Array, peerId: string): Uint8Array {
  if (epochRoot.length !== 32 || !validId(peerId)) throw new Error('crowd: invalid sender key input');
  return deriveKey(epochRoot, null, LABEL_CROWD_SENDER_KEY + peerId, 32);
}

/** Register (pre-derive) a sender key in the current epoch. */
export function addSender(g: CrowdState, peerId: string): void {
  assertCrowdState(g);
  const sk = deriveSenderKey(g.currentEpoch.epochRoot, peerId);
  g.currentEpoch.senderKeys.set(peerId, sk);
}

/** Rotate epoch on membership change using a FRESH random root (spec 13 §6.2). */
export function rotateEpochMembership(g: CrowdState): void {
  assertCrowdState(g);
  const freshRoot = crypto.getRandomValues(new Uint8Array(32));
  const nextId = g.currentEpoch.epochId + 1;
  g.prevEpochs = [g.currentEpoch, ...g.prevEpochs].slice(0, LEGACY_WINDOW_SIZE);
  g.currentEpoch = epochFromRoot(freshRoot, nextId);
}

/**
 * Install an EXTERNALLY-supplied epoch root (received from the owner over the
 * authenticated sync stream) as the new current epoch. Idempotent and monotonic:
 * a root whose epoch is not strictly newer than the installed one is ignored, so a
 * replayed or stale rotation cannot roll the group back or desync it. The previous
 * epoch is retained in the legacy window so in-flight messages under it still
 * decrypt. This is the ONLY way a membership rotation reaches remaining members —
 * the owner mints a fresh root, bumps the epoch, and broadcasts both.
 */
export function installEpochRoot(g: CrowdState, root: Uint8Array, epochId: number): void {
  assertCrowdState(g);
  if (root.length !== 32 || !Number.isSafeInteger(epochId) || epochId < 0) {
    throw new Error('crowd: invalid external epoch root');
  }
  if (epochId <= g.currentEpoch.epochId) return; // stale / duplicate — never roll back
  g.prevEpochs = [g.currentEpoch, ...g.prevEpochs].slice(0, LEGACY_WINDOW_SIZE);
  g.currentEpoch = epochFromRoot(root, epochId);
}

// ── Encryption / decryption ────────────────────────────────────────────────

/**
 * Encrypt a message with the sender's ChaCha20-Poly1305 key.
 *
 * NOTE: epoch rotation is OWNER-DRIVEN only (installEpochRoot on membership change),
 * never automatic. A per-instance count/TTL rotation would derive a new root that
 * no other member learns — each member counts only its own sends — so peers would
 * silently desync after ~1000 messages. Rotation therefore happens exclusively via
 * the synchronized `crowd_root`/`crowd_epoch` the owner broadcasts.
 */
export function crowdEncrypt(g: CrowdState, senderId: string, plaintext: Uint8Array): CrowdCiphertext {
  assertCrowdState(g);
  if (!validId(senderId) || !isByteArray(plaintext) || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error('crowd: invalid message');
  }
  let sk = g.currentEpoch.senderKeys.get(senderId);
  if (!sk) { sk = deriveSenderKey(g.currentEpoch.epochRoot, senderId); }

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = epochAAD(g.scopeId, g.currentEpoch.epochId, senderId);
  const aead = chacha20poly1305(sk, nonce, aad);
  const ct = aead.encrypt(plaintext);
  g.currentEpoch.messageCount++;
  return { epochId: g.currentEpoch.epochId, senderId, nonce, ct };
}

/** Decrypt a Crowd mode ciphertext. */
export function crowdDecrypt(g: CrowdState, ct: CrowdCiphertext): Uint8Array {
  assertCrowdState(g);
  if (!validCiphertext(ct)) throw new Error('crowd: invalid ciphertext');
  const epoch = findEpoch(g, ct.epochId);
  if (!epoch) throw new Error('crowd: epoch expired or not found');
  let sk = epoch.senderKeys.get(ct.senderId);
  if (!sk) { sk = deriveSenderKey(epoch.epochRoot, ct.senderId); }
  if (sk.length !== 32) throw new Error('crowd: invalid sender key');
  const aad = epochAAD(g.scopeId, ct.epochId, ct.senderId);
  const aead = chacha20poly1305(sk, ct.nonce, aad);
  return aead.decrypt(ct.ct);
}

// ── Internal ───────────────────────────────────────────────────────────────

function epochFromRoot(root: Uint8Array, epochId: number): CrowdEpoch {
  if (root.length !== 32 || !Number.isSafeInteger(epochId) || epochId < 0) throw new Error('crowd: invalid epoch');
  return { epochId, epochRoot: new Uint8Array(root), senderKeys: new Map(), messageCount: 0, startedAt: Date.now() };
}

function findEpoch(g: CrowdState, epochId: number): CrowdEpoch | null {
  if (g.currentEpoch.epochId === epochId) return g.currentEpoch;
  for (const e of g.prevEpochs) { if (e.epochId === epochId) return e; }
  return null;
}

function epochAAD(scopeId: string, epochId: number, senderId: string): Uint8Array {
  const prefix = new TextEncoder().encode('xorein/crowd/v2/message\0');
  const scope = new TextEncoder().encode(scopeId);
  const sender = new TextEncoder().encode(senderId);
  return concat(prefix, uint16BE(scope.length), scope, uint64BE(epochId), uint16BE(sender.length), sender);
}

function uint64BE(n: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(n / 2 ** 32), false);
  view.setUint32(4, n >>> 0, false);
  return out;
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

function validCiphertext(ct: CrowdCiphertext): boolean {
  return !!ct && Number.isSafeInteger(ct.epochId) && ct.epochId >= 0 && validId(ct.senderId)
    && isByteArray(ct.nonce) && ct.nonce.length === 12
    && isByteArray(ct.ct) && ct.ct.length >= 16 && ct.ct.length <= MAX_PLAINTEXT_BYTES + 16;
}

function isByteArray(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function assertCrowdState(g: CrowdState): void {
  if (!g || !validId(g.scopeId) || !g.currentEpoch || g.prevEpochs.length > LEGACY_WINDOW_SIZE
    || g.currentEpoch.epochRoot.length !== 32 || !Number.isSafeInteger(g.currentEpoch.epochId)
    || g.currentEpoch.epochId < 0) throw new Error('crowd: invalid state');
}
