// Round-9 P1 + metadata-minimization follow-up: the PLAINTEXT localStorage mirror
// of the runtime snapshot must not carry decrypted communication content (message
// bodies, DM threads, the social graph, abuse reports) NOR account metadata beyond
// the minimal pre-unlock bootstrap paint (identity display name, server names,
// joined ids, control endpoint). Everything else — member rosters, roles, channel
// names/topics, presence, known peers, unread counts, profile bio/avatar — is
// protected at rest only inside the encrypted native-state blob; a plaintext copy
// would let anyone reading the browser profile recover it without the account
// password or state key. The full snapshot still lives in the in-memory global
// for React. Guests write NO localStorage mirror at all (sessionStorage only).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initStore,
  setNativeIdentity,
  addServer,
  addMessage,
  ensureDm,
  addFriendRequest,
  upsertPeer,
  updatePresenceEntry,
  bumpUnread,
  setMemberRoles,
} from './store';
import { publishNativeSnapshot } from './snapshot';
import { saveGuestIdentity, clearGuestIdentity } from '../identity/storage';
import type { XoreinIdentity } from '../identity/identity';

const ME = 'me-peer-4471';
const ALICE = 'alice-peer-8272';
const SECRET = 'attack at dawn 0xC0FFEE';
const SECRET_BIO = 'my-private-bio-text';

const STORAGE_KEYS = ['harmolyn:xorein:runtime', 'harmolyn:runtime-snapshot', 'xorein:runtime-snapshot'];
const GLOBAL_KEYS = ['__HARMOLYN_XOREIN_RUNTIME__', '__HARMOLYN_RUNTIME_SNAPSHOT__', '__XOREIN_RUNTIME_SNAPSHOT__'];

