import { describe, it, expect, vi, afterEach } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import {
  normalizeJoinInput,
  discoverServerByInvite,
  sendChannelMessage,
  createServer,
  createChannel,
  createRole,
  assignRole,
  moderationAction,
  addReaction,
  removeReaction,
  pinMessage,
  unpinMessage,
  sendVoiceSignal,
  createGroupDm,
  addGroupDmMember,
  sendGroupDmMessage,
  createIdentity,
  createDm,
  listGroupDms,
  listDms,
  listPins,
  listRoles,
  connectToDefaultRuntime,
  connectToControlEndpoint,
  consumePendingNativeDeepLinks,
  clearPreferredControlEndpoint,
  getIdentityBackup,
  refreshRuntimeSnapshot,
  removePeer,
  readPreferredControlEndpoint,
  restoreIdentity,
  readNativeRuntimeBootstrapStatus,
  storePreferredControlEndpoint,
  normalizeLaunchControlEndpoint,
  subscribeRuntimeEvents,
  DEFAULT_CONTROL_ENDPOINT,
  listFriends,
  sendFriendRequest,
  actOnFriendRequest,
  removeFriend,
  getPresence,
  updatePresence,
  markNotificationsRead,
  searchMessages,
  searchNotifications,
  getNotificationSummary,
  registerRelay,
  removeRelay,
  addPeer,
  sendDmMessage,
} from "./xoreinControl";
import type { XoreinRuntimeSnapshot } from "@/types";
import { injectControlToken } from "@/test/runtimeHarness";

const runtime = { control_endpoint: "http://127.0.0.1:7711", settings: {} } as XoreinRuntimeSnapshot;

interface StubResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

function invalidJsonResponse(status = 200): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  };
}

function discoveryResponse(serverId = "x", name = "X"): Record<string, unknown> {
  return {
    invite: { server_id: serverId, has_signature: true, owner_peer_id: "owner-peer" },
    manifest: { server_id: serverId, name, security_mode: "seal" },
    owner_role: "owner",
    member_count: 0,
    channels: [],
    safety_labels: ["signed-invite"],
  };
}

