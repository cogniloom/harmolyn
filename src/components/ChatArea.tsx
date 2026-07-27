
import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Channel, Message, User, MessageLayout, XoreinAttachment } from '@/types';
import { AttachmentView } from '@/components/AttachmentView';
import { generateTheme } from '@/utils/themeGenerator';
import { resolveSecurityMode } from '@/lib/securityMode';
import { renderMarkdown } from '@/utils/markdown';
import { EmojiPicker } from '@/components/EmojiPicker';
import { StickerPicker } from '@/components/StickerPicker';
import { buildMessageLink, safeLocationOrigin } from '@/components/chatLinks';
import { copyTextToClipboardSafely } from '@/components/contextMenuUtils';
import { TypingIndicator } from '@/components/TypingIndicator';
import { MediaEmbed } from '@/components/MediaEmbed';
import { ForwardMessageModal } from '@/components/ForwardMessageModal';
import { PollCreator } from '@/components/PollCreator';
import { PollMessage } from '@/components/PollMessage';
import { ThreadPanel } from '@/components/ThreadPanel';
import { MediaLightbox } from '@/components/MediaLightbox';
import { ConfirmDeleteModal } from '@/components/ConfirmDeleteModal';
import { SearchPanel } from '@/components/SearchPanel';
import { InboxPanel } from '@/components/InboxPanel';
import { MentionAutocomplete } from '@/components/MentionAutocomplete';
import { useToast } from '@/lib/toastBus';
import { useFeature } from '@/hooks/useFeature';
import { useSendChannelMessage, useSendDmMessage, useEditMessage, useDeleteMessage, useAddReaction, useRemoveReaction, usePinMessage, useUnpinMessage, useCastPollVote, useSetPeerVerified } from '@/hooks/runtime/mutations';
import { KeyVerification } from '@/components/KeyVerification';
import { markNotificationsRead, searchNotifications } from '@/lib/xoreinControl';
import { uploadEncryptedAttachment } from '@/native/blobs/blobs';
import { useContextMenu } from '@/components/GlobalContextMenuContext';
import { readShellRuntimeData } from '@/data';
import {
  readBrowserChatActionSupport,
  readPersistedChatScopeState,
  writePersistedChatScopeState,
} from '@/protocol/client';
import { Hash, Bell, Pin, Users, Search, MoreHorizontal, MessageSquare, AtSign, Smile, Sticker, PlusCircle, X, Send, LayoutTemplate, Menu, Trash2, MicOff, Image, FileText, Reply, CornerUpRight, Pencil, Check, PanelRightClose, Forward, BarChart3, Link2, ArrowDown, MessageCircle, Inbox, Star, Lock, AlertTriangle, Clock, WifiOff } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { usePersistentState } from '@/hooks/usePersistentState';
import { PREVIEW_STORAGE_KEYS } from '@/config/storageKeys';
import { DonorBadge } from '@/components/DonorBadge';
import { resolveAvatarSrc } from '@/lib/avatar';
import { createCollisionResistantId } from '@/lib/localIds';
import { buildForwardDestinations, type ForwardDestination } from '@/components/chatForwarding';

// Action button sub-component for message interactions
const ActionBtn = ({ icon, label, onClick }: { icon: React.ReactNode, label: string, onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void }) => (
  <button
    onClick={onClick}
    className="p-1.5 text-white/40 hover:text-primary hover:bg-white/5 rounded-full transition-all btn-press focus-ring"
    aria-label={label}
  >
    {icon}
  </button>
);

// Tiny delivery status tick/icon shown on outbound messages
const DeliveryStatusIcon = ({ status }: { status: Message['delivery_status'] }) => {
  if (!status || status === 'sent') return <Check size={9} className="text-primary/60" />;
  if (status === 'pending') return <Clock size={9} className="text-white/30 animate-pulse" />;
  if (status === 'offline_queued') return <WifiOff size={9} className="text-yellow-400/70" title="Queued — recipient offline" />;
  if (status === 'failed') return <AlertTriangle size={9} className="text-accent-danger/80" title="Delivery failed" />;
  return null;
};

// Helper component for consistent reaction chips
const ReactionChip = ({ emoji, count, reacted, onClick, compact = false }: { emoji: string, count: number, reacted: boolean, onClick?: () => void, compact?: boolean }) => (
  <button 
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      className={`
        ${compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2.5 py-0.5 text-[10px]'} 
        rounded-full border flex items-center gap-1 transition-all cursor-pointer select-none group btn-press
        ${reacted 
          ? 'bg-primary/10 border-primary/30 text-primary shadow-[0_0_10px_rgba(19,221,236,0.15)] hover:bg-primary/20 hover:border-primary/50' 
          : 'bg-white/5 border-white/5 text-white/40 hover:border-white/20 hover:bg-white/10 hover:text-white/70'
        }
      `}
  >
      <span className={compact ? 'text-[10px]' : 'text-xs'}>{emoji}</span>
      <span className={`font-bold font-mono ${reacted ? 'text-primary' : 'text-white/40 group-hover:text-white/60'}`}>{count}</span>
  </button>
);

const REACTION_EMOJIS = ['👍', '❤️', '🔥', '😂', '😮', '😢', '🚀', '👀'];
const UNKNOWN_CHAT_USER: User = {
  id: 'unknown',
  username: 'Unknown User',
  avatar: '',
  status: 'offline',
};

const getAvatarInitial = (username: string) => username.trim().charAt(0).toUpperCase() || '?';

const UserAvatar = ({ user, className, alt }: { user: User; className: string; alt?: string }) => {
  const avatar = user.avatar?.trim();
  if (avatar) {
    return <img src={resolveAvatarSrc(avatar, alt ?? user.username)} className={className} alt={alt ?? user.username} />;
  }
  const decorative = alt === '';

  return (
    <span
      className={`${className} inline-flex items-center justify-center bg-white/10 text-white/60 font-bold font-display`}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : alt ?? user.username}
      role={decorative ? undefined : 'img'}
    >
      {getAvatarInitial(user.username)}
    </span>
  );
};

// Helper to get status color
const getStatusColor = (status: string) => {
  switch (status) {
    case 'online': return 'bg-accent-success shadow-[0_0_5px_#05FFA1]';
    case 'idle': return 'bg-accent-warning shadow-[0_0_5px_#FFB020]';
    case 'dnd': return 'bg-accent-danger shadow-[0_0_5px_#FF2A6D]';
    default: return 'bg-white/20';
  }
};

// Enhanced Username Component with cyberpunk visual effects
const UsernameDisplay = ({ user, compact = false }: { user: User, compact?: boolean }) => {
  const isSpecial = user.role === 'Admin' || user.role === 'Moderator';
  const baseColor = user.color || '#F6F8F8';
  
  const gradient = baseColor === '#13DDEC' 
    ? 'linear-gradient(135deg, #13DDEC 0%, #00A8CC 100%)' 
    : `linear-gradient(135deg, ${baseColor} 0%, ${baseColor}AA 100%)`;
  
  const glowColor = `${baseColor}66`;

  return (
    <span className={`font-bold ${compact ? 'text-xs' : 'text-[13px]'} tracking-tight cursor-pointer transition-all duration-300 relative px-1 -mx-1 rounded-md inline-flex items-center gap-1.5`}>
      <span 
        className="transition-all duration-300 hover:brightness-125 font-display"
        style={{ 
          background: gradient,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          filter: isSpecial && !compact ? `drop-shadow(0 0 6px ${glowColor})` : 'none',
        }}
      >
        {user.username}
      </span>
      {user.donationTier && <DonorBadge tier={user.donationTier} compact />}
      {!compact && (
        <div className={`w-1.5 h-1.5 rounded-full ${getStatusColor(user.status)}`} title={user.status}></div>
      )}
      {isSpecial && !compact && (
        <span 
          className="absolute -bottom-[1px] left-1 right-1 h-[1px] opacity-20"
          style={{ background: `linear-gradient(90deg, ${baseColor}, transparent)` }}
        ></span>
      )}
    </span>
  );
};

function normalizeChatUsers(users: User[]): User[] {
  const normalized: User[] = [];
  const seen = new Set<string>();
  for (const user of users) {
    const normalizedUser = normalizeChatUser(user);
    if (seen.has(normalizedUser.id)) {
      continue;
    }
    seen.add(normalizedUser.id);
    normalized.push(normalizedUser);
  }
  return normalized;
}

function normalizeChatMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: Message[] = [];
  const seen = new Set<string>();
  for (const [index, message] of value.entries()) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || Object.getPrototypeOf(message) !== Object.prototype) {
      continue;
    }

    const record = message as Record<string, unknown>;
    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `message-${index}`;
    if (seen.has(id)) {
      continue;
    }

    const userId = typeof record.userId === 'string' && record.userId.trim() ? record.userId.trim() : 'unknown';
    const content = typeof record.content === 'string' ? record.content : '';
    const timestamp = typeof record.timestamp === 'string' && record.timestamp.trim() ? record.timestamp.trim() : formatTimestamp();
    const replyToId = typeof record.replyToId === 'string' && record.replyToId.trim() ? record.replyToId.trim() : undefined;
    const editedAt = typeof record.editedAt === 'string' && record.editedAt.trim() ? record.editedAt.trim() : undefined;
    const attachments = Array.isArray(record.attachments)
      ? record.attachments.filter((attachment): attachment is string => typeof attachment === 'string' && attachment.trim().length > 0).map((attachment) => attachment.trim())
      : undefined;
    const reactions = Array.isArray(record.reactions)
      ? record.reactions.filter((reaction): reaction is { emoji: string; count: number; reacted: boolean } => isReactionRecord(reaction))
      : undefined;

    seen.add(id);
    normalized.push({
      id,
      userId,
      content,
      timestamp,
      ...(replyToId ? { replyToId } : {}),
      ...(editedAt ? { editedAt } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(Array.isArray(record.media) && record.media.length > 0 ? { media: record.media as XoreinAttachment[] } : {}),
      ...(reactions && reactions.length > 0 ? { reactions } : {}),
      ...(typeof record.isSystem === 'boolean' ? { isSystem: record.isSystem } : {}),
      ...(typeof record.pinned === 'boolean' ? { pinned: record.pinned } : {}),
      ...(typeof record.sticker === 'boolean' ? { sticker: record.sticker } : {}),
      ...(typeof record.delivery_status === 'string' ? { delivery_status: record.delivery_status as Message['delivery_status'] } : {}),
    });
  }

  return normalized;
}

function isReactionRecord(value: unknown): value is { emoji: string; count: number; reacted: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.emoji === 'string'
    && record.emoji.trim().length > 0
    && typeof record.count === 'number'
    && Number.isFinite(record.count)
    && typeof record.reacted === 'boolean';
}

