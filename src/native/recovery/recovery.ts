// Social-recovery orchestration: distribute my encrypted backup to guardians,
// hold friends' backups, and run the request → manual-consent → deliver flow.
//
// Security: every blob is the owner's PASSWORD-encrypted identity (opaque). The
// password is never shared. A guardian releasing a blob to the wrong person only
// leaks ciphertext — useless without the password — and release is gated behind
// the guardian's explicit human consent. Senders/requesters are bound to the
// Noise-authenticated connection peer, never a self-asserted payload field.
import type { PeerSync } from '../sync/peersync.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { PROTOCOLS, RECOVERY_OPS } from '../families/families.js';
import { storeCustody, getCustody, type CustodyEntry } from './custody.js';
import {
  decodeBase64Strict,
  encodeBase64Chunked,
  hasControlCharacters,
  isPlainObject,
  MAX_SYNC_STATE_BYTES,
} from '../security/limits.js';
import { isEncryptedSyncBlob, PENDING_STATE_KEY } from '../state/stateSync.js';
import { depositRecipientInboxOperation } from '../delivery/recipientInbox.js';
import {
  appendRecoveryChunk,
  deleteRecoveryChunks,
  readRecoveryChunks,
} from './chunks.js';

// ── UI event bus (window CustomEvents) ───────────────────────────────────────

export const RECOVERY_REQUEST_EVENT = 'harmolyn:recovery:request';
export const RECOVERY_DELIVERED_EVENT = 'harmolyn:recovery:delivered';

export interface PendingRecoveryRequest {
  id: string;
  ownerPeerId: string;     // the account being recovered
  requesterPeerId: string; // who is asking (current device)
  requestedAt: string;
}

export interface RecoveryDelivery {
  ownerPeerId: string;
  /** Absent on a late, state-only fragment completion event. */
  blob?: unknown;
  /** Encrypted account-state snapshot (servers/DMs/profile), if the owner synced one. */
  state?: unknown;
  fromPeerId: string;
}

export interface RecoveryDistributionResult {
  /** Guardians that accepted the custody update over a live authenticated path. */
  delivered: string[];
  /** Guardians whose update was sealed to them and durably replicated for later delivery. */
  queued: string[];
  /** Guardians whose identity queued but whose complete chunk set did not. */
  identityOnly: string[];
  failed: string[];
}

const _pending = new Map<string, PendingRecoveryRequest>();
const MAX_PENDING = 100;
const PENDING_TTL_MS = 15 * 60 * 1000;
const MAX_PEER_ID_BYTES = 256;
const MAX_DISPLAY_NAME_BYTES = 256;
const MAX_BLOB_JSON_BYTES = 1 * 1024 * 1024;
const MAX_STATE_JSON_BYTES = Math.ceil((MAX_SYNC_STATE_BYTES + 16) * 4 / 3) + 4096;
const RECOVERY_CHUNK_BYTES = 384 * 1024;
const MAX_RECOVERY_CHUNKS = 16;
const MAX_PARALLEL_GUARDIANS = 4;

export interface RecoveryStateManifest {
  version: 1;
  transfer_id: string;
  chunk_count: number;
  total_bytes: number;
  sha256: string;
}

export interface RecoveryStateTransfer {
  manifest: RecoveryStateManifest;
  chunks: string[];
}

function validPeerId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PEER_ID_BYTES
    && !hasControlCharacters(value);
}

function boundedObject(value: unknown, maxBytes: number): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes; } catch { return false; }
}

function validEncryptedState(value: unknown): boolean {
  return isEncryptedSyncBlob(value) && boundedObject(value, MAX_STATE_JSON_BYTES);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function validTransferId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128
    && !hasControlCharacters(value);
}

