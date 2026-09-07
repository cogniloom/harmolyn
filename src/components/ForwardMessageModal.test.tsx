import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(onClose).not.toHaveBeenCalled();
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

const destinations = [{ id: 'design', label: 'design', sublabel: 'Studio', type: 'channel' as const }];

describe('forward admission and focus', () => {
  it('preserves the note and selection when a stale prop admits a parent-rejected send', async () => {
    const onForward = vi.fn(), onClose = vi.fn();
    const user = userEvent.setup();
    render(<ForwardMessageModal messageContent="source" destinations={destinations} onForward={onForward} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /design.*Studio/ }));
    await user.type(screen.getByLabelText('Forwarding note'), 'Keep my note');
    await user.click(screen.getByRole('button', { name: /forward \(1\)/i }));
    expect(onForward).toHaveBeenCalledWith(destinations, 'Keep my note');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Forwarding note')).toHaveValue('Keep my note');
    expect(screen.getByRole('button', { name: 'Remove design' })).toBeInTheDocument();
  });

  it('lets the real owner dismiss an accepted batch exactly once', async () => {
    const accepted = vi.fn(), dismissed = vi.fn();
    function Owner() {
      const [open, setOpen] = useState(true);
      return open ? <ForwardMessageModal messageContent="source" destinations={destinations}
        onForward={() => { accepted(); setOpen(false); }} onClose={dismissed} /> : <p>Forward accepted</p>;
    }
    const user = userEvent.setup(); render(<Owner />);
    await user.click(screen.getByRole('button', { name: /design.*Studio/ }));
    await user.click(screen.getByRole('button', { name: /forward \(1\)/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(accepted).toHaveBeenCalledTimes(1); expect(dismissed).not.toHaveBeenCalled();
  });

  it('coalesces repeated activations and sanitizes an async callback rejection', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, no) => { reject = no; });
    const onForward = vi.fn(() => pending), onClose = vi.fn();
    render(<ForwardMessageModal messageContent="source" destinations={destinations} onForward={onForward} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /design.*Studio/ }));
    fireEvent.change(screen.getByLabelText('Forwarding note'), { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByRole('button', { name: /forward \(1\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /forward \(1\)/i }));
    expect(onForward).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error('private-token=secret')); await pending.catch(() => {}); });
    expect(screen.getByRole('alert')).toHaveTextContent('Your selections and note are still here');
    expect(screen.queryByText(/private-token/)).toBeNull();
    expect(screen.getByLabelText('Forwarding note')).toHaveValue('Keep me');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps keyboard focus contained and restores the opener after dismissal', async () => {
    const user = userEvent.setup();
    function Owner() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open forwarding</button>{open &&
        <ForwardMessageModal messageContent="source" destinations={destinations} onForward={() => {}} onClose={() => setOpen(false)} />}</>;
    }
    render(<Owner />); const opener = screen.getByRole('button', { name: 'Open forwarding' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    for (let i = 0; i < 10; i++) { await user.tab(); expect(dialog.contains(document.activeElement)).toBe(true); }
    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
  });

  it('normalizes padded and whitespace-only destination searches', async () => {
    const user = userEvent.setup();
    render(<ForwardMessageModal messageContent="source" destinations={destinations} onForward={() => {}} onClose={() => {}} />);
    const search = screen.getByLabelText('Search channels and DMs');
    await user.type(search, '  design  ');
    expect(screen.getByRole('button', { name: /design.*Studio/ })).toBeInTheDocument();
    await user.clear(search); await user.type(search, '   ');
    expect(screen.getByRole('button', { name: /design.*Studio/ })).toBeInTheDocument();
  });
});
