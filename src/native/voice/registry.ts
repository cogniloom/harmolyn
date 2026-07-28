// Active VoiceSession registry — decouples the signaling inbound handler and
// the mutation facade from the engine's internal session map. Mirrors the
// pattern in src/native/sync/registry.ts.
import type { VoiceSession } from './session.js';
import { getState } from '../state/store.js';

const _sessions = new Map<string, VoiceSession>();

/**
 * Rekey any active voice session on a server whose Crowd root just rotated (join/kick/leave)
 * — re-deriving SFrame keys, dropping removed members' live connections, and reconnecting
 * remaining members under the new key. Safe to call when no call is in progress.
 */
export function rekeyVoiceForServer(serverId: string): void {
  const server = getState().servers[serverId];
  if (!server) return;
  const members = server.members ?? [];
  for (const channelId of Object.keys(server.channels ?? {})) {
    _sessions.get(channelId)?.rekey(members);
  }
}

export function registerVoiceSession(session: VoiceSession): void {
  _sessions.set(session.channelId, session);
}

export function getVoiceSession(channelId: string): VoiceSession | null {
  return _sessions.get(channelId) ?? null;
}

export function clearVoiceSession(channelId: string): void {
  _sessions.delete(channelId);
}

/** Returns all currently active channel IDs. For diagnostics only. */
export function activeVoiceChannels(): string[] {
  return Array.from(_sessions.keys());
}

/** Apply a capture-volume change (0..100) to every active call immediately, so
 *  the mic-volume setting takes effect live whether or not a call is in progress. */
export function setVoiceMicVolume(volumePct: number): void {
  for (const session of _sessions.values()) session.setMicVolume(volumePct);
}
