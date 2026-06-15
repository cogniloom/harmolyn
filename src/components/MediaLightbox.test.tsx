import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MediaLightbox } from "./MediaLightbox";

describe("MediaLightbox", () => {
  it("sets a no-referrer policy on the rendered image", () => {
    const onClose = vi.fn();
    render(<MediaLightbox src="https://example.com/photo.png" alt="Photo" onClose={onClose} />);

    expect(screen.getByAltText("Photo").getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("blocks unsafe image sources and shows a safe fallback", () => {
    const onClose = vi.fn();
    render(<MediaLightbox src="https://example.com/vector.svg" onClose={onClose} />);

    expect(screen.queryByAltText("Image")).toBeNull();
    expect(screen.getByText("This image source cannot be previewed safely.")).toBeTruthy();
  });

  it("zooms in and out on wheel scroll, clamped to 0.5x..3x", () => {
    const onClose = vi.fn();
    const { getByRole } = render(
      <MediaLightbox src="https://example.com/photo.png" alt="Photo" onClose={onClose} />,
    );
    const dialog = getByRole("dialog");

    expect(screen.getByText("100%")).toBeTruthy();

    // Scroll up zooms in.
    fireEvent.wheel(dialog, { deltaY: -100 });
    expect(screen.getByText("125%")).toBeTruthy();

    // Many scroll-ups clamp at 3x (300%).
    for (let i = 0; i < 20; i += 1) fireEvent.wheel(dialog, { deltaY: -100 });
    expect(screen.getByText("300%")).toBeTruthy();

    // Many scroll-downs clamp at 0.5x (50%).
    for (let i = 0; i < 30; i += 1) fireEvent.wheel(dialog, { deltaY: 100 });
    expect(screen.getByText("50%")).toBeTruthy();
  });

  it("closes when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<MediaLightbox src="https://example.com/photo.png" alt="Photo" onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
