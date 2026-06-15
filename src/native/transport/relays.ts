// Multi-relay configuration + failover.
//
// The relay is no longer a single hardcoded address: the client resolves an
// ORDERED list (runtime override → build defaults → the built-in fallback) and
// reserves a circuit on the first one that answers, so a dead/blocked relay no
// longer takes the whole client offline. Operators/users add backups via the
// `harmolyn:xorein:relay-multiaddrs` localStorage key (JSON array) or the
// DEFAULT_RELAY_MULTIADDRS build config.
import { DEFAULT_RELAY_MULTIADDRS } from '../../config/runtimeDefaults.js';
import { RELAY_MULTIADDR, reserveCircuitRelay, type Libp2p } from './node.js';

export const RELAY_OVERRIDE_KEY = 'harmolyn:xorein:relay-multiaddrs';

/**
 * Ordered, de-duplicated list of relay multiaddrs to try. `explicit` (e.g. a
 * test/local relay) wins; then any runtime localStorage override; then build
 * defaults; then the built-in fallback. With no configuration this is just the
 * built-in relay — identical to the previous single-relay behaviour.
 */
export function resolveRelayList(explicit?: string): string[] {
  const list: string[] = [];
  if (explicit && explicit.trim()) list.push(explicit.trim());

  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem(RELAY_OVERRIDE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          for (const r of parsed) if (typeof r === 'string' && r.trim()) list.push(r.trim());
        }
      }
    }
  } catch { /* ignore a malformed override */ }

  for (const r of DEFAULT_RELAY_MULTIADDRS) if (r && r.trim()) list.push(r.trim());
  list.push(RELAY_MULTIADDR);

  return [...new Set(list)];
}

/** The user-configured relay override list (persisted in localStorage). */
export function getRelayOverrides(): string[] {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem(RELAY_OVERRIDE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string' && !!x.trim());
      }
    }
  } catch { /* malformed */ }
  return [];
}

/** Add a user relay so it joins the failover list on the next (re)connect. */
export function addRelayOverride(multiaddr: string): void {
  if (typeof window === 'undefined' || !multiaddr.trim()) return;
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
