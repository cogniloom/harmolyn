import { safeStorageGet } from '@/lib/browserStorage';
import { formatDateTime } from '@/lib/locale';
import { escapeSvgText } from '@/lib/svg';
import { isSafeAvatarSource } from '@/lib/avatar';
import { isSafeAttachment } from '@/native/security/limits';
import type {
  Channel,
  ConnectionState,
  DirectMessageChannel,
  Message,
  Server,
  User,
  UserStatus,
  XoreinRuntimeChannel,
  XoreinFriendRecord,
  XoreinRuntimeDM,
  XoreinRuntimeMessage,
  XoreinAttachment,
  XoreinPresenceEntry,
  XoreinRuntimePeer,
  XoreinRuntimeServer,
  XoreinRuntimeSnapshot,
  XoreinRuntimeVoiceParticipant,
  XoreinRuntimeVoiceSession,
  XoreinSessionSnapshot,
} from '@/types';

const CURRENT_USER_ID = 'me';
const RUNTIME_GLOBAL_KEYS = [
  '__HARMOLYN_XOREIN_RUNTIME__',
  '__HARMOLYN_RUNTIME_SNAPSHOT__',
  '__XOREIN_RUNTIME_SNAPSHOT__',
] as const;
const SESSION_GLOBAL_KEYS = [
  '__HARMOLYN_XOREIN_SESSION__',
  '__HARMOLYN_SESSION_SNAPSHOT__',
  '__XOREIN_SESSION_SNAPSHOT__',
] as const;
const RUNTIME_STORAGE_KEYS = [
  'harmolyn:xorein:runtime',
  'harmolyn:runtime-snapshot',
  'xorein:runtime-snapshot',
] as const;
const SESSION_STORAGE_KEYS = [
  'harmolyn:xorein:session',
  'harmolyn:session-snapshot',
  'xorein:session-snapshot',
] as const;

export interface ShellRuntimeData {
  runtimeSnapshot: XoreinRuntimeSnapshot | null;
  sessionSnapshot: XoreinSessionSnapshot | null;
  currentUser: User;
  users: User[];
  servers: Server[];
  directMessages: DirectMessageChannel[];
  messages: Message[];
  messagesByScope: Map<string, Message[]>;
  defaultChannelByServer: Map<string, string>;
  initialServerId: string | 'home' | 'explore';
  initialChannelId: string;
}

const initialShellSignature = createRuntimeSignature();
const shellData = createShellRuntimeData();
const RUNTIME_POLL_INTERVAL_MS = 1000;
let cachedShellSignature = initialShellSignature;
let cachedShellData = shellData;

export const CURRENT_USER = shellData.currentUser;
export const USERS = shellData.users;
export const DIRECT_MESSAGES = shellData.directMessages;
export const SERVERS = shellData.servers;
export const MESSAGES = shellData.messages;
export const ACTIVE_SESSION = shellData.sessionSnapshot;
export const HAS_RUNTIME_SNAPSHOT = shellData.runtimeSnapshot !== null;
export const INITIAL_ACTIVE_SERVER_ID = shellData.initialServerId;
export const INITIAL_ACTIVE_CHANNEL_ID = shellData.initialChannelId;

export function readShellRuntimeData(): ShellRuntimeData {
  const nextSignature = createRuntimeSignature();
  if (nextSignature !== cachedShellSignature) {
    cachedShellSignature = nextSignature;
    cachedShellData = createShellRuntimeData();
  }
  return cachedShellData;
}

export function subscribeShellRuntimeData(onChange: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  let lastSignature = createRuntimeSignature();
  const emitIfChanged = () => {
    const nextSignature = createRuntimeSignature();
    if (nextSignature === lastSignature) {
      return;
    }
    lastSignature = nextSignature;
    onChange();
  };

  const intervalId = window.setInterval(emitIfChanged, RUNTIME_POLL_INTERVAL_MS);
  window.addEventListener('storage', emitIfChanged);
  window.addEventListener('focus', emitIfChanged);
  window.addEventListener('visibilitychange', emitIfChanged);

  return () => {
    window.clearInterval(intervalId);
    window.removeEventListener('storage', emitIfChanged);
    window.removeEventListener('focus', emitIfChanged);
    window.removeEventListener('visibilitychange', emitIfChanged);
  };
}

