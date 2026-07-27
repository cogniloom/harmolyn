// Native application-state store.
// Maintains in-memory state and persists to localStorage (plain JSON).
// This is the local-only first step; P2P sync layers on top in a future iteration.
import type {
  XoreinRuntimeSnapshot,
  XoreinRuntimeServer,
  XoreinRuntimeChannel,
  XoreinRuntimeMessage,
  XoreinRuntimeDM,
  XoreinFriendRecord,
  XoreinRuntimeVoiceSession,
  XoreinRuntimeVoiceParticipant,
  XoreinRuntimePeer,
  XoreinPresenceEntry,
  XoreinRuntimeIdentity,
} from '../../types.js';

const STORAGE_KEY = 'harmolyn:native:state';

// Guests persist to sessionStorage (per-tab, session-scoped) so each browsing
// session/tab is an isolated throwaway guest — no cross-tab clobber and a fresh
// guest when the session ends. Registered identities persist to localStorage so
// they survive across sessions and are unlocked with the password.
let _storage: () => Storage | null = () =>
  (typeof window !== 'undefined' ? window.localStorage : null);

export function configureNativeStore(opts: { guest: boolean }): void {
  _storage = () => {
    if (typeof window === 'undefined') return null;
    return opts.guest ? window.sessionStorage : window.localStorage;
  };
}

export interface NativeState {
  identity: XoreinRuntimeIdentity | null;
  servers: Record<string, XoreinRuntimeServer>;
  /** Server ids the local identity has explicitly joined/created (membership). */
  joined_server_ids: string[];
  /** Known reachable peers (the bootstrap relay + discovered server members). */
  peers: Record<string, XoreinRuntimePeer>;
  messages: XoreinRuntimeMessage[];
  dms: Record<string, XoreinRuntimeDM>;
  friends: XoreinFriendRecord[];
  friend_requests: XoreinFriendRecord[];
  voice_sessions: XoreinRuntimeVoiceSession[];
  relay_addrs: string[];
  presence: Record<string, XoreinPresenceEntry>;
  /** Per-scope unread counts (channel id / dm id → count). Persisted. */
  unread: Record<string, number>;
  /**
   * The scope (channel/dm) the user is currently viewing. In-memory only — never
   * restored from storage, so a reload doesn't suppress unread for a scope the
   * user is no longer looking at. Inbound messages to this scope don't bump unread.
   */
  active_scope: string | null;
}

const EMPTY: NativeState = {
  identity: null,
  servers: {},
  joined_server_ids: [],
  peers: {},
  messages: [],
  dms: {},
  friends: [],
  friend_requests: [],
  voice_sessions: [],
  relay_addrs: [],
  presence: {},
  unread: {},
  active_scope: null,
};

let _state: NativeState = { ...EMPTY, servers: {}, dms: {} };

function load(): NativeState {
  try {
    const raw = _storage()?.getItem(STORAGE_KEY) ?? null;
    if (raw) {
      const parsed = JSON.parse(raw) as NativeState;
      return {
        ...EMPTY,
        ...parsed,
        servers: parsed.servers ?? {},
        joined_server_ids: parsed.joined_server_ids ?? [],
        // relay_addrs and peers are connection-derived: never restore stale
        // values from a previous session, or the UI would report a reachable
        // bootstrap path while actually offline. They are repopulated on connect.
        peers: {},
        dms: parsed.dms ?? {},
        messages: parsed.messages ?? [],
        friends: parsed.friends ?? [],
        friend_requests: parsed.friend_requests ?? [],
        // Voice sessions are live runtime state tied to an in-memory VoiceSession +
        // WebRTC connections — never restore them, or a reload leaves you "in" a
        // channel with no live session and no controls. You start out of voice.
        voice_sessions: [],
        relay_addrs: [],
        presence: parsed.presence ?? {},
        unread: parsed.unread ?? {},
        // active_scope is view state, not persisted — start with none selected.
        active_scope: null,
      };
    }
  } catch { /* start fresh on corrupt data */ }
  return { ...EMPTY, servers: {}, dms: {} };
}

