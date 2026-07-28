import { useEffect, useState } from 'react';

/**
 * Tracks the browser's network reachability (navigator.onLine). Distinct from
 * xorein peer connectivity — this is "does this device have a network at all",
 * used to show an honest offline banner. Defaults to online when the API is absent.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(
    typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' ? true : navigator.onLine,
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  return online;
}
