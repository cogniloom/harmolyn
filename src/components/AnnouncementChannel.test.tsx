import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnnouncementChannel } from "./AnnouncementChannel";
import { useRuntimeSnapshot } from "@/lib/xoreinRuntimeContext";
import { addReaction, searchMessages, sendChannelMessage } from "@/lib/xoreinControl";
import type { Channel } from "@/types";

vi.mock("@/lib/xoreinRuntimeContext", () => ({
  useRuntimeSnapshot: vi.fn(),
}));

vi.mock("@/lib/xoreinControl", async () => {
  const actual = await vi.importActual<typeof import("@/lib/xoreinControl")>("@/lib/xoreinControl");
  return {
    ...actual,
    addReaction: vi.fn(),
    searchMessages: vi.fn(),
    sendChannelMessage: vi.fn(),
  };
});

const channel: Channel = { id: "ch-ann", name: "news", type: "announcement", categoryId: "c" };

describe("AnnouncementChannel backend wiring", () => {
  beforeEach(() => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      peer_id: "peer-local",
      identity: { peer_id: "peer-local" },
      control_endpoint: "http://xorein.local",
    });
    vi.mocked(searchMessages).mockResolvedValue({
      messages: ["msg-1"],
      results: [{
        id: "msg-1",
        scope_type: "channel",
        scope_id: "ch-ann",
        sender_peer_id: "peer-local",
        body: "Maintenance\n\nWe will restart the mesh at 10:00 UTC.",
        created_at: "2026-05-26T12:00:00Z",
      }],
    } as never);
    vi.mocked(sendChannelMessage).mockResolvedValue({
      id: "msg-2",
      scope_type: "channel",
      scope_id: "ch-ann",
      sender_peer_id: "peer-local",
      body: "Server migration\n\nWindow opens at 18:00 UTC.",
    } as never);
    vi.mocked(addReaction).mockResolvedValue(undefined);
  });

  it("loads live announcements from xorein", async () => {
    render(<AnnouncementChannel channel={channel} />);

    await waitFor(() => {
      expect(searchMessages).toHaveBeenCalledWith(
        expect.objectContaining({ peer_id: "peer-local" }),
        expect.objectContaining({
          scope_type: "channel",
          scope_id: "ch-ann",
          limit: 50,
        }),
      );
    });

    expect(await screen.findByText("Maintenance")).toBeTruthy();
    expect(screen.getByText(/we will restart the mesh at 10:00 utc/i)).toBeTruthy();
  });

  it("publishes an announcement through xorein", async () => {
    const user = userEvent.setup();
    render(<AnnouncementChannel channel={channel} />);

    await user.click(screen.getByRole("button", { name: /new/i }));
    await user.type(screen.getByPlaceholderText(/announcement title/i), "Server migration");
    await user.type(screen.getByPlaceholderText(/write the announcement body/i), "Window opens at 18:00 UTC.");
    await user.click(screen.getByRole("button", { name: /publish through xorein/i }));

    await waitFor(() => {
      expect(sendChannelMessage).toHaveBeenCalledWith(
        expect.objectContaining({ peer_id: "peer-local" }),
        "ch-ann",
        "Server migration\n\nWindow opens at 18:00 UTC.",
      );
    });
  });

  it("sends reactions through xorein", async () => {
    const user = userEvent.setup();
    render(<AnnouncementChannel channel={channel} />);

    await waitFor(() => expect(searchMessages).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /react/i }));

    await waitFor(() => {
      expect(addReaction).toHaveBeenCalledWith(
        expect.objectContaining({ peer_id: "peer-local" }),
        "msg-1",
        "👍",
      );
    });
  });

  it("normalizes malformed runtime identity and announcement records", async () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      peer_id: { bad: true } as never,
      identity: {
        peer_id: { bad: true } as never,
      } as never,
      control_endpoint: "http://xorein.local",
    } as never);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: ["msg-1", "msg-2"],
      results: [
        {
          id: "msg-1",
          scope_type: "channel",
          scope_id: "ch-ann",
          sender_peer_id: "peer-local",
          body: "Maintenance\n\nWe will restart the mesh at 10:00 UTC.",
          created_at: "2026-05-26T12:00:00Z",
        },
        {
          id: "msg-2",
          scope_type: "channel",
          scope_id: "ch-ann",
          sender_peer_id: "",
          body: "",
        },
      ],
    } as never);

    render(<AnnouncementChannel channel={channel} />);

    expect(await screen.findByText("Maintenance")).toBeTruthy();
    expect(screen.queryByText("You")).toBeNull();
  });

  it("keeps the first announcement when duplicate message ids collide", async () => {
    vi.mocked(searchMessages).mockResolvedValue({
      messages: ["msg-1", "msg-1"],
      results: [
        {
          id: "msg-1",
          scope_type: "channel",
          scope_id: "ch-ann",
          sender_peer_id: "peer-local",
          body: "Maintenance\n\nWe will restart the mesh at 10:00 UTC.",
          created_at: "2026-05-26T12:00:00Z",
        },
        {
          id: "msg-1",
          scope_type: "channel",
          scope_id: "ch-ann",
          sender_peer_id: "peer-local",
          body: "Outage\n\nThis duplicate should not render.",
          created_at: "2026-05-26T12:05:00Z",
        },
      ],
    } as never);

    render(<AnnouncementChannel channel={channel} />);

    expect(await screen.findByText("Maintenance")).toBeTruthy();
    expect(screen.queryByText("Outage")).toBeNull();
    expect(screen.getAllByRole("button", { name: /react/i })).toHaveLength(1);
  });
});
