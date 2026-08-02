import React, { useEffect, useRef, useState } from 'react';
import { BarChart3, Plus, X } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

const QUESTION_MAX = 300;
const OPTION_MAX = 100;

interface PollCreatorProps {
  onSubmit: (question: string, options: string[]) => void;
  onClose: () => void;
}

export const PollCreator: React.FC<PollCreatorProps> = ({ onSubmit, onClose }) => {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const questionRef = useRef<HTMLInputElement>(null);

  useEscapeKey(onClose);

  useEffect(() => {
    questionRef.current?.focus();
  }, []);

  const addOption = () => {
    if (options.length < 6) setOptions([...options, '']);
  };

  const removeOption = (i: number) => {
    if (options.length > 2) setOptions(options.filter((_, idx) => idx !== i));
  };

  const updateOption = (i: number, val: string) => {
    const copy = [...options];
    copy[i] = val;
    setOptions(copy);
  };

  const canSubmit = normalizeQuestion(question).length > 0 && normalizeOptions(options).length >= 2;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create poll"
      className="absolute bottom-20 left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] z-50 flex max-h-[calc(100%-5.5rem)] min-h-0 flex-col overflow-hidden rounded-r2 border border-white/10 bg-bg-0 shadow-2xl glass-card animate-in slide-in-from-bottom-2 duration-200 md:left-6 md:right-auto md:w-[380px]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/5 px-4 py-2">
        <div className="flex items-center gap-2">
          <BarChart3 size={16} className="text-primary" />
          <span className="text-xs font-bold text-white font-display">CREATE // POLL</span>
        </div>
        <button onClick={onClose} aria-label="Close poll creator" className="touch-target flex shrink-0 items-center justify-center rounded-full text-white/30 transition-colors hover:bg-white/5 hover:text-white focus-ring">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain p-4">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="poll-question" className="micro-label text-white/40">QUESTION</label>
            <span className="text-[10px] text-white/20 font-mono tabular-nums">{question.length}/{QUESTION_MAX}</span>
          </div>
          <input
            id="poll-question"
            ref={questionRef}
            type="text"
            value={question}
            maxLength={QUESTION_MAX}
            onChange={e => setQuestion(e.target.value)}
            placeholder="Ask something..."
            className="min-h-11 w-full rounded-r1 border border-white/5 bg-surface-dark px-3 py-2 text-xs text-white placeholder-white/20 focus:border-primary/50 focus:outline-none font-mono focus-ring"
          />
        </div>

        <div className="space-y-1.5">
          <label className="micro-label text-white/40 mb-1 block">OPTIONS</label>
          {options.map((opt, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-[10px] text-white/20 font-mono w-4 text-right">{i + 1}.</span>
              <input
                type="text"
                value={opt}
                maxLength={OPTION_MAX}
                onChange={e => updateOption(i, e.target.value)}
                placeholder={`Option ${i + 1}`}
                aria-label={`Option ${i + 1}`}
                className="min-h-11 min-w-0 flex-1 rounded-r1 border border-white/5 bg-surface-dark px-3 py-2 text-xs text-white placeholder-white/15 focus:border-primary/50 focus:outline-none font-mono focus-ring"
              />
              {options.length > 2 && (
                <button onClick={() => removeOption(i)} aria-label={`Remove option ${i + 1}`} className="touch-target flex shrink-0 items-center justify-center rounded-full text-white/20 transition-colors hover:bg-accent-danger/10 hover:text-accent-danger focus-ring">
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
          {options.length < 6 && (
            <button
              onClick={addOption}
              className="touch-target mt-1 flex items-center gap-1 rounded-r1 text-[10px] text-primary/60 transition-colors hover:text-primary font-mono focus-ring"
            >
              <Plus size={12} /> ADD OPTION
            </button>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-white/5 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button onClick={onClose} className="touch-target grow rounded-full px-4 text-xs text-white/40 transition-colors hover:bg-white/5 hover:text-white focus-ring sm:grow-0">
          Cancel
        </button>
          <button
            onClick={() => {
              const normalizedQuestion = normalizeQuestion(question);
              const normalizedOptions = normalizeOptions(options);
              if (normalizedQuestion && normalizedOptions.length >= 2) {
                onSubmit(normalizedQuestion, normalizedOptions);
              }
            }}
            disabled={!canSubmit}
            className="touch-target grow rounded-full bg-primary px-4 text-xs font-bold text-bg-0 shadow-glow-sm transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30 focus-ring sm:grow-0"
          >
          Create Poll
        </button>
      </div>
    </div>
  );
};

function normalizeQuestion(value: string): string {
  return value.trim();
}

function normalizeOptions(values: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}
