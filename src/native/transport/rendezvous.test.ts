import { describe, it, expect } from 'vitest';
import { serverRendezvousCID } from './rendezvous';

describe('serverRendezvousCID', () => {
  it('produces a 64-char hex string for a valid secret', () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const cid = serverRendezvousCID(secret);
    expect(cid).toHaveLength(64);
    expect(cid).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic — same secret gives same CID', () => {
    const secret = new Uint8Array(32).fill(0x42);
    expect(serverRendezvousCID(secret)).toBe(serverRendezvousCID(secret));
  });

  it('differs for different secrets', () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    expect(serverRendezvousCID(a)).not.toBe(serverRendezvousCID(b));
  });

  it('returns empty string for secrets < 16 bytes (fail-closed)', () => {
    expect(serverRendezvousCID(new Uint8Array(15))).toBe('');
    expect(serverRendezvousCID(new Uint8Array(0))).toBe('');
  });

  // Go-oracle golden vectors — computed by running discovery.ServerRendezvousCID()
  // against the live Go oracle at /home/hal9000/docker/xorein (pkg/v0_1/discovery/rendezvous.go).
  // HMAC-SHA256(serverSecret, "xorein/server/rendezvous") → lowercase hex.
  it('byte-compatible with Go oracle (vector: ff*32)', () => {
    const secret = new Uint8Array(32).fill(0xff);
    expect(serverRendezvousCID(secret)).toBe(
      '73a5412ecbf63763de24fcce74de277995e8f6ca35460f5161f4af1ac1292429',
    );
  });

  it('byte-compatible with Go oracle (vector: ab*32)', () => {
    const secret = new Uint8Array(32).fill(0xab);
    expect(serverRendezvousCID(secret)).toBe(
      '2fab2070e9f15390bd49bdedda57a313e5e0e144fb9c2c8660896ba9a29d9158',
    );
  });
});
