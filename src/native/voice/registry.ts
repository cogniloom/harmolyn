// Active VoiceSession registry. UI observers are notified without polling.
import type { VoiceSession } from './session.js';
import { getState } from '../state/store.js';

const _sessions = new Map<string, VoiceSession>();
const observers = new Map<string, Set<() => void>>();

function notify(channelId: string): void {
  for (const listener of [...(observers.get(channelId) ?? [])]) {
    try { listener(); } catch { /* A failed UI observer must not interrupt session cleanup/rekey. */ }
  }
}

export function subscribeVoiceSession(channelId: string, listener: () => void): () => void {
  const listeners = observers.get(channelId) ?? new Set<() => void>();
  observers.set(channelId, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) observers.delete(channelId);
  };
}

/** Rekey active channels after an owner-authorized membership/root change. */
export function rekeyVoiceForServer(serverId: string): void {
  const server = getState().servers[serverId];
  if (!server) return;
  const members = server.members ?? [];
  for (const channelId of Object.keys(server.channels ?? {})) _sessions.get(channelId)?.rekey(members);
}

export function registerVoiceSession(session: VoiceSession): void {
  if (_sessions.get(session.channelId) === session) return;
  _sessions.set(session.channelId, session);
  notify(session.channelId);
}
export function getVoiceSession(channelId: string): VoiceSession | null { return _sessions.get(channelId) ?? null; }
export function clearVoiceSession(channelId: string): void { if (_sessions.delete(channelId)) notify(channelId); }
export function activeVoiceChannels(): string[] { return Array.from(_sessions.keys()); }
export function setVoiceMicVolume(volumePct: number): void {
  for (const session of _sessions.values()) session.setMicVolume(volumePct);
}
