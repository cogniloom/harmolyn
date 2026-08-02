// Passive, authenticated voice occupancy for server channels.
//
// A user who has not joined a media session still needs to see which members
// are in a channel. Presence is delivered directly over the authenticated
// libp2p voice protocol, never through the public Xorein HTTP gateway. We only
// accept it for a current member of the server that owns the channel, retain it
// for a short bounded TTL, and remove it immediately on a signed leave.
import {
  getState,
  joinVoice as storeJoinVoice,
  leaveVoice as storeLeaveVoice,
  setVoiceParticipant,
  upsertPeer,
} from '../state/store.js';
import { publishNativeSnapshot } from '../state/snapshot.js';
import type { VoicePresenceRequest } from './signaling.js';

/** A live session re-announces before this expires; crash/disconnect cleanup. */
export const VOICE_OBSERVED_PRESENCE_TTL_MS = 45_000;
/** Repeated `join` is backwards-compatible with existing voice peers. */
export const VOICE_PRESENCE_HEARTBEAT_MS = 15_000;

// Authenticated membership limits who can advertise, but still cap state so a
// compromised/buggy member cannot make an observer retain unbounded entries.
export const MAX_OBSERVED_VOICE_PARTICIPANTS = 128;
const MAX_CHANNEL_ID_LENGTH = 256;
const MAX_PEER_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 256;

interface ObservedVoicePresence {
  channelId: string;
  peerId: string;
  expiresAt: number;
}

const observed = new Map<string, ObservedVoicePresence>();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function presenceKey(channelId: string, peerId: string): string {
  return `${channelId}\u0000${peerId}`;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function safeIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !hasControlCharacter(value);
}

/** Strictly parse a channel id carried by an untrusted protocol frame. */
export function voicePresenceChannelId(value: unknown): string | null {
  return safeIdentifier(value, MAX_CHANNEL_ID_LENGTH) ? value : null;
}

/**
 * Return true only when `peerId` is a current member of the server owning
 * `channelId`. Passive occupancy intentionally has no ad-hoc/DM fallback: an
 * observer has no caller-owned roster there to validate against.
 */
export function isEligibleObservedVoicePeer(channelId: string, peerId: string): boolean {
  if (!safeIdentifier(channelId, MAX_CHANNEL_ID_LENGTH)
    || !safeIdentifier(peerId, MAX_PEER_ID_LENGTH)) return false;
  const localPeerId = getState().identity?.peer_id;
  if (!safeIdentifier(localPeerId, MAX_PEER_ID_LENGTH)) return false;
  for (const server of Object.values(getState().servers)) {
    if (server.channels && channelId in server.channels) {
      const members = server.members ?? [];
      // Membership is symmetric: a stale local Space record must not let a
      // removed observer continue learning which remaining members are in voice.
      return members.includes(localPeerId) && members.includes(peerId);
    }
  }
  return false;
}

function stopExpiryTimer(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
}

function scheduleExpiry(): void {
  stopExpiryTimer();
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const item of observed.values()) nextExpiry = Math.min(nextExpiry, item.expiresAt);
  if (!Number.isFinite(nextExpiry)) return;
  const delay = Math.max(0, nextExpiry - Date.now());
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    expireObservedVoicePresence();
  }, delay);
}

function removeObserved(channelId: string, peerId: string, publish: boolean): boolean {
  const key = presenceKey(channelId, peerId);
  if (!observed.delete(key)) return false;
  storeLeaveVoice(channelId, peerId);
  if (publish) publishNativeSnapshot();
  return true;
}

/** Remove stale passive participants. Called by one timer, not per peer. */
export function expireObservedVoicePresence(now = Date.now()): void {
  let changed = false;
  for (const item of [...observed.values()]) {
    if (item.expiresAt > now) continue;
    changed = removeObserved(item.channelId, item.peerId, false) || changed;
  }
  if (changed) publishNativeSnapshot();
  scheduleExpiry();
}

/**
 * Apply a direct, authenticated presence frame to a passive observer's runtime
 * snapshot. Returns false without mutating state for unknown channels,
 * non-members, malformed payloads, or a full bounded roster.
 */
export function observeVoicePresence(
  channelId: string,
  remotePeerId: string,
  request: VoicePresenceRequest,
): boolean {
  if (!isEligibleObservedVoicePeer(channelId, remotePeerId)) return false;
  if (request.session_id !== channelId) return false;
  if (request.action !== 'join' && request.action !== 'query' && request.action !== 'leave') return false;

  const key = presenceKey(channelId, remotePeerId);
  if (request.action === 'leave') {
    const changed = removeObserved(channelId, remotePeerId, false);
    if (changed) publishNativeSnapshot();
    scheduleExpiry();
    return true;
  }

  // A state-change query must not create a new participant. Only a join (or a
  // later heartbeat, which is deliberately encoded as join for compatibility)
  // may introduce passive occupancy.
  const existing = observed.get(key);
  if (!existing && request.action !== 'join') return true;
  if (!existing && observed.size >= MAX_OBSERVED_VOICE_PARTICIPANTS) return false;

  observed.set(key, { channelId, peerId: remotePeerId, expiresAt: Date.now() + VOICE_OBSERVED_PRESENCE_TTL_MS });
  storeJoinVoice(channelId, remotePeerId);

  const mediaState: { muted?: boolean; video?: boolean; screen_sharing?: boolean } = {};
  if (typeof request.muted === 'boolean') mediaState.muted = request.muted;
  if (typeof request.video === 'boolean') mediaState.video = request.video;
  if (typeof request.screen_sharing === 'boolean') mediaState.screen_sharing = request.screen_sharing;
  setVoiceParticipant(channelId, remotePeerId, mediaState);

  // Profile data is authenticated as the direct sender, but it is still bounded
  // before it reaches durable runtime state. Avatar blobs are deliberately not
  // learned from a lightweight occupancy beacon.
  if (safeIdentifier(request.display_name, MAX_DISPLAY_NAME_LENGTH)) {
    upsertPeer({ peer_id: remotePeerId, display_name: request.display_name });
  }

  publishNativeSnapshot();
  scheduleExpiry();
  return true;
}

/**
 * Discard passive occupancy before a local media session takes ownership of the
 * channel. Its handshake will rebuild the authoritative active roster, and this
 * prevents the passive TTL from later removing an active participant.
 */
export function clearObservedVoicePresence(channelId: string): void {
  let changed = false;
  for (const item of [...observed.values()]) {
    if (item.channelId !== channelId) continue;
    changed = removeObserved(item.channelId, item.peerId, false) || changed;
  }
  if (changed) publishNativeSnapshot();
  scheduleExpiry();
}

/** Test/teardown helper; no production caller should need global clearing. */
export function clearAllObservedVoicePresence(): void {
  let changed = false;
  for (const item of [...observed.values()]) {
    changed = removeObserved(item.channelId, item.peerId, false) || changed;
  }
  if (changed) publishNativeSnapshot();
  stopExpiryTimer();
}
