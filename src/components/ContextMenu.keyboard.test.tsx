import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenuProvider } from './GlobalContextMenu';
import { useContextMenu } from './GlobalContextMenuContext';
import { useEscapeKey } from '@/hooks/useEscapeKey';

function Controls({ onParentEscape = () => {} }: { onParentEscape?: () => void }) {
  const { showMenu } = useContextMenu();
  useEscapeKey(onParentEscape);
  return <>
    <button onClick={() => showMenu(200, 150, [{ items: [
      { label: 'Unavailable', disabled: true, onClick: () => {} },
      { label: 'First action', onClick: () => {} },
      { label: 'Last action', onClick: () => document.getElementById('outside-focus')?.focus() },
    ] }])}>Message actions</button>
    <input id="outside-focus" aria-label="Outside field" />
  </>;
}
function view(onParentEscape?: () => void) {
  return <ContextMenuProvider><Controls onParentEscape={onParentEscape} /></ContextMenuProvider>;
}
describe('context menu keyboard access', () => {
  it('focuses the first available item and supports wrapping arrows, Home and End', async () => {
    const user = userEvent.setup(); render(view());
    await user.click(screen.getByRole('button', { name: 'Message actions' }));
    expect(screen.getByRole('menuitem', { name: 'First action' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Last action' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'First action' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Last action' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'First action' })).toHaveFocus();
  });
  it('closes only the topmost overlay and restores the invoking button', async () => {
    const user = userEvent.setup(), parent = vi.fn(); render(view(parent));
    const opener = screen.getByRole('button', { name: 'Message actions' });
    await user.click(opener); await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(opener).toHaveFocus(); expect(parent).not.toHaveBeenCalled();
    await user.keyboard('{Escape}'); expect(parent).toHaveBeenCalledTimes(1);
  });
  it('dismisses with Tab instead of tabbing through hidden menu actions', async () => {
    const user = userEvent.setup(); render(view());
    const opener = screen.getByRole('button', { name: 'Message actions' });
    await user.click(opener); await user.tab();
    expect(screen.queryByRole('menu')).toBeNull(); expect(opener).toHaveFocus();
  });
  it('does not steal focus from a clicked field outside the menu', async () => {
    const user = userEvent.setup(); render(view());
    await user.click(screen.getByRole('button', { name: 'Message actions' }));
    await user.click(screen.getByRole('textbox', { name: 'Outside field' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Outside field' })).toHaveFocus();
  });
  it('respects focus moved by the selected action', async () => {
    const user = userEvent.setup(); render(view());
    await user.click(screen.getByRole('button', { name: 'Message actions' }));
    await user.keyboard('{End}{Enter}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Outside field' })).toHaveFocus();
  });
});
