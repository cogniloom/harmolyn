import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServerProfileEditor } from "./ServerProfileEditor";

describe("ServerProfileEditor", () => {
  it("normalizes malformed user records before rendering the profile modal", () => {
    render(
      <ServerProfileEditor
        user={{
          id: "peer-local",
          username: { bad: true },
          avatar: 123,
          status: "online",
          role: { bad: true },
          color: { bad: true },
          bio: { bad: true },
        } as never}
        server={{
          id: "srv-1",
          name: "Alpha",
          icon: "",
          ownerId: "peer-local",
          categories: [],
          members: [],
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText("peer-local")).toBeTruthy();
    expect(screen.getByText("Customize your identity for")).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });
});
