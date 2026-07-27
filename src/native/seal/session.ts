// Seal session manager: per-peer Double Ratchet sessions for 1:1 DM E2EE.
//
// Wraps the (Go-oracle-compatible) X3DH + Double Ratchet primitives in
// bundle.ts/ratchet.ts with the session bookkeeping the live data path needs:
//   - holds our own published prekey bundle (served to peers that DM us),
//   - establishes a ratchet on first contact via an injected `fetchBundle`
//     (the transport dials the peer's `seal.bundle` op),
//   - encrypts/decrypts message bodies, never exposing plaintext to the relay,
//     the support node, or local-at-rest storage in cleartext on the wire.
//
// The transport is INJECTED (fetchBundle) so this module is pure and can be
// exhaustively unit-tested without a live libp2p node.
import {
  buildBundle, verifyBundle, resignBundle, x3dhInitiate, x3dhRespond,
  type PrekeyBundle, type PrekeyPrivate, type InitialMessage,
} from './bundle.js';
import { ratchetEncrypt, ratchetDecrypt, type RatchetState } from './ratchet.js';
import type { HybridSigningKey } from '../crypto/hybrid.js';
import { peerIdToEdPub } from '../delivery/offline.js';

/** Rebuild the whole prekey bundle when unconsumed OPKs drop to this many or fewer. */
const OPK_LOW_WATERMARK = 5;

/** Constant-time-ish equality for public key material. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** True when the OPK slot at `i` has been consumed (published as 32 zero bytes). */
function isConsumedSlot(bundle: PrekeyBundle, i: number): boolean {
  const slot = bundle.one_time_prekeys_x25519[i];
  return !slot || !slot.some(b => b !== 0);
}

/** First-message X3DH initial message, base64-wire form. */
export interface SealInitWire { ek: string; ct: string; opk: number; opkPub?: string }

/** A Seal-encrypted message envelope carried inside the chat.send payload. */
export interface SealWire {
  /** Present only on the first message of a session (X3DH bootstrap). */
  im?: SealInitWire;
  /** Initiator's Ed25519 identity public key (b64) — needed by the responder. */
  ik: string;
  /** 53-byte Double-Ratchet header (b64). */
  header: string;
  /** ChaCha20-Poly1305 ciphertext (b64). */
  ct: string;
}

export type FetchBundle = (peerId: string) => Promise<PrekeyBundle | null>;

/** Serialized SealSessions state for encrypted persistence across reloads. */
export interface SerializedSealState {
  bundle: PrekeyBundle;
  priv: { spkPriv: string; opkPrivs: string[]; mlkemSk: string };
  sessions: Array<[string, SerializedRatchet]>;
  /** Indices of one-time prekeys already consumed (never reusable). */
  consumedOpks?: number[];
}

interface SerializedRatchet {
  rootKey: string; sendChainKey: string; recvChainKey: string;
  sendCounter: number; recvCounter: number; prevSendChainLen: number;
  sendRatchetPriv: string; sendRatchetPub: string; remoteRatchetPub: string;
  skipList: Array<[string, string]>;
}

export interface SealSessionsOptions {
  persisted?: SerializedSealState | null;
  /** Called after every state change so the caller can re-persist (encrypted). */
  onChange?: (state: SerializedSealState) => void;
}

function b64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function serializeRatchet(rs: RatchetState): SerializedRatchet {
  return {
    rootKey: b64(rs.rootKey),
    sendChainKey: b64(rs.sendChainKey),
    recvChainKey: b64(rs.recvChainKey),
    sendCounter: rs.sendCounter,
    recvCounter: rs.recvCounter,
    prevSendChainLen: rs.prevSendChainLen,
    sendRatchetPriv: b64(rs.sendRatchetPriv),
    sendRatchetPub: b64(rs.sendRatchetPub),
    remoteRatchetPub: b64(rs.remoteRatchetPub),
    skipList: [...rs.skipList.entries()].map(([k, v]) => [k, b64(v)] as [string, string]),
  };
}

function deserializeRatchet(s: SerializedRatchet): RatchetState {
  return {
    rootKey: unb64(s.rootKey),
    sendChainKey: unb64(s.sendChainKey),
    recvChainKey: unb64(s.recvChainKey),
    sendCounter: s.sendCounter,
    recvCounter: s.recvCounter,
    prevSendChainLen: s.prevSendChainLen,
    sendRatchetPriv: unb64(s.sendRatchetPriv),
    sendRatchetPub: unb64(s.sendRatchetPub),
    remoteRatchetPub: unb64(s.remoteRatchetPub),
    skipList: new Map(s.skipList.map(([k, v]) => [k, unb64(v)])),
  };
}

