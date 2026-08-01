// Native mutation operations — CRUD that drives the local store and immediately
// re-publishes the snapshot. These are the native replacements for the
// xoreinControl.ts HTTP mutations consumed by src/hooks/runtime/mutations.ts.
import type {
  XoreinRuntimeServer,
  XoreinRuntimeChannel,
  XoreinRuntimeMessage,
  XoreinFriendRecord,
  XoreinAttachment,
  ServerRole,
} from '../../types.js';
import {
  addMessage, editMessage as storeEditMessage, deleteMessage as storeDeleteMessage,
  addReaction as storeAddReaction, removeReaction as storeRemoveReaction,
  pinMessage as storePinMessage,
  setMessageDeliveryStatus,
  addServer, addChannel, updateChannel as storeUpdateChannel, removeChannel as storeRemoveChannel,
  updateServer, removeServerMembership, removeServerMember,
  setActiveScope as storeSetActiveScope, clearUnread as storeClearUnread,
  ensureDm,
  addFriendRequest, acceptFriend, removeFriendRequest,
  joinVoice, leaveVoice,
  addRelay, removeRelay,
  updatePresenceEntry,
  addServerRole, updateServerRole, removeServerRole, setMemberRoles, addPollVote,
  memberHasPermission, setPeerVerified, addReport, setReportDelivery, setReportResolved,
  enqueueOutbox, removeOutbox, getOutbox, setFriendRequestDeliveryStatus,
  updateMessageVersion,
} from './store.js';
import type { XoreinReport } from '../../types.js';
import { publishNativeSnapshot, schedulePublishNativeSnapshot } from './snapshot.js';
import { markStateDirty } from './stateSync.js';
import type { NativeState } from './store.js';
import { getState } from './store.js';
import { getPeerSync } from '../sync/registry.js';
import { rekeyVoiceForServer } from '../voice/registry.js';
import { encryptChannelEnvelope, encryptDmEnvelope, channelSecurityMode, applyChannelRoot } from '../sync/secureEnvelope.js';
import { recordedChannelSecurityMode, selectChannelSecurityMode } from '../security/channelMode.js';
import { CHANNEL_CRYPTO_PROFILE } from '../security/channelMode.js';
import { depositOfflineChat } from '../delivery/offline.js';
import { depositRecipientInboxOperation } from '../delivery/recipientInbox.js';
import { addRelayOverride, removeRelayOverride } from '../transport/relays.js';
import { isTrustedRelayMultiaddr } from '../transport/node.js';
import { PROTOCOLS } from '../families/families.js';
import { parseJoinDeepLink, buildJoinDeepLink } from '../../protocol/deeplink.js';
import {
  computeInviteToken,
  createForwardSecureInviteCapability,
  isForwardSecureInviteTransitionRecord,
  openForwardSecureInviteTransition,
  verifySignedInviteCapability,
} from '../sync/invite.js';
import { signChannelMessageVersion } from '../sync/signedHistory.js';
import { signServerRecord, verifyServerRecord } from '../sync/signedServer.js';

/** Generate a fresh base64 32-byte channel epoch root for a new server. */
function freshCrowdRoot(): string {
  const r = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < r.length; i++) s += String.fromCharCode(r[i]);
  return btoa(s);
}

/**
 * Owner-only: rotate a server's channel epoch and automatically select the mode
 * appropriate for the current roster. Every transition mints a fresh random root,
 * so switching Tree/Crowd never reuses key material. The caller broadcasts the
 * owner-signed (mode, root, epoch) tuple only to remaining members.
 */
export function rotateChannelEpoch(serverId: string): boolean {
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== localPeerId()) return false;
  if (!server.crowd_root) return false; // no channel key to rotate
  const nextEpoch = (server.crowd_epoch ?? 0) + 1;
  const currentMode = recordedChannelSecurityMode(server.channel_security_mode);
  const nextMode = selectChannelSecurityMode(server.members.length, currentMode);
  updateServer(serverId, {
    crowd_root: freshCrowdRoot(),
    crowd_epoch: nextEpoch,
    channel_security_mode: nextMode,
    ...(server.manifest ? { manifest: { ...server.manifest, security_mode: nextMode } } : {}),
  });
  applyChannelRoot(serverId); // encrypt under the new mode/epoch from now on
  // Rekey the owner's own active voice call on this server so its SFrame keys track the
  // new root and any just-removed member's live connection is torn down.
  rekeyVoiceForServer(serverId);
  return true;
}

/** Compatibility alias for older call sites. */
export const rotateCrowdEpoch = rotateChannelEpoch;

function localPeerId(): string {
  return getState().identity?.peer_id ?? '';
}

function nowISO(): string {
  return new Date().toISOString();
}

function uid(): string {
  return crypto.randomUUID();
}

/** Resolve on the first acknowledged network placement, or false once every
 * bounded path has failed. Remaining successful paths keep running so a direct
 * delivery can still be backed by the recipient's three-copy peer inbox. */
function firstSuccessfulDelivery(attempts: Array<Promise<boolean>>): Promise<boolean> {
  if (!attempts.length) return Promise.resolve(false);
  return new Promise(resolve => {
    let remaining = attempts.length;
    let settled = false;
    for (const attempt of attempts) {
      void attempt.then(ok => {
        if (settled) return;
        if (ok) {
          settled = true;
          resolve(true);
          return;
        }
        remaining--;
        if (remaining === 0) {
          settled = true;
          resolve(false);
        }
      }, () => {
        if (settled) return;
        remaining--;
        if (remaining === 0) {
          settled = true;
          resolve(false);
        }
      });
    }
  });
}

/**
 * Deliver a durable one-recipient operation over both the lowest-latency live
 * path and the replicated recipient inbox. These paths deliberately race:
 * a silent destination cannot prevent another authenticated peer from
 * accepting custody, and a fast direct delivery is still repaired toward
 * three independent holders in the background.
 */
async function deliverRecipientOperation(
  targetPeerId: string,
  protocol: string,
  operation: string,
  payload: Record<string, unknown>,
  deliveryId: string,
  legacyChatFallback = false,
): Promise<boolean> {
  const sync = getPeerSync();
  const placed = await firstSuccessfulDelivery([
    sync
      ? sync.sendToPeer(targetPeerId, protocol, operation, payload).catch(() => false)
      : Promise.resolve(false),
    depositRecipientInboxOperation(
      targetPeerId,
      protocol,
      operation,
      payload,
      deliveryId,
    ).catch(() => false),
  ]);
  if (placed || !legacyChatFallback) return placed;
  return await depositOfflineChat(targetPeerId, payload).catch(() => false);
}

// ── Deferred snapshot publish (send-path latency) ──────────────────────────
//
// publishNativeSnapshot() is heavy: a full snapshot JSON.stringify, three
// localStorage writes, and synchronous 'focus'/'visibilitychange' dispatches that
// kick off React Query refetches. Calling it inline on a message send serializes
// all of that IN FRONT of the outbound network pipeline: the libp2p dial/negotiate
// steps progress on microtasks, which cannot run until the current synchronous
// block (including the publish and its listeners) finishes.
//
// Scheduling the publish on a macrotask (setTimeout 0) instead lets the ENTIRE
// pending microtask queue — i.e. the dial + multistream-select + first socket
// write of the just-initiated broadcast — drain first, so the encrypted envelope
// reaches the wire before the UI-refresh storm begins. The local echo is delayed
// by at most one event-loop turn (~0-4ms), which is imperceptible.
//
// Durability is unaffected: the store write (addMessage/enqueueOutbox → persist)
// stays synchronous; only the UI snapshot mirror is deferred. Multiple sends in
// one tick coalesce into a single publish. (Implementation lives in snapshot.ts
// so inbound handlers share the same coalescing.)

// ── Message mutations ──────────────────────────────────────────────────────

