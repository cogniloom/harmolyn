import { describe, expect, it } from "vitest";
import { buildFeatureProtocolContract, deriveLocalCapabilities } from "./featureBridge";

describe("featureBridge input normalization", () => {
  it("ignores array-shaped feature toggle sets", () => {
    expect(deriveLocalCapabilities([] as unknown as Record<string, boolean>)).toEqual([]);
    expect(buildFeatureProtocolContract({
      accepted: [],
      ignoredRemote: [],
      missingRequired: [],
      feedback: "none",
    }, [] as unknown as Record<string, boolean>)).toEqual({
      localSupported: [],
      blockedProtocolFeatures: [],
      localOnlyEnabledFeatures: [],
    });
  });

  it("ignores null-prototype feature toggle sets", () => {
    const toggles = Object.create(null);
    (toggles as Record<string, boolean>).markdownComposer = true;

    expect(deriveLocalCapabilities(toggles)).toEqual([]);
    expect(buildFeatureProtocolContract({
      accepted: ["cap.chat"],
      ignoredRemote: [],
      missingRequired: [],
      feedback: "none",
    }, toggles)).toEqual({
      localSupported: [],
      blockedProtocolFeatures: [],
      localOnlyEnabledFeatures: [],
    });
  });
});
