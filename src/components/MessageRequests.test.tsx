import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageRequests } from './MessageRequests';

vi.mock('@/data', () => ({
  USERS: [
    {
      id: 'me',
      username: 'Alpha User',
      avatar: '/alpha.png',
      status: 'online',
    },
    {
      id: 'me',
      username: 'Beta User',
      avatar: '/beta.png',
      status: 'idle',
    },
  ],
}));

describe('MessageRequests', () => {
  it('normalizes and dedupes request records before rendering', () => {
    render(
      <MessageRequests
        requests={[
          {
            id: ' req-1 ',
            userId: ' me ',
            preview: '  First request preview  ',
            timestamp: ' 2 hours ago ',
          } as never,
          {
            id: 'req-1',
            userId: 'me',
            preview: 'should-not-render',
            timestamp: 'should-not-render',
          } as never,
          {
            id: 'req-2',
            userId: 'me',
            preview: 'Another preview',
            timestamp: '5 hours ago',
          } as never,
        ]}
        onAccept={vi.fn()}
        onIgnore={vi.fn()}
      />,
    );

    expect(screen.getByText('PENDING REQUESTS // 2')).toBeTruthy();
    expect(screen.getAllByText('First request preview').length).toBe(1);
    expect(screen.getByText('Another preview')).toBeTruthy();
    expect(screen.queryByText('should-not-render')).toBeNull();
  });

  it('keeps the first normalized user when duplicate request owners are present', () => {
    render(
      <MessageRequests
        requests={[
          {
            id: 'req-1',
            userId: 'me',
            preview: 'First request preview',
            timestamp: '2 hours ago',
          } as never,
        ]}
        onAccept={vi.fn()}
        onIgnore={vi.fn()}
      />,
    );

    expect(screen.getByText('Alpha User')).toBeTruthy();
    expect(screen.queryByText('Beta User')).toBeNull();
  });

  it('renders missing request owners with an explicit placeholder', () => {
    render(
      <MessageRequests
        requests={[
          {
            id: 'req-missing',
            userId: 'missing-user',
            preview: 'Mystery request preview',
            timestamp: '2 hours ago',
          } as never,
        ]}
        onAccept={vi.fn()}
        onIgnore={vi.fn()}
      />,
    );

    expect(screen.getByText('Unknown User')).toBeTruthy();
    expect(screen.getByText('Mystery request preview')).toBeTruthy();
  });
});