export function nativeSendChannelMessage(
  channelId: string,
  body: string,
  opts: { reply_to?: string; forwarded_from?: string; media?: XoreinAttachment[] } = {},
): XoreinRuntimeMessage {
  const state = getState();
  const server = Object.values(state.servers).find(s =>
    Object.keys(s.channels).includes(channelId),
  );
  // The real mode this message will cross the wire under: crowd when the shared
  // epoch root is seeded, else clear (encryption impossible → kept local). Stamped
  // now so the security badge reflects what actually happens, not the scope type.
  const chanMode = server ? channelSecurityMode(server.id) : 'clear';
  const msg: XoreinRuntimeMessage = {
    id: uid(),
    scope_type: 'channel',
    scope_id: channelId,
    server_id: server?.id,
    sender_peer_id: localPeerId(),
    body,
    created_at: nowISO(),
    delivery_status: 'pending',
    security_mode: chanMode,
    encrypted: chanMode !== 'clear',
    author_revision: 0,
    ...opts,
  };
  msg.author_proof = signChannelMessageVersion(msg);
  addMessage(msg);
  // Replicate even in a one-member server: support nodes are optional helpers,
  // and the periodic repair loop will retry if none are reachable yet.
  void getPeerSync()?.repairHistoryReplica?.(msg);

  // P2P: broadcast a CROWD-ENCRYPTED envelope to all server members. The shared
  // epoch root is held locally and never sent to the support node, so the relay
  // only ever sees ciphertext. If no root is seeded yet (e.g. an owner-pending
  // placeholder join) the message stays local — we never transmit plaintext.
  //
  // LATENCY ORDER: the encrypted envelope goes onto the wire FIRST (the async
  // broadcast below is initiated before any snapshot publish); the heavy snapshot
  // publish is deferred one macrotask via schedulePublishNativeSnapshot so the
  // dial/negotiate/write microtasks of the broadcast drain ahead of it. addMessage
  // stays synchronous and FIRST so every delivery-status transition (including the
  // transport-down branch inside the broadcast closure, which runs synchronously)
  // finds the message already in the store.
  const members = server?.members ?? [];
  if (members.length > 1 && server) {
    // Crowd/Tree epoch material is shared by every Space member. It protects
    // confidentiality, but sender identity comes from this hybrid author proof.
    // Never put an unsigned channel envelope on the wire: a shared-key holder
    // could otherwise forge another member's `sender_id` once the message leaves
    // its original Noise-authenticated stream.
    if (!msg.author_proof) {
      setMessageDeliveryStatus(msg.id, 'offline_queued');
      publishNativeSnapshot();
      return msg;
    }
    const base = {
      message_id: msg.id,
      scope_id: channelId,
      scope_type: 'channel',
      server_id: server.id,
      sender_id: msg.sender_peer_id,
      created_at: msg.created_at,
      author_revision: msg.author_revision,
      author_proof: msg.author_proof,
      // The reply reference must cross the wire, or the recipient renders the
      // reply as an unattached message with no quoted context.
      ...(opts.reply_to ? { reply_to: opts.reply_to } : {}),
      ...(opts.forwarded_from ? { forwarded_from: opts.forwarded_from } : {}),
    };
    const envelope = encryptChannelEnvelope(server.id, msg.sender_peer_id, base, body, opts.media);
    if (envelope) {
      void (async () => {
        const sync = getPeerSync();
        const msgId = msg.id;
        if (!sync) {
          // Relay/transport down: DURABLY queue the encrypted envelope so it is
          // replayed on reconnect — not discarded behind a misleading "queued" badge.
          enqueueOutbox({
            id: uid(),
            targets: members.filter(m => m !== msg.sender_peer_id),
            protocol: PROTOCOLS.chat,
            operation: 'chat.send',
            payload: envelope,
            message_id: msgId,
            created_at: nowISO(),
            attempts: 0,
          });
          setMessageDeliveryStatus(msgId, 'offline_queued');
          publishNativeSnapshot();
          return;
        }
        const undelivered = await sync.broadcastToScope(members, PROTOCOLS.chat, 'chat.send', envelope);
        // Channel history is a signed, multi-source swarm. Depositing one private
        // mailbox copy per offline member makes a 1,000-member space perform 1,000
        // stores and 1,000 token polls. Once any member has the record, every
        // entitled member can restore it from peers/nodes. Keep a durable local
        // retry only when nobody else received the record at all.
        const allTargets = members.filter(m => m !== msg.sender_peer_id);
        const reachedSomeone = allTargets.length === 0 || allTargets.length > undelivered.length;
        if (!reachedSomeone && undelivered.length) {
          enqueueOutbox({
            id: uid(),
            targets: undelivered,
            protocol: PROTOCOLS.chat,
            operation: 'chat.send',
            payload: envelope,
            message_id: msgId,
            created_at: nowISO(),
            attempts: 0,
          });
        }
        setMessageDeliveryStatus(msgId, reachedSomeone ? 'sent' : 'offline_queued');
        publishNativeSnapshot();
      })();
      // Local echo: published AFTER the broadcast microtasks flush (see helper).
      schedulePublishNativeSnapshot();
    } else {
      // No envelope (no crowd_root) — message stays local, no delivery possible.
      setMessageDeliveryStatus(msg.id, 'offline_queued');
      publishNativeSnapshot();
    }
  } else {
    // Single-member server or no server: no peers to deliver to, mark sent locally.
    setMessageDeliveryStatus(msg.id, 'sent');
    publishNativeSnapshot();
  }
  return msg;
}

export function nativeSendDmMessage(
  dmId: string,
  body: string,
  opts: { forwarded_from?: string; media?: XoreinAttachment[] } = {},
): XoreinRuntimeMessage {
  const dm = getState().dms[dmId];
  // Guard: refuse to create a "sent" message if the DM thread doesn't exist.
  // A missing DM means the thread was never opened/created — sending here would
  // produce a locally-stored message that can never be delivered, misleading the
  // user into thinking it was sent. The mutation facade calls nativeEnsureDirectMessage
  // before send, so this guard is a last-resort safety net.
  if (!dm) throw new Error(`nativeSendDmMessage: DM thread ${dmId} does not exist`);
  // DM bodies are always Seal-encrypted (X3DH + Double Ratchet) per recipient; the
  // send path never transmits plaintext (it queues locally on session failure), so
  // the conversation is honestly Seal-mode.
  const msg: XoreinRuntimeMessage = {
    id: uid(),
    scope_type: 'dm',
    scope_id: dmId,
    sender_peer_id: localPeerId(),
    body,
    created_at: nowISO(),
    delivery_status: 'pending',
    security_mode: 'seal',
    encrypted: true,
    ...opts,
  };
  addMessage(msg);

  // P2P: deliver a SEAL-ENCRYPTED (X3DH + Double Ratchet) envelope to each other
  // DM participant. Each recipient gets its own ratchet ciphertext; if a session
  // cannot be established (peer unreachable) the message stays local and is not
  // transmitted in plaintext.
  //
  // LATENCY ORDER: same as the channel path — the seal/encrypt/deliver closure is
  // initiated first and the snapshot publish is deferred one macrotask, so the
  // encrypt+send microtask chain reaches the socket before the UI-refresh work.
  const participants = dm?.participants ?? [];
  const sender = msg.sender_peer_id;
  if (participants.length > 1) {
    void (async () => {
      const msgId = msg.id;
      const sync = getPeerSync();
      let anyDelivered = false;
      let anyQueued = false;
      for (const peerId of participants) {
        if (peerId === sender) continue;
        const base = {
          message_id: msgId,
          scope_id: dmId,
          scope_type: 'dm',
          sender_id: sender,
        };
        // A built envelope requires a Seal session; when one already exists this
        // resolves without the network even if the relay is down.
        const envelope = await encryptDmEnvelope(peerId, base, body, opts.media);
        if (!envelope) {
          // First contact while the recipient is offline: no prekey bundle reachable, so
          // we can't encrypt yet. Persist a retryable pending-seal entry (plaintext held
          // only in the encrypted-at-rest store) so the drain re-attempts X3DH + encrypt +
          // deliver on reconnect — instead of a permanent "queued" that never ships.
          enqueueOutbox({ id: uid(), targets: [peerId], protocol: PROTOCOLS.chat, operation: 'chat.send', payload: {}, message_id: msgId, created_at: nowISO(), attempts: 0, pending_seal: { recipient: peerId, base, body, media: opts.media } });
          anyQueued = true;
          continue;
        }
        if (!sync) {
          // Relay down but we could encrypt: DURABLY queue the sealed envelope for
          // replay on reconnect instead of dropping it.
          enqueueOutbox({ id: uid(), targets: [peerId], protocol: PROTOCOLS.chat, operation: 'chat.send', payload: envelope, message_id: msgId, created_at: nowISO(), attempts: 0 });
          anyQueued = true;
          continue;
        }
        const delivered = await deliverRecipientOperation(
          peerId,
          PROTOCOLS.chat,
          'chat.send',
          envelope,
          `${msgId}:${peerId}`,
          true,
        );
        if (delivered) {
          anyDelivered = true;
        } else {
          // No live peer and no storage holder acknowledged. Keep the sealed
          // envelope in the encrypted local outbox for the next topology change.
          enqueueOutbox({ id: uid(), targets: [peerId], protocol: PROTOCOLS.chat, operation: 'chat.send', payload: envelope, message_id: msgId, created_at: nowISO(), attempts: 0 });
          anyQueued = true;
        }
      }
      const status = anyDelivered ? 'sent' : anyQueued ? 'offline_queued' : 'sent';
      setMessageDeliveryStatus(msgId, status);
      publishNativeSnapshot();
    })();
    // Local echo: published AFTER the seal/deliver microtasks flush (see helper).
    schedulePublishNativeSnapshot();
  } else {
    // No other participants (solo or just us): mark sent locally.
    setMessageDeliveryStatus(msg.id, 'sent');
    publishNativeSnapshot();
  }
  return msg;
}