/**
 * Reset all user-scoped data to empty, keeping nothing. Used when the active
 * identity changes (e.g. a fresh guest session) so one identity never sees a
 * previous identity's servers/messages. Identity is set separately by the engine.
 */
export function resetNativeStore(): void {
  _state = { ...EMPTY, servers: {}, dms: {}, peers: {} };
  persist();
}

function persist(): void {
  try {
    _storage()?.setItem(STORAGE_KEY, JSON.stringify(_state));
  } catch { /* quota exceeded / private browsing — best effort */ }
}

export function initStore(): NativeState {
  _state = load();
  return _state;
}

export function getState(): NativeState {
  return _state;
}

export function updateState(updater: (s: NativeState) => Partial<NativeState>): NativeState {
  const patch = updater(_state);
  _state = { ..._state, ...patch };
  persist();
  return _state;
}

// ── Identity ───────────────────────────────────────────────────────────────

export function setNativeIdentity(identity: XoreinRuntimeIdentity): void {
  updateState(() => ({ identity }));
}

/**
 * Merge a display_name/bio into the existing native identity without replacing
 * the peer_id or other fields. Called after HTTP createIdentity/restoreIdentity
 * so the native snapshot includes the registered profile immediately.
 */
export function mergeNativeIdentityProfile(displayName: string, bio?: string, avatar?: string): void {
  // Synthesize a minimal identity when none exists yet so the display_name is
  // never silently dropped (e.g. if called before the engine populated the
  // identity). The engine reconciles the real peer_id on start().
  const current = _state.identity ?? { id: '', peer_id: '' };
  const prevProfile = current.profile ?? {};
  // Merge into the existing profile so unrelated fields (e.g. avatar when only
  // the name changes, or bio when only the avatar changes) are preserved.
  updateState(() => ({
    identity: {
      ...current,
      profile: {
        ...prevProfile,
        display_name: displayName,
        ...(bio !== undefined ? { bio } : {}),
        ...(avatar !== undefined ? { avatar } : {}),
      },
    },
  }));
}

// ── Servers ────────────────────────────────────────────────────────────────

export function addServer(server: XoreinRuntimeServer): void {
  updateState(s => ({
    servers: { ...s.servers, [server.id]: server },
    joined_server_ids: s.joined_server_ids.includes(server.id)
      ? s.joined_server_ids
      : [...s.joined_server_ids, server.id],
  }));
}

/**
 * Apply a server pulled from its owner over P2P: store the server record, mark
 * it joined, and merge in its message history (deduped by id).
 */
export function applyJoinedServer(server: XoreinRuntimeServer, messages: XoreinRuntimeMessage[] = []): void {
  updateState(s => {
    const existingIds = new Set(s.messages.map(m => m.id));
    const merged = messages.filter(m => m && m.id && !existingIds.has(m.id));
    return {
      servers: { ...s.servers, [server.id]: server },
      joined_server_ids: s.joined_server_ids.includes(server.id)
        ? s.joined_server_ids
        : [...s.joined_server_ids, server.id],
      messages: merged.length ? [...s.messages, ...merged] : s.messages,
    };
  });
}

/** Record that the local identity has joined a server (membership). */
export function recordServerMembership(serverId: string): void {
  updateState(s => (
    s.joined_server_ids.includes(serverId)
      ? {}
      : { joined_server_ids: [...s.joined_server_ids, serverId] }
  ));
}

/** Forget a server membership (leave). */
export function removeServerMembership(serverId: string): void {
  updateState(s => {
    const server = s.servers[serverId];
    const channelIds = new Set(Object.keys(server?.channels ?? {}));
    const { [serverId]: _removed, ...rest } = s.servers;
    return {
      servers: rest,
      joined_server_ids: s.joined_server_ids.filter(id => id !== serverId),
      // Purge messages scoped to any channel in this server — privacy: messages
      // from a left/deleted server must not linger in local storage.
      messages: channelIds.size
        ? s.messages.filter(m => m.server_id !== serverId && !channelIds.has(m.scope_id))
        : s.messages,
    };
  });
}

