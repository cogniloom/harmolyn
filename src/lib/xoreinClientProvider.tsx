/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import { readShellRuntimeData, subscribeShellRuntimeData } from '@/data';
import {
  connectToDefaultRuntime,
  DEFAULT_CONTROL_ENDPOINT,
  readNativeRuntimeBootstrapStatus,
  refreshRuntimeSnapshot,
  subscribeRuntimeEvents,
} from '@/lib/xoreinControl';
import { XoreinBootstrapContext, XoreinRuntimeContext, type XoreinBootstrapState } from '@/lib/xoreinRuntimeContext';
import { normalizeRuntimeEndpoint, normalizeRuntimeSettings } from '@/lib/authPreview';
import { NativeEngineProvider, useNativeEngine } from '@/native/engine/provider';
import { publishNativeSnapshot } from '@/native/state/snapshot';
import { resolveFeatureFlag } from '@/config/featureFlags';

/**
 * In-memory passphrase channel. The unlock screen calls setPassphrase() to hand
 * the user's password to the native engine; it is never written to storage.
 */
interface EnginePassphraseContextValue {
  setPassphrase: (passphrase: string | undefined) => void;
}

const EnginePassphraseContext = createContext<EnginePassphraseContextValue>({ setPassphrase: () => {} });

export function useEnginePassphrase(): EnginePassphraseContextValue {
  return useContext(EnginePassphraseContext);
}

/**
 * Clear all local identity/runtime state and reload, yielding a fresh guest.
 * Removes: the registered identity (IndexedDB), the ephemeral guest identity
 * (sessionStorage), the native state, the published runtime snapshot, and any
 * legacy device key.
 */
export async function resetLocalIdentity(): Promise<void> {
  try {
    const storage = await import('@/native/identity/storage');
    await storage.clearPersistedIdentity().catch(() => {});
    storage.clearGuestIdentity();
    storage.clearSessionIdentity();
  } catch { /* best effort */ }
  try {
    for (const key of [
      'harmolyn:native:device-key',
      'harmolyn:native:state',
      'harmolyn:xorein:runtime',
      'harmolyn:runtime-snapshot',
      'xorein:runtime-snapshot',
    ]) {
      localStorage.removeItem(key);
    }
  } catch { /* best effort */ }
  try {
    // Guest app-state lives in sessionStorage; clear it too so a reset is a true
    // fresh guest within the same browsing session.
    for (const key of ['harmolyn:native:state', 'harmolyn:native:guest-identity']) {
      sessionStorage.removeItem(key);
    }
  } catch { /* best effort */ }
  try {
    for (const key of ['__HARMOLYN_XOREIN_RUNTIME__', '__HARMOLYN_RUNTIME_SNAPSHOT__', '__XOREIN_RUNTIME_SNAPSHOT__', '__HARMOLYN_NATIVE_ACTIVE__']) {
      delete (window as unknown as Record<string, unknown>)[key];
    }
  } catch { /* best effort */ }
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}

function NativeEngineBootstrap({ children }: { children: React.ReactNode }) {
  // The passphrase lives only in memory for this session. A guest has none; the
  // unlock screen supplies it for a registered identity.
  const [passphrase, setPassphraseValue] = useState<string | undefined>(undefined);
  // Bump a nonce on every submit so re-entering the SAME password (or retrying
  // after a transient non-passphrase start() error) always re-triggers a decrypt
  // attempt — otherwise React's useState bail-out on an identical value would
  // make the UNLOCK button a silent no-op and strand the user.
  const [passphraseNonce, setPassphraseNonce] = useState(0);
  const setPassphrase = useCallback((p: string | undefined) => {
    setPassphraseValue(p);
    setPassphraseNonce((n) => n + 1);
  }, []);
  const ctx = useMemo<EnginePassphraseContextValue>(() => ({ setPassphrase }), [setPassphrase]);
  return (
    <EnginePassphraseContext.Provider value={ctx}>
      <NativeEngineProvider passphrase={passphrase} passphraseNonce={passphraseNonce}>{children}</NativeEngineProvider>
    </EnginePassphraseContext.Provider>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 0, retry: 1 },
  },
});

