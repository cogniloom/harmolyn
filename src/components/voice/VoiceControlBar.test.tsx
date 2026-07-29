// Finding 12 regression: the voice UI must surface the LIVE call's honest media
// security mode (voice_sessions[].security_mode). Previously the mode was tracked
// in the store but no component rendered it, so the channel header could claim
// CROWD E2EE while the actual call media was DTLS-only.
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { VoiceControlBar, type VoiceControlState } from './VoiceControlBar';
import { initStore, joinVoice, setVoiceSecurityMode } from '@/native/state/store';

const CHAN = 'chan-voice';

function makeState(channelId: string | null = CHAN): VoiceControlState {
  return {
    statusLabel: 'VOICE CONNECTED',
    statusDetail: 'mesh up',
    participantCount: 1,
    muted: false,
    deafened: false,
    videoOn: false,
    screenSharing: false,
    canInteract: true,
    pendingAction: null,
    error: null,
    sessionAvailable: true,
    channelId,
  };
}

function renderBar(channelId: string | null = CHAN) {
  return render(
    <VoiceControlBar
      channelName="Voice"
      state={makeState(channelId)}
      onDisconnect={() => {}}
      onToggleMute={() => {}}
      onToggleDeafen={() => {}}
      onToggleVideo={() => {}}
    />,
  );
}

describe('VoiceControlBar — honest per-call security badge', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    joinVoice(CHAN, 'me');
  });

  it('shows DTLS ONLY when the live call downgraded to clear (no SFrame)', () => {
    setVoiceSecurityMode(CHAN, 'clear');
    renderBar();
    const badge = screen.getByTestId('voice-security-mode');
    expect(badge).toHaveTextContent('DTLS ONLY');
    // The downgrade badge must read as a warning, not as E2EE.
    expect(badge.textContent).not.toContain('E2EE');
  });

  it('shows SFRAME E2EE when SFrame is genuinely active (crowd)', () => {
    setVoiceSecurityMode(CHAN, 'crowd');
    renderBar();
    expect(screen.getByTestId('voice-security-mode')).toHaveTextContent('SFRAME E2EE');
  });

  it('renders no security badge when there is no live session mode for the channel', () => {
    renderBar('some-other-channel');
    expect(screen.queryByTestId('voice-security-mode')).toBeNull();
  });
});
