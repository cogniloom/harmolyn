import { sha256 } from '@noble/hashes/sha2.js';
import { encodeBase64Chunked, hasControlCharacters } from '../security/limits.js';

const INBOX_EPOCH_SECONDS = 24 * 60 * 60;
const INBOX_RETENTION_EPOCHS = 7;
const INBOX_TOKEN_DOMAIN = 'xorein/recipient-inbox/v1/';

function base64urlNoPad(bytes: Uint8Array): string {
  return encodeBase64Chunked(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function recipientInboxEpoch(nowSeconds = Math.floor(Date.now() / 1000)): number {
  return Math.floor(nowSeconds / INBOX_EPOCH_SECONDS);
}

/**
 * Public routing token for a recipient and day.
 *
 * The token is not an authorization secret. Providers authorize drains against
 * the Noise-authenticated recipient PeerID, while the stored packet itself is a
 * sealed box that only that recipient can open. A public token gives every new
 * contact the same stable rendezvous key without requiring a prior handshake.
 */
export function recipientInboxToken(peerId: string, epoch: number): string {
  if (!peerId
    || peerId.length > 256
    || hasControlCharacters(peerId)
    || !Number.isSafeInteger(epoch)
    || epoch < 0) return '';
  return base64urlNoPad(
    sha256(new TextEncoder().encode(`${INBOX_TOKEN_DOMAIN}${peerId}/${epoch}`)),
  );
}

/** Current token used by senders. */
export function currentRecipientInboxToken(peerId: string): string {
  return recipientInboxToken(peerId, recipientInboxEpoch());
}

/**
 * Tokens a recipient may drain after reconnecting: today plus the preceding
 * seven days. Daily rotation bounds metadata correlation without making a
 * multi-day offline account lose durable deliveries.
 */
export function recipientInboxTokens(
  peerId: string,
  retentionEpochs = INBOX_RETENTION_EPOCHS,
): string[] {
  const count = Math.max(0, Math.min(INBOX_RETENTION_EPOCHS, Math.floor(retentionEpochs)));
  const current = recipientInboxEpoch();
  const tokens: string[] = [];
  for (let epoch = current; epoch >= current - count; epoch--) {
    const token = recipientInboxToken(peerId, epoch);
    if (token) tokens.push(token);
  }
  return tokens;
}

/** Allow a sender one day of clock skew when a provider checks placement. */
export function isCurrentRecipientInboxToken(peerId: string, token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const current = recipientInboxEpoch();
  return [-1, 0, 1].some(offset => recipientInboxToken(peerId, current + offset) === token);
}

/** A drain may only name tokens belonging to the authenticated recipient. */
export function areRecipientInboxDrainTokens(peerId: string, value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > INBOX_RETENTION_EPOCHS + 1) {
    return false;
  }
  const allowed = new Set(recipientInboxTokens(peerId));
  return value.every(token => typeof token === 'string' && allowed.has(token));
}

export const RECIPIENT_INBOX_MAX_TOKENS = INBOX_RETENTION_EPOCHS + 1;
