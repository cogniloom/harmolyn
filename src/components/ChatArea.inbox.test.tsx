import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatArea } from './ChatArea';
import type { Channel, Message, User } from '@/types';

const { searchNotificationsMock, markNotificationsReadMock, shellData } = vi.hoisted(() => ({
  searchNotificationsMock: vi.fn(),
  markNotificationsReadMock: vi.fn(),
  shellData: {
    runtimeSnapshot: {
      identity: { peer_id: 'me' },
      servers: [],
      directMessages: [],
      users: [],
    },
    sessionSnapshot: null,
    currentUser: { id: 'me', username: 'me', avatar: '', status: 'online' },
    users: [],
    servers: [],
    directMessages: [],
    messages: [],
    messagesByScope: new Map(),
    defaultChannelByServer: new Map(),
    initialServerId: 'home',
    initialChannelId: '',
  },
}));

vi.mock('@/data', async () => {
  const actual = await vi.importActual<typeof import('@/data')>('@/data');
  return {
    ...actual,
    readShellRuntimeData: () => shellData,
    subscribeShellRuntimeData: () => () => undefined,
  };
});

vi.mock('@/protocol/client', () => ({
  readBrowserChatActionSupport: () => ({
    mode: 'connected',
    detail: 'connected',
    canAttemptAttachments: true,
    canPersistLocally: true,
  }),
  readPersistedChatScopeState: () => ({
    nickname: '',
    mutedUserIds: [],
    inboxReadIds: [],
    deletedMessageIds: [],
    messages: [],
    threads: {},
  }),
  writePersistedChatScopeState: () => {},
}));

vi.mock('@/hooks/useFeature', () => ({
  useFeature: (key: string) => key === 'inbox',
}));

vi.mock('@/hooks/runtime/mutations', () => ({
  useSendChannelMessage: () => ({ mutateAsync: vi.fn() }),
  useSendDmMessage: () => ({ mutateAsync: vi.fn() }),
  useEditMessage: () => ({ mutateAsync: vi.fn() }),
  useDeleteMessage: () => ({ mutateAsync: vi.fn() }),
  useAddReaction: () => ({ mutateAsync: vi.fn() }),
  useRemoveReaction: () => ({ mutateAsync: vi.fn() }),
  usePinMessage: () => ({ mutateAsync: vi.fn() }),
  useUnpinMessage: () => ({ mutateAsync: vi.fn() }),
  useCastPollVote: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useSetPeerVerified: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useSubmitReport: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock('@/lib/xoreinControl', async () => {
  const actual = await vi.importActual<typeof import('@/lib/xoreinControl')>('@/lib/xoreinControl');
  return {
    ...actual,
    searchNotifications: searchNotificationsMock,
    markNotificationsRead: markNotificationsReadMock,
  };
});

const channel: Channel = { id: 'ch-1', name: 'general', type: 'text', categoryId: 'cat-1' };
const messages: Message[] = [
  { id: 'm1', userId: 'u1', content: 'hello @me', timestamp: '2026-01-01T00:00:00Z' },
];
const users: User[] = [
  { id: 'u1', username: 'Nova', avatar: '/avatar.png', status: 'online' },
];

describe('ChatArea inbox', () => {
  beforeEach(() => {
    searchNotificationsMock.mockReset();
    searchNotificationsMock.mockResolvedValue([
      { id: 'n1', type: 'mention', scope_type: 'channel', scope_id: 'ch-1', message_id: 'm1', read: false, created_at: '2026-01-01T00:00:00Z' },
    ]);
    markNotificationsReadMock.mockReset();
    markNotificationsReadMock.mockResolvedValue({ scope_id: 'ch-1', scope_type: 'channel', read_through_message_id: 'm1' });
  });

  it('loads inbox notifications from xorein and marks them read on jump', async () => {
    const user = userEvent.setup();
    render(
      <ChatArea
        channel={channel}
        messages={messages}
        users={users}
        mobileMenuOpen={false}
        onToggleMobileMenu={() => {}}
        onToggleMemberList={() => {}}
        isDM={false}
        messageLayout="modern"
        onToggleLayout={() => {}}
        bgSeed="seed"
        setBgSeed={() => {}}
      />,
    );

    await waitFor(() => expect(searchNotificationsMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ scope_type: 'channel', scope_id: 'ch-1', unread_only: true }),
    ));

    await user.click(screen.getByRole('button', { name: /inbox/i }));
    await user.click(screen.getByRole('button', { name: /nova/i }));

    expect(markNotificationsReadMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ read_through_message_id: 'm1', scope_type: 'channel', scope_id: 'ch-1' }),
    );
  });
});
