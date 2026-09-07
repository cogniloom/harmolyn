import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatArea } from './ChatArea';
import { ContextMenuProvider } from './GlobalContextMenu';
import type { Message } from '@/types';

const mocks = vi.hoisted(() => ({
  send: vi.fn(), upload: vi.fn(), offline: false,
  poll: null as null | ((question: string, options: string[]) => void),
  sticker: null as null | ((content: string) => void),
  forward: null as null | ((destinations: { id: string; label: string; sublabel: string; type: 'channel' }[], note: string) => void),
  thread: null as null | ((content: string) => void),
}));
vi.mock('@/hooks/useFeature', () => ({ useFeature: (name: string) => ['polls', 'stickers', 'fileUploads', 'messageForwarding', 'threads'].includes(name) }));
vi.mock('@/hooks/runtime/useRuntimeMutations', () => ({
  useRuntimeMutations: () => ({ sendChannelMessage: mocks.send, sendDmMessage: mocks.send, searchNotifications: async () => [] }),
}));
vi.mock('@/protocol/client', async () => ({
  ...await vi.importActual<typeof import('@/protocol/client')>('@/protocol/client'),
  readBrowserChatActionSupport: () => ({ mode: mocks.offline ? 'offline' : 'native', detail: 'Test transport', canAttemptAttachments: !mocks.offline }),
}));
vi.mock('@/native/state/mutations', async () => ({
  ...await vi.importActual<typeof import('@/native/state/mutations')>('@/native/state/mutations'),
  nativeStopTyping: vi.fn(), nativeNotifyTyping: vi.fn(),
}));
vi.mock('@/native/blobs/blobs', async () => ({
  ...await vi.importActual<typeof import('@/native/blobs/blobs')>('@/native/blobs/blobs'),
  uploadEncryptedAttachment: mocks.upload,
}));
vi.mock('./PollCreator', () => ({ PollCreator: (props: { onSubmit: typeof mocks.poll; sendDisabledReason?: string }) => {
  mocks.poll = props.onSubmit; return <output data-testid="poll-lock">{props.sendDisabledReason}</output>;
} }));
vi.mock('./StickerPicker', () => ({ StickerPicker: (props: { onSelect: typeof mocks.sticker }) => {
  mocks.sticker = props.onSelect; return <div>Sticker choices</div>;
} }));
vi.mock('./ForwardMessageModal', () => ({ ForwardMessageModal: (props: { onForward: typeof mocks.forward; sendDisabledReason?: string }) => {
  mocks.forward = props.onForward; return <output data-testid="forward-lock">{props.sendDisabledReason}</output>;
} }));
vi.mock('./ThreadPanel', () => ({ ThreadPanel: (props: { onSend: typeof mocks.thread; sendDisabledReason?: string }) => {
  mocks.thread = props.onSend; return <output data-testid="thread-lock">{props.sendDisabledReason}</output>;
} }));
beforeEach(() => { mocks.offline = false; });
const messages: Message[] = [{ id: 'source', userId: 'peer', content: 'Source message', timestamp: '09:24' }];
const actions = ['attachment', 'poll', 'sticker', 'forward', 'thread'] as const;
type Action = typeof actions[number];
function view(id = 'send-lock', isDM = false) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
    <ContextMenuProvider><ChatArea channel={{ id, name: 'general', type: 'text', categoryId: 'cat' }} messages={messages} users={[]}
      mobileMenuOpen={false} onToggleMobileMenu={() => {}} onToggleMemberList={() => {}} isDM={isDM}
      messageLayout="modern" onToggleLayout={() => {}} hasIdentity /></ContextMenuProvider>
  </QueryClientProvider>;
}
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function draft(value: string) { fireEvent.change(screen.getByLabelText('Message Input'), { target: { value } }); }
function open(action: Action) {
  if (action === 'poll') fireEvent.click(screen.getByRole('button', { name: 'Create Poll' }));
  if (action === 'sticker') fireEvent.click(screen.getByRole('button', { name: 'Stickers' }));
  if (action === 'forward' || action === 'thread') {
    fireEvent.contextMenu(screen.getByText('Source message'));
    fireEvent.click(screen.getByRole('menuitem', { name: action === 'forward' ? 'Forward Message' : 'Create Thread' }));
  }
}
function attempt(action: Action, container: HTMLElement) {
  if (action === 'attachment') fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['bytes'], 'note.txt', { type: 'text/plain' })] } });
  if (action === 'poll') mocks.poll!('Question?', ['Yes', 'No']);
  if (action === 'sticker') mocks.sticker!('sticker');
  if (action === 'forward') mocks.forward!([{ id: 'send-lock', label: 'general', sublabel: '', type: 'channel' }], '');
  if (action === 'thread') mocks.thread!('Thread reply');
}

