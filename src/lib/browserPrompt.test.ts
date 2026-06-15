import { describe, it, expect, vi } from 'vitest';
import { safePrompt } from './browserPrompt';

describe('safePrompt', () => {
  it('returns the prompt value when available', () => {
    const spy = vi.spyOn(window, 'prompt').mockReturnValue('value');

    expect(safePrompt('label', 'default')).toBe('value');
    expect(spy).toHaveBeenCalledWith('label', 'default');
  });

  it('returns null when prompt throws', () => {
    vi.spyOn(window, 'prompt').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(safePrompt('label', 'default')).toBeNull();
  });
});
