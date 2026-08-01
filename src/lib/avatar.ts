const MAX_LOCAL_AVATAR_DATA_URI_LENGTH = 512 * 1024;
const LOCAL_RASTER_AVATAR_REGEX = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/i;

export function resolveAvatarSrc(source: unknown, fallbackLabel: unknown): string {
  const trimmed = typeof source === 'string' ? source.trim() : '';
  if (trimmed && isSafeAvatarSource(trimmed)) {
    return trimmed;
  }
  return buildFallbackAvatarDataUri(fallbackLabel);
}

export function isSafeAvatarSource(value: string): boolean {
  // Avatars are peer-controlled profile data. Never turn one into a browser
  // network request: that would disclose the viewer's IP, timing, and page
  // context to an arbitrary peer-selected host. Only the bounded, local raster
  // data URI produced by the file picker is renderable.
  return value.length <= MAX_LOCAL_AVATAR_DATA_URI_LENGTH && LOCAL_RASTER_AVATAR_REGEX.test(value);
}

function buildFallbackAvatarDataUri(label: unknown): string {
  const normalized = typeof label === 'string' ? label.trim() : '';
  const safeLabel = normalized || '?';
  const initials = normalized
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';
  const background = colorForSeed(safeLabel);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="${background}"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#05070D" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="700">${escapeSvgText(initials)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function colorForSeed(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 72% 58%)`;
}

function escapeSvgText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return char;
    }
  });
}
