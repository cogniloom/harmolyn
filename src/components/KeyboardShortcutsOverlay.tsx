import React, { useState } from 'react';
import { X, Command, ArrowUp, ArrowDown, CornerDownLeft, Search } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface Shortcut {
  keys: string[];
  description: string;
  category: string;
}

const SHORTCUTS: Shortcut[] = [
  // Navigation
  { keys: ['Ctrl', 'K'], description: 'Quick Switcher', category: 'Navigation' },
  { keys: ['Ctrl', '/'], description: 'Keyboard Shortcuts', category: 'Navigation' },
  { keys: ['Alt', '↑'], description: 'Previous Channel', category: 'Navigation' },
  { keys: ['Alt', '↓'], description: 'Next Channel', category: 'Navigation' },
  { keys: ['Ctrl', 'Shift', 'U'], description: 'Jump to Unread', category: 'Navigation' },
  { keys: ['Escape'], description: 'Close Panel / Modal', category: 'Navigation' },

  // Messaging
  { keys: ['Enter'], description: 'Send Message', category: 'Messaging' },
  { keys: ['Shift', 'Enter'], description: 'New Line', category: 'Messaging' },
  { keys: ['↑'], description: 'Edit Last Message', category: 'Messaging' },
  { keys: ['Ctrl', 'E'], description: 'Toggle Emoji Picker', category: 'Messaging' },
  { keys: ['Ctrl', 'Shift', 'M'], description: 'Mute / Unmute', category: 'Messaging' },
  { keys: ['Ctrl', 'P'], description: 'Toggle Pins', category: 'Messaging' },

  // Voice
  { keys: ['Ctrl', 'Shift', 'D'], description: 'Toggle Deafen', category: 'Voice' },
  { keys: ['Ctrl', 'Shift', 'M'], description: 'Toggle Mute', category: 'Voice' },
  { keys: ['Ctrl', 'Shift', 'E'], description: 'Disconnect Voice', category: 'Voice' },

  // View
  { keys: ['Ctrl', 'B'], description: 'Toggle Member List', category: 'View' },
  { keys: ['Ctrl', 'I'], description: 'Toggle Inbox', category: 'View' },
  { keys: ['Ctrl', 'F'], description: 'Search Messages', category: 'View' },
];

interface KeyboardShortcutsOverlayProps {
  onClose: () => void;
}

export const KeyboardShortcutsOverlay: React.FC<KeyboardShortcutsOverlayProps> = ({ onClose }) => {
  const [searchQuery, setSearchQuery] = useState('');

  useEscapeKey(onClose);

  const categories = [...new Set(SHORTCUTS.map(s => s.category))];
  const filtered = SHORTCUTS.filter(s =>
    s.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.keys.join(' ').toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
      <div
        className="w-full max-w-[560px] mx-6 glass-card rounded-r3 border border-stroke max-h-[80vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
      >
        {/* Header */}
        <div className="p-5 border-b border-white/5 flex-shrink-0">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Command size={18} className="text-primary" />
              <h2 id="keyboard-shortcuts-title" className="text-title font-semibold text-text-primary">KEYBOARD // SHORTCUTS</h2>
            </div>
            <button onClick={onClose} aria-label="Close keyboard shortcuts" className="w-8 h-8 rounded-full glass-panel border border-stroke-subtle flex items-center justify-center text-text-secondary hover:text-primary hover:border-primary transition-all focus-ring">
              <X size={16} />
            </button>
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-disabled" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search shortcuts..."
              autoFocus
              className="w-full h-10 pl-9 pr-4 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-body placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors"
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {categories.map(cat => {
            const catShortcuts = filtered.filter(s => s.category === cat);
            if (catShortcuts.length === 0) return null;
            return (
              <div key={cat}>
                <div className="micro-label text-text-tertiary mb-3">{cat.toUpperCase()}</div>
                <div className="space-y-1.5">
                  {catShortcuts.map((shortcut, i) => (
                    <div key={i} className="flex items-center justify-between py-2 px-3 rounded-r1 hover:bg-white/[0.03] transition-colors">
                      <span className="text-body text-text-secondary">{shortcut.description}</span>
                      <div className="flex items-center gap-1">
                        {shortcut.keys.map((key, ki) => (
                          <React.Fragment key={ki}>
                            {ki > 0 && <span className="text-text-disabled text-[10px]">+</span>}
                            <kbd className="px-2 py-1 rounded bg-surface-dark border border-stroke-subtle text-text-primary text-[11px] font-mono font-bold min-w-[28px] text-center">
                              {key}
                            </kbd>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-white/5 flex items-center justify-center gap-4 text-[10px] text-text-disabled flex-shrink-0">
          <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 rounded bg-surface-dark border border-stroke-subtle font-mono">↑↓</kbd> Navigate</span>
          <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 rounded bg-surface-dark border border-stroke-subtle font-mono">Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
};
