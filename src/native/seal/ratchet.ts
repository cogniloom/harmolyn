// Seal mode Double Ratchet: encrypt/decrypt with ChaCha20-Poly1305.
// Byte-compatible with Go oracle: pkg/v0_1/mode/seal/doubleratchet.go.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { generateX25519Keypair } from './curve.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { deriveKey } from './kdf.js';

const LABEL_ROOT_KEY      = 'xorein/seal/v1/root-key';
const LABEL_MESSAGE_KEY   = 'xorein/seal/v1/message-key';
const LABEL_RATCHET_STEP  = 'xorein/seal/v1/ratchet-step';

// Header: 1 + 4 + 4 + 32 + 12 = 53 bytes (spec 11 §3.3).
export const HEADER_SIZE = 53;
const HEADER_VERSION = 0x01;
const MAX_SKIPPED = 1000;

interface SkipKey { ratchetPub: string; counter: number; }

export interface RatchetState {
  rootKey:          Uint8Array; // 32
  sendChainKey:     Uint8Array; // 32
  recvChainKey:     Uint8Array; // 32
  sendCounter:      number;
  recvCounter:      number;
  prevSendChainLen: number;
  sendRatchetPriv:  Uint8Array; // 32
  sendRatchetPub:   Uint8Array; // 32
  remoteRatchetPub: Uint8Array; // 32
  skipList:         Map<string, Uint8Array>; // SkipKey→messageKey
}

function skipKeyStr(ratchetPub: Uint8Array, counter: number): string {
  return `${hex(ratchetPub)}:${counter}`;
}

function hex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Initialise a RatchetState from the hybrid master secret. Matches Go initRatchetFromMaster. */
export function initRatchetFromMaster(
  hybridMaster: Uint8Array,
  localRatchetPriv: Uint8Array,
  localRatchetPub: Uint8Array,
  remoteRatchetPub: Uint8Array,
  isInitiator: boolean,
): RatchetState {
  const okm = deriveKey(hybridMaster, null, LABEL_ROOT_KEY, 64);
  const rootKey = okm.slice(0, 32);
  const chainKey = okm.slice(32, 64);

  const rs: RatchetState = {
    rootKey:          new Uint8Array(rootKey),
    sendChainKey:     new Uint8Array(isInitiator ? chainKey : new Uint8Array(32)),
    recvChainKey:     new Uint8Array(isInitiator ? new Uint8Array(32) : chainKey),
    sendCounter:      0,
    recvCounter:      0,
    prevSendChainLen: 0,
    sendRatchetPriv:  new Uint8Array(localRatchetPriv),
    sendRatchetPub:   new Uint8Array(localRatchetPub),
    remoteRatchetPub: new Uint8Array(remoteRatchetPub),
    skipList:         new Map(),
  };
  return rs;
}

/** Encrypt plaintext; returns [header (53 bytes), ciphertext]. */
export function ratchetEncrypt(s: RatchetState, plaintext: Uint8Array): [Uint8Array, Uint8Array] {
  const { messageKey, nextChainKey } = advanceSendChain(s);

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const header = buildHeader(s.sendCounter, s.prevSendChainLen, s.sendRatchetPub, nonce);

  // ChaCha20-Poly1305 with header as AAD.
  const aead = chacha20poly1305(messageKey.slice(0, 32), nonce, header);
  const ct = aead.encrypt(plaintext);

  s.sendCounter++;
  s.sendChainKey = nextChainKey;
  return [header, ct];
}

