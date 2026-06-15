import { CSSProperties } from 'react';

export const generateTheme = (seedString: string) => {
  let seed = 0;
  for (let i = 0; i < seedString.length; i++) {
    seed = ((seed << 5) - seed) + seedString.charCodeAt(i);
    seed |= 0;
  }
  const random = () => {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randInt = (min: number, max: number) => Math.floor(random() * (max - min + 1)) + min;

  const isDark = random() > 0.3;

  const hue = randInt(0, 360);
  const sat = randInt(10, 50); 
  const lit = isDark ? randInt(5, 15) : randInt(85, 95);

  const bgBase = `hsl(${hue}, ${sat}%, ${lit}%)`;
  const bgGradient = `hsl(${(hue + randInt(30, 60)) % 360}, ${sat}%, ${isDark ? lit + 10 : lit - 10}%)`;

  const patternType = randInt(0, 3);
  let background = '';

  if (patternType === 0) {
      const angle = randInt(0, 360);
      background = `linear-gradient(${angle}deg, ${bgBase}, ${bgGradient})`;
  } else if (patternType === 1) {
      background = `radial-gradient(circle at ${randInt(0, 100)}% ${randInt(0, 100)}%, ${bgGradient}, ${bgBase})`;
  } else if (patternType === 2) {
      const c3 = `hsl(${(hue + 180) % 360}, ${sat}%, ${lit}%)`;
      background = `
          radial-gradient(at ${randInt(0,100)}% ${randInt(0,100)}%, ${bgGradient} 0px, transparent 50%),
          radial-gradient(at ${randInt(0,100)}% ${randInt(0,100)}%, ${c3} 0px, transparent 50%),
          ${bgBase}
      `;
  } else {
      background = `conic-gradient(from ${randInt(0,360)}deg at 50% 50%, ${bgBase}, ${bgGradient}, ${bgBase})`;
  }

  const textPrimary = isDark ? '#F6F8F8' : '#1a1a1a';
  const textSecondary = isDark ? 'rgba(246,248,248,0.7)' : 'rgba(0,0,0,0.7)';
  const textDim = isDark ? 'rgba(246,248,248,0.4)' : 'rgba(0,0,0,0.4)';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)';
  
  const glassBg = isDark ? 'rgba(16, 25, 27, 0.65)' : 'rgba(255, 255, 255, 0.65)';
  const glassBorder = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';

  return {
    background,
    isDark,
    themeVars: {
        '--theme-text': textPrimary,
        '--theme-text-secondary': textSecondary,
        '--theme-text-dim': textDim,
        '--theme-border': border,
        '--theme-glass-bg': glassBg,
        '--theme-glass-border': glassBorder,
        '--theme-bg-image': background,
    } as CSSProperties
  };
};
