import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readShellRuntimeData } from "@/data";
import { ChatArea } from "./ChatArea";
import { buildForwardDestinations } from "./chatForwarding";
import type { Channel, User, Message } from "@/types";

vi.mock("@/hooks/useFeature", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useFeature")>("@/hooks/useFeature");
  return {
    ...actual,
    useFeature: (feature: Parameters<typeof actual.useFeature>[0]) => feature === "mentionAutocomplete" || feature === "messageForwarding" || feature === "fileUploads" ? true : actual.useFeature(feature),
  };
});

const channel: Channel = { id: "ch-1", name: "general", type: "text", categoryId: "cat-1" };

function renderChatArea(securityMode?: string, messages: Message[] = []) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
    <ChatArea
      channel={channel}
      messages={messages}
      users={[]}
      mobileMenuOpen={false}
      onToggleMobileMenu={() => {}}
      onToggleMemberList={() => {}}
      isDM={false}
      messageLayout="modern"
      onToggleLayout={() => {}}
      bgSeed="seed"
      setBgSeed={() => {}}
      securityMode={securityMode}
      hasIdentity
    />
    </QueryClientProvider>,
  );
}

describe("ChatArea", () => {
  it("renders the negotiated security mode in the header", () => {
    renderChatArea("seal");
    expect(screen.getByText(/SEAL \/\/ 1:1 E2EE/i)).toBeTruthy();
  });

  it("treats unstamped legacy messages as insecure in the native-path badge", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_NATIVE_ACTIVE__ = true;
    try {
      const legacy: Message = { id: "m-legacy", userId: "u1", content: "old message", timestamp: "2026-01-01T00:00:00Z" };
      renderChatArea(undefined, [legacy]);
      // No provenance recorded → the badge must NOT claim E2EE; it downgrades to the
      // insecure "clear" state rather than showing Crowd for a channel.
      expect(screen.getByText(/UNENCRYPTED \/\/ DO NOT TRUST/i)).toBeTruthy();
    } finally {
      delete (window as unknown as Record<string, unknown>).__HARMOLYN_NATIVE_ACTIVE__;
    }
  });

  it("keeps the E2EE badge when every message is provenance-stamped (native path)", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_NATIVE_ACTIVE__ = true;
    try {
      const stamped: Message = { id: "m1", userId: "u1", content: "hi", timestamp: "2026-01-01T00:00:00Z", securityMode: "crowd", encrypted: true };
      renderChatArea(undefined, [stamped]);
      expect(screen.getByText(/CROWD \/\/ CHANNEL E2EE/i)).toBeTruthy();
      expect(screen.queryByText(/UNENCRYPTED \/\/ DO NOT TRUST/i)).toBeNull();
    } finally {
      delete (window as unknown as Record<string, unknown>).__HARMOLYN_NATIVE_ACTIVE__;
    }
  });

  it("does not show the removed channel follow control", () => {
    renderChatArea();

    expect(screen.queryByRole("button", { name: /^follow channel$/i })).toBeNull();
  });

  it("does not persist attachment placeholder messages", async () => {
    const user = userEvent.setup();
    renderChatArea();

    const file = new File(["payload"], "secret.txt", { type: "text/plain" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);

    const stored = JSON.parse(window.localStorage.getItem("harmolyn:xorein:chat-scope:ch-1") ?? "{}");
    expect(stored.messages ?? []).toEqual([]);
    expect(screen.getAllByText(/attachments are disabled/i).length).toBeGreaterThan(0);
  });

  it("does not persist unsupported slash command messages", async () => {
    const user = userEvent.setup();
    renderChatArea();

    await user.type(screen.getByLabelText("Message Input"), "/ghost waves{enter}");

    const stored = JSON.parse(window.localStorage.getItem("harmolyn:xorein:chat-scope:ch-1") ?? "{}");
    expect(stored.messages ?? []).toEqual([]);
    expect(screen.getAllByText(/unknown command\. available commands: \/nick, \/clear\./i).length).toBeGreaterThan(0);
  });

  it("hides runtime-only profile actions in the user popover", async () => {
    const user = userEvent.setup();
    const author: User = { id: "u2", username: "nova", avatar: "/avatar.png", status: "online", bio: "hi there" };
    const messages: Message[] = [{ id: "m1", userId: "u2", content: "hey", timestamp: "12:00" }];
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ChatArea
          channel={channel}
          messages={messages}
          users={[author]}
          mobileMenuOpen={false}
          onToggleMobileMenu={() => {}}
          onToggleMemberList={() => {}}
          isDM={false}
          messageLayout="modern"
          onToggleLayout={() => {}}
          bgSeed="seed"
          setBgSeed={() => {}}
        />
      </QueryClientProvider>,
    );

    await user.hover(screen.getByAltText("nova"));

    // The popover is open (the bio block only renders inside it) ...
    expect(screen.getByText("BIO // DECRYPTED")).toBeTruthy();
    // ... but the dead "not exposed by the runtime" actions are gone.
    expect(screen.queryByRole("button", { name: /direct link/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /more options/i })).toBeNull();
  });

  it("normalizes malformed user records before rendering messages", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatArea
          channel={channel}
          messages={[{ id: "m1", userId: "u2", content: "hello", timestamp: "12:00" }]}
          users={[{
            id: "u2",
            username: { broken: true } as unknown as string,
            avatar: { href: "https://example.com/avatar.png" } as unknown as string,
            status: "online",
            bio: { text: "broken" } as unknown as string,
          } as User]}
          mobileMenuOpen={false}
          onToggleMobileMenu={() => {}}
          onToggleMemberList={() => {}}
          isDM={false}
          messageLayout="modern"
          onToggleLayout={() => {}}
          bgSeed="seed"
          setBgSeed={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("u2")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("renders unknown senders with an explicit placeholder instead of borrowing the first user", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatArea
          channel={channel}
          messages={[{ id: "m-unknown", userId: "missing", content: "mystery sender", timestamp: "12:00" }]}
          users={[{ id: "u2", username: "nova", avatar: "/avatar.png", status: "online" } as User]}
          mobileMenuOpen={false}
          onToggleMobileMenu={() => {}}
          onToggleMemberList={() => {}}
          isDM={false}
          messageLayout="modern"
          onToggleLayout={() => {}}
          bgSeed="seed"
          setBgSeed={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Unknown User")).toBeTruthy();
    expect(screen.getByText("mystery sender")).toBeTruthy();
  });

  it("dedupes duplicate users before mention autocomplete renders suggestions", async () => {
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatArea
          channel={channel}
          messages={[]}
          users={[
            { id: "peer-dup", username: "duplicate", avatar: "", status: "online" } as User,
            { id: "peer-dup", username: "duplicate-shadow", avatar: "", status: "idle" } as User,
          ]}
          mobileMenuOpen={false}
          onToggleMobileMenu={() => {}}
          onToggleMemberList={() => {}}
          isDM={false}
          messageLayout="modern"
          onToggleLayout={() => {}}
          bgSeed="seed"
          setBgSeed={() => {}}
          hasIdentity
        />
      </QueryClientProvider>,
    );

    await user.type(screen.getByLabelText("Message Input"), "@dup");

    expect(screen.getAllByRole("option", { name: /duplicate/i }).length).toBe(1);
    expect(screen.getByText("MEMBERS — 1")).toBeTruthy();
  });

  it("builds an unknown direct-message destination when the DM owner is missing", () => {
    const actual = {
      ...readShellRuntimeData(),
      directMessages: [
        { id: "dm-missing", userId: "missing-peer", lastMessage: "mystery dm" },
      ],
    };

    const destinations = buildForwardDestinations(actual, [
      { id: "u2", username: "nova", avatar: "/avatar.png", status: "online" } as User,
    ]);

    expect(destinations.find((destination) => destination.id === "dm-missing")).toEqual({
      id: "dm-missing",
      label: "Unknown User",
      sublabel: "Direct Message",
      type: "dm",
    });
  });

  it("keeps the first normalized message when duplicate ids are present", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatArea
          channel={channel}
          messages={[
            { id: "m-dup", userId: "u2", content: "first duplicate message", timestamp: "12:00" },
            { id: "m-dup", userId: "u2", content: "second duplicate message", timestamp: "12:01" },
          ]}
          users={[
            { id: "u2", username: "nova", avatar: "/avatar.png", status: "online" } as User,
          ]}
          mobileMenuOpen={false}
          onToggleMobileMenu={() => {}}
          onToggleMemberList={() => {}}
          isDM={false}
          messageLayout="modern"
          onToggleLayout={() => {}}
          bgSeed="seed"
          setBgSeed={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("first duplicate message")).toBeTruthy();
    expect(screen.queryByText("second duplicate message")).toBeNull();
    consoleErrorSpy.mockRestore();
  });

  it("disables the send button while the composer is empty and enables it once there is content", async () => {
    const user = userEvent.setup();
    renderChatArea();

    const send = screen.getByRole("button", { name: /send message/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    await user.type(screen.getByLabelText("Message Input"), "hello");
    expect(send.disabled).toBe(false);
  });

  it("treats whitespace-only drafts as empty for the send button", async () => {
    const user = userEvent.setup();
    renderChatArea();

    const send = screen.getByRole("button", { name: /send message/i }) as HTMLButtonElement;
    await user.type(screen.getByLabelText("Message Input"), "   ");
    expect(send.disabled).toBe(true);
  });

  it("inserts a newline on Shift+Enter without sending the message", async () => {
    const user = userEvent.setup();
    renderChatArea();

    const composer = screen.getByLabelText("Message Input") as HTMLTextAreaElement;
    await user.type(composer, "line one{Shift>}{Enter}{/Shift}line two");

    expect(composer.value).toBe("line one\nline two");
  });

  it("opens a security-mode summary dialog when the header badge is clicked", async () => {
    const user = userEvent.setup();
    renderChatArea("seal");

    await user.click(screen.getByRole("button", { name: /SEAL \/\/ 1:1 E2EE/i }));
    expect(screen.getByRole("dialog", { name: /security mode/i })).toBeTruthy();
  });

});
