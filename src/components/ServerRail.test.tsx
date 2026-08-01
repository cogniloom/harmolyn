import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServerRail } from "./ServerRail";
import type { ConnectionState, Server } from "@/types";

const connectionState: ConnectionState = {
  status: "connected",
  label: "Connected",
  detail: "Connected",
  canUseConnectivityActions: true,
};

describe("ServerRail", () => {
  it("normalizes and dedupes server records before rendering", () => {
    render(
      <ServerRail
        servers={[
          {
            id: "srv-1",
            name: "First Node",
            icon: "https://example.com/first.png",
            ownerId: "me",
            categories: [
              {
                id: "srv-1-text",
                name: "Text",
                channels: [
                  { id: "c1", name: "general", type: "text", categoryId: "srv-1-text", unreadCount: 2 },
                  { id: "c1", name: "general-duplicate", type: "text", categoryId: "srv-1-text", unreadCount: 9 },
                ],
              },
        {
          id: "srv-1-text",
          name: "Text Duplicate",
          channels: [
            { id: "c2", name: "ops", type: "text", categoryId: "srv-1-text" },
            { id: "c1", name: "general-cross-category", type: "text", categoryId: "srv-1-text" },
          ],
        },
      ],
      members: [],
          },
          {
            id: "srv-1",
            name: "Second Node",
            icon: "https://example.com/second.png",
            ownerId: "me",
            categories: [],
            members: [],
          },
          {
            id: "   ",
            name: { bad: true },
            icon: 42,
            ownerId: { bad: true },
            categories: { bad: true },
            members: { bad: true },
          } as never,
        ] as Server[]}
        activeServerId="home"
        connectionState={connectionState}
        onSelectServer={() => {}}
        onCreateServer={() => {}}
      />,
    );

    expect(screen.getAllByRole("button", { name: /space: first node/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /space: second node/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /space: unknown/i })).toBeNull();
    expect(screen.getByRole("button", { name: /space: first node/i })).toBeTruthy();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("11")).toBeNull();
  });
});
