// Inbound PeerStream family handlers: receive chat messages, reactions, and
// presence/typing updates from remote peers and apply them to the local store.
import type { Libp2p } from 'libp2p';
import type { XoreinRuntimeServer, XoreinRuntimeMessage } from '../../types.js';
import {
  frameMessage, unframeMessage,
  decodePeerStreamRequest, encodePeerStreamResponse,
} from '../families/peerstream.js';
import { PROTOCOLS } from '../families/families.js';
import { addMessage, editMessage as storeEditMessage, deleteMessage as storeDeleteMessage, pinMessage as storePinMessage, updatePresenceEntry, addReaction, removeReaction, getState, updateServer, upsertPeer, addFriendRequest, acceptFriendByPeer, ensureDm, bumpUnread, getActiveScope, removeServerMembership, removeServerMember, addPollVote, memberHasPermission, addReport } from '../state/store.js';
import { nativeAnnouncePresence, broadcastServerUpdate, rotateCrowdEpoch } from '../state/mutations.js';
import { publishNativeSnapshot } from '../state/snapshot.js';
import { decryptInboundEnvelope, getScopeCrypto, applyCrowdRoot, type DecryptedMessage } from './secureEnvelope.js';
import { verifyInviteToken } from './invite.js';
import type { PeerSync } from './peersync.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Buffer for channel ciphertext that arrives under a Crowd epoch NEWER than the one we
 * currently hold. After a kick/join the owner rotates the epoch and distributes the new
 * root via a fire-and-forget sync.update on a separate stream, so a channel message under
 * the new epoch can race ahead of the root. Rather than drop it permanently (undecryptable
 * → lost), hold it briefly and replay it once the matching root installs. Bounded per
 * server; the oldest entry is evicted past the cap so a never-arriving epoch can't grow it.
 */
const FUTURE_EPOCH_BUFFER = new Map<string, { payload: Record<string, unknown>; remotePeerId: string; epoch: number }[]>();
const MAX_FUTURE_EPOCH_BUFFERED = 100;

function bufferFutureEpochChannelMessage(payload: Record<string, unknown>, remotePeerId: string, scopeId: string): void {
  const wire = payload.crowd as { epoch?: number } | undefined;
  if (!wire || typeof wire.epoch !== 'number') return;
  const state = getState();
  const server = Object.values(state.servers).find(s => Object.keys(s.channels ?? {}).includes(scopeId));
  if (!server) return;
  const installed = typeof server.crowd_epoch === 'number' ? server.crowd_epoch : 0;
  // Only buffer a genuinely FUTURE epoch — a same/older-epoch decrypt failure is a real
  // reject (tamper, wrong key, expired legacy window) and must stay dropped.
  if (wire.epoch <= installed) return;
  const list = FUTURE_EPOCH_BUFFER.get(server.id) ?? [];
  const messageId = String(payload.message_id ?? '');
  if (messageId && list.some(e => String(e.payload.message_id ?? '') === messageId)) return; // dedup
  list.push({ payload, remotePeerId, epoch: wire.epoch });
  while (list.length > MAX_FUTURE_EPOCH_BUFFERED) list.shift();
  FUTURE_EPOCH_BUFFER.set(server.id, list);
}

/**
 * Replay any buffered future-epoch channel messages that the newly-installed root can now
 * decrypt. Called right after a server's Crowd root advances (sync.update). Messages still
 * ahead of the installed epoch stay buffered for a later rotation.
 */
/**
 * Enforce a member's join-history boundary: messages strictly older than when they joined
 * are withheld beyond the `joinWindow` (join_history_messages) allowance. A member with no
 * recorded boundary (owner, or a member from before boundaries were tracked) sees the set
 * unchanged. `msgs` must already be sorted oldest→newest.
 */
function applyJoinBoundary(
  msgs: XoreinRuntimeMessage[],
  memberSince: string | undefined,
  joinWindow: number,
): XoreinRuntimeMessage[] {
  if (!memberSince) return msgs;
  const preJoin = msgs.filter(m => String(m.created_at ?? '') < memberSince);
  const postJoin = msgs.filter(m => String(m.created_at ?? '') >= memberSince);
  const allowedPreJoin = joinWindow > 0 ? preJoin.slice(-joinWindow) : [];
  return [...allowedPreJoin, ...postJoin];
}

export function replayBufferedChannelMessages(serverId: string): void {
  const list = FUTURE_EPOCH_BUFFER.get(serverId);
  if (!list || !list.length) return;
  const server = getState().servers[serverId];
  const installed = typeof server?.crowd_epoch === 'number' ? server.crowd_epoch : 0;
  const ready = list.filter(e => e.epoch <= installed);
  const remaining = list.filter(e => e.epoch > installed);
  if (remaining.length) FUTURE_EPOCH_BUFFER.set(serverId, remaining);
  else FUTURE_EPOCH_BUFFER.delete(serverId);
  for (const e of ready) handleChatSend(e.payload, e.remotePeerId); // idempotent (dedups by id)
}

/**
 * Surface an ephemeral notification to the UI. The native layer runs outside
 * React, so it dispatches a DOM CustomEvent that a listener in Layout forwards to
 * the toast bus (and, where granted, a desktop Notification). No-op off-DOM.
 */
