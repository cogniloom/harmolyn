import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StickerPicker } from './StickerPicker';

describe('StickerPicker', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('still works when localStorage is blocked', async () => {
    const user = userEvent.setup();
    const getItem = window.localStorage.getItem.bind(window.localStorage);
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.getItem = vi.fn(() => { throw new Error('blocked'); });
    window.localStorage.setItem = vi.fn(() => { throw new Error('blocked'); });

    try {
      const onSelect = vi.fn();
      render(<StickerPicker onSelect={onSelect} onClose={() => undefined} />);
      await user.click(screen.getByRole('button', { name: /send 😂 sticker/i }));
      expect(onSelect).toHaveBeenCalledWith('😂');
    } finally {
      window.localStorage.getItem = getItem;
      window.localStorage.setItem = setItem;
    }
  });

  it('normalizes malformed recent sticker storage', () => {
    window.localStorage.setItem('harmolyn-recent-stickers', JSON.stringify([null, ' 😂 ', 42, '🥳', ' 😂 ']));

    render(<StickerPicker onSelect={vi.fn()} onClose={() => undefined} />);

    expect(JSON.parse(window.localStorage.getItem('harmolyn-recent-stickers') ?? '[]')).toEqual(['😂', '🥳']);
  });
});
