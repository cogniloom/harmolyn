// Test-only composition: real UI, deterministic local props, no network engine.
// Not imported by the production entrypoint or emitted into application dist/.
import React, { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isSendFixture, settleSend, subscribeSends, getSendCount, getSendCalls } from './sendRuntime';
import { ChatArea } from '../../src/components/ChatArea';
import { ChannelRail } from '../../src/components/ChannelRail';
import { QuickSwitcher } from '../../src/components/QuickSwitcher';
import { ContextMenuProvider } from '../../src/components/GlobalContextMenu';
import { THEMES } from '../../src/lib/appearance/model';
import { initializeAppearance, updateAppearance } from '../../src/lib/appearance/store';
import type { Server, User, Message, MessageLayout } from '../../src/types';
import '../../src/i18n';
import '../../src/index.css';
import '../../src/styles/stabilization.css';
import '../../src/styles/appearance.css';
import '../../src/styles/palette-transitions.css';
import '../../src/styles/conversation.css';
const me: User = { id: 'me', username: 'Alex', avatar: '', status: 'online' };
const users: User[] = [me, { id: 'morgan', username: 'Morgan', avatar: '', status: 'online' }];
const channels = [
  { id: 'general', name: 'general', type: 'text' as const, categoryId: 'discussions' },
  { id: 'design', name: 'design-review', type: 'text' as const, categoryId: 'discussions' },
  { id: 'ideas', name: 'ideas-and-feedback', type: 'text' as const, categoryId: 'discussions' },
];
const spaces: Server[] = [{ id: 'studio', name: 'Design studio', icon: '', ownerId: 'morgan', members: users,
  categories: [{ id: 'discussions', name: 'Discussion', channels }] }];
const messages: Message[] = [
  { id: 'intro', userId: 'morgan', content: 'Let’s keep the conversation easy to follow. The latest layout is ready for review.', timestamp: '09:24', pinned: true, securityMode: 'tree', encrypted: true },
  { id: 'reply', userId: 'me', content: 'The controls are easier to find now. I’m checking the small-screen layout next.', timestamp: '09:26', securityMode: 'tree', encrypted: true, delivery_status: 'sent' },
  { id: 'details', userId: 'morgan', content: '**Today’s review**\nReadable messages, reachable controls, and predictable navigation.\n\nA long reference should wrap without moving the toolbar: abcdefghijklmnopqrstuvwxyz'.repeat(1), timestamp: '09:28', securityMode: 'tree', encrypted: true },
];
initializeAppearance();
export function Fixture() {
  const sendCount = useSyncExternalStore(subscribeSends, getSendCount);
  const [selected, setSelected] = useState('design');
  const [switcher, setSwitcher] = useState(false);
  const [layout, setLayout] = useState<MessageLayout>('modern');
  const [narrow, setNarrow] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  return <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--appearance-background)' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 8, borderBottom: '1px solid var(--appearance-border)', flexShrink: 0 }}>
      <span style={{ fontSize: 11, color: 'var(--appearance-muted)' }}>Local sample conversation · UI test</span>
      <select aria-label="Test theme" style={{ background: 'var(--appearance-surface)', color: 'var(--appearance-text)', padding: 6 }}
        onChange={e => updateAppearance(value => ({ ...value, theme: e.target.value }))}>
        {THEMES.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
      </select>
      <button type="button" onClick={() => setSwitcher(true)} style={{ padding: 6 }}>Find a conversation</button>
      {isSendFixture && <>
        <button onClick={() => settleSend(false)}>Fail pending send</button>
        <button onClick={() => settleSend(true)}>Complete pending send</button>
        <output aria-label="Test send count">{sendCount}</output>
        <output aria-label="Test send requests" hidden>{JSON.stringify(getSendCalls())}</output>
      </>}
      <button type="button" onClick={() => setNarrow(value => !value)} style={{ padding: 6 }}>Toggle narrow chat</button>
    </div>
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <aside className={navOpen ? '' : 'hidden min-[1100px]:block'} style={{ width: 244, flexShrink: 0 }}>
        <ChannelRail server={spaces[0]} activeChannelId={selected} currentUser={me} users={users} directMessages={[]}
          connectionState={{ status: 'connected', label: 'Local UI fixture', detail: 'No network engine in this test', canUseConnectivityActions: true }}
          connectedVoiceChannelId={null} collapsed={false} onToggleCollapse={() => setNavOpen(false)}
          onSelectChannel={id => { setSelected(id); setNavOpen(false); }} onJoinVoice={() => {}} onOpenSettings={() => {}} />
      </aside>
      <div style={{ display: 'flex', flex: 1, minWidth: 0, maxWidth: narrow ? 620 : undefined }}>
        <ChatArea key={selected} channel={channels.find(channel => channel.id === selected)!} messages={messages} users={users}
          mobileMenuOpen={navOpen} onToggleMobileMenu={() => setNavOpen(value => !value)} onToggleMemberList={() => {}}
          isDM={false} messageLayout={layout} onToggleLayout={() => setLayout(value => value === 'modern' ? 'bubbles' : value === 'bubbles' ? 'terminal' : 'modern')}
          securityMode="tree" hasIdentity />
      </div>
    </div>
    {switcher && <QuickSwitcher servers={spaces} users={users} directMessages={[]} onClose={() => setSwitcher(false)}
      onNavigate={(_space, id) => setSelected(id)} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><ContextMenuProvider><Fixture /></ContextMenuProvider></QueryClientProvider>);
