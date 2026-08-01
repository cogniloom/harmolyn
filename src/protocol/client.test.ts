import { afterEach, describe, expect, it, vi } from "vitest";
import { signManifest } from "./manifest";
import type { SecurityMode } from "./capabilities";
import { configureChatScopePersistence, readBrowserChatActionSupport, readPersistedChatScopeState, writePersistedChatScopeState, XoreinClient, XoreinControlTransport, type XoreinConnectionSnapshot, type XoreinTransport } from "./client";
import type { Message } from "../types";

afterEach(() => {
  vi.unstubAllGlobals();
  // Reset chat-scope persistence to the unconfigured default and drop its
  // in-memory cache so tests can't leak scope state into each other.
  configureChatScopePersistence(null);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function makeXoreinInviteDeeplink(serverId = "srv-1") {
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

describe("readBrowserChatActionSupport", () => {
  it("reports offline when the runtime is unavailable", () => {
    const support = readBrowserChatActionSupport();

    expect(support).toEqual({
      mode: "offline",
      canPersistLocally: false,
      canAttemptAttachments: false,
      detail: "The local xorein runtime is offline. Start or reconnect the node before sending chat messages.",
    });
  });

  it("reports offline when the runtime endpoint is malformed", () => {
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", {
      identity: { peer_id: "peer-local" },
      control_endpoint: "not-a-url",
      settings: { control_endpoint: "not-a-url" },
    });
    vi.stubGlobal("__HARMOLYN_CONTROL_TOKEN__", "tok");

    const support = readBrowserChatActionSupport();

    expect(support).toEqual({
      mode: "offline",
      canPersistLocally: false,
      canAttemptAttachments: false,
      detail: "The local xorein runtime is offline. Start or reconnect the node before sending chat messages.",
    });
  });

  it("reports connected when the runtime endpoint is a remote node", () => {
    // The hosted xorein node is now a legitimate connected backend: a valid peer
    // ID plus a parseable remote HTTP(S) endpoint is sufficient. Mutations go via
    // requestControlApi, which authorizes the remote node by CORS + Origin and
    // attaches no bearer token (so the stubbed token global is ignored).
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", {
      identity: { peer_id: "peer-local" },
      control_endpoint: "https://evil.example/control",
      settings: { control_endpoint: "https://evil.example/control" },
    });
    vi.stubGlobal("__HARMOLYN_CONTROL_TOKEN__", "tok");

    const support = readBrowserChatActionSupport();

    expect(support).toEqual({
      mode: "connected",
      canPersistLocally: true,
      canAttemptAttachments: true,
      detail: "Backend connected — chat mutations are sent to the remote xorein node.",
    });
  });

  it("treats empty runtime blobs as absent", () => {
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", {
      unexpected: { bad: true },
    });

    const support = readBrowserChatActionSupport();

    expect(support).toEqual({
      mode: "offline",
      canPersistLocally: false,
      canAttemptAttachments: false,
      detail: "The local xorein runtime is offline. Start or reconnect the node before sending chat messages.",
    });
  });

  it("does not treat legacy token globals as control bridge readiness", () => {
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", {
      identity: { peer_id: "peer-local" },
      control_endpoint: "http://127.0.0.1:7711",
      settings: { control_endpoint: "http://127.0.0.1:7711" },
    });
    vi.stubGlobal("__HARMOLYN_CONTROL_TOKEN__", "tok");

    const support = readBrowserChatActionSupport();

    expect(support).toEqual({
      mode: "offline",
      canPersistLocally: false,
      canAttemptAttachments: false,
      detail: "The local xorein runtime is offline. Start or reconnect the node before sending chat messages.",
    });
  });

  it("reports connected from a non-secret native control-ready signal", () => {
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", {
      identity: { peer_id: "peer-local" },
      control_endpoint: "http://127.0.0.1:7711",
      settings: { control_endpoint: "http://127.0.0.1:7711" },
    });
    vi.stubGlobal("__HARMOLYN_XOREIN_CONTROL_READY__", true);

    const support = readBrowserChatActionSupport();

    expect(support).toEqual({
      mode: "connected",
      canPersistLocally: true,
      canAttemptAttachments: true,
      detail: "Backend connected — chat mutations are sent to the local xorein runtime.",
    });
  });

  it("does not treat persisted browser tokens as a connected control bridge", () => {
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", {
      identity: { peer_id: "peer-local" },
      control_endpoint: "http://127.0.0.1:7711",
      settings: { control_endpoint: "http://127.0.0.1:7711" },
    });
    window.localStorage.setItem("harmolyn:xorein:control-token", "persisted-token");
    window.sessionStorage.setItem("xorein:control-token", "session-token");

    const support = readBrowserChatActionSupport();

    expect(support).toEqual({
      mode: "offline",
      canPersistLocally: false,
      canAttemptAttachments: false,
      detail: "The local xorein runtime is offline. Start or reconnect the node before sending chat messages.",
    });
  });

  it("ignores array-shaped runtime snapshots from globals and storage", () => {
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", []);
    window.localStorage.setItem("harmolyn:runtime-snapshot", "[]");

    const support = readBrowserChatActionSupport();

    expect(support).toEqual({
      mode: "offline",
      canPersistLocally: false,
      canAttemptAttachments: false,
      detail: "The local xorein runtime is offline. Start or reconnect the node before sending chat messages.",
    });
  });

  it("treats empty browser runtime settings as absent", () => {
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", {
      settings: {},
    });

    const support = readBrowserChatActionSupport();

    expect(support).toEqual({
      mode: "offline",
      canPersistLocally: false,
      canAttemptAttachments: false,
      detail: "The local xorein runtime is offline. Start or reconnect the node before sending chat messages.",
    });
  });

  it("ignores prototype-bearing nested runtime identities", () => {
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", {
      identity: Object.create({
        peer_id: "peer-local",
      }),
      control_endpoint: "http://127.0.0.1:7711",
      settings: { control_endpoint: "http://127.0.0.1:7711" },
    });
    vi.stubGlobal("__HARMOLYN_XOREIN_CONTROL_READY__", true);

    const support = readBrowserChatActionSupport();

    expect(support).toEqual({
      mode: "offline",
      canPersistLocally: false,
      canAttemptAttachments: false,
      detail: "The local xorein runtime is offline. Start or reconnect the node before sending chat messages.",
    });
  });

  it("normalizes malformed nested settings values in browser chat support", () => {
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", {
      identity: { peer_id: "peer-local" },
      control_endpoint: "",
      settings: {
        control_endpoint: " http://127.0.0.1:7711 ",
        control_endpoint_alt: { bad: true },
      },
    });
    vi.stubGlobal("__HARMOLYN_XOREIN_CONTROL_READY__", true);

    expect(readBrowserChatActionSupport()).toEqual({
      mode: "connected",
      canPersistLocally: true,
      canAttemptAttachments: true,
      detail: "Backend connected — chat mutations are sent to the local xorein runtime.",
    });
  });

  it("distinguishes a live native engine from a connected P2P path", () => {
    vi.stubGlobal("__HARMOLYN_NATIVE_ACTIVE__", true);
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", {
      identity: { peer_id: "peer-local" },
      transport_state: "disconnected",
    });

    expect(readBrowserChatActionSupport()).toEqual({
      mode: "connected",
      canPersistLocally: true,
      canAttemptAttachments: true,
      detail: "Native engine active locally — no xorein peer path is connected; chat mutations remain local or queued until a peer path is available.",
    });
  });

  it("falls back to nested settings when the top-level control endpoint is malformed", () => {
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", {
      identity: { peer_id: "peer-local" },
      control_endpoint: { bad: true },
      settings: {
        control_endpoint: " http://127.0.0.1:7711 ",
      },
    });
    vi.stubGlobal("__HARMOLYN_XOREIN_CONTROL_READY__", true);

    expect(readBrowserChatActionSupport()).toEqual({
      mode: "connected",
      canPersistLocally: true,
      canAttemptAttachments: true,
      detail: "Backend connected — chat mutations are sent to the local xorein runtime.",
    });
  });

  it("ignores runtime globals with a null prototype", () => {
    vi.stubGlobal("__HARMOLYN_XOREIN_RUNTIME__", Object.create(null));

    const support = readBrowserChatActionSupport();

    expect(support).toEqual({
      mode: "offline",
      canPersistLocally: false,
      canAttemptAttachments: false,
      detail: "The local xorein runtime is offline. Start or reconnect the node before sending chat messages.",
    });
  });
});

