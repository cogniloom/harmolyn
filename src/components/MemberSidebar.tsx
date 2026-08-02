
import React, { useEffect, useState } from 'react';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';
import { useRuntimeMutations } from '@/hooks/runtime/useRuntimeMutations';
import type { XoreinRuntimeSnapshot } from '@/types';
import { motion } from 'framer-motion';
import { User } from '@/types';
import { PanelRightClose, Clock, X, MessageCircle } from 'lucide-react';
import { useFeature } from '@/hooks/useFeature';
import { DonorBadge } from '@/components/DonorBadge';
import { resolveAvatarSrc } from '@/lib/avatar';

interface MemberSidebarProps {
  members: User[];
  currentUser: User;
  serverOwnerId: string;
  serverId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  isOverlay?: boolean;
  runtimeSnapshot?: XoreinRuntimeSnapshot | null;
  onOpenDM?: (userId: string) => void;
}

function isSidebarRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeSidebarText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeSidebarStatus(value: unknown): User['status'] {
  return value === 'online' || value === 'idle' || value === 'dnd' || value === 'offline' ? value : 'offline';
}

function normalizeSidebarDonationTier(value: unknown): User['donationTier'] {
  return value === 'coffee' || value === 'supporter' || value === 'champion' ? value : undefined;
}

const SAFE_ROLE_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i;

function normalizeSidebarRoleColor(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const color = value.trim();
  return SAFE_ROLE_COLOR.test(color) ? color : undefined;
}

function normalizeSidebarUser(value: unknown, fallbackId: string): User {
  if (!isSidebarRecord(value)) {
    return {
      id: fallbackId,
      username: fallbackId,
      avatar: '',
      status: 'offline',
    };
  }

  const id = normalizeSidebarText(value.id, fallbackId);
  const username = normalizeSidebarText(value.username, id);
  const avatar = typeof value.avatar === 'string' ? value.avatar : '';
  const role = normalizeSidebarText(value.role, '');
  const roleColor = normalizeSidebarRoleColor(value.roleColor);
  const color = normalizeSidebarText(value.color, '');
  const bio = normalizeSidebarText(value.bio, '');
  const joinedAt = normalizeSidebarText(value.joinedAt, '');
  const muted = typeof value.muted === 'boolean' ? value.muted : undefined;
  const donationTier = normalizeSidebarDonationTier(value.donationTier);

  return {
    id,
    username,
    avatar,
    status: normalizeSidebarStatus(value.status),
    ...(role ? { role } : {}),
    ...(roleColor ? { roleColor } : {}),
    ...(color ? { color } : {}),
    ...(bio ? { bio } : {}),
    ...(joinedAt ? { joinedAt } : {}),
    ...(muted !== undefined ? { muted } : {}),
    ...(donationTier ? { donationTier } : {}),
  };
}

const RoleMarker: React.FC<{ role?: string; color?: string }> = ({ role, color }) => {
  if (!role || role.toLowerCase() === 'member') {
    return null;
  }

  const isAdmin = role.toLowerCase() === 'admin';
  return (
    <span
      className="inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center font-mono text-[11px] font-black leading-none"
      style={{ color: color ?? '#F5B942' }}
      role="img"
      aria-label={`${role} role`}
      title={role}
    >
      {isAdmin ? '@' : '+'}
    </span>
  );
};

function normalizeSidebarUsers(value: unknown): User[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: User[] = [];
  const seen = new Set<string>();
  for (const [index, member] of value.entries()) {
    const normalizedMember = normalizeSidebarUser(member, `member-${index}`);
    if (seen.has(normalizedMember.id)) {
      continue;
    }
    seen.add(normalizedMember.id);
    normalized.push(normalizedMember);
  }

  return normalized;
}

