// XoreinTransportManager — RESILIENCE contract: the libp2p node is created ONCE
// and survives relay loss. Rebuilding the node per reconnect (the old behavior)
// killed every connection — including direct browser↔browser WebRTC links that
// don't depend on the relay — plus all inbound handlers and pooled streams.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createXoreinNode = vi.fn();
const reserveAnyRelay = vi.fn();
vi.mock('./node.js', () => ({
  createXoreinNode: (...args: unknown[]) => createXoreinNode(...args),
  circuitAddrs: () => [],
}));
vi.mock('./relays.js', () => ({
  resolveRelayList: () => ['/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay'],
  resolveRelayListAsync: async () => ['/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay'],
  reserveAnyRelay: (...args: unknown[]) => reserveAnyRelay(...args),
}));

import { XoreinTransportManager } from './manager';

function fakeNode() {
  const listeners = new Map<string, Array<(evt: CustomEvent) => void>>();
  return {
    stop: vi.fn(async () => {}),
    dial: vi.fn(async () => ({})),
    hangUp: vi.fn(async () => {}),
    getMultiaddrs: () => [],
    addEventListener(type: string, cb: (evt: CustomEvent) => void) {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
    emit(type: string, detail: unknown) {
      for (const cb of listeners.get(type) ?? []) cb({ detail } as CustomEvent);
    },
  };
}

describe('XoreinTransportManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createXoreinNode.mockReset();
    reserveAnyRelay.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('connects: creates the node once and reserves a relay', async () => {
    const node = fakeNode();
    createXoreinNode.mockResolvedValue(node);
    reserveAnyRelay.mockResolvedValue('/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay');

    const m = new XoreinTransportManager();
    await m.start();

    expect(m.connectionState).toBe('connected');
    expect(m.currentNode).toBe(node);
    expect(createXoreinNode).toHaveBeenCalledTimes(1);
  });

  it('keeps the node ALIVE when no relay answers (direct connections must survive)', async () => {
    const node = fakeNode();
    createXoreinNode.mockResolvedValue(node);
    reserveAnyRelay.mockResolvedValue(null);

    const m = new XoreinTransportManager();
    await m.start();

    expect(m.connectionState).toBe('disconnected');
    expect(node.stop).not.toHaveBeenCalled(); // the old behavior stopped it here
    expect(m.currentNode).toBe(node); // node stays available for direct P2P
  });

  it('relay drop: reconnects by RE-RESERVING on the SAME node, never rebuilding it', async () => {
    const node = fakeNode();
    createXoreinNode.mockResolvedValue(node);
    reserveAnyRelay.mockResolvedValue('/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay');

    const states: string[] = [];
    const m = new XoreinTransportManager({ onStateChange: s => states.push(s) });
    await m.start();
    expect(m.connectionState).toBe('connected');

    // Relay connection closes.
    node.emit('connection:close', { remotePeer: { toString: () => '12D3KooWRelay' } });
    expect(m.connectionState).toBe('disconnected');

    // Backoff fires → reconnect. Same node object, no stop, no re-create.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.connectionState).toBe('connected');
    expect(createXoreinNode).toHaveBeenCalledTimes(1);
    expect(node.stop).not.toHaveBeenCalled();
    expect(reserveAnyRelay.mock.calls.every(c => c[0] === node)).toBe(true);
  });

  it('ignores non-relay connection closes', async () => {
    const node = fakeNode();
    createXoreinNode.mockResolvedValue(node);
    reserveAnyRelay.mockResolvedValue('/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay');

    const m = new XoreinTransportManager();
    await m.start();
    node.emit('connection:close', { remotePeer: { toString: () => '12D3KooWSomePeer' } });
    expect(m.connectionState).toBe('connected');
  });

  it('re-reserves immediately on the selected node without rebuilding the peer node', async () => {
    const node = fakeNode();
    createXoreinNode.mockResolvedValue(node);
    reserveAnyRelay.mockResolvedValue('/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay');

    const m = new XoreinTransportManager();
    await m.start();
    await m.refreshSelectedNode();

    expect(reserveAnyRelay).toHaveBeenCalledTimes(2);
    expect(createXoreinNode).toHaveBeenCalledTimes(1);
    expect(node.stop).not.toHaveBeenCalled();
  });

  it('does not lose a node switch requested during an in-flight reconnect', async () => {
    const node = fakeNode();
    createXoreinNode.mockResolvedValue(node);
    let releaseFirst: (value: string) => void = () => {};
    reserveAnyRelay
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
      .mockResolvedValue('/dns4/relay-two.example/tcp/443/wss/p2p/12D3KooWRelayTwo');

    const m = new XoreinTransportManager();
    const starting = m.start();
    await vi.waitFor(() => expect(reserveAnyRelay).toHaveBeenCalledTimes(1));
    await m.refreshSelectedNode();
    releaseFirst('/dns4/relay-one.example/tcp/443/wss/p2p/12D3KooWRelayOne');
    await starting;
    await vi.waitFor(() => expect(reserveAnyRelay).toHaveBeenCalledTimes(2));

    expect(m.getActiveRelay()).toContain('RelayTwo');
    expect(createXoreinNode).toHaveBeenCalledTimes(1);
  });

  it('stop() stops the node and clears state', async () => {
    const node = fakeNode();
    createXoreinNode.mockResolvedValue(node);
    reserveAnyRelay.mockResolvedValue('/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay');

    const m = new XoreinTransportManager();
    await m.start();
    await m.stop();

    expect(node.stop).toHaveBeenCalledTimes(1);
    expect(m.currentNode).toBeNull();
    expect(m.connectionState).toBe('disconnected');
    expect(m.getActiveRelay()).toBeNull();
  });
});
