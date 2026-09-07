import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatArea } from './ChatArea';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/hooks/runtime/useRuntimeMutations', () => ({
  useRuntimeMutations: () => ({ sendChannelMessage: send, searchNotifications: async () => [] }),
}));
vi.mock('@/protocol/client', async () => ({
  ...await vi.importActual<typeof import('@/protocol/client')>('@/protocol/client'),
  readBrowserChatActionSupport: () => ({ mode: 'native', detail: 'Local test transport', canAttemptAttachments: false }),
}));
vi.mock('@/native/state/mutations', async () => ({
  ...await vi.importActual<typeof import('@/native/state/mutations')>('@/native/state/mutations'),
  nativeStopTyping: vi.fn(), nativeNotifyTyping: vi.fn(),
}));
function view(id = 'composer-test') {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
    <ChatArea channel={{ id, name: 'design-review', type: 'text', categoryId: 'cat' }} messages={[]} users={[]}
      mobileMenuOpen={false} onToggleMobileMenu={() => {}} onToggleMemberList={() => {}}
      isDM={false} messageLayout="modern" onToggleLayout={() => {}} hasIdentity />
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
    expect(screen.getByText(/Your draft is still here/)).toBeInTheDocument();
    expect(screen.queryByText(/bearer=SECRET/)).toBeNull();
  });
  it('ignores a failed submission after changing conversations', async () => {
    const pending = deferred(); send.mockReturnValue(pending.promise);
    const mounted = render(view()); type('old conversation');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    mounted.rerender(view('other')); type('current conversation');
    await act(async () => { pending.reject(new Error('old failure')); await pending.promise.catch(() => {}); });
    expect(screen.getByLabelText('Message Input')).toHaveValue('current conversation');
    expect(screen.queryByText(/Your draft is still here/)).toBeNull();
  });
});
