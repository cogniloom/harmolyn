import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaEmbed } from "./MediaEmbed";
import { PRIVACY_STORAGE_KEY } from "@/hooks/usePrivacyPreferences";

// Remote media auto-load is OFF by default (privacy-first), so the embed-rendering
// assertions below opt in first. A dedicated test covers the default-off behavior.
function allowRemoteMedia() {
  window.localStorage.setItem(PRIVACY_STORAGE_KEY, JSON.stringify({ loadRemoteMedia: true }));
}

describe("MediaEmbed", () => {
  beforeEach(() => {
    allowRemoteMedia();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("does not leak regex state between renders", () => {
    render(<MediaEmbed content="https://example.com/first-image.png" />);
    expect(screen.getByAltText("Embedded image")).toBeTruthy();

    cleanup();

    render(<MediaEmbed content="https://example.com/second-image.png" />);
    expect(screen.getByAltText("Embedded image")).toBeTruthy();
  });

  it("renders svg image urls as link cards instead of embedded images", () => {
    render(<MediaEmbed content="https://example.com/vector.svg" />);

    expect(screen.queryByAltText("Embedded image")).toBeNull();
    expect(screen.getByText("example.com")).toBeTruthy();
  });


  it("renders regular link cards with the parsed domain", () => {
    render(<MediaEmbed content="https://example.com/docs/guide?ref=chat" />);

    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByRole("link", { name: /https:\/\/example.com\/docs\/guide\?ref=chat/i })).toHaveAttribute("href", "https://example.com/docs/guide?ref=chat");
  });

  it("canonicalizes rendered link hrefs before exposing them to the DOM", () => {
    render(<MediaEmbed content="HTTPS://Example.com/Docs/Guide?ref=chat" />);

    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByRole("link", { name: /HTTPS:\/\/Example.com\/Docs\/Guide\?ref=chat/i })).toHaveAttribute("href", "https://example.com/Docs/Guide?ref=chat");
  });

  it("does not render unsafe image sources", () => {
    render(<MediaEmbed content="https://example.com/vector.svg" />);

    expect(screen.queryByAltText("Embedded image")).toBeNull();
    expect(screen.getByText("example.com")).toBeTruthy();
  });

  it("uses the privacy-enhanced youtube host", () => {
    render(<MediaEmbed content="https://youtu.be/dQw4w9WgXcQ" />);

    expect(screen.getByAltText("Video thumbnail").getAttribute("src")).toContain("img.youtube-nocookie.com");
  });

  it("sets a strict referrer policy on the youtube iframe", () => {
    render(<MediaEmbed content="https://youtu.be/dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByAltText("Video thumbnail"));
    expect(document.querySelector("iframe")?.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  });

  it("fetches no remote media by default until the reader opts in", () => {
    window.localStorage.clear();

    render(<MediaEmbed content="https://example.com/first-image.png" />);

    // Nothing is fetched: no <img> is rendered, only a click-to-load placeholder.
    expect(screen.queryByAltText("Embedded image")).toBeNull();
    const reveal = screen.getByRole("button", { name: /image preview hidden/i });
    expect(reveal).toBeTruthy();

    // Opting in for this item loads it.
    fireEvent.click(reveal);
    expect(screen.getByAltText("Embedded image")).toBeTruthy();
  });

  it("keeps link cards (which fetch nothing) visible even with media off", () => {
    window.localStorage.clear();

    render(<MediaEmbed content="https://example.com/docs/guide" />);

    expect(screen.getByText("example.com")).toBeTruthy();
  });
});
