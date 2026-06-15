import { usePersistentState } from '@/hooks/usePersistentState';

/**
 * User-controlled privacy preferences. Stored locally (browser) under a single
 * key so every surface that honors them stays in sync. New fields default to a
 * privacy-respecting value and are merged over any older stored object so
 * existing users pick them up without losing their saved choices.
 */
export interface PrivacyPreferences {
  /** Expose online/offline state to peers. */
  showPresence: boolean;
  /** Mark messages as read for the other side. */
  shareReadReceipts: boolean;
  /** List this account in local discovery surfaces. */
  allowDiscovery: boolean;
  /**
   * Auto-load remote media (images, video thumbnails) embedded in messages.
   * When false, remote resources are not fetched until the user reveals them,
   * preventing remote servers from learning the reader's IP/timing.
   */
  loadRemoteMedia: boolean;
}

export const PRIVACY_STORAGE_KEY = 'harmolyn:settings:privacy';

export const PRIVACY_DEFAULTS: PrivacyPreferences = {
  showPresence: true,
  shareReadReceipts: true,
  allowDiscovery: false,
  // Privacy-first: remote media is not fetched until the user opts in, so a
  // host can't learn the reader's IP/timing from an embedded image by default.
  loadRemoteMedia: false,
};

type PrivacyUpdater = PrivacyPreferences | ((current: PrivacyPreferences) => PrivacyPreferences);

/**
 * Reads privacy preferences with defaults merged in, so every field is always
 * a defined boolean even if the stored object predates a newer field.
 */
export function usePrivacyPreferences(): [PrivacyPreferences, (value: PrivacyUpdater) => void] {
  const [stored, setStored] = usePersistentState<PrivacyPreferences>(PRIVACY_STORAGE_KEY, PRIVACY_DEFAULTS);
  const resolved: PrivacyPreferences = { ...PRIVACY_DEFAULTS, ...stored };
  const setResolved = (value: PrivacyUpdater) => {
    setStored((current) => {
      const base: PrivacyPreferences = { ...PRIVACY_DEFAULTS, ...current };
      return typeof value === 'function' ? value(base) : value;
    });
  };
  return [resolved, setResolved];
}
