import { describe, expect, it } from "vitest";
import { normalizeLayoutUsers, normalizeRuntimePeerId, normalizeRuntimeVoiceSession, resolveLayoutDirectMessageUser } from "./layoutRuntime";

describe("Layout runtime normalization", () => {
  it("normalizes runtime peer ids", () => {
    expect(normalizeRuntimePeerId(" peer-local ")).toBe("peer-local");
    expect(normalizeRuntimePeerId({ bad: true } as never)).toBe("");
  });

  it("normalizes runtime voice sessions", () => {
    expect(
      normalizeRuntimeVoiceSession({
        channel_id: "voice-1",
        participants: {
          "peer-local": {
            peer_id: "peer-local",
            muted: true,
            joined_at: " 2026-05-26T12:00:00Z ",
            last_frame_at: { bad: true } as never,
          },
          "peer-bad": {
            peer_id: "peer-other",
            muted: false,
          },
          bad: {
            peer_id: 42 as never,
          },
        },
      }),
    ).toEqual({
      channel_id: "voice-1",
      participants: {
        "peer-local": {
          peer_id: "peer-local",
          muted: true,
          joined_at: "2026-05-26T12:00:00Z",
        },
      },
    });
  });

  it("keeps the first trimmed voice participant when ids collide", () => {
    expect(
      normalizeRuntimeVoiceSession({
        channel_id: "voice-1",
        participants: {
          " peer-local ": {
            peer_id: "peer-local",
            muted: true,
            joined_at: "2026-05-26T12:00:00Z",
          },
          "peer-local": {
            peer_id: "peer-local",
            muted: false,
            joined_at: "2026-05-26T13:00:00Z",
            last_frame_at: "2026-05-26T13:30:00Z",
          },
        },
      }),
    ).toEqual({
      channel_id: "voice-1",
      participants: {
        "peer-local": {
          peer_id: "peer-local",
          muted: true,
          joined_at: "2026-05-26T12:00:00Z",
        },
      },
    });
  });

  it("rejects malformed runtime voice sessions", () => {
    expect(normalizeRuntimeVoiceSession({})).toBeNull();
    expect(normalizeRuntimeVoiceSession({
      channel_id: "voice-1",
      participants: [],
    })).toBeNull();
  });

  it("keeps the first normalized layout user when duplicate ids are present", () => {
    expect(
      normalizeLayoutUsers([
        {
          id: "peer-dup",
          username: "Alpha DM",
          avatar: "/alpha.png",
          status: "online",
        },
        {
          id: "peer-dup",
          username: "Beta DM",
          avatar: "/beta.png",
          status: "idle",
        },
      ]),
    ).toEqual([
      {
        id: "peer-dup",
        username: "Alpha DM",
        avatar: "/alpha.png",
        status: "online",
      },
    ]);
  });

  it("renders an explicit unknown user for unresolved direct-message lookups", () => {
    expect(
      resolveLayoutDirectMessageUser([
        {
          id: "peer-1",
          username: "Alpha DM",
          avatar: "/alpha.png",
          status: "online",
        },
      ], "missing-peer"),
    ).toEqual({
      id: "unknown",
      username: "Unknown User",
      avatar: "",
      status: "offline",
    });
  });
});
