import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventsList } from "./EventsList";
import { PREVIEW_STORAGE_KEYS } from "@/config/storageKeys";

const KEY = PREVIEW_STORAGE_KEYS.scheduledEvents("srv-1");

describe("EventsList local-preview persistence", () => {
  it("renders the empty state and persists no fabricated events on mount", () => {
    render(<EventsList serverId="srv-1" onClose={() => {}} />);

    expect(screen.getByText(/no events scheduled/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /mark interested/i })).toBeNull();
    // The list persists an empty array, never fabricated/seed events.
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.length).toBe(0);
  });

  it("marks interest in a created event and persists it", async () => {
    const user = userEvent.setup();
    render(<EventsList serverId="srv-1" onClose={() => {}} />);

    // No events exist by default — create one through the real create flow first.
    await user.click(screen.getByRole("button", { name: /new event/i }));
    await user.type(screen.getByPlaceholderText(/weekly standup/i), "Launch Party");
    await user.click(screen.getByRole("button", { name: /create event/i }));
    await screen.findByText("Launch Party");

    const markButton = await screen.findByRole("button", { name: /mark interested/i });
    await user.click(markButton);

    const stored = JSON.parse(window.localStorage.getItem(`${KEY}:interested`) ?? "[]");
    expect(stored.length).toBe(1);
    expect(await screen.findByRole("button", { name: /^interested$/i })).toBeTruthy();
  });

  it("creates a new event and persists it", async () => {
    const user = userEvent.setup();
    render(<EventsList serverId="srv-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /new event/i }));
    await user.type(screen.getByPlaceholderText(/weekly standup/i), "Launch Party");
    await user.click(screen.getByRole("button", { name: /create event/i }));

    expect(await screen.findByText("Launch Party")).toBeTruthy();
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    expect(stored.some((e: { title: string }) => e.title === "Launch Party")).toBe(true);
  });
});