/** Remove a member from a server's member list (owner-side kick). No-op if absent. */
export function removeServerMember(serverId: string, peerId: string): void {
  updateState(s => {
    const server = s.servers[serverId];
    if (!server || !(server.members ?? []).includes(peerId)) return {};
    return {
      servers: {
        ...s.servers,
        [serverId]: { ...server, members: server.members.filter(m => m !== peerId) },
      },
    };
  });
}

// ── Known peers ──────────────────────────────────────────────────────────────

/** Insert or update a known peer (bootstrap relay or a discovered member). */
export function upsertPeer(peer: XoreinRuntimePeer): void {
  if (!peer.peer_id) return;
  updateState(s => {
    const existing = s.peers[peer.peer_id];
    const merged: XoreinRuntimePeer = {
      ...existing,
      ...peer,
      addresses: Array.from(new Set([...(existing?.addresses ?? []), ...(peer.addresses ?? [])])),
    };
    return { peers: { ...s.peers, [peer.peer_id]: merged } };
  });
}

export function updateServer(serverId: string, patch: Partial<XoreinRuntimeServer>): void {
  updateState(s => {
    const existing = s.servers[serverId];
    if (!existing) return {};
    return { servers: { ...s.servers, [serverId]: { ...existing, ...patch } } };
  });
}

export function addChannel(serverId: string, channel: XoreinRuntimeChannel): void {
  updateState(s => {
    const server = s.servers[serverId];
    if (!server) return {};
    return {
      servers: {
        ...s.servers,
        [serverId]: {
          ...server,
          channels: { ...server.channels, [channel.id]: channel },
        },
      },
    };
  });
}

/** Patch an existing channel's editable fields (name, topic, bitrate, user_limit). */
export function updateChannel(
  serverId: string,
  channelId: string,
  patch: Partial<Pick<XoreinRuntimeChannel, 'name' | 'topic' | 'bitrate' | 'user_limit'>>,
): void {
  updateState(s => {
    const server = s.servers[serverId];
    const existing = server?.channels[channelId];
    if (!server || !existing) return {};
    return {
      servers: {
        ...s.servers,
        [serverId]: {
          ...server,
          channels: { ...server.channels, [channelId]: { ...existing, ...patch } },
        },
      },
    };
  });
}

/** Remove a channel and any voice session scoped to it. */
export function removeChannel(serverId: string, channelId: string): void {
  updateState(s => {
    const server = s.servers[serverId];
    if (!server || !server.channels[channelId]) return {};
    const channels = { ...server.channels };
    delete channels[channelId];
    return {
      servers: { ...s.servers, [serverId]: { ...server, channels } },
      voice_sessions: s.voice_sessions.filter(v => v.channel_id !== channelId),
    };
  });
}

// ── Messages ───────────────────────────────────────────────────────────────

export function addMessage(msg: XoreinRuntimeMessage): void {
  // Idempotent by id: a local send and a later echo/redelivery of the same
  // message must not produce duplicates (resil-5).
  updateState(s => (s.messages.some(m => m.id === msg.id) ? {} : { messages: [...s.messages, msg] }));
}

export function editMessage(messageId: string, body: string): void {
  updateState(s => ({
    messages: s.messages.map(m =>
      m.id === messageId
        ? { ...m, body, updated_at: new Date().toISOString() }
        : m,
    ),
  }));
}

export function deleteMessage(messageId: string): void {
  updateState(s => ({
    messages: s.messages.map(m =>
      m.id === messageId ? { ...m, deleted: true } : m,
    ),
  }));
}

export function pinMessage(messageId: string, pinned: boolean): void {
  updateState(s => ({
    messages: s.messages.map(m => m.id === messageId ? { ...m, pinned } : m),
  }));
}

export function setMessageDeliveryStatus(
  messageId: string,
  status: NonNullable<XoreinRuntimeMessage['delivery_status']>,
): void {
  updateState(s => ({
    messages: s.messages.map(m => m.id === messageId ? { ...m, delivery_status: status } : m),
  }));
}

