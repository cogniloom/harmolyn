import { describe, expect, it, vi } from 'vitest';
import { createCollisionResistantId } from './localIds';

describe('createCollisionResistantId', () => {
  it('produces distinct ids when called in the same tick', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1716500000000);

    try {
      const first = createCollisionResistantId('poll');
      const second = createCollisionResistantId('poll');

      expect(first).toBe('poll-1716500000000-1');
      expect(second).toBe('poll-1716500000000-2');
      expect(first).not.toBe(second);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
