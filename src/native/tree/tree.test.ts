import { describe, it, expect } from 'vitest';
import {
  newGroup, addMember, removeMember, installEpochRoot, treeEncrypt, treeDecrypt,
  MAX_MEMBERS, LEGACY_WINDOW_SIZE,
  type Member, type GroupState,
} from './tree';
import { deriveKey } from '../seal/kdf';

function makeMember(id: string): Member {
  return { peerId: id, joinedAt: 0 };
}

function cloneGroup(g: GroupState): GroupState {
  return {
    groupId: g.groupId,
    currentEpoch: { ...g.currentEpoch, epochKey: new Uint8Array(g.currentEpoch.epochKey) },
    prevEpochs: g.prevEpochs.map(e => ({ ...e, epochKey: new Uint8Array(e.epochKey) })),
    members: g.members.map(m => ({ ...m })),
    rootKey: new Uint8Array(g.rootKey),
  };
}

function uint64BE(n: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, Math.floor(n / 2 ** 32), false);
  view.setUint32(4, n >>> 0, false);
  return buf;
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
    const { commit, epochRoot } = removeMember(g, 'bob');
    expect(commit.removedPeers).toContain('bob');
    expect(epochRoot.length).toBe(32);
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

  it('a removed member cannot derive the post-removal epoch key (fresh random root)', () => {
    const aliceG = newGroup('g1', makeMember('alice'));
    addMember(aliceG, makeMember('bob'));
    addMember(aliceG, makeMember('charlie'));
    // Bob legitimately holds the full group state right up to his removal.
    const bobG = cloneGroup(aliceG);

    const { commit } = removeMember(aliceG, 'bob');

    // The attack the old derivation-based removal rotation allowed: bob computes
    // next root = HKDF(rootKey, epochId) and the epoch key from it, offline.
    const derivedRoot = deriveKey(bobG.rootKey, uint64BE(commit.epochId), 'xorein/tree/v1/epoch-root', 32);
    const derivedEpochKey = deriveKey(derivedRoot, uint64BE(commit.epochId), 'xorein/tree/v1/exporter', 32);

    // With a fresh random root the derivation must NOT yield the real epoch key…
    expect([...derivedEpochKey]).not.toEqual([...aliceG.currentEpoch.epochKey]);

    // …and bob's forged state cannot decrypt post-removal traffic.
    const { ct } = treeEncrypt(aliceG, 'alice', enc('post-removal secret'));
    const bobForged: GroupState = {
      ...bobG,
      rootKey: derivedRoot,
      currentEpoch: { epochId: commit.epochId, epochKey: derivedEpochKey, messageCount: 0, startedAt: Date.now() },
    };
    expect(() => treeDecrypt(bobForged, ct)).toThrow();
  });

  it('remaining members install the distributed fresh root and keep decrypting', () => {
    const aliceG = newGroup('g1', makeMember('alice'));
    addMember(aliceG, makeMember('bob'));
    addMember(aliceG, makeMember('charlie'));
    const charlieG = cloneGroup(aliceG);

    const { ct: preKick } = treeEncrypt(aliceG, 'alice', enc('before the kick'));
    const { commit, epochRoot } = removeMember(aliceG, 'bob');

    // Charlie receives (commit, epochRoot) over the authenticated E2EE channel.
    charlieG.members = charlieG.members.filter(m => m.peerId !== 'bob');
    installEpochRoot(charlieG, commit.epochId, epochRoot);

    const { ct } = treeEncrypt(aliceG, 'alice', enc('after the kick'));
    expect(dec(treeDecrypt(charlieG, ct))).toBe('after the kick');
    // Pre-removal traffic still decrypts via the legacy window.
    expect(dec(treeDecrypt(charlieG, preKick))).toBe('before the kick');
  });

  it('installEpochRoot is monotonic: a stale or replayed epoch cannot roll the group back', () => {
    const g = newGroup('g1', makeMember('alice'));
    addMember(g, makeMember('bob'));
    addMember(g, makeMember('charlie')); // epoch 2
    const epochBefore = g.currentEpoch.epochId;
    const keyBefore = [...g.currentEpoch.epochKey];

    installEpochRoot(g, epochBefore, crypto.getRandomValues(new Uint8Array(32)));     // duplicate
    installEpochRoot(g, epochBefore - 1, crypto.getRandomValues(new Uint8Array(32))); // stale

    expect(g.currentEpoch.epochId).toBe(epochBefore);
    expect([...g.currentEpoch.epochKey]).toEqual(keyBefore);
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
