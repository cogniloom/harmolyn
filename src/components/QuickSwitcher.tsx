import React, { useState, useEffect, useRef, useMemo } from 'react';
import { SERVERS, DIRECT_MESSAGES, USERS } from '@/data';
import { Search, Hash, AtSign, Volume2, X, ArrowRight, Clock } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface QuickSwitcherProps {
  onClose: () => void;
  onNavigate: (serverId: string, channelId: string) => void;
}

const RECENT_SWITCHES_STORAGE_KEY = 'harmolyn-recent-switches';
const MAX_RECENT_SWITCHES = 12;

function readRecentSwitches(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_SWITCHES_STORAGE_KEY) || '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string').slice(0, MAX_RECENT_SWITCHES);
  } catch {
    return [];
  }
}

function saveRecentSwitch(channelId: string): void {
  try {
    const next = [channelId, ...readRecentSwitches().filter(id => id !== channelId)].slice(0, MAX_RECENT_SWITCHES);
    window.localStorage.setItem(RECENT_SWITCHES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be blocked in private mode or on quota/security failures.
  }
}

/**
 * Inline order-preserving subsequence ("fuzzy") matcher. Returns a positive
 * relevance score when every character of `query` appears in `target` in order,
 * or null when there is no match. Higher scores reward earlier matches, runs of
 * consecutive characters, and matches on word boundaries — so "gen" ranks
 * "general" above "image-gallery". No external dependency.
 */
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;

  let score = 0;
  let ti = 0;
  let consecutive = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;

    // Reward matches near the start of the target and penalise large gaps.
    score += Math.max(0, 12 - found);
    if (found === ti && qi > 0) {
      consecutive += 1;
      score += consecutive * 4; // contiguous runs are strong signals
    } else {
      consecutive = 0;
    }
    // Word-boundary bonus (start of string or after a separator).
    if (found === 0 || /[\s\-_/›]/.test(t[found - 1] ?? '')) {
      score += 6;
    }
    ti = found + 1;
  }
  // Prefer shorter targets when scores are otherwise close.
  score += Math.max(0, 8 - (t.length - q.length) / 4);
  return score;
}

interface SwitcherResult {
  id: string;
  label: string;
  sublabel: string;
  type: 'text' | 'voice' | 'dm';
  serverId: string;
  channelId: string;
}

const UNKNOWN_QUICK_SWITCHER_USER = {
  id: 'unknown',
  username: 'Unknown User',
};

function isQuickSwitcherRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeQuickSwitcherText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeQuickSwitcherUser(value: unknown, fallbackId: string): { id: string; username: string } {
  if (!isQuickSwitcherRecord(value)) {
    return { id: fallbackId, username: fallbackId };
  }

  const id = normalizeQuickSwitcherText(value.id, fallbackId);
  return {
    id,
    username: normalizeQuickSwitcherText(value.username, id),
  };
}

function normalizeQuickSwitcherUsers(value: unknown): { id: string; username: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: { id: string; username: string }[] = [];
  const seenIds = new Set<string>();
  for (const [index, user] of value.entries()) {
    const normalizedUser = normalizeQuickSwitcherUser(user, `member-${index}`);
    if (seenIds.has(normalizedUser.id)) {
      continue;
    }
    seenIds.add(normalizedUser.id);
    normalized.push(normalizedUser);
  }
  return normalized;
}

function normalizeQuickSwitcherResults(items: SwitcherResult[]): SwitcherResult[] {
  const normalized: SwitcherResult[] = [];
  const seenIds = new Set<string>();
  for (const item of items) {
    if (seenIds.has(item.id)) {
      continue;
    }
    seenIds.add(item.id);
    normalized.push(item);
  }
  return normalized;
}

