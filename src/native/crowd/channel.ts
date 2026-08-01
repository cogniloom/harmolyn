// Size-aware channel E2EE manager.
//
// Small spaces use Tree's AES-GCM data plane; larger spaces use Crowd's
// sender-key ChaCha20-Poly1305 data plane. The owner distributes one fresh
// 32-byte epoch root and an explicit signed mode. Infrastructure sees only the
// resulting ciphertext. Old mode state is retained solely for the bounded
// in-flight transition window.
import {
  newCrowdGroupFromRoot,
  crowdEncrypt,
  crowdDecrypt,
  installEpochRoot as installCrowdEpochRoot,
  type CrowdState,
  type CrowdCiphertext,
} from './crowd.js';
import {
  newGroupFromRoot as newTreeGroupFromRoot,
  treeEncryptManaged,
  treeDecrypt,
  installEpochRoot as installTreeEpochRoot,
  type GroupState as TreeState,
  type Ciphertext as TreeCiphertext,
} from '../tree/tree.js';
import type { ChannelSecurityMode } from '../security/channelMode.js';

/** A mode-explicit encrypted message envelope carried inside chat.send. */
export interface ChannelWire {
  epoch: number;
  /** Authenticated sender id (also bound to the Noise connection peer on receipt). */
  sndr: string;
  nonce: string; // b64, 12 bytes
  ct: string;    // b64, AEAD ciphertext + tag
}

/** Backward-compatible name used by existing Crowd-specific tests/callers. */
export type CrowdWire = ChannelWire;

interface ServerChannelState {
  currentMode: ChannelSecurityMode;
  currentEpoch: number;
  crowd?: CrowdState;
  tree?: TreeState;
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

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export class ChannelCrypto {
  private readonly groups = new Map<string, ServerChannelState>();

  /**
   * Seed or rotate a server's channel epoch. A mode transition is accepted only
   * with a strictly newer owner-authored epoch, preventing a replay from
   * changing either the key or algorithm at the current epoch.
   */
  setRoot(
    serverId: string,
    root: Uint8Array,
    epoch = 0,
    mode: ChannelSecurityMode = 'crowd',
  ): void {
    if (root.length !== 32 || !Number.isSafeInteger(epoch) || epoch < 0) return;
    const existing = this.groups.get(serverId);
    if (existing && (epoch < existing.currentEpoch
      || (epoch === existing.currentEpoch && mode !== existing.currentMode))) return;

    if (existing && epoch === existing.currentEpoch) {
      const installedRoot = mode === 'crowd'
        ? existing.crowd?.currentEpoch.epochRoot
        : existing.tree?.rootKey;
      // A root is immutable at an epoch. Reusing the number with different key
      // material would split online and freshly-started clients.
      if (!installedRoot || !equalBytes(installedRoot, root)) return;
    }

    const state: ServerChannelState = existing ?? {
      currentMode: mode,
      currentEpoch: epoch,
    };

    if (mode === 'crowd') {
      if (!state.crowd) state.crowd = newCrowdGroupFromRoot(serverId, root, epoch);
      else installCrowdEpochRoot(state.crowd, root, epoch);
    } else {
      if (!state.tree) state.tree = newTreeGroupFromRoot(serverId, root, epoch);
      else installTreeEpochRoot(state.tree, epoch, root);
    }

    state.currentMode = mode;
    state.currentEpoch = epoch;
    // Keep an inactive algorithm only for the immediately preceding epoch.
    // Otherwise a mode used years ago could remain decryptable forever merely
    // because its own internal epoch never advanced again.
    if (mode !== 'tree' && state.tree && state.tree.currentEpoch.epochId < epoch - 1) {
      state.tree = undefined;
    }
    if (mode !== 'crowd' && state.crowd && state.crowd.currentEpoch.epochId < epoch - 1) {
      state.crowd = undefined;
    }
    this.groups.set(serverId, state);
  }

  hasRoot(serverId: string): boolean {
    return this.groups.has(serverId);
  }

  /** The owner-authored current epoch, or -1 if no channel key is installed. */
  epochOf(serverId: string): number {
    return this.groups.get(serverId)?.currentEpoch ?? -1;
  }

  modeOf(serverId: string): ChannelSecurityMode | undefined {
    return this.groups.get(serverId)?.currentMode;
  }

  encrypt(serverId: string, senderId: string, plaintext: Uint8Array): ChannelWire {
    const state = this.groups.get(serverId);
    if (!state) throw new Error(`channel: no key seeded for server ${serverId}`);
    if (state.currentMode === 'tree') {
      if (!state.tree) throw new Error(`tree: no channel key seeded for server ${serverId}`);
      const c = treeEncryptManaged(state.tree, senderId, plaintext);
      return { epoch: c.epochId, sndr: c.senderId, nonce: b64(c.nonce), ct: b64(c.ct) };
    }
    if (!state.crowd) throw new Error(`crowd: no channel key seeded for server ${serverId}`);
    const c = crowdEncrypt(state.crowd, senderId, plaintext);
    return { epoch: c.epochId, sndr: c.senderId, nonce: b64(c.nonce), ct: b64(c.ct) };
  }

  /** Decrypt under the explicit wire mode; no algorithm guessing is allowed. */
  decrypt(
    serverId: string,
    wire: ChannelWire,
    mode?: ChannelSecurityMode,
  ): Uint8Array {
    const state = this.groups.get(serverId);
    if (!state) throw new Error(`channel: no key seeded for server ${serverId}`);
    const selected = mode ?? state.currentMode;
    if (!Number.isSafeInteger(wire.epoch) || wire.epoch < 0 || typeof wire.sndr !== 'string'
      || !wire.sndr || typeof wire.nonce !== 'string' || typeof wire.ct !== 'string') {
      throw new Error('channel: invalid ciphertext');
    }
    if (selected === state.currentMode) {
      if (wire.epoch > state.currentEpoch || wire.epoch < state.currentEpoch - 1) {
        throw new Error('channel: ciphertext outside current transition window');
      }
    } else if (wire.epoch !== state.currentEpoch - 1) {
      throw new Error('channel: inactive mode outside transition window');
    }
    if (selected === 'tree') {
      if (!state.tree) throw new Error(`tree: no channel key seeded for server ${serverId}`);
      if (selected !== state.currentMode && state.tree.currentEpoch.epochId !== wire.epoch) {
        throw new Error('tree: inactive mode epoch mismatch');
      }
      const c: TreeCiphertext = {
        epochId: wire.epoch,
        senderId: wire.sndr,
        nonce: unb64(wire.nonce),
        ct: unb64(wire.ct),
      };
      return treeDecrypt(state.tree, c);
    }
    if (!state.crowd) throw new Error(`crowd: no channel key seeded for server ${serverId}`);
    if (selected !== state.currentMode && state.crowd.currentEpoch.epochId !== wire.epoch) {
      throw new Error('crowd: inactive mode epoch mismatch');
    }
    const c: CrowdCiphertext = {
      epochId: wire.epoch,
      senderId: wire.sndr,
      nonce: unb64(wire.nonce),
      ct: unb64(wire.ct),
    };
    return crowdDecrypt(state.crowd, c);
  }
}
