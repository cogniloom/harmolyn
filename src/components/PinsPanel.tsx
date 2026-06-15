
import React from 'react';
import { resolveAvatarSrc } from '@/lib/avatar';
import { Message, User } from '@/types';
import { Pin, X, ArrowRight } from 'lucide-react';
import { renderMarkdown } from '@/utils/markdown';

interface PinsPanelProps {
  messages: Message[];
  users: User[];
  onClose: () => void;
  onJumpToMessage?: (msgId: string) => void;
  onUnpin?: (msgId: string) => void;
}

function isPinsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizePinsText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizePinsUser(value: unknown, fallbackId: string): User {
  if (!isPinsRecord(value)) {
    return { id: fallbackId, username: fallbackId, avatar: '', status: 'offline' };
  }

  const id = normalizePinsText(value.id, fallbackId);
  return {
    id,
    username: normalizePinsText(value.username, id),
    avatar: typeof value.avatar === 'string' ? value.avatar : '',
    status: value.status === 'online' || value.status === 'idle' || value.status === 'dnd' ? value.status : 'offline',
    ...(typeof value.color === 'string' && value.color.trim() ? { color: value.color.trim() } : {}),
  };
}

function normalizePinsUsers(value: unknown): User[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: User[] = [];
  const seen = new Set<string>();
  value.forEach((user, index) => {
    const normalizedUser = normalizePinsUser(user, `member-${index}`);
    if (seen.has(normalizedUser.id)) {
      return;
    }
    seen.add(normalizedUser.id);
    normalized.push(normalizedUser);
  });

  return normalized;
}

function getUnknownPinsUser(): User {
  return { id: 'unknown', username: 'Unknown User', avatar: '', status: 'offline' as const, color: '#F6F8F8' };
}

export const PinsPanel: React.FC<PinsPanelProps> = ({ messages, users, onClose, onJumpToMessage, onUnpin }) => {
  const pinnedMessages = messages.filter(m => m.pinned);

  const normalizedUsers = React.useMemo(() => normalizePinsUsers(users), [users]);
  const getUser = (id: string) => normalizedUsers.find(u => u.id === id) || getUnknownPinsUser();

  return (
    <div className="w-[320px] h-full glass-realistic border-l border-white/5 flex flex-col animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="h-[52px] px-5 flex items-center justify-between border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Pin size={14} className="text-primary" />
          <span className="text-xs font-bold text-white tracking-wide uppercase">Pinned Messages</span>
          <span className="text-[9px] font-mono text-white/30">{pinnedMessages.length}</span>
        </div>
        <button onClick={onClose} className="p-1.5 text-white/30 hover:text-white transition-colors rounded-full hover:bg-white/5" aria-label="Close">
          <X size={16} />
        </button>
      </div>

      {/* Pins list */}
      <div className="flex-1 overflow-y-auto no-scrollbar p-3 space-y-2.5">
        {pinnedMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <div className="w-16 h-16 rounded-r2 bg-white/3 border border-white/5 flex items-center justify-center mb-4">
              <Pin size={28} className="text-white/10" />
            </div>
            <p className="text-xs text-white/30 mb-1 font-bold">No pinned messages</p>
            <p className="text-[10px] text-white/15 font-mono">Pin important messages to find them here</p>
          </div>
        ) : (
          pinnedMessages.map(msg => {
            const user = getUser(msg.userId);
            return (
              <div
                key={msg.id}
                className="glass-card rounded-r2 border border-white/5 p-3.5 hover:border-primary/15 transition-all group"
              >
                <div className="flex items-center gap-2 mb-2">
                  <img src={resolveAvatarSrc(user.avatar, user.username)} className="w-5 h-5 rounded-full border border-white/10" alt="" />
                  <span className="text-[11px] font-bold" style={{ color: user.color || '#F6F8F8' }}>{user.username}</span>
                  <span className="text-[8px] font-mono text-white/20 ml-auto">{msg.timestamp}</span>
                </div>
                <div className="text-[11px] text-white/60 leading-relaxed line-clamp-3 mb-2.5">
                  {renderMarkdown(msg.content)}
                </div>
                <div className="flex items-center justify-between opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <button
                    onClick={() => onJumpToMessage?.(msg.id)}
                    aria-label={`Jump to message from ${user.username}`}
                    className="focus-ring rounded-r1 px-1 -mx-1 flex items-center gap-1 text-[9px] text-primary/70 hover:text-primary transition-colors font-bold"
                  >
                    Jump to message <ArrowRight size={10} />
                  </button>
                  <button
                    onClick={() => onUnpin?.(msg.id)}
                    aria-label={`Unpin message from ${user.username}`}
                    className="focus-ring rounded-r1 px-1 -mx-1 text-[9px] text-white/20 hover:text-accent-danger transition-colors font-mono"
                  >
                    Unpin
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
