import React, { useMemo, useState } from 'react';
import { ExternalLink, Play, Image as ImageIcon, Link2, X } from 'lucide-react';
import { usePrivacyPreferences } from '@/hooks/usePrivacyPreferences';
import { extractMediaPreviews, type MediaPreview } from '@/lib/stabilization/previews';
import { MediaLightbox } from '@/components/MediaLightbox';

function RemotePreview({ preview, allowRemote }: { preview: Exclude<MediaPreview, { kind: 'link' }>; allowRemote: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const host = new URL(preview.url).hostname;
  const video = preview.kind === 'video';
  const loaded = allowRemote || revealed;
  if (!loaded) return (
    <button type="button" onClick={() => setRevealed(true)} className="remote-preview-placeholder">
      {video ? <Play size={20} aria-hidden="true" /> : <ImageIcon size={20} aria-hidden="true" />}
      <span className="min-w-0"><span className="block text-sm font-semibold">{video ? 'Load video preview' : 'Load image preview'}</span>
        <span className="block break-words text-xs text-white/65">{video ? 'YouTube' : host} will receive your IP address when loaded.</span></span>
    </button>
  );
  return (
    <div className="remote-preview-card">
      <div className="flex min-w-0 items-center gap-2 px-3 py-1">
        <span className="min-w-0 flex-1 truncate text-xs text-white/65">{video ? 'YouTube' : host}</span>
        {!allowRemote && <button type="button" aria-label="Hide remote preview" className="touch-target rounded-lg text-white/70 focus-ring" onClick={() => { setRevealed(false); setPlaying(false); setExpanded(false); }}><X size={18} /></button>}
      </div>
      {video ? playing ? (
        <iframe className="aspect-video w-full border-0" src={`https://www.youtube-nocookie.com/embed/${preview.videoId}?autoplay=1`}
          allow="autoplay; encrypted-media; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" title="YouTube video" />
      ) : (
        <button type="button" className="relative block aspect-video w-full bg-black focus-ring" onClick={() => setPlaying(true)} aria-label="Play YouTube video">
          {!failed && <img src={`https://i.ytimg.com/vi/${preview.videoId}/hqdefault.jpg`} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-cover" />}
          <span className="absolute inset-0 flex items-center justify-center"><span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/75 text-white"><Play size={26} /></span></span>
        </button>
      ) : failed ? (
        <div className="p-4 text-sm text-white/75" role="status">Image unavailable. <a href={preview.url} target="_blank" rel="noopener noreferrer" className="text-primary underline">Open original</a></div>
      ) : (
        <button type="button" className="block aspect-[4/3] max-h-72 w-full bg-black focus-ring" onClick={() => setExpanded(true)} aria-label="Expand image preview">
          <img data-context-image src={preview.url} alt="Message image preview" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-contain" />
        </button>
      )}
      {!video && expanded && <MediaLightbox src={preview.url} alt="Message image preview" onClose={() => setExpanded(false)} />}
    </div>
  );
}

/** Resource identity, not list position, owns per-item consent and playback state. */
export const MediaEmbed: React.FC<{ content: string }> = React.memo(function MediaEmbed({ content }) {
  const [privacy] = usePrivacyPreferences();
  const previews = useMemo(() => extractMediaPreviews(content), [content]);
  if (!previews.length) return null;
  return <div className="message-previews mt-3 space-y-2">
    {previews.map(preview => preview.kind === 'link' ? (
      <a key={preview.url} href={preview.url} target="_blank" rel="noopener noreferrer" className="remote-preview-link">
        <Link2 size={16} aria-hidden="true" className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1"><span className="block truncate text-xs text-white/65">{new URL(preview.url).hostname}</span><span className="block truncate text-sm text-primary">{preview.url}</span></span>
        <ExternalLink size={16} aria-hidden="true" className="shrink-0 text-white/65" />
      </a>
    ) : <RemotePreview key={`${preview.kind}:${preview.url}:${privacy.loadRemoteMedia}`} preview={preview} allowRemote={privacy.loadRemoteMedia} />)}
  </div>;
});
