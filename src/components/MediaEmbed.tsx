
import React, { useState } from 'react';
import { ExternalLink, Play, X, Image as ImageIcon, Link2 } from 'lucide-react';
import { resolvePreviewImageSrc } from '@/lib/media';
import { safeParseUrl } from '@/lib/browserLocation';
import { usePrivacyPreferences } from '@/hooks/usePrivacyPreferences';
import { useEscapeKey } from '@/hooks/useEscapeKey';

// Shown in place of a remote-loading embed when auto-load is off, so nothing is
// fetched from the remote host until the reader explicitly opts in per item.
const MediaPlaceholder: React.FC<{ kind: 'image' | 'video'; onReveal: () => void }> = ({ kind, onReveal }) => (
  <div className="mt-3 max-w-[400px]">
    <button
      type="button"
      onClick={onReveal}
      className="w-full flex items-center gap-3 glass-card rounded-r1 border border-white/8 px-4 py-3 text-left hover:border-primary/20 transition-all group"
    >
      <span className="w-9 h-9 rounded-r1 bg-white/5 border border-white/10 flex items-center justify-center text-white/40 group-hover:text-primary shrink-0">
        {kind === 'video' ? <Play size={16} /> : <ImageIcon size={16} />}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-bold text-white/70">{kind === 'video' ? 'Video preview hidden' : 'Image preview hidden'}</span>
        <span className="block text-[10px] text-white/35">Tap to load from the remote host · auto-load is off in Privacy settings</span>
      </span>
    </button>
  </div>
);

// Detect image URLs in message content. Use a stateless matcher for single-URL checks
// so one render cannot leak regex cursor state into the next.
const IMAGE_MATCH_REGEX = /(https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|avif|bmp)(?:\?[^\s]*)?)/gi;
const IMAGE_URL_REGEX = /(https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|avif|bmp)(?:\?[^\s]*)?)/i;
// Detect YouTube URLs
const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
// Detect general URLs (excluding images)
const URL_REGEX = /([Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s<]+)/g;

interface MediaEmbedProps {
  content: string;
}

// Lightbox component
const Lightbox: React.FC<{ src: string; onClose: () => void }> = ({ src, onClose }) => {
  const safeSrc = resolvePreviewImageSrc(src);
  useEscapeKey(onClose);

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/90 backdrop-blur-sm flex items-center justify-center animate-in fade-in duration-200 cursor-pointer"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
    >
      <button
        className="absolute top-6 right-6 w-12 h-12 rounded-full border border-white/10 glass-panel flex items-center justify-center hover:border-primary hover:shadow-glow transition-all z-10 focus-ring"
        onClick={onClose}
        aria-label="Close image preview"
      >
        <X size={24} className="text-white" />
      </button>
      {safeSrc ? (
        <img referrerPolicy="no-referrer" 
          src={safeSrc} 
          className="max-w-[90vw] max-h-[90vh] object-contain rounded-r2 shadow-2xl"
          alt="Full size" 
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="glass-card rounded-r2 border border-white/10 px-6 py-5 text-sm text-white/70 max-w-md">
          This image source cannot be previewed safely.
        </div>
      )}
    </div>
  );
};

// Image thumbnail
const ImageEmbed: React.FC<{ url: string; allowRemote: boolean }> = ({ url, allowRemote }) => {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [error, setError] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const safeUrl = resolvePreviewImageSrc(url);

  if (error || !safeUrl) return null;
  if (!allowRemote && !revealed) {
    return <MediaPlaceholder kind="image" onReveal={() => setRevealed(true)} />;
  }

  return (
    <>
      <div className="mt-3 max-w-[400px] group cursor-pointer" onClick={() => setLightboxOpen(true)}>
        <div className="relative rounded-r1 overflow-hidden border border-white/10 shadow-lg hover:border-primary/30 transition-all">
          <img data-context-image referrerPolicy="no-referrer"
            src={safeUrl}
            alt="Embedded image"
            className="w-full max-h-[300px] object-cover group-hover:brightness-110 transition-all"
            onError={() => setError(true)}
            loading="lazy"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="px-2 py-1 rounded-full glass-panel border border-white/10 text-[9px] text-white/70 font-mono flex items-center gap-1">
              <ImageIcon size={10} /> EXPAND
            </div>
          </div>
        </div>
      </div>
      {lightboxOpen && <Lightbox src={safeUrl} onClose={() => setLightboxOpen(false)} />}
    </>
  );
};

