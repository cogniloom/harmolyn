import { useEffect, useLayoutEffect, useRef } from 'react';
import { registerEscapeHandler } from '@/lib/stabilization/interaction';

/** Stable registrations keep a rerendered parent from stealing its child's Escape. */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
  const callback = useRef(onEscape);
  useLayoutEffect(() => { callback.current = onEscape; }, [onEscape]);
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    return registerEscapeHandler(document, () => callback.current());
  }, [enabled]);
}
