
import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Channel, Message, User, MessageLayout, XoreinAttachment } from '@/types';
import { AttachmentView } from '@/components/AttachmentView';
import { generateTheme } from '@/utils/themeGenerator';
import { resolveSecurityMode } from '@/lib/securityMode';
import { formatDateTime } from '@/lib/locale';
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
import { useSendChannelMessage, useSendDmMessage, useEditMessage, useDeleteMessage, useAddReaction, useRemoveReaction, usePinMessage, useUnpinMessage, useCastPollVote, useLoadOlderHistory, useSetPeerVerified, useSubmitReport } from '@/hooks/runtime/mutations';
import { KeyVerification } from '@/components/KeyVerification';
import { ReportModal, type ReportSubmission } from '@/components/ReportModal';
import { useRuntimeMutations } from '@/hooks/runtime/useRuntimeMutations';
import { uploadEncryptedAttachment } from '@/native/blobs/blobs';
import { nativeNotifyTyping, nativeStopTyping } from '@/native/state/mutations';
import { useContextMenu } from '@/components/GlobalContextMenuContext';
import { readShellRuntimeData } from '@/data';
import {
  readBrowserChatActionSupport,
  readPersistedChatScopeState,
  writePersistedChatScopeState,
} from '@/protocol/client';
import { Hash, Bell, Pin, Users, Search, MoreHorizontal, MessageSquare, AtSign, Smile, Sticker, PlusCircle, X, Send, LayoutTemplate, Menu, Trash2, MicOff, Image, FileText, Reply, CornerUpRight, Pencil, Check, PanelRightClose, Forward, BarChart3, Link2, ArrowDown, MessageCircle, Inbox, Star, Lock, AlertTriangle, Clock, WifiOff, Flag, SlidersHorizontal } from 'lucide-react';
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

// Gradient text (background-clip: text + transparent fill) is a progressive
// enhancement: where the technique is unsupported the transparent fill would
// leave the author name INVISIBLE. Detect support once and otherwise fall back
// to a solid colour — a username must never be invisible.
const SUPPORTS_TEXT_CLIP_GRADIENT =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' &&
  (CSS.supports('-webkit-background-clip', 'text') || CSS.supports('background-clip', 'text'));
const SUPPORTS_COLOR_MIX =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' &&
  CSS.supports('color', 'color-mix(in srgb, red 60%, transparent)');

// Append an alpha to a user colour WITHOUT ever producing invalid CSS. The old
// `${color}AA` trick only parses for 6-digit hex colours; native-path users get
// `hsl(h 72% 58%)` colours (data.ts colorForSeed), and `hsl(...)AA` invalidates
// the whole gradient declaration — which, combined with the transparent text
// fill, rendered every author name invisible (blank names in the E2E shots).
const fadeColor = (color: string, alphaHex: string, percent: number): string => {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return `${color}${alphaHex}`;
  return SUPPORTS_COLOR_MIX ? `color-mix(in srgb, ${color} ${percent}%, transparent)` : color;
};

