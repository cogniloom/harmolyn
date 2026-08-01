// Multi-relay configuration + failover.
//
// The relay is no longer a single hardcoded address: the client resolves an
// ORDERED list (runtime override → build defaults → the built-in fallback) and
// reserves a circuit on the first one that answers, so a dead/blocked relay no
// longer takes the whole client offline. Operators/users add backups via the
// `harmolyn:xorein:relay-multiaddrs` localStorage key (JSON array) or the
// DEFAULT_RELAY_MULTIADDRS build config.
import { DEFAULT_RELAY_MULTIADDRS } from '../../config/runtimeDefaults.js';
import {
  isTrustedRelayMultiaddr,
  RELAY_MULTIADDR,
  fetchRelayAddrs,
  reserveCircuitRelay,
  type Libp2p,
} from './node.js';

export const RELAY_OVERRIDE_KEY = 'harmolyn:xorein:relay-multiaddrs';

/**
 * Ordered, de-duplicated list of relay multiaddrs to try. `explicit` (e.g. a
 * test/local relay) wins; then any runtime localStorage override; then build
 * defaults; then the built-in fallback. With no configuration this is just the
 * built-in relay — identical to the previous single-relay behaviour.
 */
export function resolveRelayList(explicit?: string): string[] {
  const list: string[] = [];
  if (explicit && isTrustedRelayMultiaddr(explicit)) list.push(explicit.trim());

  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem(RELAY_OVERRIDE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          for (const r of parsed) if (isTrustedRelayMultiaddr(r)) list.push(r.trim());
        }
      }
    }
  } catch { /* ignore a malformed override */ }

  for (const r of DEFAULT_RELAY_MULTIADDRS) if (isTrustedRelayMultiaddr(r)) list.push(r.trim());
  if (isTrustedRelayMultiaddr(RELAY_MULTIADDR)) list.push(RELAY_MULTIADDR);

  return [...new Set(list)];
}

/**
 * Resolve relays for a connection attempt, including the identity currently
 * advertised by a loopback support node. Local xorein relay identities are
 * generated per data directory, so a build-time production peer pin cannot be
 * the source of truth for local development. Remote relay discovery remains
 * pinned and is intentionally excluded here.
 */
export async function resolveRelayListAsync(explicit?: string): Promise<string[]> {
  const discoveredLocal = await fetchRelayAddrs({ localOnly: true });
  const localPrefixes = new Set(discoveredLocal.map(relayDialPrefix));
  // When a loopback support node gives us the live relay identity, replace any
  // stale address for that same socket (including the build-time fallback). A
  // dead local relay must not make reconnect spend 30 seconds each on several
  // copies of the same endpoint before trying the next backoff cycle.
  const configured = resolveRelayList(explicit).filter(relay => !localPrefixes.has(relayDialPrefix(relay)));
  return [...new Set([...discoveredLocal, ...configured])];
}

function relayDialPrefix(relay: string): string {
  const marker = relay.lastIndexOf('/p2p/');
  return marker > 0 ? relay.slice(0, marker) : relay;
}

/** The user-configured relay override list (persisted in localStorage). */
export function getRelayOverrides(): string[] {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem(RELAY_OVERRIDE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) return parsed.filter((x): x is string => isTrustedRelayMultiaddr(x));
      }
    }
  } catch { /* malformed */ }
  return [];
}

/** Add a user relay so it joins the failover list on the next (re)connect. */
export function addRelayOverride(multiaddr: string): void {
  if (typeof window === 'undefined' || !isTrustedRelayMultiaddr(multiaddr)) return;
  const list = [...new Set([...getRelayOverrides(), multiaddr.trim()])];
  try { window.localStorage.setItem(RELAY_OVERRIDE_KEY, JSON.stringify(list)); } catch { /* quota */ }
}

/** Remove a user relay from the override list. */
export function removeRelayOverride(multiaddr: string): void {
  if (typeof window === 'undefined') return;
  const list = getRelayOverrides().filter(r => r !== multiaddr.trim());
  try { window.localStorage.setItem(RELAY_OVERRIDE_KEY, JSON.stringify(list)); } catch { /* quota */ }
}

/**
 * Try to reserve a circuit on each relay in order; return the first that
 * succeeds, or null if none answered. Lets the transport fail over to a backup
 * relay instead of being pinned to one.
 */
export async function reserveAnyRelay(node: Libp2p, relays: string[]): Promise<string | null> {
  for (const relay of relays) {
    try {
      if (await reserveCircuitRelay(node, relay)) return relay;
    } catch { /* try the next relay */ }
  }
  return null;
}
