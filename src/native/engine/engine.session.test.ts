// P0 regression cover: reload must keep a registered user signed in and
// rehydrate their state.
//
//  (i)  register() must establish the remember-me session at REGISTRATION time
//       (previously only a later manual unlock saved it, so the first reload
//       after account creation always demanded the password again).
//  (ii) bootstrapLocalState() after a "reload" with a persisted identity must
//       restore the SAME identity from the session and rehydrate the encrypted
//       state (profile, friends, DMs) — no guest fallback — and pre-bootstrap
//       stray store writes must never clobber the registered localStorage blob.
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeIndexedDB, resetFakeIndexedDB } from '../identity/fakeIndexedDB.testutil';
import { generateIdentity, identitySigningKey } from '../identity/identity';
import { SealSessions, type FetchBundle } from '../seal/session';
import { loadSealState } from '../seal/persist';
import {
  encryptIdentity,
  saveEncryptedIdentity,
  hasPersistedIdentity,
  saveSessionIdentity,
  loadSessionIdentity,
  hasValidSession,
  clearSessionIdentity,
  setRememberMeEnabled,
  ARGON2_TEST_PARAMS,
} from '../identity/storage';
import { XoreinNativeEngine } from './engine';
import {
  configureNativeStore,
  setStateEncryptionKey,
  initStore,
  getState,
  setNativeIdentity,
  updateState,
  setActiveScope,
} from '../state/store';
import type { XoreinIdentity } from '../identity/identity';

installFakeIndexedDB();

const STATE_KEY = 'harmolyn:native:state';

beforeEach(() => {
  resetFakeIndexedDB();
  localStorage.clear();
  sessionStorage.clear();
  setStateEncryptionKey(null);
  // Remember-me is now OPT-IN (default off — the at-rest security finding).
  // These tests exercise the session-restore machinery itself, so they run as a
  // user who explicitly chose "keep me signed in on this device".
  setRememberMeEnabled(true);
});

/** Persist a registered user's account state the way a live session does. */
function seedRegisteredState(id: XoreinIdentity): void {
  configureNativeStore({ guest: false });
  setStateEncryptionKey(id.edSeed);
  initStore();
  setNativeIdentity({
    id: id.peerId,
    peer_id: id.peerId,
    created_at: new Date().toISOString(),
    profile: { display_name: 'Bob' },
  });
  updateState(() => ({
    friends: [{ id: 'fr-1', from_peer_id: id.peerId, to_peer_id: '12D3KooWpeerX', status: 'accepted' as const }],
    dms: { 'dm-1': { id: 'dm-1', participants: [id.peerId, '12D3KooWpeerX'], created_at: new Date().toISOString() } },
  }));
}

/** Simulate a page reload's pre-engine module state (fresh JS context). */
function simulateReloadBoot(): void {
  setStateEncryptionKey(null);
  // What NativeEngineProvider's module scope now does: keep pre-engine writes
  // in memory so they can never clobber the registered blob.
  configureNativeStore({ guest: true });
  // In-memory state resets on reload; emulate by loading from (empty) sessionStorage.
  initStore();
}

describe('register() session persistence (defect i)', () => {
  it('persists the encrypted identity AND a remember-me session at registration', async () => {
    const id = await generateIdentity();
    const engine = new XoreinNativeEngine({});
    // Inject the (guest) identity like the live promotion path: register() only
    // needs the keypair, not a connected relay.
    (engine as unknown as Record<string, unknown>)._identity = id;

    expect(hasValidSession()).toBe(false);
    await engine.register('a strong password', 'Bob');

    expect(await hasPersistedIdentity()).toBe(true);
    // The session must exist NOW — a reload right after registration must not
    // demand the password again.
    expect(hasValidSession()).toBe(true);
    const restored = await loadSessionIdentity();
    expect(restored?.peerId).toBe(id.peerId);
    // And the registered profile is in the store for the snapshot.
    expect(getState().identity?.profile?.display_name).toBe('Bob');
  }, 30_000); // register() runs the real (production-parameter) Argon2 KDF

  it('rejects registration without a passphrase', async () => {
    const id = await generateIdentity();
    const engine = new XoreinNativeEngine({});
    (engine as unknown as Record<string, unknown>)._identity = id;
    await expect(engine.register('')).rejects.toThrow(/passphrase/);
  });
});

