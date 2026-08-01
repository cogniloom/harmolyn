// xorein server rendezvous — browser side.
//
// Spec 31 §3.5 — server membership must not be enumerable by non-members.
// The rendezvous CID is HMAC-SHA256(serverSecret, "xorein/server/rendezvous"),
// byte-compatible with the Go oracle (pkg/v0_1/discovery/rendezvous.go).
//
// The browser client registers/discovers via the relay node's control HTTP API.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { supportNodeApiBase } from '../nodeOrigin.js';
import { reportNodeRequestFailure, reportNodeRequestSuccess } from '../../lib/nodeHealth.js';
import { getPeerSync } from '../sync/registry.js';
import { PROTOCOLS } from '../families/families.js';
import { peerServiceCandidates } from '../peerServices/providers.js';
import { isTrustedPeerCircuitMultiaddr } from './node.js';
import { getState } from '../state/store.js';

// Must match Go oracle const rendezvousLabel = "xorein/server/rendezvous".
const RENDEZVOUS_LABEL = 'xorein/server/rendezvous';
const MAX_RENDEZVOUS_STORE_CANDIDATES = 12;
const MAX_RENDEZVOUS_DISCOVERY_CANDIDATES = 64;
const MAX_PARALLEL_REQUESTS = 8;

/**
 * Compute the rendezvous CID for a server given its secret.
 * Byte-compatible with Go oracle's ServerRendezvousCID.
 * Returns empty string if serverSecret is < 16 bytes (fail-closed).
 */
