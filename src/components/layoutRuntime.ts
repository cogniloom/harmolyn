import type { User, XoreinRuntimeVoiceParticipant, XoreinRuntimeVoiceSession } from "@/types";

const UNKNOWN_LAYOUT_USER: User = {
  id: "unknown",
  username: "Unknown User",
  avatar: "",
  status: "offline",
};

export function normalizeRuntimePeerId(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function normalizeRuntimeVoiceSession(value: unknown): XoreinRuntimeVoiceSession | null {
  if (!isStrictPlainObject(value) || typeof value.channel_id !== "string" || !value.channel_id.trim() || !isStrictPlainObject(value.participants)) {
    return null;
  }

  const participants = Object.entries(value.participants).reduce<Record<string, XoreinRuntimeVoiceParticipant>>((acc, [peerId, record]) => {
    if (typeof peerId !== "string" || !peerId.trim() || !isStrictPlainObject(record) || typeof record.peer_id !== "string" || record.peer_id.trim() !== peerId.trim()) {
      return acc;
    }

    const normalizedPeerId = peerId.trim();
    if (Object.prototype.hasOwnProperty.call(acc, normalizedPeerId)) {
      return acc;
    }

    acc[normalizedPeerId] = {
      peer_id: normalizedPeerId,
      ...(typeof record.muted === "boolean" ? { muted: record.muted } : {}),
      ...(typeof record.joined_at === "string" && record.joined_at.trim() ? { joined_at: record.joined_at.trim() } : {}),
      ...(typeof record.last_frame_at === "string" && record.last_frame_at.trim() ? { last_frame_at: record.last_frame_at.trim() } : {}),
      ...(typeof record.video === "boolean" ? { video: record.video } : {}),
      ...(typeof record.screen_sharing === "boolean" ? { screen_sharing: record.screen_sharing } : {}),
      ...(typeof record.speaking === "boolean" ? { speaking: record.speaking } : {}),
      ...(typeof record.connection_state === "string" && record.connection_state.trim() ? { connection_state: record.connection_state.trim() } : {}),
    };
    return acc;
  }, {});

  return Object.keys(participants).length > 0
    ? {
        channel_id: value.channel_id.trim(),
        participants,
        ...(value.security_mode === "seal" || value.security_mode === "crowd" || value.security_mode === "tree" || value.security_mode === "clear"
          ? { security_mode: value.security_mode }
          : {}),
        ...(value.connection_state === "connecting" || value.connection_state === "connected" || value.connection_state === "failed" || value.connection_state === "closed"
          ? { connection_state: value.connection_state }
          : {}),
        ...(typeof value.self_muted === "boolean" ? { self_muted: value.self_muted } : {}),
        ...(typeof value.turn_unavailable === "boolean" ? { turn_unavailable: value.turn_unavailable } : {}),
      }
    : null;
}

export function normalizeLayoutUsers(value: unknown): User[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: User[] = [];
  const seen = new Set<string>();
  value.forEach((user, index) => {
    const normalizedUser = normalizeLayoutUser(user, `member-${index}`);
    if (seen.has(normalizedUser.id)) {
      return;
    }
    seen.add(normalizedUser.id);
    normalized.push(normalizedUser);
  });

  return normalized;
}

export function resolveLayoutDirectMessageUser(users: readonly User[], userId: string): User {
  return users.find((user) => user.id === userId) ?? UNKNOWN_LAYOUT_USER;
}

function normalizeLayoutUser(value: unknown, fallbackId: string): User {
  if (!isStrictPlainObject(value)) {
    return { id: fallbackId, username: fallbackId, avatar: '', status: 'offline' };
  }

  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : fallbackId;
  const username = typeof value.username === "string" && value.username.trim() ? value.username.trim() : id;
  const avatar = typeof value.avatar === "string" ? value.avatar : "";
  const status = value.status === "online" || value.status === "idle" || value.status === "dnd" || value.status === "offline"
    ? value.status
    : "offline";

  return {
    id,
    username,
    avatar,
    status,
    ...(typeof value.role === "string" && value.role.trim() ? { role: value.role.trim() } : {}),
    ...(typeof value.roleColor === "string" && value.roleColor.trim() ? { roleColor: value.roleColor.trim() } : {}),
    ...(typeof value.color === "string" && value.color.trim() ? { color: value.color.trim() } : {}),
    ...(typeof value.bio === "string" && value.bio.trim() ? { bio: value.bio.trim() } : {}),
  };
}

function isStrictPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
