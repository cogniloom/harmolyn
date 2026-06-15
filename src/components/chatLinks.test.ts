import { describe, expect, it, vi } from 'vitest';
import { buildMessageLink, normalizeMessageLinkOrigin, safeLocationOrigin } from './chatLinks';

describe('buildMessageLink', () => {
  it('encodes route segments', () => {
    expect(buildMessageLink('https://app.example', 'chan/1?x=1', 'msg#2')).toBe('https://app.example/#/messages/chan%2F1%3Fx%3D1/msg%232');
  });

  it('falls back to a scope placeholder when no channel id is available', () => {
    expect(buildMessageLink('https://app.example', undefined, 'msg-1')).toBe('https://app.example/#/messages/scope/msg-1');
  });

  it('rejects invalid origins', () => {
    expect(buildMessageLink('/relative', 'chan-1', 'msg-1')).toBeNull();
    expect(buildMessageLink('javascript:alert(1)', 'chan-1', 'msg-1')).toBeNull();
  });
});

describe('normalizeMessageLinkOrigin', () => {
  it('canonicalizes safe http and https origins', () => {
    expect(normalizeMessageLinkOrigin('HTTPS://Example.com/base/path')).toBe('https://example.com');
  });

  it('preserves tauri-style origins with a host', () => {
    expect(normalizeMessageLinkOrigin('tauri://localhost/index.html')).toBe('tauri://localhost');
  });

  it('rejects relative and protocol-relative origins', () => {
    expect(normalizeMessageLinkOrigin('/relative')).toBeNull();
    expect(normalizeMessageLinkOrigin('//example.com')).toBeNull();
  });

  it('rejects unsupported custom origins', () => {
    expect(normalizeMessageLinkOrigin('ftp://example.com')).toBeNull();
    expect(normalizeMessageLinkOrigin('javascript://example.com')).toBeNull();
  });
});

describe('safeLocationOrigin', () => {
  it('returns the browser origin when available', () => {
    const previous = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { href: 'https://app.example/chat?panel=friends' } });

    expect(safeLocationOrigin()).toBe('https://app.example');

    Object.defineProperty(window, 'location', { configurable: true, value: previous });
  });

  it('returns the tauri origin when available', () => {
    const previous = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { href: 'tauri://localhost/index.html#/chat' } });

    expect(safeLocationOrigin()).toBe('tauri://localhost');

    Object.defineProperty(window, 'location', { configurable: true, value: previous });
  });

  it('returns null when the location getter throws', () => {
    const previous = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });

    expect(safeLocationOrigin()).toBeNull();

    Object.defineProperty(window, 'location', { configurable: true, value: previous });
  });
});
