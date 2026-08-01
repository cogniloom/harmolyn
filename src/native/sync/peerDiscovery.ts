// Hybrid-signed peer records for browser/node peer exchange.
//
// A peer may gossip somebody else's record but cannot alter its addresses or
// claimed PeerID. Dialing still performs libp2p Noise authentication; records are
// address hints, never data-authority grants.
import type { XoreinIdentity } from '../identity/identity.js';
import { identitySigningKey } from '../identity/identity.js';
import { hybridSign, hybridVerify, HYBRID_SIG_BYTES } from '../crypto/hybrid.js';
import { peerIdToEdPub } from '../delivery/offline.js';
import { hasControlCharacters } from '../security/limits.js';
import { canonicalJSON } from './signedHistory.js';

const MAX_RECORD_AGE_SECONDS = 24 * 60 * 60;
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const records = new Map<string, SignedPeerRecord>();
let activeIdentity: XoreinIdentity | null = null;
let localRecord: SignedPeerRecord | null = null;

export interface SignedPeerRecord {
  peer_id: string;
  addresses: string[];
  /** Go encoding/json-compatible standard base64. */
  signing_public_key: string;
  /** Go encoding/json-compatible standard base64. */
  mldsa65_public_key: string;
  signed_at: number;
  /** base64url-no-pad hybrid signature. */
  signature: string;
  /** Legacy wire alias accepted on input. */
  addrs?: string[];
}

export function registerPeerDiscoveryIdentity(identity: XoreinIdentity): void {
  activeIdentity = identity;
}

export function resetPeerDiscovery(): void {
  activeIdentity = null;
  localRecord = null;
  records.clear();
}

function b64(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

function unb64(value: unknown, expected: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length > 4096
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const raw = atob(value);
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    return bytes.length === expected && b64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(value: unknown, expected: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length > 24 * 1024
    || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      + (value.length % 4 ? '='.repeat(4 - value.length % 4) : '');
    const raw = atob(padded);
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    return bytes.length === expected && b64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function normalizedAddresses(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const out: string[] = [];
  for (const address of value) {
    if (typeof address !== 'string' || !address || address.length > 512
      || hasControlCharacters(address)) return null;
    out.push(address);
  }
  return out;
}

function canonical(record: Omit<SignedPeerRecord, 'signature' | 'addrs'>): Uint8Array {
  // Byte-for-byte compatible with Go discovery.PeerRecordCanonicalBytes:
  // sorted JSON keys and []byte fields represented as standard-base64 strings.
  return new TextEncoder().encode(canonicalJSON({
    peer_id: record.peer_id,
    addresses: record.addresses,
    signing_public_key: record.signing_public_key,
    mldsa65_public_key: record.mldsa65_public_key,
    signed_at: record.signed_at,
  }));
}

export function createSignedPeerRecord(
  addresses: string[],
  identity: XoreinIdentity | null = activeIdentity,
  signedAt = Math.floor(Date.now() / 1000),
): SignedPeerRecord | null {
  const normalized = normalizedAddresses(addresses);
  if (!identity || !normalized) return null;
  const unsigned: Omit<SignedPeerRecord, 'signature' | 'addrs'> = {
    peer_id: identity.peerId,
    addresses: normalized,
    signing_public_key: b64(identity.edPub),
    mldsa65_public_key: b64(identity.mldsaPub),
    signed_at: signedAt,
  };
  return {
    ...unsigned,
    signature: b64url(hybridSign(canonical(unsigned), identitySigningKey(identity))),
  };
}

export function refreshLocalPeerRecord(addresses: string[]): SignedPeerRecord | null {
  const record = createSignedPeerRecord([...new Set(addresses)]);
  if (!record) return null;
  localRecord = record;
  records.set(record.peer_id, record);
  return record;
}

export function verifySignedPeerRecord(
  value: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): SignedPeerRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Partial<SignedPeerRecord>;
  const addresses = normalizedAddresses(
    Array.isArray(input.addresses) ? input.addresses : input.addrs,
  );
  if (!addresses
    || typeof input.peer_id !== 'string' || !input.peer_id || input.peer_id.length > 256
    || !Number.isSafeInteger(input.signed_at)
    || Number(input.signed_at) < nowSeconds - MAX_RECORD_AGE_SECONDS
    || Number(input.signed_at) > nowSeconds + MAX_FUTURE_SKEW_SECONDS
    || typeof input.signing_public_key !== 'string'
    || typeof input.mldsa65_public_key !== 'string'
    || typeof input.signature !== 'string') return null;
  const ed = unb64(input.signing_public_key, 32);
  const ml = unb64(input.mldsa65_public_key, 1952);
  const signature = unb64url(input.signature, HYBRID_SIG_BYTES);
  const peerEd = peerIdToEdPub(input.peer_id);
  if (!ed || !ml || !signature || !peerEd || !equal(ed, peerEd)) return null;
  const record: SignedPeerRecord = {
    peer_id: input.peer_id,
    addresses,
    signing_public_key: input.signing_public_key,
    mldsa65_public_key: input.mldsa65_public_key,
    signed_at: input.signed_at,
    signature: input.signature,
  };
  return hybridVerify(canonical(record), signature, {
    edPublic: ed,
    mldsaPublic: ml,
  }) ? record : null;
}

export function ingestSignedPeerRecords(values: unknown[], selfPeerId?: string): SignedPeerRecord[] {
  const accepted: SignedPeerRecord[] = [];
  for (const value of values.slice(0, 50)) {
    const record = verifySignedPeerRecord(value);
    if (!record || record.peer_id === selfPeerId) continue;
    const current = records.get(record.peer_id);
    if (!current || record.signed_at > current.signed_at
      || (record.signed_at === current.signed_at && record.signature === current.signature)) {
      records.set(record.peer_id, record);
      accepted.push(record);
    }
  }
  return accepted;
}

export function knownSignedPeerRecords(exclude: ReadonlySet<string> = new Set()): SignedPeerRecord[] {
  const now = Math.floor(Date.now() / 1000);
  const out: SignedPeerRecord[] = [];
  for (const record of records.values()) {
    if (exclude.has(record.peer_id)) continue;
    if (record.signed_at < now - MAX_RECORD_AGE_SECONDS) {
      records.delete(record.peer_id);
      continue;
    }
    out.push(record);
    if (out.length >= 50) break;
  }
  if (localRecord && !exclude.has(localRecord.peer_id)
    && !out.some(record => record.peer_id === localRecord!.peer_id)) {
    out.unshift(localRecord);
  }
  return out.slice(0, 50);
}
