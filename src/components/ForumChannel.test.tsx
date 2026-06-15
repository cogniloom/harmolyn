import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForumChannel } from "./ForumChannel";
import { useRuntimeSnapshot } from "@/lib/xoreinRuntimeContext";
import { searchMessages, sendChannelMessage } from "@/lib/xoreinControl";
import { PREVIEW_STORAGE_KEYS } from "@/config/storageKeys";
import type { Channel } from "@/types";

vi.mock("@/data", () => ({
  CURRENT_USER: {
    id: "peer-local",
    username: "Ada",
    avatar: "/avatar.png",
    status: "online",
  },
  USERS: [
    {
      id: "peer-local",
      username: "Ada",
      avatar: "/avatar.png",
      status: "online",
    },
    {
      id: "peer-local",
      username: "Ada Duplicate",
      avatar: "/avatar-duplicate.png",
      status: "idle",
    },
    {
      id: "peer-remote",
      username: "Grace",
      avatar: "/avatar2.png",
      status: "online",
    },
  ],
}));

vi.mock("@/lib/xoreinRuntimeContext", () => ({
  useRuntimeSnapshot: vi.fn(),
}));

vi.mock("@/lib/xoreinControl", async () => {
  const actual = await vi.importActual<typeof import("@/lib/xoreinControl")>("@/lib/xoreinControl");
  return {
    ...actual,
    searchMessages: vi.fn(),
    sendChannelMessage: vi.fn(),
  };
});

const channel: Channel = { id: "ch-forum", name: "ideas", type: "forum", categoryId: "c" };

