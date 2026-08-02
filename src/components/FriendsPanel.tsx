import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { User, UserStatus, XoreinFriendRecord } from '@/types';
import { USERS } from '@/data';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';
import { useRuntimeMutations } from '@/hooks/runtime/useRuntimeMutations';
import { PendingButton } from '@/components/ui/PendingButton';
import { Search, MessageSquare, X, UserPlus, Users, UserX, Clock, Check, Ban, Copy, RotateCcw } from 'lucide-react';
import { useFeature } from '@/hooks/useFeature';
import { MessageRequests } from '@/components/MessageRequests';
import { resolveAvatarSrc } from '@/lib/avatar';
import { copyTextToClipboardSafely } from '@/components/contextMenuUtils';
import { type MessageRequest } from '@/components/messageRequestsData';

type FriendsTab = 'online' | 'all' | 'pending' | 'blocked' | 'requests';

/** A resolved friend row: base user plus the peer's broadcast custom status. */
type FriendUser = User & { statusText?: string };

interface FriendRequest {
  recordId: string;
  userId: string;
  type: 'incoming' | 'outgoing';
  deliveryStatus?: XoreinFriendRecord['delivery_status'];
  timestamp: string;
  expiresAt?: string;
}

interface FeedbackState {
  tone: 'error' | 'info' | 'success';
  message: string;
}

function friendPeerId(record: XoreinFriendRecord, currentPeerId: string): string {
  return record.from_peer_id === currentPeerId
    ? (record.to_peer_id ?? peerIdFromFriendInput(record.to_peer_addr ?? ''))
    : record.from_peer_id;
}

