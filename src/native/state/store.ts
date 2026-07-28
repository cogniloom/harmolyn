// Native application-state store.
// Maintains in-memory state and persists it ENCRYPTED-AT-REST (AES-256-GCM under a
// key derived from the unlocked identity seed). The in-memory `_state` is the
// synchronous source of truth for getState(); persistence is a best-effort mirror.
import { gcm } from '@noble/ciphers/aes.js';
import { deriveKey } from '../seal/kdf.js';
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
  XoreinReport,
  XoreinOutboxEntry,
} from '../../types.js';

const STORAGE_KEY = 'harmolyn:native:state';

// Cap the number of persisted messages so the at-rest blob can't grow without
// bound and silently blow the storage quota (after which persist() would fail and
// the app would quietly stop saving). In-memory state is unaffected; only what we
// write to disk is trimmed to the most recent messages.
const MAX_PERSISTED_MESSAGES = 5000;

const STATE_KEY_LABEL = 'xorein/state/v1/at-rest';

// AES-256 key for encrypting the at-rest state blob, derived from the unlocked
// identity seed and held only in memory. Null before unlock (or in tests) — see
// persist()/load() for the plaintext-legacy fallback used only when it is null.
let _stateKey: Uint8Array | null = null;

/**
 * Install (or clear) the at-rest encryption key from the unlocked identity seed.
 * MUST be called before initStore() so load() can decrypt an existing v2 blob.
 * Passing null clears the key (e.g. on lock/logout).
 */
export function setStateEncryptionKey(seed: Uint8Array | null): void {
  _stateKey = seed && seed.length > 0 ? deriveKey(seed, null, STATE_KEY_LABEL, 32) : null;
}

function b64encode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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
  /** Abuse reports (outbound copies + inbound ones received as a server owner). */
  reports: XoreinReport[];
  /** Durable outbound queue: encrypted envelopes awaiting a live transport. */
  outbox: XoreinOutboxEntry[];
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
  reports: [],
  outbox: [],
  active_scope: null,
};

let _state: NativeState = { ...EMPTY, servers: {}, dms: {} };

/**
 * Read and decode the persisted state blob. Handles two formats:
 *   • v2 `{v:2,n,ct}` — AES-256-GCM encrypted under `_stateKey` (the only format
 *     production ever writes once an identity is unlocked).
 *   • legacy plaintext JSON — migrated forward on the next persist(). Kept only so
 *     existing installs upgrade seamlessly; new writes are always encrypted.
 * Returns null when nothing is stored or it can't be decoded.
 */
function readPersistedState(): NativeState | null {
  const raw = _storage()?.getItem(STORAGE_KEY) ?? null;
  if (!raw) return null;
  let outer: unknown;
  try { outer = JSON.parse(raw); } catch { return null; }
  if (outer && typeof outer === 'object' && (outer as { v?: number }).v === 2) {
    const env = outer as { n?: string; ct?: string };
    if (!_stateKey || typeof env.n !== 'string' || typeof env.ct !== 'string') return null;
    try {
      const pt = gcm(_stateKey, b64decode(env.n)).decrypt(b64decode(env.ct));
      return JSON.parse(new TextDecoder().decode(pt)) as NativeState;
    } catch {
      return null; // wrong key / tampered — start fresh rather than surface garbage
    }
  }
  // Legacy plaintext (pre-encryption). Accept once so it migrates on next persist.
  return outer as NativeState;
}

/**
 * Rebuild the peers map from persisted state, keeping ONLY the durable trust pins and
 * learned profile (identity_key / identity_verified / identity_changed / display_name
 * / avatar / role) and dropping transient reachability (addresses, last_seen_at,
 * source, public_key) which is repopulated on connect. This preserves safety-number
 * verification and identity-change detection across reloads.
 */
function restorePeerTrust(persisted: Record<string, XoreinRuntimePeer> | undefined): Record<string, XoreinRuntimePeer> {
  const out: Record<string, XoreinRuntimePeer> = {};
  for (const [id, p] of Object.entries(persisted ?? {})) {
    if (!p) continue;
    // Only carry a peer forward if it holds trust/profile worth persisting — a peer
    // known purely by a stale address contributes nothing and stays dropped.
    if (!p.identity_key && !p.identity_verified && !p.identity_changed && !p.display_name && !p.avatar) continue;
    out[id] = {
      peer_id: p.peer_id ?? id,
      ...(p.role ? { role: p.role } : {}),
      ...(p.identity_key ? { identity_key: p.identity_key } : {}),
      ...(p.identity_verified ? { identity_verified: true } : {}),
      ...(p.identity_changed ? { identity_changed: true } : {}),
      ...(p.display_name ? { display_name: p.display_name } : {}),
      ...(p.avatar ? { avatar: p.avatar } : {}),
      addresses: [],
    };
  }
  return out;
}

