import React from 'react';

export const Spoiler: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [revealed, setRevealed] = React.useState(false);

  const toggle = () => setRevealed(v => !v);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    // Enter/Space toggle the spoiler, matching the click behavior so keyboard
    // users can both reveal and re-hide it (privacy in public spaces).
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={revealed}
      aria-label={revealed ? 'Hide spoiler' : 'Reveal spoiler'}
      onClick={toggle}
      onKeyDown={handleKeyDown}
      className={`rounded px-1 py-0.5 cursor-pointer transition-all duration-300 inline focus-ring ${
        revealed
          ? 'bg-white/10 text-white/90'
          : 'bg-white/10 text-transparent select-none hover:bg-white/15'
      }`}
      title={revealed ? 'Click to hide spoiler' : 'Click to reveal spoiler'}
    >
      {children}
    </span>
  );
};
