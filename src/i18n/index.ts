// i18n bootstrap. Initializes i18next (with ICU message formatting for plurals /
// gender / interpolation), seeded from the in-app locale preference (locale.ts) so
// language and date/number formatting stay in sync. Import this module once for its
// side effect (main.tsx) before rendering.
//
// Catalogs are per-namespace JSON under ./locales/<lng>/<ns>.json. English is the
// source-of-truth catalog; a machine-generated pseudo-locale ('en-XA') is derived
// from it at runtime to surface untranslated strings and layout/expansion bugs in
// tests without shipping a hand-written second language.
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ICU from 'i18next-icu';
import { getLocale } from '@/lib/locale';

import enCommon from './locales/en/common.json';
import enSettings from './locales/en/settings.json';
import enOnboarding from './locales/en/onboarding.json';
import enAuth from './locales/en/auth.json';
import enVoice from './locales/en/voice.json';
import enErrors from './locales/en/errors.json';

export const NAMESPACES = ['common', 'settings', 'onboarding', 'auth', 'voice', 'errors'] as const;
export type Namespace = (typeof NAMESPACES)[number];

/**
 * Languages offered in the in-app picker. Each entry has a bundled UI catalog (so
 * selecting it produces a real, visible translation — never a fake option that only
 * changes a stored string). English is the source catalog; the pseudo-locale is a
 * dev/test aid. Additional languages appear here as their catalogs are translated.
 * Regardless of UI-string coverage, the selected locale also drives all date, time,
 * and number formatting via Intl (locale.ts), so formatting is localized app-wide.
 */
export interface SupportedLanguage {
  /** BCP-47 tag used for i18next + Intl. */
  code: string;
  /** Endonym (the language's own name), shown in the picker. */
  label: string;
  /** True for right-to-left scripts. */
  rtl?: boolean;
  /** Hidden from the production picker (dev/test only). */
  devOnly?: boolean;
}

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: 'en', label: 'English' },
  { code: 'en-XA', label: 'Pseudo (test)', rtl: false, devOnly: true },
];

// Right-to-left scripts we support. Drives <html dir> and logical-property layout.
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi']);

/** The base language subtag (e.g. 'en' from 'en-US'). */
export function baseLanguage(lng: string | undefined): string {
  return (lng ?? 'en').toLowerCase().split('-')[0];
}

/** Whether a locale is written right-to-left. */
export function isRtlLocale(lng: string | undefined): boolean {
  return RTL_LANGUAGES.has(baseLanguage(lng));
}

const enResources = {
  common: enCommon,
  settings: enSettings,
  onboarding: enOnboarding,
  auth: enAuth,
  voice: enVoice,
  errors: enErrors,
};

// Pseudo-locale: expands and brackets every English string so untranslated text and
// truncation are obvious. Purely derived — never hand-maintained.
function pseudoize(value: unknown): unknown {
  if (typeof value === 'string') {
    // Preserve ICU placeholders ({name}, {count, plural, ...}) — only decorate literals.
    return `⟦${value.replace(/([^{}]+)/g, (seg) => (seg.trim() ? `${seg}‥` : seg))}⟧`;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = pseudoize(v);
    return out;
  }
  return value;
}

const pseudoResources = Object.fromEntries(
  Object.entries(enResources).map(([ns, cat]) => [ns, pseudoize(cat)]),
) as typeof enResources;

/** Apply the document text direction + lang for a locale (RTL-aware). */
export function applyDocumentDirection(lng: string | undefined): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dir = isRtlLocale(lng) ? 'rtl' : 'ltr';
  document.documentElement.lang = baseLanguage(lng);
}

void i18n
  .use(ICU)
  .use(initReactI18next)
  .init({
    lng: getLocale() ?? 'en',
    fallbackLng: 'en',
    // The catalogs we actually bundle. Declaring them lets i18next resolve a requested
    // language to a REAL catalog (e.g. an unsupported 'ar'/'ja-JP' resolves to 'en'), so
    // `resolvedLanguage` reflects what's rendered — which we use to label the document.
    // nonExplicitSupportedLngs lets a region tag like 'en-US' resolve to the base 'en'.
    supportedLngs: ['en', 'en-XA'],
    nonExplicitSupportedLngs: true,
    ns: NAMESPACES as unknown as string[],
    defaultNS: 'common',
    resources: {
      en: enResources,
      // Expose the source catalog under the browser-default region tags too, so a
      // navigator locale like 'en-US' resolves without a missing-catalog warning.
      'en-XA': pseudoResources,
    },
    interpolation: { escapeValue: false }, // React already escapes.
    returnNull: false,
    // Keep tests + console clean; a genuinely missing key still shows the key text.
    saveMissing: false,
  });

// Keep <html dir/lang> in sync with the RENDERED catalog, now and on every change. Use the
// RESOLVED language, not the requested one: an unsupported system locale (e.g. 'ar', 'ja-JP')
// renders the English fallback, so labeling the document 'ar'/RTL would mislabel English to
// assistive tech and needlessly mirror the layout. The system locale is retained separately
// for Intl/date formatting (src/lib/locale.ts).
const renderedLanguage = (lng?: string): string => i18n.resolvedLanguage ?? lng ?? i18n.language;
applyDocumentDirection(renderedLanguage());
i18n.on('languageChanged', (lng) => applyDocumentDirection(renderedLanguage(lng)));

export default i18n;
