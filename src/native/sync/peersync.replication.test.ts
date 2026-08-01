import { beforeEach, describe, expect, it } from 'vitest';
import { initStore, upsertPeer } from '../state/store';
import { selectReplicaTargets } from './peersync';

describe('replica target placement', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
  });

  it('prefers distinct network domains before colocated fallbacks', () => {
    upsertPeer({ peer_id: 'a', role: 'archivist', addresses: ['/ip4/10.1.1.1/tcp/1/ws/p2p/a'] });
    upsertPeer({ peer_id: 'b', role: 'archivist', addresses: ['/ip4/10.1.9.9/tcp/1/ws/p2p/b'] });
    upsertPeer({ peer_id: 'c', role: 'relay', addresses: ['/ip4/10.2.1.1/tcp/1/ws/p2p/c'] });
    upsertPeer({ peer_id: 'd', role: 'relay', addresses: ['/dns4/node.example.net/tcp/443/wss/p2p/d'] });

    const selected = selectReplicaTargets('message-placement', 4);
    const firstThree = selected.slice(0, 3);
    expect(firstThree).toHaveLength(3);
    expect(firstThree).not.toEqual(expect.arrayContaining(['a', 'b']));
    expect(new Set(selected)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});