export function nativeEditMessage(messageId: string, body: string): void {
  const existing = getState().messages.find(m => m.id === messageId);
  if (!existing || existing.sender_peer_id !== localPeerId()) return;
  const editedAt = nowISO();
  const next: XoreinRuntimeMessage = {
    ...existing,
    body,
    updated_at: editedAt,
    author_revision: (existing.author_revision ?? 0) + 1,
    author_proof: undefined,
  };
  if (next.scope_type === 'channel') next.author_proof = signChannelMessageVersion(next);
  updateMessageVersion(messageId, {
    body,
    updated_at: editedAt,
    author_revision: next.author_revision,
    ...(next.author_proof ? { author_proof: next.author_proof } : {}),
  });
  publishNativeSnapshot();

  // P2P: broadcast the edit (Crowd for channels, Seal for DMs). The signed
  // channel version makes an edit independently verifiable when served later by
  // an untrusted history provider.
  const msg = getState().messages.find(m => m.id === messageId);
  if (!msg) return;
  if (msg.scope_type === 'channel') void getPeerSync()?.repairHistoryReplica?.(msg);
  const scopeMembers = getScopeMembers(msg.scope_id, msg.scope_type, msg.server_id);
  if (scopeMembers.length <= 1) return;

  const base = {
    message_id: messageId,
    scope_id: msg.scope_id,
    scope_type: msg.scope_type,
    server_id: msg.server_id,
    sender_id: localPeerId(),
    created_at: msg.created_at,
    edited_at: editedAt,
    author_revision: msg.author_revision,
    ...(msg.author_proof ? { author_proof: msg.author_proof } : {}),
  };

  if (msg.scope_type === 'channel' && msg.server_id) {
    // Crowd-encrypt the edit payload — inbound handler decrypts before applying.
    // FAIL-CLOSED: if there's no crowd root yet we do NOT fall back to a plaintext
    // edit. The inbound edit handler rejects any edit lacking the scope's required
    // encrypted envelope, so a plaintext broadcast would be silently discarded by
    // every recipient (diverging the conversation) AND put cleartext on the wire —
    // pure downside. The edit stays local until it can be encrypted.
    if (!msg.author_proof) return;
    const envelope = encryptChannelEnvelope(msg.server_id, localPeerId(), base, body);
    if (envelope) {
      void getPeerSync()?.broadcastToScope(scopeMembers, PROTOCOLS.chat, 'chat.edit', envelope);
    }
  } else if (msg.scope_type === 'dm') {
    // Seal-encrypt the edit for each DM participant individually (async). Same
    // fail-closed rule: only transmit a sealed envelope, never a plaintext fallback.
    const recipients = scopeMembers.filter(p => p !== localPeerId());
    for (const recipient of recipients) {
      void encryptDmEnvelope(recipient, base, body).then(sealed => {
        if (sealed) {
          void getPeerSync()?.sendToPeer(recipient, PROTOCOLS.chat, 'chat.edit', sealed);
        }
      });
    }
  }
}

export function nativeDeleteMessage(messageId: string): void {
  const existing = getState().messages.find(m => m.id === messageId);
  if (!existing || existing.sender_peer_id !== localPeerId()) return;
  const deletedAt = nowISO();
  const next: XoreinRuntimeMessage = {
    ...existing,
    deleted: true,
    updated_at: deletedAt,
    author_revision: (existing.author_revision ?? 0) + 1,
    author_proof: undefined,
  };
  if (next.scope_type === 'channel') next.author_proof = signChannelMessageVersion(next);
  updateMessageVersion(messageId, {
    deleted: true,
    updated_at: deletedAt,
    author_revision: next.author_revision,
    ...(next.author_proof ? { author_proof: next.author_proof } : {}),
  });
  publishNativeSnapshot();

  // P2P: broadcast the signed deletion tombstone so a history provider cannot
  // resurrect an older local copy once a recipient has observed this revision.
  const msg = getState().messages.find(m => m.id === messageId);
  if (msg) {
    if (msg.scope_type === 'channel' && !msg.author_proof) return;
    if (msg.scope_type === 'channel') void getPeerSync()?.repairHistoryReplica?.(msg);
    const scopeMembers = getScopeMembers(msg.scope_id, msg.scope_type, msg.server_id);
    if (scopeMembers.length > 1) {
      void getPeerSync()?.broadcastToScope(scopeMembers, PROTOCOLS.chat, 'chat.delete', {
        message_id: messageId,
        scope_id: msg.scope_id,
        scope_type: msg.scope_type,
        server_id: msg.server_id,
        sender_id: localPeerId(),
        created_at: msg.created_at,
        deleted_at: deletedAt,
        author_revision: msg.author_revision,
        ...(msg.author_proof ? { author_proof: msg.author_proof } : {}),
      });
    }
  }
}

export function nativeAddReaction(messageId: string, emoji: string): void {
  const peerId = localPeerId();
  storeAddReaction(messageId, emoji, peerId);
  publishNativeSnapshot();

  // P2P: broadcast reaction to scope members.
  const msg = getState().messages.find(m => m.id === messageId);
  if (msg) {
    const scopeMembers = getScopeMembers(msg.scope_id, msg.scope_type, msg.server_id);
    getPeerSync()?.broadcastReaction({
      memberPeerIds: scopeMembers,
      scopeId: msg.scope_id,
      messageId,
      emoji,
      fromPeerId: peerId,
      action: 'add',
    }).catch(() => { /* non-fatal */ });
  }
}

export function nativeRemoveReaction(messageId: string, emoji: string): void {
  const peerId = localPeerId();
  storeRemoveReaction(messageId, emoji, peerId);
  publishNativeSnapshot();

  // P2P: broadcast reaction removal to scope members.
  const msg = getState().messages.find(m => m.id === messageId);
  if (msg) {
    const scopeMembers = getScopeMembers(msg.scope_id, msg.scope_type, msg.server_id);
    getPeerSync()?.broadcastReaction({
      memberPeerIds: scopeMembers,
      scopeId: msg.scope_id,
      messageId,
      emoji,
      fromPeerId: peerId,
      action: 'remove',
    }).catch(() => { /* non-fatal */ });
  }
}

/**
 * Deliver a notify.push metadata event (pin/unpin, poll vote, …) to `targets`,
 * then DURABLY queue it for any member that could not be reached. These events
 * are never otherwise reconciled for an online-but-unreachable peer (history
 * merge de-dups by message id and does not update pinned/vote metadata), so a
 * plain fire-and-forget broadcast would leave those members permanently stale.
 * The outbox drain (reconnect + heartbeat) retries the missed peers.
 */
function broadcastNotifyDurable(targets: string[], payload: Record<string, unknown>): void {
  if (!targets.length) return;
  void (async () => {
    const sync = getPeerSync();
    let undelivered: string[] = targets;
    if (sync) {
      try {
        const res = await sync.broadcastToScope(targets, PROTOCOLS.notify, 'notify.push', payload);
        undelivered = Array.isArray(res) ? res : [];
      } catch { undelivered = targets; }
    }
    if (undelivered.length) {
      enqueueOutbox({ id: uid(), targets: undelivered, protocol: PROTOCOLS.notify, operation: 'notify.push', payload, created_at: nowISO(), attempts: 0 });
    }
  })();
}

function broadcastPinState(channelId: string, messageId: string, pinned: boolean): void {
  const msg = getState().messages.find(m => m.id === messageId);
  if (!msg) return;
  const scopeMembers = getScopeMembers(channelId, 'channel', msg.server_id);
  const targets = scopeMembers.filter(m => m !== localPeerId());
  broadcastNotifyDurable(targets, {
    kind: 'pin',
    channel_id: channelId,
    message_id: messageId,
    pinned,
    from_peer_id: localPeerId(),
  });
}

