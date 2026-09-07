import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ChatArea } from './ChatArea';
import { ContextMenuProvider } from './GlobalContextMenu';
import type { Message, MessageLayout } from '@/types';
const messages: Message[] = [
  { id: 'a', userId: 'morgan', content: 'Hello sample', timestamp: '09:24', pinned: true },
  { id: 'b', userId: 'morgan', content: 'Hello sample', timestamp: '09:24' },
  { id: 'c', userId: 'morgan', content: 'A different message', timestamp: '09:25' },
];
function renderChat(layout: MessageLayout = 'modern') {
  return render(<QueryClientProvider client={new QueryClient()}><ContextMenuProvider>
    <ChatArea channel={{ id: 'accessible', name: 'general', type: 'text', categoryId: 'cat' }} messages={messages}
      users={[{ id: 'morgan', username: 'Morgan', avatar: '', status: 'online' }]} mobileMenuOpen={false}
      onToggleMobileMenu={() => {}} onToggleMemberList={() => {}} isDM={false} messageLayout={layout}
      onToggleLayout={() => {}} hasIdentity />
  </ContextMenuProvider></QueryClientProvider>);
}
describe('conversation accessibility', () => {
  it.each(['modern', 'bubbles', 'terminal'] as const)('identifies every message action even for identical messages (%s)', (layout) => {
    renderChat(layout);
    const controls = screen.getAllByRole('button', { name: /^More message actions for Morgan,/ });
    expect(controls).toHaveLength(3);
    expect(new Set(controls.map(button => button.getAttribute('aria-label'))).size).toBe(3);
    expect(controls[0]).toHaveAccessibleName(/09:24, message 1/);
    expect(controls[1]).toHaveAccessibleName(/09:24, message 2/);
  });
  it('normalizes matching, highlighting and the active search state together', () => {
    const { container } = renderChat();
    const input = screen.getByRole('textbox', { name: 'Search messages' });
    fireEvent.change(input, { target: { value: '  hello  ' } });
    expect(screen.queryByText('A different message')).toBeNull();
    expect(screen.getAllByText('Hello', { exact: true })).toHaveLength(2);
    expect(container.querySelector('.chat-conversation-start')).toBeNull();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByText('A different message')).toBeInTheDocument();
    expect(container.querySelector('.chat-conversation-start')).not.toBeNull();
    expect(screen.queryByText('No matching messages')).toBeNull();
  });
  it.each(['toolbar', 'compact tools'])('opens, contains, and restores pinned drawer focus from %s', async (entry) => {
    const user = userEvent.setup(); renderChat();
    const opener = screen.getByRole('button', { name: entry === 'toolbar' ? 'Pinned Messages' : 'More chat tools' });
    await user.click(opener);
    if (entry === 'compact tools') {
      const tools = screen.getByRole('dialog', { name: 'Chat tools' });
      await user.click(within(tools).getByRole('button', { name: /Pinned messages/ }));
      expect(screen.queryByRole('dialog', { name: 'Chat tools' })).toBeNull();
    }
    const drawer = screen.getByRole('dialog', { name: 'Pinned messages' });
    expect(drawer.contains(document.activeElement)).toBe(true);
    await user.tab(); await user.tab({ shift: true });
    expect(drawer.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Pinned messages' })).toBeNull();
    expect(opener).toHaveFocus();
  });
});
