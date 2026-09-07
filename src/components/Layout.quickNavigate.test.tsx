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
vi.mock('@/components/WelcomeEmptyState', () => ({ WelcomeEmptyState: () => <div>No text channels</div> }));
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
describe('quick switcher voice integration', () => {
  it('does not capture media while searching, and joins on explicit Enter', async () => {
    render(<Layout />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox'), 'lounge');
    expect(screen.getByText('Enter to join voice')).toBeInTheDocument();
    expect(live.join).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(live.join).toHaveBeenCalledWith('lounge', {}));
    expect(screen.getByTestId('audio-channel')).toHaveTextContent('lounge');
    expect(screen.getByTestId('active-chat')).toHaveTextContent('general');
    expect(screen.getByTestId('active-chat')).toHaveAttribute('data-type', 'text');
  });
  it('joins a voice destination in another Space without rendering it as text', async () => {
    render(<Layout />); await select('terrace');
    await waitFor(() => expect(live.join).toHaveBeenCalledWith('terrace', {}));
    expect(screen.getByTestId('active-chat')).toHaveTextContent('planning');
    expect(screen.getByTestId('audio-channel')).toHaveTextContent('terrace');
  });
  it('keeps the live call and its audio sinks when a new snapshot arrives while browsing a DM', async () => {
    render(<Layout />); await select('lounge');
    await waitFor(() => expect(live.join).toHaveBeenCalledTimes(1));
    await select('Morgan'); publish(data());
    expect(screen.getByTestId('active-chat')).toHaveTextContent('dm-morgan');
    expect(screen.getByTestId('audio-channel')).toHaveTextContent('lounge');
    expect(live.leave).not.toHaveBeenCalled();
  });
  it('leaves the previous voice room before joining another one', async () => {
    render(<Layout />); await select('lounge');
    await waitFor(() => expect(live.join).toHaveBeenCalledTimes(1));
    await select('terrace');
    await waitFor(() => expect(live.join).toHaveBeenCalledTimes(2));
    expect(live.leave).toHaveBeenCalledWith('lounge');
    expect(live.leave.mock.invocationCallOrder[0]).toBeLessThan(live.join.mock.invocationCallOrder[1]);
  });
  it('coalesces repeated activation while the join is pending', async () => {
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    live.join.mockReturnValue(pending);
    render(<Layout />); await select('lounge');
    fireEvent.click(screen.getByRole('button', { name: 'Rail join' }));
    await select('terrace');
    expect(live.join).toHaveBeenCalledTimes(1);
    expect(live.leave).not.toHaveBeenCalled();
    await act(async () => { complete(); await pending; });
  });
  it('requires identity before the quick switcher can join voice', async () => {
    const shell = data(); shell.runtimeSnapshot.identity.peer_id = ''; shell.runtimeSnapshot.identity.profile.display_name = '';
    live.shell = shell; render(<Layout />); await select('lounge');
    expect(live.join).not.toHaveBeenCalled();
    expect(screen.getByTestId('auth-step')).toHaveTextContent('create');
  });
  it('rolls back a rejected join without changing the text conversation', async () => {
    live.join.mockRejectedValue(new Error('Permission denied'));
    render(<Layout />); await select('lounge');
    await waitFor(() => expect(live.join).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('audio-channel')).toBeEmptyDOMElement());
    expect(screen.getByTestId('active-chat')).toHaveTextContent('general');
  });
  it.each(['Error', 'NotAllowedError'])('does not expose raw %s diagnostics in voice feedback', async (name) => {
    const error = new Error('private-device-id https://user:secret@internal.invalid/session');
    error.name = name;
    live.join.mockRejectedValue(error);
    render(<Layout />); await select('lounge');
    await waitFor(() => expect(screen.getByTestId('voice-error')).not.toBeEmptyDOMElement());
    expect(screen.getByTestId('voice-error')).toHaveTextContent(name === 'NotAllowedError'
      ? 'Review your system permissions' : 'Check your audio permissions and connection');
    expect(document.body.textContent).not.toMatch(/private-device-id|user:secret|internal\.invalid/);
  });
  it('retains non-voice channel kinds during navigation', async () => {
    const shell = data(); shell.servers[1].categories[0].channels[0].type = 'forum';
    live.shell = shell; render(<Layout />); await select('planning');
    expect(live.join).not.toHaveBeenCalled();
    expect(screen.getByTestId('active-chat')).toHaveTextContent('planning');
  });
});