export function nativePinMessage(channelId: string, messageId: string): void {
  // AUTHORIZATION: only a member with MANAGE_MESSAGES may pin. THROW (don't bare-return)
  // so the mutation rejects and React Query rolls back the caller's optimistic pin —
  // otherwise the unauthorized pin stays visible/persisted locally even though the store
  // never applied it and every recipient rejects it.
  const target = getState().messages.find(m => m.id === messageId);
  if (target?.server_id && !memberHasPermission(target.server_id, localPeerId(), 'MANAGE_MESSAGES')) {
    throw new Error('not authorized to pin messages in this server');
  }
  storePinMessage(messageId, true);
  publishNativeSnapshot();

  // P2P: broadcast pin to scope members, durably queued for unreachable ones.
  broadcastPinState(channelId, messageId, true);
}

export function nativeUnpinMessage(channelId: string, messageId: string): void {
  const target = getState().messages.find(m => m.id === messageId);
  if (target?.server_id && !memberHasPermission(target.server_id, localPeerId(), 'MANAGE_MESSAGES')) {
    throw new Error('not authorized to unpin messages in this server');
  }
  storePinMessage(messageId, false);
  publishNativeSnapshot();

  // P2P: broadcast unpin to scope members, durably queued for unreachable ones.
  broadcastPinState(channelId, messageId, false);
}

// ── Server / channel mutations ─────────────────────────────────────────────

export function nativeCreateServer(
  name: string,
  description?: string,
): XoreinRuntimeServer {
  const id = `srv-${uid()}`;
  const channelId = `${id}-general`;
  const server: XoreinRuntimeServer = {
    id,
    name,
    description,
    owner_peer_id: localPeerId(),
    created_at: nowISO(),
    updated_at: nowISO(),
    members: [localPeerId()],
    // Shared channel epoch root for channel E2EE — distributed to members over the
    // authenticated P2P join stream, never to the support node. Starts at epoch 0;
    // the owner bumps it on every membership change (join/kick/leave).
    crowd_root: freshCrowdRoot(),
    crowd_epoch: 0,
    channel_security_mode: 'tree',
    channel_crypto_profile: CHANNEL_CRYPTO_PROFILE,
    // Stable member-only capability for opaque, per-channel replica namespaces.
    // Kicks rotate Crowd keys (content access); this value merely locates
    // ciphertext and is owner-signed so a member cannot redirect the archive.
    replica_secret: freshCrowdRoot(),
    server_rev: 0,
    invite_generation: 1,
    // Secret for minting/verifying invite tokens (owner-only; never leaves device).
    invite_secret: freshCrowdRoot(),
    channels: {
      [channelId]: {
        id: channelId,
        server_id: id,
        name: 'general',
        voice: false,
        created_at: nowISO(),
      },
    },
    manifest: {
      name,
      description,
      capabilities: ['cap.chat', 'cap.manifest', 'cap.friends', 'cap.identity', 'cap.dm', 'cap.presence', 'cap.tree', 'cap.crowd', 'cap.channel-aad-v2', 'cap.mediashield'],
      security_mode: 'tree',
      history_coverage: 'local-window',
      history_retention_messages: 100,
      // A server is shared conversation space, so new members receive the same
      // bounded recent window that peers/nodes retain. The owner still controls
      // the policy and can lower this value; the channel epoch rotates on join, and only this
      // explicitly allowed window is re-encrypted for the new epoch.
      join_history_messages: 100,
    },
  };
  server.owner_proof = signServerRecord(server);
  addServer(server);
  publishNativeSnapshot();
  markStateDirty(); // re-sync account state to recovery guardians
  return server;
}

/**
 * Join a server by invite. A local placeholder is never accepted: membership,
 * owner authority, channels, and encryption roots must come from an authenticated
 * owner response over the P2P path.
 */
export function nativeJoinServer(
  rawDeeplink: string,
): XoreinRuntimeServer {
  const { serverId } = parseJoinDeepLink(rawDeeplink.trim());
  const existing = getState().servers[serverId];
  if (existing && getState().joined_server_ids.includes(serverId)) return existing;
  throw new Error('join requires an authenticated response from the server owner');
}

/**
 * Push a server's current structure (channels/members/manifest/name) to its other
 * members over the sync family so owner-side edits — new channels, renames,
 * deletions — actually appear for everyone, not just the owner. Owner-only: a
 * non-owner has no authority to rewrite a server others hold. The invite secret is
 * stripped; the channel epoch root is intentionally re-shared (members already hold it).
 */
export function broadcastServerUpdate(serverId: string): void {
  const current = getState().servers[serverId];
  if (!current || current.owner_peer_id !== localPeerId()) return;
  // Stamp a monotonically-increasing revision so receivers can reject out-of-order
  // (fire-and-forget) snapshots that would otherwise regress roles/membership.
  const nextRev = (typeof current.server_rev === 'number' ? current.server_rev : 0) + 1;
  const next: XoreinRuntimeServer = {
    ...current,
    server_rev: nextRev,
    channel_crypto_profile: CHANNEL_CRYPTO_PROFILE,
  };
  next.owner_proof = signServerRecord(next);
  updateServer(serverId, {
    server_rev: nextRev,
    channel_crypto_profile: CHANNEL_CRYPTO_PROFILE,
    ...(next.owner_proof ? { owner_proof: next.owner_proof } : {}),
  });
  const server = getState().servers[serverId];
  const members = (server.members ?? []).filter(m => m !== localPeerId());
  if (!members.length) return;
  const {
    invite_secret: _omit,
    admission_capability: _omitAdmission,
    member_since: _omitSince,
    ...serverForMembers
  } = server;
  void getPeerSync()?.broadcastToScope(members, PROTOCOLS.sync, 'sync.update', {
    server_id: serverId,
    server: serverForMembers,
  });
}

/**
 * Replicate an owner-preauthorized portable admission to the members that held
 * the prior epoch. The capability itself contains the encrypted next record;
 * each recipient opens and verifies it independently instead of trusting this
 * sender's copy of the server record or membership list.
 */
export function broadcastPortableAdmission(
  serverId: string,
  targetMemberIds: string[],
  admittedPeerId: string,
  capability: string,
): void {
  const me = localPeerId();
  const server = getState().servers[serverId];
  if (!server || !me || !server.members.includes(me)
    || !admittedPeerId || admittedPeerId.length > 256 || !capability) return;
  const targets = [...new Set(targetMemberIds)]
    .filter(peerId => peerId && peerId !== me && peerId !== admittedPeerId
      && server.members.includes(peerId));
  if (!targets.length) return;
  void getPeerSync()?.broadcastToScope(targets, PROTOCOLS.sync, 'sync.admit', {
    server_id: serverId,
    admitted_peer_id: admittedPeerId,
    invite_token: capability,
  });
}

export function nativeCreateChannel(
  serverId: string,
  name: string,
  voice = false,
): XoreinRuntimeChannel {
  const id = `${serverId}-${uid()}`;
  const channel: XoreinRuntimeChannel = {
    id,
    server_id: serverId,
    name,
    voice,
    created_at: nowISO(),
  };
  addChannel(serverId, channel);
  publishNativeSnapshot();
  broadcastServerUpdate(serverId);
  return channel;
}

export interface ChannelEditPatch {
  name?: string;
  topic?: string;
  bitrate?: number;
  user_limit?: number;
}

/** Edit a channel's name/topic/bitrate/user-limit. Local owner-authoritative write. */
export function nativeUpdateChannel(serverId: string, channelId: string, patch: ChannelEditPatch): void {
  storeUpdateChannel(serverId, channelId, patch);
  publishNativeSnapshot();
  broadcastServerUpdate(serverId);
}

/** Delete a channel (and any voice session scoped to it). */
export function nativeDeleteChannel(serverId: string, channelId: string): void {
  storeRemoveChannel(serverId, channelId);
  publishNativeSnapshot();
  broadcastServerUpdate(serverId);
}

export interface ServerMetaPatch {
  name?: string;
  description?: string;
}

/**
 * Edit a server's name/description (owner-authoritative). Mirrors the change into
 * the manifest (which the UI prefers for display) and broadcasts to members so the
 * rename/description shows up everywhere, not just for the owner.
 */
export function nativeUpdateServerMeta(serverId: string, patch: ServerMetaPatch): void {
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== localPeerId()) return; // owner-only
  const name = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : server.name;
  const description = patch.description !== undefined ? patch.description : server.description;
  updateServer(serverId, {
    name,
    description,
    updated_at: nowISO(),
    ...(server.manifest ? { manifest: { ...server.manifest, name, description } } : {}),
  });
  publishNativeSnapshot();
  broadcastServerUpdate(serverId);
}

