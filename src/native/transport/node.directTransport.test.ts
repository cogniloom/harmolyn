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

import {
  createXoreinNode,
  isAllowedDialMultiaddr,
  isSafeRemoteRelayMultiaddr,
  RELAY_MULTIADDR,
} from './node';
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

  it('omits WebRTC + DCUtR + /webrtc listen when the flag is overridden off', async () => {
    localStorage.setItem(FEATURE_OVERRIDES_STORAGE_KEY, JSON.stringify({ directTransport: false }));
    await createXoreinNode();
    const cfg = captured.config!;
    expect(transportTags(cfg)).not.toContain('webrtc');
    expect(services(cfg)).not.toContain('dcutr');
    expect(listen(cfg)).toEqual(['/p2p-circuit']);
    // The relayed path is intact.
    expect(transportTags(cfg)).toEqual(expect.arrayContaining(['ws', 'wt', 'circuit']));
  });

  it('adds WebRTC transport, DCUtR service, and /webrtc listen by default (directTransport ships ON)', async () => {
    await createXoreinNode();
    const cfg = captured.config!;
    expect(transportTags(cfg)).toContain('webrtc');
    expect(services(cfg)).toContain('dcutr');
    expect(listen(cfg)).toEqual(['/p2p-circuit', '/p2p-circuit/webrtc']);
    // The relayed transports are still present (additive, not replacing).
    expect(transportTags(cfg)).toEqual(expect.arrayContaining(['ws', 'wt', 'circuit', 'webrtc']));
  });
});

describe('outbound dial gate', () => {
  const peer = '12D3KooWNNQp1tmRbcLMrqS866jRJbzoPF6sNEZRoPEVdVwLqTv6';
  const otherRelay = '/dns4/relay-two.example/tcp/443/wss/p2p/12D3KooWDsujzQH69Gq2LQb1gHMUCbDaJVACYmoVymK9dej5zh4T';
  const crossRelayCircuit = `${otherRelay}/p2p-circuit/p2p/${peer}`;

  it('allows an exact peer-bound cross-relay address only after validation added it', () => {
    expect(isAllowedDialMultiaddr(
      crossRelayCircuit,
      new Set([crossRelayCircuit]),
      new Set([RELAY_MULTIADDR]),
      new Set(),
      true,
    )).toBe(true);
    expect(isAllowedDialMultiaddr(
      crossRelayCircuit,
      new Set(),
      new Set([RELAY_MULTIADDR]),
      new Set(),
      true,
    )).toBe(false);
  });

  it('allows only WebRTC-derived direct dials to a peer authenticated this session', () => {
    const direct = `/ip4/127.0.0.1/udp/1234/webrtc-direct/p2p/${peer}`;
    expect(isAllowedDialMultiaddr(direct, new Set(), new Set(), new Set([peer]), true)).toBe(true);
    expect(isAllowedDialMultiaddr(direct, new Set(), new Set(), new Set(), true)).toBe(false);
    expect(isAllowedDialMultiaddr(direct, new Set(), new Set(), new Set([peer]), false)).toBe(false);
  });
});

describe('remote PEX host policy', () => {
  const peer = '12D3KooWNNQp1tmRbcLMrqS866jRJbzoPF6sNEZRoPEVdVwLqTv6';

  it('allows only literal globally routable addresses for automatic probes', () => {
    expect(isSafeRemoteRelayMultiaddr(`/ip4/8.8.8.8/tcp/443/wss/p2p/${peer}`, peer)).toBe(true);
    expect(isSafeRemoteRelayMultiaddr(`/ip6/2606:4700:4700::1111/tcp/443/wss/p2p/${peer}`, peer)).toBe(true);
    expect(isSafeRemoteRelayMultiaddr(`/ip4/192.168.1.1/tcp/443/wss/p2p/${peer}`, peer)).toBe(false);
    expect(isSafeRemoteRelayMultiaddr(`/ip4/100.64.1.1/tcp/443/wss/p2p/${peer}`, peer)).toBe(false);
    expect(isSafeRemoteRelayMultiaddr(`/ip6/fd00::1/tcp/443/wss/p2p/${peer}`, peer)).toBe(false);
    expect(isSafeRemoteRelayMultiaddr(`/dns4/relay.example/tcp/443/wss/p2p/${peer}`, peer)).toBe(false);
  });

  it('allows private discovery only from the same explicitly reached local scope', () => {
    const sourcePeer = RELAY_MULTIADDR.split('/').at(-1)!;
    const loopbackSource = `/ip4/127.0.0.1/tcp/9999/ws/p2p/${sourcePeer}`;
    const publicSource = `/ip4/8.8.8.8/tcp/443/wss/p2p/${sourcePeer}`;
    expect(isSafeRemoteRelayMultiaddr(
      `/ip4/127.0.0.1/tcp/19999/ws/p2p/${peer}`,
      peer,
      loopbackSource,
    )).toBe(true);
    expect(isSafeRemoteRelayMultiaddr(
      `/ip4/192.168.7.20/tcp/19999/ws/p2p/${peer}`,
      peer,
      `/ip4/192.168.7.10/tcp/9999/ws/p2p/${sourcePeer}`,
    )).toBe(true);
    expect(isSafeRemoteRelayMultiaddr(
      `/ip4/192.168.8.20/tcp/19999/ws/p2p/${peer}`,
      peer,
      `/ip4/192.168.7.10/tcp/9999/ws/p2p/${sourcePeer}`,
    )).toBe(false);
    expect(isSafeRemoteRelayMultiaddr(
      `/ip4/127.0.0.1/tcp/19999/ws/p2p/${peer}`,
      peer,
      publicSource,
    )).toBe(false);
  });
});
