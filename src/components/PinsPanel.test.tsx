import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PinsPanel } from './PinsPanel';

describe('PinsPanel', () => {
  it('normalizes malformed pinned-message users before rendering', () => {
    render(
      <PinsPanel
        messages={[
          {
            id: 'm-1',
            userId: 'peer-1',
            content: 'Pinned message',
            timestamp: '12:34',
            pinned: true,
          },
        ]}
        users={[
          {
            id: 'peer-1',
            username: { bad: true },
            avatar: 42,
            status: 'online',
            color: { accent: true },
          } as never,
        ]}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('peer-1')).toBeInTheDocument();
    expect(screen.getByText('Pinned message')).toBeInTheDocument();
  });

  it('keeps the first normalized user when duplicate ids are present', () => {
    render(
      <PinsPanel
        messages={[
          {
            id: 'm-1',
            userId: 'peer-1',
            content: 'Pinned message',
            timestamp: '12:34',
            pinned: true,
          },
        ]}
        users={[
          {
            id: 'peer-1',
            username: 'Alpha Pin',
            avatar: '/alpha.png',
            status: 'online',
          },
          {
            id: 'peer-1',
            username: 'Beta Pin',
            avatar: '/beta.png',
            status: 'idle',
          },
        ]}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Alpha Pin')).toBeInTheDocument();
    expect(screen.queryByText('Beta Pin')).toBeNull();
  });

  it('renders unknown pinned authors with an explicit placeholder', () => {
    render(
      <PinsPanel
        messages={[
          {
            id: 'm-1',
            userId: 'missing-peer',
            content: 'Pinned message',
            timestamp: '12:34',
            pinned: true,
          },
        ]}
        users={[]}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Unknown User')).toBeInTheDocument();
    expect(screen.getByText('Pinned message')).toBeInTheDocument();
  });
});
