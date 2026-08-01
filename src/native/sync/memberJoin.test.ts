import { beforeEach, describe, expect, it } from 'vitest';
import { generateIdentity } from '../identity/identity';
import {
  addServer,
  getState,
  initStore,
  setNativeIdentity,
} from '../state/store';
import {
  createForwardSecureInviteCapability,
  createSignedInviteCapability,
} from './invite';
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
      channel_security_mode: 'tree',
      channel_crypto_profile: 'scope-aad-v2',
      server_rev: 4,
      invite_generation: 3,
      manifest: { history_retention_messages: 100, join_history_messages: 0 },
    };
    server.owner_proof = signServerRecord(server, owner);
    addServer(server);

    const next: XoreinRuntimeServer = {
      ...server,
      crowd_root: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
      crowd_epoch: 3,
      channel_security_mode: 'crowd',
      channel_crypto_profile: 'scope-aad-v2',
      server_rev: 5,
      invite_generation: 4,
      updated_at: '2026-08-01T12:00:00.000Z',
      manifest: { ...server.manifest, security_mode: 'crowd' },
    };
    const capability = createForwardSecureInviteCapability(server, next, 60_000, owner);
    expect(capability).not.toBe('');
    const response = handleSyncRequest('sync.join', {
      server_id: 'srv',
      invite_token: capability,
    }, joiner.peerId);

    expect(response.ok).toBe(true);
    expect(getState().servers.srv.members).toContain(joiner.peerId);
    const served = response.server as XoreinRuntimeServer;
    expect(served.members).toContain(joiner.peerId);
    expect(served.crowd_root).toBe(next.crowd_root);
    expect(served.crowd_root).not.toBe(server.crowd_root);
    expect(served.crowd_epoch).toBe(3);
    expect(served.invite_generation).toBe(4);
    expect(served.owner_proof?.version).toBe(3);
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

    const legacy = createSignedInviteCapability('srv', 1, 60_000, owner);
    expect(handleSyncRequest('sync.join', {
      server_id: 'srv',
      invite_token: 'fabricated',
    }, joiner.peerId)).toEqual({ ok: false, error: 'invalid_invite' });
    expect(handleSyncRequest('sync.join', {
      server_id: 'srv',
      invite_token: legacy,
    }, joiner.peerId)).toEqual({ ok: false, error: 'owner_required' });
    expect(getState().servers.srv.members).not.toContain(joiner.peerId);
  });

  it('converges a member announcement by independently opening the same transition', async () => {
    const owner = await generateIdentity();
    const local = await generateIdentity();
    const announcingMember = await generateIdentity();
    const joiner = await generateIdentity();
    setNativeIdentity({ id: local.peerId, peer_id: local.peerId });
    const server: XoreinRuntimeServer = {
      id: 'srv',
      name: 'Portable',
      owner_peer_id: owner.peerId,
      members: [owner.peerId, local.peerId, announcingMember.peerId],
      channels: {},
      crowd_root: btoa(String.fromCharCode(...new Uint8Array(32).fill(4))),
      crowd_epoch: 6,
      server_rev: 9,
      invite_generation: 2,
      channel_security_mode: 'tree',
      channel_crypto_profile: 'scope-aad-v2',
    };
    server.owner_proof = signServerRecord(server, owner);
    addServer(server);
    const next: XoreinRuntimeServer = {
      ...server,
      crowd_root: btoa(String.fromCharCode(...new Uint8Array(32).fill(5))),
      crowd_epoch: 7,
      server_rev: 10,
      invite_generation: 3,
      updated_at: '2026-08-01T12:00:00.000Z',
      channel_security_mode: 'crowd',
    };
    const capability = createForwardSecureInviteCapability(server, next, 60_000, owner);

    expect(handleSyncRequest('sync.admit', {
      server_id: server.id,
      admitted_peer_id: joiner.peerId,
      invite_token: capability,
    }, announcingMember.peerId)).toEqual({ ok: true });
    expect(getState().servers.srv.members).toContain(joiner.peerId);
    expect(getState().servers.srv.crowd_root).toBe(next.crowd_root);
    expect(verifyServerRecord(getState().servers.srv)).toBe(true);

    // The same cohort can be replayed idempotently after its generation landed.
    expect(handleSyncRequest('sync.admit', {
      server_id: server.id,
      admitted_peer_id: joiner.peerId,
      invite_token: capability,
    }, announcingMember.peerId)).toEqual({ ok: true });
  });
});
