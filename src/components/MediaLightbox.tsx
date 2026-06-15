import React, { useState } from 'react';
import { X, ZoomIn, ZoomOut } from 'lucide-react';
import { resolvePreviewImageSrc } from '@/lib/media';
import { useEscapeKey } from '@/hooks/useEscapeKey';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

const clampZoom = (z: number) => Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);

interface MediaLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export const MediaLightbox: React.FC<MediaLightboxProps> = ({ src, alt = 'Image', onClose }) => {
  const [zoom, setZoom] = useState(1);
  const safeSrc = resolvePreviewImageSrc(src);

  useEscapeKey(onClose);

  const zoomIn = () => setZoom(z => clampZoom(z + 0.25));
  const zoomOut = () => setZoom(z => clampZoom(z - 0.25));

  // Scroll-to-zoom: wheel up zooms in, wheel down zooms out (matches the hint text).
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.25 : -0.25;
    setZoom(z => clampZoom(z + step));
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center"
      onClick={onClose}
      onWheel={handleWheel}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <div className="absolute inset-0 bg-black/90 backdrop-blur-md" />

      {/* Controls */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <button aria-label="Zoom out" onClick={(e) => { e.stopPropagation(); zoomOut(); }} className="p-2 glass-card rounded-full text-white/60 hover:text-white transition-colors border border-white/10 focus-ring">
          <ZoomOut size={18} />
        </button>
        <span className="text-white/40 text-xs font-mono min-w-[40px] text-center">{Math.round(zoom * 100)}%</span>
        <button aria-label="Zoom in" onClick={(e) => { e.stopPropagation(); zoomIn(); }} className="p-2 glass-card rounded-full text-white/60 hover:text-white transition-colors border border-white/10 focus-ring">
          <ZoomIn size={18} />
        </button>
        <button aria-label="Close" onClick={onClose} className="p-2 glass-card rounded-full text-white/60 hover:text-white transition-colors border border-white/10 ml-2 focus-ring">
          <X size={18} />
        </button>
      </div>

      {/* Image */}
      <div
        className="relative max-w-[90vw] max-h-[85vh] overflow-auto no-scrollbar cursor-move"
        onClick={e => e.stopPropagation()}
      >
        {safeSrc ? (
          <img
            data-context-image
            src={safeSrc}
            alt={alt}
            referrerPolicy="no-referrer"
            className="transition-transform duration-200 rounded-r1"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
            draggable={false}
          />
        ) : (
          <div className="glass-card rounded-r2 border border-white/10 px-6 py-5 text-sm text-white/70 max-w-md">
            This image source cannot be previewed safely.
          </div>
        )}
      </div>

      {/* Bottom hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[9px] text-white/20 font-mono">
        CLICK OUTSIDE TO CLOSE // SCROLL TO ZOOM
      </div>
    </div>
  );
};
