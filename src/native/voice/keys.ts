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

  // FAIL-CLOSED: without a real shared secret (crowd_root) there is no honest
  // SFrame key. We return null rather than a derivable placeholder — the caller
  // must then NOT enable SFrame, so media falls back to DTLS-only protection
  // instead of being labelled "encrypted" behind a public key. A real Seal/Tree
  // voice-key export will slot in here when it lands.
  return null;
}

/** Derive a PeerKey from a Crowd (server) crowd_root. */
function deriveCrowdPeerKey(crowdRoot: Uint8Array, peerId: string): PeerKey {
  const voiceRoot = deriveKey(crowdRoot, null, LABEL_VOICE_ROOT, 32);
  const peerKeyBytes = deriveKey(voiceRoot, utf8(peerId), LABEL_PEER_KEY, 32);
  return newPeerKey(peerId, peerKeyBytes);
}

/**
 * Determine the effective SFrame security mode for a voice channel. This must
 * agree with `deriveVoicePeerKey`: it returns `'crowd'` ONLY when a real shared
 * root exists for the channel's server (so a real key can be derived and SFrame is
 * genuine). A server channel without a seeded root — and every DM/other channel,
 * for which no shared voice-key export exists yet — is `'clear'`: SFrame stays off
 * and media is protected by DTLS alone, never by a placeholder key.
 */
export function voiceSecurityMode(channelId: string): 'crowd' | 'clear' {
  const serverId = serverIdForChannel(channelId);
  if (serverId && rootBytesForServer(serverId)) return 'crowd';
  return 'clear';
}
