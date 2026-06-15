import { describe, expect, it } from 'vitest';
import { resolveRootElement } from './bootstrapRoot';

describe('resolveRootElement', () => {
  it('returns the existing root element', () => {
    const doc = document.implementation.createHTMLDocument('app');
    const root = doc.createElement('div');
    root.id = 'root';
    doc.body.appendChild(root);

    expect(resolveRootElement(doc)).toBe(root);
  });

  it('creates a root element when the host document is missing one', () => {
    const doc = document.implementation.createHTMLDocument('app');

    const root = resolveRootElement(doc);

    expect(root).toBeInstanceOf(HTMLElement);
    expect(root?.id).toBe('root');
    expect(doc.body.querySelector('#root')).toBe(root);
  });

  it('returns null when root resolution throws', () => {
    const brokenDocument = {
      getElementById() {
        throw new Error('blocked');
      },
    } as unknown as Document;

    expect(resolveRootElement(brokenDocument)).toBeNull();
  });
});
