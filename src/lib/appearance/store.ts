import { DEFAULT_APPEARANCE, normalizeAppearance, parseAppearance, requestedPalette, resolvePalette, themeVariables, type Appearance, type ColorKey } from './model';

export const APPEARANCE_KEY = 'harmolyn:appearance:v1';
let current: Appearance = normalizeAppearance(DEFAULT_APPEARANCE);
let initialized = false;
let dispose: (() => void) | undefined;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let pendingWrite = false;
let persistenceAvailable = true;
const listeners = new Set<() => void>();
const publish = () => { for (const listener of [...listeners]) listener(); };
function apply(): void {
  if (typeof document === 'undefined') return;
  const palette = resolvePalette(requestedPalette(current));
  const root = document.documentElement;
  for (const [key, value] of Object.entries(themeVariables(palette))) root.style.setProperty(key, value);
  root.dataset.appearance = current.theme;
  root.dataset.appearanceMode = palette.mode;
  root.dataset.density = current.density;
  root.style.colorScheme = palette.mode;
  root.classList?.toggle('dark', palette.mode === 'dark');
  document.querySelector?.('meta[name="theme-color"]')?.setAttribute('content', palette.background);
}
function flush(): void {
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = undefined;
  if (!pendingWrite || typeof window === 'undefined') return;
  pendingWrite = false;
  const previous = persistenceAvailable;
  try { window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(current)); persistenceAvailable = true; }
  catch { persistenceAvailable = false; }
  if (previous !== persistenceAvailable) publish();
}
/** Install once, before first render. The returned disposer removes every listener. */
export function initializeAppearance(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (initialized) return dispose ?? (() => undefined);
  initialized = true;
  try { current = parseAppearance(window.localStorage.getItem(APPEARANCE_KEY)); persistenceAvailable = true; }
  catch { current = normalizeAppearance(null); persistenceAvailable = false; }
  apply();
  const onStorage = (event: StorageEvent) => {
    let ownStorage: Storage;
    try { ownStorage = window.localStorage; } catch { return; }
    if (event.storageArea !== ownStorage || (event.key !== null && event.key !== APPEARANCE_KEY)) return;
    // The latest completed external write wins; do not echo it back or resurrect
    // an older pending local selection after a cross-tab reset.
    if (writeTimer !== undefined) clearTimeout(writeTimer);
    writeTimer = undefined;
    pendingWrite = false;
    current = parseAppearance(event.key === null ? null : event.newValue);
    apply(); publish();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener('pagehide', flush);
  let disposed = false;
  dispose = () => {
    if (disposed) return;
    disposed = true;
    flush();
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('pagehide', flush);
    initialized = false;
    dispose = undefined;
  };
  return dispose;
}
export const getAppearance = (): Appearance => current;
export const canPersistAppearance = (): boolean => persistenceAvailable;
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function updateAppearance(update: (value: Appearance) => Appearance): void {
  if (!initialized) initializeAppearance();
  const next = normalizeAppearance(update(current));
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  current = next;
  apply(); publish();
  pendingWrite = true;
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  // Native color pickers can send many events per second. Rendering is immediate,
  // but synchronous storage writes are coalesced and flushed on pagehide.
  writeTimer = setTimeout(flush, 120);
}
export function setThemeColor(key: ColorKey, value: string): void {
  updateAppearance(p => ({ ...p, custom: { ...p.custom, [p.theme]: { ...p.custom[p.theme], [key]: value } } }));
}
export function resetTheme(): void {
  updateAppearance(p => { const custom = { ...p.custom }; delete custom[p.theme]; return { ...p, custom }; });
}
