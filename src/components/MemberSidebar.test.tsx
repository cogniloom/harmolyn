import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemberSidebar } from "./MemberSidebar";
import { useFeature } from "@/hooks/useFeature";
import { useRuntimeSnapshot } from "@/lib/xoreinRuntimeContext";
import { moderationAction, refreshRuntimeSnapshot } from "@/lib/xoreinControl";

vi.mock("@/hooks/useFeature", () => ({
  useFeature: vi.fn(),
}));

vi.mock("@/lib/xoreinRuntimeContext", () => ({
  useRuntimeSnapshot: vi.fn(),
}));

vi.mock("@/lib/xoreinControl", async () => {
  const actual = await vi.importActual<typeof import("@/lib/xoreinControl")>("@/lib/xoreinControl");
  return {
    ...actual,
    moderationAction: vi.fn(),
    refreshRuntimeSnapshot: vi.fn(),
  };
});

describe("MemberSidebar moderation", () => {
  beforeEach(() => {
    vi.mocked(useFeature).mockReturnValue(true);
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      peer_id: "peer-local",
      identity: { peer_id: "peer-local" },
      control_endpoint: "http://xorein.local",
    });
    vi.mocked(moderationAction).mockResolvedValue(undefined);
    vi.mocked(refreshRuntimeSnapshot).mockResolvedValue({
      peer_id: "peer-local",
      identity: { peer_id: "peer-local" },
      control_endpoint: "http://xorein.local",
    } as never);
  });

  it("sends timeouts through the xorein moderation API", async () => {
    const user = userEvent.setup();

    render(
      <MemberSidebar
        members={[
          { id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online", role: "Admin" },
          { id: "peer-remote", username: "Grace", avatar: "/avatar2.png", status: "online" },
        ]}
        currentUser={{ id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online", role: "Admin" }}
        serverOwnerId="peer-local"
        serverId="server-1"
        runtimeSnapshot={{
          peer_id: "peer-local",
          identity: { peer_id: "peer-local" },
          control_endpoint: "http://xorein.local",
        }}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /timeout user/i })[1]);
    await user.click(screen.getByRole("button", { name: /5 minutes/i }));
    await user.click(screen.getByRole("button", { name: /apply timeout/i }));

    await waitFor(() => {
      expect(moderationAction).toHaveBeenCalledWith(
        expect.objectContaining({ peer_id: "peer-local" }),
        "server-1",
        "mute",
        expect.objectContaining({
          target_peer_id: "peer-remote",
          duration_ms: 300000,
        }),
      );
    });
  });

  it("normalizes malformed member records before rendering moderation controls", async () => {
    const user = userEvent.setup();

    render(
      <MemberSidebar
        members={[
          { id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online", role: "Admin" },
          {
            id: "peer-remote",
            username: { bad: true },
            avatar: 42,
            status: "online",
            role: "Moderator",
            color: { accent: true },
            bio: { note: "bad" },
          } as never,
        ]}
        currentUser={{ id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online", role: "Admin" }}
        serverOwnerId="peer-local"
        serverId="server-1"
        runtimeSnapshot={{
          peer_id: "peer-local",
          identity: { peer_id: "peer-local" },
          control_endpoint: "http://xorein.local",
        }}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );

    expect(screen.getByText("peer-remote")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /timeout user/i })[1]);
    await user.click(screen.getByRole("button", { name: /5 minutes/i }));
    await user.click(screen.getByRole("button", { name: /apply timeout/i }));

    await waitFor(() => {
      expect(moderationAction).toHaveBeenCalledWith(
        expect.objectContaining({ peer_id: "peer-local" }),
        "server-1",
        "mute",
        expect.objectContaining({
          target_peer_id: "peer-remote",
          duration_ms: 300000,
        }),
      );
    });
  });

  it("keeps the first normalized member when duplicate ids are present", async () => {
    const user = userEvent.setup();

    render(
      <MemberSidebar
        members={[
          { id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online", role: "Admin" },
          { id: "peer-remote", username: "Alpha", avatar: "/avatar2.png", status: "online", role: "Member" },
          { id: "peer-remote", username: "Beta", avatar: "/avatar3.png", status: "idle", role: "Member" },
        ]}
        currentUser={{ id: "peer-local", username: "Ada", avatar: "/avatar.png", status: "online", role: "Admin" }}
        serverOwnerId="peer-local"
        serverId="server-1"
        runtimeSnapshot={{
          peer_id: "peer-local",
          identity: { peer_id: "peer-local" },
          control_endpoint: "http://xorein.local",
        }}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).toBeNull();
    expect(screen.getAllByTitle("Timeout user").length).toBe(2);

    await user.click(screen.getAllByTitle("Timeout user")[1]);
    await user.click(screen.getByRole("button", { name: /5 minutes/i }));
    await user.click(screen.getByRole("button", { name: /apply timeout/i }));

    await waitFor(() => {
      expect(moderationAction).toHaveBeenCalledWith(
        expect.objectContaining({ peer_id: "peer-local" }),
        "server-1",
        "mute",
        expect.objectContaining({
          target_peer_id: "peer-remote",
          duration_ms: 300000,
        }),
      );
    });
  });
});
