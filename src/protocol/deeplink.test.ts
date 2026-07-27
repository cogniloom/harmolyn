import { describe, expect, it } from "vitest";
import { DeeplinkValidationError, parseJoinDeepLink, buildJoinDeepLink, parseInviteMetadata } from "./deeplink";
import { parseAbsoluteUrl } from './url';

describe("member-seed round-trip (WS-D)", () => {
  const OWNER = "ownerPeer12345678901234";
  const S1 = "memberSeedAAAAAAAAAAAAAA";
  const S2 = "memberSeedBBBBBBBBBBBBBB";

  it("carries seeds through build → parse", () => {
    const link = buildJoinDeepLink("cyber-devs", OWNER, "Cyber Devs", "tok-123", [S1, S2]);
    const meta = parseInviteMetadata(link);
    expect(meta.serverId).toBe("cyber-devs");
    expect(meta.ownerPeerId).toBe(OWNER);
    expect(meta.inviteToken).toBe("tok-123");
    expect(meta.seeds).toEqual([S1, S2]);
  });

  it("drops the owner and duplicates from seeds, and caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => `seedPeer${String(i).padStart(16, "0")}`);
    const link = buildJoinDeepLink("cyber-devs", OWNER, undefined, undefined, [OWNER, S1, S1, ...many]);
    const meta = parseInviteMetadata(link);
    expect(meta.seeds).not.toContain(OWNER);
    expect(new Set(meta.seeds).size).toBe(meta.seeds!.length); // no dupes
    expect(meta.seeds!.length).toBeLessThanOrEqual(8);
  });

  it("omits seeds entirely when none are valid", () => {
    const link = buildJoinDeepLink("cyber-devs", OWNER, undefined, undefined, ["!!", "short"]);
    const meta = parseInviteMetadata(link);
    expect(meta.seeds).toBeUndefined();
  });

  it("is backward-compatible with seed-less invites", () => {
    const link = buildJoinDeepLink("cyber-devs", OWNER);
    const meta = parseInviteMetadata(link);
    expect(meta.seeds).toBeUndefined();
    expect(meta.ownerPeerId).toBe(OWNER);
  });
});

function makeXoreinInviteDeeplink(serverId = "cyber-devs") {
  const rawInvite = Buffer.from(JSON.stringify({
    server_id: serverId,
    owner_peer_id: "owner-peer",
    owner_public_key: "owner-public-key",
    manifest_hash: "0123456789abcdef0123456789abcdef",
    expires_at: "",
    security_mode: "seal",
    signature: "signed-payload",
  }), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return { deeplink: `xorein://invite/${rawInvite}`, rawInvite };
}

describe("parseAbsoluteUrl", () => {
  it("returns a parsed absolute url", () => {
    expect(parseAbsoluteUrl("https://join/cyber-devs?invite=signed")?.hostname).toBe("join");
  });

  it("returns null for malformed urls", () => {
    expect(parseAbsoluteUrl("not a url")).toBeNull();
  });
});

describe("parseJoinDeepLink", () => {
  it("parses the canonical join deeplink shape", () => {
    expect(parseJoinDeepLink("aether://join/cyber-devs?invite=signed-payload")).toEqual({
      serverId: "cyber-devs",
      invite: "signed-payload",
    });
  });

  it("parses signed xorein invite deeplinks", () => {
    const { deeplink, rawInvite } = makeXoreinInviteDeeplink();

    expect(parseJoinDeepLink(deeplink)).toEqual({
      serverId: "cyber-devs",
      invite: rawInvite,
    });
  });

  it("rejects malformed URLs with a structured deeplink validation error", () => {
    expect(() => parseJoinDeepLink("not a url")).toThrowError(DeeplinkValidationError);
    expect(() => parseJoinDeepLink("not a url")).toThrowError(/malformed absolute URL/);
  });

  it("rejects deeplinks that do not use the supported invite schemes", () => {
    expect(() => parseJoinDeepLink("https://join/cyber-devs?invite=signed-payload")).toThrowError(DeeplinkValidationError);
    expect(() => parseJoinDeepLink("https://join/cyber-devs?invite=signed-payload")).toThrowError(/invalid scheme, expected xorein or aether/);
  });

  it("parses deeplinks without an invite as invite-less discovery records", () => {
    expect(parseJoinDeepLink("aether://join/cyber-devs")).toEqual({
      serverId: "cyber-devs",
      invite: null,
    });
  });

  it("rejects malformed xorein invite payloads", () => {
    expect(() => parseJoinDeepLink("xorein://invite/not-base64")).toThrowError(DeeplinkValidationError);
    expect(() => parseJoinDeepLink("xorein://invite/not-base64")).toThrowError(/xorein invite payload/);
  });

  it("rejects deeplinks that are too long", () => {
    const overlongJoin = `aether://join/${"a".repeat(16_385)}?invite=signed-payload`;
    const overlongInvite = `xorein://invite/${"a".repeat(12_289)}`;

    expect(() => parseJoinDeepLink(overlongJoin)).toThrowError(/deeplink too long/);
    expect(() => parseJoinDeepLink(overlongInvite)).toThrowError(/deeplink too long|xorein invite payload too long/);
  });

  it("rejects array-shaped xorein invite payloads", () => {
    const payload = Buffer.from(JSON.stringify([]), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

    expect(() => parseJoinDeepLink(`xorein://invite/${payload}`)).toThrowError(/xorein invite payload must be an object/);
  });
});
