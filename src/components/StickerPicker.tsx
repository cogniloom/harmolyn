import React, { useEffect, useMemo, useState } from 'react';
import { Clock } from 'lucide-react';
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

export const StickerPicker: React.FC<StickerPickerProps> = ({ onSelect }) => {
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
    <div className="absolute bottom-14 right-0 w-[272px] h-[336px] bg-bg-0 border border-white/10 rounded-r2 shadow-[0_0_50px_rgba(0,0,0,0.8)] glass-card flex flex-col animate-in slide-in-from-bottom-2 z-50 overflow-hidden">
      <div className="px-3 py-2.5 border-b border-white/5 micro-label text-white/40 tracking-widest text-[9px]">STICKERS</div>
      <div className="flex-1 overflow-y-auto no-scrollbar px-2 py-2">
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
                  className="aspect-square text-4xl flex items-center justify-center hover:bg-white/10 rounded-r1 transition-colors"
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
