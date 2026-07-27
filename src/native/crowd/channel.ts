// Channel (Crowd-mode) E2EE manager: broadcast encryption for server channels.
//
// All members of a server share a secret 32-byte epoch root distributed by the
// owner over the authenticated P2P join stream (never via the support node).
// Each member derives per-sender ChaCha20-Poly1305 keys from that root, so any
// member can encrypt a broadcast that every other member can read, while the
// relay/support node only ever sees ciphertext.
import {
  newCrowdGroupFromRoot, crowdEncrypt, crowdDecrypt, installEpochRoot,
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
   * Seed or ROTATE the shared epoch root for a server.
   *
   * `epoch` is the owner-authoritative epoch number carried alongside the root:
   *   • first seed (no group yet)          → create the group at `epoch`.
   *   • strictly-newer epoch (a rotation)  → install the new root as current,
   *     retaining the previous epoch in the legacy window so in-flight messages
   *     still decrypt. THIS is what makes a kick actually revoke keys: a removed
   *     member never receives the new (root, epoch), so they cannot decrypt any
   *     traffic at the new epoch.
   *   • same-or-older epoch                → ignored (idempotent, no rollback).
   *
   * Previously this was first-root-wins, which silently dropped every rotation.
   */
  setRoot(serverId: string, root: Uint8Array, epoch = 0): void {
    if (root.length !== 32) return;
    const existing = this.groups.get(serverId);
    if (!existing) {
      this.groups.set(serverId, newCrowdGroupFromRoot(serverId, root, epoch));
      return;
    }
    installEpochRoot(existing, root, epoch);
  }

  hasRoot(serverId: string): boolean {
    return this.groups.has(serverId);
  }

  /** The installed epoch for a server's channel group, or -1 if none seeded. */
  epochOf(serverId: string): number {
    return this.groups.get(serverId)?.currentEpoch.epochId ?? -1;
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
