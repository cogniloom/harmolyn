// Facade coverage for the synced channel `kind` (text/forum/announcement):
//  • updateChannel forwards a kind patch to the native engine, and
//  • createChannel(serverId, name, voice, kind) stamps the kind onto the freshly
//    created channel record (announce-at-creation), voice channels excluded.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRuntimeMutations } from './useRuntimeMutations';
import { nativeCreateChannel, nativeUpdateChannel } from '@/native/state/mutations';

vi.mock('@/native/engine/provider', () => ({
  useNativeEngine: () => ({ engine: {}, registerIdentity: vi.fn(), hasRegisteredIdentity: true }),
}));

vi.mock('@/lib/xoreinRuntimeContext', () => ({
  useRuntimeSnapshot: () => ({ identity: { peer_id: 'peer-local' } }),
}));

vi.mock('@/config/featureFlags', async () => {
  const actual = await vi.importActual<typeof import('@/config/featureFlags')>('@/config/featureFlags');
  return {
    ...actual,
    resolveFeatureFlag: (flag: string) => flag === 'nativeEngine',
  };
});

vi.mock('@/native/state/mutations', async () => {
  const actual = await vi.importActual<typeof import('@/native/state/mutations')>('@/native/state/mutations');
  return {
    ...actual,
    nativeCreateChannel: vi.fn(),
    nativeUpdateChannel: vi.fn(),
  };
});

describe('useRuntimeMutations channel kind routing (native path)', () => {
  beforeEach(() => {
    vi.mocked(nativeCreateChannel).mockReset().mockReturnValue({
      id: 'chan-news',
      server_id: 'srv-1',
      name: 'news',
      voice: false,
    });
    vi.mocked(nativeUpdateChannel).mockReset();
  });

  it('updateChannel forwards the kind patch to the native engine', async () => {
    const { result } = renderHook(() => useRuntimeMutations());

    await result.current.updateChannel('srv-1', 'chan-news', { kind: 'announcement' });

    expect(nativeUpdateChannel).toHaveBeenCalledWith('srv-1', 'chan-news', { kind: 'announcement' });
  });

  it('createChannel with an announcement kind stamps it onto the new channel', async () => {
    const { result } = renderHook(() => useRuntimeMutations());

    const created = await result.current.createChannel('srv-1', 'news', false, 'announcement');

    expect(nativeCreateChannel).toHaveBeenCalledWith('srv-1', 'news', false);
    expect(nativeUpdateChannel).toHaveBeenCalledWith('srv-1', 'chan-news', { kind: 'announcement' });
    expect(created).toMatchObject({ id: 'chan-news' });
  });

  it('createChannel without a kind (or text kind) does not patch the channel', async () => {
    const { result } = renderHook(() => useRuntimeMutations());

    await result.current.createChannel('srv-1', 'general');
    await result.current.createChannel('srv-1', 'general2', false, 'text');

    expect(nativeUpdateChannel).not.toHaveBeenCalled();
  });

  it('createChannel ignores kind for voice channels', async () => {
    const { result } = renderHook(() => useRuntimeMutations());

    await result.current.createChannel('srv-1', 'voice-lounge', true, 'announcement');

    expect(nativeCreateChannel).toHaveBeenCalledWith('srv-1', 'voice-lounge', true);
    expect(nativeUpdateChannel).not.toHaveBeenCalled();
  });
});
