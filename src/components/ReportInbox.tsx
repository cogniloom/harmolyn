import React, { useMemo, useState } from 'react';
import { Flag, ShieldCheck, RotateCcw, Inbox } from 'lucide-react';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';
import { useResolveReport } from '@/hooks/runtime/mutations';
import { formatDateTime } from '@/lib/locale';
import type { XoreinReport } from '@/types';

/**
 * Owner-facing moderation inbox. Inbound abuse reports are delivered P2P to the server owner
 * and persisted in the runtime snapshot (`reports`), but until now nothing rendered them — the
 * owner's only signal was a one-time toast, so reports were effectively lost after dismissal.
 * This reads the owner's copies for the current server and lets them mark each resolved.
 *
 * Note: it reads the IN-MEMORY snapshot (via useRuntimeSnapshot), which is correct — the
 * plaintext localStorage mirror deliberately strips reports (round-9 at-rest hardening).
 */
export const ReportInbox: React.FC<{ serverId: string }> = ({ serverId }) => {
  const snapshot = useRuntimeSnapshot();
  const resolveReport = useResolveReport();
  const [showResolved, setShowResolved] = useState(false);

  const reports = useMemo<XoreinReport[]>(() => {
    const all = (snapshot?.reports ?? []).filter((r) => r.server_id === serverId && r.inbound);
    // Newest first; unresolved above resolved.
    return [...all].sort((a, b) => {
      if (!!a.resolved !== !!b.resolved) return a.resolved ? 1 : -1;
      return (b.created_at ?? '').localeCompare(a.created_at ?? '');
    });
  }, [snapshot, serverId]);

  const visible = showResolved ? reports : reports.filter((r) => !r.resolved);
  const openCount = reports.filter((r) => !r.resolved).length;

  return (
    <section>
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[22px] font-bold text-white mb-1 font-display tracking-tight flex items-center gap-2">
            <Flag size={18} className="text-accent-danger" /> Reports
          </h2>
          <p className="micro-label text-white/30">
            {openCount > 0 ? `${openCount} open report${openCount === 1 ? '' : 's'}` : 'No open reports'}
          </p>
        </div>
        {reports.some((r) => r.resolved) && (
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="micro-label text-white/40 hover:text-white transition-colors"
          >
            {showResolved ? 'Hide resolved' : 'Show resolved'}
          </button>
        )}
      </header>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-white/25">
          <Inbox size={32} className="mb-3" />
          <p className="micro-label">Nothing to review</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((r) => (
            <li
              key={r.id}
              className={`p-4 rounded-r2 border transition-colors ${
                r.resolved ? 'border-white/5 bg-white/[0.02] opacity-60' : 'border-white/10 bg-white/5'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-bold text-white truncate">{r.reason || 'Report'}</span>
                    <span className="micro-label text-white/30">
                      {r.target_kind === 'user' ? 'user' : 'message'}
                    </span>
                    {r.resolved && <span className="micro-label text-accent-success">resolved</span>}
                  </div>
                  {r.reported_peer_id && (
                    <div className="text-[11px] text-white/40 mb-1 truncate">
                      Reported peer: <span className="font-mono">{r.reported_peer_id}</span>
                    </div>
                  )}
                  {r.details && <p className="text-xs text-white/60 mb-1 whitespace-pre-wrap break-words">{r.details}</p>}
                  {r.content_excerpt && (
                    <blockquote className="text-xs text-white/45 border-l-2 border-white/10 pl-2 my-1 break-words">
                      {r.content_excerpt}
                    </blockquote>
                  )}
                  <div className="micro-label text-white/25 mt-1">
                    {r.created_at ? formatDateTime(new Date(r.created_at), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={resolveReport.isPending}
                  onClick={() => resolveReport.mutate({ reportId: r.id, resolved: !r.resolved })}
                  className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-r1 text-xs font-bold transition-all ${
                    r.resolved
                      ? 'text-white/50 hover:bg-white/5 hover:text-white'
                      : 'bg-accent-success/10 text-accent-success hover:bg-accent-success/20'
                  }`}
                >
                  {r.resolved ? <><RotateCcw size={13} /> Reopen</> : <><ShieldCheck size={13} /> Resolve</>}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
