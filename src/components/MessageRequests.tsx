import React from 'react';
import { resolveAvatarSrc } from '@/lib/avatar';
import { Check, X, Shield, MessageSquare } from 'lucide-react';
import { USERS } from '@/data';
import type { MessageRequest } from '@/components/messageRequestsData';

interface MessageRequestsProps {
  requests: MessageRequest[];
  onAccept: (id: string) => void;
  onIgnore: (id: string) => void;
}

const UNKNOWN_MESSAGE_REQUEST_USER = {
  id: 'unknown',
  username: 'Unknown User',
  avatar: '',
  status: 'offline' as const,
};

function normalizeRequestText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeRequest(value: unknown): MessageRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = normalizeRequestText(record.id, '');
  const userId = normalizeRequestText(record.userId, '');
  const preview = normalizeRequestText(record.preview, '');
  const timestamp = normalizeRequestText(record.timestamp, '');
  if (!id || !userId || !preview || !timestamp) {
    return null;
  }

  return { id, userId, preview, timestamp };
}

function normalizeRequests(value: unknown): MessageRequest[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: MessageRequest[] = [];
  for (const request of value) {
    const normalizedRequest = normalizeRequest(request);
    if (!normalizedRequest || seen.has(normalizedRequest.id)) {
      continue;
    }
    seen.add(normalizedRequest.id);
    normalized.push(normalizedRequest);
  }

  return normalized;
}

function normalizeRequestUsers(value: unknown): typeof USERS {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: typeof USERS = [];
  const seen = new Set<string>();
  value.forEach((user, index) => {
    if (!user || typeof user !== 'object' || Array.isArray(user) || Object.getPrototypeOf(user) !== Object.prototype) {
      return;
    }
    const record = user as typeof USERS[number];
    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `member-${index}`;
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    normalized.push({
      ...record,
      id,
      username: typeof record.username === 'string' && record.username.trim() ? record.username.trim() : id,
      avatar: typeof record.avatar === 'string' ? record.avatar : '',
      status: record.status === 'online' || record.status === 'idle' || record.status === 'dnd' || record.status === 'offline'
        ? record.status
        : 'offline',
    });
  });

  return normalized;
}

export const MessageRequests: React.FC<MessageRequestsProps> = ({ requests, onAccept, onIgnore }) => {
  const normalizedRequests = normalizeRequests(requests);
  const normalizedUsers = normalizeRequestUsers(USERS);

  if (normalizedRequests.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-tertiary gap-3 p-8">
        <div className="w-16 h-16 rounded-full bg-primary/5 border border-primary/10 flex items-center justify-center">
          <Shield size={28} className="text-primary/30" />
        </div>
        <p className="text-body text-text-secondary">No pending requests</p>
        <p className="text-caption text-text-disabled text-center">When someone outside your network tries to message you, their request will appear here.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-2">
      <div className="micro-label text-text-tertiary px-2 mb-3">PENDING REQUESTS // {normalizedRequests.length}</div>
      {normalizedRequests.map(req => {
        const user = normalizedUsers.find(u => u.id === req.userId) ?? UNKNOWN_MESSAGE_REQUEST_USER;
        return (
          <div key={req.id} className="glass-card rounded-r2 p-4 border border-stroke hover:border-stroke-strong transition-all group">
            <div className="flex items-start gap-3">
              <img src={resolveAvatarSrc(user.avatar, user.username)} className="w-10 h-10 rounded-full border border-stroke flex-shrink-0" alt="" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-body-strong text-text-primary">{user.username}</span>
                  <span className="text-micro text-text-disabled">{req.timestamp}</span>
                </div>
                <p className="text-caption text-text-secondary truncate">{req.preview}</p>
                <div className="mt-2 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-text-disabled">
                  <MessageSquare size={12} />
                  Message request
                </div>
              </div>
              <div className="touch-action-reveal flex gap-1.5 flex-shrink-0 transition-opacity">
                <button
                  onClick={() => onAccept(req.id)}
                  className="compact-touch-target rounded-full bg-accent-success/10 border border-accent-success/20 flex items-center justify-center text-accent-success hover:bg-accent-success/20 transition-all"
                  aria-label="Accept request"
                >
                  <Check size={14} />
                </button>
                <button
                  onClick={() => onIgnore(req.id)}
                  className="compact-touch-target rounded-full bg-accent-danger/10 border border-accent-danger/20 flex items-center justify-center text-accent-danger hover:bg-accent-danger/20 transition-all"
                  aria-label="Ignore request"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
