import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JoinServerModal } from "./JoinServerModal";

const discoverServerByInvite = vi.hoisted(() => vi.fn());

afterEach(() => {
  discoverServerByInvite.mockReset();
});

vi.mock("@/lib/xoreinControl", async () => {
  const actual = await vi.importActual<typeof import("@/lib/xoreinControl")>("@/lib/xoreinControl");
  return {
    ...actual,
    discoverServerByInvite,
  };
});

function makeXoreinInviteDeeplink(serverId = "srv-1") {
  const rawInvite = Buffer.from(
    JSON.stringify({
      server_id: serverId,
      owner_peer_id: "owner-peer",
      owner_public_key: "owner-public-key",
      manifest_hash: "0123456789abcdef0123456789abcdef",
      expires_at: "",
      security_mode: "seal",
      signature: "signed-payload",
      name: "Cyber Devs",
    }),
    "utf8",
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `xorein://invite/${rawInvite}`;
}

describe("JoinServerModal", () => {
  // The join is P2P (dial the server owner), so it is gated on the LOCAL invite
  // parse, not the support node's HTTP discovery. A malformed discovery preview
  // from the support node is best-effort enrichment and must be ignored — it must
  // not surface an error or block joining for an otherwise-valid invite.
  it("ignores a malformed discovery preview and stays joinable for a valid invite", async () => {
    discoverServerByInvite.mockResolvedValueOnce({
      invite: { server_id: "srv-1" },
      manifest: {
        server_id: "srv-1",
        name: { bad: true },
        description: 42,
      },
      member_count: "many",
    } as never);

    const invite = makeXoreinInviteDeeplink("srv-1");
    render(
      <JoinServerModal
        onClose={() => {}}
        onJoin={async () => {}}
        initialValue={invite}
        runtimeSnapshot={null}
      />,
    );

    // The best-effort support-node discovery is attempted (debounced)...
    await waitFor(() => {
      expect(discoverServerByInvite).toHaveBeenCalledTimes(1);
    });
    // ...but its malformed preview is dropped, so no error alert is shown and the
    // locally-validated invite keeps Join enabled.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /join server/i })).toBeEnabled();
  });

  it("fails closed when the invite link cannot be parsed locally", async () => {
    render(
      <JoinServerModal
        onClose={() => {}}
        onJoin={async () => {}}
        initialValue="xorein://invite/not-valid-base64-json"
        runtimeSnapshot={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /join server/i })).toBeDisabled();
    // A locally-invalid invite never reaches the support node.
    expect(discoverServerByInvite).not.toHaveBeenCalled();
  });
});
