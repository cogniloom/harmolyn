const dialogStacks = new WeakMap<Document, HTMLElement[]>();
const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focus isolation and restoration for a portal dialog; no document-wide observer. */
export function trapDialogFocus(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const opener = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  const oldTabIndex = root.getAttribute('tabindex');
  if (oldTabIndex === null) root.tabIndex = -1;
  const stack = dialogStacks.get(doc) ?? [];
  dialogStacks.set(doc, stack);
  stack.push(root);
  const isTop = () => stack[stack.length - 1] === root;
  const targets = () => Array.from(root.querySelectorAll<HTMLElement>(focusableSelector))
    .filter(el => el.tabIndex >= 0 && !el.closest('[inert], [hidden], [aria-hidden="true"]') && el.getClientRects().length > 0);
  const focusFirst = () => (targets()[0] ?? root).focus({ preventScroll: true });
  const onFocus = (event: FocusEvent) => {
    if (isTop() && event.target instanceof Node && !root.contains(event.target)) focusFirst();
  };
  const onKey = (event: KeyboardEvent) => {
    if (!isTop() || event.key !== 'Tab' || event.defaultPrevented) return;
    const items = targets();
    const current = items.indexOf(doc.activeElement as HTMLElement);
    if (items.length === 0 || current === -1 || (event.shiftKey ? current === 0 : current === items.length - 1)) {
      event.preventDefault();
      (event.shiftKey ? items[items.length - 1] ?? root : items[0] ?? root).focus({ preventScroll: true });
    }
  };
  doc.addEventListener('focusin', onFocus);
  doc.addEventListener('keydown', onKey);
  if (!root.contains(doc.activeElement)) focusFirst();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const wasTop = isTop();
    doc.removeEventListener('focusin', onFocus);
    doc.removeEventListener('keydown', onKey);
    const index = stack.indexOf(root);
    if (index >= 0) stack.splice(index, 1);
    if (!stack.length) dialogStacks.delete(doc);
    if (oldTabIndex === null) root.removeAttribute('tabindex');
    if (wasTop && opener?.isConnected && (!stack.length || stack[stack.length - 1]?.contains(opener))) opener.focus({ preventScroll: true });
  };
}

