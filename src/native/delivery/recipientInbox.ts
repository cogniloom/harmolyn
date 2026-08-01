// Scalable, recipient-addressed store-and-forward.
//
// Pairwise mailbox tokens are useful for metadata-minimized one-to-one delivery,
// but polling one token per possible sender does not scale to large spaces and a
// brand-new contact has no pre-shared mailbox capability. The recipient inbox
// gives every identity one daily rendezvous token. Its authorization is the
// recipient's Noise-authenticated PeerID, not token secrecy. Stored packets are
// sealed to the recipient's static X25519 key and hybrid-signed by the sender,
// so storage peers/nodes can neither read nor forge an operation.

import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import type { XoreinIdentity } from '../identity/identity.js';
import { identitySigningKey } from '../identity/identity.js';
import { identityKeyBlob, parseIdentityKeyBlob } from '../identity/safetyNumber.js';
import { hybridSign, hybridVerify, HYBRID_SIG_BYTES } from '../crypto/hybrid.js';
import {
  ed25519PubToX25519Pub,
  ed25519SeedToX25519Scalar,
} from '../seal/curve.js';
import { deriveKey } from '../seal/kdf.js';
import { peerIdToEdPub } from './offline.js';
import {
  currentRecipientInboxToken,
  recipientInboxTokens,
} from './inboxToken.js';
import { wrapRelayBody, unwrapRelayBody } from './mailbox.js';
import { getPeerSync } from '../sync/registry.js';
import { PROTOCOLS } from '../families/families.js';
import { peerServiceCandidates } from '../peerServices/providers.js';
import { canonicalJSON } from '../sync/signedHistory.js';
import {
  decodeBase64Strict,
  encodeBase64Chunked,
  hasControlCharacters,
  isPlainObject,
  MAX_MAILBOX_BODY_BYTES,
  MAX_MAILBOX_DELIVERIES,
} from '../security/limits.js';
import {
  getState,
  hasSeenInboxDelivery,
  markInboxDeliverySeen,
} from '../state/store.js';

const PACKET_DOMAIN = 'xorein/recipient-inbox/packet/v1\n';
const PACKET_KEY_LABEL = 'xorein/recipient-inbox/sealed-box/v1/';
const PACKET_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const TARGET_COPIES = 3;
const MAX_STORE_CANDIDATES = 12;
const MAX_DRAIN_CANDIDATES = 12;
const MAX_PARALLEL_REQUESTS = 8;
const MAX_DRAINED_PACKETS = 512;
const MAX_ACKNOWLEDGEMENTS_PER_REQUEST = 64;
const MAX_INNER_JSON_BYTES = MAX_MAILBOX_BODY_BYTES - 32 * 1024;

export interface RecipientInboxPacket {
  version: 1;
  id: string;
  ephemeral_public_key: string;
  ciphertext: string;
}

export interface RecipientInboxOperation {
  version: 1;
  id: string;
  origin_peer_id: string;
  target_peer_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  protocol: string;
  operation: string;
  payload: Record<string, unknown>;
  identity_key: string;
  signature: string;
}

type UnsignedRecipientInboxOperation = Omit<RecipientInboxOperation, 'signature'>;

let activeIdentity: XoreinIdentity | null = null;
let drainInFlight: Promise<number> | null = null;
let fullDrainRequested = false;

export function registerRecipientInboxIdentity(identity: XoreinIdentity): void {
  activeIdentity = identity;
}

export function resetRecipientInboxIdentity(): void {
  activeIdentity = null;
  drainInFlight = null;
  fullDrainRequested = false;
}

