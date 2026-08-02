import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search, X, Clock, Smile, Heart, TreePine, UtensilsCrossed, Gamepad2, Car, Lightbulb, Flag, Hash } from 'lucide-react';
import { safeStorageGet, safeStorageSet } from '@/lib/browserStorage';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface EmojiCategory {
  id: string;
  name: string;
  icon: React.ReactNode;
  emojis: string[];
}

const CATEGORIES: EmojiCategory[] = [
  {
    id: 'smileys',
    name: 'SMILEYS & PEOPLE',
    icon: <Smile size={14} />,
    emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','☹️','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'],
  },
  {
    id: 'gestures',
    name: 'GESTURES & BODY',
    icon: <Heart size={14} />,
    emojis: ['👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','💗','💓','💕','💖','💝','💘','💟'],
  },
  {
    id: 'nature',
    name: 'NATURE & ANIMALS',
    icon: <TreePine size={14} />,
    emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🌸','🌺','🌻','🌹','🌷','🌼','🌱','🪴','🌿','☘️','🍀','🌵','🌴','🌳','🌲','🍂','🍁','🍄','🌾','💐','🌍','🌎','🌏','🌕','🌖','🌗','🌑','🌒','🌓','🌔','🌙','⭐','🌟','💫','✨','☀️','🌤️','⛅','🌥️','☁️','🌧️','⛈️','🌩️','🌈','❄️','☃️','⛄','🔥','💧','🌊'],
  },
  {
    id: 'food',
    name: 'FOOD & DRINK',
    icon: <UtensilsCrossed size={14} />,
    emojis: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🫘','🥐','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','☕','🍵','🧋','🥤','🍶','🍺','🍻','🥂','🍷','🍸','🍹','🧃','💧','🧊'],
  },
  {
    id: 'activities',
    name: 'ACTIVITIES',
    icon: <Gamepad2 size={14} />,
    emojis: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','🤺','⛹️','🏊','🚣','🧗','🚴','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎪','🤹','🎭','🩰','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🪗','🎸','🪕','🎻','🎲','♟️','🎯','🎳','🎮','🕹️','🧩','🪩'],
  },
  {
    id: 'travel',
    name: 'TRAVEL & PLACES',
    icon: <Car size={14} />,
    emojis: ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🏍️','🛵','🦽','🦼','🛺','🚲','🛴','🛹','🛼','🚏','🛣️','🛤️','⛽','🛞','🚨','🚥','🚦','🛑','🚧','⚓','🛟','⛵','🛶','🚤','🛳️','⛴️','🛥️','🚢','✈️','🛩️','🛫','🛬','🪂','💺','🚁','🚟','🚠','🚡','🛰️','🚀','🛸','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🛕','🕍','⛩️','🕋','⛲','⛺','🌁','🌃','🏙️','🌄','🌅','🌆','🌇','🌉','🗾','🏔️','⛰️','🌋','🗻','🏕️','🏖️','🏜️','🏝️','🏞️'],
  },
  {
    id: 'objects',
    name: 'OBJECTS & SYMBOLS',
    icon: <Lightbulb size={14} />,
    emojis: ['⌚','📱','📲','💻','⌨️','🖥️','🖨️','🖱️','🖲️','🕹️','🗜️','💾','💿','📀','📼','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','⌛','⏳','📡','🔋','🪫','🔌','💡','🔦','🕯️','🪔','🧯','🛢️','💸','💵','💴','💶','💷','🪙','💰','💳','💎','⚖️','🪜','🧰','🪛','🔧','🔨','⚒️','🛠️','⛏️','🪚','🔩','⚙️','🪤','🧲','🔫','💣','🧨','🪓','🔪','🗡️','⚔️','🛡️','🚬','⚰️','🪦','⚱️','🏺','🔮','📿','🧿','🪬','💈','⚗️','🔭','🔬','🕳️','🩹','🩺','🩻','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡️','🧹','🪠','🧺','🧻','🧼','🫧','🪥','🧽','🧴','🔑','🗝️','🚪','🪑','🛋️','🛏️','🛌','🧸','🪆','🖼️','🪞','🪟','🛍️','🛒','🎁','🎈','🎏','🎀','🪄','🪅','🎊','🎉','🎎','🏮','🎐','🧧','✉️','📩','📨','📧','💌','📥','📤','📦','🏷️','🪧','📪','📫','📬','📭','📮','📯','📜','📃','📄','📑','🧾','📊','📈','📉','🗒️','🗓️','📆','📅','🗑️','📇','🗃️','🗳️','🗄️','📋','📁','📂','🗂️','🗞️','📰','📓','📔','📒','📕','📗','📘','📙','📚','📖','🔖','🧷','🔗','📎','🖇️','📐','📏','🧮','📌','📍','✂️','🖊️','🖋️','✒️','🖌️','🖍️','📝','✏️','🔍','🔎','🔏','🔐','🔒','🔓'],
  },
  {
    id: 'flags',
    name: 'FLAGS & SYMBOLS',
    icon: <Flag size={14} />,
    emojis: ['🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🇺🇸','🇬🇧','🇫🇷','🇩🇪','🇯🇵','🇰🇷','🇨🇳','🇧🇷','🇮🇳','🇷🇺','🇦🇺','🇨🇦','🇪🇸','🇮🇹','🇲🇽','🇳🇱','🇸🇪','🇨🇭','🇳🇴','🇩🇰','🇫🇮','🇵🇱','🇦🇹','🇧🇪','🇵🇹','🇬🇷','🇹🇷','🇿🇦','🇦🇷','🇨🇴','🇨🇱','🇵🇪','⚠️','🚸','⛔','🚫','🚳','🚭','🚯','🚱','🚷','📵','🔞','☢️','☣️','⬆️','↗️','➡️','↘️','⬇️','↙️','⬅️','↖️','↕️','↔️','↩️','↪️','⤴️','⤵️','🔃','🔄','🔙','🔚','🔛','🔜','🔝','🛐','⚛️','🕉️','✡️','☸️','☯️','✝️','☦️','☪️','☮️','🕎','🔯','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','⛎','🔀','🔁','🔂','▶️','⏩','⏭️','⏯️','◀️','⏪','⏮️','🔼','⏫','🔽','⏬','⏸️','⏹️','⏺️','⏏️','🎦','🔅','🔆','📶','🛜','📳','📴','♀️','♂️','⚧️','✖️','➕','➖','➗','🟰','♾️','‼️','⁉️','❓','❔','❕','❗','〰️','💱','💲','⚕️','♻️','⚜️','🔱','📛','🔰','⭕','✅','☑️','✔️','❌','❎','➰','➿','〽️','✳️','✴️','❇️','©️','®️','™️','#️⃣','*️⃣','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔠','🔡','🔢','🔣','🔤','🅰️','🆎','🅱️','🆑','🆒','🆓','ℹ️','🆔','Ⓜ️','🆕','🆖','🅾️','🆗','🅿️','🆘','🆙','🆚','🈁','🈂️','🈷️','🈶','🈯','🉐','🈹','🈚','🈲','🉑','🈸','🈴','🈳','㊗️','㊙️','🈺','🈵','🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪','🟥','🟧','🟨','🟩','🟦','🟪','🟫','⬛','⬜','◼️','◻️','◾','◽','▪️','▫️','🔶','🔷','🔸','🔹','🔺','🔻','💠','🔘','🔳','🔲'],
  },
];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

