import React, { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';

interface PollOption {
  text: string;
  votes: number;
}

interface PollMessageProps {
  question: string;
  options: PollOption[];
  totalVotes: number;
  votedIndex: number | null;
  onVote?: (index: number) => void;
}

export const PollMessage: React.FC<PollMessageProps> = ({ question, options: initialOptions, totalVotes: initialTotal, votedIndex: initialVoted, onVote }) => {
  const normalizedOptions = useMemo(() => normalizePollOptions(initialOptions), [initialOptions]);
  const [options, setOptions] = useState(normalizedOptions);
  const [totalVotes, setTotalVotes] = useState(normalizePollCount(initialTotal, normalizedOptions));
  const [votedIndex, setVotedIndex] = useState(initialVoted);
  const safeQuestion = normalizePollQuestion(question);

  if (options.length === 0) {
    return (
      <div className="mt-2 glass-card bg-white/[0.02] border border-white/8 rounded-r2 p-4 max-w-[400px]">
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 size={14} className="text-primary" />
          <span className="micro-label text-primary tracking-widest">POLL</span>
        </div>
        <h4 className="text-sm font-bold text-white mb-3 font-display">{safeQuestion}</h4>
        <div className="rounded-r1 border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-white/40">
          Poll data is unavailable.
        </div>
      </div>
    );
  }

  const vote = (i: number) => {
    if (votedIndex !== null) return; // already voted
    const updated = options.map((o, idx) => idx === i ? { ...o, votes: o.votes + 1 } : o);
    setOptions(updated);
    setTotalVotes(totalVotes + 1);
    setVotedIndex(i);
    onVote?.(i);
  };

  return (
    <div className="mt-2 glass-card bg-white/[0.02] border border-white/8 rounded-r2 p-4 max-w-[400px]">
      <div className="flex items-center gap-2 mb-3">
        <BarChart3 size={14} className="text-primary" />
        <span className="micro-label text-primary tracking-widest">POLL</span>
      </div>
      <h4 className="text-sm font-bold text-white mb-3 font-display">{safeQuestion}</h4>

      <div className="space-y-1.5">
        {options.map((opt, i) => {
          const pct = totalVotes > 0 ? Math.round((opt.votes / totalVotes) * 100) : 0;
          const isWinner = votedIndex !== null && opt.votes === Math.max(...options.map(o => o.votes));

          return (
            <button
              key={i}
              onClick={() => vote(i)}
              disabled={votedIndex !== null}
              className={`w-full text-left relative overflow-hidden rounded-r1 border transition-all ${
                votedIndex === i
                  ? 'border-primary/30 bg-primary/5'
                  : votedIndex !== null
                  ? 'border-white/5 bg-white/[0.02]'
                  : 'border-white/5 bg-white/[0.02] hover:border-primary/20 hover:bg-white/5 cursor-pointer'
              }`}
            >
              {/* Progress fill */}
              {votedIndex !== null && (
                <div
                  className={`absolute inset-y-0 left-0 transition-all duration-500 ${isWinner ? 'bg-primary/15' : 'bg-white/5'}`}
                  style={{ width: `${pct}%` }}
                />
              )}
              <div className="relative flex items-center justify-between px-3 py-2">
                <span className={`text-xs ${votedIndex === i ? 'text-primary font-bold' : 'text-white/70'}`}>
                  {opt.text}
                </span>
                {votedIndex !== null && (
                  <span className={`text-[10px] font-mono font-bold ${isWinner ? 'text-primary' : 'text-white/30'}`}>
                    {pct}%
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-2 text-[9px] text-white/25 font-mono">
        {totalVotes} VOTE{totalVotes !== 1 ? 'S' : ''} {votedIndex !== null ? '// VOTED' : '// TAP TO VOTE'}
      </div>
    </div>
  );
};

function normalizePollQuestion(value: unknown): string {
  if (typeof value !== 'string') {
    return 'Untitled poll';
  }
  const trimmed = value.trim();
  return trimmed || 'Untitled poll';
}

function normalizePollCount(value: unknown, options: PollOption[]): number {
  const provided = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const optionTotal = options.reduce((sum, option) => sum + Math.max(0, Math.floor(option.votes)), 0);
  return Math.max(provided, optionTotal);
}

function normalizePollOptions(value: unknown): PollOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const options: PollOption[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const text = typeof (entry as { text?: unknown }).text === 'string' ? (entry as { text: string }).text.trim() : '';
    if (!text || seen.has(text)) {
      continue;
    }

    const votes = typeof (entry as { votes?: unknown }).votes === 'number' && Number.isFinite((entry as { votes: number }).votes)
      ? Math.max(0, Math.floor((entry as { votes: number }).votes))
      : 0;

    seen.add(text);
    options.push({ text, votes });
  }

  return options;
}
