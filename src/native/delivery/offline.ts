// Offline store-and-forward delivery (resil-2).
//
// When a peer is unreachable for live P2P delivery, the (already E2E-encrypted)
// chat envelope is deposited in the support node's zero-knowledge mailbox and
// pulled by the recipient when it reconnects.
//
// Zero-knowledge property: the mailbox TOKEN and an additional CONTENT key are
// both derived from a PAIRWISE secret — ECDH between the two identities' keys —
// so (a) the node learns nothing (it stores opaque ciphertext under a blinded,
// hourly-rotating token), and (b) only the intended sender/recipient pair can
// compute the token, so a contact cannot drain or read another contact's
// deposits. The mailbox body is a second AES-256-GCM layer wrapping the chat
// envelope, hiding even the routing metadata (scope/sender/message ids) from the
// node — the inner Seal/Crowd ciphertext stays end-to-end encrypted regardless.
import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { peerIdFromString } from '@libp2p/peer-id';
import { ed25519SeedToX25519Scalar, ed25519PubToX25519Pub } from '../seal/curve.js';
import { deriveKey } from '../seal/kdf.js';
import { currentMailboxToken, drainMailboxTokens, mailboxStore, mailboxDrain } from './mailbox.js';
import type { XoreinIdentity } from '../identity/identity.js';

const LABEL_PAIR = 'xorein/mailbox/pair/v1/';
const LABEL_CONTENT = 'xorein/mailbox/content/v1';

/** Recover a peer's 32-byte Ed25519 public key from its libp2p peerId string. */
export function peerIdToEdPub(peerId: string): Uint8Array | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pid = peerIdFromString(peerId) as any;
    const raw: Uint8Array | undefined = pid?.publicKey?.raw ?? pid?.publicKey?.marshal?.();
    if (!raw || raw.length < 32) return null;
    return raw.slice(raw.length - 32);
  } catch {
    return null;
  }
}

/**
 * Pairwise mailbox secret = HKDF(ECDH(myIdentityX, theirIdentityX), "…/" + recipientPeerId).
 * Symmetric in the two identities; the recipientPeerId in the label gives each
 * DIRECTION its own namespace (A→B deposits use recipient=B; B→A use recipient=A).
 */
export function pairwiseMailboxSecret(
  myEdSeed: Uint8Array,
  theirEdPub: Uint8Array,
  recipientPeerId: string,
): Uint8Array {
  const myX = ed25519SeedToX25519Scalar(myEdSeed);
  const theirX = ed25519PubToX25519Pub(theirEdPub);
  const shared = x25519.getSharedSecret(myX, theirX);
  return deriveKey(shared, null, LABEL_PAIR + recipientPeerId, 32);
}

function contentKey(secret: Uint8Array): Uint8Array {
  return deriveKey(secret, null, LABEL_CONTENT, 32);
}

/** AES-256-GCM seal: output = nonce(12) || ciphertext+tag. */
function sealMailboxBody(ck: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = gcm(ck, nonce).encrypt(plaintext);
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 12);
  return out;
}

function openMailboxBody(ck: Uint8Array, blob: Uint8Array): Uint8Array {
  if (blob.length < 12 + 16) throw new Error('mailbox body too short');
  const nonce = blob.subarray(0, 12);
  const ct = blob.subarray(12);
  return gcm(ck, nonce).decrypt(ct);
}

// ── Registry (engine sets the active identity) ───────────────────────────────

let _identity: XoreinIdentity | null = null;

export function registerOfflineIdentity(identity: XoreinIdentity): void {
  _identity = identity;
}

export function resetOfflineIdentity(): void {
  _identity = null;
}

// ── Sender: deposit an undelivered chat envelope ─────────────────────────────

/**
 * Deposit an (already E2E-encrypted) chat envelope for an offline recipient.
 * Returns true on a successful mailbox store. Never sends plaintext: the body is
 * double-sealed and the node only ever holds opaque ciphertext.
 */
export async function depositOfflineChat(
  recipientPeerId: string,
  envelope: Record<string, unknown>,
): Promise<boolean> {
  if (!_identity) return false;
  const theirEd = peerIdToEdPub(recipientPeerId);
  if (!theirEd) return false;
  const secret = pairwiseMailboxSecret(_identity.edSeed, theirEd, recipientPeerId);
  const token = currentMailboxToken(secret);
  if (!token) return false;
  const body = sealMailboxBody(contentKey(secret), new TextEncoder().encode(JSON.stringify(envelope)));
  try {
    await mailboxStore(token, body);
    return true;
  } catch {
    return false;
  }
}

// ── Recipient: drain pending chat for known contacts ─────────────────────────

/**
 * Drain mailbox deposits from each known contact and hand the recovered chat
 * envelope to `ingest` (which re-runs the authenticated inbound chat path with
 * the contact as the verified sender). Returns the number of messages ingested.
 */
export async function drainOfflineChat(
  contactPeerIds: Iterable<string>,
  ingest: (envelope: Record<string, unknown>, fromPeerId: string) => void,
): Promise<number> {
  if (!_identity) return 0;
  const me = _identity.peerId;
  let count = 0;
  for (const contact of new Set(contactPeerIds)) {
    if (!contact || contact === me) continue;
    const theirEd = peerIdToEdPub(contact);
    if (!theirEd) continue;
    // recipient = me: matches the token the contact used when depositing for me.
    const secret = pairwiseMailboxSecret(_identity.edSeed, theirEd, me);
    let blobs: Uint8Array[];
    try {
      blobs = await mailboxDrain(drainMailboxTokens(secret));
    } catch {
      continue;
    }
    const ck = contentKey(secret);
    for (const blob of blobs) {
      try {
        const envelope = JSON.parse(new TextDecoder().decode(openMailboxBody(ck, blob))) as Record<string, unknown>;
        ingest(envelope, contact);
        count++;
      } catch {
        /* not for us / corrupt — skip */
      }
    }
  }
  return count;
}