/**
 * Owner kicks a member: drop them from the member list, rotate the channel epoch so
 * the kicked member's copy of the root is dead, tell that peer to forget the
 * server, and push the new server record (new root + epoch + member list) to
 * everyone else. The kicked peer is not in that broadcast, so it can decrypt no
 * message sent after the kick — real, cryptographic revocation.
 */
export function nativeRemoveMember(serverId: string, peerId: string): void {
  const me = localPeerId();
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== me) return; // owner-only
  if (!peerId || peerId === me) return; // owner can't kick self — use delete
  removeServerMember(serverId, peerId);
  // Revoke every bearer invite minted before this moderation decision. A kicked
  // client may still hold the admission capability it originally joined with;
  // without a generation/secret rotation its reconnect loop can present that
  // still-valid token and silently add itself back before sync.remove arrives.
  // Existing share links intentionally become invalid and the owner can mint a
  // fresh cohort after the kick.
  updateServer(serverId, {
    invite_secret: freshCrowdRoot(),
    invite_generation: (server.invite_generation ?? 0) + 1,
    admission_capability: undefined,
    updated_at: nowISO(),
  });
  // Rotate the channel epoch so the removed member's root no longer decrypts new
  // traffic. Remaining members receive the fresh root via broadcastServerUpdate.
  rotateChannelEpoch(serverId);
  publishNativeSnapshot();
  // Tell the kicked peer to drop the server from their rail.
  void getPeerSync()?.sendToPeer(peerId, PROTOCOLS.sync, 'sync.remove', { server_id: serverId });
  broadcastServerUpdate(serverId);
}

/**
 * Leave a server (member-side). The owner is notified so it removes us from the
 * member list and stops broadcasting to us; we forget the server locally. An owner
 * "leaving" their own server is a delete (an ownerless server can serve no one).
 */
export function nativeLeaveServer(serverId: string): void {
  const me = localPeerId();
  const server = getState().servers[serverId];
  if (!server) return;
  if (server.owner_peer_id === me) { nativeDeleteServer(serverId); return; }
  const owner = server.owner_peer_id;
  if (owner && owner !== 'pending-owner-sync') {
    void getPeerSync()?.sendToPeer(owner, PROTOCOLS.sync, 'sync.leave', { server_id: serverId });
  }
  removeServerMembership(serverId);
  publishNativeSnapshot();
  markStateDirty(); // re-sync account state to recovery guardians
}

/**
 * Delete a server (owner-only). Tells every member to forget it, then drops it
 * locally. Members apply the delete only when it genuinely comes from the owner.
 */
export function nativeDeleteServer(serverId: string): void {
  const me = localPeerId();
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== me) return; // owner-only
  const members = (server.members ?? []).filter(m => m !== me);
  if (members.length) {
    void getPeerSync()?.broadcastToScope(members, PROTOCOLS.sync, 'sync.delete', { server_id: serverId });
  }
  removeServerMembership(serverId);
  publishNativeSnapshot();
  markStateDirty(); // re-sync account state to recovery guardians
}

/**
 * Rotate a server's invite secret (owner-only). Invalidates every previously
 * minted invite link and returns the fresh secret so a new link can be built.
 */
/**
 * Mint the shareable invite deeplink for a server from the LIVE store record.
 * The token must be computed here: the published runtime snapshot strips
 * invite_secret (owner-only capability material), so UI layers can no longer
 * mint tokens from snapshot data. Returns null when this identity holds no
 * invite secret (non-owner, or invites revoked) — a token-less link would be
 * rejected by the owner anyway, so we fail closed instead of sharing a dud.
 */
export function nativeInviteLink(serverId: string): string | null {
  let server = getState().servers[serverId];
  const me = localPeerId();
  if (!server || !me) return null;
  const owner = server.owner_peer_id || me;
  if (!server.invite_secret) return null;
  // Ensure the snapshot carried by current members is portable even when this
  // server has not yet had a broadcast-worthy mutation.
  const proof = verifyServerRecord(server) ? server.owner_proof : signServerRecord(server);
  if (proof && server.owner_proof !== proof) {
    updateServer(serverId, { owner_proof: proof });
    server = getState().servers[serverId];
  }
  let portable = '';
  // Reuse a still-valid pending cohort so repeatedly opening the Share dialog
  // cannot mint competing next epochs. Any intervening structural owner update
  // changes the canonical record and makes this cached transition fail closed.
  if (server.admission_capability) {
    let cached = verifySignedInviteCapability(
      server.admission_capability,
      server.id,
      server.owner_peer_id,
      server.invite_generation ?? 0,
    );
    if (cached?.v === 3 && openForwardSecureInviteTransition(server, cached)) {
      portable = server.admission_capability;
    } else if ((server.invite_generation ?? 0) > 0) {
      cached = verifySignedInviteCapability(
        server.admission_capability,
        server.id,
        server.owner_peer_id,
        (server.invite_generation ?? 0) - 1,
      );
      if (cached?.v === 3 && isForwardSecureInviteTransitionRecord(server, cached)) {
        portable = server.admission_capability;
      }
    }
  }
  if (!portable && proof) {
    // A reusable bearer link has no globally enforceable one-use counter while
    // the network is partitioned. Pre-authorize Crowd for its admission cohort
    // so concurrent joiners can never push a Tree epoch beyond its 50-member
    // protocol ceiling. A later owner rotation can automatically re-enter Tree
    // once the converged roster is at or below the hysteresis threshold.
    const nextMode = 'crowd' as const;
    const next: XoreinRuntimeServer = {
      ...server,
      crowd_root: freshCrowdRoot(),
      crowd_epoch: (server.crowd_epoch ?? 0) + 1,
      server_rev: (server.server_rev ?? 0) + 1,
      invite_generation: (server.invite_generation ?? 0) + 1,
      updated_at: nowISO(),
      channel_security_mode: nextMode,
      channel_crypto_profile: CHANNEL_CRYPTO_PROFILE,
      ...(server.manifest ? {
        manifest: { ...server.manifest, security_mode: nextMode },
      } : {}),
    };
    portable = createForwardSecureInviteCapability(server, next);
    if (portable) updateServer(serverId, { admission_capability: portable });
  }
  const token = portable || computeInviteToken(server.invite_secret, serverId);
  return buildJoinDeepLink(
    serverId,
    owner,
    server.name,
    token,
    server.members.filter(member => member !== owner),
  );
}

export function nativeRotateInvite(serverId: string): string | null {
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== localPeerId()) return null;
  const secret = freshCrowdRoot();
  updateServer(serverId, {
    invite_secret: secret,
    invite_generation: (server.invite_generation ?? 0) + 1,
    admission_capability: undefined,
    updated_at: nowISO(),
  });
  broadcastServerUpdate(serverId);
  publishNativeSnapshot();
  return secret;
}

/**
 * Revoke invites entirely (owner-only): clears the invite secret so the server is
 * closed — verifyInviteToken fails for everyone until a new secret is minted.
 */
export function nativeRevokeInvite(serverId: string): void {
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== localPeerId()) return;
  updateServer(serverId, {
    invite_secret: undefined,
    invite_generation: (server.invite_generation ?? 0) + 1,
    admission_capability: undefined,
    updated_at: nowISO(),
  });
  broadcastServerUpdate(serverId);
  publishNativeSnapshot();
}

// ── Unread / read-state ──────────────────────────────────────────────────────

/** Mark a scope as the one being viewed (clears its unread). null = none focused. */
export function nativeSetActiveScope(scopeId: string | null): void {
  storeSetActiveScope(scopeId);
  publishNativeSnapshot();
}

/** Explicitly clear a scope's unread badge. */
export function nativeMarkScopeRead(scopeId: string): void {
  storeClearUnread(scopeId);
  publishNativeSnapshot();
}

/** Mark (or unmark) a peer's identity as verified after the user confirms the safety number. */
export function nativeSetPeerVerified(peerId: string, verified: boolean): void {
  setPeerVerified(peerId, verified);
  publishNativeSnapshot();
}

