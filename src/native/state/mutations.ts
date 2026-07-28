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
  addServer, addChannel, updateChannel as storeUpdateChannel, removeChannel as storeRemoveChannel, recordServerMembership,
  updateServer, removeServerMembership, removeServerMember,
  setActiveScope as storeSetActiveScope, clearUnread as storeClearUnread,
  ensureDm,
  addFriendRequest, acceptFriend, removeFriendRequest,
  joinVoice, leaveVoice,
  addRelay, removeRelay,
  updatePresenceEntry,
  addServerRole, updateServerRole, removeServerRole, setMemberRoles, addPollVote,
  memberHasPermission, setPeerVerified, addReport,
  enqueueOutbox, removeOutbox, getOutbox,
} from './store.js';
import type { XoreinReport } from '../../types.js';
import { publishNativeSnapshot } from './snapshot.js';
import { markStateDirty } from './stateSync.js';
import type { NativeState } from './store.js';
import { getState } from './store.js';
import { getPeerSync } from '../sync/registry.js';
import { rekeyVoiceForServer } from '../voice/registry.js';
import { encryptChannelEnvelope, encryptDmEnvelope, channelSecurityMode, applyCrowdRoot } from '../sync/secureEnvelope.js';
import { depositOfflineChat } from '../delivery/offline.js';
import { addRelayOverride, removeRelayOverride } from '../transport/relays.js';
import { PROTOCOLS } from '../families/families.js';
import { parseJoinDeepLink } from '../../protocol/deeplink.js';

/** Generate a fresh base64 32-byte Crowd epoch root for a new server. */
function freshCrowdRoot(): string {
  const r = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < r.length; i++) s += String.fromCharCode(r[i]);
  return btoa(s);
}

/**
 * Owner-only: rotate a server's Crowd epoch — mint a fresh random root, bump the
 * epoch number, and install both into the live crypto so we immediately encrypt at
 * the new epoch. The caller is responsible for broadcasting the updated server
 * record to remaining members (broadcastServerUpdate) so they install the same
 * (root, epoch); anyone NOT in that broadcast (a kicked member) is thereby locked
 * out of all future channel traffic. Returns true when a rotation happened.
 */
export function rotateCrowdEpoch(serverId: string): boolean {
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== localPeerId()) return false;
  if (!server.crowd_root) return false; // no channel key to rotate
  const nextEpoch = (server.crowd_epoch ?? 0) + 1;
  updateServer(serverId, { crowd_root: freshCrowdRoot(), crowd_epoch: nextEpoch });
  applyCrowdRoot(serverId); // encrypt under the new epoch from now on
  // Rekey the owner's own active voice call on this server so its SFrame keys track the
  // new root and any just-removed member's live connection is torn down.
  rekeyVoiceForServer(serverId);
  return true;
}

function localPeerId(): string {
  return getState().identity?.peer_id ?? 'local';
}

function nowISO(): string {
  return new Date().toISOString();
}

