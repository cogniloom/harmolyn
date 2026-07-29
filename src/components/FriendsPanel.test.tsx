import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FriendsPanel } from "@/components/FriendsPanel";
import { useRuntimeSnapshot } from "@/lib/xoreinRuntimeContext";
import { listFriends, refreshRuntimeSnapshot, sendFriendRequest } from "@/lib/xoreinControl";
import { createHappyRuntime } from "@/test/fixtures";

vi.mock("@/data", async () => {
  const actual = await vi.importActual<typeof import("@/data")>("@/data");
  const baseUser = actual.USERS.find((user) => user.id === "u2") ?? {
    id: "u2",
    username: "Friend",
    avatar: "",
    status: "online" as const,
  };

  return {
    ...actual,
    USERS: [
      { ...baseUser, id: "u2", username: "Alpha Friend", status: "online" as const },
      { ...baseUser, id: "u2", username: "Beta Friend", status: "offline" as const },
      ...actual.USERS.filter((user) => user.id !== "u2"),
    ],
  };
});

vi.mock("@/lib/xoreinRuntimeContext", () => ({
  useRuntimeSnapshot: vi.fn(),
}));

vi.mock("@/lib/xoreinControl", async () => {
  const actual = await vi.importActual<typeof import("@/lib/xoreinControl")>("@/lib/xoreinControl");
  return {
    ...actual,
    listFriends: vi.fn(),
    refreshRuntimeSnapshot: vi.fn(),
    sendFriendRequest: vi.fn(),
    actOnFriendRequest: vi.fn(),
    removeFriend: vi.fn(),
  };
});

