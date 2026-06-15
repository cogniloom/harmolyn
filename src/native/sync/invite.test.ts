import { describe, it, expect } from 'vitest';
import { computeInviteToken, verifyInviteToken } from './invite.js';

function randomSecretB64(): string {
  const r = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < r.length; i++) s += String.fromCharCode(r[i]);
  return btoa(s);
}

describe('invite token', () => {
  it('round-trips: a token computed from the secret verifies', () => {
    const secret = randomSecretB64();
    const token = computeInviteToken(secret, 'srv-123');
    expect(token.length).toBeGreaterThan(0);
    expect(verifyInviteToken(secret, 'srv-123', token)).toBe(true);
  });

  it('rejects a token bound to a different server id', () => {
    const secret = randomSecretB64();
    const token = computeInviteToken(secret, 'srv-123');
    expect(verifyInviteToken(secret, 'srv-OTHER', token)).toBe(false);
  });

  it('rejects a token from the wrong secret', () => {
    const token = computeInviteToken(randomSecretB64(), 'srv-123');
    expect(verifyInviteToken(randomSecretB64(), 'srv-123', token)).toBe(false);
  });

  it('rejects an empty/forged token when the server is secured', () => {
    const secret = randomSecretB64();
    expect(verifyInviteToken(secret, 'srv-123', '')).toBe(false);
    expect(verifyInviteToken(secret, 'srv-123', 'forged')).toBe(false);
  });

  it('rejects all joins on servers without an invite_secret (closed by default)', () => {
    expect(verifyInviteToken(undefined, 'srv-123', '')).toBe(false);
    expect(verifyInviteToken('', 'srv-123', 'anything')).toBe(false);
  });
});
