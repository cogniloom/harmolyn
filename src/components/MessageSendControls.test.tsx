import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PollCreator } from './PollCreator';
import { ForwardMessageModal } from './ForwardMessageModal';
import { ThreadPanel } from './ThreadPanel';

const reason = 'Retry or discard the unsent message first.';
const parent = { id: 'parent', userId: 'peer', content: 'Parent message', timestamp: '12:34' };
const author = { id: 'peer', username: 'Peer', avatar: '', status: 'online' as const };

describe('send controls preserve editable data while another message is unresolved', () => {
  it('keeps poll fields editable but refuses submission until recovery is resolved', async () => {
    const user = userEvent.setup(), submit = vi.fn();
    const view = (disabled?: string) => <PollCreator onSubmit={submit} onClose={() => {}} sendDisabledReason={disabled} />;
    const mounted = render(view());
    await user.type(screen.getByLabelText('QUESTION'), 'Question?');
    await user.type(screen.getByLabelText('Option 1'), 'One');
    await user.type(screen.getByLabelText('Option 2'), 'Two');
    mounted.rerender(view(reason));
    const send = screen.getByRole('button', { name: /Create Poll/i });
    expect(send).toBeDisabled();
    await user.click(send);
    expect(submit).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('QUESTION'), ' Updated');
    mounted.rerender(view());
    await user.click(send);
    expect(submit).toHaveBeenCalledWith('Question? Updated', ['One', 'Two']);
  });
  it('keeps forwarding selection and note without closing when sending is blocked', async () => {
    const user = userEvent.setup(), forward = vi.fn(), close = vi.fn();
    const destination = { id: 'room', type: 'channel' as const, label: 'general', sublabel: 'Space' };
    const view = (disabled?: string) => <ForwardMessageModal messageContent="Original" destinations={[destination]}
      onForward={forward} onClose={close} sendDisabledReason={disabled} />;
    const mounted = render(view());
    await user.click(screen.getByRole('button', { name: /general/i }));
    await user.type(screen.getByPlaceholderText(/Add a note/i), 'My note');
    mounted.rerender(view(reason));
    const send = screen.getByRole('button', { name: /Forward \(1\)/i });
    expect(send).toBeDisabled();
    await user.click(send);
    expect(forward).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    mounted.rerender(view()); await user.click(send);
    expect(forward).toHaveBeenCalledWith([destination], 'My note');
  });
  it('preserves a thread draft during lock and rejects IME Enter as a send action', async () => {
    const user = userEvent.setup(), send = vi.fn();
    const view = (disabled?: string) => <ThreadPanel parentMessage={parent} parentUser={author} allUsers={[]}
      replies={[]} onSend={send} onClose={() => {}} sendDisabledReason={disabled} />;
    const mounted = render(view(reason));
    const input = screen.getByPlaceholderText('REPLY // THREAD');
    await user.type(input, 'Unsent reply'); await user.keyboard('{Enter}');
    expect(send).not.toHaveBeenCalled(); expect(input).toHaveValue('Unsent reply');
    mounted.rerender(view());
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(send).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(send).toHaveBeenCalledWith('Unsent reply'); expect(input).toHaveValue('');
  });
  it('does not clear a thread draft rejected synchronously by its parent guard', () => {
    render(<ThreadPanel parentMessage={parent} parentUser={author} allUsers={[]} replies={[]}
      onSend={() => false} onClose={() => {}} />);
    const input = screen.getByPlaceholderText('REPLY // THREAD');
    fireEvent.change(input, { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Reply' }));
    expect(input).toHaveValue('Keep me');
  });
});
