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
    <div className="fixed inset-0 z-[200] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="forward-message-title"
        className="relative w-full max-w-[440px] mx-4 glass-card bg-bg-0 border border-white/10 rounded-r2 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div>
            <h2 id="forward-message-title" className="text-sm font-bold text-white font-display">FORWARD // MESSAGE</h2>
            <span className="text-[9px] text-white/30 font-mono">SELECT UP TO 5 DESTINATIONS</span>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 text-white/30 hover:text-white hover:bg-white/5 rounded-full transition-colors focus-ring">
            <X size={16} />
          </button>
        </div>

        {/* Forwarded message */}
        <div className="mx-4 mt-3 p-3 rounded-r1 bg-white/5 border border-white/5">
          <div className="micro-label text-white/30 mb-1">MESSAGE</div>
          <p className="text-xs text-white/70 line-clamp-2">{messageContent}</p>
        </div>

        {/* Search */}
        <div className="mx-4 mt-3 relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search channels & DMs..."
            aria-label="Search channels and DMs"
            className="w-full bg-surface-dark border border-white/5 rounded-full pl-9 pr-4 py-2 text-xs text-white font-mono placeholder-white/30 focus:outline-none focus:border-primary/50"
          />
        </div>

        {/* Selected chips */}
        {selected.length > 0 && (
          <div className="mx-4 mt-2 flex flex-wrap gap-1.5">
            {selected.map(s => (
              <span
                key={s.id}
                className="inline-flex items-center gap-1 bg-primary/15 border border-primary/30 text-primary text-[10px] font-bold px-2 py-0.5 rounded-full cursor-pointer hover:bg-primary/25 transition-colors"
                onClick={() => toggleSelect(s)}
              >
                {s.label}
                <X size={10} />
              </span>
            ))}
          </div>
        )}

        {/* Destination list */}
        <div
          ref={listRef}
          aria-label="Forward destinations"
          onKeyDown={handleListKeyDown}
          className="mx-2 mt-2 max-h-[200px] overflow-y-auto no-scrollbar p-2 space-y-0.5"
        >
          {filtered.map(d => {
            const isSelected = !!selected.find(s => s.id === d.id);
            return (
              <button
                key={d.id}
                data-destination-item
                aria-pressed={isSelected}
                onClick={() => toggleSelect(d)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-r1 text-left transition-all focus-ring ${
                  isSelected ? 'bg-primary/10 border border-primary/20' : 'border border-transparent hover:bg-white/5'
                }`}
              >
                {d.type === 'dm' ? <AtSign size={14} className="text-primary/50" /> : <Hash size={14} className="text-white/30" />}
                <div className="flex-1 min-w-0">
                  <span className="text-white text-xs font-bold truncate block">{d.label}</span>
                  <span className="text-white/25 text-[9px] font-mono">{d.sublabel}</span>
                </div>
                <div className={`w-4 h-4 rounded-full border-2 transition-all ${isSelected ? 'bg-primary border-primary' : 'border-white/20'}`}>
                  {isSelected && <div className="w-full h-full flex items-center justify-center text-bg-0"><ChevronRight size={10} /></div>}
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
        <div className="mx-4 mt-2">
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Add a note (optional)..."
            className="w-full bg-surface-dark border border-white/5 rounded-r1 px-3 py-2 text-xs text-white font-mono placeholder-white/20 focus:outline-none focus:border-primary/50"
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/5 mt-3">
          <button onClick={onClose} className="px-4 py-2 text-xs text-white/50 hover:text-white transition-colors rounded-full focus-ring">
            Cancel
          </button>
          <button
            onClick={handleForward}
            disabled={selected.length === 0}
            className="px-5 py-2 bg-primary text-bg-0 rounded-full text-xs font-bold flex items-center gap-1.5 shadow-glow-sm hover:brightness-110 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Send size={12} /> Forward ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
};
