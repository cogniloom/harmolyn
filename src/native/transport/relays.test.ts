import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveRelayList, RELAY_OVERRIDE_KEY,
  addRelayOverride, getRelayOverrides, removeRelayOverride,
} from './relays.js';
import { RELAY_MULTIADDR } from './node.js';

describe('resolveRelayList (multi-relay config + failover order)', () => {
  afterEach(() => {
    try { window.localStorage.removeItem(RELAY_OVERRIDE_KEY); } catch { /* noop */ }
  });

  it('defaults to just the built-in relay with no configuration', () => {
    expect(resolveRelayList()).toEqual([RELAY_MULTIADDR]);
  });

  it('puts an explicit relay first, then the built-in fallback', () => {
    const list = resolveRelayList('/dns4/local/tcp/1/ws/p2p/Qm');
    expect(list[0]).toBe('/dns4/local/tcp/1/ws/p2p/Qm');
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
    addRelayOverride('/dns4/r1/tcp/1/ws/p2p/Qm1');
    addRelayOverride('/dns4/r1/tcp/1/ws/p2p/Qm1'); // duplicate ignored
    addRelayOverride('/dns4/r2/tcp/1/ws/p2p/Qm2');
    expect(getRelayOverrides()).toEqual(['/dns4/r1/tcp/1/ws/p2p/Qm1', '/dns4/r2/tcp/1/ws/p2p/Qm2']);

    // The resolved failover list surfaces user relays before the built-in fallback.
    expect(resolveRelayList().slice(0, 2)).toEqual(['/dns4/r1/tcp/1/ws/p2p/Qm1', '/dns4/r2/tcp/1/ws/p2p/Qm2']);
    expect(resolveRelayList()[resolveRelayList().length - 1]).toBe(RELAY_MULTIADDR);

    removeRelayOverride('/dns4/r1/tcp/1/ws/p2p/Qm1');
    expect(getRelayOverrides()).toEqual(['/dns4/r2/tcp/1/ws/p2p/Qm2']);
  });
});
