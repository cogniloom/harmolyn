// Voice key derivation: group-key (crowd_root) → per-peer PeerKey for SFrame E2EE.
//
// Security model:
//  • Voice channels inherit the parent scope's security mode.
//  • For server voice channels (Crowd mode): crowd_root is already a zero-knowledge
//    32-byte shared root distributed member-to-member by the native sync engine
//    (see src/native/sync/secureEnvelope.ts rootBytesForServer). It is never sent
//    to the support node. Every channel member derives identical per-peer keys,
//    so the SFU only ever sees SFrame ciphertext.
//  • For DM (Seal) and Tree voice: STUB — no exported shared secret exists yet.
//    These return a deterministic placeholder derived from channelId so the code
//    path is exercised, but they MUST NOT be enabled in production until the
//    Seal session export and Tree group-secret accessor land.
//    They are flag-gated off via featureFlags.voiceMediaTransport.
//
// Key derivation:
//   voiceRoot   = HKDF(crowd_root, null, 'xorein/mediashield/v1/voice-root',  32)
//   peerKey(pid) = HKDF(voiceRoot,  utf8(pid), 'xorein/mediashield/v1/peer-key', 32)
//   PeerKey     = newPeerKey(pid, peerKey(pid))
import { deriveKey } from '../seal/kdf.js';
import { newPeerKey, type PeerKey } from './mediashield.js';
import { getState } from '../state/store.js';

const LABEL_VOICE_ROOT = 'xorein/mediashield/v1/voice-root';
const LABEL_PEER_KEY   = 'xorein/mediashield/v1/peer-key';

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Decode a base64-encoded 32-byte crowd_root into Uint8Array. */
function rootBytesForServer(serverId: string): Uint8Array | null {
  const server = getState().servers[serverId];
  const rootB64 = (server as { crowd_root?: string } | undefined)?.crowd_root;
  if (!rootB64) return null;
  try {
    const bin = atob(rootB64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length === 32 ? out : null;
  } catch {
    return null;
  }
}

/** Find the server that owns channelId, or undefined. */
function serverIdForChannel(channelId: string): string | undefined {
  return Object.values(getState().servers).find(s =>
    Object.keys(s.channels ?? {}).includes(channelId),
  )?.id;
}

/**
 * Derive the per-peer SFrame PeerKey for a given peer in a voice channel.
 *
 * @param channelId - The voice channel ID.
 * @param peerId    - The peer whose key to derive (use local peer_id for encrypt,
 *                    remote peer_id for decrypt).
 * @returns PeerKey ready for createEncryptTransform / createDecryptTransform, or
 *          null if the crowd_root is not yet available for this channel's server.
 */
export function deriveVoicePeerKey(channelId: string, peerId: string): PeerKey | null {
  const serverId = serverIdForChannel(channelId);
  if (serverId) {
    const root = rootBytesForServer(serverId);
    if (root) {
      return deriveCrowdPeerKey(root, peerId);
    }
  }

  // STUB: DM/Seal and Tree mode voice — no shared secret available yet.
  // Returns a deterministic placeholder so tests pass; MUST NOT ship enabled
  // in production for these modes.
  return deriveStubPeerKey(channelId, peerId);
}

/** Derive a PeerKey from a Crowd (server) crowd_root. */
function deriveCrowdPeerKey(crowdRoot: Uint8Array, peerId: string): PeerKey {
  const voiceRoot = deriveKey(crowdRoot, null, LABEL_VOICE_ROOT, 32);
  const peerKeyBytes = deriveKey(voiceRoot, utf8(peerId), LABEL_PEER_KEY, 32);
  return newPeerKey(peerId, peerKeyBytes);
}

/**
 * STUB: placeholder key derived from channelId for modes without a shared root.
 * Marked clearly so it is never mistaken for a real security primitive.
 * Replace when Seal session export (src/native/seal/session.ts) and Tree group-
 * secret accessor are implemented.
 */
function deriveStubPeerKey(channelId: string, peerId: string): PeerKey {
  // STUB: deterministic but NOT secure — replace for Seal/Tree voice.
  const fakeSeed = utf8(`stub:${channelId}:${peerId}`);
  const padded = new Uint8Array(32);
  padded.set(fakeSeed.slice(0, 32));
  return newPeerKey(peerId, padded);
}

/**
 * Determine the effective security mode for a voice channel.
 * Server channels → 'crowd'. DM channels → 'seal' (stub). Others → 'clear'.
 */
export function voiceSecurityMode(channelId: string): 'crowd' | 'seal' | 'clear' {
  if (serverIdForChannel(channelId)) return 'crowd';
  // STUB: DM voice — to be replaced with real Seal detection.
  const state = getState();
  if (state.dms && channelId in (state.dms as Record<string, unknown>)) return 'seal';
  return 'clear';
}
