import { sha256 } from '@noble/hashes/sha2.js';
import { friendRequestCounterparty, getState } from '../state/store.js';

const enc = new TextEncoder();

function stableScore(key: string, peerId: string): string {
  const digest = sha256(enc.encode(`${key}\0${peerId}`));
  return Array.from(digest.subarray(0, 12), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Pick the same storage/rendezvous peers from a partially shared network view.
 *
 * Support nodes are preferred, then ordinary peers are rendezvous-hashed by the
 * opaque key. Server rosters, DM participants, friends, and signed PEX records
 * all contribute candidates; no single configured relay is assumed.
 */
export function peerServiceCandidates(key: string, limit: number): string[] {
  if (!key || limit < 1) return [];
  const state = getState();
  const self = state.identity?.peer_id ?? '';
  const ids = new Set<string>(Object.keys(state.peers));
  for (const server of Object.values(state.servers)) {
    for (const peerId of server.members ?? []) ids.add(peerId);
  }
  for (const dm of Object.values(state.dms)) {
    for (const peerId of dm.participants ?? []) ids.add(peerId);
  }
  for (const friend of state.friends) {
    ids.add(friendRequestCounterparty(friend, self));
  }
  ids.delete('');
  ids.delete(self);

  return [...ids]
    .sort((a, b) => {
      const roleA = state.peers[a]?.role;
      const roleB = state.peers[b]?.role;
      const tierA = roleA === 'archivist' ? 0 : roleA === 'relay' || roleA === 'bootstrap' ? 1 : 2;
      const tierB = roleB === 'archivist' ? 0 : roleB === 'relay' || roleB === 'bootstrap' ? 1 : 2;
      return tierA - tierB
        || stableScore(key, a).localeCompare(stableScore(key, b))
        || a.localeCompare(b);
    })
    .slice(0, Math.min(128, Math.max(1, Math.floor(limit))));
}
