import { describe, expect, it } from 'vitest';
import { resolveAvatarSrc } from './avatar';

describe('resolveAvatarSrc', () => {
  it('keeps safe remote raster avatars', () => {
    expect(resolveAvatarSrc('https://example.com/avatar.png', 'Neo')).toBe('https://example.com/avatar.png');
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
