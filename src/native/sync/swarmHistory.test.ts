import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateIdentity, type XoreinIdentity } from '../identity/identity';
import type { XoreinRuntimeMessage } from '../../types';
import { signChannelMessageVersion } from './signedHistory';
import {
  fetchSwarmHistoryPage,
  providerEvidenceSnapshot,
  resetSwarmHistoryState,
  type SwarmHistoryProvider,
} from './swarmHistory';

async function signed(
  id: string,
  body = id,
  identity?: XoreinIdentity,
  revision = 0,
): Promise<XoreinRuntimeMessage> {
  const author = identity ?? await generateIdentity();
  const message: XoreinRuntimeMessage = {
    id,
    scope_type: 'channel',
    scope_id: 'c',
    server_id: 's',
    sender_peer_id: author.peerId,
    body,
    created_at: `2026-07-30T12:00:${id.slice(-2).padStart(2, '0')}.000Z`,
    author_revision: revision,
  };
  message.author_proof = signChannelMessageVersion(message, author);
  return message;
}

function provider(
  peerId: string,
  kind: SwarmHistoryProvider['kind'],
  messages: XoreinRuntimeMessage[],
): SwarmHistoryProvider {
  return {
    peerId,
    kind,
    coverage: vi.fn(async () => ({
      ok: true,
      entries: messages.map(message => ({
        id: message.id,
        created_at: message.created_at!,
        content_hash: message.author_proof!.content_hash,
        revision: message.author_revision ?? 0,
      })),
      has_more: false,
    })),
    fetch: vi.fn(async ids => messages.filter(message => ids.includes(message.id))),
  };
}

describe('swarm history reconstruction', () => {
  beforeEach(() => resetSwarmHistoryState(50));

  it('prefers archivists and distributes a page across equal-tier nodes', async () => {
    const messages = await Promise.all(['01', '02', '03', '04'].map(id => signed(id)));
    const a = provider('archive-a', 'archivist', messages);
    const b = provider('archive-b', 'archivist', messages);
    const peer = provider('member', 'peer', messages);

    const result = await fetchSwarmHistoryPage({
      providers: [peer, a, b],
      serverId: 's',
      channelId: 'c',
      limit: 4,
    });

    expect(result.messages.map(message => message.id)).toEqual(['01', '02', '03', '04']);
    expect(a.fetch).toHaveBeenCalled();
    expect(b.fetch).toHaveBeenCalled();
    expect(peer.fetch).not.toHaveBeenCalled();
  });

  it('rejects a tampered node copy and retries an independently verified peer', async () => {
    const authentic = await signed('01', 'real');
    const bad = { ...authentic, body: 'forged' };
    const archive = provider('bad-archive', 'archivist', [bad]);
    // The availability hash can lie; fetch verification is authoritative.
    (archive.coverage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      entries: [{
        id: bad.id,
        created_at: bad.created_at,
        content_hash: authentic.author_proof!.content_hash,
        revision: 0,
      }],
    });
    const member = provider('member', 'peer', [authentic]);

    const result = await fetchSwarmHistoryPage({
      providers: [archive, member],
      serverId: 's',
      channelId: 'c',
      limit: 1,
    });

    expect(result.messages).toEqual([authentic]);
    expect(providerEvidenceSnapshot()['bad-archive'].invalidRecords).toBeGreaterThan(0);
  });

  it('performs a three-source audit without using majority as authority', async () => {
    resetSwarmHistoryState(1);
    const authentic = await signed('01', 'real');
    const a = provider('a', 'archivist', [authentic]);
    const b = provider('b', 'archivist', [authentic]);
    const c = provider('c', 'archivist', [authentic]);

    const result = await fetchSwarmHistoryPage({
      providers: [a, b, c],
      serverId: 's',
      channelId: 'c',
      limit: 1,
    });

    expect(result.messages).toEqual([authentic]);
    expect([a, b, c].filter(p => (p.fetch as ReturnType<typeof vi.fn>).mock.calls.length > 0))
      .toHaveLength(3);
  });

  it('fetches and returns a newer signed revision for a locally held message id', async () => {
    const author = await generateIdentity();
    const original = await signed('01', 'before edit', author, 0);
    const edited = await signed('01', 'after edit', author, 1);
    const archive = provider('archive', 'archivist', [edited]);

    const result = await fetchSwarmHistoryPage({
      providers: [archive],
      serverId: 's',
      channelId: 'c',
      limit: 10,
      existingMessageRevisions: new Map([[original.id, original.author_revision ?? 0]]),
    });

    expect(archive.fetch).toHaveBeenCalledWith(['01']);
    expect(result.messages).toEqual([edited]);
  });
});