function emitNotify(detail: { kind: string; title: string; body: string; scopeId?: string }): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('harmolyn:notify', { detail }));
    }
  } catch { /* non-DOM environment (tests / workers) */ }
}

/**
 * Classify an inbound CHANNEL message for notification routing so the user's stored
 * notification level actually applies to channel traffic (previously only DMs emitted
 * events, so "All messages" / "Mentions only" were dead for channels). The kinds line
 * up with the pref filter in Layout: `everyone`/`role` are broadcast pings that
 * suppressEveryone/suppressRoles can mute; `mention` is a direct ping that survives
 * "Mentions only"; `channel` is ordinary traffic that "Mentions only" drops.
 */
export function classifyChannelNotification(
  server: { roles?: { id: string; name?: string }[]; member_roles?: Record<string, string[]> },
  mePeerId: string,
  myDisplayName: string | undefined,
  body: string,
): 'everyone' | 'role' | 'mention' | 'channel' {
  const text = (body ?? '').toLowerCase();
  if (/@(everyone|here)\b/i.test(body ?? '')) return 'everyone';
  const myName = myDisplayName?.trim().toLowerCase();
  if ((myName && text.includes('@' + myName)) || (mePeerId && text.includes('@' + mePeerId.toLowerCase()))) {
    return 'mention';
  }
  // A role ping counts only when it targets a role the local user actually holds.
  const myRoleIds = new Set((server.member_roles ?? {})[mePeerId] ?? []);
  const myRoleNames = (server.roles ?? [])
    .filter((r) => myRoleIds.has(r.id))
    .map((r) => String(r.name ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (myRoleNames.some((name) => text.includes('@' + name))) return 'role';
  return 'channel';
}

/** Best-effort display name for a peer from learned presence/profile. */
function peerDisplayName(peerId: string): string {
  return getState().peers[peerId]?.display_name?.trim() || 'Someone';
}

function okResponse(requestId?: string): Uint8Array {
  const resp = encodePeerStreamResponse({
    payload: enc.encode(JSON.stringify({ ok: true })),
    requestId,
  });
  return frameMessage(resp);
}

async function readStream(stream: AsyncIterable<Uint8Array | { subarray(): Uint8Array }>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
  }
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let off = 0;
  for (const c of chunks) { total.set(c, off); off += c.length; }
  return total;
}

/**
 * The encryption mode every message in a given scope MUST carry: DMs are Seal
 * (X3DH + Double Ratchet), channels are Crowd (sender-key broadcast). This is the
 * fail-closed policy — an inbound message whose `enc` does not match is rejected,
 * never decoded as plaintext, so a peer cannot downgrade a conversation to cleartext.
 */
function requiredEnc(scopeType: 'channel' | 'dm'): 'seal' | 'crowd' {
  return scopeType === 'dm' ? 'seal' : 'crowd';
}

// ── Chat inbound ────────────────────────────────────────────────────────────

function handleChatSend(payload: Record<string, unknown>, remotePeerId: string): void {
  const scopeId = String(payload.scope_id ?? '');
  const scopeType = String(payload.scope_type ?? 'channel') as 'channel' | 'dm';
  const messageId = String(payload.message_id ?? crypto.randomUUID());

  // SECURITY: the message author is the Noise-authenticated connection peer
  // (libp2p binds remotePeer to its static key), NOT a self-asserted payload
  // field. Reject any envelope whose claimed sender_id does not match the
  // authenticated peer — this closes the sender-spoofing hole.
  if (payload.sender_id != null && String(payload.sender_id) !== remotePeerId) return;
  const senderId = remotePeerId;

  const decoded = decodeInboundMessage(payload, remotePeerId, scopeId, scopeType);
  if (!scopeId) return;
  if (!decoded) {
    // A crowd message under a not-yet-installed (future) epoch can't decrypt yet because
    // the rotation root is still in flight — buffer it for replay instead of dropping it.
    if (scopeType === 'channel') bufferFutureEpochChannelMessage(payload, remotePeerId, scopeId);
    return;
  }
  const { body, media, mode } = decoded;
  // Accept text-only, attachment-only, or both — but never an empty message.
  if (!(body && body.length > 0) && !(media && media.length > 0)) return;

  // SECURITY/CORRECTNESS: only accept messages for a scope the local identity
  // actually belongs to, and resolve the authoritative server_id locally. This
  // prevents unsolicited injection into arbitrary scopes AND fixes bug-1 (inbound
  // messages were stored without server_id, so owners served incomplete history).
  const state = getState();
  const me = state.identity?.peer_id ?? '';
  let serverId: string | undefined;
  if (scopeType === 'dm') {
    let dm = state.dms[scopeId];
    if (!dm) {
      // First inbound DM from this peer: materialize the thread so the message
      // isn't dropped. The sender derived scopeId deterministically from our two
      // peer ids, so both sides converge on the same conversation.
      ensureDm(scopeId, [me, senderId]);
      dm = getState().dms[scopeId];
    }
    if (!dm || !(dm.participants ?? []).includes(me)) return;
  } else {
    const server = Object.values(state.servers).find(s =>
      Object.keys(s.channels ?? {}).includes(scopeId),
    );
    if (!server || !(server.members ?? []).includes(me)) return;
    // SECURITY: the authenticated sender must ALSO still be a current member. Crowd
    // retains the previous epoch root so legitimate in-flight ciphertext still
    // decrypts after a rotation — but a KICKED peer could otherwise keep minting
    // fresh ciphertext under that retained epoch and have us accept it until enough
    // later rotations evict the epoch. Gating acceptance on live membership closes
    // that window without touching the (correct) legacy decrypt window.
    if (!(server.members ?? []).includes(senderId)) return;
    serverId = server.id;
  }

  // Idempotent: drop redelivered/echoed messages (resil-5).
  if (state.messages.some(m => m.id === messageId)) return;

  addMessage({
    id: messageId,
    scope_type: scopeType,
    scope_id: scopeId,
    server_id: serverId,
    sender_peer_id: senderId,
    body,
    ...(media && media.length ? { media } : {}),
    // A message only reaches this point after successful decryption (requiredEnc
    // rejects anything unencrypted), so it is genuinely E2EE — stamp the real mode.
    ...(mode ? { security_mode: mode, encrypted: true } : {}),
    created_at: new Date().toISOString(),
  });

  // Notifications: bump the unread badge for any scope the user isn't currently
  // viewing, and pop a toast for DMs (a 1:1 message you'd otherwise miss). Channel
  // messages get the quieter unread pip rather than a toast to avoid noise.
  if (scopeId !== getActiveScope()) bumpUnread(scopeId);
  if (scopeType === 'dm' && scopeId !== getActiveScope()) {
    emitNotify({ kind: 'dm', title: peerDisplayName(senderId), body: body || 'Sent an attachment', scopeId });
  } else if (scopeType === 'channel' && scopeId !== getActiveScope() && serverId) {
    // Channel messages now emit a classified notify event (mention / @everyone / role /
    // plain channel) so the stored notification level applies to channel traffic — not
    // just DMs. Layout's pref filter decides whether it actually surfaces a toast/desktop
    // notification. The unread pip still fires above regardless.
    const server = state.servers[serverId];
    const channelName = server?.channels?.[scopeId]?.name ?? 'channel';
    const kind = server
      ? classifyChannelNotification(server, me, state.identity?.profile?.display_name, body)
      : 'channel';
    emitNotify({ kind, title: `#${channelName}`, body: `${peerDisplayName(senderId)}: ${body || 'Sent an attachment'}`, scopeId });
  }
  publishNativeSnapshot();
}

/**
 * Decode an inbound chat message. FAIL-CLOSED: the envelope MUST carry the exact
 * encryption the scope requires (seal for DMs, crowd for channels) — anything else
 * (a missing `enc`, a plaintext body, or a mode mismatch) is rejected with `null`
 * and never decoded as cleartext. This is what makes the "verifiable security"
 * promise real: a peer cannot downgrade a conversation to plaintext, and a message
 * that survives to the store is provably E2EE.
 */
function decodeInboundMessage(
  payload: Record<string, unknown>,
  remotePeerId: string,
  scopeId: string,
  scopeType: 'channel' | 'dm',
): DecryptedMessage | null {
  const enc = typeof payload.enc === 'string' ? payload.enc : '';
  if (enc !== requiredEnc(scopeType)) return null;
  return decryptInboundEnvelope(enc, payload, remotePeerId, scopeId, scopeType);
}

// ── Chat edit / delete inbound ─────────────────────────────────────────────

function handleChatEdit(payload: Record<string, unknown>, remotePeerId: string): void {
  const messageId = String(payload.message_id ?? '');
  if (!messageId) return;

  const state = getState();
  const msg = state.messages.find(m => m.id === messageId);
  if (!msg) return;

  // SECURITY: only the original sender may edit a message.
  if (msg.sender_peer_id !== remotePeerId) return;

  // FAIL-CLOSED: an edit must carry the scope's required E2EE envelope, exactly
  // like a fresh send. A plaintext edit is rejected — no cleartext fallback — so
  // an edit can never downgrade a message the original send encrypted.
  const decoded = decodeInboundMessage(payload, remotePeerId, msg.scope_id, msg.scope_type as 'channel' | 'dm');
  if (!decoded?.body) return;

  storeEditMessage(messageId, decoded.body);
  publishNativeSnapshot();
}

function handleChatDelete(payload: Record<string, unknown>, remotePeerId: string): void {
  const messageId = String(payload.message_id ?? '');
  if (!messageId) return;

  const state = getState();
  const msg = state.messages.find(m => m.id === messageId);
  if (!msg) return;

  // SECURITY: only the original sender may delete their own message.
  if (msg.sender_peer_id !== remotePeerId) return;

  storeDeleteMessage(messageId);
  publishNativeSnapshot();
}

/** Route an inbound chat family message by operation type. */
function handleChatOp(payload: Record<string, unknown>, remotePeerId: string, operation: string): void {
  if (operation === 'chat.edit') {
    handleChatEdit(payload, remotePeerId);
  } else if (operation === 'chat.delete') {
    handleChatDelete(payload, remotePeerId);
  } else {
    // Default / 'chat.send'
    handleChatSend(payload, remotePeerId);
  }
}

// ── Presence/typing inbound ────────────────────────────────────────────────

/** Extract advertised circuit addresses from a peer payload. */
function circuitAddrsFromPayload(payload: Record<string, unknown>): string[] {
  const a = payload.addresses;
  return Array.isArray(a)
    ? a.filter((x): x is string => typeof x === 'string' && x.includes('p2p-circuit'))
    : [];
}

function handlePresenceUpdate(payload: Record<string, unknown>, remotePeerId: string, _operation?: string): void {
  // SECURITY: a peer may only update ITS OWN presence — bind exclusively to the
  // Noise-authenticated connection peer; never fall back to the self-asserted
  // payload field, which any peer can forge.
  const peerId = remotePeerId;
  if (!peerId) return;
  const status = String(payload.status ?? 'online');
  updatePresenceEntry(peerId, {
    status,
    status_text: payload.status_text ? String(payload.status_text) : undefined,
    typing_in_scope: payload.typing_in_scope ? String(payload.typing_in_scope) : undefined,
    updated_at: String(payload.updated_at ?? new Date().toISOString()),
  });
  // Learn the peer's reachable circuit addresses for cross-relay delivery, plus
  // any profile (display name / avatar) they rode along with presence so it
  // propagates to everyone who sees them.
  const addrs = circuitAddrsFromPayload(payload);
  const displayName = typeof payload.display_name === 'string' && payload.display_name.trim() ? payload.display_name.trim() : undefined;
  const avatar = typeof payload.avatar === 'string' && payload.avatar.trim() ? payload.avatar.trim() : undefined;
  if (addrs.length || displayName || avatar) {
    upsertPeer({
      peer_id: peerId,
      role: 'peer',
      ...(addrs.length ? { addresses: addrs } : {}),
      ...(displayName ? { display_name: displayName } : {}),
      ...(avatar ? { avatar } : {}),
      last_seen_at: new Date().toISOString(),
    });
  }
  publishNativeSnapshot();
}

// ── Reaction inbound (via notify.push) ────────────────────────────────────

function handleNotifyPush(payload: Record<string, unknown>, remotePeerId: string, _operation?: string): void {
  // SECURITY: use the Noise-authenticated connection peer for all sender fields, so
  // a member cannot attribute a reaction/pin/vote to someone else. These metadata
  // ops travel as plaintext (the relay can see that a reaction/pin/vote happened,
  // though not message bodies); wrapping them in the Crowd envelope for full metadata
  // privacy is a tracked follow-up. Authorization for privileged ops (pin) is
  // enforced per-kind below.
  const fromPeerId = remotePeerId;

  if (payload.kind === 'reaction') {
    const messageId = String(payload.message_id ?? '');
    const emoji = String(payload.emoji ?? '');
    const action = payload.action === 'remove' ? 'remove' : 'add';
    if (!messageId || !emoji) return;
    if (action === 'add') {
      addReaction(messageId, emoji, fromPeerId);
    } else {
      removeReaction(messageId, emoji, fromPeerId);
    }
    publishNativeSnapshot();
    return;
  }

  if (payload.kind === 'pin') {
    const messageId = String(payload.message_id ?? '');
    if (!messageId) return;
    // AUTHORIZATION: a pin/unpin is a moderator action, not something any member may
    // do. Apply it only when the authenticated sender actually has MANAGE_MESSAGES on
    // the message's server — connection authentication proves *who* sent it, not that
    // they were *allowed* to. Resolve the server from the message we hold locally.
    const msg = getState().messages.find(m => m.id === messageId);
    const serverId = msg?.server_id;
    if (!serverId || !memberHasPermission(serverId, fromPeerId, 'MANAGE_MESSAGES')) return;
    const pinned = payload.pinned !== false;
    storePinMessage(messageId, pinned);
    publishNativeSnapshot();
    return;
  }

  if (payload.kind === 'poll_vote') {
    const messageId = String(payload.message_id ?? '');
    const optionIndex = Number(payload.option_index ?? -1);
    if (!messageId || optionIndex < 0) return;
    addPollVote(messageId, optionIndex, fromPeerId);
    publishNativeSnapshot();
    return;
  }

  if (payload.kind === 'report') {
    // Abuse report delivered to us as a server OWNER. Only accept it for a server we
    // actually own (the moderator who can act on it); ignore reports for anything else.
    const serverId = String(payload.server_id ?? '');
    const server = getState().servers[serverId];
    if (!serverId || !server || server.owner_peer_id !== (getState().identity?.peer_id ?? '')) return;
    // The authenticated sender must be a member of the server — otherwise any peer that
    // learns a server id could spam the owner with forged reports/notifications.
    if (!fromPeerId || !server.members.includes(fromPeerId)) return;
    // Reject references that don't belong to this server (channel must be one of ours).
    const reportChannelId = payload.channel_id ? String(payload.channel_id) : undefined;
    if (reportChannelId && !Object.prototype.hasOwnProperty.call(server.channels ?? {}, reportChannelId)) return;
    addReport({
      id: String(payload.report_id ?? crypto.randomUUID()),
      reason: String(payload.reason ?? 'other'),
      details: payload.details ? String(payload.details) : undefined,
      target_kind: payload.target_kind === 'user' ? 'user' : 'message',
      target_id: String(payload.target_id ?? ''),
      reported_peer_id: payload.reported_peer_id ? String(payload.reported_peer_id) : undefined,
      server_id: serverId,
      channel_id: reportChannelId,
      content_excerpt: payload.content_excerpt ? String(payload.content_excerpt) : undefined,
      reporter_peer_id: fromPeerId,
      created_at: new Date().toISOString(),
      inbound: true,
    });
    emitNotify({ kind: 'server', title: 'New report', body: `A member reported content in “${server.name}”` });
    publishNativeSnapshot();
    return;
  }
}

// ── Server sync inbound (serve manifest/channels/history to joiners) ─────────

/**
 * Respond to a joiner's `sync.join` / `sync.pull`. On `sync.join` the OWNER adds
 * the requester to the server's members (so future broadcasts reach them), then
 * returns the full server record + its message history. This is the owner-served
 * half of P2P invite-join — the joiner dials us over the relay circuit.
 */
export function handleSyncRequest(operation: string, payload: Record<string, unknown>, remotePeerId: string): Record<string, unknown> {
  const serverId = String(payload.server_id ?? '');
  if (!serverId) return { ok: false, error: 'missing_server_id' };

  const state = getState();
  const server = state.servers[serverId];
  if (!server) return { ok: false, error: 'unknown_server' };

  const localPeerId = state.identity?.peer_id ?? '';
  const isOwner = server.owner_peer_id === localPeerId;

  // Owner-pushed structural update (new/renamed/deleted channels, membership): a
  // member applies it only when it genuinely comes from the server's owner. This
  // is what makes owner-side channel edits show up for everyone, not just the owner.
  if (operation === 'sync.update') {
    const incoming = payload.server as Partial<XoreinRuntimeServer> | undefined;
    if (incoming && remotePeerId === server.owner_peer_id && !isOwner) {
      // Reject a STALE whole snapshot: broadcastServerUpdate is fire-and-forget on
      // independent streams, so an older update can arrive after a newer one. Applying
      // it would restore roles/permissions/membership the owner just changed. Gate the
      // entire apply on a monotonic server_rev (older owners omit it → still applied).
      const incomingRev = typeof incoming.server_rev === 'number' ? incoming.server_rev : undefined;
      const storedRev = typeof server.server_rev === 'number' ? server.server_rev : -1;
      if (incomingRev !== undefined && incomingRev <= storedRev) {
        return { ok: true };
      }
      // Apply the owner-authoritative fields. CRITICAL: this must include
      // crowd_root/crowd_epoch (channel-key rotation) and roles/member_roles —
      // previously they were silently dropped here, so kicks never revoked keys
      // and role changes never reached members.
      const nextRoot = typeof incoming.crowd_root === 'string' ? incoming.crowd_root : undefined;
      const nextEpoch = typeof incoming.crowd_epoch === 'number' ? incoming.crowd_epoch : undefined;
      // crowd_epoch is monotonic. Because broadcastServerUpdate is fire-and-forget on
      // independent streams, an OLDER update can arrive after a newer rotation — persist
      // the root/epoch only when it advances (>= stored), or the store would regress to
      // an obsolete key and fail to decrypt current-epoch traffic after a reload.
      const storedEpoch = typeof server.crowd_epoch === 'number' ? server.crowd_epoch : -1;
      const applyCrowd = nextRoot !== undefined && nextEpoch !== undefined && nextEpoch >= storedEpoch;
      updateServer(serverId, {
        ...(incoming.channels ? { channels: incoming.channels } : {}),
        ...(Array.isArray(incoming.members) ? { members: incoming.members } : {}),
        ...(incoming.manifest ? { manifest: incoming.manifest } : {}),
        ...(typeof incoming.name === 'string' && incoming.name ? { name: incoming.name } : {}),
        ...(typeof incoming.description === 'string' ? { description: incoming.description } : {}),
        ...(applyCrowd ? { crowd_root: nextRoot, crowd_epoch: nextEpoch } : {}),
        ...(Array.isArray(incoming.roles) ? { roles: incoming.roles } : {}),
        ...(incoming.member_roles && typeof incoming.member_roles === 'object' ? { member_roles: incoming.member_roles } : {}),
        ...(incomingRev !== undefined ? { server_rev: incomingRev } : {}),
      });
      // Install the (possibly rotated) root into the live crypto so the new epoch
      // takes effect immediately — only when we actually persisted an advancing root.
      if (applyCrowd) {
        applyCrowdRoot(serverId);
        // The new root may unlock channel messages that raced ahead of it — replay any
        // buffered future-epoch ciphertext now that this epoch's key is installed.
        replayBufferedChannelMessages(serverId);
      }
      publishNativeSnapshot();
    }
    return { ok: true };
  }

  // Member leaving: the owner drops them from the member list, ROTATES the Crowd
  // epoch (same forward-secrecy rule as a kick — a departed member must not keep a
  // usable channel key for future ciphertext), and re-broadcasts the updated roster +
  // fresh root so everyone's view converges. Only the owner mutates membership.
  if (operation === 'sync.leave') {
    if (isOwner && remotePeerId && server.members.includes(remotePeerId)) {
      removeServerMember(serverId, remotePeerId);
      rotateCrowdEpoch(serverId);
      publishNativeSnapshot();
      broadcastServerUpdate(serverId);
    }
    return { ok: true };
  }

  // Owner deleted the server, or kicked this peer: forget it locally. Applied only
  // when the instruction genuinely comes from the server's owner.
  if (operation === 'sync.delete' || operation === 'sync.remove') {
    if (remotePeerId === server.owner_peer_id && !isOwner) {
      removeServerMembership(serverId);
      emitNotify({
        kind: 'server',
        title: operation === 'sync.delete' ? 'Server deleted' : 'Removed from server',
        body: operation === 'sync.delete'
          ? `“${server.name}” was deleted by its owner`
          : `You were removed from “${server.name}”`,
      });
      publishNativeSnapshot();
    }
    return { ok: true };
  }

  // SECURITY: a non-member must present a valid invite-capability token before we
  // admit them or serve any history. Existing members re-pulling are exempt.
  // Servers without an invite_secret are treated as closed (verifyInviteToken
  // returns false) — use nativeCreateServer to get a fresh invite_secret.
  const alreadyMember = !!remotePeerId && server.members.includes(remotePeerId);
  if (!alreadyMember && !verifyInviteToken(server.invite_secret, serverId, String(payload.invite_token ?? ''))) {
    return { ok: false, error: 'invalid_invite' };
  }

  // Learn the joiner's reachable circuit addresses so we can deliver back across
  // relays (keyed to the authenticated peer).
  const joinerAddrs = circuitAddrsFromPayload(payload);
  if (remotePeerId && joinerAddrs.length) {
    upsertPeer({ peer_id: remotePeerId, role: 'peer', addresses: joinerAddrs, last_seen_at: new Date().toISOString() });
  }

  // Only the owner mutates membership; any member can still serve a read copy.
  // A brand-new joiner: add them, then ROTATE the Crowd epoch so they cannot derive
  // the previous epoch's sender keys (forward secrecy on join). Existing members
  // receive the fresh root via the broadcast below; the joiner gets it in this
  // response's server record. Re-pulls by existing members do NOT rotate.
  const isNewJoiner = operation === 'sync.join' && isOwner && remotePeerId && !alreadyMember;
  if (isNewJoiner) {
    // Record the join boundary NOW so it is enforced on every later pull, not just this
    // response — otherwise `alreadyMember` flips true and a subsequent sync.pull would
    // serve the full retention window, leaking the pre-join history the policy withheld.
    const joinedAt = new Date().toISOString();
    updateServer(serverId, {
      members: [...server.members, remotePeerId],
      member_since: { ...(server.member_since ?? {}), [remotePeerId]: joinedAt },
    });
    rotateCrowdEpoch(serverId);
    broadcastServerUpdate(serverId);
    publishNativeSnapshot();
  }

  const current = getState().servers[serverId] ?? server;
  // Chronological order (oldest → newest) so cursor paging is deterministic across
  // peers regardless of local store insertion order. Tie-break equal timestamps by id
  // so the (created_at, id) cursor is a total order — otherwise a page ending on a
  // timestamp shared by many messages would skip the rest of them on the next pull.
  const allMessages = getState().messages
    .filter(m => !m.deleted && m.server_id === serverId)
    .slice()
    .sort((a, b) =>
      String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) ||
      String(a.id).localeCompare(String(b.id)));
  const retention = current.manifest?.history_retention_messages ?? 100;
  // History policy: the owner holds DECRYPTED plaintext, so clamping HERE — not the epoch
  // rotation alone — is what actually stops a member from reading old conversations. A
  // member gets at most `join_history_messages` (default 0) of pre-join history, enforced
  // via their persisted join boundary on EVERY pull. The boundary — not the transient
  // `alreadyMember ? retention : joinWindow` split — is what prevents a member who is now
  // `alreadyMember` from later paging into the pre-join window.
  const joinWindow = current.manifest?.join_history_messages ?? 0;
  const memberSince = remotePeerId ? current.member_since?.[remotePeerId] : undefined;
  const boundaried = applyJoinBoundary(allMessages, memberSince, joinWindow);

  // Cursor pagination (`sync.pull` with `before`): serve the page of messages that
  // precede the cursor, so a member can lazily scroll further back than the initial
  // window. The cursor is (`before` created_at, `before_id`) — a total order — so
  // messages sharing a timestamp across a page boundary stay pageable; `limit` bounds
  // the page; `channel_id` scopes it to one channel (the UI pages a single channel).
  const before = typeof payload.before === 'string' ? payload.before : undefined;
  const beforeId = typeof payload.before_id === 'string' ? payload.before_id : '';
  const pullChannelId = typeof payload.channel_id === 'string' ? payload.channel_id : undefined;
  const requestedLimit = Number(payload.limit);
  const pageLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), retention)
    : Math.min(50, retention);

  let messages: XoreinRuntimeMessage[];
  let hasMore = false;
  if (operation === 'sync.pull' && before) {
    // Only members may page (cursor pull is not a join); non-members get nothing.
    // Scope to the requested channel so a busy server's other channels can't fill the
    // page, and clamp to the retention window BEFORE cursoring so repeated pulls can
    // never exfiltrate history older than the manifest's advertised limit. `boundaried`
    // has already dropped pre-join history beyond the join allowance.
    const scoped = alreadyMember
      ? (pullChannelId ? boundaried.filter(m => m.scope_id === pullChannelId) : boundaried)
      : [];
    const windowed = scoped.slice(-retention);
    // Older than the (created_at, id) cursor: strictly-earlier timestamp, OR same
    // timestamp with a strictly-smaller id (matches the total-order sort above).
    const older = windowed.filter(m => {
      const ts = String(m.created_at ?? '');
      return ts < before || (ts === before && String(m.id) < beforeId);
    });
    messages = older.slice(-pageLimit);
    hasMore = older.length > messages.length;
  } else {
    // Initial join / full pull: the boundaried set already reflects the join policy, so
    // serve up to the retention window of it.
    const windowed = boundaried.slice(-retention);
    messages = windowed;
    hasMore = boundaried.length > windowed.length;
  }
  // Advertise our own circuit addresses so the joiner can reach us on our relay.
  const addresses = (getState().relay_addrs ?? []).filter(a => a.includes('p2p-circuit'));
  // SECURITY: strip invite_secret before sending — it is an owner-only capability
  // that grants invite-minting authority. crowd_root/crowd_epoch ARE distributed to
  // joining members so they can decrypt channel messages at the current epoch; the
  // root is rotated on join above so a joiner never learns a prior epoch's key.
  const { invite_secret: _omit, member_since: _omitSince, ...serverForJoiner } = current;
  return { ok: true, server: serverForJoiner, messages, addresses, has_more: hasMore };
}

