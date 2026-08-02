import { describe, it, expect, vi } from "vitest";
import { readShellRuntimeData, deriveConnectionState, type ShellRuntimeData } from "@/data";
import type { XoreinRuntimeSnapshot } from "@/types";
import { clearRuntime, injectRuntimeSnapshot, injectSessionSnapshot } from "@/test/runtimeHarness";
import { createHappyRuntime, createRuntimeServer, createSessionSnapshot } from "@/test/fixtures";

describe("readShellRuntimeData mapping", () => {
  it("maps an injected runtime snapshot into UI servers, channels, and messages", () => {
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      messages: [
        {
          id: "msg-base-1",
          scope_type: "channel",
          scope_id: "base-node-general",
          server_id: "base-node",
          sender_peer_id: "u2",
          body: "hello from the base node",
          reply_to: "msg-root-1",
          created_at: "2026-04-22T00:00:00Z",
        },
      ],
    });
    const shell = readShellRuntimeData();

    expect(shell.runtimeSnapshot).not.toBeNull();
    expect(shell.servers).toHaveLength(1);
    expect(shell.servers[0].name).toBe("Base Node");

    const channels = shell.servers[0].categories.flatMap((category) => category.channels);
    expect(channels.find((channel) => channel.name === "general")?.type).toBe("text");
    expect(channels.find((channel) => channel.name === "Voice Lounge")?.type).toBe("voice");

    const general = shell.messagesByScope.get("base-node-general") ?? [];
    expect(general).toHaveLength(1);
    expect(general[0].content).toBe("hello from the base node");
    expect(general[0].replyToId).toBe("msg-root-1");

    expect(shell.directMessages).toHaveLength(1);
    expect(shell.currentUser).toBeDefined();
  });

  it("preserves peer-swarm attachment manifests through runtime normalization", () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32))).replace(/=+$/, "");
    const nonce = btoa(String.fromCharCode(...new Uint8Array(12))).replace(/=+$/, "");
    const swarm = {
      version: 1 as const,
      blob_id: "a".repeat(64),
      node_namespace: "A".repeat(43),
      scope_id: "base-node-general",
      owner_peer_id: "u2",
      ciphertext_size: 17,
      chunk_size: 64 * 1024,
      chunk_hashes: ["b".repeat(64)],
      provider_peer_ids: ["u2"],
    };
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      messages: [{
        id: "msg-attachment",
        scope_type: "channel",
        scope_id: "base-node-general",
        server_id: "base-node",
        sender_peer_id: "u2",
        body: "peer attachment",
        media: [{
          id: swarm.blob_id,
          name: "peer.txt",
          content_type: "text/plain",
          size: 1,
          key,
          nonce,
          content_hash: "c".repeat(64),
          swarm,
        }],
      }],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.messages?.[0].media?.[0].swarm).toEqual(swarm);
    expect(shell.messagesByScope.get("base-node-general")?.[0].media?.[0].swarm).toEqual(swarm);
  });

  it("uses persisted local presence for the current user", () => {
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      presence: {
        "peer-local": {
          status: "away",
          status_text: "deep work",
          updated_at: "2026-04-22T00:00:00Z",
        },
      },
    });
    const shell = readShellRuntimeData();
    expect(shell.currentUser.status).toBe("idle");
  });

  it("uses backend presence for remote peers when available", () => {
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      presence: {
        "u2": {
          status: "dnd",
          updated_at: "2026-04-22T00:00:00Z",
        },
      },
    });
    const shell = readShellRuntimeData();
    const remote = shell.users.find((user) => user.id === "u2");
    expect(remote?.status).toBe("dnd");
  });

  it("escapes user-controlled avatar labels inside svg data uris", () => {
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      identity: {
        ...createHappyRuntime().identity,
        profile: {
          ...createHappyRuntime().identity.profile,
          display_name: `<script>alert(1)</script>`,
        },
      },
    });

    const shell = readShellRuntimeData();
    const svg = decodeURIComponent(shell.currentUser.avatar.split(",")[1] ?? "");

    expect(svg).toContain("&lt;");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("</script>");
  });

  it("ignores array-shaped injected runtime snapshots", () => {
    clearRuntime();
    window.localStorage.setItem("harmolyn:xorein:runtime", JSON.stringify([]));

    const shell = readShellRuntimeData();

    expect(shell.runtimeSnapshot).toBeNull();
  });

  it("ignores null-prototype injected runtime snapshots", () => {
    clearRuntime();
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = Object.create(null);

    const shell = readShellRuntimeData();

    expect(shell.runtimeSnapshot).toBeNull();
  });

  it("drops malformed nested server channel maps from injected runtime snapshots", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      servers: [
        {
          ...createHappyRuntime().servers[0],
          channels: {
            "base-node-general": null as unknown as never,
          },
        } as unknown as XoreinRuntimeSnapshot["servers"][number],
      ],
    });

    expect(() => readShellRuntimeData()).not.toThrow();
    const shell = readShellRuntimeData();
    expect(shell.servers).toHaveLength(1);
    expect(shell.runtimeSnapshot?.servers?.[0].channels).toEqual({});
  });

  it("drops malformed nested identity profiles from injected runtime snapshots", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      identity: {
        ...createHappyRuntime().identity,
        profile: {
          display_name: 123 as unknown as string,
          bio: "connected test user",
        } as unknown as XoreinRuntimeSnapshot["identity"]["profile"],
      },
    });

    const shell = readShellRuntimeData();
    expect(shell.currentUser.username).toBe("Local User");
    expect(shell.currentUser.bio).toBe("connected test user");
  });

  it("normalizes runtime settings into strict string values", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      settings: {
        control_endpoint: { bad: true } as never,
        theme: " neon ",
        empty: "   ",
      } as never,
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.settings).toEqual({
      theme: "neon",
    });
  });

  it("drops empty runtime settings objects from shell hydration", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      settings: {},
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.settings).toBeUndefined();
  });

  it("drops empty runtime presence maps from shell hydration", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      presence: {},
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.presence).toBeUndefined();
  });

  it("keeps the first normalized runtime setting when keys collide", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      settings: {
        ' control_endpoint ': ' http://127.0.0.1:7711 ',
        control_endpoint: ' http://127.0.0.1:7999 ',
      } as never,
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.settings).toEqual({
      control_endpoint: 'http://127.0.0.1:7711',
    });
  });

  it("keeps the first normalized runtime presence entry when keys collide", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      presence: {
        ' peer-local ': {
          status: 'online',
          updated_at: '2026-01-01T00:00:00Z',
        },
        'peer-local': {
          status: 'idle',
          updated_at: '2026-01-02T00:00:00Z',
        },
      } as never,
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.presence).toEqual({
      'peer-local': {
        status: 'online',
        updated_at: '2026-01-01T00:00:00Z',
      },
    });
  });

  it("drops raw top-level runtime keys while preserving sanitized friends", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      role: "  operator  ",
      peer_id: "  peer-local  ",
      control_endpoint: "  http://127.0.0.1:7711  ",
      friends: [
        {
          id: " friend-1 ",
          from_peer_id: " peer-local ",
          status: "accepted",
          created_at: "2026-04-22T00:00:00Z",
          unexpected: true,
        } as never,
      ],
      friend_requests: [
        {
          id: " request-1 ",
          from_peer_id: " peer-remote ",
          status: "pending",
          created_at: "2026-04-22T00:00:00Z",
          unexpected: "bad",
        } as never,
      ],
      unexpected: { bad: true } as never,
    } as unknown as XoreinRuntimeSnapshot);

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.role).toBe("operator");
    expect(shell.runtimeSnapshot?.peer_id).toBe("peer-local");
    expect(shell.runtimeSnapshot?.control_endpoint).toBe("http://127.0.0.1:7711");
    expect(shell.runtimeSnapshot?.friends).toEqual([
      {
        id: "friend-1",
        from_peer_id: "peer-local",
        status: "accepted",
        created_at: "2026-04-22T00:00:00Z",
      },
    ]);
    expect(shell.runtimeSnapshot?.friend_requests).toEqual([
      {
        id: "request-1",
        from_peer_id: "peer-remote",
        status: "pending",
        created_at: "2026-04-22T00:00:00Z",
      },
    ]);
    expect((shell.runtimeSnapshot as Record<string, unknown> | null)?.unexpected).toBeUndefined();
  });

  it("keeps the first normalized friend and friend-request entries when ids collide", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      friends: [
        {
          id: " friend-1 ",
          from_peer_id: " peer-local ",
          status: "accepted",
          created_at: "2026-04-22T00:00:00Z",
        } as never,
        {
          id: "friend-1",
          from_peer_id: "peer-remote",
          status: "blocked",
          created_at: "2026-04-23T00:00:00Z",
        } as never,
      ],
      friend_requests: [
        {
          id: " request-1 ",
          from_peer_id: " peer-remote ",
          status: "pending",
          created_at: "2026-04-22T00:00:00Z",
        } as never,
        {
          id: "request-1",
          from_peer_id: "peer-local",
          status: "cancelled",
          created_at: "2026-04-23T00:00:00Z",
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.friends).toEqual([
      {
        id: "friend-1",
        from_peer_id: "peer-local",
        status: "accepted",
        created_at: "2026-04-22T00:00:00Z",
      },
    ]);
    expect(shell.runtimeSnapshot?.friend_requests).toEqual([
      {
        id: "request-1",
        from_peer_id: "peer-remote",
        status: "pending",
        created_at: "2026-04-22T00:00:00Z",
      },
    ]);
  });

  it("keeps the first normalized runtime message when ids collide", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      messages: [
        {
          id: " msg-1 ",
          scope_type: " channel ",
          scope_id: " base-node-general ",
          sender_peer_id: " peer-local ",
          body: "first",
          created_at: "2026-04-22T00:00:00Z",
        } as never,
        {
          id: "msg-1",
          scope_type: "channel",
          scope_id: "base-node-general",
          sender_peer_id: "u2",
          body: "duplicate",
          created_at: "2026-04-23T00:00:00Z",
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.messages).toEqual([
      {
        id: "msg-1",
        scope_type: "channel",
        scope_id: "base-node-general",
        sender_peer_id: "peer-local",
        body: "first",
        created_at: "2026-04-22T00:00:00Z",
      },
    ]);
  });

  it("keeps the first normalized runtime DM when ids collide", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      dms: [
        {
          id: " dm-1 ",
          participants: ["peer-local", "u2"],
          created_at: "2026-04-22T00:00:00Z",
        } as never,
        {
          id: "dm-1",
          participants: ["peer-local", "u3"],
          created_at: "2026-04-23T00:00:00Z",
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.dms).toEqual([
      {
        id: "dm-1",
        participants: ["peer-local", "u2"],
        created_at: "2026-04-22T00:00:00Z",
      },
    ]);
  });

  it("fails closed to an unknown DM user when participants are missing", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      dms: [
        {
          id: "dm-missing",
          participants: [],
          created_at: "2026-04-22T00:00:00Z",
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.directMessages).toHaveLength(1);
    expect(shell.directMessages[0]).toEqual(expect.objectContaining({
      id: "dm-missing",
      userId: "unknown",
      lastMessage: "NO MESSAGES YET",
    }));
    expect(shell.users.some((user) => user.id === "unknown" && user.username === "Unknown User")).toBe(true);
  });

  it("does not invent a biography from local runtime connectivity", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      identity: {
        peer_id: "peer-local",
        profile: { display_name: "Ada" },
      },
    });

    expect(readShellRuntimeData().currentUser.bio).toBeUndefined();
  });

  it("preserves Space roles and member role colours for the member overview", () => {
    clearRuntime();
    const server = createRuntimeServer({
      id: "roles-space",
      name: "Roles Space",
      ownerPeerId: "peer-owner",
      memberPeerIds: ["peer-local", "u2"],
    });
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      servers: [{
        ...server,
        roles: [{ id: "moderator", name: "Moderator", color: "#7C5CFF", permissions: ["MANAGE_MESSAGES"] }],
        member_roles: { u2: ["moderator", "unknown-role"] },
      }],
    });

    const members = readShellRuntimeData().servers[0].members;
    expect(members.find((member) => member.id === "u2")).toMatchObject({
      role: "Moderator",
      roleColor: "#7C5CFF",
    });
    expect(members.find((member) => member.id === "peer-owner")).toMatchObject({
      role: "Admin",
      roleColor: "#F5B942",
    });
  });

  it("keeps member roles scoped to their own Space", () => {
    clearRuntime();
    const moderatorSpace = createRuntimeServer({
      id: "moderator-space",
      name: "Moderator Space",
      ownerPeerId: "peer-owner",
      memberPeerIds: ["peer-local", "u2"],
    });
    const memberSpace = createRuntimeServer({
      id: "member-space",
      name: "Member Space",
      ownerPeerId: "peer-owner-2",
      memberPeerIds: ["peer-local", "u2"],
    });
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      servers: [
        {
          ...moderatorSpace,
          roles: [{ id: "moderator", name: "Moderator", color: "#7C5CFF", permissions: ["MANAGE_MESSAGES"] }],
          member_roles: { u2: ["moderator"] },
        },
        memberSpace,
      ],
    });

    const servers = readShellRuntimeData().servers;
    expect(servers.find((server) => server.id === "moderator-space")?.members.find((member) => member.id === "u2"))
      .toMatchObject({ role: "Moderator", roleColor: "#7C5CFF" });
    expect(servers.find((server) => server.id === "member-space")?.members.find((member) => member.id === "u2"))
      .not.toHaveProperty("role");
  });

  it("normalizes runtime voice sessions into strict participant maps", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      voice_sessions: [
        {
          id: "voice-base",
          security_mode: "crowd",
          connection_state: "connected",
          self_muted: true,
          turn_unavailable: false,
          participants: [
            {
              peer_id: "peer-local",
              muted: true,
              video: true,
              screen_sharing: false,
              speaking: true,
              connection_state: "connected",
              joined_at: " 2026-04-22T00:00:00Z ",
              last_frame_at: { bad: true } as never,
            },
            {
              peer_id: "u2",
              muted: false,
            },
            {
              peer_id: "",
              muted: true,
            },
          ] as never,
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.voice_sessions?.[0]).toEqual({
      channel_id: "voice-base",
      security_mode: "crowd",
      connection_state: "connected",
      self_muted: true,
      turn_unavailable: false,
      participants: {
        "peer-local": {
          peer_id: "peer-local",
          muted: true,
          joined_at: "2026-04-22T00:00:00Z",
          video: true,
          screen_sharing: false,
          speaking: true,
          connection_state: "connected",
        },
        "u2": {
          peer_id: "u2",
          muted: false,
        },
      },
    });
  });

  it("keeps the first normalized runtime voice session when channel ids collide", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      voice_sessions: [
        {
          id: " voice-base ",
          participants: [
            {
              peer_id: " peer-local ",
              muted: true,
            },
            {
              peer_id: " u2 ",
            },
          ] as never,
        } as never,
        {
          id: "voice-base",
          participants: [
            {
              peer_id: "peer-local",
              muted: false,
            },
            {
              peer_id: "u3",
            },
          ] as never,
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.voice_sessions).toEqual([{
      channel_id: "voice-base",
      participants: {
        "peer-local": {
          peer_id: "peer-local",
          muted: true,
        },
        "u2": {
          peer_id: "u2",
        },
      },
    }]);
  });

  it("drops object-form voice participants whose peer_id does not match the map key", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      voice_sessions: [
        {
          id: "voice-base",
          participants: {
            "peer-local": {
              peer_id: "peer-local",
              muted: true,
            },
            "u2": {
              peer_id: "peer-bad",
              muted: false,
            } as never,
          } as never,
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.voice_sessions?.[0]).toEqual({
      channel_id: "voice-base",
      participants: {
        "peer-local": {
          peer_id: "peer-local",
          muted: true,
        },
      },
    });
  });

  it("keeps the first normalized object-form voice participant when peer ids collide", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      voice_sessions: [
        {
          id: "voice-base",
          participants: {
            " peer-local ": {
              peer_id: " peer-local ",
              muted: false,
            },
            "peer-local": {
              peer_id: "peer-local",
              muted: true,
            } as never,
            " u2 ": {
              peer_id: " u2 ",
            },
          } as never,
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.voice_sessions?.[0]).toEqual({
      channel_id: "voice-base",
      participants: {
        "peer-local": {
          peer_id: "peer-local",
          muted: false,
        },
        "u2": {
          peer_id: "u2",
        },
      },
    });
  });

  it("drops runtime DMs with malformed participant arrays", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      dms: [
        {
          id: "dm-good",
          participants: ["peer-local", "u2"],
        },
        {
          id: "dm-bad",
          participants: ["peer-local", { bad: true } as never],
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.dms).toEqual([
      {
        id: "dm-good",
        participants: ["peer-local", "u2"],
      },
    ]);
  });

  it("drops runtime messages with malformed deleted flags", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      messages: [
        {
          id: "msg-good",
          scope_type: "channel",
          scope_id: "base-node-general",
          sender_peer_id: "peer-local",
          body: "hello",
          deleted: false,
        },
        {
          id: "msg-bad",
          scope_type: "channel",
          scope_id: "base-node-general",
          sender_peer_id: "peer-local",
          body: "malformed",
          deleted: "nope" as never,
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.messages).toEqual([
      {
        id: "msg-good",
        scope_type: "channel",
        scope_id: "base-node-general",
        sender_peer_id: "peer-local",
        body: "hello",
        deleted: false,
      },
    ]);
  });

  it("drops runtime messages with blank bodies", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      messages: [
        {
          id: "msg-good",
          scope_type: "channel",
          scope_id: "base-node-general",
          sender_peer_id: "peer-local",
          body: "hello",
        },
        {
          id: "msg-bad",
          scope_type: "channel",
          scope_id: "base-node-general",
          sender_peer_id: "peer-local",
          body: "   ",
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.messages).toEqual([
      {
        id: "msg-good",
        scope_type: "channel",
        scope_id: "base-node-general",
        sender_peer_id: "peer-local",
        body: "hello",
      },
    ]);
  });

  it("drops runtime peers with malformed address arrays", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      known_peers: [
        { peer_id: "peer-local", role: "client", addresses: ["127.0.0.1:4100"], source: "self" },
        { peer_id: "peer-bad", role: "client", addresses: ["127.0.0.1:4101", { bad: true } as never], source: "manual" } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.known_peers).toEqual([
      { peer_id: "peer-local", role: "client", addresses: ["127.0.0.1:4100"], source: "self" },
    ]);
  });

  it("dedupes runtime peers by normalized peer id before rendering", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      known_peers: [
        { peer_id: " peer-local ", role: "client", addresses: ["127.0.0.1:4100"], source: "self" },
        { peer_id: "peer-local", role: "relay", addresses: ["127.0.0.1:4101"], source: "manual" },
      ] as never,
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.known_peers).toEqual([
      { peer_id: "peer-local", role: "client", addresses: ["127.0.0.1:4100"], source: "self" },
    ]);
  });

  it("normalizes server manifest relay addresses before relay detection", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      servers: [
        {
          ...createHappyRuntime().servers[0],
          manifest: {
            ...createHappyRuntime().servers[0].manifest,
            relay_addrs: ["/ip4/127.0.0.1/tcp/7777/p2p/relay-id", { bad: true } as never],
          } as never,
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.servers?.[0].manifest?.relay_addrs).toEqual([
      "/ip4/127.0.0.1/tcp/7777/p2p/relay-id",
    ]);
  });

  it("drops malformed server descriptions before rendering servers", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      servers: [
        {
          ...createHappyRuntime().servers[0],
          description: { bad: true } as never,
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.servers?.[0].description).toBeUndefined();
  });

  it("strips capability secrets from runtime data before rendering", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      servers: [{
        ...createHappyRuntime().servers[0],
        invite_secret: "owner-only-secret",
        crowd_root: "owner-only-root",
      } as never],
    });

    const runtimeServers = readShellRuntimeData().runtimeSnapshot?.servers;
    if (!runtimeServers?.[0]) {
      throw new Error("expected normalized runtime server");
    }
    const server = runtimeServers[0];
    expect("invite_secret" in server).toBe(false);
    expect("crowd_root" in server).toBe(false);
  });

  it("normalizes server owner, member, and channel ids before rendering servers", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      servers: [
        {
          ...createHappyRuntime().servers[0],
          id: " srv-1 ",
          name: " Alpha ",
          owner_peer_id: " peer-owner-base ",
          members: [" peer-local ", " peer-owner-base ", "u2 "],
          channels: {
            " srv-1-general ": {
              id: " srv-1-general ",
              server_id: " srv-1 ",
              name: " general ",
              voice: false,
              created_at: "2026-04-22T00:00:00Z",
            } as never,
          } as never,
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    const server = shell.runtimeSnapshot?.servers?.[0];
    expect(server?.id).toBe("srv-1");
    expect(server?.name).toBe("Alpha");
    expect(server?.description).toBe("Seed runtime for tests.");
    expect(server?.owner_peer_id).toBe("peer-owner-base");
    expect(server?.members).toEqual(["peer-local", "peer-owner-base", "u2"]);
    expect(server?.channels).toEqual({
      "srv-1-general": {
        id: "srv-1-general",
        server_id: "srv-1",
        name: "general",
        voice: false,
        created_at: "2026-04-22T00:00:00Z",
      },
    });
    expect(server?.manifest).toEqual({
      name: "Base Node",
      description: "Seed runtime for tests.",
      owner_addresses: ["127.0.0.1:4101"],
      capabilities: ["cap.chat", "cap.manifest", "cap.identity", "cap.dm", "cap.voice", "cap.presence"],
      history_coverage: "local-window",
      history_retention_messages: 50,
    });
  });

  it("keeps the first normalized server when server ids collide", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      servers: [
        {
          ...createHappyRuntime().servers[0],
          id: " srv-1 ",
          name: " First Alpha ",
        } as never,
        {
          ...createHappyRuntime().servers[0],
          id: "srv-1",
          name: "Second Alpha",
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.servers).toEqual([
      expect.objectContaining({
        id: "srv-1",
        name: "First Alpha",
      }),
    ]);
  });

  it("drops servers whose normalized channel ids would collide", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      servers: [
        {
          ...createHappyRuntime().servers[0],
          channels: {
            " srv-1-general ": {
              id: " srv-1-general ",
              server_id: " srv-1 ",
              name: " general ",
              voice: false,
            } as never,
            "srv-1-general": {
              id: "srv-1-general",
              server_id: "srv-1",
              name: "general backup",
              voice: false,
            } as never,
          } as never,
        } as never,
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.servers?.some((server) => server.id === "srv-1")).toBe(false);
  });

  it("falls back cleanly when injected storage access is blocked", () => {
    const storageError = new DOMException("Blocked", "SecurityError");
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw storageError;
    });
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw storageError;
    });

    expect(() => readShellRuntimeData()).not.toThrow();
    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot).toBeNull();
    expect(shell.sessionSnapshot).toBeNull();
  });
});

