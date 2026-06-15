// Module-level PeerSync registry so state/mutations can broadcast without
// a circular import (engine → mutations → engine).
import type { PeerSync } from './peersync.js';

let _peerSync: PeerSync | null = null;

export function registerPeerSync(ps: PeerSync): void {
  _peerSync = ps;
}

export function getPeerSync(): PeerSync | null {
  return _peerSync;
}
