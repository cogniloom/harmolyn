/** Local-only appearance data. No URLs, CSS fragments or executable theme content. */
export const COLOR_KEYS = ['background', 'surface', 'accent', 'text'] as const;
export type ColorKey = typeof COLOR_KEYS[number];
export type Palette = Record<ColorKey, string>;
export interface ThemePreset { id: string; name: string; description: string; colors: Palette }
export const THEMES: readonly ThemePreset[] = [
  { id: 'midnight', name: 'Midnight', description: 'Deep navy, soft indigo', colors: { background: '#10131C', surface: '#191E2C', accent: '#A5B4FC', text: '#F1F5FF' } },
  { id: 'graphite', name: 'Graphite', description: 'Neutral, quiet, focused', colors: { background: '#151617', surface: '#222426', accent: '#C5CDD6', text: '#F3F4F6' } },
  { id: 'oled', name: 'OLED', description: 'True black, crisp mint', colors: { background: '#000000', surface: '#101512', accent: '#74E8B1', text: '#F1FFF7' } },
  { id: 'ocean', name: 'Ocean', description: 'Marine blue, clear cyan', colors: { background: '#091924', surface: '#122B3B', accent: '#7DD3FC', text: '#E9F7FF' } },
  { id: 'forest', name: 'Forest', description: 'Pine green, sage accents', colors: { background: '#101C17', surface: '#1C3026', accent: '#A7D9A5', text: '#F0F7EB' } },
  { id: 'ember', name: 'Ember', description: 'Warm charcoal, apricot', colors: { background: '#211713', surface: '#33241D', accent: '#FDBA8C', text: '#FFF3E8' } },
  { id: 'rose', name: 'Rose', description: 'Berry tones, soft pink', colors: { background: '#21131E', surface: '#342030', accent: '#F5A6C9', text: '#FFF0F7' } },
  { id: 'violet', name: 'Violet', description: 'Plum surfaces, lavender', colors: { background: '#191526', surface: '#2A2340', accent: '#CAB8FF', text: '#F5EFFF' } },
  { id: 'daylight', name: 'Daylight', description: 'Bright paper, cobalt', colors: { background: '#F4F6FA', surface: '#FFFFFF', accent: '#314DBB', text: '#172033' } },
  { id: 'sand', name: 'Sand', description: 'Warm paper, earthen tones', colors: { background: '#F5F0E6', surface: '#FFFCF6', accent: '#86502E', text: '#33281E' } },
];
export interface Appearance {
  version: 1;
  theme: string;
  density: 'comfortable' | 'compact';
  custom: Record<string, Partial<Palette>>;
}
export const DEFAULT_APPEARANCE: Appearance = { version: 1, theme: 'midnight', density: 'comfortable', custom: {} };
const HEX = /^#[\da-f]{6}$/i;
export const normalizeColor = (value: unknown): string | null => typeof value === 'string' && HEX.test(value) ? value.toUpperCase() : null;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function normalizeAppearance(value: unknown): Appearance {
  if (!plain(value) || value.version !== 1) return { ...DEFAULT_APPEARANCE, custom: {} };
  const custom: Appearance['custom'] = {};
  if (plain(value.custom)) for (const theme of THEMES) {
    const source = value.custom[theme.id];
    if (!plain(source)) continue;
    const colors: Partial<Palette> = {};
    for (const key of COLOR_KEYS) {
      const color = normalizeColor(source[key]);
      if (color) colors[key] = color;
    }
    if (Object.keys(colors).length) custom[theme.id] = colors;
  }
  return { version: 1, theme: THEMES.some(t => t.id === value.theme) ? value.theme as string : 'midnight', density: value.density === 'compact' ? 'compact' : 'comfortable', custom };
}
export function parseAppearance(raw: string | null): Appearance {
  if (!raw || raw.length > 16384) return normalizeAppearance(null);
  try { return normalizeAppearance(JSON.parse(raw)); } catch { return normalizeAppearance(null); }
}
export const presetFor = (id: string): ThemePreset => THEMES.find(t => t.id === id) ?? THEMES[0];
export const requestedPalette = (prefs: Appearance): Palette => ({ ...presetFor(prefs.theme).colors, ...prefs.custom[prefs.theme] });
export function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
export function luminance(hex: string): number {
  const values = rgb(hex).map(n => { const s = n / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function mix(a: string, b: string, amount: number): string {
  const right = rgb(b);
  return '#' + rgb(a).map((left, i) => Math.round(left + (right[i] - left) * amount).toString(16).padStart(2, '0')).join('').toUpperCase();
}
const worstContrast = (color: string, surfaces: string[]) => Math.min(...surfaces.map(surface => contrast(color, surface)));
export function readable(color: string, surfaces: string[], minimum = 4.5): string {
  if (worstContrast(color, surfaces) >= minimum) return color;
  const black = worstContrast('#000000', surfaces), white = worstContrast('#FFFFFF', surfaces);
  const endpoint = black > white ? '#000000' : '#FFFFFF';
  for (let step = 1; step <= 100; step++) {
    const candidate = mix(color, endpoint, step / 100);
    if (worstContrast(candidate, surfaces) >= minimum) return candidate;
  }
  return endpoint;
}
export interface ResolvedPalette extends Palette {
  elevated: string; muted: string; subtle: string; border: string; onAccent: string;
  mode: 'dark' | 'light'; adjusted: ColorKey[];
}
export function resolvePalette(input: Palette): ResolvedPalette {
  const mode = luminance(input.background) > 0.4 ? 'light' : 'dark';
  // Opposite extremes cannot share a legible foreground. Keep the custom surface
  // in the background's luminance family, without mutating the user's saved color.
  let surface = input.surface;
  const anchor = mode === 'light' ? '#000000' : '#FFFFFF';
  if (Math.min(contrast(anchor, input.background), contrast(anchor, surface)) < 5) {
    for (let step = 1; step <= 100; step++) {
      const candidate = mix(input.surface, input.background, step / 100);
      if (contrast(anchor, candidate) >= 5) { surface = candidate; break; }
    }
  }
  // A mid-luminance background may need the opposite anchor to the preferred mode.
  const elevated = mix(surface, input.background, 0.35);
  const surfaces = [input.background, surface, elevated];
  let text = readable(input.text, surfaces);
  // If the background is in the black/white crossover, unify the surface when
  // no single black or white foreground can meet the required contrast on both.
  if (worstContrast(text, surfaces) < 4.5) {
    surface = input.background;
    text = readable(input.text, [surface]);
  }
  const finalElevated = mix(surface, input.background, 0.35);
  const finalSurfaces = [input.background, surface, finalElevated];
  const accent = readable(input.accent, finalSurfaces);
  const muted = readable(mix(text, surface, 0.26), finalSurfaces);
  const subtle = readable(mix(text, surface, 0.36), finalSurfaces);
  return { ...input, surface, accent, text, elevated: finalElevated, muted, subtle,
    border: mix(surface, text, 0.22), onAccent: readable('#FFFFFF', [accent]), mode,
    adjusted: COLOR_KEYS.filter(key => ({ ...input, surface, accent, text })[key] !== input[key]),
  };
}
const hsl = (hex: string): string => {
  const [r, g, b] = rgb(hex).map(n => n / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min, l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  let h = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  h = (h * 60 + 360) % 360;
  return `${h.toFixed(2)} ${(s * 100).toFixed(2)}% ${(l * 100).toFixed(2)}%`;
};
export function themeVariables(p: ResolvedPalette): Record<string, string> {
  const vars: Record<string, string> = {};
  const tokens: Record<string, string> = {
    background: p.background, foreground: p.text, primary: p.accent, 'primary-foreground': p.onAccent,
    secondary: p.elevated, 'secondary-foreground': p.text, muted: p.surface, 'muted-foreground': p.muted,
    accent: p.elevated, 'accent-foreground': p.text, card: p.surface, 'card-foreground': p.text,
    popover: p.surface, 'popover-foreground': p.text, border: p.border, input: p.surface, ring: p.accent,
    'sidebar-background': p.background, 'sidebar-foreground': p.text, 'sidebar-primary': p.accent,
    'sidebar-primary-foreground': p.onAccent, 'sidebar-accent': p.elevated,
    'sidebar-accent-foreground': p.text, 'sidebar-border': p.border, 'sidebar-ring': p.accent,
  };
  for (const [name, color] of Object.entries(tokens)) vars[`--${name}`] = hsl(color);
  for (const [name, color] of Object.entries({ background: p.background, surface: p.surface, elevated: p.elevated, text: p.text, muted: p.muted, subtle: p.subtle, border: p.border, accent: p.accent, 'on-accent': p.onAccent })) {
    vars[`--appearance-${name}`] = color;
    vars[`--appearance-${name}-rgb`] = rgb(color).join(' ');
  }
  for (const [name, color] of Object.entries({ success: '#05FFA1', warning: '#FFB020', danger: '#FF2A6D', purple: '#A855F7' })) {
    const resolved = readable(color, [p.background, p.surface, p.elevated]);
    vars[`--appearance-${name}-rgb`] = rgb(resolved).join(' ');
    vars[`--appearance-on-${name}`] = readable('#FFFFFF', [resolved]);
  }
  // Legacy inline theme variables reference these rather than supplying a second palette.
  vars['--theme-text'] = p.text;
  vars['--theme-text-secondary'] = p.muted;
  vars['--theme-text-dim'] = p.subtle;
  vars['--theme-glass-bg'] = p.surface;
  vars['--theme-glass-border'] = p.border;
  vars['--theme-border'] = p.border;
  vars['--primary-glow'] = 'none';
  vars['--shadow-glow-sm'] = 'none';
  return vars;
}
