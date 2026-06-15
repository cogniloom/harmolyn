import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerSettingsScreen } from "./ServerSettingsScreen";
import * as clipboardUtils from './contextMenuUtils';
import type { Server } from "@/types";

const createChannelMutateAsync = vi.fn();
const updateChannelMutateAsync = vi.fn();
const deleteChannelMutateAsync = vi.fn();
const createRoleMutateAsync = vi.fn();
const updateRoleMutateAsync = vi.fn();
const deleteRoleMutateAsync = vi.fn();
const assignRoleMutateAsync = vi.fn();
const moderationMutateAsync = vi.fn();

// Owner-authoritative server mutations live on the runtime-mutations facade.
const removeMember = vi.fn();
const deleteServer = vi.fn();
const updateServerMeta = vi.fn();
const rotateInvite = vi.fn();
const revokeInvite = vi.fn();

vi.mock("@/hooks/runtime/mutations", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/runtime/mutations")>("@/hooks/runtime/mutations");
  return {
    ...actual,
    useCreateChannel: () => ({ mutateAsync: createChannelMutateAsync }),
    useUpdateChannel: () => ({ mutateAsync: updateChannelMutateAsync }),
    useDeleteChannel: () => ({ mutateAsync: deleteChannelMutateAsync }),
    useCreateRole: () => ({ mutateAsync: createRoleMutateAsync }),
    useUpdateRole: () => ({ mutateAsync: updateRoleMutateAsync }),
    useDeleteRole: () => ({ mutateAsync: deleteRoleMutateAsync }),
    useAssignRole: () => ({ mutateAsync: assignRoleMutateAsync }),
    useModerationAction: () => ({ mutateAsync: moderationMutateAsync }),
    useAuditLog: () => ({ data: [], refetch: vi.fn() }),
    useAutoModRules: () => ({ data: [], refetch: vi.fn() }),
    useCreateAutoModRule: () => ({ mutateAsync: vi.fn() }),
    useUpdateAutoModRule: () => ({ mutateAsync: vi.fn() }),
    useDeleteAutoModRule: () => ({ mutateAsync: vi.fn() }),
    useBots: () => ({ data: [], refetch: vi.fn() }),
    useCreateBot: () => ({ mutateAsync: vi.fn().mockResolvedValue({ id: 'b1', name: 'TestBot', token: 'tok', created_at: '' }) }),
    useDeleteBot: () => ({ mutateAsync: vi.fn() }),
  };
});

vi.mock("@/hooks/runtime/useRuntimeMutations", () => ({
  useRuntimeMutations: () => ({ removeMember, deleteServer, updateServerMeta, rotateInvite, revokeInvite }),
}));

// Mock the runtime snapshot so the local identity OWNS srv-1 (owner_peer_id ===
// our peer id). isOwner gating then exposes the owner-only management controls,
// and the invite secret yields a real shareable deeplink.
vi.mock("@/lib/xoreinRuntimeContext", async () => {
  const actual = await vi.importActual<typeof import("@/lib/xoreinRuntimeContext")>("@/lib/xoreinRuntimeContext");
  return {
    ...actual,
    useRuntimeSnapshot: () => ({
      identity: { peer_id: "owner1" },
      servers: [{
        id: "srv-1", owner_peer_id: "owner1", invite_secret: "sek", name: "Test Server",
        roles: [
          { id: "role-mod", name: "Moderator", color: "#ff0000", permissions: ["kick"], protected: false },
          { id: "role-admin", name: "Admin", color: "#FF2A6D", permissions: ["*"], protected: true },
        ],
      }],
    }),
  };
});

function makeServer(): Server {
  return {
    id: "srv-1",
    name: "Test Server",
    icon: "",
    ownerId: "me",
    categories: [
      {
        id: "srv-1-text",
        name: "TEXT",
        channels: [{ id: "c1", name: "general", type: "text", categoryId: "srv-1-text" }],
      },
    ],
    members: [
      { id: "me", username: "me", avatar: "/me.png", status: "online", role: "Admin" },
      { id: "u2", username: "nova", avatar: "/nova.png", status: "online", role: "Member" },
    ],
  };
}