function uid(): string {
  return crypto.randomUUID();
}

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
    ...opts,
  };
  addMessage(msg);
  publishNativeSnapshot();

  // P2P: broadcast a CROWD-ENCRYPTED envelope to all server members. The shared
  // epoch root is held locally and never sent to the support node, so the relay
  // only ever sees ciphertext. If no root is seeded yet (e.g. an owner-pending
  // placeholder join) the message stays local — we never transmit plaintext.
  const members = server?.members ?? [];
  if (members.length > 1 && server) {
    const base = {
      message_id: msg.id,
      scope_id: channelId,
      scope_type: 'channel',
      server_id: server.id,
      sender_id: msg.sender_peer_id,
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
        // Offline members get the same encrypted envelope via their zero-knowledge
        // mailbox (resil-2); each deposit is sealed under a pairwise secret. If BOTH
        // direct delivery and the mailbox deposit fail for a peer, durably queue the
        // envelope for that peer so reconnect replays it — a real outage never nulls
        // `sync`, so relying on the `!sync` branch alone would silently drop it.
        const stillFailed: string[] = [];
        for (const peerId of undelivered) {
          const deposited = await depositOfflineChat(peerId, envelope).catch(() => false);
          if (!deposited) stillFailed.push(peerId);
        }
        if (stillFailed.length) {
          enqueueOutbox({ id: uid(), targets: stillFailed, protocol: PROTOCOLS.chat, operation: 'chat.send', payload: envelope, message_id: msgId, created_at: nowISO(), attempts: 0 });
        }
        // Delivery status: sent if at least one peer got it directly OR was mailboxed;
        // offline_queued only when nothing reached anyone (everything durably queued).
        const allTargets = members.filter(m => m !== msg.sender_peer_id);
        const reachedSomeone = allTargets.length === 0
          || allTargets.length > undelivered.length
          || undelivered.length > stillFailed.length;
        setMessageDeliveryStatus(msgId, reachedSomeone ? 'sent' : 'offline_queued');
        publishNativeSnapshot();
      })();
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
  publishNativeSnapshot();

  // P2P: deliver a SEAL-ENCRYPTED (X3DH + Double Ratchet) envelope to each other
  // DM participant. Each recipient gets its own ratchet ciphertext; if a session
  // cannot be established (peer unreachable) the message stays local and is not
  // transmitted in plaintext.
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
        const delivered = await sync.sendToPeer(peerId, PROTOCOLS.chat, 'chat.send', envelope);
        if (delivered) {
          anyDelivered = true;
        } else {
          // Offline fallback: deposit the encrypted envelope in the zero-knowledge
          // mailbox so the recipient pulls it on reconnect (resil-2). If BOTH the direct
          // send AND the mailbox deposit fail, durably queue it — don't claim "queued"
          // with nothing actually persisted to retry.
          const deposited = await depositOfflineChat(peerId, envelope).catch(() => false);
          if (!deposited) {
            enqueueOutbox({ id: uid(), targets: [peerId], protocol: PROTOCOLS.chat, operation: 'chat.send', payload: envelope, message_id: msgId, created_at: nowISO(), attempts: 0 });
          }
          anyQueued = true;
        }
      }
      const status = anyDelivered ? 'sent' : anyQueued ? 'offline_queued' : 'sent';
      setMessageDeliveryStatus(msgId, status);
      publishNativeSnapshot();
    })();
  } else {
    // No other participants (solo or just us): mark sent locally.
    setMessageDeliveryStatus(msg.id, 'sent');
    publishNativeSnapshot();
  }
  return msg;
}