export function addServerRole(serverId: string, role: import('../../types.js').ServerRole): void {
  updateState(s => {
    const server = s.servers[serverId];
    if (!server) return {};
    const existing = server.roles ?? [];
    if (existing.some(r => r.id === role.id)) return {};
    return { servers: { ...s.servers, [serverId]: { ...server, roles: [...existing, role] } } };
  });
}

export function updateServerRole(serverId: string, roleId: string, patch: { name?: string; color?: string; permissions?: string[] }): void {
  updateState(s => {
    const server = s.servers[serverId];
    if (!server) return {};
    const roles = (server.roles ?? []).map(r =>
      r.id === roleId ? { ...r, ...patch } : r,
    );
    return { servers: { ...s.servers, [serverId]: { ...server, roles } } };
  });
}

export function removeServerRole(serverId: string, roleId: string): void {
  updateState(s => {
    const server = s.servers[serverId];
    if (!server) return {};
    const roles = (server.roles ?? []).filter(r => r.id !== roleId);
    const member_roles = Object.fromEntries(
      Object.entries(server.member_roles ?? {}).map(([pid, rids]) => [pid, rids.filter(r => r !== roleId)]),
    );
    return { servers: { ...s.servers, [serverId]: { ...server, roles, member_roles } } };
  });
}

export function setMemberRoles(serverId: string, peerId: string, roleIds: string[]): void {
  updateState(s => {
    const server = s.servers[serverId];
    if (!server) return {};
    const member_roles = { ...(server.member_roles ?? {}), [peerId]: roleIds };
    return { servers: { ...s.servers, [serverId]: { ...server, member_roles } } };
  });
}

export function addPollVote(messageId: string, optionIndex: number, peerId: string): boolean {
  // Returns true if this is a new vote (not a duplicate).
  let isNew = false;
  updateState(s => {
    const msg = s.messages.find(m => m.id === messageId);
    if (!msg) return {};
    const votes = msg.poll_votes ?? {};
    const voters = votes[optionIndex] ?? [];
    if (voters.includes(peerId)) return {};
    isNew = true;
    return {
      messages: s.messages.map(m => m.id === messageId
        ? { ...m, poll_votes: { ...votes, [optionIndex]: [...voters, peerId] } }
        : m),
    };
  });
  return isNew;
}

export function addReaction(messageId: string, emoji: string, peerId: string): void {
  updateState(s => ({
    messages: s.messages.map(m => {
      if (m.id !== messageId) return m;
      const reactions = m.reactions ?? [];
      const existing = reactions.find(r => r.emoji === emoji);
      const isLocal = peerId === (s.identity?.peer_id ?? '');
      if (existing) {
        if ((existing.reactedBy ?? []).includes(peerId)) return m; // idempotent
        return {
          ...m,
          reactions: reactions.map(r =>
            r.emoji === emoji
              ? { ...r, count: r.count + 1, reacted: isLocal || r.reacted, reactedBy: [...(r.reactedBy ?? []), peerId] }
              : r,
          ),
        };
      }
      return { ...m, reactions: [...reactions, { emoji, count: 1, reacted: isLocal, reactedBy: [peerId] }] };
    }),
  }));
}

export function removeReaction(messageId: string, emoji: string, peerId: string): void {
  updateState(s => ({
    messages: s.messages.map(m => {
      if (m.id !== messageId) return m;
      const isLocal = peerId === (s.identity?.peer_id ?? '');
      const reactions = (m.reactions ?? []).map(r => {
        if (r.emoji !== emoji) return r;
        const reactedBy = (r.reactedBy ?? []).filter(p => p !== peerId);
        if (!(r.reactedBy ?? []).includes(peerId)) return r; // peer never added this reaction
        return { ...r, count: Math.max(0, r.count - 1), reacted: isLocal ? false : r.reacted, reactedBy };
      }).filter(r => r.count > 0);
      return { ...m, reactions };
    }),
  }));
}

// ── DMs ────────────────────────────────────────────────────────────────────

export function ensureDm(dmId: string, participants: string[]): void {
  updateState(s => {
    if (s.dms[dmId]) return {};
    return {
      dms: {
        ...s.dms,
        [dmId]: { id: dmId, participants, created_at: new Date().toISOString() },
      },
    };
  });
}

