// Verifies the Seal/Crowd session layer that actually carries traffic on the
// live data path: real ciphertext round-trips, plaintext never appears on the
// wire, and tampering / wrong-peer is rejected.
import { describe, it, expect } from 'vitest';
import { SealSessions, type FetchBundle, type SerializedSealState } from './session.js';
import { ChannelCrypto } from '../crowd/channel.js';
import { generateSigningIdentity, type HybridSigningKey } from '../crypto/hybrid.js';
import { identityKeyBlob } from '../identity/safetyNumber.js';
import { buildBundle } from './bundle.js';

function mkSigning(): HybridSigningKey {
  return generateSigningIdentity();
}

function b64bytes(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

describe('SealSessions (1:1 DM E2EE)', () => {
  it('establishes a session and round-trips a DM in both directions', async () => {
    const aliceKey = mkSigning();
    const bobKey = mkSigning();
    const alice = new SealSessions('alice', aliceKey);
    const bob = new SealSessions('bob', bobKey);

    // Transport stub: fetching bob's bundle returns bob's served bundle.
    const fetchBundle: FetchBundle = async (peerId) =>
      peerId === 'bob' ? bob.serveBundle() : null;

    const plaintext = 'attack at dawn 🌅';
    const wire = await alice.encrypt('bob', new TextEncoder().encode(plaintext), fetchBundle);

    // The wire MUST NOT contain the plaintext anywhere.
    const wireStr = JSON.stringify(wire);
    expect(wireStr).not.toContain('attack at dawn');
    expect(wire.im).toBeDefined(); // first message carries the X3DH bootstrap

    // Bob decrypts (peerId = alice, the authenticated connection peer).
    const got = bob.decrypt('alice', wire);
    expect(new TextDecoder().decode(got)).toBe(plaintext);

    // Bob replies — session now established both ways.
    const reply = 'hold the line';
    const wire2 = await bob.encrypt('alice', new TextEncoder().encode(reply), async () => alice.serveBundle());
    expect(JSON.stringify(wire2)).not.toContain(reply);
    expect(new TextDecoder().decode(alice.decrypt('bob', wire2))).toBe(reply);
  });

  it('ratchets across multiple messages without an im after the first', async () => {
    const a = new SealSessions('a', mkSigning());
    const b = new SealSessions('b', mkSigning());
    const fetch: FetchBundle = async () => b.serveBundle();

    const w1 = await a.encrypt('b', new TextEncoder().encode('m1'), fetch);
    const w2 = await a.encrypt('b', new TextEncoder().encode('m2'), fetch);
    expect(w1.im).toBeDefined();
    expect(w2.im).toBeUndefined(); // session already established
    expect(new TextDecoder().decode(b.decrypt('a', w1))).toBe('m1');
    expect(new TextDecoder().decode(b.decrypt('a', w2))).toBe('m2');
  });

  it('fails closed when no session and no bootstrap im is present', () => {
    const b = new SealSessions('b', mkSigning());
    expect(() => b.decrypt('a', { ik: 'AAAA', header: 'AAAA', ct: 'AAAA' })).toThrow();
  });

  it('rejects a tampered ciphertext (AEAD auth)', async () => {
    const a = new SealSessions('a', mkSigning());
    const b = new SealSessions('b', mkSigning());
    const wire = await a.encrypt('b', new TextEncoder().encode('secret'), async () => b.serveBundle());
    const tampered = { ...wire, ct: btoa('x'.repeat(atob(wire.ct).length)) };
    expect(() => b.decrypt('a', tampered)).toThrow();
  });

  it('does not poison the session or burn an OPK when a first init fails to authenticate', async () => {
    const bob = new SealSessions('bob', mkSigning());
    const aliceKey = mkSigning();

    // A first-contact init whose ciphertext is garbage: X3DH still derives the ratchet,
    // but AEAD auth fails. The failed attempt must NOT commit a session or consume the OPK.
    const alice1 = new SealSessions('alice', aliceKey);
    const w1 = await alice1.encrypt('bob', new TextEncoder().encode('m1'), async () => bob.serveBundle());
    const wBad = { ...w1, ct: btoa('x'.repeat(atob(w1.ct).length)) };
    expect(() => bob.decrypt('alice', wBad)).toThrow();

    // A fresh valid first message from the same identity must still establish + decrypt —
    // previously the poisoned session made this fail (bob would skip X3DH and mis-decrypt).
    const alice2 = new SealSessions('alice', aliceKey);
    const w2 = await alice2.encrypt('bob', new TextEncoder().encode('m2'), async () => bob.serveBundle());
    expect(new TextDecoder().decode(bob.decrypt('alice', w2))).toBe('m2');
  });

  it('retains the rotated bundle so a concurrent first-contact under the OLD bundle still decrypts', async () => {
    const bobKey = mkSigning();
    // Bob starts with just OPK_LOW_WATERMARK+1 (6) one-time prekeys, so the FIRST accepted
    // handshake drops the count to 5 (≤ watermark) and triggers a bundle rotation.
    const built = buildBundle('bob', bobKey, 6);
    const oldBundle = built.bundle; // what both initiators fetch (before the rotation)
    const bob = new SealSessions('bob', bobKey, {
      persisted: {
        bundle: built.bundle,
        priv: { spkPriv: b64bytes(built.priv.spkPriv), opkPrivs: built.priv.opkPrivs.map(b64bytes), mlkemSk: b64bytes(built.priv.mlkemSk) },
        sessions: [],
        consumedOpks: [],
      },
    });

    // Initiator 1 fetches the old bundle and handshakes — this consumes an OPK and rotates.
    const alice1 = new SealSessions('alice1', mkSigning());
    const w1 = await alice1.encrypt('bob', new TextEncoder().encode('one'), async () => oldBundle);
    expect(new TextDecoder().decode(bob.decrypt('alice1', w1))).toBe('one');

    // Initiator 2 also fetched the OLD (now-rotated-away) bundle. Its init references the old
    // SPK/OPK/ML-KEM key; without retention bob would derive the wrong secret and fail. With
    // the retained bundle it still decrypts. (alice1's consumed OPK is zeroed in the shared
    // bundle, so alice2 deterministically picks a different, still-available OPK.)
    const alice2 = new SealSessions('alice2', mkSigning());
    const w2 = await alice2.encrypt('bob', new TextEncoder().encode('two'), async () => oldBundle);
    expect(new TextDecoder().decode(bob.decrypt('alice2', w2))).toBe('two');
  });

  it('pins the initiator hybrid identity on an inbound first-contact DM (responder TOFU)', async () => {
    const pinned: Array<[string, string]> = [];
    const bob = new SealSessions('bob', mkSigning(), { onPeerIdentity: (p, blob) => pinned.push([p, blob]) });
    const aliceKey = mkSigning();
    const alice = new SealSessions('alice', aliceKey);

    const w = await alice.encrypt('bob', new TextEncoder().encode('hi'), async () => bob.serveBundle());
    bob.decrypt('alice', w);

    expect(pinned).toHaveLength(1);
    expect(pinned[0][0]).toBe('alice');
    // The responder pins the SAME hybrid blob the encrypt side would derive for alice, so
    // both directions compute an identical safety number.
    expect(pinned[0][1]).toBe(identityKeyBlob(aliceKey.edPublic, aliceKey.mldsaPublic));
  });

  it('throws (no plaintext fallback) when a peer bundle cannot be fetched', async () => {
    const a = new SealSessions('a', mkSigning());
    await expect(
      a.encrypt('ghost', new TextEncoder().encode('hi'), async () => null),
    ).rejects.toThrow();
  });

  it('persists and restores sessions so a reloaded receiver keeps decrypting', async () => {
    const aKey = mkSigning();
    const bKey = mkSigning();
    const a = new SealSessions('a', aKey);
    let bState: SerializedSealState | undefined;
    const b = new SealSessions('b', bKey, { onChange: (s) => { bState = s; } });

    const enc = (s: string) => new TextEncoder().encode(s);
    const dec = (u: Uint8Array) => new TextDecoder().decode(u);

    const w1 = await a.encrypt('b', enc('m1'), async () => b.serveBundle());
    expect(dec(b.decrypt('a', w1))).toBe('m1');
    expect(bState).toBeDefined();

    // Simulate B reloading: reconstruct purely from the persisted (serialized) state.
    const bReloaded = new SealSessions('b', bKey, { persisted: bState });

    // A sends a SECOND message — no X3DH im, relies on the existing ratchet.
    const w2 = await a.encrypt('b', enc('m2'), async () => b.serveBundle());
    expect(w2.im).toBeUndefined();
    expect(dec(bReloaded.decrypt('a', w2))).toBe('m2');
  });
});

describe('ChannelCrypto (Crowd broadcast E2EE)', () => {
  it('round-trips a channel message between members sharing the same root', () => {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const owner = new ChannelCrypto();
    const member = new ChannelCrypto();
    owner.setRoot('srv-1', root);
    member.setRoot('srv-1', root);

    const wire = owner.encrypt('srv-1', 'owner-peer', new TextEncoder().encode('hello channel'));
    expect(JSON.stringify(wire)).not.toContain('hello channel');
    expect(new TextDecoder().decode(member.decrypt('srv-1', wire))).toBe('hello channel');
  });

  it('a member without the shared root cannot decrypt', () => {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const owner = new ChannelCrypto();
    const outsider = new ChannelCrypto();
    owner.setRoot('srv-1', root);
    outsider.setRoot('srv-1', crypto.getRandomValues(new Uint8Array(32))); // wrong root
    const wire = owner.encrypt('srv-1', 'owner-peer', new TextEncoder().encode('members only'));
    expect(() => outsider.decrypt('srv-1', wire)).toThrow();
  });

  it('throws when encrypting with no root seeded (no plaintext fallback)', () => {
    const c = new ChannelCrypto();
    expect(() => c.encrypt('srv-x', 'me', new TextEncoder().encode('x'))).toThrow();
  });
});
