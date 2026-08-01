// Regression tests for the messaging defects found by the two-client E2E
// (scenario-03): stale persisted-scope copies shadowing remote updates, dropped
// reply references, mount-frozen poll state, raw poll payload leaking as text,
// unreachable advanced search, and missing delete tombstones on receivers.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ChatArea } from "./ChatArea";
import type { Channel, Message } from "@/types";
import { injectRuntimeSnapshot } from "@/test/runtimeHarness";
import { createHappyRuntime } from "@/test/fixtures";
import {
  configureChatScopePersistence,
  writePersistedChatScopeState,
} from "@/protocol/client";

const mutationStub = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})), isPending: false });
const sendChannelMock = vi.hoisted(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})), isPending: false }));
const castPollVoteMock = vi.hoisted(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})), isPending: false }));

vi.mock("@/hooks/runtime/mutations", () => ({
  useSendChannelMessage: () => sendChannelMock,
  useSendDmMessage: () => mutationStub(),
  useEditMessage: () => mutationStub(),
  useDeleteMessage: () => mutationStub(),
  useAddReaction: () => mutationStub(),
  useRemoveReaction: () => mutationStub(),
  usePinMessage: () => mutationStub(),
  useUnpinMessage: () => mutationStub(),
  useCastPollVote: () => castPollVoteMock,
  useLoadOlderHistory: () => mutationStub(),
  useSetPeerVerified: () => mutationStub(),
  useSubmitReport: () => mutationStub(),
}));

// ChatArea and SearchPanel reach the runtime through the mutation facade — stub
// it so both can render without a live engine.
//
// IMPORTANT: the stubs MUST be referentially stable across renders. SearchPanel
// keys an effect on `searchMessages`, and that effect unconditionally calls
// setResults({...}) (a fresh object). A per-render `vi.fn()` gives the effect a
// new dependency every render → effect re-runs → new state object → re-render →
// … an infinite render/effect loop that never yields, hanging the vitest worker
// (this is exactly the 372s fork-timeout the advanced-search tests used to hit).
const facadeMocks = vi.hoisted(() => ({
  searchMessages: vi.fn(async () => ({ messages: [], results: [] })),
  searchNotifications: vi.fn(async () => []),
  markNotificationsRead: vi.fn(async () => ({ scope_id: "ch-1", scope_type: "channel", read_through_message_id: "" })),
}));
vi.mock("@/hooks/runtime/useRuntimeMutations", () => ({
  useRuntimeMutations: () => facadeMocks,
}));

const channel: Channel = { id: "ch-1", name: "general", type: "text", categoryId: "cat-1" };
const TEST_CHAT_SCOPE_KEY = new Uint8Array(32).fill(0x5a);
const TEST_CHAT_SCOPE_NAMESPACE = "peer-test";

function seedPersistedScope(messages: Message[], deletedMessageIds: string[] = []) {
  configureChatScopePersistence({ key: TEST_CHAT_SCOPE_KEY, namespace: TEST_CHAT_SCOPE_NAMESPACE });
  writePersistedChatScopeState(channel.id, {
    version: 1,
    nickname: "",
    mutedUserIds: [],
    inboxReadIds: [],
    deletedMessageIds,
    messages,
    threads: {},
  });
}

function renderChat(messages: Message[]) {
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatArea
        channel={channel}
        messages={messages}
        users={[{ id: "u2", username: "nova", avatar: "", status: "online" }, { id: "me", username: "self", avatar: "", status: "online" }]}
        mobileMenuOpen={false}
        onToggleMobileMenu={() => {}}
        onToggleMemberList={() => {}}
        isDM={false}
        messageLayout="modern"
        onToggleLayout={() => {}}
        hasIdentity
      />
    </QueryClientProvider>,
  );
  const rerender = (nextMessages: Message[]) => view.rerender(
    <QueryClientProvider client={queryClient}>
      <ChatArea
        channel={channel}
        messages={nextMessages}
        users={[{ id: "u2", username: "nova", avatar: "", status: "online" }, { id: "me", username: "self", avatar: "", status: "online" }]}
        mobileMenuOpen={false}
        onToggleMobileMenu={() => {}}
        onToggleMemberList={() => {}}
        isDM={false}
        messageLayout="modern"
        onToggleLayout={() => {}}
        hasIdentity
      />
    </QueryClientProvider>,
  );
  return { ...view, rerenderMessages: rerender };
}

