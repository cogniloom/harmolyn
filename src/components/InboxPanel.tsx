import React, { useMemo, useState } from 'react';
import { Inbox, X, AtSign, Reply, Hash, Bell } from 'lucide-react';
import { Message, User } from '@/types';
import { resolveAvatarSrc } from '@/lib/avatar';

interface InboxPanelProps {
  items: InboxItem[];
  messages: Message[];
  users: User[];
  onJump: (item: InboxItem) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
}

const UNKNOWN_INBOX_USER: User = {
  id: 'unknown',
  username: 'Unknown User',
  avatar: '',
  status: 'offline',
};

export interface InboxItem {
  id: string;
  type: 'mention' | 'reply';
  messageId: string;
  channelName: string;
  serverName: string;
  timestamp: string;
  read: boolean;
}

type InboxFilter = 'all' | 'mentions' | 'replies';

function isInboxRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeInboxText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeInboxStatus(value: unknown): User['status'] {
  return value === 'online' || value === 'idle' || value === 'dnd' || value === 'offline' ? value : 'offline';
}

function normalizeInboxUser(value: unknown, fallbackId: string): User {
  if (!isInboxRecord(value)) {
    return { id: fallbackId, username: fallbackId, avatar: '', status: 'offline' };
  }

  const id = normalizeInboxText(value.id, fallbackId);
  return {
    id,
    username: normalizeInboxText(value.username, id),
    avatar: typeof value.avatar === 'string' ? value.avatar : '',
    status: normalizeInboxStatus(value.status),
    ...(typeof value.role === 'string' && value.role.trim() ? { role: value.role.trim() } : {}),
    ...(typeof value.color === 'string' && value.color.trim() ? { color: value.color.trim() } : {}),
    ...(typeof value.bio === 'string' && value.bio.trim() ? { bio: value.bio.trim() } : {}),
  };
}

function normalizeInboxItem(value: unknown): InboxItem | null {
  if (!isInboxRecord(value)) {
    return null;
  }

  const id = normalizeInboxText(value.id, '');
  const type = value.type === 'mention' || value.type === 'reply' ? value.type : null;
  const messageId = normalizeInboxText(value.messageId, '');
  const channelName = normalizeInboxText(value.channelName, '');
  const serverName = normalizeInboxText(value.serverName, '');
  const timestamp = normalizeInboxText(value.timestamp, '');

  if (!id || !type || !messageId || !channelName || !serverName || !timestamp) {
    return null;
  }

  return {
    id,
    type,
    messageId,
    channelName,
    serverName,
    timestamp,
    read: value.read === true,
  };
}

function normalizeInboxItems(value: unknown): InboxItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: InboxItem[] = [];

  for (const item of value) {
    const normalizedItem = normalizeInboxItem(item);
    if (!normalizedItem || seen.has(normalizedItem.id)) {
      continue;
    }
    seen.add(normalizedItem.id);
    normalized.push(normalizedItem);
  }

  return normalized;
}

export const InboxPanel: React.FC<InboxPanelProps> = ({ items, messages, users, onJump, onMarkAllRead, onClose }) => {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const normalizedUsers = useMemo(() => normalizeInboxUsers(users), [users]);
  const normalizedMessages = useMemo(() => normalizeInboxMessages(messages), [messages]);
  const normalizedItems = useMemo(() => normalizeInboxItems(items), [items]);

  const filtered = normalizedItems.filter(item => {
    if (filter === 'mentions') return item.type === 'mention';
    if (filter === 'replies') return item.type === 'reply';
    return true;
  });

  const unreadCount = normalizedItems.filter(i => !i.read).length;

  return (
    <div className="absolute right-0 top-[52px] bottom-0 w-[380px] z-50 glass-card border-l border-stroke flex flex-col animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="p-4 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Inbox size={18} className="text-primary" />
            <h2 className="text-title font-semibold text-text-primary">INBOX</h2>
            {unreadCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-accent-danger/20 text-accent-danger text-[10px] font-bold border border-accent-danger/30">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onMarkAllRead} className="text-[10px] text-primary hover:underline font-bold">Mark all read</button>
            <button onClick={onClose} className="w-7 h-7 rounded-full glass-panel border border-stroke-subtle flex items-center justify-center text-text-secondary hover:text-primary transition-all">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 bg-glass-overlay rounded-full border border-stroke-subtle p-0.5">
          {(['all', 'mentions', 'replies'] as InboxFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex-1 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all ${
                filter === f ? 'bg-primary text-bg-0' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-3">
            <Inbox size={32} className="text-white/10" />
            <p className="text-body text-text-secondary">No notifications</p>
          </div>
        ) : (
          filtered.map(item => {
            const msg = normalizedMessages.find(m => m.id === item.messageId);
            const user = msg ? normalizedUsers.find(u => u.id === msg.userId) ?? UNKNOWN_INBOX_USER : UNKNOWN_INBOX_USER;
            return (
              <button key={item.id} onClick={() => onJump(item)} className={`w-full glass-card rounded-r2 p-3 border transition-all cursor-pointer group text-left ${item.read ? 'border-stroke hover:border-stroke-strong' : 'border-primary/20 bg-primary/[0.03]'}`}>
                <div className="flex items-start gap-2.5">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${item.type === 'mention' ? 'bg-primary/10 text-primary' : 'bg-accent-purple/10 text-accent-purple'}`}>
                    {item.type === 'mention' ? <AtSign size={12} /> : <Reply size={12} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      {user && <img src={resolveAvatarSrc(user.avatar, user.username)} className="w-4 h-4 rounded-full" alt="" />}
                      <span className="text-xs font-bold text-text-primary">{user?.username}</span>
                      <span className="text-[9px] text-text-disabled">{item.timestamp}</span>
                      {!item.read && <div className="w-1.5 h-1.5 rounded-full bg-primary ml-auto flex-shrink-0" />}
                    </div>
                    <p className="text-caption text-text-secondary line-clamp-2">{msg?.content || 'Message content'}</p>
                    <div className="flex items-center gap-1.5 mt-1.5 text-[9px] text-text-disabled">
                      <Hash size={8} />
                      <span>{item.channelName}</span>
                      <span>•</span>
                      <span>{item.serverName}</span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

function normalizeInboxUsers(value: unknown): User[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: User[] = [];
  for (const entry of value) {
    const user = normalizeInboxUser(entry, 'member');
    if (seen.has(user.id)) {
      continue;
    }
    seen.add(user.id);
    normalized.push(user);
  }

  return normalized;
}

interface NormalizedInboxMessage {
  id: string;
  userId: string;
  content: string;
  timestamp: string;
}

function normalizeInboxMessages(value: unknown): NormalizedInboxMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: NormalizedInboxMessage[] = [];
  for (const entry of value) {
    const message = normalizeInboxMessage(entry);
    if (!message || seen.has(message.id)) {
      continue;
    }
    seen.add(message.id);
    normalized.push(message);
  }

  return normalized;
}

function normalizeInboxMessage(value: unknown): NormalizedInboxMessage | null {
  if (!isInboxRecord(value)) {
    return null;
  }

  const id = normalizeInboxText(value.id, '');
  const userId = normalizeInboxText(value.userId, '');
  const content = normalizeInboxText(value.content, '');
  const timestamp = normalizeInboxText(value.timestamp, '');

  if (!id || !userId || !content || !timestamp) {
    return null;
  }

  return { id, userId, content, timestamp };
}