const TimeoutModal: React.FC<{ user: User; onClose: () => void; onApply: (duration: string, reason: string) => void }> = ({ user, onClose, onApply }) => {
  const [duration, setDuration] = useState('60');
  const [reason, setReason] = useState('');
  const [applied, setApplied] = useState(false);
  const durations = [
    { value: '60', label: '60 seconds' },
    { value: '300', label: '5 minutes' },
    { value: '600', label: '10 minutes' },
    { value: '3600', label: '1 hour' },
    { value: '86400', label: '1 day' },
    { value: '604800', label: '1 week' },
  ];

  const handleApply = () => {
    setApplied(true);
    onApply(duration, reason);
    setTimeout(onClose, 1500);
  };

  return (
    <div className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in" onClick={onClose}>
      <div className="glass-card rounded-r3 border border-white/10 w-full max-w-[380px] p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-bold text-white font-display">TIMEOUT // {user.username.toUpperCase()}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center hover:border-primary transition-all">
            <X size={14} className="text-white/40" />
          </button>
        </div>

        <div className="micro-label text-white/30 mb-2">DURATION</div>
        <div className="flex flex-wrap gap-2 mb-4">
          {durations.map(d => (
            <button
              key={d.value}
              onClick={() => setDuration(d.value)}
              className={`px-3 py-1.5 rounded-full text-[10px] font-bold border transition-all ${
                duration === d.value
                  ? 'bg-accent-warning/15 border-accent-warning/30 text-accent-warning'
                  : 'bg-white/3 border-white/5 text-white/30 hover:bg-white/5'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="micro-label text-white/30 mb-2">REASON (OPTIONAL)</div>
        <input
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Reason for timeout..."
          className="w-full bg-surface-dark rounded-r1 px-4 py-2.5 text-sm text-white placeholder:text-white/20 border border-white/5 focus:border-accent-warning/30 focus:outline-none mb-5 focus-ring"
        />

        <button
          onClick={handleApply}
          disabled={applied}
          className={`w-full py-3 rounded-full font-bold text-sm transition-all ${
            applied
              ? 'bg-accent-success/20 text-accent-success'
              : 'bg-accent-warning text-bg-0 hover:shadow-[0_0_15px_rgba(255,176,32,0.3)]'
          }`}
        >
          {applied ? '✓ TIMEOUT APPLIED' : 'APPLY TIMEOUT'}
        </button>
      </div>
    </div>
  );
};

export const MemberSidebar: React.FC<MemberSidebarProps> = ({ members, currentUser, serverOwnerId, serverId, collapsed, onToggleCollapse, isOverlay, runtimeSnapshot, onOpenDM }) => {
  const hookRuntimeSnapshot = useRuntimeSnapshot();
  const liveRuntimeSnapshot = runtimeSnapshot ?? hookRuntimeSnapshot;
  // Moderation routes through the mutation facade (the single switch-point) — a
  // component must never call the xoreinControl HTTP client directly.
  const mutations = useRuntimeMutations();
  const hasTimeout = useFeature('timeout');
  const [timeoutTarget, setTimeoutTarget] = useState<User | null>(null);
  const [timedOutUsers, setTimedOutUsers] = useState<Record<string, { duration: string; reason: string }>>({});
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'info' | 'success'; message: string } | null>(null);
  const normalizedMembers = React.useMemo(() => normalizeSidebarUsers(members), [members]);
  const normalizedCurrentUser = React.useMemo(() => normalizeSidebarUser(currentUser, 'me'), [currentUser]);

  useEffect(() => {
    if (!feedback) {
      return;
    }

    const timer = window.setTimeout(() => setFeedback(null), 2200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const groups = {
    'ONLINE': normalizedMembers.filter(m => m.status === 'online' || m.status === 'dnd'),
    'IDLE': normalizedMembers.filter(m => m.status === 'idle'),
    'OFFLINE': normalizedMembers.filter(m => m.status === 'offline'),
  };

  // A member's broadcast custom status (presence.status_text). Member ids are raw
  // peer ids except the local user, whose row id is remapped — resolve that back
  // to the snapshot's peer_id so your own custom status renders too.
  const statusTextFor = (userId: string): string | undefined => {
    const presence = liveRuntimeSnapshot?.presence;
    if (!presence || typeof presence !== 'object' || Array.isArray(presence)) return undefined;
    const peerKey = userId === normalizedCurrentUser.id ? (liveRuntimeSnapshot?.peer_id ?? userId) : userId;
    const entry = (presence as Record<string, { status_text?: string } | undefined>)[peerKey];
    const text = typeof entry?.status_text === 'string' ? entry.status_text.trim() : '';
    return text || undefined;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online': return 'bg-accent-success shadow-[0_0_5px_#05FFA1]';
      case 'idle': return 'bg-accent-warning shadow-[0_0_5px_#FFB020]';
      case 'dnd': return 'bg-accent-danger shadow-[0_0_5px_#FF2A6D]';
      default: return 'bg-white/20';
    }
  };

  const canModerateTimeouts = normalizedCurrentUser.role === 'Admin' || normalizedCurrentUser.role === 'Moderator' || normalizedCurrentUser.id === serverOwnerId;

  const handleTimeoutRequest = (user: User) => {
    if (!canModerateTimeouts) {
      setFeedback({ tone: 'info', message: `Permission denied: ${normalizedCurrentUser.username} cannot time out members.` });
      return;
    }

    if (user.role === 'Admin' || user.id === serverOwnerId || user.id === normalizedCurrentUser.id) {
      setFeedback({ tone: 'info', message: `${user.username} is protected and cannot be timed out.` });
      return;
    }

    setTimeoutTarget(user);
  };

  const handleTimeoutApply = async (user: User, duration: string, reason: string) => {
    try {
      await mutations.moderationAction(serverId, 'mute', {
        target_peer_id: user.id,
        duration_ms: Number(duration) * 1000,
        reason: reason.trim() || undefined,
      });
      setTimedOutUsers((prev) => ({
        ...prev,
        [user.id]: { duration, reason },
      }));
      setFeedback({ tone: 'success', message: `Applied a ${duration}s timeout to ${user.username} through xorein${reason.trim() ? ` (${reason.trim()})` : ''}.` });
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'Unable to apply timeout through xorein.' });
    }
  };

  return (
    <div className={`w-[224px] glass-realistic flex flex-col h-full ${isOverlay ? 'shadow-2xl' : ''}`}>
      {timeoutTarget && <TimeoutModal user={timeoutTarget} onClose={() => setTimeoutTarget(null)} onApply={(duration, reason) => handleTimeoutApply(timeoutTarget, duration, reason)} />}
      <div className="h-[52px] px-5 flex items-center justify-between border-b theme-border">
        <span className="micro-label theme-text-dim">Entities</span>
        <button onClick={onToggleCollapse} className="theme-text-dim hover:text-primary"><PanelRightClose size={16} /></button>
      </div>
      {feedback && (
        <div className={`mx-4 mt-4 rounded-r2 border px-3 py-2 text-[10px] ${feedback.tone === 'error' ? 'border-accent-danger/30 bg-accent-danger/10 text-accent-danger' : feedback.tone === 'success' ? 'border-accent-success/30 bg-accent-success/10 text-accent-success' : 'border-primary/30 bg-primary/10 text-primary'}`}>
          {feedback.message}
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-5 space-y-6 no-scrollbar">
        {Object.entries(groups).map(([name, users]) => (
          <div key={name}>
            <h3 className="micro-label theme-text-dim mb-3 px-2">{name} // {users.length}</h3>
            <div className="space-y-0.5">
              {users.map((u, i) => {
                const isCurrentUser = u.id === normalizedCurrentUser.id;
                return (
                  <motion.div
                    key={u.id}
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.03, duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    className={`flex items-center gap-2.5 px-2.5 py-2.5 rounded-r1 hover:bg-white/5 active:bg-white/8 transition-all group cursor-pointer relative min-h-[48px] ${isCurrentUser ? 'bg-primary/[0.06] ring-1 ring-inset ring-primary/25' : ''} ${timedOutUsers[u.id] ? 'opacity-80' : ''}`}
                    data-member-id={u.id}
                    aria-current={isCurrentUser ? 'true' : undefined}
                  >
                  <div className="relative">
                    <img src={resolveAvatarSrc(u.avatar, u.username)} className="w-[26px] h-[26px] rounded-r1 border theme-border grayscale-[0.3] group-hover:grayscale-0 transition-all" />
                    <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-bg-1 ${getStatusColor(u.status)}`}></div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1 min-w-0">
                        <RoleMarker role={u.role} color={u.roleColor} />
                        <div className="text-xs font-bold theme-text-secondary group-hover:theme-text truncate" style={u.status !== 'offline' ? {color: u.color} : {}}>{u.username}</div>
                        {isCurrentUser && <span className="text-[7px] font-bold uppercase tracking-wider text-primary/75">You</span>}
                        {u.donationTier && <DonorBadge tier={u.donationTier} compact />}
                        {timedOutUsers[u.id] && <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-accent-warning/20 bg-accent-warning/10 text-accent-warning">timeout</span>}
                      </div>
                      {u.status !== 'offline' && <div className={`w-1.5 h-1.5 rounded-full ${getStatusColor(u.status).split(' ')[0]}`}></div>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[8px] uppercase font-bold tracking-wider opacity-50" style={{ color: u.status === 'online' ? '#05FFA1' : u.status === 'dnd' ? '#FF2A6D' : u.status === 'idle' ? '#FFB020' : 'rgba(255,255,255,0.3)' }}>{u.status}</span>
                      {statusTextFor(u.id) && <span className="text-[9px] text-primary/70 font-mono truncate">{statusTextFor(u.id)}</span>}
                      {timedOutUsers[u.id] && <span className="text-[8px] uppercase font-bold tracking-wider text-accent-warning">{timedOutUsers[u.id].duration}s hold</span>}
                      {u.bio && <div className="text-[9px] theme-text-dim font-mono truncate hidden group-hover:block transition-all"> // {u.bio.substring(0, 15)}</div>}
                    </div>
                  </div>
                  {/* Contextual action buttons (DM + Timeout) */}
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {onOpenDM && u.id !== normalizedCurrentUser.id && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpenDM(u.id); }}
                        className="p-1 rounded-full hover:bg-primary/10 text-white/20 hover:text-primary transition-all"
                        title={`Send DM to ${u.username}`}
                        aria-label={`Send DM to ${u.username}`}
                      >
                        <MessageCircle size={12} />
                      </button>
                    )}
                    {hasTimeout && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (timedOutUsers[u.id]) {
                            setFeedback({ tone: 'info', message: `${u.username} already has a local timeout applied.` });
                          } else {
                            handleTimeoutRequest(u);
                          }
                        }}
                        className="p-1 rounded-full hover:bg-accent-warning/10 text-white/20 hover:text-accent-warning transition-all"
                        title={timedOutUsers[u.id] ? 'Timeout already applied' : 'Timeout user'}
                      >
                        <Clock size={12} />
                      </button>
                    )}
                  </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