describe('publishNativeSnapshot — at-rest content and metadata stripping', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearGuestIdentity();
    for (const k of GLOBAL_KEYS) delete (window as unknown as Record<string, unknown>)[k];
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME, profile: { display_name: 'Me', bio: SECRET_BIO, avatar: 'data:image/png;base64,AVATARDATA' } });
    addServer({
      id: 'srv1',
      name: 'S',
      owner_peer_id: ME,
      members: [ME, ALICE],
      roles: [{ id: 'r1', name: 'mods', color: '#fff', permissions: ['ADMINISTRATOR'] }],
      channels: { c1: { id: 'c1', server_id: 'srv1', name: 'secret-channel-general', topic: 'hidden topic', voice: false } },
    });
    setMemberRoles('srv1', ALICE, ['r1']);
    addMessage({ id: 'm1', scope_type: 'channel', scope_id: 'c1', server_id: 'srv1', sender_peer_id: ALICE, body: SECRET, created_at: '2026-01-01T00:00:00.000Z' });
    ensureDm('dm1', [ME, ALICE]);
    addFriendRequest({ peer_id: ALICE, direction: 'incoming' } as never);
    upsertPeer({ peer_id: ALICE, addresses: [], display_name: 'Alice Display', identity_key: 'aWRrZXk=' });
    updatePresenceEntry(ALICE, { peer_id: ALICE, status: 'online', updated_at: '2026-01-01T00:00:00.000Z' } as never);
    bumpUnread('c1');
  });

  afterEach(() => {
    clearGuestIdentity();
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

  it('reduces the persisted mirror to the minimal bootstrap paint — no rosters, roles, channels, presence, peers, unread, or profile bio/avatar', () => {
    publishNativeSnapshot();
    for (const key of STORAGE_KEYS) {
      const raw = localStorage.getItem(key) as string;
      // Social-graph and account metadata must not appear anywhere in the blob.
      expect(raw).not.toContain(ALICE);
      expect(raw).not.toContain('secret-channel-general');
      expect(raw).not.toContain('hidden topic');
      expect(raw).not.toContain(SECRET_BIO);
      expect(raw).not.toContain('AVATARDATA');
      expect(raw).not.toContain('Alice Display');

      const parsed = JSON.parse(raw) as {
        identity?: { peer_id?: string; profile?: Record<string, unknown> };
        servers?: Array<Record<string, unknown>>;
        joined_server_ids?: string[];
        known_peers?: unknown[];
        presence?: Record<string, unknown>;
        unread?: Record<string, unknown>;
      };
      // What the pre-unlock paint legitimately needs is kept…
      expect(parsed.identity?.peer_id).toBe(ME);
      expect(parsed.identity?.profile?.display_name).toBe('Me');
      expect(parsed.joined_server_ids).toEqual(['srv1']);
      expect(parsed.servers?.length).toBe(1);
      expect(parsed.servers?.[0].name).toBe('S');
      // …and everything else is stripped.
      expect(parsed.servers?.[0].members).toEqual([]);
      expect(parsed.servers?.[0].channels).toEqual({});
      expect(parsed.servers?.[0].owner_peer_id).toBe('');
      expect(parsed.servers?.[0].roles).toBeUndefined();
      expect(parsed.servers?.[0].member_roles).toBeUndefined();
      expect(parsed.servers?.[0].description).toBeUndefined();
      expect(parsed.known_peers).toEqual([]);
      expect(parsed.presence).toEqual({});
      expect(parsed.unread).toEqual({});
    }
  });

  it('keeps the FULL snapshot (with messages) in the in-memory global for React', () => {
    publishNativeSnapshot();
    for (const key of GLOBAL_KEYS) {
      const snap = (window as unknown as Record<string, { messages?: Array<{ body: string }> }>)[key];
      expect(snap?.messages?.some(m => m.body === SECRET)).toBe(true);
    }
  });

  it('GUESTS write no localStorage mirror at all — only a minimal per-tab sessionStorage copy', () => {
    // Seed a rich legacy mirror (what older builds persisted) to verify the
    // one-time hygiene sweep minimizes it rather than leaving rosters behind.
    localStorage.setItem(STORAGE_KEYS[0], JSON.stringify({
      peer_id: 'old-registered-peer',
      identity: { id: 'old-registered-peer', peer_id: 'old-registered-peer' },
      servers: [{ id: 'srvX', name: 'Old', owner_peer_id: 'old-owner', members: ['old-owner', 'old-member'], channels: { cX: { id: 'cX', server_id: 'srvX', name: 'old-channel' } } }],
      messages: [{ id: 'mx', body: SECRET }],
      known_peers: [{ peer_id: 'old-member', addresses: [] }],
    }));

    saveGuestIdentity({ peerId: 'guest-peer' } as unknown as XoreinIdentity);
    publishNativeSnapshot();

    for (const key of STORAGE_KEYS) {
      // The guest's own data never lands in durable localStorage…
      const localRaw = localStorage.getItem(key) ?? '';
      expect(localRaw).not.toContain(ME);
      expect(localRaw).not.toContain(ALICE);
      expect(localRaw).not.toContain(SECRET);
      // …and any legacy rich mirror has been minimized in place (no rosters/channels).
      if (localRaw) {
        expect(localRaw).not.toContain('old-member');
        expect(localRaw).not.toContain('old-channel');
      }
      // The guest mirror lives in per-tab sessionStorage, minimized like the rest.
      const sessionRaw = sessionStorage.getItem(key);
      expect(sessionRaw, `sessionStorage ${key}`).toBeTruthy();
      expect(sessionRaw).not.toContain(SECRET);
      expect(sessionRaw).not.toContain(ALICE);
      const parsed = JSON.parse(sessionRaw as string) as { servers?: Array<{ members: unknown[] }> };
      expect(parsed.servers?.[0]?.members).toEqual([]);
    }
  });

  it('a registered publish removes any stale guest sessionStorage mirror (which would shadow it)', () => {
    for (const key of STORAGE_KEYS) sessionStorage.setItem(key, JSON.stringify({ peer_id: 'stale-guest' }));

    publishNativeSnapshot();

    for (const key of STORAGE_KEYS) {
      expect(sessionStorage.getItem(key)).toBeNull();
      expect(localStorage.getItem(key)).toBeTruthy();
    }
  });
});