// YouTube embed
const YouTubeEmbed: React.FC<{ videoId: string; allowRemote: boolean }> = ({ videoId, allowRemote }) => {
  const [playing, setPlaying] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const thumbUrl = `https://img.youtube-nocookie.com/vi/${videoId}/hqdefault.jpg`;

  if (!allowRemote && !revealed) {
    return <MediaPlaceholder kind="video" onReveal={() => setRevealed(true)} />;
  }

  return (
    <div className="mt-3 max-w-[440px]">
      <div className="glass-card rounded-r2 border border-white/10 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
          <div className="w-3 h-3 rounded-full bg-accent-danger" />
          <span className="text-[10px] font-mono text-white/30 tracking-wider">YOUTUBE // VIDEO</span>
        </div>
        {playing ? (
          <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
            <iframe
              className="absolute inset-0 w-full h-full"
              src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`}
              allow="autoplay; encrypted-media"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              title="YouTube video"
            />
          </div>
        ) : (
          <div className="relative cursor-pointer group" onClick={() => setPlaying(true)}>
            <img referrerPolicy="no-referrer" src={thumbUrl} className="w-full aspect-video object-cover group-hover:brightness-75 transition-all" alt="Video thumbnail" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-16 h-16 rounded-full glass-panel border border-white/20 flex items-center justify-center group-hover:border-primary group-hover:shadow-glow transition-all">
                <Play size={28} className="text-white ml-1 group-hover:text-primary" fill="currentColor" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Link card fallback for URLs when we don't have fetched metadata.
const LinkCard: React.FC<{ url: string }> = ({ url }) => {
  const parsed = safeParseUrl(url);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return null;
  }
  const href = parsed.toString();
  const domain = parsed.hostname;

  // Skip image/video URLs — those get their own embeds
  if (IMAGE_URL_REGEX.test(url) || YOUTUBE_REGEX.test(url)) return null;

  return (
    <div className="mt-3 max-w-[400px]">
      <a href={href} target="_blank" rel="noopener noreferrer" className="block glass-card rounded-r1 border border-white/8 overflow-hidden hover:border-primary/20 transition-all group">
        <div className="border-l-[3px] border-primary px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <Link2 size={12} className="text-primary shrink-0" />
            <span className="text-[10px] font-mono text-white/30 truncate">{domain}</span>
            <ExternalLink size={10} className="text-white/20 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
          </div>
          <div className="text-sm text-primary font-bold truncate group-hover:underline">{url}</div>
        </div>
      </a>
    </div>
  );
};

/**
 * Renders media embeds (images, YouTube, link cards) detected in message content.
 * Place this below the message text content.
 */
export const MediaEmbed: React.FC<MediaEmbedProps> = ({ content }) => {
  const [privacy] = usePrivacyPreferences();
  const allowRemote = privacy.loadRemoteMedia;
  const embeds: React.ReactNode[] = [];

  // Find images
  const imageMatches = [...content.matchAll(new RegExp(IMAGE_MATCH_REGEX.source, "gi"))];
  const seenUrls = new Set<string>();

  imageMatches.forEach((match, i) => {
    if (!seenUrls.has(match[1])) {
      seenUrls.add(match[1]);
      embeds.push(<ImageEmbed key={`img-${i}`} url={match[1]} allowRemote={allowRemote} />);
    }
  });

  // Find YouTube
  const ytMatch = content.match(YOUTUBE_REGEX);
  if (ytMatch) {
    embeds.push(<YouTubeEmbed key="yt" videoId={ytMatch[1]} allowRemote={allowRemote} />);
  }

  // Find other URLs for link cards
  const urlMatches = [...content.matchAll(new RegExp(URL_REGEX.source, "g"))];
  urlMatches.forEach((match, i) => {
    const url = match[1];
    if (!seenUrls.has(url) && !YOUTUBE_REGEX.test(url)) {
      if (!IMAGE_URL_REGEX.test(url)) {
        seenUrls.add(url);
        embeds.push(<LinkCard key={`link-${i}`} url={url} />);
      }
    }
  });

  if (embeds.length === 0) return null;
  return <div className="space-y-2">{embeds}</div>;

};
