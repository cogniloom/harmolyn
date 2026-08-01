// Inbound PeerStream family handlers: receive chat messages, reactions, and
// presence/typing updates from remote peers and apply them to the local store.
import type { Libp2p } from 'libp2p';
import type { XoreinRuntimeServer, XoreinRuntimeMessage, XoreinMessageAuthorProof } from '../../types.js';
import {
  frameMessage, encodePeerStreamResponse, serveFamilyStream,
  type InboundFamilyStream, type PeerStreamRequest,
} from '../families/peerstream.js';
import { PROTOCOLS, RECOVERY_OPS } from '../families/families.js';
import { addMessage, editMessage as storeEditMessage, deleteMessage as storeDeleteMessage, updateMessageVersion, pinMessage as storePinMessage, updatePresenceEntry, addReaction, removeReaction, getState, updateServer, upsertPeer, addFriendRequest, acceptFriendByPeer, ensureDm, bumpUnread, getActiveScope, removeServerMembership, removeServerMember, addPollVote, memberHasPermission, isScopeMember, addReport } from '../state/store.js';
import { nativeAnnouncePresence, broadcastServerUpdate, rotateChannelEpoch } from '../state/mutations.js';
import { publishNativeSnapshot, schedulePublishNativeSnapshot } from '../state/snapshot.js';
import { decryptInboundEnvelope, getScopeCrypto, applyChannelRoot, channelModeForServer, type DecryptedMessage } from './secureEnvelope.js';
import { isChannelSecurityMode } from '../security/channelMode.js';
import { verifyInviteToken, verifySignedInviteCapability } from './invite.js';
import { rekeyVoiceForServer } from '../voice/registry.js';
import type { PeerSync } from './peersync.js';
import { isTrustedPeerCircuitMultiaddr } from '../transport/node.js';
import { hasControlCharacters, MAX_CHAT_BODY_BYTES } from '../security/limits.js';
import { verifySignedHistoryMessage } from './signedHistory.js';
import { verifyServerRecord } from './signedServer.js';
import {
  knownSignedPeerRecords,
} from './peerDiscovery.js';
import {
  claimRoutedRequest,
  openRoutedRequest,
  sealRoutedResponse,
  verifyRoutedRequest,
  type RoutedInnerRequest,
  type RoutedRequest,
} from './routedRequest.js';
import { handleBlobSyncRequest } from '../blobs/swarm.js';
import { handlePeerMailboxRequest } from '../delivery/peerMailbox.js';
import { handlePeerRendezvousRequest } from '../transport/peerRendezvous.js';
import {
  handleRecoveryDeliver,
  handleRecoveryDeliverChunk,
  handleRecoveryRequest,
  handleRecoveryStore,
  handleRecoveryStoreChunk,
} from '../recovery/recovery.js';

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
  const mode = payload.enc;
  if (!isChannelSecurityMode(mode)) return;
  const wire = payload[mode] as { epoch?: number } | undefined;
  if (!wire || typeof wire.epoch !== 'number') return;
  const state = getState();
  const server = Object.values(state.servers).find(s => Object.keys(s.channels ?? {}).includes(scopeId));
  if (!server) return;
  // AUTHORIZATION: only buffer from a CURRENT member of the server. Otherwise any
  // authenticated non-member who knows a channel id could submit malformed ciphertext with an
  // arbitrarily large epoch and flood the bounded per-server buffer, evicting legitimate
  // messages that merely raced the real epoch update. (The post-decrypt path already gates on
  // membership; this undecryptable path must too, before it consumes a buffer slot.)
  if (!(server.members ?? []).includes(remotePeerId)) return;
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
 * recorded boundary sees the set unchanged — the caller (handleSyncRequest) only takes
 * that lenient path when THIS peer is the owner (whose member_since map is authoritative,
 * so a missing entry genuinely means a pre-tracking member); non-owner responders fail
 * closed instead. `msgs` must already be sorted oldest→newest.
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
/**
 * True when `body` mentions the COMPLETE `token` after an `@` — i.e. `@token` followed by a
 * non-word character or end of string. A raw substring test would let `@Ann` match `@Anna`
 * and notify the wrong person under "Mentions only".
 */
function mentionsToken(body: string, token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('@' + escaped + '(?![\\w])', 'i').test(body);
}

export function classifyChannelNotification(
  server: { roles?: { id: string; name?: string }[]; member_roles?: Record<string, string[]> },
  mePeerId: string,
  myDisplayName: string | undefined,
  body: string,
): 'everyone' | 'role' | 'mention' | 'channel' {
  const text = body ?? '';
  // A DIRECT mention of the local user wins over a broadcast tag: a message that both
  // @everyone's and names me should classify as 'mention' so it survives the Mentions-Only /
  // Suppress-Everyone filters (a direct ping is supposed to reach me even when I've muted
  // broadcasts). Check the direct mention BEFORE the everyone/here branch.
  if ((myDisplayName && mentionsToken(text, myDisplayName)) || (mePeerId && mentionsToken(text, mePeerId))) {
    return 'mention';
  }
  if (/@(everyone|here)\b/i.test(text)) return 'everyone';
  // A role ping counts only when it targets a role the local user actually holds.
  const myRoleIds = new Set((server.member_roles ?? {})[mePeerId] ?? []);
  const myRoleNames = (server.roles ?? [])
    .filter((r) => myRoleIds.has(r.id))
    .map((r) => String(r.name ?? '').trim())
    .filter(Boolean);
  if (myRoleNames.some((name) => mentionsToken(text, name))) return 'role';
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

/**
 * Validate the explicit channel mode against the owner-authored server state.
 * The immediately previous mode/epoch is accepted only for in-flight traffic
 * during a signed mode transition; anything older or mode-less is rejected.
 */
function channelEnvelopeModeAllowed(
  encMode: string,
  payload: Record<string, unknown>,
  scopeId: string,
): boolean {
  if (!isChannelSecurityMode(encMode)) return false;
  const server = Object.values(getState().servers).find(s =>
    Object.keys(s.channels ?? {}).includes(scopeId),
  );
  if (!server) return false;
  const currentMode = channelModeForServer(server.id);
  if (encMode === currentMode) return true;
  const wire = payload[encMode] as { epoch?: unknown } | undefined;
  const currentEpoch = typeof server.crowd_epoch === 'number' ? server.crowd_epoch : 0;
  return typeof wire?.epoch === 'number'
    && Number.isSafeInteger(wire.epoch)
    && currentEpoch > 0
    && wire.epoch === currentEpoch - 1;
}

function boundedPayloadString(value: unknown, maxBytes: number, allowEmpty = false): string | null {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxBytes) return null;
  if (hasControlCharacters(value)) return null;
  return value;
}