export function deriveConnectionState(
  shell: ShellRuntimeData,
  activeServerId: string | 'home' | 'explore',
  hasSeenRuntime: boolean,
): ConnectionState {
  const runtimeSnapshot = shell.runtimeSnapshot;
  const sessionSnapshot = shell.sessionSnapshot;
  const localPeerId = normalizeRuntimeIdentity(runtimeSnapshot?.identity)?.peer_id ?? '';

  if (!runtimeSnapshot || !localPeerId) {
    if (hasSeenRuntime || Boolean(sessionSnapshot?.serverId)) {
      return {
        status: 'reconnecting',
        label: 'RECONNECTING',
        detail: 'Waiting for the local xorein runtime to come back online.',
        canUseConnectivityActions: false,
      };
    }
    return {
      status: 'disconnected',
      label: 'OFFLINE',
      detail: 'The local xorein runtime is unavailable.',
      canUseConnectivityActions: false,
    };
  }

  const scopedServerId = activeServerId === 'home' || activeServerId === 'explore'
    ? sessionSnapshot?.serverId ?? null
    : activeServerId;
  const scopedServer = runtimeSnapshot.servers?.find((server) => server.id === scopedServerId) ?? null;
  if (!scopedServerId || !scopedServer) {
    if (runtimeSnapshot.transport_state !== 'connected' && runtimeSnapshot.transport_state !== 'disconnected') {
      return {
        status: 'reconnecting',
        label: 'CONNECTING',
        detail: 'The local xorein runtime is ready; connecting to the xorein peer network.',
        // Local-only mutations (including creating a server) remain available;
        // operations that need another peer surface their own delivery state.
        canUseConnectivityActions: true,
      };
    }
    if (runtimeSnapshot.transport_state === 'disconnected') {
      return {
        status: 'no-relay',
        label: 'FINDING PEERS',
        detail: 'No live peer path is available yet. Peer and relay discovery is still running; durable joins and friend requests retry automatically through any path that appears.',
        canUseConnectivityActions: true,
      };
    }
    return {
      status: 'connected',
      label: 'CONNECTED',
      detail: 'Connected to the xorein peer network.',
      canUseConnectivityActions: true,
    };
  }

  const remoteMemberIds = scopedServer.members.filter((peerId) => peerId && peerId !== localPeerId);
  const isOwner = scopedServer.owner_peer_id === localPeerId;
  const hasRemoteMembers = remoteMemberIds.length > 0;
  if (runtimeSnapshot.transport_state !== 'connected' && runtimeSnapshot.transport_state !== 'disconnected') {
    return {
      status: 'reconnecting',
      label: 'CONNECTING',
      detail: `The local xorein runtime is ready; connecting to ${scopedServer.name}.`,
      canUseConnectivityActions: isOwner && !hasRemoteMembers,
    };
  }
  if (runtimeSnapshot.transport_state === 'disconnected') {
    return {
      status: 'no-relay',
      label: 'FINDING PEERS',
      detail: `No live peer path is available for ${scopedServer.name} yet. Discovery and encrypted delivery retries continue automatically.`,
      // Text and relationship mutations remain durable locally and are replayed
      // through the first authenticated path that discovery finds.
      canUseConnectivityActions: true,
    };
  }

  const knownPeers = new Map((runtimeSnapshot.known_peers ?? []).map((peer) => [peer.peer_id, peer]));
  const remotePeers = remoteMemberIds
    .map((peerId) => knownPeers.get(peerId))
    .filter((peer): peer is NonNullable<typeof peer> => Boolean(peer));
  const hasReachablePeer = remotePeers.some((peer) => (peer.addresses?.length ?? 0) > 0)
    || ((knownPeers.get(scopedServer.owner_peer_id)?.addresses?.length ?? 0) > 0);
  // A live relay reservation is one reachable path into the peer graph, regardless
  // of which independently operated relay supplied it. We key this strictly on
  // relay_addrs, which are cleared on disconnect and never restored stale on reload.
  const hasBootstrapPath = (runtimeSnapshot.relay_addrs?.length ?? 0) > 0;
  // Server owner with no other members yet can still manage the server (set up channels,
  // roles, invites). Only block connectivity actions when there are remote members
  // and none of them are reachable AND there is no bootstrap path to reach them.
  if (!hasReachablePeer && !hasBootstrapPath && !(isOwner && !hasRemoteMembers)) {
    return {
      // transport_state=connected is proof of a live authenticated edge, even
      // when the destination member is not directly connected or advertised.
      // Routed requests deliberately ask that peer graph for the next hop.
      status: 'connected',
      label: 'P2P ROUTED',
      detail: `Connected to the peer graph. Requests for ${scopedServer.name} are routed through known peers until a direct path is found.`,
      canUseConnectivityActions: true,
    };
  }

  const telemetry = runtimeSnapshot.telemetry ?? [];
  const relayTargets = [
    ...(runtimeSnapshot.relay_addrs ?? []),
    ...(scopedServer.manifest?.relay_addrs ?? []),
    ...(runtimeSnapshot.known_peers ?? [])
      .filter((peer) => peer.role === 'relay' || peer.role === 'bootstrap')
      .flatMap((peer) => peer.addresses ?? []),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  const relayFailureDetected = telemetry.some((entry) =>
    entry.includes('delivery.relay.failed')
    || entry.includes('relay fallback not configured')
    || entry.includes('relay reservation')
    || entry.includes('delivery failed on direct and relay paths'));
  if (relayFailureDetected && relayTargets.length === 0) {
    return {
      // A support-node failure is not a network failure. transport_state is
      // connected here, so at least one authenticated peer edge remains and
      // peer.route can continue asking the graph for the destination.
      status: 'connected',
      label: 'P2P ONLY',
      detail: `No support node is currently available for ${scopedServer.name}. Connected peers remain active while relay discovery and storage repair continue in the background.`,
      canUseConnectivityActions: true,
    };
  }

  return {
    status: 'connected',
    label: 'CONNECTED',
    detail: `Connected to ${scopedServer.name} through the xorein peer network.`,
    canUseConnectivityActions: true,
  };
}

export function getDefaultChannelId(serverId: string | 'home' | 'explore'): string {
  if (serverId === 'explore') {
    return '';
  }
  return shellData.defaultChannelByServer.get(serverId) ?? '';
}

export function getMessagesForScope(scopeId: string): Message[] {
  return shellData.messagesByScope.get(scopeId) ?? [];
}

function createShellRuntimeData(): ShellRuntimeData {
  const runtimeSnapshot = normalizeInjectedRuntimeSnapshot(readInjectedValue<XoreinRuntimeSnapshot>(RUNTIME_GLOBAL_KEYS, RUNTIME_STORAGE_KEYS));
  const sessionSnapshot = readInjectedValue<XoreinSessionSnapshot>(SESSION_GLOBAL_KEYS, SESSION_STORAGE_KEYS);
  const currentPeerId = normalizeRuntimeIdentity(runtimeSnapshot?.identity)?.peer_id ?? '';
  const knownPeers = new Map((runtimeSnapshot?.known_peers ?? []).map((peer) => [peer.peer_id, peer]));
  const presenceByPeer = new Map<string, XoreinPresenceEntry>(Object.entries(runtimeSnapshot?.presence ?? {}));
  const voiceSessions = new Map((runtimeSnapshot?.voice_sessions ?? []).map((session) => [session.channel_id, normalizeRuntimeVoiceSession(session)]));

  const currentUser = createCurrentUser(runtimeSnapshot, currentPeerId);
  const userMap = new Map<string, User>([[CURRENT_USER_ID, currentUser]]);

  const ensureUser = (
    peerId: string,
    options: {
      role?: string;
      fallbackName?: string;
      muted?: boolean;
      speaking?: boolean;
      video?: boolean;
      screenSharing?: boolean;
    } = {},
  ): User => {
    const userId = mapPeerIdToUserId(peerId, currentPeerId);
    const existing = userMap.get(userId);
    if (existing) {
      const merged: User = {
        ...existing,
        ...(options.role ? { role: options.role } : {}),
        ...(typeof options.muted === 'boolean' ? { muted: options.muted } : {}),
        ...(typeof options.speaking === 'boolean' ? { speaking: options.speaking } : {}),
        ...(typeof options.video === 'boolean' ? { video: options.video } : {}),
        ...(typeof options.screenSharing === 'boolean' ? { screenSharing: options.screenSharing } : {}),
      };
      userMap.set(userId, merged);
      return merged;
    }

    const peer = knownPeers.get(peerId);
    // Prefer a peer's broadcast display name/avatar (learned over presence) over
    // the synthesized fallback, so custom avatars propagate to everyone.
    const peerName = typeof peer?.display_name === 'string' ? peer.display_name.trim() : '';
    const username = userId === CURRENT_USER_ID
      ? currentUser.username
      : (options.fallbackName?.trim() || peerName || abbreviatePeerId(peerId));
    const peerAvatar = typeof peer?.avatar === 'string' ? peer.avatar.trim() : '';
    const avatar = userId === CURRENT_USER_ID
      ? currentUser.avatar
      : (peerAvatar && isSafeAvatarSource(peerAvatar) ? peerAvatar : buildAvatarDataUri(username, colorForSeed(peerId || username)));
    const nextUser: User = {
      id: userId,
      username,
      avatar,
      status: statusFromPresence(presenceByPeer.get(peerId), Boolean(options.muted)) ?? statusFromPeer(peer, Boolean(options.muted)),
      role: options.role,
      color: colorForSeed(peerId || username),
      bio: userId === CURRENT_USER_ID ? currentUser.bio : peer?.source ? `SOURCE // ${peer.source.toUpperCase()}` : undefined,
      joinedAt: formatDate(peer?.last_seen_at),
      muted: options.muted,
      speaking: options.speaking,
      video: options.video,
      screenSharing: options.screenSharing,
    };
    userMap.set(userId, nextUser);
    return nextUser;
  };

  // Deleted messages are NOT dropped: they map to content-stripped tombstones so
  // every member renders a consistent "Message deleted" row (Discord-class UX)
  // instead of the message silently vanishing on receivers.
  const mappedMessages = (runtimeSnapshot?.messages ?? [])
    .sort((left, right) => toTimestamp(left.created_at) - toTimestamp(right.created_at))
    .map((message) => mapMessage(message, currentPeerId, ensureUser));

  const messagesByScope = new Map<string, Message[]>();
  for (const message of mappedMessages) {
    const scoped = messagesByScope.get(message.scopeId) ?? [];
    scoped.push(message.message);
    messagesByScope.set(message.scopeId, scoped);
  }

  const unreadByScope = runtimeSnapshot?.unread ?? {};
  const directMessages = (runtimeSnapshot?.dms ?? [])
    .map((dm) => mapDirectMessage(dm, currentPeerId, messagesByScope, ensureUser, unreadByScope))
    .sort((left, right) => compareTimestamps(right.timestamp, left.timestamp));

  // Membership filter: a user (guest or registered) only ever sees servers they
  // created, joined, or own. A fresh guest with no memberships sees none — the
  // node's global server list never leaks into the rail.
  const joinedServerIds = new Set(runtimeSnapshot?.joined_server_ids ?? []);
  const servers = (runtimeSnapshot?.servers ?? [])
    .filter((server) =>
      (currentPeerId && server.members.includes(currentPeerId))
      || server.owner_peer_id === currentPeerId
      || joinedServerIds.has(server.id))
    .map((server) => mapServer(server, currentPeerId, voiceSessions, ensureUser, unreadByScope))
    .sort((left, right) => left.name.localeCompare(right.name));

  const defaultChannelByServer = new Map<string, string>();
  defaultChannelByServer.set('home', directMessages[0]?.id ?? '');
  defaultChannelByServer.set('explore', '');
  for (const server of servers) {
    const firstChannel = server.categories.flatMap((category) => category.channels).find((channel) => channel.type === 'text')
      ?? server.categories.flatMap((category) => category.channels)[0];
    defaultChannelByServer.set(server.id, firstChannel?.id ?? '');
  }

  const initialServerId = selectInitialServerId(sessionSnapshot, servers, directMessages);
  const initialChannelId = defaultChannelByServer.get(initialServerId) ?? '';

  return {
    runtimeSnapshot,
    sessionSnapshot,
    currentUser,
    users: [...userMap.values()].sort((left, right) => {
      if (left.id === CURRENT_USER_ID) return -1;
      if (right.id === CURRENT_USER_ID) return 1;
      return left.username.localeCompare(right.username);
    }),
    servers,
    directMessages,
    messages: mappedMessages.map((entry) => entry.message),
    messagesByScope,
    defaultChannelByServer,
    initialServerId,
    initialChannelId,
  };
}

function mapServer(
  server: XoreinRuntimeServer,
  currentPeerId: string,
  voiceSessions: Map<string, XoreinRuntimeVoiceSession>,
  ensureUser: (peerId: string, options?: { role?: string; fallbackName?: string; muted?: boolean }) => User,
  unreadByScope: Record<string, number> = {},
): Server {
  const channels = Object.values(server.channels ?? {}).sort((left, right) => toTimestamp(left.created_at) - toTimestamp(right.created_at));
  const textChannels = channels.filter((channel) => !channel.voice).map((channel) => mapChannel(channel, voiceSessions, currentPeerId, ensureUser, unreadByScope));
  const voiceChannels = channels.filter((channel) => channel.voice).map((channel) => mapChannel(channel, voiceSessions, currentPeerId, ensureUser, unreadByScope));
  const members = uniqueUsers(server.members.map((peerId) => ensureUser(peerId, {
    role: peerId === server.owner_peer_id ? 'Admin' : 'Member',
  })));

  return {
    id: server.id,
    name: server.manifest?.name?.trim() || server.name,
    icon: buildAvatarDataUri(server.name, colorForSeed(server.id)),
    ownerId: mapPeerIdToUserId(server.owner_peer_id, currentPeerId),
    members,
    description: server.manifest?.description?.trim() || server.description,
    securityMode: server.channel_security_mode === 'tree' ? 'tree' : 'crowd',
    categories: [
      ...(textChannels.length > 0 ? [{ id: `${server.id}-text`, name: 'TEXT CHANNELS', channels: textChannels }] : []),
      ...(voiceChannels.length > 0 ? [{ id: `${server.id}-voice`, name: 'VOICE CHANNELS', channels: voiceChannels }] : []),
    ],
  };
}

function mapChannel(
  channel: XoreinRuntimeChannel,
  voiceSessions: Map<string, XoreinRuntimeVoiceSession>,
  currentPeerId: string,
  ensureUser: (peerId: string, options?: { role?: string; fallbackName?: string; muted?: boolean; speaking?: boolean; video?: boolean; screenSharing?: boolean }) => User,
  unreadByScope: Record<string, number> = {},
): Channel {
  const voiceSession = voiceSessions.get(channel.id);
  const unreadCount = unreadByScope[channel.id] ?? 0;
  return {
    id: channel.id,
    name: channel.name,
    type: channel.voice ? 'voice' : 'text',
    categoryId: channel.voice ? `${channel.server_id}-voice` : `${channel.server_id}-text`,
    topic: typeof channel.topic === 'string' ? channel.topic : undefined,
    bitrate: typeof channel.bitrate === 'number' ? channel.bitrate : undefined,
    userLimit: typeof channel.user_limit === 'number' ? channel.user_limit : undefined,
    ...(unreadCount > 0 ? { unreadCount } : {}),
    activeUsers: channel.voice
      ? Object.values(voiceSession?.participants ?? {}).map((participant) => ensureUser(participant.peer_id, {
          muted: participant.muted,
          speaking: participant.speaking,
          video: participant.video,
          screenSharing: participant.screen_sharing,
        }))
      : undefined,
  };
}

function mapDirectMessage(
  dm: XoreinRuntimeDM,
  currentPeerId: string,
  messagesByScope: Map<string, Message[]>,
  ensureUser: (peerId: string, options?: { role?: string; fallbackName?: string; muted?: boolean }) => User,
  unreadByScope: Record<string, number> = {},
): DirectMessageChannel {
  const otherParticipant = dm.participants.find((peerId) => peerId !== currentPeerId) ?? dm.participants[0] ?? 'unknown';
  const user = otherParticipant === 'unknown'
    ? ensureUser(otherParticipant, { fallbackName: 'Unknown User' })
    : ensureUser(otherParticipant);
  const latestMessage = messagesByScope.get(dm.id)?.at(-1);
  const unreadCount = unreadByScope[dm.id] ?? 0;
  return {
    id: dm.id,
    userId: user.id,
    lastMessage: latestMessage?.content || 'NO MESSAGES YET',
    timestamp: latestMessage?.timestamp || formatShortTimestamp(dm.created_at),
    ...(unreadCount > 0 ? { unreadCount } : {}),
  };
}

function mapMessage(
  message: XoreinRuntimeMessage,
  currentPeerId: string,
  ensureUser: (peerId: string, options?: { role?: string; fallbackName?: string; muted?: boolean }) => User,
): { scopeId: string; message: Message } {
  ensureUser(message.sender_peer_id);
  // A deleted message becomes a content-stripped tombstone (deletedAt drives the
  // "Message deleted" row) rather than disappearing from the mapped view.
  const deleted = message.deleted === true;
  return {
    scopeId: message.scope_id,
    message: {
      id: message.id,
      userId: mapPeerIdToUserId(message.sender_peer_id, currentPeerId),
      content: deleted ? '' : message.body,
      timestamp: formatMessageTimestamp(message.created_at),
      editedAt: message.updated_at ? formatMessageTimestamp(message.updated_at) : undefined,
      replyToId: message.reply_to,
      ...(deleted ? { deletedAt: message.updated_at || message.created_at || new Date(0).toISOString() } : {}),
      ...(message.reactions && message.reactions.length > 0 ? { reactions: message.reactions } : {}),
      ...(message.media && message.media.length > 0 ? { media: message.media } : {}),
      ...(message.pinned === true ? { pinned: true } : {}),
      ...(message.delivery_status ? { delivery_status: message.delivery_status } : {}),
      ...(message.poll_votes ? { poll_votes: message.poll_votes } : {}),
      ...(message.security_mode ? { securityMode: message.security_mode } : {}),
      ...(typeof message.encrypted === 'boolean' ? { encrypted: message.encrypted } : {}),
    },
  };
}

/** Validate/keep only well-formed encrypted attachment refs. */
function normalizeAttachments(value: unknown): XoreinAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: XoreinAttachment[] = [];
  for (const a of value) {
    if (!isSafeAttachment(a)) continue;
    out.push({
      ...a,
      ...(a.swarm ? {
        swarm: {
          ...a.swarm,
          chunk_hashes: [...a.swarm.chunk_hashes],
          ...(a.swarm.provider_peer_ids
            ? { provider_peer_ids: [...a.swarm.provider_peer_ids] }
            : {}),
        },
      } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function createCurrentUser(runtimeSnapshot: XoreinRuntimeSnapshot | null, currentPeerId: string): User {
  const identity = normalizeRuntimeIdentity(runtimeSnapshot?.identity);
  const displayName = identity?.profile?.display_name?.trim() || 'Local User';
  const color = colorForSeed(currentPeerId || displayName);
  const presence = currentPeerId ? runtimeSnapshot?.presence?.[currentPeerId] : undefined;
  // Prefer the user's own chosen avatar (a data: URI on the profile) over the
  // synthesized initials avatar.
  const profileAvatar = typeof identity?.profile?.avatar === 'string' ? identity.profile.avatar.trim() : '';
  return {
    id: CURRENT_USER_ID,
    username: displayName,
    avatar: profileAvatar && isSafeAvatarSource(profileAvatar) ? profileAvatar : buildAvatarDataUri(displayName, color),
    status: presenceToUserStatus(presence?.status) ?? (identity?.peer_id ? 'online' : 'offline'),
    color,
    bio: identity?.profile?.bio?.trim() || (identity?.peer_id ? 'CONNECTED TO LOCAL XOREIN RUNTIME' : 'WAITING FOR LOCAL XOREIN RUNTIME'),
    joinedAt: formatDate(identity?.created_at),
  };
}

function statusFromPresence(presence: XoreinPresenceEntry | undefined, muted: boolean): UserStatus | null {
  if (muted) {
    return 'dnd';
  }
  if (!presence) {
    return null;
  }
  switch ((presence.status ?? '').trim()) {
    case 'online':
      return 'online';
    case 'idle':
    case 'away':
      return 'idle';
    case 'dnd':
      return 'dnd';
    case 'offline':
    case 'invisible':
      return 'offline';
    default:
      return null;
  }
}

function presenceToUserStatus(status: string | undefined): UserStatus | null {
  switch ((status ?? '').trim()) {
    case 'online':
      return 'online';
    case 'idle':
    case 'away':
      return 'idle';
    case 'dnd':
      return 'dnd';
    case 'offline':
    case 'invisible':
      return 'offline';
    default:
      return null;
  }
}

function statusFromPeer(peer: XoreinRuntimePeer | undefined, muted: boolean): UserStatus {
  if (muted) {
    return 'dnd';
  }
  if (!peer?.last_seen_at) {
    return 'offline';
  }
  const ageMs = Date.now() - toTimestamp(peer.last_seen_at);
  if (ageMs < 5 * 60_000) {
    return 'online';
  }
  if (ageMs < 30 * 60_000) {
    return 'idle';
  }
  return 'offline';
}

function mapPeerIdToUserId(peerId: string, currentPeerId: string): string {
  if (!peerId) {
    return peerId;
  }
  return peerId === currentPeerId ? CURRENT_USER_ID : peerId;
}

function selectInitialServerId(
  sessionSnapshot: XoreinSessionSnapshot | null,
  servers: Server[],
  directMessages: DirectMessageChannel[],
): string | 'home' | 'explore' {
  if (sessionSnapshot?.serverId && servers.some((server) => server.id === sessionSnapshot.serverId)) {
    return sessionSnapshot.serverId;
  }
  if (servers.length > 0) {
    return servers[0].id;
  }
  if (directMessages.length > 0) {
    return 'home';
  }
  return 'home';
}

function readInjectedValue<T>(globalKeys: readonly string[], storageKeys: readonly string[]): T | null {
  if (typeof window === 'undefined') {
    return null;
  }

  for (const key of globalKeys) {
    const value = parseMaybeJson<T>((window as unknown as Record<string, unknown>)[key]);
    if (value) {
      return value;
    }
  }

  const storages = [() => window.sessionStorage, () => window.localStorage] as const;
  for (const storage of storages) {
    for (const key of storageKeys) {
      const raw = safeStorageGet(storage, key);
      const value = parseMaybeJson<T>(raw);
      if (value) {
        return value;
      }
    }
  }

  return null;
}

function createRuntimeSignature(): string {
  const runtime = readInjectedValue<XoreinRuntimeSnapshot>(RUNTIME_GLOBAL_KEYS, RUNTIME_STORAGE_KEYS);
  const session = readInjectedValue<XoreinSessionSnapshot>(SESSION_GLOBAL_KEYS, SESSION_STORAGE_KEYS);
  return JSON.stringify({ runtime, session });
}

function parseMaybeJson<T>(value: unknown): T | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isPlainObject(parsed)) {
        return parsed as T;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (isPlainObject(value)) {
    return value as T;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeInjectedRuntimeSnapshot(value: XoreinRuntimeSnapshot | null): XoreinRuntimeSnapshot | null {
  if (!value) {
    return null;
  }
  const identity = normalizeRuntimeIdentity(value.identity);
  const role = typeof value.role === 'string' && value.role.trim() ? value.role.trim() : undefined;
  const peerId = typeof value.peer_id === 'string' && value.peer_id.trim() ? value.peer_id.trim() : undefined;
  const controlEndpoint = typeof value.control_endpoint === 'string' && value.control_endpoint.trim() ? value.control_endpoint.trim() : undefined;
  const knownPeers = normalizeRuntimePeerArray(value.known_peers);
  const servers = normalizeRuntimeServerArray(value.servers);
  const dms = normalizeRuntimeDmArray(value.dms);
  const messages = normalizeRuntimeMessageArray(value.messages);
  const friends = normalizeRuntimeFriendArray(value.friends);
  const friendRequests = normalizeRuntimeFriendArray(value.friend_requests);
  const voiceSessions = normalizeRuntimeVoiceSessionArray(value.voice_sessions);
  const presence = normalizeRuntimePresenceMap(value.presence);
  const relayAddrs = normalizeRuntimeStringArray(value.relay_addrs);
  const telemetry = normalizeRuntimeStringArray(value.telemetry);
  const settings = normalizeRuntimeStringMap(value.settings);
  const transportState = value.transport_state === 'connecting' || value.transport_state === 'connected' || value.transport_state === 'disconnected'
    ? value.transport_state
    : undefined;
  return {
    ...(role ? { role } : {}),
    ...(peerId ? { peer_id: peerId } : {}),
    ...(controlEndpoint ? { control_endpoint: controlEndpoint } : {}),
    ...(transportState ? { transport_state: transportState } : {}),
    ...(identity ? { identity } : {}),
    known_peers: knownPeers ?? [],
    servers: servers ?? [],
    joined_server_ids: normalizeRuntimeStringArray(value.joined_server_ids) ?? [],
    dms: dms ?? [],
    messages: messages ?? [],
    friends: friends ?? [],
    friend_requests: friendRequests ?? [],
    voice_sessions: voiceSessions ?? [],
    ...(presence ? { presence } : {}),
    relay_addrs: relayAddrs ?? [],
    telemetry: telemetry ?? [],
    ...(settings ? { settings } : {}),
    unread: normalizeRuntimeNumberMap(value.unread) ?? {},
  };
}

function normalizeRuntimeIdentity(value: unknown): XoreinRuntimeSnapshot['identity'] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const peerId = typeof value.peer_id === 'string' ? value.peer_id.trim() : '';
  if (!peerId) {
    return undefined;
  }
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : undefined;
  const publicKey = typeof value.public_key === 'string' && value.public_key.trim() ? value.public_key.trim() : undefined;
  const createdAt = typeof value.created_at === 'string' && value.created_at.trim() ? value.created_at.trim() : undefined;
  const profile = isPlainObject(value.profile)
    ? normalizeRuntimeIdentityProfile(value.profile)
    : undefined;

  return {
    ...(id ? { id } : {}),
    peer_id: peerId,
    ...(publicKey ? { public_key: publicKey } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(profile ? { profile } : {}),
  };
}

function normalizeRuntimeIdentityProfile(value: unknown): NonNullable<XoreinRuntimeSnapshot['identity']>['profile'] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const displayName = typeof value.display_name === 'string' && value.display_name.trim() ? value.display_name.trim() : undefined;
  const bio = typeof value.bio === 'string' && value.bio.trim() ? value.bio.trim() : undefined;
  const avatarRaw = typeof value.avatar === 'string' ? value.avatar.trim() : '';
  const avatar = avatarRaw && isSafeAvatarSource(avatarRaw) ? avatarRaw : undefined;
  return displayName || bio || avatar
    ? {
        ...(displayName ? { display_name: displayName } : {}),
        ...(bio ? { bio } : {}),
        ...(avatar ? { avatar } : {}),
      }
    : undefined;
}

function normalizeRuntimeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized.length > 0 ? normalized : [];
}

function normalizeRuntimeStringMap(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value).flatMap(([key, entry]) => {
    const normalizedKey = typeof key === 'string' ? key.trim() : '';
    const normalizedValue = typeof entry === 'string' ? entry.trim() : '';
    if (!normalizedKey || !normalizedValue) {
      return [];
    }
    return [[normalizedKey, normalizedValue] as const];
  });

  if (entries.length === 0) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      continue;
    }
    normalized[key] = entry;
  }
  return normalized;
}

function normalizeRuntimeNumberMap(value: unknown): Record<string, number> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const normalized: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const k = typeof key === 'string' ? key.trim() : '';
    const n = typeof entry === 'number' && Number.isFinite(entry) ? entry : 0;
    if (k && n > 0) normalized[k] = n;
  }
  return normalized;
}

