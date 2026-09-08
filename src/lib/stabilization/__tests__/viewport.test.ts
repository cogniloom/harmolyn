import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { installVisualViewport } from '../viewport';

describe('visual viewport lifecycle', () => {
  it('batches resize events, preserves pinch zoom and restores only owned CSS values', () => {
    const values = new Map<string, string>([['--harmolyn-viewport-height', '777px']]);
    const style = { getPropertyValue: (name: string) => values.get(name) ?? '', getPropertyPriority: () => '', setProperty: (name: string, value: string) => values.set(name, value), removeProperty: (name: string) => values.delete(name) };
    const viewport = Object.assign(new EventTarget(), { height: 450, offsetTop: 20, scale: 1 });
    const frames = new Map<number, FrameRequestCallback>(); let sequence = 0;
    const win = Object.assign(new EventTarget(), { visualViewport: viewport, innerHeight: 900, document: { documentElement: { style } }, requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: (id: number) => frames.delete(id) });
    const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); };
    const dispose = installVisualViewport(win as unknown as Window); assert.equal(values.get('--harmolyn-viewport-height'), '450px');
    viewport.height = 400; viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll')); win.dispatchEvent(new Event('resize')); assert.equal(frames.size, 1); flush(); assert.equal(values.get('--harmolyn-viewport-height'), '400px');
    viewport.scale = 2; viewport.height = 200; viewport.dispatchEvent(new Event('resize')); flush(); assert.equal(values.get('--harmolyn-viewport-height'), '400px');
    values.set('--harmolyn-viewport-top', '99px'); viewport.dispatchEvent(new Event('resize')); dispose(); assert.equal(frames.size, 0); assert.equal(values.get('--harmolyn-viewport-height'), '777px'); assert.equal(values.get('--harmolyn-viewport-top'), '99px');
  });
});
