import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerBoost } from "./ServerBoost";
import { PREVIEW_STORAGE_KEYS } from "@/config/storageKeys";

const KEY = PREVIEW_STORAGE_KEYS.serverBoost("srv-1");

describe("ServerBoost local-preview persistence", () => {
  it("boosts the server and persists the incremented count", async () => {
    const user = userEvent.setup();
    render(<ServerBoost serverId="srv-1" serverName="Test" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /boost this server/i }));

    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "0")).toBe(4);
  });

  it("hydrates a previously stored boost count", async () => {
    window.localStorage.setItem(KEY, "7");
    const user = userEvent.setup();
    render(<ServerBoost serverId="srv-1" serverName="Test" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /boost this server/i }));

    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "0")).toBe(8);
  });
});
