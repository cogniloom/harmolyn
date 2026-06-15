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

export const VOICE_OPS = {
  presence: 'voice.presence',
  offer: 'voice.offer',
  leave: 'voice.leave',
} as const;

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
 * Fetch short-lived TURN credentials from the support node (for NAT traversal
 * when a direct/relayed peer connection needs a TURN relay). Falls back to a
 * STUN-only configuration when the node serves no TURN credentials.
 */
export async function fetchTurnCredentials(): Promise<RTCIceServer[]> {
  try {
    const resp = await fetch('https://node.xorein.com/v1/voice/turn-credentials', { method: 'GET' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as { urls: string[]; username: string; credential: string };
    return [
      { urls: data.urls, username: data.username, credential: data.credential },
      { urls: ['stun:stun.l.google.com:19302'] },
    ];
  } catch {
    // STUN-only fallback (public + node STUN). Works for most non-symmetric NATs.
    return [
      { urls: ['stun:node.xorein.com:3479'] },
      { urls: ['stun:stun.l.google.com:19302'] },
    ];
  }
}
