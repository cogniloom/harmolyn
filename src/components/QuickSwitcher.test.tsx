import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuickSwitcher } from "./QuickSwitcher";

vi.mock("@/data", () => ({
  SERVERS: [
    {
      id: "srv-1",
      name: "Alpha",
      categories: [
        {
          id: "cat-1",
          name: "general",
          channels: [
            { id: "chan-1", name: "chat", type: "text", categoryId: "cat-1" },
            { id: "chan-1", name: "duplicate chat", type: "text", categoryId: "cat-1" },
          ],
        },
      ],
    },
  ],
  DIRECT_MESSAGES: [
    { id: "dm-1", userId: "peer-remote" },
    { id: "dm-1", userId: "peer-shadow" },
    { id: "dm-missing", userId: "peer-missing" },
  ],
  USERS: [
    {
      id: "peer-remote",
      username: "Alpha DM",
      avatar: 123,
      status: "online",
    },
    {
      id: "peer-remote",
      username: "Beta DM",
      avatar: "/beta.png",
      status: "offline",
    },
    {
      id: "peer-shadow",
      username: "Shadow",
      avatar: "/shadow.png",
      status: "online",
    },
  ],
}));

describe("QuickSwitcher", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps the first normalized direct-message user when duplicate ids are present", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(<QuickSwitcher onClose={vi.fn()} onNavigate={onNavigate} />);

    expect(await screen.findByText("Alpha DM")).toBeTruthy();
    await user.click(screen.getByText("Alpha DM"));
    expect(onNavigate).toHaveBeenCalledWith("home", "dm-1");
  });

  it("keeps only the first result when duplicate ids are present", async () => {
    render(<QuickSwitcher onClose={vi.fn()} onNavigate={vi.fn()} />);

    expect(await screen.findByText("Alpha DM")).toBeTruthy();
    expect(screen.queryByText("Beta DM")).toBeNull();
    expect(screen.queryByText("Shadow")).toBeNull();
    expect(screen.queryByText("duplicate chat")).toBeNull();
    expect(screen.getByText("chat")).toBeTruthy();
  });

  it("renders unknown direct-message entries with an explicit placeholder label", () => {
    render(<QuickSwitcher onClose={vi.fn()} onNavigate={vi.fn()} />);

    expect(screen.getByText("Unknown User")).toBeTruthy();
    expect(screen.queryByText("peer-missing")).toBeNull();
  });

  it("fuzzy-matches non-contiguous query characters", async () => {
    const user = userEvent.setup();
    render(<QuickSwitcher onClose={vi.fn()} onNavigate={vi.fn()} />);

    // "ct" is a subsequence of "chat" but not a substring — only fuzzy matching finds it.
    await user.type(screen.getByPlaceholderText(/JUMP TO/i), "ct");
    expect(await screen.findByText("chat")).toBeTruthy();
  });

  it("records the chosen channel as recent for the next session", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<QuickSwitcher onClose={vi.fn()} onNavigate={onNavigate} />);

    await user.click(await screen.findByText("chat"));
    expect(onNavigate).toHaveBeenCalledWith("srv-1", "chan-1");

    const stored = JSON.parse(window.localStorage.getItem("harmolyn-recent-switches") || "[]");
    expect(stored[0]).toBe("chan-1");
  });
});
