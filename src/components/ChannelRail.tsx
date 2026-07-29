
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Channel, ConnectionState, DirectMessageChannel, Server, User, UserStatus } from '@/types';
import { ChevronDown, ChevronRight, Hash, Megaphone, Volume2, Mic, MicOff, Video, MonitorUp, Headphones, HeadphoneOff, Settings, X, LogOut, Radio, PanelLeftClose, ArrowUpDown, FileText, Heart, Plus, Check, Pencil, Trash2, Copy, BellOff } from 'lucide-react';
import { StatusPicker } from '@/components/StatusPicker';
import { AccountSwitcher } from '@/components/AccountSwitcher';
import { ConnectionActivityPill } from '@/components/ConnectionActivityPill';
import { VoiceControlBar, type VoiceControlState } from '@/components/voice/VoiceControlBar';
import { VoiceTextChat } from '@/components/voice/VoiceTextChat';
import { useFeature } from '@/hooks/useFeature';
import { resolveAvatarSrc } from '@/lib/avatar';
import { shortFingerprint } from '@/lib/peerLabel';
import { useCreateChannel, useUpdateChannel, useDeleteChannel, useUpdatePresence } from '@/hooks/runtime/mutations';
import { useRuntimeMutations } from '@/hooks/runtime/useRuntimeMutations';
import { ChannelSettingsModal, type ChannelEditValues } from '@/components/ChannelSettingsModal';
import { usePiiBlurClass } from '@/components/streamer/StreamerMode';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';
import { useToast } from '@/lib/toastBus';
import { resetLocalIdentity } from '@/lib/xoreinClientProvider';
import { listVaultIdentities, type VaultEntry } from '@/native/identity/storage';
import { useContextMenu } from '@/components/GlobalContextMenuContext';
import { copyTextToClipboardSafely, safeConfirm } from '@/components/contextMenuUtils';

function isRailRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeRailText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeRailStatus(value: unknown): UserStatus {
  return value === 'online' || value === 'idle' || value === 'dnd' || value === 'offline' ? value : 'offline';
}

function normalizeRailUser(value: unknown, fallbackId: string): User {
  if (!isRailRecord(value)) {
    return {
      id: fallbackId,
      username: fallbackId,
      avatar: '',
      status: 'offline',
    };
  }

  const id = normalizeRailText(value.id, fallbackId);
  const username = normalizeRailText(value.username, id);
  const avatar = typeof value.avatar === 'string' ? value.avatar : '';

  return {
    id,
    username,
    avatar,
    status: normalizeRailStatus(value.status),
  };
}

function normalizeRailUsers(value: unknown): User[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: User[] = [];
  const seen = new Set<string>();
  value.forEach((user, index) => {
    const normalizedUser = normalizeRailUser(user, `member-${index}`);
    if (seen.has(normalizedUser.id)) {
      return;
    }
    seen.add(normalizedUser.id);
    normalized.push(normalizedUser);
  });

  return normalized;
}

function normalizeRailDirectMessage(value: unknown, fallbackId: string): DirectMessageChannel | null {
  if (!isRailRecord(value)) {
    return null;
  }

  const id = normalizeRailText(value.id, fallbackId);
  const userId = normalizeRailText(value.userId, '');
  if (!id || !userId) {
    return null;
  }

  return {
    id,
    userId,
    ...(typeof value.lastMessage === 'string' && value.lastMessage.trim() ? { lastMessage: value.lastMessage.trim() } : {}),
    ...(typeof value.timestamp === 'string' && value.timestamp.trim() ? { timestamp: value.timestamp.trim() } : {}),
    ...(typeof value.unreadCount === 'number' && Number.isFinite(value.unreadCount) ? { unreadCount: value.unreadCount } : {}),
  };
}

function normalizeRailDirectMessages(value: unknown): DirectMessageChannel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: DirectMessageChannel[] = [];
  const seen = new Set<string>();

  value.forEach((dm, index) => {
    const normalizedDm = normalizeRailDirectMessage(dm, `dm-${index}`);
    if (!normalizedDm || seen.has(normalizedDm.id)) {
      return;
    }
    seen.add(normalizedDm.id);
    normalized.push(normalizedDm);
  });

  return normalized;
}

function getUnknownRailUser(): User {
  return {
    id: 'unknown',
    username: 'Unknown User',
    avatar: '',
    status: 'offline',
  };
}

