import { useCallback, useState } from 'react';

export interface Toast {
  id: string;
  type: 'mention' | 'message' | 'system' | 'voice' | 'info' | 'success' | 'error' | 'loading';
  title: string;
  body: string;
  avatar?: string;
  timestamp: number;
  /** When true the toast does NOT auto-dismiss (e.g. an in-flight "loading" toast). */
  durable?: boolean;
}

const TOAST_TYPES: readonly Toast['type'][] = ['mention', 'message', 'system', 'voice', 'info', 'success', 'error', 'loading'];

let toastSequence = 0;

function createToastId(): string {
  const next = toastSequence++;
  return `toast-${Date.now()}-${next}`;
}

function normalizeToastText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeToastType(value: unknown): Toast['type'] {
  return (TOAST_TYPES as readonly string[]).includes(value as string) ? (value as Toast['type']) : 'system';
}

export function normalizeToastInput(value: unknown): Toast | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = normalizeToastText(record.id, createToastId());
  const title = normalizeToastText(record.title, 'Notification');
  const body = normalizeToastText(record.body, '');
  if (!body) {
    return null;
  }

  return {
    id,
    type: normalizeToastType(record.type),
    title,
    body,
    avatar: typeof record.avatar === 'string' && record.avatar.trim() ? record.avatar.trim() : undefined,
    timestamp: typeof record.timestamp === 'number' && Number.isFinite(record.timestamp) ? record.timestamp : Date.now(),
    durable: record.durable === true,
  };
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Returns the toast id so callers can later updateToast()/dismissToast() it
  // (e.g. flip a durable "loading" toast to "success"/"error" in place).
  const addToast = useCallback((toast: Omit<Toast, 'id' | 'timestamp'> & { id?: string }): string => {
    const id = toast.id ?? createToastId();
    const normalized = normalizeToastInput({ ...toast, id, timestamp: Date.now() });
    if (!normalized) {
      return id;
    }
    setToasts(prev => (prev.some(t => t.id === id)
      ? prev.map(t => (t.id === id ? normalized : t))
      : [...prev, normalized]));
    return id;
  }, []);

  const updateToast = useCallback((id: string, patch: Partial<Omit<Toast, 'id' | 'timestamp'>>) => {
    setToasts(prev => prev.map(t => (t.id === id
      ? { ...t, ...patch, type: patch.type ? normalizeToastType(patch.type) : t.type }
      : t)));
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return { toasts, addToast, updateToast, dismissToast };
}
