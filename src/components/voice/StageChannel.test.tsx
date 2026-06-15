import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StageChannel } from "./StageChannel";
import { PREVIEW_STORAGE_KEYS } from "@/config/storageKeys";

const KEY = PREVIEW_STORAGE_KEYS.stage("vc-1");

// The stage component ships empty (no runtime/protocol backing — see
// docs/PROTOCOL_GAPS.md "Stage channels"). Seed the preview store so there is a
// raised-hand listener to invite, then assert the local persistence logic.
beforeEach(() => {
  window.localStorage.setItem(
    KEY,
    JSON.stringify([
      {
        user: { id: "u1", username: "Cipher_Punk", avatar: "", status: "online", color: "#FF2A6D" },
        role: "speaker",
        isMuted: false,
        handRaised: false,
      },
      {
        user: { id: "u3", username: "ByteWalker", avatar: "", status: "online", color: "#F6F8F8" },
        role: "listener",
        isMuted: true,
        handRaised: true,
      },
    ]),
  );
});

describe("StageChannel local-preview persistence", () => {
  it("invites a raised-hand listener to speak and persists the role change", async () => {
    const user = userEvent.setup();
    render(<StageChannel channelId="vc-1" channelName="Main Stage" onLeave={() => {}} />);

    await user.click(screen.getByRole("button", { name: /invite to speak/i }));

    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    expect(stored.find((p: { user: { id: string } }) => p.user.id === "u3").role).toBe("speaker");
  });
});
