import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../identity/identity';
import type { XoreinRuntimeServer } from '../../types';
import { signServerRecord, verifyServerRecord } from './signedServer';

describe('portable owner-signed server records', () => {
  it('lets an untrusted member transport structure without rewriting it', async () => {
    const owner = await generateIdentity();
    const server: XoreinRuntimeServer = {
      id: 'srv',
      name: 'Real',
      owner_peer_id: owner.peerId,
      members: [owner.peerId],
      channels: {
        general: { id: 'general', server_id: 'srv', name: 'general', voice: false },
      },
      crowd_root: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
      crowd_epoch: 3,
      replica_secret: btoa(String.fromCharCode(...new Uint8Array(32).fill(8))),
      server_rev: 9,
      invite_generation: 2,
    };
    server.owner_proof = signServerRecord(server, owner);
    expect(server.owner_proof?.version).toBe(2);
    expect(verifyServerRecord(server)).toBe(true);
    expect(verifyServerRecord({ ...server, name: 'Forged' })).toBe(false);
    expect(verifyServerRecord({ ...server, crowd_epoch: 4 })).toBe(false);
    expect(verifyServerRecord({ ...server, channel_security_mode: 'tree' })).toBe(false);
    expect(verifyServerRecord({ ...server, channel_crypto_profile: 'scope-aad-v2' })).toBe(true);
    expect(verifyServerRecord({
      ...server,
      replica_secret: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
    })).toBe(false);
    // Portable admissions may extend the effective member list without making
    // that serving member an authority over channels/keys/policy.
    expect(verifyServerRecord({ ...server, members: [...server.members, 'new-peer'] })).toBe(true);
  });
});
