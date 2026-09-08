import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatArea } from './ChatArea';
import { ContextMenuProvider } from './GlobalContextMenu';
import type { Message } from '@/types';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/hooks/runtime/useRuntimeMutations', () => ({
  useRuntimeMutations: () => ({ sendChannelMessage: send, sendDmMessage: send, searchNotifications: async () => [] }),
}));
vi.mock('@/protocol/client', async () => ({
  ...await vi.importActual<typeof import('@/protocol/client')>('@/protocol/client'),
  readBrowserChatActionSupport: () => ({ mode: 'native', detail: 'Local test transport', canAttemptAttachments: false }),
}));
vi.mock('@/native/state/mutations', async () => ({
  ...await vi.importActual<typeof import('@/native/state/mutations')>('@/native/state/mutations'),
  nativeStopTyping: vi.fn(), nativeNotifyTyping: vi.fn(),
}));
function view(id = 'composer-test', messages: Message[] = [], isDM = false) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
    <ContextMenuProvider><ChatArea channel={{ id, name: 'design-review', type: 'text', categoryId: 'cat' }} messages={messages} users={[]}
      mobileMenuOpen={false} onToggleMobileMenu={() => {}} onToggleMemberList={() => {}}
      isDM={isDM} messageLayout="modern" onToggleLayout={() => {}} hasIdentity /></ContextMenuProvider>
  </QueryClientProvider>;
}
function type(text: string) { fireEvent.change(screen.getByLabelText('Message Input'), { target: { value: text } }); }
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
describe('chat composer submission', () => {
  beforeEach(() => { send.mockReset(); });
  it('uses ordinary message wording and describes keyboard controls', () => {
    render(view());
    expect(screen.getByPlaceholderText('Message #design-review')).toBeInTheDocument();
    expect(screen.getByLabelText('Message Input')).toHaveAccessibleDescription(/Shift\+Enter/);
  });
  it('adapts to the actual short pane and restores normal sizing after resize', () => {
    render(view()); type('one\ntwo\nthree');
    const input = screen.getByLabelText('Message Input');
    const composer = input.closest<HTMLElement>('.chat-composer')!;
    const workspace = composer.parentElement!;
    const geometry = vi.spyOn(workspace, 'getBoundingClientRect');
    geometry.mockReturnValue({ height: 366 } as DOMRect);
    fireEvent(window, new Event('resize'));
    expect(composer).toHaveAttribute('data-short-viewport', 'true');
    expect(input).toHaveValue('one\ntwo\nthree');
    geometry.mockReturnValue({ height: 800 } as DOMRect);
    fireEvent(window, new Event('resize'));
    expect(composer).toHaveAttribute('data-short-viewport', 'false');
    expect(input).toHaveValue('one\ntwo\nthree');
    geometry.mockRestore();
  });
  it('does not send when Enter confirms an IME selection', () => {
    render(view()); type('こんにちは');
    fireEvent.keyDown(screen.getByLabelText('Message Input'), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(screen.getByLabelText('Message Input'), { key: 'Enter', keyCode: 229 });
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message Input')).toHaveValue('こんにちは');
  });
  it('coalesces repeated Enter and preserves edits while a send is pending', async () => {
    const pending = deferred(); send.mockReturnValue(pending.promise);
    render(view()); type('first draft');
    fireEvent.keyDown(screen.getByLabelText('Message Input'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByLabelText('Message Input'), { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Send Message' })).toBeDisabled();
    type('a new draft');
    await act(async () => { pending.resolve(); await pending.promise; });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send Message' })).not.toBeDisabled());
    expect(screen.getByLabelText('Message Input')).toHaveValue('a new draft');
  });
  it('preserves newer edits even when they return to the submitted text', async () => {
    const pending = deferred(); send.mockReturnValue(pending.promise);
    render(view()); type('repeat this');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    type(''); type('repeat this');
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(screen.getByLabelText('Message Input')).toHaveValue('repeat this');
  });
  it('preserves a reply cancelled and reselected during a pending send', async () => {
    const pending = deferred(); send.mockReturnValue(pending.promise);
    render(view('reply-test', [{ id: 'source', userId: 'peer', content: 'Reply source', timestamp: '09:24' }]));
    const selectReply = () => {
      fireEvent.contextMenu(screen.getByText('Reply source'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
    };
    selectReply(); type('pending reply');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
    selectReply();
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(screen.getByRole('button', { name: 'Cancel reply' })).toBeInTheDocument();
  });
  it('clears only an unchanged draft after successful submission', async () => {
    send.mockResolvedValue(undefined); render(view()); type('hello');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await waitFor(() => expect(screen.getByLabelText('Message Input')).toHaveValue(''));
  });
  it('preserves a failed draft without exposing raw diagnostics', async () => {
    const pending = deferred(); send.mockReturnValue(pending.promise);
    render(view()); type('private draft');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    type('new text while waiting');
    await act(async () => { pending.reject(new Error('bearer=SECRET /home/user/private')); await pending.promise.catch(() => {}); });
    expect(screen.getByLabelText('Message Input')).toHaveValue('new text while waiting');
    expect(screen.getByText(/Your current draft is unchanged/)).toBeInTheDocument();
    expect(screen.queryByText(/bearer=SECRET/)).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Unsent message' })).getByText('private draft')).toBeInTheDocument();
    const recovery = screen.getByRole('region', { name: 'Unsent message' });
    expect(recovery.closest('.chat-message-list')).not.toBeNull();
    expect(recovery.closest('.chat-composer')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send Message' })).toBeDisabled();
  });
  it('ignores a failed submission after changing conversations', async () => {
    const pending = deferred(); send.mockReturnValue(pending.promise);
    const mounted = render(view()); type('old conversation');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    mounted.rerender(view('other')); type('current conversation');
    await act(async () => { pending.reject(new Error('old failure')); await pending.promise.catch(() => {}); });
    expect(screen.getByLabelText('Message Input')).toHaveValue('current conversation');
    expect(screen.queryByText(/Your current draft is unchanged/)).toBeNull();
  });
});

describe('recoverable unsent messages', () => {
  beforeEach(() => { send.mockReset(); });
  it.each([false, true])('retries the original request without overwriting a newer draft (DM: %s)', async (isDM) => {
    const pending = deferred(); send.mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    render(view('retry-scope', [], isDM)); type('first message');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    type('second message');
    await act(async () => { pending.reject(new Error('network detail')); await pending.promise.catch(() => {}); });
    expect(screen.getByRole('region', { name: 'Unsent message' })).toHaveTextContent('first message');
    const firstArgs = send.mock.calls[0];
    fireEvent.click(screen.getByRole('button', { name: 'Retry unsent message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]).toEqual(firstArgs);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unsent message' })).toBeNull());
    expect(screen.getByLabelText('Message Input')).toHaveValue('second message');
    expect(screen.getByRole('button', { name: 'Send Message' })).toBeEnabled();
  });
  it('keeps the original reply target and does not clear a newer selection on retry', async () => {
    const pending = deferred(); send.mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const messages = ['First target', 'Second target'].map((content, i) => ({ id: `target-${i}`, userId: 'peer', content, timestamp: '09:24' }));
    render(view('retry-reply', messages));
    const reply = (text: string) => {
      fireEvent.contextMenu(screen.getByText(text));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
    };
    reply('First target'); type('failed reply');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
    reply('Second target'); type('new reply');
    await act(async () => { pending.reject(new Error('failure')); await pending.promise.catch(() => {}); });
    fireEvent.click(screen.getByRole('button', { name: 'Retry unsent message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(send.mock.calls[1][2]).toEqual({ reply_to: 'target-0' });
    expect(screen.getByRole('button', { name: 'Cancel reply' })).toBeInTheDocument();
    expect(screen.getByLabelText('Message Input')).toHaveValue('new reply');
  });
  it('retains only one failure and coalesces repeated retry while pending', async () => {
    const retry = deferred(); send.mockRejectedValueOnce(new Error('first failure')).mockReturnValueOnce(retry.promise);
    render(view()); type('original');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await screen.findByRole('region', { name: 'Unsent message' });
    type('new draft');
    fireEvent.keyDown(screen.getByLabelText('Message Input'), { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    const button = screen.getByRole('button', { name: 'Retry unsent message' });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Discard unsent message' })).toBeDisabled();
    await act(async () => { retry.reject(new Error('retry failed')); await retry.promise.catch(() => {}); });
    expect(screen.getAllByRole('region', { name: 'Unsent message' })).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Unsent message' })).toHaveTextContent('original');
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsent message' }));
    expect(screen.queryByRole('region', { name: 'Unsent message' })).toBeNull();
    expect(screen.getByLabelText('Message Input')).toHaveValue('new draft');
    expect(screen.getByLabelText('Message Input')).toHaveFocus();
  });
  it('clears an untouched original draft after its retry succeeds', async () => {
    send.mockRejectedValueOnce(new Error('failure')).mockResolvedValue(undefined);
    render(view()); type('retry me');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await screen.findByRole('region', { name: 'Unsent message' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry unsent message' }));
    await waitFor(() => expect(screen.getByLabelText('Message Input')).toHaveValue(''));
  });
  it('does not persist recovery content and releases it when leaving the conversation', async () => {
    send.mockRejectedValue(new Error('failure'));
    const mounted = render(view()); type('PRIVATE-FAILED-PAYLOAD');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await screen.findByRole('region', { name: 'Unsent message' });
    expect(JSON.stringify(localStorage)).not.toContain('PRIVATE-FAILED-PAYLOAD');
    expect(JSON.stringify(sessionStorage)).not.toContain('PRIVATE-FAILED-PAYLOAD');
    mounted.rerender(view('elsewhere')); type('current draft');
    expect(screen.queryByRole('region', { name: 'Unsent message' })).toBeNull();
    expect(document.body.textContent).not.toContain('PRIVATE-FAILED-PAYLOAD');
  });
});
