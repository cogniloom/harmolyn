import React from 'react';
import { Flag, X } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

export type ReportReason =
  | 'harassment'
  | 'spam'
  | 'hate'
  | 'violence'
  | 'csam'
  | 'self_harm'
  | 'illegal'
  | 'other';

export interface ReportSubmission {
  reason: ReportReason;
  details: string;
}

interface ReportModalProps {
  /** What is being reported (for the header) — e.g. "message from Sam" or "Sam". */
  targetLabel: string;
  onSubmit: (report: ReportSubmission) => void;
  onClose: () => void;
}

const REASONS: { key: ReportReason; label: string; hint: string }[] = [
  { key: 'harassment', label: 'Harassment or bullying', hint: 'Targeting, threats, or repeated unwanted contact' },
  { key: 'spam', label: 'Spam or scam', hint: 'Unsolicited ads, phishing, or fraud' },
  { key: 'hate', label: 'Hate speech', hint: 'Attacks based on identity' },
  { key: 'violence', label: 'Violence or threats', hint: 'Incitement or credible threats of harm' },
  { key: 'csam', label: 'Child sexual abuse material', hint: 'Content that sexualizes minors' },
  { key: 'self_harm', label: 'Self-harm or suicide', hint: 'Someone may be in danger' },
  { key: 'illegal', label: 'Other illegal content', hint: 'Anything else prohibited by law' },
  { key: 'other', label: 'Something else', hint: 'Describe it below' },
];

/**
 * Report a user or message. In an end-to-end-encrypted P2P network the operator
 * cannot read content, so reports about a server are delivered to that server's
 * owner (who can act with kick/ban/delete); a copy is kept locally. Serious/illegal
 * matters are routed to the operator contact per the Community Guidelines.
 */
export const ReportModal: React.FC<ReportModalProps> = ({ targetLabel, onSubmit, onClose }) => {
  useEscapeKey(onClose);
  const [reason, setReason] = React.useState<ReportReason | null>(null);
  const [details, setDetails] = React.useState('');

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Report ${targetLabel}`}
        className="relative w-full max-w-[460px] max-h-[85vh] flex flex-col glass-card bg-bg-0 border border-white/10 rounded-r2 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 p-5 border-b border-white/8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-accent-danger/15 flex items-center justify-center text-accent-danger">
              <Flag size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white font-display">Report {targetLabel}</h2>
              <p className="text-[11px] text-white/40">Your report is private. Thank you for helping keep Harmolyn safe.</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="focus-ring rounded-full p-1.5 text-white/40 hover:text-white hover:bg-white/5">
            <X size={16} />
          </button>
        </header>

        <div className="overflow-y-auto p-5 space-y-2">
          <fieldset>
            <legend className="micro-label text-white/40 mb-2">Why are you reporting this?</legend>
            {REASONS.map((r) => (
              <label
                key={r.key}
                className={`flex items-start gap-3 p-3 rounded-r1 border cursor-pointer transition-all mb-1.5 ${
                  reason === r.key ? 'border-primary/40 bg-primary/5' : 'border-white/8 hover:bg-white/5'
                }`}
              >
                <input
                  type="radio"
                  name="report-reason"
                  checked={reason === r.key}
                  onChange={() => setReason(r.key)}
                  className="mt-0.5 h-4 w-4 accent-primary"
                />
                <span>
                  <span className="block text-[13px] text-white/80 font-semibold">{r.label}</span>
                  <span className="block text-[11px] text-white/40">{r.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="pt-2">
            <label className="micro-label text-white/40 mb-1.5 block" htmlFor="report-details">Details (optional)</label>
            <textarea
              id="report-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Add anything that would help someone reviewing this…"
              className="w-full px-4 py-3 rounded-r1 bg-white/5 border border-white/8 text-[13px] text-white/80 placeholder:text-white/25 focus:border-primary/40 focus:outline-none resize-none"
            />
          </div>
        </div>

        <footer className="flex justify-end gap-2 p-4 border-t border-white/8">
          <button onClick={onClose} className="focus-ring px-4 py-2 text-xs text-white/50 hover:text-white rounded-full border border-white/10 hover:bg-white/5">
            Cancel
          </button>
          <button
            onClick={() => reason && onSubmit({ reason, details: details.trim() })}
            disabled={!reason}
            className="focus-ring px-5 py-2 bg-accent-danger text-white rounded-full text-xs font-bold hover:brightness-110 transition-all disabled:opacity-40"
          >
            Submit report
          </button>
        </footer>
      </div>
    </div>
  );
};
