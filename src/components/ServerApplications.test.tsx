import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerApplications } from "./ServerApplications";
import { PREVIEW_STORAGE_KEYS } from "@/config/storageKeys";

const APPS_KEY = `${PREVIEW_STORAGE_KEYS.serverApplications("srv-1")}:apps`;
const QUESTIONS_KEY = `${PREVIEW_STORAGE_KEYS.serverApplications("srv-1")}:questions`;

// The applications inbox ships empty (no membership-application model — see
// docs/PROTOCOL_GAPS.md "Server applications"). Seed the preview store with a
// pending application, then assert the local approve/persist logic.
beforeEach(() => {
  window.localStorage.setItem(
    APPS_KEY,
    JSON.stringify([
      {
        id: "app1",
        userId: "u10",
        username: "new_recruit_01",
        avatar: "",
        status: "pending",
        submittedAt: "2025-02-19 10:30",
        answers: [{ questionId: "q1", answer: "I want to contribute!" }],
      },
    ]),
  );
});

describe("ServerApplications local-preview persistence", () => {
  it("approves a pending application and persists the new status", async () => {
    const user = userEvent.setup();
    render(<ServerApplications serverId="srv-1" onClose={() => {}} />);

    await user.click(screen.getByText("new_recruit_01"));
    await user.click(screen.getByRole("button", { name: /^approve$/i }));

    const stored = JSON.parse(window.localStorage.getItem(APPS_KEY) ?? "[]");
    const approved = stored.find((a: { username: string }) => a.username === "new_recruit_01");
    expect(approved.status).toBe("approved");
  });

  it("adds an application question in the form builder and persists it", async () => {
    const user = userEvent.setup();
    render(<ServerApplications serverId="srv-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /form builder/i }));
    await user.click(screen.getByRole("button", { name: /add question/i }));

    const stored = JSON.parse(window.localStorage.getItem(QUESTIONS_KEY) ?? "[]");
    expect(stored.length).toBeGreaterThan(3);
  });

  it("hydrates previously stored applications on a fresh mount", () => {
    window.localStorage.setItem(
      APPS_KEY,
      JSON.stringify([
        { id: "x", userId: "ux", username: "stored_user", avatar: "", status: "pending", submittedAt: "now", answers: [] },
      ]),
    );
    render(<ServerApplications serverId="srv-1" onClose={() => {}} />);
    expect(screen.getByText("stored_user")).toBeTruthy();
  });
});