/**
 * Re-run the authenticated inbound chat path for an envelope recovered from the
 * offline mailbox, with `fromPeerId` as the cryptographically-verified sender
 * (the deposit was sealed under a secret only that peer + we share). Reuses the
 * same scope/membership checks, decryption, and de-dup as live delivery.
 */
export function ingestMailboxChat(envelope: Record<string, unknown>, fromPeerId: string): void {
  handleChatSend(envelope, fromPeerId);
}

// ── Seal prekey-bundle service ───────────────────────────────────────────────

/**
 * Serve this peer's signed Seal prekey bundle to a peer that wants to start an
 * E2EE DM. The bundle is self-authenticating (hybrid-signed) so serving it over
 * the relay leaks nothing — only public key material a DM partner needs.
 */
function handleSealBundle(): Record<string, unknown> {
  const sc = getScopeCrypto();
  if (!sc) return { ok: false, error: 'no_crypto' };
  return { ok: true, bundle: sc.seal.serveBundle() };
}

// ── Friend requests (P2P social graph) ───────────────────────────────────────

/**
 * Handle an inbound friend op from `remotePeerId`:
 *  - `request`: record an incoming pending request so it shows in the Pending tab.
 *  - `accept` : the peer accepted a request we sent — flip our outgoing pending to
 *    an accepted friend (matched by counterparty, since each side holds its own id).
 * The `kind` is carried in the payload because the void handler family doesn't pass
 * the wire operation through.
 */
