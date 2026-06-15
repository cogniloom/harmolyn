import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Soundboard } from "./Soundboard";
import { PREVIEW_STORAGE_KEYS } from "@/config/storageKeys";

// The soundboard ships with no sounds (no sound-asset model / audio frames — see
// docs/PROTOCOL_GAPS.md "Soundboard"). Seed the preview store so there is a sound
// to favorite, then assert the local persistence logic.
beforeEach(() => {
  window.localStorage.setItem(
    PREVIEW_STORAGE_KEYS.soundboard,
    JSON.stringify([
      { id: "s1", name: "Air Horn", emoji: "📯", duration: "0:02", favorited: true, category: "classic" },
      { id: "s2", name: "Crickets", emoji: "🦗", duration: "0:03", favorited: false, category: "nature" },
    ]),
  );
});

describe("Soundboard local-preview persistence", () => {
  it("favorites a sound and persists it", async () => {
    const user = userEvent.setup();
    render(<Soundboard onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^favorite crickets$/i }));

    const stored = JSON.parse(window.localStorage.getItem(PREVIEW_STORAGE_KEYS.soundboard) ?? "[]");
    expect(stored.find((s: { name: string }) => s.name === "Crickets").favorited).toBe(true);
  });

  it("persists the volume setting", () => {
    render(<Soundboard onClose={() => {}} />);

    fireEvent.change(screen.getByRole("slider"), { target: { value: "40" } });

    expect(JSON.parse(window.localStorage.getItem(`${PREVIEW_STORAGE_KEYS.soundboard}:volume`) ?? "0")).toBe(40);
  });
});