// ── Chat inbound ────────────────────────────────────────────────────────────

function handleChatSend(payload: Record<string, unknown>, remotePeerId: string): void {
  const scopeId = boundedPayloadString(payload.scope_id, 256);
  const scopeTypeValue = payload.scope_type;
  const scopeType = scopeTypeValue === 'channel' || scopeTypeValue === 'dm' ? scopeTypeValue : null;
  const messageId = boundedPayloadString(payload.message_id, 256);
  if (!scopeId || !scopeType || !messageId || !remotePeerId) return;

  // SECURITY: the message author is the Noise-authenticated connection peer
  // (libp2p binds remotePeer to its static key), NOT a self-asserted payload
  // field. Reject any envelope whose claimed sender_id does not match the
  // authenticated peer — this closes the sender-spoofing hole.
  if (typeof payload.sender_id !== 'string' || payload.sender_id !== remotePeerId) return;
  const senderId = remotePeerId;

  const decoded = decodeInboundMessage(payload, remotePeerId, scopeId, scopeType);
  if (!scopeId) return;
  if (!decoded) {
    // A channel message under a not-yet-installed (future) epoch can't decrypt yet because
    // the rotation root is still in flight — buffer it for replay instead of dropping it.
    if (scopeType === 'channel') bufferFutureEpochChannelMessage(payload, remotePeerId, scopeId);
    return;
  }
  const { body, media, mode } = decoded;
  // Accept text-only, attachment-only, or both — but never an empty message.
  if (new TextEncoder().encode(body).length > MAX_CHAT_BODY_BYTES) return;
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
    // Both ends must belong to the thread. Checking only `me` is not enough: the
    // scope id is derived deterministically from the two peer ids, so ANY peer can
    // compute the id of a conversation between two other people, open a normal Seal
    // session with us, and label its message with that scope — landing a message
    // inside a private thread it is not part of. (The server branch below already
    // gates on sender membership for the same reason.)
    const participants = dm?.participants ?? [];
    if (!dm || !participants.includes(me) || !participants.includes(senderId)) return;
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

  const createdAt = boundedPayloadString(payload.created_at, 96, true) || new Date().toISOString();
  const authorRevision = Number.isSafeInteger(payload.author_revision)
    && Number(payload.author_revision) >= 0
    ? Number(payload.author_revision)
    : 0;
  const authorProof = payload.author_proof as XoreinMessageAuthorProof | undefined;
  const message: XoreinRuntimeMessage = {
    id: messageId,
    scope_type: scopeType,
    scope_id: scopeId,
    server_id: serverId,
    sender_peer_id: senderId,
    body,
    ...(media && media.length ? { media } : {}),
    // Carry the sender's reply reference so the quoted context renders here too.
    ...(boundedPayloadString(payload.reply_to, 256)
      ? { reply_to: boundedPayloadString(payload.reply_to, 256) as string }
      : {}),
    ...(boundedPayloadString(payload.forwarded_from, 256)
      ? { forwarded_from: boundedPayloadString(payload.forwarded_from, 256) as string }
      : {}),
    // A message only reaches this point after successful mode validation and decryption
    // rejects anything unencrypted), so it is genuinely E2EE — stamp the real mode.
    ...(mode ? { security_mode: mode, encrypted: true } : {}),
    created_at: createdAt,
    author_revision: authorRevision,
    ...(authorProof ? { author_proof: authorProof } : {}),
  };
  // Every channel sender knows the shared epoch root and can therefore derive
  // every symmetric sender key. Sender identity MUST come from the author's
  // hybrid signature even on a live Noise-authenticated path, because routed or
  // replayed ciphertext can outlive that path. v1 has no unsigned channel mode.
  if (scopeType === 'channel' && (!authorProof || !verifySignedHistoryMessage(message).ok)) return;
  if (scopeType === 'dm' && authorProof && !verifySignedHistoryMessage(message).ok) return;
  addMessage(message);

  // The message itself proves the sender stopped typing — clear the indicator
  // NOW instead of waiting for their (deferred) presence.update, so the typing
  // pill swaps to the message in the same render.
  //
  // KNOWN RACE (accepted): chat and presence ride separate streams, so a
  // typing-start the sender issued AFTER this message can arrive BEFORE it and
  // be wrongly cleared here. The wire envelope carries no sender-clock message
  // timestamp to compare against, and mixing sender presence clocks with the
  // receiver's would be meaningless under skew. The window is one cross-stream
  // reorder (~ms) and self-heals on the sender's next typing rebroadcast.
  const senderPresence = state.presence?.[senderId];
  if (senderPresence?.typing_in_scope === scopeId) {
    updatePresenceEntry(senderId, { ...senderPresence, typing_in_scope: undefined, updated_at: new Date().toISOString() });
  }

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
  schedulePublishNativeSnapshot();
}

