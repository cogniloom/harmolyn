import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XoreinAppProviders } from './xoreinClientProvider';
import { useRuntimeBootstrapState } from './xoreinRuntimeContext';

vi.mock('@/config/featureFlags', () => ({
  resolveFeatureFlag: () => false,
}));

// This suite exercises the HTTP bootstrap-failure UX, which only runs when the
// native engine is disabled (when the native engine owns the snapshot, the HTTP
// autoconnect is intentionally never armed).
const shellRuntimeData = vi.hoisted(() => ({ runtimeSnapshot: null }));
const readShellRuntimeDataMock = vi.hoisted(() => vi.fn(() => shellRuntimeData));
const connectToDefaultRuntimeMock = vi.hoisted(() => vi.fn(async () => null));
const readNativeRuntimeBootstrapStatusMock = vi.hoisted(() => vi.fn(async () => ({
  phase: 'waiting' as const,
  message: 'Local xorein runtime is not authenticated yet.',
  detail: 'http://127.0.0.1:7711',
})));
vi.mock('@/data', () => ({
  readShellRuntimeData: readShellRuntimeDataMock,
  subscribeShellRuntimeData: () => () => undefined,
}));

vi.mock('@/lib/xoreinControl', () => ({
  connectToDefaultRuntime: connectToDefaultRuntimeMock,
  DEFAULT_CONTROL_ENDPOINT: 'https://node.xorein.com',
  readNativeRuntimeBootstrapStatus: readNativeRuntimeBootstrapStatusMock,
  refreshRuntimeSnapshot: vi.fn(async () => undefined),
  subscribeRuntimeEvents: () => () => undefined,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('XoreinAppProviders runtime bootstrap', () => {
  it('surfaces a visible failure when the default node cannot be reached', async () => {
    function BootstrapProbe() {
      const bootstrapState = useRuntimeBootstrapState();
      return (
        <div>
          <span>{bootstrapState.status}</span>
          <span>{bootstrapState.message}</span>
          <span>{bootstrapState.detail ?? ''}</span>
        </div>
      );
    }

    render(
      <XoreinAppProviders>
        <BootstrapProbe />
      </XoreinAppProviders>,
    );

    expect(await screen.findByText('failed')).toBeTruthy();
    expect(screen.getByText(/default xorein node/i)).toBeTruthy();
    await waitFor(() => {
      expect(connectToDefaultRuntimeMock).toHaveBeenCalledTimes(1);
    });
  });
});
