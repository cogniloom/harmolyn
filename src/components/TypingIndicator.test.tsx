import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypingIndicator } from "./TypingIndicator";

describe("TypingIndicator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when no typing ids are provided", () => {
    const { container } = render(
      <TypingIndicator
        currentUserId="peer-local"
        users={[
          { id: "peer-remote", username: "remote", avatar: "", status: "online" },
        ]}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("normalizes malformed users before rendering real typing state", () => {
    render(
      <TypingIndicator
        currentUserId="peer-local"
        typingUserIds={["peer-remote"]}
        users={[
          {
            id: "peer-remote",
            username: { bad: true },
            avatar: 123,
            status: "online",
            role: { bad: true },
            color: { bad: true },
            bio: { bad: true },
          } as never,
        ]}
      />,
    );

    expect(screen.getByText("peer-remote is typing")).toBeTruthy();
  });

  it("never reports the current user as typing", () => {
    const { container } = render(
      <TypingIndicator
        currentUserId="peer-local"
        typingUserIds={["peer-local"]}
        users={[
          { id: "peer-local", username: "me", avatar: "", status: "online" },
        ]}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("only renders typing for users present in the explicit typing list", () => {
    render(
      <TypingIndicator
        currentUserId="peer-local"
        typingUserIds={["peer-a"]}
        users={[
          { id: "peer-a", username: "alice", avatar: "", status: "online" },
          { id: "peer-b", username: "bob", avatar: "", status: "online" },
        ]}
      />,
    );

    expect(screen.getByText("alice is typing")).toBeTruthy();
    expect(screen.queryByText("bob is typing")).toBeNull();
  });

  it("keeps the first user record when duplicate ids conflict", () => {
    render(
      <TypingIndicator
        currentUserId="peer-local"
        typingUserIds={["peer-remote"]}
        users={[
          { id: "peer-remote", username: "offline-first", avatar: "", status: "offline" } as never,
          { id: "peer-remote", username: "online-second", avatar: "", status: "online" } as never,
        ]}
      />,
    );

    expect(screen.getByText("offline-first is typing")).toBeTruthy();
    expect(screen.queryByText("online-second is typing")).toBeNull();
  });
});
