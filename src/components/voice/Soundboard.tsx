
import React, { useState } from 'react';
import { Volume2, VolumeX, Star, Search, X } from 'lucide-react';
import { usePersistentState } from '@/hooks/usePersistentState';
import { PREVIEW_STORAGE_KEYS } from '@/config/storageKeys';

interface SoundEffect {
  id: string;
  name: string;
  emoji: string;
  duration: string;
  favorited: boolean;
  category: string;
}


const CATEGORIES = ['all', 'favorites', 'classic', 'memes', 'nature', 'reactions', 'effects'];

interface SoundboardProps {
  onClose: () => void;
}

export const Soundboard: React.FC<SoundboardProps> = ({ onClose }) => {
  const [sounds, setSounds] = usePersistentState<SoundEffect[]>(PREVIEW_STORAGE_KEYS.soundboard, []);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [volume, setVolume] = usePersistentState<number>(`${PREVIEW_STORAGE_KEYS.soundboard}:volume`, 75);

  const toggleFavorite = (id: string) => {
    setSounds(prev => prev.map(s => s.id === id ? { ...s, favorited: !s.favorited } : s));
  };

  const playSound = (id: string) => {
    setPlayingId(id);
    setTimeout(() => setPlayingId(null), 1500);
  };

  const filtered = sounds.filter(s => {
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (activeCategory === 'favorites') return s.favorited;
    if (activeCategory !== 'all' && s.category !== activeCategory) return false;
    return true;
  });

  return (
    <div className="w-[320px] h-[420px] glass-card border border-white/10 rounded-r2 shadow-2xl flex flex-col overflow-hidden animate-in fade-in slide-in-from-bottom-2">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Volume2 size={14} className="text-primary" />
          <span className="micro-label text-white/80 tracking-widest">SOUNDBOARD</span>
        </div>
        <button onClick={onClose} className="p-1 text-white/30 hover:text-white/60 transition-colors">
          <X size={14} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center gap-2 bg-surface-dark rounded-full border border-white/5 px-3 py-1.5">
          <Search size={12} className="text-white/30" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search sounds..."
            className="flex-1 bg-transparent text-[11px] text-white placeholder-white/25 focus:outline-none"
          />
        </div>
      </div>

      {/* Categories */}
      <div className="px-3 pb-2 flex gap-1.5 overflow-x-auto no-scrollbar">
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider whitespace-nowrap transition-all border ${
              activeCategory === cat
                ? 'bg-primary/15 border-primary/30 text-primary'
                : 'bg-white/3 border-white/5 text-white/40 hover:bg-white/5 hover:text-white/60'
            }`}
          >
            {cat === 'favorites' ? '⭐' : ''} {cat}
          </button>
        ))}
      </div>

      {/* Sound Grid */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 no-scrollbar">
        <div className="grid grid-cols-3 gap-2">
          {filtered.map(sound => (
            <button
              key={sound.id}
              onClick={() => playSound(sound.id)}
              className={`relative flex flex-col items-center gap-1 p-2.5 rounded-r1 border transition-all cursor-pointer group ${
                playingId === sound.id
                  ? 'bg-primary/15 border-primary/30 scale-95'
                  : 'bg-white/3 border-white/5 hover:bg-white/5 hover:border-white/10'
              }`}
            >
              <span className="text-xl">{sound.emoji}</span>
              <span className="text-[9px] font-bold text-white/70 truncate w-full text-center">{sound.name}</span>
              <span className="text-[7px] font-mono text-white/30">{sound.duration}</span>
              {/* Favorite star */}
              <button
                onClick={e => { e.stopPropagation(); toggleFavorite(sound.id); }}
                aria-label={`${sound.favorited ? 'Unfavorite' : 'Favorite'} ${sound.name}`}
                aria-pressed={sound.favorited}
                className={`absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity ${sound.favorited ? '!opacity-100 text-accent-warning' : 'text-white/20'}`}
              >
                <Star size={10} fill={sound.favorited ? 'currentColor' : 'none'} />
              </button>
              {/* Playing indicator */}
              {playingId === sound.id && (
                <div className="absolute inset-0 rounded-r1 border-2 border-primary animate-pulse pointer-events-none" />
              )}
            </button>
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="flex items-center justify-center h-20 text-white/20 text-[10px] font-mono">NO SOUNDS FOUND</div>
        )}
      </div>

      {/* Volume — local effect playback level for this client */}
      <div className="px-4 py-2.5 border-t border-white/5 flex items-center gap-3">
        <VolumeX size={12} className="text-white/30" />
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={e => setVolume(Number(e.target.value))}
          aria-label="Soundboard effect volume"
          aria-valuetext={`${volume}%`}
          className="flex-1 accent-primary h-1 focus-ring rounded-full"
        />
        <Volume2 size={12} className="text-white/30" />
        <span className="text-[9px] font-mono text-white/40 w-8 text-right">{volume}%</span>
      </div>
    </div>
  );
};
