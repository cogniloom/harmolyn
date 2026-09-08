import type { CSSProperties } from 'react';

export interface Theme {
  background: string;
  glassTint: string;
  pattern: string;
  themeVars: CSSProperties;
}

// Preserve the existing call sites and saved seed values. All rendered surfaces
// now follow the user's explicit palette; there is no second random theme owner.
const THEME: Theme = {
  background: 'var(--appearance-background)',
  glassTint: 'var(--appearance-surface)',
  pattern: 'none',
  themeVars: {
    '--theme-text': 'var(--appearance-text)',
    '--theme-text-secondary': 'var(--appearance-muted)',
    '--theme-text-dim': 'var(--appearance-subtle)',
    '--theme-glass-bg': 'var(--appearance-surface)',
    '--theme-glass-border': 'var(--appearance-border)',
    '--theme-border': 'var(--appearance-border)',
  } as CSSProperties,
};
export const generateTheme = (_seed: string): Theme => THEME;
