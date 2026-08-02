/**
 * Build-time defaults for the xorein runtime.
 *
 * This is an initial rendezvous address, not a central dependency. Once a
 * client has discovered other authenticated peers and Nodes, normal relay
 * scoring and graph discovery can continue without this host.
 *
 * Runtime override via localStorage key "harmolyn:xorein:relay-multiaddrs" (JSON array of strings).
 */
export const DEFAULT_RELAY_PEER_ID = (
  import.meta.env.VITE_RELAY_PEER_ID?.trim()
  || '12D3KooWAe9by8oYTkvAoTKndPNTVX9mMeor4xwyvX7zsbSC1kVM'
);

export const DEFAULT_RELAY_MULTIADDR = (
  import.meta.env.VITE_RELAY_MULTIADDR?.trim()
  || `/dns4/node.xorein.com/tcp/9999/wss/p2p/${DEFAULT_RELAY_PEER_ID}`
);

export const DEFAULT_RELAY_MULTIADDRS: string[] = [DEFAULT_RELAY_MULTIADDR];
