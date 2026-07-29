import React, { useEffect, useMemo, useState } from 'react';
import { Search, X, User, Calendar } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { type XoreinMessageSearchResult } from '@/lib/xoreinControl';
import { useRuntimeMutations } from '@/hooks/runtime/useRuntimeMutations';
import type { User as AppUser } from '@/types';
import { renderMarkdown } from '@/utils/markdown';
import { resolveAvatarSrc } from '@/lib/avatar';

interface SearchPanelProps {
  onClose: () => void;
  scopeType: 'channel' | 'dm';
  scopeId: string;
  serverId?: string;
  users: AppUser[];
}

type FilterType = 'from' | 'before' | 'after' | null;

interface SearchFilter {
  type: 'from' | 'before' | 'after';
  value: string;
  label: string;
}

const UNKNOWN_SEARCH_USER: AppUser = {
  id: 'unknown',
  username: 'Unknown User',
  avatar: '',
  status: 'offline',
};

function isSearchRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeSearchText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeSearchUser(value: unknown, fallbackId: string): AppUser {
  if (!isSearchRecord(value)) {
    return { id: fallbackId, username: fallbackId, avatar: '', status: 'offline' };
  }

  const id = normalizeSearchText(value.id, fallbackId);
  const status = value.status === 'online' || value.status === 'idle' || value.status === 'dnd' || value.status === 'offline'
    ? value.status
    : 'offline';

  return {
    id,
    username: normalizeSearchText(value.username, id),
    avatar: typeof value.avatar === 'string' ? value.avatar : '',
    status,
    ...(typeof value.role === 'string' && value.role.trim() ? { role: value.role.trim() } : {}),
    ...(typeof value.color === 'string' && value.color.trim() ? { color: value.color.trim() } : {}),
    ...(typeof value.bio === 'string' && value.bio.trim() ? { bio: value.bio.trim() } : {}),
  };
}

function normalizeSearchUsers(users: AppUser[]): AppUser[] {
  const normalized: AppUser[] = [];
  const seenIds = new Set<string>();
  for (const user of users.map((entry) => normalizeSearchUser(entry, 'member'))) {
    if (seenIds.has(user.id)) {
      continue;
    }
    seenIds.add(user.id);
    normalized.push(user);
  }
  return normalized;
}