function normalizeRuntimePeerArray(value: unknown): XoreinRuntimePeer[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: XoreinRuntimePeer[] = [];
  const seenPeerIds = new Set<string>();
  for (const entry of value) {
    if (!isRuntimePeerRecord(entry)) {
      continue;
    }
    const normalizedPeer = normalizeRuntimePeerRecord(entry);
    if (seenPeerIds.has(normalizedPeer.peer_id)) {
      continue;
    }
    seenPeerIds.add(normalizedPeer.peer_id);
    normalized.push(normalizedPeer);
  }
  return normalized.length > 0 ? normalized : [];
}

function normalizeRuntimeServerArray(value: unknown): XoreinRuntimeServer[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: XoreinRuntimeServer[] = [];
  const seenIds = new Set<string>();
  for (const server of value) {
    const normalizedServer = normalizeRuntimeServer(server);
    if (!normalizedServer || seenIds.has(normalizedServer.id)) {
      continue;
    }
    seenIds.add(normalizedServer.id);
    normalized.push(normalizedServer);
  }
  return normalized.length > 0 ? normalized : [];
}

function normalizeRuntimeDmArray(value: unknown): XoreinRuntimeDM[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: XoreinRuntimeDM[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!isRuntimeDmRecord(entry)) {
      continue;
    }
    const dm = normalizeRuntimeDm(entry);
    if (seenIds.has(dm.id)) {
      continue;
    }
    seenIds.add(dm.id);
    normalized.push(dm);
  }
  return normalized.length > 0 ? normalized : [];
}

