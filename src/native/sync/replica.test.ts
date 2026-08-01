import { beforeEach, describe, expect, it } from 'vitest';
import { generateIdentity, identitySigningKey } from '../identity/identity';
import { ChannelCrypto } from '../crowd/channel';
import { SealSessions } from '../seal/session';
import { initStore, setNativeIdentity, addServer } from '../state/store';
import { registerScopeCrypto, resetScopeCrypto } from './secureEnvelope';
import { signChannelMessageVersion } from './signedHistory';
import {
  decryptHistoryReplica,
  encryptHistoryReplica,
  historyReplicaNamespace,
  registerReplicaIdentity,
  resetReplicaIdentity,
} from './replica';
import type { XoreinRuntimeMessage } from '../../types';

const root = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const replicaSecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe('opaque history replicas', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    resetScopeCrypto();
    resetReplicaIdentity();
  });

  it('round-trips through ciphertext and rejects node tampering', async () => {
    const identity = await generateIdentity();
    registerReplicaIdentity(identity);
    setNativeIdentity({ id: identity.peerId, peer_id: identity.peerId });
    addServer({
      id: 'srv-test',
      name: 'test',
      owner_peer_id: identity.peerId,
      members: [identity.peerId],
      crowd_root: root,
      crowd_epoch: 4,
      replica_secret: replicaSecret,
      channels: {
        channel: { id: 'channel', server_id: 'srv-test', name: 'general', voice: false },
      },
    });
    registerScopeCrypto({
      channels: new ChannelCrypto(),
      seal: new SealSessions(identity.peerId, identitySigningKey(identity)),
      fetchBundle: async () => null,
    });
    const message: XoreinRuntimeMessage = {
      id: 'message-1',
      server_id: 'srv-test',
      scope_type: 'channel',
      scope_id: 'channel',
      sender_peer_id: identity.peerId,
      body: 'the node cannot read this',
      created_at: '2026-07-30T00:00:00.000Z',
      author_revision: 0,
    };
    message.author_proof = signChannelMessageVersion(message, identity);

    const replica = encryptHistoryReplica(message)!;
    expect(replica).toBeTruthy();
    expect(JSON.stringify(replica)).not.toContain(message.body);
    expect(historyReplicaNamespace('srv-test', 'channel')).toBe(replica.namespace);
    expect(decryptHistoryReplica(replica, 'srv-test', 'channel')).toMatchObject({
      id: message.id,
      body: message.body,
    });

    expect(decryptHistoryReplica({ ...replica, revision: 1 }, 'srv-test', 'channel')).toBeNull();
    expect(decryptHistoryReplica({
      ...replica,
      envelope: { ...replica.envelope, ct: `${replica.envelope.ct.slice(0, -2)}AA` },
    }, 'srv-test', 'channel')).toBeNull();
  });
});
