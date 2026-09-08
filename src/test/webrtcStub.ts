// Vitest stand-in for @libp2p/webrtc. Unit tests must not load the
// node-datachannel native addon; production still uses the real transport.
export function webRTC(): { tag: 'webrtc' } {
  return { tag: 'webrtc' };
}