// ── Friends ────────────────────────────────────────────────────────────────

export function addFriendRequest(record: XoreinFriendRecord): void {
  updateState(s => ({
    friend_requests: [
      ...s.friend_requests.filter(r => r.id !== record.id),
      record,
    ],
  }));
}

export function acceptFriend(requestId: string): void {
  updateState(s => {
    const req = s.friend_requests.find(r => r.id === requestId);
    if (!req) return {};
    return {
      friend_requests: s.friend_requests.filter(r => r.id !== requestId),
      friends: [...s.friends.filter(f => f.id !== req.id), { ...req, status: 'accepted' as const }],
    };
  });
}

/** Drop a pending request (decline/cancel) without recording a friendship. */
export function removeFriendRequest(requestId: string): void {
  updateState(s => ({
    friend_requests: s.friend_requests.filter(r => r.id !== requestId),
  }));
}

/**
 * Accept the pending request involving `peerId` (used when the *other* side tells
 * us they accepted — we match by counterparty rather than request id since the two
 * peers each hold their own request record).
 */
export function acceptFriendByPeer(peerId: string): void {
  updateState(s => {
    const me = s.identity?.peer_id ?? '';
    const counterpartyOf = (r: XoreinFriendRecord) =>
      r.from_peer_id === me ? (r.to_peer_id ?? r.to_peer_addr ?? '') : r.from_peer_id;
    const req = s.friend_requests.find(r => counterpartyOf(r) === peerId);
    if (!req) return {};
    return {
      friend_requests: s.friend_requests.filter(r => r.id !== req.id),
      friends: [...s.friends.filter(f => f.id !== req.id), { ...req, status: 'accepted' as const }],
    };
  });
}

// ── Voice ──────────────────────────────────────────────────────────────────

export function joinVoice(channelId: string, peerId: string): void {
  updateState(s => {
    const existing = s.voice_sessions.find(v => v.channel_id === channelId);
    if (existing) {
      // Idempotent: keep an already-present participant's av-state (muted, video,
      // speaking) instead of resetting it on a re-announce.
      if (existing.participants[peerId]) return {};
      return {
        voice_sessions: s.voice_sessions.map(v =>
          v.channel_id === channelId
            ? { ...v, participants: { ...v.participants, [peerId]: { peer_id: peerId, joined_at: new Date().toISOString() } } }
            : v,
        ),
      };
    }
    return {
      voice_sessions: [
        ...s.voice_sessions,
        { channel_id: channelId, participants: { [peerId]: { peer_id: peerId, joined_at: new Date().toISOString() } } },
      ],
    };
  });
}

/** Merge an av-state patch onto a voice participant (no-op if not present). */
export function setVoiceParticipant(
  channelId: string,
  peerId: string,
  patch: Partial<XoreinRuntimeVoiceParticipant>,
): void {
  updateState(s => ({
    voice_sessions: s.voice_sessions.map(v => {
      if (v.channel_id !== channelId) return v;
      const current = v.participants[peerId];
      if (!current) return v;
      return { ...v, participants: { ...v.participants, [peerId]: { ...current, ...patch } } };
    }),
  }));
}

/** Set the local session's connection state badge. */
export function setVoiceConnectionState(channelId: string, state: XoreinRuntimeVoiceSession['connection_state']): void {
  updateState(s => ({
    voice_sessions: s.voice_sessions.map(v =>
      v.channel_id === channelId ? { ...v, connection_state: state } : v,
    ),
  }));
}

/**
 * Record the HONEST media security mode for a voice session so the UI badge
 * reflects real protection: `crowd` = SFrame E2EE over DTLS (a real shared key),
 * `clear` = DTLS-only (no SFrame — e.g. no crowd_root). Never claims SFrame the
 * media pipeline isn't actually applying.
 */
export function setVoiceSecurityMode(channelId: string, mode: XoreinRuntimeVoiceSession['security_mode']): void {
  updateState(s => ({
    voice_sessions: s.voice_sessions.map(v =>
      v.channel_id === channelId ? { ...v, security_mode: mode } : v,
    ),
  }));
}