describe("FriendsPanel", () => {
  beforeEach(() => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue(null);
    vi.mocked(listFriends).mockResolvedValue([]);
    vi.mocked(sendFriendRequest).mockResolvedValue({
      id: "freq-1",
      from_peer_id: "peer-local",
      to_peer_id: "peer-remote",
      status: "pending",
    });
    vi.mocked(refreshRuntimeSnapshot).mockResolvedValue(createHappyRuntime());
    window.localStorage.clear();
  });

  it("does not create a local friend-request fallback when xorein is offline", async () => {
    const user = userEvent.setup();
    render(<FriendsPanel onOpenDM={() => ({ ok: true })} hasIdentity />);

    await user.click(screen.getByRole("button", { name: /add friend/i }));
    await user.type(screen.getByPlaceholderText(/peer id/i), "peer-remote");
    await user.click(screen.getByRole("button", { name: /send request/i }));

    expect(sendFriendRequest).not.toHaveBeenCalled();
    expect(await screen.findByText("Start the local xorein runtime before sending friend requests.")).toBeTruthy();
  });

  it("sends friend requests through the xorein control API", async () => {
    const runtime = {
      ...createHappyRuntime(),
      friends: [],
      friend_requests: [],
    };
    vi.mocked(useRuntimeSnapshot).mockReturnValue(runtime);

    const user = userEvent.setup();
    render(<FriendsPanel onOpenDM={() => ({ ok: true })} hasIdentity />);

    await user.click(screen.getByRole("button", { name: /add friend/i }));
    await user.type(screen.getByPlaceholderText(/peer id/i), "/ip4/127.0.0.1/tcp/4101/p2p/peer-remote");
    await user.click(screen.getByRole("button", { name: /send request/i }));

    await waitFor(() => {
      expect(sendFriendRequest).toHaveBeenCalledWith(runtime, "/ip4/127.0.0.1/tcp/4101/p2p/peer-remote");
    });
    expect(await screen.findByText("Friend request sent.")).toBeTruthy();
  });


  it("still renders when localStorage is blocked", async () => {
    const getItem = window.localStorage.getItem.bind(window.localStorage);
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    const removeItem = window.localStorage.removeItem.bind(window.localStorage);
    window.localStorage.getItem = vi.fn(() => { throw new Error('blocked'); });
    window.localStorage.setItem = vi.fn(() => { throw new Error('blocked'); });
    window.localStorage.removeItem = vi.fn(() => { throw new Error('blocked'); });

    try {
      render(<FriendsPanel onOpenDM={() => ({ ok: true })} />);
      expect(await screen.findByRole('button', { name: /add friend/i })).toBeTruthy();
    } finally {
      window.localStorage.getItem = getItem;
      window.localStorage.setItem = setItem;
      window.localStorage.removeItem = removeItem;
    }
  });

  it("ignores an array-shaped friends snapshot instead of fabricating friends", async () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      ...createHappyRuntime(),
      friends: [] as never,
      friend_requests: [] as never,
      // A malformed (array-shaped where the component expects records) friends payload
      // must never become a fabricated local friend list.
    });

    render(<FriendsPanel onOpenDM={() => ({ ok: true })} />);

    expect(await screen.findByRole("button", { name: /add friend/i })).toBeTruthy();
    expect(screen.getByText("No one is online")).toBeTruthy();
    // Nothing is persisted to the removed social-preview localStorage stub.
    expect(window.localStorage.getItem("harmolyn:xorein:social-preview")).toBeNull();
  });

  it("drops malformed friend-request records from the runtime snapshot", async () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      ...createHappyRuntime(),
      friends: [],
      friend_requests: [
        { id: "freq-good", from_peer_id: "u6", to_peer_id: "peer-local", status: "pending", created_at: "2026-04-22T00:00:00Z" },
        // status is not "pending" -> must be filtered out of the pending list.
        { id: "freq-accepted", from_peer_id: "u7", to_peer_id: "peer-local", status: "accepted", created_at: "2026-04-22T01:00:00Z" },
        // not a plain object -> must be ignored, never fabricated into a request.
        "not-a-record" as never,
      ],
    });

    const user = userEvent.setup();
    render(<FriendsPanel onOpenDM={() => ({ ok: true })} />);

    await user.click(screen.getByRole("button", { name: /^pending/i }));
    expect(screen.getByText("PENDING — 1")).toBeTruthy();
    expect(screen.getByText("u6")).toBeTruthy();
    expect(screen.queryByText("u7")).toBeNull();
  });

  it("dedupes accepted friend records before rendering the friends list", async () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      ...createHappyRuntime(),
      presence: {
        u6: { status: "online" as const, updated_at: "2026-04-22T00:00:00Z" },
      },
      friends: [
        { id: "friend-1", from_peer_id: "peer-local", to_peer_id: "u6", status: "accepted" },
        { id: "friend-2", from_peer_id: "u6", to_peer_id: "peer-local", status: "accepted" },
      ],
      friend_requests: [],
    });

    const user = userEvent.setup();
    render(<FriendsPanel onOpenDM={() => ({ ok: true })} />);

    await user.click(screen.getByRole("button", { name: /^all/i }));
    // Two accepted records resolve to the same peer (u6); it must appear once.
    expect(screen.getByText("ALL FRIENDS — 1")).toBeTruthy();
    expect(screen.getAllByText("u6").length).toBe(1);
  });

  it("prefers backend presence over last_seen_at for friend status", async () => {
    const runtime = {
      ...createHappyRuntime(),
      presence: {
        u2: { status: "dnd" as const, updated_at: "2026-04-22T00:00:00Z" },
      },
      friends: [
        { id: "friend-u2", from_peer_id: "peer-local", to_peer_id: "u2", status: "accepted" as const },
      ],
      friend_requests: [],
    };
    vi.mocked(useRuntimeSnapshot).mockReturnValue(runtime);

    render(<FriendsPanel onOpenDM={() => ({ ok: true })} />);

    expect(await screen.findByText("DO NOT DISTURB")).toBeTruthy();
  });

  it("normalizes malformed runtime peers and presence before rendering friends", async () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      ...createHappyRuntime(),
      known_peers: { bad: true } as never,
      presence: [] as never,
    });

    render(<FriendsPanel onOpenDM={() => ({ ok: true })} />);

    expect(await screen.findByRole("button", { name: /add friend/i })).toBeTruthy();
    expect(screen.getByText("FRIENDS")).toBeTruthy();
  });

  it("keeps the first normalized static user when duplicate ids are present", async () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      ...createHappyRuntime(),
      presence: {
        u2: { status: "online" as const, updated_at: "2026-04-22T00:00:00Z" },
      },
    });

    render(<FriendsPanel onOpenDM={() => ({ ok: true })} />);

    expect(await screen.findByText("Alpha Friend")).toBeTruthy();
    expect(screen.queryByText("Beta Friend")).toBeNull();
  });

  it("resolves a friend's display name from known_peers while keeping the peer id visible", async () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      ...createHappyRuntime(),
      known_peers: [
        { peer_id: "peer-bob", role: "peer", display_name: "Bob", addresses: [] },
      ],
      presence: {
        "peer-bob": { status: "online" as const, updated_at: "2026-04-22T00:00:00Z" },
      },
      friends: [
        { id: "friend-bob", from_peer_id: "peer-local", to_peer_id: "peer-bob", status: "accepted" as const },
      ],
      friend_requests: [],
    });

    const user = userEvent.setup();
    render(<FriendsPanel onOpenDM={() => ({ ok: true })} />);

    await user.click(screen.getByRole("button", { name: /^all/i }));
    // The learned display name is the row title…
    expect(screen.getByText("Bob")).toBeTruthy();
    // …and the raw peer id stays visible (secondary line) instead of BEING the title.
    expect(screen.getByText("peer-bob")).toBeTruthy();
  });

  it("excludes the local identity from the friends list even when own presence exists", async () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      ...createHappyRuntime(),
      known_peers: [],
      presence: {
        // Own presence entry (published by the native engine) must NOT become a friend row.
        "peer-local": { status: "online" as const, updated_at: "2026-04-22T00:00:00Z" },
        "peer-bob": { status: "online" as const, updated_at: "2026-04-22T00:00:00Z" },
      },
      friends: [
        { id: "friend-bob", from_peer_id: "peer-local", to_peer_id: "peer-bob", status: "accepted" as const },
      ],
      friend_requests: [],
    });

    const user = userEvent.setup();
    render(<FriendsPanel onOpenDM={() => ({ ok: true })} />);

    await user.click(screen.getByRole("button", { name: /^all/i }));
    expect(screen.getByText("ALL FRIENDS — 1")).toBeTruthy();
    expect(screen.queryByText("peer-local")).toBeNull();
    // Exactly one Message action — none offered for your own identity.
    expect(screen.getAllByRole("button", { name: "Message" }).length).toBe(1);
  });

  it("renders a friend's broadcast custom status text", async () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      ...createHappyRuntime(),
      known_peers: [
        { peer_id: "peer-bob", role: "peer", display_name: "Bob", addresses: [] },
      ],
      presence: {
        "peer-bob": { status: "online" as const, status_text: "BRB coffee", updated_at: "2026-04-22T00:00:00Z" },
      },
      friends: [
        { id: "friend-bob", from_peer_id: "peer-local", to_peer_id: "peer-bob", status: "accepted" as const },
      ],
      friend_requests: [],
    });

    const user = userEvent.setup();
    render(<FriendsPanel onOpenDM={() => ({ ok: true })} />);

    await user.click(screen.getByRole("button", { name: /^all/i }));
    expect(screen.getByText("BRB coffee")).toBeTruthy();
  });
});
