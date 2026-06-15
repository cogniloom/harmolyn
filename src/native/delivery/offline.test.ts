// Verifies offline store-and-forward (resil-2): pairwise mailbox secrets are
// symmetric, the node only ever sees opaque ciphertext (no routing metadata),
// and a deposited chat envelope is recovered by the intended recipient only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  peerIdToEdPub, pairwiseMailboxSecret,
  registerOfflineIdentity, resetOfflineIdentity,
  depositOfflineChat, drainOfflineChat,
} from './offline.js';
import { generateIdentity, type XoreinIdentity } from '../identity/identity.js';

function mockMailbox() {
  const store = new Map<string, string[]>();
  const fetchMock = vi.fn(async (url: string | URL, init?: { body?: string }) => {
    const u = String(url);
    const body = JSON.parse(init?.body ?? '{}');
    if (u.endsWith('/mailbox/store')) {
      const arr = store.get(body.token) ?? [];
      arr.push(body.body);
      store.set(body.token, arr);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (u.endsWith('/mailbox/drain')) {
      const bodies: string[] = [];
      for (const t of body.tokens ?? []) {
        const arr = store.get(t);
        if (arr) { bodies.push(...arr); store.delete(t); }
      }
      return { ok: true, status: 200, json: async () => ({ bodies }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;
  return { store, fetchMock };
}

describe('offline mailbox (pairwise, zero-knowledge)', () => {
  let alice: XoreinIdentity;
  let bob: XoreinIdentity;

  beforeEach(async () => {
    alice = await generateIdentity();
    bob = await generateIdentity();
  });
  afterEach(() => {
    resetOfflineIdentity();
    vi.restoreAllMocks();
  });

  it('recovers a peer ed key from its peerId', () => {
    expect(Array.from(peerIdToEdPub(bob.peerId)!)).toEqual(Array.from(bob.edPub));
  });

  it('derives an identical pairwise secret on both sides for a given recipient', () => {
    const senderSide = pairwiseMailboxSecret(alice.edSeed, bob.edPub, bob.peerId);
    const recipientSide = pairwiseMailboxSecret(bob.edSeed, alice.edPub, bob.peerId);
    expect(Array.from(senderSide)).toEqual(Array.from(recipientSide));
  });

  it('uses a DIFFERENT namespace per direction (recipient id is bound in)', () => {
    const aToB = pairwiseMailboxSecret(alice.edSeed, bob.edPub, bob.peerId);
    const bToA = pairwiseMailboxSecret(alice.edSeed, bob.edPub, alice.peerId);
    expect(Array.from(aToB)).not.toEqual(Array.from(bToA));
  });

  it('deposits an opaque envelope and the recipient drains+recovers it', async () => {
    const { store } = mockMailbox();
    const envelope = { enc: 'seal', scope_id: 'dm-xyz', sender_id: alice.peerId, message_id: 'm1', seal: { ik: 'AA', header: 'BB', ct: 'CC' } };

    registerOfflineIdentity(alice);
    expect(await depositOfflineChat(bob.peerId, envelope)).toBe(true);

    // What the node stored must NOT reveal routing metadata in cleartext.
    const stored = JSON.stringify([...store.values()]);
    expect(stored).not.toContain('dm-xyz');
    expect(stored).not.toContain(alice.peerId);

    registerOfflineIdentity(bob);
    const got: Array<{ env: Record<string, unknown>; from: string }> = [];
    const n = await drainOfflineChat([alice.peerId], (env, from) => got.push({ env, from }));
    expect(n).toBe(1);
    expect(got[0].from).toBe(alice.peerId);
    expect(got[0].env).toEqual(envelope);
  });

  it("a third party cannot drain the recipient's mailbox", async () => {
    mockMailbox();
    const mallory = await generateIdentity();
    const envelope = { enc: 'seal', scope_id: 's', sender_id: alice.peerId, message_id: 'm' };

    registerOfflineIdentity(alice);
    await depositOfflineChat(bob.peerId, envelope);

    registerOfflineIdentity(mallory);
    const got: unknown[] = [];
    const n = await drainOfflineChat([alice.peerId, bob.peerId], (env) => got.push(env));
    expect(n).toBe(0);
    expect(got).toHaveLength(0);
  });
});
