import React, { useState } from 'react';
import { resolveAvatarSrc } from '@/lib/avatar';
import { Message, User } from '@/types';
import { renderMarkdown } from '@/utils/markdown';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { X, Send, MessageSquare } from 'lucide-react';

interface ThreadPanelProps {
  parentMessage: Message;
  parentUser: User;
  allUsers: User[];
  replies: Message[];
  onSend: (content: string) => void;
  onClose: () => void;
}

function isThreadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeThreadText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeThreadStatus(value: unknown): User['status'] {
  return value === 'online' || value === 'idle' || value === 'dnd' || value === 'offline' ? value : 'offline';
}

function normalizeThreadUser(value: unknown, fallbackId: string): User {
  if (!isThreadRecord(value)) {
    return { id: fallbackId, username: fallbackId, avatar: '', status: 'offline' };
  }

  const id = normalizeThreadText(value.id, fallbackId);
  return {
    id,
    username: normalizeThreadText(value.username, id),
    avatar: typeof value.avatar === 'string' ? value.avatar : '',
    status: normalizeThreadStatus(value.status),
    ...(typeof value.color === 'string' && value.color.trim() ? { color: value.color.trim() } : {}),
  };
}

function normalizeThreadUsers(value: unknown): User[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: User[] = [];
  const seen = new Set<string>();
  value.forEach((user, index) => {
    const normalizedUser = normalizeThreadUser(user, `member-${index}`);
    if (seen.has(normalizedUser.id)) {
      return;
    }
    seen.add(normalizedUser.id);
    normalized.push(normalizedUser);
  });

  return normalized;
}

function getUnknownThreadUser(): User {
  return { id: 'unknown', username: 'Unknown User', avatar: '', status: 'offline' as const };
}

export const ThreadPanel: React.FC<ThreadPanelProps> = ({ parentMessage, parentUser, allUsers, replies, onSend, onClose }) => {
  const [input, setInput] = useState('');

  useEscapeKey(onClose);

  const normalizedParentUser = React.useMemo(() => normalizeThreadUser(parentUser, 'parent'), [parentUser]);
  const normalizedUsers = React.useMemo(() => normalizeThreadUsers(allUsers), [allUsers]);
  const getUser = (id: string): User => normalizedUsers.find(u => u.id === id) || getUnknownThreadUser();

  const canSend = input.trim().length > 0;

  const handleSend = () => {
    if (!canSend) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm z-30 animate-in fade-in" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Thread"
        className="absolute top-0 right-0 bottom-0 w-[320px] max-w-full bg-bg-0 border-l border-white/10 z-40 flex flex-col animate-in slide-in-from-right duration-300 shadow-2xl"
      >
        {/* Header */}
        <div className="h-[52px] px-5 flex items-center justify-between border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare size={14} className="text-primary" />
            <div>
              <h3 className="font-bold text-white text-xs font-display">THREAD</h3>
              <span className="micro-label text-white/30 text-[8px]">{replies.length} REPLIES</span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close thread" className="focus-ring p-1.5 text-white/40 hover:text-primary transition-colors rounded-full hover:bg-white/5">
            <X size={16} />
          </button>
        </div>

        {/* Parent message */}
        <div className="px-4 py-3 border-b border-white/5 bg-white/[0.02]">
          <div className="flex items-center gap-2 mb-1.5">
            <img referrerPolicy="no-referrer" src={resolveAvatarSrc(normalizedParentUser.avatar, normalizedParentUser.username)} className="w-6 h-6 rounded-full" alt={normalizedParentUser.username} />
            <span className="text-xs font-bold" style={{ color: normalizedParentUser.color || '#F6F8F8' }}>{normalizedParentUser.username}</span>
            <span className="text-[9px] text-white/25 font-mono">{parentMessage.timestamp}</span>
          </div>
          <div className="text-xs text-white/70 leading-relaxed">{renderMarkdown(parentMessage.content)}</div>
        </div>

        {/* Replies */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 no-scrollbar">
          {replies.map(reply => {
            const user = getUser(reply.userId);
            return (
              <div key={reply.id} className="flex gap-2.5">
                <img referrerPolicy="no-referrer" src={resolveAvatarSrc(user.avatar, user.username)} className="w-7 h-7 rounded-full mt-0.5 flex-shrink-0" alt={user.username} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[11px] font-bold" style={{ color: user.color || '#F6F8F8' }}>{user.username}</span>
                    <span className="text-[8px] text-white/20 font-mono">{reply.timestamp}</span>
                  </div>
                  <div className="text-xs text-white/70 leading-relaxed">{renderMarkdown(reply.content)}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Input */}
        <div className="p-3 border-t border-white/5">
          <label htmlFor="thread-reply-input" className="sr-only">Reply to thread</label>
          <div className="glass-realistic rounded-r2 flex items-center p-1 focus-within:border-primary/50 transition-all">
            <input
              id="thread-reply-input"
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
              placeholder="REPLY // THREAD"
              className="flex-1 bg-transparent border-none focus:outline-none text-white px-3 font-mono text-xs placeholder-white/30"
            />
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="focus-ring w-8 h-8 rounded-full bg-primary flex items-center justify-center text-bg-0 shadow-glow-sm transition-all hover:scale-105 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
              aria-label="Send Reply"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
