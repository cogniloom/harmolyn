import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePerformanceMode } from "./usePerformanceMode";

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(window, "navigator");

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.classList.remove("perf-mode");
  if (originalNavigatorDescriptor) {
    Object.defineProperty(window, "navigator", originalNavigatorDescriptor);
  }
});

describe("usePerformanceMode", () => {
  it("falls back cleanly when localStorage is blocked", async () => {
    const storageError = new DOMException("Blocked", "SecurityError");
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw storageError;
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw storageError;
    });

    const { result } = renderHook(() => usePerformanceMode());

    await waitFor(() => {
      expect(result.current.perfMode).toBe(false);
    });
    expect(document.documentElement.classList.contains("perf-mode")).toBe(false);

    act(() => {
      result.current.togglePerfMode();
    });
    await waitFor(() => {
      expect(result.current.perfMode).toBe(true);
    });
    expect(document.documentElement.classList.contains("perf-mode")).toBe(true);
  });


  it("falls back cleanly when navigator getters throw", async () => {
    Object.defineProperty(window, "navigator", {
      configurable: true,
      get() {
        return {
          get deviceMemory() {
            throw new Error("blocked");
          },
          get hardwareConcurrency() {
            throw new Error("blocked");
          },
        } as unknown as Navigator;
      },
    });

    const { result } = renderHook(() => usePerformanceMode());

    await waitFor(() => {
      expect(result.current.perfMode).toBe(false);
    });
    expect(document.documentElement.classList.contains("perf-mode")).toBe(false);
  });

  it("falls back cleanly when matchMedia throws", async () => {
    const previous = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });

    const { result } = renderHook(() => usePerformanceMode());

    await waitFor(() => {
      expect(result.current.perfMode).toBe(false);
    });
    expect(document.documentElement.classList.contains("perf-mode")).toBe(false);

    Object.defineProperty(window, "matchMedia", { configurable: true, value: previous });
  });
});