function parseStateManifest(value: unknown): RecoveryStateManifest | null {
  if (!isPlainObject(value)
    || value.version !== 1
    || !validTransferId(value.transfer_id)
    || !Number.isSafeInteger(value.chunk_count)
    || Number(value.chunk_count) < 1
    || Number(value.chunk_count) > MAX_RECOVERY_CHUNKS
    || !Number.isSafeInteger(value.total_bytes)
    || Number(value.total_bytes) < 1
    || Number(value.total_bytes) > MAX_STATE_JSON_BYTES
    || Number(value.chunk_count) !== Math.ceil(Number(value.total_bytes) / RECOVERY_CHUNK_BYTES)
    || typeof value.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  return value as unknown as RecoveryStateManifest;
}

function manifestFingerprint(manifest: RecoveryStateManifest): string {
  return `${manifest.version}:${manifest.transfer_id}:${manifest.chunk_count}:${manifest.total_bytes}:${manifest.sha256}`;
}

function assemblyKey(
  kind: 'store' | 'deliver',
  remotePeerId: string,
  manifest: RecoveryStateManifest,
  ownerPeerId = '',
): string {
  return `${kind}:${remotePeerId}:${ownerPeerId}:${manifest.transfer_id}`;
}

function sourceKey(kind: 'store' | 'deliver', remotePeerId: string, ownerPeerId = ''): string {
  return `${kind}:${remotePeerId}:${ownerPeerId}`;
}

export function buildRecoveryStateTransfer(state: unknown): RecoveryStateTransfer | null {
  if (!validEncryptedState(state)) return null;
  const encoded = new TextEncoder().encode(JSON.stringify(state));
  const chunkCount = Math.ceil(encoded.length / RECOVERY_CHUNK_BYTES);
  if (!chunkCount || chunkCount > MAX_RECOVERY_CHUNKS) return null;
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += RECOVERY_CHUNK_BYTES) {
    chunks.push(encodeBase64Chunked(encoded.subarray(offset, offset + RECOVERY_CHUNK_BYTES)));
  }
  return {
    manifest: {
      version: 1,
      transfer_id: crypto.randomUUID(),
      chunk_count: chunks.length,
      total_bytes: encoded.length,
      sha256: hex(sha256(encoded)),
    },
    chunks,
  };
}

function decodeRecoveryState(manifest: RecoveryStateManifest, chunks: string[]): unknown | null {
  if (chunks.length !== manifest.chunk_count) return null;
  const decoded: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < chunks.length; index++) {
    const expected = index === chunks.length - 1
      ? manifest.total_bytes - RECOVERY_CHUNK_BYTES * index
      : RECOVERY_CHUNK_BYTES;
    const bytes = decodeBase64Strict(chunks[index], RECOVERY_CHUNK_BYTES);
    if (!bytes || bytes.length !== expected) return null;
    decoded.push(bytes);
    total += bytes.length;
  }
  if (total !== manifest.total_bytes) return null;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const bytes of decoded) {
    joined.set(bytes, offset);
    offset += bytes.length;
  }
  if (hex(sha256(joined)) !== manifest.sha256) return null;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown;
    return validEncryptedState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function consumeRecoveryState(
  kind: 'store' | 'deliver',
  remotePeerId: string,
  manifest: RecoveryStateManifest,
  completedChunks?: string[],
  ownerPeerId = '',
): Promise<unknown | null> {
  const key = assemblyKey(kind, remotePeerId, manifest, ownerPeerId);
  const chunks = completedChunks ?? await readRecoveryChunks(
    key,
    sourceKey(kind, remotePeerId, ownerPeerId),
    `${manifestFingerprint(manifest)}:${ownerPeerId}`,
  );
  if (!chunks) return null;
  const state = decodeRecoveryState(manifest, chunks);
  await deleteRecoveryChunks(key);
  return state;
}

function persistDeliveredState(state: unknown): void {
  if (!validEncryptedState(state)) return;
  try { localStorage.setItem(PENDING_STATE_KEY, JSON.stringify(state)); } catch { /* best effort */ }
}

function prunePending(now = Date.now()): void {
  for (const [id, request] of _pending) {
    const timestamp = Date.parse(request.requestedAt);
    if (!Number.isFinite(timestamp) || now - timestamp > PENDING_TTL_MS) _pending.delete(id);
  }
}

function emit(name: string, detail: unknown): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function listPendingRecovery(): PendingRecoveryRequest[] {
  prunePending();
  return Array.from(_pending.values());
}

// ── Inbound handlers (called by the engine's recovery family handler) ─────────

/** owner → guardian: persist the owner's encrypted backup. Owner == auth'd peer. */
export async function handleRecoveryStore(payload: Record<string, unknown>, remotePeerId: string): Promise<Record<string, unknown>> {
  const blob = payload.blob;
  if (!validPeerId(remotePeerId) || !boundedObject(blob, MAX_BLOB_JSON_BYTES)) return { ok: false, error: 'invalid_blob' };
  const state = payload.state === undefined ? undefined : payload.state;
  const manifest = payload.state_manifest === undefined ? null : parseStateManifest(payload.state_manifest);
  if ((state !== undefined && !validEncryptedState(state))
    || (payload.state_manifest !== undefined && !manifest)
    || (state !== undefined && manifest)) return { ok: false, error: 'invalid_state' };
  const entry: CustodyEntry = {
    ownerPeerId: remotePeerId, // bind to the authenticated sender, not a payload field
    ownerDisplayName: typeof payload.owner_display_name === 'string'
      ? payload.owner_display_name.slice(0, MAX_DISPLAY_NAME_BYTES)
      : '',
    blob,
    ...(state !== undefined ? { state } : {}),
    receivedAt: new Date().toISOString(),
  };
  if (manifest) {
    // Install the refreshed identity/base packet first, but carry forward the
    // last verified state until this transfer authenticates. Doing this before
    // consuming chunks also orders a concurrent final-chunk handler after the
    // preservation write instead of allowing the old state to overwrite it.
    const previous = await getCustody(remotePeerId);
    await storeCustody({
      ...entry,
      ...(previous?.state !== undefined ? { state: previous.state } : {}),
    });
    const assembled = await consumeRecoveryState('store', remotePeerId, manifest);
    if (assembled) {
      await storeCustody({ ...entry, state: assembled });
    }
  } else {
    await storeCustody(entry);
  }
  return { ok: true };
}