function expectNativeControlGlobalsCleared(): void {
  const windowRecord = window as unknown as Record<string, unknown>;
  expect(windowRecord.__HARMOLYN_XOREIN_CONTROL_ENDPOINT__).toBeUndefined();
  expect(windowRecord.__HARMOLYN_CONTROL_ENDPOINT__).toBeUndefined();
  expect(windowRecord.__XOREIN_CONTROL_ENDPOINT__).toBeUndefined();
  expect(windowRecord.__HARMOLYN_XOREIN_CONTROL_READY__).toBeUndefined();
  expect(windowRecord.__HARMOLYN_CONTROL_READY__).toBeUndefined();
  expect(windowRecord.__HARMOLYN_XOREIN_CONTROL_TOKEN__).toBeUndefined();
  expect(windowRecord.__HARMOLYN_CONTROL_TOKEN__).toBeUndefined();
  expect(windowRecord.__XOREIN_CONTROL_TOKEN__).toBeUndefined();
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_ENDPOINT__;
  delete (window as unknown as Record<string, unknown>).__HARMOLYN_CONTROL_ENDPOINT__;
  delete (window as unknown as Record<string, unknown>).__XOREIN_CONTROL_ENDPOINT__;
  delete (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_READY__;
  delete (window as unknown as Record<string, unknown>).__HARMOLYN_CONTROL_READY__;
  delete (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_TOKEN__;
  delete (window as unknown as Record<string, unknown>).__HARMOLYN_CONTROL_TOKEN__;
  delete (window as unknown as Record<string, unknown>).__XOREIN_CONTROL_TOKEN__;
  clearPreferredControlEndpoint();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  invokeMock.mockReset();
  listenMock.mockReset();
});

function makeXoreinInviteDeeplink(serverId = "base-node") {
  const rawInvite = Buffer.from(JSON.stringify({
    server_id: serverId,
    owner_peer_id: "owner-peer",
    owner_public_key: "owner-public-key",
    manifest_hash: "0123456789abcdef0123456789abcdef",
    expires_at: "",
    security_mode: "seal",
    signature: "signed-payload",
  }), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `xorein://invite/${rawInvite}`;
}

describe("normalizeJoinInput", () => {
  it("accepts a valid signed aether invite", () => {
    expect(normalizeJoinInput("aether://join/alpha?invite=signed")).toBe("aether://join/alpha?invite=signed");
  });

  it("accepts a valid signed xorein invite", () => {
    const invite = makeXoreinInviteDeeplink();
    expect(normalizeJoinInput(invite)).toBe(invite);
  });

  it("rejects empty, malformed, and unsigned invites", () => {
    expect(() => normalizeJoinInput("")).toThrow();
    expect(() => normalizeJoinInput("https://example.com")).toThrow();
    expect(() => normalizeJoinInput("aether://join/alpha")).toThrow();
    expect(() => normalizeJoinInput("xorein://invite/not-base64")).toThrow();
  });
});

describe("requestControlApi (through control functions)", () => {
  it("throws runtime_unavailable when there is no control endpoint", async () => {
    injectControlToken("tok");
    await expect(sendChannelMessage(null, "c1", "hi")).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("rejects malformed control endpoints before issuing a request", async () => {
    injectControlToken("tok");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const badRuntime = { control_endpoint: "not-a-url", settings: {} } as XoreinRuntimeSnapshot;

    await expect(discoverServerByInvite(badRuntime, "aether://join/alpha?invite=signed")).rejects.toMatchObject({
      code: "invalid_endpoint",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows remote control endpoints without bearer auth", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse(discoveryResponse("x", "Remote")));
    vi.stubGlobal("fetch", fetchMock);
    const remoteRuntime = { control_endpoint: "https://evil.example/control", settings: {} } as XoreinRuntimeSnapshot;

    const preview = await discoverServerByInvite(remoteRuntime, "aether://join/alpha?invite=signed");
    expect(preview.manifest.server_id).toBe("x");
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("https://evil.example/v1/servers/preview");
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBeUndefined();
  });

  it("omits the Authorization header when no control token is present (public node)", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse(discoveryResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const preview = await discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"));

    expect(preview.manifest.server_id).toBe("x");
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBeUndefined();
  });

  it("calls the resolved local endpoint without bearer auth and returns the parsed body", async () => {
    injectControlToken("tok-123");
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse(discoveryResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const preview = await discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"));
    expect(preview).toEqual(discoveryResponse());

    const url = String(fetchMock.mock.calls[0]?.[0] ?? "");
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
    expect(url).toContain("/v1/servers/preview");
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toBeUndefined();
    expect(JSON.parse(init.body ?? "{}").deeplink).toBe(makeXoreinInviteDeeplink("alpha"));
  });

  it("strips the invite-capability token from the deeplink before asking the node for a preview", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse(discoveryResponse()));
    vi.stubGlobal("fetch", fetchMock);

    // v1 join link carrying the owner-verified HMAC capability token.
    const payload = btoa(JSON.stringify({ v: 1, owner: "owner-peer-owner-peer-x1", name: "Hub", tok: "SECRET-CAPABILITY" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await discoverServerByInvite(runtime, `xorein://join/alpha?invite=${payload}`);

    const sent = String((JSON.parse(String((fetchMock.mock.calls[0]?.[1] as { body?: string })?.body ?? "{}")) as { deeplink?: string }).deeplink ?? "");
    // The capability must never reach the support node, in any encoding.
    expect(sent).not.toContain("SECRET-CAPABILITY");
    expect(atob(sent.split("invite=")[1].replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("SECRET-CAPABILITY");
    // Public preview fields survive.
    expect(sent).toContain("xorein://join/alpha");
  });

  it("rejects primitive discovery bodies before normalizing them", async () => {
    injectControlToken("tok-123");
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse("oops"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"))).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects array discovery bodies before normalizing them", async () => {
    injectControlToken("tok-123");
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"))).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("uses the native bridge for ready local control requests", async () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_ENDPOINT__ = "http://127.0.0.1:7711";
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_READY__ = true;
    invokeMock.mockResolvedValueOnce({ status: 200, body: discoveryResponse("x", "Native") });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const preview = await discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"));

    expect(preview).toEqual(discoveryResponse("x", "Native"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("request_xorein_control_api", {
      endpoint: "http://127.0.0.1:7711",
      method: "POST",
      path: "/v1/servers/preview",
      body: { deeplink: makeXoreinInviteDeeplink("alpha") },
    });
  });

  it("uses the native bridge for a different local node than the managed runtime", async () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_ENDPOINT__ = "http://127.0.0.1:7711";
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_READY__ = true;
    storePreferredControlEndpoint("http://127.0.0.1:7777");
    invokeMock.mockResolvedValueOnce({ status: 200, body: discoveryResponse("x", "External") });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const runtimeSnapshot = { control_endpoint: "http://127.0.0.1:7777", settings: {} } as XoreinRuntimeSnapshot;
    const preview = await discoverServerByInvite(runtimeSnapshot, makeXoreinInviteDeeplink("alpha"));

    expect(preview).toEqual(discoveryResponse("x", "External"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("request_xorein_control_api", {
      endpoint: "http://127.0.0.1:7777",
      method: "POST",
      path: "/v1/servers/preview",
      body: { deeplink: makeXoreinInviteDeeplink("alpha") },
    });
  });

  it("rejects primitive native bridge bodies before normalizing them", async () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_ENDPOINT__ = "http://127.0.0.1:7711";
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_READY__ = true;
    invokeMock.mockResolvedValueOnce({ status: 200, body: "oops" });

    await expect(discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"))).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects array native bridge bodies before normalizing them", async () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_ENDPOINT__ = "http://127.0.0.1:7711";
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_READY__ = true;
    invokeMock.mockResolvedValueOnce({ status: 200, body: [] });

    await expect(discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"))).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects null-prototype native bridge bodies before normalizing them", async () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_ENDPOINT__ = "http://127.0.0.1:7711";
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_READY__ = true;
    invokeMock.mockResolvedValueOnce({ status: 200, body: Object.create(null) });

    await expect(discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"))).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("maps native bridge HTTP failures to structured control errors", async () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_ENDPOINT__ = "http://127.0.0.1:7711";
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_READY__ = true;
    invokeMock.mockResolvedValueOnce({ status: 500, body: { code: "http_500", message: "boom" } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"))).rejects.toMatchObject({
      code: "http_500",
      message: "boom",
      status: 500,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects token-bearing discovery responses before returning them to UI callers", async () => {
    injectControlToken("tok-123");
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse({
      ...discoveryResponse(),
      token: "raw-invite-token",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"))).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects discovery responses with mismatched invite and manifest server IDs", async () => {
    injectControlToken("tok-123");
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse({
      invite: { server_id: "invite-id", has_signature: true },
      manifest: { server_id: "manifest-id", name: "Mismatch" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"))).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects discovery responses with malformed channel entries", async () => {
    injectControlToken("tok-123");
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse({
      invite: { server_id: "alpha", has_signature: true },
      manifest: { server_id: "alpha", name: "Alpha" },
      channels: [{ id: "chan-1", server_id: "alpha", voice: true }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"))).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects discovery responses with malformed safety labels", async () => {
    injectControlToken("tok-123");
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse({
      invite: { server_id: "alpha", has_signature: true },
      manifest: { server_id: "alpha", name: "Alpha" },
      safety_labels: ["signed-invite", ""],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"))).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("uses the hosted default endpoint when no override is configured", () => {
    expect(DEFAULT_CONTROL_ENDPOINT).toBe("https://node.xorein.com");
  });

  it("normalizes trusted launch endpoints and persists them for the next launch", () => {
    window.localStorage.clear();
    expect(normalizeLaunchControlEndpoint("127.0.0.1:7788")).toBe("http://127.0.0.1:7788");
    expect(storePreferredControlEndpoint("127.0.0.1:7788")).toBe("http://127.0.0.1:7788");
    expect(readPreferredControlEndpoint()).toBe("http://127.0.0.1:7788");
  });

  it("accepts arbitrary https preferred endpoints", () => {
    window.localStorage.clear();
    expect(normalizeLaunchControlEndpoint("https://evil.example/control")).toBe("https://evil.example");
    expect(storePreferredControlEndpoint("https://evil.example/control")).toBe("https://evil.example");
    expect(readPreferredControlEndpoint()).toBe("https://evil.example");
  });

  it("prefers a stored launch endpoint over the default node", async () => {
    window.localStorage.clear();
    storePreferredControlEndpoint("127.0.0.1:7788");
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({
        identity: { peer_id: "peer-local" },
        control_endpoint: "http://127.0.0.1:7788",
        settings: {},
        servers: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await connectToDefaultRuntime();

    expect(snapshot?.control_endpoint).toBe("http://127.0.0.1:7788");
    // Autoconnect targets the stored launch endpoint, not the hosted default node.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("http://127.0.0.1:7788/v1/state");
  });

  it("uses the native bridge for an explicit local launch endpoint", async () => {
    storePreferredControlEndpoint("127.0.0.1:7711");
    invokeMock.mockResolvedValueOnce({
      status: 200,
      body: {
        identity: { peer_id: "peer-local" },
        control_endpoint: null,
        known_peers: null,
        relay_addrs: [],
        presence: null,
        servers: [],
        dms: [],
        messages: [],
        friends: null,
        friend_requests: null,
        voice_sessions: [],
        settings: null,
        notifications: [],
        group_dms: [],
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await connectToControlEndpoint("http://127.0.0.1:7711");

    expect(snapshot?.control_endpoint).toBe("http://127.0.0.1:7711");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("request_xorein_control_api", {
      endpoint: "http://127.0.0.1:7711",
      method: "GET",
      path: "/v1/state",
      body: null,
    });
    expect(window.localStorage.getItem("harmolyn:xorein:runtime") ?? "").toContain("peer-local");
  });

  it("maps a non-ok response to a XoreinControlError with the server code and status", async () => {
    injectControlToken("tok");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "forbidden", message: "nope" }, 403)));

    await expect(discoverServerByInvite(runtime, "aether://join/alpha?invite=signed")).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  it("does not clear local control credentials when no bearer token is needed", async () => {
    injectControlToken("stale-token");
    window.localStorage.setItem("harmolyn:control-token", "legacy-stale-token");
    window.localStorage.setItem("xorein:control-token", "legacy-xorein-token");
    window.sessionStorage.setItem("harmolyn:xorein:control-token", "session-stale-token");
    const fetchMock = vi.fn(async () => jsonResponse({ code: "unauthorized", message: "invalid bearer token" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverServerByInvite(runtime, "aether://join/alpha?invite=signed")).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });

    const windowRecord = window as unknown as Record<string, unknown>;
    expect(windowRecord.__HARMOLYN_XOREIN_CONTROL_TOKEN__).toBe("stale-token");
    expect(windowRecord.__HARMOLYN_CONTROL_TOKEN__).toBeUndefined();
    expect(windowRecord.__XOREIN_CONTROL_TOKEN__).toBe("stale-token");
    expect(window.localStorage.getItem("harmolyn:xorein:control-token")).toBe("stale-token");
    expect(window.localStorage.getItem("harmolyn:control-token")).toBe("legacy-stale-token");
    expect(window.localStorage.getItem("xorein:control-token")).toBe("legacy-xorein-token");
    expect(window.sessionStorage.getItem("harmolyn:xorein:control-token")).toBe("session-stale-token");
  });

  it("wraps fetch failures as transport_unavailable", async () => {
    injectControlToken("tok");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    await expect(discoverServerByInvite(runtime, "aether://join/alpha?invite=signed")).rejects.toMatchObject({
      code: "transport_unavailable",
      status: 503,
    });
  });

  it("times out stalled control requests instead of leaving UI actions pending", async () => {
    vi.useFakeTimers();
    try {
      injectControlToken("tok");
      const fetchMock = vi.fn((_url: URL | string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }));
      vi.stubGlobal("fetch", fetchMock);

      const pending = discoverServerByInvite(runtime, "aether://join/alpha?invite=signed");
      const expectation = expect(pending).rejects.toMatchObject({
        code: "transport_unavailable",
        message: "xorein control request timed out.",
        status: 503,
      });
      await vi.advanceTimersByTimeAsync(6000);

      await expectation;
      const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
      expect(init.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the timeout active while parsing a stalled success body", async () => {
    vi.useFakeTimers();
    try {
      injectControlToken("tok");
      const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      const pending = discoverServerByInvite(runtime, "aether://join/alpha?invite=signed");
      const expectation = expect(pending).rejects.toMatchObject({
        code: "transport_unavailable",
        message: "xorein control request timed out.",
        status: 503,
      });
      await vi.advanceTimersByTimeAsync(6000);

      await expectation;
      const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
      expect(init.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the timeout active while parsing a stalled error body", async () => {
    vi.useFakeTimers();
    try {
      injectControlToken("tok");
      const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      const pending = discoverServerByInvite(runtime, "aether://join/alpha?invite=signed");
      const expectation = expect(pending).rejects.toMatchObject({
        code: "transport_unavailable",
        message: "xorein control request timed out.",
        status: 503,
      });
      await vi.advanceTimersByTimeAsync(6000);

      await expectation;
      const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
      expect(init.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps malformed success bodies as invalid_response", async () => {
    injectControlToken("tok");
    vi.stubGlobal("fetch", vi.fn(async () => invalidJsonResponse(200)));

    await expect(discoverServerByInvite(runtime, "aether://join/alpha?invite=signed")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });
});

describe("createServer", () => {
  it("rejects an empty name before calling the API", async () => {
    injectControlToken("tok");
    await expect(createServer(runtime, { name: "   " })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects malformed server records before returning a refreshed snapshot", async () => {
    const fetchMock = vi.fn(async (url: URL | string, _init?: RequestInit) => {
      if (String(url).endsWith("/v1/servers")) {
        return jsonResponse({ id: "srv-1", name: "Alpha", security_mode: "seal", created_at: "2026-01-01T00:00:00Z" }, 201);
      }
      return jsonResponse({ peer_id: "peer-local", servers: [], settings: {} });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createServer(runtime, { name: "Alpha" })).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });
});

describe("identity control API", () => {
  const backupDocument = {
    version: 2,
    alg: "argon2id-aes256gcm",
    peer_id: "peer-local",
    salt: "c2FsdA==",
    nonce: "bm9uY2U=",
    ciphertext: "Y2lwaGVydGV4dA==",
  };

  it("creates identities with the flat xorein payload shape", async () => {
    const fetchMock = vi.fn(async (url: URL | string, _init?: RequestInit) => {
      if (String(url).endsWith("/v1/state")) {
        return jsonResponse({ peer_id: "peer-local", display_name: "Ada", servers: [], settings: {} });
      }
      return jsonResponse({ peer_id: "peer-local", display_name: "Ada" }, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    const identity = await createIdentity(runtime, " Ada ", " hello ");

    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { method?: string; body?: string };
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toBe("http://127.0.0.1:7711/v1/identities");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body ?? "{}")).toEqual({ display_name: "Ada", bio: "hello" });
    expect(identity.peer_id).toBe("peer-local");
  });

  it("rejects malformed identity records before refreshing state", async () => {
    const fetchMock = vi.fn(async (url: URL | string, _init?: RequestInit) => {
      if (String(url).endsWith("/v1/state")) {
        return jsonResponse({ peer_id: "peer-local", display_name: "Ada", servers: [], settings: {} });
      }
      return jsonResponse({ id: "ident-1", peer_id: "   " }, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createIdentity(runtime, "Ada")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("normalizes xorein /v1/state into the Harmolyn runtime shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      unexpected: { bad: true },
      peer_id: "peer-local",
      display_name: "Ada",
      identity: {
        peer_id: "peer-local",
        created_at: "2026-01-01T00:00:00Z",
        profile: { display_name: "Ada", bio: "hello" },
      },
      friends: [{ id: " friend-1 ", from_peer_id: " peer-local ", status: "accepted", created_at: "2026-01-01T00:00:00Z" }],
      friend_requests: [{ id: " request-1 ", from_peer_id: " peer-remote ", status: "pending", created_at: "2026-01-01T00:00:00Z" }],
      servers: [{
        id: "srv-1",
        name: "Alpha",
        owner_peer_id: "peer-owner",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        invite: "  raw-invite  ",
        unexpected_server: { bad: true },
      }],
      channels: [
        { id: " ch-1 ", server_id: "srv-1", name: "general", voice: false, created_at: "2026-01-01T00:00:00Z", unexpected_channel: true },
        { id: "ch-1", server_id: "srv-1", name: "shadowed", voice: false, created_at: "2026-01-02T00:00:00Z" },
      ],
      dms: [{ id: "dm-1", peer_id: "peer-remote", created_at: "2026-01-01T00:00:00Z", unexpected_dm: "bad" }],
      voice_sessions: [
        { id: " ch-voice ", participants: ["peer-local"], unexpected_voice: true },
        { id: "ch-voice", participants: ["u2"] },
      ],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.identity?.peer_id).toBe("peer-local");
    expect(snapshot.identity?.profile?.display_name).toBe("Ada");
    expect(snapshot.identity?.profile?.bio).toBe("hello");
    expect(snapshot.servers?.[0].created_at).toBe("2026-01-01T00:00:00Z");
    expect(snapshot.servers?.[0].updated_at).toBe("2026-01-02T00:00:00Z");
    expect(snapshot.servers?.[0].invite).toBe("raw-invite");
    expect(snapshot.servers?.[0].members).toEqual(["peer-owner", "peer-local"]);
    expect(Object.keys(snapshot.servers?.[0].channels ?? {})).toEqual(["ch-1"]);
    expect(snapshot.servers?.[0].channels["ch-1"].name).toBe("general");
    expect(snapshot.servers?.[0].channels["ch-1"].created_at).toBe("2026-01-01T00:00:00Z");
    expect((snapshot.servers?.[0] as unknown as Record<string, unknown>).unexpected_server).toBeUndefined();
    expect((snapshot.servers?.[0].channels["ch-1"] as unknown as Record<string, unknown>).unexpected_channel).toBeUndefined();
    expect(snapshot.dms?.[0].created_at).toBe("2026-01-01T00:00:00Z");
    expect((snapshot.dms?.[0] as unknown as Record<string, unknown>).unexpected_dm).toBeUndefined();
    expect(snapshot.dms?.[0].participants).toEqual(["peer-local", "peer-remote"]);
    expect(snapshot.friends).toEqual([
      { id: "friend-1", from_peer_id: "peer-local", status: "accepted", created_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(snapshot.friend_requests).toEqual([
      { id: "request-1", from_peer_id: "peer-remote", status: "pending", created_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(snapshot.voice_sessions?.[0].channel_id).toBe("ch-voice");
    expect(snapshot.voice_sessions?.[0].participants["peer-local"].peer_id).toBe("peer-local");
    expect((snapshot.voice_sessions?.[0] as unknown as Record<string, unknown>).unexpected_voice).toBeUndefined();
    expect((snapshot as Record<string, unknown>).unexpected).toBeUndefined();
  });

  it("keeps the first normalized runtime voice session when channel ids collide in /v1/state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      voice_sessions: [
        {
          id: " ch-voice ",
          participants: ["peer-local"],
        },
        {
          id: "ch-voice",
          participants: ["u2"],
        },
      ],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.voice_sessions).toEqual([{
      channel_id: "ch-voice",
      participants: {
        "peer-local": {
          peer_id: "peer-local",
        },
      },
    }]);
  });

  it("keeps the first normalized server when ids collide in /v1/state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      servers: [
        {
          id: " srv-1 ",
          name: "First Alpha",
          owner_peer_id: "peer-owner",
          members: ["peer-owner", "peer-local"],
          channels: {},
        },
        {
          id: "srv-1",
          name: "Second Alpha",
          owner_peer_id: "peer-owner",
          members: ["peer-owner", "peer-local"],
          channels: {},
        },
      ],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.servers).toEqual([
      expect.objectContaining({
        id: "srv-1",
        name: "First Alpha",
      }),
    ]);
  });

  it("keeps the first normalized runtime message when ids collide in /v1/state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      messages: [
        {
          id: " msg-1 ",
          scope_type: " channel ",
          scope_id: " base-node-general ",
          sender_peer_id: " peer-local ",
          body: "first",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "msg-1",
          scope_type: "channel",
          scope_id: "base-node-general",
          sender_peer_id: "u2",
          body: "duplicate",
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.messages).toEqual([
      {
        id: "msg-1",
        scope_type: "channel",
        scope_id: "base-node-general",
        sender_peer_id: "peer-local",
        body: "first",
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("keeps the first normalized DM when ids collide in /v1/state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      dms: [
        { id: " dm-1 ", peer_id: "peer-remote", created_at: "2026-01-01T00:00:00Z" },
        { id: "dm-1", peer_id: "peer-local", created_at: "2026-01-02T00:00:00Z" },
      ],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.dms).toEqual([
      { id: "dm-1", participants: ["peer-local", "peer-remote"], created_at: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("keeps the first normalized friend and friend-request entries in /v1/state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      friends: [
        { id: " friend-1 ", from_peer_id: " peer-local ", status: "accepted", created_at: "2026-01-01T00:00:00Z" },
        { id: "friend-1", from_peer_id: "peer-remote", status: "blocked", created_at: "2026-01-02T00:00:00Z" },
      ],
      friend_requests: [
        { id: " request-1 ", from_peer_id: " peer-remote ", status: "pending", created_at: "2026-01-01T00:00:00Z" },
        { id: "request-1", from_peer_id: "peer-local", status: "cancelled", created_at: "2026-01-02T00:00:00Z" },
      ],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.friends).toEqual([
      { id: "friend-1", from_peer_id: "peer-local", status: "accepted", created_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(snapshot.friend_requests).toEqual([
      { id: "request-1", from_peer_id: "peer-remote", status: "pending", created_at: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("matches normalized channels to padded server ids in /v1/state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      servers: [{
        id: " srv-1 ",
        name: "Alpha",
        owner_peer_id: "peer-owner",
        channels: {},
      }],
      channels: [{
        id: " srv-1-general ",
        server_id: " srv-1 ",
        name: "general",
        voice: false,
      }],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.servers?.[0].id).toBe("srv-1");
    expect(snapshot.servers?.[0].channels["srv-1-general"]).toEqual({
      id: "srv-1-general",
      server_id: "srv-1",
      name: "general",
      voice: false,
    });
  });

  it("normalizes xorein server manifests before publishing runtime snapshots", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      servers: [{
        id: "srv-1",
        name: "Alpha",
        owner_peer_id: "peer-owner",
        manifest: {
          name: " Alpha ",
          description: "  launch node  ",
          relay_addrs: [" /ip4/127.0.0.1/tcp/4001/p2p/relay ", ""],
          capabilities: [" cap.chat ", { bad: true } as never],
        },
      }],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.servers?.[0].manifest).toEqual({
      name: "Alpha",
      description: "launch node",
      relay_addrs: ["/ip4/127.0.0.1/tcp/4001/p2p/relay"],
      capabilities: ["cap.chat"],
    });
  });

  it("drops malformed runtime server descriptions before publishing snapshots", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      servers: [{
        id: "srv-1",
        name: "Alpha",
        description: { bad: true },
        owner_peer_id: "peer-owner",
      }],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.servers?.[0].description).toBeUndefined();
  });

  it("rejects runtime snapshots with inconsistent embedded server channels", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      servers: [{
        id: "srv-1",
        name: "Alpha",
        channels: {
          "ch-1": { id: "ch-1", server_id: "srv-2", name: "general", voice: false },
        },
      }],
      settings: {},
    })));

    await expect(refreshRuntimeSnapshot(runtime)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("keeps the first normalized server channel when ids collide", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      channels: [
        { id: " srv-1-general ", server_id: "srv-1", name: "general", voice: false },
        { id: "srv-1-general", server_id: "srv-1", name: "general backup", voice: false },
      ],
      servers: [{
        id: "srv-1",
        name: "Alpha",
        channels: {},
      }],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.servers?.[0].channels).toEqual({
      "srv-1-general": {
        id: "srv-1-general",
        server_id: "srv-1",
        name: "general",
        voice: false,
      },
    });
  });

  it("rejects runtime snapshots with malformed server records", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      servers: [{
        id: "   ",
        name: "Alpha",
      }],
      settings: {},
    })));

    await expect(refreshRuntimeSnapshot(runtime)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects runtime snapshots with malformed direct messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      dms: [{
        id: "  ",
        peer_id: "peer-remote",
      }],
      settings: {},
    })));

    await expect(refreshRuntimeSnapshot(runtime)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects runtime snapshots with inconsistent voice session participants", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      voice_sessions: [{
        channel_id: "ch-1",
        participants: {
          "peer-a": { peer_id: "peer-b", muted: false },
        },
      }],
      settings: {},
    })));

    await expect(refreshRuntimeSnapshot(runtime)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("keeps the first normalized object-form voice participant when peer ids collide", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      voice_sessions: [{
        channel_id: "ch-1",
        participants: {
          " peer-a ": {
            peer_id: " peer-a ",
            muted: false,
            joined_at: "2026-01-01T00:00:00Z",
          },
          "peer-a": {
            peer_id: "peer-a",
            muted: true,
            joined_at: "2026-02-01T00:00:00Z",
          },
        },
      }],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.voice_sessions).toEqual([{
      channel_id: "ch-1",
      participants: {
        "peer-a": {
          peer_id: "peer-a",
          muted: false,
          joined_at: "2026-01-01T00:00:00Z",
        },
      },
    }]);
  });

  it("keeps the first normalized array-form voice participant when peer ids collide", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      voice_sessions: [{
        channel_id: "ch-2",
        participants: [" peer-a ", "peer-a", " peer-b "],
      }],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.voice_sessions).toEqual([{
      channel_id: "ch-2",
      participants: {
        "peer-a": {
          peer_id: "peer-a",
        },
        "peer-b": {
          peer_id: "peer-b",
        },
      },
    }]);
  });

  it("rejects runtime snapshots with malformed known peers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      known_peers: [{
        peer_id: "   ",
        role: "relay",
      }],
      settings: {},
    })));

    await expect(refreshRuntimeSnapshot(runtime)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("dedupes runtime peers by normalized peer id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      known_peers: [
        { peer_id: " peer-a ", role: "client" },
        { peer_id: "peer-a", role: "relay" },
      ],
      settings: {},
    })));

    const snapshot = await refreshRuntimeSnapshot(runtime);

    expect(snapshot.known_peers).toEqual([
      { peer_id: "peer-a", role: "client" },
    ]);
  });

  it("rejects runtime snapshots with malformed relay addresses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      relay_addrs: [" /ip4/127.0.0.1/tcp/4001/p2p/relay ", ""],
      settings: {},
    })));

    await expect(refreshRuntimeSnapshot(runtime)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects runtime snapshots with malformed presence entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      presence: {
        "": { status: "online", updated_at: "2026-01-01T00:00:00Z" },
      },
      settings: {},
    })));

    await expect(refreshRuntimeSnapshot(runtime)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects runtime snapshots with incomplete presence records", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      presence: {
        "peer-1": { updated_at: "2026-01-01T00:00:00Z" },
      },
      settings: {},
    })));

    await expect(refreshRuntimeSnapshot(runtime)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects runtime snapshots with malformed messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      peer_id: "peer-local",
      messages: [{
        id: "msg-1",
        scope_type: "channel",
        scope_id: "base-node-general",
        sender_peer_id: "peer-remote",
        body: "   ",
      }],
      settings: {},
    })));

    await expect(refreshRuntimeSnapshot(runtime)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("requests encrypted identity backups with a passphrase over POST", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => jsonResponse(backupDocument));
    vi.stubGlobal("fetch", fetchMock);

    const backup = await getIdentityBackup(runtime, " secret ");

    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { method?: string; body?: string };
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toBe("http://127.0.0.1:7711/v1/identities/backup");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body ?? "{}")).toEqual({ passphrase: "secret" });
    expect(JSON.parse(backup)).toEqual(backupDocument);
  });

  it("rejects malformed identity backups from /v1/identities/backup", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => jsonResponse({
      version: 1,
      alg: "argon2id-aes256gcm",
      peer_id: "peer-local",
      salt: "c2FsdA==",
      nonce: "bm9uY2U=",
      ciphertext: "Y2lwaGVydGV4dA==",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getIdentityBackup(runtime, "secret")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("restores identities with a passphrase and structured backup document", async () => {
    const fetchMock = vi.fn(async (url: URL | string, _init?: RequestInit) => {
      if (String(url).endsWith("/v1/state")) {
        return jsonResponse({ peer_id: "peer-local", display_name: "Ada", servers: [], settings: {} });
      }
      return jsonResponse({ peer_id: "peer-local", display_name: "Ada" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await restoreIdentity(runtime, JSON.stringify(backupDocument), " secret ");

    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { method?: string; body?: string };
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toBe("http://127.0.0.1:7711/v1/identities/restore");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body ?? "{}")).toEqual({ passphrase: "secret", backup: backupDocument });
  });

  it("rejects malformed backup JSON before calling restore", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(restoreIdentity(runtime, "not json", "secret")).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("consumePendingNativeDeepLinks", () => {
  it("returns pending deeplinks from the native bridge in order", async () => {
    invokeMock.mockResolvedValueOnce([
      "  aether://join/cyber?invite=one  ",
      "aether://join/lab?invite=two",
    ]);

    await expect(consumePendingNativeDeepLinks()).resolves.toEqual([
      "aether://join/cyber?invite=one",
      "aether://join/lab?invite=two",
    ]);
  });

  it("dedupes pending deeplinks from the native bridge", async () => {
    invokeMock.mockResolvedValueOnce([
      "  aether://join/cyber?invite=one  ",
      "aether://join/cyber?invite=one",
      "aether://join/lab?invite=two",
    ]);

    await expect(consumePendingNativeDeepLinks()).resolves.toEqual([
      "aether://join/cyber?invite=one",
      "aether://join/lab?invite=two",
    ]);
  });

  it("returns an empty list when the native bridge is unavailable", async () => {
    invokeMock.mockRejectedValueOnce(new Error("bridge unavailable"));

    await expect(consumePendingNativeDeepLinks()).resolves.toEqual([]);
  });

  it("ignores malformed native deep-link queues", async () => {
    invokeMock.mockResolvedValueOnce(Object.create(null));

    await expect(consumePendingNativeDeepLinks()).resolves.toEqual([]);
  });
});

describe("readNativeRuntimeBootstrapStatus", () => {
  it("reports a waiting sidecar as visible bootstrap progress", async () => {
    invokeMock.mockResolvedValueOnce({
      control_endpoint: "",
      control_ready: false,
      data_dir: "/tmp/harmolyn-xorein",
      sidecar: {
        managed: true,
        running: true,
        control_endpoint: "",
      },
    });

    await expect(readNativeRuntimeBootstrapStatus()).resolves.toEqual({
      phase: "waiting",
      message: "xorein sidecar is running. Waiting for the control endpoint...",
      detail: "/tmp/harmolyn-xorein",
    });
  });

  it("reports native startup failures with the underlying error", async () => {
    invokeMock.mockResolvedValueOnce({
      control_endpoint: "",
      control_ready: false,
      sidecar: {
        managed: true,
        running: false,
        last_error: "Unable to start xorein sidecar: missing binary",
      },
    });

    await expect(readNativeRuntimeBootstrapStatus()).resolves.toEqual({
      phase: "failed",
      message: "xorein could not start.",
      detail: "Unable to start xorein sidecar: missing binary",
    });
  });
});

describe("connectToDefaultRuntime", () => {
  it("publishes local runtime state and defaults the control endpoint", async () => {
    storePreferredControlEndpoint("127.0.0.1:7711");
    const state = { identity: { peer_id: "peer-x" }, control_endpoint: "", servers: [], settings: {}, presence: {} };
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse(state));
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result).not.toBeNull();
    expect(result?.control_endpoint).toBe("http://127.0.0.1:7711");
    expect(result?.settings).toBeUndefined();
    expect(result?.presence).toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("http://127.0.0.1:7711/v1/state");
    expect(window.localStorage.getItem("harmolyn:xorein:runtime") ?? "").toContain("peer-x");
  });

  it("fetches the preferred local endpoint for autoconnect without exposing a token", async () => {
    storePreferredControlEndpoint("127.0.0.1:7711");
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ identity: { peer_id: "peer-native" }, control_endpoint: "", servers: [], settings: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result?.identity?.peer_id).toBe("peer-native");
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("http://127.0.0.1:7711/v1/state");
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_TOKEN__).toBeUndefined();
  });

  it("keeps any stored token out of the browser fetch on autoconnect", async () => {
    storePreferredControlEndpoint("127.0.0.1:7711");
    injectControlToken("local-node-token");
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ identity: { peer_id: "peer-x" }, control_endpoint: "", servers: [], settings: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await connectToDefaultRuntime();

    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("http://127.0.0.1:7711/v1/state");
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_TOKEN__).toBeUndefined();
  });

  it("fetches the hosted endpoint for follow-up control calls without a token", async () => {
    // No preferred endpoint: autoconnect resolves the hosted default node, so
    // both the initial connect and the follow-up refresh take the browser fetch
    // path (the remote node authorizes by Origin, never a bearer token).
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ identity: { peer_id: "peer-x" }, control_endpoint: "", servers: [], settings: {} }))
      .mockResolvedValueOnce(jsonResponse({ identity: { peer_id: "peer-y" }, control_endpoint: "", servers: [], settings: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const connected = await connectToDefaultRuntime();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse({ identity: { peer_id: "peer-y" }, control_endpoint: "", servers: [], settings: {} }));
    const refreshed = await refreshRuntimeSnapshot(connected);

    expect(refreshed.identity?.peer_id).toBe("peer-y");
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("https://node.xorein.com/v1/state");
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_TOKEN__).toBeUndefined();
  });

  it("drops malformed identity profile fields during autoconnect", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({
        identity: {
          peer_id: "peer-bad",
          profile: {
            display_name: 123,
            bio: "connected test user",
          },
        },
        control_endpoint: "",
        servers: [],
        settings: {},
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result?.identity?.peer_id).toBe("peer-bad");
    expect(result?.identity?.profile?.display_name).toBeUndefined();
    expect(result?.identity?.profile?.bio).toBe("connected test user");
  });

  it("drops malformed top-level peer ids during autoconnect", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({
        peer_id: Object.create({ trim: () => "peer-local" }),
        identity: {
          profile: {
            display_name: "Ada",
          },
        },
        control_endpoint: "",
        servers: [],
        settings: {},
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result?.peer_id).toBeUndefined();
    expect(result?.identity).toBeUndefined();
  });

  it("drops display-name-only identities during autoconnect", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({
        identity: {
          profile: {
            display_name: "Ada",
          },
        },
        control_endpoint: "",
        servers: [],
        settings: {},
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result?.identity).toBeUndefined();
    expect(result?.peer_id).toBeUndefined();
  });

  it("normalizes runtime settings into strict string values", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({
        peer_id: "peer-native",
        control_endpoint: "",
        settings: {
          control_endpoint: { bad: true },
          theme: " neon ",
          empty: "   ",
        },
        servers: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result?.peer_id).toBe("peer-native");
    expect(result?.settings).toEqual({ theme: "neon" });
  });

  it("keeps the first normalized runtime setting when keys collide", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({
        peer_id: "peer-native",
        control_endpoint: "",
        settings: {
          ' control_endpoint ': " http://127.0.0.1:7711 ",
          control_endpoint: " http://127.0.0.1:7999 ",
        },
        servers: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result?.settings).toEqual({ control_endpoint: "http://127.0.0.1:7711" });
  });

  it("keeps the first normalized presence entry when keys collide", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({
        peer_id: "peer-native",
        control_endpoint: "",
        presence: {
          ' peer-local ': {
            status: "online",
            updated_at: "2026-01-01T00:00:00Z",
          },
          "peer-local": {
            status: "idle",
            updated_at: "2026-01-02T00:00:00Z",
          },
        },
        servers: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result?.presence).toEqual({
      "peer-local": {
        status: "online",
        updated_at: "2026-01-01T00:00:00Z",
      },
    });
  });

  it("falls back to the preferred local endpoint when /v1/state returns a malformed top-level endpoint", async () => {
    storePreferredControlEndpoint("127.0.0.1:7711");
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({
        peer_id: "peer-native",
        control_endpoint: { bad: true },
        settings: {},
        servers: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result?.peer_id).toBe("peer-native");
    expect(result?.control_endpoint).toBe("http://127.0.0.1:7711");
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("http://127.0.0.1:7711/v1/state");
  });

  it("falls back to the hosted default endpoint when the top-level endpoint is empty", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({
        peer_id: "peer-native",
        control_endpoint: "",
        settings: {
          control_endpoint: "https://node.xorein.com",
        },
        servers: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result?.peer_id).toBe("peer-native");
    expect(result?.control_endpoint).toBe("https://node.xorein.com");
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("https://node.xorein.com/v1/state");
  });

  it("honors a valid top-level endpoint over the resolved autoconnect endpoint", async () => {
    storePreferredControlEndpoint("127.0.0.1:7711");
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({
        peer_id: "peer-native",
        control_endpoint: "http://127.0.0.1:7811",
        settings: {},
        servers: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result?.peer_id).toBe("peer-native");
    expect(result?.control_endpoint).toBe("http://127.0.0.1:7811");
    // The single autoconnect fetch still targets the resolved (preferred) endpoint.
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("http://127.0.0.1:7711/v1/state");
  });

  it("does not reuse persisted browser tokens for autoconnect", async () => {
    storePreferredControlEndpoint("127.0.0.1:7711");
    window.localStorage.setItem("harmolyn:xorein:control-token", "persisted-token");
    window.sessionStorage.setItem("xorein:control-token", "session-token");
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ identity: { peer_id: "peer-x" }, control_endpoint: "", servers: [], settings: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await connectToDefaultRuntime();

    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("http://127.0.0.1:7711/v1/state");
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_TOKEN__).toBeUndefined();
  });

  it("falls back to the default node when no valid preferred endpoint is stored", async () => {
    // An unstorable (blank) preferred endpoint is rejected at storage time, so
    // autoconnect resolves the hosted default node.
    storePreferredControlEndpoint("   ");
    expect(readPreferredControlEndpoint()).toBe("");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(connectToDefaultRuntime()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("https://node.xorein.com/v1/state");
  });

  it("returns null when the default node returns an empty body", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(connectToDefaultRuntime()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("https://node.xorein.com/v1/state");
  });

  it("fetches a remote endpoint directly", async () => {
    storePreferredControlEndpoint("https://evil.example/control");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(connectToDefaultRuntime()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("https://evil.example/v1/state");
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_TOKEN__).toBeUndefined();
  });

  it("still publishes the runtime snapshot when storage writes fail", async () => {
    const state = { identity: { peer_id: "peer-storage" }, control_endpoint: "", servers: [], settings: {} };
    vi.stubGlobal("fetch", vi.fn(async (..._args: unknown[]) => jsonResponse(state)));
    const storageSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    const result = await connectToDefaultRuntime();

    expect(result?.identity?.peer_id).toBe("peer-storage");
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__).toBeDefined();
    expect(storageSpy).toHaveBeenCalled();
    storageSpy.mockRestore();
  });

  it("resolves the preferred local endpoint immediately without polling for a sidecar", async () => {
    // The Tauri sidecar probe was removed: autoconnect no longer waits/polls for
    // a starting native runtime. It issues a single fetch against the resolved
    // endpoint and resolves promptly.
    storePreferredControlEndpoint("127.0.0.1:7811");
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ identity: { peer_id: "peer-delayed" }, control_endpoint: "", servers: [], settings: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectToDefaultRuntime();

    expect(result?.control_endpoint).toBe("http://127.0.0.1:7811");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("http://127.0.0.1:7811/v1/state");
  });

  it("does not publish or fetch an unready native control endpoint", async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockResolvedValue({
        control_endpoint: "http://127.0.0.1:7711",
        control_ready: false,
        sidecar: { running: true, managed: true },
      });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const pending = connectToDefaultRuntime();
      await vi.advanceTimersByTimeAsync(8000);

      await expect(pending).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectNativeControlGlobalsCleared();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain an unready native token for later browser control requests", async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockResolvedValue({
        control_endpoint: "http://127.0.0.1:7711",
        control_ready: false,
        control_token: "native-token",
        sidecar: { running: true, managed: true },
      });
      const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse(discoveryResponse("x", "No Token")));
      vi.stubGlobal("fetch", fetchMock);

      const pending = connectToDefaultRuntime();
      await vi.advanceTimersByTimeAsync(8000);
      await expect(pending).resolves.not.toBeNull();
      fetchMock.mockClear();
      invokeMock.mockClear();

      await discoverServerByInvite(runtime, makeXoreinInviteDeeplink("alpha"));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { headers?: Record<string, string> };
      expect(init.headers?.Authorization).toBeUndefined();
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears stale native globals before writing fresh runtime config", async () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_ENDPOINT__ = "http://127.0.0.1:7777";
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_READY__ = true;
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_TOKEN__ = "stale-token";
    invokeMock.mockResolvedValueOnce({ control_endpoint: "", sidecar: { running: false, managed: true } });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unreachable"); }));

    await expect(connectToDefaultRuntime()).resolves.toBeNull();
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_ENDPOINT__).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_READY__).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_TOKEN__).toBeUndefined();
  });

  it("clears stale runtime publication state when autoconnect fails", async () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = { stale: true };
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_SESSION__ = { stale: true };
    window.localStorage.setItem("harmolyn:xorein:runtime", JSON.stringify({ stale: true }));
    window.localStorage.setItem("harmolyn:xorein:session", JSON.stringify({ stale: true }));
    window.sessionStorage.setItem("harmolyn:xorein:runtime", JSON.stringify({ stale: true }));
    window.sessionStorage.setItem("harmolyn:xorein:session", JSON.stringify({ stale: true }));

    invokeMock.mockResolvedValueOnce({ control_endpoint: "http://127.0.0.1:7711" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "down" }, 503)));

    await expect(connectToDefaultRuntime()).resolves.toBeNull();
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_SESSION__).toBeUndefined();
    expectNativeControlGlobalsCleared();
    expect(window.localStorage.getItem("harmolyn:xorein:runtime")).toBeNull();
    expect(window.localStorage.getItem("harmolyn:xorein:session")).toBeNull();
    expect(window.sessionStorage.getItem("harmolyn:xorein:runtime")).toBeNull();
    expect(window.sessionStorage.getItem("harmolyn:xorein:session")).toBeNull();
  });

  it("clears native control globals and published state when autoconnect is rejected", async () => {
    // Pre-seed the in-memory control globals to confirm a rejected autoconnect
    // tears them down. The hosted node authorizes by Origin (no bearer token),
    // so a 401 here means the node rejected the request, not a bad token.
    const windowRecord = window as unknown as Record<string, unknown>;
    windowRecord.__HARMOLYN_XOREIN_CONTROL_ENDPOINT__ = "http://127.0.0.1:7711";
    windowRecord.__HARMOLYN_XOREIN_CONTROL_READY__ = true;
    windowRecord.__HARMOLYN_XOREIN_CONTROL_TOKEN__ = "stale-token";

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "unauthorized", message: "rejected" }, 401)));

    await expect(connectToDefaultRuntime()).resolves.toBeNull();
    expectNativeControlGlobalsCleared();
  });

  it("clears stale runtime publication state when autoconnect receives malformed JSON", async () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = { stale: true };
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_SESSION__ = { stale: true };
    window.localStorage.setItem("harmolyn:xorein:runtime", JSON.stringify({ stale: true }));
    window.localStorage.setItem("harmolyn:xorein:session", JSON.stringify({ stale: true }));
    window.sessionStorage.setItem("harmolyn:xorein:runtime", JSON.stringify({ stale: true }));
    window.sessionStorage.setItem("harmolyn:xorein:session", JSON.stringify({ stale: true }));

    invokeMock.mockResolvedValueOnce({ control_endpoint: "http://127.0.0.1:7711" });
    vi.stubGlobal("fetch", vi.fn(async () => invalidJsonResponse(200)));

    await expect(connectToDefaultRuntime()).resolves.toBeNull();
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_SESSION__).toBeUndefined();
    expectNativeControlGlobalsCleared();
    expect(window.localStorage.getItem("harmolyn:xorein:runtime")).toBeNull();
    expect(window.localStorage.getItem("harmolyn:xorein:session")).toBeNull();
    expect(window.sessionStorage.getItem("harmolyn:xorein:runtime")).toBeNull();
    expect(window.sessionStorage.getItem("harmolyn:xorein:session")).toBeNull();
  });

  it("clears native control globals when autoconnect cannot reach the local runtime", async () => {
    invokeMock.mockResolvedValueOnce({ control_endpoint: "http://127.0.0.1:7711" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));

    await expect(connectToDefaultRuntime()).resolves.toBeNull();
    expectNativeControlGlobalsCleared();
  });

  it("returns null when the node is unreachable", async () => {
    invokeMock.mockResolvedValue({ control_endpoint: "http://127.0.0.1:7711" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "down" }, 503)));
    expect(await connectToDefaultRuntime()).toBeNull();
  });

  it("no-ops when auto-connect is disabled", async () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_DISABLE_AUTOCONNECT__ = true;
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    expect(await connectToDefaultRuntime()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    delete (window as unknown as Record<string, unknown>).__HARMOLYN_DISABLE_AUTOCONNECT__;
  });
});

