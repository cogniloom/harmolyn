// xorein zero-knowledge mailbox: blinded epoch tokens + relay-framed ciphertext.
// Byte-compatible with Go oracle: pkg/v0_1/nat/store_forward.go.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { supportNodeApiBase } from '../nodeOrigin.js';
import { reportNodeRequestFailure, reportNodeRequestSuccess } from '../../lib/nodeHealth.js';
import { getPeerSync } from '../sync/registry.js';
import { PROTOCOLS } from '../families/families.js';
import { peerServiceCandidates } from '../peerServices/providers.js';
import { getState } from '../state/store.js';
import {
  decodeBase64Strict,
  encodeBase64Chunked,
  isPlainObject,
  MAX_MAILBOX_BODY_BYTES,
  MAX_MAILBOX_DELIVERIES,
} from '../security/limits.js';

// ── Constants (must match Go oracle) ──────────────────────────────────────

const MAILBOX_EPOCH_SECONDS = 3600; // 1 hour
const DRAIN_EPOCH_SKEW = 1;         // drain current + 1 past epoch
const MAILBOX_LABEL = 'xorein/mailbox/';
const MIN_MAILBOX_SECRET = 16;
const TARGET_MAILBOX_COPIES = 3;
const MAX_MAILBOX_STORE_CANDIDATES = 12;
// A sender never attempts beyond the first 12 deterministic holders, so a
// recipient gains nothing by probing a wider set.
const MAX_MAILBOX_DRAIN_CANDIDATES = MAX_MAILBOX_STORE_CANDIDATES;
const MAX_PARALLEL_PEER_REQUESTS = 8;

// Relay frame magic: 4 ASCII + 1 version byte = "xrn1\x01".
const RELAY_FRAME_MAGIC = new Uint8Array([0x78, 0x72, 0x6e, 0x31, 0x01]);

// ── Token derivation ───────────────────────────────────────────────────────

/** Current epoch index = floor(unix_seconds / MAILBOX_EPOCH_SECONDS). */
export function mailboxEpoch(nowSeconds?: number): number {
  const t = nowSeconds ?? Math.floor(Date.now() / 1000);
  return Math.floor(t / MAILBOX_EPOCH_SECONDS);
}

/**
 * Derive the blinded mailbox token for a given secret and epoch.
 * Token = base64url_no_pad(HMAC-SHA256(mailboxSecret, "xorein/mailbox/" + epoch)).
 * Matches Go MailboxToken.
 */
export function mailboxToken(mailboxSecret: Uint8Array, epoch: number): string {
  if (mailboxSecret.length < MIN_MAILBOX_SECRET || !Number.isSafeInteger(epoch)) return '';
  const label = new TextEncoder().encode(MAILBOX_LABEL + epoch.toString());
  const mac = hmac(sha256, mailboxSecret, label);
  return base64urlNoPad(mac);
}

/** Token for the current epoch (used by senders). */
export function currentMailboxToken(mailboxSecret: Uint8Array): string {
  return mailboxToken(mailboxSecret, mailboxEpoch());
}

/**
 * Derive all tokens a recipient should drain (current + DRAIN_EPOCH_SKEW past epochs).
 * Matches Go DrainMailboxTokens.
 */
export function drainMailboxTokens(mailboxSecret: Uint8Array): string[] {
  if (mailboxSecret.length < MIN_MAILBOX_SECRET) return [];
  const cur = mailboxEpoch();
  const tokens: string[] = [];
  for (let e = cur; e >= cur - DRAIN_EPOCH_SKEW; e--) {
    tokens.push(mailboxToken(mailboxSecret, e));
  }
  return tokens;
}

// ── Relay frame ────────────────────────────────────────────────────────────

/** Prepend the relay frame magic to ciphertext. Relay checks for opacity. */
export function wrapRelayBody(ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length > MAX_MAILBOX_BODY_BYTES) throw new RangeError('relay body: ciphertext exceeds limit');
  const out = new Uint8Array(RELAY_FRAME_MAGIC.length + ciphertext.length);
  out.set(RELAY_FRAME_MAGIC, 0);
  out.set(ciphertext, RELAY_FRAME_MAGIC.length);
  return out;
}