async function handleRecoveryChunk(
  payload: Record<string, unknown>,
  remotePeerId: string,
  kind: 'store' | 'deliver',
): Promise<Record<string, unknown>> {
  if (!validPeerId(remotePeerId)) return { ok: false, error: 'invalid_peer' };
  const ownerPeerId = kind === 'deliver' && typeof payload.owner_peer_id === 'string'
    ? payload.owner_peer_id.trim()
    : '';
  if (kind === 'deliver' && !validPeerId(ownerPeerId)) return { ok: false, error: 'invalid_owner' };
  const manifest = parseStateManifest(payload.state_manifest);
  const chunkIndex = payload.chunk_index;
  if (!manifest
    || !Number.isSafeInteger(chunkIndex)
    || Number(chunkIndex) < 0
    || Number(chunkIndex) >= manifest.chunk_count
    || typeof payload.chunk !== 'string') return { ok: false, error: 'invalid_chunk' };
  const expectedBytes = Number(chunkIndex) === manifest.chunk_count - 1
    ? manifest.total_bytes - RECOVERY_CHUNK_BYTES * Number(chunkIndex)
    : RECOVERY_CHUNK_BYTES;
  const decoded = decodeBase64Strict(payload.chunk, RECOVERY_CHUNK_BYTES);
  if (!decoded || decoded.length !== expectedBytes) return { ok: false, error: 'invalid_chunk' };

  const result = await appendRecoveryChunk({
    key: assemblyKey(kind, remotePeerId, manifest, ownerPeerId),
    source: sourceKey(kind, remotePeerId, ownerPeerId),
    fingerprint: `${manifestFingerprint(manifest)}:${ownerPeerId}`,
    chunkCount: manifest.chunk_count,
    chunkIndex: Number(chunkIndex),
    data: payload.chunk,
  });
  if (!result.accepted) return { ok: false, error: 'conflicting_chunk' };
  if (!result.chunks) return { ok: true, complete: false };

  if (kind === 'store') {
    // A provider may replay chunks before the small identity/manifest packet.
    // Keep the complete encrypted assembly until that base packet arrives.
    const custody = await getCustody(remotePeerId);
    if (!custody) return { ok: true, complete: false };
    const state = await consumeRecoveryState(kind, remotePeerId, manifest, result.chunks);
    if (!state) return { ok: false, error: 'invalid_state_hash' };
    await storeCustody({ ...custody, state });
    return { ok: true, complete: true };
  }

  const state = await consumeRecoveryState(kind, remotePeerId, manifest, result.chunks, ownerPeerId);
  if (!state) return { ok: false, error: 'invalid_state_hash' };
  persistDeliveredState(state);
  emit(RECOVERY_DELIVERED_EVENT, {
    ownerPeerId,
    state,
    fromPeerId: remotePeerId,
  } as RecoveryDelivery);
  return { ok: true, complete: true };
}

export function handleRecoveryStoreChunk(
  payload: Record<string, unknown>,
  remotePeerId: string,
): Promise<Record<string, unknown>> {
  return handleRecoveryChunk(payload, remotePeerId, 'store');
}

export function handleRecoveryDeliverChunk(
  payload: Record<string, unknown>,
  remotePeerId: string,
): Promise<Record<string, unknown>> {
  return handleRecoveryChunk(payload, remotePeerId, 'deliver');
}

