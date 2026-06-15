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
    <div className="fixed inset-0 z-[200] flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Delete message"
        className="relative w-full max-w-[400px] mx-4 glass-card bg-bg-0 border border-white/10 rounded-r2 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-accent-danger/15 flex items-center justify-center">
              <AlertTriangle size={20} className="text-accent-danger" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white font-display">Delete message</h2>
              <span className="text-[9px] text-white/30 font-mono">This can't be undone</span>
            </div>
          </div>

          <div className="p-3 rounded-r1 bg-white/5 border border-white/5 mb-4">
            <p className="text-xs text-white/60 line-clamp-3">{messageContent}</p>
          </div>

          <p className="text-xs text-white/40 mb-5">
            Are you sure you want to delete this message? This action is permanent.
          </p>

          <div className="flex justify-end gap-2">
            <button
              ref={cancelRef}
              onClick={onCancel}
              className="focus-ring px-4 py-2 text-xs text-white/50 hover:text-white transition-colors rounded-full border border-white/10 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="focus-ring px-5 py-2 bg-accent-danger text-white rounded-full text-xs font-bold shadow-[0_0_6px_rgba(255,42,109,0.35)] hover:brightness-110 transition-all"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