const MAX_OUTBOX_ATTEMPTS = 50;
// First-contact pending-seal entries retry until the recipient's prekey bundle becomes
// reachable, which can take far longer than an ordinary send (the peer may be offline for
// days). Bounding those by attempt count would expire them after only ~21 min of periodic
// drains, so they get a generous time-based retention instead — the message survives the
// wait and ships when the peer finally appears.
const PENDING_SEAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Queued abuse reports must survive an ordinary owner outage (overnight/weekend) rather than
// expiring after ~50 heartbeat drains (~21 min). Retain them by age, like pending_seal.
const REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Serialize drains: nativeDrainOutbox is triggered from several places (transport
// reconnect, the presence heartbeat, peer-presence changes). Two overlapping runs would
// both read the same queue snapshot and could re-encrypt/re-send the same pending_seal
// entry (double delivery). A single in-flight promise coalesces concurrent callers; a
// re-run flag makes one extra pass if new work was requested mid-drain, so nothing queued
// during a drain waits for the next heartbeat.
let drainInFlight: Promise<void> | null = null;
let drainRequestedAgain = false;

/**
 * Replay the durable outbound queue after the transport reconnects. For each queued
 * encrypted envelope, deliver it to its targets; any target still unreachable gets
 * the envelope deposited in its zero-knowledge mailbox. Entries are removed once
 * handled (delivered or mailboxed) and the originating message is marked sent. This
 * is what makes the "queued" delivery state honest — the message really does go out
 * on reconnect rather than being silently lost. Serialized so concurrent triggers
 * never double-process the same entry.
 */
export function nativeDrainOutbox(): Promise<void> {
  if (drainInFlight) {
    drainRequestedAgain = true;
    return drainInFlight;
  }
  drainInFlight = (async () => {
    try {
      do {
        drainRequestedAgain = false;
        await drainOutboxOnce();
      } while (drainRequestedAgain);
    } finally {
      drainInFlight = null;
    }
  })();
  return drainInFlight;
}

async function drainOutboxOnce(): Promise<void> {
  const sync = getPeerSync();
  if (!sync) return;
  const entries = [...getOutbox()];
  for (const entry of entries) {
    try {
      let allHandled = true;
      let channelReached = false;
      const channelEnvelope = entry.protocol === PROTOCOLS.chat
        && entry.operation === 'chat.send'
        && entry.payload.scope_type === 'channel';
      // First-contact pending-seal entry: no session existed at compose time. Now that
      // we're online, (re)attempt X3DH + encryption; if it still can't encrypt (bundle
      // not yet reachable), leave the entry for a later drain.
      let payload = entry.payload;
      if (entry.pending_seal) {
        const ps = entry.pending_seal;
        const sealed = await encryptDmEnvelope(ps.recipient, ps.base, ps.body, ps.media);
        if (!sealed) {
          // Still can't establish a session — keep the entry until it ages out (time-based,
          // not attempt-based, so a days-offline recipient's first-contact DM survives).
          const createdMs = Date.parse(entry.created_at);
          const tooOld = Number.isFinite(createdMs) && (Date.now() - createdMs) >= PENDING_SEAL_MAX_AGE_MS;
          if (tooOld) {
            removeOutbox(entry.id);
            if (entry.message_id) setMessageDeliveryStatus(entry.message_id, 'failed');
          } else {
            removeOutbox(entry.id);
            enqueueOutbox({ ...entry, attempts: entry.attempts + 1 });
          }
          continue;
        }
        payload = sealed;
      }
      for (const target of entry.targets) {
        const delivered = channelEnvelope
          ? await sync.sendToPeer(target, entry.protocol, entry.operation, payload)
          : await deliverRecipientOperation(
            target,
            entry.protocol,
            entry.operation,
            payload,
            `${entry.id}:${target}`,
            entry.operation === 'chat.send',
          );
        if (delivered) {
          if (channelEnvelope) channelReached = true;
        } else if (!channelEnvelope) allHandled = false;
      }
      if (channelEnvelope) {
        // A signed channel record needs one additional holder, not one private
        // mailbox copy per member. Offline/missed members restore from history.
        allHandled = channelReached;
      }
      if (allHandled) {
        removeOutbox(entry.id);
        if (entry.message_id) setMessageDeliveryStatus(entry.message_id, 'sent');
        if (entry.friend_request_id) setFriendRequestDeliveryStatus(entry.friend_request_id, 'sent');
      } else {
        // A queued abuse report (notify.push, kind:'report') has no message_id and must not
        // expire on the generic ~50-attempt cap (~21 min) — an ordinary owner outage would
        // lose it despite the reporter being promised a retry. Retain reports by AGE and, when
        // they finally age out, flag the stored report record so the failure is surfaced.
        const reportKind = (entry.payload as { kind?: string } | undefined)?.kind === 'report';
        const reportId = reportKind ? (entry.payload as { report_id?: string }).report_id : undefined;
        const createdMs = Date.parse(entry.created_at);
        const ageMs = Number.isFinite(createdMs) ? Date.now() - createdMs : 0;
        const expired = reportKind
          ? ageMs >= REPORT_MAX_AGE_MS
          : entry.attempts + 1 >= MAX_OUTBOX_ATTEMPTS;
        if (expired) {
          // Give up so the queue can't wedge forever.
          removeOutbox(entry.id);
          if (entry.message_id) setMessageDeliveryStatus(entry.message_id, 'failed');
          if (entry.friend_request_id) setFriendRequestDeliveryStatus(entry.friend_request_id, 'failed');
          if (reportId) setReportDelivery(reportId, 'failed');
        } else {
          // Re-enqueue with a bumped attempt count (remove + add keeps it deduped).
          removeOutbox(entry.id);
          enqueueOutbox({ ...entry, attempts: entry.attempts + 1 });
        }
      }
    } catch {
      /* transient — leave the entry for the next drain */
    }
  }
  publishNativeSnapshot();
}

export interface ReportInput {
  targetKind: 'message' | 'user';
  targetId: string;
  reportedPeerId?: string;
  serverId?: string;
  channelId?: string;
  contentExcerpt?: string;
  reason: string;
  details?: string;
}

/**
 * Submit an abuse report. A local copy is always kept. When the report concerns a
 * server, it is delivered P2P to that server's OWNER (the moderator who can act) via
 * notify.push — the owner already has access to that server's content, so sharing a
 * short excerpt with them leaks nothing new. DM reports stay local (no owner exists;
 * the Community Guidelines route serious/illegal matters to the operator contact).
 */
export function nativeSubmitReport(input: ReportInput): XoreinReport {
  const report: XoreinReport = {
    id: uid(),
    reason: input.reason,
    details: input.details,
    target_kind: input.targetKind,
    target_id: input.targetId,
    reported_peer_id: input.reportedPeerId,
    server_id: input.serverId,
    channel_id: input.channelId,
    content_excerpt: input.contentExcerpt ? input.contentExcerpt.slice(0, 280) : undefined,
    reporter_peer_id: localPeerId(),
    created_at: nowISO(),
  };
  addReport(report);
  publishNativeSnapshot();

  if (input.serverId) {
    const server = getState().servers[input.serverId];
    const owner = server?.owner_peer_id;
    if (owner && owner !== localPeerId()) {
      const payload = {
        kind: 'report',
        report_id: report.id,
        reason: report.reason,
        details: report.details ?? '',
        target_kind: report.target_kind,
        target_id: report.target_id,
        reported_peer_id: report.reported_peer_id ?? '',
        server_id: report.server_id,
        channel_id: report.channel_id ?? '',
        content_excerpt: report.content_excerpt ?? '',
      };
      void (async () => {
        const delivered = await deliverRecipientOperation(
          owner,
          PROTOCOLS.notify,
          'notify.push',
          payload,
          report.id,
        );
        if (!delivered) {
          // Owner offline / transport down: durably queue the report so it reaches the
          // moderator on a future topology change instead of silently losing it.
          enqueueOutbox({ id: uid(), targets: [owner], protocol: PROTOCOLS.notify, operation: 'notify.push', payload, created_at: nowISO(), attempts: 0 });
        }
      })();
    }
  }
  return report;
}

/**
 * Owner-side moderation action: mark a received report resolved/dismissed (or reopen it).
 * Only meaningful on the server owner's copy (the moderation inbox); local state only.
 */
export function nativeResolveReport(reportId: string, resolved = true): void {
  setReportResolved(reportId, resolved);
  publishNativeSnapshot();
}

// ── Friends ────────────────────────────────────────────────────────────────

/** Extract the bare peer id from either a raw peer id or a dialable multiaddr. */
function peerIdFromAddr(peerAddr: string): string {
  const trimmed = peerAddr.trim();
  if (trimmed.includes('/p2p/')) return trimmed.split('/p2p/').pop() ?? trimmed;
  return trimmed;
}

export async function nativeAddFriendRequest(peerAddr: string): Promise<XoreinFriendRecord> {
  const targetPeerId = peerIdFromAddr(peerAddr);
  const record: XoreinFriendRecord = {
    id: uid(),
    from_peer_id: localPeerId(),
    to_peer_id: targetPeerId,
    to_peer_addr: peerAddr,
    status: 'pending',
    delivery_status: 'pending',
    created_at: nowISO(),
  };
  addFriendRequest(record);
  publishNativeSnapshot();
  // P2P: deliver the request to the target so it lands in their Pending tab.
  // If they gave a full multiaddr, register it so we dial the right circuit.
  const sync = getPeerSync();
  if (peerAddr.includes('/p2p-circuit')) sync?.registerPeer(targetPeerId, peerAddr);
  const payload = {
    kind: 'request',
    id: record.id,
    from_peer_id: localPeerId(),
    display_name: getState().identity?.profile?.display_name,
  };
  // A first-contact request must not wait behind a silent direct destination.
  // Race live/routed delivery with replicated peer custody. Either remote
  // acknowledgement means the request has left this device and is "sent".
  const delivered = await deliverRecipientOperation(
    targetPeerId,
    PROTOCOLS.friends,
    'friends.request',
    payload,
    record.id,
  );
  if (delivered) {
    setFriendRequestDeliveryStatus(record.id, 'sent');
  } else {
    // A friend request is a durable relationship operation, not a best-effort
    // notification. The recipient-addressed inbox lets a first-contact target
    // recover it without already knowing our pairwise mailbox token. If no
    // storage peer answered, retain it in the encrypted local outbox.
    setFriendRequestDeliveryStatus(record.id, 'queued');
    enqueueOutbox({
      id: uid(),
      targets: [targetPeerId],
      protocol: PROTOCOLS.friends,
      operation: 'friends.request',
      payload,
      friend_request_id: record.id,
      created_at: nowISO(),
      attempts: 0,
    });
  }
  publishNativeSnapshot();
  return { ...record, delivery_status: delivered ? 'sent' : 'queued' };
}

export function nativeAcceptFriend(requestId: string): void {
  const req = getState().friend_requests.find(r => r.id === requestId);
  acceptFriend(requestId);
  publishNativeSnapshot();
  // Tell the original requester we accepted so their outgoing pending flips to an
  // accepted friend on their side too.
  if (req) {
    const me = localPeerId();
    const requesterPeerId = req.from_peer_id === me ? (req.to_peer_id ?? req.to_peer_addr) : req.from_peer_id;
    if (requesterPeerId) {
      const payload = {
        kind: 'accept',
        id: req.id,
        from_peer_id: me,
        display_name: getState().identity?.profile?.display_name,
      };
      // DURABLE delivery: a one-shot fire-and-forget send here was the P0 — if the
      // first dial to the requester failed (cold circuit, requester briefly offline),
      // the accept was lost forever while our presence heartbeat kept reaching them,
      // leaving their outgoing request stuck on PENDING. Queue the accept in the
      // durable outbox on failure so the drain (reconnect + 25s heartbeat) retries it
      // until the requester's node acknowledges.
      void (async () => {
        const delivered = await deliverRecipientOperation(
          requesterPeerId,
          PROTOCOLS.friends,
          'friends.accept',
          payload,
          `accept:${req.id}`,
        );
        if (!delivered) {
          enqueueOutbox({
            id: uid(),
            targets: [requesterPeerId],
            protocol: PROTOCOLS.friends,
            operation: 'friends.accept',
            payload,
            created_at: nowISO(),
            attempts: 0,
          });
        }
      })();
    }
  }
  // Let the new friend see us online immediately rather than after the heartbeat.
  nativeAnnouncePresence();
}

/** Decline/cancel a pending friend request locally (no friendship recorded). */
export function nativeDeclineFriend(requestId: string): void {
  removeFriendRequest(requestId);
  publishNativeSnapshot();
}

// ── Voice ──────────────────────────────────────────────────────────────────

export function nativeJoinVoice(channelId: string): void {
  joinVoice(channelId, localPeerId());
  publishNativeSnapshot();
}

export function nativeLeaveVoice(channelId: string): void {
  leaveVoice(channelId, localPeerId());
  publishNativeSnapshot();
}

// ── Relays ─────────────────────────────────────────────────────────────────

export function nativeAddRelay(multiaddr: string): void {
  if (!isTrustedRelayMultiaddr(multiaddr)) {
    throw new Error('Relay multiaddr must identify a pinned relay over WSS or loopback WS.');
  }
  addRelay(multiaddr);
  // Persist as a real backup relay: the multi-relay failover list picks it up on
  // the next (re)connect, so "Add relay" is functional, not cosmetic (resil-1).
  addRelayOverride(multiaddr);
  publishNativeSnapshot();
}

export function nativeRemoveRelay(multiaddr: string): void {
  removeRelay(multiaddr);
  removeRelayOverride(multiaddr);
  publishNativeSnapshot();
}

// ── Presence ───────────────────────────────────────────────────────────────

/**
 * Everyone who should see our presence: all server co-members plus all accepted
 * friends (a friend you share no server with still belongs here — otherwise they'd
 * always look offline). Excludes self.
 */
function presenceTargets(): string[] {
  const me = localPeerId();
  const set = new Set<string>();
  const st = getState();
  for (const server of Object.values(st.servers)) {
    for (const m of server.members ?? []) set.add(m);
  }
  for (const f of st.friends ?? []) {
    const pid = f.from_peer_id === me ? (f.to_peer_id ?? f.to_peer_addr) : f.from_peer_id;
    if (pid) set.add(pid);
  }
  set.delete(me);
  return Array.from(set);
}

export function nativeUpdatePresence(
  status: string,
  opts: { status_text?: string; typing_in_scope?: string } = {},
): void {
  const peerId = localPeerId();
  updatePresenceEntry(peerId, {
    status,
    status_text: opts.status_text,
    typing_in_scope: opts.typing_in_scope,
    updated_at: nowISO(),
  });
  publishNativeSnapshot();

  // P2P: broadcast presence (status + status_text) and optional typing indicator
  // to all server co-members AND accepted friends.
  const targets = presenceTargets();
  if (targets.length) {
    const isTyping = opts.typing_in_scope != null;
    getPeerSync()?.broadcastTyping({
      memberPeerIds: targets,
      peerId,
      scopeId: opts.typing_in_scope ?? '',
      isTyping,
      status,
      status_text: opts.status_text,
    }).catch(() => { /* non-fatal */ });
  }
}

// ── Typing producer ────────────────────────────────────────────────────────
// The composer calls nativeNotifyTyping(scopeId) on every keystroke; this layer
// debounces the network side so peers see "is typing" without a broadcast per
// keypress: at most one presence broadcast per TYPING_REBROADCAST_MS while the
// user keeps typing, and an automatic stop-typing broadcast after
// TYPING_IDLE_STOP_MS of inactivity (or an explicit nativeStopTyping on send).
const TYPING_REBROADCAST_MS = 2_500;
const TYPING_IDLE_STOP_MS = 4_000;
let _typingScope: string | null = null;
let _typingLastSentAt = 0;
let _typingStopTimer: ReturnType<typeof setTimeout> | null = null;

/** Broadcast presence carrying the given typing scope, preserving status/status_text. */
function broadcastTypingState(typingInScope: string | undefined): void {
  const me = localPeerId();
  const own = getState().presence?.[me];
  nativeUpdatePresence(own?.status ?? 'online', {
    status_text: own?.status_text,
    ...(typingInScope ? { typing_in_scope: typingInScope } : {}),
  });
}

/**
 * Report that the local user is composing in `scopeId` (channel or DM id).
 * Debounced: safe to call once per keystroke. Publishes typing presence to all
 * co-members/friends and schedules the stop-typing broadcast automatically.
 */
export function nativeNotifyTyping(scopeId: string): void {
  if (!scopeId || !localPeerId()) return;
  if (_typingStopTimer) clearTimeout(_typingStopTimer);
  _typingStopTimer = setTimeout(() => {
    _typingStopTimer = null;
    nativeStopTyping();
  }, TYPING_IDLE_STOP_MS);
  const now = Date.now();
  if (_typingScope === scopeId && now - _typingLastSentAt < TYPING_REBROADCAST_MS) return;
  _typingScope = scopeId;
  _typingLastSentAt = now;
  broadcastTypingState(scopeId);
}

/**
 * Report that the local user stopped composing (message sent, composer cleared,
 * or idle timeout). Broadcasts a presence update with the typing flag cleared.
 * Idempotent — a no-op when we never announced typing.
 */
export function nativeStopTyping(): void {
  if (_typingStopTimer) {
    clearTimeout(_typingStopTimer);
    _typingStopTimer = null;
  }
  if (_typingScope == null) return;
  _typingScope = null;
  _typingLastSentAt = 0;
  const me = localPeerId();
  if (!me) return;
  // The LOCAL indicator clears immediately (riding the coalesced publish)…
  const own = getState().presence?.[me];
  updatePresenceEntry(me, {
    status: own?.status ?? 'online',
    status_text: own?.status_text,
    typing_in_scope: undefined,
    updated_at: nowISO(),
  });
  schedulePublishNativeSnapshot();
  // …but the WIRE broadcast is deferred one macrotask. The common trigger is a
  // message send, where this used to put a presence.update on the wire AHEAD of
  // the chat envelope — receivers paid the presence handling before the message
  // could even arrive. Receivers also clear typing implicitly when the message
  // lands (inbound handleChatSend), so the deferral only matters for the
  // composer-cleared-without-send case, where a tick is imperceptible.
  setTimeout(() => {
    if (_typingScope != null) return; // user resumed typing meanwhile
    broadcastTypingState(undefined);
  }, 0);
}

/**
 * Announce we're online to all co-members and friends. Called on connect and on a
 * light heartbeat so peers who came online after us (or on another relay) still
 * learn we're here — without this, a freshly-connected peer shows all its friends
 * as offline until someone happens to type.
 */
export function nativeAnnouncePresence(): void {
  const peerId = localPeerId();
  if (!peerId) return;
  const st = getState();
  const existing = st.presence?.[peerId];
  const status = existing?.status ?? 'online';
  // Refresh our own presence entry so updated_at stays current on each heartbeat.
  updatePresenceEntry(peerId, {
    status,
    status_text: existing?.status_text,
    typing_in_scope: existing?.typing_in_scope,
    updated_at: nowISO(),
  });
  publishNativeSnapshot();
  const targets = presenceTargets();
  if (!targets.length) return;
  getPeerSync()?.broadcastTyping({
    memberPeerIds: targets,
    peerId,
    scopeId: '',
    isTyping: false,
    status,
    status_text: existing?.status_text,
  }).catch(() => { /* non-fatal */ });
}

function getScopeMembers(scopeId: string, scopeType: string, serverId?: string): string[] {
  const state = getState();
  if (scopeType === 'dm') {
    return state.dms[scopeId]?.participants ?? [];
  }
  return serverId ? (state.servers[serverId]?.members ?? []) : [];
}

// ── DM ─────────────────────────────────────────────────────────────────────

export function nativeEnsureDm(dmId: string, participants: string[]): void {
  ensureDm(dmId, participants);
  publishNativeSnapshot();
}

/**
 * Deterministic 1:1 DM thread id for a pair of peers (order-independent), so both
 * sides converge on the same conversation id without a round-trip.
 */
export function dmIdForPeers(a: string, b: string): string {
  return `dm-${[a, b].sort().join('__')}`;
}

/**
 * Ensure (create if missing) the 1:1 DM thread with `peerId` and return its id.
 * Used when opening a DM from the friends list — previously opening a DM that had
 * no prior thread failed with "no direct-message thread exists".
 */
export function nativeEnsureDirectMessage(peerId: string): string {
  const me = localPeerId();
  const dmId = dmIdForPeers(me, peerId);
  ensureDm(dmId, [me, peerId]);
  publishNativeSnapshot();
  return dmId;
}

// ── Roles (Goal 7) ─────────────────────────────────────────────────────────

/**
 * Create a server role (owner-only). Stored in the server record and broadcast
 * to members via sync.update so roles propagate P2P.
 */
export function nativeCreateRole(serverId: string, name: string, permissions: string[] = [], color?: string): ServerRole {
  const me = localPeerId();
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== me) throw new Error('Only the server owner can create roles.');
  const role: ServerRole = {
    id: `role-${uid()}`,
    name,
    color: color ?? '#13DDEC',
    permissions,
    protected: false,
  };
  addServerRole(serverId, role);
  publishNativeSnapshot();
  broadcastServerUpdate(serverId);
  return role;
}

