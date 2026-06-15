import { useRef, useEffect, useCallback, type RefObject } from 'react';

interface SwipeConfig {
  /** Minimum distance in px to count as a swipe (default 50) */
  threshold?: number;
  /** Maximum vertical deviation before cancelling (default 100) */
  maxVertical?: number;
  /** Edge zone width in px — only trigger if touch starts within this zone (0 = anywhere) */
  edgeZone?: number;
  /** Which edge: 'left' | 'right' */
  edge?: 'left' | 'right';
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  /** Whether the gesture is currently enabled */
  enabled?: boolean;
}

export function useSwipeGesture(
  ref: RefObject<HTMLElement | null>,
  config: SwipeConfig
) {
  const {
    threshold = 50,
    maxVertical = 100,
    edgeZone = 0,
    edge,
    onSwipeLeft,
    onSwipeRight,
    enabled = true,
  } = config;

  const startX = useRef(0);
  const startY = useRef(0);
  const tracking = useRef(false);

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      if (!enabled) return;
      const touch = e.touches[0];

      // Edge zone filter
      if (edgeZone > 0 && edge) {
        const rect = (ref.current as HTMLElement).getBoundingClientRect();
        if (edge === 'left' && touch.clientX - rect.left > edgeZone) return;
        if (edge === 'right' && rect.right - touch.clientX > edgeZone) return;
      }

      startX.current = touch.clientX;
      startY.current = touch.clientY;
      tracking.current = true;
    },
    [enabled, edgeZone, edge, ref]
  );

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      if (!tracking.current) return;
      tracking.current = false;

      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX.current;
      const dy = Math.abs(touch.clientY - startY.current);

      if (dy > maxVertical) return;
      if (Math.abs(dx) < threshold) return;

      if (dx > 0) onSwipeRight?.();
      else onSwipeLeft?.();
    },
    [threshold, maxVertical, onSwipeLeft, onSwipeRight]
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [ref, enabled, handleTouchStart, handleTouchEnd]);
}