interface ChannelRailProps {
  server?: Server;
  activeChannelId: string;
  currentUser: User;
  users: User[];
  directMessages: DirectMessageChannel[];
  connectionState: ConnectionState;
  connectedVoiceChannelId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectChannel: (id: string) => void;
  onJoinVoice: (id: string) => void;
  onOpenSettings: () => void;
  onOpenNodeLaunch?: () => void;
  /** Open the auth flow (used by the footer's "add another account"). */
  onOpenAuth?: () => void;
  onOpenServerSettings?: () => void;
  /** Copy the server's invite link (header dropdown → "Copy Invite Link"). */
  onInvite?: () => void;
  /** Leave the server (member). Navigates home afterwards. */
  onLeaveServer?: () => void;
  /** Delete the server (owner). Navigates home afterwards. */
  onDeleteServer?: () => void;
  onOpenActivities?: () => void;
  onOpenSoundboard?: () => void;
  onOpenStage?: () => void;
  onOpenVoiceSettings?: () => void;
  voiceControlState?: VoiceControlState;
  onToggleVoiceMute?: () => void;
  onToggleVoiceDeafen?: () => void;
  onToggleVoiceVideo?: () => void;
  onToggleVoiceScreenShare?: () => void;
  isHome?: boolean;
  onShowFriends?: () => void;
}