describe("ServerSettingsScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    createChannelMutateAsync.mockResolvedValue({ id: "c2", server_id: "srv-1", name: "new-2", voice: false });
    updateChannelMutateAsync.mockResolvedValue(undefined);
    deleteChannelMutateAsync.mockResolvedValue(undefined);
    createRoleMutateAsync.mockResolvedValue(undefined);
    updateRoleMutateAsync.mockResolvedValue(undefined);
    deleteRoleMutateAsync.mockResolvedValue(undefined);
    assignRoleMutateAsync.mockResolvedValue(undefined);
    moderationMutateAsync.mockResolvedValue(undefined);
    removeMember.mockResolvedValue(undefined);
    deleteServer.mockResolvedValue(undefined);
    updateServerMeta.mockResolvedValue(undefined);
    rotateInvite.mockResolvedValue(undefined);
    revokeInvite.mockResolvedValue(undefined);
  });

  it("does not persist admin state on mount", () => {
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);
    expect(window.localStorage.length).toBe(0);
  });

  it("exposes the P2P-synced roles section for owners", () => {
    // Roles are now real (stored in server record, synced via sync.update) so the
    // Roles nav entry is visible and shows default role placeholders until P2P sync.
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /^roles$/i })).not.toBeNull();
  });

  it("renames a role through the engine (real P2P mutation)", async () => {
    const user = userEvent.setup();
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^roles$/i }));
    // Click the role name button to enter edit mode.
    await user.click(screen.getByRole("button", { name: /edit name of moderator/i }));
    const input = screen.getByRole("textbox", { name: /rename moderator/i });
    await user.clear(input);
    await user.type(input, "Senior Mod{Enter}");

    await waitFor(() => {
      expect(updateRoleMutateAsync).toHaveBeenCalledWith({
        serverId: "srv-1",
        roleId: "role-mod",
        patch: expect.objectContaining({ name: "Senior Mod" }),
      });
    });
  });

  it("creates channels through the engine", async () => {
    const user = userEvent.setup();
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^channels$/i }));
    await user.click(screen.getByRole("button", { name: /add channel/i }));

    await waitFor(() => {
      expect(createChannelMutateAsync).toHaveBeenCalledWith({ serverId: "srv-1", name: "new-2", voice: false });
    });
    // No local placeholder is appended — the live snapshot is the source of truth.
    expect(window.localStorage.length).toBe(0);
  });

  it("renames a channel through the engine (real edit, not a stub)", async () => {
    const user = userEvent.setup();
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^channels$/i }));
    await user.click(screen.getByRole("button", { name: /edit general/i }));
    const input = screen.getByRole("textbox", { name: /rename general/i });
    await user.clear(input);
    await user.type(input, "renamed{Enter}");

    await waitFor(() => {
      expect(updateChannelMutateAsync).toHaveBeenCalledWith({ serverId: "srv-1", channelId: "c1", patch: { name: "renamed" } });
    });
  });

  it("deletes a channel through the engine", async () => {
    const user = userEvent.setup();
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^channels$/i }));
    await user.click(screen.getByRole("button", { name: /delete general/i }));

    await waitFor(() => {
      expect(deleteChannelMutateAsync).toHaveBeenCalledWith({ serverId: "srv-1", channelId: "c1" });
    });
  });

  it("saves server name/description through the engine", async () => {
    const user = userEvent.setup();
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);

    const nameInput = screen.getByLabelText(/server name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed Server");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(updateServerMeta).toHaveBeenCalledWith("srv-1", expect.objectContaining({ name: "Renamed Server" }));
    });
  });

  it("rotates and revokes the real invite link", async () => {
    const user = userEvent.setup();
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^invites$/i }));
    await user.click(screen.getByRole("button", { name: /rotate link/i }));
    await waitFor(() => expect(rotateInvite).toHaveBeenCalledWith("srv-1"));

    // Revoke is gated behind a confirm() — accept it.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: /^revoke$/i }));
    await waitFor(() => expect(revokeInvite).toHaveBeenCalledWith("srv-1"));
  });

  it("shows the clipboard warning when invite copying is blocked", async () => {
    vi.spyOn(clipboardUtils, 'copyTextToClipboardSafely').mockResolvedValue(false);

    const user = userEvent.setup();
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^invites$/i }));
    await user.click(screen.getByRole("button", { name: /copy invite link/i }));
    expect(await screen.findByText(/clipboard access is unavailable/i)).toBeTruthy();
  });

  it("deletes the server through the engine (real, not a stub)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ServerSettingsScreen server={makeServer()} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: /delete server/i }));
    await waitFor(() => expect(deleteServer).toHaveBeenCalledWith("srv-1"));
    expect(onClose).toHaveBeenCalled();
  });

  it("normalizes malformed member records before rendering the admin member list", async () => {
    const user = userEvent.setup();
    render(
      <ServerSettingsScreen
        server={{
          ...makeServer(),
          members: [
            { id: "me", username: "me", avatar: "/me.png", status: "online", role: "Admin", bio: "Primary operator" },
            {
              id: "u2",
              username: { bad: true },
              avatar: 42,
              status: "online",
              role: "Member",
              color: { accent: true },
              bio: { note: "bad" },
            } as never,
          ],
        }}
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^members$/i }));
    expect(screen.getByText("u2")).toBeInTheDocument();
    expect(screen.getByText("No status set.")).toBeInTheDocument();
  });

  it("keeps the first member when duplicate ids collide in admin state", async () => {
    const user = userEvent.setup();
    render(
      <ServerSettingsScreen
        server={{
          ...makeServer(),
          members: [
            { id: "u2", username: "first-nova", avatar: "/nova.png", status: "online", role: "Member", bio: "First record" },
            { id: "u2", username: "second-nova", avatar: "/nova.png", status: "idle", role: "Member", bio: "Second record" },
          ],
        }}
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^members$/i }));

    expect(screen.getAllByText("first-nova").length).toBe(1);
    expect(screen.queryByText("second-nova")).toBeNull();
    expect(screen.getByRole("button", { name: /remove first-nova/i })).toBeTruthy();
  });

  it("filters the member list by the search query", async () => {
    const user = userEvent.setup();
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^members$/i }));
    expect(screen.getByText("nova")).toBeInTheDocument();
    expect(screen.getByText("me")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: /search members/i }), "nova");

    expect(screen.getByText("nova")).toBeInTheDocument();
    expect(screen.queryByText("me")).toBeNull();
  });

  it("removes a member through the engine after confirmation", async () => {
    const user = userEvent.setup();
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^members$/i }));
    await user.click(screen.getByRole("button", { name: /remove nova/i }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^remove member$/i }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(removeMember).toHaveBeenCalledWith("srv-1", "u2");
  });

  it("cancels member removal without calling the engine", async () => {
    const user = userEvent.setup();
    render(<ServerSettingsScreen server={makeServer()} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^members$/i }));
    await user.click(screen.getByRole("button", { name: /remove nova/i }));
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("nova")).toBeInTheDocument();
    expect(removeMember).not.toHaveBeenCalled();
  });

  it("dismisses the remove dialog with Escape without closing the settings screen", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ServerSettingsScreen server={makeServer()} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: /^members$/i }));
    await user.click(screen.getByRole("button", { name: /remove nova/i }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the first normalized category and channel when duplicate ids collide in admin state", async () => {
    const user = userEvent.setup();
    render(
      <ServerSettingsScreen
        server={{
          ...makeServer(),
          categories: [
            {
              id: "srv-1-text",
              name: "Alpha Text",
              channels: [
                { id: "c1", name: "general", type: "text", categoryId: "srv-1-text" },
                { id: "c1", name: "duplicate general", type: "text", categoryId: "srv-1-text" },
              ],
            },
            {
              id: "srv-1-text",
              name: "Beta Text",
              channels: [{ id: "c2", name: "should-not-render", type: "text", categoryId: "srv-1-text" }],
            },
          ],
        }}
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^channels$/i }));

    expect(screen.getByText("Alpha Text")).toBeInTheDocument();
    expect(screen.queryByText("Beta Text")).toBeNull();
    expect(screen.getAllByText("general").length).toBe(1);
    expect(screen.queryByText("duplicate general")).toBeNull();
    expect(screen.queryByText("should-not-render")).toBeNull();
    expect(screen.getByRole("button", { name: /delete general/i })).toBeTruthy();
  });
});
