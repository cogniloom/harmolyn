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
import { ratchetEncrypt, ratchetDecrypt, pruneSkipList, type RatchetState } from './ratchet.js';
import type { HybridSigningKey } from '../crypto/hybrid.js';
import { peerIdToEdPub } from '../delivery/offline.js';
import { identityKeyBlob } from '../identity/safetyNumber.js';

/** Rebuild the whole prekey bundle when unconsumed OPKs drop to this many or fewer. */
const OPK_LOW_WATERMARK = 5;
// How many just-retired bundles to keep so in-flight first-contact handshakes that fetched
// the previous bundle can still complete after a rotation. One covers the realistic
// concurrent-first-contact race; a small cap bounds retained private-key material.
const RETIRED_GRACE = 1;

interface RetainedBundle { bundle: PrekeyBundle; priv: PrekeyPrivate; consumedOpks: Set<number> }

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
export interface SealInitWire {
  ek: string; ct: string; opk: number; opkPub?: string;
  /**
   * Initiator's ML-DSA-65 identity public key (b64). Carried so the RESPONDER can TOFU-pin
   * the initiator's full hybrid identity (Ed25519 ‖ ML-DSA-65) on a first inbound DM — the
   * responder never fetches the initiator's bundle, so without this it would have only the
   * Ed25519 key and could never show a safety number or detect an identity change. The
   * Ed25519 half is bound to the authenticated sender; the ML-DSA half is first-seen (TOFU),
   * matching the same blob the encrypt-side pin derives, so both directions agree.
   */
  dsa?: string;
}

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

interface SerializedPrekeyPrivate { spkPriv: string; opkPrivs: string[]; mlkemSk: string }

/** Serialized SealSessions state for encrypted persistence across reloads. */
export interface SerializedSealState {
  bundle: PrekeyBundle;
  priv: SerializedPrekeyPrivate;
  /**
   * Per-peer ratchet sessions. A peer id may appear more than once: the FIRST
   * occurrence is the current session, later ones are recently-archived sessions
   * kept so a crossed first-contact handshake converges instead of wedging.
   */
  sessions: Array<[string, SerializedRatchet]>;
  /** Indices of one-time prekeys already consumed (never reusable). */
  consumedOpks?: number[];
  /**
   * Recently-retired bundles kept for a grace window so in-flight first-contact handshakes
   * that fetched the previous bundle (before a rotation) can still complete.
   */
  retired?: Array<{ bundle: PrekeyBundle; priv: SerializedPrekeyPrivate; consumedOpks: number[] }>;
  /**
   * X3DH init messages still riding on outgoing messages for sessions the peer has
   * not yet confirmed (no inbound ciphertext decrypted under them yet).
   */
  pendingInit?: Array<[string, SealInitWire]>;
}

interface SerializedRatchet {
  rootKey: string; sendChainKey: string; recvChainKey: string;
  sendCounter: number; recvCounter: number; prevSendChainLen: number;
  sendRatchetPriv: string; sendRatchetPub: string; remoteRatchetPub: string;
  /** [skipKey, b64 messageKey, addedAt?] — 2-tuples are legacy pre-TTL entries. */
  skipList: Array<[string, string] | [string, string, number]>;
}

export interface SealSessionsOptions {
  persisted?: SerializedSealState | null;
  /** Called after every state change so the caller can re-persist (encrypted). */
  onChange?: (state: SerializedSealState) => void;
  /**
   * Called with a peer's verified hybrid identity key (b64 Ed25519 ‖ ML-DSA-65) the
   * first time we establish a session with them, so the caller can TOFU-pin it for
   * safety-number verification and change detection.
   */
  onPeerIdentity?: (peerId: string, identityKeyB64: string) => void;
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

function serializePrekeyPrivate(p: PrekeyPrivate): SerializedPrekeyPrivate {
  return { spkPriv: b64(p.spkPriv), opkPrivs: p.opkPrivs.map(b64), mlkemSk: b64(p.mlkemSk) };
}
function deserializePrekeyPrivate(s: SerializedPrekeyPrivate): PrekeyPrivate {
  return { spkPriv: unb64(s.spkPriv), opkPrivs: s.opkPrivs.map(unb64), mlkemSk: unb64(s.mlkemSk) };
}

function serializeRatchet(rs: RatchetState): SerializedRatchet {
  // Expired skipped keys are plaintext-equivalent — never let them reach disk.
  pruneSkipList(rs);
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
    skipList: [...rs.skipList.entries()].map(([k, e]) => [k, b64(e.mk), e.addedAt] as [string, string, number]),
  };
}