const RECENT_EMOJIS_STORAGE_KEY = 'harmolyn-recent-emojis';
const SKIN_TONE_STORAGE_KEY = 'harmolyn-emoji-skin-tone';

/**
 * Fitzpatrick skin-tone modifiers (U+1F3FB..U+1F3FF). Index 0 is the default
 * (yellow / no modifier). Only applied to the curated `TONEABLE` allow-list so
 * we never emit a broken modifier sequence on an emoji that does not support one.
 */
const SKIN_TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
const SKIN_TONE_LABELS = ['Default', 'Light', 'Medium-light', 'Medium', 'Medium-dark', 'Dark'];
const SKIN_TONE_SWATCHES = ['#FFD83D', '#FAD9C2', '#E4BB95', '#C8956A', '#A06940', '#5C473C'];

/** Base hand/person emoji that universally accept a skin-tone modifier. */
const TONEABLE = new Set<string>([
  '👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙',
  '👈','👉','👆','🖕','👇','☝️','🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝',
  '🙏','💪','🦾',
]);

/** Applies the chosen skin tone to a toneable base emoji; otherwise returns it unchanged. */
function applySkinTone(emoji: string, toneIndex: number): string {
  const tone = SKIN_TONES[toneIndex];
  if (!tone) return emoji;
  // Strip any trailing variation selector before appending the modifier so the
  // sequence renders consistently (e.g. "✌️" -> "✌🏽").
  const base = emoji.replace(/️$/u, '');
  return TONEABLE.has(emoji) ? base + tone : emoji;
}

