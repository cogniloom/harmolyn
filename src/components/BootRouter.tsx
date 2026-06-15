import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { readShellRuntimeData, subscribeShellRuntimeData } from '@/data';
import { Layout } from '@/components/Layout';
import { ensureRelays } from '@/lib/xoreinControl';
import { DEFAULT_RELAY_MULTIADDRS } from '@/config/runtimeDefaults';
import { useFeature } from '@/hooks/useFeature';
import { useNativeEngine } from '@/native/engine/provider';
import { Spinner } from '@/components/ui/Spinner';

const RELAY_ADDRS_STORAGE_KEY = 'harmolyn:xorein:relay-multiaddrs';

export const BootRouter: React.FC = () => {
  const shellData = useSyncExternalStore(subscribeShellRuntimeData, readShellRuntimeData, readShellRuntimeData);
  const runtimeAvailable = shellData.runtimeSnapshot !== null;

  const relayAutoConnect = useFeature('relayAutoConnect');
  const relayEnsuredRef = useRef(false);

  // Real boot-phase activity from the native engine (same source UnlockScreen
  // reads). Falls back to friendly static copy when no live phase is reported —
  // never fabricate phases.
  const { activity } = useNativeEngine();
  const statusMessage =
    activity.phase !== 'idle' && activity.phase !== 'error' && activity.message
      ? activity.message
      : 'Connecting to your node…';

  useEffect(() => {
    if (!runtimeAvailable || !relayAutoConnect || relayEnsuredRef.current) return;
    relayEnsuredRef.current = true;

    let extra: string[] = [];
    try {
      const stored = localStorage.getItem(RELAY_ADDRS_STORAGE_KEY);
      if (stored) extra = JSON.parse(stored) as string[];
    } catch { /* ignore */ }

    const addrs = [...DEFAULT_RELAY_MULTIADDRS, ...extra].filter(Boolean);
    if (addrs.length > 0) {
      void ensureRelays(shellData.runtimeSnapshot, addrs);
    }
  }, [runtimeAvailable, relayAutoConnect, shellData.runtimeSnapshot]);

  // Gate 1: xorein runtime not yet available
  if (!runtimeAvailable) {
    return (
      <div
        className="flex h-screen w-full bg-bg-0 items-center justify-center flex-col gap-4"
        role="status"
        aria-live="polite"
      >
        <Spinner size={28} className="text-text-secondary" />
        <p className="text-body-strong text-text-secondary">
          {statusMessage}
        </p>
        <button
          onClick={() => window.location.reload()}
          aria-label="Retry connecting"
          className="focus-ring px-4 py-2 rounded-full text-sm font-medium text-white hover:opacity-80 transition-opacity"
          style={{ background: 'var(--accent, #5865f2)' }}
        >
          Retry
        </button>
      </div>
    );
  }

  return <Layout />;
};
