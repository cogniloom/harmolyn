import { describe, expect, it } from 'vitest';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './browserStorage';

describe('browserStorage', () => {
  it('swallows storage getter failures', () => {
    const storageError = new DOMException('Blocked', 'SecurityError');
    const brokenStorage = (() => {
      throw storageError;
    }) as unknown as () => Storage;

    expect(safeStorageGet(brokenStorage, 'harmolyn:test')).toBeNull();
    expect(() => safeStorageSet(brokenStorage, 'harmolyn:test', 'value')).not.toThrow();
    expect(() => safeStorageRemove(brokenStorage, 'harmolyn:test')).not.toThrow();
  });
});