function normalizeRuntimeMessageArray(value: unknown): XoreinRuntimeMessage[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: XoreinRuntimeMessage[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!isRuntimeMessageRecord(entry)) {
      continue;
    }
    const message = normalizeRuntimeMessage(entry);
    if (seenIds.has(message.id)) {
      continue;
    }
    seenIds.add(message.id);
    normalized.push(message);
  }
  return normalized.length > 0 ? normalized : [];
}

function normalizeRuntimeFriendArray(value: unknown): XoreinFriendRecord[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.flatMap((entry) => {
    const record = normalizeRuntimeFriendRecord(entry);
    return record ? [record] : [];
  });
  if (normalized.length === 0) {
    return [];
  }
  const deduped: XoreinFriendRecord[] = [];
  const seenIds = new Set<string>();
  for (const record of normalized) {
    if (seenIds.has(record.id)) {
      continue;
    }
    seenIds.add(record.id);
    deduped.push(record);
  }
  return deduped;
}

function normalizeRuntimeMessage(value: unknown): XoreinRuntimeMessage {
  if (!isRuntimeMessageRecord(value)) {
    throw new TypeError("runtime message record was expected");
  }
  const id = value.id.trim();
  const scopeType = value.scope_type.trim();
  const scopeId = value.scope_id.trim();
  const senderPeerId = value.sender_peer_id.trim();
  const body = value.body.trim();
  const serverId = typeof value.server_id === 'string' && value.server_id.trim() ? value.server_id.trim() : undefined;
  const replyTo = typeof value.reply_to === 'string' && value.reply_to.trim() ? value.reply_to.trim() : undefined;
  const forwardedFrom = typeof value.forwarded_from === 'string' && value.forwarded_from.trim() ? value.forwarded_from.trim() : undefined;
  const createdAt = typeof value.created_at === 'string' && value.created_at.trim() ? value.created_at.trim() : undefined;
  const updatedAt = typeof value.updated_at === 'string' && value.updated_at.trim() ? value.updated_at.trim() : undefined;
  const deleted = typeof value.deleted === 'boolean' ? value.deleted : undefined;
  const reactions = Array.isArray(value.reactions)
    ? value.reactions.filter((r): r is { emoji: string; count: number; reacted: boolean } =>
        !!r && typeof r === 'object' && typeof (r as { emoji?: unknown }).emoji === 'string'
        && typeof (r as { count?: unknown }).count === 'number')
      .map((r) => ({ emoji: r.emoji, count: r.count, reacted: (r as { reacted?: unknown }).reacted === true }))
    : undefined;
  // Fields below are re-read by mapMessage(). Dropping any of them here silently
  // reverts live state on the next merge tick: `pinned` un-pins, `poll_votes`
  // hides other people's votes, and — worst — losing `security_mode`/`encrypted`
  // strips a message's provenance, which the badge reads as unknown and reports
  // as UNENCRYPTED. Keep this list in sync with mapMessage.
  const raw = value as unknown as Record<string, unknown>;
  const pinned = typeof raw.pinned === 'boolean' ? raw.pinned : undefined;
  const deliveryStatus = typeof raw.delivery_status === 'string' ? raw.delivery_status : undefined;
  const securityMode = raw.security_mode === 'seal' || raw.security_mode === 'tree' || raw.security_mode === 'crowd' || raw.security_mode === 'clear'
    ? raw.security_mode
    : undefined;
  const encrypted = typeof raw.encrypted === 'boolean' ? raw.encrypted : undefined;
  const pollVotes = normalizeRuntimePollVotes(raw.poll_votes);
  return {
    id,
    scope_type: scopeType,
    scope_id: scopeId,
    sender_peer_id: senderPeerId,
    body,
    ...(serverId ? { server_id: serverId } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(forwardedFrom ? { forwarded_from: forwardedFrom } : {}),
    ...(reactions && reactions.length > 0 ? { reactions } : {}),
    ...(normalizeAttachments((value as { media?: unknown }).media) ? { media: normalizeAttachments((value as { media?: unknown }).media) } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(deleted !== undefined ? { deleted } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
    ...(deliveryStatus ? { delivery_status: deliveryStatus as XoreinRuntimeMessage['delivery_status'] } : {}),
    ...(securityMode ? { security_mode: securityMode } : {}),
    ...(encrypted !== undefined ? { encrypted } : {}),
    ...(pollVotes ? { poll_votes: pollVotes } : {}),
  };
}

/** Poll votes as `{ optionIndex: [peerId, ...] }`, dropping malformed entries. */
function normalizeRuntimePollVotes(value: unknown): Record<number, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<number, string[]> = {};
  let any = false;
  for (const [key, voters] of Object.entries(value as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(voters)) continue;
    const peers = voters.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    if (!peers.length) continue;
    out[index] = peers;
    any = true;
  }
  return any ? out : undefined;
}

function normalizeRuntimeVoiceSessionArray(value: unknown): XoreinRuntimeVoiceSession[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: XoreinRuntimeVoiceSession[] = [];
  const seenChannelIds = new Set<string>();
  for (const entry of value) {
    const session = normalizeRuntimeVoiceSession(entry);
    if (!session || seenChannelIds.has(session.channel_id)) {
      continue;
    }
    seenChannelIds.add(session.channel_id);
    normalized.push(session);
  }
  return normalized.length > 0 ? normalized : [];
}

function normalizeRuntimeDm(value: unknown): XoreinRuntimeDM {
  if (!isRuntimeDmRecord(value)) {
    throw new TypeError("runtime dm record was expected");
  }
  const id = value.id.trim();
  const participants = uniqueStrings(value.participants);
  const createdAt = typeof value.created_at === 'string' && value.created_at.trim() ? value.created_at.trim() : undefined;
  return {
    id,
    participants,
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

function normalizeRuntimeVoiceSession(value: unknown): XoreinRuntimeVoiceSession | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const channelId = typeof value.channel_id === 'string' && value.channel_id.trim()
    ? value.channel_id.trim()
    : typeof value.id === 'string' && value.id.trim()
      ? value.id.trim()
      : '';
  if (!channelId) {
    return undefined;
  }
  const participants = normalizeRuntimeVoiceParticipantMap(value.participants);
  return {
    channel_id: channelId,
    participants,
  };
}

function normalizeRuntimeVoiceParticipantMap(value: unknown): Record<string, XoreinRuntimeVoiceParticipant> {
  if (Array.isArray(value)) {
    const normalized: Record<string, XoreinRuntimeVoiceParticipant> = {};
    for (const entry of value) {
      if (!isPlainObject(entry) || typeof entry.peer_id !== 'string' || !entry.peer_id.trim()) {
        continue;
      }
      const peerId = entry.peer_id.trim();
      if (Object.prototype.hasOwnProperty.call(normalized, peerId)) {
        continue;
      }
      normalized[peerId] = normalizeRuntimeVoiceParticipant(entry, peerId);
    }
    return normalized;
  }
  if (!isPlainObject(value)) {
    return {};
  }
  const normalized: Record<string, XoreinRuntimeVoiceParticipant> = {};
  for (const [peerId, entry] of Object.entries(value)) {
    const normalizedPeerId = typeof peerId === 'string' ? peerId.trim() : '';
    if (!normalizedPeerId || (isPlainObject(entry) && typeof entry.peer_id === 'string' && entry.peer_id.trim() && entry.peer_id.trim() !== normalizedPeerId)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, normalizedPeerId)) {
      continue;
    }
    normalized[normalizedPeerId] = normalizeRuntimeVoiceParticipant(entry, normalizedPeerId);
  }
  return normalized;
}

function normalizeRuntimeVoiceParticipant(value: unknown, fallbackPeerId: string): XoreinRuntimeVoiceParticipant {
  const peerId = isPlainObject(value) && typeof value.peer_id === 'string' && value.peer_id.trim() ? value.peer_id.trim() : fallbackPeerId;
  return {
    peer_id: peerId,
    ...(isPlainObject(value) && typeof value.muted === 'boolean' ? { muted: value.muted } : {}),
    ...(isPlainObject(value) && typeof value.joined_at === 'string' && value.joined_at.trim() ? { joined_at: value.joined_at.trim() } : {}),
    ...(isPlainObject(value) && typeof value.last_frame_at === 'string' && value.last_frame_at.trim() ? { last_frame_at: value.last_frame_at.trim() } : {}),
  };
}

function normalizeRuntimePresenceMap(value: unknown): Record<string, XoreinPresenceEntry> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const normalizedEntries = Object.entries(value).flatMap(([peerId, entry]) => {
    const normalizedPeerId = typeof peerId === 'string' ? peerId.trim() : '';
    if (!normalizedPeerId || !isRuntimePresenceRecord(entry)) {
      return [];
    }
    return [[normalizedPeerId, entry] as const];
  });
  if (normalizedEntries.length === 0) {
    return undefined;
  }
  const normalized: Record<string, XoreinPresenceEntry> = {};
  for (const [peerId, entry] of normalizedEntries) {
    if (Object.prototype.hasOwnProperty.call(normalized, peerId)) {
      continue;
    }
    normalized[peerId] = entry;
  }
  return normalized;
}

function normalizeRuntimeServer(server: unknown): XoreinRuntimeServer | undefined {
  if (!isPlainObject(server)) {
    return undefined;
  }
  const id = typeof server.id === 'string' ? server.id.trim() : '';
  const name = typeof server.name === 'string' ? server.name.trim() : '';
  const ownerPeerId = typeof server.owner_peer_id === 'string' ? server.owner_peer_id.trim() : '';
  if (!id || !name || !ownerPeerId || !Array.isArray(server.members) || !isPlainObject(server.channels ?? {})) {
    return undefined;
  }
  const manifest = normalizeRuntimeManifest(server.manifest);
  const description = typeof server.description === 'string' && server.description.trim() ? server.description.trim() : undefined;
  const normalizedChannels = Object.values(server.channels ?? {}).flatMap((channel) => {
    const normalizedChannel = normalizeRuntimeChannel(channel, id);
    return normalizedChannel ? [normalizedChannel] : [];
  });
  const normalizedChannelIds = new Set<string>();
  for (const channel of normalizedChannels) {
    if (normalizedChannelIds.has(channel.id)) {
      return undefined;
    }
    normalizedChannelIds.add(channel.id);
  }
  const members = uniqueStrings(server.members.map((member) => typeof member === 'string' ? member.trim() : ''));
  if (members.length === 0) {
    return undefined;
  }
  const normalizedServer: XoreinRuntimeServer = {
    id,
    name,
    description,
    owner_peer_id: ownerPeerId,
    members,
    channels: normalizedChannels.reduce<Record<string, XoreinRuntimeChannel>>((accumulator, channel) => {
      if (!Object.prototype.hasOwnProperty.call(accumulator, channel.id)) {
        accumulator[channel.id] = channel;
      }
      return accumulator;
    }, {}),
    ...(typeof server.created_at === 'string' && server.created_at.trim() ? { created_at: server.created_at.trim() } : {}),
    ...(typeof server.updated_at === 'string' && server.updated_at.trim() ? { updated_at: server.updated_at.trim() } : {}),
    ...(manifest ? { manifest } : {}),
    ...(server.channel_security_mode === 'tree' || server.channel_security_mode === 'crowd'
      ? { channel_security_mode: server.channel_security_mode }
      : {}),
  };
  return normalizedServer;
}

function normalizeRuntimeChannel(value: unknown, serverId: string): XoreinRuntimeChannel | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const channelServerId = typeof value.server_id === 'string' ? value.server_id.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!id || !channelServerId || channelServerId !== serverId || !name || typeof value.voice !== 'boolean') {
    return undefined;
  }
  const createdAt = typeof value.created_at === 'string' && value.created_at.trim() ? value.created_at.trim() : undefined;
  // Channel kind is owner-authoritative server structure that propagates P2P like
  // a rename; dropping it here made a switch to Announce/Forum invisible to every
  // client (including the one that made it) and lost on reload. Same for the
  // topic/bitrate/user_limit settings.
  const kind = value.kind === 'text' || value.kind === 'forum' || value.kind === 'announcement'
    ? value.kind
    : undefined;
  const topic = typeof value.topic === 'string' && value.topic.trim() ? value.topic.trim() : undefined;
  const bitrate = typeof value.bitrate === 'number' && Number.isFinite(value.bitrate) ? value.bitrate : undefined;
  const userLimit = typeof value.user_limit === 'number' && Number.isFinite(value.user_limit) ? value.user_limit : undefined;
  return {
    id,
    server_id: channelServerId,
    name,
    voice: value.voice,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(kind ? { kind } : {}),
    ...(topic ? { topic } : {}),
    ...(bitrate !== undefined ? { bitrate } : {}),
    ...(userLimit !== undefined ? { user_limit: userLimit } : {}),
  };
}

