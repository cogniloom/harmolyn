// Round-9 P1: the PLAINTEXT localStorage mirror of the runtime snapshot must not carry
// decrypted communication content (message bodies, DM threads, the social graph, abuse
// reports). Those are protected at rest only inside the encrypted native-state blob; a
// plaintext copy would let anyone reading the browser profile recover chat history
// without the account password or state key. The full snapshot still lives in the
// in-memory global for React.
import { describe, it, expect, beforeEach } from 'vitest';
import { initStore, setNativeIdentity, addServer, addMessage, ensureDm, addFriendRequest } from './store';
import { publishNativeSnapshot } from './snapshot';

const ME = 'me';
const ALICE = 'alice';
const SECRET = 'attack at dawn 0xC0FFEE';

const STORAGE_KEYS = ['harmolyn:xorein:runtime', 'harmolyn:runtime-snapshot', 'xorein:runtime-snapshot'];
const GLOBAL_KEYS = ['__HARMOLYN_XOREIN_RUNTIME__', '__HARMOLYN_RUNTIME_SNAPSHOT__', '__XOREIN_RUNTIME_SNAPSHOT__'];

describe('publishNativeSnapshot — at-rest content stripping (Round-9 P1)', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const k of GLOBAL_KEYS) delete (window as unknown as Record<string, unknown>)[k];
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    addServer({ id: 'srv1', name: 'S', owner_peer_id: ME, members: [ME, ALICE], channels: { c1: { id: 'c1', server_id: 'srv1', name: 'general', voice: false } } });
    addMessage({ id: 'm1', scope_type: 'channel', scope_id: 'c1', server_id: 'srv1', sender_peer_id: ALICE, body: SECRET, created_at: '2026-01-01T00:00:00.000Z' });
    ensureDm('dm1', [ME, ALICE]);
    addFriendRequest({ peer_id: ALICE, direction: 'incoming' } as never);
  });

  it('omits message bodies, DMs, friends, and reports from every plaintext localStorage key', () => {
    publishNativeSnapshot();
    for (const key of STORAGE_KEYS) {
      const raw = localStorage.getItem(key);
      expect(raw, `key ${key}`).toBeTruthy();
      expect(raw).not.toContain(SECRET);
      const parsed = JSON.parse(raw as string);
      expect(parsed.messages).toEqual([]);
      expect(parsed.dms).toEqual([]);
      expect(parsed.friends).toEqual([]);
      expect(parsed.friend_requests).toEqual([]);
      expect(parsed.reports).toEqual([]);
    }
  });

  it('keeps the FULL snapshot (with messages) in the in-memory global for React', () => {
    publishNativeSnapshot();
    for (const key of GLOBAL_KEYS) {
      const snap = (window as unknown as Record<string, { messages?: Array<{ body: string }> }>)[key];
      expect(snap?.messages?.some(m => m.body === SECRET)).toBe(true);
    }
  });
});
