/**
 * Build-time defaults for the xorein runtime.
 *
 * This is an initial rendezvous address, not a central dependency. Once a
 * client has discovered other authenticated peers and Nodes, normal relay
 * scoring and graph discovery can continue without this host.
 *
 * Runtime override via localStorage key "harmolyn:xorein:relay-multiaddrs" (JSON array of strings).
 */
export const DEFAULT_RELAY_MULTIADDRS: string[] = [
  '/dns4/node.xorein.com/tcp/9999/wss/p2p/12D3KooWGWC3A4KawRYn9Mcyt9LjDg6TS7vF5uju7v6gTFsrEBS4',
];
