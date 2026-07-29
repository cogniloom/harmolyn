// Channel `kind` (text/forum/announcement) is part of the server structure: it is
// stored on the channel record, survives a reload (persisted state), and is exposed
// through the runtime snapshot so every surface renders the same channel type.
import { beforeEach, describe, expect, it } from 'vitest';
import { initStore, getState, addServer, addChannel, updateChannel, toRuntimeSnapshot } from './store';

function seedServerWithChannel() {
  addServer({
    id: 'srv-1',
    name: 'Test Hub',
    owner_peer_id: 'peer-owner',
    members: ['peer-owner'],
    channels: {},
  });
  addChannel('srv-1', { id: 'chan-news', server_id: 'srv-1', name: 'news', voice: false });
}

beforeEach(() => {
  localStorage.clear();
  initStore();
});

describe('store channel kind', () => {
  it('updateChannel stores the kind on the channel record', () => {
    seedServerWithChannel();

    updateChannel('srv-1', 'chan-news', { kind: 'announcement' });

    expect(getState().servers['srv-1'].channels['chan-news'].kind).toBe('announcement');
  });

  it('channels without a kind stay kind-less (text by default)', () => {
    seedServerWithChannel();

    expect(getState().servers['srv-1'].channels['chan-news'].kind).toBeUndefined();
  });

  it('kind survives a reload via persisted state', () => {
    seedServerWithChannel();
    updateChannel('srv-1', 'chan-news', { kind: 'announcement' });

    // Simulate an app reload: re-init the store from persisted storage.
    initStore();

    expect(getState().servers['srv-1'].channels['chan-news'].kind).toBe('announcement');
  });

  it('the runtime snapshot exposes the kind to the UI', () => {
    seedServerWithChannel();
    updateChannel('srv-1', 'chan-news', { kind: 'announcement' });

    const snapshot = toRuntimeSnapshot();
    const server = snapshot.servers?.find((s) => s.id === 'srv-1');

    expect(server?.channels['chan-news'].kind).toBe('announcement');
  });

  it('kind patches do not clobber other channel fields', () => {
    seedServerWithChannel();
    updateChannel('srv-1', 'chan-news', { topic: 'ship updates' });
    updateChannel('srv-1', 'chan-news', { kind: 'announcement' });

    const chan = getState().servers['srv-1'].channels['chan-news'];
    expect(chan.topic).toBe('ship updates');
    expect(chan.name).toBe('news');
    expect(chan.kind).toBe('announcement');
  });
});