export function leaveVoice(channelId: string, peerId: string): void {
  updateState(s => ({
    voice_sessions: s.voice_sessions
      .map(v => {
        if (v.channel_id !== channelId) return v;
        const participants = { ...v.participants };
        delete participants[peerId];
        return { ...v, participants };
      })
      .filter(v => Object.keys(v.participants).length > 0),
  }));
}

// ── Relays ─────────────────────────────────────────────────────────────────

export function addRelay(multiaddr: string): void {
  updateState(s => ({
    relay_addrs: Array.from(new Set([...s.relay_addrs, multiaddr])),
  }));
}

export function removeRelay(multiaddr: string): void {
  updateState(s => ({
    relay_addrs: s.relay_addrs.filter(r => r !== multiaddr),
  }));
}

// ── Presence ───────────────────────────────────────────────────────────────

export function updatePresenceEntry(peerId: string, entry: XoreinPresenceEntry): void {
  updateState(s => ({
    presence: { ...s.presence, [peerId]: entry },
  }));
}

// ── Unread / notifications ───────────────────────────────────────────────────

/** Increment the unread counter for a scope (channel id / dm id). */
export function bumpUnread(scopeId: string): void {
  if (!scopeId) return;
  updateState(s => ({ unread: { ...s.unread, [scopeId]: (s.unread[scopeId] ?? 0) + 1 } }));
}

/** Clear the unread counter for a scope (e.g. when the user opens it). */
export function clearUnread(scopeId: string): void {
  if (!scopeId) return;
  updateState(s => {
    if (!s.unread[scopeId]) return {};
    const { [scopeId]: _drop, ...rest } = s.unread;
    return { unread: rest };
  });
}

/** The scope the user is currently viewing (inbound msgs here don't bump unread). */
export function getActiveScope(): string | null {
  return _state.active_scope;
}

/** Mark a scope active (and clear its unread). null = no scope focused. */
export function setActiveScope(scopeId: string | null): void {
  updateState(s => {
    const unread = s.unread[scopeId ?? ''] ? (() => {
      const { [scopeId as string]: _drop, ...rest } = s.unread;
      return rest;
    })() : s.unread;
    return { active_scope: scopeId, unread };
  });
}

// ── Snapshot ───────────────────────────────────────────────────────────────

export function toRuntimeSnapshot(): XoreinRuntimeSnapshot {
  const s = _state;
  // Strip owner-only cryptographic secrets before exposing to React render state.
  // crowd_root and invite_secret are E2EE / invite-authority material that must
  // never appear in the runtime snapshot — only the encrypted store and the crypto
  // layer (secureEnvelope.ts / invite.ts) read them directly via getState().
  const serverPublic = (srv: XoreinRuntimeServer): XoreinRuntimeServer => {
    const { crowd_root: _cr, invite_secret: _is, ...pub } = srv;
    return pub as XoreinRuntimeServer;
  };
  return {
    role: 'peer',
    peer_id: s.identity?.peer_id,
    identity: s.identity ?? undefined,
    servers: Object.values(s.servers).map(serverPublic),
    joined_server_ids: s.joined_server_ids,
    messages: s.messages.filter(m => !m.deleted),
    dms: Object.values(s.dms),
    friends: s.friends,
    friend_requests: s.friend_requests,
    voice_sessions: s.voice_sessions,
    relay_addrs: s.relay_addrs,
    presence: s.presence,
    unread: s.unread,
    // Reachable peers, including the always-on bootstrap relay (seeded by the
    // engine once the transport connects) so deriveConnectionState can see that
    // the support node is reachable instead of reporting every server no-peer.
    known_peers: Object.values(s.peers),
    // HTTP-routed operations (identity, pins, roles, etc.) need a control endpoint.
    // Always include the default so requestControlApi can route even when native is active.
    control_endpoint: import.meta.env.VITE_XOREIN_CONTROL_ENDPOINT?.trim() || 'https://node.xorein.com',
  };
}
