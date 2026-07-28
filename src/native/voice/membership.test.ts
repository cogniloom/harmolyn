// Round-7 P1: a voice session must reject signaling from peers who are not current members
// of the channel's server, so a kicked member can't recreate a connection (and, on a
// DTLS-only fallback, receive unwrapped media) after the epoch rekey tore it down.
import { describe, it, expect, beforeEach } from 'vitest';
import { initStore, addServer, setNativeIdentity } from '../state/store.js';
import { VoiceSession } from './session.js';
import type { VoiceIceRequest } from './signaling.js';

const ME = 'me';
const ALICE = 'alice';
const KICKED = 'kicked';
const SRV = 'srv';
const CHAN = 'voiceChan';

const ice = (from: string): VoiceIceRequest => ({ session_id: CHAN, from_peer_id: from, candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host' });

describe('voice signaling membership gate', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    addServer({ id: SRV, name: 'S', owner_peer_id: ME, members: [ME, ALICE],
      channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'voice', voice: true } } });
  });

  it('accepts ICE from a current member but rejects a non-member (kicked) peer', () => {
    const session = new VoiceSession(CHAN, null, ME, {});
    // A current member's candidate is accepted (buffered pre-offer).
    expect(session.handleIce(ice(ALICE), ALICE).ok).toBe(true);
    // A peer not in server.members is rejected outright.
    expect(session.handleIce(ice(KICKED), KICKED).ok).toBe(false);
  });

  it('rejects an offer and a presence-join from a non-member', async () => {
    const session = new VoiceSession(CHAN, null, ME, {});
    const offer = await session.handleOffer({ session_id: CHAN, from_peer_id: KICKED, sdp: 'v=0' }, KICKED);
    expect(offer.ok).toBe(false);
    const presence = session.handlePresence({ session_id: CHAN, action: 'join', from_peer_id: KICKED }, KICKED);
    expect(presence.ok).toBe(false);
  });

  it('does not gate an ad-hoc/DM voice channel that has no owning server', () => {
    const session = new VoiceSession('dm-voice', null, ME, {});
    // No server owns 'dm-voice' → no roster → any authenticated peer may signal.
    expect(session.handleIce(ice(KICKED), KICKED).ok).toBe(true);
  });
});