beforeEach(() => {
  configureChatScopePersistence({ key: TEST_CHAT_SCOPE_KEY, namespace: TEST_CHAT_SCOPE_NAMESPACE });
  window.localStorage.clear();
  window.sessionStorage.clear();
  sendChannelMock.mutate.mockClear();
  sendChannelMock.mutateAsync.mockClear();
  castPollVoteMock.mutate.mockClear();
  facadeMocks.searchMessages.mockClear();
  facadeMocks.searchNotifications.mockClear();
  facadeMocks.markNotificationsRead.mockClear();
});

afterEach(() => {
  configureChatScopePersistence(null);
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete (window as unknown as Record<string, unknown>).__HARMOLYN_NATIVE_ACTIVE__;
});

describe("ChatArea persisted-scope merge (live runtime data wins)", () => {
  it("renders a REMOTE reaction count increase even when a stale persisted copy exists", () => {
    seedPersistedScope([
      { id: "m-net-1", userId: "u2", content: "hello world", timestamp: "12:00", reactions: [{ emoji: "👍", count: 1, reacted: true }] },
    ]);

    renderChat([
      { id: "m-net-1", userId: "u2", content: "hello world", timestamp: "12:00", reactions: [{ emoji: "👍", count: 2, reacted: true }] },
    ]);

    expect(screen.getByRole("button", { name: /👍\s*2/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /👍\s*1$/ })).toBeNull();
  });

  it("renders a REMOTE edit even when a stale persisted copy exists", () => {
    seedPersistedScope([
      { id: "m-net-1", userId: "u2", content: "original text", timestamp: "12:00" },
    ]);

    renderChat([
      { id: "m-net-1", userId: "u2", content: "edited text v2", timestamp: "12:00", editedAt: "12:05" },
    ]);

    expect(screen.getByText("edited text v2")).toBeTruthy();
    expect(screen.queryByText("original text")).toBeNull();
    expect(screen.getByText("(edited)")).toBeTruthy();
  });

  it("renders a REMOTE pin even when a stale persisted copy exists", () => {
    seedPersistedScope([
      { id: "m-net-1", userId: "u2", content: "pin me later", timestamp: "12:00", pinned: false },
    ]);

    renderChat([
      { id: "m-net-1", userId: "u2", content: "pin me later", timestamp: "12:00", pinned: true },
    ]);

    // The header pin button badge counts pinned messages from the MERGED state:
    // the remote pinned:true must win over the stale persisted pinned:false.
    const pinButton = screen.getByRole("button", { name: "Pinned Messages" });
    expect(pinButton.textContent).toContain("1");

    // And the pinned drawer must actually list the message (not the empty state).
    fireEvent.click(pinButton);
    expect(screen.getByText(/ARCHIVE \/\/ 1 ENTRIES/)).toBeTruthy();
    expect(screen.queryByText("No Pinned Messages")).toBeNull();
    // Message list + drawer entry — the drawer renders a second copy.
    expect(screen.getAllByText("pin me later").length).toBeGreaterThanOrEqual(2);
  });

  it("shows a tombstone when a message VANISHES from the live runtime view (remote delete)", () => {
    const survivor: Message = { id: "m-net-2", userId: "u2", content: "survivor message", timestamp: "12:01" };
    const { rerenderMessages } = renderChat([
      { id: "m-net-1", userId: "u2", content: "doomed message", timestamp: "12:00" },
      survivor,
    ]);
    expect(screen.getByText("doomed message")).toBeTruthy();

    rerenderMessages([survivor]);

    expect(screen.queryByText("doomed message")).toBeNull();
    expect(screen.getByText(/Message deleted/)).toBeTruthy();
    expect(screen.getByText("survivor message")).toBeTruthy();
  });

  it("keeps persisted offline history that is missing from the live snapshot", () => {
    seedPersistedScope([
      { id: "m-history-1", userId: "u2", content: "old offline history entry", timestamp: "11:00" },
      { id: "local-msg-abc", userId: "me", content: "locally composed note", timestamp: "11:30" },
    ]);

    renderChat([
      { id: "m-net-1", userId: "u2", content: "live message", timestamp: "12:00" },
    ]);

    expect(screen.getByText("old offline history entry")).toBeTruthy();
    expect(screen.getByText("locally composed note")).toBeTruthy();
    expect(screen.getByText("live message")).toBeTruthy();
  });

  it("keeps the local delete tombstone for ids recorded in deletedMessageIds", () => {
    seedPersistedScope(
      [{ id: "m-net-1", userId: "u2", content: "locally deleted", timestamp: "12:00", deletedAt: "2026-07-28T10:00:00Z" }],
      ["m-net-1"],
    );

    renderChat([]);

    expect(screen.queryByText("locally deleted")).toBeNull();
    expect(screen.getByText(/Message deleted/)).toBeTruthy();
  });
});

