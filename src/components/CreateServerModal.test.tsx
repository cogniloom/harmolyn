import type React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CreateServerModal } from "./CreateServerModal";

function renderModal(overrides: Partial<React.ComponentProps<typeof CreateServerModal>> = {}) {
  const onClose = vi.fn();
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onOpenJoin = vi.fn();
  render(
    <CreateServerModal
      onClose={onClose}
      onCreate={onCreate}
      onOpenJoin={onOpenJoin}
      {...overrides}
    />,
  );
  return { onClose, onCreate, onOpenJoin };
}

describe("CreateServerModal", () => {
  it("auto-focuses the name input on mount", () => {
    renderModal();
    expect(screen.getByLabelText(/space name/i)).toHaveFocus();
  });

  it("disables the create button while the name is blank and enables it once filled", async () => {
    const user = userEvent.setup();
    renderModal();

    const createButton = screen.getByRole("button", { name: /create space/i });
    expect(createButton).toBeDisabled();

    await user.type(screen.getByLabelText(/space name/i), "Hub");
    expect(createButton).toBeEnabled();

    // A whitespace-only name must not be considered fillable.
    await user.clear(screen.getByLabelText(/space name/i));
    await user.type(screen.getByLabelText(/space name/i), "   ");
    expect(createButton).toBeDisabled();
  });

  it("does not submit a blank name when Enter is pressed", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderModal();

    await user.type(screen.getByLabelText(/space name/i), "{Enter}");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("invokes onCreate with the trimmed name", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderModal();

    await user.type(screen.getByLabelText(/space name/i), "  Cyber Devs  ");
    await user.click(screen.getByRole("button", { name: /create space/i }));

    expect(onCreate).toHaveBeenCalledWith({ name: "Cyber Devs", description: "" });
  });
});
