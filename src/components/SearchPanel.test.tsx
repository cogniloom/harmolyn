import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchPanel } from "./SearchPanel";

const searchMessagesMock = vi.fn();

vi.mock("@/hooks/runtime/useRuntimeMutations", () => ({
  useRuntimeMutations: () => ({
    searchMessages: searchMessagesMock,
  }),
}));

describe("SearchPanel", () => {
  beforeEach(() => {
    searchMessagesMock.mockReset();
    searchMessagesMock.mockResolvedValue({ messages: [], results: [] });
  });

  it("searches native P2P messages via the mutation facade", async () => {
    searchMessagesMock.mockResolvedValue({
      messages: ["msg-1"],
      results: [{
        id: "msg-1",
        scope_type: "channel",
        scope_id: "chan-1",
        sender_peer_id: "peer-local",
        body: "runtime result",
        created_at: "2026-05-26T12:00:00Z",
      }],
    });

    const user = userEvent.setup();
    render(
      <SearchPanel
        onClose={vi.fn()}
        scopeType="channel"
        scopeId="chan-1"
        serverId="srv-1"
        users={[
          { id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online" },
        ]}
      />,
    );

    await user.type(screen.getByPlaceholderText(/search messages/i), "runtime");

    await waitFor(() => {
      expect(searchMessagesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "runtime",
          scope_type: "channel",
          scope_id: "chan-1",
          server_id: "srv-1",
          limit: 50,
        }),
      );
    });

    expect(await screen.findByText("runtime result")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("passes the selected date boundary through to the search query", async () => {
    const user = userEvent.setup();
    render(
      <SearchPanel
        onClose={vi.fn()}
        scopeType="channel"
        scopeId="chan-1"
        users={[
          { id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online" },
        ]}
      />,
    );

    await user.type(screen.getByPlaceholderText(/search messages/i), "runtime");
    await user.click(screen.getByRole("button", { name: /date/i }));

    const beforeInput = document.querySelectorAll<HTMLInputElement>('input[type="date"]')[0];
    fireEvent.change(beforeInput, { target: { value: "2026-05-26" } });
    await user.click(screen.getAllByRole("button", { name: /^apply$/i })[0]);

    await waitFor(() => {
      expect(searchMessagesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          query: "runtime",
          scope_type: "channel",
          scope_id: "chan-1",
          before: expect.any(String),
          limit: 50,
        }),
      );
    });
  });

  it("normalizes malformed user records before rendering search filters and results", async () => {
    searchMessagesMock.mockResolvedValue({
      messages: ["msg-1"],
      results: [{
        id: "msg-1",
        scope_type: "channel",
        scope_id: "chan-1",
        sender_peer_id: "peer-local",
        body: "runtime result",
        created_at: "2026-05-26T12:00:00Z",
      }],
    });

    const user = userEvent.setup();
    render(
      <SearchPanel
        onClose={vi.fn()}
        scopeType="channel"
        scopeId="chan-1"
        serverId="srv-1"
        users={[
          {
            id: "peer-local",
            username: { bad: true },
            avatar: 42,
            status: "online",
            bio: { note: "bad" },
          } as never,
        ]}
      />,
    );

    await user.type(screen.getByPlaceholderText(/search messages/i), "runtime");
    await user.click(screen.getByRole("button", { name: /from/i }));

    expect(await screen.findByText("runtime result")).toBeTruthy();
    expect(screen.getAllByText("peer-local")).toHaveLength(2);
  });

  it("collapses duplicate user ids before rendering the From filter list", async () => {
    const user = userEvent.setup();
    render(
      <SearchPanel
        onClose={vi.fn()}
        scopeType="channel"
        scopeId="chan-1"
        users={[
          { id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online" },
          { id: "peer-local", username: "Ada Duplicate", avatar: "/avatar-2.png", status: "idle" },
        ]}
      />,
    );

    await user.type(screen.getByPlaceholderText(/search messages/i), "runtime");
    await user.click(screen.getByRole("button", { name: /from/i }));

    expect(screen.getAllByText("Ada")).toHaveLength(1);
    expect(screen.queryByText("Ada Duplicate")).toBeNull();
  });

  it("renders unknown search senders explicitly instead of borrowing the local user", async () => {
    searchMessagesMock.mockResolvedValue({
      messages: ["msg-1"],
      results: [{
        id: "msg-1",
        scope_type: "channel",
        scope_id: "chan-1",
        sender_peer_id: "missing-peer",
        body: "runtime result",
        created_at: "2026-05-26T12:00:00Z",
      }],
    });

    const user = userEvent.setup();
    render(
      <SearchPanel
        onClose={vi.fn()}
        scopeType="channel"
        scopeId="chan-1"
        users={[
          { id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online" },
        ]}
      />,
    );

    await user.type(screen.getByPlaceholderText(/search messages/i), "runtime");

    expect(await screen.findByText("Unknown User")).toBeTruthy();
    expect(screen.queryByText("Ada")).toBeNull();
  });
});