describe("readPersistedChatScopeState", () => {
  it("falls back when the stored chat scope state is array-shaped", () => {
    window.localStorage.setItem("harmolyn:xorein:chat-scope:ch-1", "[]");

    expect(readPersistedChatScopeState("ch-1")).toEqual({
      version: 1,
      nickname: "",
      mutedUserIds: [],
      inboxReadIds: [],
      deletedMessageIds: [],
      messages: [],
      threads: {},
    });
  });

  it("purges prototype-bearing legacy chat state instead of reading it", () => {
    const stored = Object.create(null);
    stored.version = 1;
    stored.nickname = "Cipher";
    stored.mutedUserIds = [];
    stored.inboxReadIds = [];
    stored.deletedMessageIds = [];
    stored.messages = [Object.assign(Object.create({ id: "msg-proto" }), {
      userId: "peer-local",
      content: "hello world",
      timestamp: "2026-04-22T00:00:00Z",
    })];
    stored.threads = {};
    window.localStorage.setItem("harmolyn:xorein:chat-scope:ch-2", JSON.stringify(stored));

    expect(readPersistedChatScopeState("ch-2")).toEqual({
      version: 1,
      nickname: "",
      mutedUserIds: [],
      inboxReadIds: [],
      deletedMessageIds: [],
      messages: [],
      threads: {},
    });
    expect(window.localStorage.getItem("harmolyn:xorein:chat-scope:ch-2")).toBeNull();
  });

  it("normalizes stored thread ids and drops blank thread keys", () => {
    window.localStorage.setItem("harmolyn:xorein:chat-scope:ch-1", JSON.stringify({
      version: 1,
      nickname: "Scout",
      mutedUserIds: [],
      inboxReadIds: [],
      deletedMessageIds: [],
      messages: [],
      threads: {
        " thread-1 ": [
          {
            id: "msg-1",
            userId: "peer-1",
            content: "hello",
            timestamp: "2026-05-27T10:00:00Z",
          },
        ],
        "": [
          {
            id: "msg-2",
            userId: "peer-2",
            content: "ignored",
            timestamp: "2026-05-27T10:01:00Z",
          },
        ],
        "   ": [],
      },
    }));

    expect(readPersistedChatScopeState("ch-1")).toEqual({
      version: 1,
      nickname: "",
      mutedUserIds: [],
      inboxReadIds: [],
      deletedMessageIds: [],
      messages: [],
      threads: {},
    });
    expect(window.localStorage.getItem("harmolyn:xorein:chat-scope:ch-1")).toBeNull();
  });

  it("normalizes stored messages before hydrating chat state", () => {
    window.localStorage.setItem("harmolyn:xorein:chat-scope:ch-3", JSON.stringify({
      version: 1,
      nickname: "Ops",
      mutedUserIds: [],
      inboxReadIds: [],
      deletedMessageIds: [],
      messages: [
        {
          id: " msg-1 ",
          userId: " peer-1 ",
          content: "hello",
          timestamp: " 2026-05-27T10:05:00Z ",
          attachments: [" /files/a ", "", null],
          reactions: [
            { emoji: " 👍 ", count: 2, reacted: true },
            { emoji: "", count: 1, reacted: false },
          ],
          isSystem: true,
          pinned: false,
          replyToId: " msg-0 ",
          editedAt: " 2026-05-27T10:06:00Z ",
          sticker: true,
        },
        {
          id: "msg-1",
          userId: "peer-duplicate",
          content: "ignored duplicate",
          timestamp: "2026-05-27T10:07:00Z",
        },
        {
          id: " ",
          userId: "peer-2",
          content: "ignored blank id",
          timestamp: "2026-05-27T10:08:00Z",
        },
      ],
      threads: {},
    }));

    expect(readPersistedChatScopeState("ch-3")).toEqual({
      version: 1,
      nickname: "",
      mutedUserIds: [],
      inboxReadIds: [],
      deletedMessageIds: [],
      messages: [],
      threads: {},
    });
    expect(window.localStorage.getItem("harmolyn:xorein:chat-scope:ch-3")).toBeNull();
  });

  it("normalizes stored messages before persisting chat state", () => {
    writePersistedChatScopeState(" ch-4 ", {
      version: 1,
      nickname: "  Relay  ",
      mutedUserIds: [" peer-1 ", "peer-1", ""],
      inboxReadIds: [" msg-1 ", "msg-1"],
      deletedMessageIds: [" msg-9 ", "msg-9"],
      messages: [
        {
          id: " msg-2 ",
          userId: " peer-2 ",
          content: "persisted",
          timestamp: " 2026-05-27T10:09:00Z ",
        } as unknown as Message,
        {
          id: "msg-2",
          userId: "peer-dupe",
          content: "ignored duplicate",
          timestamp: "2026-05-27T10:10:00Z",
        } as unknown as Message,
      ],
      threads: {
        " thread-3 ": [
          {
            id: " msg-3 ",
            userId: " peer-3 ",
            content: "threaded",
            timestamp: " 2026-05-27T10:11:00Z ",
          } as unknown as Message,
        ],
      },
    });

    // SECURITY: without a configured at-rest cipher, writes stay in memory —
    // decrypted chat content must never reach browser storage as plaintext.
    expect(window.localStorage.getItem("harmolyn:xorein:chat-scope:ch-4")).toBeNull();
    expect(window.sessionStorage.getItem("harmolyn:xorein:chat-scope:ch-4")).toBeNull();

    expect(readPersistedChatScopeState("ch-4")).toEqual({
      version: 1,
      nickname: "Relay",
      mutedUserIds: ["peer-1"],
      inboxReadIds: ["msg-1"],
      deletedMessageIds: ["msg-9"],
      messages: [
        {
          id: "msg-2",
          userId: "peer-2",
          content: "persisted",
          timestamp: "2026-05-27T10:09:00Z",
        },
      ],
      threads: {
        "thread-3": [
          {
            id: "msg-3",
            userId: "peer-3",
            content: "threaded",
            timestamp: "2026-05-27T10:11:00Z",
          },
        ],
      },
    });
  });

  it("normalizes stored scalar lists and nickname on read", () => {
    window.localStorage.setItem("harmolyn:xorein:chat-scope:ch-5", JSON.stringify({
      version: 1,
      nickname: "  Relay  ",
      mutedUserIds: [" peer-1 ", "peer-1", "", null],
      inboxReadIds: [" msg-1 ", "msg-1"],
      deletedMessageIds: [" msg-2 ", "msg-2", " "],
      messages: [],
      threads: {},
    }));

    expect(readPersistedChatScopeState("ch-5")).toEqual({
      version: 1,
      nickname: "",
      mutedUserIds: [],
      inboxReadIds: [],
      deletedMessageIds: [],
      messages: [],
      threads: {},
    });
    expect(window.localStorage.getItem("harmolyn:xorein:chat-scope:ch-5")).toBeNull();
  });
});

