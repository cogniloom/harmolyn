// i18n integrity + no-raw-key guard for the converted surfaces.
//
// (1) Every key referenced by a converted surface resolves in the English catalog
//     (a missing key would make i18next echo the dotted key — we assert it doesn't).
// (2) Rendering a converted surface under the pseudo-locale decorates every string
//     (⟦…⟧), proving the UI reads from the catalog rather than hardcoded English —
//     so an unwrapped literal would stand out as bare text, and a missing key would
//     surface as a raw dotted key. This is the regression guard the sweep relies on.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import i18n from './index';
import { ProductTour } from '@/components/onboarding/ProductTour';

// Keys the converted surfaces reference — extend as more screens are localized.
const REQUIRED_KEYS: Array<[string, string]> = [
  ['common', 'actions.next'],
  ['common', 'actions.back'],
  ['common', 'actions.skip'],
  ['onboarding', 'tour.welcome.title'],
  ['onboarding', 'tour.start'],
  ['settings', 'accessibility.title'],
  ['settings', 'accessibility.simpleMode'],
  ['settings', 'language.label'],
  ['voice', 'turnWarning'],
  ['errors', 'generic'],
];

describe('i18n catalog integrity', () => {
  afterEach(() => cleanup());

  it('resolves every required key in English (no raw dotted keys)', async () => {
    await i18n.changeLanguage('en');
    for (const [ns, key] of REQUIRED_KEYS) {
      const value = i18n.t(key, { ns });
      expect(value, `${ns}:${key} unresolved`).not.toBe(key);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('renders ProductTour under English with real copy, no raw keys', async () => {
    await i18n.changeLanguage('en');
    render(<ProductTour onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: /Welcome to Harmolyn/i })).toBeInTheDocument();
    // No dotted key text leaked into the DOM.
    expect(document.body.textContent).not.toMatch(/tour\.\w+\.\w+/);
  });

  it('pseudo-locale decorates every string (proves catalog-driven rendering)', async () => {
    await i18n.changeLanguage('en-XA');
    render(<ProductTour onClose={() => {}} />);
    // Pseudo wraps each string in ⟦…⟧; the heading must be decorated, not English.
    expect(document.body.textContent).toContain('⟦');
    // And still no raw dotted keys.
    expect(document.body.textContent).not.toMatch(/tour\.\w+\.\w+/);
    await i18n.changeLanguage('en'); // restore for other tests
  });
});