describe('bootstrapLocalState() after reload (defect ii)', () => {
  it('restores identity from the session and rehydrates state — no guest fallback', async () => {
    const id = await generateIdentity();
    seedRegisteredState(id);
    await saveEncryptedIdentity(encryptIdentity(id, 'pw-123456789', ARGON2_TEST_PARAMS));
    await saveSessionIdentity(id);
    const blobBefore = localStorage.getItem(STATE_KEY);
    expect(blobBefore).toBeTruthy();
    expect((JSON.parse(blobBefore!) as { v?: number }).v).toBe(2); // encrypted at rest

    simulateReloadBoot();

    // NO passphrase: the persisted session must carry the unlock.
    const engine = new XoreinNativeEngine({});
    const { guestMode } = await engine.bootstrapLocalState();

    expect(guestMode).toBe(false);
    expect(engine.identity.peerId).toBe(id.peerId);
    const st = getState();
    expect(st.identity?.peer_id).toBe(id.peerId);
    expect(st.identity?.profile?.display_name).toBe('Bob'); // drives hasIdentity in the UI
    expect(st.friends).toHaveLength(1);
    expect(st.friends[0]?.to_peer_id).toBe('12D3KooWpeerX');
    expect(Object.keys(st.dms)).toEqual(['dm-1']);
  });

  it('a stray pre-bootstrap UI write cannot clobber the registered state blob', async () => {
    const id = await generateIdentity();
    seedRegisteredState(id);
    await saveEncryptedIdentity(encryptIdentity(id, 'pw-123456789', ARGON2_TEST_PARAMS));
    await saveSessionIdentity(id);
    const blobBefore = localStorage.getItem(STATE_KEY);

    simulateReloadBoot();
    // The exact write that used to destroy the account: Layout's setActiveScope
    // effect firing while the identity is still locked (before initStore ran on
    // the real backend). It must not be serialized anywhere.
    setActiveScope('channel-123');

    expect(localStorage.getItem(STATE_KEY)).toBe(blobBefore); // blob intact
    expect(sessionStorage.getItem(STATE_KEY)).toBeNull();     // locked state is memory-only

    const engine = new XoreinNativeEngine({});
    await engine.bootstrapLocalState();
    // Full rehydration despite the stray write.
    expect(getState().identity?.profile?.display_name).toBe('Bob');
    expect(getState().friends).toHaveLength(1);

    // And post-bootstrap persistence goes back to the encrypted localStorage blob.
    updateState(() => ({ unread: { 'dm-1': 1 } }));
    const blobAfter = localStorage.getItem(STATE_KEY);
    expect(blobAfter).not.toBe(blobBefore);
    expect((JSON.parse(blobAfter!) as { v?: number }).v).toBe(2);
  });

  it('throws a recoverable locked error when no session and no passphrase exist', async () => {
    const id = await generateIdentity();
    seedRegisteredState(id);
    await saveEncryptedIdentity(encryptIdentity(id, 'pw-123456789', ARGON2_TEST_PARAMS));
    clearSessionIdentity();

    simulateReloadBoot();

    const engine = new XoreinNativeEngine({});
    await expect(engine.bootstrapLocalState()).rejects.toThrow(/locked/);
  });

  it('seal ratchets survive guest→registered promotion + reload (post-reload DMs decrypt)', async () => {
    // Bob boots as a GUEST (the real first-load path), registers mid-session
    // (promotion, no engine restart), exchanges Seal DMs, then "reloads".
    // The reloaded engine must decrypt the peer's NEXT ratchet message — the
    // E2E defect where a post-reload DM never arrived because no ratchet state
    // had ever been persisted (seal persistence was frozen off at guest boot).
    type EngineInternals = { wireScopeCrypto(guest: boolean): void; _seal: SealSessions };
    const bob1 = new XoreinNativeEngine({});
    const boot1 = await bob1.bootstrapLocalState();
    expect(boot1.guestMode).toBe(true);
    (bob1 as unknown as EngineInternals).wireScopeCrypto(true);
    const bobId = bob1.identity;
    const bobSeal1 = (bob1 as unknown as EngineInternals)._seal;

    // While still a guest, NOTHING seal-shaped may touch localStorage.
    expect(loadSealState(bobId)).toBeNull();

    await bob1.register('a strong password', 'Bob');
    // Promotion snapshots the CURRENT bundle immediately (peers who cached it
    // pre-reload must still be able to handshake after one).
    const persistedAtRegister = loadSealState(bobId);
    expect(persistedAtRegister).not.toBeNull();
    expect(persistedAtRegister!.bundle.peer_id).toBe(bobId.peerId);

    // Alice (in-memory peer) establishes a session and they exchange messages.
    const aliceId = await generateIdentity();
    const aliceSeal = new SealSessions(aliceId.peerId, identitySigningKey(aliceId), {});
    const bobBundle: FetchBundle = async () => bobSeal1.serveBundle();
    const aliceBundle: FetchBundle = async () => aliceSeal.serveBundle();
    const utf8 = (s: string) => new TextEncoder().encode(s);

    const w1 = await aliceSeal.encrypt(bobId.peerId, utf8('hello bob'), bobBundle);
    expect(new TextDecoder().decode(bobSeal1.decrypt(aliceId.peerId, w1))).toBe('hello bob');
    const w2 = await bobSeal1.encrypt(aliceId.peerId, utf8('hello alice'), aliceBundle);
    expect(new TextDecoder().decode(aliceSeal.decrypt(bobId.peerId, w2))).toBe('hello alice');

    // "Reload": fresh engine, no passphrase — the 5-day session unlocks it and
    // wireScopeCrypto(false) must restore the persisted ratchets.
    simulateReloadBoot();
    const bob2 = new XoreinNativeEngine({});
    const boot2 = await bob2.bootstrapLocalState();
    expect(boot2.guestMode).toBe(false);
    expect(bob2.identity.peerId).toBe(bobId.peerId);
    (bob2 as unknown as EngineInternals).wireScopeCrypto(false);
    const bobSeal2 = (bob2 as unknown as EngineInternals)._seal;
    expect(bobSeal2.hasSession(aliceId.peerId)).toBe(true);

    // Alice keeps her live ratchet and sends AFTER bob's reload — exactly the
    // failing E2E step. The restored session must decrypt it.
    const w3 = await aliceSeal.encrypt(bobId.peerId, utf8('post-reload fresh'), bobBundle);
    expect(new TextDecoder().decode(bobSeal2.decrypt(aliceId.peerId, w3))).toBe('post-reload fresh');

    // And bob's restored side can still SEND on the same ratchet.
    const w4 = await bobSeal2.encrypt(aliceId.peerId, utf8('bob back online'), aliceBundle);
    expect(new TextDecoder().decode(aliceSeal.decrypt(bobId.peerId, w4))).toBe('bob back online');
  }, 40_000); // register() runs the real (production-parameter) Argon2 KDF

  it('unlocking with the passphrase (no session) also saves a session for next time', async () => {
    const id = await generateIdentity();
    seedRegisteredState(id);
    await saveEncryptedIdentity(encryptIdentity(id, 'pw-123456789', ARGON2_TEST_PARAMS));
    clearSessionIdentity();

    simulateReloadBoot();

    const engine = new XoreinNativeEngine({ passphrase: 'pw-123456789' });
    const { guestMode } = await engine.bootstrapLocalState();
    expect(guestMode).toBe(false);
    expect(engine.identity.peerId).toBe(id.peerId);
    expect(getState().identity?.profile?.display_name).toBe('Bob');
    // The fire-and-forget session save settles on the microtask queue.
    await new Promise((r) => setTimeout(r, 50));
    expect(hasValidSession()).toBe(true);
  });
});