export class SealSessions {
  private bundle: PrekeyBundle;
  private priv: PrekeyPrivate;
  private readonly signingKey: HybridSigningKey;
  private readonly selfPeerId: string;
  private readonly edSeed: Uint8Array;
  private readonly edPub: Uint8Array;
  private readonly sessions = new Map<string, RatchetState>();
  private readonly consumedOpks: Set<number>;
  private readonly onChange?: (state: SerializedSealState) => void;

  constructor(peerId: string, signingKey: HybridSigningKey, opts: SealSessionsOptions = {}) {
    this.signingKey = signingKey;
    this.selfPeerId = peerId;
    this.edSeed = signingKey.edSecret;
    this.edPub = signingKey.edPublic;
    this.onChange = opts.onChange;
    this.consumedOpks = new Set(opts.persisted?.consumedOpks ?? []);
    if (opts.persisted) {
      // Restore the SAME bundle (so peers who cached it can still handshake) and
      // every in-flight ratchet, so a reload doesn't break ongoing DMs.
      this.bundle = opts.persisted.bundle;
      this.priv = {
        spkPriv: unb64(opts.persisted.priv.spkPriv),
        opkPrivs: opts.persisted.priv.opkPrivs.map(unb64),
        mlkemSk: unb64(opts.persisted.priv.mlkemSk),
      };
      for (const [pid, sr] of opts.persisted.sessions) this.sessions.set(pid, deserializeRatchet(sr));
    } else {
      const built = buildBundle(peerId, signingKey);
      this.bundle = built.bundle;
      this.priv = built.priv;
    }
  }

  /** Snapshot the full session state for encrypted persistence. */
  serialize(): SerializedSealState {
    return {
      bundle: this.bundle,
      priv: {
        spkPriv: b64(this.priv.spkPriv),
        opkPrivs: this.priv.opkPrivs.map(b64),
        mlkemSk: b64(this.priv.mlkemSk),
      },
      sessions: [...this.sessions.entries()].map(
        ([pid, rs]) => [pid, serializeRatchet(rs)] as [string, SerializedRatchet],
      ),
      consumedOpks: [...this.consumedOpks],
    };
  }

  private persist(): void {
    this.onChange?.(this.serialize());
  }

  /** Count of one-time prekeys still available (not consumed). */
  private remainingOpks(): number {
    let n = 0;
    for (let i = 0; i < this.bundle.one_time_prekeys_x25519.length; i++) {
      if (!isConsumedSlot(this.bundle, i)) n++;
    }
    return n;
  }

  /**
   * Rebuild the whole prekey bundle when it has expired or its one-time prekeys are
   * running low. A fresh SPK + fresh OPKs restore forward secrecy for new sessions;
   * existing ratchets are unaffected (they hold their own keys). Persists on rebuild.
   */
  private maybeRotateBundle(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = nowSec > this.bundle.expires_at;
    if (!expired && this.remainingOpks() > OPK_LOW_WATERMARK) return;
    const built = buildBundle(this.selfPeerId, this.signingKey);
    this.bundle = built.bundle;
    this.priv = built.priv;
    this.consumedOpks.clear();
    this.persist();
  }

  /** Mark a one-time prekey consumed: zero its private + public halves, re-sign. */
  private consumeOpk(index: number): void {
    this.consumedOpks.add(index);
    this.priv.opkPrivs[index] = new Uint8Array(32);
    this.bundle.one_time_prekeys_x25519[index] = new Array(32).fill(0);
    resignBundle(this.bundle, this.signingKey);
  }

  /**
   * Our published prekey bundle, served to peers that want to DM us. Rotates first
   * if the bundle has expired or is low on one-time prekeys, so peers never fetch a
   * stale bundle or one that can't offer a fresh OPK.
   */
  serveBundle(): PrekeyBundle {
    this.maybeRotateBundle();
    return this.bundle;
  }

  /** True once a ratchet session exists for this peer. */
  hasSession(peerId: string): boolean {
    return this.sessions.has(peerId);
  }

