import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerExplorer } from "./ServerExplorer";
import { discoverServerByInvite } from "@/lib/xoreinControl";

vi.mock("@/lib/xoreinControl", async () => {
  const actual = await vi.importActual<typeof import("@/lib/xoreinControl")>("@/lib/xoreinControl");
  return {
    ...actual,
    discoverServerByInvite: vi.fn(),
  };
});

describe("ServerExplorer", () => {
  beforeEach(() => {
    vi.mocked(discoverServerByInvite).mockReset();
  });

  it("normalizes malformed invite previews before rendering discovery cards", async () => {
    vi.mocked(discoverServerByInvite).mockResolvedValue({
      invite: {
        server_id: "srv-1",
        expires_at: { bad: true } as never,
        has_signature: true,
        owner_peer_id: { bad: true } as never,
      },
      manifest: {
        server_id: "srv-1",
        name: "Alpha Node",
        description: { bad: true } as never,
        history_coverage: { bad: true } as never,
        security_mode: { bad: true } as never,
      },
      owner_role: { bad: true } as never,
      member_count: 12,
      channels: [
        {
          id: " chan-1 ",
          server_id: " srv-1 ",
          name: " general ",
          voice: false,
          created_at: "2026-05-26T12:00:00Z",
        },
        {
          id: 123 as never,
          server_id: "srv-1",
          name: "broken",
          voice: false,
        },
        {
          id: "chan-1",
          server_id: "srv-1",
          name: "shadowed",
          voice: false,
        },
      ],
      safety_labels: ["signed-invite", 123 as never],
    } as never);

    const user = userEvent.setup();
    render(
      <ServerExplorer
        servers={[]}
        runtimeSnapshot={{ control_endpoint: "http://xorein.local" } as never}
        onSelectServer={vi.fn()}
        onOpenJoin={vi.fn()}
      />,
    );

    await user.type(screen.getByPlaceholderText(/invite/i), "xorein://invite/alpha");
    await waitFor(() => expect(discoverServerByInvite).toHaveBeenCalled());

    expect(await screen.findByText("Alpha Node")).toBeTruthy();
    expect(screen.getByText("This invite resolved to a live xorein manifest.")).toBeTruthy();
    expect(screen.getByText("12 members")).toBeTruthy();
    expect(screen.getByText("1 channels")).toBeTruthy();
    expect(screen.queryByText("shadowed")).toBeNull();
  });

  it("dedupes malformed invite safety labels before rendering discovery cards", async () => {
    vi.mocked(discoverServerByInvite).mockResolvedValue({
      invite: {
        server_id: "srv-1",
        has_signature: true,
      },
      manifest: {
        server_id: "srv-1",
        name: "Alpha Node",
      },
      safety_labels: [" signed-invite ", "signed-invite", "public"] as never,
    } as never);

    const user = userEvent.setup();
    render(
      <ServerExplorer
        servers={[]}
        runtimeSnapshot={{ control_endpoint: "http://xorein.local" } as never}
        onSelectServer={vi.fn()}
        onOpenJoin={vi.fn()}
      />,
    );

    await user.type(screen.getByPlaceholderText(/invite/i), "xorein://invite/alpha");
    await waitFor(() => expect(discoverServerByInvite).toHaveBeenCalled());

    expect(await screen.findByText("Alpha Node")).toBeTruthy();
    expect(screen.getAllByText("signed-invite").length).toBe(1);
    expect(screen.getByText("public")).toBeTruthy();
  });
});
