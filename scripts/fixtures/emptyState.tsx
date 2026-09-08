// Test-only composition of the production empty state and normalized shell data.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WelcomeEmptyState } from '../../src/components/WelcomeEmptyState';
import { initializeAppearance, updateAppearance } from '../../src/lib/appearance/store';
import { THEMES } from '../../src/lib/appearance/model';
import '../../src/index.css';
import '../../src/styles/stabilization.css';
import '../../src/styles/appearance.css';
import '../../src/styles/palette-transitions.css';
function snapshot(hasSpace: boolean) {
  (window as unknown as Record<string, unknown>).__HARMOLYN_RUNTIME_SNAPSHOT__ = {
    identity: { id: 'owner', peer_id: 'owner', profile: { display_name: 'Alex' } },
    servers: hasSpace ? [{ id: 'voice-space', name: 'Voice Space', owner_peer_id: 'owner', members: ['owner'],
      channels: { lounge: { id: 'lounge', server_id: 'voice-space', name: 'Lounge', voice: true } } }] : [],
  };
}
snapshot(true); initializeAppearance();
export function Fixture() {
  const [hasSpace, setHasSpace] = useState(true);
  const [action, setAction] = useState('');
  return <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--appearance-background)', color: 'var(--appearance-text)' }}>
    <header style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 8 }}>
      <select aria-label="Test theme" onChange={event => updateAppearance(value => ({ ...value, theme: event.target.value }))}>
        {THEMES.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
      </select>
      <button onClick={() => { snapshot(!hasSpace); setHasSpace(!hasSpace); setAction(''); }}>Toggle Space membership</button>
    </header>
    <WelcomeEmptyState hasIdentity canUseConnectivity onCreateServer={() => setAction('Create requested')} onJoinServer={() => setAction('Join requested')}
      onAddFriend={() => setAction('Friends requested')} onOpenAuth={() => setAction('Auth requested')} />
    <output>{action}</output>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
