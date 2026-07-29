// WS-C: direct WebRTC transport addressing. Pure selection/synthesis logic — the
// hole-punch itself is a documented live smoketest (2 relays + real browsers).
import { describe, it, expect } from 'vitest';
import { selectPeerAddr, webrtcCircuitAddr } from './peersync';

const RELAY = '/dns4/node.xorein.com/tcp/9999/wss/p2p/12D3KooWRelay';
const PEER = '12D3KooWPeerAAAA';

describe('webrtcCircuitAddr', () => {
  it('synthesizes a WebRTC-upgradeable circuit address', () => {
    expect(webrtcCircuitAddr(PEER, RELAY)).toBe(`${RELAY}/p2p-circuit/webrtc/p2p/${PEER}`);
  });
});

describe('selectPeerAddr', () => {
  const plain = `${RELAY}/p2p-circuit/p2p/${PEER}`;
  const wrtc = `${RELAY}/p2p-circuit/webrtc/p2p/${PEER}`;

  it('prefers a /webrtc advertised address when direct transport is on', () => {
    expect(selectPeerAddr([plain, wrtc], PEER, RELAY, true)).toBe(wrtc);
  });

  it('ignores /webrtc and takes any circuit address when direct transport is off', () => {
    expect(selectPeerAddr([plain, wrtc], PEER, RELAY, false)).toBe(plain);
  });

  it('falls back to any advertised circuit address when no /webrtc is present', () => {
    expect(selectPeerAddr([plain], PEER, RELAY, true)).toBe(plain);
  });

  it('synthesizes a plain circuit fallback when nothing is advertised (direct off)', () => {
    expect(selectPeerAddr([], PEER, RELAY, false)).toBe(`${RELAY}/p2p-circuit/p2p/${PEER}`);
  });

  it('synthesizes a PLAIN circuit fallback even with direct on (never guess /webrtc support)', () => {
    // A peer that supports WebRTC advertises its /webrtc addr; a peer that does
    // not cannot answer a /webrtc dial AT ALL (no signaling handler), and the
    // dial fails with no retry. So the unknown-peer fallback must stay plain —
    // first contact with an older peer (invite join, friend request) depends on it.
    expect(selectPeerAddr([], PEER, RELAY, true)).toBe(`${RELAY}/p2p-circuit/p2p/${PEER}`);
  });
});
