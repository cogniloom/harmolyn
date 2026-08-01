// Tier-0 A3: Crowd epoch rotation actually revokes a kicked member's channel keys.
//
// This is the security property the old code silently lacked (setRoot was
// first-root-wins and sync.update dropped crowd_root, so a kick rotated nothing).
// The test models three members sharing an epoch-0 root, the owner rotating to a
// fresh epoch-1 root and propagating it to the REMAINING member only, and asserts:
//   • before the kick, everyone decrypts,
//   • after the kick, the remaining member decrypts new (epoch-1) traffic while the
//     removed member — who never received the new root — CANNOT,
//   • the removed member can still read the pre-kick (epoch-0) message it already
//     had (legacy window / no retroactive breakage).
import { describe, it, expect } from 'vitest';
import { ChannelCrypto } from './channel';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const randomRoot = () => crypto.getRandomValues(new Uint8Array(32));

const SRV = 'srv-rotation';

describe('Crowd epoch rotation — a kick revokes channel keys', () => {
  it('changes Tree to Crowd at a fresh epoch and retains in-flight Tree ciphertext', () => {
    const R0 = randomRoot();
    const R1 = randomRoot();
    const A = new ChannelCrypto(); A.setRoot(SRV, R0, 0, 'tree');
    const B = new ChannelCrypto(); B.setRoot(SRV, R0, 0, 'tree');

    const treeWire = A.encrypt(SRV, 'A', enc('small space'));
    expect(dec(B.decrypt(SRV, treeWire, 'tree'))).toBe('small space');

    A.setRoot(SRV, R1, 1, 'crowd');
    B.setRoot(SRV, R1, 1, 'crowd');
    expect(A.modeOf(SRV)).toBe('crowd');
    expect(dec(B.decrypt(SRV, treeWire, 'tree'))).toBe('small space');

    const crowdWire = A.encrypt(SRV, 'A', enc('large space'));
    expect(crowdWire.epoch).toBe(1);
    expect(dec(B.decrypt(SRV, crowdWire, 'crowd'))).toBe('large space');
  });

  it('refuses an algorithm change without an advancing epoch', () => {
    const root = randomRoot();
    const A = new ChannelCrypto();
    A.setRoot(SRV, root, 3, 'tree');
    A.setRoot(SRV, randomRoot(), 3, 'crowd');
    expect(A.modeOf(SRV)).toBe('tree');
    expect(A.epochOf(SRV)).toBe(3);
  });

  it('refuses different key material reusing the same epoch', () => {
    const original = randomRoot();
    const replacement = randomRoot();
    const A = new ChannelCrypto(); A.setRoot(SRV, original, 4, 'crowd');
    const B = new ChannelCrypto(); B.setRoot(SRV, original, 4, 'crowd');
    A.setRoot(SRV, replacement, 4, 'crowd');
    const wire = A.encrypt(SRV, 'A', enc('immutable epoch root'));
    expect(dec(B.decrypt(SRV, wire, 'crowd'))).toBe('immutable epoch root');
  });

  it('retires an inactive mode after the one-epoch transition window', () => {
    const A = new ChannelCrypto();
    const treeRoot = randomRoot();
    A.setRoot(SRV, treeRoot, 0, 'tree');
    const oldTree = A.encrypt(SRV, 'A', enc('old tree'));
    A.setRoot(SRV, randomRoot(), 1, 'crowd');
    expect(dec(A.decrypt(SRV, oldTree, 'tree'))).toBe('old tree');
    A.setRoot(SRV, randomRoot(), 2, 'crowd');
    expect(() => A.decrypt(SRV, oldTree, 'tree')).toThrow();
  });

  it('remaining member decrypts new epoch; kicked member is locked out', () => {
    const R0 = randomRoot(); // shared epoch-0 root (all three members)
    const R1 = randomRoot(); // owner's fresh root after kicking C

    // A = owner, B = stays, C = gets kicked. All seed the same epoch-0 root.
    const A = new ChannelCrypto(); A.setRoot(SRV, R0, 0);
    const B = new ChannelCrypto(); B.setRoot(SRV, R0, 0);
    const C = new ChannelCrypto(); C.setRoot(SRV, R0, 0);

    // Epoch 0: A broadcasts, B and C both decrypt.
    const w0 = A.encrypt(SRV, 'A', enc('hello everyone'));
    expect(w0.epoch).toBe(0);
    expect(dec(B.decrypt(SRV, w0))).toBe('hello everyone');
    expect(dec(C.decrypt(SRV, w0))).toBe('hello everyone');

    // Owner kicks C → rotate to epoch 1 and propagate the new root to B ONLY.
    // (In production this is nativeRemoveMember → broadcastServerUpdate → the
    //  sync.update handler installing crowd_root/crowd_epoch; C is not a recipient.)
    A.setRoot(SRV, R1, 1);
    B.setRoot(SRV, R1, 1);
    // C never learns R1.

    // Epoch 1: A broadcasts. B decrypts; C cannot (it has no epoch-1 key).
    const w1 = A.encrypt(SRV, 'A', enc('members only now'));
    expect(w1.epoch).toBe(1);
    expect(dec(B.decrypt(SRV, w1))).toBe('members only now');
    expect(() => C.decrypt(SRV, w1)).toThrow();
  });

  it('rotation keeps the previous epoch decryptable (legacy window)', () => {
    const R0 = randomRoot();
    const R1 = randomRoot();
    const A = new ChannelCrypto(); A.setRoot(SRV, R0, 0);
    const B = new ChannelCrypto(); B.setRoot(SRV, R0, 0);

    const w0 = A.encrypt(SRV, 'A', enc('epoch zero message'));
    // Both rotate forward.
    A.setRoot(SRV, R1, 1);
    B.setRoot(SRV, R1, 1);

    // The old epoch-0 ciphertext still decrypts for both after rotation.
    expect(dec(A.decrypt(SRV, w0))).toBe('epoch zero message');
    expect(dec(B.decrypt(SRV, w0))).toBe('epoch zero message');
    expect(A.epochOf(SRV)).toBe(1);
  });

  it('setRoot is monotonic — a stale/replayed older epoch never rolls the group back', () => {
    const R0 = randomRoot();
    const R1 = randomRoot();
    const A = new ChannelCrypto();
    A.setRoot(SRV, R0, 0);
    A.setRoot(SRV, R1, 1);      // rotate forward
    A.setRoot(SRV, R0, 0);      // replayed old rotation — must be ignored
    expect(A.epochOf(SRV)).toBe(1);
    // New encryptions are still at epoch 1 (R1), so a would-be rollback attacker
    // holding only R0 cannot decrypt them.
    expect(A.encrypt(SRV, 'A', enc('x')).epoch).toBe(1);
  });
});
