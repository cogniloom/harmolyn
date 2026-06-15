// React context provider for the xorein native engine (P10 cutover gate).
// When the `nativeEngine` feature flag is enabled, this provider starts the
// native P2P engine and makes it available throughout the component tree.
//
// Identity modes:
//   • guest      — no persisted identity and no passphrase → ephemeral identity.
//   • registered — a password-protected identity is persisted in IndexedDB and
//                  requires the user passphrase to decrypt.
//   • locked     — a registered identity exists but no passphrase has been
//                  supplied yet (await unlock). The engine does not start.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { resolveFeatureFlag } from '@/config/featureFlags';
import { hasValidSession } from '@/native/identity/storage';
import type { XoreinNativeEngine, EngineActivity } from './engine';

type NativeEngineState =
  | 'disabled'
  | 'starting'
  | 'locked'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

interface NativeEngineContextValue {
  engine: XoreinNativeEngine | null;
  state: NativeEngineState;
  /** True when a registered (password-protected) identity exists on this device. */
  hasRegisteredIdentity: boolean;
  error?: string;
  /**
   * Promote the live (guest) identity to a registered one. Bound to the engine
   * instance directly so it works throughout the connect window — registration
   * only needs the keypair (resolved early in `start()`), NOT a connected relay.
   * Using the `engine` field instead would fail here: that field is intentionally
   * null until `state === 'connected'` (it also gates the unlock screen), so a
   * user who creates an account while the relay is still reserving a circuit would
   * otherwise fall through to the HTTP path and stay "Viewing as guest".
   */
  registerIdentity: (passphrase: string, displayName?: string, bio?: string) => Promise<void>;
  /** Human-facing startup/connectivity phase, for transparent loading indicators. */
  activity: EngineActivity;
}

const NativeEngineContext = createContext<NativeEngineContextValue>({
  engine: null,
  state: 'disabled',
  hasRegisteredIdentity: false,
  registerIdentity: () => Promise.reject(new Error('native engine unavailable')),
  activity: { phase: 'idle', message: '' },
});

// eslint-disable-next-line react-refresh/only-export-components
export function useNativeEngine(): NativeEngineContextValue {
  return useContext(NativeEngineContext);
}

interface NativeEngineProviderProps {
  children: React.ReactNode;
  /**
   * User passphrase for identity decryption. Undefined runs as a guest when no
   * registered identity exists, or keeps the engine `locked` when one does.
   */
  passphrase?: string;
  /**
   * Monotonic submit counter. Changing it forces a fresh start attempt even when
   * `passphrase` is unchanged, so retrying the same password always re-decrypts.
   */
  passphraseNonce?: number;
}

const LEGACY_DEVICE_KEY = 'harmolyn:native:device-key';
const NATIVE_STATE_KEY = 'harmolyn:native:state';

export function NativeEngineProvider({ children, passphrase, passphraseNonce = 0 }: NativeEngineProviderProps) {
  const flagOn = resolveFeatureFlag('nativeEngine');
  // null = still determining whether a registered identity is persisted.
  const [hasRegistered, setHasRegistered] = useState<boolean | null>(null);
  const [state, setState] = useState<NativeEngineState>(flagOn ? 'starting' : 'disabled');
  const [error, setError] = useState<string | undefined>();
  const [activity, setActivity] = useState<EngineActivity>({ phase: 'idle', message: '' });
  const engineRef = useRef<XoreinNativeEngine | null>(null);
  const [engine, setEngine] = useState<XoreinNativeEngine | null>(null);

  // One-time: detect a persisted identity (and migrate away from the legacy
  // device-key scheme, which was not a real password).
  useEffect(() => {
    if (!flagOn) { setHasRegistered(false); return; }
    let mounted = true;
    void (async () => {
      try {
        const storage = await import('../identity/storage');
        // Legacy migration: older builds auto-encrypted the identity under a
        // device key kept in cleartext localStorage — i.e. no real password.
        // Drop it so the user is taken through the mandatory-password flow.
        if (typeof localStorage !== 'undefined' && localStorage.getItem(LEGACY_DEVICE_KEY)) {
          await storage.clearPersistedIdentity().catch(() => {});
          try {
            localStorage.removeItem(LEGACY_DEVICE_KEY);
            localStorage.removeItem(NATIVE_STATE_KEY);
          } catch { /* best effort */ }
        }
        const persisted = await storage.hasPersistedIdentity().catch(() => false);
        if (mounted) setHasRegistered(persisted);
      } catch {
        if (mounted) setHasRegistered(false);
      }
    })();
    return () => { mounted = false; };
  }, [flagOn]);

  // locked: a registered identity exists, no passphrase was supplied, and no
  // valid 5-day session exists to unlock without a password.
  const locked = flagOn && hasRegistered === true && !passphrase && !hasValidSession();

  useEffect(() => {
    if (!flagOn) { setState('disabled'); return; }
    if (hasRegistered === null) { setState('starting'); return; }
    if (locked) { setState('locked'); return; }

    let mounted = true;
    setState('starting');
    setError(undefined);
    void import('./engine').then(({ XoreinNativeEngine }) => {
      if (!mounted) return;
      const e = new XoreinNativeEngine({
        passphrase,
        // Expose the engine as soon as the local identity + E2EE layer are ready,
        // before the relay connects. This makes local mutations (createServer,
        // sendMessage, etc.) available even when offline.
        onLocalReady: () => {
          if (mounted) setEngine(engineRef.current);
        },
        onStateChange: (s) => {
          if (!mounted) return;
          // Also set engine on 'connected' in case onLocalReady fired before mount
          // completed (unlikely but safe — setEngine is idempotent).
          if (s === 'connected') setEngine(engineRef.current);
          setState(s);
        },
        onActivity: (a) => { if (mounted) setActivity(a); },
      });
      engineRef.current = e;

      e.start().then(() => {
        if (mounted) { setEngine(e); setState('connected'); }
      }).catch((err: Error) => {
        if (!mounted) return;
        const msg = err?.message ?? String(err);
        // A wrong/absent passphrase is recoverable: return to `locked` so the
        // unlock screen can re-prompt rather than dead-ending on a fatal error.
        if (/decryption failed|passphrase|locked/i.test(msg)) {
          setError('Incorrect password. Please try again.');
          setState('locked');
          setActivity({ phase: 'idle', message: '' });
        } else {
          setError(msg);
          setState('error');
          setActivity({ phase: 'error', message: 'Something went wrong', detail: msg });
        }
      });
    });

    return () => {
      mounted = false;
      engineRef.current?.stop().catch(() => {});
      engineRef.current = null;
    };
  }, [flagOn, hasRegistered, locked, passphrase, passphraseNonce]);

  // Stable callback bound to the live engine ref (set synchronously at
  // construction), so identity registration is available even before the
  // transport connects. The engine resolves its keypair early in start(), so
  // by the time a user has filled the create form `_identity` is ready.
  const registerIdentity = useCallback(
    (pass: string, displayName?: string, bio?: string): Promise<void> => {
      const e = engineRef.current;
      if (!e) return Promise.reject(new Error('native engine not started'));
      return e.register(pass, displayName, bio);
    },
    [],
  );

  const value = useMemo<NativeEngineContextValue>(
    () => ({ engine, state, error, hasRegisteredIdentity: hasRegistered === true, registerIdentity, activity }),
    [engine, state, error, hasRegistered, registerIdentity, activity],
  );

  return (
    <NativeEngineContext.Provider value={value}>
      {children}
    </NativeEngineContext.Provider>
  );
}
