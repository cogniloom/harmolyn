/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useMemo } from 'react';
import { useToasts, type Toast } from '@/components/useToasts';
import { NotificationToast } from '@/components/NotificationToast';

type ToastInput = Omit<Toast, 'id' | 'timestamp'> & { id?: string };

export interface ToastApi {
  notify: (input: ToastInput) => string;
  info: (body: string, title?: string) => string;
  success: (body: string, title?: string) => string;
  error: (body: string, title?: string) => string;
  /** Durable "in-flight" toast. Returns its id so you can update()/dismiss() it. */
  loading: (body: string, title?: string) => string;
  /** Patch a toast in place (e.g. flip a loading toast to success/error). */
  update: (id: string, patch: Partial<Omit<Toast, 'id' | 'timestamp'>>) => void;
  dismiss: (id: string) => void;
}

// No-op fallback so components used outside the provider (e.g. isolated unit
// tests) never crash on toast.* calls.
const NOOP: ToastApi = {
  notify: () => '', info: () => '', success: () => '', error: () => '', loading: () => '',
  update: () => {}, dismiss: () => {},
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}

/**
 * Mounts a single toast stack at the app root and exposes a small imperative API
 * (`info/success/error/loading/update/dismiss`) via `useToast()`. This makes
 * background work visible from anywhere — a mutation can fire a durable
 * "Sending…" toast and flip it to "Sent"/error on settle, even after the user
 * has navigated away from the originating panel.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { toasts, addToast, updateToast, dismissToast } = useToasts();

  const api = useMemo<ToastApi>(() => ({
    notify: (input) => addToast(input),
    info: (body, title = 'Info') => addToast({ type: 'info', title, body }),
    success: (body, title = 'Done') => addToast({ type: 'success', title, body }),
    error: (body, title = 'Something went wrong') => addToast({ type: 'error', title, body }),
    loading: (body, title = 'Working…') => addToast({ type: 'loading', title, body, durable: true }),
    update: (id, patch) => updateToast(id, patch),
    dismiss: (id) => dismissToast(id),
  }), [addToast, updateToast, dismissToast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <NotificationToast toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}