/**
 * Decode an inbound chat message. FAIL-CLOSED: the envelope MUST carry the exact
 * encryption the scope requires (Seal for DMs, owner-authored Tree/Crowd for channels) — anything else
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
  if (scopeType === 'dm' ? enc !== 'seal' : !channelEnvelopeModeAllowed(enc, payload, scopeId)) return null;
  return decryptInboundEnvelope(enc, payload, remotePeerId, scopeId, scopeType);
}

// ── Chat edit / delete inbound ─────────────────────────────────────────────

function handleChatEdit(payload: Record<string, unknown>, remotePeerId: string): void {
  const messageId = boundedPayloadString(payload.message_id, 256);
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

  const editedAt = boundedPayloadString(payload.edited_at, 96, true) || new Date().toISOString();
  const revision = Number.isSafeInteger(payload.author_revision)
    ? Number(payload.author_revision)
    : (msg.author_revision ?? 0) + 1;
  if (revision <= (msg.author_revision ?? 0)) return;
  const proof = payload.author_proof as XoreinMessageAuthorProof | undefined;
  const next: XoreinRuntimeMessage = {
    ...msg,
    body: decoded.body,
    updated_at: editedAt,
    author_revision: revision,
    ...(proof ? { author_proof: proof } : {}),
  };
  if (msg.scope_type === 'channel' && (!proof || !verifySignedHistoryMessage(next).ok)) return;
  if (msg.scope_type === 'dm' && proof && !verifySignedHistoryMessage(next).ok) return;
  if (proof) {
    updateMessageVersion(messageId, {
      body: decoded.body,
      updated_at: editedAt,
      author_revision: revision,
      author_proof: proof,
    });
  } else {
    storeEditMessage(messageId, decoded.body);
    updateMessageVersion(messageId, { author_proof: undefined, author_revision: revision });
  }
  schedulePublishNativeSnapshot();
}

function handleChatDelete(payload: Record<string, unknown>, remotePeerId: string): void {
  const messageId = boundedPayloadString(payload.message_id, 256);
  if (!messageId) return;

  const state = getState();
  const msg = state.messages.find(m => m.id === messageId);
  if (!msg) return;

  // SECURITY: only the original sender may delete their own message.
  if (msg.sender_peer_id !== remotePeerId) return;

  const deletedAt = boundedPayloadString(payload.deleted_at, 96, true) || new Date().toISOString();
  const revision = Number.isSafeInteger(payload.author_revision)
    ? Number(payload.author_revision)
    : (msg.author_revision ?? 0) + 1;
  if (revision <= (msg.author_revision ?? 0)) return;
  const proof = payload.author_proof as XoreinMessageAuthorProof | undefined;
  const next: XoreinRuntimeMessage = {
    ...msg,
    deleted: true,
    updated_at: deletedAt,
    author_revision: revision,
    ...(proof ? { author_proof: proof } : {}),
  };
  if (msg.scope_type === 'channel' && (!proof || !verifySignedHistoryMessage(next).ok)) return;
  if (msg.scope_type === 'dm' && proof && !verifySignedHistoryMessage(next).ok) return;
  if (proof) {
    updateMessageVersion(messageId, {
      deleted: true,
      updated_at: deletedAt,
      author_revision: revision,
      author_proof: proof,
    });
  } else {
    storeDeleteMessage(messageId);
    updateMessageVersion(messageId, { author_proof: undefined, author_revision: revision });
  }
  schedulePublishNativeSnapshot();
}

/** Route an inbound chat family message by operation type. */
function handleChatOp(payload: Record<string, unknown>, remotePeerId: string, operation: string): void {
  if (operation === 'chat.edit') {
    handleChatEdit(payload, remotePeerId);
  } else if (operation === 'chat.delete') {
    handleChatDelete(payload, remotePeerId);
  } else if (operation === 'chat.send') {
    // Default / 'chat.send'
    handleChatSend(payload, remotePeerId);
  }
}

// ── Presence/typing inbound ────────────────────────────────────────────────

/** Extract advertised circuit addresses from a peer payload. */
function circuitAddrsFromPayload(payload: Record<string, unknown>, expectedPeerId?: string): string[] {
  const a = payload.addresses;
  return Array.isArray(a)
    ? a
      .filter((x): x is string => typeof x === 'string'
        && isTrustedPeerCircuitMultiaddr(x, expectedPeerId))
      .slice(0, 8)
    : [];
}

/**
 * Reconcile a LOST friends.accept from presence: a peer only broadcasts presence
 * to its server co-members and ACCEPTED friends. So when presence arrives from a
 * peer we hold an outgoing pending request to, and we share NO server with them,
 * the only way we can be in their presence-target set is that they accepted our
 * request — flip our outgoing pending to an accepted friend. This converges the
 * requester even if the one-shot friends.accept (and all its outbox retries)
 * never landed. Exported for tests.
 */
export function reconcileFriendAcceptFromPresence(peerId: string): boolean {
  const state = getState();
  const me = state.identity?.peer_id ?? '';
  if (!me || !peerId || peerId === me) return false;
  const outgoing = state.friend_requests.find(r =>
    r.status === 'pending'
    && r.from_peer_id === me
    && (r.to_peer_id ?? r.to_peer_addr) === peerId,
  );
  if (!outgoing) return false;
  // Shared server membership is the other legitimate reason they'd send us
  // presence — in that case their broadcast proves nothing about the request.
  const sharesServer = Object.values(state.servers).some(s => {
    const members = s.members ?? [];
    return members.includes(me) && members.includes(peerId);
  });
  if (sharesServer) return false;
  acceptFriendByPeer(peerId);
  emitNotify({ kind: 'friend', title: 'Friend request accepted', body: `${peerDisplayName(peerId)} accepted your friend request` });
  return true;
}