export function nativeEditMessage(messageId: string, body: string): void {
  storeEditMessage(messageId, body);
  publishNativeSnapshot();

  // P2P: broadcast the edit (crowd-encrypted for channels, plaintext-base for DMs
  // until seal-encrypted edit envelopes are implemented).
  const msg = getState().messages.find(m => m.id === messageId);
  if (!msg) return;
  const scopeMembers = getScopeMembers(msg.scope_id, msg.scope_type, msg.server_id);
  if (scopeMembers.length <= 1) return;

  const base = {
    message_id: messageId,
    scope_id: msg.scope_id,
    scope_type: msg.scope_type,
    server_id: msg.server_id,
    sender_id: localPeerId(),
    edited_at: nowISO(),
  };

  if (msg.scope_type === 'channel' && msg.server_id) {
    // Crowd-encrypt the edit payload — inbound handler decrypts before applying.
    // FAIL-CLOSED: if there's no crowd root yet we do NOT fall back to a plaintext
    // edit. The inbound edit handler rejects any edit lacking the scope's required
    // encrypted envelope, so a plaintext broadcast would be silently discarded by
    // every recipient (diverging the conversation) AND put cleartext on the wire —
    // pure downside. The edit stays local until it can be encrypted.
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
  storeDeleteMessage(messageId);
  publishNativeSnapshot();

  // P2P: broadcast the deletion (tombstone) so the message disappears for all.
  const msg = getState().messages.find(m => m.id === messageId);
  if (msg) {
    const scopeMembers = getScopeMembers(msg.scope_id, msg.scope_type, msg.server_id);
    if (scopeMembers.length > 1) {
      void getPeerSync()?.broadcastToScope(scopeMembers, PROTOCOLS.chat, 'chat.delete', {
        message_id: messageId,
        scope_id: msg.scope_id,
        scope_type: msg.scope_type,
        server_id: msg.server_id,
        sender_id: localPeerId(),
        deleted_at: nowISO(),
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

  // P2P: broadcast pin to scope members.
  const msg = getState().messages.find(m => m.id === messageId);
  if (msg) {
    const scopeMembers = getScopeMembers(channelId, 'channel', msg.server_id);
    if (scopeMembers.length > 1) {
      void getPeerSync()?.broadcastToScope(scopeMembers, PROTOCOLS.notify, 'notify.push', {
        kind: 'pin',
        channel_id: channelId,
        message_id: messageId,
        pinned: true,
        from_peer_id: localPeerId(),
      });
    }
  }
}

export function nativeUnpinMessage(channelId: string, messageId: string): void {
  const target = getState().messages.find(m => m.id === messageId);
  if (target?.server_id && !memberHasPermission(target.server_id, localPeerId(), 'MANAGE_MESSAGES')) {
    throw new Error('not authorized to unpin messages in this server');
  }
  storePinMessage(messageId, false);
  publishNativeSnapshot();

  // P2P: broadcast unpin to scope members.
  const msg = getState().messages.find(m => m.id === messageId);
  if (msg) {
    const scopeMembers = getScopeMembers(channelId, 'channel', msg.server_id);
    if (scopeMembers.length > 1) {
      void getPeerSync()?.broadcastToScope(scopeMembers, PROTOCOLS.notify, 'notify.push', {
        kind: 'pin',
        channel_id: channelId,
        message_id: messageId,
        pinned: false,
        from_peer_id: localPeerId(),
      });
    }
  }
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
    // Shared Crowd epoch root for channel E2EE — distributed to members over the
    // authenticated P2P join stream, never to the support node. Starts at epoch 0;
    // the owner bumps it on every membership change (join/kick/leave).
    crowd_root: freshCrowdRoot(),
    crowd_epoch: 0,
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
      capabilities: ['cap.chat', 'cap.manifest', 'cap.friends', 'cap.identity', 'cap.dm', 'cap.presence'],
      history_coverage: 'local-window',
      history_retention_messages: 100,
    },
  };
  addServer(server);
  publishNativeSnapshot();
  markStateDirty(); // re-sync account state to recovery guardians
  return server;
}

/**
 * Join a server by invite. Records membership locally so the server appears for
 * this identity (read-only until the full manifest/channels arrive over P2P).
 *
 * NOTE: fetching the authoritative manifest (name, owner, channels) from the
 * server owner via rendezvous is the remaining P2P piece; `preview` lets the
 * caller seed name/owner from the support node's discovery in the meantime.
 */
export function nativeJoinServer(
  rawDeeplink: string,
  preview?: { name?: string; ownerPeerId?: string },
): XoreinRuntimeServer {
  const { serverId } = parseJoinDeepLink(rawDeeplink.trim());
  const me = localPeerId();
  const existing = getState().servers[serverId];
  const base: XoreinRuntimeServer = existing ?? {
    id: serverId,
    name: preview?.name?.trim() || serverId,
    // Never claim ownership for the joiner — that would grant them false
    // owner/admin/moderation affordances. Use the discovered owner if known,
    // otherwise a non-self placeholder until the authoritative manifest syncs.
    owner_peer_id: preview?.ownerPeerId?.trim() || 'pending-owner-sync',
    members: [],
    channels: {},
    created_at: nowISO(),
    updated_at: nowISO(),
  };
  const members = Array.from(new Set([...(base.members ?? []), me]));
  const joined: XoreinRuntimeServer = { ...base, members };
  addServer(joined);
  recordServerMembership(serverId);
  publishNativeSnapshot();
  markStateDirty(); // re-sync account state to recovery guardians
  return joined;
}

/**
 * Push a server's current structure (channels/members/manifest/name) to its other
 * members over the sync family so owner-side edits — new channels, renames,
 * deletions — actually appear for everyone, not just the owner. Owner-only: a
 * non-owner has no authority to rewrite a server others hold. The invite secret is
 * stripped; crowd_root is intentionally re-shared (members already hold it).
 */
export function broadcastServerUpdate(serverId: string): void {
  const current = getState().servers[serverId];
  if (!current || current.owner_peer_id !== localPeerId()) return;
  const members = (current.members ?? []).filter(m => m !== localPeerId());
  if (!members.length) return;
  // Stamp a monotonically-increasing revision so receivers can reject out-of-order
  // (fire-and-forget) snapshots that would otherwise regress roles/membership.
  const nextRev = (typeof current.server_rev === 'number' ? current.server_rev : 0) + 1;
  updateServer(serverId, { server_rev: nextRev });
  const server = getState().servers[serverId];
  const { invite_secret: _omit, member_since: _omitSince, ...serverForMembers } = server;
  void getPeerSync()?.broadcastToScope(members, PROTOCOLS.sync, 'sync.update', {
    server_id: serverId,
    server: serverForMembers,
  });
}

export function nativeCreateChannel(
  serverId: string,
  name: string,
  voice = false,
): XoreinRuntimeChannel {
  const id = `${serverId}-${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
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
 * Owner kicks a member: drop them from the member list, ROTATE the Crowd epoch so
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
  // Rotate the channel epoch so the removed member's root no longer decrypts new
  // traffic. Remaining members receive the fresh root via broadcastServerUpdate.
  rotateCrowdEpoch(serverId);
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
export function nativeRotateInvite(serverId: string): string | null {
  const server = getState().servers[serverId];
  if (!server || server.owner_peer_id !== localPeerId()) return null;
  const secret = freshCrowdRoot();
  updateServer(serverId, { invite_secret: secret, updated_at: nowISO() });
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
  updateServer(serverId, { invite_secret: undefined, updated_at: nowISO() });
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
        const delivered = await sync.sendToPeer(target, entry.protocol, entry.operation, payload);
        if (!delivered) {
          // Still unreachable → hand off to the recipient's offline mailbox so they
          // pull it when they reconnect. Only the chat family is mailbox-eligible.
          // depositOfflineChat reports ordinary failures by RETURNING false (it does not
          // throw), so honor the boolean — otherwise the entry would be dropped and the
          // message marked sent with nothing actually delivered or stored.
          if (entry.operation === 'chat.send') {
            const deposited = await depositOfflineChat(target, payload).catch(() => false);
            if (!deposited) allHandled = false;
          } else {
            allHandled = false;
          }
        }
      }
      if (allHandled) {
        removeOutbox(entry.id);
        if (entry.message_id) setMessageDeliveryStatus(entry.message_id, 'sent');
      } else if (entry.attempts + 1 >= MAX_OUTBOX_ATTEMPTS) {
        // Give up after too many attempts so the queue can't wedge forever.
        removeOutbox(entry.id);
        if (entry.message_id) setMessageDeliveryStatus(entry.message_id, 'failed');
      } else {
        // Re-enqueue with a bumped attempt count (remove + add keeps it deduped).
        removeOutbox(entry.id);
        enqueueOutbox({ ...entry, attempts: entry.attempts + 1 });
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
        const sync = getPeerSync();
        const delivered = sync ? await sync.sendToPeer(owner, PROTOCOLS.notify, 'notify.push', payload) : false;
        if (!delivered) {
          // Owner offline / transport down: durably queue the report so it reaches the
          // moderator on reconnect instead of being silently lost with only a local copy.
          // notify.push isn't mailbox-eligible, so the drain simply re-attempts direct
          // delivery (bounded by MAX_OUTBOX_ATTEMPTS) until it lands.
          enqueueOutbox({ id: uid(), targets: [owner], protocol: PROTOCOLS.notify, operation: 'notify.push', payload, created_at: nowISO(), attempts: 0 });
        }
      })();
    }
  }
  return report;
}

// ── Friends ────────────────────────────────────────────────────────────────

/** Extract the bare peer id from either a raw peer id or a dialable multiaddr. */
function peerIdFromAddr(peerAddr: string): string {
  const trimmed = peerAddr.trim();
  if (trimmed.includes('/p2p/')) return trimmed.split('/p2p/').pop() ?? trimmed;
  return trimmed;
}

export function nativeAddFriendRequest(peerAddr: string): XoreinFriendRecord {
  const targetPeerId = peerIdFromAddr(peerAddr);
  const record: XoreinFriendRecord = {
    id: uid(),
    from_peer_id: localPeerId(),
    to_peer_id: targetPeerId,
    to_peer_addr: peerAddr,
    status: 'pending',
    created_at: nowISO(),
  };
  addFriendRequest(record);
  publishNativeSnapshot();
  // P2P: deliver the request to the target so it lands in their Pending tab.
  // If they gave a full multiaddr, register it so we dial the right circuit.
  const sync = getPeerSync();
  if (sync) {
    if (peerAddr.includes('/p2p-circuit')) sync.registerPeer(targetPeerId, peerAddr);
    void sync.sendToPeer(targetPeerId, PROTOCOLS.friends, 'friends.request', {
      kind: 'request',
      id: record.id,
      from_peer_id: localPeerId(),
      display_name: getState().identity?.profile?.display_name,
    });
  }
  return record;
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
      void getPeerSync()?.sendToPeer(requesterPeerId, PROTOCOLS.friends, 'friends.accept', {
        kind: 'accept',
        id: req.id,
        from_peer_id: me,
        display_name: getState().identity?.profile?.display_name,
      });
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
  if (scopeMembers.length <= 1) return;
  void getPeerSync()?.broadcastToScope(scopeMembers, PROTOCOLS.notify, 'notify.push', {
    kind: 'poll_vote',
    message_id: messageId,
    option_index: optionIndex,
    from_peer_id: peerId,
  });
}