function deserializeRatchet(s: SerializedRatchet): RatchetState {
  const now = Date.now();
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
    // Legacy pre-TTL entries carry no timestamp — stamp them now so they age out
    // one TTL from this load rather than surviving forever.
    skipList: new Map(s.skipList.map((e) => [e[0], { mk: unb64(e[1]), addedAt: typeof e[2] === 'number' ? e[2] : now }])),
  };
}

/**
 * One ratchet session with a peer. `pendingIm` is set while WE initiated the
 * session and the peer has not yet proven it holds it (no inbound ciphertext has
 * decrypted under it): until then the X3DH init rides on EVERY outgoing message,
 * so a dropped or rejected first message cannot wedge the DM direction.
 */
interface SessionEntry { rs: RatchetState; pendingIm?: SealInitWire }

/**
 * Sessions kept per peer: the current one plus one archived predecessor, so a
 * crossed first-contact (both sides initiate simultaneously) or a rejected
 * handshake converges on one shared session instead of wedging forever.
 */
const MAX_SESSIONS_PER_PEER = 2;

export class SealSessions {
  private bundle: PrekeyBundle;
  private priv: PrekeyPrivate;
  private readonly signingKey: HybridSigningKey;
  private readonly selfPeerId: string;
  private readonly edSeed: Uint8Array;
  private readonly edPub: Uint8Array;
  /** Per-peer session list, current first (see SessionEntry / MAX_SESSIONS_PER_PEER). */
  private readonly sessions = new Map<string, SessionEntry[]>();
  private consumedOpks: Set<number>;
  // Just-retired bundles (privates) kept for a grace window across a rotation.
  private retired: RetainedBundle[] = [];
  private readonly onChange?: (state: SerializedSealState) => void;
  private readonly onPeerIdentity?: (peerId: string, identityKeyB64: string) => void;

  constructor(peerId: string, signingKey: HybridSigningKey, opts: SealSessionsOptions = {}) {
    this.signingKey = signingKey;
    this.selfPeerId = peerId;
    this.edSeed = signingKey.edSecret;
    this.edPub = signingKey.edPublic;
    this.onChange = opts.onChange;
    this.onPeerIdentity = opts.onPeerIdentity;
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
      // A repeated peer id lists archived sessions after the current one — order preserved.
      for (const [pid, sr] of opts.persisted.sessions) {
        const list = this.sessions.get(pid) ?? [];
        list.push({ rs: deserializeRatchet(sr) });
        this.sessions.set(pid, list);
      }
      for (const [pid, im] of opts.persisted.pendingInit ?? []) {
        const current = this.sessions.get(pid)?.[0];
        if (current) current.pendingIm = im;
      }
      this.retired = (opts.persisted.retired ?? []).map(r => ({
        bundle: r.bundle,
        priv: deserializePrekeyPrivate(r.priv),
        consumedOpks: new Set(r.consumedOpks),
      }));
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
      priv: serializePrekeyPrivate(this.priv),
      sessions: [...this.sessions.entries()].flatMap(
        ([pid, list]) => list.map(e => [pid, serializeRatchet(e.rs)] as [string, SerializedRatchet]),
      ),
      consumedOpks: [...this.consumedOpks],
      retired: this.retired.map(r => ({
        bundle: r.bundle,
        priv: serializePrekeyPrivate(r.priv),
        consumedOpks: [...r.consumedOpks],
      })),
      pendingInit: [...this.sessions.entries()]
        .filter(([, list]) => list[0]?.pendingIm)
        .map(([pid, list]) => [pid, list[0].pendingIm!] as [string, SealInitWire]),
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
    // Retain the OUTGOING bundle's privates for a grace window so a concurrent first-contact
    // handshake that fetched it before this rotation can still be answered (its init
    // references the old SPK/OPK/ML-KEM key). Bounded so retained key material stays small.
    this.retired = [{ bundle: this.bundle, priv: this.priv, consumedOpks: new Set(this.consumedOpks) }, ...this.retired].slice(0, RETIRED_GRACE);
    const built = buildBundle(this.selfPeerId, this.signingKey);
    this.bundle = built.bundle;
    this.priv = built.priv;
    this.consumedOpks = new Set();
    this.persist();
  }

