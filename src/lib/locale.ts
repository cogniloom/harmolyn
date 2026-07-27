// Locale resolution for date/time/number formatting. Uses an explicit in-app
// preference if the user set one (harmolyn:locale), otherwise the browser/OS
// locale — so a reader in Berlin or Tokyo sees their own date and time formats
// instead of hardcoded US ones. Falls back to the runtime default when unknown.
const LOCALE_STORAGE_KEY = 'harmolyn:locale';

export function getLocale(): string | undefined {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (stored && stored.trim()) return stored.trim();
    }
  } catch { /* storage unavailable */ }
  if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
  return undefined; // Intl uses the runtime default locale
}

export function setLocale(locale: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (locale) localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    else localStorage.removeItem(LOCALE_STORAGE_KEY);
  } catch { /* best effort */ }
}

/** Locale-aware date/time formatter. Pass the same options you'd give Intl.DateTimeFormat. */
export function formatDateTime(value: number | Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(getLocale(), options).format(value);
}
