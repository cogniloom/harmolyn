
import React, { useState } from 'react';
import { X, Search, Gamepad2, Music, Palette, Globe, Star, Users, Play, Sparkles } from 'lucide-react';

interface Activity {
  id: string;
  name: string;
  description: string;
  category: 'games' | 'music' | 'creative' | 'social';
  icon: React.ReactNode;
  maxPlayers: number;
  popular?: boolean;
}

const ACTIVITIES: Activity[] = [
  { id: 'a1', name: 'Sketch Together', description: 'Collaborative whiteboard drawing game', category: 'creative', icon: <Palette size={24} />, maxPlayers: 16, popular: true },
  { id: 'a2', name: 'Watch Together', description: 'Synchronized video watching party', category: 'social', icon: <Globe size={24} />, maxPlayers: 50, popular: true },
  { id: 'a3', name: 'Word Chain', description: 'Fast-paced word association game', category: 'games', icon: <Gamepad2 size={24} />, maxPlayers: 8 },
  { id: 'a4', name: 'Beats Studio', description: 'Make music together in real-time', category: 'music', icon: <Music size={24} />, maxPlayers: 6 },
  { id: 'a5', name: 'Trivia Night', description: 'Test your knowledge against friends', category: 'games', icon: <Sparkles size={24} />, maxPlayers: 12, popular: true },
  { id: 'a6', name: 'Chess', description: 'Classic 1v1 strategy board game', category: 'games', icon: <Gamepad2 size={24} />, maxPlayers: 2 },
  { id: 'a7', name: 'Poker Stars', description: 'Texas Hold\'em with your crew', category: 'games', icon: <Star size={24} />, maxPlayers: 8 },
  { id: 'a8', name: 'Pixel Art', description: 'Create pixel art collaboratively', category: 'creative', icon: <Palette size={24} />, maxPlayers: 10 },
];

const categoryIcons: Record<string, React.ReactNode> = {
  games: <Gamepad2 size={14} />,
  music: <Music size={14} />,
  creative: <Palette size={14} />,
  social: <Globe size={14} />,
};

interface ActivityLauncherProps {
  onClose: () => void;
  onLaunch?: (activityId: string) => Promise<void> | void;
  disabledReason?: string;
  activeActivityId?: string | null;
}

export const ActivityLauncher: React.FC<ActivityLauncherProps> = ({ onClose, onLaunch, disabledReason, activeActivityId }) => {
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [launching, setLaunching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const categories = ['all', 'games', 'music', 'creative', 'social'];

  const filtered = ACTIVITIES.filter(a => {
    const matchesSearch = a.name.toLowerCase().includes(search.toLowerCase());
    const matchesCat = selectedCategory === 'all' || a.category === selectedCategory;
    return matchesSearch && matchesCat;
  });

  const handleLaunch = async (id: string) => {
    if (disabledReason) {
      setError(disabledReason);
      return;
    }
    setLaunching(id);
    setError(null);
    try {
      await onLaunch?.(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to launch the activity.');
    } finally {
      setLaunching(null);
    }
  };

  return (
    <div className="absolute inset-0 z-[100] bg-bg-0/95 backdrop-blur-xl flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="glass-card rounded-r3 border border-white/10 w-full max-w-[600px] max-h-[80vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="px-6 py-5 border-b border-white/5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white font-display tracking-tight">ACTIVITIES</h2>
          <p className="micro-label text-white/30 mt-1">LAUNCH // PLAY // CONNECT</p>
        </div>
          <button onClick={onClose} className="w-10 h-10 rounded-full border border-white/10 glass-panel flex items-center justify-center hover:border-primary hover:shadow-glow-sm transition-all">
            <X size={18} className="text-white/60 hover:text-primary" />
          </button>
        </div>

        {disabledReason && (
          <div className="mx-6 mt-4 rounded-r2 border border-accent-warning/20 bg-accent-warning/10 px-4 py-3 text-[10px] font-mono text-accent-warning">
            {disabledReason}
          </div>
        )}

        {error && (
          <div className="mx-6 mt-4 rounded-r2 border border-accent-danger/20 bg-accent-danger/10 px-4 py-3 text-[10px] font-mono text-accent-danger">
            {error}
          </div>
        )}

        {/* Search */}
        <div className="px-6 py-3">
          <div className="relative">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search activities..."
              className="w-full bg-surface-dark rounded-full pl-11 pr-4 py-3 text-sm text-white placeholder:text-white/25 border border-white/5 focus:border-primary/30 focus:outline-none transition-all"
            />
          </div>
        </div>

        {/* Category Filters */}
        <div className="px-6 pb-3 flex gap-2 flex-wrap">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${
                selectedCategory === cat
                  ? 'bg-primary/15 border-primary/30 text-primary'
                  : 'bg-white/3 border-white/5 text-white/30 hover:bg-white/5 hover:text-white/50'
              }`}
            >
              {cat !== 'all' && categoryIcons[cat]}
              {cat}
            </button>
          ))}
        </div>

        {/* Activity Grid */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 no-scrollbar">
          <div className="grid grid-cols-2 gap-3">
            {filtered.map(activity => (
              <div
                key={activity.id}
                className={`glass-card rounded-r2 p-4 border transition-all cursor-pointer group relative overflow-hidden ${
                  launching === activity.id || activeActivityId === activity.id
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-white/5 hover:border-primary/20 hover:bg-white/[0.02]'
                } ${disabledReason ? 'opacity-50 cursor-not-allowed' : ''}`}
                onClick={() => handleLaunch(activity.id)}
              >
                {activity.popular && (
                  <div className="absolute top-2 right-2">
                    <span className="px-2 py-0.5 rounded-full bg-accent-warning/20 text-accent-warning text-[8px] font-bold uppercase tracking-wider">HOT</span>
                  </div>
                )}

                <div className={`w-12 h-12 rounded-r2 flex items-center justify-center mb-3 transition-all ${
                  launching === activity.id ? 'bg-primary/20 text-primary' : 'bg-white/5 text-white/40 group-hover:text-primary group-hover:bg-primary/10'
                }`}>
                  {launching === activity.id ? (
                    <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  ) : activeActivityId === activity.id ? (
                    <Play size={24} className="text-primary" />
                  ) : activity.icon}
                </div>

                <h3 className="text-sm font-bold text-white mb-1">{activity.name}</h3>
                <p className="text-[10px] text-white/40 mb-3 line-clamp-2">{activity.description}</p>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1 text-[9px] text-white/20">
                    <Users size={10} />
                    <span>Max {activity.maxPlayers}</span>
                  </div>
                  <div className={`flex items-center gap-1 text-[9px] font-bold transition-all ${
                    launching === activity.id || activeActivityId === activity.id ? 'text-primary' : 'text-white/20 group-hover:text-primary'
                  }`}>
                    <Play size={10} />
                    <span>{launching === activity.id ? 'LAUNCHING...' : activeActivityId === activity.id ? 'ACTIVE' : 'LAUNCH'}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {filtered.length === 0 && (
            <div className="text-center py-16">
              <Gamepad2 size={32} className="mx-auto text-white/10 mb-3" />
              <p className="text-xs text-white/20">No activities found</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
