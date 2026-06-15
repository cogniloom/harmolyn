// Channel (Crowd-mode) E2EE manager: broadcast encryption for server channels.
//
// All members of a server share a secret 32-byte epoch root distributed by the
// owner over the authenticated P2P join stream (never via the support node).
// Each member derives per-sender ChaCha20-Poly1305 keys from that root, so any
// member can encrypt a broadcast that every other member can read, while the
// relay/support node only ever sees ciphertext.
import {
  newCrowdGroupFromRoot, crowdEncrypt, crowdDecrypt,
  type CrowdState, type CrowdCiphertext,
} from './crowd.js';

/** A Crowd-encrypted message envelope carried inside the chat.send payload. */
export interface CrowdWire {
  epoch: number;
  /** Authenticated sender id (also bound to the Noise connection peer on receipt). */
  sndr: string;
  nonce: string; // b64, 12 bytes
  ct: string;    // b64, ChaCha20-Poly1305 ciphertext + tag
}

function b64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class ChannelCrypto {
  /** One Crowd group per server (all channels of a server share the root). */
  private readonly groups = new Map<string, CrowdState>();

  /**
   * Seed the shared epoch root for a server. Idempotent: the first root wins so
   * a late re-seed cannot desync an active group. `root` is the raw 32 bytes.
   */
  setRoot(serverId: string, root: Uint8Array): void {
    if (this.groups.has(serverId)) return;
    if (root.length !== 32) return;
    this.groups.set(serverId, newCrowdGroupFromRoot(serverId, root));
  }

  hasRoot(serverId: string): boolean {
    return this.groups.has(serverId);
  }

  /** Encrypt a channel message for `serverId`. Throws if no root is seeded. */
  encrypt(serverId: string, senderId: string, plaintext: Uint8Array): CrowdWire {
    const g = this.groups.get(serverId);
    if (!g) throw new Error(`crowd: no channel key seeded for server ${serverId}`);
    const c = crowdEncrypt(g, senderId, plaintext);
    return { epoch: c.epochId, sndr: c.senderId, nonce: b64(c.nonce), ct: b64(c.ct) };
  }

  /** Decrypt a channel message for `serverId`. Throws if no root / wrong key. */
  decrypt(serverId: string, wire: CrowdWire): Uint8Array {
    const g = this.groups.get(serverId);
    if (!g) throw new Error(`crowd: no channel key seeded for server ${serverId}`);
    const c: CrowdCiphertext = {
      epochId: wire.epoch,
      senderId: wire.sndr,
      nonce: unb64(wire.nonce),
      ct: unb64(wire.ct),
    };
    return crowdDecrypt(g, c);
  }
}
