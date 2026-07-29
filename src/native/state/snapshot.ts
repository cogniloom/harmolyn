// Publishes the native state as a XoreinRuntimeSnapshot to the global keys
// and localStorage keys that data.ts reads every 1s.
//
// Writing to these well-known locations (matching xoreinControl.ts publishSnapshot)
// means the UI's data path (data.ts → createShellRuntimeData) is unchanged.
import { toRuntimeSnapshot } from './store.js';
import { isGuestIdentityActive } from '../identity/storage.js';
import type { XoreinRuntimeSnapshot } from '../../types.js';

// Keys from src/data.ts / src/lib/xoreinControl.ts
const RUNTIME_GLOBAL_KEYS = [
  '__HARMOLYN_XOREIN_RUNTIME__',
  '__HARMOLYN_RUNTIME_SNAPSHOT__',
  '__XOREIN_RUNTIME_SNAPSHOT__',
] as const;

const RUNTIME_STORAGE_KEYS = [
  'harmolyn:xorein:runtime',
  'harmolyn:runtime-snapshot',
  'xorein:runtime-snapshot',
] as const;

/**
 * Reduce a runtime snapshot to the MINIMUM needed for the pre-unlock bootstrap
 * paint. The persisted mirror is PLAINTEXT — separate from, and NOT protected
 * by, the AES-GCM native-state blob — so anyone who can read the browser
 * profile can read it without the account password or state key. It therefore
 * must carry no decrypted communication content AND no account metadata beyond
 * what the lock-screen shell paints: the local identity's display name, the
 * names of joined servers, and the support-node endpoint.
 *
 * Deliberately stripped (readable only via the in-memory global while the
 * engine is live, and from the encrypted store after unlock): message bodies,
 * DM threads, the social graph (friends/known_peers), abuse reports, server
 * member rosters, roles/member_roles, channel names/topics, server
 * descriptions/owners, presence, and per-scope unread counts.
 */
function minimalBootstrapMirror(snapshot: XoreinRuntimeSnapshot): XoreinRuntimeSnapshot {
  return {
    role: snapshot.role,
    peer_id: snapshot.peer_id,
    control_endpoint: snapshot.control_endpoint,
    ...(snapshot.identity
      ? {
          identity: {
            id: snapshot.identity.id,
            peer_id: snapshot.identity.peer_id,
            ...(snapshot.identity.profile?.display_name
              ? { profile: { display_name: snapshot.identity.profile.display_name } }
              : {}),
          },
        }
      : {}),
    servers: (snapshot.servers ?? []).map(server => ({
      id: server.id,
      name: server.name,
      owner_peer_id: '',
      members: [],
      channels: {},
    })),
    joined_server_ids: snapshot.joined_server_ids ?? [],
    messages: [],
    dms: [],
    friends: [],
    friend_requests: [],
    reports: [],
    known_peers: [],
    voice_sessions: [],
    relay_addrs: [],
    presence: {},
    unread: {},
  };
}

// One-time hygiene sweep: older builds persisted the FULL snapshot (rosters,
// roles, presence, known peers) to the localStorage mirror. A registered
// publish overwrites those keys with the minimal mirror, but on guest-only
// devices no registered publish ever happens — so minimize any pre-existing
// mirror in place once per JS context before leaving localStorage alone.
let _legacyMirrorSweepDone = false;
function sweepLegacyLocalStorageMirrors(): void {
  if (_legacyMirrorSweepDone) return;
  _legacyMirrorSweepDone = true;
  for (const key of RUNTIME_STORAGE_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as XoreinRuntimeSnapshot;
      localStorage.setItem(key, JSON.stringify(minimalBootstrapMirror(parsed)));
    } catch { /* best effort */ }
  }
}

export function publishNativeSnapshot(): void {
  if (typeof window === 'undefined') return;

  const snapshot = toRuntimeSnapshot();

  for (const key of RUNTIME_GLOBAL_KEYS) {
    // In-memory global for the UI — full snapshot (reports drive the moderation UI).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any)[key] = snapshot;
  }

  // Persisted mirror: PLAINTEXT, best-effort, minimal (see minimalBootstrapMirror).
  const persisted = JSON.stringify(minimalBootstrapMirror(snapshot));
  if (isGuestIdentityActive()) {
    // Guests are throwaway: their session must leave nothing durable behind.
    // Mirror to per-tab sessionStorage only (like the guest native state) and
    // never touch localStorage — a registered account's pre-unlock paint may
    // live there. Legacy rich mirrors from older builds are minimized once.
    sweepLegacyLocalStorageMirrors();
    for (const key of RUNTIME_STORAGE_KEYS) {
      try { sessionStorage.setItem(key, persisted); } catch { /* best effort */ }
    }
  } else {
    for (const key of RUNTIME_STORAGE_KEYS) {
      try { localStorage.setItem(key, persisted); } catch { /* best effort */ }
      // Drop any per-tab guest mirror: data.ts reads sessionStorage FIRST, so a
      // stale guest copy would shadow the registered mirror in this tab.
      try { sessionStorage.removeItem(key); } catch { /* best effort */ }
    }
  }

  // Signal the React polling loop (same events as xoreinControl.ts publishSnapshot).
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
}
