const valueOrDefault = (value: string | undefined, fallback: string) =>
  value?.trim() || fallback;

export const siteConfig = {
  appUrl: valueOrDefault(import.meta.env.VITE_HARMOLYN_APP_URL, "https://web.harmolyn.com"),
  sourceUrl: valueOrDefault(
    import.meta.env.VITE_SOURCE_URL,
    "https://github.com/cogniloom/harmolyn",
  ),
  xoreinUrl: valueOrDefault(import.meta.env.VITE_XOREIN_URL, "https://xorein.com"),
  version: valueOrDefault(import.meta.env.VITE_APP_VERSION, "1.0.0-rc.1"),
} as const;
