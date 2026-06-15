import { useEffect } from 'react';

/**
 * Invokes `onEscape` when the Escape key is pressed while `enabled` is true.
 *
 * Shared overlay/modal affordance: pairs with the click-outside handlers that
 * most overlays already implement so keyboard users get the same "dismiss"
 * escape hatch as mouse users. Registers a single document-level `keydown`
 * listener and cleans it up on unmount or when disabled.
 */
export function useEscapeKey(onEscape: () => void, enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onEscape();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onEscape, enabled]);
}
