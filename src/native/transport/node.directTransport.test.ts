// WS-C: verify the directTransport flag adds the WebRTC transport + DCUtR service
// + /webrtc circuit listener to the node config, and adds nothing when off. We mock
// createLibp2p to capture the config it is built with (no real node is started).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const captured: { config?: Record<string, unknown> } = {};

vi.mock('libp2p', () => ({
  createLibp2p: vi.fn(async (config: Record<string, unknown>) => {
    captured.config = config;
    return { start: vi.fn(), getMultiaddrs: () => [] };
  }),
}));
// Tag each transport/service factory so we can assert presence by identity.
vi.mock('@libp2p/websockets', () => ({ webSockets: () => ({ tag: 'ws' }) }));
vi.mock('@libp2p/webtransport', () => ({ webTransport: () => ({ tag: 'wt' }) }));
vi.mock('@libp2p/webrtc', () => ({ webRTC: () => ({ tag: 'webrtc' }) }));
vi.mock('@libp2p/circuit-relay-v2', () => ({ circuitRelayTransport: () => ({ tag: 'circuit' }) }));
vi.mock('@libp2p/dcutr', () => ({ dcutr: () => ({ tag: 'dcutr' }) }));
vi.mock('@chainsafe/libp2p-noise', () => ({ noise: () => ({ tag: 'noise' }) }));
vi.mock('@chainsafe/libp2p-yamux', () => ({ yamux: () => ({ tag: 'yamux' }) }));
vi.mock('@libp2p/identify', () => ({ identify: () => ({ tag: 'identify' }) }));
vi.mock('@libp2p/ping', () => ({ ping: () => ({ tag: 'ping' }) }));

import { createXoreinNode } from './node';
import { FEATURE_OVERRIDES_STORAGE_KEY } from '../../config/featureFlags';

const transportTags = (config: Record<string, unknown>) =>
  (config.transports as Array<{ tag: string }>).map(t => t.tag);
const listen = (config: Record<string, unknown>) =>
  (config.addresses as { listen: string[] }).listen;
const services = (config: Record<string, unknown>) =>
  Object.keys(config.services as Record<string, unknown>);

describe('createXoreinNode — directTransport flag', () => {
  beforeEach(() => { captured.config = undefined; localStorage.clear(); });
  afterEach(() => localStorage.clear());

  it('omits WebRTC + DCUtR + /webrtc listen when the flag is off (default)', async () => {
    await createXoreinNode();
    const cfg = captured.config!;
    expect(transportTags(cfg)).not.toContain('webrtc');
    expect(services(cfg)).not.toContain('dcutr');
    expect(listen(cfg)).toEqual(['/p2p-circuit']);
    // The relayed path is intact.
    expect(transportTags(cfg)).toEqual(expect.arrayContaining(['ws', 'wt', 'circuit']));
  });

  it('adds WebRTC transport, DCUtR service, and /webrtc listen when the flag is on', async () => {
    localStorage.setItem(FEATURE_OVERRIDES_STORAGE_KEY, JSON.stringify({ directTransport: true }));
    await createXoreinNode();
    const cfg = captured.config!;
    expect(transportTags(cfg)).toContain('webrtc');
    expect(services(cfg)).toContain('dcutr');
    expect(listen(cfg)).toEqual(['/p2p-circuit', '/p2p-circuit/webrtc']);
    // The relayed transports are still present (additive, not replacing).
    expect(transportTags(cfg)).toEqual(expect.arrayContaining(['ws', 'wt', 'circuit', 'webrtc']));
  });
});