function normalizeChatUser(user: User): User {
  const id = typeof user?.id === 'string' && user.id.trim() ? user.id.trim() : 'unknown';
  const username = normalizeChatUserText(user?.username, id === 'unknown' ? 'Unknown User' : id);
  const avatar = typeof user?.avatar === 'string' ? user.avatar : '';
  const status = user?.status === 'online' || user?.status === 'idle' || user?.status === 'dnd' || user?.status === 'offline'
    ? user.status
    : 'offline';
  const role = typeof user?.role === 'string' && user.role.trim() ? user.role.trim() : undefined;
  const color = typeof user?.color === 'string' && user.color.trim() ? user.color.trim() : undefined;
  const bio = normalizeChatUserText(user?.bio, '');
  const joinedAt = typeof user?.joinedAt === 'string' && user.joinedAt.trim() ? user.joinedAt.trim() : undefined;
  const muted = typeof user?.muted === 'boolean' ? user.muted : undefined;
  const donationTier = user?.donationTier === 'coffee' || user?.donationTier === 'supporter' || user?.donationTier === 'champion'
    ? user.donationTier
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

function normalizeChatUserText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

// User popup sub-component for member details
const UserPopup = ({ user, children, onDirectLink, onMoreOptions }: { user: User, children?: React.ReactNode, onDirectLink?: () => void, onMoreOptions?: () => void }) => {
    const [open, setOpen] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const handleEnter = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true); };
    const handleLeave = () => { closeTimer.current = setTimeout(() => setOpen(false), 200); };
    return (
        <div className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
            {children}
            {open && (
                <div
                    className="absolute top-0 left-14 w-[230px] bg-bg-0 border border-white/10 rounded-r2 shadow-[0_0_50px_rgba(0,0,0,0.8)] z-[100] glass-card overflow-hidden animate-in fade-in zoom-in-95 duration-200"
                    onMouseEnter={handleEnter}
                    onMouseLeave={handleLeave}
                >
                    <div className="h-16 bg-gradient-to-r from-primary/30 to-accent-purple/30 relative">
                        <div className="absolute inset-0 grid-overlay opacity-20"></div>
                    </div>
                    <div className="px-5 pb-5 -mt-8">
                        <div className="relative inline-block">
                            <UserAvatar user={user} className="w-16 h-16 rounded-r2 border-[3px] border-bg-0 shadow-xl mb-3 ring-1 ring-white/10" />
                            <div className={`absolute bottom-3 -right-1.5 px-1.5 py-0.5 rounded-full text-[7px] font-bold uppercase tracking-wider text-bg-0 border-2 border-bg-0 ${
                                user.status === 'online' ? 'bg-accent-success' : 
                                user.status === 'idle' ? 'bg-accent-warning' : 
                                user.status === 'dnd' ? 'bg-accent-danger' : 'bg-white/40'
                            }`}>
                                {user.status}
                            </div>
                        </div>
                        <h3 className="font-bold text-xl text-white font-display mb-1">{user.username}</h3>
                        {user.donationTier && (
                          <div className="mb-2">
                            <DonorBadge tier={user.donationTier} />
                          </div>
                        )}
                        <p className="micro-label text-primary/60 tracking-widest mb-3">OP // {user.id.toUpperCase()}</p>
                        <div className="bg-white/5 rounded-r1 p-3 border border-white/5 mb-3">
                            <div className="micro-label text-white/40 mb-1.5">BIO // DECRYPTED</div>
                            <p className="text-[10px] text-white/80 italic leading-relaxed">{user.bio}</p>
                        </div>
                        {(onDirectLink || onMoreOptions) && (
                          <div className="flex gap-1.5">
                            {onDirectLink && <button onClick={onDirectLink} className="flex-1 bg-primary text-bg-0 font-bold py-2 rounded-full micro-label tracking-tight hover:shadow-glow transition-all text-[10px]">Direct Link</button>}
                            {onMoreOptions && <button onClick={onMoreOptions} className="px-2.5 bg-white/5 text-white/60 rounded-full hover:bg-white/10 transition-colors border border-white/5" aria-label="More options"><MoreHorizontal size={16} /></button>}
                          </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

interface ChatAreaProps {
  channel?: Channel;
  messages: Message[];
  users?: User[];
  mobileMenuOpen: boolean;
  onToggleMobileMenu: () => void;
  onToggleMemberList: () => void;
  isDM?: boolean;
  messageLayout: MessageLayout;
  onToggleLayout: () => void;
  securityMode?: string;
  headerControl?: React.ReactNode;
  hasIdentity?: boolean;
  onOpenAuth?: () => void;
}

interface InboxItem {
  id: string;
  type: 'mention' | 'reply';
  messageId: string;
  channelName: string;
  serverName: string;
  timestamp: string;
  read: boolean;
}

interface ComposerFeedback {
  tone: 'info' | 'success' | 'error';
  text: string;
}

const MESSAGE_ID_PREFIX = 'local-msg-';

const formatTimestamp = (value = Date.now()) => new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
}).format(new Date(value));

const buildMessageElementId = (messageId: string) => `chat-message-${messageId}`;

const formatAttachmentLabel = (file: File) => {
  const sizeKb = Math.max(1, Math.round(file.size / 1024));
  return `${file.name} • ${sizeKb} KB`;
};

export const ChatArea: React.FC<ChatAreaProps> = ({
  channel,
  messages,
  users = [],
  onToggleMobileMenu,
  onToggleMemberList,
  isDM,
  messageLayout,
  onToggleLayout,
  securityMode,
  headerControl,
  hasIdentity = false,
  onOpenAuth,
}) => {
  // The security badge is derived from what ACTUALLY happened on the wire, never
  // from the scope type. On the native path each message carries the real mode it
  // was encrypted/decrypted under (`securityMode`): inbound messages only exist
  // after successful decryption, and outbound messages are marked `clear` only when
  // encryption was impossible and they were kept local. So: if any message in the
  // conversation is `clear`, the badge downgrades to the danger state (warning the
  // user their traffic isn't protected); otherwise it shows the real E2EE mode.
  // An empty conversation shows its expected mode (the next message is guaranteed
  // encrypted by the fail-closed send path). Off the native path we defer to the
  // negotiated value and never claim encryption the wire didn't provide.
  const nativeActive = typeof window !== 'undefined'
    && (window as unknown as { __HARMOLYN_NATIVE_ACTIVE__?: boolean }).__HARMOLYN_NATIVE_ACTIVE__ === true;
  const anyClearMessage = useMemo(
    () => messages.some((m) => !m.isSystem && (m.securityMode === 'clear' || m.encrypted === false)),
    [messages],
  );
  const conversationMode = nativeActive
    ? (anyClearMessage ? 'clear' : (isDM ? 'seal' : 'crowd'))
    : securityMode;
  const securityBadge = resolveSecurityMode(conversationMode);
  const channelFollowingEnabled = useFeature('channelFollowing');
  const [followedChannels, setFollowedChannels] = usePersistentState<string[]>(PREVIEW_STORAGE_KEYS.channelFollows, []);
  const normalizedUsers = useMemo(() => normalizeChatUsers(users), [users]);
  const normalizedMessages = useMemo(() => normalizeChatMessages(messages), [messages]);
  const isFollowingChannel = channel ? followedChannels.includes(channel.id) : false;
  const toggleFollowChannel = () => {
    if (!channel) return;
    setFollowedChannels((prev) => (prev.includes(channel.id) ? prev.filter((id) => id !== channel.id) : [...prev, channel.id]));
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showPinned, setShowPinned] = useState(false);
  const [showSecuritySummary, setShowSecuritySummary] = useState(false);
  const [showKeyVerification, setShowKeyVerification] = useState(false);
  const setPeerVerified = useSetPeerVerified();
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [reactionMenuMsgId, setReactionMenuMsgId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const COMPOSER_MAX_HEIGHT = 160;
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [composerFeedback, setComposerFeedback] = useState<ComposerFeedback | null>(null);

  const [messagesState, setMessagesState] = useState<Message[]>(messages);
  const [mutedUsers, setMutedUsers] = useState<Set<string>>(new Set());
  const [forwardingContent, setForwardingContent] = useState<string | null>(null);
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [threadRepliesByParent, setThreadRepliesByParent] = useState<Record<string, Message[]>>({});
  const [localNickname, setLocalNickname] = useState('');
  const [inboxReadIds, setInboxReadIds] = useState<Set<string>>(new Set());
  const [deletedMessageIds, setDeletedMessageIds] = useState<Set<string>>(new Set());

  const hasForwarding = useFeature('messageForwarding');
  const hasPolls = useFeature('polls');
  const hasThreads = useFeature('threads');
  const hasMessageLinks = useFeature('messageLinks');
  const hasLightbox = useFeature('imageLightbox');
  const hasDeleteConfirm = useFeature('deleteConfirmation');
  const hasJumpToPresent = useFeature('jumpToPresent');
  const hasUnreadDivider = useFeature('unreadDivider');
  const hasAdvancedSearch = useFeature('advancedSearch');
  const hasInbox = useFeature('inbox');
  const hasMentionAutocomplete = useFeature('mentionAutocomplete');
  const hasFileUploads = useFeature('fileUploads');

  const sendChannelMutation = useSendChannelMessage();
  const sendDmMutation = useSendDmMessage();
  const editMutation = useEditMessage();
  const deleteMutation = useDeleteMessage();
  const addReactionMutation = useAddReaction();
  const removeReactionMutation = useRemoveReaction();
  const pinMutation = usePinMessage();
  const unpinMutation = useUnpinMessage();
  const castPollVoteMutation = useCastPollVote();

  const [threadMessage, setThreadMessage] = useState<Message | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Message | null>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const UNREAD_AFTER_INDEX = 8;

  const { showMenu } = useContextMenu();
  const toast = useToast();
  const chatSupport = readBrowserChatActionSupport();

  useEscapeKey(() => setShowSecuritySummary(false), showSecuritySummary);

  const persistScopeState = useCallback((next: {
    messages?: Message[];
    mutedUserIds?: Set<string>;
    threads?: Record<string, Message[]>;
    nickname?: string;
    inboxReadIds?: Set<string>;
    deletedMessageIds?: Set<string>;
  }) => {
    if (!channel?.id) {
      return;
    }

    writePersistedChatScopeState(channel.id, {
      version: 1,
      nickname: next.nickname ?? localNickname,
      mutedUserIds: [...(next.mutedUserIds ?? mutedUsers)],
      inboxReadIds: [...(next.inboxReadIds ?? inboxReadIds)],
      deletedMessageIds: [...(next.deletedMessageIds ?? deletedMessageIds)],
      messages: next.messages ?? messagesState,
      threads: next.threads ?? threadRepliesByParent,
    });
  }, [channel?.id, deletedMessageIds, inboxReadIds, localNickname, messagesState, mutedUsers, threadRepliesByParent]);

  const showFeedback = useCallback((tone: ComposerFeedback['tone'], text: string, _toastType: 'message' | 'system' = 'system') => {
    setComposerFeedback({ tone, text });
    if (tone === 'error') toast.error(text);
    else if (tone === 'success') toast.success(text);
    else toast.info(text);
  }, [toast]);

  const mergePersistedMessages = useCallback((incomingMessages: Message[], persistedMessages: Message[], deletedIds: Set<string>) => {
    if (persistedMessages.length === 0) {
      // Preserve tombstones (deletedAt set) rather than filtering them out
      return incomingMessages.map(m => deletedIds.has(m.id) && !m.deletedAt
        ? { ...m, deletedAt: new Date().toISOString() }
        : m,
      );
    }

    const merged = [...persistedMessages];
    const seen = new Set(merged.map((message) => message.id));
    for (const incomingMessage of incomingMessages) {
      if (!seen.has(incomingMessage.id)) {
        // If deleted, include as tombstone
        if (deletedIds.has(incomingMessage.id)) {
          merged.push({ ...incomingMessage, deletedAt: incomingMessage.deletedAt ?? new Date().toISOString() });
        } else {
          merged.push(incomingMessage);
        }
      }
    }
    return merged;
  }, []);

  useEffect(() => {
    if (!channel?.id) {
      setMessagesState(normalizedMessages);
      setMutedUsers(new Set());
      setThreadRepliesByParent({});
      setLocalNickname('');
      setInboxReadIds(new Set());
      setDeletedMessageIds(new Set());
      return;
    }

    const persisted = readPersistedChatScopeState(channel.id);
    const persistedDeletedIds = new Set(persisted.deletedMessageIds);
    setMessagesState(mergePersistedMessages(normalizedMessages, persisted.messages, persistedDeletedIds));
    setMutedUsers(new Set(persisted.mutedUserIds));
    setThreadRepliesByParent(persisted.threads);
    setLocalNickname(persisted.nickname);
    setInboxReadIds(new Set(persisted.inboxReadIds));
    setDeletedMessageIds(persistedDeletedIds);
    setComposerFeedback({
      tone: chatSupport.mode === 'offline' ? 'error' : 'info',
      text: chatSupport.detail,
    });
  }, [channel?.id, chatSupport.detail, chatSupport.mode, mergePersistedMessages, normalizedMessages]);

  const handleContextMenu = (e: React.MouseEvent, msgId: string) => {
    e.preventDefault();
    (e.nativeEvent as Event & { __customContextHandled?: boolean }).__customContextHandled = true;

    const msg = messagesState.find(m => m.id === msgId);
    if (!msg) return;

    const isMe = msg.userId === 'me';
    const isMuted = mutedUsers.has(msg.userId);

    const mainItems = [
      { label: 'Reply', icon: <MessageSquare size={13} />, onClick: () => setReplyingTo(msg) },
      { label: msg.pinned ? 'Unpin Message' : 'Pin Message', icon: <Pin size={13} />, onClick: () => togglePin(msg.id) },
      { label: 'Add Reaction', icon: <Smile size={13} />, onClick: () => setReactionMenuMsgId(msg.id) },
    ];
    if (isMe) mainItems.push({ label: 'Edit Message', icon: <Pencil size={13} />, onClick: () => startEdit(msg) });
    if (hasForwarding) mainItems.push({ label: 'Forward Message', icon: <Forward size={13} />, onClick: () => setForwardingContent(msg.content) });
    if (hasThreads) mainItems.push({ label: 'Create Thread', icon: <MessageCircle size={13} />, onClick: () => setThreadMessage(msg) });
    if (hasMessageLinks) mainItems.push({ label: 'Copy Message Link', icon: <Link2 size={13} />, onClick: () => copyMessageLink(msg.id) });

    const moderationItems = [
      { label: isMuted ? 'Unmute User' : 'Mute User', icon: <MicOff size={13} />, onClick: () => toggleMuteUser(msg.userId) },
      { label: 'Delete Message', icon: <Trash2 size={13} />, onClick: () => deleteMessage(msg.id), danger: true },
    ];

    showMenu(e.clientX, e.clientY, [
      { items: mainItems },
      { items: moderationItems },
    ]);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputValue(val);
    if (val === '/') {
      setShowSlashCommands(true);
    } else {
      setShowSlashCommands(false);
    }
    // Mention autocomplete
    if (hasMentionAutocomplete) {
      const atMatch = val.match(/@(\w*)$/);
      if (atMatch) {
        setMentionQuery(atMatch[1]);
      } else {
        setMentionQuery(null);
      }
    }
  };

  const handleSlashCommand = (cmd: string) => {
    setInputValue(`/${cmd} `);
    setShowSlashCommands(false);
  };

  const createLocalMessage = useCallback((content: string, overrides: Partial<Message> = {}): Message => ({
    id: createCollisionResistantId(MESSAGE_ID_PREFIX.slice(0, -1)),
    userId: 'me',
    content,
    timestamp: formatTimestamp(),
    ...(replyingTo ? { replyToId: replyingTo.id } : {}),
    ...overrides,
  }), [replyingTo]);

  const handleSendMessage = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('/')) {
      const [command, ...rest] = trimmed.slice(1).split(/\s+/);
      const payload = rest.join(' ').trim();
      if (command === 'nick') {
        if (!payload) {
          showFeedback('error', 'Provide a nickname after /nick, for example `/nick Cipher`.', 'system');
          return;
        }
        setLocalNickname(payload);
        persistScopeState({ nickname: payload });
        setInputValue('');
        showFeedback('success', `Using ${payload} as your local chat alias in this scope.`, 'system');
        return;
      }

      if (command === 'clear') {
        const nextMessages = normalizedMessages.filter((message) => !message.id.startsWith(MESSAGE_ID_PREFIX));
        setMessagesState(nextMessages);
        setInputValue('');
        setReplyingTo(null);
        persistScopeState({ messages: nextMessages });
        showFeedback('success', 'Cleared locally composed messages for this chat.', 'system');
        return;
      }

      if (command === 'me') {
        const nextMessages = [...messagesState, createLocalMessage(payload ? `_${payload}_` : '_shrugs in silence_')];
        setMessagesState(nextMessages);
        setInputValue('');
        setReplyingTo(null);
        persistScopeState({ messages: nextMessages });
        return;
      }

      if (command === 'shrug') {
        const nextMessages = [...messagesState, createLocalMessage(`${payload} ¯\\_(ツ)_/¯`.trim())];
        setMessagesState(nextMessages);
        setInputValue('');
        setReplyingTo(null);
        persistScopeState({ messages: nextMessages });
        return;
      }

      showFeedback('error', `Unknown command. Available commands: /nick, /clear.`, 'system');
      return;
    }

    if (chatSupport.mode !== 'offline' && channel?.id) {
      const content = inputValue;
      setInputValue('');
      setReplyingTo(null);
      try {
        if (isDM) {
          await sendDmMutation.mutateAsync({ dmId: channel.id, content });
        } else {
          await sendChannelMutation.mutateAsync({ channelId: channel.id, content });
        }
      } catch (error) {
        setInputValue(content);
        showFeedback('error', error instanceof Error ? error.message : 'Failed to send message.', 'system');
      }
    } else {
      const nextMessages = [...messagesState, createLocalMessage(inputValue)];
      setMessagesState(nextMessages);
      setInputValue('');
      setReplyingTo(null);
      persistScopeState({ messages: nextMessages });
      showFeedback('info', chatSupport.detail, 'message');
    }
  };

  const handleSendSticker = async (sticker: string) => {
    setShowStickerPicker(false);
    setReplyingTo(null);
    if (chatSupport.mode !== 'offline' && channel?.id) {
      try {
        if (isDM) {
          await sendDmMutation.mutateAsync({ dmId: channel.id, content: sticker });
        } else {
          await sendChannelMutation.mutateAsync({ channelId: channel.id, content: sticker });
        }
      } catch (error) {
        showFeedback('error', error instanceof Error ? error.message : 'Failed to send sticker.', 'system');
      }
    } else {
      const nextMessages = [...messagesState, createLocalMessage(sticker, { sticker: true })];
      setMessagesState(nextMessages);
      persistScopeState({ messages: nextMessages });
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.currentTarget.value = '';
    if (!file) {
      return;
    }
    if (!chatSupport.canAttemptAttachments) {
      showFeedback('error', 'Attachments are disabled while the local xorein runtime is offline.', 'system');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showFeedback('error', 'Attachments are limited to 8 MB.', 'system');
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => showFeedback('error', 'Could not read the selected file.', 'system');
    reader.onload = async () => {
      const buffer = reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : null;
      if (!buffer || buffer.length === 0) {
        showFeedback('error', 'Could not read the selected file.', 'system');
        return;
      }
      showFeedback('info', `Encrypting & uploading ${file.name}…`, 'system');
      try {
        // Encrypt the file client-side, upload only ciphertext to the node, and
        // carry the decryption key INSIDE the E2EE message — the node stores an
        // opaque blob it can never read (priv-4).
        const attachment = await uploadEncryptedAttachment(
          buffer, file.name, file.type || 'application/octet-stream',
        );
        const sizeKb = Math.max(1, Math.round(attachment.size / 1024));
        const caption = `📎 ${attachment.name} (${sizeKb} KB)`;
        if (channel?.id) {
          if (isDM) {
            await sendDmMutation.mutateAsync({ dmId: channel.id, content: caption, media: [attachment] });
          } else {
            await sendChannelMutation.mutateAsync({ channelId: channel.id, content: caption, media: [attachment] });
          }
        }
        showFeedback('success', `Uploaded ${attachment.name} (${sizeKb} KB), end-to-end encrypted.`, 'message');
      } catch (error) {
        showFeedback('error', error instanceof Error ? error.message : 'Upload failed.', 'system');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline (matches every major chat app).
    // When the mention dropdown is open it owns Enter (selecting a member), so we
    // defer to it rather than sending a half-typed @mention.
    if (e.key === 'Enter' && !e.shiftKey) {
      if (mentionQuery !== null && hasMentionAutocomplete) {
        return;
      }
      e.preventDefault();
      handleSendMessage();
    }
  };

  const toggleMuteUser = (userId: string) => {
    setMutedUsers(prev => {
      const next = new Set(prev);
      const muting = !next.has(userId);
      if (muting) {
        next.add(userId);
      } else {
        next.delete(userId);
      }
      persistScopeState({ mutedUserIds: next });
      return next;
    });
  };

  const removeLocalMessage = (msgId: string) => {
    // Mark as deleted (tombstone) instead of removing so moderators can see who deleted what
    const deletedAt = new Date().toISOString();
    const deletedByPeerId = liveShellData.runtimeSnapshot?.identity?.peer_id ?? '';
    const nextMessages = messagesState.map(m =>
      m.id === msgId ? { ...m, deletedAt, deletedBy: deletedByPeerId } : m,
    );
    const nextDeletedIds = new Set(deletedMessageIds);
    nextDeletedIds.add(msgId);
    setMessagesState(nextMessages);
    setDeletedMessageIds(nextDeletedIds);
    persistScopeState({ messages: nextMessages, deletedMessageIds: nextDeletedIds });
  };

  const deleteMessage = (msgId: string) => {
    if (hasDeleteConfirm) {
      const msg = messagesState.find(m => m.id === msgId);
      if (msg) setDeleteTarget(msg);
    } else {
      if (!msgId.startsWith(MESSAGE_ID_PREFIX) && chatSupport.mode !== 'offline') {
        deleteMutation.mutate(
          { messageId: msgId },
          { onError: (error) => showFeedback('error', error instanceof Error ? error.message : 'Failed to delete message.', 'system') },
        );
      }
      removeLocalMessage(msgId);
    }
  };

  const confirmDelete = () => {
    if (deleteTarget) {
      if (!deleteTarget.id.startsWith(MESSAGE_ID_PREFIX) && chatSupport.mode !== 'offline') {
        deleteMutation.mutate(
          { messageId: deleteTarget.id },
          { onError: (error) => showFeedback('error', error instanceof Error ? error.message : 'Failed to delete message.', 'system') },
        );
      }
      removeLocalMessage(deleteTarget.id);
      setDeleteTarget(null);
    }
  };

  const copyMessageLink = async (msgId: string) => {
    const origin = safeLocationOrigin();
    if (!origin) {
      showFeedback('error', 'Unable to build a stable local message link in this browser.', 'system');
      return;
    }

    const link = buildMessageLink(origin, channel?.id, msgId);
    if (!link) {
      showFeedback('error', 'Unable to build a stable local message link in this browser.', 'system');
      return;
    }
    if (await copyTextToClipboardSafely(link)) {
      showFeedback('success', 'Copied a stable local message link to the clipboard.', 'message');
      return;
    }
    showFeedback('error', 'Unable to write the message link to the clipboard in this browser.', 'system');
  };

  const togglePin = (msgId: string) => {
    const target = messagesState.find(m => m.id === msgId);
    const willPin = !target?.pinned;
    const snapshot = messagesState;
    const nextMessages = snapshot.map(m => m.id === msgId ? { ...m, pinned: willPin } : m);
    setMessagesState(nextMessages);
    persistScopeState({ messages: nextMessages });
    if (target && channel && !isDM && !msgId.startsWith(MESSAGE_ID_PREFIX) && chatSupport.mode !== 'offline') {
      const mutation = willPin ? pinMutation : unpinMutation;
      mutation.mutate(
        { channelId: channel.id, messageId: msgId },
        {
          onError: (error) => {
            setMessagesState(snapshot);
            persistScopeState({ messages: snapshot });
            showFeedback('error', error instanceof Error ? error.message : `Failed to ${willPin ? 'pin' : 'unpin'} message.`, 'system');
          },
        },
      );
    }
  };

  const startEdit = (msg: Message) => {
    setEditingMsgId(msg.id);
    setEditValue(msg.content);
  };

  const saveEdit = () => {
    if (!editingMsgId || !editValue.trim()) return;
    const msgId = editingMsgId;
    const content = editValue;
    setEditingMsgId(null);
    setEditValue('');
    if (!msgId.startsWith(MESSAGE_ID_PREFIX) && chatSupport.mode !== 'offline') {
      editMutation.mutate(
        { messageId: msgId, content },
        { onError: (error) => showFeedback('error', error instanceof Error ? error.message : 'Failed to edit message.', 'system') },
      );
    }
    const nextMessages = messagesState.map(m =>
      m.id === msgId ? { ...m, content, editedAt: formatTimestamp() } : m,
    );
    setMessagesState(nextMessages);
    persistScopeState({ messages: nextMessages });
  };

  const cancelEdit = () => {
    setEditingMsgId(null);
    setEditValue('');
  };

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setIsScrolledUp(false);
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [channel, messageLayout, normalizedMessages, searchQuery, scrollToBottom]);

  // Auto-expand the composer up to a capped max-height as the draft grows, then
  // let it scroll internally. Driven off inputValue so emoji/sticker/mention
  // insertions resize too, not just keystrokes.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
  }, [inputValue]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current || !hasJumpToPresent) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setIsScrolledUp(scrollHeight - scrollTop - clientHeight > 200);
  }, [hasJumpToPresent]);
  

  const getUser = useCallback((id: string): User => {
    const found = normalizedUsers.find((u) => u.id === id);
    if (found) {
      if (id === 'me' && localNickname.trim()) {
        return { ...found, username: localNickname.trim() };
      }
      return found;
    }
    return UNKNOWN_CHAT_USER;
  }, [localNickname, normalizedUsers]);

  const handleReactionToggle = (msgId: string, emoji: string) => {
    // Guests are read-only: reacting writes to the P2P network, so route them to
    // sign in instead of mutating local state.
    if (!hasIdentity) { onOpenAuth?.(); return; }
    const target = messagesState.find(m => m.id === msgId);
    const alreadyReacted = Boolean(target?.reactions?.find(r => r.emoji === emoji)?.reacted);
    const snapshot = messagesState;
    const nextMessages = snapshot.map(msg => {
        if (msg.id !== msgId) return msg;

        const reactions = msg.reactions || [];
        const existing = reactions.find(r => r.emoji === emoji);

        let newReactions;
        if (existing) {
            if (existing.reacted) {
                const newCount = existing.count - 1;
                if (newCount > 0) {
                     newReactions = reactions.map(r => r.emoji === emoji ? { ...r, count: newCount, reacted: false } : r);
                } else {
                     newReactions = reactions.filter(r => r.emoji !== emoji);
                }
            } else {
                newReactions = reactions.map(r => r.emoji === emoji ? { ...r, count: r.count + 1, reacted: true } : r);
            }
        } else {
            newReactions = [...reactions, { emoji, count: 1, reacted: true }];
        }

        return { ...msg, reactions: newReactions };
    });
    setMessagesState(nextMessages);
    persistScopeState({ messages: nextMessages });
    setReactionMenuMsgId(null);
    if (target && !msgId.startsWith(MESSAGE_ID_PREFIX) && chatSupport.mode !== 'offline') {
      const mutation = alreadyReacted ? removeReactionMutation : addReactionMutation;
      mutation.mutate(
        { messageId: msgId, emoji },
        {
          onError: (error) => {
            setMessagesState(snapshot);
            persistScopeState({ messages: snapshot });
            showFeedback('error', error instanceof Error ? error.message : 'Failed to update reaction.', 'system');
          },
        },
      );
    }
  };

  const highlightText = (text: string, query: string) => {
    if (!query.trim()) return text;
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escapedQuery})`, 'gi'));
    return parts.map((part, i) => 
      part.toLowerCase() === query.toLowerCase() ? (
        <span key={i} className="bg-primary/20 text-white font-bold px-0.5 rounded shadow-[0_0_5px_rgba(19,221,236,0.2)] transition-all duration-300">
          {part}
        </span>
      ) : (
        part
      )
    );
  };

  const liveShellData = readShellRuntimeData();
  const runtimeSnapshot = liveShellData.runtimeSnapshot ?? null;
  const currentUserName = liveShellData.currentUser.username.toLowerCase();

  // Safety-number verification data for a DM: the other participant's pinned hybrid
  // identity + our own, resolved from the runtime snapshot. Undefined for channels.
  const dmVerification = useMemo(() => {
    if (!isDM || !channel || !runtimeSnapshot) return null;
    const localPeerId = runtimeSnapshot.identity?.peer_id ?? '';
    const dm = runtimeSnapshot.dms?.find((d) => d.id === channel.id);
    const remotePeerId = dm?.participants?.find((p) => p !== localPeerId) ?? '';
    if (!remotePeerId) return null;
    const remotePeer = runtimeSnapshot.known_peers?.find((p) => p.peer_id === remotePeerId);
    return {
      localPeerId,
      localIdentityKey: runtimeSnapshot.identity?.identity_key,
      remotePeerId,
      remoteIdentityKey: remotePeer?.identity_key,
      verified: !!remotePeer?.identity_verified,
      changed: !!remotePeer?.identity_changed,
    };
  }, [isDM, channel, runtimeSnapshot]);

  const forwardDestinations = useMemo<ForwardDestination[]>(() => buildForwardDestinations(liveShellData, normalizedUsers), [liveShellData, normalizedUsers]);

  // Real typing state: peers whose presence reports typing_in_scope === this
  // channel/DM. Presence is keyed by peer id; for remote peers the peer id is the
  // user id (the local peer maps to "me" and is excluded by the indicator). No
  // fabrication — when nobody is typing this is empty and the indicator hides.
  const typingUserIds = useMemo<string[]>(() => {
    const presence = runtimeSnapshot?.presence;
    if (!presence || !channel) {
      return [];
    }
    const localPeerId = runtimeSnapshot?.identity?.peer_id ?? '';
    return Object.entries(presence)
      .filter(([peerId, entry]) => peerId !== localPeerId && entry?.typing_in_scope === channel.id)
      .map(([peerId]) => peerId);
  }, [runtimeSnapshot, channel]);

  useEffect(() => {
    if (!hasInbox || !channel || !runtimeSnapshot) {
      return;
    }

    void searchNotifications(runtimeSnapshot, {
      scope_type: isDM ? 'dm' : 'channel',
      scope_id: channel.id,
      unread_only: true,
    }).catch(() => { /* best-effort — support node may be unavailable */ });
  }, [channel, hasInbox, isDM, runtimeSnapshot]);

  const unreadInboxItems = useMemo(() => {
    const selfName = currentUserName;
    return messagesState.reduce<InboxItem[]>((items, message) => {
      if (message.userId === 'me') {
        return items;
      }

      const isReply = Boolean(message.replyToId && messagesState.some((candidate) => candidate.id === message.replyToId && candidate.userId === 'me'));
      const isMention = message.content.toLowerCase().includes(`@${selfName}`);
      if (!isReply && !isMention) {
        return items;
      }

      const id = `${isReply ? 'reply' : 'mention'}:${message.id}`;
      items.push({
        id,
        type: isReply ? 'reply' : 'mention',
        messageId: message.id,
        channelName: channel?.name || 'current-chat',
        serverName: isDM ? 'Direct Messages' : 'Current Server',
        timestamp: message.timestamp,
        read: inboxReadIds.has(id),
      });
      return items;
    }, []).filter((item) => !item.read);
  }, [channel?.name, currentUserName, inboxReadIds, isDM, messagesState]);

  const jumpToMessage = useCallback((messageId: string) => {
    const element = document.getElementById(buildMessageElementId(messageId));
    if (!element) {
      showFeedback('error', 'That message is not available in the current chat scope.', 'system');
      return;
    }

    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setShowInbox(false);
  }, [showFeedback]);

  const handleForwardMessage = useCallback(async (destinations: ForwardDestination[], note: string) => {
    const body = forwardingContent ?? '';
    const content = `${note.trim() ? `${note.trim()}\n\n` : ''}↪ **Forwarded message${channel ? ` from #${channel.name}` : ''}:** ${body}`;
    setForwardingContent(null);
    let successCount = 0;
    let failCount = 0;
    for (const destination of destinations) {
      try {
        if (chatSupport.mode !== 'offline') {
          if (destination.type === 'dm') {
            await sendDmMutation.mutateAsync({ dmId: destination.id, content });
          } else {
            await sendChannelMutation.mutateAsync({ channelId: destination.id, content });
          }
        } else {
          const persisted = readPersistedChatScopeState(destination.id);
          const forwardedMessage: Message = {
            id: createCollisionResistantId(`${MESSAGE_ID_PREFIX.slice(0, -1)}-forward-${destination.id}`),
            userId: 'me',
            timestamp: formatTimestamp(),
            content,
          };
          writePersistedChatScopeState(destination.id, {
            ...persisted,
            messages: [...persisted.messages, forwardedMessage],
          });
          if (destination.id === channel?.id) {
            setMessagesState(prev => {
              const next = [...prev, forwardedMessage];
              persistScopeState({ messages: next });
              return next;
            });
          }
        }
        successCount++;
      } catch {
        failCount++;
      }
    }
    if (failCount === 0) {
      showFeedback('success', `Forwarded to ${successCount} destination${successCount === 1 ? '' : 's'}.`, 'message');
    } else if (successCount > 0) {
      showFeedback('info', `Forwarded to ${successCount}; ${failCount} failed.`, 'message');
    } else {
      showFeedback('error', 'Failed to forward message.', 'message');
    }
  }, [channel, chatSupport.mode, forwardingContent, persistScopeState, sendChannelMutation, sendDmMutation, showFeedback]);

  const filteredMessages = messagesState.filter(msg => 
    msg.content.toLowerCase().includes(searchQuery.toLowerCase()) && !mutedUsers.has(msg.userId)
  );

  if (!channel) return <div className="flex-1 bg-bg-2 flex items-center justify-center text-white/20 micro-label">Awaiting // Selection</div>;

  return (
    <div className="flex-1 h-full relative z-0 overflow-hidden">
      <div 
        className="absolute inset-0 z-[-1] transition-all duration-1000 ease-in-out"
        style={{ backgroundImage: 'var(--theme-bg-image)' }}
      ></div>
      <div className="absolute inset-0 grid-overlay opacity-30 z-[-1]"></div>
      
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 h-[52px] flex items-center justify-between px-3 lg:px-6 border-b theme-border glass-realistic z-20">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <button onClick={onToggleMobileMenu} className="lg:hidden text-primary/80 hover:text-primary transition-colors p-2 min-w-[44px] min-h-[44px] flex items-center justify-center" aria-label="Open Menu">
            <Menu size={22} />
          </button>
          
          <div className="text-primary text-glow flex-shrink-0">
             {isDM ? <AtSign size={18} /> : <Hash size={18} />}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-bold theme-text tracking-wide text-base font-display uppercase truncate max-w-[120px] md:max-w-xs">{channel.name}</span>
            <button
              type="button"
              onClick={() => setShowSecuritySummary((prev) => !prev)}
              className={`micro-label tracking-widest text-[7px] hidden md:flex items-center gap-1 focus-ring rounded-r1 hover:brightness-125 transition-all ${securityBadge.className}`}
              title="View this conversation's security mode"
              aria-haspopup="dialog"
              aria-expanded={showSecuritySummary}
            >
              {securityBadge.insecure ? <AlertTriangle size={8} /> : <Lock size={8} />}
              {securityBadge.label}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1.5 md:gap-5">
           {headerControl}
           {channelFollowingEnabled && !isDM && (
             <button
               onClick={toggleFollowChannel}
               aria-label={isFollowingChannel ? 'Unfollow channel' : 'Follow channel'}
               aria-pressed={isFollowingChannel}
               title={isFollowingChannel ? 'Following' : 'Follow channel'}
               className={`p-1.5 transition-colors ${isFollowingChannel ? 'text-accent-warning' : 'text-white/40 hover:text-primary'}`}
             >
               <Star size={16} fill={isFollowingChannel ? 'currentColor' : 'none'} />
             </button>
           )}
           <button
             onClick={onToggleLayout} 
             className="text-white/40 hover:text-primary transition-colors p-1.5" 
             title={`Change View: ${messageLayout}`}
             aria-label="Change Chat View"
           >
              <LayoutTemplate size={18} />
           </button>

           {/* Member Toggle - Mobile & Tablet */}
           <button onClick={onToggleMemberList} className="lg:hidden text-white/40 hover:text-primary transition-colors p-2 min-w-[44px] min-h-[44px] flex items-center justify-center" aria-label="Member List">
               <Users size={20} />
           </button>

          <div className="hidden lg:flex items-center gap-4 text-white/40">
             {hasInbox && (
                <button aria-label="Inbox" onClick={() => setShowInbox(!showInbox)} className={`transition-colors relative ${showInbox ? 'text-primary' : 'hover:text-primary'}`}>
                  <Inbox size={16} />
                  {unreadInboxItems.length > 0 && (
                    <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-accent-danger text-[7px] font-bold flex items-center justify-center text-white shadow-[0_0_6px_rgba(255,42,109,0.35)]">{Math.min(unreadInboxItems.length, 9)}</span>
                  )}
                </button>
              )}
              <button aria-label="Notifications" onClick={() => showFeedback('info', 'Notification routing is managed from Settings → Signal Alerts.', 'system')} className="hover:text-primary transition-colors"><Bell size={16} /></button>
              <div className="relative">
                 <button aria-label="Pinned Messages" onClick={() => setShowPinned(!showPinned)} className={`transition-colors relative ${showPinned ? 'text-primary' : 'hover:text-primary'}`}>
                   <Pin size={16} />
                   {messagesState.filter(m => m.pinned).length > 0 && (
                     <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-accent-danger text-[7px] font-bold flex items-center justify-center text-white shadow-[0_0_6px_rgba(255,42,109,0.35)]">
                       {messagesState.filter(m => m.pinned).length}
                     </span>
                   )}
                 </button>
              </div>
             <button aria-label="Member List" onClick={onToggleMemberList} className="hover:text-primary transition-colors"><Users size={16} /></button>
             <div className="relative group">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-primary transition-colors" />
                <input 
                    type="text" 
                    placeholder="Search..." 
                    className="bg-bg-0/50 border border-white/5 rounded-full px-10 py-1.5 text-xs focus:outline-none focus:border-primary/50 focus:w-52 transition-all w-40 font-mono text-white placeholder-white/40"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    aria-label="Search messages"
                />
             </div>
          </div>
        </div>
      </div>

      {/* Messages Area */}
      <div className={`absolute inset-0 overflow-y-auto px-3 md:px-10 pt-20 pb-28 ${
          messageLayout === 'terminal' ? 'space-y-0.5 font-mono' : 
          messageLayout === 'bubbles' ? 'space-y-2.5' : 
          'space-y-6'
        }`} ref={scrollRef} onScroll={handleScroll}>
        
        {messageLayout !== 'terminal' && !searchQuery && (
             <div className="pb-10 border-b border-white/5 mb-6">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-primary/30 to-transparent flex items-center justify-center mb-6 shadow-glow border border-primary/20 relative group">
                    <div className="absolute inset-0 grid-overlay opacity-30"></div>
                    {isDM ? <AtSign size={40} className="text-primary group-hover:scale-110 transition-transform" /> : <Hash size={40} className="text-primary group-hover:scale-110 transition-transform" />}
                </div>
                <h1 className="text-2xl md:text-4xl font-bold text-white mb-2.5 font-display tracking-tight">Welcome to {isDM ? '@' : '#'}{channel.name}</h1>
                <p className="text-caption text-white/50">{isDM ? 'This is the start of your conversation.' : `This is the beginning of the #${channel.name} channel.`}</p>
            </div>
        )}

        {filteredMessages.length === 0 && searchQuery && (
             <div className="flex flex-col items-center justify-center h-full text-white/30">
                 <Search size={40} className="mb-3 opacity-50" />
                 <p className="font-mono text-base">NO MATCHES FOUND</p>
             </div>
        )}

        {filteredMessages.map((msg, msgIndex) => {
          {/* Unread divider */}
          const showUnreadDivider = hasUnreadDivider && !searchQuery && msgIndex === UNREAD_AFTER_INDEX;

          {/* Deletion tombstone — shown instead of the original content */}
          if (msg.deletedAt) {
            const deletedUser = msg.deletedBy ? getUser(msg.deletedBy) : null;
            const deletedWhen = msg.deletedAt ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(msg.deletedAt)) : '';
            return (
              <React.Fragment key={msg.id}>
                {showUnreadDivider && (
                  <div className="flex items-center gap-3 py-1 -mx-1.5">
                    <div className="flex-1 h-[1px] bg-accent-danger/40" />
                    <span className="text-[9px] text-accent-danger font-bold font-mono tracking-widest">NEW</span>
                    <div className="flex-1 h-[1px] bg-accent-danger/40" />
                  </div>
                )}
                <div className="flex items-center gap-2 py-1.5 px-2 rounded-r1 text-[10px] text-white/25 italic select-none">
                  <Trash2 size={11} className="text-white/20 flex-shrink-0" />
                  <span>
                    Message deleted
                    {deletedUser && deletedUser.username !== 'Unknown' ? ` by ${deletedUser.username}` : ''}
                    {deletedWhen ? ` · ${deletedWhen}` : ''}
                  </span>
                </div>
              </React.Fragment>
            );
          }

          const user = getUser(msg.userId);
          const isSpecial = user.role === 'Admin' || user.role === 'Moderator';
          const isMe = msg.userId === 'me';
          const displayContent = msg.sticker
            ? <span className="text-5xl leading-none">{msg.content}</span>
            : searchQuery ? highlightText(msg.content, searchQuery) : renderMarkdown(msg.content);
          const replyMsg = msg.replyToId ? messagesState.find(m => m.id === msg.replyToId) : null;
          const replyUser = replyMsg ? getUser(replyMsg.userId) : null;

          // --- TERMINAL VIEW ---
          if (messageLayout === 'terminal') {
             return (
                 <React.Fragment key={msg.id}>
                  {showUnreadDivider && (
                    <div className="flex items-center gap-3 py-1 -mx-1.5">
                      <div className="flex-1 h-[1px] bg-accent-danger/40"></div>
                      <span className="text-[9px] text-accent-danger font-bold font-mono tracking-widest">NEW</span>
                      <div className="flex-1 h-[1px] bg-accent-danger/40"></div>
                    </div>
                  )}
                  <div 
                     id={buildMessageElementId(msg.id)}
                     onContextMenu={(e) => handleContextMenu(e, msg.id)}
                     className="flex text-xs hover:bg-white/5 px-1.5 -mx-1.5 py-0.5 rounded font-mono"
                  >
                     <span className="text-white/30 text-[10px] select-none whitespace-nowrap shrink-0 pt-[1px] inline-flex items-center gap-0.5">{msg.timestamp}{isMe && msg.delivery_status && <DeliveryStatusIcon status={msg.delivery_status} />}&nbsp;</span>
                     <div className="min-w-0">
                       <span className="font-bold whitespace-nowrap" style={{ color: user.color }}>{user.username}</span>
                       <span className="text-white/40">:&nbsp;</span>
                       <span className="text-white/90 break-words">{displayContent}{msg.editedAt && <span className="text-white/20 text-[8px] ml-1">(edited)</span>}</span>
                     </div>
                 </div>
                 </React.Fragment>
             )
          }

          // --- BUBBLES VIEW ---
          if (messageLayout === 'bubbles') {
              return (
                  <React.Fragment key={msg.id}>
                  {showUnreadDivider && (
                    <div className="flex items-center gap-3 py-2">
                      <div className="flex-1 h-[1px] bg-accent-danger/40"></div>
                      <span className="text-[9px] text-accent-danger font-bold font-mono tracking-widest">NEW MESSAGES</span>
                      <div className="flex-1 h-[1px] bg-accent-danger/40"></div>
                    </div>
                  )}
                    <div  
                         id={buildMessageElementId(msg.id)}
                         onMouseEnter={(e) => { if (!e.buttons) setHoveredMessageId(msg.id); }}
                         onMouseLeave={(e) => { if (!e.buttons && !reactionMenuMsgId) setHoveredMessageId(null); }}
                         onContextMenu={(e) => handleContextMenu(e, msg.id)}
                        className={`flex gap-2.5 w-full group relative ${isMe ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                      {!isMe && (
                        <UserPopup user={user}>
                            <UserAvatar user={user} className="w-7 h-7 rounded-full self-end mb-1 cursor-pointer hover:ring-2 hover:ring-primary transition-all shadow-lg" />
                        </UserPopup>
                      )}
                      
                       <div className={`max-w-[85%] md:max-w-[65%] relative flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                          {replyMsg && replyUser && (
                            <div className={`flex items-center gap-1.5 mb-1 px-2.5 py-0.5 rounded-full bg-white/5 border border-white/5 text-[10px] ${isMe ? 'self-end' : 'self-start'}`}>
                              <CornerUpRight size={9} className="text-primary/50" />
                              <span className="font-bold text-white/50">{replyUser.username}</span>
                              <span className="text-white/30 truncate max-w-[160px]">{replyMsg.content}</span>
                            </div>
                          )}
                          {!isMe && <div className="ml-1 mb-0.5 text-[9px] font-bold text-white/40 tracking-wider uppercase">{user.username}</div>}
                          
                          <div className={`px-4 py-2.5 text-[13px] leading-relaxed relative shadow-lg group-hover:brightness-110 transition-all
                              ${isMe 
                                  ? 'bg-primary text-bg-0 rounded-2xl rounded-tr-sm shadow-[0_0_15px_rgba(19,221,236,0.15)]' 
                                  : 'bg-white/5 border border-white/10 text-white/90 rounded-2xl rounded-tl-sm backdrop-blur-sm'
                              }`}
                          >
                             {editingMsgId === msg.id ? (
                               <div className="flex flex-col gap-1.5">
                                 <input
                                   type="text"
                                   value={editValue}
                                   onChange={(e) => setEditValue(e.target.value)}
                                   onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
                                   className="bg-white/10 border border-white/20 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-primary/50"
                                   autoFocus
                                 />
                                 <div className="flex gap-1.5 text-[9px]">
                                   <button onClick={saveEdit} className="text-primary hover:underline">save</button>
                                   <button onClick={cancelEdit} className="text-white/40 hover:underline">cancel</button>
                                 </div>
                               </div>
                             ) : (
                               <>{displayContent}{msg.editedAt && <span className={`text-[8px] ml-1 ${isMe ? 'text-bg-0/50' : 'text-white/20'}`}>(edited)</span>}</>
                             )}
                             <div className={`text-[8px] text-right mt-1 font-mono transition-opacity duration-300 flex items-center justify-end gap-1 ${isMe ? 'text-bg-0/70' : 'text-white/30'} ${hoveredMessageId === msg.id ? 'opacity-60' : 'opacity-0'}`}>
                                {msg.timestamp}
                                {isMe && msg.delivery_status && <DeliveryStatusIcon status={msg.delivery_status} />}
                             </div>
                          </div>
                          
                            {msg.reactions && msg.reactions.length > 0 && (
                                <div className={`flex gap-1 mt-1 flex-wrap ${isMe ? 'justify-end' : 'justify-start'}`}>
                                    {msg.reactions.map((r, i) => (
                                        <ReactionChip key={i} {...r} onClick={() => handleReactionToggle(msg.id, r.emoji)} compact />
                                    ))}
                                </div>
                            )}
                      </div>

                       {/* Action Menu for Bubbles */}
                       {hoveredMessageId === msg.id && (
                           <div className={`absolute top-0 ${isMe ? 'left-auto right-[calc(100%+6px)]' : 'left-[calc(100%+6px)]'} glass-panel border border-white/10 rounded-full px-1 py-0.5 flex items-center gap-0.5 shadow-xl animate-in fade-in zoom-in-95 z-10`}>
                             {!hasIdentity ? (
                               <button onClick={() => onOpenAuth?.()} className="px-2.5 py-1 text-[10px] font-bold text-primary hover:text-primary/80 transition-colors whitespace-nowrap">
                                 Sign in to react
                               </button>
                             ) : (<>
                               <ActionBtn icon={<Smile size={14} />} label="Add Reaction" onClick={() => setReactionMenuMsgId(msg.id)} />
                                 <ActionBtn icon={<MessageSquare size={14} />} label="Reply" onClick={() => setReplyingTo(msg)} />
                               {isMe && <ActionBtn icon={<Pencil size={14} />} label="Edit Message" onClick={() => startEdit(msg)} />}
                               <ActionBtn icon={<Trash2 size={14} />} label="Delete Message" onClick={() => deleteMessage(msg.id)} />
                               <ActionBtn
                                 icon={<MicOff size={14} className={mutedUsers.has(msg.userId) ? "text-accent-danger" : ""} />}
                                 label={mutedUsers.has(msg.userId) ? "Unmute User" : "Mute User"}
                                 onClick={() => toggleMuteUser(msg.userId)}
                               />
                                <ActionBtn icon={<MoreHorizontal size={14} />} label="More" onClick={(e) => { e.stopPropagation(); handleContextMenu(e as unknown as React.MouseEvent, msg.id); }} />

                               {reactionMenuMsgId === msg.id && (
                                    <div className="absolute top-full left-0 mt-1.5 p-1.5 glass-card rounded-r2 border border-white/10 shadow-2xl z-50 flex gap-0.5 animate-in zoom-in-95 min-w-[160px] flex-wrap justify-center">
                                        {REACTION_EMOJIS.map(emoji => (
                                            <button 
                                                key={emoji}
                                                onClick={() => handleReactionToggle(msg.id, emoji)}
                                                className="p-1.5 hover:bg-white/10 rounded-full transition-colors text-base"
                                            >
                                                {emoji}
                                            </button>
                                        ))}
                                        <button onClick={() => setReactionMenuMsgId(null)} className="p-1.5 hover:bg-white/10 rounded-full transition-colors text-white/40"><X size={12} /></button>
                                    </div>
                                )}
                             </>)}
                           </div>
                       )}
                  </div>
                  </React.Fragment>
              )
          }

          // --- MODERN VIEW (Default) ---
          return (
            <React.Fragment key={msg.id}>
            {showUnreadDivider && (
              <div className="flex items-center gap-3 py-2 -mx-2.5">
                <div className="flex-1 h-[1px] bg-accent-danger/40"></div>
                <span className="text-[9px] text-accent-danger font-bold font-mono tracking-widest">NEW MESSAGES</span>
                <div className="flex-1 h-[1px] bg-accent-danger/40"></div>
              </div>
            )}
            <div 
                id={buildMessageElementId(msg.id)}
                 onMouseEnter={(e) => { if (!e.buttons) setHoveredMessageId(msg.id); }}
                 onMouseLeave={(e) => { if (!e.buttons && !reactionMenuMsgId) setHoveredMessageId(null); }}
                 onContextMenu={(e) => handleContextMenu(e, msg.id)}
                onDoubleClick={() => { if (isMe) startEdit(msg); }}
                className={`flex gap-5 group relative p-2.5 -mx-2.5 rounded-r1 transition-all hover:bg-white/[0.03] ${isSpecial ? 'bg-gradient-to-r from-primary/5 to-transparent border-l-2 border-primary/20' : ''}`}
            >
              {isSpecial && <div className="absolute left-0 top-2.5 bottom-2.5 w-[2px] bg-primary rounded-full shadow-glow"></div>}

               <UserPopup user={user}>
                 <div className="w-11 h-11 rounded-r2 overflow-hidden cursor-pointer ring-1 ring-white/10 hover:ring-primary transition-all shadow-xl mt-1 relative flex-shrink-0">
                    <UserAvatar user={user} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                 </div>
              </UserPopup>
              
              <div className="flex-1 min-w-0">
                {replyMsg && replyUser && (
                  <div className="flex items-center gap-1.5 mb-1.5 pl-1">
                    <div className="w-[2px] h-3.5 bg-primary/30 rounded-full"></div>
                    <UserAvatar user={replyUser} className="w-3.5 h-3.5 rounded-full" alt="" />
                    <span className="text-[10px] font-bold text-white/50">{replyUser.username}</span>
                    <span className="text-[10px] text-white/30 truncate max-w-[240px]">{replyMsg.content}</span>
                  </div>
                )}
                <div className="flex items-center gap-2.5 mb-1.5 flex-wrap min-h-[20px]">
                  <UsernameDisplay user={user} />
                  {user.role === 'Bot' && (
                    <span className="bg-primary/20 text-primary text-[7px] px-1.5 py-[2px] rounded-full font-bold micro-label tracking-tight border border-primary/30">Bot</span>
                  )}
                  <span className="opacity-0 group-hover:opacity-100 transition-all duration-300 translate-x-[-5px] group-hover:translate-x-0">
                    <span className="px-1.5 py-0.5 rounded-full bg-white/5 border theme-border text-[7px] font-mono theme-text-dim tracking-widest shadow-sm">
                        {msg.timestamp}
                    </span>
                  </span>
                  {isMe && msg.delivery_status && (
                    <span className="opacity-60 flex items-center">
                      <DeliveryStatusIcon status={msg.delivery_status} />
                    </span>
                  )}
                </div>
                {editingMsgId === msg.id ? (
                  <div className="flex flex-col gap-1.5 mt-1">
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
                      className="bg-white/5 border border-white/10 rounded-r1 px-3 py-1.5 text-[13px] text-white font-chat focus:outline-none focus:border-primary/50 w-full"
                      autoFocus
                    />
                    <div className="flex gap-2.5 text-[10px]">
                      <span className="text-white/30">escape to <button onClick={cancelEdit} className="text-primary hover:underline">cancel</button></span>
                      <span className="text-white/30">enter to <button onClick={saveEdit} className="text-primary hover:underline">save</button></span>
                    </div>
                  </div>
                ) : (
                  <div className="theme-text-secondary leading-relaxed font-chat font-light text-[15px] selection:bg-primary/30 selection:text-white tracking-wide break-words select-text cursor-text">
                    {displayContent}
                    {msg.editedAt && <span className="text-white/20 text-[9px] ml-1">(edited)</span>}
                  </div>
                )}
                
                {/* Poll embed — data encoded in message content, votes P2P-synced */}
                {msg.content.startsWith('🗳️ POLL:') && (() => {
                  try {
                    const raw = JSON.parse(msg.content.slice('🗳️ POLL:'.length)) as { q: string; o: string[] };
                    const votes = msg.poll_votes ?? {};
                    const options = raw.o.map((text, i) => ({ text, votes: (votes[i] ?? []).length }));
                    const totalVotes = options.reduce((sum, o) => sum + o.votes, 0);
                    return (
                      <PollMessage
                        question={raw.q}
                        options={options}
                        totalVotes={totalVotes}
                        votedIndex={null}
                        onVote={(i) => castPollVoteMutation.mutate({ messageId: msg.id, optionIndex: i })}
                      />
                    );
                  } catch { return null; }
                })()}

                {/* Media Embeds */}
                <MediaEmbed content={msg.content} />

                {/* End-to-end encrypted attachments (decrypted on view) */}
                {msg.media && msg.media.length > 0 && (
                  <div className="flex flex-col items-start gap-1">
                    {msg.media.map((att) => <AttachmentView key={att.id} attachment={att} />)}
                  </div>
                )}

                {msg.reactions && msg.reactions.length > 0 && (
                    <div className="flex gap-1.5 mt-3 flex-wrap">
                        {msg.reactions.map((r, i) => (
                            <ReactionChip key={i} {...r} onClick={() => handleReactionToggle(msg.id, r.emoji)} />
                        ))}
                    </div>
                )}
              </div>

              {hoveredMessageId === msg.id && (
                  <div className="absolute -top-4 right-6 glass-panel border border-white/10 rounded-full px-2.5 py-1 flex items-center gap-1.5 shadow-2xl animate-in fade-in zoom-in-95 z-10">
                      {!hasIdentity ? (
                        <button onClick={() => onOpenAuth?.()} className="px-2 py-0.5 text-[10px] font-bold text-primary hover:text-primary/80 transition-colors whitespace-nowrap">
                          Sign in to react
                        </button>
                      ) : (<>
                      <ActionBtn icon={<Smile size={14} />} label="Add Reaction" onClick={() => setReactionMenuMsgId(msg.id)} />
                      <ActionBtn icon={<MessageSquare size={14} />} label="Reply" onClick={() => setReplyingTo(msg)} />
                      {isMe && <ActionBtn icon={<Pencil size={14} />} label="Edit Message" onClick={() => startEdit(msg)} />}
                      <ActionBtn icon={<Pin size={14} className={msg.pinned ? 'text-primary' : ''} />} label={msg.pinned ? 'Unpin' : 'Pin'} onClick={() => togglePin(msg.id)} />
                      {hasForwarding && <ActionBtn icon={<Forward size={14} />} label="Forward" onClick={() => setForwardingContent(msg.content)} />}
                      {hasThreads && <ActionBtn icon={<MessageCircle size={14} />} label="Thread" onClick={() => setThreadMessage(msg)} />}
                      {hasMessageLinks && <ActionBtn icon={<Link2 size={14} />} label="Copy Link" onClick={() => copyMessageLink(msg.id)} />}
                      <ActionBtn icon={<Trash2 size={14} />} label="Delete Message" onClick={() => deleteMessage(msg.id)} />
                      <ActionBtn
                        icon={<MicOff size={14} className={mutedUsers.has(msg.userId) ? "text-accent-danger" : ""} />}
                        label={mutedUsers.has(msg.userId) ? "Unmute User" : "Mute User"}
                        onClick={() => toggleMuteUser(msg.userId)}
                      />
                      <ActionBtn icon={<MoreHorizontal size={14} />} label="More Actions" onClick={(e) => { e.stopPropagation(); handleContextMenu(e as unknown as React.MouseEvent, msg.id); }} />

                      {reactionMenuMsgId === msg.id && (
                            <div className="absolute bottom-full right-0 mb-1.5 p-1.5 glass-card rounded-r2 border border-white/10 shadow-2xl z-50 flex gap-0.5 animate-in zoom-in-95 min-w-[160px] flex-wrap justify-center">
                                {REACTION_EMOJIS.map(emoji => (
                                    <button 
                                        key={emoji}
                                        onClick={() => handleReactionToggle(msg.id, emoji)}
                                        className="p-1.5 hover:bg-white/10 rounded-full transition-colors text-base"
                                    >
                                        {emoji}
                                    </button>
                                ))}
                                <button onClick={() => setReactionMenuMsgId(null)} className="p-1.5 hover:bg-white/10 rounded-full transition-colors text-white/40"><X size={12} /></button>
                            </div>
                        )}
                      </>)}
                  </div>
              )}
            </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Pinned Messages Drawer */}
      {showPinned && (
        <>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm z-30 animate-in fade-in" onClick={() => setShowPinned(false)} />
          <div className="absolute top-0 right-0 bottom-0 w-[288px] max-w-full bg-bg-0 border-l border-white/10 z-40 flex flex-col animate-in slide-in-from-right duration-300 shadow-2xl">
            <div className="h-[52px] px-5 flex items-center justify-between border-b border-white/5 shrink-0">
              <div>
                <h3 className="font-bold text-white text-xs font-display">PINNED // MESSAGES</h3>
                <span className="micro-label text-white/30 text-[8px]">ARCHIVE // {messagesState.filter(m => m.pinned).length} ENTRIES</span>
              </div>
              <button onClick={() => setShowPinned(false)} className="p-1.5 text-white/40 hover:text-primary transition-colors rounded-full hover:bg-white/5">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2.5 no-scrollbar">
              {messagesState.filter(m => m.pinned).length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-6">
                  <Pin size={40} className="text-white/10 mb-3" />
                  <p className="text-white/30 text-xs font-bold mb-1">No Pinned Messages</p>
                  <p className="text-white/15 text-[10px] font-mono">PIN IMPORTANT MESSAGES TO KEEP THEM HERE</p>
                </div>
              ) : (
                messagesState.filter(m => m.pinned).map(m => {
                  const pinnedUser = getUser(m.userId);
                  return (
                    <div key={m.id} className="glass-card rounded-r1 border border-white/8 p-3 group hover:border-primary/20 transition-all">
                      <div className="flex items-center gap-2.5 mb-2.5">
                        <UserAvatar user={pinnedUser} className="w-7 h-7 rounded-full border border-white/10" />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-bold" style={{ color: pinnedUser.color }}>{pinnedUser.username}</span>
                          <span className="text-[9px] text-white/30 font-mono ml-1.5">{m.timestamp}</span>
                        </div>
                        <button 
                          onClick={() => togglePin(m.id)}
                          className="p-1 text-white/20 hover:text-accent-danger hover:bg-accent-danger/10 rounded-full transition-all opacity-0 group-hover:opacity-100"
                          aria-label="Unpin"
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <div className="text-xs text-white/70 leading-relaxed">{renderMarkdown(m.content)}</div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}


      {/* Input Area */}
      <div className="absolute bottom-0 left-0 right-0 p-3 md:p-6 pt-0 z-10">
        {showSlashCommands && (
            <div className="absolute bottom-20 left-6 w-52 bg-bg-0 border border-white/10 rounded-r2 shadow-2xl z-50 glass-card overflow-hidden animate-in slide-in-from-bottom-2">
                <div className="micro-label text-primary/60 px-3 py-1.5 bg-white/5">COMMANDS</div>
                <div className="p-1.5 space-y-0.5">
                    {['me', 'shrug', 'nick', 'clear'].map(cmd => (
                        <button key={cmd} onClick={() => handleSlashCommand(cmd)} className="w-full text-left px-2.5 py-1.5 hover:bg-white/10 rounded-r1 text-white text-xs font-mono flex items-center gap-1.5">
                            <span className="text-primary">/</span>{cmd}
                        </button>
                    ))}
                </div>
            </div>
        )}

        {/* Typing Indicator */}
        <TypingIndicator users={normalizedUsers} currentUserId="me" typingUserIds={typingUserIds} />

        {!hasIdentity ? (
          <button
            onClick={onOpenAuth}
            className="glass-realistic rounded-r2 w-full flex items-center justify-between px-5 py-4 text-white/50 hover:text-white transition-all group border border-white/5 hover:border-primary/30"
            aria-label="Create identity to post"
          >
            <span className="text-sm">Sign in to post in {isDM ? '@' : '#'}{channel.name}</span>
            <span className="text-xs font-bold text-primary group-hover:text-primary opacity-80 group-hover:opacity-100 transition-opacity">Create account</span>
          </button>
        ) : (
          <>
            <div className="mb-2 px-1 flex items-center justify-between gap-2 text-[9px] font-mono tracking-[0.18em] uppercase">
              <span className={`${chatSupport.mode === 'offline' ? 'text-accent-danger/80' : 'text-primary/70'}`}>
                {chatSupport.mode === 'offline' ? 'offline' : 'connected'}
              </span>
              <span className={`${composerFeedback?.tone === 'error' ? 'text-accent-danger/75' : composerFeedback?.tone === 'success' ? 'text-accent-success/80' : 'text-white/45'} text-right`}>{composerFeedback?.text || chatSupport.detail}</span>
            </div>

            {/* Reply Preview Bar */}
            {replyingTo && (
              <div className="glass-card rounded-t-r2 border border-white/10 border-b-0 px-3 py-2.5 flex items-center gap-2.5 animate-in slide-in-from-bottom-2">
                <div className="w-[2px] h-6 bg-primary rounded-full flex-shrink-0"></div>
                <div className="flex-1 min-w-0">
                  <div className="micro-label text-primary mb-0.5">REPLYING TO // {getUser(replyingTo.userId).username.toUpperCase()}</div>
                  <div className="text-[10px] text-white/50 truncate">{replyingTo.content}</div>
                </div>
                <button onClick={() => setReplyingTo(null)} className="p-1 text-white/30 hover:text-white hover:bg-white/10 rounded-full transition-colors" aria-label="Cancel reply">
                  <X size={14} />
                </button>
              </div>
            )}

            <div className={`glass-realistic ${replyingTo ? 'rounded-b-r2 rounded-t-none' : 'rounded-r2'} flex items-end p-1.5 focus-within:border-primary/50 transition-all shadow-2xl relative overflow-visible group`}>
                <div className="absolute inset-0 grid-overlay opacity-5 group-focus-within:opacity-10 pointer-events-none"></div>

                {/* Mention Autocomplete */}
                {mentionQuery !== null && hasMentionAutocomplete && (
                  <MentionAutocomplete
                    users={normalizedUsers}
                    query={mentionQuery}
                    onSelect={(user) => {
                      setInputValue(prev => prev.replace(/@\w*$/, `@${user.username} `));
                      setMentionQuery(null);
                    }}
                    onClose={() => setMentionQuery(null)}
                  />
                )}

                {hasFileUploads && (
                  <>
                    <input type="file" ref={fileInputRef} className="hidden" onChange={handleFileUpload} />
                    <button onClick={() => fileInputRef.current?.click()} className="p-3 text-white/30 hover:text-primary transition-colors" aria-label="Add attachment"><PlusCircle size={20} /></button>
                  </>
                )}
                {hasPolls && (
                  <button onClick={() => setShowPollCreator(!showPollCreator)} className={`p-2 transition-colors ${showPollCreator ? 'text-primary' : 'text-white/30 hover:text-primary'}`} aria-label="Create Poll">
                    <BarChart3 size={18} />
                  </button>
                )}

                <textarea
                    ref={composerRef}
                    rows={1}
                    placeholder={`INPUT // ${isDM ? '@' : '#'}${channel.name.toUpperCase()}`}
                    className="flex-1 bg-transparent border-none focus:outline-none text-white px-3 py-2 font-mono text-xs placeholder-white/40 focus-ring rounded-r1 resize-none leading-relaxed"
                    aria-label="Message Input"
                    aria-multiline="true"
                    value={inputValue}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                />
                <div className="flex items-center gap-2.5 px-1.5">
                    <div className="relative">
                        <button onClick={() => { setShowStickerPicker(prev => !prev); setShowEmojiPicker(false); }} className={`p-2 transition-all ${showStickerPicker ? 'text-primary' : 'text-white/40 hover:text-primary'}`} aria-label="Stickers"><Sticker size={18} /></button>
                        {showStickerPicker && (
                          <StickerPicker
                            onSelect={handleSendSticker}
                            onClose={() => setShowStickerPicker(false)}
                          />
                        )}
                    </div>
                    <div className="relative">
                        <button onClick={() => { setShowEmojiPicker(prev => !prev); setShowStickerPicker(false); }} className={`p-2 transition-all ${showEmojiPicker ? 'text-primary' : 'text-white/40 hover:text-primary'}`} aria-label="Emoji Picker"><Smile size={18} /></button>
                        {showEmojiPicker && (
                          <EmojiPicker
                            onSelect={(emoji) => { setInputValue(prev => prev + emoji); setShowEmojiPicker(false); }}
                            onClose={() => setShowEmojiPicker(false)}
                          />
                        )}
                    </div>
                    <button
                      onClick={handleSendMessage}
                      disabled={!inputValue.trim()}
                      className={`w-10 h-10 rounded-full flex items-center justify-center transition-all btn-press focus-ring ${
                        inputValue.trim()
                          ? 'bg-primary text-bg-0 shadow-glow hover:scale-105 group-focus-within:shadow-[0_0_20px_#13DDEC] cursor-pointer'
                          : 'bg-white/10 text-white/30 cursor-not-allowed'
                      }`}
                      aria-label="Send Message"
                    ><Send size={18} /></button>
                </div>
            </div>
          </>
        )}
      </div>

      {/* Poll Creator */}
      {showPollCreator && hasPolls && (
          <PollCreator
          onSubmit={(question, options) => {
            const body = `🗳️ POLL:${JSON.stringify({ q: question, o: options })}`;
            if (channel?.id && !isDM) {
              void sendChannelMutation.mutateAsync({ channelId: channel.id, content: body });
            } else if (isDM && channel?.id) {
              void sendDmMutation.mutateAsync({ dmId: channel.id, content: body });
            }
            setShowPollCreator(false);
          }}
          onClose={() => setShowPollCreator(false)}
        />
      )}

      {/* Forward Modal */}
      {forwardingContent !== null && hasForwarding && (
        <ForwardMessageModal
          messageContent={forwardingContent}
          destinations={forwardDestinations}
          onForward={handleForwardMessage}
          onClose={() => setForwardingContent(null)}
        />
      )}

      {/* Jump to Present */}
      {hasJumpToPresent && isScrolledUp && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-32 left-1/2 -translate-x-1/2 z-20 glass-card bg-bg-0/80 border border-white/10 rounded-full px-4 py-2 flex items-center gap-2 shadow-2xl hover:border-primary/30 transition-all animate-in fade-in slide-in-from-bottom-2 btn-press hover-lift"
        >
          <ArrowDown size={14} className="text-primary" />
          <span className="text-[10px] text-white/60 font-mono font-bold">JUMP TO PRESENT</span>
        </button>
      )}

      {/* Delete Confirmation */}
      {deleteTarget && hasDeleteConfirm && (
        <ConfirmDeleteModal
          messageContent={deleteTarget.content}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Thread Panel */}
      {threadMessage && hasThreads && (() => {
        // Derive thread replies from real messages (reply_to field, set P2P) so threads
        // survive page reload and show replies from other peers — not just local state.
        const nativeReplies = messagesState.filter(m => m.replyToId === threadMessage.id);
        const localReplies = (threadRepliesByParent[threadMessage.id] ?? []).filter(
          lr => !nativeReplies.some(nr => nr.id === lr.id),
        );
        const allReplies = [...nativeReplies, ...localReplies];
        return (
          <ThreadPanel
            parentMessage={threadMessage}
            parentUser={getUser(threadMessage.userId)}
            allUsers={normalizedUsers}
            replies={allReplies}
            onSend={(content) => {
              // Send as a real message with reply_to so it propagates P2P.
              if (channel?.id && !threadMessage.id.startsWith(MESSAGE_ID_PREFIX)) {
                if (isDM) {
                  void sendDmMutation.mutateAsync({ dmId: channel.id, content });
                } else {
                  void sendChannelMutation.mutateAsync({ channelId: channel.id, content, replyTo: threadMessage.id });
                }
              } else {
                // Offline/local: keep in component state only.
                const nextThreadReplies = {
                  ...threadRepliesByParent,
                  [threadMessage.id]: [
                    ...(threadRepliesByParent[threadMessage.id] ?? []),
                    createLocalMessage(content, { replyToId: threadMessage.id }),
                  ],
                };
                setThreadRepliesByParent(nextThreadReplies);
                persistScopeState({ threads: nextThreadReplies });
              }
            }}
            onClose={() => setThreadMessage(null)}
          />
        );
      })()}

      {/* Media Lightbox */}
      {lightboxSrc && hasLightbox && (
        <MediaLightbox
          src={lightboxSrc}
          onClose={() => setLightboxSrc(null)}
        />
      )}

      {/* Search Panel */}
      {showSearchPanel && hasAdvancedSearch && (
        <SearchPanel onClose={() => setShowSearchPanel(false)} />
      )}

      {/* Security mode summary — surfaces the REAL negotiated mode and its
          guarantees so users can verify how the conversation is protected. No
          fabricated key fingerprints: the engine does not expose safety numbers
          yet, so we report only what is genuinely known. */}
      {showSecuritySummary && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setShowSecuritySummary(false)} aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Conversation security mode"
            className="absolute top-[56px] left-3 lg:left-6 z-40 w-[300px] glass-card border border-white/10 rounded-r2 shadow-2xl p-4 animate-in fade-in slide-in-from-top-2 duration-200"
          >
            <div className="flex items-center justify-between mb-2.5">
              <div className={`flex items-center gap-1.5 ${securityBadge.className}`}>
                {securityBadge.insecure ? <AlertTriangle size={14} /> : <Lock size={14} />}
                <span className="micro-label tracking-widest">{securityBadge.label}</span>
              </div>
              <button
                onClick={() => setShowSecuritySummary(false)}
                className="p-1 text-white/30 hover:text-white hover:bg-white/10 rounded-full transition-colors focus-ring"
                aria-label="Close security summary"
              >
                <X size={14} />
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-white/70">{securityBadge.description}</p>
            {securityBadge.insecure && (
              <p className="text-[10px] leading-relaxed text-accent-danger/80 mt-2 font-bold">
                Do not share anything sensitive in this conversation.
              </p>
            )}
            {isDM && dmVerification && (
              <button
                onClick={() => { setShowSecuritySummary(false); setShowKeyVerification(true); }}
                className={`focus-ring mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-full text-[11px] font-bold transition-all ${
                  dmVerification.changed
                    ? 'bg-accent-danger/15 text-accent-danger hover:brightness-110'
                    : dmVerification.verified
                      ? 'border border-accent-success/30 text-accent-success hover:bg-accent-success/10'
                      : 'border border-white/10 text-white/70 hover:bg-white/5'
                }`}
              >
                {dmVerification.changed
                  ? 'Safety number changed — review'
                  : dmVerification.verified
                    ? 'Verified — view safety number'
                    : 'Verify safety number'}
              </button>
            )}
          </div>
        </>
      )}

      {showKeyVerification && dmVerification && (
        <KeyVerification
          peerName={channel?.name?.trim() || 'this contact'}
          localPeerId={dmVerification.localPeerId}
          localIdentityKey={dmVerification.localIdentityKey}
          remotePeerId={dmVerification.remotePeerId}
          remoteIdentityKey={dmVerification.remoteIdentityKey}
          verified={dmVerification.verified}
          changed={dmVerification.changed}
          onSetVerified={(verified) => {
            setPeerVerified.mutate({ peerId: dmVerification.remotePeerId, verified });
          }}
          onClose={() => setShowKeyVerification(false)}
        />
      )}

      {/* Inbox Panel */}
      {showInbox && hasInbox && (
        <InboxPanel
          items={unreadInboxItems}
          messages={messagesState}
          users={normalizedUsers.map((user) => user.id === 'me' && localNickname.trim() ? { ...user, username: localNickname.trim() } : user)}
          onJump={(item) => {
            const nextReadIds = new Set(inboxReadIds);
            nextReadIds.add(item.id);
            setInboxReadIds(nextReadIds);
            persistScopeState({ inboxReadIds: nextReadIds });
            void markNotificationsRead(runtimeSnapshot, {
              read_through_message_id: item.messageId,
              scope_type: isDM ? 'dm' : 'channel',
              scope_id: channel?.id,
            }).catch(() => { /* best-effort */ });
            jumpToMessage(item.messageId);
          }}
          onMarkAllRead={() => {
            const nextReadIds = new Set(inboxReadIds);
            let latestMessageId: string | undefined;
            for (const item of unreadInboxItems) {
              nextReadIds.add(item.id);
              latestMessageId = item.messageId;
            }
            setInboxReadIds(nextReadIds);
            persistScopeState({ inboxReadIds: nextReadIds });
            if (latestMessageId && chatSupport.mode !== 'offline') {
              void markNotificationsRead(runtimeSnapshot, {
                read_through_message_id: latestMessageId,
                scope_type: isDM ? 'dm' : 'channel',
                scope_id: channel?.id,
              }).catch(() => { /* best-effort */ });
            }
          }}
          onClose={() => setShowInbox(false)}
        />
      )}
    </div>
  );
};