describe('one send order across every conversation action', () => {
  beforeEach(() => { mocks.send.mockReset(); mocks.upload.mockReset(); mocks.poll = null; mocks.sticker = null; mocks.forward = null; mocks.thread = null; });
  it.each(actions)('blocks %s callbacks during a pending send and recovery, then re-enables after discard', async (action) => {
    const pending = deferred(); mocks.send.mockReturnValue(pending.promise);
    const { container } = render(view()); open(action); draft('first');
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    draft('new draft');
    await act(async () => { attempt(action, container); });
    expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.upload).not.toHaveBeenCalled();
    await act(async () => { pending.reject(new Error('private diagnostic')); await pending.promise.catch(() => {}); });
    expect(screen.getByRole('region', { name: 'Unsent message' })).toHaveTextContent('first');
    await act(async () => { attempt(action, container); });
    expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.upload).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message Input')).toHaveValue('new draft');
    for (const label of ['Create Poll', 'Stickers', 'Add attachment']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
    if (action === 'poll' || action === 'forward' || action === 'thread') expect(screen.getByTestId(`${action}-lock`)).toHaveTextContent(/Retry or discard/);
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsent message' }));
    expect(screen.getByRole('button', { name: 'Create Poll' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send Message' })).not.toBeDisabled();
  });
});

const attachment = { id: 'encrypted-file', name: 'note.txt', size: 5, mime: 'text/plain', key: 'fixture-key' };
describe('auxiliary send lifetimes', () => {
  beforeEach(() => { mocks.send.mockReset(); mocks.upload.mockReset(); });
  it.each(['poll', 'sticker', 'thread'] as const)('retains a failed %s for exact retry without clearing the main draft', async (action) => {
    const pending = deferred(); mocks.send.mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const { container } = render(view()); draft('unrelated draft'); open(action);
    await act(async () => { attempt(action, container); });
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByLabelText('Message Input'), { key: 'Enter' });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const request = mocks.send.mock.calls[0];
    await act(async () => { pending.reject(new Error('do not show token=SECRET')); await pending.promise.catch(() => {}); });
    expect(screen.getByRole('region', { name: 'Unsent message' })).toBeInTheDocument();
    expect(screen.queryByText(/token=SECRET/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry unsent message' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unsent message' })).toBeNull());
    expect(mocks.send.mock.calls[1]).toEqual(request);
    expect(screen.getByLabelText('Message Input')).toHaveValue('unrelated draft');
  });
  it('reserves the slot before a file is read, holds it during encryption, and retries the same descriptor', async () => {
    const encrypting = deferred<typeof attachment>(), sending = deferred();
    mocks.upload.mockReturnValue(encrypting.promise);
    mocks.send.mockReturnValueOnce(sending.promise).mockResolvedValue(undefined);
    const { container } = render(view()); draft('next text');
    attempt('attachment', container);
    fireEvent.keyDown(screen.getByLabelText('Message Input'), { key: 'Enter' });
    expect(mocks.send).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Add attachment' })).toBeDisabled();
    await act(async () => { encrypting.resolve(attachment); });
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    const request = mocks.send.mock.calls[0];
    expect(request).toContainEqual({ media: [attachment] });
    await act(async () => { sending.reject(new Error('send failed')); await sending.promise.catch(() => {}); });
    fireEvent.click(screen.getByRole('button', { name: 'Retry unsent message' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unsent message' })).toBeNull());
    expect(mocks.send.mock.calls[1]).toEqual(request);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Message Input')).toHaveValue('next text');
  });
  it('drops a late encrypted upload after navigation without sending under the new conversation', async () => {
    const encrypting = deferred<typeof attachment>(); mocks.upload.mockReturnValue(encrypting.promise);
    const mounted = render(view()); attempt('attachment', mounted.container);
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    mounted.rerender(view('another-conversation')); draft('new conversation draft');
    await act(async () => { encrypting.resolve(attachment); });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message Input')).toHaveValue('new conversation draft');
    expect(screen.getByRole('button', { name: 'Send Message' })).not.toBeDisabled();
  });
  it('releases a failed file preparation without exposing diagnostics or stranding the composer', async () => {
    mocks.upload.mockRejectedValue(new Error('file:///private/key?secret=hidden'));
    const { container } = render(view()); draft('keep this'); attempt('attachment', container);
    await waitFor(() => expect(screen.getByText(/attachment could not be prepared/)).toBeInTheDocument());
    expect(screen.queryByText(/secret=hidden/)).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send Message' })).not.toBeDisabled();
    expect(screen.getByLabelText('Message Input')).toHaveValue('keep this');
  });
  it('keeps bulk forwarding exclusive between destinations and stops when the scope changes', async () => {
    const pending = deferred(); mocks.send.mockReturnValue(pending.promise);
    const mounted = render(view()); open('forward'); draft('next message');
    await act(async () => { mocks.forward!([
      { id: 'first', label: 'first', sublabel: '', type: 'channel' },
      { id: 'second', label: 'second', sublabel: '', type: 'channel' },
    ], 'note'); });
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByLabelText('Message Input'), { key: 'Enter' });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    mounted.rerender(view('new-scope'));
    await act(async () => { pending.resolve(); });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Forwarded to/)).toBeNull();
  });
});


describe('stale action and offline guards', () => {
  beforeEach(() => { mocks.send.mockReset(); mocks.upload.mockReset(); });
  it.each(['poll', 'sticker', 'forward', 'thread'] as const)('rejects a captured %s callback after changing scope', async (action) => {
    const mounted = render(view()); open(action);
    const captured = { poll: mocks.poll, sticker: mocks.sticker, forward: mocks.forward, thread: mocks.thread };
    const trigger = () => {
      if (action === 'poll') captured.poll!('Question?', ['One', 'Two']);
      if (action === 'sticker') captured.sticker!('sticker');
      if (action === 'thread') captured.thread!('reply');
      if (action === 'forward') captured.forward!([{ id: 'send-lock', label: 'general', sublabel: '', type: 'channel' }], '');
    };
    mounted.rerender(view('other-scope')); draft('stay here');
    await act(async () => { trigger(); });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message Input')).toHaveValue('stay here');
  });
  it.each(['poll', 'thread'] as const)('keeps an offline %s editor open instead of silently dropping its submission', async (action) => {
    mocks.offline = true;
    const mounted = render(view()); open(action);
    await act(async () => { attempt(action, mounted.container); });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(screen.getByTestId(`${action}-lock`)).toHaveTextContent(/Reconnect/);
  });
});