/**
 * Rename/recolor a server role or change its permissions (owner-only). Patches the
 * role in the server record and broadcasts the updated server to all members.
 */
export function nativeUpdateRole(serverId: string, roleId: string, patch: { name?: string; color?: string; permissions?: string[] }): void {
  const me = localPeerId();
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== me) return;
  const role = (server.roles ?? []).find(r => r.id === roleId);
  if (!role || role.protected) return; // can't rename built-in roles
  updateServerRole(serverId, roleId, patch);
  publishNativeSnapshot();
  broadcastServerUpdate(serverId);
}

/**
 * Delete a server role (owner-only). Also strips that role from all member_roles.
 */
export function nativeDeleteRole(serverId: string, roleId: string): void {
  const me = localPeerId();
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== me) return;
  const role = (server.roles ?? []).find(r => r.id === roleId);
  if (role?.protected) return; // can't delete built-in roles
  removeServerRole(serverId, roleId);
  publishNativeSnapshot();
  broadcastServerUpdate(serverId);
}

/**
 * Assign/unassign a role to/from a member (owner-only). Toggle: if the member
 * already has this role it is removed; otherwise it is added.
 */
export function nativeAssignRole(serverId: string, peerId: string, roleId: string): void {
  const me = localPeerId();
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== me) return;
  const current = (server.member_roles ?? {})[peerId] ?? [];
  const next = current.includes(roleId)
    ? current.filter(r => r !== roleId)
    : [...current, roleId];
  setMemberRoles(serverId, peerId, next);
  publishNativeSnapshot();
  broadcastServerUpdate(serverId);
}

