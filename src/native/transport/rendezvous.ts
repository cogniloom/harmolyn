// xorein server rendezvous — browser side.
//
// Spec 31 §3.5 — server membership must not be enumerable by non-members.
// The rendezvous CID is HMAC-SHA256(serverSecret, "xorein/server/rendezvous"),
// byte-compatible with the Go oracle (pkg/v0_1/discovery/rendezvous.go).
//
// The browser client registers/discovers via the relay node's control HTTP API.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Must match Go oracle const rendezvousLabel = "xorein/server/rendezvous".
const RENDEZVOUS_LABEL = 'xorein/server/rendezvous';

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

const CONTROL_BASE = 'https://node.xorein.com/v1';

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
  const res = await fetch(`${CONTROL_BASE}/rendezvous/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ namespace, peer_id: peerId, addrs, ttl_seconds: ttlSeconds }),
  });
  if (!res.ok) throw new Error(`rendezvous register: ${res.status}`);
}

/**
 * Discover peers registered in a rendezvous namespace.
 */
export async function rendezvousDiscover(namespace: string, limit = 50): Promise<RendezvousPeer[]> {
  const res = await fetch(
    `${CONTROL_BASE}/rendezvous/discover?namespace=${encodeURIComponent(namespace)}&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`rendezvous discover: ${res.status}`);
  const data = await res.json() as { peers: RendezvousPeer[] };
  return data.peers ?? [];
}
