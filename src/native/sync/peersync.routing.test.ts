import { describe, expect, it, vi } from 'vitest';
import type { Libp2p } from 'libp2p';
import { PeerSync } from './peersync';
import type { RoutedRequest } from './routedRequest';

function connection(peerId: string, address: string) {
  return {
    status: 'open',
    remotePeer: { toString: () => peerId },
    remoteAddr: { toString: () => address },
  };
}

describe('PeerSync routed fan-out', () => {
  it('uses a healthy next hop without waiting for a silent direct target', async () => {
    const sync = new PeerSync();
    sync.setNode({
      peerId: { toString: () => 'router-local' },
      getConnections: () => [
        connection('target-peer', '/webrtc/p2p/target-peer'),
        connection('helper-peer', '/webrtc/p2p/helper-peer'),
      ],
    } as unknown as Libp2p);

    const never = new Promise<null>(() => {});
    const sendRouteHop = vi.fn((address: string) => (
      address.includes('target-peer')
        ? never
        : Promise.resolve({ ok: true, response_ciphertext: 'sealed-answer' })
    ));
    (sync as unknown as {
      sendRouteHop: typeof sendRouteHop;
    }).sendRouteHop = sendRouteHop;

    const request = {
      version: 1,
      id: 'route-1',
      origin_peer_id: 'origin-peer',
      target_peer_id: 'target-peer',
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + 30_000,
      max_hops: 6,
      ciphertext: 'opaque',
      ciphertext_hash: 'hash',
      identity_key: 'identity',
      signature: 'signature',
      path: ['origin-peer'],
    } satisfies RoutedRequest;

    const result = await Promise.race([
      sync.forwardRoutedRequest(request, 'previous-peer'),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 100)),
    ]);

    expect(result).toEqual({ ok: true, response_ciphertext: 'sealed-answer' });
    expect(sendRouteHop).toHaveBeenCalledTimes(2);
  });
});
