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
    await user.type(screen.getByRole("combobox", { name: /Search channels/ }), "ct");
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

describe('QuickSwitcher keyboard navigation', () => {
  it('links a combobox to the selected result and clears selection when empty', async () => {
    const user = userEvent.setup();
    render(<QuickSwitcher onClose={vi.fn()} onNavigate={vi.fn()} />);
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('aria-controls', 'quick-switcher-results');
    expect(input).toHaveAttribute('aria-activedescendant', 'quick-switcher-option-0');
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', 'quick-switcher-option-1');
    await user.type(input, 'zzzzzzzzzz');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByText('No matching conversations')).toBeInTheDocument();
    await user.clear(input);
    expect(input).toHaveAttribute('aria-activedescendant', 'quick-switcher-option-0');
  });
  it('does not navigate when Enter confirms composition', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const navigate = vi.fn();
    render(<QuickSwitcher onClose={vi.fn()} onNavigate={navigate} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', keyCode: 229 });
    expect(navigate).not.toHaveBeenCalled();
  });
  it('closes once for Escape, not once per registered handler', async () => {
    const user = userEvent.setup(); const close = vi.fn();
    render(<QuickSwitcher onClose={close} onNavigate={vi.fn()} />);
    await user.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('ignores oversized persisted recency values', () => {
    window.localStorage.setItem('harmolyn-recent-switches', '[' + ' '.repeat(10000) + ']');
    render(<QuickSwitcher onClose={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });
});

it('updates destinations from the live shell rather than only the module-load snapshot', () => {
  const makeSpace = (name: string) => [{ id: 'live-space', name: 'Space', icon: '', ownerId: 'me', members: [],
    categories: [{ id: 'cat', name: 'Channels', channels: [{ id: 'new', name, type: 'text' as const, categoryId: 'cat' }] }] }];
  const props = { users: [], directMessages: [], onClose: vi.fn(), onNavigate: vi.fn() };
  const mounted = render(<QuickSwitcher {...props} servers={makeSpace('new-channel')} />);
  expect(screen.getByText('new-channel')).toBeInTheDocument();
  mounted.rerender(<QuickSwitcher {...props} servers={makeSpace('renamed-channel')} />);
  expect(screen.queryByText('new-channel')).toBeNull();
  expect(screen.getByText('renamed-channel')).toBeInTheDocument();
});
