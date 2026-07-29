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
/**
 * Skipped message keys are plaintext-equivalent: anyone holding one can decrypt the
 * matching recorded ciphertext forever. Bound their lifetime so a message that never
 * arrives does not leave its key on disk indefinitely (forward secrecy) and so stale
 * entries cannot permanently exhaust the MAX_SKIPPED budget and wedge the session.
 */
export const SKIPPED_KEY_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

/** A retained skipped-message key plus its creation time (for age-based expiry). */
export interface SkipEntry { mk: Uint8Array; addedAt: number }

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
  skipList:         Map<string, SkipEntry>; // `${hex(ratchetPub)}:${counter}` → skipped key
}

function skipKeyStr(ratchetPub: Uint8Array, counter: number): string {
  return `${hex(ratchetPub)}:${counter}`;
}

function hex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Initialise a RatchetState from the hybrid master secret. Matches Go initRatchetFromMaster.
 *
 * isInitiator=true → sendChainKey=chainKey. isInitiator=false → recvChainKey=chainKey, and the
 * responder additionally bootstraps its own send chain (see below) since X3DH only ever splits
 * ONE root/chain pair — nothing analogous exists for the responder's sending direction.
 */
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
    sendChainKey:     new Uint8Array(32),
    recvChainKey:     new Uint8Array(32),
    sendCounter:      0,
    recvCounter:      0,
    prevSendChainLen: 0,
    sendRatchetPriv:  new Uint8Array(localRatchetPriv),
    sendRatchetPub:   new Uint8Array(localRatchetPub),
    remoteRatchetPub: new Uint8Array(remoteRatchetPub),
    skipList:         new Map(),
  };

  if (isInitiator) {
    rs.sendChainKey = new Uint8Array(chainKey);
    return rs;
  }
  rs.recvChainKey = new Uint8Array(chainKey);

  // SECURITY: without this, sendChainKey stays all zero — a constant known to every
  // observer, not a secret — until the responder happens to receive a message with a
  // new ratchet key. That never arrives on its own: the initiator's first message
  // reuses the SAME ratchet key (EK) already stored as remoteRatchetPub, so
  // remoteRatchetPub never changes and dhRatchetStep is never triggered. The
  // responder's first reply would be encrypted with that public, all-zero key and be
  // readable by anyone.
  //
  // Bootstrap a real send chain the same way a later DH ratchet step would: mint a
  // fresh key pair and derive (root, chain) from DH(newPriv, remoteRatchetPub).
  // remoteRatchetPub is the initiator's X3DH ephemeral (EK); this DH output is NOT
  // part of hybridMaster (only the responder will ever know newPriv), so it is
  // fresh, secret keying material — symmetric with what the initiator will
  // independently derive via its own dhRatchetStep the first time it sees this new
  // ratchet public key in a reply (DH(EK_priv, newPub) == DH(newPriv, EK_pub) by
  // ECDH commutativity, against the same starting rootKey both sides already share).
  //
  // This deliberately mirrors only the SEND half of dhRatchetStep: it must NOT touch
  // recvChainKey/recvCounter (just set correctly above) or it would clobber them
  // with a redundant, already-spent DH output — X25519(SPK, EK), the very value
  // already folded into hybridMaster — desyncing the responder from the
  // initiator's not-yet-rotated chain.
  const { priv: newSendPriv, pub: newSendPub } = generateX25519Keypair();
  const dhOut = x25519.getSharedSecret(newSendPriv, remoteRatchetPub);
  const okm2 = deriveKey(rootKey, dhOut, LABEL_RATCHET_STEP, 64);
  rs.rootKey = new Uint8Array(okm2.slice(0, 32));
  rs.sendChainKey = new Uint8Array(okm2.slice(32));
  rs.sendRatchetPriv = newSendPriv;
  rs.sendRatchetPub = newSendPub;
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

/**
 * Decrypt a message given header (53 bytes) and ciphertext.
 *
 * TRANSACTIONAL: all ratchet-state mutation happens on a working COPY, and the
 * caller's state is swapped only after the AEAD tag verifies (mirrors the
 * "authenticate before committing" rule the first-contact path in session.ts
 * follows, and the Signal spec's "discard the state object when decryption
 * fails"). A replayed, reordered, or forged ciphertext therefore throws WITHOUT
 * advancing the receive chain, re-keying the root, replacing the local ratchet
 * keypair, or consuming skipped keys — the session keeps decrypting genuine
 * traffic. Without this, a single duplicated ciphertext (e.g. a mailbox blob
 * re-served by the untrusted support node, or an outbox retry) would permanently
 * destroy the receive direction.
 */
