// Tier-0 A7: TOFU identity pinning + safety-number-changed detection.
import { describe, it, expect, beforeEach } from 'vitest';
import { initStore, getState, pinPeerIdentity, setPeerVerified } from './store';

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
