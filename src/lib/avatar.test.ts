import { describe, expect, it } from 'vitest';
import { resolveAvatarSrc } from './avatar';

describe('resolveAvatarSrc', () => {
  it('rejects remote raster avatars so peer profile data cannot trigger network requests', () => {
    expect(resolveAvatarSrc('https://example.com/avatar.png', 'Neo')).toMatch(/^data:image\/svg\+xml;utf8,/);
  });

  it('keeps bounded local raster data avatars', () => {
    expect(resolveAvatarSrc('data:image/png;base64,AA==', 'Neo')).toBe('data:image/png;base64,AA==');
  });

  it('rejects oversized local avatar data', () => {
    const oversized = `data:image/png;base64,${'A'.repeat(512 * 1024)}`;
    expect(resolveAvatarSrc(oversized, 'Neo')).toMatch(/^data:image\/svg\+xml;utf8,/);
  });

  it('falls back for blob and svg avatars', () => {
    const svgFallback = resolveAvatarSrc('data:image/svg+xml,<svg></svg>', 'Neo User');
    const blobFallback = resolveAvatarSrc('blob:https://example.com/avatar', 'Neo User');

    expect(svgFallback).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(blobFallback).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(svgFallback).toContain('NU');
  });

  it('falls back for relative and protocol-relative avatar sources', () => {
    expect(resolveAvatarSrc('/avatars/neo.png', 'Neo User')).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(resolveAvatarSrc('//example.com/avatar.png', 'Neo User')).toMatch(/^data:image\/svg\+xml;utf8,/);
  });

  it('falls back for malformed avatar sources', () => {
    expect(resolveAvatarSrc(123, 'Neo User')).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(resolveAvatarSrc({ href: 'https://example.com/avatar.png' }, 'Neo User')).toMatch(/^data:image\/svg\+xml;utf8,/);
  });

  it('falls back safely when the fallback label is malformed', () => {
    expect(resolveAvatarSrc(123, 456)).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(resolveAvatarSrc(null, { label: 'Neo' })).toMatch(/^data:image\/svg\+xml;utf8,/);
  });
});