export function ratchetDecrypt(s: RatchetState, header: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (header.length < HEADER_SIZE) throw new Error('ratchet: short header');
  if (header[0] !== HEADER_VERSION) throw new Error('ratchet: unsupported header version');
  const view = new DataView(header.buffer, header.byteOffset);
  const counter = view.getUint32(1, false);
  const prevChainLen = view.getUint32(5, false);
  const ratchetPub = header.slice(9, 41);
  const nonce = header.slice(41, 53);

  // Work on a deep copy; commit only on AEAD success.
  const w = cloneRatchetState(s);
  pruneSkipList(w);

  let messageKey: Uint8Array;
  const sk = skipKeyStr(ratchetPub, counter);
  const skipped = w.skipList.get(sk);
  if (skipped) {
    messageKey = skipped.mk;
    w.skipList.delete(sk);
  } else {
    const needsDHStep = !ratchetPub.every((b, i) => b === w.remoteRatchetPub[i]);
    if (needsDHStep) {
      skipMessages(w, w.remoteRatchetPub, prevChainLen);
      dhRatchetStep(w, ratchetPub);
    }
    skipMessages(w, ratchetPub, counter);
    const adv = advanceRecvChain(w);
    messageKey = adv.messageKey;
    w.recvChainKey = adv.nextChainKey;
    w.recvCounter++;
  }

  const pt = openMessage(messageKey, nonce, header, ciphertext); // throws on bad tag
  commitRatchetState(s, w); // tag verified — commit atomically
  return pt;
}

/**
 * Drop skipped message keys older than SKIPPED_KEY_TTL_MS. Run before every
 * decrypt (reclaims the MAX_SKIPPED budget) and before serialization (so a
 * plaintext-equivalent key for a message that never arrived does not persist to
 * disk beyond the window).
 */
export function pruneSkipList(s: RatchetState, now: number = Date.now()): void {
  for (const [k, e] of s.skipList) {
    if (now - e.addedAt > SKIPPED_KEY_TTL_MS) s.skipList.delete(k);
  }
}

function cloneRatchetState(s: RatchetState): RatchetState {
  return {
    rootKey:          new Uint8Array(s.rootKey),
    sendChainKey:     new Uint8Array(s.sendChainKey),
    recvChainKey:     new Uint8Array(s.recvChainKey),
    sendCounter:      s.sendCounter,
    recvCounter:      s.recvCounter,
    prevSendChainLen: s.prevSendChainLen,
    sendRatchetPriv:  new Uint8Array(s.sendRatchetPriv),
    sendRatchetPub:   new Uint8Array(s.sendRatchetPub),
    remoteRatchetPub: new Uint8Array(s.remoteRatchetPub),
    skipList: new Map(
      [...s.skipList.entries()].map(([k, e]) => [k, { mk: new Uint8Array(e.mk), addedAt: e.addedAt }]),
    ),
  };
}

/** Copy every field of `src` into `dst` in place (callers hold `dst` by reference). */
function commitRatchetState(dst: RatchetState, src: RatchetState): void {
  dst.rootKey          = src.rootKey;
  dst.sendChainKey     = src.sendChainKey;
  dst.recvChainKey     = src.recvChainKey;
  dst.sendCounter      = src.sendCounter;
  dst.recvCounter      = src.recvCounter;
  dst.prevSendChainLen = src.prevSendChainLen;
  dst.sendRatchetPriv  = src.sendRatchetPriv;
  dst.sendRatchetPub   = src.sendRatchetPub;
  dst.remoteRatchetPub = src.remoteRatchetPub;
  dst.skipList         = src.skipList;
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
  const now = Date.now();
  while (s.recvCounter < targetCounter) {
    const { messageKey, nextChainKey } = advanceRecvChain(s);
    s.skipList.set(skipKeyStr(ratchetPub, s.recvCounter), { mk: messageKey, addedAt: now });
    s.recvChainKey = nextChainKey;
    s.recvCounter++;
  }
}

function dhRatchetStep(s: RatchetState, newRemotePub: Uint8Array): void {
  // FORWARD SECRECY / boundedness: after a DH step, only the chain we are leaving
  // (the immediately-previous remote ratchet key) may still have undelivered
  // messages realistically in flight — its skipped keys were just minted by
  // skipMessages above. Purge skipped keys belonging to any OLDER chain so
  // retired plaintext-equivalent keys don't accumulate in memory or on disk.
  const keepPrefix = `${hex(s.remoteRatchetPub)}:`;
  for (const k of s.skipList.keys()) {
    if (!k.startsWith(keepPrefix)) s.skipList.delete(k);
  }

  const dhOut = x25519.getSharedSecret(s.sendRatchetPriv, newRemotePub);
  const okm1 = deriveKey(s.rootKey, dhOut, LABEL_RATCHET_STEP, 64);
  const tempRoot = okm1.slice(0, 32);
  s.recvChainKey = okm1.slice(32);
  s.recvCounter = 0;

  const { priv: newSendPriv, pub: newSendPub } = generateX25519Keypair();
  const dhOut2 = x25519.getSharedSecret(newSendPriv, newRemotePub);
  const okm2 = deriveKey(tempRoot, dhOut2, LABEL_RATCHET_STEP, 64);

  s.prevSendChainLen = s.sendCounter;
  s.sendCounter = 0;
  // CHAINING: root must carry forward through BOTH KDF_RK calls (recv-half then
  // send-half), not just the first. Storing only tempRoot here (the pre-fix
  // behavior) desyncs the two peers' root keys the moment BOTH sides have each
  // independently run a dhRatchetStep at least once: the next step on either side
  // would derive from a root missing the other side's most recent send-half
  // mixing, permanently breaking decryption from that point on.
  s.rootKey = okm2.slice(0, 32);
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