export const QuickSwitcher: React.FC<QuickSwitcherProps> = ({ onClose, onNavigate }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Snapshot recency once per open so re-renders while typing stay stable.
  const recentOrder = useMemo(() => {
    const order = new Map<string, number>();
    readRecentSwitches().forEach((id, index) => order.set(id, index));
    return order;
  }, []);

  useEscapeKey(onClose);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const allItems = useMemo(() => {
    const items: SwitcherResult[] = [];
    const normalizedUsers = normalizeQuickSwitcherUsers(USERS);

    // Add DMs
    DIRECT_MESSAGES.forEach(dm => {
      const user = normalizedUsers.find((entry) => entry.id === dm.userId);
      items.push({
        id: dm.id,
        label: user?.username ?? UNKNOWN_QUICK_SWITCHER_USER.username,
        sublabel: 'Direct Message',
        type: 'dm',
        serverId: 'home',
        channelId: dm.id,
      });
    });

    // Add server channels
    SERVERS.forEach(server => {
      server.categories.forEach(cat => {
        cat.channels.forEach(ch => {
          items.push({
            id: ch.id,
            label: ch.name,
            sublabel: `${server.name} › ${cat.name}`,
            type: ch.type === 'voice' ? 'voice' : 'text',
            serverId: server.id,
            channelId: ch.id,
          });
        });
      });
    });

    return normalizeQuickSwitcherResults(items);
  }, []);

  const results = useMemo(() => {
    const recencyBonus = (id: string) => {
      const rank = recentOrder.get(id);
      return rank === undefined ? 0 : (MAX_RECENT_SWITCHES - rank) * 3;
    };

    // No query: most-recently-used first, then the original feed order.
    if (!query.trim()) {
      return [...allItems]
        .sort((a, b) => recencyBonus(b.channelId) - recencyBonus(a.channelId))
        .slice(0, 8);
    }

    const q = query.trim();
    return allItems
      .map(item => {
        const labelScore = fuzzyScore(q, item.label);
        const sublabelScore = fuzzyScore(q, item.sublabel);
        const best = Math.max(labelScore ?? -Infinity, (sublabelScore ?? -Infinity) - 4);
        return { item, score: best === -Infinity ? null : best + recencyBonus(item.channelId) };
      })
      .filter((entry): entry is { item: SwitcherResult; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(entry => entry.item);
  }, [query, allItems, recentOrder]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const selectResult = (r: SwitcherResult) => {
    saveRecentSwitch(r.channelId);
    onNavigate(r.serverId, r.channelId);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      selectResult(results[selectedIndex]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const showingRecent = !query.trim();

  const TypeIcon = ({ type }: { type: string }) => {
    if (type === 'dm') return <AtSign size={14} className="text-primary/60" />;
    if (type === 'voice') return <Volume2 size={14} className="text-accent-success/60" />;
    return <Hash size={14} className="text-white/40" />;
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
        className="relative w-full max-w-[540px] mx-4 glass-card bg-bg-0 border border-white/10 rounded-r2 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/5">
          <Search size={18} className="text-primary flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="JUMP TO // CHANNEL OR DM"
            aria-label="Search channels and direct messages"
            className="flex-1 bg-transparent text-white text-sm font-mono placeholder-white/30 focus:outline-none"
          />
          <button onClick={onClose} aria-label="Close quick switcher" className="p-1 text-white/30 hover:text-white transition-colors focus-ring rounded-r1">
            <X size={16} />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-[320px] overflow-y-auto no-scrollbar p-2" role="listbox" aria-label="Results">
          {showingRecent && results.length > 0 && recentOrder.size > 0 && (
            <div className="flex items-center gap-1.5 px-4 pt-1 pb-2 text-white/25">
              <Clock size={10} />
              <span className="micro-label text-[9px]">Recent</span>
            </div>
          )}
          {results.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-white/20 text-xs font-mono">NO RESULTS // TRY DIFFERENT QUERY</p>
            </div>
          ) : (
            results.map((r, i) => {
              const isSelected = i === selectedIndex;
              return (
                <button
                  key={r.id}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectResult(r)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={`focus-ring w-full flex items-center gap-3 px-4 py-2.5 rounded-r1 text-left transition-all ${
                    isSelected
                      ? 'bg-primary/15 border border-primary/50 shadow-glow-sm'
                      : 'border border-transparent hover:bg-white/5'
                  }`}
                >
                  <TypeIcon type={r.type} />
                  <div className="flex-1 min-w-0">
                    <span className={`text-xs font-bold block truncate ${isSelected ? 'text-white' : 'text-white/80'}`}>{r.label}</span>
                    <span className="text-white/30 text-[10px] font-mono truncate block">{r.sublabel}</span>
                  </div>
                  {isSelected && <ArrowRight size={12} className="text-primary flex-shrink-0" />}
                </button>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-2 border-t border-white/5 flex items-center gap-4">
          <span className="text-[9px] text-white/20 font-mono">↑↓ NAVIGATE</span>
          <span className="text-[9px] text-white/20 font-mono">ENTER SELECT</span>
          <span className="text-[9px] text-white/20 font-mono">ESC CLOSE</span>
        </div>
      </div>
    </div>
  );
};