function handlePresenceUpdate(payload: Record<string, unknown>, remotePeerId: string, _operation?: string): void {
  // SECURITY: a peer may only update ITS OWN presence — bind exclusively to the
  // Noise-authenticated connection peer; never fall back to the self-asserted
  // payload field, which any peer can forge.
  const peerId = remotePeerId;
  if (!peerId) return;
  const status = payload.status === 'online' || payload.status === 'idle'
    || payload.status === 'dnd' || payload.status === 'offline'
    ? payload.status
    : 'online';
  const statusText = boundedPayloadString(payload.status_text, 512, true);
  const typingScope = boundedPayloadString(payload.typing_in_scope, 256, true);
  const updatedAt = boundedPayloadString(payload.updated_at, 64, true);
  updatePresenceEntry(peerId, {
    status,
    status_text: statusText || undefined,
    typing_in_scope: typingScope || undefined,
    updated_at: updatedAt || new Date().toISOString(),
  });
  // Learn the peer's reachable circuit addresses for cross-relay delivery, plus
  // any profile (display name / avatar) they rode along with presence so it
  // propagates to everyone who sees them.
  const addrs = circuitAddrsFromPayload(payload, remotePeerId);
  const displayName = boundedPayloadString(payload.display_name, 256, true)?.trim() || undefined;
  const avatar = boundedPayloadString(payload.avatar, 512 * 1024, true)?.trim() || undefined;
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
  // Presence from a peer we friend-requested (and share no server with) implies
  // they accepted — recover from a lost friends.accept so the requester converges.
  reconcileFriendAcceptFromPresence(peerId);
  schedulePublishNativeSnapshot();
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
    const messageId = boundedPayloadString(payload.message_id, 256);
    const emoji = boundedPayloadString(payload.emoji, 128);
    const action = payload.action === 'remove' || payload.action === 'add' ? payload.action : null;
    if (!messageId || !emoji || !action) return;
    if (action === 'add') {
      addReaction(messageId, emoji, fromPeerId);
    } else {
      removeReaction(messageId, emoji, fromPeerId);
    }
    schedulePublishNativeSnapshot();
    return;
  }

  if (payload.kind === 'pin') {
    const messageId = boundedPayloadString(payload.message_id, 256);
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
    schedulePublishNativeSnapshot();
    return;
  }

  if (payload.kind === 'poll_vote') {
    const messageId = boundedPayloadString(payload.message_id, 256);
    const optionIndex = typeof payload.option_index === 'number' ? payload.option_index : -1;
    if (!messageId || !Number.isSafeInteger(optionIndex) || optionIndex < 0 || optionIndex > 1000) return;
    // AUTHORIZATION: only a CURRENT participant of the poll's scope may vote. Connection
    // authentication proves who sent it, not that they belong to the channel/DM — without
    // this check a kicked member (or any peer that learned the message id) could keep
    // changing poll results after removal. Resolve the scope from the message we hold.
    const msg = getState().messages.find(m => m.id === messageId);
    if (!msg) return;
    if (!isScopeMember(msg.scope_id, msg.scope_type, msg.server_id, fromPeerId)) return;
    addPollVote(messageId, optionIndex, fromPeerId);
    schedulePublishNativeSnapshot();
    return;
  }

  if (payload.kind === 'report') {
    // Abuse report delivered to us as a server OWNER. Only accept it for a server we
    // actually own (the moderator who can act on it); ignore reports for anything else.
    const serverId = boundedPayloadString(payload.server_id, 256);
    const server = getState().servers[serverId];
    if (!serverId || !server || server.owner_peer_id !== (getState().identity?.peer_id ?? '')) return;
    // The authenticated sender must be a member of the server — otherwise any peer that
    // learns a server id could spam the owner with forged reports/notifications.
    if (!fromPeerId || !server.members.includes(fromPeerId)) return;
    // Reject references that don't belong to this server (channel must be one of ours).
    const reportChannelId = payload.channel_id ? boundedPayloadString(payload.channel_id, 256) ?? undefined : undefined;
    if (reportChannelId && !Object.prototype.hasOwnProperty.call(server.channels ?? {}, reportChannelId)) return;
    addReport({
      id: boundedPayloadString(payload.report_id, 256) ?? crypto.randomUUID(),
      reason: boundedPayloadString(payload.reason, 128) ?? 'other',
      details: payload.details ? boundedPayloadString(payload.details, 4096) ?? undefined : undefined,
      target_kind: payload.target_kind === 'user' ? 'user' : 'message',
      target_id: boundedPayloadString(payload.target_id, 256) ?? '',
      reported_peer_id: payload.reported_peer_id ? boundedPayloadString(payload.reported_peer_id, 256) ?? undefined : undefined,
      server_id: serverId,
      channel_id: reportChannelId,
      content_excerpt: payload.content_excerpt ? boundedPayloadString(payload.content_excerpt, 4096) ?? undefined : undefined,
      reporter_peer_id: fromPeerId,
      created_at: new Date().toISOString(),
      inbound: true,
    });
    emitNotify({ kind: 'server', title: 'New report', body: `A member reported content in “${server.name}”` });
    schedulePublishNativeSnapshot();
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
  const serverId = boundedPayloadString(payload.server_id, 256);
  if (!serverId) return { ok: false, error: 'missing_server_id' };

  // Never let an unknown operation fall through to the read path. In particular,
  // an attacker must not turn an arbitrary family operation plus an invite token
  // into an accidental history oracle.
  if (operation !== 'sync.join' && operation !== 'sync.pull'
    && operation !== 'sync.coverage' && operation !== 'sync.fetch'
    && operation !== 'sync.update' && operation !== 'sync.leave'
    && operation !== 'sync.delete' && operation !== 'sync.remove') {
    return { ok: false, error: 'unsupported_operation' };
  }

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
      if (incoming.owner_proof
        && !verifyServerRecord(incoming as XoreinRuntimeServer)) {
        return { ok: false, error: 'invalid_owner_proof' };
      }
      // Reject a STALE whole snapshot: broadcastServerUpdate is fire-and-forget on
      // independent streams, so an older update can arrive after a newer one. Applying
      // it would restore roles/permissions/membership the owner just changed. Gate the
      // entire apply on a monotonic server_rev (older owners omit it → still applied).
      const incomingRev = typeof incoming.server_rev === 'number' ? incoming.server_rev : undefined;
      const storedRev = typeof server.server_rev === 'number' ? server.server_rev : -1;
      if (incomingRev !== undefined && incomingRev <= storedRev) {
        return { ok: true };
      }
      // Apply the owner-authoritative fields. CRITICAL: this must include the
      // channel mode/root/epoch tuple and roles/member_roles —
      // previously they were silently dropped here, so kicks never revoked keys
      // and role changes never reached members.
      const nextRoot = typeof incoming.crowd_root === 'string' ? incoming.crowd_root : undefined;
      const nextEpoch = typeof incoming.crowd_epoch === 'number' ? incoming.crowd_epoch : undefined;
      if (incoming.channel_security_mode !== undefined
        && !isChannelSecurityMode(incoming.channel_security_mode)) {
        return { ok: false, error: 'invalid_channel_security_mode' };
      }
      if (incoming.channel_crypto_profile !== undefined
        && incoming.channel_crypto_profile !== 'scope-aad-v2') {
        return { ok: false, error: 'unsupported_channel_crypto_profile' };
      }
      const nextMode = isChannelSecurityMode(incoming.channel_security_mode)
        ? incoming.channel_security_mode
        : 'crowd';
      // crowd_epoch is monotonic. Because broadcastServerUpdate is fire-and-forget on
      // independent streams, an OLDER update can arrive after a newer rotation — persist
      // the root/epoch only when it advances (>= stored), or the store would regress to
      // an obsolete key and fail to decrypt current-epoch traffic after a reload.
      const storedEpoch = typeof server.crowd_epoch === 'number' ? server.crowd_epoch : -1;
      const storedMode = channelModeForServer(serverId);
      const modeChanged = nextMode !== storedMode;
      if (nextRoot !== undefined && nextEpoch === storedEpoch
        && (modeChanged || nextRoot !== server.crowd_root)) {
        return { ok: false, error: 'channel_epoch_reused' };
      }
      const applyChannel = nextRoot !== undefined && nextEpoch !== undefined
        && (nextEpoch > storedEpoch
          || (nextEpoch === storedEpoch && !modeChanged && nextRoot === server.crowd_root));
      updateServer(serverId, {
        ...(incoming.channels ? { channels: incoming.channels } : {}),
        ...(Array.isArray(incoming.members) ? { members: incoming.members } : {}),
        ...(incoming.manifest ? { manifest: incoming.manifest } : {}),
        ...(typeof incoming.name === 'string' && incoming.name ? { name: incoming.name } : {}),
        ...(typeof incoming.description === 'string' ? { description: incoming.description } : {}),
        ...(applyChannel ? {
          crowd_root: nextRoot,
          crowd_epoch: nextEpoch,
          channel_security_mode: nextMode,
          channel_crypto_profile: incoming.channel_crypto_profile ?? 'scope-aad-v2',
        } : {}),
        ...(typeof incoming.replica_secret === 'string'
          ? { replica_secret: incoming.replica_secret }
          : {}),
        ...(Array.isArray(incoming.roles) ? { roles: incoming.roles } : {}),
        ...(incoming.member_roles && typeof incoming.member_roles === 'object' ? { member_roles: incoming.member_roles } : {}),
        ...(incoming.owner_proof ? { owner_proof: incoming.owner_proof } : {}),
        ...(typeof incoming.invite_generation === 'number'
          ? { invite_generation: incoming.invite_generation }
          : {}),
        // Persist the owner-authoritative join boundaries (member_since). Every member
        // answers sync.pull for this server, so every member needs the boundary map to
        // enforce the pre-join history policy — it is join-time metadata (who joined
        // when), not capability material like invite_secret.
        ...(incoming.member_since && typeof incoming.member_since === 'object' && !Array.isArray(incoming.member_since)
          ? { member_since: incoming.member_since as Record<string, string> }
          : {}),
        ...(incomingRev !== undefined ? { server_rev: incomingRev } : {}),
      });
      // Install the (possibly rotated) root into the live crypto so the new epoch
      // takes effect immediately — only when we actually persisted an advancing root.
      if (applyChannel) {
        applyChannelRoot(serverId);
        // The new root may unlock channel messages that raced ahead of it — replay any
        // buffered future-epoch ciphertext now that this epoch's key is installed.
        replayBufferedChannelMessages(serverId);
        // Rekey any active voice call on this server: SFrame keys derive from crowd_root,
        // so a rotation must re-key remaining members and drop removed ones' connections.
        rekeyVoiceForServer(serverId);
      }
      schedulePublishNativeSnapshot();
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
      rotateChannelEpoch(serverId);
      schedulePublishNativeSnapshot();
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
      schedulePublishNativeSnapshot();
    }
    return { ok: true };
  }

  // SECURITY: a non-member must present either the legacy owner-only HMAC token
  // or a portable owner-signed capability for the current invite generation.
  // The latter is independently verifiable by every member, so owner downtime
  // cannot turn a valid invite into a dead link.
  const alreadyMember = !!remotePeerId && server.members.includes(remotePeerId);
	const inviteToken = boundedPayloadString(payload.invite_token, 12_288, true) ?? '';
  const signedInvite = verifySignedInviteCapability(
    inviteToken,
    serverId,
    server.owner_peer_id,
    server.invite_generation ?? 0,
  );
  const legacyOwnerInvite = isOwner
    && verifyInviteToken(server.invite_secret, serverId, inviteToken);
	if (!alreadyMember && !signedInvite && !legacyOwnerInvite) {
		return { ok: false, error: 'invalid_invite' };
	}
	// A fresh membership response is an owner authorization decision. Existing
	// members may reconcile from any member, but a peer that is not yet a member
	// must never be admitted by a co-member or receive a member-served snapshot.
	// Validate the capability first so callers get the stable invalid_invite
	// result for a missing/invalid token rather than an authorization oracle.
	if (!alreadyMember && operation !== 'sync.join') {
		return { ok: false, error: 'owner_required' };
	}
	if (operation === 'sync.join' && !alreadyMember && !isOwner && !signedInvite) {
		return { ok: false, error: 'owner_required' };
	}

  // Learn the joiner's reachable circuit addresses so we can deliver back across
  // relays (keyed to the authenticated peer) — and their self-declared profile, so
  // the member list shows their name immediately instead of waiting for the next
  // presence heartbeat (~25s).
  const joinerAddrs = circuitAddrsFromPayload(payload, remotePeerId);
  const joinerName = typeof payload.display_name === 'string' && payload.display_name.trim()
    ? payload.display_name.trim()
    : undefined;
  if (remotePeerId && (joinerAddrs.length || joinerName)) {
    upsertPeer({
      peer_id: remotePeerId,
      role: 'peer',
      ...(joinerAddrs.length ? { addresses: joinerAddrs } : {}),
      ...(joinerName ? { display_name: joinerName } : {}),
      last_seen_at: new Date().toISOString(),
    });
  }

  // Only the owner mutates membership; any member can still serve a read copy.
  // A brand-new joiner: add them, then ROTATE the Crowd epoch so they cannot derive
  // the previous epoch's sender keys (forward secrecy on join). Existing members
  // receive the fresh root via the broadcast below; the joiner gets it in this
  // response's server record. Re-pulls by existing members do NOT rotate.
  const isNewOwnerJoiner = operation === 'sync.join' && isOwner && remotePeerId && !alreadyMember;
  if (isNewOwnerJoiner) {
    // Record the join boundary NOW so it is enforced on every later pull, not just this
    // response — otherwise `alreadyMember` flips true and a subsequent sync.pull would
    // serve the full retention window, leaking the pre-join history the policy withheld.
    const joinedAt = new Date().toISOString();
    updateServer(serverId, {
      members: [...server.members, remotePeerId],
      member_since: { ...(server.member_since ?? {}), [remotePeerId]: joinedAt },
    });
    rotateChannelEpoch(serverId);
    broadcastServerUpdate(serverId);
    schedulePublishNativeSnapshot();
  } else if (operation === 'sync.join' && signedInvite && remotePeerId && !alreadyMember) {
    // Portable admission: the owner already delegated this decision by signing
    // the capability. A member may add the authenticated requester to its local
    // effective roster and serve the owner-signed snapshot. No member is allowed
    // to rewrite channels/policy/key epochs; verifyServerRecord on the joiner
    // keeps that authority with the owner.
    const joinedAt = new Date().toISOString();
    updateServer(serverId, {
      members: [...server.members, remotePeerId],
      member_since: { ...(server.member_since ?? {}), [remotePeerId]: joinedAt },
    });
    schedulePublishNativeSnapshot();
  }

  const current = getState().servers[serverId] ?? server;
  // Chronological order (oldest → newest) so cursor paging is deterministic across
  // peers regardless of local store insertion order. Tie-break equal timestamps by id
  // so the (created_at, id) cursor is a total order — otherwise a page ending on a
  // timestamp shared by many messages would skip the rest of them on the next pull.
  const allMessages = getState().messages
    // Keep signed deletion tombstones in the replicated log. Omitting them lets
    // an old-but-valid provider copy resurrect content after a fresh install.
    .filter(m => m.server_id === serverId)
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
  // SECURITY (pre-join boundary on EVERY responder, not just the owner): member_since
  // is owner-authoritative and distributed with the server record, but a non-owner
  // responder may hold no entry for the requester (e.g. a stale copy from before the
  // requester joined). In that case FAIL CLOSED — serve only the join_history_messages
  // allowance — instead of treating "no boundary recorded" as "entitled to everything",
  // which let any co-member hand a new joiner the full pre-join history. Two peers are
  // exempt from fail-closed: the requesting OWNER (the history authority is never
  // clamped by its own members) and, on the owner's side, a legacy member from before
  // boundaries were tracked (the owner's map is authoritative, so a missing entry
  // there genuinely means "no boundary").
  const requesterIsOwner = !!remotePeerId && remotePeerId === current.owner_peer_id;
  let boundaried: XoreinRuntimeMessage[];
  if (requesterIsOwner) {
    boundaried = allMessages;
  } else if (!memberSince && !isOwner) {
    boundaried = joinWindow > 0 ? allMessages.slice(-joinWindow) : [];
  } else {
    boundaried = applyJoinBoundary(allMessages, memberSince, joinWindow);
  }

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

  // Provider-neutral availability exchange. Coverage is only a hint; the
  // requester verifies every fetched author proof independently.
  if (operation === 'sync.coverage') {
    if (!alreadyMember || !pullChannelId) return { ok: false, error: 'member_required' };
    const scoped = boundaried.filter(m => m.scope_id === pullChannelId).slice(-retention);
    const older = before
      ? scoped.filter(m => {
        const ts = String(m.created_at ?? '');
        return ts < before || (ts === before && String(m.id) < beforeId);
      })
      : scoped;
    const portableOlder = older
      .filter(message => verifySignedHistoryMessage(message).ok);
    const portable = portableOlder.slice(-Math.min(pageLimit, 200));
    return {
      ok: true,
      entries: portable.map(message => ({
        id: message.id,
        created_at: message.created_at ?? '',
        content_hash: message.author_proof!.content_hash,
        revision: message.author_revision ?? 0,
      })),
      has_more: portableOlder.length > portable.length,
    };
  }

  // Fetch exact content-addressed records assigned to this provider by the
  // requester's round-robin planner. Membership, retention, and join boundaries
  // are re-applied here; an inventory claim is never a read capability.
  if (operation === 'sync.fetch') {
    if (!alreadyMember || !pullChannelId) return { ok: false, error: 'member_required' };
    const ids = Array.isArray(payload.message_ids)
      ? payload.message_ids.filter((id): id is string =>
        typeof id === 'string' && id.length > 0 && id.length <= 256 && !hasControlCharacters(id),
      ).slice(0, 100)
      : [];
    if (!ids.length || ids.length !== (payload.message_ids as unknown[] | undefined)?.length) {
      return { ok: false, error: 'invalid_message_ids' };
    }
    const requested = new Set(ids);
    const messages = boundaried
      .filter(message => message.scope_id === pullChannelId)
      .slice(-retention)
      .filter(message => requested.has(message.id))
      .filter(message => verifySignedHistoryMessage(message).ok);
    return { ok: true, messages };
  }

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
  // member_since is deliberately INCLUDED: it is the owner-authoritative join-boundary
  // map every member needs to enforce the pre-join history policy when they serve
  // sync.pull themselves (join-time metadata, not secret capability material).
  const {
    invite_secret: _omit,
    admission_capability: _omitAdmission,
    ...serverForJoiner
  } = current;
  return { ok: true, server: serverForJoiner, messages, addresses, has_more: hasMore };
}

