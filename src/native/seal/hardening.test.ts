// Tier-0 A6: Seal hardening — one-time-prekey single use, bundle rotation,
// identity binding, and out-of-order delivery (the previously-missing coverage).
import { describe, it, expect } from 'vitest';
import { SealSessions, type FetchBundle } from './session.js';
import { generateSigningIdentity } from '../crypto/hybrid.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('Seal — one-time prekey single use', () => {
  it('consumes the OPK on first use and rejects reuse of that slot', async () => {
    const a = new SealSessions('a', generateSigningIdentity());
    const b = new SealSessions('b', generateSigningIdentity());
    const fetch: FetchBundle = async () => b.serveBundle();

    const w1 = await a.encrypt('b', enc('first'), fetch);
    const k = w1.im!.opk;
    expect(k).toBeGreaterThanOrEqual(0);
    expect(dec(b.decrypt('a', w1))).toBe('first'); // consumes slot k

    // The consumed slot is now published as 32 zero bytes.
    expect(b.serveBundle().one_time_prekeys_x25519[k].every(x => x === 0)).toBe(true);

    // A fresh first-contact envelope that reuses the consumed slot is rejected —
    // an OPK must never back a second session.
    const a2 = new SealSessions('a2', generateSigningIdentity());
    const w = await a2.encrypt('b', enc('replay'), async () => b.serveBundle());
    if (w.im) { w.im.opk = k; delete w.im.opkPub; }
    expect(() => b.decrypt('a2', w)).toThrow();
  });

  it('rebuilds the bundle (new SPK) when one-time prekeys run low', async () => {
    const b = new SealSessions('b', generateSigningIdentity());
    const firstSpk = JSON.stringify(b.serveBundle().signed_prekey_x25519);
    for (let i = 0; i < 30; i++) {
      const ai = new SealSessions(`a${i}`, generateSigningIdentity());
      const w = await ai.encrypt('b', enc('x'), async () => b.serveBundle());
      try { b.decrypt(`a${i}`, w); } catch { /* occasional random-slot collision — fine */ }
    }
    // Crossing the low-watermark rotates the whole bundle, so the SPK changes.
    expect(JSON.stringify(b.serveBundle().signed_prekey_x25519)).not.toBe(firstSpk);
  });
});

describe('Seal — identity binding', () => {
  it('rejects a bundle whose peer_id does not match the requested peer (relay swap)', async () => {
    const a = new SealSessions('a', generateSigningIdentity());
    const impostor = new SealSessions('mallory', generateSigningIdentity());
    // We ask to DM 'b' but the relay serves mallory's bundle (peer_id='mallory').
    await expect(a.encrypt('b', enc('secret'), async () => impostor.serveBundle())).rejects.toThrow();
  });
});

describe('Seal — out-of-order / skipped messages', () => {
  it('decrypts messages that arrive out of order within a chain', async () => {
    const a = new SealSessions('a', generateSigningIdentity());
    const b = new SealSessions('b', generateSigningIdentity());
    const fetch: FetchBundle = async () => b.serveBundle();

    const w1 = await a.encrypt('b', enc('m1'), fetch);
    const w2 = await a.encrypt('b', enc('m2'), fetch);
    const w3 = await a.encrypt('b', enc('m3'), fetch);

    expect(dec(b.decrypt('a', w1))).toBe('m1'); // establishes the session
    expect(dec(b.decrypt('a', w3))).toBe('m3'); // skip ahead — m2's key is stored
    expect(dec(b.decrypt('a', w2))).toBe('m2'); // late arrival still decrypts
  });
});
