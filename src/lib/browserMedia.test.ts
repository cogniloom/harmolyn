import { afterEach, describe, expect, it, vi } from "vitest";
import { safeMatchMedia } from "./browserMedia";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeMatchMedia", () => {
  it("returns a media query list when available", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true } as MediaQueryList);
    const previous = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });

    expect(safeMatchMedia("(max-width: 767px)")?.matches).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 767px)");

    Object.defineProperty(window, "matchMedia", { configurable: true, value: previous });
  });

  it("returns null when matchMedia throws", () => {
    const previous = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });

    expect(safeMatchMedia("(prefers-reduced-motion: reduce)")).toBeNull();

    Object.defineProperty(window, "matchMedia", { configurable: true, value: previous });
  });
});
