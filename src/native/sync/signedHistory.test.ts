import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../identity/identity';
import type { XoreinRuntimeMessage } from '../../types';
import {
  canonicalJSON,
  selectNewestVerifiedVersions,
  signChannelMessageVersion,
  verifySignedHistoryMessage,
} from './signedHistory';

describe('signed channel history', () => {
  it('canonicalizes nested objects deterministically', () => {
    expect(canonicalJSON({ z: 1, a: { y: 2, x: [3, 'v'] } }))
      .toBe('{"a":{"x":[3,"v"],"y":2},"z":1}');
  });

  it('binds scope, sender, plaintext, and revision to the PeerID', async () => {
    const identity = await generateIdentity();
    const message: XoreinRuntimeMessage = {
      id: 'm-1',
      scope_type: 'channel',
      scope_id: 'c-1',
      server_id: 's-1',
      sender_peer_id: identity.peerId,
      body: 'authentic',
      created_at: '2026-07-30T12:00:00.000Z',
      author_revision: 0,
    };
    message.author_proof = signChannelMessageVersion(message, identity);
    expect(verifySignedHistoryMessage(message)).toEqual({
      ok: true,
      contentHash: message.author_proof?.content_hash,
    });

    expect(verifySignedHistoryMessage({ ...message, body: 'tampered' })).toEqual({
      ok: false,
      reason: 'hash_mismatch',
    });
    expect(verifySignedHistoryMessage({ ...message, scope_id: 'other' })).toEqual({
      ok: false,
      reason: 'hash_mismatch',
    });
  });

  it('selects a higher signed edit without trusting a provider majority', async () => {
    const identity = await generateIdentity();
    const original: XoreinRuntimeMessage = {
      id: 'm-2',
      scope_type: 'channel',
      scope_id: 'c-1',
      server_id: 's-1',
      sender_peer_id: identity.peerId,
      body: 'v0',
      created_at: '2026-07-30T12:00:00.000Z',
      author_revision: 0,
    };
    original.author_proof = signChannelMessageVersion(original, identity);
    const edited: XoreinRuntimeMessage = {
      ...original,
      body: 'v1',
      updated_at: '2026-07-30T12:01:00.000Z',
      author_revision: 1,
      author_proof: undefined,
    };
    edited.author_proof = signChannelMessageVersion(edited, identity);

    expect(selectNewestVerifiedVersions([original, original, edited]))
      .toEqual([edited]);
  });

  it('binds every attachment swarm field in proof v2', async () => {
    const identity = await generateIdentity();
    const message: XoreinRuntimeMessage = {
      id: 'm-swarm',
      scope_type: 'channel',
      scope_id: 'c-1',
      server_id: 's-1',
      sender_peer_id: identity.peerId,
      body: 'attachment',
      created_at: '2026-07-30T12:00:00.000Z',
      media: [{
        id: 'blob',
        name: 'file.bin',
        content_type: 'application/octet-stream',
        size: 1,
        key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        nonce: 'AAAAAAAAAAAAAAAA',
        content_hash: 'a'.repeat(64),
        swarm: {
          version: 1,
          blob_id: 'b'.repeat(64),
          scope_id: 'c-1',
          owner_peer_id: identity.peerId,
          ciphertext_size: 17,
          chunk_size: 64 * 1024,
          chunk_hashes: ['c'.repeat(64)],
          provider_peer_ids: ['provider-a'],
        },
      }],
    };
    message.author_proof = signChannelMessageVersion(message, identity);
    expect(message.author_proof?.version).toBe(2);
    expect(verifySignedHistoryMessage(message).ok).toBe(true);

    const tampered = structuredClone(message);
    tampered.media![0].swarm!.provider_peer_ids = ['provider-b'];
    expect(verifySignedHistoryMessage(tampered)).toEqual({
      ok: false,
      reason: 'hash_mismatch',
    });
  });
});
