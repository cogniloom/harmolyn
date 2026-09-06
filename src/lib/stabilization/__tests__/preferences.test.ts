import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { preferenceChannel } from '../preferenceStore';
import { event, withGlobals } from './support';

describe('shared preferences', () => {
  function storageFixture() {
    const data = new Map<string, string>(); let writes = 0;
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { writes++; data.set(key, value); } };
    const win = Object.assign(new EventTarget(), { localStorage: storage });
    return { win, storage, data, writes: () => writes };
  }
  it('shares same-tab updates without writing defaults on mount', async () => {
    const f = storageFixture(); await withGlobals({ window: f.win }, () => {
      const a = preferenceChannel('test-pref-a', false); const b = preferenceChannel('test-pref-a', false); let notified = 0;
      const releaseA = a.subscribe(() => notified++); const releaseB = b.subscribe(() => notified++);
      assert.equal(f.writes(), 0); a.set(true); assert.equal(b.getSnapshot(), true); assert.equal(notified, 2); assert.equal(f.writes(), 1);
      b.set(true); assert.equal(f.writes(), 1); releaseA(); releaseB();
    });
  });
  it('serializes functional updates against the shared latest value and isolates keys', async () => {
    const f = storageFixture(); await withGlobals({ window: f.win }, () => {
      const a = preferenceChannel('test-pref-b', 0); const b = preferenceChannel('test-pref-b', 0); const other = preferenceChannel('test-pref-c', 10);
      const releases = [a.subscribe(() => {}), b.subscribe(() => {}), other.subscribe(() => {})];
      a.set(value => value + 1); b.set(value => value + 1); assert.equal(a.getSnapshot(), 2); assert.equal(other.getSnapshot(), 10);
      for (const release of releases) release();
    });
  });
  it('handles cross-tab changes and storage clear', async () => {
    const f = storageFixture(); await withGlobals({ window: f.win }, () => {
      const channel = preferenceChannel('test-pref-d', false); const release = channel.subscribe(() => {});
      f.data.set('test-pref-d', 'true'); f.win.dispatchEvent(event('storage', { key: 'test-pref-d', storageArea: f.storage })); assert.equal(channel.getSnapshot(), true);
      f.data.clear(); f.win.dispatchEvent(event('storage', { key: null, storageArea: f.storage })); assert.equal(channel.getSnapshot(), false); release();
    });
  });
  it('keeps a privacy choice effective when disk storage fails', async () => {
    const f = storageFixture(); f.storage.setItem = () => { throw new Error('quota'); };
    await withGlobals({ window: f.win }, () => {
      const channel = preferenceChannel('test-pref-e', true); const release = channel.subscribe(() => {});
      channel.set(false); assert.equal(channel.getSnapshot(), false); release();
    });
  });
});

