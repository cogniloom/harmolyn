/** One document listener, with stable last-opened-first dismissal. */
const escapeStacks = new WeakMap<Document, Array<() => void>>();
const escapeListeners = new WeakMap<Document, (event: KeyboardEvent) => void>();

export function registerEscapeHandler(doc: Document, callback: () => void): () => void {
  let stack = escapeStacks.get(doc);
  if (!stack) {
    stack = [];
    escapeStacks.set(doc, stack);
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const current = escapeStacks.get(doc);
      const top = current?.[current.length - 1];
      if (!top) return;
      event.preventDefault();
      top();
    };
    escapeListeners.set(doc, handler);
    doc.addEventListener('keydown', handler);
  }
  // A wrapper gives two registrations of the same callback independent lifetimes.
  const entry = () => callback();
  stack.push(entry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    if (stack.length === 0) {
      const handler = escapeListeners.get(doc);
      if (handler) doc.removeEventListener('keydown', handler);
      escapeListeners.delete(doc);
      escapeStacks.delete(doc);
    }
  };
}

