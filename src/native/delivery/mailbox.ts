// xorein zero-knowledge mailbox: blinded epoch tokens + relay-framed ciphertext.
// Byte-compatible with Go oracle: pkg/v0_1/nat/store_forward.go.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

// ── Constants (must match Go oracle) ──────────────────────────────────────

const MAILBOX_EPOCH_SECONDS = 3600; // 1 hour
const DRAIN_EPOCH_SKEW = 1;         // drain current + 1 past epoch
const MAILBOX_LABEL = 'xorein/mailbox/';
const MIN_MAILBOX_SECRET = 16;

// Relay frame magic: 4 ASCII + 1 version byte = "xrn1\x01".
const RELAY_FRAME_MAGIC = new Uint8Array([0x78, 0x72, 0x6e, 0x31, 0x01]);

const CONTROL_BASE = 'https://node.xorein.com/v1';

// ── Token derivation ───────────────────────────────────────────────────────

/** Current epoch index = floor(unix_seconds / MAILBOX_EPOCH_SECONDS). */
export function mailboxEpoch(nowSeconds?: number): number {
  const t = nowSeconds ?? Math.floor(Date.now() / 1000);
  return Math.floor(t / MAILBOX_EPOCH_SECONDS);
}

/**
 * Derive the blinded mailbox token for a given secret and epoch.
 * Token = base64url_no_pad(HMAC-SHA256(mailboxSecret, "xorein/mailbox/" + epoch)).
 * Matches Go MailboxToken.
 */
export function mailboxToken(mailboxSecret: Uint8Array, epoch: number): string {
  if (mailboxSecret.length < MIN_MAILBOX_SECRET) return '';
  const label = new TextEncoder().encode(MAILBOX_LABEL + epoch.toString());
  const mac = hmac(sha256, mailboxSecret, label);
  return base64urlNoPad(mac);
}

/** Token for the current epoch (used by senders). */
export function currentMailboxToken(mailboxSecret: Uint8Array): string {
  return mailboxToken(mailboxSecret, mailboxEpoch());
}

/**
 * Derive all tokens a recipient should drain (current + DRAIN_EPOCH_SKEW past epochs).
 * Matches Go DrainMailboxTokens.
 */
export function drainMailboxTokens(mailboxSecret: Uint8Array): string[] {
  if (mailboxSecret.length < MIN_MAILBOX_SECRET) return [];
  const cur = mailboxEpoch();
  const tokens: string[] = [];
  for (let e = cur; e >= cur - DRAIN_EPOCH_SKEW; e--) {
    tokens.push(mailboxToken(mailboxSecret, e));
  }
  return tokens;
}

// ── Relay frame ────────────────────────────────────────────────────────────

/** Prepend the relay frame magic to ciphertext. Relay checks for opacity. */
export function wrapRelayBody(ciphertext: Uint8Array): Uint8Array {
  const out = new Uint8Array(RELAY_FRAME_MAGIC.length + ciphertext.length);
  out.set(RELAY_FRAME_MAGIC, 0);
  out.set(ciphertext, RELAY_FRAME_MAGIC.length);
  return out;
}

/** Strip the relay frame header, returning raw ciphertext. Throws on bad magic. */
export function unwrapRelayBody(framed: Uint8Array): Uint8Array {
  if (framed.length < RELAY_FRAME_MAGIC.length) throw new Error('relay body: too short');
  for (let i = 0; i < RELAY_FRAME_MAGIC.length; i++) {
    if (framed[i] !== RELAY_FRAME_MAGIC[i]) throw new Error('relay body: invalid frame magic');
  }
  return framed.subarray(RELAY_FRAME_MAGIC.length);
}

// ── HTTP mailbox client ────────────────────────────────────────────────────

/**
 * Store a delivery in the relay mailbox.
 * token = blinded epoch token (from currentMailboxToken).
 * ciphertext = raw encrypted message bytes (will be wrapped with relay frame).
 */
export async function mailboxStore(token: string, ciphertext: Uint8Array): Promise<void> {
  const framed = wrapRelayBody(ciphertext);
  const body_b64 = base64urlNoPad(framed);
  const res = await fetch(`${CONTROL_BASE}/mailbox/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, body: body_b64 }),
  });
  if (!res.ok && res.status !== 204) throw new Error(`mailbox store: ${res.status}`);
}

/**
 * Drain deliveries from the relay mailbox for the given tokens.
 * Returns raw ciphertext bytes (relay frame stripped).
 */
export async function mailboxDrain(tokens: string[]): Promise<Uint8Array[]> {
  if (tokens.length === 0) return [];
  const res = await fetch(`${CONTROL_BASE}/mailbox/drain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokens }),
  });
  if (!res.ok) throw new Error(`mailbox drain: ${res.status}`);
  const data = await res.json() as { bodies: string[] };
  return (data.bodies ?? []).map(b => unwrapRelayBody(base64urlDecode(b)));
}

// ── High-level offline delivery ────────────────────────────────────────────

/**
 * Deliver an encrypted message to a recipient.
 * If the recipient's P2P peer is available, dials directly (not yet implemented here;
 * this function handles the relay fallback path for offline delivery).
 */
export async function deliverOffline(
  mailboxSecret: Uint8Array,
  ciphertext: Uint8Array,
): Promise<void> {
  const token = currentMailboxToken(mailboxSecret);
  if (!token) throw new Error('mailbox secret too short');
  await mailboxStore(token, ciphertext);
}

/** Drain pending deliveries for this identity's mailbox secret. */
export async function drainDeliveries(mailboxSecret: Uint8Array): Promise<Uint8Array[]> {
  const tokens = drainMailboxTokens(mailboxSecret);
  return mailboxDrain(tokens);
}

// ── Utilities ──────────────────────────────────────────────────────────────

function base64urlNoPad(b: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...b));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(s: string): Uint8Array {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  return new Uint8Array([...atob(padded)].map(c => c.charCodeAt(0)));
}
