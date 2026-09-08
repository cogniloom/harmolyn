import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { resolvePreviewImageSrc } from '@/lib/media';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { trapDialogFocus } from '@/lib/stabilization/interaction';

interface MediaLightboxProps { src: string; alt?: string; onClose: () => void }

export const MediaLightbox: React.FC<MediaLightboxProps> = ({ src, alt = 'Image', onClose }) => {
  const [view, setView] = useState({ src, zoom: 1, failed: false });
  const zoom = view.src === src ? view.zoom : 1;
  const failed = view.src === src && view.failed;
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const backdropPress = useRef(false);
  const safeSrc = resolvePreviewImageSrc(src);
  useEscapeKey(onClose);
  useEffect(() => root.current ? trapDialogFocus(root.current) : undefined, []);
  const changeZoom = (delta: number) => setView(current => ({ src, failed: current.src === src && current.failed, zoom: Math.min(3, Math.max(0.5, (current.src === src ? current.zoom : 1) + delta)) }));
  // Native listener can prevent wheel scrolling when zooming; React's wheel listener may be passive.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return; // Ordinary scrolling pans a magnified image.
      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.25 : -0.25;
      setView(current => ({ src, failed: current.src === src && current.failed, zoom: Math.min(3, Math.max(0.5, (current.src === src ? current.zoom : 1) + delta)) }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [src]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={root} className="harmolyn-visible-viewport media-lightbox appearance-media-island" role="dialog" aria-modal="true" aria-label={alt || 'Image preview'}
      onPointerDown={event => { backdropPress.current = event.target === event.currentTarget; }}
      onClick={event => { if (event.target === event.currentTarget && backdropPress.current) onClose(); backdropPress.current = false; }}>
      <div className="media-lightbox-toolbar">
        <button type="button" aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => changeZoom(-0.25)}><ZoomOut size={20} /></button>
        <span aria-live="polite" className="min-w-12 text-center text-sm tabular-nums">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => changeZoom(0.25)}><ZoomIn size={20} /></button>
        <button type="button" aria-label="Reset zoom" onClick={() => setView({ src, zoom: 1, failed })}><RotateCcw size={20} /></button>
        <button type="button" aria-label="Close image preview" onClick={onClose}><X size={22} /></button>
      </div>
      <div ref={scroller} className="media-lightbox-content">
        {safeSrc && !failed ? (
          <div style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, marginInline: 'auto' }}>
          <img data-context-image src={safeSrc} alt={alt} referrerPolicy="no-referrer" draggable={false} decoding="async"
            onError={() => setView({ src, zoom, failed: true })}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
        ) : <p role="status" className="p-6 text-sm text-white/80">This image cannot be displayed safely. Close the preview to return to the conversation.</p>}
      </div>
      <p className="media-lightbox-hint">Use the zoom controls, or Ctrl/⌘ + scroll. Escape closes the preview.</p>
    </div>, document.body,
  );
};
