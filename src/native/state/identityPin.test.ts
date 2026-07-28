// Tier-0 A7: TOFU identity pinning + safety-number-changed detection.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initStore, getState, pinPeerIdentity, setPeerVerified, upsertPeer, setStateEncryptionKey } from './store';

const PEER = '12D3KooWPeer';

describe('pinPeerIdentity (TOFU)', () => {
  beforeEach(() => { localStorage.clear(); initStore(); });

  it('pins on first sighting without flagging a change', () => {
    pinPeerIdentity(PEER, 'KEY-A');
    const p = getState().peers[PEER];
    expect(p?.identity_key).toBe('KEY-A');
    expect(p?.identity_changed).toBeFalsy();
  });

  it('is a no-op when the same key is seen again', () => {
    pinPeerIdentity(PEER, 'KEY-A');
    setPeerVerified(PEER, true);
    pinPeerIdentity(PEER, 'KEY-A'); // same key — must not clear verification
    const p = getState().peers[PEER];
    expect(p?.identity_verified).toBe(true);
    expect(p?.identity_changed).toBeFalsy();
  });

  it('flags a change and clears verification when the key differs (relay swap / re-key)', () => {
    pinPeerIdentity(PEER, 'KEY-A');
    setPeerVerified(PEER, true);
    pinPeerIdentity(PEER, 'KEY-B'); // different key
    const p = getState().peers[PEER];
    expect(p?.identity_key).toBe('KEY-B');
    expect(p?.identity_changed).toBe(true);
    expect(p?.identity_verified).toBe(false);
  });

  it('re-verifying clears the changed flag', () => {
    pinPeerIdentity(PEER, 'KEY-A');
    pinPeerIdentity(PEER, 'KEY-B');
    expect(getState().peers[PEER]?.identity_changed).toBe(true);
    setPeerVerified(PEER, true);
    const p = getState().peers[PEER];
    expect(p?.identity_verified).toBe(true);
    expect(p?.identity_changed).toBe(false);
  });
});

describe('TOFU trust survives reload', () => {
  const KEY = new Uint8Array(32).fill(7);
  beforeEach(() => { localStorage.clear(); setStateEncryptionKey(KEY); initStore(); });
  afterEach(() => setStateEncryptionKey(null));

  it('preserves identity pin + verification across a reload, dropping stale addresses', () => {
    pinPeerIdentity(PEER, 'KEY-A');
    setPeerVerified(PEER, true);
    upsertPeer({ peer_id: PEER, role: 'peer', addresses: ['/dns4/relay/tcp/9/p2p-circuit/p2p/' + PEER] });

    // Simulate a reload: re-install the key and re-init from persisted storage.
    setStateEncryptionKey(KEY);
    initStore();

    const p = getState().peers[PEER];
    expect(p?.identity_key).toBe('KEY-A');
    expect(p?.identity_verified).toBe(true);   // verification is NOT lost on reload
    expect(p?.addresses ?? []).toEqual([]);    // transient reachability is dropped
  });

  it('carries a changed-identity warning across a reload', () => {
    pinPeerIdentity(PEER, 'KEY-A');
    pinPeerIdentity(PEER, 'KEY-B'); // re-key → identity_changed
    setStateEncryptionKey(KEY);
    initStore();
    expect(getState().peers[PEER]?.identity_changed).toBe(true);
  });
});
