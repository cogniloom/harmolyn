import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContextMenuProvider } from './GlobalContextMenu';
import { useContextMenu } from './GlobalContextMenuContext';

function Panes() {
  const { showMenu } = useContextMenu();
  const open = () => showMenu(100, 100, [{ items: [{ label: 'Menu action', onClick: () => {} }] }]);
  return <>
    <section data-testid="navigation-pane"><button onClick={open}>Channel actions</button></section>
    <section data-testid="chat-pane" onContextMenu={event => {
      event.preventDefault();
      (event.nativeEvent as Event & { __customContextHandled?: boolean }).__customContextHandled = true;
      open();
    }}>Message history</section>
    <section data-testid="other-pane"><input aria-label="Other input" /></section>
  </>;
}
function mount() { render(<ContextMenuProvider><Panes /></ContextMenuProvider>); }
function openWithKeyboard() {
  const button = screen.getByRole('button', { name: 'Channel actions' });
  button.focus();
  fireEvent.click(button, { detail: 0 });
  expect(screen.getByRole('menuitem')).toHaveFocus();
}
function scroll(pane: HTMLElement, position: number) {
  pane.scrollTop = position;
  fireEvent.scroll(pane);
}

describe('context-menu scroll ownership', () => {
  it('keeps a navigation menu open when message history auto-scrolls after a resize', () => {
    mount(); openWithKeyboard();
    scroll(screen.getByTestId('chat-pane'), 100);
    expect(screen.getByRole('menuitem')).toHaveFocus();
  });
  it('ignores an already-applied opening scroll, but dismisses when its own ancestor moves', () => {
    mount();
    const pane = screen.getByTestId('navigation-pane');
    pane.scrollTop = 40;
    openWithKeyboard();
    fireEvent.scroll(pane);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    scroll(pane, 80);
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('tracks the right-clicked pane rather than an unrelated previously focused input', () => {
    mount(); screen.getByRole('textbox').focus();
    fireEvent.contextMenu(screen.getByTestId('chat-pane'));
    expect(screen.getByRole('menuitem')).toHaveFocus();
    scroll(screen.getByTestId('other-pane'), 20);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    scroll(screen.getByTestId('chat-pane'), 20);
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('does not close on the opening click bubbling to window, but closes on a separate outside click', () => {
    mount();
    const button = screen.getByRole('button', { name: 'Channel actions' });
    button.focus();
    // The same native event may reach window after React commits the menu.
    const event = new MouseEvent('click', { bubbles: true, detail: 0 });
    act(() => { button.dispatchEvent(event); });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('textbox'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