/** Strip the relay frame header, returning raw ciphertext. Throws on bad magic. */
export function unwrapRelayBody(framed: Uint8Array): Uint8Array {
  if (framed.length < RELAY_FRAME_MAGIC.length) throw new Error('relay body: too short');
  if (framed.length - RELAY_FRAME_MAGIC.length > MAX_MAILBOX_BODY_BYTES) throw new Error('relay body: ciphertext exceeds limit');
  for (let i = 0; i < RELAY_FRAME_MAGIC.length; i++) {
    if (framed[i] !== RELAY_FRAME_MAGIC[i]) throw new Error('relay body: invalid frame magic');
  }
  return framed.subarray(RELAY_FRAME_MAGIC.length);
}

// ── HTTP mailbox client ────────────────────────────────────────────────────

/**
 * Store a delivery in the relay mailbox.
 * token = blinded epoch token (from currentMailboxToken).
 * ciphertext = raw encrypted message bytes (will be wrapped with relay frame).
 */
export async function mailboxStore(token: string, ciphertext: Uint8Array): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('mailbox store: invalid token');
  const framed = wrapRelayBody(ciphertext);
  const body_b64 = base64urlNoPad(framed);
  const entryId = crypto.randomUUID();
  // Preferred path: the authenticated libp2p session already established to
  // the selected node. This works directly against turnkey Xorein and avoids
  // exposing mailbox mutations on the public browser bootstrap gateway.
  const peerSync = getPeerSync();
  let acknowledgements = 0;
  let lastError: unknown;
  if (typeof peerSync?.storeMailboxAtRelay === 'function'
    && await peerSync.storeMailboxAtRelay(token, body_b64, entryId)) acknowledgements++;

  // Compatibility path for the legacy local support shim. Do not deposit
  // twice on the same selected node when its authenticated relay API already
  // acknowledged the body.
  if (acknowledgements === 0) {
    try {
      const res = await fetch(`${supportNodeApiBase()}/mailbox/store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, body: body_b64 }),
      });
      reportNodeRequestSuccess();
      if (!res.ok && res.status !== 204) throw new Error(`mailbox store: ${res.status}`);
      acknowledgements++;
    } catch (error) {
      lastError = error;
      reportNodeRequestFailure(error);
    }
  }

  // Node-independent path: rendezvous-hash the blinded token onto peers. The
  // recipient derives the same candidate order from its shared network view.
  // Providers see neither recipient identity nor plaintext.
  if (peerSync) {
    const candidates = peerServiceCandidates(token, MAX_MAILBOX_STORE_CANDIDATES);
    for (let offset = 0;
      offset < candidates.length && acknowledgements < TARGET_MAILBOX_COPIES;
      offset += MAX_PARALLEL_PEER_REQUESTS) {
      const batch = candidates.slice(offset, offset + MAX_PARALLEL_PEER_REQUESTS);
      const results = await Promise.all(batch.map(async peerId => {
        const role = getState().peers[peerId]?.role;
        const support = role === 'relay' || role === 'archivist';
        const response = await peerSync.requestPeer<{ ok?: boolean; queued?: boolean }>(
          peerId,
          PROTOCOLS.peer,
          support ? 'peer.relay.store' : 'peer.mailbox.store',
          support
            ? { mailbox_token: token, id: entryId, body: body_b64 }
            : { token, id: entryId, body: body_b64 },
        );
        return (support ? response?.queued === true : response?.ok === true && response.queued === true);
      }));
      acknowledgements += results.filter(Boolean).length;
    }
  }
  if (acknowledgements > 0) return;
  if (lastError instanceof Error) throw lastError;
  throw new Error('mailbox store: no node or peer storage provider is reachable');
}

/**
 * Drain deliveries from the relay mailbox for the given tokens.
 * Returns raw ciphertext bytes (relay frame stripped).
 */
export async function mailboxDrain(tokens: string[]): Promise<Uint8Array[]> {
  if (tokens.length === 0) return [];
  if (tokens.length > DRAIN_EPOCH_SKEW + 1 || tokens.some(token => !/^[A-Za-z0-9_-]{43}$/.test(token))) {
    throw new Error('mailbox drain: invalid tokens');
  }
  // A successful empty drain is distinct from an unavailable peer service.
  const peerSync = getPeerSync();
  let providerAnswered = false;
  let lastError: unknown;
  const bodies: string[] = [];
  const peerBodies = typeof peerSync?.drainMailboxAtRelay === 'function'
    ? await peerSync.drainMailboxAtRelay(tokens)
    : null;
  if (peerBodies !== null) {
    providerAnswered = true;
    if (peerBodies.length <= MAX_MAILBOX_DELIVERIES) bodies.push(...peerBodies);
  }

  // Compatibility path for the legacy local support shim.
  if (peerBodies === null) {
    try {
      const res = await fetch(`${supportNodeApiBase()}/mailbox/drain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens }),
      });
      reportNodeRequestSuccess();
      if (!res.ok) throw new Error(`mailbox drain: ${res.status}`);
      const data = await res.json() as unknown;
      if (!isPlainObject(data)
        || !Array.isArray(data.bodies)
        || data.bodies.length > MAX_MAILBOX_DELIVERIES
        || data.bodies.some(body => typeof body !== 'string')) {
        throw new Error('mailbox drain: invalid response');
      }
      providerAnswered = true;
      bodies.push(...data.bodies as string[]);
    } catch (error) {
      lastError = error;
      reportNodeRequestFailure(error);
    }
  }

  if (peerSync) {
    // The delivery may belong to the previous epoch. Provider placement is
    // token-hashed, so query each token's deterministic holder set rather than
    // only the current token's (which changes at the hour boundary).
    const candidates = [...new Set(tokens.flatMap(token =>
      peerServiceCandidates(token, MAX_MAILBOX_DRAIN_CANDIDATES)))];
    for (let offset = 0; offset < candidates.length; offset += MAX_PARALLEL_PEER_REQUESTS) {
      const batch = candidates.slice(offset, offset + MAX_PARALLEL_PEER_REQUESTS);
      const results = await Promise.all(batch.map(async peerId => {
        const role = getState().peers[peerId]?.role;
        const support = role === 'relay' || role === 'archivist';
        return peerSync.requestPeer<{
          ok?: boolean;
          entries?: Array<{ id?: unknown; body?: unknown }>;
        }>(
          peerId,
          PROTOCOLS.peer,
          support ? 'peer.relay.drain' : 'peer.mailbox.drain',
          support ? { mailbox_tokens: tokens } : { tokens },
        );
      }));
      for (const response of results) {
        if (!response
          || !Array.isArray(response.entries)
          || response.entries.length > MAX_MAILBOX_DELIVERIES) continue;
        providerAnswered = true;
        for (const entry of response.entries) {
          if (typeof entry?.body === 'string') bodies.push(entry.body);
        }
      }
    }
  }

  const deliveries: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    if (seen.has(body) || deliveries.length >= MAX_MAILBOX_DELIVERIES) continue;
    const framed = base64urlDecode(body);
    if (!framed) continue;
    try {
      deliveries.push(unwrapRelayBody(framed));
      seen.add(body);
    } catch {
      // Untrusted providers may return junk; ignore it and retain valid copies.
    }
  }
  if (providerAnswered) return deliveries;
  if (lastError instanceof Error) throw lastError;
  throw new Error('mailbox drain: no node or peer storage provider is reachable');
}

// ── High-level offline delivery ────────────────────────────────────────────

/**
 * Deliver an encrypted message to a recipient.
 * If the recipient's P2P peer is available, dials directly (not yet implemented here;
 * this function handles the relay fallback path for offline delivery).
 */
export async function deliverOffline(
  mailboxSecret: Uint8Array,
  ciphertext: Uint8Array,
): Promise<void> {
  const token = currentMailboxToken(mailboxSecret);
  if (!token) throw new Error('mailbox secret too short');
  await mailboxStore(token, ciphertext);
}

/** Drain pending deliveries for this identity's mailbox secret. */
export async function drainDeliveries(mailboxSecret: Uint8Array): Promise<Uint8Array[]> {
  const tokens = drainMailboxTokens(mailboxSecret);
  return mailboxDrain(tokens);
}

// ── Utilities ──────────────────────────────────────────────────────────────

function base64urlNoPad(b: Uint8Array): string {
  const base64 = encodeBase64Chunked(b);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(s: unknown): Uint8Array | null {
  return decodeBase64Strict(s, RELAY_FRAME_MAGIC.length + MAX_MAILBOX_BODY_BYTES, true);
}
