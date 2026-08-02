import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface ConfirmDeleteModalProps {
  messageContent: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDeleteModal: React.FC<ConfirmDeleteModalProps> = ({ messageContent, onConfirm, onCancel }) => {
  useEscapeKey(onCancel);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div className="responsive-overlay-scroll fixed inset-0 z-[200] flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Delete message"
        className="relative flex max-h-full min-h-0 w-full max-w-[400px] flex-col overflow-hidden rounded-r2 border border-white/10 bg-bg-0 shadow-2xl glass-card animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-danger/15">
              <AlertTriangle size={20} className="text-accent-danger" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-white font-display">Delete message</h2>
              <span className="text-[9px] text-white/30 font-mono">This can't be undone</span>
            </div>
          </div>

          <div className="p-3 rounded-r1 bg-white/5 border border-white/5 mb-4">
            <p className="break-words text-xs text-white/60 line-clamp-3">{messageContent}</p>
          </div>

          <p className="text-xs text-white/40">
            Are you sure you want to delete this message? This action is permanent.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-white/5 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-4">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="touch-target grow rounded-full border border-white/10 px-4 text-xs text-white/50 transition-colors hover:bg-white/5 hover:text-white focus-ring sm:grow-0"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="touch-target grow rounded-full bg-accent-danger px-5 text-xs font-bold text-white shadow-[0_0_6px_rgba(255,42,109,0.35)] transition-all hover:brightness-110 focus-ring sm:grow-0"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};
