// Opaque, content-authenticated history replicas for untrusted storage nodes.
//
// A node learns only a random-looking per-channel namespace, timing/size hints,
// and mode-explicit channel ciphertext. After decryption the client accepts the record solely
// when the original author's hybrid signature verifies. Storage acknowledgments
// are availability evidence, never truth.
import { sha256 } from '@noble/hashes/sha2.js';
import type { XoreinRuntimeMessage } from '../../types.js';
import { decodeBase64Strict, hasControlCharacters, isPlainObject } from '../security/limits.js';
import { getState } from '../state/store.js';
import { decryptChannelReplica, encryptChannelReplica } from './secureEnvelope.js';
import { verifySignedHistoryMessage } from './signedHistory.js';

const NAMESPACE_DOMAIN = new TextEncoder().encode('xorein/history-replica-namespace/v1\n');
const MAX_REPLICA_JSON_BYTES = 512 * 1024;

export interface EncryptedHistoryReplica {
  version: 1;
  namespace: string;
  id: string;
  revision: number;
  created_at: string;
  content_hash: string;
  key_epoch: number;
  uploader_peer_id: string;
  envelope: {
    /** Missing legacy replicas were Crowd. */
    mode?: 'tree' | 'crowd';
    epoch: number;
    sndr: string;
    nonce: string;
    ct: string;
  };
}

function b64url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Derive an unguessable, stable namespace without revealing server/channel IDs. */
export function historyReplicaNamespace(serverId: string, channelId: string): string | null {
  const server = getState().servers[serverId];
  const secret = decodeBase64Strict(server?.replica_secret, 32);
  if (!server || !secret || secret.length !== 32
    || !channelId || channelId.length > 256 || hasControlCharacters(channelId)
    || server.channels[channelId]?.server_id !== serverId) return null;
  return b64url(sha256(concat(
    NAMESPACE_DOMAIN,
    secret,
    new Uint8Array([0]),
    new TextEncoder().encode(channelId),
  )));
}

function validReplica(value: unknown): value is EncryptedHistoryReplica {
  if (!isPlainObject(value)
    || value.version !== 1
    || typeof value.namespace !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(value.namespace)
    || typeof value.id !== 'string' || !value.id || value.id.length > 256
    || hasControlCharacters(value.id)
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || typeof value.created_at !== 'string' || value.created_at.length > 96
    || typeof value.content_hash !== 'string' || value.content_hash.length > 128
    || typeof value.key_epoch !== 'number' || !Number.isSafeInteger(value.key_epoch)
    || value.key_epoch < 0 || value.key_epoch > 0xffffffff
    || typeof value.uploader_peer_id !== 'string' || !value.uploader_peer_id
    || value.uploader_peer_id.length > 256 || hasControlCharacters(value.uploader_peer_id)
    || !isPlainObject(value.envelope)
    || (value.envelope.mode !== undefined
      && value.envelope.mode !== 'tree' && value.envelope.mode !== 'crowd')
    || value.envelope.sndr !== value.uploader_peer_id
    || value.envelope.epoch !== value.key_epoch) return false;
  return true;
}

/** Encrypt one author-verified message for storage by nodes. */
export function encryptHistoryReplica(
  message: XoreinRuntimeMessage,
): EncryptedHistoryReplica | null {
  const verified = verifySignedHistoryMessage(message);
  const serverId = message.server_id;
  if (!verified.ok || !serverId || message.scope_type !== 'channel') return null;
  const namespace = historyReplicaNamespace(serverId, message.scope_id);
  const uploader = getState().identity?.peer_id;
  if (!namespace || !uploader) return null;
  let plaintext: Uint8Array;
  try {
    plaintext = new TextEncoder().encode(JSON.stringify(message));
  } catch {
    return null;
  }
  if (!plaintext.length || plaintext.length > MAX_REPLICA_JSON_BYTES) return null;
  const envelope = encryptChannelReplica(serverId, uploader, plaintext);
  if (!envelope) return null;
  return {
    version: 1,
    namespace,
    id: message.id,
    revision: message.author_revision ?? 0,
    created_at: message.created_at ?? '',
    content_hash: verified.contentHash,
    key_epoch: envelope.epoch,
    uploader_peer_id: uploader,
    envelope,
  };
}

/**
 * Decrypt and authenticate a node-served replica. Every untrusted outer hint is
 * compared with the signed inner record before it can enter local history.
 */
export function decryptHistoryReplica(
  value: unknown,
  serverId: string,
  channelId: string,
): XoreinRuntimeMessage | null {
  if (!validReplica(value)) return null;
  const expectedNamespace = historyReplicaNamespace(serverId, channelId);
  if (!expectedNamespace || value.namespace !== expectedNamespace) return null;
  const plaintext = decryptChannelReplica(serverId, value.envelope);
  if (!plaintext || plaintext.length > MAX_REPLICA_JSON_BYTES) return null;
  let message: XoreinRuntimeMessage;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    if (!isPlainObject(decoded)) return null;
    message = decoded as unknown as XoreinRuntimeMessage;
  } catch {
    return null;
  }
  const verified = verifySignedHistoryMessage(message);
  if (!verified.ok
    || message.server_id !== serverId
    || message.scope_type !== 'channel'
    || message.scope_id !== channelId
    || message.id !== value.id
    || (message.author_revision ?? 0) !== value.revision
    || (message.created_at ?? '') !== value.created_at
    || verified.contentHash !== value.content_hash) return null;
  return message;
}
