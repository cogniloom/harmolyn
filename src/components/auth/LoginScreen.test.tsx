import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { LoginScreen } from "./LoginScreen";
import { useFeature } from "@/hooks/useFeature";
import { useRestoreIdentity } from "@/hooks/runtime/mutations";
import { useRuntimeSnapshot } from "@/lib/xoreinRuntimeContext";

vi.mock("@/hooks/useFeature", () => ({
  useFeature: vi.fn(),
}));

vi.mock("@/hooks/runtime/mutations", () => ({
  useRestoreIdentity: vi.fn(),
}));

vi.mock("@/lib/xoreinRuntimeContext", () => ({
  useRuntimeSnapshot: vi.fn(),
}));

describe("LoginScreen", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(useFeature).mockReturnValue(false);
    vi.mocked(useRestoreIdentity).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as never);
  });

  it("blocks continuation when the runtime peer does not match the stored identity", () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      peer_id: "peer-active",
      identity: {
        peer_id: "peer-restored",
        profile: { display_name: "Ada" },
      },
    });

    render(<LoginScreen onLogin={vi.fn()} onSwitchToRegister={vi.fn()} />);

    expect(screen.getByText("peer-active")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText(/restart harmolyn or the local xorein node before continuing/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /restart required/i }).hasAttribute("disabled")).toBe(true);
  });

  it("does not crash when the stored identity has no profile", () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      peer_id: "peer-active",
      identity: {
        peer_id: "peer-restored",
      },
    });

    render(<LoginScreen onLogin={vi.fn()} onSwitchToRegister={vi.fn()} />);

    expect(screen.getByText("peer-active")).toBeTruthy();
    expect(screen.queryByText("Ada")).toBeNull();
    expect(screen.getByRole("button", { name: /restart required/i }).hasAttribute("disabled")).toBe(true);
  });

  it("normalizes malformed identity profiles before rendering the active identity banner", () => {
    vi.mocked(useRuntimeSnapshot).mockReturnValue({
      peer_id: "peer-active",
      identity: {
        peer_id: "peer-restored",
        profile: {
          display_name: { bad: true } as never,
          bio: "connected test user",
        } as never,
      },
    });

    render(<LoginScreen onLogin={vi.fn()} onSwitchToRegister={vi.fn()} />);

    expect(screen.getByText("peer-active")).toBeTruthy();
    expect(screen.queryByText("[object Object]")).toBeNull();
    expect(screen.getByText(/restart harmolyn or the local xorein node before continuing/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /restart required/i }).hasAttribute("disabled")).toBe(true);
  });
});