// ── Search (Goal 9) ────────────────────────────────────────────────────────

interface NativeSearchQuery {
  query?: string;
  scope_type?: 'channel' | 'dm';
  scope_id?: string;
  server_id?: string;
  sender_peer_id?: string;
  before?: string;
  after?: string;
  limit?: number;
}

/**
 * Full-text search over locally-stored native messages. Runs entirely in-memory
 * against the native store — no support-node round-trip required. Case-insensitive
 * substring match against the message body. Deleted messages are excluded.
 */
export function nativeSearchMessages(query: NativeSearchQuery): { messages: string[]; results: XoreinRuntimeMessage[] } {
  const q = (query.query ?? '').toLowerCase().trim();
  const limit = typeof query.limit === 'number' && query.limit > 0 ? query.limit : 50;
  const results = getState().messages.filter(m => {
    if (m.deleted) return false;
    if (query.scope_type && m.scope_type !== query.scope_type) return false;
    if (query.scope_id && m.scope_id !== query.scope_id) return false;
    if (query.server_id && m.server_id !== query.server_id) return false;
    if (query.sender_peer_id && m.sender_peer_id !== query.sender_peer_id) return false;
    if (query.before && m.created_at && m.created_at >= query.before) return false;
    if (query.after && m.created_at && m.created_at <= query.after) return false;
    if (q && !m.body.toLowerCase().includes(q)) return false;
    return true;
  }).slice(0, limit);
  return { messages: results.map(m => m.id), results };
}

// ── Polls (Goal 9) ─────────────────────────────────────────────────────────

/**
 * Cast a poll vote on a message. Broadcast to all scope members via notify.push
 * so votes are aggregated P2P. Idempotent — duplicate votes from the same peer
 * are silently ignored at the store level.
 */
export function nativeCastPollVote(messageId: string, optionIndex: number): void {
  const peerId = localPeerId();
  const isNew = addPollVote(messageId, optionIndex, peerId);
  if (!isNew) return; // already voted
  publishNativeSnapshot();

  const msg = getState().messages.find(m => m.id === messageId);
  if (!msg) return;
  const scopeMembers = getScopeMembers(msg.scope_id, msg.scope_type, msg.server_id);
  const targets = scopeMembers.filter(m => m !== peerId);
  if (targets.length === 0) return;
  // Best-effort broadcast, then DURABLY queue the vote for any member that was offline
  // (see broadcastNotifyDurable — poll results are never otherwise reconciled).
  broadcastNotifyDurable(targets, {
    kind: 'poll_vote',
    message_id: messageId,
    option_index: optionIndex,
    from_peer_id: peerId,
  });
}
