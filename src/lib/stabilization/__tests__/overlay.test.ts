import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { registerEscapeHandler } from '../escape';
import { event } from './support';

describe('overlay dismissal', () => {
  it('dismisses the newest overlay only, then restores the parent', () => {
    const doc = new EventTarget(); const calls: string[] = [];
    const parent = registerEscapeHandler(doc as Document, () => calls.push('parent'));
    const child = registerEscapeHandler(doc as Document, () => calls.push('child'));
    doc.dispatchEvent(event('keydown', { key: 'Escape' })); assert.deepEqual(calls, ['child']);
    child(); child(); doc.dispatchEvent(event('keydown', { key: 'Escape' })); assert.deepEqual(calls, ['child', 'parent']);
    parent(); doc.dispatchEvent(event('keydown', { key: 'Escape' })); assert.equal(calls.length, 2);
  });
  it('leaves composition and already-handled Escape alone', () => {
    const doc = new EventTarget(); let calls = 0;
    const release = registerEscapeHandler(doc as Document, () => calls++);
    doc.dispatchEvent(event('keydown', { key: 'Escape', isComposing: true }));
    doc.dispatchEvent(event('keydown', { key: 'Escape', keyCode: 229 }));
    const handled = event('keydown', { key: 'Escape' }); handled.preventDefault(); doc.dispatchEvent(handled);
    assert.equal(calls, 0); release();
  });
  it('keeps duplicate callback registrations independent', () => {
    const doc = new EventTarget(); let calls = 0; const callback = () => calls++;
    const first = registerEscapeHandler(doc as Document, callback); const second = registerEscapeHandler(doc as Document, callback);
    first(); doc.dispatchEvent(event('keydown', { key: 'Escape' })); assert.equal(calls, 1); second();
  });
});