function readRecentEmojis(): string[] {
  try {
    const parsed = JSON.parse(safeStorageGet(() => window.localStorage, RECENT_EMOJIS_STORAGE_KEY) || "[]") as unknown;
    return parseRecentStringArray(parsed, 24);
  } catch {
    return [];
  }
}

function saveRecentEmojis(emojis: string[]): void {
  try {
    safeStorageSet(() => window.localStorage, RECENT_EMOJIS_STORAGE_KEY, JSON.stringify(emojis));
  } catch {
    // Browsers can block storage in private mode or on quota/security failures.
  }
}

function readSkinTone(): number {
  try {
    const raw = safeStorageGet(() => window.localStorage, SKIN_TONE_STORAGE_KEY);
    const idx = raw == null ? 0 : Number.parseInt(raw, 10);
    return Number.isInteger(idx) && idx >= 0 && idx < SKIN_TONES.length ? idx : 0;
  } catch {
    return 0;
  }
}

function saveSkinTone(toneIndex: number): void {
  try {
    safeStorageSet(() => window.localStorage, SKIN_TONE_STORAGE_KEY, String(toneIndex));
  } catch {
    // Browsers can block storage in private mode or on quota/security failures.
  }
}

export const EmojiPicker: React.FC<EmojiPickerProps> = ({ onSelect, onClose }) => {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('smileys');
  const [recentEmojis, setRecentEmojis] = useState<string[]>(() => readRecentEmojis());
  const [skinTone, setSkinTone] = useState<number>(() => readSkinTone());
  const [toneMenuOpen, setToneMenuOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const categoryRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEscapeKey(toneMenuOpen ? () => setToneMenuOpen(false) : onClose);

  const handleSelect = (emoji: string) => {
    const toned = applySkinTone(emoji, skinTone);
    onSelect(toned);
    const updated = [toned, ...recentEmojis.filter(e => e !== toned)].slice(0, 24);
    setRecentEmojis(updated);
  };

  useEffect(() => {
    saveRecentEmojis(recentEmojis);
  }, [recentEmojis]);

  useEffect(() => {
    saveSkinTone(skinTone);
  }, [skinTone]);

  const filteredCategories = useMemo(() => {
    if (!search.trim()) return CATEGORIES;
    const q = search.toLowerCase();
    return CATEGORIES.map(cat => ({
      ...cat,
      emojis: cat.emojis.filter(e => e.includes(q)),
    })).filter(cat => cat.emojis.length > 0);
  }, [search]);

  const scrollToCategory = (id: string) => {
    setActiveCategory(id);
    categoryRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const handleScroll = () => {
      for (const cat of CATEGORIES) {
        const ref = categoryRefs.current[cat.id];
        if (ref) {
          const rect = ref.getBoundingClientRect();
          const containerRect = el.getBoundingClientRect();
          if (rect.top >= containerRect.top - 10 && rect.top <= containerRect.top + 80) {
            setActiveCategory(cat.id);
            break;
          }
        }
      }
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div
      role="dialog"
      aria-label="Emoji picker"
      className="responsive-composer-picker absolute bottom-[calc(3.5rem+env(safe-area-inset-bottom))] right-[max(0px,env(safe-area-inset-right))] z-50 flex h-[336px] max-h-[calc(100dvh-5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[368px] max-w-[calc(100vw-1rem-env(safe-area-inset-left)-env(safe-area-inset-right))] min-h-0 flex-col overflow-hidden rounded-r2 border border-white/10 bg-bg-0 shadow-[0_0_50px_rgba(0,0,0,0.8)] glass-card animate-in slide-in-from-bottom-2"
    >
      {/* Search */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-white/5 p-2.5">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/20" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search emojis..."
            className="compact-touch-target w-full rounded-full border border-white/5 bg-white/5 py-1.5 pl-7 pr-11 text-[10px] font-mono text-white placeholder-white/30 focus:border-primary/40 focus:outline-none focus-ring"
            autoFocus
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="compact-touch-target absolute right-0 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-full text-white/30 hover:text-white focus-ring">
              <X size={10} />
            </button>
          )}
        </div>

        {/* Skin tone selector */}
        <div className="relative flex-shrink-0">
          <button
            type="button"
            onClick={() => setToneMenuOpen(o => !o)}
            aria-label={`Default skin tone: ${SKIN_TONE_LABELS[skinTone]}`}
            aria-haspopup="true"
            aria-expanded={toneMenuOpen}
            title="Default skin tone"
            className="compact-touch-target h-6 w-6 rounded-full border border-white/15 transition-all hover:border-white/30 focus-ring"
            style={{ backgroundColor: SKIN_TONE_SWATCHES[skinTone] }}
          />
          {toneMenuOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 grid grid-cols-3 items-center gap-1 rounded-r2 border border-white/10 bg-bg-0 p-1 shadow-[0_0_30px_rgba(0,0,0,0.6)]">
              {SKIN_TONES.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => { setSkinTone(i); setToneMenuOpen(false); }}
                  aria-label={SKIN_TONE_LABELS[i]}
                  title={SKIN_TONE_LABELS[i]}
                  className={`compact-touch-target h-5 w-5 rounded-full transition-all focus-ring ${skinTone === i ? 'ring-2 ring-primary' : 'hover:scale-110'}`}
                  style={{ backgroundColor: SKIN_TONE_SWATCHES[i] }}
                />
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close emoji picker"
          className="compact-touch-target flex shrink-0 items-center justify-center rounded-full text-white/40 transition-colors hover:bg-white/5 hover:text-white focus-ring"
        >
          <X size={14} />
        </button>
      </div>

      {/* Category tabs */}
      {!search && (
        <div className="no-scrollbar flex shrink-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain border-b border-white/5 px-1.5 py-1">
          {recentEmojis.length > 0 && (
            <button
              type="button"
              onClick={() => scrollToCategory('recent')}
              aria-label="Recently Used"
              className={`compact-touch-target flex shrink-0 items-center justify-center rounded-md p-1.5 transition-all ${activeCategory === 'recent' ? 'bg-primary/15 text-primary' : 'text-white/30 hover:text-white/60 hover:bg-white/5'}`}
              title="Recently Used"
            >
              <Clock size={12} />
            </button>
          )}
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              type="button"
              onClick={() => scrollToCategory(cat.id)}
              aria-label={cat.name}
              className={`compact-touch-target flex shrink-0 items-center justify-center rounded-md p-1.5 transition-all ${activeCategory === cat.id ? 'bg-primary/15 text-primary' : 'text-white/30 hover:text-white/60 hover:bg-white/5'}`}
              title={cat.name}
            >
              {cat.icon}
            </button>
          ))}
        </div>
      )}

      {/* Emoji grid */}
      <div ref={contentRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5">
        {/* Recent */}
        {!search && recentEmojis.length > 0 && (
          <div ref={el => { categoryRefs.current['recent'] = el; }}>
            <div className="micro-label text-white/25 tracking-widest px-1 py-1 text-[8px]">RECENTLY USED</div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-0.5">
              {recentEmojis.map((e, i) => (
                <button type="button" key={`r-${i}`} onClick={() => handleSelect(e)} aria-label={e} className="compact-touch-target rounded-md p-1 text-center text-lg transition-colors hover:bg-white/10 focus-ring">
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        {filteredCategories.map(cat => (
          <div key={cat.id} ref={el => { categoryRefs.current[cat.id] = el; }}>
            <div className="micro-label text-white/25 tracking-widest px-1 py-1 text-[8px] sticky top-0 bg-bg-0/90 backdrop-blur-sm z-10">{cat.name}</div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-0.5">
              {cat.emojis.map((e, i) => {
                const display = applySkinTone(e, skinTone);
                return (
                  <button type="button" key={`${cat.id}-${i}`} onClick={() => handleSelect(e)} aria-label={display} className="compact-touch-target rounded-md p-1 text-center text-lg transition-colors hover:bg-white/10 focus-ring">
                    {display}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {filteredCategories.length === 0 && search && (
          <div className="flex flex-col items-center justify-center h-full text-white/20 py-10">
            <Search size={26} className="mb-2.5 opacity-40" />
            <p className="text-[10px] font-mono">NO EMOJIS FOUND</p>
          </div>
        )}
      </div>
    </div>
  );
};

function parseRecentStringArray(value: unknown, limit: number): string[] {
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
    if (parsed.length >= limit) {
      break;
    }
  }
  return parsed;
}
