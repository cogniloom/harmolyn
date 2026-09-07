import assert from 'node:assert/strict';
import { test } from 'vitest';
import { APPEARANCE_KEY, canPersistAppearance, getAppearance, initializeAppearance, resetTheme, setThemeColor, subscribeAppearance, updateAppearance } from './store';
import { DEFAULT_APPEARANCE } from './model';
import { withGlobals, event } from '../stabilization/__tests__/support';

class LocalStore {
  data = new Map<string, string>(); writes = 0; fail = false;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.fail) throw new Error('quota'); this.writes++; this.data.set(key, value); }
}
async function fixture(run: (win: EventTarget & { localStorage: LocalStore }, props: Map<string, string>, dispose: () => void) => void | Promise<void>, stored?: string) {
  const win = Object.assign(new EventTarget(), { localStorage: new LocalStore() });
  if (stored !== undefined) win.localStorage.data.set(APPEARANCE_KEY, stored);
  const props = new Map<string, string>();
  const document = { documentElement: { style: { setProperty: (key: string, value: string) => props.set(key, value), colorScheme: '' }, dataset: {} } };
  await withGlobals({ window: win, document }, async () => {
    const dispose = initializeAppearance();
    try { await run(win, props, dispose); } finally { dispose(); }
  });
}
test('loads the persisted theme before render without writing defaults', async () => {
  await fixture((win, props) => {
    assert.equal(getAppearance().theme, 'rose');
    assert.equal(props.get('--appearance-background'), '#21131E');
    assert.equal(win.localStorage.writes, 0);
  }, JSON.stringify({ ...DEFAULT_APPEARANCE, theme: 'rose' }));
});
test('coalesces color input writes and flushes the latest value on pagehide', async () => {
  await fixture(win => {
    setThemeColor('accent', '#ABCDEF'); setThemeColor('accent', '#FEDCBA');
    assert.equal(win.localStorage.writes, 0);
    win.dispatchEvent(new Event('pagehide'));
    assert.equal(win.localStorage.writes, 1);
    assert.equal(JSON.parse(win.localStorage.getItem(APPEARANCE_KEY)!).custom.midnight.accent, '#FEDCBA');
  });
});
test('external storage updates cancel stale writes and are not echoed back', async () => {
  await fixture(win => {
    setThemeColor('accent', '#ABCDEF');
    win.dispatchEvent(event('storage', { key: APPEARANCE_KEY, storageArea: win.localStorage, newValue: JSON.stringify({ ...DEFAULT_APPEARANCE, theme: 'forest' }) }));
    assert.equal(getAppearance().theme, 'forest');
    win.dispatchEvent(new Event('pagehide'));
    assert.equal(win.localStorage.writes, 0);
  });
});
test('ignores unrelated storage areas and unrelated preference keys', async () => {
  await fixture(win => {
    const data = JSON.stringify({ ...DEFAULT_APPEARANCE, theme: 'rose' });
    win.dispatchEvent(event('storage', { key: APPEARANCE_KEY, storageArea: new LocalStore(), newValue: data }));
    win.dispatchEvent(event('storage', { key: 'other', storageArea: win.localStorage, newValue: data }));
    assert.equal(getAppearance().theme, 'midnight');
  });
});
test('storage clear resets appearance without repopulating deleted preferences', async () => {
  await fixture(win => {
    win.dispatchEvent(event('storage', { key: null, storageArea: win.localStorage, newValue: null }));
    assert.deepEqual(getAppearance(), DEFAULT_APPEARANCE);
    win.dispatchEvent(new Event('pagehide'));
    assert.equal(win.localStorage.writes, 0);
  }, JSON.stringify({ ...DEFAULT_APPEARANCE, theme: 'sand' }));
});
test('reset only clears the selected theme and preserves other custom palettes', async () => {
  await fixture(() => {
    setThemeColor('accent', '#ABCDEF');
    updateAppearance(p => ({ ...p, theme: 'rose', density: 'compact' }));
    setThemeColor('accent', '#FEDCBA'); resetTheme();
    assert.equal(getAppearance().custom.midnight.accent, '#ABCDEF');
    assert.equal(getAppearance().custom.rose, undefined);
    assert.equal(getAppearance().density, 'compact');
  });
});
test('storage failures keep the live theme and report session-only persistence', async () => {
  await fixture((win, props) => {
    win.localStorage.fail = true;
    updateAppearance(p => ({ ...p, theme: 'daylight' }));
    win.dispatchEvent(new Event('pagehide'));
    assert.equal(getAppearance().theme, 'daylight');
    assert.equal(props.get('--appearance-background'), '#F4F6FA');
    assert.equal(canPersistAppearance(), false);
  });
});
test('disposal and subscriptions have independent, idempotent lifetimes', async () => {
  await fixture((win, _props, dispose) => {
    let count = 0;
    const release = subscribeAppearance(() => { count++; });
    updateAppearance(p => ({ ...p, theme: 'graphite' }));
    assert.equal(count, 1); release(); release();
    updateAppearance(p => ({ ...p, theme: 'sand' }));
    assert.equal(count, 1); dispose(); dispose();
    win.dispatchEvent(event('storage', { key: APPEARANCE_KEY, storageArea: win.localStorage, newValue: null }));
    assert.equal(getAppearance().theme, 'sand');
  });
});

test('an old disposer cannot tear down a newly initialized appearance store', async () => {
  await fixture((win, _props, dispose) => {
    dispose();
    const nextDispose = initializeAppearance();
    try {
      dispose();
      win.dispatchEvent(event('storage', { key: APPEARANCE_KEY, storageArea: win.localStorage, newValue: JSON.stringify({ ...DEFAULT_APPEARANCE, theme: 'ocean' }) }));
      assert.equal(getAppearance().theme, 'ocean');
    } finally { nextDispose(); }
  });
});


test('a fresh successful storage read clears an earlier persistence error', async () => {
  await fixture(win => {
    win.localStorage.fail = true;
    updateAppearance(p => ({ ...p, theme: 'sand' }));
    win.dispatchEvent(new Event('pagehide'));
    assert.equal(canPersistAppearance(), false);
  });
  await fixture(() => { assert.equal(canPersistAppearance(), true); });
});
