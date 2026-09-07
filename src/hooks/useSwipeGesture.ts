import { useRef, useEffect, useLayoutEffect, type RefObject } from 'react';
import { bindSwipeGesture, type SwipeConfig } from '@/lib/stabilization/interaction';

export function useSwipeGesture(ref: RefObject<HTMLElement | null>, config: SwipeConfig): void {
  const latest = useRef(config);
  useLayoutEffect(() => { latest.current = config; }, [config]);
  const enabled = config.enabled !== false;
  useEffect(() => {
    if (!ref.current || !enabled) return;
    return bindSwipeGesture(ref.current, () => latest.current);
  }, [ref, enabled]);
}