function normalizeRuntimeManifest(value: unknown): XoreinRuntimeServer['manifest'] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : undefined;
  const description = typeof value.description === 'string' && value.description.trim() ? value.description.trim() : undefined;
  const ownerAddresses = normalizeRuntimeStringArray(value.owner_addresses);
  const bootstrapAddrs = normalizeRuntimeStringArray(value.bootstrap_addrs);
  const relayAddrs = normalizeRuntimeStringArray(value.relay_addrs);
  const capabilities = normalizeRuntimeStringArray(value.capabilities);
  const securityMode = value.security_mode === 'tree' || value.security_mode === 'crowd'
    ? value.security_mode
    : undefined;
  const historyCoverage = typeof value.history_coverage === 'string' && value.history_coverage.trim() ? value.history_coverage.trim() : undefined;
  const historyRetentionMessages = typeof value.history_retention_messages === 'number' && Number.isFinite(value.history_retention_messages)
    ? value.history_retention_messages
    : undefined;

  const joinHistoryMessages = typeof value.join_history_messages === 'number' && Number.isFinite(value.join_history_messages)
    ? value.join_history_messages
    : undefined;

  if (!name && !description && !ownerAddresses && !bootstrapAddrs && !relayAddrs && !capabilities
    && !securityMode && !historyCoverage && historyRetentionMessages === undefined
    && joinHistoryMessages === undefined) {
    return undefined;
  }

  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(ownerAddresses ? { owner_addresses: ownerAddresses } : {}),
    ...(bootstrapAddrs ? { bootstrap_addrs: bootstrapAddrs } : {}),
    ...(relayAddrs ? { relay_addrs: relayAddrs } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(securityMode ? { security_mode: securityMode } : {}),
    ...(historyCoverage ? { history_coverage: historyCoverage } : {}),
    ...(historyRetentionMessages !== undefined ? { history_retention_messages: historyRetentionMessages } : {}),
    ...(joinHistoryMessages !== undefined ? { join_history_messages: joinHistoryMessages } : {}),
  };
}

