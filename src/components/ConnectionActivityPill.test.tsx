import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionActivityPill } from './ConnectionActivityPill';

const nativeContext = vi.hoisted(() => ({
  value: {
    engine: null,
    state: 'disconnected',
    hasRegisteredIdentity: false,
    registerIdentity: vi.fn(),
    activity: { phase: 'connected', message: 'Connected' },
  },
}));

vi.mock('@/native/engine/provider', () => ({
  useNativeEngine: () => nativeContext.value,
}));

describe('ConnectionActivityPill', () => {
  beforeEach(() => {
    nativeContext.value.state = 'disconnected';
    nativeContext.value.activity = { phase: 'connected', message: 'Connected' };
  });

  it('never calls a live local runtime connected without a peer path', () => {
    render(<ConnectionActivityPill />);

    expect(screen.getByRole('status')).toHaveAccessibleName(/FINDING PEERS/i);
    expect(screen.getByText('Finding peers')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('shows connected only when the provider reports a live network path', () => {
    nativeContext.value.state = 'connected';
    render(<ConnectionActivityPill />);

    expect(screen.getByRole('status')).toHaveAccessibleName(/connected to the xorein network/i);
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });
});
