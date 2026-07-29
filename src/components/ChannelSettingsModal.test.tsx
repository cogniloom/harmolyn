import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChannelSettingsModal } from './ChannelSettingsModal';
import type { Channel } from '@/types';

const channel: Channel = { id: 'chan-1', name: 'general', type: 'text', categoryId: 'cat-1' };

function renderModal(overrides: Partial<ComponentProps<typeof ChannelSettingsModal>> = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const onDelete = vi.fn();
  render(
    <ChannelSettingsModal
      channel={channel}
      onClose={onClose}
      onSave={onSave}
      onDelete={onDelete}
      {...overrides}
    />,
  );
  return { onSave, onClose, onDelete };
}

describe('ChannelSettingsModal', () => {
  it('associates the CHANNEL NAME label with its input', () => {
    renderModal();

    // getByLabelText only resolves through a real htmlFor/id association.
    const input = screen.getByLabelText('CHANNEL NAME');
    expect(input).toHaveValue('general');
  });

  it('tells the user when the channel name will be normalized', async () => {
    const user = userEvent.setup();
    renderModal();

    const input = screen.getByLabelText('CHANNEL NAME');
    await user.clear(input);
    await user.type(input, 'My Cool Channel');

    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/will be saved as/i);
    expect(note).toHaveTextContent('#my-cool-channel');
    expect(input).toHaveAttribute('aria-describedby', 'channel-name-normalized-note');
  });

  it('shows no normalization note when the name is already normalized', async () => {
    const user = userEvent.setup();
    renderModal();

    const input = screen.getByLabelText('CHANNEL NAME');
    await user.clear(input);
    await user.type(input, 'already-fine');

    expect(screen.queryByRole('note')).toBeNull();
  });

  it('saves the normalized name', async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    const input = screen.getByLabelText('CHANNEL NAME');
    await user.clear(input);
    await user.type(input, 'My Cool Channel');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'my-cool-channel' }));
  });

  it('keeps a real, accessibly-named close button', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