function isRuntimePeerRecord(value: unknown): value is XoreinRuntimePeer {
  return isPlainObject(value)
    && typeof value.peer_id === 'string'
    && value.peer_id.trim().length > 0
    && (
      value.addresses === undefined
      || (
        Array.isArray(value.addresses)
        && value.addresses.every((address) => typeof address === 'string' && address.trim().length > 0)
      )
    );
}

function normalizeRuntimePeerRecord(value: XoreinRuntimePeer): XoreinRuntimePeer {
  const peerId = value.peer_id.trim();
  const role = typeof value.role === 'string' && value.role.trim() ? value.role.trim() : undefined;
  const publicKey = typeof value.public_key === 'string' && value.public_key.trim() ? value.public_key.trim() : undefined;
  const source = typeof value.source === 'string' && value.source.trim() ? value.source.trim() : undefined;
  const lastSeenAt = typeof value.last_seen_at === 'string' && value.last_seen_at.trim() ? value.last_seen_at.trim() : undefined;
  const addresses = Array.isArray(value.addresses)
    ? uniqueStrings(value.addresses.map((address) => address.trim()))
    : undefined;
  const displayName = typeof value.display_name === 'string' && value.display_name.trim() ? value.display_name.trim() : undefined;
  const avatarRaw = typeof value.avatar === 'string' ? value.avatar.trim() : '';
  const avatar = avatarRaw && isSafeAvatarSource(avatarRaw) ? avatarRaw : undefined;
  return {
    peer_id: peerId,
    ...(role ? { role } : {}),
    ...(addresses !== undefined ? { addresses } : {}),
    ...(publicKey ? { public_key: publicKey } : {}),
    ...(source ? { source } : {}),
    ...(lastSeenAt ? { last_seen_at: lastSeenAt } : {}),
    ...(displayName ? { display_name: displayName } : {}),
    ...(avatar ? { avatar } : {}),
  };
}

