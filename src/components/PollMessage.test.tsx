import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PollMessage } from "./PollMessage";

describe("PollMessage", () => {
  it("normalizes poll options before rendering", () => {
    render(
      <PollMessage
        question={{ bad: true } as never}
        options={[
          { text: "First", votes: 2 },
          { text: "First", votes: 99 },
          { text: "Second", votes: -1 },
          { text: { bad: true } as never, votes: 4 },
          null as never,
        ]}
        totalVotes={-5 as never}
        votedIndex={null}
      />,
    );

    expect(screen.getByText("Untitled poll")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /first/i })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /first/i })).toHaveTextContent("First");
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.queryByText("[object Object]")).toBeNull();
    expect(screen.getByText("2 VOTES // TAP TO VOTE")).toBeTruthy();
  });

  it("falls back when poll data is unusable", () => {
    render(
      <PollMessage
        question="Broken poll"
        options={[null as never, { text: "", votes: 1 } as never, { text: "   ", votes: 0 } as never]}
        totalVotes={0}
        votedIndex={null}
      />,
    );

    expect(screen.getByText("Broken poll")).toBeTruthy();
    expect(screen.getByText("Poll data is unavailable.")).toBeTruthy();
  });

  it("still allows voting on normalized polls", () => {
    render(
      <PollMessage
        question="Choose"
        options={[
          { text: "Alpha", votes: 1 },
          { text: "Beta", votes: 3 },
        ]}
        totalVotes={4}
        votedIndex={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));

    expect(screen.getByText("5 VOTES // VOTED")).toBeTruthy();
    expect(screen.getByRole("button", { name: /alpha/i })).toHaveTextContent("40%");
  });
});
