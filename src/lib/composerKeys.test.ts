import { describe, expect, it } from 'vitest';
import { isComposingKey } from './composerKeys';
describe('IME send protection', () => {
  it('recognizes browser composition and legacy Safari composition', () => {
    expect(isComposingKey({ isComposing: true })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });
  it('does not suppress ordinary keyboard input', () => {
    expect(isComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isComposingKey({})).toBe(false);
  });
});
