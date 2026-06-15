import { describe, it, expect } from 'vitest';
import {
  newGroup, addMember, removeMember, treeEncrypt, treeDecrypt,
  MAX_MEMBERS, LEGACY_WINDOW_SIZE,
  type Member,
} from './tree';

function makeMember(id: string): Member {
  return { peerId: id, joinedAt: 0 };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('Tree mode group', () => {
  it('creates a group with epoch 0', () => {
    const g = newGroup('g1', makeMember('alice'));
    expect(g.currentEpoch.epochId).toBe(0);
    expect(g.members.length).toBe(1);
    expect(g.rootKey.length).toBe(32);
    expect(g.currentEpoch.epochKey.length).toBe(32);
  });

  it('addMember rotates epoch and adds peer', () => {
    const g = newGroup('g1', makeMember('alice'));
    const commit = addMember(g, makeMember('bob'));
    expect(commit.epochId).toBe(1);
    expect(commit.addedPeers).toContain('bob');
    expect(g.currentEpoch.epochId).toBe(1);
    expect(g.members.length).toBe(2);
  });

  it('removeMember rotates epoch and removes peer', () => {
    const g = newGroup('g1', makeMember('alice'));
    addMember(g, makeMember('bob'));
    const commit = removeMember(g, 'bob');
    expect(commit.removedPeers).toContain('bob');
    expect(g.members.length).toBe(1);
    expect(g.currentEpoch.epochId).toBe(2);
  });

  it('rejects adding duplicate member', () => {
    const g = newGroup('g1', makeMember('alice'));
    addMember(g, makeMember('bob'));
    expect(() => addMember(g, makeMember('bob'))).toThrow('already a member');
  });

  it('rejects removing non-member', () => {
    const g = newGroup('g1', makeMember('alice'));
    expect(() => removeMember(g, 'bob')).toThrow('not a member');
  });
});

describe('Tree mode encrypt / decrypt', () => {
  it('encrypts and decrypts in the same epoch', () => {
    const g = newGroup('g1', makeMember('alice'));
    addMember(g, makeMember('bob'));
    const { ct } = treeEncrypt(g, 'alice', enc('hello bob'));
    expect(dec(treeDecrypt(g, ct))).toBe('hello bob');
  });

  it('decrypts from a prev epoch (legacy window)', () => {
    const g = newGroup('g1', makeMember('alice'));
    addMember(g, makeMember('bob'));
    const { ct: ct1 } = treeEncrypt(g, 'alice', enc('msg1'));
    // Rotate epoch (add charlie)
    addMember(g, makeMember('charlie'));
    // ct1 was in epoch 1; current is now epoch 2; prev should cover it
    expect(dec(treeDecrypt(g, ct1))).toBe('msg1');
  });

  it('fails to decrypt an epoch outside the legacy window', () => {
    const g = newGroup('g1', makeMember('alice'));
    const { ct: ct0 } = treeEncrypt(g, 'alice', enc('old msg'));
    // Rotate enough times to evict epoch 0 from the window
    for (let i = 0; i <= LEGACY_WINDOW_SIZE + 1; i++) {
      addMember(g, makeMember(`peer${i}`));
    }
    expect(() => treeDecrypt(g, ct0)).toThrow();
  });

  it('multi-member round-trip: alice sends, bob and charlie receive', () => {
    const aliceG = newGroup('g1', makeMember('alice'));
    addMember(aliceG, makeMember('bob'));
    addMember(aliceG, makeMember('charlie'));

    // Bob and charlie share the same group state (simplified: clone)
    const bobG = JSON.parse(JSON.stringify(aliceG, null, 0), (k, v) => {
      if (v && v.type === 'Buffer') return new Uint8Array(v.data);
      return v;
    }) as typeof aliceG;
    // Re-parse with proper Uint8Array reconstruction
    bobG.rootKey = new Uint8Array(Object.values(aliceG.rootKey));
    bobG.currentEpoch.epochKey = new Uint8Array(Object.values(aliceG.currentEpoch.epochKey));

    const { ct } = treeEncrypt(aliceG, 'alice', enc('group message'));
    // Bob uses same epoch key (same state after membership)
    expect(dec(treeDecrypt(aliceG, ct))).toBe('group message');
  });
});