describe("XoreinControlTransport structured failures", () => {
  it("rejects malformed endpoints before constructing requests", () => {
    expect(() => new XoreinControlTransport({ endpoint: "not-a-url", token: "tok" })).toThrowErrorMatchingInlineSnapshot("[XoreinConnectionError: invalid or untrusted xorein control transport endpoint]");
  });

  it("rejects remote endpoints before bearer auth can be sent", () => {
    const fetchMock = vi.fn();

    expect(() => new XoreinControlTransport({
      endpoint: "https://evil.example/control",
      token: "tok-secret",
      fetch: fetchMock as typeof fetch,
    })).toThrowErrorMatchingInlineSnapshot("[XoreinConnectionError: invalid or untrusted xorein control transport endpoint]");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws structured connection errors when the control bridge is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("failed to fetch");
    });
    const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "tok", fetch: fetchMock as typeof fetch });

    await expect(transport.connect()).rejects.toMatchObject({ code: "control_transport_unreachable" });
  });

  it("rejects primitive JSON bodies from the control transport", async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith("/v1/state")) {
        return new Response(JSON.stringify("oops"), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 404 });
    });
    const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "tok", fetch: fetchMock as typeof fetch });

    await expect(transport.connect()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects array JSON bodies from the control transport", async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith("/v1/state")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 404 });
    });
    const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "tok", fetch: fetchMock as typeof fetch });

    await expect(transport.connect()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects null-prototype JSON bodies from the control transport", async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith("/v1/state")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => Object.create(null),
        } as Response;
      }
      return new Response(null, { status: 404 });
    });
    const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "tok", fetch: fetchMock as typeof fetch });

    await expect(transport.connect()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("throws structured server_not_found errors when the runtime has no matching server", async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith("/v1/state")) {
        return new Response(JSON.stringify({ servers: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 404 });
    });
    const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "tok", fetch: fetchMock as typeof fetch });

    await expect(transport.performHandshake({
      serverId: "srv-1",
      localCapabilities: [],
      preferredSecurityModes: ["seal"],
      protocolOffers: [],
    })).rejects.toMatchObject({ code: "server_not_found" });
  });

  it("throws structured manifest_invalid errors when the bridge manifest is malformed", async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith("/v1/state")) {
        return new Response(JSON.stringify({
          servers: [{
            id: "srv-4",
            name: "Broken",
            manifest: {
              server_id: "srv-4",
              name: "Broken",
              owner_peer_id: "owner",
              owner_public_key: "owner-pub",
              owner_addresses: [],
              capabilities: ["cap.chat", "invalid capability"],
              issued_at: "2026-04-22T00:00:00Z",
              updated_at: "2026-04-22T00:00:00Z",
              signature: "sig",
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 404 });
    });
    const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "tok", fetch: fetchMock as typeof fetch });

    await expect(transport.performHandshake({
      serverId: "srv-4",
      localCapabilities: [],
      preferredSecurityModes: ["seal"],
      protocolOffers: [],
    })).rejects.toMatchObject({ code: "manifest_invalid" });
  });

  it("throws structured manifest_invalid errors when the bridge manifest arrays are malformed", async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith("/v1/state")) {
        return new Response(JSON.stringify({
          servers: [{
            id: "srv-6",
            name: "Broken",
            manifest: {
              server_id: "srv-6",
              name: "Broken",
              owner_peer_id: "owner",
              owner_public_key: "owner-pub",
              owner_addresses: [1, "owner-addr"],
              capabilities: ["cap.chat"],
              issued_at: "2026-04-22T00:00:00Z",
              updated_at: "2026-04-22T00:00:00Z",
              signature: "sig",
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 404 });
    });
    const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "tok", fetch: fetchMock as typeof fetch });

    await expect(transport.performHandshake({
      serverId: "srv-6",
      localCapabilities: [],
      preferredSecurityModes: ["seal"],
      protocolOffers: [],
    })).rejects.toMatchObject({ code: "manifest_invalid" });
  });

  it("dedupes bridge manifest address lists during handshake", async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith("/v1/state")) {
        return new Response(JSON.stringify({
          servers: [{
            id: "srv-7",
            name: "Manifest Server",
            manifest: {
              server_id: "srv-7",
              name: "Manifest Server",
              owner_peer_id: "owner",
              owner_public_key: "owner-pub",
              owner_addresses: [" addr-1 ", "addr-1", "addr-2"],
              bootstrap_addrs: ["bootstrap-1", " bootstrap-1 "],
              relay_addrs: ["relay-1", " relay-1 ", "relay-2"],
              capabilities: ["cap.chat"],
              issued_at: "2026-04-22T00:00:00Z",
              updated_at: "2026-04-22T00:00:00Z",
              signature: "sig",
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 404 });
    });
    const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "tok", fetch: fetchMock as typeof fetch });

    await expect(transport.performHandshake({
      serverId: "srv-7",
      localCapabilities: [],
      preferredSecurityModes: ["seal"],
      protocolOffers: [],
    })).resolves.toMatchObject({
      manifest: expect.objectContaining({
        ownerAddresses: ["addr-1", "addr-2"],
        bootstrapAddrs: ["bootstrap-1"],
        relayAddrs: ["relay-1", "relay-2"],
      }),
    });
  });

  it("ignores malformed protocol offers and keeps negotiating a valid one", async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith("/v1/state")) {
        return new Response(JSON.stringify({
          servers: [{
            id: "srv-5",
            name: "Protocol Server",
            manifest: {
              server_id: "srv-5",
              name: "Protocol Server",
              owner_peer_id: "owner",
              owner_public_key: "owner-pub",
              owner_addresses: [],
              capabilities: ["cap.chat"],
              issued_at: "2026-04-22T00:00:00Z",
              updated_at: "2026-04-22T00:00:00Z",
              signature: "sig",
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 404 });
    });
    const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "tok", fetch: fetchMock as typeof fetch });

    await expect(transport.performHandshake({
      serverId: "srv-5",
      localCapabilities: [],
      preferredSecurityModes: ["seal"],
      protocolOffers: ["/aether/chat/1", "/aether/chat/1.0"],
    })).resolves.toMatchObject({
      acceptedProtocol: "/aether/chat/1.0",
      manifest: expect.objectContaining({ serverId: "srv-5" }),
    });
  });
});

