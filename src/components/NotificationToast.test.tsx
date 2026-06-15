import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NotificationToast } from './NotificationToast';

describe('NotificationToast', () => {
  it('normalizes malformed toast records before rendering', () => {
    render(
      <NotificationToast
        toasts={[
          {
            id: 'toast-1',
            type: 'mention',
            title: { bad: true },
            body: '  Hello world  ',
            avatar: 42,
            timestamp: 0,
          } as never,
        ]}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Notification')).toBeInTheDocument();
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('keeps the first toast when duplicate ids collide', () => {
    render(
      <NotificationToast
        toasts={[
          {
            id: 'toast-dup',
            type: 'mention',
            title: 'First toast',
            body: 'First body',
            avatar: '',
            timestamp: 0,
          } as never,
          {
            id: 'toast-dup',
            type: 'system',
            title: 'Second toast',
            body: 'Second body',
            avatar: '',
            timestamp: 1,
          } as never,
        ]}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('First toast')).toBeInTheDocument();
    expect(screen.getByText('First body')).toBeInTheDocument();
    expect(screen.queryByText('Second toast')).toBeNull();
    expect(screen.queryByText('Second body')).toBeNull();
  });

  it('keeps distinct malformed toasts that need generated ids', () => {
    render(
      <NotificationToast
        toasts={[
          {
            type: 'mention',
            title: 'First generated toast',
            body: 'First generated body',
            avatar: '',
            timestamp: 0,
          } as never,
          {
            type: 'system',
            title: 'Second generated toast',
            body: 'Second generated body',
            avatar: '',
            timestamp: 1,
          } as never,
        ]}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('First generated toast')).toBeInTheDocument();
    expect(screen.getByText('First generated body')).toBeInTheDocument();
    expect(screen.getByText('Second generated toast')).toBeInTheDocument();
    expect(screen.getByText('Second generated body')).toBeInTheDocument();
  });

  it('marks error toasts as alerts and other toasts as status', () => {
    render(
      <NotificationToast
        toasts={[
          { id: 'err', type: 'error', title: 'Boom', body: 'It broke', timestamp: 0 } as never,
          { id: 'ok', type: 'success', title: 'Yay', body: 'It worked', timestamp: 1 } as never,
        ]}
        onDismiss={vi.fn()}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('It broke');
    expect(alert).toHaveAttribute('aria-live', 'assertive');

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('It worked');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('caps the visible stack and keeps the most recent toasts', () => {
    const toasts = Array.from({ length: 8 }, (_, i) => ({
      id: `toast-${i}`,
      type: 'info',
      title: `Toast ${i}`,
      body: `Body ${i}`,
      timestamp: i,
    })) as never[];

    render(<NotificationToast toasts={toasts} onDismiss={vi.fn()} />);

    // Only the last 5 (indices 3..7) should be rendered.
    expect(screen.queryByText('Body 0')).toBeNull();
    expect(screen.queryByText('Body 2')).toBeNull();
    expect(screen.getByText('Body 3')).toBeInTheDocument();
    expect(screen.getByText('Body 7')).toBeInTheDocument();
    expect(screen.getAllByRole('status')).toHaveLength(5);
  });
});
