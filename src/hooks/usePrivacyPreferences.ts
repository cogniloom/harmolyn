import { useCallback, useMemo } from 'react';
import { usePersistentState } from '@/hooks/usePersistentState';

export interface PrivacyPreferences {
  showPresence: boolean;
  shareReadReceipts: boolean;
  allowDiscovery: boolean;
  /** Remote requests disclose the reader's IP/timing; loading is opt-in. */
  loadRemoteMedia: boolean;
}
export const PRIVACY_STORAGE_KEY = 'harmolyn:settings:privacy';
export const PRIVACY_DEFAULTS: PrivacyPreferences = {
  showPresence: true, shareReadReceipts: true, allowDiscovery: false, loadRemoteMedia: false,
};
type PrivacyUpdater = PrivacyPreferences | ((current: PrivacyPreferences) => PrivacyPreferences);

export function normalizePrivacyPreferences(value: unknown): PrivacyPreferences {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const flag = (key: keyof PrivacyPreferences) => typeof record[key] === 'boolean' ? record[key] as boolean : PRIVACY_DEFAULTS[key];
  return { showPresence: flag('showPresence'), shareReadReceipts: flag('shareReadReceipts'), allowDiscovery: flag('allowDiscovery'), loadRemoteMedia: flag('loadRemoteMedia') };
}

export function usePrivacyPreferences(): [PrivacyPreferences, (value: PrivacyUpdater) => void] {
  const [stored, setStored] = usePersistentState(PRIVACY_STORAGE_KEY, PRIVACY_DEFAULTS);
  const resolved = useMemo(() => normalizePrivacyPreferences(stored), [stored]);
  const setResolved = useCallback((value: PrivacyUpdater) => {
    setStored(current => normalizePrivacyPreferences(typeof value === 'function' ? value(normalizePrivacyPreferences(current)) : value));
  }, [setStored]);
  return [resolved, setResolved];
}