/** requester → guardian: surface a consent prompt; do NOT auto-release. */
export async function handleRecoveryRequest(payload: Record<string, unknown>, remotePeerId: string): Promise<Record<string, unknown>> {
  prunePending();
  const ownerPeerId = typeof payload.owner_peer_id === 'string' ? payload.owner_peer_id.trim() : '';
  if (!validPeerId(ownerPeerId) || !validPeerId(remotePeerId)) return { ok: false, error: 'invalid_owner' };
  const custody = await getCustody(ownerPeerId);
  if (!custody) return { ok: false, error: 'no_custody' };
  if (_pending.size >= MAX_PENDING) return { ok: false, error: 'busy' };
  const req: PendingRecoveryRequest = {
    id: crypto.randomUUID(),
    ownerPeerId,
    requesterPeerId: remotePeerId,
    requestedAt: new Date().toISOString(),
  };
  _pending.set(req.id, req);
  emit(RECOVERY_REQUEST_EVENT, req);
  return { ok: true, pending: true };
}

/** guardian → requester (post-consent): the backup arrived. Hand to the UI. */
export async function handleRecoveryDeliver(payload: Record<string, unknown>, remotePeerId: string): Promise<Record<string, unknown>> {
  const ownerPeerId = typeof payload.owner_peer_id === 'string' ? payload.owner_peer_id.trim() : '';
  const blob = payload.blob;
  const state = payload.state;
  const manifest = payload.state_manifest === undefined ? null : parseStateManifest(payload.state_manifest);
  if (!validPeerId(ownerPeerId) || !validPeerId(remotePeerId) || !boundedObject(blob, MAX_BLOB_JSON_BYTES)
    || (state !== undefined && !validEncryptedState(state))
    || (payload.state_manifest !== undefined && !manifest)
    || (state !== undefined && manifest)) return { ok: false, error: 'bad_delivery' };
  const assembled = manifest
    ? await consumeRecoveryState('deliver', remotePeerId, manifest, undefined, ownerPeerId)
    : null;
  const deliveredState = state ?? assembled ?? undefined;
  if (deliveredState !== undefined) persistDeliveredState(deliveredState);
  emit(RECOVERY_DELIVERED_EVENT, {
    ownerPeerId,
    blob,
    ...(deliveredState !== undefined ? { state: deliveredState } : {}),
    fromPeerId: remotePeerId,
  } as RecoveryDelivery);
  return { ok: true };
}

// ── Owner side: distribute my backup to chosen guardians ──────────────────────

