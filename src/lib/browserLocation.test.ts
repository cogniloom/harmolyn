import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeLocationHref, safeLocationSearch, safeParseUrl } from './browserLocation';

const originalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');

afterEach(() => {
  vi.restoreAllMocks();
  if (originalLocationDescriptor) {
    Object.defineProperty(globalThis, 'location', originalLocationDescriptor);
  }
});

describe('safeLocationHref', () => {
  it('returns the browser href when available', () => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://app.example/chat?panel=friends' } });

    expect(safeLocationHref()).toBe('https://app.example/chat?panel=friends');
  });

  it('returns null when the location getter throws', () => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });

    expect(safeLocationHref()).toBeNull();
  });
});

describe('safeParseUrl', () => {
  it('resolves relative paths against the current href', () => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://app.example/base/page' } });

    expect(safeParseUrl('/assets/pic.png', 'https://app.example/base/page')?.toString()).toBe('https://app.example/assets/pic.png');
  });

  it('does not resolve relative paths without an explicit base', () => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://app.example/base/page' } });

    expect(safeParseUrl('/assets/pic.png')).toBeNull();
  });

  it('returns null when the location getter throws', () => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });

    expect(safeParseUrl('/assets/pic.png')).toBeNull();
  });
});

describe('safeLocationSearch', () => {
  it('returns the browser search string when available', () => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?panel=friends' } });

    expect(safeLocationSearch()).toBe('?panel=friends');
  });

  it('returns null when the location getter throws', () => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });

    expect(safeLocationSearch()).toBeNull();
  });
});