function handleFriendOp(payload: Record<string, unknown>, remotePeerId: string, _operation?: string): void {
  const me = getState().identity?.peer_id ?? '';
  if (!remotePeerId || remotePeerId === me) return;
  const kind = String(payload.kind ?? '');

  if (kind === 'request') {
    const state = getState();
    // Idempotent: ignore if we're already friends or already hold a request for them.
    const friendPeerIds = state.friends.flatMap(f => [f.from_peer_id, f.to_peer_id, f.to_peer_addr]);
    if (friendPeerIds.includes(remotePeerId)) return;
    if (state.friend_requests.some(r => r.from_peer_id === remotePeerId || r.to_peer_id === remotePeerId)) return;
    const id = typeof payload.id === 'string' && payload.id ? payload.id : `fr-${remotePeerId}`;
    const reqName = typeof payload.display_name === 'string' && payload.display_name.trim() ? payload.display_name.trim() : peerDisplayName(remotePeerId);
    // Learn the requester's display name now so the Pending tab shows a real name,
    // not a raw peer id, before they ever come online.
    if (typeof payload.display_name === 'string' && payload.display_name.trim()) {
      upsertPeer({ peer_id: remotePeerId, role: 'peer', display_name: payload.display_name.trim(), last_seen_at: new Date().toISOString() });
    }
    addFriendRequest({
      id,
      from_peer_id: remotePeerId,
      to_peer_id: me,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    emitNotify({ kind: 'friend', title: 'Friend request', body: `${reqName} wants to be friends` });
    publishNativeSnapshot();
    return;
  }

  if (kind === 'accept') {
    acceptFriendByPeer(remotePeerId);
    emitNotify({ kind: 'friend', title: 'Friend request accepted', body: `${peerDisplayName(remotePeerId)} accepted your friend request` });
    publishNativeSnapshot();
    // Announce online to the just-confirmed friend so each side sees the other
    // online right away (presenceTargets now includes them).
    nativeAnnouncePresence();
  }
}

// ── Handler registration ────────────────────────────────────────────────────

/**
 * Request handler that returns a JSON response payload built from `handle`'s
 * return value (unlike makeHandler, which always replies {ok:true}). Used by the
 * sync family so joiners receive the server snapshot.
 */
function makeRequestHandler(
  peerSync: PeerSync,
  handle: (operation: string, payload: Record<string, unknown>, remotePeerId: string) => Record<string, unknown>,
) {
  return async (stream: AsyncIterable<Uint8Array | { subarray(): Uint8Array }>, connection: { remotePeer: { toString(): string }; remoteAddr: { toString(): string } }) => {
    try {
      const remotePeerId = connection.remotePeer.toString();
      const remoteAddr = connection.remoteAddr.toString();
      peerSync.registerPeer(remotePeerId, remoteAddr.includes('p2p-circuit') ? remoteAddr : undefined);

      const raw = await readStream(stream);
      const msg = unframeMessage(raw);
      if (!msg) return;
      const req = decodePeerStreamRequest(msg);
      let payload: Record<string, unknown> = {};
      if (req.payload) {
        try { payload = JSON.parse(dec.decode(req.payload)) as Record<string, unknown>; } catch { /* non-JSON */ }
      }

      let result: Record<string, unknown>;
      try { result = handle(req.operation, payload, remotePeerId); }
      catch { result = { ok: false, error: 'handler_error' }; }

      const resp = encodePeerStreamResponse({ payload: enc.encode(JSON.stringify(result)), requestId: req.requestId });
      (stream as unknown as { send(d: Uint8Array): boolean }).send(frameMessage(resp));
      await (stream as unknown as { close(): Promise<void> }).close();
    } catch { /* non-fatal */ }
  };
}


function makeHandler(
  localPeerId: string,
  peerSync: PeerSync,
  handle: (payload: Record<string, unknown>, remotePeerId: string, operation: string) => void,
) {
  return async (stream: AsyncIterable<Uint8Array | { subarray(): Uint8Array }>, connection: { remotePeer: { toString(): string }; remoteAddr: { toString(): string } }) => {
    try {
      const remotePeerId = connection.remotePeer.toString();
      const remoteAddr = connection.remoteAddr.toString();
      // Register the peer's addr so outbound can reach them.
      peerSync.registerPeer(remotePeerId, remoteAddr.includes('p2p-circuit') ? remoteAddr : undefined);

      const raw = await readStream(stream);
      const msg = unframeMessage(raw);
      if (!msg) return;

      const req = decodePeerStreamRequest(msg);
      let payload: Record<string, unknown> = {};
      if (req.payload) {
        try { payload = JSON.parse(dec.decode(req.payload)) as Record<string, unknown>; } catch { /* non-JSON payload */ }
      }

      handle(payload, remotePeerId, req.operation);

      // Send OK response.
      (stream as unknown as { send(d: Uint8Array): boolean }).send(okResponse(req.requestId));
      await (stream as unknown as { close(): Promise<void> }).close();
    } catch { /* non-fatal: stream errors from unknown peers */ }
  };
}

/**
 * Register inbound PeerStream handlers for chat, presence, and notify families.
 * Must be called after the libp2p node is started.
 */
export async function registerInboundHandlers(
  node: Libp2p,
  localPeerId: string,
  peerSync: PeerSync,
): Promise<void> {
  const opts = { runOnLimitedConnection: true };

  await node.handle(
    PROTOCOLS.chat,
    makeHandler(localPeerId, peerSync, handleChatOp) as Parameters<typeof node.handle>[1],
    opts,
  );

  await node.handle(
    PROTOCOLS.presence,
    makeHandler(localPeerId, peerSync, handlePresenceUpdate) as Parameters<typeof node.handle>[1],
    opts,
  );

  await node.handle(
    PROTOCOLS.notify,
    makeHandler(localPeerId, peerSync, handleNotifyPush) as Parameters<typeof node.handle>[1],
    opts,
  );

  // Server sync: serve manifest/channels/history to joiners and accept members.
  await node.handle(
    PROTOCOLS.sync,
    makeRequestHandler(peerSync, handleSyncRequest) as Parameters<typeof node.handle>[1],
    opts,
  );

  // Seal: serve our signed prekey bundle so peers can start an E2EE DM with us.
  await node.handle(
    PROTOCOLS.seal,
    makeRequestHandler(peerSync, () => handleSealBundle()) as Parameters<typeof node.handle>[1],
    opts,
  );

  // Friends: receive friend requests / acceptances over P2P so the social graph
  // is delivered peer-to-peer rather than only written to the local store.
  await node.handle(
    PROTOCOLS.friends,
    makeHandler(localPeerId, peerSync, handleFriendOp) as Parameters<typeof node.handle>[1],
    opts,
  );
}
