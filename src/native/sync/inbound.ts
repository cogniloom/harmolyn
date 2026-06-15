// Inbound PeerStream family handlers: receive chat messages, reactions, and
// presence/typing updates from remote peers and apply them to the local store.
import type { Libp2p } from 'libp2p';
import type { XoreinRuntimeServer } from '../../types.js';
import {
  frameMessage, unframeMessage,
  decodePeerStreamRequest, encodePeerStreamResponse,
} from '../families/peerstream.js';
import { PROTOCOLS } from '../families/families.js';
import { addMessage, editMessage as storeEditMessage, deleteMessage as storeDeleteMessage, pinMessage as storePinMessage, updatePresenceEntry, addReaction, removeReaction, getState, updateServer, upsertPeer, addFriendRequest, acceptFriendByPeer, ensureDm, bumpUnread, getActiveScope, removeServerMembership, removeServerMember, addPollVote } from '../state/store.js';
import { nativeAnnouncePresence, broadcastServerUpdate } from '../state/mutations.js';
import { publishNativeSnapshot } from '../state/snapshot.js';
import { decryptInboundEnvelope, getScopeCrypto, type DecryptedMessage } from './secureEnvelope.js';
import { verifyInviteToken } from './invite.js';
import type { PeerSync } from './peersync.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

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

function base64ToUtf8(b64: string): string {
  try { return decodeURIComponent(escape(atob(b64))); } catch { return b64; }
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
  if (!scopeId || !decoded) return;
  const { body, media } = decoded;
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
    created_at: new Date().toISOString(),
  });

  // Notifications: bump the unread badge for any scope the user isn't currently
  // viewing, and pop a toast for DMs (a 1:1 message you'd otherwise miss). Channel
  // messages get the quieter unread pip rather than a toast to avoid noise.
  if (scopeId !== getActiveScope()) bumpUnread(scopeId);
  if (scopeType === 'dm' && scopeId !== getActiveScope()) {
    emitNotify({ kind: 'dm', title: peerDisplayName(senderId), body: body || 'Sent an attachment', scopeId });
  }
  publishNativeSnapshot();
}

/**
 * Decode an inbound chat message. Encrypted envelopes (enc: 'seal' | 'crowd') are
 * decrypted via the session layer and yield the text body + any E2EE attachments;
 * legacy base64 bodies are decoded directly. Returns null when an encrypted
 * envelope cannot be decrypted (dropped, not surfaced as garbage).
 */
function decodeInboundMessage(
  payload: Record<string, unknown>,
  remotePeerId: string,
  scopeId: string,
  scopeType: 'channel' | 'dm',
): DecryptedMessage | null {
  const enc = typeof payload.enc === 'string' ? payload.enc : '';
  if (enc === 'seal' || enc === 'crowd') {
    return decryptInboundEnvelope(enc, payload, remotePeerId, scopeId, scopeType);
  }
  const rawBody = payload.body;
  return { body: typeof rawBody === 'string' ? base64ToUtf8(rawBody) : '' };
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

  // Decrypt if the payload carries an E2EE envelope; fall back to plaintext body
  // (legacy / unencrypted path) for compatibility.
  let body: string;
  const enc = typeof payload.enc === 'string' ? payload.enc : '';
  if (enc === 'seal' || enc === 'crowd') {
    const decoded = decodeInboundMessage(payload, remotePeerId, msg.scope_id, msg.scope_type as 'channel' | 'dm');
    if (!decoded?.body) return;
    body = decoded.body;
  } else {
    body = typeof payload.body === 'string' ? payload.body : '';
    if (!body) return;
  }

  storeEditMessage(messageId, body);
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
  // SECURITY: use the Noise-authenticated connection peer for all sender fields.
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
}

// ── Server sync inbound (serve manifest/channels/history to joiners) ─────────

/**
 * Respond to a joiner's `sync.join` / `sync.pull`. On `sync.join` the OWNER adds
 * the requester to the server's members (so future broadcasts reach them), then
 * returns the full server record + its message history. This is the owner-served
 * half of P2P invite-join — the joiner dials us over the relay circuit.
 */
function handleSyncRequest(operation: string, payload: Record<string, unknown>, remotePeerId: string): Record<string, unknown> {
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
      updateServer(serverId, {
        ...(incoming.channels ? { channels: incoming.channels } : {}),
        ...(Array.isArray(incoming.members) ? { members: incoming.members } : {}),
        ...(incoming.manifest ? { manifest: incoming.manifest } : {}),
        ...(typeof incoming.name === 'string' && incoming.name ? { name: incoming.name } : {}),
      });
      publishNativeSnapshot();
    }
    return { ok: true };
  }

  // Member leaving: the owner drops them from the member list and re-broadcasts the
  // updated roster so everyone's view converges. Only the owner mutates membership.
  if (operation === 'sync.leave') {
    if (isOwner && remotePeerId && server.members.includes(remotePeerId)) {
      removeServerMember(serverId, remotePeerId);
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
  if (operation === 'sync.join' && isOwner && remotePeerId && !server.members.includes(remotePeerId)) {
    updateServer(serverId, { members: [...server.members, remotePeerId] });
    publishNativeSnapshot();
  }

  const current = getState().servers[serverId] ?? server;
  const allMessages = getState().messages.filter(m => !m.deleted && m.server_id === serverId);
  const retention = current.manifest?.history_retention_messages ?? 100;
  // Serve the most recent `retention` messages only — honour the manifest window.
  const messages = allMessages.slice(-retention);
  // Advertise our own circuit addresses so the joiner can reach us on our relay.
  const addresses = (getState().relay_addrs ?? []).filter(a => a.includes('p2p-circuit'));
  // SECURITY: strip invite_secret before sending — it is an owner-only capability
  // that grants invite-minting authority. crowd_root is intentionally distributed
  // to joining members so they can decrypt channel messages; it is a shared epoch
  // key. Known gap: there is currently no epoch rotation on member removal — a
  // revoked member retains their copy of crowd_root until the owner rotates it
  // manually. Epoch rotation is tracked in docs/xorein-native-roadmap.md.
  const { invite_secret: _omit, ...serverForJoiner } = current;
  return { ok: true, server: serverForJoiner, messages, addresses };
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
