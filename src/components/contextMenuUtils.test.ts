import { afterEach, describe, expect, it, vi } from 'vitest';
import { canCopyTextToClipboardSafely, copyTextToClipboardSafely, openUrlSafely, safeConfirm, safeGetSelectedText, safeReloadPage } from './contextMenuUtils';
import { ALLOWED_IMAGE_SCHEMES } from './contextMenuUtils';

function setClipboard(writeTextImpl?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeTextImpl
      ? { writeText: vi.fn(writeTextImpl) }
      : { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  return navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> };
}

describe('contextMenuUtils clipboard helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
  });

  it('reports clipboard availability when the getter throws', () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });

    expect(canCopyTextToClipboardSafely()).toBe(false);
  });

  it('returns false when clipboard writes are blocked', async () => {
    const clipboard = setClipboard(() => Promise.reject(new Error('blocked')));

    await expect(copyTextToClipboardSafely('copy me')).resolves.toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledWith('copy me');
  });

  it('returns true when clipboard writes succeed', async () => {
    const clipboard = setClipboard();

    await expect(copyTextToClipboardSafely('copy me')).resolves.toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('copy me');
  });

  it('returns false when confirm throws', () => {
    const previous = window.confirm;
    Object.defineProperty(window, 'confirm', {
      configurable: true,
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });

    expect(safeConfirm('Continue?')).toBe(false);

    Object.defineProperty(window, 'confirm', { configurable: true, value: previous });
  });

  it('returns an empty selection when getSelection throws', () => {
    const previous = window.getSelection;
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });

    expect(safeGetSelectedText()).toBe('');

    Object.defineProperty(window, 'getSelection', { configurable: true, value: previous });
  });

  it('returns false when reload throws or is unavailable', () => {
    const previous = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: vi.fn(() => { throw new Error('blocked'); }) },
    });

    expect(safeReloadPage()).toBe(false);

    Object.defineProperty(window, 'location', { configurable: true, value: previous });
  });

  it('rejects relative and protocol-relative urls', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    expect(openUrlSafely('/docs/guide', new Set(['http', 'https']))).toBe(false);
    expect(openUrlSafely('//example.com/path', new Set(['http', 'https']))).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('still blocks unsafe image urls', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    expect(openUrlSafely('data:text/html,<script>alert(1)</script>', ALLOWED_IMAGE_SCHEMES)).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
