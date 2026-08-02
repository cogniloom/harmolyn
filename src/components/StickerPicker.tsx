import React, { useEffect, useMemo, useState } from 'react';
import { Clock, X } from 'lucide-react';
import { safeStorageGet, safeStorageSet } from '@/lib/browserStorage';

interface StickerCategory {
  id: string;
  name: string;
  stickers: string[];
}

const CATEGORIES: StickerCategory[] = [
  { id: 'reactions', name: 'REACTIONS', stickers: ['😂', '🤣', '😭', '😍', '🥹', '😎', '🤔', '😱', '🥳', '😴', '🙄', '😤'] },
  { id: 'love', name: 'LOVE', stickers: ['❤️', '🧡', '💛', '💚', '💙', '💜', '💕', '💖', '😘', '🥰'] },
  { id: 'celebrate', name: 'CELEBRATE', stickers: ['🎉', '🎊', '🥳', '🍾', '🎂', '✨', '🙌', '👏', '🏆', '🎈'] },
  { id: 'animals', name: 'CRITTERS', stickers: ['🐶', '🐱', '🦊', '🐼', '🐸', '🐵', '🦄', '🐙', '🐧', '🦁'] },
  { id: 'hands', name: 'HANDS', stickers: ['👍', '👎', '👌', '✌️', '🤝', '🙏', '💪', '🤙', '👏', '🫶'] },
];

const RECENT_STORAGE_KEY = 'harmolyn-recent-stickers';

interface StickerPickerProps {
  onSelect: (sticker: string) => void;
  onClose: () => void;
}

export const StickerPicker: React.FC<StickerPickerProps> = ({ onSelect, onClose }) => {
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(safeStorageGet(() => window.localStorage, RECENT_STORAGE_KEY) || "[]") as unknown;
      return parseRecentStickers(parsed);
    } catch {
      return [];
    }
  });

  const handleSelect = (sticker: string) => {
    const updated = [sticker, ...recent.filter((s) => s !== sticker)].slice(0, 8);
    setRecent(updated);
    onSelect(sticker);
  };

  useEffect(() => {
    safeStorageSet(() => window.localStorage, RECENT_STORAGE_KEY, JSON.stringify(recent));
  }, [recent]);

  const sections = useMemo(() => {
    if (recent.length === 0) {
      return CATEGORIES;
    }
    return [{ id: 'recent', name: 'RECENTLY USED', stickers: recent }, ...CATEGORIES];
  }, [recent]);

  return (
    <div
      role="dialog"
      aria-label="Sticker picker"
      className="responsive-composer-picker absolute bottom-[calc(3.5rem+env(safe-area-inset-bottom))] right-[max(0px,env(safe-area-inset-right))] z-50 flex h-[336px] max-h-[calc(100dvh-5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[320px] max-w-[calc(100vw-1rem-env(safe-area-inset-left)-env(safe-area-inset-right))] min-h-0 flex-col overflow-hidden rounded-r2 border border-white/10 bg-bg-0 shadow-[0_0_50px_rgba(0,0,0,0.8)] glass-card animate-in slide-in-from-bottom-2"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-white/5 py-1.5 pl-3 pr-1.5">
        <span className="micro-label text-[9px] tracking-widest text-white/40">STICKERS</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close sticker picker"
          className="compact-touch-target flex items-center justify-center rounded-full text-white/40 transition-colors hover:bg-white/5 hover:text-white focus-ring"
        >
          <X size={14} />
        </button>
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {sections.map((category) => (
          <div key={category.id}>
            <div className="micro-label text-white/25 tracking-widest px-1 py-1 text-[8px] flex items-center gap-1">
              {category.id === 'recent' && <Clock size={9} />}
              {category.name}
            </div>
            <div className="grid grid-cols-4 gap-1">
              {category.stickers.map((sticker, index) => (
                <button
                  key={`${category.id}-${index}`}
                  type="button"
                  onClick={() => handleSelect(sticker)}
                  className="compact-touch-target flex aspect-square min-h-11 items-center justify-center rounded-r1 text-4xl transition-colors hover:bg-white/10 focus-ring"
                  aria-label={`Send ${sticker} sticker`}
                >
                  {sticker}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

function parseRecentStickers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const parsed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    parsed.push(normalized);
    if (parsed.length >= 8) {
      break;
    }
  }
  return parsed;
}