/** Decrypt a message given header (53 bytes) and ciphertext. */
export function ratchetDecrypt(s: RatchetState, header: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (header[0] !== HEADER_VERSION) throw new Error('ratchet: unsupported header version');
  const view = new DataView(header.buffer, header.byteOffset);
  const counter = view.getUint32(1, false);
  const prevChainLen = view.getUint32(5, false);
  const ratchetPub = header.slice(9, 41);
  const nonce = header.slice(41, 53);

  // Check skip list.
  const sk = skipKeyStr(ratchetPub, counter);
  if (s.skipList.has(sk)) {
    const mk = s.skipList.get(sk)!;
    s.skipList.delete(sk);
    return openMessage(mk, nonce, header, ciphertext);
  }

  const needsDHStep = !ratchetPub.every((b, i) => b === s.remoteRatchetPub[i]);
  if (needsDHStep) {
    skipMessages(s, s.remoteRatchetPub, prevChainLen);
    dhRatchetStep(s, ratchetPub);
  }
  skipMessages(s, ratchetPub, counter);

  const { messageKey, nextChainKey } = advanceRecvChain(s);
  s.recvChainKey = nextChainKey;
  s.recvCounter++;
  return openMessage(messageKey, nonce, header, ciphertext);
}

// ── Internal helpers ───────────────────────────────────────────────────────

function advanceSendChain(s: RatchetState): { messageKey: Uint8Array; nextChainKey: Uint8Array } {
  const okm = deriveKey(s.sendChainKey, new Uint8Array([0x01]), LABEL_MESSAGE_KEY, 64);
  return { messageKey: okm.slice(0, 32), nextChainKey: okm.slice(32) };
}

function advanceRecvChain(s: RatchetState): { messageKey: Uint8Array; nextChainKey: Uint8Array } {
  const okm = deriveKey(s.recvChainKey, new Uint8Array([0x01]), LABEL_MESSAGE_KEY, 64);
  return { messageKey: okm.slice(0, 32), nextChainKey: okm.slice(32) };
}

function skipMessages(s: RatchetState, ratchetPub: Uint8Array, targetCounter: number): void {
  if (s.skipList.size + (targetCounter - s.recvCounter) > MAX_SKIPPED) {
    throw new Error('ratchet: too many skipped messages');
  }
  while (s.recvCounter < targetCounter) {
    const { messageKey, nextChainKey } = advanceRecvChain(s);
    s.skipList.set(skipKeyStr(ratchetPub, s.recvCounter), messageKey);
    s.recvChainKey = nextChainKey;
    s.recvCounter++;
  }
}

function dhRatchetStep(s: RatchetState, newRemotePub: Uint8Array): void {
  const dhOut = x25519.getSharedSecret(s.sendRatchetPriv, newRemotePub);
  const okm1 = deriveKey(s.rootKey, dhOut, LABEL_RATCHET_STEP, 64);
  const newRoot = okm1.slice(0, 32);
  s.recvChainKey = okm1.slice(32);
  s.recvCounter = 0;

  const { priv: newSendPriv, pub: newSendPub } = generateX25519Keypair();
  const dhOut2 = x25519.getSharedSecret(newSendPriv, newRemotePub);
  const okm2 = deriveKey(newRoot, dhOut2, LABEL_RATCHET_STEP, 64);

  s.prevSendChainLen = s.sendCounter;
  s.sendCounter = 0;
  s.rootKey = newRoot;
  s.sendChainKey = okm2.slice(32);
  s.sendRatchetPriv = newSendPriv;
  s.sendRatchetPub = newSendPub;
  s.remoteRatchetPub = new Uint8Array(newRemotePub);
}

function buildHeader(counter: number, prevChainLen: number, ratchetPub: Uint8Array, nonce: Uint8Array): Uint8Array {
  const h = new Uint8Array(HEADER_SIZE);
  const view = new DataView(h.buffer);
  h[0] = HEADER_VERSION;
  view.setUint32(1, counter, false);
  view.setUint32(5, prevChainLen, false);
  h.set(ratchetPub, 9);
  h.set(nonce, 41);
  return h;
}

function openMessage(mk: Uint8Array, nonce: Uint8Array, header: Uint8Array, ct: Uint8Array): Uint8Array {
  const aead = chacha20poly1305(mk.slice(0, 32), nonce, header);
  return aead.decrypt(ct);
}
