// Resolves the support-node ORIGIN (scheme+host, no /v1) every native subsystem
// must use for HTTP calls to the xorein support node (blobs, mailbox, rendezvous,
// TURN credentials). Resolution order matches the control API client
// (src/lib/xoreinControl.ts): the user-selected endpoint from the Settings
// "connect node" dialog wins over the build-time default, so a self-hosted or
// local node receives ALL support traffic — nothing may stay pinned to the
// public default node.

const DEFAULT_NODE = 'https://node.xorein.com';

// Same key xoreinControl.ts writes via storePreferredControlEndpoint().
const CONTROL_ENDPOINT_STORAGE_KEY = 'harmolyn:xorein:selected-control-endpoint';

/** The active support-node origin, e.g. "https://node.xorein.com" or "http://127.0.0.1:7711". */
export function supportNodeOrigin(): string {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(CONTROL_ENDPOINT_STORAGE_KEY);
      if (stored) {
        return new URL(stored).origin;
      }
    } catch {
      // Storage unavailable or a malformed value — fall through to the build default.
    }
  }
  const env = import.meta.env?.VITE_XOREIN_CONTROL_ENDPOINT?.trim();
  return (env || DEFAULT_NODE).replace(/\/+$/, '');
}

/** The /v1 API base for the active support node. */
export function supportNodeApiBase(): string {
  return `${supportNodeOrigin()}/v1`;
}