  /**
   * Encrypt a DM to `peerId`. Establishes a ratchet session via fetchBundle on
   * first contact (requires the peer reachable for the very first message).
   * Throws if a session cannot be established — the caller MUST NOT fall back to
   * plaintext.
   */
  async encrypt(peerId: string, plaintext: Uint8Array, fetchBundle: FetchBundle): Promise<SealWire> {
    let rs = this.sessions.get(peerId);
    let im: InitialMessage | undefined;
    if (!rs) {
      const bundle = await fetchBundle(peerId);
      if (!bundle || !verifyBundle(bundle)) {
        throw new Error('seal: cannot establish session (missing/invalid prekey bundle)');
      }
      // IDENTITY BINDING: a self-signed bundle only proves it is internally
      // consistent — not that it belongs to the peer we asked for. Bind it to
      // `peerId` so a compromised relay can't swap in another peer's bundle
      // (MITM). The bundle must claim to be this peer, and its Ed25519 identity
      // key must hash to this peer's libp2p id (checked when the id is parseable;
      // fake ids in unit tests skip the second check, Noise still authenticates).
      assertBundleBinding(peerId, bundle);
      const init = x3dhInitiate(this.edSeed, bundle);
      rs = init.rs;
      im = init.im;
      this.sessions.set(peerId, rs);
    }
    const [header, ct] = ratchetEncrypt(rs, plaintext);
    const wire: SealWire = { ik: b64(this.edPub), header: b64(header), ct: b64(ct) };
    if (im) {
      wire.im = {
        ek: b64(im.ekPub),
        ct: b64(im.ctMlkem),
        opk: im.opkIndex,
        ...(im.opkPub ? { opkPub: b64(im.opkPub) } : {}),
      };
    }
    this.persist();
    return wire;
  }

  /**
   * Decrypt an inbound DM from `peerId`. On first contact, the X3DH `im` in the
   * envelope bootstraps the responder ratchet. Throws on auth/decrypt failure.
   */
  decrypt(peerId: string, wire: SealWire): Uint8Array {
    let rs = this.sessions.get(peerId);
    if (!rs) {
      if (!wire.im) throw new Error('seal: no session and no X3DH init message');
      const theirEdPub = unb64(wire.ik);
      // IDENTITY BINDING: the initiator's claimed identity key must belong to the
      // Noise-authenticated sender — otherwise a relay could relabel a bundle.
      assertWireIdentityBinding(peerId, theirEdPub);
      const im: InitialMessage = {
        ekPub: unb64(wire.im.ek),
        ctMlkem: unb64(wire.im.ct),
        opkIndex: wire.im.opk,
        ...(wire.im.opkPub ? { opkPub: unb64(wire.im.opkPub) } : {}),
      };
      // ONE-TIME PREKEY: enforce single use. A consumed OPK must never back a
      // second session (that would defeat the forward secrecy OPKs exist for);
      // and the echoed OPK pub must match the slot we advertised.
      if (im.opkIndex >= 0) {
        if (im.opkPub) {
          const advertised = this.bundle.one_time_prekeys_x25519[im.opkIndex];
          if (!advertised || !bytesEqual(new Uint8Array(advertised), im.opkPub)) {
            throw new Error('seal: one-time prekey mismatch');
          }
        }
        if (this.consumedOpks.has(im.opkIndex) || isConsumedSlot(this.bundle, im.opkIndex)) {
          throw new Error('seal: one-time prekey already consumed');
        }
      }
      rs = x3dhRespond(im, this.priv, this.bundle, this.edSeed, theirEdPub);
      this.sessions.set(peerId, rs);
      if (im.opkIndex >= 0) this.consumeOpk(im.opkIndex);
      this.maybeRotateBundle();
    }
    const pt = ratchetDecrypt(rs, unb64(wire.header), unb64(wire.ct));
    this.persist();
    return pt;
  }
}

/**
 * Bind a fetched bundle to the peer it is claimed to belong to. Throws on mismatch
 * so the caller keeps the message local rather than encrypting to an impostor.
 */
function assertBundleBinding(peerId: string, bundle: PrekeyBundle): void {
  if (bundle.peer_id !== peerId) {
    throw new Error('seal: bundle peer_id does not match requested peer');
  }
  const expectedEd = peerIdToEdPub(peerId);
  if (expectedEd && !bytesEqual(expectedEd, new Uint8Array(bundle.identity_key_ed25519))) {
    throw new Error('seal: bundle identity key does not match peer id');
  }
}

/** Bind an inbound wire's claimed identity key to the authenticated sender peer id. */
function assertWireIdentityBinding(senderPeerId: string, theirEdPub: Uint8Array): void {
  const expectedEd = peerIdToEdPub(senderPeerId);
  if (expectedEd && !bytesEqual(expectedEd, theirEdPub)) {
    throw new Error('seal: wire identity key does not match sender peer id');
  }
}