function isRuntimeServerRecord(value: unknown): value is XoreinRuntimeServer {
  if (!isPlainObject(value)
    || typeof value.id !== 'string'
    || value.id.trim().length === 0
    || typeof value.name !== 'string'
    || value.name.trim().length === 0
    || typeof value.owner_peer_id !== 'string'
    || value.owner_peer_id.trim().length === 0
    || !Array.isArray(value.members)
    || !isPlainObject(value.channels ?? {})) {
    return false;
  }

  for (const member of value.members) {
    if (typeof member !== 'string' || !member.trim()) {
      return false;
    }
  }

  for (const channel of Object.values(value.channels ?? {})) {
    if (!isRuntimeChannelRecord(channel, value.id)) {
      return false;
    }
  }

  return true;
}

function isRuntimeChannelRecord(value: unknown, serverId: string): value is XoreinRuntimeChannel {
  return isPlainObject(value)
    && typeof value.id === 'string'
    && value.id.trim().length > 0
    && typeof value.server_id === 'string'
    && value.server_id === serverId
    && typeof value.name === 'string'
    && value.name.trim().length > 0
    && typeof value.voice === 'boolean';
}

function isRuntimeDmRecord(value: unknown): value is XoreinRuntimeDM {
  return isPlainObject(value)
    && typeof value.id === 'string'
    && value.id.trim().length > 0
    && Array.isArray(value.participants)
    && value.participants.every((participant) => typeof participant === 'string' && participant.trim().length > 0);
}

