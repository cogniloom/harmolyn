
import React, { useState, useEffect } from 'react';
import { X, MessageSquare, AtSign, Bell, Volume2, Loader2, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { normalizeToastInput, type Toast } from '@/components/useToasts';
import { resolveAvatarSrc } from '@/lib/avatar';

interface NotificationToastProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

const TOAST_DURATION = 5000;

// Cap how many toasts are visible at once so a burst of notifications can never
// overflow the screen. The newest toasts win (older ones are dropped from the
// top of the stack); they remain in the bus state and simply aren't rendered.
const MAX_VISIBLE_TOASTS = 5;

const iconMap: Record<Toast['type'], React.ReactNode> = {
  mention: <AtSign size={14} className="text-primary" />,
  message: <MessageSquare size={14} className="text-primary" />,
  system: <Bell size={14} className="text-accent-warning" />,
  voice: <Volume2 size={14} className="text-accent-success" />,
  info: <Info size={14} className="text-primary" />,
  success: <CheckCircle2 size={14} className="text-accent-success" />,
  error: <AlertTriangle size={14} className="text-accent-danger" />,
  loading: <Loader2 size={14} className="text-primary animate-spin" />,
};

const accentMap: Record<Toast['type'], string> = {
  mention: 'bg-primary',
  message: 'bg-white/20',
  system: 'bg-accent-warning',
  voice: 'bg-accent-success',
  info: 'bg-primary',
  success: 'bg-accent-success',
  error: 'bg-accent-danger',
  loading: 'bg-primary',
};

export const NotificationToast: React.FC<NotificationToastProps> = ({ toasts, onDismiss }) => {
  const normalizedToasts = normalizeToastList(toasts);

  // Enforce the visible-stack cap, keeping the most recent toasts.
  const visibleToasts =
    normalizedToasts.length > MAX_VISIBLE_TOASTS
      ? normalizedToasts.slice(-MAX_VISIBLE_TOASTS)
      : normalizedToasts;

  return (
    <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2.5 max-w-[340px] pointer-events-none">
      {visibleToasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
};

function normalizeToastList(value: unknown): Toast[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: Toast[] = [];
  const seen = new Set<string>();
  for (const toast of value) {
    const normalizedToast = normalizeToastInput(toast);
    if (!normalizedToast || seen.has(normalizedToast.id)) {
      continue;
    }
    seen.add(normalizedToast.id);
    normalized.push(normalizedToast);
  }

  return normalized;
}

const ToastItem: React.FC<{ toast: Toast; onDismiss: (id: string) => void }> = ({ toast, onDismiss }) => {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    // Durable / in-flight "loading" toasts stay until explicitly updated or
    // dismissed. When a loading toast is later flipped to success/error (durable
    // becomes false), this effect re-runs and starts the auto-dismiss timer.
    if (toast.durable || toast.type === 'loading') {
      return;
    }
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(() => onDismiss(toast.id), 300);
    }, TOAST_DURATION);
    return () => clearTimeout(timer);
  }, [toast.id, toast.durable, toast.type, onDismiss]);

  // Error toasts assertively interrupt the screen reader; everything else is
  // announced politely so it doesn't trample whatever the user is doing.
  const isError = toast.type === 'error';

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`
        pointer-events-auto glass-card rounded-r2 border border-white/10 p-3.5 flex items-start gap-3
        shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl
        transition-all duration-300
        ${exiting ? 'opacity-0 translate-x-8' : 'opacity-100 translate-x-0 animate-in slide-in-from-right fade-in duration-300'}
      `}
    >
      {toast.avatar ? (
        <img src={resolveAvatarSrc(toast.avatar, toast.title)} className="w-8 h-8 rounded-full border border-white/10 flex-shrink-0" alt="" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
          {iconMap[toast.type]}
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold text-white truncate">{toast.title}</span>
          <button
            onClick={() => onDismiss(toast.id)}
            className="focus-ring rounded-r1 p-0.5 text-white/20 hover:text-white/60 transition-colors flex-shrink-0"
            aria-label="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
        <p className="text-[11px] text-white/50 line-clamp-2 mt-0.5">{toast.body}</p>
      </div>

      {/* Accent strip */}
      <div className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full ${accentMap[toast.type] ?? 'bg-white/20'}`} />
    </div>
  );
};