  /**
   * Mark a one-time prekey consumed in a specific bundle: zero its private + public halves
   * so it can never back a second session. Re-sign only the CURRENT published bundle (a
   * retired bundle is never served again, so its signature is irrelevant).
   */
  private consumeOpkIn(cand: RetainedBundle, index: number): void {
    cand.consumedOpks.add(index);
    cand.priv.opkPrivs[index] = new Uint8Array(32);
    cand.bundle.one_time_prekeys_x25519[index] = new Array(32).fill(0);
    if (cand.bundle === this.bundle) resignBundle(this.bundle, this.signingKey);
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
    return (this.sessions.get(peerId)?.length ?? 0) > 0;
  }

  /**
   * Encrypt a DM to `peerId`. Establishes a ratchet session via fetchBundle on
   * first contact (requires the peer reachable for the very first message).
   * Throws if a session cannot be established — the caller MUST NOT fall back to
   * plaintext.
   *
   * UNCONFIRMED-SESSION HANDLING: a session WE initiated is only provisional until
   * the peer sends a ciphertext that decrypts under it. Until then the X3DH init
   * rides on every outgoing message — if the first message is dropped (mailbox
   * loss) the peer can still bootstrap from any later one, instead of the DM
   * direction wedging forever on 'no session and no X3DH init message'.
   */
  async encrypt(peerId: string, plaintext: Uint8Array, fetchBundle: FetchBundle): Promise<SealWire> {
    let current = this.sessions.get(peerId)?.[0];
    if (!current) {
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
      // TOFU-pin the peer's verified hybrid identity for safety-number verification.
      this.onPeerIdentity?.(
        peerId,
        identityKeyBlob(new Uint8Array(bundle.identity_key_ed25519), new Uint8Array(bundle.identity_key_ml_dsa_65)),
      );
      const init = x3dhInitiate(this.edSeed, bundle);
      current = { rs: init.rs, pendingIm: this.initToWire(init.im) };
      this.sessions.set(peerId, [current]);
    }
    const [header, ct] = ratchetEncrypt(current.rs, plaintext);
    const wire: SealWire = { ik: b64(this.edPub), header: b64(header), ct: b64(ct) };
    if (current.pendingIm) wire.im = current.pendingIm;
    this.persist();
    return wire;
  }

  /** Wire form of an X3DH init, built once and re-attached until the session is confirmed. */
  private initToWire(im: InitialMessage): SealInitWire {
    return {
      ek: b64(im.ekPub),
      ct: b64(im.ctMlkem),
      opk: im.opkIndex,
      ...(im.opkPub ? { opkPub: b64(im.opkPub) } : {}),
      // Carry our ML-DSA-65 identity key so the responder can pin our FULL hybrid
      // identity (they never fetch our bundle on the inbound path).
      dsa: b64(this.signingKey.mldsaPublic),
    };
  }

  /**
   * Decrypt an inbound DM from `peerId`. On first contact, the X3DH `im` in the
   * envelope bootstraps the responder ratchet. Throws on auth/decrypt failure.
   *
   * Tries every retained session for the peer (current first, then the archived
   * predecessor); ratchetDecrypt is transactional, so a failed attempt cannot
   * corrupt a session. If none decrypts and the wire carries its own X3DH init,
   * the init is used to bootstrap a REPLACEMENT session — this is the recovery
   * path for a crossed first-contact (both sides initiated) or a handshake the
   * responder rejected (e.g. consumed one-time prekey): the peer re-initiates
   * and we converge on their session instead of both directions wedging forever.
   * Adoption over a live session requires the init to consume a one-time prekey,
   * so a recorded first-contact wire cannot be replayed later to reset a session.
   */
  decrypt(peerId: string, wire: SealWire): Uint8Array {
    const entries = this.sessions.get(peerId) ?? [];
    let lastErr: unknown;
    for (const entry of entries) {
      let pt: Uint8Array;
      try {
        pt = ratchetDecrypt(entry.rs, unb64(wire.header), unb64(wire.ct));
      } catch (e) { lastErr = e; continue; }
      // The peer sent a ciphertext that decrypts under this session — it is
      // confirmed; stop attaching the X3DH init and make it the current session.
      entry.pendingIm = undefined;
      const i = entries.indexOf(entry);
      if (i > 0) { entries.splice(i, 1); entries.unshift(entry); }
      this.persist();
      return pt;
    }

    if (!wire.im) {
      if (entries.length > 0) throw lastErr instanceof Error ? lastErr : new Error('seal: decrypt failed');
      throw new Error('seal: no session and no X3DH init message');
    }
    // SESSION-RESET SAFETY: never let an init that consumed NO one-time prekey
    // replace an existing session — without the OPK single-use check a recorded
    // first-contact wire would remain replayable forever.
    if (entries.length > 0 && wire.im.opk < 0) {
      throw lastErr instanceof Error ? lastErr : new Error('seal: decrypt failed');
    }
    return this.bootstrapFromInit(peerId, wire, wire.im);
  }