function load(): NativeState {
  try {
    const parsed = readPersistedState();
    if (parsed) {
      return {
        ...EMPTY,
        ...parsed,
        servers: parsed.servers ?? {},
        joined_server_ids: parsed.joined_server_ids ?? [],
        // relay_addrs and peer REACHABILITY are connection-derived: never restore
        // stale values, or the UI would report a reachable path while actually
        // offline. But the TOFU trust pins (identity_key / identity_verified /
        // identity_changed) and learned profile MUST survive a reload — otherwise a
        // verified contact silently becomes unverified and a changed identity reads as
        // a fresh first sighting instead of raising the safety-number warning. Keep the
        // trust/profile fields; drop transient addresses/reachability.
        peers: restorePeerTrust(parsed.peers),
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
        reports: parsed.reports ?? [],
        outbox: parsed.outbox ?? [],
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
    const store = _storage();
    if (!store) return;
    // Trim persisted messages to the retention cap (keep the most recent). The live
    // in-memory state keeps everything for this session; only the disk copy is bounded.
    const toPersist: NativeState = _state.messages.length > MAX_PERSISTED_MESSAGES
      ? { ..._state, messages: _state.messages.slice(-MAX_PERSISTED_MESSAGES) }
      : _state;
    const json = JSON.stringify(toPersist);
    if (_stateKey) {
      // Encrypt at rest: crowd_root, invite_secret, and every message body are in
      // this blob — they must never touch disk in cleartext.
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ct = gcm(_stateKey, nonce).encrypt(new TextEncoder().encode(json));
      store.setItem(STORAGE_KEY, JSON.stringify({ v: 2, n: b64encode(nonce), ct: b64encode(ct) }));
    } else {
      // No key yet (pre-unlock / tests). No sensitive data exists before an identity
      // is unlocked; writing plaintext here keeps dev/test round-trips working and is
      // migrated to v2 as soon as a key is installed.
      store.setItem(STORAGE_KEY, json);
    }
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

/**
 * Merge a page of older history (from a member/owner `sync.pull`) into the store,
 * de-duplicating by message id. Returns the number of NEW messages actually added,
 * so the caller (UI load-older) can tell whether the page advanced anything.
 */
export function mergeHistoryMessages(messages: XoreinRuntimeMessage[]): number {
  let added = 0;
  updateState(s => {
    const existingIds = new Set(s.messages.map(m => m.id));
    const fresh = messages.filter(m => m && m.id && !existingIds.has(m.id));
    added = fresh.length;
    return fresh.length ? { messages: [...fresh, ...s.messages] } : {};
  });
  return added;
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

/**
 * TOFU-pin a peer's hybrid identity key (b64 of Ed25519 ‖ ML-DSA-65), learned from
 * their verified prekey bundle. First sighting pins it silently. A LATER sighting
 * with a different key sets `identity_changed` and clears `identity_verified` — the
 * "safety number changed" alarm — so a relay can't quietly swap a contact's identity.
 */
export function pinPeerIdentity(peerId: string, identityKey: string): void {
  if (!peerId || !identityKey) return;
  updateState(s => {
    const existing = s.peers[peerId];
    if (existing?.identity_key === identityKey) return {}; // unchanged — no-op
    const changed = !!existing?.identity_key && existing.identity_key !== identityKey;
    const merged: XoreinRuntimePeer = {
      peer_id: peerId,
      role: 'peer',
      ...existing,
      identity_key: identityKey,
      ...(changed ? { identity_changed: true, identity_verified: false } : {}),
    };
    return { peers: { ...s.peers, [peerId]: merged } };
  });
}

const OUTBOX_CAP = 500;

/** Queue an encrypted envelope for delivery once the transport is back (deduped by id). */
export function enqueueOutbox(entry: XoreinOutboxEntry): void {
  let evicted: XoreinOutboxEntry[] = [];
  updateState(s => {
    if (s.outbox.some(e => e.id === entry.id)) return {};
    // Bound the queue so a long offline stretch can't grow it without limit. The oldest
    // entries fall off the front; capture them so their messages can be marked failed
    // rather than silently dropped (which would leave the UI showing a stuck "queued").
    const next = [...s.outbox, entry];
    if (next.length > OUTBOX_CAP) {
      evicted = next.slice(0, next.length - OUTBOX_CAP);
      return { outbox: next.slice(-OUTBOX_CAP) };
    }
    return { outbox: next };
  });
  for (const e of evicted) {
    if (e.message_id) setMessageDeliveryStatus(e.message_id, 'failed');
  }
}

/** Remove an outbox entry once it has been delivered (or given up on). */
export function removeOutbox(id: string): void {
  updateState(s => ({ outbox: s.outbox.filter(e => e.id !== id) }));
}

/** Snapshot the current outbox entries. */
export function getOutbox(): XoreinOutboxEntry[] {
  return _state.outbox;
}

/** Append an abuse report (deduped by id). Newest first. */
export function addReport(report: XoreinReport): void {
  updateState(s => {
    if (s.reports.some(r => r.id === report.id)) return {};
    return { reports: [report, ...s.reports].slice(0, 500) };
  });
}

/** Set the reporter-side delivery state of a report (e.g. 'failed' once retry ages out). */
export function setReportDelivery(reportId: string, delivery: XoreinReport['delivery']): void {
  updateState(s => {
    if (!s.reports.some(r => r.id === reportId)) return {};
    return { reports: s.reports.map(r => (r.id === reportId ? { ...r, delivery } : r)) };
  });
}

/** Mark an owner-side report resolved/dismissed (moderation inbox action). */
export function setReportResolved(reportId: string, resolved: boolean): void {
  updateState(s => {
    if (!s.reports.some(r => r.id === reportId)) return {};
    return { reports: s.reports.map(r => (r.id === reportId ? { ...r, resolved } : r)) };
  });
}

/** Mark (or unmark) a peer's identity as user-verified out of band; clears the change flag. */
export function setPeerVerified(peerId: string, verified: boolean): void {
  updateState(s => {
    const existing = s.peers[peerId];
    if (!existing) return {};
    return {
      peers: {
        ...s.peers,
        [peerId]: { ...existing, identity_verified: verified, ...(verified ? { identity_changed: false } : {}) },
      },
    };
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

/**
 * Whether `peerId` holds `permission` on `serverId`. The owner implicitly has every
 * permission; other members have it if any of their assigned roles grants it (or the
 * catch-all ADMINISTRATOR). Used to authorize privileged actions — e.g. pinning —
 * both when broadcasting locally and when APPLYING an inbound op, so a member cannot
 * forge a privileged action just because the transport authenticated them as a peer.
 */
export function memberHasPermission(serverId: string, peerId: string, permission: string): boolean {
  const server = _state.servers[serverId];
  if (!server || !peerId) return false;
  if (server.owner_peer_id === peerId) return true;
  // A removed member's `member_roles` assignment can linger after removeServerMember drops
  // them from `members`; require CURRENT membership so a kicked moderator's stale role can't
  // keep authorizing pin/unpin (or any) privileged operations.
  if (!(server.members ?? []).includes(peerId)) return false;
  const roleIds = server.member_roles?.[peerId] ?? [];
  if (roleIds.length === 0) return false;
  const roles = server.roles ?? [];
  return roleIds.some(rid => {
    const role = roles.find(r => r.id === rid);
    return !!role && (role.permissions.includes(permission) || role.permissions.includes('ADMINISTRATOR'));
  });
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

/** True when peerId is a current participant of the given scope (DM participant or server member). */
export function isScopeMember(scopeId: string, scopeType: string, serverId: string | undefined, peerId: string): boolean {
  if (!peerId) return false;
  if (scopeType === 'dm') return (_state.dms[scopeId]?.participants ?? []).includes(peerId);
  return serverId ? (_state.servers[serverId]?.members ?? []).includes(peerId) : false;
}

export function addPollVote(messageId: string, optionIndex: number, peerId: string): boolean {
  // Returns true if this is a new vote (not a duplicate).
  let isNew = false;
  updateState(s => {
    const msg = s.messages.find(m => m.id === messageId);
    if (!msg) return {};
    const votes = msg.poll_votes ?? {};
    // Single-choice: a peer holds at most ONE vote across all options. Reject if the peer
    // already appears in ANY option's voter list — previously only the selected option was
    // checked, so after a reload (where the UI no longer remembers the prior selection) the
    // same identity could stack a vote onto every option.
    const alreadyVoted = Object.values(votes).some(voters => voters.includes(peerId));
    if (alreadyVoted) return {};
    const voters = votes[optionIndex] ?? [];
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

/** Flag whether TURN is unavailable for a voice session (STUN-only). */
export function setVoiceTurnUnavailable(channelId: string, unavailable: boolean): void {
  updateState(s => ({
    voice_sessions: s.voice_sessions.map(v =>
      v.channel_id === channelId ? { ...v, turn_unavailable: unavailable } : v,
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
    reports: s.reports,
    // Reachable peers, including the always-on bootstrap relay (seeded by the
    // engine once the transport connects) so deriveConnectionState can see that
    // the support node is reachable instead of reporting every server no-peer.
    known_peers: Object.values(s.peers),
    // HTTP-routed operations (identity, pins, roles, etc.) need a control endpoint.
    // Always include the default so requestControlApi can route even when native is active.
    control_endpoint: import.meta.env.VITE_XOREIN_CONTROL_ENDPOINT?.trim() || 'https://node.xorein.com',
  };
}
