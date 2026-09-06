export const MAX_MEDIA_PREVIEWS = 4;
export const MAX_PREVIEW_SCAN = 32_768;
export type MediaPreview = { kind: 'image' | 'link'; url: string } | { kind: 'video'; url: string; videoId: string };

function publicImageHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (!name || name === 'localhost' || /\.(?:localhost|local|internal)$/.test(name)) return false;
  // Treat every literal IPv6 address as a link, never an automatic image request.
  if (name.startsWith('[')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
    const [a, b] = name.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  return true;
}

/** Bounded and stateless: malicious message text cannot create unlimited embeds. */
export function extractMediaPreviews(content: string): MediaPreview[] {
  const text = content.slice(0, MAX_PREVIEW_SCAN);
  const matches = text.matchAll(/https?:\/\/[^\s<>"']+/gi);
  const result: MediaPreview[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const match of matches) {
    if (++scanned > 64 || result.length >= MAX_MEDIA_PREVIEWS) break;
    // Never turn the prefix of a truncated URL into a request to a different URL.
    if (content.length > text.length && match.index + match[0].length === text.length) break;
    const raw = match[0].replace(/[),.!?;\]}]+$/, '');
    if (raw.length > 4096) continue;
    let parsed: URL;
    try { parsed = new URL(raw); } catch { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
    const url = parsed.href;
    if (seen.has(url)) continue;
    seen.add(url);
    const host = parsed.hostname.toLowerCase();
    let videoId: string | null = null;
    if (host === 'youtu.be' || host === 'www.youtu.be') videoId = parsed.pathname.slice(1);
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
      videoId = parsed.pathname === '/watch' ? parsed.searchParams.get('v') : /^\/(?:shorts|embed)\/([^/]+)$/.exec(parsed.pathname)?.[1] ?? null;
    }
    if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      result.push({ kind: 'video', url, videoId });
    } else if (/\.(?:jpe?g|png|gif|webp|avif|bmp)$/i.test(parsed.pathname) && publicImageHost(host)) {
      result.push({ kind: 'image', url });
    } else result.push({ kind: 'link', url });
  }
  return result;
}

/** No executable document MIME types in same-origin blob previews. */
export function safePreviewMime(type: string): string {
  const mime = type.split(';', 1)[0].trim().toLowerCase();
  return /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/.test(mime) ? mime : 'application/octet-stream';
}
export function safeDownloadName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\]/g, '_').trim().slice(0, 180) || 'attachment';
}

/** Explicit ownership prevents late completions from leaking decrypted blob URLs. */
export function createObjectUrlLease(api: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL) {
  let active = true;
  let generation = 0;
  let pending: number | null = null;
  let url: string | null = null;
  const release = () => {
    generation++;
    pending = null;
    if (url) api.revokeObjectURL(url);
    url = null;
  };
  return {
    activate() { active = true; },
    begin(): number | null {
      if (!active || pending !== null) return null;
      pending = ++generation;
      return pending;
    },
    isCurrent(token: number): boolean { return active && pending === token; },
    complete(token: number, blob: Blob): string | null {
      if (!active || token !== pending) return null;
      const next = api.createObjectURL(blob);
      if (url) api.revokeObjectURL(url);
      url = next;
      pending = null;
      return next;
    },
    fail(token: number): boolean {
      if (!active || token !== pending) return false;
      pending = null;
      return true;
    },
    release,
    dispose() { active = false; release(); },
  };
}
