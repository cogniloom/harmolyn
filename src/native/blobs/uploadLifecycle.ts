// Uploads belong to the identity and visible conversation that admitted them.
// Native navigation publishes focus/visibility events; checking at each async
// boundary also covers headless callers and state changes without a UI publish.
import { getState } from '../state/store.js';

export function uploadAborted(): Error {
  const error = new Error('Attachment upload cancelled.');
  error.name = 'AbortError';
  return error;
}

export interface UploadGuard {
  signal: AbortSignal;
  check: () => void;
}

export function createUploadLifetime(scopeId: string, ownerPeerId: string, external?: AbortSignal): UploadGuard & { dispose: () => void } {
  const controller = new AbortController();
  const initialScope = getState().active_scope;
  const initialIdentity = getState().identity?.peer_id ?? '';
  const abort = () => controller.abort(uploadAborted());
  const check = () => {
    const state = getState();
    if ((state.identity?.peer_id ?? '') !== initialIdentity
      || (scopeId && (ownerPeerId !== initialIdentity || state.active_scope !== initialScope))
      || (scopeId && initialScope !== null && initialScope !== scopeId)) abort();
    if (controller.signal.aborted) throw uploadAborted();
  };
  // Event callbacks must not throw into native snapshot publication.
  const onSnapshot = () => { try { check(); } catch { /* signal carries cancellation */ } };
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) abort();
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onSnapshot);
    window.addEventListener('pagehide', abort);
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onSnapshot);
  return {
    signal: controller.signal,
    check,
    dispose: () => {
      external?.removeEventListener('abort', abort);
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onSnapshot);
        window.removeEventListener('pagehide', abort);
      }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onSnapshot);
    },
  };
}

/** Stop awaiting a cancelled request and always observe its eventual outcome.
 * Bytes already handed to a transport cannot be recalled. Callers check again
 * before dispatch so cancelled workers cannot start another provider/batch. */
export function awaitUpload<T>(operation: Promise<T>, guard?: UploadGuard): Promise<T> {
  if (!guard) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { finish(); reject(uploadAborted()); };
    const finish = () => guard.signal.removeEventListener('abort', abort);
    guard.signal.addEventListener('abort', abort, { once: true });
    operation.then(value => {
      finish();
      try { guard.check(); resolve(value); } catch (error) { reject(error); }
    }, error => { finish(); reject(error); });
    try { guard.check(); } catch (error) { finish(); reject(error); }
    if (guard.signal.aborted) { finish(); abort(); }
  });
}
