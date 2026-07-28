// Secure-envelope glue between the live data path (mutations.ts / inbound.ts)
// and the E2EE session managers (SealSessions / ChannelCrypto).
//
// The engine registers the active managers on start; send/receive call through
// here. If encryption is unavailable, the encrypt helpers return null and the
// caller keeps the message LOCAL — they must never fall back to plaintext on the
// wire. This is the single chokepoint that guarantees no cleartext leaves the
// device for channel/DM message bodies.
import { SealSessions, type SealWire, type FetchBundle } from '../seal/session.js';
import { ChannelCrypto, type CrowdWire } from '../crowd/channel.js';
import { getState } from '../state/store.js';
import type { XoreinAttachment } from '../../types.js';

/** Decrypted chat content: text body + any E2EE attachments. */
export interface DecryptedMessage {
  body: string;
  media?: XoreinAttachment[];
  /**
   * The mode this message was actually decrypted under. Present only on messages
   * that were genuinely E2EE (seal for DMs, crowd for channels); the caller stamps
   * it onto the stored message so the UI badge reflects real encryption.
   */
  mode?: 'seal' | 'crowd';
}

/**
 * The plaintext that actually gets sealed is a small JSON envelope so attachment
 * keys travel end-to-end with the message (never as a separate cleartext field).
 */
function encodePlaintext(body: string, media?: XoreinAttachment[]): string {
  return JSON.stringify(media && media.length ? { b: body, a: media } : { b: body });
}

function decodePlaintext(s: string): DecryptedMessage {
  try {
    const obj = JSON.parse(s) as { b?: unknown; a?: unknown };
    if (obj && typeof obj === 'object' && typeof obj.b === 'string') {
      return { body: obj.b, ...(Array.isArray(obj.a) ? { media: obj.a as XoreinAttachment[] } : {}) };
    }
  } catch { /* not our JSON — treat as a legacy raw body */ }
  return { body: s };
}

interface ScopeCrypto {
  seal: SealSessions;
  channels: ChannelCrypto;
  fetchBundle: FetchBundle;
}

let _crypto: ScopeCrypto | null = null;

export function registerScopeCrypto(c: ScopeCrypto): void {
  _crypto = c;
}

export function resetScopeCrypto(): void {
  _crypto = null;
}

export function getScopeCrypto(): ScopeCrypto | null {
  return _crypto;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function rootBytesForServer(serverId: string): Uint8Array | null {
  const server = getState().servers[serverId];
  const rootB64 = (server as { crowd_root?: string } | undefined)?.crowd_root;
  if (!rootB64) return null;
  try {
    const bin = atob(rootB64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length === 32 ? out : null;
  } catch {
    return null;
  }
}

/** The owner-authoritative Crowd epoch for a server (0 when absent/legacy). */
function crowdEpochForServer(serverId: string): number {
  const server = getState().servers[serverId] as { crowd_epoch?: number } | undefined;
  const e = server?.crowd_epoch;
  return typeof e === 'number' && e >= 0 ? e : 0;
}

/**
 * Install the server's CURRENT (root, epoch) into the live ChannelCrypto. Called
 * on every send/receive (a seed or a no-op) and after the owner rotates so the
 * new epoch takes effect immediately. Returns false when no crypto/root is available.
 */
function seedChannelRoot(serverId: string): boolean {
  if (!_crypto) return false;
  const root = rootBytesForServer(serverId);
  if (!root) return false;
  _crypto.channels.setRoot(serverId, root, crowdEpochForServer(serverId));
  return true;
}

/**
 * Apply a server's current Crowd root+epoch into the live crypto. Used by the
 * rotation paths (owner kick/join) and by the member-side sync.update handler so a
 * rotated root takes effect without waiting for the next message.
 */
export function applyCrowdRoot(serverId: string): void {
  seedChannelRoot(serverId);
}

function serverIdForChannel(channelId: string): string | undefined {
  const server = Object.values(getState().servers).find(s =>
    Object.keys(s.channels ?? {}).includes(channelId),
  );
  return server?.id;
}

/**
 * The security mode a channel message for `serverId` will actually be sent under:
 * `crowd` when the shared epoch root is seeded (the message will be E2EE), else
 * `clear` — meaning encryption is impossible right now and the message can only be
 * kept local. Lets the send path stamp the true mode on the stored message without
 * re-deriving root availability.
 */
export function channelSecurityMode(serverId: string): 'crowd' | 'clear' {
  return rootBytesForServer(serverId) ? 'crowd' : 'clear';
}

/**
 * Build a Seal-encrypted chat.send payload for ONE DM recipient. Returns null if
 * a session cannot be established (peer unreachable / no crypto) — caller keeps
 * the message local and retries later; it must not transmit plaintext.
 */
export async function encryptDmEnvelope(
  recipientPeerId: string,
  base: Record<string, unknown>,
  body: string,
  media?: XoreinAttachment[],
): Promise<Record<string, unknown> | null> {
  if (!_crypto) return null;
  try {
    const wire: SealWire = await _crypto.seal.encrypt(recipientPeerId, utf8(encodePlaintext(body, media)), _crypto.fetchBundle);
    return { ...base, enc: 'seal', seal: wire };
  } catch {
    return null;
  }
}

/**
 * Build a Crowd-encrypted chat.send payload for a channel (one ciphertext for
 * all members). Returns null if the server's shared root is not yet seeded.
 */
export function encryptChannelEnvelope(
  serverId: string,
  senderId: string,
  base: Record<string, unknown>,
  body: string,
  media?: XoreinAttachment[],
): Record<string, unknown> | null {
  if (!seedChannelRoot(serverId)) return null;
  try {
    const wire: CrowdWire = _crypto.channels.encrypt(serverId, senderId, utf8(encodePlaintext(body, media)));
    return { ...base, enc: 'crowd', crowd: wire };
  } catch {
    return null;
  }
}

/**
 * Decrypt an inbound encrypted envelope. Returns the plaintext body, or null if
 * decryption is impossible (no crypto, no key, auth failure) — the caller drops
 * the message rather than surfacing garbage.
 */
export function decryptInboundEnvelope(
  enc: string,
  payload: Record<string, unknown>,
  remotePeerId: string,
  scopeId: string,
  _scopeType: 'channel' | 'dm',
): DecryptedMessage | null {
  if (!_crypto) return null;
  try {
    if (enc === 'seal') {
      const wire = payload.seal as SealWire | undefined;
      if (!wire) return null;
      return { ...decodePlaintext(fromUtf8(_crypto.seal.decrypt(remotePeerId, wire))), mode: 'seal' };
    }
    if (enc === 'crowd') {
      const wire = payload.crowd as CrowdWire | undefined;
      if (!wire) return null;
      // SECURITY: the authenticated connection peer must be the claimed sender.
      if (wire.sndr && wire.sndr !== remotePeerId) return null;
      const serverId = (typeof payload.server_id === 'string' && payload.server_id)
        || serverIdForChannel(scopeId);
      if (!serverId) return null;
      if (!seedChannelRoot(serverId)) return null;
      return { ...decodePlaintext(fromUtf8(_crypto.channels.decrypt(serverId, wire))), mode: 'crowd' };
    }
  } catch {
    return null;
  }
  return null;
}
