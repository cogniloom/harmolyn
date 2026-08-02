// Guardian-side consent prompt for social recovery.
//
// When a friend asks us (a guardian) to release the encrypted backup we hold for
// them, the recovery layer emits a window event. We surface an explicit approve/
// deny dialog — releasing the (encrypted) backup is gated behind this human
// consent, exactly as the user specified ("the friend has to manually consent").
import React, { useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { useNativeEngine } from '@/native/engine/provider';
import { RECOVERY_REQUEST_EVENT, type PendingRecoveryRequest } from '@/native/recovery/recovery';
import { useToast } from '@/lib/toastBus';

export function RecoveryConsentPrompt() {
  const { engine } = useNativeEngine();
  const toast = useToast();
  const [queue, setQueue] = useState<PendingRecoveryRequest[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const req = (e as CustomEvent<PendingRecoveryRequest>).detail;
      if (req?.id) setQueue((q) => (q.some(r => r.id === req.id) ? q : [...q, req]));
    };
    window.addEventListener(RECOVERY_REQUEST_EVENT, handler);
    return () => window.removeEventListener(RECOVERY_REQUEST_EVENT, handler);
  }, []);

  const current = queue[0];
  if (!current) return null;

  const dismiss = () => setQueue((q) => q.slice(1));

  const approve = async () => {
    if (!engine) return;
    setBusy(true);
    try {
      const ok = await engine.approveRecovery(current.id);
      toast?.[ok ? 'success' : 'error'](ok ? 'Backup released or securely queued for your friend.' : 'Could not secure a delivery copy yet; try again when a peer is reachable.');
    } finally {
      setBusy(false);
      dismiss();
    }
  };

  const deny = () => {
    engine?.denyRecovery(current.id);
    dismiss();
  };

  return (
    <div className="responsive-overlay-scroll fixed inset-0 z-[320] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-label="Account recovery request" className="flex max-h-full min-h-0 w-full max-w-[420px] flex-col overflow-hidden rounded-r3 border border-primary/20 shadow-2xl glass-card">
        <div className="flex shrink-0 items-center gap-3 border-b border-white/5 p-4 sm:p-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><ShieldCheck size={20} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-white font-bold">Account recovery request</div>
            <div className="text-[11px] text-white/45">A friend is trying to recover their account using the backup you hold.</div>
          </div>
          <button type="button" onClick={deny} aria-label="Dismiss" className="touch-target flex shrink-0 items-center justify-center rounded-full text-white/30 transition-colors hover:bg-white/5 hover:text-white/70 focus-ring"><X size={16} /></button>
        </div>

        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-5">
          <div className="space-y-2 text-[11px]">
            <div className="rounded-r2 bg-bg-0/60 border border-white/10 px-3 py-2">
              <div className="micro-label text-white/30">Account being recovered</div>
              <code className="text-white/70 font-mono break-all">{current.ownerPeerId}</code>
            </div>
            <div className="rounded-r2 bg-bg-0/60 border border-white/10 px-3 py-2">
              <div className="micro-label text-white/30">Requesting device</div>
              <code className="text-white/70 font-mono break-all">{current.requesterPeerId}</code>
            </div>
          </div>

          <p className="text-[11px] text-white/55 leading-relaxed">
            Only approve if you’re confident this is really your friend (check with them out-of-band). The backup stays encrypted — your friend still needs their password to use it.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2 border-t border-white/5 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:py-4">
          <button type="button" onClick={() => void approve()} disabled={busy} className="touch-target w-full rounded-full bg-primary px-4 text-sm font-bold text-bg-0 transition-all hover:shadow-glow disabled:opacity-50 sm:w-auto sm:flex-1">
            {busy ? 'Sending…' : 'Approve & send backup'}
          </button>
          <button type="button" onClick={deny} className="touch-target w-full rounded-full border border-white/10 px-5 text-sm text-white/60 transition-all hover:bg-white/5 sm:w-auto">Deny</button>
        </div>
      </div>
    </div>
  );
}
