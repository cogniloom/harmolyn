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
    expect(screen.getByAltText("Message image preview")).toBeTruthy();

    cleanup();

    render(<MediaEmbed content="https://example.com/second-image.png" />);
    expect(screen.getByAltText("Message image preview")).toBeTruthy();
  });

  it("renders svg image urls as link cards instead of embedded images", () => {
    render(<MediaEmbed content="https://example.com/vector.svg" />);

    expect(screen.queryByAltText("Message image preview")).toBeNull();
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

    expect(screen.queryByAltText("Message image preview")).toBeNull();
    expect(screen.getByText("example.com")).toBeTruthy();
  });

  it("uses the privacy-enhanced host for the YouTube player", () => {
    render(<MediaEmbed content="https://youtu.be/dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play YouTube video" }));
    expect(document.querySelector("iframe")?.getAttribute("src")).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\//);
  });

  it("sets a strict referrer policy on the youtube iframe", () => {
    render(<MediaEmbed content="https://youtu.be/dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play YouTube video" }));
    expect(document.querySelector("iframe")?.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  });

  it("fetches no remote media by default until the reader opts in", () => {
    window.localStorage.clear();

    render(<MediaEmbed content="https://example.com/first-image.png" />);

    // Nothing is fetched: no <img> is rendered, only a click-to-load placeholder.
    expect(screen.queryByAltText("Message image preview")).toBeNull();
    const reveal = screen.getByRole("button", { name: /load image preview/i });
    expect(reveal).toBeTruthy();

    // Opting in for this item loads it.
    fireEvent.click(reveal);
    expect(screen.getByAltText("Message image preview")).toBeTruthy();
  });

  it("keeps link cards (which fetch nothing) visible even with media off", () => {
    window.localStorage.clear();

    render(<MediaEmbed content="https://example.com/docs/guide" />);

    expect(screen.getByText("example.com")).toBeTruthy();
  });
});
