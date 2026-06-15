import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePersistentState } from "./usePersistentState";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("usePersistentState", () => {
  it("seeds from the fallback and persists it under the key", () => {
    const { result } = renderHook(() => usePersistentState("test:key", { count: 0 }));
    expect(result.current[0]).toEqual({ count: 0 });
    expect(JSON.parse(window.localStorage.getItem("test:key")!)).toEqual({ count: 0 });
  });

  it("hydrates from an existing stored value", () => {
    window.localStorage.setItem("test:key", JSON.stringify({ count: 42 }));
    const { result } = renderHook(() => usePersistentState("test:key", { count: 0 }));
    expect(result.current[0]).toEqual({ count: 42 });
  });

  it("persists updates, including functional updates", () => {
    const { result } = renderHook(() => usePersistentState("test:counter", 1));
    act(() => result.current[1]((current) => current + 1));
    expect(result.current[0]).toBe(2);
    expect(JSON.parse(window.localStorage.getItem("test:counter")!)).toBe(2);
  });

  it("falls back when the stored value is malformed JSON", () => {
    window.localStorage.setItem("test:key", "{broken");
    const { result } = renderHook(() => usePersistentState("test:key", { ok: true }));
    expect(result.current[0]).toEqual({ ok: true });
  });

  it("falls back when the stored value has the wrong JSON shape", () => {
    window.localStorage.setItem("test:key", JSON.stringify([]));
    const { result } = renderHook(() => usePersistentState("test:key", false));
    expect(result.current[0]).toBe(false);
  });

  it("falls back when the stored value is a null-prototype object", () => {
    vi.spyOn(JSON, "parse").mockReturnValueOnce(Object.create(null));
    window.localStorage.setItem("test:key", "{}");
    const { result } = renderHook(() => usePersistentState("test:key", { ok: true }));
    expect(result.current[0]).toEqual({ ok: true });
  });

  it("falls back when the storage getter itself throws", () => {
    const storageError = new DOMException("Blocked", "SecurityError");
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw storageError;
    });

    const { result } = renderHook(() => usePersistentState("test:getter-blocked", { count: 7 }));
    expect(result.current[0]).toEqual({ count: 7 });

    act(() => result.current[1]({ count: 9 }));
    expect(result.current[0]).toEqual({ count: 9 });
  });

  it("falls back to the provided default when storage is blocked", () => {
    const storageError = new DOMException("Blocked", "SecurityError");
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw storageError;
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw storageError;
    });

    const { result } = renderHook(() => usePersistentState("test:blocked", { count: 7 }));
    expect(result.current[0]).toEqual({ count: 7 });

    act(() => result.current[1]({ count: 9 }));
    expect(result.current[0]).toEqual({ count: 9 });
  });
});