// Enhanced Username Component with cyberpunk visual effects
const UsernameDisplay = ({ user, compact = false }: { user: User, compact?: boolean }) => {
  const isSpecial = user.role === 'Admin' || user.role === 'Moderator';
  const baseColor = user.color || '#F6F8F8';

  const gradient = baseColor === '#13DDEC'
    ? 'linear-gradient(135deg, #13DDEC 0%, #00A8CC 100%)'
    : `linear-gradient(135deg, ${baseColor} 0%, ${fadeColor(baseColor, 'AA', 67)} 100%)`;

  const glowColor = fadeColor(baseColor, '66', 40);

  return (
    <span className={`font-bold ${compact ? 'text-xs' : 'text-[13px]'} tracking-tight cursor-pointer transition-all duration-300 relative px-1 -mx-1 rounded-md inline-flex items-center gap-1.5`}>
      <span
        className="transition-all duration-300 hover:brightness-125 font-display"
        style={{
          // Solid fallback colour first — it paints the glyphs whenever the
          // gradient-clip technique is unavailable, so the name always renders.
          color: baseColor,
          ...(SUPPORTS_TEXT_CLIP_GRADIENT ? {
            background: gradient,
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          } : {}),
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
    const deletedAt = typeof record.deletedAt === 'string' && record.deletedAt.trim() ? record.deletedAt.trim() : undefined;
    const deletedBy = typeof record.deletedBy === 'string' && record.deletedBy.trim() ? record.deletedBy.trim() : undefined;
    const pollVotes = normalizePollVotes(record.poll_votes);

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
      ...(deletedAt ? { deletedAt } : {}),
      ...(deletedBy ? { deletedBy } : {}),
      ...(pollVotes ? { poll_votes: pollVotes } : {}),
      ...(record.securityMode === 'seal' || record.securityMode === 'crowd' || record.securityMode === 'clear' ? { securityMode: record.securityMode } : {}),
      ...(typeof record.encrypted === 'boolean' ? { encrypted: record.encrypted } : {}),
    });
  }

  return normalized;
}

/** Validate `poll_votes` (option index → voter peer ids) from an untrusted record. */
function normalizePollVotes(value: unknown): Record<number, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const normalized: Record<number, string[]> = {};
  let any = false;
  for (const [key, voters] of Object.entries(value as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(voters)) {
      continue;
    }
    normalized[index] = voters.filter((voter): voter is string => typeof voter === 'string' && voter.trim().length > 0);
    any = true;
  }
  return any ? normalized : undefined;
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

const formatTimestamp = (value = Date.now()) => formatDateTime(new Date(value), {
  hour: 'numeric',
  minute: '2-digit',
});

const buildMessageElementId = (messageId: string) => `chat-message-${messageId}`;

const formatAttachmentLabel = (file: File) => {
  const sizeKb = Math.max(1, Math.round(file.size / 1024));
  return `${file.name} • ${sizeKb} KB`;
};

const POLL_CONTENT_PREFIX = '🗳️ POLL:';

/** Parse a poll message body (`🗳️ POLL:{"q":…,"o":[…]}`). Null when not a poll / malformed. */
function parsePollContent(content: string): { q: string; o: string[] } | null {
  if (typeof content !== 'string' || !content.startsWith(POLL_CONTENT_PREFIX)) return null;
  try {
    const raw = JSON.parse(content.slice(POLL_CONTENT_PREFIX.length)) as { q?: unknown; o?: unknown };
    if (typeof raw.q !== 'string' || !Array.isArray(raw.o)) return null;
    const options = raw.o.filter((option): option is string => typeof option === 'string' && option.trim().length > 0);
    if (options.length === 0) return null;
    return { q: raw.q, o: options };
  } catch {
    return null;
  }
}

