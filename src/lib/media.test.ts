import { describe, expect, it } from 'vitest';
import { isSafePreviewImageSource, resolvePreviewImageSrc } from './media';

describe('media preview helpers', () => {
  it('accepts safe raster remote and data URLs', () => {
    expect(isSafePreviewImageSource('https://example.com/image.png')).toBe(true);
    expect(isSafePreviewImageSource('data:image/png;base64,AAAA')).toBe(true);
  });

  it('canonicalizes safe remote preview URLs before rendering', () => {
    expect(resolvePreviewImageSrc('HTTPS://Example.com/Image.PNG?ref=chat')).toBe('https://example.com/Image.PNG?ref=chat');
  });

  it('rejects svg and blob image sources', () => {
    expect(isSafePreviewImageSource('https://example.com/image.svg')).toBe(false);
    expect(isSafePreviewImageSource('blob:https://example.com/image')).toBe(false);
    expect(resolvePreviewImageSrc('https://example.com/image.svg')).toBeNull();
  });

  it('rejects relative and protocol-relative preview sources', () => {
    expect(isSafePreviewImageSource('/assets/image.png')).toBe(false);
    expect(isSafePreviewImageSource('//example.com/image.png')).toBe(false);
    expect(resolvePreviewImageSrc('/assets/image.png')).toBeNull();
    expect(resolvePreviewImageSrc('//example.com/image.png')).toBeNull();
  });
});