describe("deriveConnectionState", () => {
  it("is OFFLINE when no runtime has ever been seen", () => {
    const shell = readShellRuntimeData();
    expect(deriveConnectionState(shell, "home", false).status).toBe("disconnected");
  });

  it("is RECONNECTING when the runtime drops after having been seen", () => {
    const shell = readShellRuntimeData();
    expect(deriveConnectionState(shell, "home", true).status).toBe("reconnecting");
  });

  it("is RECONNECTING when a session exists but the runtime is gone", () => {
    injectSessionSnapshot(createSessionSnapshot());
    const shell = readShellRuntimeData();
    expect(deriveConnectionState(shell, "home", false).status).toBe("reconnecting");
  });

  it("is CONNECTED with no scoped server", () => {
    injectRuntimeSnapshot(createHappyRuntime());
    const shell = readShellRuntimeData();
    const state = deriveConnectionState(shell, "home", true);
    expect(state.status).toBe("connected");
    expect(state.canUseConnectivityActions).toBe(true);
  });

  it("does not call a reachable runtime CONNECTED until a peer path is confirmed", () => {
    const runtime = createHappyRuntime();
    delete runtime.transport_state;
    injectRuntimeSnapshot(runtime);
    const shell = readShellRuntimeData();
    const state = deriveConnectionState(shell, "home", true);
    expect(state.status).toBe("reconnecting");
    expect(state.label).toBe("CONNECTING");
    expect(state.detail).toContain("peer network");
  });

  it("treats prototype-bearing runtime identities as disconnected", () => {
    const shell = {
      runtimeSnapshot: {
        identity: Object.create({
          peer_id: "peer-local",
        }),
        servers: [],
        known_peers: [],
        dms: [],
        messages: [],
        voice_sessions: [],
        presence: {},
        relay_addrs: [],
        telemetry: [],
      },
      sessionSnapshot: null,
      currentUser: {
        id: "me",
        username: "Local User",
        avatar: "",
        status: "offline",
      },
      users: [],
      servers: [],
      directMessages: [],
      messages: [],
      messagesByScope: new Map(),
      defaultChannelByServer: new Map(),
      initialServerId: "home",
      initialChannelId: "",
    } satisfies ShellRuntimeData;

    expect(deriveConnectionState(shell, "home", false).status).toBe("disconnected");
  });

  it("is CONNECTED for a scoped server with a reachable peer", () => {
    injectRuntimeSnapshot(createHappyRuntime());
    const shell = readShellRuntimeData();
    expect(deriveConnectionState(shell, "base-node", true).status).toBe("connected");
  });

  it("uses the live peer graph as a router when the scoped member has no direct address", () => {
    const runtime: XoreinRuntimeSnapshot = {
      ...createHappyRuntime(),
      known_peers: [
        { peer_id: "peer-local", role: "client", addresses: ["127.0.0.1:4100"], source: "self" },
      ],
      servers: [
        createRuntimeServer({
          id: "lonely",
          name: "Lonely Node",
          ownerPeerId: "absent-owner",
          memberPeerIds: ["peer-local", "absent-owner"],
        }),
      ],
    };
    injectRuntimeSnapshot(runtime);
    const shell = readShellRuntimeData();
    const state = deriveConnectionState(shell, "lonely", true);
    expect(state.status).toBe("connected");
    expect(state.label).toBe("P2P ROUTED");
    expect(state.canUseConnectivityActions).toBe(true);
  });

  it("keeps durable peer actions enabled while a scoped space is still finding peers", () => {
    const runtime: XoreinRuntimeSnapshot = {
      ...createHappyRuntime(),
      transport_state: "disconnected",
      relay_addrs: [],
    };
    injectRuntimeSnapshot(runtime);
    const shell = readShellRuntimeData();
    const state = deriveConnectionState(shell, "base-node", true);
    expect(state.status).toBe("no-relay");
    expect(state.label).toBe("FINDING PEERS");
    expect(state.canUseConnectivityActions).toBe(true);
    expect(state.detail).toContain("retries continue automatically");
  });

  it("keeps peer actions active when a relay fails but an authenticated peer edge remains", () => {
    const runtime: XoreinRuntimeSnapshot = {
      ...createHappyRuntime(),
      known_peers: [
        { peer_id: "peer-local", role: "client", addresses: ["127.0.0.1:4100"], source: "self" },
        { peer_id: "direct-owner", role: "client", addresses: ["127.0.0.1:4200"], source: "manual" },
      ],
      servers: [
        {
          ...createRuntimeServer({
            id: "relayless",
            name: "Relayless Node",
            ownerPeerId: "direct-owner",
            memberPeerIds: ["peer-local", "direct-owner"],
          }),
          manifest: { name: "Relayless Node", relay_addrs: [], capabilities: ["cap.chat"] },
        },
      ],
      telemetry: ["delivery.relay.failed for relayless"],
    };
    injectRuntimeSnapshot(runtime);
    const shell = readShellRuntimeData();
    const state = deriveConnectionState(shell, "relayless", true);
    expect(state.status).toBe("connected");
    expect(state.label).toBe("P2P ONLY");
    expect(state.canUseConnectivityActions).toBe(true);
    expect(state.detail).toContain("Connected peers remain active");
  });

  it("treats top-level relay_addrs as a reachable relay path", () => {
    const runtime: XoreinRuntimeSnapshot = {
      ...createHappyRuntime(),
      relay_addrs: ["/ip4/127.0.0.1/tcp/7777/p2p/relay-id"],
      known_peers: [
        { peer_id: "peer-local", role: "client", addresses: ["127.0.0.1:4100"], source: "self" },
        { peer_id: "direct-owner", role: "client", addresses: ["127.0.0.1:4200"], source: "manual" },
      ],
      servers: [
        {
          ...createRuntimeServer({
            id: "relayless",
            name: "Relayless Node",
            ownerPeerId: "direct-owner",
            memberPeerIds: ["peer-local", "direct-owner"],
          }),
          manifest: { name: "Relayless Node", relay_addrs: [], capabilities: ["cap.chat"] },
        },
      ],
      telemetry: ["delivery.relay.failed for relayless"],
    };
    injectRuntimeSnapshot(runtime);
    const shell = readShellRuntimeData();
    expect(deriveConnectionState(shell, "relayless", true).status).toBe("connected");
  });

  it("dedupes runtime relay addresses before hydration", () => {
    clearRuntime();
    injectRuntimeSnapshot({
      ...createHappyRuntime(),
      relay_addrs: [
        " /ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay ",
        "/ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay",
        "/ip4/127.0.0.1/tcp/4002/p2p/12D3KooRelayTwo",
      ],
    });

    const shell = readShellRuntimeData();
    expect(shell.runtimeSnapshot?.relay_addrs).toEqual([
      "/ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay",
      "/ip4/127.0.0.1/tcp/4002/p2p/12D3KooRelayTwo",
    ]);
  });
});
