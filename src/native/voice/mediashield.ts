// xorein MediaShield mode: SFrame-based E2EE for voice/video media frames.
// Byte-compatible with Go oracle: pkg/v0_1/mode/mediashield/mediashield.go.
// Source: docs/spec/v0.1/15-mode-mediashield.md
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm as aesGcm } from '@noble/ciphers/aes.js';
import { deriveKey } from '../seal/kdf.js';

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_FRAME_COUNTER = 0xFFFFFFFFFFFFn; // 2^48 - 1
const NONCE_SIZE = 12;
const KID_SIZE = 8;
export const SFRAME_HEADER_SIZE = KID_SIZE + 8; // 16 bytes

const LABEL_MEDIASHIELD       = 'xorein/mediashield/v1';
const LABEL_MEDIASHIELD_NONCE = LABEL_MEDIASHIELD + '/nonce';

// ── PeerKey ────────────────────────────────────────────────────────────────

export interface PeerKey {
  peerId: string;
  key: Uint8Array;          // 32 B; AES-128 uses first 16
  frameCounter: bigint;     // next frame counter for encrypt
  maxDecryptedCounter: bigint;
  hasDecrypted: boolean;
}

export function newPeerKey(peerId: string, key: Uint8Array): PeerKey {
  return { peerId, key: new Uint8Array(key), frameCounter: 0n, maxDecryptedCounter: 0n, hasDecrypted: false };
}

// ── KID + nonce ────────────────────────────────────────────────────────────

/** First 8 bytes of SHA-256(peerID) — used as SFrame Key ID. */
export function peerKID(peerId: string): Uint8Array {
  return sha256(new TextEncoder().encode(peerId)).subarray(0, KID_SIZE);
}

/** Per-frame nonce: DeriveKey(key, uint64BE(frameCounter), "xorein/mediashield/v1/nonce", 12). */
export function deriveNonce(key: Uint8Array, frameCounter: bigint): Uint8Array {
  const salt = uint64BEBig(frameCounter);
  return deriveKey(key, salt, LABEL_MEDIASHIELD_NONCE, NONCE_SIZE);
}

/** SFrame header: KID(8) || CTR_BE8(8) = 16 bytes. */
export function buildSFrameHeader(peerId: string, frameCounter: bigint): Uint8Array {
  const hdr = new Uint8Array(SFRAME_HEADER_SIZE);
  hdr.set(peerKID(peerId), 0);
  hdr.set(uint64BEBig(frameCounter), KID_SIZE);
  return hdr;
}

// ── Encrypt / Decrypt ──────────────────────────────────────────────────────

/**
 * Encrypt a media frame (AES-128-GCM).
 * Returns [sframeHeader(16B), ciphertext+tag].
 */
export function encryptFrame(
  pk: PeerKey,
  rtpHeader: Uint8Array,
  plaintext: Uint8Array,
): [Uint8Array, Uint8Array] {
  if (pk.frameCounter > MAX_FRAME_COUNTER) throw new Error('mediashield: frame counter overflow');
  const nonce = deriveNonce(pk.key, pk.frameCounter);
  const sframeHeader = buildSFrameHeader(pk.peerId, pk.frameCounter);
  const aad = concat(sframeHeader, rtpHeader);
  const key16 = pk.key.slice(0, 16);
  const aead = aesGcm(key16, nonce, aad);
  const ct = aead.encrypt(plaintext);
  pk.frameCounter++;
  return [sframeHeader, ct];
}

/** Decrypt a media frame; enforces KID validation and replay protection. */
export function decryptFrame(
  pk: PeerKey,
  rtpHeader: Uint8Array,
  sframeHeader: Uint8Array,
  ctWithTag: Uint8Array,
): Uint8Array {
  if (sframeHeader.length !== SFRAME_HEADER_SIZE) {
    throw new Error(`mediashield: bad header size ${sframeHeader.length}`);
  }
  const expectedKID = peerKID(pk.peerId);
  for (let i = 0; i < KID_SIZE; i++) {
    if (sframeHeader[i] !== expectedKID[i]) throw new Error('mediashield: KID mismatch');
  }
  const frameCounter = readUint64BEBig(sframeHeader, KID_SIZE);
  if (pk.hasDecrypted && frameCounter <= pk.maxDecryptedCounter) {
    throw new Error('mediashield: replay detected');
  }
  const nonce = deriveNonce(pk.key, frameCounter);
  const aad = concat(sframeHeader, rtpHeader);
  const key16 = pk.key.slice(0, 16);
  const aead = aesGcm(key16, nonce, aad);
  const pt = aead.decrypt(ctWithTag);
  pk.maxDecryptedCounter = frameCounter;
  pk.hasDecrypted = true;
  return pt;
}

// ── WebRTC Insertable Streams integration ──────────────────────────────────

/**
 * Create an RTCRtpScriptTransformer-compatible transform function that
 * encrypts outgoing encoded frames with MediaShield. The `pk` is the LOCAL
 * peer's key. Returns a transformer usable with RTCRtpSender.transform.
 *
 * Browser API: RTCRtpSender.transform = new RTCRtpScriptTransform(worker, {...})
 * For now this is exposed as a helper for integration with the WebRTC layer.
 */
export function createEncryptTransform(pk: PeerKey) {
  return async (encodedFrame: { data: ArrayBuffer; getMetadata?: () => { rtpTimestamp: number } }, controller: { enqueue: (f: typeof encodedFrame) => void }) => {
    const rtpHeader = new Uint8Array(4); // minimal 4-byte RTP header placeholder
    const plaintext = new Uint8Array(encodedFrame.data);
    const [sframeHeader, ct] = encryptFrame(pk, rtpHeader, plaintext);
    // Prepend sframeHeader to ciphertext so receiver can parse it.
    const combined = new Uint8Array(sframeHeader.length + ct.length);
    combined.set(sframeHeader, 0);
    combined.set(ct, sframeHeader.length);
    encodedFrame.data = combined.buffer;
    controller.enqueue(encodedFrame);
  };
}

/** Create a decrypt transform for incoming encoded frames. */
export function createDecryptTransform(pk: PeerKey) {
  return async (encodedFrame: { data: ArrayBuffer }, controller: { enqueue: (f: typeof encodedFrame) => void }) => {
    const combined = new Uint8Array(encodedFrame.data);
    if (combined.length < SFRAME_HEADER_SIZE) { controller.enqueue(encodedFrame); return; }
    const sframeHeader = combined.slice(0, SFRAME_HEADER_SIZE);
    const ctWithTag = combined.slice(SFRAME_HEADER_SIZE);
    const rtpHeader = new Uint8Array(4);
    try {
      const pt = decryptFrame(pk, rtpHeader, sframeHeader, ctWithTag);
      encodedFrame.data = pt.buffer as ArrayBuffer;
      controller.enqueue(encodedFrame);
    } catch { /* drop invalid/replayed frame */ }
  };
}

// ── Utilities ──────────────────────────────────────────────────────────────

function uint64BEBig(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, Number(n >> 32n), false);
  view.setUint32(4, Number(n & 0xFFFFFFFFn), false);
  return buf;
}

function readUint64BEBig(buf: Uint8Array, off: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + off, 8);
  const hi = BigInt(view.getUint32(0, false));
  const lo = BigInt(view.getUint32(4, false));
  return (hi << 32n) | lo;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
