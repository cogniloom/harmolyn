import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JoinServerModal } from "./JoinServerModal";

const discoverServerByInvite = vi.hoisted(() => vi.fn());
// Mutable holders: the preview leak gate is the nativeEngine FLAG (not engine
// liveness) — flag off → HTTP/legacy mode, support-node preview allowed; flag on →
// preview must stay local even while `engine` is still null (bootstrapping).
const engineHolder = vi.hoisted(() => ({ engine: null as object | null }));
const flagHolder = vi.hoisted(() => ({ nativeEngine: true }));
// Stable across renders — a fresh fn per render would churn the facade's useMemo.
const registerIdentity = vi.hoisted(() => vi.fn());

afterEach(() => {
  discoverServerByInvite.mockReset();
  engineHolder.engine = null;
  flagHolder.nativeEngine = true;
});

vi.mock("@/lib/xoreinControl", async () => {
  const actual = await vi.importActual<typeof import("@/lib/xoreinControl")>("@/lib/xoreinControl");
  return {
    ...actual,
    discoverServerByInvite,
  };
});

vi.mock("@/native/engine/provider", () => ({
  useNativeEngine: () => ({ engine: engineHolder.engine, registerIdentity, hasRegisteredIdentity: false }),
}));

vi.mock("@/config/featureFlags", async () => {
  const actual = await vi.importActual<typeof import("@/config/featureFlags")>("@/config/featureFlags");
  return {
    ...actual,
    resolveFeatureFlag: (flag: string) =>
      flag === "nativeEngine" ? flagHolder.nativeEngine : actual.resolveFeatureFlag(flag as never),
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
  it("ignores a malformed discovery preview and stays joinable for a valid invite (HTTP/legacy branch)", async () => {
    flagHolder.nativeEngine = false; // genuinely HTTP-mode client — preview allowed
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

  // Finding 8 regression: previewing an invite must NOT tell the support node which
  // server the user is about to join. On the native path the modal renders the
  // preview entirely from the locally-parsed deeplink; the node is never consulted —
  // including while the engine is still bootstrapping (flag on, engine still null),
  // the exact window that leaked one preview POST in the live E2E audit.
  // Fails without the fix (the modal called discoverServerByInvite unconditionally).
  it("never asks the support node for a preview on the native path (zero-trust)", async () => {
    engineHolder.engine = null; // nativeEngine flag ON (default) but engine still bootstrapping
    const invite = makeXoreinInviteDeeplink("srv-1");
    render(
      <JoinServerModal
        onClose={() => {}}
        onJoin={async () => {}}
        initialValue={invite}
        runtimeSnapshot={null}
      />,
    );

    // The locally-parsed preview renders (name straight from the invite payload)…
    await waitFor(() => {
      expect(screen.getByText("Cyber Devs")).toBeInTheDocument();
    });
    // …the 250 ms debounced enrichment window elapses…
    await new Promise((resolve) => setTimeout(resolve, 400));
    // …and the support node was never told which server this user is looking at.
    expect(discoverServerByInvite).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /join server/i })).toBeEnabled();
  });
});
