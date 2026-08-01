import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WelcomeEmptyState } from './WelcomeEmptyState';

describe('WelcomeEmptyState', () => {
  it('prompts a guest to create an account instead of showing the action cards', () => {
    const onOpenAuth = vi.fn();
    render(
      <WelcomeEmptyState
        hasIdentity={false}
        canUseConnectivity
        onCreateServer={vi.fn()}
        onJoinServer={vi.fn()}
        onAddFriend={vi.fn()}
        onOpenAuth={onOpenAuth}
      />,
    );

    expect(screen.getByText('Welcome to Harmolyn')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Create your account'));
    expect(onOpenAuth).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Create a Space')).toBeNull();
  });

  it('offers enabled getting-started actions to a connected, signed-in user', () => {
    const onCreateServer = vi.fn();
    render(
      <WelcomeEmptyState
        hasIdentity
        canUseConnectivity
        onCreateServer={onCreateServer}
        onJoinServer={vi.fn()}
        onAddFriend={vi.fn()}
        onOpenAuth={vi.fn()}
      />,
    );

    const createBtn = screen.getByText('Create a Space').closest('button')!;
    expect(createBtn).not.toBeDisabled();
    fireEvent.click(createBtn);
    expect(onCreateServer).toHaveBeenCalledTimes(1);
  });

  it('disables actions while still connecting', () => {
    render(
      <WelcomeEmptyState
        hasIdentity
        canUseConnectivity={false}
        onCreateServer={vi.fn()}
        onJoinServer={vi.fn()}
        onAddFriend={vi.fn()}
        onOpenAuth={vi.fn()}
      />,
    );

    expect(screen.getByText('Create a Space').closest('button')!).toBeDisabled();
    expect(screen.getByText(/these actions become available once you’re online/i)).toBeInTheDocument();
  });
});
