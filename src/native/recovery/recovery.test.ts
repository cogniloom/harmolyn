import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerSync } from '../sync/peersync.js';
import { installFakeIndexedDB, resetFakeIndexedDB } from '../identity/fakeIndexedDB.testutil.js';
import { encodeBase64Chunked } from '../security/limits.js';

const depositRecipientInboxOperation = vi.hoisted(() => vi.fn());

vi.mock('../delivery/recipientInbox.js', () => ({
  depositRecipientInboxOperation,
}));

import {
  buildRecoveryStateTransfer,
  distributeRecovery,
  handleRecoveryStore,
  handleRecoveryStoreChunk,
  sendRecoveryRequest,
} from './recovery.js';
import { PROTOCOLS, RECOVERY_OPS } from '../families/families.js';
import { getCustody } from './custody.js';

installFakeIndexedDB();

function peerSyncWith(response: unknown): PeerSync {
  return {
    requestPeer: vi.fn().mockResolvedValue(response),
  } as unknown as PeerSync;
}

describe('durable social recovery delivery', () => {
  beforeEach(() => {
    depositRecipientInboxOperation.mockReset();
    resetFakeIndexedDB();
  });

  it('reports a live guardian as delivered without creating provider copies', async () => {
    const peerSync = peerSyncWith({ ok: true });
    const result = await distributeRecovery(peerSync, ['guardian-1'], 'Alice', { v: 1 });

    expect(result).toEqual({
      delivered: ['guardian-1'],
      queued: [],
      identityOnly: [],
      failed: [],
    });
    expect(depositRecipientInboxOperation).not.toHaveBeenCalled();
  });

  it('seals and replicates a custody update when the guardian is offline', async () => {
    const peerSync = peerSyncWith(null);
    depositRecipientInboxOperation.mockResolvedValue(true);

    const result = await distributeRecovery(peerSync, ['guardian-1'], 'Alice', { v: 1 });

    expect(result.queued).toEqual(['guardian-1']);
    expect(result.failed).toEqual([]);
    expect(depositRecipientInboxOperation).toHaveBeenCalledWith(
      'guardian-1',
      PROTOCOLS.recovery,
      RECOVERY_OPS.store,
      { owner_display_name: 'Alice', blob: { v: 1 } },
    );
  });

  it('reports identity-only when the base queues but a state fragment does not', async () => {
    const peerSync = peerSyncWith(null);
    depositRecipientInboxOperation
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const state = {
      v: 1 as const,
      nonce: '00'.repeat(12),
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(16))),
    };

    const result = await distributeRecovery(peerSync, ['guardian-1'], 'Alice', { v: 1 }, state);

    expect(result.queued).toEqual(['guardian-1']);
    expect(result.identityOnly).toEqual(['guardian-1']);
    expect(depositRecipientInboxOperation).toHaveBeenCalledTimes(3);
    expect(depositRecipientInboxOperation.mock.calls[1]?.[3]).toMatchObject({
      owner_display_name: 'Alice',
      blob: { v: 1 },
      state_manifest: { version: 1, chunk_count: 1 },
    });
    expect(depositRecipientInboxOperation.mock.calls[2]?.slice(0, 3)).toEqual([
      'guardian-1',
      PROTOCOLS.recovery,
      RECOVERY_OPS.storeChunk,
    ]);
  });

  it('queues every encrypted state fragment after the full packet exceeds its bound', async () => {
    const peerSync = peerSyncWith(null);
    depositRecipientInboxOperation.mockResolvedValueOnce(false).mockResolvedValue(true);
    const state = {
      v: 1 as const,
      nonce: '00'.repeat(12),
      ciphertext: encodeBase64Chunked(new Uint8Array(700_000)),
    };

    const result = await distributeRecovery(peerSync, ['guardian-1'], 'Alice', { v: 1 }, state);

    expect(result.queued).toEqual(['guardian-1']);
    expect(result.identityOnly).toEqual([]);
    const transfer = buildRecoveryStateTransfer(state);
    expect(transfer?.chunks.length).toBeGreaterThan(1);
    expect(depositRecipientInboxOperation).toHaveBeenCalledTimes(2 + (transfer?.chunks.length ?? 0));
  });

  it('reassembles out-of-order encrypted fragments into durable guardian custody', async () => {
    const state = {
      v: 1 as const,
      nonce: '00'.repeat(12),
      ciphertext: encodeBase64Chunked(new Uint8Array(700_000)),
    };
    const transfer = buildRecoveryStateTransfer(state);
    expect(transfer).not.toBeNull();
    await handleRecoveryStore({
      owner_display_name: 'Alice',
      blob: { v: 1 },
      state_manifest: transfer!.manifest,
    }, 'owner-1');

    for (let index = transfer!.chunks.length - 1; index >= 0; index--) {
      const response = await handleRecoveryStoreChunk({
        state_manifest: transfer!.manifest,
        chunk_index: index,
        chunk: transfer!.chunks[index],
      }, 'owner-1');
      expect(response.ok).toBe(true);
    }

    await expect(getCustody('owner-1')).resolves.toMatchObject({ state });
  });

  it('rejects a same-size fragment whose authenticated manifest hash no longer matches', async () => {
    const state = {
      v: 1 as const,
      nonce: '00'.repeat(12),
      ciphertext: encodeBase64Chunked(new Uint8Array(500_000)),
    };
    const transfer = buildRecoveryStateTransfer(state)!;
    await handleRecoveryStore({ blob: { v: 1 }, state_manifest: transfer.manifest }, 'owner-1');
    const tampered = [...transfer.chunks];
    const first = tampered[0];
    tampered[0] = `${first[0] === 'A' ? 'B' : 'A'}${first.slice(1)}`;
    let last: Record<string, unknown> = {};
    for (let index = 0; index < tampered.length; index++) {
      last = await handleRecoveryStoreChunk({
        state_manifest: transfer.manifest,
        chunk_index: index,
        chunk: tampered[index],
      }, 'owner-1');
    }
    expect(last).toMatchObject({ ok: false, error: 'invalid_state_hash' });
    const custody = await getCustody('owner-1');
    expect(custody?.state).toBeUndefined();
  });

  it('preserves the last complete snapshot while a chunked refresh is incomplete', async () => {
    const previousState = {
      v: 1 as const,
      nonce: '00'.repeat(12),
      ciphertext: encodeBase64Chunked(new Uint8Array(16).fill(1)),
    };
    const refreshedState = {
      v: 1 as const,
      nonce: '11'.repeat(12),
      ciphertext: encodeBase64Chunked(new Uint8Array(700_000)),
    };
    const transfer = buildRecoveryStateTransfer(refreshedState)!;

    await handleRecoveryStore({ blob: { v: 1 }, state: previousState }, 'owner-1');
    await handleRecoveryStore({
      blob: { v: 2 },
      state_manifest: transfer.manifest,
    }, 'owner-1');

    await expect(getCustody('owner-1')).resolves.toMatchObject({
      blob: { v: 2 },
      state: previousState,
    });
  });

  it('queues a recovery request for an offline guardian', async () => {
    const peerSync = peerSyncWith(null);
    depositRecipientInboxOperation.mockResolvedValue(true);

    await expect(sendRecoveryRequest(peerSync, 'guardian-1', 'owner-1')).resolves.toEqual({
      ok: true,
      pending: true,
      queued: true,
    });
    expect(depositRecipientInboxOperation).toHaveBeenCalledWith(
      'guardian-1',
      PROTOCOLS.recovery,
      RECOVERY_OPS.request,
      { owner_peer_id: 'owner-1' },
    );
  });
});
