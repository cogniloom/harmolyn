// Real Layout + QuickSwitcher; only external runtime and unrelated panels are substituted.
import React, { type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Server } from '@/types';
import { Layout } from './Layout';

const live = vi.hoisted(() => ({
  shell: null as unknown,
  listeners: new Set<() => void>(),
  join: vi.fn(), leave: vi.fn(), active: vi.fn(),
}));
vi.mock('@/data', () => ({
  SERVERS: [], USERS: [], DIRECT_MESSAGES: [],
  readShellRuntimeData: () => live.shell,
  subscribeShellRuntimeData: (listener: () => void) => { live.listeners.add(listener); return () => live.listeners.delete(listener); },
  deriveConnectionState: () => ({ status: 'connected', label: 'Connected', detail: 'Test connection', canUseConnectivityActions: true }),
}));
vi.mock('@/hooks/useFeature', () => ({ useFeature: (key: string) => key === 'quickSwitcher' }));
vi.mock('@/native/engine/provider', () => ({ useNativeEngine: () => ({ engine: {}, hasRegisteredIdentity: false }) }));
vi.mock('@/hooks/runtime/useRuntimeMutations', () => ({ useRuntimeMutations: () => ({
  joinVoiceChannel: live.join, leaveVoiceChannel: live.leave, setActiveScope: live.active,
}) }));
vi.mock('@/lib/xoreinRuntimeContext', () => ({ useRuntimeBootstrapState: () => ({ status: 'ready', message: '' }) }));
vi.mock('@/lib/xoreinControl', async () => ({
  ...await vi.importActual<typeof import('@/lib/xoreinControl')>('@/lib/xoreinControl'),
  consumePendingNativeDeepLinks: async () => [],
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@/hooks/useNodeHealth', () => ({ useNodeHealth: () => ({ nodeOffline: false }) }));
vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));
vi.mock('@/components/ServerRail', () => ({ ServerRail: () => null }));
vi.mock('@/components/MemberSidebar', () => ({ MemberSidebar: () => null }));
vi.mock('@/components/RecoveryConsentPrompt', () => ({ RecoveryConsentPrompt: () => null }));
vi.mock('@/components/ChatArea', () => ({ ChatArea: ({ channel }: { channel: Channel }) => <div data-testid="active-chat" data-type={channel.type}>{channel.id}</div> }));
vi.mock('@/components/ChannelRail', () => ({ ChannelRail: ({ connectedVoiceChannelId, onJoinVoice, voiceControlState }: {
  voiceControlState: { error: string | null }; connectedVoiceChannelId: string | null; onJoinVoice: (id: string) => void;
}) => <div><output data-testid="voice-channel">{connectedVoiceChannelId ?? ''}</output><output data-testid="voice-error">{voiceControlState.error ?? ''}</output><button onClick={() => onJoinVoice('lounge')}>Rail join</button></div> }));
vi.mock('@/components/voice/VoiceAudioSinks', () => ({ VoiceAudioSinks: ({ channelId }: { channelId: string | null }) => <output data-testid="audio-channel">{channelId ?? ''}</output> }));
vi.mock('@/components/voice/VoiceVideoSinks', () => ({ VoiceVideoSinks: () => null }));
vi.mock('@/components/auth/AuthFlow', () => ({ AuthFlow: ({ initialStep }: { initialStep: string }) => <output data-testid="auth-step">{initialStep}</output> }));
vi.mock('@/components/streamer/StreamerMode', () => ({
  StreamerModeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  StreamerTopBar: () => null,
  StreamerServerReveal: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const me = { id: 'me', username: 'Alex', avatar: '', status: 'online' as const };
const makeSpace = (id: string, channelId: string, voice: string): Server => ({
  id, name: id, icon: '', ownerId: 'me', members: [me], categories: [{ id: 'cat-' + id, name: 'Channels', channels: [
    { id: channelId, name: channelId, type: 'text', categoryId: 'cat-' + id },
    { id: voice, name: voice, type: 'voice', categoryId: 'cat-' + id },
  ] }],
});
function data() {
  return { initialServerId: 'studio', initialChannelId: 'general',
    servers: [makeSpace('studio', 'general', 'lounge'), makeSpace('garden', 'planning', 'terrace')],
    users: [me, { ...me, id: 'morgan', username: 'Morgan' }], currentUser: me,
    directMessages: [{ id: 'dm-morgan', userId: 'morgan', lastMessage: '' }], messagesByScope: new Map(),
    runtimeSnapshot: { identity: { peer_id: 'me', profile: { display_name: 'Alex' } }, voice_sessions: [], friend_requests: [] },
    sessionSnapshot: null,
  };
}
async function select(query: string) {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const user = userEvent.setup();
  const input = screen.getByRole('combobox', { name: 'Search channels and direct messages' });
  await user.type(input, query);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Quick switcher' })).toBeNull());
}
function publish(shell: ReturnType<typeof data>) {
  act(() => { live.shell = shell; live.listeners.forEach(listener => listener()); });
}
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('harmolyn_onboarding_dismissed', 'true');
  live.shell = data(); live.join.mockReset().mockResolvedValue(undefined);
  live.leave.mockReset().mockResolvedValue(undefined); live.active.mockReset();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
});
describe('real empty-conversation state in Layout', () => {
  it('keeps voice-only Spaces out of first-time onboarding and joins through the existing flow', async () => {
    const shell = data();
    shell.servers[0].categories[0].channels = shell.servers[0].categories[0].channels.filter(channel => channel.type === 'voice');
    shell.initialChannelId = '';
    live.shell = shell;
    render(<Layout />);
    expect(screen.getByRole('heading', { name: 'No text channel selected' })).toBeInTheDocument();
    expect(screen.queryByText('Welcome to Harmolyn')).toBeNull();
    expect(screen.queryByText(/You don.t have any Spaces yet/)).toBeNull();
    await select('lounge');
    await waitFor(() => expect(live.join).toHaveBeenCalledWith('lounge', {}));
    expect(screen.getByTestId('audio-channel')).toHaveTextContent('lounge');
    expect(screen.getByRole('heading', { name: 'No text channel selected' })).toBeInTheDocument();
    expect(live.leave).not.toHaveBeenCalled();
  });
  it('reserves global welcome for accounts that actually have no Spaces', () => {
    const shell = data(); shell.servers = []; shell.initialServerId = 'missing'; shell.initialChannelId = '';
    live.shell = shell;
    render(<Layout />);
    expect(screen.getByText('Welcome to Harmolyn')).toBeInTheDocument();
    expect(screen.queryByText('No text channel selected')).toBeNull();
  });
  it('updates when the last empty Space disappears without retaining a misleading state', () => {
    const shell = data(); shell.servers = [shell.servers[0]]; shell.servers[0].categories = []; shell.initialChannelId = '';
    live.shell = shell; render(<Layout />);
    expect(screen.getByRole('heading', { name: 'No text channel selected' })).toBeInTheDocument();
    publish({ ...shell, servers: [], initialServerId: 'missing' });
    expect(screen.getByText('Welcome to Harmolyn')).toBeInTheDocument();
  });
});
