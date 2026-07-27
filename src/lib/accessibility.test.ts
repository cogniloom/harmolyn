import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyAccessibilityPrefs,
  applyStoredAccessibilityPrefs,
  ACCESSIBILITY_STORAGE_KEY,
} from './accessibility';

describe('applyAccessibilityPrefs', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    document.documentElement.style.cssText = '';
    document.body.style.cssText = '';
    localStorage.clear();
  });

  it('toggles the simple-mode class on and off', () => {
    applyAccessibilityPrefs({ simpleMode: true });
    expect(document.documentElement.classList.contains('simple-mode')).toBe(true);
    applyAccessibilityPrefs({ simpleMode: false });
    expect(document.documentElement.classList.contains('simple-mode')).toBe(false);
  });

  it('applies every visual class from a full preference object', () => {
    applyAccessibilityPrefs({
      highContrast: true, reducedMotion: true, dyslexicFont: true, simpleMode: true,
      fontSize: 'large',
    });
    const cl = document.documentElement.classList;
    expect(cl.contains('high-contrast')).toBe(true);
    expect(cl.contains('reduce-motion')).toBe(true);
    expect(cl.contains('dyslexic-font')).toBe(true);
    expect(cl.contains('simple-mode')).toBe(true);
    expect(document.documentElement.style.fontSize).toBe('17px');
  });

  it('puts saturation on the body by default and on html when asked', () => {
    applyAccessibilityPrefs({ saturation: 50 });
    expect(document.body.style.filter).toContain('saturate(50%)');
    expect(document.documentElement.style.filter).toBe('');

    document.body.style.cssText = '';
    applyAccessibilityPrefs({ saturation: 50 }, { applySaturationOnHtml: true });
    expect(document.documentElement.style.filter).toContain('saturate(50%)');
  });

  it('leaves saturation empty at 100%', () => {
    applyAccessibilityPrefs({ saturation: 100 });
    expect(document.body.style.filter).toBe('');
  });
});

describe('applyStoredAccessibilityPrefs', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    localStorage.clear();
  });

  it('reads persisted prefs from localStorage and applies them', () => {
    localStorage.setItem(ACCESSIBILITY_STORAGE_KEY, JSON.stringify({ simpleMode: true, highContrast: true }));
    applyStoredAccessibilityPrefs();
    expect(document.documentElement.classList.contains('simple-mode')).toBe(true);
    expect(document.documentElement.classList.contains('high-contrast')).toBe(true);
  });

  it('is a no-op when nothing is stored', () => {
    applyStoredAccessibilityPrefs();
    expect(document.documentElement.classList.contains('simple-mode')).toBe(false);
  });

  it('swallows malformed JSON', () => {
    localStorage.setItem(ACCESSIBILITY_STORAGE_KEY, '{not json');
    expect(() => applyStoredAccessibilityPrefs()).not.toThrow();
  });
});
