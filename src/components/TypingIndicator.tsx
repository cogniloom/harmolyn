import React, { useMemo } from 'react';
import { User } from '@/types';

interface TypingIndicatorProps {
  users: User[];
  currentUserId: string;
  /**
   * Ids of users currently reported as typing, derived from real presence data
   * (e.g. XoreinPresenceEntry.typing_in_scope) by the caller. When empty or
   * omitted, the indicator renders nothing — it never fabricates typing activity.
   */
  typingUserIds?: string[];
}

function isTypingRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeTypingText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeTypingStatus(value: unknown): User['status'] {
  return value === 'online' || value === 'idle' || value === 'dnd' || value === 'offline' ? value : 'offline';
}

function normalizeTypingUser(value: unknown, fallbackId: string): User {
  if (!isTypingRecord(value)) {
    return { id: fallbackId, username: fallbackId, avatar: '', status: 'offline' };
  }

  const id = normalizeTypingText(value.id, fallbackId);
  return {
    id,
    username: normalizeTypingText(value.username, id),
    avatar: typeof value.avatar === 'string' ? value.avatar : '',
    status: normalizeTypingStatus(value.status),
    ...(typeof value.role === 'string' && value.role.trim() ? { role: value.role.trim() } : {}),
    ...(typeof value.color === 'string' && value.color.trim() ? { color: value.color.trim() } : {}),
    ...(typeof value.bio === 'string' && value.bio.trim() ? { bio: value.bio.trim() } : {}),
  };
}

function normalizeTypingUsers(users: unknown[]): User[] {
  const seen = new Set<string>();
  const normalized: User[] = [];

  for (const [index, user] of users.entries()) {
    const normalizedUser = normalizeTypingUser(user, `member-${index}`);
    if (seen.has(normalizedUser.id)) {
      continue;
    }
    seen.add(normalizedUser.id);
    normalized.push(normalizedUser);
  }

  return normalized;
}

const TypingDots = () => (
  <span className="inline-flex items-center gap-[3px] ml-1">
    <span className="w-[5px] h-[5px] rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms', animationDuration: '1s' }}></span>
    <span className="w-[5px] h-[5px] rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms', animationDuration: '1s' }}></span>
    <span className="w-[5px] h-[5px] rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms', animationDuration: '1s' }}></span>
  </span>
);

export const TypingIndicator: React.FC<TypingIndicatorProps> = ({ users, currentUserId, typingUserIds }) => {
  const normalizedUsers = useMemo(() => normalizeTypingUsers(users), [users]);

  // Only show users actually reported as typing via real presence data. We never
  // invent typing activity: without an explicit list of currently-typing ids the
  // indicator renders nothing.
  const typingUserObjects = useMemo(() => {
    if (!typingUserIds || typingUserIds.length === 0) {
      return [];
    }
    const typingSet = new Set(typingUserIds.filter((id) => id && id !== currentUserId));
    return normalizedUsers.filter((user) => typingSet.has(user.id));
  }, [typingUserIds, normalizedUsers, currentUserId]);

  if (typingUserObjects.length === 0) return null;

  const names = typingUserObjects.map(u => u.username);
  let text: string;
  if (names.length === 1) {
    text = `${names[0]} is typing`;
  } else if (names.length === 2) {
    text = `${names[0]} and ${names[1]} are typing`;
  } else {
    text = `${names[0]} and ${names.length - 1} others are typing`;
  }

  return (
    <div className="h-6 flex items-center gap-2 px-4 text-[11px] text-white/60 font-mono animate-in fade-in duration-200">
      <span className="font-bold text-white/80">{text}</span>
      <TypingDots />
    </div>
  );
};
