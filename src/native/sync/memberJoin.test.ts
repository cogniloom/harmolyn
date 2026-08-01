import { beforeEach, describe, expect, it } from 'vitest';
import { generateIdentity } from '../identity/identity';
import {
  addServer,
  getState,
  initStore,
  setNativeIdentity,
} from '../state/store';
import { createSignedInviteCapability } from './invite';
import { handleSyncRequest } from './inbound';
import { signServerRecord, verifyServerRecord } from './signedServer';
import type { XoreinRuntimeServer } from '../../types';

describe('owner-offline member-served admission', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
  });

  it('admits an authenticated joiner only with the owner-signed capability', async () => {
    const owner = await generateIdentity();
    const member = await generateIdentity();
    const joiner = await generateIdentity();
    setNativeIdentity({ id: member.peerId, peer_id: member.peerId });

    const server: XoreinRuntimeServer = {
      id: 'srv',
      name: 'Portable',
      owner_peer_id: owner.peerId,
      members: [owner.peerId, member.peerId],
      channels: {
        general: { id: 'general', server_id: 'srv', name: 'general', voice: false },
      },
      crowd_root: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
      crowd_epoch: 2,
      server_rev: 4,
      invite_generation: 3,
      manifest: { history_retention_messages: 100, join_history_messages: 0 },
    };
    server.owner_proof = signServerRecord(server, owner);
    addServer(server);

    const capability = createSignedInviteCapability('srv', 3, 60_000, owner);
    const response = handleSyncRequest('sync.join', {
      server_id: 'srv',
      invite_token: capability,
    }, joiner.peerId);

    expect(response.ok).toBe(true);
    expect(getState().servers.srv.members).toContain(joiner.peerId);
    const served = response.server as XoreinRuntimeServer;
    expect(served.members).toContain(joiner.peerId);
    expect(verifyServerRecord(served)).toBe(true);
    expect(served.invite_secret).toBeUndefined();
  });

  it('does not let a member admit a joiner with a legacy or fabricated token', async () => {
    const owner = await generateIdentity();
    const member = await generateIdentity();
    const joiner = await generateIdentity();
    setNativeIdentity({ id: member.peerId, peer_id: member.peerId });
    const server: XoreinRuntimeServer = {
      id: 'srv',
      name: 'Portable',
      owner_peer_id: owner.peerId,
      members: [owner.peerId, member.peerId],
      channels: {},
      invite_generation: 1,
    };
    server.owner_proof = signServerRecord(server, owner);
    addServer(server);

    expect(handleSyncRequest('sync.join', {
      server_id: 'srv',
      invite_token: 'fabricated',
    }, joiner.peerId)).toEqual({ ok: false, error: 'invalid_invite' });
    expect(getState().servers.srv.members).not.toContain(joiner.peerId);
  });
});
