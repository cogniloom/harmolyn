import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PollCreator } from "./PollCreator";

describe("PollCreator", () => {
  it("normalizes duplicate and blank options before submission", () => {
    const onSubmit = vi.fn();
    render(<PollCreator onSubmit={onSubmit} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("Ask something..."), { target: { value: "  Choose a winner  " } });
    fireEvent.change(screen.getByPlaceholderText("Option 1"), { target: { value: " Alpha " } });
    fireEvent.change(screen.getByPlaceholderText("Option 2"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: /add option/i }));
    fireEvent.change(screen.getByPlaceholderText("Option 3"), { target: { value: " Beta " } });

    fireEvent.click(screen.getByRole("button", { name: /create poll/i }));

    expect(onSubmit).toHaveBeenCalledWith("Choose a winner", ["Alpha", "Beta"]);
  });

  it("keeps the create button disabled until at least two unique options exist", () => {
    render(<PollCreator onSubmit={() => {}} onClose={() => {}} />);

    expect(screen.getByRole("button", { name: /create poll/i })).toBeDisabled();
  });

  it("auto-focuses the question input on mount", () => {
    render(<PollCreator onSubmit={() => {}} onClose={() => {}} />);

    expect(screen.getByPlaceholderText("Ask something...")).toHaveFocus();
  });

  it("enforces a character limit on the question and option inputs", () => {
    render(<PollCreator onSubmit={() => {}} onClose={() => {}} />);

    expect(screen.getByPlaceholderText("Ask something...")).toHaveAttribute("maxLength", "300");
    expect(screen.getByPlaceholderText("Option 1")).toHaveAttribute("maxLength", "100");
  });

  it("closes when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<PollCreator onSubmit={() => {}} onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