  /** Bootstrap a responder ratchet from the X3DH init message `imWire` carried by `wire`. */
  private bootstrapFromInit(peerId: string, wire: SealWire, imWire: SealInitWire): Uint8Array {
    const theirEdPub = unb64(wire.ik);
    // IDENTITY BINDING: the initiator's claimed identity key must belong to the
    // Noise-authenticated sender — otherwise a relay could relabel a bundle.
    assertWireIdentityBinding(peerId, theirEdPub);
    const im: InitialMessage = {
      ekPub: unb64(imWire.ek),
      ctMlkem: unb64(imWire.ct),
      opkIndex: imWire.opk,
      ...(imWire.opkPub ? { opkPub: unb64(imWire.opkPub) } : {}),
    };
    // Try the CURRENT bundle first, then any retained (recently-retired) bundle. An init
    // built against a since-rotated bundle references that bundle's SPK/OPK/ML-KEM key, so
    // only its retained privates derive the right shared secret; the other candidates fail
    // ratchetDecrypt and are skipped. This lets a concurrent first-contact handshake that
    // fetched the old bundle complete instead of wedging permanently.
    const candidates: RetainedBundle[] = [
      { bundle: this.bundle, priv: this.priv, consumedOpks: this.consumedOpks },
      ...this.retired,
    ];
    let lastErr: unknown;
    for (const cand of candidates) {
      // ONE-TIME PREKEY single-use + advertised-pub match, per candidate bundle. A consumed
      // OPK must never back a second session (defeats the forward secrecy OPKs exist for).
      if (im.opkIndex >= 0) {
        if (im.opkPub) {
          const advertised = cand.bundle.one_time_prekeys_x25519[im.opkIndex];
          if (!advertised || !bytesEqual(new Uint8Array(advertised), im.opkPub)) {
            lastErr = new Error('seal: one-time prekey mismatch'); continue;
          }
        }
        if (cand.consumedOpks.has(im.opkIndex) || isConsumedSlot(cand.bundle, im.opkIndex)) {
          lastErr = new Error('seal: one-time prekey already consumed'); continue;
        }
      }
      // AUTHENTICATE BEFORE COMMITTING: derive the responder ratchet and decrypt against
      // this CANDIDATE first. Only on success do we commit the session, consume the OPK from
      // the MATCHING bundle, and rotate — so a malformed init can neither poison the in-memory
      // session (a stored bad ratchet would make later valid inits skip X3DH and fail) nor
      // burn a one-time prekey before decryption ever authenticated.
      let candidateRs: RatchetState;
      try { candidateRs = x3dhRespond(im, cand.priv, cand.bundle, this.edSeed, theirEdPub); }
      catch (e) { lastErr = e; continue; }
      let pt: Uint8Array;
      try { pt = ratchetDecrypt(candidateRs, unb64(wire.header), unb64(wire.ct)); }
      catch (e) { lastErr = e; continue; }

      // Adopt the peer-initiated session as CURRENT; archive our previous one(s)
      // (bounded) so in-flight messages under a superseded session can still be
      // tried. An archived session's pending init is dropped — it will never ride
      // again because outgoing traffic now uses the adopted session.
      const previous = (this.sessions.get(peerId) ?? []).map(e => ({ rs: e.rs }));
      this.sessions.set(peerId, [{ rs: candidateRs }, ...previous].slice(0, MAX_SESSIONS_PER_PEER));
      if (im.opkIndex >= 0) this.consumeOpkIn(cand, im.opkIndex);
      // TOFU-pin the initiator's full hybrid identity (Ed25519 bound to the sender + the
      // ML-DSA half they carried) so the responder can show a safety number and detect
      // identity changes for a relationship where the peer messaged first.
      if (imWire.dsa) {
        this.onPeerIdentity?.(peerId, identityKeyBlob(theirEdPub, unb64(imWire.dsa)));
      }
      this.maybeRotateBundle();
      this.persist();
      return pt;
    }
    throw lastErr instanceof Error ? lastErr : new Error('seal: could not establish session from init');
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
