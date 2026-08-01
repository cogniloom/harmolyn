// Resolves the support-node ORIGIN (scheme+host, no /v1) every native subsystem
// must use for HTTP calls to the xorein support node (blobs, mailbox, rendezvous,
// TURN credentials). Resolution order matches the control API client
// (src/lib/xoreinControl.ts): the user-selected endpoint from the Settings
// "connect node" dialog wins over the build-time default, so a self-hosted or
// local node receives ALL support traffic — nothing may stay pinned to the
// public default node.

import { parseTrustedHttpOrigin } from '../lib/trustedOrigin.js';

const DEFAULT_NODE = 'https://node.xorein.com';

// Same key xoreinControl.ts writes via storePreferredControlEndpoint().
const CONTROL_ENDPOINT_STORAGE_KEY = 'harmolyn:xorein:selected-control-endpoint';

/** The active support-node origin, e.g. "https://node.xorein.com" or "http://127.0.0.1:7711". */
export function supportNodeOrigin(): string {
  let stored: string | null | undefined;
  if (typeof window !== 'undefined') {
    try {
      stored = window.localStorage.getItem(CONTROL_ENDPOINT_STORAGE_KEY);
    } catch {
      // Storage unavailable — use the build-time endpoint below.
    }
  }

  // An explicitly stored but malformed/insecure endpoint must not silently
  // fall back to the public node: that would send ciphertext and metadata to a
  // different operator than the user selected. Empty means fail closed.
  if (stored !== null && stored !== undefined) {
    return parseTrustedHttpOrigin(stored)?.origin ?? '';
  }

  const env = import.meta.env?.VITE_XOREIN_CONTROL_ENDPOINT?.trim();
  return parseTrustedHttpOrigin(env || DEFAULT_NODE)?.origin ?? '';
}

/** The /v1 API base for the active support node. */
export function supportNodeApiBase(): string {
  const origin = supportNodeOrigin();
  if (!origin) {
    throw new Error('xorein support node endpoint is missing or insecure');
  }
  return `${origin}/v1`;
}
