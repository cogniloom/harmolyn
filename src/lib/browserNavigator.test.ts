import { afterEach, describe, expect, it } from "vitest";
import { safeNavigatorInfo } from "./browserNavigator";

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(window, "navigator");

afterEach(() => {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(window, "navigator", originalNavigatorDescriptor);
  }
});

describe("safeNavigatorInfo", () => {
  it("returns nulls when the navigator getter itself throws", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });

    expect(safeNavigatorInfo()).toEqual({
      deviceMemory: null,
      hardwareConcurrency: null,
    });
  });

  it("returns nulls when navigator getters throw", () => {
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

    expect(safeNavigatorInfo()).toEqual({
      deviceMemory: null,
      hardwareConcurrency: null,
    });
  });

  it("returns numbers when navigator values are available", () => {
    Object.defineProperty(window, "navigator", {
      configurable: true,
      value: {
        deviceMemory: 8,
        hardwareConcurrency: 12,
      },
    });

    expect(safeNavigatorInfo()).toEqual({
      deviceMemory: 8,
      hardwareConcurrency: 12,
    });
  });
});
