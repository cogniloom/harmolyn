import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThreadPanel } from './ThreadPanel';

describe('ThreadPanel', () => {
  it('normalizes malformed parent and reply users before rendering', () => {
    render(
      <ThreadPanel
        parentMessage={{
          id: 'm-1',
          userId: 'peer-1',
          content: 'Parent message',
          timestamp: '12:34',
        }}
        parentUser={{
          id: 'peer-1',
          username: { bad: true },
          avatar: 42,
          status: 'online',
          color: { accent: true },
        } as never}
        allUsers={[
          {
            id: 'peer-2',
            username: { bad: true },
            avatar: 42,
            status: 'online',
          } as never,
        ]}
        replies={[
          {
            id: 'r-1',
            userId: 'peer-2',
            content: 'Reply body',
            timestamp: '12:35',
          },
        ]}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('peer-1')).toBeInTheDocument();
    expect(screen.getByText('peer-2')).toBeInTheDocument();
    expect(screen.getByText('Parent message')).toBeInTheDocument();
    expect(screen.getByText('Reply body')).toBeInTheDocument();
  });

  it('keeps the first normalized reply author when duplicate ids are present', () => {
    render(
      <ThreadPanel
        parentMessage={{
          id: 'm-1',
          userId: 'peer-1',
          content: 'Parent message',
          timestamp: '12:34',
        }}
        parentUser={{
          id: 'peer-1',
          username: 'Parent',
          avatar: '/parent.png',
          status: 'online',
        }}
        allUsers={[
          {
            id: 'peer-2',
            username: 'Alpha Reply',
            avatar: '/alpha.png',
            status: 'online',
          },
          {
            id: 'peer-2',
            username: 'Beta Reply',
            avatar: '/beta.png',
            status: 'idle',
          },
        ]}
        replies={[
          {
            id: 'r-1',
            userId: 'peer-2',
            content: 'Reply body',
            timestamp: '12:35',
          },
        ]}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Alpha Reply')).toBeInTheDocument();
    expect(screen.queryByText('Beta Reply')).toBeNull();
  });

  it('renders unknown reply authors with an explicit placeholder', () => {
    render(
      <ThreadPanel
        parentMessage={{
          id: 'm-1',
          userId: 'peer-1',
          content: 'Parent message',
          timestamp: '12:34',
        }}
        parentUser={{
          id: 'peer-1',
          username: 'Parent',
          avatar: '/parent.png',
          status: 'online',
        }}
        allUsers={[]}
        replies={[
          {
            id: 'r-1',
            userId: 'missing-peer',
            content: 'Reply body',
            timestamp: '12:35',
          },
        ]}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Unknown User')).toBeInTheDocument();
    expect(screen.getByText('Reply body')).toBeInTheDocument();
  });

  it('disables the send button until the reply has content', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <ThreadPanel
        parentMessage={{ id: 'm-1', userId: 'peer-1', content: 'Parent message', timestamp: '12:34' }}
        parentUser={{ id: 'peer-1', username: 'Parent', avatar: '/parent.png', status: 'online' }}
        allUsers={[]}
        replies={[]}
        onSend={onSend}
        onClose={vi.fn()}
      />,
    );

    const sendButton = screen.getByRole('button', { name: 'Send Reply' });
    expect(sendButton).toBeDisabled();

    // Whitespace-only input stays disabled and does not send.
    const input = screen.getByPlaceholderText('REPLY // THREAD');
    await user.type(input, '   ');
    expect(sendButton).toBeDisabled();

    await user.type(input, 'hello');
    expect(sendButton).toBeEnabled();
    await user.click(sendButton);
    expect(onSend).toHaveBeenCalledWith('hello');
  });
});
