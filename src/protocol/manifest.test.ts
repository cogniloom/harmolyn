import { afterEach, describe, expect, it, vi } from "vitest";
import { ManifestValidationError, cloneManifest, signManifest, validateStoredSignature } from "./manifest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("manifest crypto fallbacks", () => {
  it("rejects signing when neither WebCrypto nor Node crypto is available", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.stubGlobal("process", { versions: {} });

    await expect(signManifest({
      serverId: "srv-1",
      version: 1,
      description: "Test server",
      updatedAt: "2026-05-27T00:00:00Z",
      capabilities: { chat: true, voice: false },
    }, "peer-1")).rejects.toBeInstanceOf(ManifestValidationError);
    await expect(signManifest({
      serverId: "srv-1",
      version: 1,
      description: "Test server",
      updatedAt: "2026-05-27T00:00:00Z",
      capabilities: { chat: true, voice: false },
    }, "peer-1")).rejects.toMatchObject({ message: "WebCrypto unavailable" });
  });

  it("rejects xorein manifest signature validation when neither WebCrypto nor Node crypto is available", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.stubGlobal("process", { versions: {} });

    await expect(validateStoredSignature({
      serverId: "srv-2",
      identity: "peer-owner",
      version: 1,
      name: "Test",
      description: "Test server",
      ownerPeerId: "peer-owner",
      ownerPublicKey: "owner-key",
      ownerAddresses: [],
      updatedAt: "2026-05-27T00:00:00Z",
      issuedAt: "2026-05-27T00:00:00Z",
      capabilities: ["cap.chat"],
      signature: "sig",
    })).rejects.toBeInstanceOf(ManifestValidationError);
    await expect(validateStoredSignature({
      serverId: "srv-2",
      identity: "peer-owner",
      version: 1,
      name: "Test",
      description: "Test server",
      ownerPeerId: "peer-owner",
      ownerPublicKey: "owner-key",
      ownerAddresses: [],
      updatedAt: "2026-05-27T00:00:00Z",
      issuedAt: "2026-05-27T00:00:00Z",
      capabilities: ["cap.chat"],
      signature: "sig",
    })).rejects.toMatchObject({ message: "WebCrypto unavailable" });
  });
});

describe("manifest field validation", () => {
  it("clones manifests without preserving raw extra keys", () => {
    const source = {
      serverId: "srv-4",
      identity: "peer-owner",
      version: 1,
      name: "Test",
      description: "Test server",
      ownerPeerId: "peer-owner",
      ownerPublicKey: "owner-key",
      ownerAddresses: ["addr-1"],
      bootstrapAddrs: ["bootstrap-1"],
      relayAddrs: ["relay-1"],
      updatedAt: "2026-05-27T00:00:00Z",
      issuedAt: "2026-05-27T00:00:00Z",
      expiresAt: "2026-06-27T00:00:00Z",
      historyRetentionMessages: 50,
      historyCoverage: "local-window",
      historyDurability: "eventual",
      capabilities: { chat: true, voice: false },
      signature: "sig",
      unexpected: { bad: true } as never,
    } as unknown as Parameters<typeof cloneManifest>[0];
    const manifest = cloneManifest(source);

    expect((manifest as unknown as Record<string, unknown>).unexpected).toBeUndefined();
    expect(manifest.ownerAddresses).toEqual(["addr-1"]);
    expect(manifest.bootstrapAddrs).toEqual(["bootstrap-1"]);
    expect(manifest.relayAddrs).toEqual(["relay-1"]);
    expect(manifest.capabilities).toEqual({ chat: true, voice: false });
    expect(manifest.ownerAddresses).not.toBe(source.ownerAddresses);
    expect(manifest.bootstrapAddrs).not.toBe(source.bootstrapAddrs);
    expect(manifest.relayAddrs).not.toBe(source.relayAddrs);
    expect(manifest.capabilities).not.toBe(source.capabilities);
  });

  it("rejects malformed xorein manifest field types", async () => {
    await expect(validateStoredSignature({
      serverId: "srv-3",
      identity: "peer-owner",
      version: 1,
      name: "Test",
      description: "Test server",
      ownerPeerId: "peer-owner",
      ownerPublicKey: "owner-key",
      ownerAddresses: [1 as unknown as string],
      updatedAt: "2026-05-27T00:00:00Z",
      issuedAt: "2026-05-27T00:00:00Z",
      capabilities: ["cap.chat"],
      signature: "sig",
    } as unknown as Parameters<typeof validateStoredSignature>[0])).rejects.toBeInstanceOf(ManifestValidationError);
  });

  it("rejects malformed legacy manifest field types", async () => {
    await expect(signManifest({
      serverId: 123 as unknown as string,
      version: 1,
      description: "Test server",
      updatedAt: "2026-05-27T00:00:00Z",
      capabilities: { chat: true, voice: false },
    } as unknown as Parameters<typeof signManifest>[0], "peer-1")).rejects.toBeInstanceOf(ManifestValidationError);
  });
});
