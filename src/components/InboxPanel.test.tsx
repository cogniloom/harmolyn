import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InboxPanel } from "./InboxPanel";

describe("InboxPanel", () => {
  it("normalizes malformed inbox users before rendering notification rows", () => {
    render(
      <InboxPanel
        items={[
          {
            id: "item-1",
            type: "mention",
            messageId: "msg-1",
            channelName: "general",
            serverName: "Alpha",
            timestamp: "2026-05-26T12:00:00Z",
            read: false,
          },
        ]}
        messages={[
          {
            id: "msg-1",
            userId: "peer-local",
            content: "runtime inbox message",
            timestamp: "2026-05-26T12:00:00Z",
          },
        ]}
        users={[
          {
            id: "peer-local",
            username: { bad: true },
            avatar: 123,
            status: "online",
            role: { bad: true },
            color: { bad: true },
            bio: { bad: true },
          } as never,
        ]}
        onJump={vi.fn()}
        onMarkAllRead={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("peer-local")).toBeTruthy();
    expect(screen.getByText("runtime inbox message")).toBeTruthy();
  });

  it("dedupes and normalizes inbox items before rendering notification rows", () => {
    const onJump = vi.fn();
    render(
      <InboxPanel
        items={[
          {
            id: " item-1 ",
            type: "mention",
            messageId: " msg-1 ",
            channelName: " general ",
            serverName: " Alpha ",
            timestamp: " 2026-05-26T12:00:00Z ",
            read: false,
          } as never,
          {
            id: "item-1",
            type: "reply",
            messageId: "msg-2",
            channelName: "should-not-render",
            serverName: "should-not-render",
            timestamp: "2026-05-26T12:00:00Z",
            read: true,
          } as never,
          {
            id: "item-2",
            type: "mention",
            messageId: "msg-3",
            channelName: "news",
            serverName: "Beta",
            timestamp: "2026-05-26T12:00:00Z",
            read: true,
          } as never,
        ]}
        messages={[
          {
            id: "msg-1",
            userId: "peer-local",
            content: "runtime inbox message",
            timestamp: "2026-05-26T12:00:00Z",
          },
          {
            id: "msg-3",
            userId: "peer-other",
            content: "secondary inbox message",
            timestamp: "2026-05-26T12:00:00Z",
          },
        ]}
        users={[
          {
            id: "peer-local",
            username: "nova",
            avatar: "",
            status: "online",
          } as never,
          {
            id: "peer-other",
            username: "orbit",
            avatar: "",
            status: "online",
          } as never,
        ]}
        onJump={onJump}
        onMarkAllRead={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByText("runtime inbox message").length).toBe(1);
    expect(screen.getAllByText("secondary inbox message").length).toBe(1);
    expect(screen.getByText("general")).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("should-not-render")).toBeNull();
    expect(screen.getByText("runtime inbox message")).toBeTruthy();
    expect(screen.getByText("secondary inbox message")).toBeTruthy();
  });

  it("keeps the first normalized message and user when duplicate ids are present", () => {
    render(
      <InboxPanel
        items={[
          {
            id: "item-1",
            type: "mention",
            messageId: "msg-1",
            channelName: "general",
            serverName: "Alpha",
            timestamp: "2026-05-26T12:00:00Z",
            read: false,
          },
        ]}
        messages={[
          {
            id: "msg-1",
            userId: "peer-dup",
            content: "first inbox message",
            timestamp: "2026-05-26T12:00:00Z",
          },
          {
            id: "msg-1",
            userId: "peer-dup",
            content: "second inbox message",
            timestamp: "2026-05-26T12:00:01Z",
          } as never,
        ]}
        users={[
          {
            id: "peer-dup",
            username: "Alpha Inbox",
            avatar: "",
            status: "online",
          } as never,
          {
            id: "peer-dup",
            username: "Beta Inbox",
            avatar: "",
            status: "offline",
          } as never,
        ]}
        onJump={vi.fn()}
        onMarkAllRead={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("first inbox message")).toBeTruthy();
    expect(screen.queryByText("second inbox message")).toBeNull();
    expect(screen.getByText("Alpha Inbox")).toBeTruthy();
    expect(screen.queryByText("Beta Inbox")).toBeNull();
  });

  it("renders missing inbox senders with an explicit placeholder", () => {
    render(
      <InboxPanel
        items={[
          {
            id: "item-missing",
            type: "reply",
            messageId: "msg-missing",
            channelName: "general",
            serverName: "Alpha",
            timestamp: "2026-05-26T12:00:00Z",
            read: false,
          },
        ]}
        messages={[
          {
            id: "msg-missing",
            userId: "missing-user",
            content: "mystery inbox message",
            timestamp: "2026-05-26T12:00:00Z",
          },
        ]}
        users={[]}
        onJump={vi.fn()}
        onMarkAllRead={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Unknown User")).toBeTruthy();
    expect(screen.getByText("mystery inbox message")).toBeTruthy();
  });
});
