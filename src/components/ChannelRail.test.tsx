import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { ChannelRail } from './ChannelRail';
import type { ConnectionState, Server, User } from '@/types';

// ChannelRail uses react-query (useCreateChannel/useUpdatePresence), so every render
// must be wrapped in a QueryClientProvider or the hooks throw "No QueryClient set".
function renderRail(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

const updatePresenceMutateAsync = vi.fn();

vi.mock('@/hooks/useFeature', () => ({
  useFeature: () => false,
}));

vi.mock('@/hooks/runtime/mutations', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/runtime/mutations')>('@/hooks/runtime/mutations');
  return {
    ...actual,
    useUpdatePresence: () => ({ mutateAsync: updatePresenceMutateAsync }),
  };
});

vi.mock('@/components/AccountSwitcher', () => ({
  AccountSwitcher: () => null,
}));

vi.mock('@/components/voice/VoiceControlBar', () => ({
  VoiceControlBar: () => null,
}));

const currentUser: User = {
  id: 'neo',
  username: 'Neo',
  avatar: 'https://example.com/avatar.png',
  status: 'online',
};

const connectionState: ConnectionState = {
  status: 'connected',
  label: 'Connected',
  detail: 'Connected',
  canUseConnectivityActions: true,
};

describe('ChannelRail status picker', () => {
  beforeEach(() => {
    updatePresenceMutateAsync.mockReset();
    updatePresenceMutateAsync.mockResolvedValue(undefined);
  });

  it('publishes status changes through xorein', async () => {
    const user = userEvent.setup();
    renderRail(
      <ChannelRail
        activeChannelId="c1"
        currentUser={currentUser}
        users={[currentUser]}
        directMessages={[]}
        connectionState={connectionState}
        connectedVoiceChannelId={null}
        collapsed={false}
        onToggleCollapse={() => {}}
        onSelectChannel={() => {}}
        onJoinVoice={() => {}}
        onOpenSettings={() => {}}
        isHome
      />,
    );

    await user.click(screen.getByRole('button', { name: /set status/i }));
    await user.click(screen.getByRole('button', { name: /do not disturb/i }));

    await waitFor(() => expect(updatePresenceMutateAsync).toHaveBeenCalledWith({
      status: 'dnd',
      statusText: undefined,
    }));
  });

  it('publishes custom status text through xorein', async () => {
    const user = userEvent.setup();
    renderRail(
      <ChannelRail
        activeChannelId="c1"
        currentUser={currentUser}
        users={[currentUser]}
        directMessages={[]}
        connectionState={connectionState}
        connectedVoiceChannelId={null}
        collapsed={false}
        onToggleCollapse={() => {}}
        onSelectChannel={() => {}}
        onJoinVoice={() => {}}
        onOpenSettings={() => {}}
        isHome
      />,
    );

    await user.click(screen.getByRole('button', { name: /set status/i }));
    const input = screen.getByPlaceholderText(/set a custom status/i);
    await user.type(input, 'heads down{enter}');

    await waitFor(() => expect(updatePresenceMutateAsync).toHaveBeenCalledWith({
      status: 'online',
      statusText: 'heads down',
    }));
  });

  it('surfaces presence update failures in the footer', async () => {
    const user = userEvent.setup();
    updatePresenceMutateAsync.mockRejectedValueOnce(new Error('presence unavailable'));

    renderRail(
      <ChannelRail
        activeChannelId="c1"
        currentUser={currentUser}
        users={[currentUser]}
        directMessages={[]}
        connectionState={connectionState}
        connectedVoiceChannelId={null}
        collapsed={false}
        onToggleCollapse={() => {}}
        onSelectChannel={() => {}}
        onJoinVoice={() => {}}
        onOpenSettings={() => {}}
        isHome
      />,
    );

    await user.click(screen.getByRole('button', { name: /set status/i }));
    await user.click(screen.getByRole('button', { name: /do not disturb/i }));

    expect(await screen.findByRole('status')).toHaveTextContent('presence unavailable');
  });

  it('normalizes malformed rail users before rendering the footer and DMs', () => {
    renderRail(
      <ChannelRail
        activeChannelId="dm-1"
        currentUser={{
          id: 'neo',
          username: { bad: true },
          avatar: 42,
          status: 'online',
        } as never}
        users={[
          {
            id: 'friend',
            username: { bad: true },
            avatar: 42,
            status: 'online',
          } as never,
        ]}
        directMessages={[{ id: 'dm-1', userId: 'friend', lastMessage: 'hello' }]}
        connectionState={connectionState}
        connectedVoiceChannelId={null}
        collapsed={false}
        onToggleCollapse={() => {}}
        onSelectChannel={() => {}}
        onJoinVoice={() => {}}
        onOpenSettings={() => {}}
        isHome
      />,
    );

    // The footer now reflects the authoritative runtime identity; with no identity
    // in context the user is a read-only guest. The malformed DM user still renders.
    expect(screen.getByText('Guest')).toBeInTheDocument();
    expect(screen.getByText('friend')).toBeInTheDocument();
  });

  it('normalizes and dedupes direct messages before rendering the home rail', () => {
    renderRail(
      <ChannelRail
        activeChannelId="dm-1"
        currentUser={currentUser}
        users={[currentUser, currentUser]}
        directMessages={[
          { id: 'dm-1', userId: 'neo', lastMessage: 'first', unreadCount: 1 },
          { id: 'dm-1', userId: 'neo', lastMessage: 'second', unreadCount: 5 },
          { id: '   ', userId: { bad: true } as never, lastMessage: 'bad' } as never,
        ]}
        connectionState={connectionState}
        connectedVoiceChannelId={null}
        collapsed={false}
        onToggleCollapse={() => {}}
        onSelectChannel={() => {}}
        onJoinVoice={() => {}}
        onOpenSettings={() => {}}
        isHome
      />,
    );

    expect(screen.getAllByRole('button', { name: /neo/i })).toHaveLength(1);
    expect(screen.queryByText('second')).toBeNull();
    expect(screen.queryByText('bad')).toBeNull();
  });

  it('keeps the first normalized user when duplicate ids appear in the DM lookup list', () => {
    renderRail(
      <ChannelRail
        activeChannelId="dm-1"
        currentUser={currentUser}
        users={[
          { id: 'friend', username: 'Alpha Friend', avatar: '/alpha.png', status: 'online' },
          { id: 'friend', username: 'Beta Friend', avatar: '/beta.png', status: 'idle' },
        ]}
        directMessages={[
          { id: 'dm-1', userId: 'friend', lastMessage: 'hello' },
        ]}
        connectionState={connectionState}
        connectedVoiceChannelId={null}
        collapsed={false}
        onToggleCollapse={() => {}}
        onSelectChannel={() => {}}
        onJoinVoice={() => {}}
        onOpenSettings={() => {}}
        isHome
      />,
    );

    expect(screen.getByText('Alpha Friend')).toBeInTheDocument();
    expect(screen.queryByText('Beta Friend')).toBeNull();
  });

  it('renders unresolved direct messages with an explicit placeholder', () => {
    renderRail(
      <ChannelRail
        activeChannelId="dm-missing"
        currentUser={currentUser}
        users={[]}
        directMessages={[
          { id: 'dm-missing', userId: 'missing-peer', lastMessage: 'mystery dm' },
        ]}
        connectionState={connectionState}
        connectedVoiceChannelId={null}
        collapsed={false}
        onToggleCollapse={() => {}}
        onSelectChannel={() => {}}
        onJoinVoice={() => {}}
        onOpenSettings={() => {}}
        isHome
      />,
    );

    expect(screen.getByText('Unknown User')).toBeInTheDocument();
    expect(screen.getByText('mystery dm')).toBeInTheDocument();
  });

  it('collapses and expands a category via its chevron toggle', async () => {
    const user = userEvent.setup();
    const server: Server = {
      id: 'srv',
      name: 'Test Server',
      icon: '',
      ownerId: 'neo',
      members: [currentUser],
      categories: [
        {
          id: 'cat-1',
          name: 'General',
          channels: [
            { id: 'chan-1', name: 'lobby', type: 'text', categoryId: 'cat-1' },
          ],
        },
      ],
    };

    renderRail(
      <ChannelRail
        server={server}
        activeChannelId="chan-1"
        currentUser={currentUser}
        users={[currentUser]}
        directMessages={[]}
        connectionState={connectionState}
        connectedVoiceChannelId={null}
        collapsed={false}
        onToggleCollapse={() => {}}
        onSelectChannel={() => {}}
        onJoinVoice={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    const toggle = screen.getByRole('button', { name: /collapse general/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // While expanded, the channel list wrapper is not hidden.
    const listWhenOpen = screen.getByText('lobby').closest('div.space-y-0\\.5');
    expect(listWhenOpen).not.toBeNull();
    expect(listWhenOpen).not.toHaveClass('hidden');

    await user.click(toggle);

    const expandToggle = screen.getByRole('button', { name: /expand general/i });
    expect(expandToggle).toHaveAttribute('aria-expanded', 'false');
    // The channel button stays mounted but its wrapper gets the `hidden` class.
    // (Tailwind's stylesheet is not loaded in jsdom, so we assert on the class
    // rather than computed visibility.)
    const listWhenCollapsed = screen.getByText('lobby').closest('div.space-y-0\\.5');
    expect(listWhenCollapsed).toHaveClass('hidden');
  });
});
