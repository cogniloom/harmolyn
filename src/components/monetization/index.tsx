
import React, { useState } from 'react';
import { X, ShoppingBag, Trophy, Clock, CheckCircle2, Gift, Heart, Sparkles } from 'lucide-react';
import { DONATION_TIER_CONFIG } from '@/components/donorTiers';
import { usePersistentState } from '@/hooks/usePersistentState';
import { PREVIEW_STORAGE_KEYS } from '@/config/storageKeys';
import type { DonationTier } from '@/types';

/* ===== Donation Page ===== */

const DONATION_TIERS = [
  { id: 'coffee' as DonationTier, amount: '$3/mo', description: 'Buy the team a coffee every month' },
  { id: 'supporter' as DonationTier, amount: '$10/mo', description: 'Support monthly development' },
  { id: 'champion' as DonationTier, amount: '$25/mo', description: 'Champion the cause — maximum impact' },
  { id: 'custom' as const, amount: '', description: 'Choose your own recurring amount' },
];

export const DonationScreen: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [customAmount, setCustomAmount] = useState('');

  return (
    <div className="absolute inset-0 z-[100] bg-bg-0 overflow-y-auto no-scrollbar animate-in fade-in duration-200">
      <button onClick={onClose} className="absolute top-6 right-6 z-10 w-10 h-10 rounded-full border border-white/10 glass-panel flex items-center justify-center hover:border-primary hover:shadow-glow-sm transition-all">
        <X size={18} className="text-white/60" />
      </button>

      {/* Hero */}
      <div className="relative overflow-hidden py-16 px-6 text-center">
        <div className="absolute inset-0 bg-gradient-to-br from-accent-danger/10 via-primary/10 to-accent-success/10" />
        <div className="absolute inset-0 grid-overlay opacity-15" />
        <div className="relative">
          <div className="w-20 h-20 rounded-full bg-gradient-to-br from-accent-danger to-primary flex items-center justify-center mx-auto mb-5 shadow-[0_0_30px_rgba(255,42,109,0.3)]">
            <Heart size={36} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white font-display tracking-tight mb-2">SUPPORT HARMOLYN</h1>
          <p className="text-sm text-white/40 max-w-md mx-auto">
            Harmolyn is free and open. Your donations fund development, infrastructure, and keep the project alive.
          </p>
        </div>
      </div>

      {/* Tiers */}
      <div className="max-w-[520px] mx-auto px-6 pb-12">
        <div className="micro-label text-white/30 mb-4">CHOOSE A RECURRING TIER</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
          {DONATION_TIERS.map(tier => {
            const config = tier.id !== 'custom' ? DONATION_TIER_CONFIG[tier.id as DonationTier] : null;
            return (
              <button
                key={tier.id}
                onClick={() => setSelectedTier(tier.id)}
                className={`glass-card rounded-r2 p-5 border text-left transition-all ${
                  selectedTier === tier.id
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-white/5 hover:border-white/10'
                }`}
              >
                <div className="flex items-center gap-2.5 mb-2">
                  {config ? (
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center"
                      style={{ backgroundColor: `${config.color}15`, color: config.color, boxShadow: `0 0 12px ${config.glow}` }}
                    >
                      {React.cloneElement(config.icon as React.ReactElement, { size: 18 })}
                    </div>
                  ) : (
                    <div className="w-10 h-10 rounded-full flex items-center justify-center bg-white/5 text-white/40">
                      <Sparkles size={18} />
                    </div>
                  )}
                  <div>
                    <div className="text-sm font-bold text-white">{config?.label || 'Custom'}</div>
                    {tier.amount && <div className="text-lg font-bold text-white font-display">{tier.amount}</div>}
                  </div>
                </div>
                <p className="text-[11px] text-white/40">{tier.description}</p>
                {config && (
                  <div className="mt-2 text-[9px] uppercase tracking-wider font-bold" style={{ color: config.color }}>
                    Badge shown in chat &amp; profile
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {selectedTier === 'custom' && (
          <div className="mb-6">
            <label className="micro-label text-white/30 mb-2 block">CUSTOM AMOUNT</label>
            <input
              type="text"
              value={customAmount}
              onChange={e => setCustomAmount(e.target.value)}
              placeholder="$5.00"
              className="w-full h-14 px-6 rounded-full bg-surface-dark border border-white/10 text-white text-lg font-display placeholder:text-white/20 focus:border-primary/50 focus:outline-none"
            />
          </div>
        )}

        {selectedTier && (
          <button className="w-full py-4 rounded-full bg-primary text-bg-0 font-bold text-sm hover:shadow-glow transition-all flex items-center justify-center gap-2">
            <Heart size={16} />
            DONATE NOW
          </button>
        )}

        <div className="mt-8 glass-card rounded-r2 p-5 border border-white/5">
          <div className="micro-label text-white/30 mb-3">WHERE DONATIONS GO</div>
          <div className="space-y-2 text-[12px] text-white/50">
            <div className="flex items-center gap-2"><span className="text-primary">▸</span> Server infrastructure &amp; hosting</div>
            <div className="flex items-center gap-2"><span className="text-primary">▸</span> Core development &amp; bug fixes</div>
            <div className="flex items-center gap-2"><span className="text-primary">▸</span> Security audits &amp; encryption research</div>
            <div className="flex items-center gap-2"><span className="text-primary">▸</span> Community tools &amp; documentation</div>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ===== Shop ===== */

interface ShopItem {
  id: string;
  name: string;
  description: string;
  price: string;
  category: 'avatar' | 'profile' | 'effects' | 'collectible';
  image: string;
  rarity?: 'common' | 'rare' | 'epic' | 'legendary';
}

const SHOP_ITEMS: ShopItem[] = [
  { id: 's1', name: 'Neon Frame', description: 'Glowing cyan avatar frame', price: '$1.99', category: 'avatar', image: '🖼️', rarity: 'rare' },
  { id: 's2', name: 'Holographic Banner', description: 'Animated profile banner', price: '$4.99', category: 'profile', image: '🌈', rarity: 'epic' },
  { id: 's3', name: 'Sparkle Effect', description: 'Add sparkles to your messages', price: '$2.99', category: 'effects', image: '✨', rarity: 'common' },
  { id: 's4', name: 'Cyber Badge', description: 'Exclusive collector badge', price: '$7.99', category: 'collectible', image: '🏆', rarity: 'legendary' },
  { id: 's5', name: 'Ghost Mode Frame', description: 'Translucent avatar frame', price: '$1.49', category: 'avatar', image: '👻', rarity: 'common' },
  { id: 's6', name: 'Pixel Burst', description: 'Pixel explosion message effect', price: '$3.49', category: 'effects', image: '💥', rarity: 'rare' },
];

const rarityColors = {
  common: 'text-white/50',
  rare: 'text-primary',
  epic: 'text-accent-purple',
  legendary: 'text-accent-warning',
};

export const ShopScreen: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [category, setCategory] = useState<string>('all');
  const [owned, setOwned] = usePersistentState<string[]>(PREVIEW_STORAGE_KEYS.shop, []);
  const cats = ['all', 'avatar', 'profile', 'effects', 'collectible'];
  const filtered = category === 'all' ? SHOP_ITEMS : SHOP_ITEMS.filter(i => i.category === category);
  const purchase = (id: string) => setOwned((prev) => (prev.includes(id) ? prev : [...prev, id]));

  return (
    <div className="absolute inset-0 z-[100] bg-bg-0 overflow-y-auto no-scrollbar animate-in fade-in duration-200">
      <button onClick={onClose} className="absolute top-6 right-6 z-10 w-10 h-10 rounded-full border border-white/10 glass-panel flex items-center justify-center hover:border-primary hover:shadow-glow-sm transition-all">
        <X size={18} className="text-white/60" />
      </button>

      <div className="max-w-[700px] mx-auto px-6 py-12">
        <div className="flex items-center gap-3 mb-2">
          <ShoppingBag size={24} className="text-primary" />
          <h1 className="text-2xl font-bold text-white font-display tracking-tight">SHOP</h1>
        </div>
        <p className="micro-label text-white/30 mb-8">CUSTOMIZE // COLLECT // EXPRESS</p>

        {/* Category Filters */}
        <div className="flex gap-2 mb-6 flex-wrap">
          {cats.map(c => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${
                category === c
                  ? 'bg-primary/15 border-primary/30 text-primary'
                  : 'bg-white/3 border-white/5 text-white/30 hover:bg-white/5'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Items Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {filtered.map(item => (
            <div key={item.id} className="glass-card rounded-r2 p-4 border border-white/5 hover:border-primary/20 transition-all cursor-pointer group">
              <div className="text-4xl mb-3 text-center">{item.image}</div>
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-sm font-bold text-white">{item.name}</h3>
                {item.rarity && (
                  <span className={`text-[8px] font-bold uppercase tracking-wider ${rarityColors[item.rarity]}`}>{item.rarity}</span>
                )}
              </div>
              <p className="text-[10px] text-white/35 mb-3">{item.description}</p>
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-primary">{item.price}</span>
                {owned.includes(item.id) ? (
                  <span className="px-3 py-1 rounded-full bg-accent-success/10 border border-accent-success/20 text-accent-success text-[10px] font-bold flex items-center gap-1">
                    <CheckCircle2 size={10} /> OWNED
                  </span>
                ) : (
                  <button onClick={() => purchase(item.id)} className="px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold hover:bg-primary/20 transition-all opacity-0 group-hover:opacity-100">
                    BUY
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/* ===== Quests ===== */

interface Quest {
  id: string;
  title: string;
  description: string;
  reward: string;
  progress: number;
  maxProgress: number;
  type: 'daily' | 'weekly' | 'special';
  expiresIn?: string;
  completed?: boolean;
}


const questTypeColors = {
  daily: { color: 'text-primary', bg: 'bg-primary/15', border: 'border-primary/20' },
  weekly: { color: 'text-accent-purple', bg: 'bg-accent-purple/15', border: 'border-accent-purple/20' },
  special: { color: 'text-accent-warning', bg: 'bg-accent-warning/15', border: 'border-accent-warning/20' },
};

export const QuestsScreen: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [filter, setFilter] = useState<string>('all');
  const [progress, setProgress] = usePersistentState<{ balance: number; claimed: string[] }>(
    PREVIEW_STORAGE_KEYS.quests,
    { balance: 1250, claimed: [] },
  );
  // Quests have no runtime/protocol backing (see docs/PROTOCOL_GAPS.md
  // "Monetization"). The catalog ships empty and is preview-only; any quests are
  // hydrated from the local preview store.
  const [quests] = usePersistentState<Quest[]>(`${PREVIEW_STORAGE_KEYS.quests}:catalog`, []);
  const types = ['all', 'daily', 'weekly', 'special'];
  const filtered = filter === 'all' ? quests : quests.filter(q => q.type === filter);

  const claimQuest = (quest: Quest) => {
    if (progress.claimed.includes(quest.id)) {
      return;
    }
    const gems = /(\d+)\s*Gems/i.exec(quest.reward);
    setProgress((prev) => ({
      balance: prev.balance + (gems ? Number(gems[1]) : 0),
      claimed: [...prev.claimed, quest.id],
    }));
  };

  return (
    <div className="absolute inset-0 z-[100] bg-bg-0 overflow-y-auto no-scrollbar animate-in fade-in duration-200">
      <button onClick={onClose} className="absolute top-6 right-6 z-10 w-10 h-10 rounded-full border border-white/10 glass-panel flex items-center justify-center hover:border-primary hover:shadow-glow-sm transition-all">
        <X size={18} className="text-white/60" />
      </button>

      <div className="max-w-[600px] mx-auto px-6 py-12">
        <div className="flex items-center gap-3 mb-2">
          <Trophy size={24} className="text-accent-warning" />
          <h1 className="text-2xl font-bold text-white font-display tracking-tight">QUESTS</h1>
        </div>
        <p className="micro-label text-white/30 mb-8">CHALLENGES // REWARDS // GLORY</p>

        {/* Gem Balance */}
        <div className="glass-card rounded-r2 p-5 border border-white/8 mb-6 flex items-center justify-between">
          <div>
            <div className="micro-label text-white/30 mb-1">YOUR BALANCE</div>
            <div className="text-2xl font-bold text-white font-display flex items-center gap-2">
              <span className="text-accent-warning">💎</span> {progress.balance.toLocaleString()}
            </div>
          </div>
          <button className="px-4 py-2 rounded-full bg-accent-warning/10 border border-accent-warning/20 text-accent-warning text-xs font-bold hover:bg-accent-warning/20 transition-all">
            REDEEM
          </button>
        </div>

        {/* Filters */}
        <div className="flex gap-2 mb-6">
          {types.map(t => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={`px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${
                filter === t
                  ? 'bg-primary/15 border-primary/30 text-primary'
                  : 'bg-white/3 border-white/5 text-white/30 hover:bg-white/5'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Quest List */}
        <div className="space-y-3">
          {filtered.map(quest => {
            const tc = questTypeColors[quest.type];
            const pct = (quest.progress / quest.maxProgress) * 100;
            return (
              <div key={quest.id} className={`glass-card rounded-r2 p-4 border transition-all ${quest.completed ? 'border-accent-success/20 opacity-60' : 'border-white/5'}`}>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-bold text-white">{quest.title}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider ${tc.bg} ${tc.color} border ${tc.border}`}>
                        {quest.type}
                      </span>
                      {quest.completed && (
                        <CheckCircle2 size={14} className="text-accent-success" />
                      )}
                    </div>
                    <p className="text-[11px] text-white/40">{quest.description}</p>
                  </div>
                  {quest.expiresIn && (
                    <span className="flex items-center gap-1 text-[9px] text-accent-warning font-mono flex-shrink-0">
                      <Clock size={10} /> {quest.expiresIn}
                    </span>
                  )}
                </div>

                {/* Progress */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${quest.completed ? 'bg-accent-success' : 'bg-primary'}`}
                      style={{ width: `${Math.min(pct, 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-white/30 flex-shrink-0">
                    {quest.progress}/{quest.maxProgress}
                  </span>
                </div>

                {/* Reward */}
                <div className="flex items-center justify-between mt-2">
                  <div className="flex items-center gap-1.5 text-[10px] text-white/25">
                    <Gift size={10} />
                    <span>Reward: <span className="text-accent-warning font-bold">{quest.reward}</span></span>
                  </div>
                  {quest.completed && (
                    progress.claimed.includes(quest.id) ? (
                      <span className="text-[9px] font-bold uppercase tracking-wider text-accent-success">Claimed</span>
                    ) : (
                      <button onClick={() => claimQuest(quest)} className="px-3 py-1 rounded-full bg-accent-warning/10 border border-accent-warning/20 text-accent-warning text-[9px] font-bold hover:bg-accent-warning/20 transition-all">
                        CLAIM
                      </button>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
