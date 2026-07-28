// Tier-0 A5: native state is ENCRYPTED at rest. crowd_root, invite_secret and
// message bodies must never appear in localStorage in cleartext, and the blob must
// round-trip only under the correct key.
import { describe, it, expect, beforeEach } from 'vitest';
import { initStore, setStateEncryptionKey, addServer, addMessage, getState } from './store';

const STORAGE_KEY = 'harmolyn:native:state';
const KEY_A = new Uint8Array(32).fill(9);
const KEY_B = new Uint8Array(32).fill(1);

const SECRET_ROOT = 'SECRET-CROWD-ROOT-b64==';
const SECRET_INVITE = 'SECRET-INVITE-b64==';
const SECRET_BODY = 'TOP-SECRET-MESSAGE-BODY';

function seedSensitiveState(): void {
  addServer({
    id: 's1', name: 'S', owner_peer_id: 'p', members: ['p'], channels: {},
    crowd_root: SECRET_ROOT, invite_secret: SECRET_INVITE,
  });
  addMessage({
    id: 'm1', scope_type: 'channel', scope_id: 'c1', server_id: 's1',
    sender_peer_id: 'p', body: SECRET_BODY, created_at: '2026-01-01T00:00:00.000Z',
  });
}

describe('store — encrypted at rest (A5)', () => {
  beforeEach(() => {
    localStorage.clear();
    setStateEncryptionKey(null);
  });

  it('writes ciphertext (v2) with no secret substrings when a key is set', () => {
    setStateEncryptionKey(KEY_A);
    initStore();
    seedSensitiveState();

    const raw = localStorage.getItem(STORAGE_KEY)!;
    expect(raw).toBeTruthy();
    const outer = JSON.parse(raw);
    expect(outer.v).toBe(2);
    expect(typeof outer.ct).toBe('string');
    // The sensitive material must not be recoverable from the persisted blob.
    expect(raw).not.toContain(SECRET_ROOT);
    expect(raw).not.toContain(SECRET_INVITE);
    expect(raw).not.toContain(SECRET_BODY);
  });

  it('round-trips the encrypted blob on reload with the same key', () => {
    setStateEncryptionKey(KEY_A);
    initStore();
    seedSensitiveState();

    // Simulate a reload: re-install the same key and re-init from storage.
    setStateEncryptionKey(KEY_A);
    initStore();

    expect(getState().servers['s1']?.crowd_root).toBe(SECRET_ROOT);
    expect(getState().messages.find(m => m.id === 'm1')?.body).toBe(SECRET_BODY);
  });

  it('a wrong key cannot decrypt — starts fresh rather than surfacing garbage', () => {
    setStateEncryptionKey(KEY_A);
    initStore();
    seedSensitiveState();

    setStateEncryptionKey(KEY_B); // attacker / different identity
    initStore();

    expect(getState().servers['s1']).toBeUndefined();
    expect(getState().messages.find(m => m.id === 'm1')).toBeUndefined();
  });
});
