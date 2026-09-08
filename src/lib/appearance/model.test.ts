import assert from 'node:assert/strict';
import { test } from 'vitest';
import { COLOR_KEYS, DEFAULT_APPEARANCE, THEMES, contrast, normalizeAppearance, normalizeColor, parseAppearance, requestedPalette, resolvePalette, themeVariables } from './model';

test('exactly ten uniquely named presets have valid colors', () => {
  assert.equal(THEMES.length, 10);
  assert.equal(new Set(THEMES.map(t => t.id)).size, 10);
  for (const t of THEMES) for (const key of COLOR_KEYS) assert.equal(normalizeColor(t.colors[key]), t.colors[key]);
});
for (const preset of THEMES) test(`${preset.name} keeps text, controls, and semantic colors legible`, () => {
  const p = resolvePalette(preset.colors);
  for (const ink of [p.text, p.muted, p.subtle, p.accent]) for (const surface of [p.background, p.surface, p.elevated]) assert.ok(contrast(ink, surface) >= 4.5);
  assert.ok(contrast(p.onAccent, p.accent) >= 4.5);
  for (const [name, value] of Object.entries(themeVariables(p))) {
    assert.ok(name.startsWith('--'));
    assert.ok(!/url|expression|[{};<>]/i.test(value));
  }
});
test('rejects executable CSS, URLs, shorthand, and non-color types', () => {
  for (const value of ['red', '#fff', 'url(https://example.invalid)', '#123456; color:red', 'var(--x)', '#12345678', {}, 0, null]) assert.equal(normalizeColor(value), null);
  assert.equal(normalizeColor('#abcdef'), '#ABCDEF');
});
test('bounds serialized preferences and rejects invalid versions or structure', () => {
  for (const raw of ['{', '[]', 'null', '{}', '{"version":2,"theme":"rose"}', 'x'.repeat(16385)]) assert.deepEqual(parseAppearance(raw), DEFAULT_APPEARANCE);
});
test('only known palette fields and preset identifiers survive normalization', () => {
  const input = JSON.parse('{"version":1,"theme":"ocean","density":"compact","custom":{"ocean":{"accent":"#abcdef","css":"url(evil)","text":false,"__proto__":{"polluted":true}},"unknown":{"text":"#123456"}},"url":"https://example.invalid"}');
  assert.deepEqual(normalizeAppearance(input), { version: 1, theme: 'ocean', density: 'compact', custom: { ocean: { accent: '#ABCDEF' } } });
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});
test('custom palettes remain independent and do not mutate presets', () => {
  const p = normalizeAppearance({ version: 1, theme: 'ocean', custom: { ocean: { accent: '#ABCDEF' }, rose: { accent: '#123456' } } });
  assert.equal(requestedPalette(p).accent, '#ABCDEF');
  assert.equal(requestedPalette({ ...p, theme: 'rose' }).accent, '#123456');
  assert.equal(THEMES.find(t => t.id === 'rose')?.colors.accent, '#F5A6C9');
});
test('impossible custom combinations are corrected without losing chosen values', () => {
  const input = { background: '#FFFFFF', surface: '#000000', text: '#FFFFFF', accent: '#FFFFFF' };
  const before = JSON.stringify(input), p = resolvePalette(input);
  assert.equal(JSON.stringify(input), before);
  assert.ok(p.adjusted.length > 0);
  for (const surface of [p.background, p.surface, p.elevated]) assert.ok(contrast(p.text, surface) >= 4.5);
});
test('5,000 deterministic custom palettes satisfy the contrast contract', () => {
  let seed = 0x1a2b3c4d;
  const color = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return '#' + (seed & 0xffffff).toString(16).padStart(6, '0').toUpperCase(); };
  for (let i = 0; i < 5000; i++) {
    const p = resolvePalette({ background: color(), surface: color(), accent: color(), text: color() });
    for (const ink of [p.text, p.muted, p.subtle, p.accent]) for (const surface of [p.background, p.surface, p.elevated]) assert.ok(contrast(ink, surface) >= 4.5, `${i}: ${ink}/${surface}`);
    assert.ok(contrast(p.onAccent, p.accent) >= 4.5);
  }
});
