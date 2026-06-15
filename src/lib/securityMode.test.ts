import { describe, it, expect } from "vitest";
import { resolveSecurityMode } from "./securityMode";

describe("resolveSecurityMode", () => {
  it("maps each negotiated mode to its badge", () => {
    expect(resolveSecurityMode("seal").key).toBe("seal");
    expect(resolveSecurityMode("tree").key).toBe("tree");
    expect(resolveSecurityMode("clear").key).toBe("clear");
    expect(resolveSecurityMode("unspecified").key).toBe("unspecified");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveSecurityMode("  SEAL ").key).toBe("seal");
    expect(resolveSecurityMode("Clear").key).toBe("clear");
  });

  it("treats the forward-compat crowd/channel aliases as crowd", () => {
    expect(resolveSecurityMode("crowd").key).toBe("crowd");
    expect(resolveSecurityMode("channel").key).toBe("crowd");
  });

  it("falls back to unspecified for absent or unknown modes", () => {
    expect(resolveSecurityMode(undefined).key).toBe("unspecified");
    expect(resolveSecurityMode(null).key).toBe("unspecified");
    expect(resolveSecurityMode("").key).toBe("unspecified");
    expect(resolveSecurityMode("nonsense").key).toBe("unspecified");
  });

  it("flags clear as the alarming danger treatment and seal/tree as encrypted", () => {
    expect(resolveSecurityMode("clear").className).toContain("danger");
    expect(resolveSecurityMode("seal").className).toContain("success");
    expect(resolveSecurityMode("tree").className).toContain("primary");
    expect(resolveSecurityMode("clear").label).toMatch(/UNENCRYPTED/);
  });

  it("marks only clear as insecure so the UI can treat it as an alarm state", () => {
    expect(resolveSecurityMode("clear").insecure).toBe(true);
    expect(resolveSecurityMode("seal").insecure).toBeFalsy();
    expect(resolveSecurityMode("tree").insecure).toBeFalsy();
    expect(resolveSecurityMode("crowd").insecure).toBeFalsy();
    expect(resolveSecurityMode("unspecified").insecure).toBeFalsy();
  });

  it("provides a non-empty human-readable description for every mode", () => {
    for (const mode of ["seal", "tree", "crowd", "clear", "unspecified"]) {
      expect(resolveSecurityMode(mode).description.length).toBeGreaterThan(0);
    }
  });

  it("does not claim a verification state for the un-negotiated fallback", () => {
    expect(resolveSecurityMode(undefined).label).not.toMatch(/verif/i);
  });
});