/**
 * Async sync-family dispatcher. Blob fragment operations touch IndexedDB and
 * therefore cannot use the legacy synchronous server-history responder.
 */
export async function handleSyncOperationRequest(
  operation: string,
  payload: Record<string, unknown>,
  remotePeerId: string,
): Promise<Record<string, unknown>> {
  if (operation === 'sync.blob.store'
    || operation === 'sync.blob.inventory'
    || operation === 'sync.blob.fetch') {
    return handleBlobSyncRequest(operation, payload, remotePeerId);
  }
  return handleSyncRequest(operation, payload, remotePeerId);
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

/**
 * Run the authenticated inbound notify.push path (reaction / pin / poll_vote /
 * report) with `fromPeerId` as the connection-authenticated sender. Exported so
 * tests can exercise the per-kind authorization rules (e.g. a pin is applied only
 * when the sender really holds MANAGE_MESSAGES) without a live libp2p stream.
 */
export function ingestNotifyPush(payload: Record<string, unknown>, fromPeerId: string): void {
  handleNotifyPush(payload, fromPeerId);
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
    schedulePublishNativeSnapshot();
    return;
  }

  if (kind === 'accept') {
    // Learn the accepter's display name from the accept payload so the requester's
    // friends list / DM header shows a real name immediately (not a raw peer id
    // until the next presence heartbeat).
    if (typeof payload.display_name === 'string' && payload.display_name.trim()) {
      upsertPeer({ peer_id: remotePeerId, role: 'peer', display_name: payload.display_name.trim(), last_seen_at: new Date().toISOString() });
    }
    acceptFriendByPeer(remotePeerId);
    emitNotify({ kind: 'friend', title: 'Friend request accepted', body: `${peerDisplayName(remotePeerId)} accepted your friend request` });
    schedulePublishNativeSnapshot();
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
function parseRequestPayload(req: PeerStreamRequest): Record<string, unknown> {
  if (!req.payload) return {};
  try { return JSON.parse(dec.decode(req.payload)) as Record<string, unknown>; } catch { return {}; /* non-JSON */ }
}

function makeRequestHandler(
  peerSync: PeerSync,
  handle: (operation: string, payload: Record<string, unknown>, remotePeerId: string) => unknown | Promise<unknown>,
) {
  return async (stream: InboundFamilyStream, connection: { remotePeer: { toString(): string }; remoteAddr: { toString(): string } }) => {
    try {
      const remotePeerId = connection.remotePeer.toString();
      const remoteAddr = connection.remoteAddr.toString();
      peerSync.registerPeer(remotePeerId, remoteAddr.includes('p2p-circuit') ? remoteAddr : undefined);

      // Streams are persistent: serve every framed request the peer sends
      // (legacy one-shot peers half-close after one; the loop then drains).
      await serveFamilyStream(stream, async (req) => {
        let result: unknown;
        try { result = await handle(req.operation, parseRequestPayload(req), remotePeerId); }
        catch { result = { ok: false, error: 'handler_error' }; }
        return frameMessage(encodePeerStreamResponse({ payload: enc.encode(JSON.stringify(result)), requestId: req.requestId }));
      });
    } catch { /* non-fatal */ }
  };
}

export async function dispatchAuthenticatedOperation(
  inner: RoutedInnerRequest,
  originPeerId: string,
  peerSync: PeerSync,
): Promise<unknown> {
  if (inner.protocol === PROTOCOLS.peer) {
    if (inner.operation === 'peer.route') return { ok: false, error: 'nested_route' };
    return handlePeerRequest(inner.operation, inner.payload, originPeerId, peerSync);
  }
  if (inner.protocol === PROTOCOLS.sync) {
    return handleSyncOperationRequest(inner.operation, inner.payload, originPeerId);
  }
  if (inner.protocol === PROTOCOLS.seal && inner.operation === 'seal.bundle') {
    return handleSealBundle();
  }
  if (inner.protocol === PROTOCOLS.chat) {
    handleChatOp(inner.payload, originPeerId, inner.operation);
    return { ok: true };
  }
  if (inner.protocol === PROTOCOLS.friends) {
    handleFriendOp(inner.payload, originPeerId, inner.operation);
    return { ok: true };
  }
  if (inner.protocol === PROTOCOLS.presence) {
    handlePresenceUpdate(inner.payload, originPeerId, inner.operation);
    return { ok: true };
  }
  if (inner.protocol === PROTOCOLS.notify) {
    handleNotifyPush(inner.payload, originPeerId, inner.operation);
    return { ok: true };
  }
  if (inner.protocol === PROTOCOLS.recovery) {
    if (inner.operation === RECOVERY_OPS.store) {
      return handleRecoveryStore(inner.payload, originPeerId);
    }
    if (inner.operation === RECOVERY_OPS.storeChunk) {
      return handleRecoveryStoreChunk(inner.payload, originPeerId);
    }
    if (inner.operation === RECOVERY_OPS.request) {
      return handleRecoveryRequest(inner.payload, originPeerId);
    }
    if (inner.operation === RECOVERY_OPS.deliver) {
      return handleRecoveryDeliver(inner.payload, originPeerId);
    }
    if (inner.operation === RECOVERY_OPS.deliverChunk) {
      return handleRecoveryDeliverChunk(inner.payload, originPeerId);
    }
    return { ok: false, error: 'unknown_recovery_operation' };
  }
  return { ok: false, error: 'route_protocol_not_allowed' };
}

async function handlePeerRequest(
  operation: string,
  payload: Record<string, unknown>,
  remotePeerId: string,
  peerSync: PeerSync,
): Promise<unknown> {
  if (operation === 'peer.mailbox.store'
    || operation === 'peer.mailbox.drain'
    || operation === 'peer.inbox.store'
    || operation === 'peer.inbox.drain') {
    return handlePeerMailboxRequest(operation, payload, remotePeerId);
  }
  if (operation === 'peer.rendezvous.mesh.register'
    || operation === 'peer.rendezvous.mesh.discover') {
    return handlePeerRendezvousRequest(operation, payload, remotePeerId);
  }
  if (operation === 'peer.info') {
    const state = getState();
    return {
      peer_id: state.identity?.peer_id ?? '',
      role: 'client',
      addresses: peerSync.localCircuitAddrs(),
      capabilities: [
        'cap.peer.transport',
        'cap.chat',
        'cap.sync',
        'cap.mailbox.peer',
        'cap.inbox.peer',
        'cap.rendezvous.peer',
        'cap.blob.peer',
      ],
    };
  }
  if (operation === 'peer.exchange') {
    const rawKnown = Array.isArray(payload.known_peer_ids) ? payload.known_peer_ids : [];
    if (rawKnown.length > 200 || rawKnown.some(id =>
      typeof id !== 'string' || !id || id.length > 256 || hasControlCharacters(id),
    )) return [];
    return knownSignedPeerRecords(new Set(rawKnown as string[]));
  }
  if (operation === 'peer.route') {
    const request = payload as unknown as RoutedRequest;
    const localPeerId = getState().identity?.peer_id ?? '';
    if (!localPeerId
      || !verifyRoutedRequest(request)
      || request.path.at(-1) !== remotePeerId
      || request.path.includes(localPeerId)
      || !claimRoutedRequest(request)) {
      return { ok: false, error: 'invalid_route' };
    }
    if (request.target_peer_id !== localPeerId) {
      return peerSync.forwardRoutedRequest(request, remotePeerId);
    }
    const inner = openRoutedRequest(request);
    if (!inner) return { ok: false, error: 'route_decrypt_failed' };
    const result = await dispatchAuthenticatedOperation(inner, request.origin_peer_id, peerSync);
    const response = sealRoutedResponse(request, result);
    return response
      ? { ok: true, response_ciphertext: response }
      : { ok: false, error: 'route_response_failed' };
  }
  return { ok: false, error: 'unsupported_operation' };
}


function makeHandler(
  localPeerId: string,
  peerSync: PeerSync,
  handle: (payload: Record<string, unknown>, remotePeerId: string, operation: string) => void,
) {
  return async (stream: InboundFamilyStream, connection: { remotePeer: { toString(): string }; remoteAddr: { toString(): string } }) => {
    try {
      const remotePeerId = connection.remotePeer.toString();
      const remoteAddr = connection.remoteAddr.toString();
      // Register the peer's addr so outbound can reach them.
      peerSync.registerPeer(remotePeerId, remoteAddr.includes('p2p-circuit') ? remoteAddr : undefined);

      // Streams are persistent: serve every framed request the peer sends.
      await serveFamilyStream(stream, (req) => {
        handle(parseRequestPayload(req), remotePeerId, req.operation);
        return okResponse(req.requestId);
      });
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
    PROTOCOLS.peer,
    makeRequestHandler(
      peerSync,
      (operation, payload, remotePeerId) =>
        handlePeerRequest(operation, payload, remotePeerId, peerSync),
    ) as Parameters<typeof node.handle>[1],
    opts,
  );

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
    makeRequestHandler(peerSync, handleSyncOperationRequest) as Parameters<typeof node.handle>[1],
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
