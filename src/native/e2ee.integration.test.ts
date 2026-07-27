// Hermetic two-peer E2EE integration test — the biggest prior coverage hole.
//
// Two INDEPENDENT identities exchange a real Seal DM and a real Crowd channel
// message through the actual encrypt → wire → decrypt path (secureEnvelope), with
// NO fetchBundle stub (the initiator fetches the responder's real signed bundle).
// Proves: (1) the wire carries only ciphertext, and (2) the other identity recovers
// the plaintext under the correct mode. The secureEnvelope `_crypto` singleton is
// re-registered per side, mirroring how the live engine has one crypto context per
// peer — encrypt runs as the sender, decrypt as the receiver.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SealSessions } from './seal/session.js';
import { ChannelCrypto } from './crowd/channel.js';
import { generateSigningIdentity } from './crypto/hybrid.js';
import {
  registerScopeCrypto, resetScopeCrypto,
  encryptDmEnvelope, encryptChannelEnvelope, decryptInboundEnvelope,
} from './sync/secureEnvelope.js';
import { initStore, setNativeIdentity, addServer, updateServer } from './state/store.js';

const ALICE = 'alice-peer';
const BOB = 'bob-peer';

function freshRootB64(): string {
  const r = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < r.length; i++) s += String.fromCharCode(r[i]);
  return btoa(s);
}

describe('two-peer E2EE integration (no mocks)', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
  });
  afterEach(() => resetScopeCrypto());

  it('Seal DM: alice → bob, ciphertext on the wire, bob recovers plaintext', async () => {
    const alice = new SealSessions(ALICE, generateSigningIdentity());
    const bob = new SealSessions(BOB, generateSigningIdentity());
    const secret = 'the eagle lands at midnight';

    // Alice encrypts to Bob, fetching BOB'S REAL bundle (not a stub key).
    registerScopeCrypto({ seal: alice, channels: new ChannelCrypto(), fetchBundle: async (pid) => (pid === BOB ? bob.serveBundle() : null) });
    const base = { message_id: 'm1', scope_id: 'dm-1', scope_type: 'dm', sender_id: ALICE };
    const envelope = await encryptDmEnvelope(BOB, base, secret);
    expect(envelope).toBeTruthy();
    expect(JSON.stringify(envelope)).not.toContain(secret); // wire is ciphertext

    // Bob (the other identity) decrypts.
    registerScopeCrypto({ seal: bob, channels: new ChannelCrypto(), fetchBundle: async () => null });
    const decoded = decryptInboundEnvelope('seal', envelope!, ALICE, 'dm-1', 'dm');
    expect(decoded).toBeTruthy();
    expect(decoded!.body).toBe(secret);
    expect(decoded!.mode).toBe('seal');
  });

  it('Crowd channel: alice → bob under a shared root, ciphertext on the wire', () => {
    // Shared server record (both members hold the same crowd_root in the store).
    const SRV = 'srv1';
    const CHAN = 'chan1';
    setNativeIdentity({ id: ALICE, peer_id: ALICE });
    addServer({ id: SRV, name: 'S', owner_peer_id: ALICE, members: [ALICE, BOB], channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } } });
    updateServer(SRV, { crowd_root: freshRootB64(), crowd_epoch: 0 });
    const secret = 'channel broadcast payload';

    // Alice encrypts; her ChannelCrypto seeds from the shared root.
    registerScopeCrypto({ seal: new SealSessions(ALICE, generateSigningIdentity()), channels: new ChannelCrypto(), fetchBundle: async () => null });
    const base = { message_id: 'm2', scope_id: CHAN, scope_type: 'channel', server_id: SRV, sender_id: ALICE };
    const envelope = encryptChannelEnvelope(SRV, ALICE, base, secret);
    expect(envelope).toBeTruthy();
    expect(JSON.stringify(envelope)).not.toContain(secret);

    // Bob, a distinct ChannelCrypto seeded from the SAME root, decrypts.
    registerScopeCrypto({ seal: new SealSessions(BOB, generateSigningIdentity()), channels: new ChannelCrypto(), fetchBundle: async () => null });
    const decoded = decryptInboundEnvelope('crowd', envelope!, ALICE, CHAN, 'channel');
    expect(decoded).toBeTruthy();
    expect(decoded!.body).toBe(secret);
    expect(decoded!.mode).toBe('crowd');
    // (Crowd rotation revocation across epochs is proven in crowd/rotation.test.ts.)
  });
});
