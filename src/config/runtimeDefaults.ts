/**
 * Build-time defaults for the xorein runtime.
 *
 * DEFAULT_RELAY_MULTIADDRS: add the full multiaddr once the relay peer-id is known.
 * Format: "/dns4/xorein.lama-lan.ch/tcp/<port>/p2p/<peer-id>"
 *
 * Runtime override via localStorage key "harmolyn:xorein:relay-multiaddrs" (JSON array of strings).
 */
export const DEFAULT_RELAY_MULTIADDRS: string[] = [
  // TODO(relay-peer-id): fill in once xorein.lama-lan.ch's libp2p peer-id is known.
];
