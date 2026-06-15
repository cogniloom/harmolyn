import { afterEach, describe, expect, it, vi } from "vitest";

import { ALLOWED_IMAGE_SCHEMES, copyTextToClipboardSafely, openUrlSafely, safeConfirm, safeGetSelectedText, safeReloadPage } from "./contextMenuUtils";
import { safeViewportSize } from "@/lib/browserViewport";

function setClipboardWriteTextMock(implementation: (text: string) => Promise<void>) {
  const writeText = vi.fn(implementation);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

describe("openUrlSafely", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
  });

  it("opens allowed urls with noopener and noreferrer", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const ok = openUrlSafely("https://example.com/path?q=1", new Set(["http", "https"]));

    expect(ok).toBe(true);
    expect(openSpy).toHaveBeenCalledWith("https://example.com/path?q=1", "_blank", "noopener,noreferrer");
  });

  it("rejects javascript urls", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const ok = openUrlSafely("javascript:alert(1)", new Set(["http", "https"]));

    expect(ok).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('falls back when selection and reload browser APIs throw', () => {
    const selectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => {
      throw new Error('blocked');
    });
    const previous = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      get() {
        return { reload: vi.fn(() => { throw new Error('blocked'); }) } as unknown as Location;
      },
    });

    expect(safeGetSelectedText()).toBe('');
    expect(safeReloadPage()).toBe(false);
    expect(selectionSpy).toHaveBeenCalled();

    Object.defineProperty(window, 'location', { configurable: true, value: previous });
  });

  it("rejects svg, blob, and html image urls while keeping raster data images", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const imageOk = openUrlSafely("data:image/png;base64,iVBORw0KGgo=", ALLOWED_IMAGE_SCHEMES);
    const svgOk = openUrlSafely("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>", ALLOWED_IMAGE_SCHEMES);
    const blobOk = openUrlSafely("blob:https://example.com/1234", ALLOWED_IMAGE_SCHEMES);
    const remoteSvgOk = openUrlSafely("https://example.com/image.svg", ALLOWED_IMAGE_SCHEMES);
    const htmlOk = openUrlSafely("data:text/html,<script>alert(1)</script>", ALLOWED_IMAGE_SCHEMES);

    expect(imageOk).toBe(true);
    expect(svgOk).toBe(false);
    expect(blobOk).toBe(false);
    expect(remoteSvgOk).toBe(false);
    expect(htmlOk).toBe(false);
    expect(openSpy).toHaveBeenCalledWith("data:image/png;base64,iVBORw0KGgo=", "_blank", "noopener,noreferrer");
    expect(openSpy).not.toHaveBeenCalledWith("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>", "_blank", "noopener,noreferrer");
    expect(openSpy).not.toHaveBeenCalledWith("blob:https://example.com/1234", "_blank", "noopener,noreferrer");
    expect(openSpy).not.toHaveBeenCalledWith("https://example.com/image.svg", "_blank", "noopener,noreferrer");
    expect(openSpy).not.toHaveBeenCalledWith("data:text/html,<script>alert(1)</script>", "_blank", "noopener,noreferrer");
  });


  it("falls back when viewport getters throw", () => {
    const previousWidth = window.innerWidth;
    const previousHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });

    expect(safeViewportSize()).toEqual({ width: null, height: null });

    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth, writable: true });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: previousHeight, writable: true });
  });


  it("returns false when clipboard writes are blocked", async () => {
    const writeSpy = setClipboardWriteTextMock(() => Promise.reject(new Error('blocked')));

    await expect(copyTextToClipboardSafely('copy me')).resolves.toBe(false);
    expect(writeSpy).toHaveBeenCalledWith('copy me');
  });

  it("returns true when clipboard writes succeed", async () => {
    const writeSpy = setClipboardWriteTextMock(() => Promise.resolve(undefined));

    await expect(copyTextToClipboardSafely('copy me')).resolves.toBe(true);
    expect(writeSpy).toHaveBeenCalledWith('copy me');
  });
});
