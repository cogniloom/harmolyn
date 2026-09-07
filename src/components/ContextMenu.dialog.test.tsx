import React, { useEffect, useRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { ContextMenuProvider } from './GlobalContextMenu';
import { useContextMenu } from './GlobalContextMenuContext';
import { trapDialogFocus } from '@/lib/stabilization/interaction';

function ParentDialog() {
  const root = useRef<HTMLDivElement>(null);
  const { showMenu } = useContextMenu();
  useEffect(() => root.current ? trapDialogFocus(root.current) : undefined, []);
  return <div role="dialog" aria-label="Parent dialog" ref={root}>
    <button onClick={() => showMenu(100, 100, [{ items: [{ label: 'Reply', onClick: () => {} }] }])}>Actions</button>
  </div>;
}
it('lets a portalled menu take focus above a dialog and restores its invoker', async () => {
  const user = userEvent.setup();
  render(<ContextMenuProvider><ParentDialog /></ContextMenuProvider>);
  const opener = screen.getByRole('button', { name: 'Actions' });
  await user.click(opener);
  expect(screen.getByRole('menuitem', { name: 'Reply' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(opener).toHaveFocus();
  expect(screen.getByRole('dialog', { name: 'Parent dialog' })).toBeInTheDocument();
});
