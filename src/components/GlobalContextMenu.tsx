import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Copy, ExternalLink, Clipboard, Search, Eye, RotateCcw, Link2 } from 'lucide-react';
import { ContextMenuContext, type ContextMenuSection, type ContextMenuState } from '@/components/GlobalContextMenuContext';
import { ALLOWED_EXTERNAL_SCHEMES, ALLOWED_IMAGE_SCHEMES, copyTextToClipboardSafely, openUrlSafely, safeConfirm, safeGetSelectedText, safeReloadPage } from '@/components/contextMenuUtils';
import { safeViewportSize } from '@/lib/browserViewport';

// ─── Detect what's under the cursor ──────────────────────────

function findAnchorHref(target: HTMLElement): string | null {
  const anchor = target.closest('a');
  return anchor?.href || null;
}

function findImageSrc(target: HTMLElement): string | null {
  // Scope UPWARD (like findAnchorHref) and only treat genuine content images —
  // chat attachments, inline embeds, the lightbox — as image targets. Avatars and
  // decorative <img>s are deliberately NOT tagged, so right-clicking them (or any
  // region that merely *contains* an avatar) no longer offers "Open/Copy Image".
  const img = target instanceof HTMLImageElement ? target : target.closest('img');
  if (!(img instanceof HTMLImageElement)) return null;
  if (!img.closest('[data-context-image]')) return null;
  return img.src || null;
}

/** Build default context items based on what's under the cursor */
function buildDefaultItems(target: HTMLElement): ContextMenuSection[] {
  const sections: ContextMenuSection[] = [];
  const selectedText = safeGetSelectedText();
  const href = findAnchorHref(target);
  const imgSrc = findImageSrc(target);

  // Text selection section
  if (selectedText) {
    sections.push({
      items: [
        {
          label: 'Copy Text',
          icon: <Copy size={13} />,
          onClick: () => { void copyTextToClipboardSafely(selectedText); },
        },
        {
          label: 'Search for Text',
          icon: <Search size={13} />,
          onClick: () => {
            if (safeConfirm('This will send selected text to an external search engine. Continue?')) {
              openUrlSafely(`https://duckduckgo.com/?q=${encodeURIComponent(selectedText)}`, ALLOWED_EXTERNAL_SCHEMES);
            }
          },
        },
      ],
    });
  }

  // Link section
  if (href) {
    sections.push({
      items: [
        {
          label: 'Open Link',
          icon: <ExternalLink size={13} />,
          onClick: () => openUrlSafely(href, ALLOWED_EXTERNAL_SCHEMES),
        },
        {
          label: 'Copy Link',
          icon: <Link2 size={13} />,
          onClick: () => { void copyTextToClipboardSafely(href); },
        },
      ],
    });
  }

  // Image section
  if (imgSrc) {
    sections.push({
      items: [
        {
          label: 'Open Image',
          icon: <Eye size={13} />,
          onClick: () => openUrlSafely(imgSrc, ALLOWED_IMAGE_SCHEMES),
        },
        {
          label: 'Copy Image URL',
          icon: <Clipboard size={13} />,
          onClick: () => { void copyTextToClipboardSafely(imgSrc); },
        },
      ],
    });
  }

  // Always-present general section
  sections.push({
    items: [
      {
        label: 'Reload',
        icon: <RotateCcw size={13} />,
        onClick: () => { void safeReloadPage(); },
      },
    ],
  });

  return sections;
}

// ─── Provider ────────────────────────────────────────────────

export const ContextMenuProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const showMenu = useCallback((x: number, y: number, sections: ContextMenuSection[]) => {
    // Clamp to viewport so menu doesn't overflow offscreen
    const menuW = 200;
    const menuH = sections.reduce((h, s) => h + s.items.length * 44 + 9, 8);
    const viewport = safeViewportSize();
    const renderedMenuW = viewport.width === null ? menuW : Math.min(menuW, Math.max(0, viewport.width - 8));
    const renderedMenuH = viewport.height === null ? menuH : Math.min(menuH, Math.max(0, viewport.height - 8));
    const clampedX = viewport.width === null ? x : Math.min(x, viewport.width - renderedMenuW - 4);
    const clampedY = viewport.height === null ? y : Math.min(y, viewport.height - renderedMenuH - 4);
    setMenu({ x: Math.max(4, clampedX), y: Math.max(4, clampedY), sections });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  // Close on click anywhere or Escape
  useEffect(() => {
    if (!menu) return;
    const handleClick = () => closeMenu();
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    const handleScroll = (event: Event) => {
      // The menu itself can scroll on short viewports. Only outside scrolling
      // should dismiss it.
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      closeMenu();
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [menu, closeMenu]);

  // Global contextmenu handler — suppress native and show custom
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      const target = e.target as HTMLElement;

      // Check if a component already handled this via data attribute
      if ((e as Event & { __customContextHandled?: boolean }).__customContextHandled) return;

      // Build default items from DOM context
      const sections = buildDefaultItems(target);
      showMenu(e.clientX, e.clientY, sections);
    };

    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, [showMenu]);

  return (
    <ContextMenuContext.Provider value={{ showMenu, closeMenu }}>
      {children}
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Context menu"
          className="fixed z-[200] max-h-[calc(100dvh-0.5rem)] w-[min(200px,calc(100vw-0.5rem))] overflow-x-hidden overflow-y-auto overscroll-contain rounded-r2 glass-card shadow-2xl animate-in fade-in zoom-in-95 duration-100"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-1">
            {menu.sections.map((section, si) => (
              <React.Fragment key={si}>
                {si > 0 && <div className="h-[1px] bg-white/5 my-1" />}
                {section.items.map((item, ii) => (
                  <button
                    key={ii}
                    role="menuitem"
                    onClick={() => { if (!item.disabled) { item.onClick(); closeMenu(); } }}
                    disabled={item.disabled}
                    className={`touch-target flex w-full items-center gap-2 rounded-r1 px-3 py-2 text-left text-[12px] transition-colors ${
                      item.danger
                        ? 'text-accent-danger hover:bg-accent-danger/15'
                        : item.disabled
                        ? 'text-white/20 cursor-not-allowed'
                        : 'text-white/80 hover:bg-white/8 hover:text-white'
                    }`}
                  >
                    {item.icon && <span className="text-white/30 flex-shrink-0">{item.icon}</span>}
                    <span className="truncate">{item.label}</span>
                  </button>
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </ContextMenuContext.Provider>
  );
};
