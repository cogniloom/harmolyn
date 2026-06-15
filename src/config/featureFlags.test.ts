import { describe, it, expect, afterEach, vi } from "vitest";
import {
  FEATURES,
  FEATURE_OVERRIDES_STORAGE_KEY,
  readFeatureOverrides,
  resolveFeatureFlag,
} from "./featureFlags";

afterEach(() => {
  window.localStorage.clear();
});

describe("resolveFeatureFlag", () => {
  it("returns the compiled default when no override is present", () => {
    expect(resolveFeatureFlag("directMessages")).toBe(FEATURES.directMessages);
    expect(resolveFeatureFlag("forumChannels")).toBe(FEATURES.forumChannels);
  });

  it("lets a localStorage override flip a flag in either direction", () => {
    window.localStorage.setItem(
      FEATURE_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ forumChannels: true, directMessages: false }),
    );
    expect(resolveFeatureFlag("forumChannels")).toBe(true);
    expect(resolveFeatureFlag("directMessages")).toBe(false);
  });
});

describe("readFeatureOverrides", () => {
  it("returns an empty object when nothing is stored", () => {
    expect(readFeatureOverrides()).toEqual({});
  });

  it("ignores unknown keys and non-boolean values", () => {
    window.localStorage.setItem(
      FEATURE_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ forumChannels: true, notARealFlag: true }),
    );
    const overrides = readFeatureOverrides();
    expect(overrides).toEqual({ forumChannels: true });
  });

  it("ignores array-shaped overrides", () => {
    window.localStorage.setItem(FEATURE_OVERRIDES_STORAGE_KEY, JSON.stringify(["forumChannels"]));
    expect(readFeatureOverrides()).toEqual({});
  });

  it("falls back to an empty object on malformed JSON", () => {
    window.localStorage.setItem(FEATURE_OVERRIDES_STORAGE_KEY, "{not json");
    expect(readFeatureOverrides()).toEqual({});
  });

  it("falls back to an empty object when storage access is blocked", () => {
    const storageError = new DOMException("Blocked", "SecurityError");
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw storageError;
    });

    expect(readFeatureOverrides()).toEqual({});
  });
});
