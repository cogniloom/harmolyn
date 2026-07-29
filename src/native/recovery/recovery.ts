// Social-recovery orchestration: distribute my encrypted backup to guardians,
// hold friends' backups, and run the request → manual-consent → deliver flow.
//
// Security: every blob is the owner's PASSWORD-encrypted identity (opaque). The
// password is never shared. A guardian releasing a blob to the wrong person only
// leaks ciphertext — useless without the password — and release is gated behind
// the guardian's explicit human consent. Senders/requesters are bound to the
// Noise-authenticated connection peer, never a self-asserted payload field.
import type { PeerSync } from '../sync/peersync.js';
import { PROTOCOLS, RECOVERY_OPS } from '../families/families.js';
import { storeCustody, getCustody, type CustodyEntry } from './custody.js';
import { hasControlCharacters, isPlainObject } from '../security/limits.js';

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
  blob: unknown;
  /** Encrypted account-state snapshot (servers/DMs/profile), if the owner synced one. */
  state?: unknown;
  fromPeerId: string;
}

const _pending = new Map<string, PendingRecoveryRequest>();
const MAX_PENDING = 100;
const PENDING_TTL_MS = 15 * 60 * 1000;
const MAX_PEER_ID_BYTES = 256;
const MAX_DISPLAY_NAME_BYTES = 256;
const MAX_BLOB_JSON_BYTES = 1 * 1024 * 1024;
const MAX_STATE_JSON_BYTES = 4 * 1024 * 1024;

function validPeerId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PEER_ID_BYTES
    && !hasControlCharacters(value);
}

function boundedObject(value: unknown, maxBytes: number): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  try { return JSON.stringify(value).length <= maxBytes; } catch { return false; }
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
  if (state !== undefined && !boundedObject(state, MAX_STATE_JSON_BYTES)) return { ok: false, error: 'invalid_state' };
  const entry: CustodyEntry = {
    ownerPeerId: remotePeerId, // bind to the authenticated sender, not a payload field
    ownerDisplayName: typeof payload.owner_display_name === 'string'
      ? payload.owner_display_name.slice(0, MAX_DISPLAY_NAME_BYTES)
      : '',
    blob,
    ...(state !== undefined ? { state } : {}),
    receivedAt: new Date().toISOString(),
  };
  await storeCustody(entry);
  return { ok: true };
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
export function handleRecoveryDeliver(payload: Record<string, unknown>, remotePeerId: string): Record<string, unknown> {
  const ownerPeerId = typeof payload.owner_peer_id === 'string' ? payload.owner_peer_id.trim() : '';
  const blob = payload.blob;
  const state = payload.state;
  if (!validPeerId(ownerPeerId) || !validPeerId(remotePeerId) || !boundedObject(blob, MAX_BLOB_JSON_BYTES)
    || (state !== undefined && !boundedObject(state, MAX_STATE_JSON_BYTES))) return { ok: false, error: 'bad_delivery' };
  emit(RECOVERY_DELIVERED_EVENT, { ownerPeerId, blob, state, fromPeerId: remotePeerId } as RecoveryDelivery);
  return { ok: true };
}

// ── Owner side: distribute my backup to chosen guardians ──────────────────────

export async function distributeRecovery(
  peerSync: PeerSync,
  contacts: string[],
  ownerDisplayName: string,
  blob: unknown,
  state?: unknown,
): Promise<{ delivered: string[]; failed: string[] }> {
  if (!boundedObject(blob, MAX_BLOB_JSON_BYTES) || (state !== undefined && !boundedObject(state, MAX_STATE_JSON_BYTES))) {
    return { delivered: [], failed: contacts.filter(validPeerId) };
  }
  const delivered: string[] = [];
  const failed: string[] = [];
  const safeContacts = Array.from(new Set(contacts.filter(validPeerId))).slice(0, MAX_PENDING);
  await Promise.allSettled(safeContacts.map(async (peerId) => {
    const resp = await peerSync.requestPeer<{ ok?: boolean }>(peerId, PROTOCOLS.recovery, RECOVERY_OPS.store, {
      owner_display_name: ownerDisplayName,
      blob,
      ...(state ? { state } : {}),
    });
    if (resp?.ok) delivered.push(peerId); else failed.push(peerId);
  }));
  return { delivered, failed: [...failed, ...contacts.filter(peerId => !safeContacts.includes(peerId))] };
}

// ── Requester side: ask a guardian to release my backup ───────────────────────

export async function sendRecoveryRequest(
  peerSync: PeerSync,
  guardianPeerId: string,
  ownerPeerId: string,
): Promise<{ ok: boolean; pending?: boolean; error?: string }> {
  if (!validPeerId(guardianPeerId) || !validPeerId(ownerPeerId)) return { ok: false, error: 'invalid_peer' };
  const resp = await peerSync.requestPeer<{ ok?: boolean; pending?: boolean; error?: string }>(
    guardianPeerId, PROTOCOLS.recovery, RECOVERY_OPS.request, { owner_peer_id: ownerPeerId },
  );
  if (!resp) return { ok: false, error: 'unreachable' };
  return { ok: !!resp.ok, pending: resp.pending, error: resp.error };
}

// ── Guardian side: approve / deny a pending request ───────────────────────────

export async function approveRecovery(peerSync: PeerSync, requestId: string): Promise<boolean> {
  prunePending();
  const req = _pending.get(requestId);
  if (!req) return false;
  const custody = await getCustody(req.ownerPeerId);
  if (!custody) { _pending.delete(requestId); return false; }
  const resp = await peerSync.requestPeer<{ ok?: boolean }>(
    req.requesterPeerId, PROTOCOLS.recovery, RECOVERY_OPS.deliver,
    { owner_peer_id: req.ownerPeerId, blob: custody.blob, ...(custody.state ? { state: custody.state } : {}) },
  );
  _pending.delete(requestId);
  return !!resp?.ok;
}

export function denyRecovery(requestId: string): void {
  prunePending();
  _pending.delete(requestId);
}
