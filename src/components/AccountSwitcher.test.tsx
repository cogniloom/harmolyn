import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AccountSwitcher } from './AccountSwitcher';
import type { VaultEntry } from '@/native/identity/storage';

const entry = (peerId: string, displayName: string): VaultEntry => ({
  peerId,
  displayName,
  createdAt: '2026-01-01T00:00:00.000Z',
  blob: {} as never,
});

describe('AccountSwitcher', () => {
  it('lists saved accounts and marks the active one (no Switch button for it)', () => {
    render(
      <AccountSwitcher
        entries={[entry('12D3KooWalpha000000000000xyz', 'Alpha'), entry('12D3KooWbeta0000000000000xyz', 'Beta')]}
        activePeerId="12D3KooWalpha000000000000xyz"
        onAdd={vi.fn()}
        onLogout={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // Exactly one "Switch" button — the non-active account.
    expect(screen.getAllByText('Switch')).toHaveLength(1);
  });

  it('exposes add-another-account and log-out actions', () => {
    const onAdd = vi.fn();
    const onLogout = vi.fn();
    render(
      <AccountSwitcher
        entries={[]}
        activePeerId=""
        onAdd={onAdd}
        onLogout={onLogout}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('No other accounts saved on this device.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Add another account'));
    fireEvent.click(screen.getByText('Log out'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('reveals an inline password field when switching to another account', () => {
    render(
      <AccountSwitcher
        entries={[entry('12D3KooWalpha000000000000xyz', 'Alpha')]}
        activePeerId="12D3KooWother00000000000xyz"
        onAdd={vi.fn()}
        onLogout={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Switch'));
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
  });
});