export const SearchPanel: React.FC<SearchPanelProps> = ({ onClose, scopeType, scopeId, serverId, users }) => {
  const { searchMessages } = useRuntimeMutations();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilter[]>([]);
  const [showFilterMenu, setShowFilterMenu] = useState<FilterType>(null);
  const [beforeDraft, setBeforeDraft] = useState('');
  const [afterDraft, setAfterDraft] = useState('');
  const [results, setResults] = useState<XoreinMessageSearchResult>({ messages: [], results: [] });
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const normalizedUsers = useMemo(() => normalizeSearchUsers(users), [users]);

  // Close the active filter dropdown first; otherwise dismiss the whole panel.
  useEscapeKey(showFilterMenu ? () => setShowFilterMenu(null) : onClose);

  const addFilter = (type: SearchFilter['type'], value: string, label: string) => {
    setFilters((current) => {
      const next = current.filter((filter) => filter.type !== type);
      return [...next, { type, value, label }];
    });
    setShowFilterMenu(null);
  };

  const removeFilter = (index: number) => {
    setFilters(f => f.filter((_, i) => i !== index));
  };

  const fromFilter = useMemo(() => filters.find((filter) => filter.type === 'from')?.value ?? '', [filters]);
  const beforeFilter = useMemo(() => filters.find((filter) => filter.type === 'before')?.value ?? '', [filters]);
  const afterFilter = useMemo(() => filters.find((filter) => filter.type === 'after')?.value ?? '', [filters]);

  useEffect(() => {
    let active = true;
    const trimmed = query.trim();
    if (!trimmed) {
      // Functional update that keeps the previous state object when it is
      // already empty: unconditionally setting a fresh {messages,results}
      // object here re-renders, and if the `searchMessages` identity is not
      // stable across renders this effect re-runs → infinite render/effect
      // loop (it hard-hung the vitest worker under a per-render mock).
      setResults((prev) => (prev.messages.length === 0 && prev.results.length === 0 ? prev : { messages: [], results: [] }));
      setSearchError(null);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    setSearchError(null);
    searchMessages({
      query: trimmed,
      scope_type: scopeType,
      scope_id: scopeId,
      server_id: serverId,
      sender_peer_id: fromFilter || undefined,
      before: beforeFilter || undefined,
      after: afterFilter || undefined,
      limit: 50,
    })
      .then((next) => {
        if (!active) return;
        setResults(next);
      })
      .catch((error) => {
        if (!active) return;
        setResults({ messages: [], results: [] });
        setSearchError(error instanceof Error ? error.message : 'Search failed.');
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [query, searchMessages, scopeType, scopeId, serverId, fromFilter, beforeFilter, afterFilter]);

  const applyDateFilter = (type: 'before' | 'after', value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setFilters((current) => current.filter((filter) => filter.type !== type));
      return;
    }

    const selectedDate = new Date(`${trimmed}T00:00:00`);
    if (Number.isNaN(selectedDate.getTime())) {
      return;
    }

    const boundary = type === 'before'
      ? new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 23, 59, 59, 999)
      : new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 0, 0, 0, 0);
    addFilter(type, boundary.toISOString(), `${type === 'before' ? 'Before' : 'After'} ${trimmed}`);
  };

  const resultMessages = results.results;
  const resultCount = resultMessages.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search messages"
      className="absolute inset-0 z-50 flex flex-col bg-bg-0/95 backdrop-blur-sm animate-in fade-in duration-200"
    >
      {/* Header */}
      <div className="p-4 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <Search size={18} className="text-primary" />
          <h2 className="text-title font-semibold text-text-primary flex-1">SEARCH // CHANNEL</h2>
          <button onClick={onClose} aria-label="Close search" className="w-8 h-8 rounded-full glass-panel border border-stroke-subtle flex items-center justify-center text-text-secondary hover:text-primary transition-all focus-ring">
            <X size={16} />
          </button>
        </div>

        {/* Search Input */}
        <div className="relative">
          <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-text-disabled" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search messages..."
            autoFocus
            className="w-full h-12 pl-10 pr-4 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-body placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors focus-ring"
          />
        </div>

        {/* Filter chips */}
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <button onClick={() => setShowFilterMenu(showFilterMenu === 'from' ? null : 'from')} aria-expanded={showFilterMenu === 'from'} className="px-3 py-1.5 rounded-full text-[10px] font-bold border border-stroke-subtle text-text-secondary hover:bg-white/5 flex items-center gap-1.5 transition-all focus-ring">
            <User size={10} /> From
          </button>
          <button onClick={() => setShowFilterMenu(showFilterMenu === 'before' ? null : 'before')} aria-expanded={showFilterMenu === 'before'} className="px-3 py-1.5 rounded-full text-[10px] font-bold border border-stroke-subtle text-text-secondary hover:bg-white/5 flex items-center gap-1.5 transition-all focus-ring">
            <Calendar size={10} /> Date
          </button>

          {filters.map((f, i) => (
            <span key={i} className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-primary/15 text-primary border border-primary/30 flex items-center gap-1.5">
              {f.type}: {f.label}
              <button onClick={() => removeFilter(i)} aria-label={`Remove ${f.type} filter`} className="hover:text-white transition-colors focus-ring rounded-full"><X size={9} /></button>
            </span>
          ))}
        </div>

        {/* Filter dropdown */}
        {showFilterMenu === 'from' && (
          <div className="mt-2 glass-card rounded-r2 border border-stroke p-2 max-h-40 overflow-y-auto">
            {normalizedUsers.filter(u => u.id !== 'me').map(u => (
              <button key={u.id} onClick={() => addFilter('from', u.id, u.username)} className="w-full flex items-center gap-2 px-3 py-2 rounded-r1 text-text-secondary hover:bg-white/5 hover:text-text-primary text-xs transition-all">
                <img referrerPolicy="no-referrer" src={resolveAvatarSrc(u.avatar, u.username)} className="w-5 h-5 rounded-full" alt="" />
                {u.username}
              </button>
            ))}
          </div>
        )}
        {showFilterMenu === 'before' && (
          <div className="mt-2 glass-card rounded-r2 border border-stroke p-3 space-y-3">
            <div className="space-y-2">
              <div className="micro-label text-text-tertiary">BEFORE</div>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={beforeDraft}
                  onChange={(e) => setBeforeDraft(e.target.value)}
                  className="flex-1 h-10 px-3 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption focus:border-stroke-primary focus:outline-none"
                />
                <button onClick={() => applyDateFilter('before', beforeDraft)} className="h-10 px-4 rounded-full bg-primary text-bg-0 text-caption font-bold">
                  Apply
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <div className="micro-label text-text-tertiary">AFTER</div>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={afterDraft}
                  onChange={(e) => setAfterDraft(e.target.value)}
                  className="flex-1 h-10 px-3 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption focus:border-stroke-primary focus:outline-none"
                />
                <button onClick={() => applyDateFilter('after', afterDraft)} className="h-10 px-4 rounded-full bg-primary text-bg-0 text-caption font-bold">
                  Apply
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {query.trim().length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-3">
            <Search size={40} className="text-white/10" />
            <p className="text-body text-text-secondary">Start typing to search</p>
            <p className="text-caption text-text-disabled">Search runs against the live xorein control API.</p>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-3">
            <Search size={40} className="text-white/10" />
            <p className="text-body text-text-secondary">Searching the runtime</p>
          </div>
        ) : searchError ? (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-3">
            <Search size={40} className="text-white/10" />
            <p className="text-body text-text-secondary">Search unavailable</p>
            <p className="text-caption text-text-disabled text-center max-w-sm">{searchError}</p>
          </div>
        ) : resultCount === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-3">
            <Search size={40} className="text-white/10" />
            <p className="text-body text-text-secondary">No results found</p>
          </div>
        ) : (
          <>
            <div className="micro-label text-text-tertiary mb-3">{resultCount} RESULT{resultCount !== 1 ? 'S' : ''}</div>
            {resultMessages.map(msg => {
              const user = normalizedUsers.find(u => u.id === msg.sender_peer_id) ?? UNKNOWN_SEARCH_USER;
              return (
                <div key={msg.id} className="glass-card rounded-r2 p-3 border border-stroke hover:border-stroke-strong transition-all cursor-pointer">
                  <div className="flex items-center gap-2 mb-1.5">
                    <img referrerPolicy="no-referrer" src={resolveAvatarSrc(user.avatar, user.username)} className="w-5 h-5 rounded-full" alt="" />
                    <span className="text-xs font-bold text-text-primary">{user.username}</span>
                    <span className="text-[9px] text-text-disabled font-mono">{msg.created_at ?? ''}</span>
                  </div>
                  <div className="text-caption text-text-secondary">{renderMarkdown(msg.body)}</div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};
