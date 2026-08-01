import { describe, it, expect, afterEach, vi } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import {
  resolveRelayList, RELAY_OVERRIDE_KEY,
  addRelayOverride, getRelayOverrides, removeRelayOverride,
} from './relays.js';
import {
  circuitAddrsForRelay,
  isTrustedRelayMultiaddr,
  RELAY_MULTIADDR,
  RELAY_PEER_ID,
  reserveCircuitRelay,
  type Libp2p,
} from './node.js';

describe('resolveRelayList (multi-relay config + failover order)', () => {
  afterEach(() => {
    try { window.localStorage.removeItem(RELAY_OVERRIDE_KEY); } catch { /* noop */ }
  });

  it('defaults to just the built-in relay with no configuration', () => {
    expect(resolveRelayList()).toEqual([RELAY_MULTIADDR]);
  });

  it('puts an explicit relay first, then the built-in fallback', () => {
    const list = resolveRelayList('/dns4/local/tcp/1/wss/p2p/Qm');
    expect(list[0]).toBe('/dns4/local/tcp/1/wss/p2p/Qm');
    expect(list).toContain(RELAY_MULTIADDR);
  });

  it('includes localStorage override relays in order, before the fallback', () => {
    window.localStorage.setItem(RELAY_OVERRIDE_KEY, JSON.stringify([
      '/dns4/relay-a/tcp/9999/wss/p2p/QmA',
      '/dns4/relay-b/tcp/9999/wss/p2p/QmB',
    ]));
    const list = resolveRelayList();
    expect(list.slice(0, 2)).toEqual([
      '/dns4/relay-a/tcp/9999/wss/p2p/QmA',
      '/dns4/relay-b/tcp/9999/wss/p2p/QmB',
    ]);
    expect(list[list.length - 1]).toBe(RELAY_MULTIADDR);
  });

  it('de-duplicates while preserving order', () => {
    window.localStorage.setItem(RELAY_OVERRIDE_KEY, JSON.stringify([RELAY_MULTIADDR, RELAY_MULTIADDR]));
    expect(resolveRelayList()).toEqual([RELAY_MULTIADDR]);
  });

  it('ignores a malformed override and still yields the fallback', () => {
    window.localStorage.setItem(RELAY_OVERRIDE_KEY, '{not json');
    expect(resolveRelayList()).toEqual([RELAY_MULTIADDR]);
  });
});

describe('relay overrides (user-configured backup relays)', () => {
  afterEach(() => {
    try { window.localStorage.removeItem(RELAY_OVERRIDE_KEY); } catch { /* noop */ }
  });

  it('add/get/remove round-trips, de-dups, and feeds the failover list', () => {
    addRelayOverride('/dns4/r1/tcp/1/wss/p2p/Qm1');
    addRelayOverride('/dns4/r1/tcp/1/wss/p2p/Qm1'); // duplicate ignored
    addRelayOverride('/dns4/r2/tcp/1/wss/p2p/Qm2');
    expect(getRelayOverrides()).toEqual(['/dns4/r1/tcp/1/wss/p2p/Qm1', '/dns4/r2/tcp/1/wss/p2p/Qm2']);

    // The resolved failover list surfaces user relays before the built-in fallback.
    expect(resolveRelayList().slice(0, 2)).toEqual(['/dns4/r1/tcp/1/wss/p2p/Qm1', '/dns4/r2/tcp/1/wss/p2p/Qm2']);
    expect(resolveRelayList()[resolveRelayList().length - 1]).toBe(RELAY_MULTIADDR);

    removeRelayOverride('/dns4/r1/tcp/1/wss/p2p/Qm1');
    expect(getRelayOverrides()).toEqual(['/dns4/r2/tcp/1/wss/p2p/Qm2']);
  });
});

describe('LAN relay addresses', () => {
  it('accepts Noise-pinned ws on private LANs but not plaintext public ws', () => {
    expect(isTrustedRelayMultiaddr(
      '/ip4/192.168.0.20/tcp/9999/ws/p2p/QmLan',
    )).toBe(true);
    expect(isTrustedRelayMultiaddr(
      '/ip4/8.8.8.8/tcp/9999/ws/p2p/QmPublic',
    )).toBe(false);
  });

  it('does not mistake a stale circuit address for a replacement relay', () => {
    const relayA = '/ip4/127.0.0.1/tcp/19999/ws/p2p/QmRelayA';
    const relayB = '/ip4/127.0.0.1/tcp/29999/ws/p2p/QmRelayB';
    const node = {
      getMultiaddrs: () => [
        { toString: () => `${relayA}/p2p-circuit/p2p/QmBrowser` },
      ],
    };

    expect(circuitAddrsForRelay(node, relayA)).toHaveLength(1);
    expect(circuitAddrsForRelay(node, relayB)).toEqual([]);
  });

  it('rebuilds a stale CircuitSearch slot without restarting the peer node', async () => {
    const staleRelay =
      '/ip4/127.0.0.1/tcp/19999/ws/p2p/12D3KooWDsujzQH69Gq2LQb1gHMUCbDaJVACYmoVymK9dej5zh4T';
    const replacementRelay = `/ip4/127.0.0.1/tcp/29999/ws/p2p/${RELAY_PEER_ID}`;
    let replacementAdvertised = false;
    const enough = new Error('stale discovered reservation');
    enough.name = 'HadEnoughRelaysError';
    const reservationStore = {
      addRelay: vi.fn()
        .mockRejectedValueOnce(enough)
        .mockImplementationOnce(async () => { replacementAdvertised = true; }),
      removeEventListener: vi.fn(),
    };
    const listener = {
      reservationStore,
      getAddrs: () => [multiaddr(`${staleRelay}/p2p-circuit`)],
      close: vi.fn(async () => {}),
      _onAddRelayPeer: vi.fn(),
    };
    const transportManager = {
      getTransports: () => [{
        [Symbol.toStringTag]: '@libp2p/circuit-relay-v2-transport',
        reservationStore,
      }],
      getListeners: () => [listener],
      listen: vi.fn(async () => {}),
    };
    const removeObservedAddr = vi.fn();
    const node = {
      dial: vi.fn(async () => ({
        remotePeer: { toString: () => RELAY_PEER_ID },
      })),
      getMultiaddrs: () => [{
        toString: () => replacementAdvertised
          ? `${replacementRelay}/p2p-circuit/p2p/QmBrowser`
          : `${staleRelay}/p2p-circuit/p2p/QmBrowser`,
      }],
      components: {
        transportManager,
        addressManager: { removeObservedAddr },
      },
    };

    await expect(reserveCircuitRelay(node as unknown as Libp2p, replacementRelay))
      .resolves.toBe(true);
    expect(listener.close).toHaveBeenCalledOnce();
    expect(removeObservedAddr).toHaveBeenCalledOnce();
    expect(transportManager.listen).toHaveBeenCalledWith([multiaddr('/p2p-circuit')]);
    expect(reservationStore.addRelay).toHaveBeenCalledTimes(2);
  });
});