async function queueRecoveryTransfer(
  targetPeerId: string,
  baseOperation: typeof RECOVERY_OPS.store | typeof RECOVERY_OPS.deliver,
  chunkOperation: typeof RECOVERY_OPS.storeChunk | typeof RECOVERY_OPS.deliverChunk,
  basePayload: Record<string, unknown>,
  transfer: RecoveryStateTransfer | null,
  ownerPeerId?: string,
): Promise<{ identity: boolean; complete: boolean }> {
  const base = {
    ...basePayload,
    ...(transfer ? { state_manifest: transfer.manifest } : {}),
  };
  const identity = await depositRecipientInboxOperation(
    targetPeerId,
    PROTOCOLS.recovery,
    baseOperation,
    base,
  );
  if (!identity || !transfer) return { identity, complete: identity };

  // Keep each independently sealed packet comfortably below the recipient
  // inbox bound. The provider repair inside each deposit still fans it out to
  // three holders; this loop only bounds local CPU/network pressure.
  for (let index = 0; index < transfer.chunks.length; index++) {
    const stored = await depositRecipientInboxOperation(
      targetPeerId,
      PROTOCOLS.recovery,
      chunkOperation,
      {
        ...(ownerPeerId ? { owner_peer_id: ownerPeerId } : {}),
        state_manifest: transfer.manifest,
        chunk_index: index,
        chunk: transfer.chunks[index],
      },
    );
    if (!stored) return { identity: true, complete: false };
  }
  return { identity: true, complete: true };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

export async function distributeRecovery(
  peerSync: PeerSync,
  contacts: string[],
  ownerDisplayName: string,
  blob: unknown,
  state?: unknown,
): Promise<RecoveryDistributionResult> {
  if (!boundedObject(blob, MAX_BLOB_JSON_BYTES) || (state !== undefined && !validEncryptedState(state))) {
    return { delivered: [], queued: [], identityOnly: [], failed: contacts.filter(validPeerId) };
  }
  const safeContacts = Array.from(new Set(contacts.filter(validPeerId))).slice(0, MAX_PENDING);
  const invalid = contacts.filter(peerId => !safeContacts.includes(peerId));
  const transfer = state === undefined ? null : buildRecoveryStateTransfer(state);
  if (state !== undefined && !transfer) {
    return { delivered: [], queued: [], identityOnly: [], failed: [...safeContacts, ...invalid] };
  }
  const outcomes = await mapWithConcurrency(safeContacts, MAX_PARALLEL_GUARDIANS, async (peerId): Promise<{
    peerId: string;
    outcome: 'delivered' | 'queued' | 'identity-only' | 'failed';
  }> => {
    const fullPayload = {
      owner_display_name: ownerDisplayName,
      blob,
      ...(state ? { state } : {}),
    };
    const resp = await peerSync.requestPeer<{ ok?: boolean }>(
      peerId,
      PROTOCOLS.recovery,
      RECOVERY_OPS.store,
      fullPayload,
    ).catch(() => null);
    if (resp?.ok) return { peerId, outcome: 'delivered' };

    // A live guardian is not required. The generic recipient inbox seals this
    // operation to the guardian's static key, hybrid-signs it as the owner, and
    // repairs it toward three independent providers (nodes first, peers next).
    // Providers therefore cannot inspect the password-encrypted identity blob
    // or use it as an offline password oracle.
    const queued = await depositRecipientInboxOperation(
      peerId,
      PROTOCOLS.recovery,
      RECOVERY_OPS.store,
      fullPayload,
    );
    if (queued) return { peerId, outcome: 'queued' };

    const chunked = await queueRecoveryTransfer(
      peerId,
      RECOVERY_OPS.store,
      RECOVERY_OPS.storeChunk,
      { owner_display_name: ownerDisplayName, blob },
      transfer,
    );
    if (chunked.complete) return { peerId, outcome: 'queued' };
    if (chunked.identity) return { peerId, outcome: 'identity-only' };

    return { peerId, outcome: 'failed' };
  });
  return {
    delivered: outcomes.filter(value => value.outcome === 'delivered').map(value => value.peerId),
    queued: outcomes.filter(value => value.outcome === 'queued' || value.outcome === 'identity-only').map(value => value.peerId),
    identityOnly: outcomes.filter(value => value.outcome === 'identity-only').map(value => value.peerId),
    failed: [...outcomes.filter(value => value.outcome === 'failed').map(value => value.peerId), ...invalid],
  };
}

// ── Requester side: ask a guardian to release my backup ───────────────────────

export async function sendRecoveryRequest(
  peerSync: PeerSync,
  guardianPeerId: string,
  ownerPeerId: string,
): Promise<{ ok: boolean; pending?: boolean; queued?: boolean; error?: string }> {
  if (!validPeerId(guardianPeerId) || !validPeerId(ownerPeerId)) return { ok: false, error: 'invalid_peer' };
  const resp = await peerSync.requestPeer<{ ok?: boolean; pending?: boolean; error?: string }>(
    guardianPeerId, PROTOCOLS.recovery, RECOVERY_OPS.request, { owner_peer_id: ownerPeerId },
  );
  if (!resp) {
    const queued = await depositRecipientInboxOperation(
      guardianPeerId,
      PROTOCOLS.recovery,
      RECOVERY_OPS.request,
      { owner_peer_id: ownerPeerId },
    );
    return queued
      ? { ok: true, pending: true, queued: true }
      : { ok: false, error: 'unreachable' };
  }
  return { ok: !!resp.ok, pending: resp.pending, error: resp.error };
}

// ── Guardian side: approve / deny a pending request ───────────────────────────

export async function approveRecovery(peerSync: PeerSync, requestId: string): Promise<boolean> {
  prunePending();
  const req = _pending.get(requestId);
  if (!req) return false;
  const custody = await getCustody(req.ownerPeerId);
  if (!custody) { _pending.delete(requestId); return false; }
  const payload = {
    owner_peer_id: req.ownerPeerId,
    blob: custody.blob,
    ...(custody.state ? { state: custody.state } : {}),
  };
  const resp = await peerSync.requestPeer<{ ok?: boolean }>(
    req.requesterPeerId, PROTOCOLS.recovery, RECOVERY_OPS.deliver,
    payload,
  ).catch(() => null);
  let secured = resp?.ok === true;
  if (!secured) {
    secured = await depositRecipientInboxOperation(
      req.requesterPeerId,
      PROTOCOLS.recovery,
      RECOVERY_OPS.deliver,
      payload,
    );
  }
  if (!secured && custody.state !== undefined) {
    const transfer = buildRecoveryStateTransfer(custody.state);
    if (!transfer) return false;
    const chunked = await queueRecoveryTransfer(
      req.requesterPeerId,
      RECOVERY_OPS.deliver,
      RECOVERY_OPS.deliverChunk,
      { owner_peer_id: req.ownerPeerId, blob: custody.blob },
      transfer,
      req.ownerPeerId,
    );
    secured = chunked.complete;
  }
  if (secured) _pending.delete(requestId);
  return secured;
}

export function denyRecovery(requestId: string): void {
  prunePending();
  _pending.delete(requestId);
}
