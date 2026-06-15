import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MentionAutocomplete } from "./MentionAutocomplete";

describe("MentionAutocomplete", () => {
  it("normalizes malformed mention users before rendering and selection", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <MentionAutocomplete
        users={[
          {
            id: "peer-local",
            username: { bad: true },
            avatar: 123,
            status: "not-a-status",
            role: { bad: true },
            color: { bad: true },
            bio: { bad: true },
          } as never,
        ]}
        query="peer"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("option", { name: /peer-local/i }));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "peer-local",
        username: "peer-local",
        avatar: "",
        status: "offline",
      }),
    );
  });

  it("keeps the first user when duplicate mention ids collide", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <MentionAutocomplete
        users={[
          {
            id: "peer-dup",
            username: "first-suggestion",
            avatar: "",
            status: "online",
          } as never,
          {
            id: "peer-dup",
            username: "second-suggestion",
            avatar: "",
            status: "idle",
          } as never,
        ]}
        query="suggestion"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    expect(screen.getAllByRole("option", { name: /first-suggestion/i }).length).toBe(1);
    await user.click(screen.getByRole("option", { name: /first-suggestion/i }));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "peer-dup",
        username: "first-suggestion",
        status: "online",
      }),
    );
    expect(onSelect).not.toHaveBeenCalledWith(
      expect.objectContaining({
        username: "second-suggestion",
      }),
    );
  });
});