describe("ChatArea reply references", () => {
  it("passes replyTo on the online channel send path", async () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_NATIVE_ACTIVE__ = true;
    const user = userEvent.setup();
    renderChat([
      { id: "m-net-1", userId: "u2", content: "reply target message", timestamp: "12:00", securityMode: "crowd", encrypted: true },
    ]);

    // Open the hover action bar for the message row.
    await user.hover(screen.getByText("reply target message"));

    // Click "Reply" with fireEvent, NOT user.click: user-event v14 dispatches the
    // preceding `mouseout` with relatedTarget:null (its mouse system never sets
    // relatedTarget), which React's enter/leave plugin reads as "pointer left the
    // window" and fires onMouseLeave on EVERY ancestor — including the message
    // row. That unmounts the hover bar mid-click, so the click lands on a
    // detached node and never reaches React. Real browsers set relatedTarget to
    // the button (still inside the row), so no leave fires — the E2E covers that.
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    // The composer must show the reply preview bar before sending.
    expect(screen.getByText(/REPLYING TO \/\/ NOVA/)).toBeTruthy();

    await user.type(screen.getByLabelText("Message Input"), "the actual reply{enter}");

    expect(sendChannelMock.mutateAsync).toHaveBeenCalledWith({
      channelId: "ch-1",
      content: "the actual reply",
      replyTo: "m-net-1",
    });
  });
});

describe("ChatArea polls", () => {
  const pollBody = `🗳️ POLL:${JSON.stringify({ q: "Tabs or spaces?", o: ["Tabs", "Spaces"] })}`;

  it("hides the encoded poll payload and renders vote counts from live poll_votes", () => {
    renderChat([
      { id: "m-poll", userId: "u2", content: pollBody, timestamp: "12:00", poll_votes: { 0: ["peer-bob"] } },
    ]);

    expect(screen.getByText("Tabs or spaces?")).toBeTruthy();
    // The raw payload must not render as message text.
    expect(screen.queryByText(/POLL:\{/)).toBeNull();
    expect(screen.getByText(/1 VOTE \/\/ TAP TO VOTE/)).toBeTruthy();
  });

  it("updates the rendered vote count when a REMOTE vote arrives (no remount)", () => {
    const { rerenderMessages } = renderChat([
      { id: "m-poll", userId: "u2", content: pollBody, timestamp: "12:00" },
    ]);
    expect(screen.getByText(/0 VOTES \/\/ TAP TO VOTE/)).toBeTruthy();

    rerenderMessages([
      { id: "m-poll", userId: "u2", content: pollBody, timestamp: "12:00", poll_votes: { 0: ["peer-bob"] } },
    ]);

    expect(screen.getByText(/1 VOTE \/\/ TAP TO VOTE/)).toBeTruthy();
  });

  it("derives the local user's own vote from poll_votes and the local peer id", () => {
    injectRuntimeSnapshot(createHappyRuntime()); // identity peer_id = "peer-local"

    renderChat([
      { id: "m-poll", userId: "u2", content: pollBody, timestamp: "12:00", poll_votes: { 1: ["peer-local"], 0: ["peer-bob"] } },
    ]);

    expect(screen.getByText(/2 VOTES \/\/ VOTED/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Tabs/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Spaces/ })).toBeDisabled();
  });

  it("casts a vote through the mutation facade when an option is clicked", async () => {
    const user = userEvent.setup();
    renderChat([
      { id: "m-poll", userId: "u2", content: pollBody, timestamp: "12:00" },
    ]);

    await user.click(screen.getByRole("button", { name: "Spaces" }));

    expect(castPollVoteMock.mutate).toHaveBeenCalledWith({ messageId: "m-poll", optionIndex: 1 });
    // Optimistic overlay until the snapshot reflects the vote.
    expect(screen.getByText(/1 VOTE \/\/ VOTED/)).toBeTruthy();
  });
});

describe("ChatArea advanced search reachability", () => {
  it("opens the SearchPanel from the header Advanced search button", async () => {
    const user = userEvent.setup();
    renderChat([]);

    await user.click(screen.getByRole("button", { name: "Advanced search" }));

    expect(screen.getByRole("dialog", { name: "Search messages" })).toBeTruthy();
  });

  it("toggles the SearchPanel with Ctrl+F (documented shortcut)", () => {
    renderChat([]);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Search messages" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "Search messages" })).toBeNull();
  });
});
