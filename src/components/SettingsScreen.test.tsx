import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsScreen } from "./SettingsScreen";
import * as clipboardUtils from './contextMenuUtils';
import type { User } from "@/types";

const updatePresenceMutateAsync = vi.fn();
const registerRelayMutateAsync = vi.fn();
const removeRelayMutateAsync = vi.fn();

vi.mock("@/hooks/runtime/mutations", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/runtime/mutations")>("@/hooks/runtime/mutations");
  return {
    ...actual,
    useBackupIdentity: () => ({ mutateAsync: vi.fn() }),
    useUpdateProfile: () => ({ mutateAsync: vi.fn() }),
    useUpdatePresence: () => ({ mutateAsync: updatePresenceMutateAsync }),
    useRegisterRelay: () => ({ mutateAsync: registerRelayMutateAsync }),
    useRemoveRelay: () => ({ mutateAsync: removeRelayMutateAsync }),
  };
});

const user: User = {
  id: "neo",
  username: "Neo",
  avatar: "https://example.com/avatar.png",
  status: "online",
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("SettingsScreen About & Legal", () => {
  beforeEach(() => {
    updatePresenceMutateAsync.mockReset();
    registerRelayMutateAsync.mockReset();
    removeRelayMutateAsync.mockReset();
    updatePresenceMutateAsync.mockResolvedValue(undefined);
    registerRelayMutateAsync.mockResolvedValue(undefined);
    removeRelayMutateAsync.mockResolvedValue(undefined);
  });

  it("offers the source code under the default AGPL source URL", async () => {
    const u = userEvent.setup();
    render(<SettingsScreen user={user} onClose={() => {}} />);

    await u.click(screen.getByRole("button", { name: /about & legal/i }));

    const sourceLink = screen.getByRole("link", { name: /source code/i });
    expect(sourceLink.getAttribute("href")).toBe("https://github.com/cogniloom/harmolyn");
    expect(screen.getByText(/AGPL-3\.0-or-later/i)).toBeTruthy();
  });

  it("normalizes malformed persisted account profile fields", async () => {
    window.localStorage.setItem(
      "harmolyn:settings:profile:neo",
      JSON.stringify({
        displayName: { label: "broken" },
        identityLink: [],
        bio: null,
        avatarUrl: 123,
      }),
    );

    render(<SettingsScreen user={user} onClose={() => {}} />);

    expect(await screen.findAllByText("Neo")).toBeTruthy();
    expect(await screen.findByText("No status established.")).toBeTruthy();
  });

  it("edits the profile inline instead of through a blocking window.prompt", async () => {
    // The UX audit replaced the legacy prompt-based "Identity Link" row with an
    // inline profile editor. Opening Edit must reveal in-page form fields and
    // never call window.prompt, and the removed Identity Link row must stay gone.
    const promptSpy = vi.spyOn(window, "prompt");
    const u = userEvent.setup();
    render(<SettingsScreen user={user} onClose={() => {}} />);

    expect(screen.queryByText("Identity Link")).toBeNull();

    const displayNameRow = screen.getByText("Display Name").parentElement?.parentElement;
    expect(displayNameRow).toBeTruthy();
    await u.click(within(displayNameRow as HTMLElement).getByRole("button", { name: /^edit$/i }));

    const nameField = await screen.findByDisplayValue("Neo");
    expect(nameField).toBeTruthy();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("saves presence visibility through xorein", async () => {
    const u = userEvent.setup();
    render(<SettingsScreen user={user} onClose={() => {}} />);

    await u.click(screen.getByRole("button", { name: /privacy & safety/i }));
    await u.click(screen.getByRole("button", { name: /show presence/i }));

    expect(updatePresenceMutateAsync).toHaveBeenCalledWith({ status: "offline" });
    expect(await screen.findByText(/presence visibility is now hidden through xorein/i)).toBeTruthy();
  });

  it("normalizes malformed persisted notification settings", async () => {
    window.localStorage.setItem(
      "harmolyn:settings:notifications",
      JSON.stringify({
        globalLevel: { selected: "all" },
        desktopEnabled: "yes",
        soundEnabled: null,
        flashTaskbar: 1,
        suppressEveryone: "no",
        suppressRoles: [],
      }),
    );

    const u = userEvent.setup();
    render(<SettingsScreen user={user} onClose={() => {}} />);

    await u.click(screen.getByRole("button", { name: /notifications/i }));

    expect(screen.getByText(/mentions only/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /desktop notifications/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /notification sounds/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /flash taskbar/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /pending friend request badge/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("persists and announces pending friend-request badge changes", async () => {
    const u = userEvent.setup();
    const preferenceEvents: boolean[] = [];
    const onPreferenceChange = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: unknown }>).detail;
      preferenceEvents.push(detail?.enabled === true);
    };
    window.addEventListener("harmolyn:friend-request-badge-preference", onPreferenceChange);

    try {
      render(<SettingsScreen user={user} onClose={() => {}} />);
      await u.click(screen.getByRole("button", { name: /notifications/i }));
      await u.click(screen.getByRole("button", { name: /pending friend request badge/i }));

      expect(screen.getByRole("button", { name: /pending friend request badge/i })).toHaveAttribute("aria-pressed", "false");
      expect(JSON.parse(window.localStorage.getItem("harmolyn:settings:notifications") ?? "{}")).toMatchObject({
        friendRequestBadgeEnabled: false,
      });
      expect(preferenceEvents).toEqual([false]);
    } finally {
      window.removeEventListener("harmolyn:friend-request-badge-preference", onPreferenceChange);
    }
  });

  it("keeps avatar editing local-only so profile data cannot trigger remote fetches", async () => {
    const u = userEvent.setup();
    render(<SettingsScreen user={user} onClose={() => {}} />);

    await u.click(screen.getByRole("button", { name: /change avatar image/i }));

    expect(screen.queryByPlaceholderText(/paste an https/i)).toBeNull();
    expect(screen.getByText(/kept as local encrypted profile data/i)).toBeTruthy();
  });

  it("opens the avatar editor without touching window.prompt", async () => {
    // The inline editor must never fall back to window.prompt, so even a broken
    // prompt implementation cannot block editing or surface an error.
    const promptSpy = vi.spyOn(window, "prompt").mockImplementation(() => {
      throw new Error("blocked");
    });
    const u = userEvent.setup();
    render(<SettingsScreen user={user} onClose={() => {}} />);

    await u.click(screen.getByRole("button", { name: /change avatar image/i }));

    expect(screen.getByRole("button", { name: /choose image from your device/i })).toBeTruthy();
    expect(screen.queryByPlaceholderText(/paste an https/i)).toBeNull();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables the identity-backup copy control when clipboard access is unavailable", async () => {
    // When the browser blocks clipboard writes, the Copy control must stay
    // visible-but-disabled (with an explanatory title) rather than disappearing,
    // so the unavailable state is honest instead of a silent no-op.
    vi.spyOn(clipboardUtils, 'canCopyTextToClipboardSafely').mockReturnValue(false);

    render(<SettingsScreen user={user} initialSection="recovery" onClose={() => {}} />);

    const copyButton = screen.getByRole("button", { name: /^copy$/i });
    expect(copyButton).toBeDisabled();
    expect(copyButton).toHaveAttribute("title", expect.stringMatching(/clipboard access is unavailable/i));
  });

  it("clears stored control tokens even when browser storage is blocked", async () => {
    const storageError = new DOMException("Blocked", "SecurityError");
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
      throw storageError;
    });
    vi.spyOn(window.sessionStorage, "removeItem").mockImplementation(() => {
      throw storageError;
    });

    const onLogOut = vi.fn();
    const u = userEvent.setup();
    render(<SettingsScreen user={user} onClose={() => {}} onLogOut={onLogOut} />);

    await u.click(screen.getByRole("button", { name: /authorized hubs/i }));

    // Log out now requires confirmation: the sidebar button opens an
    // alertdialog, and the dialog's confirm button performs the logout.
    await u.click(screen.getByRole("button", { name: /^log out$/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(onLogOut).not.toHaveBeenCalled();
    await u.click(within(dialog).getByRole("button", { name: /log out/i }));

    expect(onLogOut).toHaveBeenCalledTimes(1);
  });

  it("manages relays through xorein from the network section", async () => {
    const u = userEvent.setup();
    render(
      <SettingsScreen
        user={user}
        onClose={() => {}}
        runtimeSnapshot={{ relay_addrs: ["/ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay"] }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /network/i }));
    const relayInput = await screen.findByLabelText(/relay multiaddr/i);
    await u.type(relayInput, "/ip4/127.0.0.1/tcp/4002/p2p/12D3KooRelayTwo");
    await u.click(screen.getByRole("button", { name: /add relay/i }));

    expect(registerRelayMutateAsync).toHaveBeenCalledWith({ multiaddr: "/ip4/127.0.0.1/tcp/4002/p2p/12D3KooRelayTwo" });

    await u.click(screen.getByRole("button", { name: /remove/i }));
    expect(removeRelayMutateAsync).toHaveBeenCalledWith({ multiaddr: "/ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay" });
  });

  it("normalizes malformed relay address lists before rendering", async () => {
    const u = userEvent.setup();
    render(
      <SettingsScreen
        user={user}
        onClose={() => {}}
        runtimeSnapshot={{ relay_addrs: ["/ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay", { bad: true } as never, "   "] as never }}
      />,
    );

    await u.click(screen.getByRole("button", { name: /network/i }));

    expect(screen.getByText("/ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay")).toBeTruthy();
    expect(screen.queryByText("[object Object]")).toBeNull();
  });

  it("dedupes relay addresses before rendering the network list", async () => {
    const u = userEvent.setup();
    render(
      <SettingsScreen
        user={user}
        onClose={() => {}}
        runtimeSnapshot={{ relay_addrs: ["/ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay", " /ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay ", "/ip4/127.0.0.1/tcp/4002/p2p/12D3KooRelayTwo"] }}
      />,
    );

    await u.click(screen.getByRole("button", { name: /network/i }));

    expect(screen.getAllByText("/ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay").length).toBe(1);
    expect(screen.getByText("/ip4/127.0.0.1/tcp/4002/p2p/12D3KooRelayTwo")).toBeTruthy();
  });
});
