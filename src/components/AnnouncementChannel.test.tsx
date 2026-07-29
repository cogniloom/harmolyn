import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnnouncementChannel } from "./AnnouncementChannel";
import { useRuntimeSnapshot } from "@/lib/xoreinRuntimeContext";
import { useRuntimeMutations } from "@/hooks/runtime/useRuntimeMutations";
import type { Channel } from "@/types";

vi.mock("@/lib/xoreinRuntimeContext", () => ({
  useRuntimeSnapshot: vi.fn(),
}));

// The announcement surface must route EVERYTHING through the mutation facade
// (native engine) — never the HTTP support-node client.
vi.mock("@/hooks/runtime/useRuntimeMutations", () => ({
  useRuntimeMutations: vi.fn(),
}));

const sendChannelMessage = vi.fn();
const addReaction = vi.fn();

const channel: Channel = { id: "ch-ann", name: "news", type: "announcement", categoryId: "c" };

const baseMessage = {
  id: "msg-1",
  scope_type: "channel",
  scope_id: "ch-ann",
  sender_peer_id: "peer-local",
  body: "Maintenance\n\nWe will restart the mesh at 10:00 UTC.",
  created_at: "2026-05-26T12:00:00Z",
};

function mockSnapshot(messages: unknown[]) {
  vi.mocked(useRuntimeSnapshot).mockReturnValue({
    peer_id: "peer-local",
    identity: { peer_id: "peer-local" },
    control_endpoint: "http://xorein.local",
    messages,
  } as never);
}

describe("AnnouncementChannel native-engine wiring", () => {
  beforeEach(() => {
    sendChannelMessage.mockReset().mockResolvedValue({ id: "msg-2" });
    addReaction.mockReset().mockResolvedValue(undefined);
    vi.mocked(useRuntimeMutations).mockReturnValue({
      sendChannelMessage,
      addReaction,
    } as never);
    mockSnapshot([baseMessage]);
  });

  it("renders live announcements from the runtime snapshot", () => {
    render(<AnnouncementChannel channel={channel} />);

    expect(screen.getByText("Maintenance")).toBeTruthy();
    expect(screen.getByText(/we will restart the mesh at 10:00 utc/i)).toBeTruthy();
  });

  it("only shows messages scoped to this channel", () => {
    mockSnapshot([
      baseMessage,
      { ...baseMessage, id: "msg-other", scope_id: "ch-other", body: "Elsewhere\n\nNot for this feed." },
      { ...baseMessage, id: "msg-dm", scope_type: "dm", body: "DM\n\nNot a channel message." },
      { ...baseMessage, id: "msg-del", deleted: true, body: "Deleted\n\nShould not render." },
    ]);

    render(<AnnouncementChannel channel={channel} />);

    expect(screen.getByText("Maintenance")).toBeTruthy();
    expect(screen.queryByText("Elsewhere")).toBeNull();
    expect(screen.queryByText("DM")).toBeNull();
    expect(screen.queryByText("Deleted")).toBeNull();
  });

  it("updates reactively when the snapshot gains a new announcement (no reload step)", () => {
    const { rerender } = render(<AnnouncementChannel channel={channel} />);
    expect(screen.queryByText("Fresh news")).toBeNull();

    mockSnapshot([
      baseMessage,
      { ...baseMessage, id: "msg-2", body: "Fresh news\n\nJust arrived over P2P.", created_at: "2026-05-26T13:00:00Z" },
    ]);
    rerender(<AnnouncementChannel channel={channel} />);

    expect(screen.getByText("Fresh news")).toBeTruthy();
  });

  it("publishes an announcement through the mutation facade", async () => {
    const user = userEvent.setup();
    render(<AnnouncementChannel channel={channel} />);

    await user.click(screen.getByRole("button", { name: /new/i }));
    await user.type(screen.getByPlaceholderText(/announcement title/i), "Server migration");
    await user.type(screen.getByPlaceholderText(/write the announcement body/i), "Window opens at 18:00 UTC.");
    await user.click(screen.getByRole("button", { name: /publish through xorein/i }));

    await waitFor(() => {
      expect(sendChannelMessage).toHaveBeenCalledWith(
        "ch-ann",
        "Server migration\n\nWindow opens at 18:00 UTC.",
      );
    });
    // Compose form closes on success.
    expect(screen.queryByPlaceholderText(/announcement title/i)).toBeNull();
  });

  it("surfaces a publish failure in the status banner", async () => {
    sendChannelMessage.mockRejectedValueOnce(new Error("crowd key unavailable"));
    const user = userEvent.setup();
    render(<AnnouncementChannel channel={channel} />);

    await user.click(screen.getByRole("button", { name: /new/i }));
    await user.type(screen.getByPlaceholderText(/announcement title/i), "Broken");
    await user.click(screen.getByRole("button", { name: /publish through xorein/i }));

    expect(await screen.findByRole("status")).toHaveTextContent("crowd key unavailable");
    // Compose stays open so the draft is not lost.
    expect(screen.getByPlaceholderText(/announcement title/i)).toBeTruthy();
  });

  it("sends reactions through the mutation facade", async () => {
    const user = userEvent.setup();
    render(<AnnouncementChannel channel={channel} />);

    await user.click(screen.getByRole("button", { name: /react/i }));

    await waitFor(() => {
      expect(addReaction).toHaveBeenCalledWith("msg-1", "👍");
    });
  });

  it("normalizes malformed runtime identity and announcement records", () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      peer_id: { bad: true } as never,
      identity: { peer_id: { bad: true } as never } as never,
      messages: [
        baseMessage,
        { id: "msg-2", scope_type: "channel", scope_id: "ch-ann", sender_peer_id: "", body: "" },
        "not-a-record",
      ],
    } as never);

    render(<AnnouncementChannel channel={channel} />);

    expect(screen.getByText("Maintenance")).toBeTruthy();
    expect(screen.queryByText("You")).toBeNull();
  });

  it("keeps the first announcement when duplicate message ids collide", () => {
    mockSnapshot([
      baseMessage,
      { ...baseMessage, body: "Outage\n\nThis duplicate should not render.", created_at: "2026-05-26T12:05:00Z" },
    ]);

    render(<AnnouncementChannel channel={channel} />);

    expect(screen.getByText("Maintenance")).toBeTruthy();
    expect(screen.queryByText("Outage")).toBeNull();
    expect(screen.getAllByRole("button", { name: /react/i })).toHaveLength(1);
  });
});