describe("XoreinControlTransport joinByLink validation", () => {
  it("rejects unsigned join deeplinks before sending the control request", async () => {
    const fetchMock = vi.fn();
    const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "tok", fetch: fetchMock as typeof fetch });

    await expect(transport.joinByLink("aether://join/srv-1", {
      serverId: "srv-1",
      localCapabilities: [],
      preferredSecurityModes: ["seal"],
      protocolOffers: [],
    })).rejects.toThrow(/signed invite is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("XoreinClient connectByLink validation", () => {
  it("accepts signed xorein invite deeplinks before invoking the transport", async () => {
    const transport: XoreinTransport = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      performHandshake: vi.fn(async (request) => ({
        manifest: await signManifest({
          serverId: request.serverId,
          version: 1,
          description: "Server",
          updatedAt: "2026-04-22T00:00:00Z",
          capabilities: { chat: true, voice: false },
        }, "owner-peer", async (payload) => `digest:${payload}`),
        offeredSecurityModes: ["seal"] as SecurityMode[],
      })),
    };

    const client = new XoreinClient({ transport, digest: async (payload) => `digest:${payload}`, now: () => Date.parse("2026-04-22T00:00:00Z") });
    const invite = makeXoreinInviteDeeplink("srv-1");

    await expect(client.connectByLink(invite)).resolves.toMatchObject({ serverId: "srv-1" });
    expect(transport.connect).toHaveBeenCalled();
    expect(transport.performHandshake).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv-1" }));
  });

  it("rejects unsigned join deeplinks before invoking the transport", async () => {
    const transport: XoreinTransport = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      performHandshake: vi.fn(async () => ({
        manifest: {
          serverId: "srv-1",
          identity: "owner",
          version: 1,
          name: "Server",
          description: "Server",
          ownerPeerId: "owner",
          ownerPublicKey: "owner-pub",
          ownerAddresses: [],
          capabilities: ["cap.chat"],
          issuedAt: "2026-04-22T00:00:00Z",
          updatedAt: "2026-04-22T00:00:00Z",
          signature: "sig",
        },
      })),
    };

    const client = new XoreinClient({ transport });
    await expect(client.connectByLink("aether://join/srv-1")).rejects.toThrow(/signed invite is required/);
    expect(transport.connect).not.toHaveBeenCalled();
    expect(transport.performHandshake).not.toHaveBeenCalled();
  });
});

describe("XoreinClient connection failure classification", () => {
  it("maps structured peer offline errors to no-peer", async () => {
    const transport: XoreinTransport = {
      connect: vi.fn(async () => {
        throw Object.assign(new Error("connection failed"), { code: "server_not_found" });
      }),
      disconnect: vi.fn(async () => undefined),
      performHandshake: vi.fn(async () => {
        throw new Error("handshake should not run after connect failure");
      }),
    };

    const client = new XoreinClient({ transport });
    await expect(client.connectToServer("srv-1")).rejects.toThrow("connection failed");
    expect(client.connection().state).toBe("no-peer");
    expect(client.connection().detail).toBe("connection failed");
    expect(transport.disconnect).toHaveBeenCalledWith("handshake-failed");
  });

  it("maps structured relay failures to no-relay", async () => {
    const transport: XoreinTransport = {
      connect: vi.fn(async () => {
        throw Object.assign(new Error("relay unavailable"), { code: "relay_unavailable" });
      }),
      disconnect: vi.fn(async () => undefined),
      performHandshake: vi.fn(async () => {
        throw new Error("handshake should not run after connect failure");
      }),
    };

    const client = new XoreinClient({ transport });
    await expect(client.connectToServer("srv-2")).rejects.toThrow("relay unavailable");
    expect(client.connection().state).toBe("no-relay");
    expect(client.connection().detail).toBe("relay unavailable");
    expect(transport.disconnect).toHaveBeenCalledWith("handshake-failed");
  });

  it("surfaces missing handshake manifests as structured manifest_invalid errors", async () => {
    const transport: XoreinTransport = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      performHandshake: vi.fn(async () => ({
        manifest: undefined as never,
      })),
    };

    const client = new XoreinClient({ transport });
    await expect(client.connectToServer("srv-3a")).rejects.toMatchObject({ code: "manifest_invalid", message: "manifest required from handshake response" });
    expect(client.connection().state).toBe("disconnected");
    expect(client.connection().detail).toBe("manifest required from handshake response");
    expect(transport.disconnect).toHaveBeenCalledWith("handshake-failed");
  });

  it("throws structured errors when reconnect is requested before any prior server exists", async () => {
    const transport: XoreinTransport = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      performHandshake: vi.fn(async () => {
        throw new Error("handshake should not run");
      }),
    };

    const client = new XoreinClient({ transport });
    await expect(client.selfHeal()).rejects.toMatchObject({ code: "no_previous_server", message: "no previous server to reconnect to" });
    expect(client.connection().state).toBe("disconnected");
    expect(client.connection().detail).toBe("Not connected to a xorein server.");
  });

  it("throws structured errors for handshake validation failures", async () => {
    const transport: XoreinTransport = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      performHandshake: vi.fn(async () => ({
        manifest: {
          serverId: "other-server",
          identity: "owner",
          version: 1,
          name: "Other",
          description: "Other server",
          ownerPeerId: "owner",
          ownerPublicKey: "owner-pub",
          ownerAddresses: [],
          updatedAt: "2026-05-27T00:00:00Z",
          issuedAt: "2026-05-27T00:00:00Z",
          capabilities: ["cap.chat"],
          signature: "sig",
        },
      })),
    };

    const client = new XoreinClient({ transport });
    await expect(client.connectToServer("srv-3")).rejects.toMatchObject({ code: "manifest_mismatch", message: "manifest server mismatch" });
    expect(client.connection().state).toBe("no-peer");
    expect(client.connection().detail).toBe("manifest server mismatch");
    expect(transport.disconnect).toHaveBeenCalledWith("handshake-failed");
  });

  it("classifies malformed accepted protocols as protocol_invalid", async () => {
    const manifest = await signManifest({
      serverId: "srv-4",
      version: 1,
      description: "Other server",
      updatedAt: "2026-05-27T00:00:00Z",
      capabilities: { chat: true, voice: false },
    }, "owner");

    const transport: XoreinTransport = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      performHandshake: vi.fn(async () => ({
        manifest,
        offeredSecurityModes: ["seal"] as SecurityMode[],
        acceptedProtocol: "/aether/chat/not-a-version",
      })),
    };

    const client = new XoreinClient({ transport, now: () => Date.parse("2026-05-27T00:00:00Z"), protocolOffers: [{ family: "chat", version: { major: 1, minor: 0 }, name: "chat/1.0" }] });
    await expect(client.connectToServer("srv-4")).rejects.toMatchObject({ code: "protocol_invalid", message: "invalid accepted protocol: /aether/chat/not-a-version" });
    expect(client.connection().state).toBe("disconnected");
    expect(client.connection().detail).toBe("invalid accepted protocol: /aether/chat/not-a-version");
    expect(transport.disconnect).toHaveBeenCalledWith("handshake-failed");
  });

  it("returns cloned sessions and connection snapshots without raw extra keys", async () => {
    const transport: XoreinTransport = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      performHandshake: vi.fn(async () => ({
        manifest: await signManifest({
          serverId: "srv-5",
          version: 1,
          description: "Session clone server",
          updatedAt: "2026-05-27T00:00:00Z",
          capabilities: { chat: true, voice: false },
        }, "owner-peer", async (payload) => `digest:${payload}`),
        offeredSecurityModes: ["seal"] as SecurityMode[],
      })),
    };

    const client = new XoreinClient({ transport, digest: async (payload) => `digest:${payload}`, now: () => Date.parse("2026-05-27T00:00:00Z") });
    await client.connectToServer("srv-5");

    const rawSession = (client as unknown as {
      currentSession: XoreinConnectionSnapshot["session"] & Record<string, unknown>;
      connectionSnapshot: XoreinConnectionSnapshot & Record<string, unknown>;
    });
    rawSession.currentSession.extra_session = { bad: true };
    rawSession.currentSession.acceptedProtocol = {
      family: "chat",
      version: { major: 1, minor: 0 },
      name: "chat/1.0",
      extra_protocol: "bad",
    } as never;
    rawSession.connectionSnapshot.extra_connection = { bad: true };
    rawSession.connectionSnapshot.session = rawSession.currentSession;
    const rawConnectionSession = rawSession.connectionSnapshot.session as unknown as Record<string, unknown>;
    rawConnectionSession.extra_connection_session = { bad: true };
    const rawNegotiation = rawSession.currentSession.capabilityNegotiation as unknown as Record<string, unknown>;
    rawNegotiation.extra_negotiation = { bad: true };
    const rawContract = rawSession.currentSession.featureContract as unknown as Record<string, unknown>;
    rawContract.extra_feature = { bad: true };

    const session = client.snapshot();
    const connection = client.connection();
    const rawNegotiationArrays = rawSession.currentSession.capabilityNegotiation as unknown as {
      accepted: string[];
      ignoredRemote: string[];
      missingRequired: string[];
    };
    const rawFeatureArrays = rawSession.currentSession.featureContract as unknown as {
      localSupported: string[];
      blockedProtocolFeatures: string[];
      localOnlyEnabledFeatures: string[];
    };
    rawNegotiationArrays.accepted.push("cap.extra");
    rawNegotiationArrays.ignoredRemote.push("cap.remote");
    rawNegotiationArrays.missingRequired.push("cap.missing");
    rawFeatureArrays.localSupported.push("cap.local");
    rawFeatureArrays.blockedProtocolFeatures.push("cap.blocked");
    rawFeatureArrays.localOnlyEnabledFeatures.push("cap.local-only");

    expect(session).toEqual(expect.objectContaining({
      serverId: "srv-5",
      securityMode: "seal",
      connectedAtMs: Date.parse("2026-05-27T00:00:00Z"),
      reconnectAttempts: 0,
    }));
    expect((session as unknown as Record<string, unknown>).extra_session).toBeUndefined();
    expect((session?.acceptedProtocol as unknown as Record<string, unknown>)?.extra_protocol).toBeUndefined();
    expect((session?.capabilityNegotiation as unknown as Record<string, unknown>)?.extra_negotiation).toBeUndefined();
    expect((session?.featureContract as unknown as Record<string, unknown>)?.extra_feature).toBeUndefined();
    expect(session?.capabilityNegotiation.accepted).not.toContain("cap.extra");
    expect(session?.capabilityNegotiation.ignoredRemote).not.toContain("cap.remote");
    expect(session?.capabilityNegotiation.missingRequired).not.toContain("cap.missing");
    expect(session?.featureContract.localSupported).not.toContain("cap.local");
    expect(session?.featureContract.blockedProtocolFeatures).not.toContain("cap.blocked");
    expect(session?.featureContract.localOnlyEnabledFeatures).not.toContain("cap.local-only");

    expect(connection).toEqual(expect.objectContaining({
      state: "connected",
      serverId: "srv-5",
      reconnectAttempts: 0,
      updatedAtMs: Date.parse("2026-05-27T00:00:00Z"),
    }));
    expect((connection as unknown as Record<string, unknown>).extra_connection).toBeUndefined();
    expect((connection.session as unknown as Record<string, unknown> | undefined)?.extra_connection_session).toBeUndefined();
  });
});