function isRuntimeMessageRecord(value: unknown): value is XoreinRuntimeMessage {
  return isPlainObject(value)
    && typeof value.id === 'string'
    && value.id.trim().length > 0
    && typeof value.scope_type === 'string'
    && value.scope_type.trim().length > 0
    && typeof value.scope_id === 'string'
    && value.scope_id.trim().length > 0
    && typeof value.sender_peer_id === 'string'
    && value.sender_peer_id.trim().length > 0
    && typeof value.body === 'string'
    && value.body.trim().length > 0
    && (value.deleted === undefined || typeof value.deleted === 'boolean');
}

function normalizeRuntimeFriendRecord(value: unknown): XoreinFriendRecord | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
  const fromPeerId = typeof value.from_peer_id === 'string' && value.from_peer_id.trim() ? value.from_peer_id.trim() : '';
  const status = typeof value.status === 'string' && value.status.trim() ? value.status.trim() : '';
  if (!id || !fromPeerId || !status || !isFriendStatus(status)) {
    return undefined;
  }
  const toPeerId = typeof value.to_peer_id === 'string' && value.to_peer_id.trim() ? value.to_peer_id.trim() : undefined;
  const toPeerAddr = typeof value.to_peer_addr === 'string' && value.to_peer_addr.trim() ? value.to_peer_addr.trim() : undefined;
  const createdAt = typeof value.created_at === 'string' && value.created_at.trim() ? value.created_at.trim() : undefined;
  return {
    id,
    from_peer_id: fromPeerId,
    status,
    ...(toPeerId ? { to_peer_id: toPeerId } : {}),
    ...(toPeerAddr ? { to_peer_addr: toPeerAddr } : {}),
    ...(value.delivery_status === 'pending' || value.delivery_status === 'sent' || value.delivery_status === 'queued' || value.delivery_status === 'failed'
      ? { delivery_status: value.delivery_status }
      : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

function isFriendStatus(status: string): status is XoreinFriendRecord['status'] {
  return ['pending', 'accepted', 'declined', 'cancelled', 'blocked'].includes(status);
}

function isRuntimeVoiceSessionRecord(value: unknown): value is XoreinRuntimeVoiceSession {
  return isPlainObject(value)
    && (typeof value.channel_id === 'string' || typeof value.id === 'string')
    && (value.participants === undefined || Array.isArray(value.participants) || isPlainObject(value.participants));
}

function isRuntimePresenceRecord(value: unknown): value is XoreinPresenceEntry {
  return isPlainObject(value)
    && typeof value.status === 'string'
    && typeof value.updated_at === 'string';
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return values
    .map((value) => value?.trim() ?? '')
    .filter((value, index, all) => value && all.indexOf(value) === index);
}

function uniqueUsers(users: User[]): User[] {
  const seen = new Map<string, User>();
  for (const user of users) {
    seen.set(user.id, user);
  }
  return [...seen.values()];
}

function abbreviatePeerId(peerId: string): string {
  if (!peerId) {
    return 'Unknown Peer';
  }
  return peerId.length <= 12 ? peerId : `${peerId.slice(0, 6)}…${peerId.slice(-4)}`;
}

function formatMessageTimestamp(value?: string): string {
  const timestamp = toTimestamp(value);
  if (!timestamp) {
    return '--:--';
  }
  return formatDateTime(new Date(timestamp), {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatShortTimestamp(value?: string): string {
  const timestamp = toTimestamp(value);
  if (!timestamp) {
    return '';
  }
  const deltaMinutes = Math.round((Date.now() - timestamp) / 60_000);
  if (deltaMinutes < 1) {
    return 'NOW';
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}M`;
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}H`;
  }
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}D`;
}

function formatDate(value?: string): string | undefined {
  const timestamp = toTimestamp(value);
  if (!timestamp) {
    return undefined;
  }
  return formatDateTime(new Date(timestamp), {
    month: 'short',
    year: 'numeric',
  }).toUpperCase();
}

function compareTimestamps(left?: string, right?: string): number {
  return toTimestamp(left) - toTimestamp(right);
}

function toTimestamp(value?: string): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function colorForSeed(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 72% 58%)`;
}

function buildAvatarDataUri(label: string, background: string): string {
  const initials = label
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="${background}"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#05070D" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="700">${escapeSvgText(initials)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