function b64url(bytes: Uint8Array): string {
  return encodeBase64Chunked(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function unb64url(value: unknown, maxBytes: number, exactBytes?: number): Uint8Array | null {
  const decoded = decodeBase64Strict(value, maxBytes, true);
  if (!decoded || (exactBytes !== undefined && decoded.length !== exactBytes)) return null;
  return decoded;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function packetAAD(id: string, ephemeralPublicKey: string): Uint8Array {
  return new TextEncoder().encode(`${PACKET_DOMAIN}${id}\n${ephemeralPublicKey}`);
}

function signedBytes(value: UnsignedRecipientInboxOperation): Uint8Array {
  return new TextEncoder().encode(PACKET_DOMAIN + canonicalJSON(value));
}

function normalizedPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    if (!encoded.length || encoded.length > MAX_INNER_JSON_BYTES) return null;
    const decoded = JSON.parse(new TextDecoder().decode(encoded)) as unknown;
    return isPlainObject(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Build an opaque sealed-box packet. The provider sees only a random packet id,
 * an ephemeral X25519 public key, and ciphertext.
 */
export function createRecipientInboxPacket(
  targetPeerId: string,
  protocol: string,
  operation: string,
  payload: Record<string, unknown>,
  deliveryId: string = crypto.randomUUID(),
  identity: XoreinIdentity | null = activeIdentity,
): RecipientInboxPacket | null {
  if (!identity
    || !targetPeerId
    || targetPeerId === identity.peerId
    || targetPeerId.length > 256
    || hasControlCharacters(targetPeerId)
    || !protocol
    || protocol.length > 256
    || hasControlCharacters(protocol)
    || !operation
    || operation.length > 128
    || hasControlCharacters(operation)
    || deliveryId.length < 8
    || deliveryId.length > 128
    || hasControlCharacters(deliveryId)) return null;
  const targetEd = peerIdToEdPub(targetPeerId);
  const safePayload = normalizedPayload(payload);
  if (!targetEd || !safePayload) return null;

  try {
    const now = Date.now();
    const unsigned: UnsignedRecipientInboxOperation = {
      version: 1,
      id: deliveryId,
      origin_peer_id: identity.peerId,
      target_peer_id: targetPeerId,
      created_at_ms: now,
      expires_at_ms: now + PACKET_TTL_MS,
      protocol,
      operation,
      payload: safePayload,
      identity_key: identityKeyBlob(identity.edPub, identity.mldsaPub),
    };
    const inner: RecipientInboxOperation = {
      ...unsigned,
      signature: b64url(hybridSign(signedBytes(unsigned), identitySigningKey(identity))),
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(inner));
    if (plaintext.length > MAX_INNER_JSON_BYTES) return null;

    const ephemeralSecret = x25519.utils.randomSecretKey();
    const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
    const ephemeralPublicKey = b64url(ephemeralPublic);
    const shared = x25519.getSharedSecret(
      ephemeralSecret,
      ed25519PubToX25519Pub(targetEd),
    );
    ephemeralSecret.fill(0);
    const key = deriveKey(shared, null, PACKET_KEY_LABEL + deliveryId, 32);
    shared.fill(0);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = gcm(key, nonce, packetAAD(deliveryId, ephemeralPublicKey))
      .encrypt(plaintext);
    key.fill(0);
    const sealed = new Uint8Array(nonce.length + ciphertext.length);
    sealed.set(nonce);
    sealed.set(ciphertext, nonce.length);
    return {
      version: 1,
      id: deliveryId,
      ephemeral_public_key: ephemeralPublicKey,
      ciphertext: b64url(sealed),
    };
  } catch {
    return null;
  }
}

/** Decrypt and authenticate one provider-served packet for the active identity. */
export function openRecipientInboxPacket(
  value: unknown,
  identity: XoreinIdentity | null = activeIdentity,
  now = Date.now(),
): RecipientInboxOperation | null {
  if (!identity || !isPlainObject(value)
    || value.version !== 1
    || typeof value.id !== 'string'
    || value.id.length < 8
    || value.id.length > 128
    || hasControlCharacters(value.id)
    || typeof value.ephemeral_public_key !== 'string'
    || typeof value.ciphertext !== 'string') return null;
  const ephemeralPublic = unb64url(value.ephemeral_public_key, 32, 32);
  const ciphertext = unb64url(value.ciphertext, MAX_MAILBOX_BODY_BYTES);
  if (!ephemeralPublic || !ciphertext || ciphertext.length < 12 + 16) return null;

  let inner: unknown;
  try {
    const identitySecret = ed25519SeedToX25519Scalar(identity.edSeed);
    const identityShared = x25519.getSharedSecret(identitySecret, ephemeralPublic);
    identitySecret.fill(0);
    const key = deriveKey(identityShared, null, PACKET_KEY_LABEL + value.id, 32);
    identityShared.fill(0);
    const plaintext = gcm(
      key,
      ciphertext.subarray(0, 12),
      packetAAD(value.id, value.ephemeral_public_key),
    ).decrypt(ciphertext.subarray(12));
    key.fill(0);
    if (plaintext.length > MAX_INNER_JSON_BYTES) return null;
    inner = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }

  if (!isPlainObject(inner)
    || inner.version !== 1
    || inner.id !== value.id
    || typeof inner.origin_peer_id !== 'string'
    || !inner.origin_peer_id
    || inner.origin_peer_id.length > 256
    || inner.target_peer_id !== identity.peerId
    || !Number.isSafeInteger(inner.created_at_ms)
    || !Number.isSafeInteger(inner.expires_at_ms)
    || Number(inner.created_at_ms) > now + FUTURE_SKEW_MS
    || Number(inner.expires_at_ms) < now
    || Number(inner.expires_at_ms) - Number(inner.created_at_ms) > PACKET_TTL_MS
    || typeof inner.protocol !== 'string'
    || !inner.protocol
    || inner.protocol.length > 256
    || hasControlCharacters(inner.protocol)
    || typeof inner.operation !== 'string'
    || !inner.operation
    || inner.operation.length > 128
    || hasControlCharacters(inner.operation)
    || !isPlainObject(inner.payload)
    || typeof inner.identity_key !== 'string'
    || typeof inner.signature !== 'string') return null;
  const identityKey = parseIdentityKeyBlob(inner.identity_key);
  const originEd = peerIdToEdPub(inner.origin_peer_id);
  const signature = unb64url(inner.signature, HYBRID_SIG_BYTES, HYBRID_SIG_BYTES);
  if (!identityKey
    || identityKey.mldsa65.length !== 1952
    || !originEd
    || !equal(originEd, identityKey.ed25519)
    || !signature) return null;
  const unsigned: UnsignedRecipientInboxOperation = {
    version: 1,
    id: inner.id,
    origin_peer_id: inner.origin_peer_id,
    target_peer_id: inner.target_peer_id,
    created_at_ms: Number(inner.created_at_ms),
    expires_at_ms: Number(inner.expires_at_ms),
    protocol: inner.protocol,
    operation: inner.operation,
    payload: inner.payload,
    identity_key: inner.identity_key,
  };
  return hybridVerify(signedBytes(unsigned), signature, {
    edPublic: identityKey.ed25519,
    mldsaPublic: identityKey.mldsa65,
  }) ? inner as unknown as RecipientInboxOperation : null;
}

function encodedPacket(packet: RecipientInboxPacket): Uint8Array | null {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(packet));
    return bytes.length <= MAX_INNER_JSON_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * A sender may know ordinary peers the recipient has never heard of. Custody on
 * such a peer is an opportunistic extra copy, not durable delivery: the
 * recipient cannot derive that holder from its own graph. A shared Space/DM
 * roster is mutually derivable; dedicated nodes are continuously discovered.
 */
function recipientCanDiscoverProvider(targetPeerId: string, providerPeerId: string): boolean {
  const state = getState();
  const role = state.peers[providerPeerId]?.role;
  if (role === 'relay' || role === 'archivist' || role === 'bootstrap') return true;
  if (Object.values(state.servers).some(server =>
    server.members.includes(targetPeerId) && server.members.includes(providerPeerId))) return true;
  return Object.values(state.dms).some(dm =>
    dm.participants.includes(targetPeerId) && dm.participants.includes(providerPeerId));
}

/**
 * Replicate a durable operation to three independently authenticated storage
 * providers. Dedicated nodes are preferred by peerServiceCandidates; ordinary
 * members take over automatically when no node is reachable.
 */
export async function depositRecipientInboxOperation(
  targetPeerId: string,
  protocol: string,
  operation: string,
  payload: Record<string, unknown>,
  deliveryId: string = crypto.randomUUID(),
): Promise<boolean> {
  const packet = createRecipientInboxPacket(
    targetPeerId,
    protocol,
    operation,
    payload,
    deliveryId,
  );
  const packetBytes = packet ? encodedPacket(packet) : null;
  const token = currentRecipientInboxToken(targetPeerId);
  const peerSync = getPeerSync();
  if (!packet || !packetBytes || !token || !peerSync) return false;
  const body = b64url(wrapRelayBody(packetBytes));
  let acknowledgements = 0;
  let discoverableAcknowledgements = 0;
  const acknowledged = new Set<string>();
  const activeRelay = peerSync.activeRelayPeerId?.() ?? null;
  const candidates = peerServiceCandidates(token, MAX_STORE_CANDIDATES)
    // The recipient is not an independent storage replica of its own inbox.
    // Avoid wasting one bounded worker on a target that is already known to be
    // unavailable (the reason this path exists).
    .filter(peerId => peerId !== targetPeerId && peerId !== activeRelay);

  const attempts: Array<{
    providerId: string;
    discoverable: boolean;
    store(): Promise<boolean>;
  }> = [];
  if (typeof peerSync.storeInboxAtRelay === 'function') {
    attempts.push({
      providerId: activeRelay ?? `selected-relay:${deliveryId}`,
      discoverable: true,
      store: () => peerSync.storeInboxAtRelay(targetPeerId, token, body, deliveryId),
    });
  }
  for (const peerId of candidates) {
    attempts.push({
      providerId: peerId,
      discoverable: recipientCanDiscoverProvider(targetPeerId, peerId),
      store: async () => {
        const response = await peerSync.requestPeer<{ ok?: boolean; queued?: boolean }>(
          peerId,
          PROTOCOLS.peer,
          'peer.inbox.store',
          {
            recipient_peer_id: targetPeerId,
            token,
            id: deliveryId,
            body,
          },
        );
        return response?.ok === true && response.queued === true;
      },
    });
  }
  if (!attempts.length) return false;

  // Start node-preferred providers first, but do not serialize failover behind
  // a dead selected node or a silent peer. The caller can report "sent" as soon
  // as one independent holder acknowledges; the bounded workers continue in
  // the background until three copies exist or every known provider was tried.
  let cursor = 0;
  let firstDiscoverableAcknowledgement: ((stored: true) => void) | null = null;
  const firstDiscoverableStored = new Promise<true>(resolve => {
    firstDiscoverableAcknowledgement = resolve;
  });
  const worker = async (): Promise<void> => {
    while (cursor < attempts.length && acknowledgements < TARGET_COPIES) {
      const attempt = attempts[cursor++];
      let stored = false;
      try {
        stored = await attempt.store();
      } catch {
        stored = false;
      }
      if (!stored || acknowledged.has(attempt.providerId)) continue;
      acknowledged.add(attempt.providerId);
      acknowledgements++;
      if (attempt.discoverable) {
        discoverableAcknowledgements++;
        if (discoverableAcknowledgements === 1) firstDiscoverableAcknowledgement?.(true);
      }
    }
  };
  const completion = Promise.all(
    Array.from(
      { length: Math.min(MAX_PARALLEL_REQUESTS, attempts.length) },
      () => worker(),
    ),
  ).then(() => discoverableAcknowledgements > 0);
  // Promise.race attaches handlers to completion; this explicit catch also
  // keeps the post-return three-copy repair detached and rejection-safe.
  void completion.catch(() => false);
  return await Promise.race([firstDiscoverableStored, completion]);
}

interface FetchedRecipientInbox {
  bodies: string[];
  acknowledge(ids: string[]): Promise<void>;
}

async function fetchRecipientInboxBodies(tokens: string[]): Promise<FetchedRecipientInbox> {
  const peerSync = getPeerSync();
  if (!peerSync || !tokens.length) {
    return { bodies: [], acknowledge: async () => undefined };
  }
  const bodies: string[] = [];
  const activeRelay = peerSync.activeRelayPeerId?.();
  const appendEntries = (response: {
    ok?: boolean;
    entries?: Array<{ id?: unknown; body?: unknown }>;
  } | null): void => {
    if (response?.ok !== true
      || !Array.isArray(response.entries)
      || response.entries.length > MAX_MAILBOX_DELIVERIES) return;
    for (const entry of response.entries) {
      if (typeof entry?.body === 'string' && bodies.length < MAX_DRAINED_PACKETS) {
        bodies.push(entry.body);
      }
    }
  };

  const candidates = [...new Set(tokens.flatMap(token =>
    peerServiceCandidates(token, MAX_DRAIN_CANDIDATES)))]
    .filter(peerId => peerId !== activeRelay);

  // A dead selected relay must never delay ordinary-peer recovery. Probe it and
  // the bounded peer set concurrently; every response remains untrusted and is
  // authenticated only after packet decryption below.
  const relayDrain = (async () => {
    if (typeof peerSync.drainInboxAtRelay !== 'function') return;
    const relayBodies = await peerSync.drainInboxAtRelay(tokens);
    if (relayBodies && relayBodies.length <= MAX_DRAINED_PACKETS) {
      for (const body of relayBodies) {
        if (bodies.length < MAX_DRAINED_PACKETS) bodies.push(body);
      }
    }
  })();
  const peerDrain = (async () => {
    for (let offset = 0; offset < candidates.length; offset += MAX_PARALLEL_REQUESTS) {
      if (bodies.length >= MAX_DRAINED_PACKETS) return;
      const batch = candidates.slice(offset, offset + MAX_PARALLEL_REQUESTS);
      const responses = await Promise.all(batch.map(peerId =>
        peerSync.requestPeer<{
          ok?: boolean;
          entries?: Array<{ id?: unknown; body?: unknown }>;
        }>(
          peerId,
          PROTOCOLS.peer,
          'peer.inbox.drain',
          { tokens },
        ).catch(() => null)));
      for (const response of responses) appendEntries(response);
    }
  })();
  await Promise.allSettled([relayDrain, peerDrain]);
  return {
    bodies,
    acknowledge: async (ids: string[]): Promise<void> => {
      const uniqueIds = [...new Set(ids)].filter(id =>
        id.length >= 8 && id.length <= 128 && !hasControlCharacters(id));
      if (!uniqueIds.length) return;
      const idBatches = Array.from(
        { length: Math.ceil(uniqueIds.length / MAX_ACKNOWLEDGEMENTS_PER_REQUEST) },
        (_, index) => uniqueIds.slice(
          index * MAX_ACKNOWLEDGEMENTS_PER_REQUEST,
          (index + 1) * MAX_ACKNOWLEDGEMENTS_PER_REQUEST,
        ),
      );
      const attempts: Array<() => Promise<unknown>> = [];
      if (typeof peerSync.drainInboxAtRelay === 'function') {
        for (const idBatch of idBatches) {
          attempts.push(() => peerSync.drainInboxAtRelay(tokens, idBatch));
        }
      }
      for (const peerId of candidates) {
        for (const idBatch of idBatches) {
          attempts.push(() => peerSync.requestPeer(
            peerId,
            PROTOCOLS.peer,
            'peer.inbox.drain',
            { tokens, acknowledge_ids: idBatch },
          ));
        }
      }
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < attempts.length) {
          const attempt = attempts[cursor++];
          try {
            await attempt();
          } catch {
            // A receipt is also retained in encrypted local state. The next
            // drain retries acknowledgements against providers that return.
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(MAX_PARALLEL_REQUESTS, attempts.length) },
          () => worker(),
        ),
      );
    },
  };
}

function decodedPackets(bodies: string[]): RecipientInboxPacket[] {
  const packets: RecipientInboxPacket[] = [];
  const seenBodies = new Set<string>();
  for (const body of bodies) {
    if (seenBodies.has(body) || packets.length >= MAX_DRAINED_PACKETS) continue;
    seenBodies.add(body);
    const framed = unb64url(body, MAX_MAILBOX_BODY_BYTES + 5);
    if (!framed) continue;
    try {
      const raw = unwrapRelayBody(framed);
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
      if (isPlainObject(parsed)) packets.push(parsed as unknown as RecipientInboxPacket);
    } catch {
      // A provider is untrusted. Invalid copies are ignored; valid replicas win.
    }
  }
  return packets;
}

/**
 * Pull, decrypt, verify, de-duplicate, and apply durable operations.
 *
 * `fullWindow` scans the seven-day reconnect window. The periodic background
 * poll uses only today + yesterday, keeping steady-state traffic bounded.
 */
export function drainRecipientInbox(
  apply: (
    operation: RecipientInboxOperation,
  ) => unknown | Promise<unknown>,
  fullWindow = false,
): Promise<number> {
  if (drainInFlight) {
    fullDrainRequested ||= fullWindow;
    return drainInFlight;
  }
  drainInFlight = (async () => {
    let applied = 0;
    let scanFullWindow = fullWindow;
    do {
      fullDrainRequested = false;
      const identity = activeIdentity;
      if (!identity) break;
      const tokens = recipientInboxTokens(identity.peerId, scanFullWindow ? 7 : 1);
      const fetched = await fetchRecipientInboxBodies(tokens);
      const packets = decodedPackets(fetched.bodies);
      const seenThisPass = new Set<string>();
      const acknowledgeIds = new Set<string>();
      for (const packet of packets) {
        const opened = openRecipientInboxPacket(packet, identity);
        if (!opened) continue;
        if (seenThisPass.has(opened.id) || hasSeenInboxDelivery(opened.id)) {
          acknowledgeIds.add(opened.id);
          continue;
        }
        seenThisPass.add(opened.id);
        try {
          const result = await apply(opened);
          // Inbox handlers may signal a recoverable refusal as { ok: false }
          // rather than throw.  Treat it exactly like a transient exception:
          // leave the packet at every provider and retry it on the next drain.
          if (result && typeof result === 'object' && 'ok' in result
            && (result as { ok?: unknown }).ok === false) {
            throw new Error('recipient inbox operation was not accepted');
          }
          markInboxDeliverySeen(opened.id);
          acknowledgeIds.add(opened.id);
          applied++;
        } catch {
          // Do not record or acknowledge a receipt: every provider keeps the
          // packet so a transient local failure can retry safely.
        }
      }
      if (acknowledgeIds.size > 0) {
        // Receipt IDs are already persisted locally. Provider cleanup may
        // continue without delaying UI recovery; a restart retries it.
        void fetched.acknowledge([...acknowledgeIds]).catch(() => undefined);
      }
      scanFullWindow = fullDrainRequested;
    } while (scanFullWindow);
    return applied;
  })().finally(() => {
    drainInFlight = null;
  });
  return drainInFlight;
}

export function recipientInboxPacketTTL(): number {
  return PACKET_TTL_MS;
}
