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

function emit(name: string, detail: unknown): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function listPendingRecovery(): PendingRecoveryRequest[] {
  return Array.from(_pending.values());
}

// ── Inbound handlers (called by the engine's recovery family handler) ─────────

/** owner → guardian: persist the owner's encrypted backup. Owner == auth'd peer. */
export async function handleRecoveryStore(payload: Record<string, unknown>, remotePeerId: string): Promise<Record<string, unknown>> {
  const blob = payload.blob;
  if (!blob || typeof blob !== 'object') return { ok: false, error: 'no_blob' };
  const entry: CustodyEntry = {
    ownerPeerId: remotePeerId, // bind to the authenticated sender, not a payload field
    ownerDisplayName: typeof payload.owner_display_name === 'string' ? payload.owner_display_name : '',
    blob,
    ...(payload.state && typeof payload.state === 'object' ? { state: payload.state } : {}),
    receivedAt: new Date().toISOString(),
  };
  await storeCustody(entry);
  return { ok: true };
}

/** requester → guardian: surface a consent prompt; do NOT auto-release. */
export async function handleRecoveryRequest(payload: Record<string, unknown>, remotePeerId: string): Promise<Record<string, unknown>> {
  const ownerPeerId = String(payload.owner_peer_id ?? '').trim();
  if (!ownerPeerId) return { ok: false, error: 'no_owner' };
  const custody = await getCustody(ownerPeerId);
  if (!custody) return { ok: false, error: 'no_custody' };
  const req: PendingRecoveryRequest = {
    id: `${ownerPeerId}:${remotePeerId}:${Math.floor(Math.random() * 1e9)}`,
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
  const ownerPeerId = String(payload.owner_peer_id ?? '').trim();
  const blob = payload.blob;
  if (!ownerPeerId || !blob) return { ok: false, error: 'bad_delivery' };
  emit(RECOVERY_DELIVERED_EVENT, { ownerPeerId, blob, state: payload.state, fromPeerId: remotePeerId } as RecoveryDelivery);
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
  const delivered: string[] = [];
  const failed: string[] = [];
  await Promise.allSettled(contacts.map(async (peerId) => {
    const resp = await peerSync.requestPeer<{ ok?: boolean }>(peerId, PROTOCOLS.recovery, RECOVERY_OPS.store, {
      owner_display_name: ownerDisplayName,
      blob,
      ...(state ? { state } : {}),
    });
    if (resp?.ok) delivered.push(peerId); else failed.push(peerId);
  }));
  return { delivered, failed };
}

// ── Requester side: ask a guardian to release my backup ───────────────────────

export async function sendRecoveryRequest(
  peerSync: PeerSync,
  guardianPeerId: string,
  ownerPeerId: string,
): Promise<{ ok: boolean; pending?: boolean; error?: string }> {
  const resp = await peerSync.requestPeer<{ ok?: boolean; pending?: boolean; error?: string }>(
    guardianPeerId, PROTOCOLS.recovery, RECOVERY_OPS.request, { owner_peer_id: ownerPeerId },
  );
  if (!resp) return { ok: false, error: 'unreachable' };
  return { ok: !!resp.ok, pending: resp.pending, error: resp.error };
}

// ── Guardian side: approve / deny a pending request ───────────────────────────

export async function approveRecovery(peerSync: PeerSync, requestId: string): Promise<boolean> {
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
  _pending.delete(requestId);
}