/** Extract a case-sensitive libp2p peer id from a pasted ID or a multiaddr. */
function peerIdFromFriendInput(value: string): string {
  const trimmed = value.trim();
  const match = /\/p2p\/([^/\s]+)$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function requestIsExpired(record: Pick<XoreinFriendRecord, 'created_at' | 'expires_at'>): boolean {
  const advertisedExpiry = Date.parse(record.expires_at ?? '');
  if (Number.isFinite(advertisedExpiry)) {
    return advertisedExpiry <= Date.now();
  }
  const createdAt = Date.parse(record.created_at ?? '');
  return !Number.isFinite(createdAt) || createdAt <= Date.now() - 7 * 24 * 60 * 60 * 1000;
}

const getStatusColor = (status: UserStatus) => {
  switch (status) {
    case 'online': return 'bg-accent-success shadow-[0_0_5px_#05FFA1]';
    case 'idle': return 'bg-accent-warning shadow-[0_0_5px_#FFB020]';
    case 'dnd': return 'bg-accent-danger shadow-[0_0_5px_#FF2A6D]';
    default: return 'bg-white/20';
  }
};

const getStatusLabel = (status: UserStatus) => {
  switch (status) {
    case 'online': return 'ONLINE';
    case 'idle': return 'IDLE';
    case 'dnd': return 'DO NOT DISTURB';
    default: return 'OFFLINE';
  }
};

interface FriendsPanelProps {
  onOpenDM: (userId: string) => { ok: boolean; message?: string };
  hasIdentity?: boolean;
  onOpenAuth?: () => void;
}

export const FriendsPanel: React.FC<FriendsPanelProps> = ({ onOpenDM, hasIdentity = false, onOpenAuth }) => {
  const runtimeSnapshot = useRuntimeSnapshot();
  // Open straight to Pending when an incoming request is waiting, so accepting a
  // friend is two clicks (open Friends → Accept) rather than buried behind a tab.
  const [activeTab, setActiveTab] = useState<FriendsTab>(() => {
    const reqs = Array.isArray(runtimeSnapshot?.friend_requests) ? runtimeSnapshot.friend_requests : [];
    const me = runtimeSnapshot?.peer_id ?? runtimeSnapshot?.identity?.peer_id ?? '';
    return reqs.some((r) => r.status === 'pending' && r.from_peer_id && r.from_peer_id !== me) ? 'pending' : 'online';
  });
  const hasMessageRequests = useFeature('messageRequests');
  const [searchQuery, setSearchQuery] = useState('');
  const [addFriendInput, setAddFriendInput] = useState('');
  const [addFriendPending, setAddFriendPending] = useState(false);
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedStaticUsers = useMemo(() => normalizeFriendsUsers(USERS), []);
  // Friend ops route through the mutation facade so they hit the native P2P engine
  // (delivering request/accept to the other peer) rather than the HTTP support node.
  const mutations = useRuntimeMutations();

  // Keyboard shortcut to focus the search input: "/" (when not already typing
  // in a field) or Ctrl/Cmd+F, matching the search affordance in other panels.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typingInField = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      const isSlash = event.key === '/' && !typingInField && !event.metaKey && !event.ctrlKey && !event.altKey;
      const isCtrlF = event.key.toLowerCase() === 'f' && (event.metaKey || event.ctrlKey);
      if (isSlash || isCtrlF) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const currentPeerId = runtimeSnapshot?.peer_id ?? runtimeSnapshot?.identity?.peer_id ?? '';

  const acceptedRecords = useMemo(() => {
    const records = Array.isArray(runtimeSnapshot?.friends) ? runtimeSnapshot.friends : [];
    return records.filter((r) => r.status === 'accepted');
  }, [runtimeSnapshot?.friends]);

  const blockedRecords = useMemo(() => {
    const records = Array.isArray(runtimeSnapshot?.friends) ? runtimeSnapshot.friends : [];
    return records.filter((r) => r.status === 'blocked');
  }, [runtimeSnapshot?.friends]);

  const pendingRecords = useMemo(() => {
    const records = Array.isArray(runtimeSnapshot?.friend_requests) ? runtimeSnapshot.friend_requests : [];
    return records.filter((r) => r.status === 'pending');
  }, [runtimeSnapshot?.friend_requests]);

  const friendIdSet = useMemo(
    () => new Set(acceptedRecords.map((r) => friendPeerId(r, currentPeerId)).filter(Boolean)),
    [acceptedRecords, currentPeerId],
  );

  const friendRequests = useMemo<FriendRequest[]>(
    () => pendingRecords.map((r) => ({
      recordId: r.id,
      userId: friendPeerId(r, currentPeerId),
      type: r.from_peer_id === currentPeerId ? 'outgoing' : 'incoming',
      ...(r.delivery_status ? { deliveryStatus: r.delivery_status } : {}),
      timestamp: r.created_at ?? '',
      ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
    })),
    [pendingRecords, currentPeerId],
  );

  const blockedUsers = useMemo(
    () => blockedRecords.map((r) => friendPeerId(r, currentPeerId)).filter(Boolean),
    [blockedRecords, currentPeerId],
  );

  const messageRequests: MessageRequest[] = [];

  const runtimePeers = useMemo(() => {
    const peers = Array.isArray(runtimeSnapshot?.known_peers) ? runtimeSnapshot.known_peers : [];
    return new Map(
      peers
        .filter((peer): peer is RuntimePeerRecord => isPeerRecord(peer))
        .map((peer) => [peer.peer_id, peer]),
    );
  }, [runtimeSnapshot]);
  const runtimePresence = useMemo(() => {
    const presence = runtimeSnapshot?.presence;
    if (!isPlainObject(presence)) {
      return new Map<string, RuntimePresenceRecord>();
    }

    return new Map(
      Object.entries(presence)
        .filter((entry): entry is [string, RuntimePresenceRecord] => {
          const [peerId, value] = entry;
          return typeof peerId === 'string' && isPresenceRecord(value);
        }),
    );
  }, [runtimeSnapshot]);

  const resolveUser = (userId: string): FriendUser => {
    const staticUser = normalizedStaticUsers.find((user) => user.id === userId);
    const peer = runtimePeers.get(userId);
    const presence = runtimePresence.get(userId);
    const runtimeStatus = presence ? (presence.status === 'idle' || presence.status === 'dnd' || presence.status === 'offline' ? presence.status : 'online') : undefined;
    const statusText = typeof presence?.status_text === 'string' && presence.status_text.trim() ? presence.status_text.trim() : undefined;
    if (staticUser) {
      return {
        ...staticUser,
        status: runtimeStatus ?? staticUser.status,
        statusText,
      };
    }

    // Resolve the peer's broadcast display name (carried on friend-request/accept
    // payloads and presence, upserted into known_peers); fall back to the raw
    // peer id only when no name was ever learned.
    const displayName = typeof peer?.display_name === 'string' && peer.display_name.trim() ? peer.display_name.trim() : '';
    return {
      id: userId,
      username: displayName || userId,
      avatar: resolveAvatarSrc(peer?.avatar, displayName || userId),
      status: (runtimeStatus as UserStatus) ?? 'offline',
      role: peer?.role,
      bio: peer?.source ? `SOURCE // ${peer.source.toUpperCase()}` : undefined,
      statusText,
    };
  };

  // Union accepted friends with peers we hold live presence for, but NEVER the
  // local identity itself — your own presence entry must not render you as a
  // friend row (self-inflated counts + a "Message yourself" affordance).
  const visibleFriendIds = Array.from(new Set([...Array.from(friendIdSet), ...runtimePresence.keys()]))
    .filter((userId) => userId && userId !== currentPeerId);
  const allFriends = visibleFriendIds
    .map((userId) => resolveUser(userId))
    .filter((user) => !blockedUsers.includes(user.id));
  const onlineFriends = allFriends.filter((user) => user.status === 'online' || user.status === 'idle' || user.status === 'dnd');
  const pendingRequests = friendRequests;
  const blocked = blockedUsers.map((userId) => resolveUser(userId));

  const tabs: { key: FriendsTab; label: string; count?: number }[] = [
    { key: 'online', label: 'ONLINE', count: onlineFriends.length },
    { key: 'all', label: 'ALL', count: allFriends.length },
    { key: 'pending', label: 'PENDING', count: pendingRequests.length },
    { key: 'blocked', label: 'BLOCKED', count: blocked.length },
    ...(hasMessageRequests ? [{ key: 'requests' as FriendsTab, label: 'REQUESTS', count: messageRequests.length }] : []),
  ];

  const filterUsers = (users: FriendUser[]) => {
    if (!searchQuery.trim()) return users;
    return users.filter((user) => user.username.toLowerCase().includes(searchQuery.toLowerCase()));
  };

  const acceptRequest = async (recordId: string) => {
    try {
      await mutations.acceptFriend(recordId);
      setFeedback({ tone: 'success', message: 'Friend request accepted.' });
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to accept friend request.' });
    }
  };

  const declineRequest = async (recordId: string) => {
    try {
      await mutations.declineFriend(recordId);
      setFeedback({ tone: 'info', message: 'Friend request declined.' });
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to decline friend request.' });
    }
  };

  const cancelRequest = async (recordId: string) => {
    try {
      await mutations.actOnFriendRequest(recordId, 'cancel');
      setFeedback({ tone: 'info', message: 'Friend request cancelled.' });
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to cancel friend request.' });
    }
  };

  const retryRequest = async (recordId: string) => {
    try {
      await mutations.retryFriendRequest(recordId);
      setFeedback({ tone: 'info', message: 'Friend request delivery retried.' });
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to retry friend request.' });
    }
  };

  const unblockUser = async (peerId: string) => {
    if (!runtimeSnapshot) return;
    const record = blockedRecords.find((r) => friendPeerId(r, currentPeerId) === peerId);
    if (!record) return;
    try {
      await mutations.removeFriend(record.id);
      setFeedback({ tone: 'success', message: 'User unblocked.' });
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to unblock user.' });
    }
  };

  const handleAddFriend = async () => {
    if (!hasIdentity) {
      onOpenAuth?.();
      return;
    }
    const normalized = addFriendInput.trim();
    if (!normalized) {
      setFeedback({ tone: 'error', message: 'Enter a peer ID or multiaddr before sending a friend request.' });
      return;
    }

    if (!runtimeSnapshot) {
      setFeedback({ tone: 'error', message: 'Start the local xorein runtime before sending friend requests.' });
      return;
    }

    const targetPeerId = peerIdFromFriendInput(normalized);
    const duplicate = friendRequests.find((request) => request.userId === targetPeerId);
    // A queued/failed request can be deliberately re-sent using its stable id.
    // Let the native lifecycle retry it instead of creating a competing request.
    // A seven-day stale row is also allowed through; the native store prunes it
    // before accepting the new request.
    if (duplicate && !['queued', 'failed'].includes(duplicate.deliveryStatus ?? '') && !requestIsExpired({
      created_at: duplicate.timestamp,
      expires_at: duplicate.expiresAt,
    })) {
      setFeedback({ tone: 'info', message: 'A pending friend request already exists for that peer.' });
      return;
    }

    setAddFriendPending(true);
    try {
      const result = await mutations.sendFriendRequest(normalized);
      const deliveryStatus = result && typeof result === 'object' && 'delivery_status' in result
        ? (result as { delivery_status?: string }).delivery_status
        : undefined;
      setAddFriendInput('');
      setActiveTab('pending');
      setFeedback({
        tone: deliveryStatus === 'queued' ? 'info' : 'success',
        message: deliveryStatus === 'queued'
          ? 'Saved locally. Harmolyn will retry automatically when any peer path is available.'
          : 'Friend request sent.',
      });
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'Unable to send friend request.' });
    } finally {
      setAddFriendPending(false);
    }
  };

  const handleOpenDirectMessage = (user: User) => {
    const result = onOpenDM(user.id);
    if (result.ok) {
      setFeedback({ tone: 'success', message: `Opened the direct message with ${user.username}.` });
      return;
    }
    setFeedback({ tone: 'info', message: result.message || `Direct messages with ${user.username} are unavailable right now.` });
  };

  const handleAcceptMessageRequest = (_id: string) => {
    setFeedback({ tone: 'info', message: 'Message request handling is not available yet.' });
  };

  const handleIgnoreMessageRequest = (_id: string) => {
    setFeedback({ tone: 'info', message: 'Message request handling is not available yet.' });
  };

  const renderEmptyState = (icon: React.ReactNode, title: string, subtitle: string) => (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mb-5 text-white/20">
        {icon}
      </div>
      <p className="text-white/40 font-display text-base mb-1.5">{title}</p>
      <p className="text-white/20 text-xs max-w-[240px]">{subtitle}</p>
    </div>
  );

  const renderFriendRow = (user: FriendUser, actions: React.ReactNode, index = 0) => (
    <motion.div
      key={user.id}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-wrap items-center gap-3 p-3 rounded-r2 border border-white/5 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/10 transition-all group hover-lift"
    >
      <div className="relative flex-shrink-0">
        <img src={resolveAvatarSrc(user.avatar, user.username)} alt={user.username} className="w-10 h-10 rounded-r2 ring-1 ring-white/10" />
        <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-bg-0 ${getStatusColor(user.status)}`}></div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-foreground font-display text-[13px] truncate">{user.username}</div>
        <div className="micro-label text-white/30 tracking-widest text-[8px]">
          {getStatusLabel(user.status)}
          {user.statusText && <span className="ml-1.5 normal-case tracking-normal text-primary/70 font-mono text-[9px]">{user.statusText}</span>}
        </div>
        {user.username !== user.id && (
          <div className="text-[8px] font-mono text-white/20 truncate" title={user.id}>{user.id}</div>
        )}
      </div>
      <div className="flex w-full items-center justify-end gap-1.5 opacity-100 min-[600px]:w-auto min-[1100px]:opacity-0 min-[1100px]:group-hover:opacity-100 min-[1100px]:group-focus-within:opacity-100 transition-opacity">
        {actions}
      </div>
    </motion.div>
  );

  const ActionButton = ({ icon, label, onClick, variant = 'default' }: { icon: React.ReactNode; label: string; onClick: () => void; variant?: 'default' | 'danger' | 'success' }) => (
    <button
      onClick={onClick}
      className={`compact-touch-target rounded-full flex items-center justify-center transition-all border btn-press focus-ring ${
        variant === 'danger' ? 'bg-accent-danger/10 border-accent-danger/20 text-accent-danger hover:bg-accent-danger/20' :
        variant === 'success' ? 'bg-accent-success/10 border-accent-success/20 text-accent-success hover:bg-accent-success/20' :
        'bg-white/5 border-white/10 text-white/50 hover:text-primary hover:border-primary/30 hover:bg-primary/10'
      }`}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  );

  let content: React.ReactNode;

  if (activeTab === 'online') {
    const filtered = filterUsers(onlineFriends);
    content = filtered.length > 0 ? (
      <div className="space-y-1.5">
        <div className="micro-label text-white/30 tracking-widest px-1 mb-2.5">ONLINE — {filtered.length}</div>
        {filtered.map((user, index) => renderFriendRow(user, (
          <ActionButton icon={<MessageSquare size={16} />} label="Message" onClick={() => handleOpenDirectMessage(user)} />
        ), index))}
      </div>
    ) : renderEmptyState(<Users size={32} />, 'No one is online', 'Your online friends will appear here.');
  } else if (activeTab === 'all') {
    const filtered = filterUsers(allFriends);
    content = filtered.length > 0 ? (
      <div className="space-y-1.5">
        <div className="micro-label text-white/30 tracking-widest px-1 mb-2.5">ALL FRIENDS — {filtered.length}</div>
        {filtered.map((user, index) => renderFriendRow(user, (
          <ActionButton icon={<MessageSquare size={16} />} label="Message" onClick={() => handleOpenDirectMessage(user)} />
        ), index))}
      </div>
    ) : renderEmptyState(<Users size={32} />, 'No friends yet', 'Add some friends to get started!');
  } else if (activeTab === 'pending') {
    content = pendingRequests.length > 0 ? (
      <div className="space-y-1.5">
        <div className="micro-label text-white/30 tracking-widest px-1 mb-2.5">PENDING — {pendingRequests.length}</div>
        {pendingRequests.map((request) => {
          const user = resolveUser(request.userId);
          return renderFriendRow(user, request.type === 'incoming' ? (
            <>
              <ActionButton icon={<Check size={16} />} label="Accept" onClick={() => void acceptRequest(request.recordId)} variant="success" />
              <ActionButton icon={<X size={16} />} label="Decline" onClick={() => void declineRequest(request.recordId)} variant="danger" />
            </>
          ) : (
            <>
              <span className="micro-label text-white/20 tracking-widest mr-1.5">
                {request.deliveryStatus === 'queued' ? 'QUEUED' : request.deliveryStatus === 'failed' ? 'FAILED' : 'OUTGOING'}
              </span>
              {(request.deliveryStatus === 'queued' || request.deliveryStatus === 'failed') && (
                <ActionButton icon={<RotateCcw size={14} />} label="Retry now" onClick={() => void retryRequest(request.recordId)} />
              )}
              <ActionButton icon={<X size={16} />} label="Cancel request" onClick={() => void cancelRequest(request.recordId)} variant="danger" />
            </>
          ));
        })}
      </div>
    ) : renderEmptyState(<Clock size={32} />, 'No pending requests', 'Friend requests you send or receive will show up here.');
  } else if (activeTab === 'requests') {
    content = <MessageRequests requests={messageRequests} onAccept={handleAcceptMessageRequest} onIgnore={handleIgnoreMessageRequest} />;
  } else {
    content = blocked.length > 0 ? (
      <div className="space-y-1.5">
        <div className="micro-label text-white/30 tracking-widest px-1 mb-2.5">BLOCKED — {blocked.length}</div>
        {blocked.map((user) => renderFriendRow(user, (
          <ActionButton icon={<UserX size={16} />} label="Unblock" onClick={() => unblockUser(user.id)} variant="danger" />
        )))}
      </div>
    ) : renderEmptyState(<Ban size={32} />, 'No blocked users', 'Users you block will appear here.');
  }

  return (
    <div className="flex-1 h-full flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 md:px-6 border-b border-white/5 glass-realistic flex-shrink-0 min-[1100px]:min-h-[52px] min-[1100px]:flex-nowrap min-[1100px]:py-0">
        <div className="flex min-w-0 items-center gap-3">
          <Users size={18} className="text-white/50" />
          <span className="font-bold text-foreground font-display text-base tracking-wide">FRIENDS</span>
          <div className="hidden h-4 w-px bg-white/10 min-[1100px]:block"></div>
        </div>
        <div className="order-3 w-full min-w-0 overflow-x-auto no-scrollbar min-[1100px]:order-none min-[1100px]:w-auto min-[1100px]:flex-1">
          <div className="flex w-max min-w-full items-center gap-1 min-[1100px]:min-w-0">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                aria-pressed={activeTab === tab.key}
                className={`compact-touch-target px-3 py-1.5 rounded-full text-[11px] font-bold tracking-wider transition-all focus-ring ${
                  activeTab === tab.key
                    ? 'bg-primary/15 text-primary border border-primary/30'
                    : 'text-white/40 hover:text-white/70 hover:bg-white/5 border border-transparent'
                }`}
              >
                {tab.label}
                {tab.count !== undefined && tab.count > 0 && (
                  <span className={`ml-1 text-[10px] ${activeTab === tab.key ? 'text-primary/70' : 'text-white/25'}`}>{tab.count}</span>
                )}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => hasIdentity ? setShowAddFriend(!showAddFriend) : onOpenAuth?.()}
          aria-expanded={showAddFriend}
          className={`compact-touch-target ml-auto shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold tracking-wider transition-all flex items-center gap-1.5 focus-ring ${
            showAddFriend
              ? 'bg-transparent text-white/50 border border-white/10'
              : 'bg-accent-success text-bg-0 hover:brightness-110 shadow-[0_0_10px_rgba(5,255,161,0.2)]'
          }`}
        >
          <UserPlus size={12} />
          {showAddFriend ? 'CLOSE' : 'ADD FRIEND'}
        </button>
      </div>

      {showAddFriend && (
        <div className="shrink-0 max-h-[min(50dvh,28rem)] overflow-y-auto px-3 md:px-6 py-4 border-b border-white/5 bg-white/[0.02] overscroll-contain">
          <p className="text-xs text-white/60 mb-2.5">You can add friends with their peer ID or dialable multiaddr.</p>
          {currentPeerId && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-r1 bg-bg-0/60 border border-white/10 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[9px] uppercase tracking-wider text-white/35 font-bold">Your ID — share it so friends can add you</div>
                <div className="text-[10px] font-mono text-white/55 truncate">{currentPeerId}</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  void copyTextToClipboardSafely(currentPeerId).then((ok) =>
                    setFeedback(ok
                      ? { tone: 'success', message: 'Your ID was copied — send it to a friend so they can add you.' }
                      : { tone: 'error', message: 'Couldn’t access the clipboard on this device.' }),
                  );
                }}
                className="compact-touch-target ml-auto flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/30 text-primary text-[10px] font-bold tracking-wider hover:bg-primary/20 transition-all focus-ring"
              >
                <Copy size={12} /> COPY MY ID
              </button>
            </div>
          )}
          {feedback && <FeedbackBanner feedback={feedback} className="mb-3" />}
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <input
              type="text"
              value={addFriendInput}
              onChange={(event) => setAddFriendInput(event.target.value)}
              placeholder="Peer ID or multiaddr..."
              aria-label="Peer ID or multiaddr"
              onKeyDown={(event) => { if (event.key === 'Enter' && addFriendInput.trim() && !addFriendPending) { event.preventDefault(); void handleAddFriend(); } }}
              className="min-h-[44px] min-w-0 flex-1 bg-bg-0 border border-white/10 rounded-full px-4 py-2.5 text-xs font-mono text-foreground placeholder-white/30 focus:outline-none focus:border-primary/50 transition-colors focus-ring"
            />
            <PendingButton
              onClick={handleAddFriend}
              pending={addFriendPending}
              pendingLabel="Sending…"
              disabled={!addFriendInput.trim()}
              spinnerSize={14}
              className="touch-target justify-center px-5 py-2.5 bg-primary rounded-full text-bg-0 font-bold text-xs tracking-wider flex items-center gap-2 disabled:opacity-30 disabled:cursor-not-allowed hover:shadow-glow transition-all"
            >
              SEND REQUEST
            </PendingButton>
          </div>
        </div>
      )}

      {!showAddFriend && feedback && (
        <div className="mx-3 md:mx-6 mt-4">
          <FeedbackBanner feedback={feedback} />
        </div>
      )}

      <div className="shrink-0 px-3 md:px-6 py-2.5">
        <div className="relative">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/20" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search friends...  ( / )"
            aria-label="Search friends"
            className="w-full min-h-[44px] bg-bg-0/50 border border-white/5 rounded-full px-9 py-2 text-xs font-mono text-foreground placeholder-white/30 focus:outline-none focus:border-primary/50 transition-colors focus-ring"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 md:px-6 pb-safe no-scrollbar overscroll-contain">
        {content}
      </div>
    </div>
  );
};

function normalizeFriendsUsers(value: unknown): User[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: User[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const user = normalizeFriendsUser(entry);
    if (seen.has(user.id)) {
      continue;
    }
    seen.add(user.id);
    normalized.push(user);
  }
  return normalized;
}

function normalizeFriendsUser(value: unknown): User {
  if (!isPlainObject(value)) {
    return {
      id: 'unknown',
      username: 'Unknown User',
      avatar: '',
      status: 'offline',
    };
  }

  const id = normalizeFriendText(value.id, 'unknown');
  const username = normalizeFriendText(value.username, id === 'unknown' ? 'Unknown User' : id);
  const avatar = typeof value.avatar === 'string' ? value.avatar : '';
  const status = value.status === 'online' || value.status === 'idle' || value.status === 'dnd' || value.status === 'offline'
    ? value.status
    : 'offline';
  const role = normalizeFriendText(value.role, '');
  const color = normalizeFriendText(value.color, '');
  const bio = normalizeFriendText(value.bio, '');
  const joinedAt = normalizeFriendText(value.joinedAt, '');
  const muted = typeof value.muted === 'boolean' ? value.muted : undefined;
  const donationTier = value.donationTier === 'coffee' || value.donationTier === 'supporter' || value.donationTier === 'champion'
    ? value.donationTier
    : undefined;

  return {
    id,
    username,
    avatar,
    status,
    ...(role ? { role } : {}),
    ...(color ? { color } : {}),
    ...(bio ? { bio } : {}),
    ...(joinedAt ? { joinedAt } : {}),
    ...(typeof muted === 'boolean' ? { muted } : {}),
    ...(donationTier ? { donationTier } : {}),
  };
}

function normalizeFriendText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

const FeedbackBanner = ({ feedback, className = '' }: { feedback: FeedbackState; className?: string }) => (
  <div className={`${className} rounded-r2 border px-4 py-3 text-xs ${feedback.tone === 'error' ? 'border-accent-danger/30 bg-accent-danger/10 text-accent-danger' : feedback.tone === 'success' ? 'border-accent-success/30 bg-accent-success/10 text-accent-success' : 'border-primary/30 bg-primary/10 text-primary'}`}>
    {feedback.message}
  </div>
);


function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

interface RuntimePeerRecord {
  peer_id: string;
  role?: string;
  addresses?: string[];
  public_key?: string;
  source?: string;
  last_seen_at?: string;
  /** Broadcast display name learned via friend requests / presence. */
  display_name?: string;
  /** Broadcast avatar data: URI learned via presence. */
  avatar?: string;
}

interface RuntimePresenceRecord {
  status: string;
  status_text?: string;
  typing_in_scope?: string;
  updated_at: string;
}

function isPeerRecord(value: unknown): value is RuntimePeerRecord {
  return isPlainObject(value) && typeof value.peer_id === 'string';
}

function isPresenceRecord(value: unknown): value is RuntimePresenceRecord {
  return isPlainObject(value) && typeof value.status === 'string' && typeof value.updated_at === 'string';
}

function isMessageRequestRecord(value: unknown): value is MessageRequest {
  return isPlainObject(value)
    && typeof value.id === 'string'
    && typeof value.userId === 'string'
    && typeof value.preview === 'string'
    && typeof value.timestamp === 'string';
}
