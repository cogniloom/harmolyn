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
import { reportNodeRequestFailure, reportNodeRequestSuccess } from '../../lib/nodeHealth.js';

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
/** Never let an unavailable credential endpoint indefinitely stall voice setup. */
export const TURN_CREDENTIALS_TIMEOUT_MS = 5_000;

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
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller?.abort();
      reject(new Error('TURN credential request timed out.'));
    }, TURN_CREDENTIALS_TIMEOUT_MS);
  });

  try {
    const init: RequestInit = { method: 'GET' };
    if (controller) init.signal = controller.signal;
    // The deadline covers both connection establishment and an incomplete JSON
    // body. Some fetch implementations do not promptly honour abort(), so the
    // race itself is the hard bound that lets a watcher start signaling.
    const resp = await Promise.race([
      fetch(`${supportNodeApiBase()}/voice/turn-credentials`, init),
      deadline,
    ]);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await Promise.race([
      resp.json() as Promise<{ urls: string[]; username: string; credential: string }>,
      deadline,
    ]);
    reportNodeRequestSuccess();
    return [
      { urls: data.urls, username: data.username, credential: data.credential },
      ...optionalPublicStun(),
    ];
  } catch (error) {
    reportNodeRequestFailure(error);
    // STUN-only fallback (node STUN). Works for most non-symmetric NATs.
    return [
      // Xorein serves STUN and TURN on the same standard UDP listener. Keeping
      // the fallback on 3478 means a node configured with the turnkey default
      // works even when its credential endpoint is temporarily unavailable.
      { urls: [`stun:${new URL(supportNodeOrigin()).hostname}:3478`] },
      ...optionalPublicStun(),
    ];
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
