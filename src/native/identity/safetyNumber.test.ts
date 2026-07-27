// Tier-0 A7: safety-number determinism, symmetry, and sensitivity to key changes.
import { describe, it, expect } from 'vitest';
import {
  computeSafetyNumber, formatSafetyNumber, identityKeyBlob, parseIdentityKeyBlob,
  type HybridIdentityKey,
} from './safetyNumber';

function key(edFill: number, mldsaFill = edFill): HybridIdentityKey {
  return { ed25519: new Uint8Array(32).fill(edFill), mldsa65: new Uint8Array(1952).fill(mldsaFill) };
}

const A = key(1);
const B = key(2);

describe('safety number', () => {
  it('is deterministic', () => {
    const n1 = computeSafetyNumber(A, 'alice', B, 'bob');
    const n2 = computeSafetyNumber(A, 'alice', B, 'bob');
    expect(n1).toBe(n2);
    expect(n1).toMatch(/^\d{60}$/);
  });

  it('is symmetric — both sides compute the same number', () => {
    const fromAlice = computeSafetyNumber(A, 'alice', B, 'bob');
    const fromBob = computeSafetyNumber(B, 'bob', A, 'alice');
    expect(fromAlice).toBe(fromBob);
  });

  it('changes when a party’s identity key changes (MITM / re-key detection)', () => {
    const original = computeSafetyNumber(A, 'alice', B, 'bob');
    const swapped = computeSafetyNumber(A, 'alice', key(3), 'bob');
    expect(swapped).not.toBe(original);
  });

  it('changes when the post-quantum (ML-DSA) half differs, even with the same Ed25519', () => {
    const a = computeSafetyNumber(A, 'alice', key(2, 2), 'bob');
    const b = computeSafetyNumber(A, 'alice', key(2, 9), 'bob');
    expect(a).not.toBe(b);
  });

  it('formats into 5-digit groups', () => {
    const grouped = formatSafetyNumber('0'.repeat(60));
    expect(grouped.split(' ')).toHaveLength(12);
    expect(grouped.split(' ').every(g => g.length === 5)).toBe(true);
  });

  it('round-trips the identity-key blob', () => {
    const blob = identityKeyBlob(A.ed25519, A.mldsa65);
    const parsed = parseIdentityKeyBlob(blob)!;
    expect(parsed.ed25519).toEqual(A.ed25519);
    expect(parsed.mldsa65).toEqual(A.mldsa65);
  });
});
