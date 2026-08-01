import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../identity/identity';
import {
  createForwardSecureInviteCapability,
  createSignedInviteCapability,
  openForwardSecureInviteTransition,
  verifySignedInviteCapability,
} from './invite';
import { buildJoinDeepLink, parseInviteMetadata } from '../../protocol/deeplink';
import { signServerRecord, verifyServerRecord } from './signedServer';
import type { XoreinRuntimeServer } from '../../types';

describe('portable signed invite capabilities', () => {
  it('can be verified by a member without the owner secret', async () => {
    const owner = await generateIdentity();
    const token = createSignedInviteCapability('srv', 4, 60_000, owner);
    expect(verifySignedInviteCapability(token, 'srv', owner.peerId, 4)).toMatchObject({
      v: 2,
      server_id: 'srv',
      owner_peer_id: owner.peerId,
      generation: 4,
    });
    expect(verifySignedInviteCapability(token, 'other', owner.peerId, 4)).toBeNull();
    expect(verifySignedInviteCapability(token, 'srv', owner.peerId, 5)).toBeNull();
    const link = buildJoinDeepLink('srv', owner.peerId, 'S', token, ['12D3KooWSeedSeedSeedSeed']);
    expect(link.length).toBeLessThanOrEqual(16_384);
    expect(parseInviteMetadata(link).inviteToken).toBe(token);
  });

  it('rejects expired and modified capabilities', async () => {
    const owner = await generateIdentity();
    const token = createSignedInviteCapability('srv', 1, 60_000, owner);
    const decoded = verifySignedInviteCapability(token, 'srv', owner.peerId, 1)!;
    expect(verifySignedInviteCapability(
      token, 'srv', owner.peerId, 1, decoded.expires_at + 1,
    )).toBeNull();
    const last = token.at(-1)!;
    const changed = token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(verifySignedInviteCapability(changed, 'srv', owner.peerId, 1)).toBeNull();
  });

  it('seals an exact owner-authorized next epoch from the invite bearer', async () => {
    const owner = await generateIdentity();
    const current: XoreinRuntimeServer = {
      id: 'srv',
      name: 'Forward secure',
      owner_peer_id: owner.peerId,
      members: [owner.peerId],
      channels: {},
      crowd_root: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
      crowd_epoch: 4,
      server_rev: 8,
      invite_generation: 2,
      channel_security_mode: 'tree',
      channel_crypto_profile: 'scope-aad-v2',
      manifest: { security_mode: 'tree' },
    };
    current.owner_proof = signServerRecord(current, owner);
    const next: XoreinRuntimeServer = {
      ...current,
      crowd_root: btoa(String.fromCharCode(...new Uint8Array(32).fill(2))),
      crowd_epoch: 5,
      server_rev: 9,
      invite_generation: 3,
      updated_at: '2026-08-01T12:00:00.000Z',
      channel_security_mode: 'crowd',
      manifest: { security_mode: 'crowd' },
    };
    const token = createForwardSecureInviteCapability(current, next, 60_000, owner);
    const capability = verifySignedInviteCapability(token, 'srv', owner.peerId, 2);
    expect(capability?.v).toBe(3);
    if (!capability || capability.v !== 3) throw new Error('missing v3 capability');
    const opened = openForwardSecureInviteTransition(current, capability);
    expect(opened?.crowd_root).toBe(next.crowd_root);
    expect(opened?.crowd_epoch).toBe(5);
    expect(opened?.owner_proof?.version).toBe(3);
    expect(opened && verifyServerRecord(opened)).toBe(true);

    const link = buildJoinDeepLink('srv', owner.peerId, 'S', token, [owner.peerId]);
    expect(link.length).toBeLessThanOrEqual(16_384);
    expect(parseInviteMetadata(link).inviteToken).toBe(token);

    // A bearer can verify the authorization but cannot open it without the
    // verified current epoch root held by an existing member.
    expect(openForwardSecureInviteTransition({
      ...current,
      crowd_root: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
    }, capability)).toBeNull();
  });
});
