// Active VoiceSession registry — decouples the signaling inbound handler and
// the mutation facade from the engine's internal session map. Mirrors the
// pattern in src/native/sync/registry.ts.
import type { VoiceSession } from './session.js';

const _sessions = new Map<string, VoiceSession>();

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
