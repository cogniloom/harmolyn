// Voice mesh signaling helpers over the /aether/voice/0.1.0 libp2p protocol.
//
// There is NO SFU: node.xorein.com is a relay/blob support service only. Voice is
// a peer-to-peer WebRTC MESH — each participant holds one RTCPeerConnection per
// other participant. Signaling is request/response over libp2p (via PeerSync):
//
//   voice.presence  newcomer → each member: "I joined channel X" → reply tells the
//                   newcomer whether the responder is also in X (+ their av state),
//                   so the newcomer knows whom to dial.
//   voice.offer     offerer → answerer: SDP offer (non-trickle, ICE embedded) →
//                   reply is the SDP answer. Also used for renegotiation
//                   (add/remove camera or screen tracks).
//   voice.leave     leaver → each member: tear down the peer connection.
//
// Media between two peers is end-to-end encrypted by WebRTC DTLS (no intermediary
// can read it). SFrame is layered on top as defense-in-depth when the browser
// supports Insertable Streams, but is NOT required to join (unlike the old SFU
// design, where SFrame was mandatory because the SFU forwarded frames).

import { supportNodeApiBase, supportNodeOrigin } from '../nodeOrigin.js';

export const VOICE_OPS = {
  presence: 'voice.presence',
  offer: 'voice.offer',
  ice: 'voice.ice',
  leave: 'voice.leave',
} as const;

/**
 * A single trickled ICE candidate, sent peer→peer as soon as it is gathered
 * (instead of waiting for the full gather to embed candidates in the SDP). The
 * receiver applies it once it has a remote description, buffering earlier ones.
 */
export interface VoiceIceRequest {
  session_id: string;
  from_peer_id: string;
  candidate: string;
  sdp_mid?: string | null;
  sdp_mline_index?: number | null;
}

export type VoicePresenceAction = 'join' | 'leave' | 'query';

export interface VoicePresenceRequest {
  session_id: string;
  action: VoicePresenceAction;
  // Self av-state advertised to the receiver.
  muted?: boolean;
  video?: boolean;
  screen_sharing?: boolean;
  display_name?: string;
  avatar?: string;
}

export interface VoicePresenceResponse {
  ok: boolean;
  // Whether the RESPONDER is currently in session_id.
  in_channel: boolean;
  muted?: boolean;
  video?: boolean;
  screen_sharing?: boolean;
  display_name?: string;
  avatar?: string;
}

export interface VoiceOfferRequest {
  session_id: string;
  from_peer_id: string;
  sdp: string;
  // mid → track kind, so the answerer can tell camera from screen-share.
  kinds?: Record<string, 'audio' | 'camera' | 'screen'>;
}

export interface VoiceOfferResponse {
  ok: boolean;
  sdp?: string;
  kinds?: Record<string, 'audio' | 'camera' | 'screen'>;
  error?: string;
}

/**
 * PRIVACY: every ICE server in the list receives STUN binding requests carrying the
 * user's real IP the moment a call starts — an ICE entry is a disclosure of "this
 * address is in a call right now" to whoever operates that server. The default
 * configuration therefore talks ONLY to the user's configured support node
 * (self-hosted nodes included via supportNodeOrigin()). A public Google STUN
 * fallback exists solely behind this explicit, default-OFF opt-in for users on
 * NATs their node's STUN cannot traverse, and is never shipped in the default list.
 */
export const PUBLIC_STUN_OPT_IN_KEY = 'harmolyn:voice:allow-public-stun';
const PUBLIC_STUN_URL = 'stun:stun.l.google.com:19302';

function optionalPublicStun(): RTCIceServer[] {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(PUBLIC_STUN_OPT_IN_KEY) === 'true') {
      return [{ urls: [PUBLIC_STUN_URL] }];
    }
  } catch { /* storage unavailable (workers/tests) — stay private */ }
  return [];
}

/**
 * Fetch short-lived TURN credentials from the support node (for NAT traversal
 * when a direct/relayed peer connection needs a TURN relay). Falls back to a
 * STUN-only configuration when the node serves no TURN credentials. Only the
 * configured support node appears in the ICE list unless the user explicitly
 * opted in to the public STUN fallback (see PUBLIC_STUN_OPT_IN_KEY above).
 */
export async function fetchTurnCredentials(): Promise<RTCIceServer[]> {
  try {
    const resp = await fetch(`${supportNodeApiBase()}/voice/turn-credentials`, { method: 'GET' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as { urls: string[]; username: string; credential: string };
    return [
      { urls: data.urls, username: data.username, credential: data.credential },
      ...optionalPublicStun(),
    ];
  } catch {
    // STUN-only fallback (node STUN). Works for most non-symmetric NATs.
    return [
      { urls: [`stun:${new URL(supportNodeOrigin()).hostname}:3479`] },
      ...optionalPublicStun(),
    ];
  }
}
