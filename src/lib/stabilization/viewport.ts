/** VisualViewport accounts for keyboards that do not resize 100dvh (notably iOS). */
export function installVisualViewport(win: Window): () => void {
  const style = win.document.documentElement.style;
  const properties = ['--harmolyn-viewport-height', '--harmolyn-viewport-top'] as const;
  const original = properties.map(name => [style.getPropertyValue(name), style.getPropertyPriority(name)] as const);
  const written = new Map<string, string>();
  const viewport = win.visualViewport;
  let frame: number | null = null;
  let disposed = false;
  const update = () => {
    frame = null;
    if (disposed) return;
    // Do not reflow the app while the user is magnifying it with pinch zoom.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const height = viewport?.height ?? win.innerHeight;
    const top = viewport?.offsetTop ?? 0;
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(top)) return;
    [Math.round(height * 100) / 100, Math.max(0, Math.round(top * 100) / 100)].forEach((value, index) => {
      const css = `${value}px`;
      if (written.get(properties[index]) !== css) {
        style.setProperty(properties[index], css);
        written.set(properties[index], css);
      }
    });
  };
  const schedule = () => { if (!disposed && frame === null) frame = win.requestAnimationFrame(update); };
  update();
  win.addEventListener('resize', schedule, { passive: true });
  win.addEventListener('orientationchange', schedule, { passive: true });
  viewport?.addEventListener('resize', schedule, { passive: true });
  viewport?.addEventListener('scroll', schedule, { passive: true });
  return () => {
    disposed = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    win.removeEventListener('resize', schedule);
    win.removeEventListener('orientationchange', schedule);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    properties.forEach((name, index) => {
      if (style.getPropertyValue(name) !== written.get(name)) return;
      const [value, priority] = original[index];
      if (value) style.setProperty(name, value, priority); else style.removeProperty(name);
    });
  };
}