function XoreinRuntimeProvider({ children }: { children: React.ReactNode }) {
  const { state: nativeEngineState, activity: nativeActivity } = useNativeEngine();
  const nativeActive = nativeEngineState === 'connected';
  // The native engine owns the runtime snapshot whenever the flag is on (the
  // default). Read the flag synchronously so the HTTP autoconnect/poll is never
  // armed during the async window where the engine is still 'starting' — that
  // window is exactly what let the HTTP control client publish (and on origin
  // rejection, *clear*) the shared snapshot keys, producing the flashing
  // left-rail server circles and the node's global server list leaking to guests.
  const nativeEngineFlagOn = resolveFeatureFlag('nativeEngine');
  const shellData = useSyncExternalStore(subscribeShellRuntimeData, readShellRuntimeData, readShellRuntimeData);
  const snapshot = shellData.runtimeSnapshot;
  const endpoint = normalizeRuntimeEndpoint(snapshot?.control_endpoint) || normalizeRuntimeSettings(snapshot?.settings)?.control_endpoint || '';
  const autoconnectDisabled = nativeEngineFlagOn
    || nativeActive
    || (typeof window !== 'undefined'
    && (window as unknown as Record<string, unknown>).__HARMOLYN_DISABLE_AUTOCONNECT__ === true);
  const [bootstrapState, setBootstrapState] = useState<XoreinBootstrapState>({
    status: autoconnectDisabled ? 'idle' : 'connecting',
    message: autoconnectDisabled ? '' : 'Connecting to the default xorein node...',
  });

  const syncBootstrapState = async (fallbackStatus: 'connecting' | 'retrying') => {
    const nativeStatus = await readNativeRuntimeBootstrapStatus();
    setBootstrapState({
      status: nativeStatus.phase === 'failed' ? 'failed' : nativeStatus.phase === 'idle' ? fallbackStatus : nativeStatus.phase,
      message: nativeStatus.message,
      detail: nativeStatus.detail,
    });
  };

  // On launch, bootstrap the default runtime connection and surface the native
  // startup state when the desktop shell provides it.
  useEffect(() => {
    let stopped = false;

    const connect = async () => {
      if (stopped || autoconnectDisabled) {
        return;
      }
      setBootstrapState({
        status: 'connecting',
        message: 'Connecting to the default xorein node...',
      });
      await syncBootstrapState('connecting');
      if (stopped) {
        return;
      }
      const connected = await connectToDefaultRuntime();
      if (stopped) {
        return;
      }
      if (connected) {
        setBootstrapState({
          status: 'ready',
          message: 'xorein runtime is ready.',
          detail: connected.control_endpoint,
        });
        return;
      }
      setBootstrapState({
        status: 'failed',
        message: `The default xorein node (${DEFAULT_CONTROL_ENDPOINT}) is not reachable right now.`,
        detail: 'Open the node picker to choose a local node or continue offline.',
      });
    };

    void connect();

    return () => {
      stopped = true;
    };
  }, [autoconnectDisabled]);

  // In native mode the HTTP autoconnect is disabled, so the startup banner would
  // otherwise stay dark. Bridge the in-browser engine's activity phases into the
  // existing bootstrap banner so the user sees live progress (connecting, syncing…).
  useEffect(() => {
    if (!nativeEngineFlagOn) return;
    const phase = nativeActivity.phase;
    const status: XoreinBootstrapState['status'] =
      phase === 'connected' ? 'ready'
      : phase === 'error' ? 'failed'
      : phase === 'discovering-peers' || phase === 'syncing' ? 'waiting'
      : phase === 'idle' || phase === 'reconnecting-relay' ? 'idle'
      : 'connecting'; // starting | decrypting | connecting-relay (initial only)
    setBootstrapState({ status, message: nativeActivity.message, detail: nativeActivity.detail });
  }, [nativeEngineFlagOn, nativeActivity]);

  useEffect(() => {
    if (!endpoint || nativeActive || nativeEngineFlagOn) {
      // When the native engine owns the snapshot (flag on, or already active),
      // never run the HTTP remote-refresh poll. Forcefully publish the native
      // snapshot to evict any stale HTTP snapshot still in the globals/storage.
      if (nativeActive || nativeEngineFlagOn) publishNativeSnapshot();
      return;
    }
    return subscribeRuntimeEvents(snapshot, () => {
      void refreshRuntimeSnapshot(snapshot, undefined).catch(() => undefined);
    });
  // Re-subscribe when the endpoint changes OR when native ownership changes
  // (native going 'connected' / flag on must stop HTTP polling immediately).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, nativeActive, nativeEngineFlagOn]);

  return (
    <XoreinBootstrapContext.Provider value={bootstrapState}>
      <XoreinRuntimeContext.Provider value={snapshot}>
        {children}
      </XoreinRuntimeContext.Provider>
    </XoreinBootstrapContext.Provider>
  );
}

export function XoreinAppProviders({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <NativeEngineBootstrap>
        <XoreinRuntimeProvider>
          {children}
        </XoreinRuntimeProvider>
      </NativeEngineBootstrap>
    </QueryClientProvider>
  );
}
