import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShopScreen, QuestsScreen } from "./index";
import { PREVIEW_STORAGE_KEYS } from "@/config/storageKeys";

describe("ShopScreen local-preview persistence", () => {
  it("purchases an item, shows OWNED, and persists ownership", async () => {
    const user = userEvent.setup();
    render(<ShopScreen onClose={() => {}} />);

    const buyButtons = screen.getAllByRole("button", { name: /^buy$/i });
    await user.click(buyButtons[0]);

    expect(screen.getAllByText(/owned/i).length).toBeGreaterThan(0);
    const owned = JSON.parse(window.localStorage.getItem(PREVIEW_STORAGE_KEYS.shop) ?? "[]");
    expect(owned.length).toBe(1);
  });
});

describe("QuestsScreen local-preview persistence", () => {
  it("claims a completed quest, credits gems, and persists the balance", async () => {
    // Quests have no runtime/protocol backing (see docs/PROTOCOL_GAPS.md
    // "Monetization"). Seed the preview catalog with a completed quest, then
    // assert the local claim/credit/persist logic.
    window.localStorage.setItem(
      `${PREVIEW_STORAGE_KEYS.quests}:catalog`,
      JSON.stringify([
        {
          id: "qst3",
          title: "Reactor",
          description: "Add 20 reactions to messages",
          reward: "50 Gems",
          progress: 20,
          maxProgress: 20,
          type: "daily",
          completed: true,
        },
      ]),
    );

    const user = userEvent.setup();
    render(<QuestsScreen onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^claim$/i }));

    const stored = JSON.parse(window.localStorage.getItem(PREVIEW_STORAGE_KEYS.quests) ?? "null");
    expect(stored.balance).toBe(1300); // 1250 + 50 Gems (Reactor)
    expect(stored.claimed).toContain("qst3");
    expect(screen.getByText(/claimed/i)).toBeTruthy();
  });
});
