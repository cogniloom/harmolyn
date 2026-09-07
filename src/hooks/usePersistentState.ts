import { useMemo, useSyncExternalStore } from 'react';
import { preferenceChannel } from '@/lib/stabilization/preferenceStore';

/** All mounted consumers of a key share updates; reading never writes a default. */
export function usePersistentState<T>(storageKey: string, fallback: T): [T, (value: T | ((current: T) => T)) => void] {
  const channel = useMemo(() => preferenceChannel(storageKey, fallback), [storageKey, fallback]);
  const value = useSyncExternalStore(channel.subscribe, channel.getSnapshot, () => fallback);
  return [value, channel.set];
}
