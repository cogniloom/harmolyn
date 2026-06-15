import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmojiPicker } from "./EmojiPicker";

describe("EmojiPicker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("still works when localStorage is blocked", () => {
    const storageError = new DOMException("Blocked", "SecurityError");
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw storageError;
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw storageError;
    });

    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(<EmojiPicker onSelect={onSelect} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "😀" }));

    expect(onSelect).toHaveBeenCalledWith("😀");
    expect(screen.getByText(/recently used/i)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "😀" }).length).toBeGreaterThanOrEqual(2);
  });

  it("normalizes malformed recent emoji storage", () => {
    window.localStorage.setItem("harmolyn-recent-emojis", JSON.stringify([1, " 😀 ", null, "😄", " 😀 "])); 

    render(<EmojiPicker onSelect={vi.fn()} onClose={vi.fn()} />);

    expect(JSON.parse(window.localStorage.getItem("harmolyn-recent-emojis") ?? "[]")).toEqual(["😀", "😄"]);
  });
});