/** Human-readable one-line preview of a message body (hides encoded poll payloads). */
function messagePreviewText(content: string): string {
  const poll = parsePollContent(content);
  return poll ? `🗳️ ${poll.q}` : content;
}

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
    () => messages.some((m) => {
      if (m.isSystem) return false;
      if (m.securityMode === 'clear' || m.encrypted === false) return true;
      // Unstamped legacy messages — persisted before provenance stamping and, under the
      // old inbound path, possibly accepted as plaintext — carry NEITHER securityMode nor
      // `encrypted`. Their provenance is unknown, so treat them as insecure rather than let
      // the badge over-claim E2EE for pre-upgrade history. (Every current send/receive path
      // stamps provenance, so this only ever matches genuinely-unstamped legacy records.)
      return m.securityMode == null && m.encrypted == null;
    }),
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
  const submitReport = useSubmitReport();
  const [reportTarget, setReportTarget] = useState<{ messageId: string; userId: string; content: string; label: string } | null>(null);
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

  // Notification read-state/search go through the mutation facade: on the native
  // path they are handled locally and never reach the support node (which channel
  // you read, and when, is identity metadata the untrusted node must not see).
  const { searchNotifications, markNotificationsRead } = useRuntimeMutations();
  const sendChannelMutation = useSendChannelMessage();
  const sendDmMutation = useSendDmMessage();
  const editMutation = useEditMessage();
  const deleteMutation = useDeleteMessage();
  const addReactionMutation = useAddReaction();
  const removeReactionMutation = useRemoveReaction();
  const pinMutation = usePinMessage();
  const unpinMutation = useUnpinMessage();
  const castPollVoteMutation = useCastPollVote();
  const loadOlderMutation = useLoadOlderHistory();

  // Older-history paging: whether more history is believed to exist further back,
  // and a ref holding the scroll height captured just before a prepend so we can
  // restore the viewport to the same messages instead of jumping.
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const preserveScrollRef = useRef<number | null>(null);

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

  // Ctrl/Cmd+F opens the advanced message search — the shortcut documented in the
  // keyboard-shortcuts overlay ("Search Messages"). Browser find is intentionally
  // overridden while a chat scope is focused, matching Discord.
  useEffect(() => {
    if (!hasAdvancedSearch) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setShowSearchPanel((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasAdvancedSearch]);

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

  // Merge the LIVE runtime view of the scope with the locally persisted copy.
  //
  // The network owns message facts (body/edits/reactions/pins/deletes/poll votes/
  // security provenance), so for any id present in the live snapshot the LIVE copy
  // wins — a stale persisted copy must never shadow a remote reaction, edit, pin
  // or delete. Persistence only contributes:
  //   • messages MISSING from the live snapshot (offline history, locally composed
  //     `local-msg-*` entries), appended in their persisted order, and
  //   • local tombstone annotations (deletedAt/deletedBy) for locally deleted ids.
  const mergePersistedMessages = useCallback((incomingMessages: Message[], persistedMessages: Message[], deletedIds: Set<string>) => {
    const stampTombstone = (message: Message): Message =>
      message.deletedAt ? message : { ...message, deletedAt: new Date().toISOString() };
    const persistedById = new Map(persistedMessages.map((message) => [message.id, message]));
    const incomingIds = new Set(incomingMessages.map((message) => message.id));

    // Persisted-only messages keep their persisted RELATIVE position: walk the
    // persisted order backwards to find each one's first successor that is also
    // live, and inject it just before that successor (locally composed messages
    // with no live successor land at the end, as before).
    const insertBefore = new Map<string, Message[]>();
    const tail: Message[] = [];
    const queued = new Set<string>();
    let nextLiveSuccessor: string | null = null;
    for (let i = persistedMessages.length - 1; i >= 0; i--) {
      const persisted = persistedMessages[i];
      if (incomingIds.has(persisted.id)) {
        nextLiveSuccessor = persisted.id;
        continue;
      }
      if (queued.has(persisted.id)) continue;
      queued.add(persisted.id);
      const entry = deletedIds.has(persisted.id) ? stampTombstone(persisted) : persisted;
      if (nextLiveSuccessor) {
        insertBefore.set(nextLiveSuccessor, [entry, ...(insertBefore.get(nextLiveSuccessor) ?? [])]);
      } else {
        tail.unshift(entry);
      }
    }

    const emitted = new Set<string>();
    const merged: Message[] = [];
    for (const incoming of incomingMessages) {
      if (emitted.has(incoming.id)) continue;
      emitted.add(incoming.id);
      const before = insertBefore.get(incoming.id);
      if (before) merged.push(...before);
      const persisted = persistedById.get(incoming.id);
      if (deletedIds.has(incoming.id) || incoming.deletedAt) {
        // Tombstone — prefer the locally recorded deletion stamp/actor when known.
        merged.push({
          ...incoming,
          deletedAt: persisted?.deletedAt ?? incoming.deletedAt ?? new Date().toISOString(),
          ...(persisted?.deletedBy && !incoming.deletedBy ? { deletedBy: persisted.deletedBy } : {}),
        });
      } else {
        merged.push(incoming);
      }
    }
    merged.push(...tail);

    return merged;
  }, []);

  // Remote-delete detection: the native store drops deleted messages from the
  // published snapshot entirely, so the only signal a receiver gets is a message
  // id VANISHING from the live view. Track every id we have seen live for the
  // current scope; when one disappears while the scope still has live messages,
  // synthesize a stable "Message deleted" tombstone (Discord-class behavior)
  // instead of letting the message silently evaporate.
  const liveSeenRef = useRef<Map<string, Message>>(new Map());
  const remoteTombstonesRef = useRef<Map<string, Message>>(new Map());
  const liveOrderRef = useRef<string[]>([]);
  const lastMergedChannelRef = useRef<string | null>(null);

  const buildLiveView = useCallback((incomingMessages: Message[]): Message[] => {
    const seen = liveSeenRef.current;
    const tombstones = remoteTombstonesRef.current;
    const incomingIds = new Set(incomingMessages.map((message) => message.id));

    // A message that reappears was never deleted (transient snapshot blip) — heal it.
    for (const id of [...tombstones.keys()]) {
      if (incomingIds.has(id)) tombstones.delete(id);
    }

    // An entirely empty live view is ambiguous (engine restart / scope reset), so
    // only treat disappearances as deletions while OTHER live messages remain.
    if (incomingMessages.length > 0) {
      for (const [id, lastSeen] of seen) {
        if (!incomingIds.has(id) && !tombstones.has(id)) {
          tombstones.set(id, { ...lastSeen, content: '', deletedAt: new Date().toISOString() });
        }
      }
    }
    for (const message of incomingMessages) {
      seen.set(message.id, message);
    }

    // Re-anchor tombstones where the message used to sit: walk the previous render
    // order backwards to find each vanished id's first SURVIVING successor, then
    // emit the tombstone just before that successor (or at the end).
    const insertBefore = new Map<string, Message[]>();
    const tail: Message[] = [];
    let nextSurvivor: string | null = null;
    for (let i = liveOrderRef.current.length - 1; i >= 0; i--) {
      const id = liveOrderRef.current[i];
      if (incomingIds.has(id)) {
        nextSurvivor = id;
        continue;
      }
      const tombstone = tombstones.get(id);
      if (!tombstone) continue;
      if (nextSurvivor) {
        insertBefore.set(nextSurvivor, [tombstone, ...(insertBefore.get(nextSurvivor) ?? [])]);
      } else {
        tail.unshift(tombstone);
      }
    }
    const anchored = new Set([...insertBefore.values(), tail].flat().map((message) => message.id));

    const liveView: Message[] = [];
    for (const message of incomingMessages) {
      const before = insertBefore.get(message.id);
      if (before) liveView.push(...before);
      liveView.push(message);
    }
    liveView.push(...tail);
    // Tombstones whose whole neighborhood vanished from the previous order still render (at the end).
    for (const [id, tombstone] of tombstones) {
      if (!anchored.has(id) && !liveView.some((message) => message.id === id)) {
        liveView.push(tombstone);
      }
    }
    liveOrderRef.current = liveView.map((message) => message.id);
    return liveView;
  }, []);

  useEffect(() => {
    if (lastMergedChannelRef.current !== (channel?.id ?? null)) {
      lastMergedChannelRef.current = channel?.id ?? null;
      liveSeenRef.current = new Map();
      remoteTombstonesRef.current = new Map();
      liveOrderRef.current = [];
    }

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
    setMessagesState(mergePersistedMessages(buildLiveView(normalizedMessages), persisted.messages, persistedDeletedIds));
    setMutedUsers(new Set(persisted.mutedUserIds));
    setThreadRepliesByParent(persisted.threads);
    setLocalNickname(persisted.nickname);
    setInboxReadIds(new Set(persisted.inboxReadIds));
    setDeletedMessageIds(persistedDeletedIds);
    setComposerFeedback({
      tone: chatSupport.mode === 'offline' ? 'error' : 'info',
      text: chatSupport.detail,
    });
  }, [buildLiveView, channel?.id, chatSupport.detail, chatSupport.mode, mergePersistedMessages, normalizedMessages]);

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

    const moderationItems: { label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }[] = [
      { label: isMuted ? 'Unmute User' : 'Mute User', icon: <MicOff size={13} />, onClick: () => toggleMuteUser(msg.userId) },
    ];
    if (!isMe) {
      const author = normalizedUsers.find((u) => u.id === msg.userId);
      moderationItems.push({
        label: 'Report Message',
        icon: <Flag size={13} />,
        onClick: () => setReportTarget({ messageId: msg.id, userId: msg.userId, content: msg.content, label: `message from ${author?.username ?? 'this user'}` }),
      });
    }
    moderationItems.push({ label: 'Delete Message', icon: <Trash2 size={13} />, onClick: () => deleteMessage(msg.id), danger: true });

    showMenu(e.clientX, e.clientY, [
      { items: mainItems },
      { items: moderationItems },
    ]);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputValue(val);
    // Broadcast typing presence to the scope (debounced + auto-stop in the
    // native layer); clearing the composer stops it immediately.
    if (channel?.id) {
      if (val.trim()) nativeNotifyTyping(channel.id);
      else nativeStopTyping();
    }
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
      // Carry the reply reference on the wire (locally composed `local-msg-*`
      // targets only exist on this device, so never reference them remotely).
      const replyTarget = replyingTo;
      const replyToId = replyTarget && !replyTarget.id.startsWith(MESSAGE_ID_PREFIX) ? replyTarget.id : undefined;
      setInputValue('');
      setReplyingTo(null);
      nativeStopTyping();
      try {
        if (isDM) {
          await sendDmMutation.mutateAsync({ dmId: channel.id, content });
        } else {
          await sendChannelMutation.mutateAsync({ channelId: channel.id, content, ...(replyToId ? { replyTo: replyToId } : {}) });
        }
      } catch (error) {
        setInputValue(content);
        setReplyingTo(replyTarget);
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
    // When we just prepended older history, keep the viewport anchored to the same
    // messages (restore by the height delta) instead of snapping to the bottom.
    if (preserveScrollRef.current != null && scrollRef.current) {
      // Only consume the anchor once the prepended rows have actually rendered — i.e. the
      // scroll height has grown past the value captured at pull time. This effect also runs
      // for unrelated dependency changes (layout, an incoming message) that can fire before
      // the older page commits; consuming the anchor then would compute a zero/late delta
      // and snap the viewport. Hold the anchor until the content grows, then restore.
      if (scrollRef.current.scrollHeight > preserveScrollRef.current) {
        const delta = scrollRef.current.scrollHeight - preserveScrollRef.current;
        scrollRef.current.scrollTop = delta;
        preserveScrollRef.current = null;
      }
      return;
    }
    scrollToBottom();
  }, [channel, messageLayout, normalizedMessages, searchQuery, scrollToBottom]);

  // Reset the "more history" belief when switching channels, and track the active
  // channel id in a ref so an in-flight history pull can detect a switch and discard
  // its stale result rather than clobbering the new channel's state.
  const channelRef = useRef(channel?.id);
  useEffect(() => { channelRef.current = channel?.id; setHasMoreHistory(true); }, [channel?.id]);

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
  // The local peer id — poll voter lists (`poll_votes`) contain raw peer ids, so
  // deriving "my own vote" needs the identity, not the 'me' alias.
  const localPeerId = runtimeSnapshot?.identity?.peer_id ?? '';

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

  // The server that owns this channel (undefined for DMs) — needed for the cursor pull.
  const historyServerId = useMemo(() => {
    if (isDM || !channel) return undefined;
    return runtimeSnapshot?.servers?.find(
      (s) => Object.prototype.hasOwnProperty.call(s.channels ?? {}, channel.id),
    )?.id;
  }, [isDM, channel, runtimeSnapshot]);

  const handleLoadOlder = useCallback(async () => {
    if (!channel || !historyServerId || loadOlderMutation.isPending) return;
    // Capture the channel this pull is for. If the user switches channels before it
    // resolves, discard the stale result — otherwise channel A's response would clobber
    // channel B's hasMoreHistory / scroll-preservation (shared state).
    const requestedChannelId = channel.id;
    preserveScrollRef.current = scrollRef.current?.scrollHeight ?? null;
    try {
      const res = await loadOlderMutation.mutateAsync({ serverId: historyServerId, channelId: requestedChannelId }) as { added: number; hasMore: boolean; unavailable?: boolean };
      if (channelRef.current !== requestedChannelId) { preserveScrollRef.current = null; return; }
      // A transient "unavailable" (owner/members unreachable) must NOT hide the button —
      // keep it so the user can retry when connectivity returns. Only a definitive
      // answer (has_more, or a real empty page) updates the exhausted state.
      if (res.unavailable) setHasMoreHistory(true);
      else setHasMoreHistory(res.hasMore);
      // If nothing was actually prepended, release the scroll anchor now — the content
      // won't grow, so the anchored-restore effect would otherwise hold it forever and
      // wedge normal auto-scroll-to-bottom. Keep it only when rows were added.
      if (res.added === 0) preserveScrollRef.current = null;
    } catch {
      // Network/exception is also transient — keep the retry affordance visible.
      preserveScrollRef.current = null;
      if (channelRef.current === requestedChannelId) setHasMoreHistory(true);
    }
  }, [channel, historyServerId, loadOlderMutation]);

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

    void searchNotifications({
      scope_type: isDM ? 'dm' : 'channel',
      scope_id: channel.id,
      unread_only: true,
    }).catch(() => { /* best-effort — native path answers locally */ });
  }, [channel, hasInbox, isDM, runtimeSnapshot, searchNotifications]);

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
             {hasAdvancedSearch && (
               <button
                 aria-label="Advanced search"
                 title="Advanced search (Ctrl+F) — filters by sender and date"
                 onClick={() => setShowSearchPanel(true)}
                 className={`transition-colors ${showSearchPanel ? 'text-primary' : 'hover:text-primary'}`}
               >
                 <SlidersHorizontal size={16} />
               </button>
             )}
          </div>
        </div>
      </div>

      {/* Messages Area */}
      <div className={`absolute inset-0 overflow-y-auto px-3 md:px-10 pt-20 pb-28 ${
          messageLayout === 'terminal' ? 'space-y-0.5 font-mono' : 
          messageLayout === 'bubbles' ? 'space-y-2.5' : 
          'space-y-6'
        }`} ref={scrollRef} onScroll={handleScroll}>

        {/* Load older history — only for server channels (DMs page differently) and
            when not filtering. Shown even on an EMPTY channel (a recovered device
            restores membership but not history — the owner can still serve the
            retention window). Hidden only once the responder reports no more history. */}
        {!isDM && !searchQuery && historyServerId && hasMoreHistory && (
          <div className="flex justify-center pb-4">
            <button
              type="button"
              onClick={handleLoadOlder}
              disabled={loadOlderMutation.isPending}
              className="text-xs font-semibold text-white/50 hover:text-primary border border-white/10 hover:border-primary/30 rounded-full px-4 py-1.5 transition-colors disabled:opacity-50"
            >
              {loadOlderMutation.isPending ? 'Loading…' : 'Load older messages'}
            </button>
          </div>
        )}

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
            const deletedWhen = msg.deletedAt ? formatDateTime(new Date(msg.deletedAt), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
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
          // Polls: the body carries an encoded payload (🗳️ POLL:{json}) that must
          // never render as message text — the modern layout shows only the poll
          // card; compact layouts show a readable "🗳️ question" summary instead.
          const poll = parsePollContent(msg.content);
          const displayContent = msg.sticker
            ? <span className="text-5xl leading-none">{msg.content}</span>
            : poll
              ? <span className="italic">🗳️ {searchQuery ? highlightText(poll.q, searchQuery) : poll.q}</span>
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
                              <span className="text-white/30 truncate max-w-[160px]">{messagePreviewText(replyMsg.content)}</span>
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
                    <span className="text-[10px] text-white/30 truncate max-w-[240px]">{messagePreviewText(replyMsg.content)}</span>
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
                ) : poll ? null : (
                  <div className="theme-text-secondary leading-relaxed font-chat font-light text-[15px] selection:bg-primary/30 selection:text-white tracking-wide break-words select-text cursor-text">
                    {displayContent}
                    {msg.editedAt && <span className="text-white/20 text-[9px] ml-1">(edited)</span>}
                  </div>
                )}

                {/* Poll embed — rendered from LIVE snapshot data (poll_votes syncs P2P):
                    vote counts and the local user's own vote are derived per render,
                    so remote votes appear without a remount. */}
                {poll && (() => {
                  const votes = msg.poll_votes ?? {};
                  const options = poll.o.map((text, i) => ({ text, votes: (votes[i] ?? []).length }));
                  const totalVotes = options.reduce((sum, o) => sum + o.votes, 0);
                  const ownVoteIndex = localPeerId
                    ? poll.o.findIndex((_text, i) => (votes[i] ?? []).includes(localPeerId))
                    : -1;
                  return (
                    <PollMessage
                      question={poll.q}
                      options={options}
                      totalVotes={totalVotes}
                      votedIndex={ownVoteIndex >= 0 ? ownVoteIndex : null}
                      onVote={(i) => castPollVoteMutation.mutate({ messageId: msg.id, optionIndex: i })}
                    />
                  );
                })()}

                {/* Media Embeds (never for polls — the body is an encoded payload) */}
                {!poll && <MediaEmbed content={msg.content} />}

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
                      <div className="text-xs text-white/70 leading-relaxed">{renderMarkdown(messagePreviewText(m.content))}</div>
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
                  <div className="text-[10px] text-white/50 truncate">{messagePreviewText(replyingTo.content)}</div>
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

      {/* Search Panel (advanced search — sender/date filters over the runtime store) */}
      {showSearchPanel && hasAdvancedSearch && (
        <SearchPanel
          onClose={() => setShowSearchPanel(false)}
          scopeType={isDM ? 'dm' : 'channel'}
          scopeId={channel.id}
          serverId={historyServerId}
          users={normalizedUsers}
        />
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

      {reportTarget && (
        <ReportModal
          targetLabel={reportTarget.label}
          onClose={() => setReportTarget(null)}
          onSubmit={(report: ReportSubmission) => {
            const serverId = isDM
              ? undefined
              : runtimeSnapshot?.servers?.find((s) => Object.prototype.hasOwnProperty.call(s.channels ?? {}, channel?.id ?? ''))?.id;
            submitReport.mutate({
              targetKind: 'message',
              targetId: reportTarget.messageId,
              reportedPeerId: reportTarget.userId,
              serverId,
              channelId: isDM ? undefined : channel?.id,
              contentExcerpt: reportTarget.content,
              reason: report.reason,
              details: report.details || undefined,
            });
            setReportTarget(null);
            toast.success('Report submitted', serverId ? 'It has been sent to the server owner (and will retry if they are offline).' : 'Thanks — your report was recorded.');
          }}
        />
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
            void markNotificationsRead({
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
              void markNotificationsRead({
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