describe("ForumChannel backend wiring", () => {
  beforeEach(() => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      peer_id: "peer-local",
      identity: { peer_id: "peer-local" },
      control_endpoint: "http://xorein.local",
    });
    vi.mocked(searchMessages).mockResolvedValue({
      messages: ["msg-1", "msg-2"],
      results: [
        {
          id: "msg-1",
          scope_type: "channel",
          scope_id: "ch-forum",
          sender_peer_id: "peer-local",
          body: "How do I set up relays?\n\nI need a sane production approach.\n\n#help #relay",
          created_at: "2026-05-26T10:00:00Z",
        },
        {
          id: "msg-2",
          scope_type: "channel",
          scope_id: "ch-forum",
          sender_peer_id: "peer-remote",
          body: "Use discovery first.\n\nThen persist relay queue state.\n\n#rfc",
          reply_to: "msg-1",
          created_at: "2026-05-26T11:00:00Z",
        },
      ],
    } as never);
    vi.mocked(sendChannelMessage).mockResolvedValue({
      id: "msg-3",
      scope_type: "channel",
      scope_id: "ch-forum",
      sender_peer_id: "peer-local",
      body: "New forum post\n\nHello world\n\n#idea",
    } as never);
  });

  it("loads live forum posts from xorein", async () => {
    render(
      <ForumChannel
        channel={channel}
        users={[
          { id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online" },
          { id: "peer-remote", username: "Grace", avatar: "/avatar2.png", status: "online" },
        ]}
      />,
    );

    await waitFor(() => {
      expect(searchMessages).toHaveBeenCalledWith(
        expect.objectContaining({ peer_id: "peer-local" }),
        expect.objectContaining({
          scope_type: "channel",
          scope_id: "ch-forum",
          limit: 200,
        }),
      );
    });

    expect(await screen.findByText("How do I set up relays?")).toBeTruthy();
    expect(screen.getByText(/i need a sane production approach/i)).toBeTruthy();
  });

  it("normalizes malformed persisted forum posts", () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue(null);
    window.localStorage.setItem(
      PREVIEW_STORAGE_KEYS.forum(channel.id),
      JSON.stringify([
        // Fully broken record: non-string id/title/authorId -> dropped entirely.
        {
          id: { broken: true },
          title: 123,
          authorId: null,
          content: { body: "broken" },
          tags: [{ tag: "bad" }],
          timestamp: [],
          replies: "nope",
          views: "nope",
          upvotes: "nope",
        },
        // Valid-but-malformed record: required fields present, but the numeric
        // and tag fields need coercion. Should survive normalization.
        {
          id: "  fp-coerce  ",
          title: "  Needs trimming  ",
          authorId: "peer-local",
          content: "Body stays as-is",
          tags: [" Relay ", "relay", 42, "help"],
          timestamp: "2026-05-27T12:00:00Z",
          replies: "not-a-number",
          views: NaN,
          upvotes: 7,
        },
      ]),
    );

    render(<ForumChannel channel={channel} />);

    // Broken record produced no fabricated/seed content.
    expect(screen.queryByText("How to set up E2E encryption for DMs?")).toBeNull();

    // Valid-but-malformed record is normalized: trimmed strings, coerced numbers,
    // deduped/lowercased tags.
    expect(screen.getByText("Needs trimming")).toBeTruthy();
    expect(screen.getByText("Body stays as-is")).toBeTruthy();
    expect(screen.getByText("relay")).toBeTruthy();
    expect(screen.getByText("help")).toBeTruthy();
    // " Relay " and "relay" collapse to a single chip; non-string tags are dropped.
    expect(screen.getAllByText("relay").length).toBe(1);
    // upvotes coerced/preserved as a number, invalid replies fell back to 0.
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("renders the empty state when all persisted forum posts are malformed", () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue(null);
    window.localStorage.setItem(
      PREVIEW_STORAGE_KEYS.forum(channel.id),
      JSON.stringify([
        { id: { broken: true }, title: 123, authorId: null },
        "not-an-object",
        { id: "missing-title", authorId: "peer-local" },
      ]),
    );

    render(<ForumChannel channel={channel} />);

    expect(screen.getByText(/no posts yet/i)).toBeTruthy();
    expect(screen.queryByText("How to set up E2E encryption for DMs?")).toBeNull();
  });

  it("dedupes forum tags before rendering chips and tag filters", () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue(null);
    window.localStorage.setItem(
      PREVIEW_STORAGE_KEYS.forum(channel.id),
      JSON.stringify([
        {
          id: "fp-dup",
          title: "Duplicate tags",
          authorId: "u2",
          content: "Testing forum tag dedupe",
          tags: [" relay ", "relay", "Relay", "help", "help"],
          timestamp: "2026-05-27T12:00:00Z",
          replies: 0,
          views: 0,
          upvotes: 0,
        },
      ]),
    );

    render(<ForumChannel channel={channel} />);

    expect(screen.getAllByText("relay").length).toBe(1);
    expect(screen.getAllByText("help").length).toBe(1);
    expect(screen.getByText("RELAY")).toBeTruthy();
    expect(screen.getByText("HELP")).toBeTruthy();
  });

  it("publishes a live forum post through xorein", async () => {
    const user = userEvent.setup();

    render(
      <ForumChannel
        channel={channel}
        users={[
          { id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online" },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /new post/i }));
    await user.type(screen.getByLabelText(/post title/i), "New forum post");
    await user.type(screen.getByLabelText(/post content/i), "Hello world");
    await user.type(screen.getByLabelText(/post tags/i), "idea");
    await user.click(screen.getByRole("button", { name: /^publish$/i }));

    await waitFor(() => {
      expect(sendChannelMessage).toHaveBeenCalledWith(
        expect.objectContaining({ peer_id: "peer-local" }),
        "ch-forum",
        "New forum post\n\nHello world\n\n#idea",
      );
    });
  });

  it("opens a thread and replies through xorein", async () => {
    const user = userEvent.setup();

    render(
      <ForumChannel
        channel={channel}
        users={[
          { id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online" },
          { id: "peer-remote", username: "Grace", avatar: "/avatar2.png", status: "online" },
        ]}
      />,
    );

    await waitFor(() => expect(searchMessages).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /How do I set up relays\?/i }));
    await user.type(screen.getByPlaceholderText(/reply \/\/ thread/i), "Try the relay queue");
    await user.click(screen.getByRole("button", { name: /send reply/i }));

    await waitFor(() => {
      expect(sendChannelMessage).toHaveBeenCalledWith(
        expect.objectContaining({ peer_id: "peer-local" }),
        "ch-forum",
        "Try the relay queue",
        { reply_to: "msg-1" },
      );
    });
  });

  it("keeps the first normalized user when duplicate author ids are present", () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue(null);
    window.localStorage.setItem(
      PREVIEW_STORAGE_KEYS.forum(channel.id),
      JSON.stringify([
        {
          id: "fp-dup",
          title: "Duplicate author",
          authorId: "peer-local",
          content: "Testing duplicate forum users",
          tags: ["help"],
          timestamp: "2026-05-27T12:00:00Z",
          replies: 0,
          views: 0,
          upvotes: 0,
        },
      ]),
    );

    render(<ForumChannel channel={channel} />);

    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.queryByText("Ada Duplicate")).toBeNull();
  });
});
