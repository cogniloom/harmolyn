import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ForwardMessageModal } from "./ForwardMessageModal";

describe("ForwardMessageModal", () => {
  it("normalizes destinations before rendering and forwarding", async () => {
    const onForward = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ForwardMessageModal
        messageContent="Forward this message"
        destinations={[
          {
            id: "chan-1",
            label: "first-channel",
            sublabel: "General",
            type: "channel",
          },
          {
            id: "chan-1",
            label: "second-channel",
            sublabel: "Duplicate",
            type: "channel",
          },
          {
            id: "   ",
            label: { bad: true },
            sublabel: 42,
            type: "not-a-type",
          } as never,
        ]}
        onForward={onForward}
        onClose={onClose}
      />,
    );

    expect(screen.getAllByRole("button", { name: /first-channel/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /second-channel/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /destination-2/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /first-channel/i }));
    await user.click(screen.getByRole("button", { name: /forward \(1\)/i }));

    expect(onForward).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: "chan-1",
          label: "first-channel",
          sublabel: "General",
          type: "channel",
        }),
      ],
      "",
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("exposes modal dialog semantics", () => {
    render(
      <ForwardMessageModal
        messageContent="Forward this message"
        destinations={[]}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(/forward/i);
  });

  it("closes when Escape is pressed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ForwardMessageModal
        messageContent="Forward this message"
        destinations={[]}
        onForward={vi.fn()}
        onClose={onClose}
      />,
    );

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
