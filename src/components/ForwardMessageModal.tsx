import React, { useMemo, useRef, useState } from 'react';
import { Send, X, Hash, AtSign, Search, ChevronRight } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface ForwardMessageModalProps {
  messageContent: string;
  destinations: Destination[];
  onForward: (destinations: Destination[], note: string) => void;
  onClose: () => void;
}

interface Destination {
  id: string;
  label: string;
  sublabel: string;
  type: 'channel' | 'dm';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeDestinationText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeDestination(value: unknown, fallbackId: string): Destination | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const id = normalizeDestinationText(value.id, fallbackId);
  const label = normalizeDestinationText(value.label, id);
  const sublabel = normalizeDestinationText(value.sublabel, '');
  const type = value.type === 'channel' || value.type === 'dm' ? value.type : null;
  if (!id || !type) {
    return null;
  }
  return { id, label, sublabel, type };
}

function normalizeDestinations(value: unknown): Destination[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: Destination[] = [];
  const seen = new Set<string>();

  value.forEach((dest, index) => {
    const normalizedDestination = normalizeDestination(dest, `destination-${index}`);
    if (!normalizedDestination || seen.has(normalizedDestination.id)) {
      return;
    }
    seen.add(normalizedDestination.id);
    normalized.push(normalizedDestination);
  });

  return normalized;
}

export const ForwardMessageModal: React.FC<ForwardMessageModalProps> = ({ messageContent, destinations, onForward, onClose }) => {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Destination[]>([]);
  const [note, setNote] = useState('');
  const normalizedDestinations = useMemo(() => normalizeDestinations(destinations), [destinations]);
  const listRef = useRef<HTMLDivElement>(null);

  useEscapeKey(onClose);

  // Arrow-key navigation across the destination buttons. Keeps native Tab order
  // intact and only intercepts Up/Down when focus is already inside the list.
  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items: HTMLButtonElement[] = listRef.current
      ? Array.from(listRef.current.querySelectorAll<HTMLButtonElement>('[data-destination-item]'))
      : [];
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex === -1) return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = (currentIndex + delta + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const filtered = query.trim()
    ? normalizedDestinations.filter(d => d.label.toLowerCase().includes(query.toLowerCase()))
    : normalizedDestinations;

  const toggleSelect = (dest: Destination) => {
    if (selected.find(s => s.id === dest.id)) {
      setSelected(selected.filter(s => s.id !== dest.id));
    } else if (selected.length < 5) {
      setSelected([...selected, dest]);
    }
  };

  const handleForward = () => {
    onForward(selected, note);
    onClose();
  };

  return (
    <div className="responsive-overlay-scroll fixed inset-0 z-[200] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="forward-message-title"
        className="relative flex max-h-full w-full max-w-[440px] flex-col overflow-hidden rounded-r2 border border-white/10 bg-bg-0 shadow-2xl glass-card animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-white/5 px-4 py-3 sm:px-5 sm:py-4">
          <div>
            <h2 id="forward-message-title" className="text-sm font-bold text-white font-display">FORWARD // MESSAGE</h2>
            <span className="text-[9px] text-white/30 font-mono">SELECT UP TO 5 DESTINATIONS</span>
          </div>
          <button onClick={onClose} aria-label="Close" className="touch-target flex flex-shrink-0 items-center justify-center rounded-full text-white/30 transition-colors hover:bg-white/5 hover:text-white focus-ring">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/* Forwarded message */}
          <div className="mx-4 mt-3 rounded-r1 border border-white/5 bg-white/5 p-3">
            <div className="micro-label text-white/30 mb-1">MESSAGE</div>
            <p className="text-xs text-white/70 line-clamp-2">{messageContent}</p>
          </div>

          {/* Search */}
          <div className="relative mx-4 mt-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search channels & DMs..."
              aria-label="Search channels and DMs"
              className="compact-touch-target w-full rounded-full border border-white/5 bg-surface-dark py-2 pl-9 pr-4 text-xs text-white font-mono placeholder-white/30 focus:border-primary/50 focus:outline-none"
            />
          </div>

          {/* Selected chips */}
          {selected.length > 0 && (
            <div className="mx-4 mt-2 flex flex-wrap gap-1.5">
              {selected.map(s => (
                <button
                  type="button"
                  key={s.id}
                  aria-label={`Remove ${s.label}`}
                  className="compact-touch-target inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/15 px-2 py-0.5 text-[10px] font-bold text-primary transition-colors hover:bg-primary/25"
                  onClick={() => toggleSelect(s)}
                >
                  {s.label}
                  <X size={10} />
                </button>
              ))}
            </div>
          )}

          {/* Destination list */}
          <div
            ref={listRef}
            aria-label="Forward destinations"
            onKeyDown={handleListKeyDown}
            className="mx-2 mt-2 space-y-0.5 p-2"
          >
            {filtered.map(d => {
              const isSelected = !!selected.find(s => s.id === d.id);
              return (
                <button
                  key={d.id}
                  data-destination-item
                  aria-pressed={isSelected}
                  onClick={() => toggleSelect(d)}
                  className={`compact-touch-target flex w-full items-center gap-3 rounded-r1 px-3 py-2 text-left transition-all focus-ring ${
                    isSelected ? 'bg-primary/10 border border-primary/20' : 'border border-transparent hover:bg-white/5'
                  }`}
                >
                  {d.type === 'dm' ? <AtSign size={14} className="text-primary/50" /> : <Hash size={14} className="text-white/30" />}
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-white">{d.label}</span>
                    <span className="text-[9px] text-white/25 font-mono">{d.sublabel}</span>
                  </div>
                  <div className={`h-4 w-4 flex-shrink-0 rounded-full border-2 transition-all ${isSelected ? 'bg-primary border-primary' : 'border-white/20'}`}>
                    {isSelected && <div className="flex h-full w-full items-center justify-center text-bg-0"><ChevronRight size={10} /></div>}
                  </div>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-3 py-8 text-center text-[11px] text-white/35 font-mono">
                No live destinations matched this query.
              </div>
            )}
          </div>

          {/* Note */}
          <div className="mx-4 mb-3 mt-2">
            <input
              type="text"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Add a note (optional)..."
              className="compact-touch-target w-full rounded-r1 border border-white/5 bg-surface-dark px-3 py-2 text-xs text-white font-mono placeholder-white/20 focus:border-primary/50 focus:outline-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2 border-t border-white/5 px-4 py-3 sm:px-5 sm:py-4">
          <button onClick={onClose} className="compact-touch-target rounded-full px-4 py-2 text-xs text-white/50 transition-colors hover:text-white focus-ring">
            Cancel
          </button>
          <button
            onClick={handleForward}
            disabled={selected.length === 0}
            className="compact-touch-target flex items-center gap-1.5 rounded-full bg-primary px-5 py-2 text-xs font-bold text-bg-0 shadow-glow-sm transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Send size={12} /> Forward ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
};
