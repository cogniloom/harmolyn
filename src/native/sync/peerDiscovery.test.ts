import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../identity/identity';
import {
  createSignedPeerRecord,
  ingestSignedPeerRecords,
  resetPeerDiscovery,
  verifySignedPeerRecord,
} from './peerDiscovery';

describe('hybrid signed peer discovery records', () => {
  it('binds advertised addresses to the claimed libp2p PeerID', async () => {
    const identity = await generateIdentity();
    const record = createSignedPeerRecord(
      [`/dns4/relay.example/tcp/443/wss/p2p/${identity.peerId}`],
      identity,
    )!;
    expect(verifySignedPeerRecord(record)).toEqual(record);
    expect(verifySignedPeerRecord({
      ...record,
      addresses: [`/dns4/evil.example/tcp/443/wss/p2p/${identity.peerId}`],
    })).toBeNull();
  });

  it('rejects a relayer changing the claimed peer id or replaying stale records', async () => {
    resetPeerDiscovery();
    const identity = await generateIdentity();
    const other = await generateIdentity();
    const now = Math.floor(Date.now() / 1000);
    const record = createSignedPeerRecord(['/ip4/127.0.0.1/tcp/1'], identity, now)!;
    expect(verifySignedPeerRecord({ ...record, peer_id: other.peerId }, now)).toBeNull();
    const stale = createSignedPeerRecord(['/ip4/127.0.0.1/tcp/1'], identity, now - 86_401)!;
    expect(verifySignedPeerRecord(stale, now)).toBeNull();
    expect(ingestSignedPeerRecords([record], other.peerId)).toEqual([record]);
  });
});
