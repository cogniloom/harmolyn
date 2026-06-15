
import React from 'react';
import { X, Zap, Sparkles, ChevronRight, Star } from 'lucide-react';
import { usePersistentState } from '@/hooks/usePersistentState';
import { PREVIEW_STORAGE_KEYS } from '@/config/storageKeys';

interface BoostTier {
  level: number;
  name: string;
  boostsRequired: number;
  perks: string[];
  color: string;
}

const BOOST_TIERS: BoostTier[] = [
  {
    level: 1, name: 'Tier 1', boostsRequired: 2,
    perks: ['50 custom emoji slots', '128 Kbps audio quality', 'Custom server invite background', 'Animated server icon'],
    color: '#A855F7',
  },
  {
    level: 2, name: 'Tier 2', boostsRequired: 7,
    perks: ['100 custom emoji slots', '256 Kbps audio quality', '50 MB upload limit', 'Server banner', '1080p stream quality'],
    color: '#EC4899',
  },
  {
    level: 3, name: 'Tier 3', boostsRequired: 14,
    perks: ['250 custom emoji slots', '384 Kbps audio quality', '100 MB upload limit', 'Vanity URL', 'Custom role icons'],
    color: '#F59E0B',
  },
];

interface ServerBoostProps {
  serverId: string;
  serverName: string;
  onClose: () => void;
}

export const ServerBoost: React.FC<ServerBoostProps> = ({ serverId, serverName, onClose }) => {
  const [currentBoosts, setCurrentBoosts] = usePersistentState<number>(PREVIEW_STORAGE_KEYS.serverBoost(serverId), 3);

  const currentTier = BOOST_TIERS.reduce((acc, t) => currentBoosts >= t.boostsRequired ? t : acc, null as BoostTier | null);
  const nextTier = BOOST_TIERS.find(t => currentBoosts < t.boostsRequired);
  const progressToNext = nextTier ? (currentBoosts / nextTier.boostsRequired) * 100 : 100;

  const handleBoost = () => {
    setCurrentBoosts((n) => n + 1);
  };

  return (
    <div className="absolute inset-0 z-[100] bg-bg-0/95 backdrop-blur-xl flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="glass-card rounded-r3 border border-white/10 w-full max-w-[520px] max-h-[85vh] overflow-y-auto shadow-2xl no-scrollbar">
        {/* Header */}
        <div className="relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-accent-purple/20 via-primary/10 to-accent-purple/5" />
          <div className="absolute inset-0 grid-overlay opacity-20" />
          <div className="relative px-6 py-8 text-center">
            <div className="w-16 h-16 rounded-full bg-accent-purple/20 border border-accent-purple/30 flex items-center justify-center mx-auto mb-4 shadow-[0_0_20px_rgba(168,85,247,0.3)]">
              <Zap size={28} className="text-accent-purple" />
            </div>
            <h2 className="text-xl font-bold text-white font-display tracking-tight">SERVER BOOST</h2>
            <p className="micro-label text-white/30 mt-1">{serverName.toUpperCase()} // ENHANCEMENT</p>
          </div>
          <button onClick={onClose} className="absolute top-4 right-4 w-10 h-10 rounded-full border border-white/10 glass-panel flex items-center justify-center hover:border-primary hover:shadow-glow-sm transition-all">
            <X size={18} className="text-white/60" />
          </button>
        </div>

        {/* Current Status */}
        <div className="px-6 py-5">
          <div className="glass-card rounded-r2 p-5 border border-white/8">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-accent-purple" />
                <span className="micro-label text-white/40">CURRENT STATUS</span>
              </div>
              <span className="text-sm font-bold" style={{ color: currentTier?.color || '#F6F8F8' }}>
                {currentTier ? currentTier.name : 'No Tier'}
              </span>
            </div>

            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl font-bold text-white font-display">{currentBoosts}</span>
              <span className="text-xs text-white/30">boosts active</span>
            </div>

            {nextTier && (
              <>
                <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden mb-2">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min(progressToNext, 100)}%`,
                      background: `linear-gradient(90deg, ${currentTier?.color || '#13DDEC'}, ${nextTier.color})`,
                      boxShadow: `0 0 8px ${nextTier.color}40`,
                    }}
                  />
                </div>
                <p className="text-[10px] text-white/25 font-mono">
                  {nextTier.boostsRequired - currentBoosts} MORE BOOSTS TO {nextTier.name.toUpperCase()}
                </p>
              </>
            )}
          </div>
        </div>

        {/* Tiers */}
        <div className="px-6 pb-5">
          <div className="micro-label text-white/30 mb-3">BOOST // TIERS</div>
          <div className="space-y-3">
            {BOOST_TIERS.map(tier => {
              const unlocked = currentBoosts >= tier.boostsRequired;
              return (
                <div
                  key={tier.level}
                  className={`glass-card rounded-r2 p-4 border transition-all ${
                    unlocked ? 'border-white/10' : 'border-white/5 opacity-60'
                  }`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Star size={14} style={{ color: tier.color }} className={unlocked ? '' : 'opacity-50'} />
                      <span className="text-sm font-bold text-white">{tier.name}</span>
                      <span className="text-[9px] font-mono text-white/20">{tier.boostsRequired} BOOSTS</span>
                    </div>
                    {unlocked && (
                      <span className="px-2 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider bg-accent-success/15 text-accent-success border border-accent-success/20">
                        UNLOCKED
                      </span>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {tier.perks.map((perk, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px] text-white/40">
                        <ChevronRight size={10} style={{ color: unlocked ? tier.color : undefined }} />
                        <span>{perk}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Boost Button */}
        <div className="px-6 pb-6">
          <button
            onClick={handleBoost}
            className="w-full py-4 rounded-full font-bold text-sm transition-all flex items-center justify-center gap-2 bg-gradient-to-r from-accent-purple to-pink-500 text-white hover:shadow-[0_0_20px_rgba(168,85,247,0.4)]"
          >
            <Zap size={16} />
            BOOST THIS SERVER
          </button>
          <p className="text-center text-[9px] text-white/15 font-mono mt-2">
            BOOST SUBSCRIPTION // RENEWABLE MONTHLY
          </p>
        </div>
      </div>
    </div>
  );
};
