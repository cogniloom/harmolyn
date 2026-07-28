// Single source of truth for applying persisted accessibility preferences to the
// document. Used both at boot (Layout, before Settings mounts) and live (the
// AccessibilitySection effect), so the two can never drift.

export const ACCESSIBILITY_STORAGE_KEY = 'harmolyn:settings:accessibility';

export type AccessibilityFontSize = 'small' | 'default' | 'large' | 'xlarge';

export interface AppliedAccessibilityPrefs {
  fontSize?: AccessibilityFontSize | string;
  saturation?: number;
  highContrast?: boolean;
  reducedMotion?: boolean;
  dyslexicFont?: boolean;
  simpleMode?: boolean;
}

export const FONT_SIZE_PX: Record<string, string> = {
  small: '13px',
  default: '15px',
  large: '17px',
  xlarge: '19px',
};

/**
 * Apply accessibility preferences to the given root/body. Idempotent: each class
 * is toggled to match the preference (so clearing a preference removes its class).
 * Saturation is applied on the body as a CSS filter; the caller owning the html
 * `filter` (the live effect) may pass `applySaturationOnHtml` to place it there
 * instead, keeping a single filter source.
 */
export function applyAccessibilityPrefs(
  prefs: AppliedAccessibilityPrefs,
  opts: { root?: HTMLElement; body?: HTMLElement; applySaturationOnHtml?: boolean } = {},
): void {
  const root = opts.root ?? document.documentElement;
  const body = opts.body ?? document.body;

  if (prefs.fontSize) root.style.fontSize = FONT_SIZE_PX[prefs.fontSize] ?? '15px';

  root.classList.toggle('high-contrast', Boolean(prefs.highContrast));
  root.classList.toggle('reduce-motion', Boolean(prefs.reducedMotion));
  root.classList.toggle('dyslexic-font', Boolean(prefs.dyslexicFont));
  root.classList.toggle('simple-mode', Boolean(prefs.simpleMode));

  const sat = typeof prefs.saturation === 'number' && prefs.saturation !== 100
    ? `saturate(${prefs.saturation}%)`
    : '';
  if (opts.applySaturationOnHtml) {
    root.style.filter = sat;
  } else if (body) {
    body.style.filter = sat;
  }
}

/** Read persisted prefs from localStorage and apply them (used at boot). */
export function applyStoredAccessibilityPrefs(): void {
  try {
    const raw = localStorage.getItem(ACCESSIBILITY_STORAGE_KEY);
    if (!raw) return;
    // Apply the saturation filter on <html>, the SAME element the live Accessibility
    // Settings effect uses. If boot put it on <body> and the live effect on <html>,
    // the two CSS filters would compound (a saved 50% would render ~25%). Keeping
    // saturation on <html> leaves <body> free for the color-blind matrix (they stack).
    applyAccessibilityPrefs(JSON.parse(raw) as AppliedAccessibilityPrefs, { applySaturationOnHtml: true });
  } catch {
    /* best effort */
  }
}
