import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoiceTextChat } from './VoiceTextChat';
import { PREVIEW_STORAGE_KEYS } from '@/config/storageKeys';

afterEach(() => {
  window.localStorage.clear();
});

describe('VoiceTextChat', () => {
  it('normalizes malformed persisted messages', () => {
    window.localStorage.setItem(
      PREVIEW_STORAGE_KEYS.voiceText('voice-1'),
      JSON.stringify([
        {
          id: { broken: true },
          username: 123,
          avatar: { href: 'https://example.com/avatar.png' },
          content: { body: 'hello' },
          timestamp: null,
        },
      ]),
    );

    render(<VoiceTextChat channelId="voice-1" channelName="General" />);

    expect(screen.getByText('Unknown User')).toBeTruthy();
  });

  it('dedupes persisted voice messages by id before rendering', () => {
    window.localStorage.setItem(
      PREVIEW_STORAGE_KEYS.voiceText('voice-1'),
      JSON.stringify([
        {
          id: 'voice-msg-1',
          username: 'Alpha',
          avatar: 'https://example.com/alpha.png',
          content: 'first',
          timestamp: '12:00',
        },
        {
          id: 'voice-msg-1',
          username: 'Beta',
          avatar: 'https://example.com/beta.png',
          content: 'second',
          timestamp: '12:01',
        },
      ]),
    );

    render(<VoiceTextChat channelId="voice-1" channelName="General" />);

    expect(screen.getAllByText('Alpha')).toHaveLength(1);
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.getByText('first')).toBeTruthy();
  });
});
