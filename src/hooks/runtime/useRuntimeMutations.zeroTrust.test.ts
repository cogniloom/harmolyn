// Zero-trust facade routing (findings 7 + 8):
//  • moderationAction on the native path must NEVER reach the HTTP control client —
//    the payload (server id, moderator, target peer id, free-text reason) is social
//    metadata the support node must not learn. kick/ban route to the native
//    owner-authoritative primitives; actions with no native primitive reject with
//    an honest error instead of silently POSTing to the node.
//  • previewServerInvite on the native path is a local no-op — the support node
//    must not learn which server a user is ABOUT to join.
// Both fail without the fix: the native branch previously fell through to the
// HTTP client for moderation, and the modal called discoverServerByInvite always.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRuntimeMutations } from './useRuntimeMutations';
import { nativeRemoveMember, nativeRotateInvite } from '@/native/state/mutations';
import { moderationAction as httpModerationAction, discoverServerByInvite } from '@/lib/xoreinControl';

const engineHolder = vi.hoisted(() => ({ engine: {} as object | null }));
const registerIdentity = vi.hoisted(() => vi.fn());

vi.mock('@/native/engine/provider', () => ({
  useNativeEngine: () => ({ engine: engineHolder.engine, registerIdentity, hasRegisteredIdentity: true }),
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
    nativeRemoveMember: vi.fn(),
    nativeRotateInvite: vi.fn(),
  };
});

vi.mock('@/lib/xoreinControl', async () => {
  const actual = await vi.importActual<typeof import('@/lib/xoreinControl')>('@/lib/xoreinControl');
  return {
    ...actual,
    moderationAction: vi.fn(),
    discoverServerByInvite: vi.fn(),
  };
});

describe('useRuntimeMutations — zero-trust moderation routing (native path)', () => {
  beforeEach(() => {
    vi.mocked(nativeRemoveMember).mockReset();
    vi.mocked(nativeRotateInvite).mockReset();
    vi.mocked(httpModerationAction).mockReset();
    vi.mocked(discoverServerByInvite).mockReset();
  });

  it('routes kick to the native removal primitive, never to HTTP', async () => {
    const { result } = renderHook(() => useRuntimeMutations());

    await result.current.moderationAction('srv-1', 'kick', { target_peer_id: 'peer-bad', reason: 'spam' });

    expect(nativeRemoveMember).toHaveBeenCalledWith('srv-1', 'peer-bad');
    expect(nativeRotateInvite).not.toHaveBeenCalled();
    expect(httpModerationAction).not.toHaveBeenCalled();
  });

  it('routes ban to native removal + invite rotation, never to HTTP', async () => {
    const { result } = renderHook(() => useRuntimeMutations());

    await result.current.moderationAction('srv-1', 'ban', { target_peer_id: 'peer-bad' });

    expect(nativeRemoveMember).toHaveBeenCalledWith('srv-1', 'peer-bad');
    expect(nativeRotateInvite).toHaveBeenCalledWith('srv-1');
    expect(httpModerationAction).not.toHaveBeenCalled();
  });

  it('rejects an unsupported action (mute) honestly WITHOUT shipping the payload to the node', async () => {
    const { result } = renderHook(() => useRuntimeMutations());

    await expect(
      result.current.moderationAction('srv-1', 'mute', {
        target_peer_id: 'peer-bad',
        duration_ms: 60_000,
        reason: 'operator-authored free text about a named user',
      }),
    ).rejects.toThrow(/not supported by the P2P engine/);

    // The regression: previously this fell through to POST /v1/moderation/... on
    // the untrusted node, leaking server id + target peer + reason for no benefit.
    expect(httpModerationAction).not.toHaveBeenCalled();
    expect(nativeRemoveMember).not.toHaveBeenCalled();
  });

  it('rejects a kick with no target without calling anything', async () => {
    const { result } = renderHook(() => useRuntimeMutations());

    await expect(result.current.moderationAction('srv-1', 'kick', {})).rejects.toThrow(/target peer/);
    expect(nativeRemoveMember).not.toHaveBeenCalled();
    expect(httpModerationAction).not.toHaveBeenCalled();
  });
});

describe('useRuntimeMutations — invite preview stays local on the native path', () => {
  beforeEach(() => {
    vi.mocked(discoverServerByInvite).mockReset();
    engineHolder.engine = {};
  });

  it('previewServerInvite resolves null without consulting the support node', async () => {
    const { result } = renderHook(() => useRuntimeMutations());

    const preview = await result.current.previewServerInvite('xorein://invite/whatever');

    expect(preview).toBeNull();
    expect(discoverServerByInvite).not.toHaveBeenCalled();
  });

  it('stays local even while the engine is still BOOTSTRAPPING (flag on, engine null)', async () => {
    // The facade serves its HTTP branch while `engine` is null — but a native-mode
    // user has not opted into HTTP, so the preview must still resolve locally.
    // This exact window leaked one /v1/servers/preview POST in the live E2E audit.
    engineHolder.engine = null;
    const { result } = renderHook(() => useRuntimeMutations());

    const preview = await result.current.previewServerInvite('xorein://invite/whatever');

    expect(preview).toBeNull();
    expect(discoverServerByInvite).not.toHaveBeenCalled();
  });
});
