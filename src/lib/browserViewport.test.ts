import { afterEach, describe, expect, it, vi } from "vitest";
import { safeViewportSize } from "./browserViewport";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeViewportSize", () => {
  it("returns the viewport size when available", () => {
    const previousWidth = window.innerWidth;
    const previousHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280, writable: true });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720, writable: true });

    expect(safeViewportSize()).toEqual({ width: 1280, height: 720 });

    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth, writable: true });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: previousHeight, writable: true });
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
});
