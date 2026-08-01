import React from 'react';
import { Bell, Volume2, AtSign, BellOff } from 'lucide-react';
import { usePersistentState } from '@/hooks/usePersistentState';

export type NotifLevel = 'all' | 'mentions' | 'none';

export interface NotificationPreferences {
  globalLevel: NotifLevel;
  desktopEnabled: boolean;
  soundEnabled: boolean;
  flashTaskbar: boolean;
  suppressEveryone: boolean;
  suppressRoles: boolean;
}

export const NOTIFICATION_SETTINGS_STORAGE_KEY = 'harmolyn:settings:notifications';
const STORAGE_KEY = NOTIFICATION_SETTINGS_STORAGE_KEY;

const DEFAULT_PREFERENCES: NotificationPreferences = {
  globalLevel: 'mentions',
  desktopEnabled: true,
  soundEnabled: true,
  flashTaskbar: true,
  suppressEveryone: false,
  suppressRoles: false,
};

export const NotificationSettings: React.FC = () => {
  const [storedPreferences, setPreferences] = usePersistentState<NotificationPreferences>(STORAGE_KEY, DEFAULT_PREFERENCES);
  const preferences = normalizeNotificationPreferences(storedPreferences);

  const levels: { key: NotifLevel; label: string; desc: string; icon: React.ReactNode }[] = [
    { key: 'all', label: 'ALL MESSAGES', desc: 'Notify for every message', icon: <Bell size={16} /> },
    { key: 'mentions', label: 'MENTIONS ONLY', desc: 'Only @mentions and DMs', icon: <AtSign size={16} /> },
    { key: 'none', label: 'NOTHING', desc: 'Mute all notifications', icon: <BellOff size={16} /> },
  ];

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">Notifications</h2>
        <p className="micro-label text-white/30">Alerts, sounds, and desktop notifications</p>
      </header>

      <div className="space-y-6">
        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">DEFAULT NOTIFICATION LEVEL</h3>
          <div className="space-y-2">
            {levels.map((lvl) => (
              <button
                key={lvl.key}
                type="button"
                onClick={() => setPreferences((prev) => ({ ...prev, globalLevel: lvl.key }))}
                className={`w-full flex items-center gap-3 p-4 rounded-r2 border transition-all ${
                  preferences.globalLevel === lvl.key
                    ? 'bg-primary/10 border-primary/20 text-white'
                    : 'border-white/5 text-white/50 hover:bg-white/5 hover:text-white'
                }`}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${preferences.globalLevel === lvl.key ? 'bg-primary/15 text-primary' : 'bg-white/5 text-white/30'}`}>
                  {lvl.icon}
                </div>
                <div className="text-left flex-1">
                  <div className="text-sm font-bold">{lvl.label}</div>
                  <div className="text-[10px] text-white/40">{lvl.desc}</div>
                </div>
                {preferences.globalLevel === lvl.key && <div className="w-2.5 h-2.5 rounded-full bg-primary shadow-glow-sm" />}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">DELIVERY OPTIONS</h3>
          <div className="space-y-3">
            <ToggleRow
              label="Desktop Notifications"
              desc="Show OS-level notifications"
              checked={preferences.desktopEnabled}
              onChange={(value) => {
                setPreferences((prev) => ({ ...prev, desktopEnabled: value }));
                // Turning the toggle ON is a user gesture — request OS permission now, so
                // notifications work immediately instead of only after a reload (the Layout
                // first-gesture effect doesn't re-run when this stored pref changes).
                if (value && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                  void Notification.requestPermission();
                }
              }}
            />
            <ToggleRow
              label="Notification Sounds"
              desc="Play audio on new messages"
              checked={preferences.soundEnabled}
              onChange={(value) => setPreferences((prev) => ({ ...prev, soundEnabled: value }))}
            />
            <ToggleRow
              label="Flash Taskbar"
              desc="Flash when window is not focused"
              checked={preferences.flashTaskbar}
              onChange={(value) => setPreferences((prev) => ({ ...prev, flashTaskbar: value }))}
            />
          </div>
        </section>

        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">MENTION SUPPRESSION</h3>
          <div className="space-y-3">
            <ToggleRow
              label="Suppress @everyone / @here"
              desc="Ignore Space-wide pings"
              checked={preferences.suppressEveryone}
              onChange={(value) => setPreferences((prev) => ({ ...prev, suppressEveryone: value }))}
            />
            <ToggleRow
              label="Suppress Role Mentions"
              desc="Ignore role-based pings"
              checked={preferences.suppressRoles}
              onChange={(value) => setPreferences((prev) => ({ ...prev, suppressRoles: value }))}
            />
          </div>
        </section>

        <div className="flex items-center gap-2 text-[10px] text-white/30">
          <Volume2 size={12} />
          <span>Preferences are stored locally in this browser.</span>
        </div>
      </div>
    </>
  );
};

/**
 * Read the saved notification preferences synchronously from storage. Used by the
 * notification delivery path (Layout) so the user's choices — "Nothing", "Mentions
 * only", suppress @everyone/@role — are actually honored, not just stored.
 */
export function readNotificationPreferences(): NotificationPreferences {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_PREFERENCES;
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeNotificationPreferences(JSON.parse(raw)) : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  if (!isPlainObject(value)) {
    return DEFAULT_PREFERENCES;
  }

  return {
    globalLevel: value.globalLevel === 'all' || value.globalLevel === 'mentions' || value.globalLevel === 'none'
      ? value.globalLevel
      : DEFAULT_PREFERENCES.globalLevel,
    desktopEnabled: typeof value.desktopEnabled === 'boolean' ? value.desktopEnabled : DEFAULT_PREFERENCES.desktopEnabled,
    soundEnabled: typeof value.soundEnabled === 'boolean' ? value.soundEnabled : DEFAULT_PREFERENCES.soundEnabled,
    flashTaskbar: typeof value.flashTaskbar === 'boolean' ? value.flashTaskbar : DEFAULT_PREFERENCES.flashTaskbar,
    suppressEveryone: typeof value.suppressEveryone === 'boolean' ? value.suppressEveryone : DEFAULT_PREFERENCES.suppressEveryone,
    suppressRoles: typeof value.suppressRoles === 'boolean' ? value.suppressRoles : DEFAULT_PREFERENCES.suppressRoles,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

const ToggleRow = ({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) => (
  <div className="glass-card rounded-r2 p-4 border border-white/10 flex items-center justify-between">
    <div>
      <div className="text-white font-bold text-sm">{label}</div>
      <div className="text-[10px] text-white/40">{desc}</div>
    </div>
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`w-11 h-6 rounded-full transition-all relative ${checked ? 'bg-primary/30' : 'bg-white/10'}`}
      aria-pressed={checked}
      aria-label={label}
    >
      <div className={`w-5 h-5 rounded-full absolute top-0.5 transition-all ${checked ? 'left-[22px] bg-primary' : 'left-0.5 bg-white/35'}`} />
    </button>
  </div>
);
