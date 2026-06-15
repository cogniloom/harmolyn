import { describe, it, expect } from 'vitest';
import {
  newCrowdGroup, addSender, crowdEncrypt, crowdDecrypt,
  rotateEpochMembership, deriveSenderKey, deriveEpochRoot,
} from './crowd';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('Crowd mode', () => {
  it('creates a group with epoch 0', () => {
    const g = newCrowdGroup('scope1');
    expect(g.currentEpoch.epochId).toBe(0);
    expect(g.currentEpoch.epochRoot.length).toBe(32);
  });

  it('encrypts and decrypts for the same peer', () => {
    const g = newCrowdGroup('scope1');
    addSender(g, 'alice');
    const ct = crowdEncrypt(g, 'alice', enc('hello crowd'));
    expect(dec(crowdDecrypt(g, ct))).toBe('hello crowd');
  });

  it('decrypts without pre-registering sender (on-demand key derivation)', () => {
    const g = newCrowdGroup('scope1');
    const ct = crowdEncrypt(g, 'alice', enc('lazy key derivation'));
    expect(dec(crowdDecrypt(g, ct))).toBe('lazy key derivation');
  });

  it('multi-sender: different senders produce different keys', () => {
    const root = new Uint8Array(32).fill(0x42);
    const ka = deriveSenderKey(root, 'alice');
    const kb = deriveSenderKey(root, 'bob');
    expect([...ka]).not.toEqual([...kb]);
  });

  it('epoch rotation on membership change uses fresh random root', () => {
    const g = newCrowdGroup('scope1');
    const oldRoot = new Uint8Array(g.currentEpoch.epochRoot);
    rotateEpochMembership(g);
    expect(g.currentEpoch.epochId).toBe(1);
    // New root must differ from both old root and derived-from-old-root
    const derived = deriveEpochRoot(oldRoot);
    expect([...g.currentEpoch.epochRoot]).not.toEqual([...oldRoot]);
    expect([...g.currentEpoch.epochRoot]).not.toEqual([...derived]);
  });

  it('decrypts from prev epoch (legacy window)', () => {
    const g = newCrowdGroup('scope1');
    const ct0 = crowdEncrypt(g, 'alice', enc('epoch0 msg'));
    rotateEpochMembership(g); // epoch 1 - epoch 0 in prev
    expect(dec(crowdDecrypt(g, ct0))).toBe('epoch0 msg');
  });
});
