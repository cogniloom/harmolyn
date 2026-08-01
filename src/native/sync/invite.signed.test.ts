import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../identity/identity';
import {
  createSignedInviteCapability,
  verifySignedInviteCapability,
} from './invite';
import { buildJoinDeepLink, parseInviteMetadata } from '../../protocol/deeplink';

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
});