export function serverRendezvousCID(serverSecret: Uint8Array): string {
  if (serverSecret.length < 16) return '';
  const mac = hmac(sha256, serverSecret, new TextEncoder().encode(RENDEZVOUS_LABEL));
  return Array.from(mac).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── HTTP rendezvous (relay control API) ────────────────────────────────────

export interface RendezvousPeer {
  peer_id: string;
  addrs: string[];
  ttl_remaining_seconds: number;
}

/**
 * Register this peer in a rendezvous namespace via the relay control API.
 * Namespace is typically the server's rendezvous CID.
 */
export async function rendezvousRegister(
  namespace: string,
  peerId: string,
  addrs: string[],
  ttlSeconds = 7200,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(namespace)
    || !peerId
    || peerId.length > 256
    || !Number.isSafeInteger(ttlSeconds)
    || ttlSeconds < 60
    || ttlSeconds > 7200
    || !Array.isArray(addrs)
    || addrs.length < 1
    || addrs.length > 8
    || addrs.some(address => !isTrustedPeerCircuitMultiaddr(address, peerId))) {
    throw new Error('rendezvous register: invalid registration');
  }
  const peerSync = getPeerSync();
  let acknowledgements = 0;
  let lastError: unknown;
  if (typeof peerSync?.registerRendezvousAtRelay === 'function'
    && await peerSync.registerRendezvousAtRelay(namespace, addrs, ttlSeconds)) acknowledgements++;

  // Compatibility path for the legacy local support shim.
  if (acknowledgements === 0) {
    try {
      const res = await fetch(`${supportNodeApiBase()}/rendezvous/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace, peer_id: peerId, addrs, ttl_seconds: ttlSeconds }),
      });
      reportNodeRequestSuccess();
      if (!res.ok) throw new Error(`rendezvous register: ${res.status}`);
      acknowledgements++;
    } catch (error) {
      lastError = error;
      reportNodeRequestFailure(error);
    }
  }

  if (peerSync) {
    const candidates = peerServiceCandidates(namespace, MAX_RENDEZVOUS_STORE_CANDIDATES);
    for (let offset = 0; offset < candidates.length; offset += MAX_PARALLEL_REQUESTS) {
      const responses = await Promise.all(
        candidates.slice(offset, offset + MAX_PARALLEL_REQUESTS).map(candidate => {
          const role = getState().peers[candidate]?.role;
          const support = role === 'relay' || role === 'archivist';
          return peerSync.requestPeer<{ ok?: boolean }>(
            candidate,
            PROTOCOLS.peer,
            support ? 'peer.rendezvous.register' : 'peer.rendezvous.mesh.register',
            { namespace, addrs, ttl_seconds: ttlSeconds },
          );
        }),
      );
      acknowledgements += responses.filter(response => response?.ok === true).length;
      if (acknowledgements >= 3) break;
    }
  }
  if (acknowledgements > 0) return;
  if (lastError instanceof Error) throw lastError;
  throw new Error('rendezvous register: no node or peer registrar is reachable');
}

/**
 * Discover peers registered in a rendezvous namespace.
 */
export async function rendezvousDiscover(namespace: string, limit = 50): Promise<RendezvousPeer[]> {
  if (!/^[0-9a-f]{64}$/.test(namespace)
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 200) {
    throw new Error('rendezvous discover: invalid request');
  }
  const peerSync = getPeerSync();
  let providerAnswered = false;
  let lastError: unknown;
  const allPeers: RendezvousPeer[] = [];
  const discovered = typeof peerSync?.discoverRendezvousAtRelay === 'function'
    ? await peerSync.discoverRendezvousAtRelay(namespace, limit)
    : null;
  if (discovered !== null) {
    providerAnswered = true;
    allPeers.push(...discovered);
  }

  // POST with a JSON body per the Go oracle (pkg/v0_1/control/handlers_rendezvous.go);
  // the control API has no GET variant of this endpoint.
  if (discovered === null) {
    try {
      const res = await fetch(`${supportNodeApiBase()}/rendezvous/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace, limit }),
      });
      reportNodeRequestSuccess();
      if (!res.ok) throw new Error(`rendezvous discover: ${res.status}`);
      const data = await res.json() as { peers?: unknown };
      if (!Array.isArray(data.peers) || data.peers.length > 200) {
        throw new Error('rendezvous discover: invalid response');
      }
      providerAnswered = true;
      allPeers.push(...data.peers as RendezvousPeer[]);
    } catch (error) {
      lastError = error;
      reportNodeRequestFailure(error);
    }
  }

  if (peerSync) {
    const candidates = peerServiceCandidates(namespace, MAX_RENDEZVOUS_DISCOVERY_CANDIDATES);
    for (let offset = 0; offset < candidates.length; offset += MAX_PARALLEL_REQUESTS) {
      const responses = await Promise.all(
        candidates.slice(offset, offset + MAX_PARALLEL_REQUESTS).map(candidate => {
          const role = getState().peers[candidate]?.role;
          const support = role === 'relay' || role === 'archivist';
          return peerSync.requestPeer<{ ok?: boolean; peers?: unknown[] }>(
            candidate,
            PROTOCOLS.peer,
            support ? 'peer.rendezvous.discover' : 'peer.rendezvous.mesh.discover',
            { namespace, limit },
          );
        }),
      );
      for (const response of responses) {
        if (!response?.ok || !Array.isArray(response.peers) || response.peers.length > 200) continue;
        providerAnswered = true;
        allPeers.push(...response.peers as RendezvousPeer[]);
      }
    }
  }

  const merged = new Map<string, RendezvousPeer>();
  for (const peer of allPeers) {
    if (!peer
      || typeof peer.peer_id !== 'string'
      || peer.peer_id.length < 1
      || peer.peer_id.length > 256
      || !Array.isArray(peer.addrs)
      || peer.addrs.length > 8
      || peer.addrs.some(address => !isTrustedPeerCircuitMultiaddr(address, peer.peer_id))
      || !Number.isFinite(peer.ttl_remaining_seconds)
      || peer.ttl_remaining_seconds < 0) continue;
    const current = merged.get(peer.peer_id);
    merged.set(peer.peer_id, {
      peer_id: peer.peer_id,
      addrs: [...new Set([...(current?.addrs ?? []), ...peer.addrs])].slice(0, 8),
      ttl_remaining_seconds: Math.max(
        current?.ttl_remaining_seconds ?? 0,
        Math.floor(peer.ttl_remaining_seconds),
      ),
    });
  }
  if (providerAnswered) return [...merged.values()].slice(0, limit);
  if (lastError instanceof Error) throw lastError;
  throw new Error('rendezvous discover: no node or peer registrar is reachable');
}
