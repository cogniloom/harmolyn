// xorein P2P family protocol IDs and payload types.
// Byte-compatible with Go oracle: pkg/v0_1/family/*/handler.go

export const PROTOCOLS = {
  peer:     '/aether/peer/0.1.0',
  identity: '/aether/identity/0.1.0',
  presence: '/aether/presence/0.2.0',
  chat:     '/aether/chat/0.1.0',
  dm:       '/aether/dm/0.1.0',
  friends:  '/aether/friends/0.1.0',
  notify:   '/aether/notify/0.1.0',
  voice:    '/aether/voice/0.1.0',
  sync:     '/aether/sync/0.1.0',
  seal:     '/aether/seal/0.1.0',
  recovery: '/aether/recovery/0.1.0',
} as const;

// ── Social recovery (friend-held identity backup) ────────────────────────────

export const RECOVERY_OPS = {
  // owner → guardian: "hold my password-encrypted backup".
  store: 'recovery.store',
  // requester → guardian: "I'm recovering account X — please release my backup".
  request: 'recovery.request',
  // guardian → requester (after manual consent): the backup blob.
  deliver: 'recovery.deliver',
} as const;

// ── Presence ───────────────────────────────────────────────────────────────

export type PresenceStatus = 'online' | 'away' | 'offline' | 'idle' | 'dnd' | 'invisible';

export interface PresenceRecord {
  peer_id: string;
  status: PresenceStatus;
  status_text?: string;
  updated_at: string;
  status_version?: number;
  is_typing?: boolean;
  typing_in_scope?: string;
}

// ── Friends ────────────────────────────────────────────────────────────────

export interface FriendRequest {
  from_peer_id: string;
  display_name: string;
  message?: string;
  timestamp: string;
}

export interface FriendResponse {
  to_peer_id: string;
  accepted: boolean;
  timestamp: string;
}

// ── Notifications ──────────────────────────────────────────────────────────

export type NotificationKind = 'mention' | 'reply' | 'reaction' | 'friend_request' | 'invite';

export interface NotificationEvent {
  kind: NotificationKind;
  scope_id: string;
  message_id?: string;
  from_peer_id: string;
  preview?: string;
  timestamp: string;
}

// ── Reactions ─────────────────────────────────────────────────────────────

export interface ReactionEvent {
  scope_id: string;
  message_id: string;
  emoji: string;
  from_peer_id: string;
  action: 'add' | 'remove';
  timestamp: string;
}

// ── Pins ──────────────────────────────────────────────────────────────────

export interface PinEvent {
  channel_id: string;
  message_id: string;
  pinned_by: string;
  action: 'pin' | 'unpin';
  timestamp: string;
}

// ── Typing ────────────────────────────────────────────────────────────────

export interface TypingEvent {
  scope_id: string;
  peer_id: string;
  is_typing: boolean;
}
