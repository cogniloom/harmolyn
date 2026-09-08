export interface SwipeConfig {
  threshold?: number;
  maxVertical?: number;
  edgeZone?: number;
  edge?: 'left' | 'right';
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  enabled?: boolean;
}

/** Passive, single-touch navigation. Scrolling, selection and pinch zoom win. */
export function bindSwipeGesture(element: HTMLElement, readConfig: () => SwipeConfig): () => void {
  let start: { id: number; x: number; y: number; time: number } | null = null;
  const cancel = () => { start = null; };
  const onStart = (event: TouchEvent) => {
    cancel();
    const config = readConfig();
    if (config.enabled === false || event.touches.length !== 1 || event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="dialog"], [data-no-swipe], video, audio, pre')) return;
    if (element.ownerDocument.getSelection()?.toString()) return;
    for (let parent = target; parent && parent !== element; parent = parent.parentElement) {
      if (parent instanceof HTMLElement && parent.scrollWidth > parent.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(parent).overflowX)) return;
    }
    const touch = event.touches[0];
    const rect = element.getBoundingClientRect();
    const zone = config.edgeZone ?? 0;
    if (zone > 0 && config.edge === 'left' && (touch.clientX < rect.left || touch.clientX - rect.left > zone)) return;
    if (zone > 0 && config.edge === 'right' && (touch.clientX > rect.right || rect.right - touch.clientX > zone)) return;
    start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp };
  };
  const onMove = (event: TouchEvent) => {
    if (!start) return;
    if (event.touches.length !== 1) { cancel(); return; }
    const touch = event.touches[0];
    const dx = Math.abs(touch.clientX - start.x);
    const dy = Math.abs(touch.clientY - start.y);
    if (touch.identifier !== start.id || dy > (readConfig().maxVertical ?? 100) || (dy > 12 && dy >= dx)) cancel();
  };
  const onEnd = (event: TouchEvent) => {
    const origin = start;
    cancel();
    const config = readConfig();
    if (!origin || config.enabled === false || event.defaultPrevented || event.touches.length || event.timeStamp - origin.time > 700) return;
    const touch = Array.from(event.changedTouches).find(item => item.identifier === origin.id);
    if (!touch) return;
    const dx = touch.clientX - origin.x;
    const dy = Math.abs(touch.clientY - origin.y);
    if (dy > (config.maxVertical ?? 100) || Math.abs(dx) < (config.threshold ?? 50) || Math.abs(dx) < dy * 1.5) return;
    if (dx > 0) config.onSwipeRight?.(); else config.onSwipeLeft?.();
  };
  element.addEventListener('touchstart', onStart, { passive: true });
  element.addEventListener('touchmove', onMove, { passive: true });
  element.addEventListener('touchend', onEnd, { passive: true });
  element.addEventListener('touchcancel', cancel, { passive: true });
  return () => {
    cancel();
    element.removeEventListener('touchstart', onStart);
    element.removeEventListener('touchmove', onMove);
    element.removeEventListener('touchend', onEnd);
    element.removeEventListener('touchcancel', cancel);
  };
}