export const ChannelRail: React.FC<ChannelRailProps> = ({ 
  server, 
  activeChannelId, 
  currentUser, 
  users,
  directMessages,
  connectionState,
  connectedVoiceChannelId,
  collapsed,
  onToggleCollapse,
  onSelectChannel,
  onJoinVoice,
  onOpenSettings,
  onOpenAuth,
  onOpenServerSettings,
  onInvite,
  onLeaveServer,
  onDeleteServer,
  onOpenActivities,
  onOpenSoundboard,
  onOpenStage,
  onOpenVoiceSettings,
  voiceControlState,
  onToggleVoiceMute,
  onToggleVoiceDeafen,
  onToggleVoiceVideo,
  onToggleVoiceScreenShare,
  isHome,
  onShowFriends,
}) => {
  const connectivityEnabled = connectionState.canUseConnectivityActions;
  const voiceDisabledReason = voiceControlState?.canInteract ? undefined : voiceControlState?.statusDetail;
  const voiceControlBarEnabled = useFeature('voiceControlBar');
  const voiceTextChatEnabled = useFeature('voiceTextChat');
  const normalizedCurrentUser = React.useMemo(() => normalizeRailUser(currentUser, 'me'), [currentUser]);
  const normalizedUsers = React.useMemo(() => normalizeRailUsers(users), [users]);
  const normalizedDirectMessages = useMemo(() => normalizeRailDirectMessages(directMessages), [directMessages]);

  const createChannelMutation = useCreateChannel();
  const updateChannelMutation = useUpdateChannel();
  const deleteChannelMutation = useDeleteChannel();
  const runtimeMutations = useRuntimeMutations();
  const hasAnnouncementChannels = useFeature('announcementChannels');
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [newChannel, setNewChannel] = useState<{ categoryId: string; name: string; voice: boolean; announcement: boolean } | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const newChannelInputRef = useRef<HTMLInputElement>(null);
  const { showMenu } = useContextMenu();

  // Server structure is owner-authoritative: only the owner's channel edits sync to
  // members (broadcastServerUpdate is owner-gated, and members reject non-owner
  // updates). Gate the channel-management UI to the owner so members don't create
  // phantom local-only channels that never reach anyone else.
  const railSnapshot = useRuntimeSnapshot();
  const myPeerId = railSnapshot?.identity?.peer_id ?? railSnapshot?.peer_id ?? '';
  const serverOwnerPeerId = railSnapshot?.servers?.find((s) => s.id === server?.id)?.owner_peer_id ?? '';
  const isOwner = Boolean(server) && !!myPeerId && myPeerId === serverOwnerPeerId;

  const toggleCategoryCollapsed = (categoryId: string) => {
    setCollapsedCategories(prev => ({ ...prev, [categoryId]: !prev[categoryId] }));
  };

  const showChannelContextMenu = (e: React.MouseEvent, ch: Channel, categoryId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const isVoice = ch.type === 'voice';
    const canManage = isOwner;
    showMenu(e.clientX, e.clientY, [
      {
        items: [
          ...(!isVoice ? [{
            label: 'Mark as Read',
            icon: <BellOff size={13} />,
            onClick: () => onSelectChannel(ch.id),
          }] : []),
          {
            label: 'Copy Channel Name',
            icon: <Copy size={13} />,
            onClick: () => { void copyTextToClipboardSafely(ch.name); },
          },
        ],
      },
      {
        items: [
          {
            label: 'Create Text Channel Here',
            icon: <Hash size={13} />,
            onClick: () => openNewChannel(categoryId),
            disabled: !canManage,
          },
          {
            label: 'Create Voice Channel Here',
            icon: <Volume2 size={13} />,
            onClick: () => openNewVoiceChannel(categoryId),
            disabled: !canManage,
          },
        ],
      },
      {
        items: [
          {
            label: isVoice ? 'Edit Voice Channel' : 'Edit Channel',
            icon: <Pencil size={13} />,
            onClick: () => setEditingChannel(ch),
            disabled: !canManage,
          },
          {
            label: 'Delete Channel',
            icon: <Trash2 size={13} />,
            onClick: () => handleDeleteChannel(ch),
            danger: true,
            disabled: !canManage,
          },
        ],
      },
    ]);
  };

  const handleDeleteChannel = (ch: Channel) => {
    if (!server) return;
    if (!safeConfirm(`Delete ${ch.type === 'voice' ? 'voice channel' : '#'}${ch.name}? This cannot be undone.`)) return;
    void deleteChannelMutation.mutateAsync({ serverId: server.id, channelId: ch.id });
    if (editingChannel?.id === ch.id) setEditingChannel(null);
  };

  const handleSaveChannel = async (patch: ChannelEditValues) => {
    if (!server || !editingChannel) return;
    await updateChannelMutation.mutateAsync({ serverId: server.id, channelId: editingChannel.id, patch });
    setEditingChannel(null);
  };

  const showCategoryContextMenu = (e: React.MouseEvent, categoryId: string) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, [
      {
        items: [
          {
            label: 'Create Text Channel',
            icon: <Hash size={13} />,
            onClick: () => openNewChannel(categoryId),
            disabled: !isOwner,
          },
          {
            label: 'Create Voice Channel',
            icon: <Volume2 size={13} />,
            onClick: () => openNewVoiceChannel(categoryId),
            disabled: !isOwner,
          },
        ],
      },
    ]);
  };

  const openNewChannel = (categoryId: string) => {
    setNewChannel({ categoryId, name: '', voice: false, announcement: false });
    setTimeout(() => newChannelInputRef.current?.focus(), 50);
  };

  const openNewVoiceChannel = (categoryId: string) => {
    setNewChannel({ categoryId, name: '', voice: true, announcement: false });
    setTimeout(() => newChannelInputRef.current?.focus(), 50);
  };

  const submitNewChannel = async () => {
    if (!newChannel || !server || !newChannel.name.trim() || !isOwner) return;
    try {
      const created = await createChannelMutation.mutateAsync({ serverId: server.id, name: newChannel.name.trim(), voice: newChannel.voice });
      // Announce at creation: stamp the synced kind onto the fresh channel record
      // via the mutation facade (the RQ hook only carries name/voice). The kind is
      // owner-authoritative server structure, so it broadcasts like a rename.
      const createdId = created && typeof created === 'object' && 'id' in created ? String((created as { id?: unknown }).id ?? '') : '';
      if (!newChannel.voice && newChannel.announcement && createdId) {
        await runtimeMutations.updateChannel?.(server.id, createdId, { kind: 'announcement' });
      }
    } finally {
      setNewChannel(null);
    }
  };

  // Server header dropdown: the everything-in-2-clicks entry for a server. One
  // click opens it; the second click invites, opens settings, or leaves/deletes.
  const showServerHeaderMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!server) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu(rect.left, rect.bottom + 4, [
      {
        items: [
          ...(onInvite ? [{
            label: 'Copy Invite Link',
            icon: <Copy size={13} />,
            onClick: () => onInvite(),
          }] : []),
          ...(onOpenServerSettings ? [{
            label: 'Server Settings',
            icon: <Settings size={13} />,
            onClick: () => onOpenServerSettings(),
          }] : []),
        ],
      },
      {
        items: [
          isOwner
            ? {
                label: 'Delete Server',
                icon: <Trash2 size={13} />,
                onClick: () => { if (safeConfirm(`Delete “${server.name}”? This permanently removes it for every member and cannot be undone.`)) onDeleteServer?.(); },
                danger: true,
                disabled: !onDeleteServer,
              }
            : {
                label: 'Leave Server',
                icon: <LogOut size={13} />,
                onClick: () => { if (safeConfirm(`Leave “${server.name}”? You'll need a new invite to rejoin.`)) onLeaveServer?.(); },
                danger: true,
                disabled: !onLeaveServer,
              },
        ],
      },
    ]);
  };

  return (
    <div 
        className={`
            w-[224px] glass-realistic flex flex-col h-full transition-transform duration-300 ease-in-out
            ${collapsed ? '-translate-x-full' : 'translate-x-0'}
            ${isHome ? 'border-r border-white/5' : ''}
        `}
        role="complementary" 
        aria-label="Channel List"
    >
      {/* Collapsed Handle (Visible when collapsed) */}
      {collapsed && (
          <button 
            className="absolute right-[-10px] top-0 bottom-0 w-[10px] bg-bg-1 flex items-center justify-center hover:bg-bg-2 cursor-pointer transition-colors border-r border-white/5" 
            onClick={onToggleCollapse}
            aria-label="Expand Channel List"
          >
               <div className="w-1 h-6 bg-white/20 rounded-full"></div>
          </button>
      )}

      {/* Header */}
      <div className="h-[52px] px-5 flex items-center justify-between border-b theme-border">
        <div className="flex items-center gap-2 overflow-hidden min-w-0">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColorClass(connectionState.status)}`}></div>
          {!isHome && server ? (
            <button
              onClick={showServerHeaderMenu}
              className="min-w-0 flex items-center gap-1.5 group/title text-left hover:text-primary transition-colors focus-ring rounded"
              aria-label="Server menu"
              title="Server menu"
            >
              <div className="min-w-0">
                <h2 className="font-bold theme-text truncate micro-label text-xs tracking-widest group-hover/title:text-primary transition-colors">{server?.name}</h2>
                <div className="text-[9px] theme-text-dim truncate tracking-[0.24em]">{connectionState.label}</div>
              </div>
              <ChevronDown size={12} className="flex-shrink-0 theme-text-dim group-hover/title:text-primary transition-colors" />
            </button>
          ) : (
            <div className="min-w-0">
              <h2 className="font-bold theme-text truncate micro-label text-xs tracking-widest">{isHome ? 'System Hub' : server?.name}</h2>
              <div className="text-[9px] theme-text-dim truncate tracking-[0.24em]">{connectionState.label}</div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!isHome && onOpenServerSettings && (
            <button onClick={onOpenServerSettings} className="theme-text-dim hover:text-primary transition-colors" aria-label="Server Settings" title="Server Settings">
              <Settings size={14} />
            </button>
          )}
          <button onClick={onToggleCollapse} className="theme-text-dim hover:text-primary transition-colors" aria-label="Collapse Channel List">
              <PanelLeftClose size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-5 space-y-6 no-scrollbar">
        {isHome ? (
            <section>
                <button onClick={onShowFriends} className="micro-label theme-text-dim mb-3 px-2 hover:text-primary transition-colors cursor-pointer w-full text-left" aria-label="Friends">Direct Communications</button>
                <div className="space-y-1.5">
                    {normalizedDirectMessages.map(dm => {
                        const user = normalizedUsers.find(u => u.id === dm.userId) ?? getUnknownRailUser();
                        const active = activeChannelId === dm.id;
                        return (
                            <button 
                                key={dm.id} 
                                disabled={!connectivityEnabled}
                                onClick={() => onSelectChannel(dm.id)}
                                title={!connectivityEnabled ? connectionState.detail : user.username}
                                className={`w-full flex items-center gap-2.5 p-1.5 rounded-r2 border transition-all cursor-pointer btn-press disabled:opacity-40 disabled:cursor-not-allowed ${active ? 'bg-primary/10 border-primary/20 text-primary shadow-[inset_0_0_10px_rgba(19,221,236,0.1)]' : 'bg-transparent border-transparent theme-text-secondary hover:bg-white/5 hover:theme-text'}`}>
                                <div className="w-7 h-7 rounded-full overflow-hidden border theme-border">
                                    <img src={resolveAvatarSrc(user.avatar, user.username)} className="w-full h-full object-cover" alt={user.username} />
                                </div>
                                <div className="flex-1 min-w-0 text-left">
                                    <div className="text-xs font-bold truncate">{user.username}</div>
                                    <div className="text-[9px] opacity-60 truncate font-mono">{dm.lastMessage}</div>
                                </div>
                            </button>
                        )
                    })}
                </div>
            </section>
        ) : (
            server?.categories.map(cat => {
                const isCollapsed = Boolean(collapsedCategories[cat.id]);
                return (
                <section key={cat.id}>
                    <div onContextMenu={e => showCategoryContextMenu(e, cat.id)} className="flex items-center justify-between micro-label theme-text-dim mb-2.5 px-2 group/cat">
                        <button
                          onClick={() => toggleCategoryCollapsed(cat.id)}
                          className="flex items-center gap-1 min-w-0 flex-1 text-left hover:text-primary transition-colors focus-ring rounded"
                          aria-expanded={!isCollapsed}
                          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${cat.name}`}
                        >
                          {isCollapsed ? <ChevronRight size={10} className="flex-shrink-0" /> : <ChevronDown size={10} className="flex-shrink-0" />}
                          <span className="truncate">{cat.name}</span>
                        </button>
                        <div className="flex items-center gap-1">
                          {isOwner && (
                            /* Persistent but subdued: always visible (discoverable
                               without hover-hunting), brightening on hover/focus to
                               match the rail's quiet-until-engaged design language. */
                            <button
                              onClick={() => openNewChannel(cat.id)}
                              className="opacity-50 hover:opacity-100 focus-visible:opacity-100 group-hover/cat:opacity-80 transition-opacity p-0.5 hover:text-primary rounded focus-ring"
                              aria-label="Add channel"
                              title="Add channel"
                            >
                              <Plus size={11} />
                            </button>
                          )}
                        </div>
                    </div>
                    <div className={`space-y-0.5 ${isCollapsed ? 'hidden' : ''}`}>
                        {cat.channels.map(ch => {
                            const isVoice = ch.type === 'voice';
                            const isConnected = connectedVoiceChannelId === ch.id;
                            const active = activeChannelId === ch.id && !isVoice;
                            return (
                                <div key={ch.id}>
                                    <button
                                        disabled={isVoice ? false : !connectivityEnabled}
                                         onClick={() => isVoice ? onJoinVoice(ch.id) : onSelectChannel(ch.id)}
                                        onContextMenu={e => showChannelContextMenu(e, ch, cat.id)}
                                        title={!connectivityEnabled && !isVoice ? connectionState.detail : ch.name}
                                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-r2 border transition-all cursor-pointer group btn-press disabled:opacity-40 disabled:cursor-not-allowed ${active ? 'bg-primary/10 border-primary/20 text-primary shadow-inner' : 'bg-transparent border-transparent theme-text-secondary hover:bg-white/5 hover:theme-text'} ${isConnected ? 'bg-accent-success/10 border-accent-success/20 text-accent-success' : ''}`}>
                                         {isVoice ? <Volume2 size={14} /> : <Hash size={14} />}
                                         <span className="text-xs font-medium tracking-tight flex-1 text-left">{ch.name}</span>
                                         {ch.unreadCount && !active && <div className="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_8px_white]"></div>}
                                    </button>
                                    {isVoice && ch.activeUsers && ch.activeUsers.length > 0 && (
                                        <div className="ml-7 mt-1.5 space-y-1 pb-1.5">
                                            {ch.activeUsers.map(u => (
                                                <div key={u.id} className="flex items-center gap-2 text-[11px] text-white/55 hover:text-white px-1.5 py-0.5 rounded hover:bg-white/5 cursor-pointer transition-colors group/vp">
                                                    <div className={`relative rounded-full transition-all ${u.speaking ? 'ring-2 ring-accent-success shadow-[0_0_7px_rgba(5,255,161,0.85)]' : 'ring-1 ring-transparent'}`}>
                                                        <img src={resolveAvatarSrc(u.avatar, u.username)} className="w-5 h-5 rounded-full block" alt="" />
                                                    </div>
                                                    <span className={`truncate flex-1 ${u.speaking ? 'text-white' : ''}`}>{u.username}</span>
                                                    {u.screenSharing && <MonitorUp size={11} className="text-accent-success shrink-0" />}
                                                    {u.video && <Video size={11} className="text-white/45 shrink-0" />}
                                                    {u.muted && <MicOff size={11} className="text-accent-danger/80 shrink-0" />}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                        {/* Inline channel creation form for this category */}
                        {newChannel?.categoryId === cat.id && (
                          <div className="mt-1 px-1">
                            <div className="glass-card rounded-r2 p-2 border border-primary/20 space-y-2">
                              <div className="flex gap-1 mb-1" role="group" aria-label="New channel type">
                                <button
                                  type="button"
                                  onClick={() => setNewChannel(c => c ? { ...c, voice: false, announcement: false } : c)}
                                  aria-pressed={!newChannel.voice && !newChannel.announcement}
                                  className={`flex-1 flex items-center justify-center gap-1 py-1 rounded text-[10px] font-bold transition-all ${!newChannel.voice && !newChannel.announcement ? 'bg-primary/15 text-primary' : 'text-white/40 hover:bg-white/5'}`}
                                >
                                  <Hash size={10} /> Text
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setNewChannel(c => c ? { ...c, voice: true, announcement: false } : c)}
                                  aria-pressed={newChannel.voice}
                                  className={`flex-1 flex items-center justify-center gap-1 py-1 rounded text-[10px] font-bold transition-all ${newChannel.voice ? 'bg-primary/15 text-primary' : 'text-white/40 hover:bg-white/5'}`}
                                >
                                  <Volume2 size={10} /> Voice
                                </button>
                                {hasAnnouncementChannels && (
                                  <button
                                    type="button"
                                    onClick={() => setNewChannel(c => c ? { ...c, voice: false, announcement: true } : c)}
                                    aria-pressed={!newChannel.voice && newChannel.announcement}
                                    className={`flex-1 flex items-center justify-center gap-1 py-1 rounded text-[10px] font-bold transition-all ${!newChannel.voice && newChannel.announcement ? 'bg-primary/15 text-primary' : 'text-white/40 hover:bg-white/5'}`}
                                  >
                                    <Megaphone size={10} /> Announce
                                  </button>
                                )}
                              </div>
                              <input
                                ref={newChannelInputRef}
                                value={newChannel.name}
                                onChange={e => setNewChannel(c => c ? { ...c, name: e.target.value } : c)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') void submitNewChannel();
                                  if (e.key === 'Escape') setNewChannel(null);
                                }}
                                placeholder="channel-name"
                                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder-white/25 focus:outline-none focus:border-primary/40"
                              />
                              <div className="flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => void submitNewChannel()}
                                  disabled={!newChannel.name.trim() || createChannelMutation.isPending}
                                  className="flex-1 flex items-center justify-center gap-1 py-1 bg-primary/20 hover:bg-primary/30 text-primary rounded text-[10px] font-bold disabled:opacity-40 transition-colors"
                                >
                                  <Check size={10} /> Create
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setNewChannel(null)}
                                  className="p-1 text-white/30 hover:text-white/70 rounded transition-colors"
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                    </div>
                </section>
                );
            })
        )}
      </div>

      {/* Voice Control Bar */}
      {connectedVoiceChannelId && voiceControlBarEnabled ? (
        <>
          <VoiceControlBar
            channelName={
              server?.categories.flatMap(c => c.channels).find(ch => ch.id === connectedVoiceChannelId)?.name || 'Voice'
            }
            state={voiceControlState ?? {
              statusLabel: 'VOICE CONNECTED',
              statusDetail: 'The local runtime is available.',
              participantCount: 0,
              muted: false,
              deafened: false,
              videoOn: false,
              screenSharing: false,
              activeActivityId: null,
              canInteract: false,
              pendingAction: null,
              error: voiceDisabledReason ?? null,
              sessionAvailable: false,
              channelId: connectedVoiceChannelId,
            }}
            onDisconnect={() => onJoinVoice('')}
            onToggleMute={onToggleVoiceMute}
            onToggleDeafen={onToggleVoiceDeafen}
            onToggleVideo={onToggleVoiceVideo}
            onToggleScreenShare={onToggleVoiceScreenShare}
            onOpenActivities={onOpenActivities}
            onOpenSoundboard={onOpenSoundboard}
            onOpenStage={onOpenStage}
            onOpenVoiceSettings={onOpenVoiceSettings}
          />
          {voiceTextChatEnabled && (
            <VoiceTextChat
              key={connectedVoiceChannelId}
              channelId={connectedVoiceChannelId}
              channelName={
                server?.categories.flatMap(c => c.channels).find(ch => ch.id === connectedVoiceChannelId)?.name || 'voice'
              }
              disabledReason={voiceDisabledReason}
            />
          )}
        </>
      ) : connectedVoiceChannelId ? (
        <div className="p-3 bg-accent-success/5 border-t border-accent-success/10 flex items-center justify-between">
          <div>
            <div className="micro-label text-accent-success flex items-center gap-1.5"><Radio size={9} className="animate-pulse" /> Linked</div>
            <div className="text-[9px] text-white/50">ENC // VOICE NODE 04</div>
          </div>
          <button onClick={() => onJoinVoice('')} aria-label="Disconnect Voice" className="p-1.5 hover:bg-accent-danger/20 text-accent-danger rounded-full transition-colors"><LogOut size={14} /></button>
        </div>
      ) : null}

      {/* User Footer */}
      <UserFooter
        currentUser={normalizedCurrentUser}
        connectionState={connectionState}
        onOpenSettings={onOpenSettings}
        onOpenAuth={onOpenAuth}
        voiceControlState={voiceControlState}
        onToggleVoiceMute={onToggleVoiceMute}
        onToggleVoiceDeafen={onToggleVoiceDeafen}
      />

      {editingChannel && server && (
        <ChannelSettingsModal
          channel={editingChannel}
          busy={updateChannelMutation.isPending || deleteChannelMutation.isPending}
          onClose={() => setEditingChannel(null)}
          onSave={(patch) => { void handleSaveChannel(patch); }}
          onDelete={() => handleDeleteChannel(editingChannel)}
        />
      )}
    </div>
  );
};

const UserFooter: React.FC<{
  currentUser: User;
  connectionState: ConnectionState;
  onOpenSettings: () => void;
  onOpenAuth?: () => void;
  voiceControlState?: VoiceControlState;
  onToggleVoiceMute?: () => void;
  onToggleVoiceDeafen?: () => void;
}> = ({ currentUser, connectionState, onOpenSettings, onOpenAuth, voiceControlState, onToggleVoiceMute, onToggleVoiceDeafen }) => {
  const updatePresenceMutation = useUpdatePresence();
  const [showStatusPicker, setShowStatusPicker] = useState(false);
  const [userStatus, setUserStatus] = useState<UserStatus>(currentUser.status);
  const [customStatus, setCustomStatus] = useState('');
  const [presenceError, setPresenceError] = useState<string | null>(null);
  const [showAccountSwitcher, setShowAccountSwitcher] = useState(false);
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[]>([]);
  const hasAccountSwitching = useFeature('accountSwitching');
  const piiBlur = usePiiBlurClass();
  const toast = useToast();
  const snapshot = useRuntimeSnapshot();
  const activePeerId = snapshot?.identity?.peer_id?.trim() ?? '';
  const activeDisplayName = snapshot?.identity?.profile?.display_name?.trim() ?? '';
  const hasIdentity = Boolean(activePeerId && activeDisplayName);
  const connectivityEnabled = connectionState.canUseConnectivityActions;
  const voiceControlsAvailable = Boolean(onToggleVoiceMute && onToggleVoiceDeafen);
  const voiceActionTitle = !voiceControlState?.channelId
    ? 'Join a voice channel to use voice controls.'
    : voiceControlState.pendingAction
      ? `Voice ${voiceControlState.pendingAction} is syncing.`
      : !voiceControlsAvailable
        ? 'Voice controls are unavailable in this shell.'
        : voiceControlState.canInteract
          ? undefined
          : voiceControlState.statusDetail;
  const canUseVoiceFooterControls = Boolean(voiceControlState?.channelId)
    && !voiceControlState?.pendingAction
    && connectivityEnabled
    && voiceControlsAvailable;

  // Global voice hotkeys: Ctrl+M toggles mute, Ctrl+D toggles deafen. Only active
  // while connected to a voice channel so they don't hijack the browser shortcuts
  // (Ctrl+D = bookmark) when voice controls are unavailable.
  useEffect(() => {
    if (!canUseVoiceFooterControls) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'm') {
        event.preventDefault();
        onToggleVoiceMute?.();
      } else if (key === 'd') {
        event.preventDefault();
        onToggleVoiceDeafen?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canUseVoiceFooterControls, onToggleVoiceMute, onToggleVoiceDeafen]);

  const statusColors: Record<UserStatus, string> = {
    online: 'bg-accent-success shadow-[0_0_5px_#05FFA1]',
    idle: 'bg-accent-warning shadow-[0_0_5px_#FFB020]',
    dnd: 'bg-accent-danger shadow-[0_0_5px_#FF2A6D]',
    offline: 'bg-white/20',
  };

  const openAccountSwitcher = () => {
    setShowAccountSwitcher((open) => {
      const next = !open;
      // Load the device vault each time it opens so newly-saved accounts appear.
      if (next) listVaultIdentities().then(setVaultEntries).catch(() => setVaultEntries([]));
      return next;
    });
  };

  const handleStatusChange = async (status: UserStatus) => {
    setUserStatus(status);
    try {
      await updatePresenceMutation.mutateAsync({
        status,
        statusText: customStatus.trim() || undefined,
      });
      setPresenceError(null);
    } catch (error) {
      setPresenceError(error instanceof Error ? error.message : 'Unable to update presence right now.');
    }
  };

  const handleCustomStatusChange = async (text: string) => {
    setCustomStatus(text);
    try {
      await updatePresenceMutation.mutateAsync({
        status: userStatus,
        statusText: text.trim() || undefined,
      });
      setPresenceError(null);
    } catch (error) {
      setPresenceError(error instanceof Error ? error.message : 'Unable to update presence right now.');
    }
  };

  return (
    <div className="p-3 bg-bg-0/50 border-t border-white/5 flex flex-col gap-2 relative">
      {showStatusPicker && (
        <StatusPicker
          currentStatus={userStatus}
          customStatus={customStatus}
          onStatusChange={(status) => {
            void handleStatusChange(status);
            setShowStatusPicker(false);
          }}
          onCustomStatusChange={(text) => {
            void handleCustomStatusChange(text);
          }}
          onClose={() => setShowStatusPicker(false)}
        />
      )}
      {showAccountSwitcher && hasAccountSwitching && (
        <AccountSwitcher
          entries={vaultEntries}
          activePeerId={activePeerId}
          onAdd={() => { setShowAccountSwitcher(false); onOpenAuth?.(); }}
          onLogout={() => { setShowAccountSwitcher(false); void resetLocalIdentity(); }}
          onClose={() => setShowAccountSwitcher(false)}
        />
      )}
      <ConnectionActivityPill />
      <div className="flex items-center gap-2.5 w-full">
      <button className="relative group cursor-pointer" onClick={() => setShowStatusPicker(!showStatusPicker)} aria-label="Set Status">
        <img src={resolveAvatarSrc(currentUser.avatar, hasIdentity ? activeDisplayName : 'Guest')} className="w-8 h-8 rounded-full border border-white/10 group-hover:border-primary transition-colors" alt="My Avatar" />
        <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-bg-0 ${hasIdentity ? statusColors[userStatus] : 'bg-white/20'}`} />
      </button>
      <div className="flex-1 min-w-0">
        {hasIdentity ? (
          <>
            <div className="text-xs font-bold truncate text-white tracking-tight">{activeDisplayName}</div>
            {customStatus ? (
              <div className="text-[9px] text-primary/70 truncate">{customStatus}</div>
            ) : (
              <div className={`text-[8px] font-mono text-white/40 truncate ${piiBlur}`}>{shortFingerprint(activePeerId)}</div>
            )}
          </>
        ) : (
          <>
            <div className="text-xs font-bold truncate text-white tracking-tight">Guest</div>
            <div className="text-[9px] text-white/40">Read only — sign in to post</div>
          </>
        )}
        {presenceError && (
          <div className="text-[8px] text-accent-danger font-mono mt-1 truncate" role="status">
            {presenceError}
          </div>
        )}
      </div>
      <div className="flex gap-0.5">
        {hasIdentity && (
          <button
            onClick={() => {
              void copyTextToClipboardSafely(activePeerId).then((ok) =>
                ok
                  ? toast.success('Your ID was copied — send it to a friend so they can add you.')
                  : toast.error('Couldn’t access the clipboard. Open Settings → My Account to copy your ID.'),
              );
            }}
            aria-label="Copy my ID to share"
            title="Copy my ID — share it so a friend can add you"
            className="p-1 text-white/40 hover:text-primary transition-colors btn-press"
          ><Copy size={14} /></button>
        )}
        {hasAccountSwitching && (
          <button onClick={openAccountSwitcher} aria-label="Switch Account" className="p-1 text-white/40 hover:text-primary transition-colors"><ArrowUpDown size={14} /></button>
        )}
        <button
          disabled={!canUseVoiceFooterControls}
          onClick={onToggleVoiceMute}
          title={voiceActionTitle ?? `${voiceControlState?.muted ? 'Unmute Microphone' : 'Mute Microphone'} (Ctrl+M)`}
          aria-keyshortcuts="Control+M"
          aria-label={voiceControlState?.muted ? 'Unmute Microphone' : 'Mute Microphone'}
          className={`p-1 transition-colors btn-press disabled:opacity-40 disabled:cursor-not-allowed ${voiceControlState?.muted ? 'text-accent-danger hover:text-accent-danger' : 'text-white/40 hover:text-primary'}`}
        >{voiceControlState?.muted ? <MicOff size={14} /> : <Mic size={14} />}</button>
        <button
          disabled={!canUseVoiceFooterControls}
          onClick={onToggleVoiceDeafen}
          title={voiceActionTitle ?? `${voiceControlState?.deafened ? 'Undeafen Audio' : 'Deafen Audio'} (Ctrl+D)`}
          aria-keyshortcuts="Control+D"
          aria-label={voiceControlState?.deafened ? 'Undeafen Audio' : 'Deafen Audio'}
          className={`p-1 transition-colors btn-press disabled:opacity-40 disabled:cursor-not-allowed ${voiceControlState?.deafened ? 'text-accent-danger hover:text-accent-danger' : 'text-white/40 hover:text-primary'}`}
        >{voiceControlState?.deafened ? <HeadphoneOff size={14} /> : <Headphones size={14} />}</button>
        <button onClick={onOpenSettings} aria-label="Open Settings" className="p-1 text-white/40 hover:text-primary transition-colors btn-press"><Settings size={14} /></button>
      </div>
      </div>
    </div>
  );
};

function statusColorClass(status: ConnectionState['status']): string {
  switch (status) {
    case 'connected':
      return 'bg-accent-success shadow-[0_0_8px_rgba(5,255,161,0.75)]';
    case 'reconnecting':
      return 'bg-accent-warning shadow-[0_0_8px_rgba(255,176,32,0.75)]';
    case 'disconnected':
    case 'no-peer':
    case 'no-relay':
      return 'bg-accent-danger shadow-[0_0_8px_rgba(255,42,109,0.75)]';
  }
}
