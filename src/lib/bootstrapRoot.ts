export function resolveRootElement(doc: Document = document): HTMLElement | null {
  try {
    const existingRoot = doc.getElementById('root');
    if (existingRoot instanceof HTMLElement) {
      return existingRoot;
    }

    if (!doc.body) {
      return null;
    }

    const root = doc.createElement('div');
    root.id = 'root';
    doc.body.appendChild(root);
    return root;
  } catch {
    return null;
  }
}
