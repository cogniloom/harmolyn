import { describe, it, expect } from 'vitest';
import {
  mailboxToken, mailboxEpoch, currentMailboxToken, drainMailboxTokens,
  wrapRelayBody, unwrapRelayBody,
} from './mailbox';

const secret32 = new Uint8Array(32).fill(0xab);

describe('mailboxEpoch', () => {
  it('matches floor(unix_seconds / 3600)', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(mailboxEpoch(now)).toBe(Math.floor(now / 3600));
  });
});

describe('mailboxToken', () => {
  it('returns a non-empty base64url string for a valid secret', () => {
    const t = mailboxToken(secret32, 1000);
    expect(t.length).toBeGreaterThan(0);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is deterministic', () => {
    expect(mailboxToken(secret32, 1000)).toBe(mailboxToken(secret32, 1000));
  });

  it('differs across epochs', () => {
    expect(mailboxToken(secret32, 1000)).not.toBe(mailboxToken(secret32, 1001));
  });

  it('differs across secrets', () => {
    const s2 = new Uint8Array(32).fill(0xcd);
    expect(mailboxToken(secret32, 42)).not.toBe(mailboxToken(s2, 42));
  });

  it('returns empty string for secrets < 16 bytes (fail-closed)', () => {
    expect(mailboxToken(new Uint8Array(15), 0)).toBe('');
  });

  // Go-oracle golden vectors — computed by running nat.MailboxToken() against the
  // live Go oracle at /home/hal9000/docker/xorein (pkg/v0_1/nat/store_forward.go).
  // base64url_no_pad( HMAC-SHA256(secret, "xorein/mailbox/" + epoch_decimal) )
  // secret32 = Uint8Array(32).fill(0xab)
  it('byte-compatible with Go oracle (vector: ab*32, epoch=1000)', () => {
    // Note: secret32 is 0xab*32 (defined at top of this test file).
    // Go: nat.MailboxToken(bytes.Repeat([]byte{0xab}, 32), 1000)
    expect(mailboxToken(secret32, 1000)).toBe('1nSyTxu_M4RFliYSxAJuh5A0jh8Vt_8TOHNH9n8cudw');
  });

  it('byte-compatible with Go oracle (vector: 42*32, epoch=1000)', () => {
    const s42 = new Uint8Array(32).fill(0x42);
    expect(mailboxToken(s42, 1000)).toBe('WOVo_N_JD0oCE8UxngwJm9vquRZ4geboKUtZJ-eeO3U');
  });

  it('byte-compatible with Go oracle (vector: 42*32, epoch=0)', () => {
    const s42 = new Uint8Array(32).fill(0x42);
    expect(mailboxToken(s42, 0)).toBe('dTuHr-adsp2Z8F5P5cX_mb3mJQPxETJTRjyL5lXzwzg');
  });

  it('byte-compatible with Go oracle (vector: 42*32, epoch=15000)', () => {
    const s42 = new Uint8Array(32).fill(0x42);
    expect(mailboxToken(s42, 15000)).toBe('5g4ojAwubov9ojLd9uSPJeWF5LMjrG-ez5eFff2vIX4');
  });
});

describe('drainMailboxTokens', () => {
  it('returns current + 1 prior epoch', () => {
    const tokens = drainMailboxTokens(secret32);
    expect(tokens.length).toBe(2);
    const cur = mailboxEpoch();
    expect(tokens[0]).toBe(mailboxToken(secret32, cur));
    expect(tokens[1]).toBe(mailboxToken(secret32, cur - 1));
  });
});

describe('relay frame', () => {
  it('wrapRelayBody prepends magic bytes', () => {
    const ct = new Uint8Array([1, 2, 3]);
    const framed = wrapRelayBody(ct);
    expect(framed[0]).toBe(0x78); // 'x'
    expect(framed[1]).toBe(0x72); // 'r'
    expect(framed[2]).toBe(0x6e); // 'n'
    expect(framed[3]).toBe(0x31); // '1'
    expect(framed[4]).toBe(0x01); // version
    expect(framed.length).toBe(8);
  });

  it('unwrapRelayBody strips magic and returns original bytes', () => {
    const ct = new Uint8Array([10, 20, 30]);
    const framed = wrapRelayBody(ct);
    const restored = unwrapRelayBody(framed);
    expect([...restored]).toEqual([10, 20, 30]);
  });

  it('unwrapRelayBody throws on bad magic', () => {
    const bad = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);
    expect(() => unwrapRelayBody(bad)).toThrow('invalid frame magic');
  });
});