describe("subscribeRuntimeEvents", () => {
  it("polls for state changes instead of using unauthenticated EventSource", () => {
    listenMock.mockRejectedValue(new Error("native bridge unavailable"));
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const snapshot = { control_endpoint: "http://127.0.0.1:7777", settings: {} } as XoreinRuntimeSnapshot;

      const stop = subscribeRuntimeEvents(snapshot, onChange);
      expect(onChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000);
      expect(onChange).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5000);
      expect(onChange).toHaveBeenCalledTimes(2);

      stop();
      vi.advanceTimersByTime(15000);
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores malformed nested settings values when deciding whether to subscribe", () => {
    const onChange = vi.fn();
    const snapshot = {
      settings: {
        control_endpoint: { bad: true } as never,
      },
    } as XoreinRuntimeSnapshot;

    const stop = subscribeRuntimeEvents(snapshot, onChange);
    expect(onChange).not.toHaveBeenCalled();
    stop();
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("uses native runtime events when a Tauri bridge is available", async () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const snapshot = { control_endpoint: "http://127.0.0.1:7777", settings: {} } as XoreinRuntimeSnapshot;
      const unlisten = vi.fn();
      let callback: ((event: unknown) => void) | null = null;
      listenMock.mockImplementation(async (_eventName: string, handler: (event: unknown) => void) => {
        callback = handler;
        return unlisten;
      });

      const stop = subscribeRuntimeEvents(snapshot, onChange);
      await Promise.resolve();

      expect(onChange).not.toHaveBeenCalled();
      callback?.({});
      expect(onChange).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(15000);
      expect(onChange).toHaveBeenCalledTimes(1);

      stop();
      expect(unlisten).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a no-op when there is no control endpoint", () => {
    const onChange = vi.fn();
    const stop = subscribeRuntimeEvents({ settings: {} } as XoreinRuntimeSnapshot, onChange);
    stop();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("v1 endpoints (friends, presence, notifications, search, relays, peers)", () => {
  const API_ENDPOINT = "http://127.0.0.1:7777";
  const apiRuntime = { control_endpoint: API_ENDPOINT, settings: {} } as XoreinRuntimeSnapshot;

  type Call = { url: string; init?: RequestInit };

  function stubFetch(status: number, body: unknown): Call[] {
    const calls: Call[] = [];
    const text = body === undefined ? "" : JSON.stringify(body);
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      // 204 must be constructed with a null body per the Fetch spec.
      return new Response(text === "" ? null : text, {
        status,
        headers: text ? { "Content-Type": "application/json" } : {},
      });
    }));
    return calls;
  }

  it("listFriends GETs /v1/friends and unwraps {friends}", async () => {
    const calls = stubFetch(200, { friends: [{ id: "f1", from_peer_id: "p", status: "accepted" }] });
    const friends = await listFriends(apiRuntime);
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/friends`);
    expect(calls[0].init?.method).toBe("GET");
    expect(friends).toEqual([{ id: "f1", from_peer_id: "p", status: "accepted" }]);
  });

  it("rejects malformed friend records from /v1/friends", async () => {
    stubFetch(200, { friends: [{ id: "f1", from_peer_id: "p", status: "mystery" }] });
    await expect(listFriends(apiRuntime)).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("createDm POSTs a peer ID and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ id: "dm-1", peer_id: "peer-2", created_at: "2026-01-01T00:00:00Z" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const record = await createDm(apiRuntime, "  peer-2  ");
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/dms`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ peer_id: "peer-2" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
    expect(record.id).toBe("dm-1");
    await expect(createDm(apiRuntime, "   ")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects malformed DM records from /v1/dms", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => jsonResponse({ id: "dm-1", peer_id: "  ", created_at: "2026-01-01T00:00:00Z" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createDm(apiRuntime, "peer-2")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("sendFriendRequest POSTs a peer_addr body and refreshes /v1/state", async () => {
    const addr = "/ip4/1.2.3.4/tcp/9000/p2p/12D3KooAbc";
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ id: "freq1", from_peer_id: "me", to_peer_addr: addr, status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rec = await sendFriendRequest(apiRuntime, addr);
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/friends/requests`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ peer_addr: addr });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
    expect(rec.status).toBe("pending");
  });

  it("sendFriendRequest trims whitespace and rejects blank values before calling the API", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "freq1", from_peer_id: "me", to_peer_addr: "12D3KooAbc", status: "pending" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await sendFriendRequest(apiRuntime, " 12D3KooAbc  ");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ peer_addr: "12D3KooAbc" });
    await expect(sendFriendRequest(apiRuntime, "   ")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("actOnFriendRequest PUTs {action} to the request id and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ id: "freq1", from_peer_id: "me", status: "accepted" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rec = await actOnFriendRequest(apiRuntime, "freq1", "accept");
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/friends/requests/freq1`);
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ action: "accept" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
    expect(rec.status).toBe("accepted");
  });

  it("actOnFriendRequest trims whitespace and rejects blank IDs before calling the API", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "freq1", from_peer_id: "me", status: "accepted" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await actOnFriendRequest(apiRuntime, "  freq1  ", "accept");
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/friends/requests/freq1`);
    await expect(actOnFriendRequest(apiRuntime, "   ", "accept")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("removeFriend DELETEs and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(removeFriend(apiRuntime, "f1")).resolves.toBeUndefined();
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/friends/f1`);
    expect(calls[0].init?.method).toBe("DELETE");
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
  });

  it("removeFriend trims whitespace and rejects blank IDs before calling the API", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(removeFriend(apiRuntime, "  f1  ")).resolves.toBeUndefined();
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/friends/f1`);
    await expect(removeFriend(apiRuntime, "   ")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("getPresence unwraps {peers}", async () => {
    stubFetch(200, { peers: { p1: { status: "online", updated_at: "2026-01-01T00:00:00Z" } } });
    const presence = await getPresence(apiRuntime);
    expect(presence.p1.status).toBe("online");
  });

  it("rejects malformed presence responses from /v1/presence", async () => {
    stubFetch(200, { peers: { p1: { status: "online" } } });
    await expect(getPresence(apiRuntime)).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("updatePresence POSTs the status payload and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: { p1: { status: "online", updated_at: "2026-01-01T00:00:00Z" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await updatePresence(apiRuntime, { status: "offline", status_text: "away", typing_in_scope: "c1" });
    expect(calls[0].url).toBe(
      `${API_ENDPOINT}/v1/presence`,
    );
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      status: "offline",
      status_text: "away",
      typing_in_scope: "c1",
    });
    expect(calls[1].url).toBe(
      `${API_ENDPOINT}/v1/state`,
    );
    expect(calls[1].init?.method).toBe("GET");
  });

  it("updatePresence trims fields and rejects invalid statuses before calling the API", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await updatePresence(apiRuntime, { status: "  dnd  ", status_text: "  focused  ", typing_in_scope: "  c1  " });
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      status: "dnd",
      status_text: "focused",
      typing_in_scope: "c1",
    });
    await expect(updatePresence(apiRuntime, { status: "mood" })).rejects.toMatchObject({ code: "invalid_request" });
  });


  it("createChannel POSTs a trimmed channel name and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ id: "ch-1", server_id: "srv-1", name: "general", voice: false }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await createChannel(apiRuntime, "srv-1", "  general  ", false);
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/servers/srv-1/channels`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ name: "general", voice: false });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
    await expect(createChannel(apiRuntime, "srv-1", "   ", false)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects malformed channel records from /v1/servers/:id/channels", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => jsonResponse({ id: "ch-1", server_id: "srv-2", name: "general", voice: false }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createChannel(apiRuntime, "srv-1", "general", false)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("createRole POSTs a trimmed role name and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await createRole(apiRuntime, "srv-1", { role_name: " Moderators " });
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/servers/srv-1/roles`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ role_name: "Moderators" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
    await expect(createRole(apiRuntime, "srv-1", { role_name: "   " })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("assignRole PUTs the trimmed member role and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await assignRole(apiRuntime, "srv-1", "peer-2", " Admin ");
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/servers/srv-1/members/peer-2/roles`);
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ role: "Admin" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
    await expect(assignRole(apiRuntime, "srv-1", "peer-2", "   ")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("encodes dynamic control path segments before issuing requests", async () => {
    const calls = stubFetch(200, { peers: {} });

    await assignRole(apiRuntime, " srv/one ", " peer two/é ", "Admin");

    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/servers/srv%2Fone/members/peer%20two%2F%C3%A9/roles`);
    expect(calls[0].init?.method).toBe("PUT");
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
  });

  it("rejects dot-segment control path inputs before issuing requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(assignRole(apiRuntime, "..", "peer-2", "Admin")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(assignRole(apiRuntime, "srv-1", "..", "Admin")).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moderationAction POSTs and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await moderationAction(apiRuntime, "srv-1", "kick", { target_peer_id: "peer-2", reason: "rule break" });
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/moderation/srv-1/kick`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ target_peer_id: "peer-2", reason: "rule break" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
  });

  it("addReaction POSTs and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await addReaction(apiRuntime, "m1", "👍");
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/messages/m1/reactions`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ emoji: "👍" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
  });

  it("removeReaction DELETEs and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await removeReaction(apiRuntime, "m1", "👍");
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/messages/m1/reactions`);
    expect(calls[0].init?.method).toBe("DELETE");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ emoji: "👍" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
  });

  it("pinMessage POSTs and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await pinMessage(apiRuntime, "c1", "m1");
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/channels/c1/pins`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ message_id: "m1" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
  });

  it("unpinMessage DELETEs and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await unpinMessage(apiRuntime, "c1", "m1");
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/channels/c1/pins`);
    expect(calls[0].init?.method).toBe("DELETE");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ message_id: "m1" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
  });


  it("sendVoiceSignal POSTs signaling data and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await sendVoiceSignal(apiRuntime, "ch-voice", "offer", { session_id: "sess-1", target_peer: "peer-2", sdp: "v=0" });
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/voice/ch-voice/offer`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ session_id: "sess-1", target_peer: "peer-2", sdp: "v=0" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
  });

  it("createGroupDm POSTs the group payload and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ id: "gdm-1", members: ["peer-local", "peer-2"], created_at: "2026-01-01T00:00:00Z" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const record = await createGroupDm(apiRuntime, { name: " Crew ", members: [" peer-2 "] });
    expect(record.id).toBe("gdm-1");
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/groups`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ name: "Crew", members: ["peer-2"] });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
  });

  it("createGroupDm trims members and rejects blank entries before calling the API", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ id: "gdm-1", members: ["peer-local", "peer-2"], created_at: "2026-01-01T00:00:00Z" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await createGroupDm(apiRuntime, { name: "  Crew  ", members: ["  peer-2  "] });
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ name: "Crew", members: ["peer-2"] });
    await expect(createGroupDm(apiRuntime, { name: "Crew", members: ["   "] })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("addGroupDmMember POSTs the member payload and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await addGroupDmMember(apiRuntime, "gdm-1", "/ip4/1.2.3.4/tcp/9000/p2p/12D3KooAbc");
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/groups/gdm-1/members`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ peer_addr: "/ip4/1.2.3.4/tcp/9000/p2p/12D3KooAbc" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
  });

  it("addGroupDmMember trims whitespace around the peer identity", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await addGroupDmMember(apiRuntime, "gdm-1", " 12D3KooAbc  ");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ peer_addr: "12D3KooAbc" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
  });

  it("addGroupDmMember rejects blank member identities before calling the API", async () => {
    await expect(addGroupDmMember(apiRuntime, "gdm-1", "   ")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("sendGroupDmMessage POSTs the message and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ id: "m1", scope_type: "group_dm", scope_id: "gdm-1", sender_peer_id: "peer-local", body: "hi" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const record = await sendGroupDmMessage(apiRuntime, "gdm-1", "hi");
    expect(record.id).toBe("m1");
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/groups/gdm-1/messages`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ body: "hi" });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
  });

  it("rejects malformed message records from /v1/groups/:id/messages", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => jsonResponse({ id: "m1", scope_type: "group_dm", scope_id: "gdm-1", sender_peer_id: "peer-local", body: "   " }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendGroupDmMessage(apiRuntime, "gdm-1", "hi")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("sendGroupDmMessage rejects blank bodies before calling the API", async () => {
    await expect(sendGroupDmMessage(apiRuntime, "gdm-1", "   ")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("sendChannelMessage POSTs reply metadata when provided", async () => {
    const calls = stubFetch(200, { id: "m1", scope_type: "channel", scope_id: "c1", sender_peer_id: "p", body: "hi", reply_to: "p0" });
    await sendChannelMessage(apiRuntime, "c1", "hi", { reply_to: "p0" });
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/channels/c1/messages`);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ body: "hi", reply_to: "p0" });
  });

  it("rejects malformed message records from /v1/channels/:id/messages", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => jsonResponse({ id: "m1", scope_type: "channel", scope_id: "c1", sender_peer_id: "p", body: "   " }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendChannelMessage(apiRuntime, "c1", "hi")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("sendChannelMessage rejects blank bodies before calling the API", async () => {
    await expect(sendChannelMessage(apiRuntime, "c1", "   ")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("sendDmMessage POSTs forwarded metadata when provided", async () => {
    const calls = stubFetch(200, { id: "m2", scope_type: "dm", scope_id: "dm-1", sender_peer_id: "p", body: "hi", forwarded_from: "m0" });
    await sendDmMessage(apiRuntime, "dm-1", "hi", { forwarded_from: "m0" });
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/dms/dm-1/messages`);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ body: "hi", forwarded_from: "m0" });
  });

  it("rejects malformed message records from /v1/dms/:id/messages", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => jsonResponse({ id: "m2", scope_type: "dm", scope_id: "dm-1", sender_peer_id: "p", body: "   " }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendDmMessage(apiRuntime, "dm-1", "hi")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("sendDmMessage rejects blank bodies before calling the API", async () => {
    await expect(sendDmMessage(apiRuntime, "dm-1", "   ")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("searchMessages POSTs the query and returns {messages,results}", async () => {
    const calls = stubFetch(200, {
      messages: ["m1"],
      results: [
        { id: " m1 ", scope_id: "c1", scope_type: "channel", sender_peer_id: "p", body: "hi" },
        { id: "m1", scope_id: "c1", scope_type: "channel", sender_peer_id: "q", body: "shadowed" },
      ],
    });
    const out = await searchMessages(apiRuntime, { query: "hi", scope_type: "channel", scope_id: "c1" });
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/messages/search`);
    expect(calls[0].init?.method).toBe("POST");
    expect(out.messages).toEqual(["m1"]);
    expect(out.results).toEqual([{
      id: "m1",
      scope_id: "c1",
      scope_type: "channel",
      sender_peer_id: "p",
      body: "hi",
    }]);
  });

  it("rejects malformed search results from /v1/messages/search", async () => {
    stubFetch(200, {
      messages: ["m1", " "],
      results: [{ id: "m1", scope_id: "c1", scope_type: "channel", sender_peer_id: "p", body: "hi" }],
    });
    await expect(searchMessages(apiRuntime, { query: "hi" })).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("searchNotifications POSTs the filter and unwraps {notifications}", async () => {
    const calls = stubFetch(200, {
      notifications: [
        { id: " n1 ", type: "mention", read: false },
        { id: "n1", type: "mention", read: true },
      ],
    });
    const out = await searchNotifications(apiRuntime, { unread_only: true, limit: 10 });
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/notifications/search`);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ unread_only: true, limit: 10 });
    expect(out).toEqual([{ id: "n1", type: "mention", read: false }]);
  });

  it("rejects malformed notification records from /v1/notifications/search", async () => {
    stubFetch(200, { notifications: [{ id: "n1", type: "mention", read: "false" }] });
    await expect(searchNotifications(apiRuntime, { unread_only: true })).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("getNotificationSummary validates unread counters", async () => {
    stubFetch(200, { total_unread: 2, by_server: { "base-node": { unread: 1, mentions: 1 } }, dms_unread: 1 });
    const summary = await getNotificationSummary(apiRuntime);
    expect(summary.total_unread).toBe(2);
    expect(summary.by_server["base-node"].mentions).toBe(1);
  });

  it("keeps the first normalized notification summary entry when server ids collide", async () => {
    stubFetch(200, {
      total_unread: 3,
      by_server: {
        " base-node ": { unread: 1, mentions: 1 },
        "base-node": { unread: 2, mentions: 2 },
      },
      dms_unread: 1,
    });

    const summary = await getNotificationSummary(apiRuntime);

    expect(summary.by_server).toEqual({
      "base-node": { unread: 1, mentions: 1 },
    });
  });

  it("rejects malformed notification summary payloads", async () => {
    stubFetch(200, { total_unread: 2, by_server: { "base-node": { unread: 1, mentions: "one" } }, dms_unread: 1 });
    await expect(getNotificationSummary(apiRuntime)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("markNotificationsRead POSTs the read-through payload and refreshes /v1/state", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ scope_id: "c1", scope_type: "channel", read_through_message_id: "m9" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await markNotificationsRead(apiRuntime, {
      read_through_message_id: "m9",
      scope_type: "channel",
      scope_id: "c1",
    });
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/notifications/read`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      read_through_message_id: "m9",
      scope_type: "channel",
      scope_id: "c1",
    });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
    expect(out.read_through_message_id).toBe("m9");
  });

  it("rejects malformed read-through payloads from /v1/notifications/read", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ scope_id: "c1", scope_type: "channel", read_through_message_id: " " }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(markNotificationsRead(apiRuntime, {
      read_through_message_id: "m9",
      scope_type: "channel",
      scope_id: "c1",
    })).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("listPins validates pinned message ids", async () => {
    stubFetch(200, { channel_id: "c1", pinned: ["m1", "m2"] });
    await expect(listPins(apiRuntime, "c1")).resolves.toEqual(["m1", "m2"]);
  });

  it("rejects malformed pinned message payloads", async () => {
    stubFetch(200, { pinned: ["m1", " "] });
    await expect(listPins(apiRuntime, "c1")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("listRoles validates role entries", async () => {
    stubFetch(200, {
      roles: [
        { peer_id: " peer-1 ", role: "admin", version: 1 },
        { peer_id: "peer-1", role: "owner", version: 2 },
      ],
    });
    await expect(listRoles(apiRuntime, "srv-1")).resolves.toEqual([{ peer_id: "peer-1", role: "admin", version: 1 }]);
  });

  it("rejects malformed role payloads", async () => {
    stubFetch(200, { roles: [{ peer_id: "peer-1", role: "admin", version: "1" }] });
    await expect(listRoles(apiRuntime, "srv-1")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("listGroupDms dedupes group DM records by normalized id", async () => {
    stubFetch(200, {
      group_dms: [
        { id: " gdm-1 ", name: "Crew", members: ["peer-1"], created_at: "2026-01-01T00:00:00Z" },
        { id: "gdm-1", name: "Shadowed", members: ["peer-2"], created_at: "2026-01-02T00:00:00Z" },
      ],
    });

    await expect(listGroupDms(apiRuntime)).resolves.toEqual([
      { id: "gdm-1", name: "Crew", members: ["peer-1"], created_at: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("listDms validates direct message payloads", async () => {
    stubFetch(200, { dms: [{ id: "dm-1", peer_id: "peer-remote", created_at: "2026-01-01T00:00:00Z" }] });
    await expect(listDms(apiRuntime)).resolves.toEqual([{ id: "dm-1", participants: ["peer-remote"], created_at: "2026-01-01T00:00:00Z" }]);
  });

  it("rejects malformed DM list payloads", async () => {
    stubFetch(200, { dms: [{ id: "dm-1", peer_id: " ", created_at: "2026-01-01T00:00:00Z" }] });
    await expect(listDms(apiRuntime)).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("removePeer trims whitespace and rejects blank IDs before calling the API", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(removePeer(apiRuntime, "  /ip4/1.2.3.4/tcp/9000/p2p/12D3KooAbc  ")).resolves.toBeUndefined();
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ address: "/ip4/1.2.3.4/tcp/9000/p2p/12D3KooAbc" });
    await expect(removePeer(apiRuntime, "   ")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("registerRelay POSTs a multiaddr and refreshes /v1/state", async () => {
    const ma = "/ip4/1.2.3.4/tcp/1337/p2p/12D3KooRelay/p2p-circuit";
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ peers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(registerRelay(apiRuntime, ma)).resolves.toBeUndefined();
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/relays`);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ multiaddr: ma });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
    expect(calls[1].init?.method).toBe("GET");
  });

  it("registerRelay rejects relay strings without a dialable /p2p multiaddr", async () => {
    await expect(registerRelay(apiRuntime, "relay-id-only")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("removeRelay DELETEs a multiaddr and refreshes /v1/state", async () => {
    const ma = "/ip4/1.2.3.4/tcp/1337/p2p/12D3KooRelay/p2p-circuit";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (...args: unknown[]) => {
        calls.push({ url: String(args[0] ?? ""), init: args[1] as RequestInit | undefined });
        if (calls.length === 1) {
          return jsonResponse(undefined, 204);
        }
        return jsonResponse({});
      }),
    );

    await expect(removeRelay(apiRuntime, ma)).resolves.toBeUndefined();
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/relays`);
    expect(calls[0].init?.method).toBe("DELETE");
    expect(JSON.parse(String(calls[0].init?.body ?? "{}"))).toEqual({ multiaddr: ma });
    expect(calls[1].url).toBe(`${API_ENDPOINT}/v1/state`);
  });

  it("removeRelay rejects relay strings without a dialable /p2p multiaddr", async () => {
    await expect(removeRelay(apiRuntime, "relay-id-only")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("addPeer POSTs a dialable multiaddr address", async () => {
    const addr = "/ip4/1.2.3.4/tcp/9000/p2p/12D3KooAbc";
    const calls = stubFetch(200, {});
    await addPeer(apiRuntime, addr);
    expect(calls[0].url).toBe(`${API_ENDPOINT}/v1/peers/manual`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ address: addr });
  });

  it("addPeer rejects bare peer IDs before calling the API", async () => {
    await expect(addPeer(apiRuntime, "12D3KooAbc")).rejects.toMatchObject({ code: "invalid_request" });
  });
});
