import React, { useEffect, useCallback, useRef, useState, useMemo } from 'react';
import {
  X,
  User,
  Shield,
  Key,
  Bell,
  Monitor,
  LogOut,
  ChevronRight,
  Smartphone,
  Lock,
  QrCode,
  Accessibility,
  Heart,
  ShoppingBag,
  Trophy,
  Zap,
  Copy,
  LayoutGrid,
  ShieldAlert,
  Globe,
  Settings,
  Calendar,
  Info,
  Scale,
  ExternalLink,
  RefreshCw,
  Download,
  Upload,
  Trash2,
  UserCheck,
  Plus,
  Check,
  Video,
  Mic,
  Volume2,
  Eye,
  EyeOff,
  Radio,
  Sliders,
  Edit3,
  Camera,
  Speaker,
  FileText,
} from 'lucide-react';
import QRCode from 'qrcode';
import { User as UserType, type MessageLayout } from '@/types';
import { NotificationSettings } from '@/components/NotificationSettings';
import { LegalDocViewer } from '@/components/legal/LegalDocViewer';
import { useFeature } from '@/hooks/useFeature';
import { usePerformanceMode } from '@/hooks/usePerformanceMode';
import { usePersistentState } from '@/hooks/usePersistentState';
import { usePrivacyPreferences, type PrivacyPreferences } from '@/hooks/usePrivacyPreferences';
import { SecurityNote } from '@/components/SecurityNote';
import { useBackupIdentity, useUpdateProfile, useRegisterRelay, useRemoveRelay, useUpdatePresence } from '@/hooks/runtime/mutations';
import { readBrowserAuthContext } from '@/lib/authPreview';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';
import {
  listVaultIdentities,
  saveCurrentToVault,
  removeFromVault,
  importToVault,
  loadEncryptedIdentity,
  hasPersistedIdentity,
  type VaultEntry,
} from '@/native/identity/storage';
import { useNativeEngine } from '@/native/engine/provider';
import { setVoiceMicVolume } from '@/native/voice/registry';
import { getRecoveryContacts, setRecoveryContacts } from '@/native/recovery/custody';
import { usePiiBlurClass } from '@/components/streamer/StreamerMode';
import { unlockAndActivateVaultIdentity, downloadIdentityBackup, downloadActiveIdentityBackup } from '@/lib/identitySwitch';
import { SwitchingOverlay } from '@/components/SwitchingOverlay';
import { PendingButton } from '@/components/ui/PendingButton';
import { safeStorageRemove } from '@/lib/browserStorage';
import { canCopyTextToClipboardSafely, copyTextToClipboardSafely } from '@/components/contextMenuUtils';
import { resolveAvatarSrc } from '@/lib/avatar';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { safeParseUrl } from '@/lib/browserLocation';
import type { XoreinRuntimeSnapshot } from '@/types';
import { generateTheme } from '@/utils/themeGenerator';

// Minimal Web Speech API typings (not part of the standard DOM lib).
interface SpeechRecognitionResultLike {
  readonly transcript: string;
}
interface SpeechRecognitionEventLike {
  readonly results: ArrayLike<ArrayLike<SpeechRecognitionResultLike>>;
}
interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  start: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SettingsScreenProps {
  user: UserType;
  /** Open directly on this section (e.g. 'audio-video' from the voice cog). */
  initialSection?: string;
  onClose: () => void;
  onLogOut?: () => void;
  messageLayout?: MessageLayout;
  onSetMessageLayout?: (layout: MessageLayout) => void;
  runtimeSnapshot?: XoreinRuntimeSnapshot | null;
  onOpenNodeLaunch?: () => void;
  bgSeed?: string;
  onSetBgSeed?: (seed: string) => void;
}

type SettingsSection = 'account' | 'privacy' | 'mfa' | 'authorized' | 'network' | 'appearance' | 'notifications' | 'accessibility' | 'mobile' | 'streamer' | 'audio-video' | 'about';
type FeedbackTone = 'error' | 'info' | 'success';

interface FeedbackState {
  tone: FeedbackTone;
  message: string;
}

interface AccountPreferences {
  displayName: string;
  bio: string;
  avatarUrl: string;
}

interface AuthorizedPreferences {
  rememberBrowser: boolean;
}

interface AccessibilityPreferences {
  highContrast: boolean;
  reducedMotion: boolean;
  fontSize: 'small' | 'default' | 'large' | 'xlarge';
  saturation: number;
  dyslexicFont: boolean;
  colorBlindMode: 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
  ttsEnabled: boolean;
  sttEnabled: boolean;
}

const AUTH_TOKEN_STORAGE_KEYS = [
  'harmolyn:xorein:control-token',
  'harmolyn:control-token',
  'xorein:control-token',
] as const;

const SOURCE_URL = import.meta.env.VITE_SOURCE_URL ?? 'https://github.com/xorein/hybrid';
const APP_VERSION = __APP_VERSION__;
const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';
const SPEC_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

const ACCOUNT_DEFAULTS = (user: UserType): AccountPreferences => ({
  displayName: user.username,
  bio: user.bio?.trim() || 'No status established.',
  avatarUrl: user.avatar,
});

const AUTHORIZED_DEFAULTS: AuthorizedPreferences = {
  rememberBrowser: true,
};

const ACCESSIBILITY_DEFAULTS: AccessibilityPreferences = {
  highContrast: false,
  reducedMotion: false,
  fontSize: 'default',
  saturation: 100,
  dyslexicFont: false,
  colorBlindMode: 'none',
  ttsEnabled: false,
  sttEnabled: false,
};

const FONT_SIZES: Array<{ key: AccessibilityPreferences['fontSize']; label: string; size: string }> = [
  { key: 'small', label: 'SMALL', size: '13px' },
  { key: 'default', label: 'DEFAULT', size: '15px' },
  { key: 'large', label: 'LARGE', size: '17px' },
  { key: 'xlarge', label: 'X-LARGE', size: '19px' },
];

export const SettingsScreen: React.FC<SettingsScreenProps> = ({
  user,
  initialSection,
  onClose,
  onLogOut,
  messageLayout = 'modern',
  onSetMessageLayout,
  runtimeSnapshot = null,
  onOpenNodeLaunch,
  bgSeed = 'nexus-default',
  onSetBgSeed,
}) => {
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    (initialSection as SettingsSection) || 'account',
  );
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const registerRelayMutation = useRegisterRelay();
  const removeRelayMutation = useRemoveRelay();

  useEffect(() => {
    if (!feedback) {
      return;
    }

    const timer = window.setTimeout(() => setFeedback(null), 2600);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const showFeedback = (tone: FeedbackTone, message: string) => setFeedback({ tone, message });

  const performLogout = () => {
    setLogoutConfirmOpen(false);
    for (const key of AUTH_TOKEN_STORAGE_KEYS) {
      safeStorageRemove(() => window.localStorage, key);
      safeStorageRemove(() => window.sessionStorage, key);
    }

    if (onLogOut) {
      onLogOut();
    } else {
      showFeedback('success', 'Cleared stored control tokens from this browser.');
    }
  };

  // Escape dismisses the logout confirmation first, otherwise closes Settings
  // (matching the visible "ESC" hint on the close button).
  useEscapeKey(() => {
    if (logoutConfirmOpen) {
      setLogoutConfirmOpen(false);
    } else {
      onClose();
    }
  });

  return (
    <div className="absolute inset-0 z-[100] bg-bg-0 flex flex-col md:flex-row text-white/70 overflow-hidden">
      <div className="hidden md:flex w-[224px] bg-bg-1 flex-col items-end py-10 px-5 border-r border-white/5">
        <div className="w-full space-y-1.5">
          <div className="micro-label text-white/20 px-3 mb-3">User settings</div>
          <SettingsItem icon={<User size={16} />} label="My Account" active={activeSection === 'account'} onClick={() => setActiveSection('account')} />
          <SettingsItem icon={<Shield size={16} />} label="Privacy & Safety" active={activeSection === 'privacy'} onClick={() => setActiveSection('privacy')} />
          <SettingsItem icon={<Lock size={16} />} label="Security (MFA)" active={activeSection === 'mfa'} onClick={() => setActiveSection('mfa')} />
          <SettingsItem icon={<Key size={16} />} label="Authorized Hubs" active={activeSection === 'authorized'} onClick={() => setActiveSection('authorized')} />
          <SettingsItem icon={<Globe size={16} />} label="Network" active={activeSection === 'network'} onClick={() => setActiveSection('network')} />

          <div className="h-6" />
          <div className="micro-label text-white/20 px-3 mb-3">System configuration</div>
          <SettingsItem icon={<Monitor size={16} />} label="Appearance" active={activeSection === 'appearance'} onClick={() => setActiveSection('appearance')} />
          <SettingsItem icon={<Bell size={16} />} label="Notifications" active={activeSection === 'notifications'} onClick={() => setActiveSection('notifications')} />
          <SettingsItem icon={<Accessibility size={16} />} label="Accessibility" active={activeSection === 'accessibility'} onClick={() => setActiveSection('accessibility')} />
          <SettingsItem icon={<Mic size={16} />} label="Audio & Video" active={activeSection === 'audio-video'} onClick={() => setActiveSection('audio-video')} />
          <SettingsItem icon={<Eye size={16} />} label="Streamer Mode" active={activeSection === 'streamer'} onClick={() => setActiveSection('streamer')} />
          <SettingsItem icon={<Smartphone size={16} />} label="Mobile Sync" active={activeSection === 'mobile'} onClick={() => setActiveSection('mobile')} />
          <SettingsItem icon={<Info size={16} />} label="About & Legal" active={activeSection === 'about'} onClick={() => setActiveSection('about')} />

          <div className="h-6" />
          <div className="border-t border-white/5 my-3 mx-3" />
          <button
            type="button"
            className="flex items-center gap-2.5 px-3 py-2 rounded-r1 w-full text-accent-danger hover:bg-accent-danger/10 transition-all micro-label btn-press focus-ring"
            onClick={() => setLogoutConfirmOpen(true)}
          >
            <LogOut size={16} />
            <span>Log Out</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-bg-2 relative">
        <div className="absolute inset-0 grid-overlay opacity-30 pointer-events-none" />
        <div className="max-w-[640px] mx-auto py-12 px-6 md:px-10">
          {activeSection === 'account' && <AccountSection user={user} showFeedback={showFeedback} onOpenMfa={() => setActiveSection('mfa')} />}
          {activeSection === 'privacy' && <PrivacySection showFeedback={showFeedback} />}
          {activeSection === 'mfa' && <MFASection showFeedback={showFeedback} />}
          {activeSection === 'authorized' && <AuthorizedSection user={user} showFeedback={showFeedback} />}
          {activeSection === 'network' && <NetworkSection runtimeSnapshot={runtimeSnapshot} showFeedback={showFeedback} registerRelayMutation={registerRelayMutation} removeRelayMutation={removeRelayMutation} onOpenNodeLaunch={onOpenNodeLaunch} />}
          {activeSection === 'appearance' && (
            <AppearanceSection
              messageLayout={messageLayout}
              onSetMessageLayout={onSetMessageLayout}
              bgSeed={bgSeed}
              onSetBgSeed={onSetBgSeed}
              showFeedback={showFeedback}
            />
          )}
          {activeSection === 'notifications' && <NotificationSettings />}
          {activeSection === 'accessibility' && <AccessibilitySection />}
          {activeSection === 'mobile' && <MobileSection showFeedback={showFeedback} />}
          {activeSection === 'streamer' && <StreamerSection showFeedback={showFeedback} />}
          {activeSection === 'audio-video' && <AudioVideoSection />}
          {activeSection === 'about' && <AboutSection />}
        </div>
      </div>

      {/* Fixed floating toast — does not shift page content */}
      {feedback && (
        <div
          role="alert"
          aria-live="assertive"
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] max-w-sm w-[calc(100%-3rem)] rounded-r2 border px-5 py-3 text-caption shadow-2xl backdrop-blur-sm pointer-events-none transition-all animate-in slide-in-from-bottom-2 fade-in duration-200 ${
            feedback.tone === 'error'
              ? 'border-accent-danger/40 bg-accent-danger/15 text-accent-danger'
              : feedback.tone === 'success'
                ? 'border-accent-success/40 bg-accent-success/15 text-accent-success'
                : 'border-primary/40 bg-primary/15 text-primary'
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* Log out confirmation — inline themed alertdialog (destructive) */}
      {logoutConfirmOpen && (
        <div
          className="fixed inset-0 z-[210] flex items-center justify-center bg-bg-0/70 backdrop-blur-sm p-4 animate-in fade-in duration-150"
          onClick={() => setLogoutConfirmOpen(false)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="logout-confirm-title"
            aria-describedby="logout-confirm-desc"
            className="glass-card rounded-r2 border border-accent-danger/30 shadow-2xl max-w-sm w-full p-6 space-y-4 animate-in zoom-in-95 duration-150"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-accent-danger/10 flex items-center justify-center text-accent-danger flex-shrink-0">
                <LogOut size={18} />
              </div>
              <h2 id="logout-confirm-title" className="text-white font-bold text-base font-display tracking-tight">Log out of Harmolyn?</h2>
            </div>
            <p id="logout-confirm-desc" className="text-[11px] text-white/55 leading-relaxed">
              This clears the stored control tokens from this browser session. Your encrypted identity stays on this device — make sure you have a backup before logging out on a shared machine.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={performLogout}
                className="flex-1 h-10 rounded-full bg-accent-danger text-bg-0 font-bold text-xs hover:shadow-glow transition-all flex items-center justify-center gap-1.5 focus-ring"
              >
                <LogOut size={13} /> Log Out
              </button>
              <button
                type="button"
                onClick={() => setLogoutConfirmOpen(false)}
                autoFocus
                className="px-5 h-10 rounded-full border border-white/10 text-white/60 text-xs hover:bg-white/5 transition-all focus-ring"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="absolute top-6 right-6 flex flex-col items-center gap-1.5 group cursor-pointer z-[110]" onClick={onClose}>
        <div className="w-10 h-10 rounded-full border border-white/10 glass-panel flex items-center justify-center group-hover:border-primary group-hover:shadow-glow transition-all">
          <X size={20} className="text-white group-hover:text-primary" />
        </div>
        <span className="micro-label text-[7px] text-white/20 group-hover:text-white">ESC</span>
      </div>
    </div>
  );
};

const SettingsItem = ({ icon, label, active = false, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-r1 cursor-pointer transition-all border btn-press text-left w-full ${active ? 'bg-primary/10 border-primary/20 text-white shadow-inner' : 'border-transparent text-white/40 hover:bg-white/5 hover:text-white'}`}
  >
    <div className={active ? 'text-primary' : ''}>{icon}</div>
    <span className="font-bold text-xs tracking-tight">{label}</span>
  </button>
);

const InfoField = ({
  label,
  value,
  onModify,
}: {
  label: string;
  value: string;
  onModify: () => void;
}) => (
  <div className="flex justify-between items-center py-3 border-b border-white/5 group gap-4">
    <div>
      <div className="micro-label text-white/20 mb-1">{label}</div>
      <div className="text-white font-medium text-sm break-all">{value}</div>
    </div>
    <button type="button" className="px-3 py-1 rounded-full bg-white/5 border border-white/5 hover:border-primary/40 hover:bg-primary/10 hover:text-primary text-[10px] transition-all" onClick={onModify}>
      Modify
    </button>
  </div>
);

/**
 * Read a local image file, downscale it to a square `size`×`size` PNG, and return
 * a self-contained data: URI. Keeps the avatar tiny (a few KB) so it fits in the
 * identity profile and the presence broadcast that propagates it to peers.
 */
async function fileToAvatarDataUri(file: File, size = 256): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('decode failed'));
    image.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  // Cover-crop to a centered square.
  const min = Math.min(img.width, img.height);
  const sx = (img.width - min) / 2;
  const sy = (img.height - min) / 2;
  ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
  // JPEG keeps it small; quality 0.85 is plenty for an avatar.
  return canvas.toDataURL('image/jpeg', 0.85);
}

const AccountSection: React.FC<{ user: UserType; showFeedback: (tone: FeedbackTone, message: string) => void; onOpenMfa: () => void }> = ({ user, showFeedback, onOpenMfa }) => {
  const snapshot = useRuntimeSnapshot();
  const peerId = snapshot?.identity?.peer_id?.trim() ?? '';
  // Prefer the native engine's display_name as the source of truth for the nickname
  const nativeDisplayName = snapshot?.identity?.profile?.display_name?.trim() || '';
  const [storedProfile, setProfile] = usePersistentState<AccountPreferences>(`harmolyn:settings:profile:${user.id}`, ACCOUNT_DEFAULTS(user));
  const profile = normalizeAccountPreferences(storedProfile, user, nativeDisplayName);
  const createIdentityMutation = useUpdateProfile();

  // Per-field inline editing — one field open at a time (name OR bio), edited in
  // place on its own row. No combined "controls on top" block, no coupling of
  // nickname and bio.
  const nativeBio = snapshot?.identity?.profile?.bio?.trim() ?? '';
  const nativeAvatar = typeof snapshot?.identity?.profile?.avatar === 'string' ? snapshot.identity.profile.avatar : '';
  const displayName = nativeDisplayName || profile.displayName;
  const bioText = nativeBio || (profile.bio && profile.bio !== 'No status established.' ? profile.bio : '');
  const avatarSrc = resolveAvatarSrc(nativeAvatar || profile.avatarUrl || user.avatar, displayName || user.username);

  const piiBlur = usePiiBlurClass();
  const [editingField, setEditingField] = useState<'name' | 'bio' | null>(null);
  const [draft, setDraft] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [avatarEditOpen, setAvatarEditOpen] = useState(false);
  const [avatarUrlInput, setAvatarUrlInput] = useState('');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarFileRef = useRef<HTMLInputElement>(null);

  const updateProfile = (patch: Partial<AccountPreferences>) => {
    setProfile((current) => ({ ...current, ...patch }));
  };

  const startEdit = (field: 'name' | 'bio') => {
    setDraft(field === 'name' ? displayName : bioText);
    setEditingField(field);
  };

  const commitField = async (field: 'name' | 'bio') => {
    const value = draft.trim();
    if (field === 'name' && !value) { showFeedback('error', 'Display name cannot be empty.'); return; }
    const nextName = field === 'name' ? value : displayName;
    const nextBio = field === 'bio' ? value : bioText;
    setEditBusy(true);
    try {
      await createIdentityMutation.mutateAsync({ displayName: nextName, bio: nextBio });
      updateProfile({ displayName: nextName, bio: nextBio || 'No status established.' });
      showFeedback('success', field === 'name' ? 'Display name updated.' : 'Bio updated.');
      setEditingField(null);
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Failed to update profile.');
    } finally {
      setEditBusy(false);
    }
  };

  const commitAvatar = async (avatar: string) => {
    setAvatarBusy(true);
    try {
      await createIdentityMutation.mutateAsync({ displayName, bio: bioText, avatar });
      updateProfile({ avatarUrl: avatar });
      showFeedback('success', 'Avatar updated — it’s now visible to everyone you talk to.');
      setAvatarEditOpen(false);
      setAvatarUrlInput('');
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Failed to update avatar.');
    } finally {
      setAvatarBusy(false);
    }
  };

  const onPickAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      showFeedback('error', 'Choose a PNG, JPG, GIF, or WebP image.');
      return;
    }
    setAvatarBusy(true);
    try {
      const dataUri = await fileToAvatarDataUri(file, 256);
      await commitAvatar(dataUri);
    } catch {
      showFeedback('error', 'Could not read that image. Try a different file.');
      setAvatarBusy(false);
    }
  };

  const saveAvatarUrl = async () => {
    const trimmed = avatarUrlInput.trim();
    if (!trimmed) { showFeedback('error', 'Enter an image URL.'); return; }
    if (!isValidImageUrl(trimmed)) { showFeedback('error', 'Enter a valid https:// image URL or data:image/ URL. SVG is not accepted.'); return; }
    await commitAvatar(trimmed);
  };

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">My account</h2>
        <p className="micro-label text-white/30">Profile and security</p>
      </header>

      <div className="glass-card rounded-r2 overflow-hidden mb-6 border border-white/10 shadow-2xl">
        <div className="h-[100px] bg-gradient-to-r from-primary/10 via-primary/5 to-accent-purple/10 relative">
          <div className="absolute inset-0 grid-overlay opacity-30" />
        </div>
        <div className="px-6 pb-6 -mt-10 flex flex-col md:flex-row items-start md:items-end justify-between gap-5">
          <div className="flex flex-col md:flex-row items-center md:items-end gap-5">
            <button type="button" aria-label="Change avatar image" className="w-[100px] h-[100px] rounded-r2 border-[6px] border-bg-2 bg-bg-1 overflow-hidden relative group cursor-pointer shadow-xl p-0" onClick={() => { setAvatarUrlInput(''); setAvatarEditOpen((v) => !v); }}>
              <img src={avatarSrc} className="w-full h-full object-cover group-hover:opacity-40 transition-all duration-500" alt="" />
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Camera size={18} className="text-white" />
                <span className="micro-label tracking-tighter text-white">Change</span>
              </div>
            </button>
            <div className="mb-1.5 text-center md:text-left">
              <div className="text-xl font-bold text-white font-display leading-tight">{displayName}</div>
              <div className="text-primary/60 font-mono text-[10px] tracking-widest mt-1 uppercase">
                {peerId ? `${peerId.slice(0, 20).toUpperCase()}…` : 'NOT REGISTERED'}
              </div>
            </div>
          </div>
        </div>

        <input ref={avatarFileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => { void onPickAvatarFile(e); }} />

        {/* Avatar editor: pick a local file (primary) or paste a URL */}
        {avatarEditOpen && (
          <div className="border-t border-white/5 px-6 py-5 space-y-3 bg-bg-1/40">
            <div className="flex items-center justify-between">
              <label className="micro-label text-white/30">PROFILE PICTURE</label>
              <button type="button" onClick={() => setAvatarEditOpen(false)} className="text-white/30 hover:text-white/70 transition-colors"><X size={14} /></button>
            </div>
            <button
              type="button"
              onClick={() => avatarFileRef.current?.click()}
              disabled={avatarBusy}
              className="w-full h-11 rounded-full bg-primary text-bg-0 font-bold text-xs hover:shadow-glow transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {avatarBusy ? <><RefreshCw size={13} className="animate-spin" /> Updating…</> : <><Upload size={13} /> Choose image from your device</>}
            </button>
            <div className="text-[10px] text-white/35 text-center">Downscaled and shared with everyone you talk to. PNG, JPG, GIF or WebP.</div>
            <div className="flex items-center gap-2 pt-1">
              <input
                type="url"
                value={avatarUrlInput}
                onChange={e => setAvatarUrlInput(e.target.value)}
                placeholder="…or paste an https:// image URL"
                onKeyDown={e => { if (e.key === 'Enter') void saveAvatarUrl(); }}
                className="flex-1 h-10 px-4 rounded-full bg-surface-dark border border-stroke-subtle text-white text-xs placeholder:text-white/20 focus:border-primary focus:outline-none transition-colors"
              />
              <button type="button" onClick={() => void saveAvatarUrl()} disabled={avatarBusy || !avatarUrlInput.trim()} className="px-4 h-10 rounded-full border border-white/10 text-white/70 text-xs hover:bg-white/5 transition-all disabled:opacity-40">Use URL</button>
            </div>
          </div>
        )}

        <div className="px-6 py-5 space-y-4">
          {/* Display name — inline edit on its own row */}
          <div className="py-3 border-b border-white/5">
            {editingField === 'name' ? (
              <>
                <div className="micro-label text-white/20 mb-1.5">Display Name</div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    maxLength={64}
                    autoFocus
                    onKeyDown={e => { if (e.key === 'Enter') void commitField('name'); if (e.key === 'Escape') setEditingField(null); }}
                    className="flex-1 h-10 px-4 rounded-full bg-surface-dark border border-primary/40 text-white text-sm focus:outline-none transition-colors"
                  />
                  <button type="button" aria-label="Save display name" onClick={() => void commitField('name')} disabled={editBusy} className="w-9 h-9 rounded-full bg-primary text-bg-0 flex items-center justify-center hover:shadow-glow transition-all disabled:opacity-50">
                    {editBusy ? <RefreshCw size={13} className="animate-spin" /> : <Check size={14} />}
                  </button>
                  <button type="button" aria-label="Cancel" onClick={() => setEditingField(null)} className="w-9 h-9 rounded-full border border-white/10 text-white/50 flex items-center justify-center hover:bg-white/5 transition-all"><X size={14} /></button>
                </div>
              </>
            ) : (
              <div className="flex justify-between items-center gap-4">
                <div>
                  <div className="micro-label text-white/20 mb-1">Display Name</div>
                  <div className="text-white font-medium text-sm">{displayName}</div>
                </div>
                <button type="button" onClick={() => startEdit('name')} className="px-3 py-1 rounded-full bg-white/5 border border-white/5 hover:border-primary/40 hover:bg-primary/10 hover:text-primary text-[10px] transition-all flex items-center gap-1"><Edit3 size={10} /> Edit</button>
              </div>
            )}
          </div>

          {peerId ? (
            <div className="flex justify-between items-center py-3 border-b border-white/5 gap-4">
              <div className="min-w-0 flex-1">
                <div className="micro-label text-white/20 mb-1">Peer ID</div>
                <div className={`text-white font-mono text-[10px] break-all ${piiBlur}`}>{peerId}</div>
              </div>
              <button
                type="button"
                onClick={() => void copyTextToClipboardSafely(peerId).then(ok => showFeedback(ok ? 'success' : 'info', ok ? 'Peer ID copied.' : 'Clipboard unavailable.'))}
                className="px-3 py-1 rounded-full bg-white/5 border border-white/5 hover:border-primary/40 hover:bg-primary/10 hover:text-primary text-[10px] transition-all flex-shrink-0"
              >
                Copy
              </button>
            </div>
          ) : (
            <div className="py-3 border-b border-white/5 text-[10px] text-white/30">No registered identity found on this device.</div>
          )}

          {/* Bio — independent inline edit on its own row */}
          <div className="py-3 border-b border-white/5">
            <div className="micro-label text-white/20 mb-1.5">Bio</div>
            {editingField === 'bio' ? (
              <div className="space-y-2">
                <textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  rows={3}
                  maxLength={256}
                  autoFocus
                  placeholder="A short bio (optional)"
                  onKeyDown={e => { if (e.key === 'Escape') setEditingField(null); }}
                  className="w-full px-4 py-3 rounded-r2 bg-surface-dark border border-primary/40 text-white text-sm placeholder:text-white/20 focus:outline-none transition-colors resize-none"
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => void commitField('bio')} disabled={editBusy} className="h-9 px-4 rounded-full bg-primary text-bg-0 font-bold text-xs hover:shadow-glow transition-all disabled:opacity-50 flex items-center gap-1.5">
                    {editBusy ? <><RefreshCw size={12} className="animate-spin" /> Saving…</> : <><Check size={12} /> Save</>}
                  </button>
                  <button type="button" onClick={() => setEditingField(null)} className="h-9 px-4 rounded-full border border-white/10 text-white/50 text-xs hover:bg-white/5 transition-all">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex justify-between items-center gap-4">
                <div className="text-white/60 text-sm">{bioText || 'No status established.'}</div>
                <button type="button" onClick={() => startEdit('bio')} className="px-3 py-1 rounded-full bg-white/5 border border-white/5 hover:border-primary/40 hover:bg-primary/10 hover:text-primary text-[10px] transition-all flex items-center gap-1 flex-shrink-0"><Edit3 size={10} /> Edit</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <section className="space-y-5">
        <h3 className="micro-label text-white/40 border-b border-white/5 pb-2">Data encryption & authentication</h3>
        <button type="button" onClick={onOpenMfa} className="glass-card rounded-r2 p-5 flex items-center justify-between group hover:border-primary/30 transition-all cursor-pointer text-left w-full">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary group-hover:shadow-glow transition-all">
              <Shield size={18} />
            </div>
            <div>
              <div className="text-white font-bold mb-0.5 text-sm">Identity backup & recovery</div>
              <div className="text-[10px] text-white/40">Create an encrypted backup before you lose access to this device.</div>
            </div>
          </div>
          <ChevronRight size={18} className="text-white/20 group-hover:text-primary" />
        </button>
      </section>

      <IdentityVaultSection showFeedback={showFeedback} />
    </>
  );
};

// ── Identity Vault section ─────────────────────────────────────────────────

const IdentityVaultSection: React.FC<{ showFeedback: (tone: FeedbackTone, message: string) => void }> = ({ showFeedback }) => {
  const hasAccountSwitching = useFeature('accountSwitching');
  const snapshot = useRuntimeSnapshot();
  const { registerIdentity } = useNativeEngine();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingFor, setSwitchingFor] = useState<string | null>(null);
  const [switchPassphrase, setSwitchPassphrase] = useState('');
  const [switching, setSwitching] = useState(false);
  const [switchOverlay, setSwitchOverlay] = useState(false);
  const [saving, setSaving] = useState(false);
  // Whether the active identity is already password-encrypted on this device.
  // null = unknown (still checking). false + an active peer = guest identity.
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [guestPass, setGuestPass] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  // Inline import passphrase — avoids window.prompt
  const [pendingImport, setPendingImport] = useState<{ text: string } | null>(null);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importBusy, setImportBusy] = useState(false);

  const activePeerId = snapshot?.identity?.peer_id?.trim() ?? '';
  const activeDisplayName = snapshot?.identity?.profile?.display_name?.trim() ?? '';

  const reload = () => {
    setLoading(true);
    listVaultIdentities()
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
    void hasPersistedIdentity().then(setPersisted).catch(() => setPersisted(null));
  };

  useEffect(reload, []);

  if (!hasAccountSwitching) return null;
  if (switchOverlay) return <SwitchingOverlay />;

  const alreadySaved = !!activePeerId && entries.some(e => e.peerId === activePeerId);
  const isGuest = persisted === false && !!activePeerId;

  // Registered identity: just (re)write the already-encrypted blob into the vault.
  const handleSaveCurrent = async () => {
    if (!activePeerId) {
      showFeedback('error', 'No active identity to save. Register or unlock first.');
      return;
    }
    setSaving(true);
    try {
      await saveCurrentToVault(activePeerId, activeDisplayName);
      reload();
      showFeedback('success', `Identity ${activeDisplayName || activePeerId.slice(0, 12)} saved to this device.`);
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Failed to save identity to vault.');
    } finally {
      setSaving(false);
    }
  };

  // Guest identity: there is no encrypted blob to save yet. Set a password to
  // promote the CURRENT identity in place (same peer_id + keys, no regeneration),
  // which encrypts it to disk — then save it to the vault.
  const handlePromoteAndSave = async () => {
    const pass = guestPass.trim();
    if (pass.length < 8) { showFeedback('error', 'Choose a password of at least 8 characters.'); return; }
    setSaving(true);
    try {
      await registerIdentity(pass, activeDisplayName || undefined);
      await saveCurrentToVault(activePeerId, activeDisplayName);
      setGuestPass('');
      setPersisted(true);
      reload();
      showFeedback('success', 'Password set — your identity is now saved on this device and can be reused.');
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Failed to save identity.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (peerId: string) => {
    try {
      await removeFromVault(peerId);
      reload();
      showFeedback('success', 'Identity removed from vault.');
    } catch {
      showFeedback('error', 'Failed to remove identity.');
    }
  };

  const handleExport = (entry: VaultEntry) => {
    downloadIdentityBackup(entry.blob, entry.peerId);
    showFeedback('success', 'Identity backup downloaded.');
  };

  const handleSwitch = async (entry: VaultEntry) => {
    if (!switchPassphrase.trim()) {
      showFeedback('error', 'Enter the passphrase for this identity.');
      return;
    }
    setSwitching(true);
    try {
      // Decrypts (validates the passphrase), activates the entry, seeds the
      // native state with its profile, then reloads. Throws on a wrong passphrase.
      // The full-screen overlay shows only after a successful unlock, right before reload.
      await unlockAndActivateVaultIdentity(entry, switchPassphrase, () => setSwitchOverlay(true));
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Wrong passphrase or corrupt identity.');
      setSwitching(false);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    const text = await file.text();
    setPendingImport({ text });
    setImportPassphrase('');
  };

  const confirmImport = async () => {
    if (!pendingImport) return;
    if (!importPassphrase.trim()) { showFeedback('error', 'Enter the passphrase for this identity backup.'); return; }
    setImportBusy(true);
    try {
      const entry = await importToVault(pendingImport.text, importPassphrase.trim());
      setPendingImport(null);
      setImportPassphrase('');
      reload();
      showFeedback('success', `Identity ${entry.peerId.slice(0, 12)}… imported to vault.`);
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Import failed — wrong passphrase or corrupt file.');
    } finally {
      setImportBusy(false);
    }
  };

  const otherEntries = entries.filter(e => e.peerId !== activePeerId);

  return (
    <section className="space-y-4 mt-8">
      <div className="border-b border-white/5 pb-2">
        <h3 className="micro-label text-white/40">Saved identities</h3>
        <p className="text-[10px] text-white/30 mt-1">Your vault is the list of accounts stored encrypted on this device. Saved identities appear at sign-in and in the account switcher so you can hold more than one account and switch between them.</p>
      </div>

      {/* Guest identity — not yet encrypted to disk. Set a password to keep it. */}
      {isGuest && (
        <div className="glass-card rounded-r2 p-4 border border-accent-warning/20 bg-accent-warning/5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-accent-warning/10 flex items-center justify-center text-accent-warning flex-shrink-0">
              <Key size={16} />
            </div>
            <div>
              <div className="text-white font-bold text-sm">Guest identity — not saved yet</div>
              <div className="text-[10px] text-white/45">This account lives only in this browser session. Set a password to encrypt and keep it (your keys and ID stay the same).</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={guestPass}
              onChange={e => setGuestPass(e.target.value)}
              placeholder="Choose a password (min 8 chars)"
              onKeyDown={e => { if (e.key === 'Enter') void handlePromoteAndSave(); }}
              className="flex-1 h-10 px-4 rounded-full bg-surface-dark border border-stroke-subtle text-white text-xs placeholder:text-white/20 focus:border-primary focus:outline-none transition-colors"
            />
            <button type="button" onClick={() => void handlePromoteAndSave()} disabled={saving || guestPass.trim().length < 8} className="px-4 h-10 rounded-full bg-primary text-bg-0 font-bold text-xs hover:shadow-glow transition-all disabled:opacity-40 flex items-center gap-1.5">
              {saving ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />} Save
            </button>
          </div>
        </div>
      )}

      {/* Registered + already in the vault — show status, no redundant action. */}
      {!isGuest && alreadySaved && (
        <div className="glass-card rounded-r2 p-4 flex items-center gap-3 border border-accent-success/15">
          <div className="w-9 h-9 rounded-full bg-accent-success/10 flex items-center justify-center text-accent-success flex-shrink-0">
            <UserCheck size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-white font-bold text-sm">This identity is saved on this device</div>
            <div className="text-[10px] text-white/40 font-mono truncate">{activePeerId.slice(0, 36)}…</div>
          </div>
        </div>
      )}

      {/* Registered but not in the vault — offer to save it. */}
      {!isGuest && !alreadySaved && activePeerId && (
        <button
          type="button"
          onClick={() => void handleSaveCurrent()}
          disabled={saving}
          className="glass-card rounded-r2 p-4 flex items-center gap-3 hover:border-primary/30 transition-all cursor-pointer text-left w-full disabled:opacity-50"
        >
          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary flex-shrink-0">
            <Plus size={16} />
          </div>
          <div>
            <div className="text-white font-bold text-sm">Save current identity to this device</div>
            <div className="text-[10px] text-white/40">Stores it (encrypted) in your vault so it appears at sign-in and in the account switcher.</div>
          </div>
        </button>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-white/30 text-caption py-2">
          <RefreshCw size={13} className="animate-spin" />
          Loading vault…
        </div>
      ) : otherEntries.length === 0 ? (
        <p className="text-[10px] text-white/30 px-1">No other identities saved. Save your current identity or import a backup to switch between accounts.</p>
      ) : (
        <div className="space-y-2">
          {otherEntries.map((entry) => (
            <div key={entry.peerId} className="glass-card rounded-r2 border border-white/10 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-surface-dark border border-white/10 flex items-center justify-center flex-shrink-0">
                    <UserCheck size={15} className="text-white/40" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-white font-bold text-sm truncate">{entry.displayName || 'Unknown'}</div>
                    <div className="text-[10px] text-white/30 font-mono truncate">{entry.peerId.slice(0, 30)}…</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    title="Export backup"
                    onClick={() => handleExport(entry)}
                    className="p-2 rounded-full hover:bg-white/5 text-white/30 hover:text-white transition-all"
                  >
                    <Download size={14} />
                  </button>
                  <button
                    type="button"
                    title="Remove from vault"
                    onClick={() => void handleRemove(entry.peerId)}
                    className="p-2 rounded-full hover:bg-accent-danger/10 text-white/30 hover:text-accent-danger transition-all"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {switchingFor === entry.peerId ? (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={switchPassphrase}
                    onChange={(e) => setSwitchPassphrase(e.target.value)}
                    placeholder="Passphrase for this identity"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSwitch(entry); if (e.key === 'Escape') { setSwitchingFor(null); setSwitchPassphrase(''); } }}
                    className="w-full h-10 px-4 rounded-full bg-surface-dark border border-stroke-subtle text-white text-caption placeholder:text-white/20 focus:border-primary focus:outline-none transition-colors"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSwitch(entry)}
                      disabled={switching}
                      className="flex-1 h-9 rounded-full bg-primary text-bg-0 font-bold text-[11px] hover:shadow-glow transition-all disabled:opacity-50"
                    >
                      {switching ? 'Switching…' : 'Switch & Reload'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSwitchingFor(null); setSwitchPassphrase(''); }}
                      className="px-4 h-9 rounded-full bg-white/5 text-white/50 text-[11px] hover:bg-white/10 transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { setSwitchingFor(entry.peerId); setSwitchPassphrase(''); }}
                  className="w-full h-9 rounded-full bg-white/5 border border-white/10 text-white/70 font-bold text-[11px] hover:border-primary/40 hover:text-primary transition-all flex items-center justify-center gap-1.5"
                >
                  <RefreshCw size={12} />
                  Switch to this identity
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {pendingImport ? (
        <div className="rounded-r2 border border-white/10 bg-bg-1/50 p-4 space-y-3">
          <div className="flex items-center gap-2 text-white/70 text-sm font-bold">
            <Upload size={14} className="text-primary" />
            Confirm import passphrase
          </div>
          <input
            type="password"
            value={importPassphrase}
            onChange={e => setImportPassphrase(e.target.value)}
            placeholder="Passphrase used when creating the backup"
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') void confirmImport(); if (e.key === 'Escape') { setPendingImport(null); setImportPassphrase(''); } }}
            className="w-full h-10 px-4 rounded-full bg-surface-dark border border-stroke-subtle text-white text-caption placeholder:text-white/20 focus:border-primary focus:outline-none transition-colors"
          />
          <div className="flex gap-2">
            <button type="button" onClick={() => void confirmImport()} disabled={importBusy} className="flex-1 h-9 rounded-full bg-primary text-bg-0 font-bold text-xs hover:shadow-glow transition-all disabled:opacity-50">
              {importBusy ? 'Importing…' : 'Import'}
            </button>
            <button type="button" onClick={() => { setPendingImport(null); setImportPassphrase(''); }} className="px-4 h-9 rounded-full bg-white/5 text-white/50 text-xs hover:bg-white/10 transition-all">Cancel</button>
          </div>
        </div>
      ) : (
        <label className="flex items-center gap-3 cursor-pointer px-4 py-3 rounded-r2 border border-dashed border-white/10 hover:border-primary/30 transition-colors">
          <Upload size={14} className="text-primary/60 flex-shrink-0" />
          <span className="text-[11px] text-white/40">Import identity from backup file</span>
          <input ref={importRef} type="file" accept=".json,.txt,.bak" className="sr-only" onChange={(e) => void handleImport(e)} />
        </label>
      )}
    </section>
  );
};

function normalizeAccountPreferences(value: unknown, user: UserType, nativeDisplayName?: string): AccountPreferences {
  const fallback = ACCOUNT_DEFAULTS(user);
  // Prefer the native engine's display_name as source of truth for the nickname
  if (nativeDisplayName) fallback.displayName = nativeDisplayName;
  if (!isPlainObject(value)) {
    return fallback;
  }

  return {
    displayName: nativeDisplayName || normalizeAccountString(value.displayName, fallback.displayName),
    bio: normalizeAccountString(value.bio, fallback.bio),
    avatarUrl: normalizeAccountString(value.avatarUrl, fallback.avatarUrl),
  };
}

function normalizeAccountString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

const PrivacySection: React.FC<{ showFeedback: (tone: FeedbackTone, message: string) => void }> = ({ showFeedback }) => {
  const [privacy, setPrivacy] = usePrivacyPreferences();
  const updatePresenceMutation = useUpdatePresence();

  const togglePresence = async () => {
    const next = !privacy.showPresence;
    setPrivacy((current) => ({ ...current, showPresence: next }));
    await updatePresenceMutation.mutateAsync({ status: next ? 'online' : 'offline' });
    showFeedback('success', next ? 'presence visibility is now shown through xorein' : 'presence visibility is now hidden through xorein');
  };

  const toggle = (key: keyof PrivacyPreferences) => {
    if (key === 'showPresence') {
      void togglePresence();
      return;
    }
    setPrivacy((current) => ({ ...current, [key]: !current[key] }));
    showFeedback('success', 'Privacy preference saved locally.');
  };

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">PRIVACY // SAFETY</h2>
        <p className="micro-label text-white/30">LOCAL // VISIBILITY // DISCOVERY</p>
      </header>

      <div className="space-y-3">
        <ToggleCard label="Show presence" desc="Lets peers see when you're online or offline. Off keeps your activity private." checked={privacy.showPresence} onToggle={() => toggle('showPresence')} />
        <ToggleCard label="Share read receipts" desc="Tells the other side when you've opened their messages. Off hides that you've read them." checked={privacy.shareReadReceipts} onToggle={() => toggle('shareReadReceipts')} />
        <ToggleCard label="Allow discovery" desc="Lets others on your local network find this account by its profile. Off keeps you unlisted." checked={privacy.allowDiscovery} onToggle={() => toggle('allowDiscovery')} />
        <ToggleCard label="Auto-load media previews" desc="Fetches images and video thumbnails from remote servers. Off keeps them hidden until you tap to load each one." checked={privacy.loadRemoteMedia} onToggle={() => toggle('loadRemoteMedia')} />
      </div>

      <SecurityNote tone="caution" className="mt-4">
        Media previews are fetched directly from the host that serves them, so that host can see your IP
        address and when you opened the message — even in an encrypted conversation. Turn off auto-load to
        fetch nothing until you choose to.
      </SecurityNote>
    </>
  );
};

const MFASection: React.FC<{ showFeedback: (tone: FeedbackTone, message: string) => void }> = ({ showFeedback }) => {
  const snapshot = useRuntimeSnapshot();
  const { engine } = useNativeEngine();
  const peerId = snapshot?.identity?.peer_id?.trim() ?? '';
  const [identityBackup, setIdentityBackup] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const clipboardAvailable = canCopyTextToClipboardSafely();

  const createIdentityBackup = async () => {
    if (!peerId) {
      showFeedback('error', 'No registered identity on this device to back up.');
      return;
    }
    setBackupBusy(true);
    try {
      const blob = await loadEncryptedIdentity();
      if (!blob) {
        showFeedback('error', 'No encrypted identity found — register an account first.');
        return;
      }
      setIdentityBackup(JSON.stringify(blob, null, 2));
      showFeedback('success', 'Backup loaded. Download the file or copy the JSON below.');
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Failed to load identity backup.');
    } finally {
      setBackupBusy(false);
    }
  };

  const downloadBackup = async () => {
    // Bundle the encrypted account-state snapshot so restoring this file on a new
    // device brings back your servers/DMs/profile, not just the keypair.
    const state = engine?.encryptedStateForBackup() ?? undefined;
    const ok = await downloadActiveIdentityBackup(peerId, state);
    if (ok) showFeedback('success', 'Encrypted backup downloaded — includes your servers & profile.');
    else showFeedback('error', 'No identity to back up — register an account first.');
  };

  const copyIdentityBackup = async () => {
    if (!identityBackup) {
      showFeedback('info', 'Show the backup first before copying it.');
      return;
    }
    if (await copyTextToClipboardSafely(identityBackup)) {
      showFeedback('success', 'Copied encrypted identity backup.');
      return;
    }

    showFeedback('info', 'Clipboard access is unavailable in this browser context.');
  };

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">Security</h2>
        <p className="micro-label text-white/30">Backup and extra protection</p>
      </header>

      <div className="space-y-5">
        <div className="glass-card rounded-r2 p-5 border border-white/10">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-accent-success/10 flex items-center justify-center text-accent-success">
                <Key size={18} />
              </div>
              <div>
                <div className="text-white font-bold text-sm">Encrypted Identity Backup</div>
                <div className="text-[10px] text-white/40">Exports the local xorein identity as passphrase-encrypted JSON</div>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-[11px] text-white/50 leading-relaxed">
              Your identity is encrypted with your account password. This backup can restore your
              account on another device — you will need your account password to unlock it.
            </p>

            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={() => void createIdentityBackup()}
                disabled={backupBusy}
                className="flex-1 h-11 rounded-full bg-primary text-bg-0 font-bold text-xs hover:shadow-glow transition-all disabled:opacity-50"
              >
                {backupBusy ? 'Loading…' : identityBackup ? 'Refresh Backup' : 'Show Backup JSON'}
              </button>
              <button
                type="button"
                onClick={() => void downloadBackup()}
                className="h-11 px-4 rounded-full border border-white/10 text-white/50 font-bold text-xs hover:border-primary/30 hover:text-primary transition-all flex items-center justify-center gap-2"
              >
                <Download size={14} />
                Download
              </button>
              <button
                type="button"
                onClick={() => void copyIdentityBackup()}
                disabled={!identityBackup || !clipboardAvailable}
                title={clipboardAvailable ? undefined : 'Clipboard access is unavailable in this browser context.'}
                className="h-11 px-5 rounded-full border border-white/10 text-white/50 font-bold text-xs hover:border-primary/30 hover:text-primary transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Copy size={14} />
                Copy
              </button>
            </div>

            {identityBackup && (
              <textarea
                readOnly
                rows={6}
                value={identityBackup}
                className="w-full rounded-r2 bg-bg-0/70 border border-white/10 p-3 text-[10px] text-white/60 font-mono resize-none"
              />
            )}
          </div>
        </div>

        {/* Security model explanation — why TOTP doesn't apply */}
        <div className="glass-card rounded-r2 p-5 border border-white/10">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-accent-success/10 flex items-center justify-center text-accent-success">
              <Shield size={18} />
            </div>
            <div>
              <div className="text-white font-bold text-sm">Why no TOTP or passkeys?</div>
              <div className="text-[10px] text-white/40">Harmolyn's security model is different</div>
            </div>
          </div>
          <p className="text-[11px] text-white/55 leading-relaxed">
            Traditional 2FA (TOTP, passkeys) guards a <em>server-side</em> credential. Your Harmolyn identity <strong>is</strong> a cryptographic keypair — the private key never leaves your device and is protected directly by your account password via Argon2id + AES-256-GCM. There is no central server to authenticate against, so TOTP and passkeys have no role here.
          </p>
          <p className="text-[11px] text-white/55 leading-relaxed mt-2">
            The equivalent protection here is: <strong>a strong, unique password</strong> + <strong>an encrypted offline backup</strong>. Store the backup somewhere safe and never share your password.
          </p>
        </div>

        <RecoveryContactsSection showFeedback={showFeedback} peerId={peerId} />
      </div>
    </>
  );
};

const RecoveryContactsSection: React.FC<{ showFeedback: (tone: FeedbackTone, message: string) => void; peerId: string }> = ({ showFeedback, peerId }) => {
  const { engine } = useNativeEngine();
  const snapshot = useRuntimeSnapshot();
  const [contacts, setContacts] = useState<string[]>(() => getRecoveryContacts());
  const [addId, setAddId] = useState('');
  const [busy, setBusy] = useState(false);

  // Accepted friends become one-tap guardian suggestions (the counterpart peer id).
  const friendIds = useMemo(() => {
    const out = new Set<string>();
    for (const f of snapshot?.friends ?? []) {
      if (f.status !== 'accepted') continue;
      const other = f.from_peer_id === peerId ? (f.to_peer_id ?? '') : f.from_peer_id;
      if (other && other !== peerId) out.add(other);
    }
    return Array.from(out).filter(id => !contacts.includes(id));
  }, [snapshot?.friends, peerId, contacts]);

  const persist = (next: string[]) => { setContacts(next); setRecoveryContacts(next); };

  const distribute = async (list: string[]) => {
    if (!engine || list.length === 0) return;
    setBusy(true);
    try {
      const { delivered } = await engine.distributeRecovery(list);
      showFeedback(delivered.length ? 'success' : 'info',
        delivered.length
          ? `Backup secured with ${delivered.length} of ${list.length} contact${list.length > 1 ? 's' : ''}.`
          : 'Contacts saved. They’ll receive your backup the next time they’re online.');
    } catch (e) {
      showFeedback('error', e instanceof Error ? e.message : 'Could not distribute backup.');
    } finally {
      setBusy(false);
    }
  };

  const addContact = async (id: string) => {
    const trimmed = id.trim();
    if (!trimmed || trimmed === peerId || contacts.includes(trimmed)) { setAddId(''); return; }
    const next = [...contacts, trimmed];
    persist(next);
    setAddId('');
    await distribute([trimmed]);
  };

  const removeContact = (id: string) => persist(contacts.filter(c => c !== id));

  return (
    <div className="glass-card rounded-r2 p-5 border border-white/10 space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
          <Shield size={18} />
        </div>
        <div>
          <div className="text-white font-bold text-sm">Trusted recovery contacts</div>
          <div className="text-[10px] text-white/40">Friends who hold an encrypted copy of your account, so you can recover even if you lose this device.</div>
        </div>
      </div>

      <p className="text-[11px] text-white/55 leading-relaxed">
        Your identity is shared with these friends <strong>encrypted with your password</strong> — they can never read or use it. To recover on a new device, you ask one of them and they approve the transfer; then your <strong>password</strong> unlocks it. (If you forget your password, the account still can’t be recovered — that’s the point.)
      </p>

      {!peerId && <p className="text-[11px] text-accent-warning">Set a password for your identity first (Saved identities → set a password) before adding recovery contacts.</p>}

      {/* Your account id — needed to recover later */}
      {peerId && (
        <div className="rounded-r2 bg-bg-0/60 border border-white/10 p-3">
          <div className="micro-label text-white/30 mb-1">Your account ID — write this down to recover later</div>
          <div className="flex items-center gap-2">
            <code className="text-[10px] text-white/70 font-mono break-all flex-1">{peerId}</code>
            <button type="button" onClick={() => void copyTextToClipboardSafely(peerId).then(ok => showFeedback(ok ? 'success' : 'info', ok ? 'Account ID copied.' : 'Clipboard unavailable.'))} className="px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] text-white/60 hover:text-primary hover:border-primary/40 transition-all flex-shrink-0">Copy</button>
          </div>
        </div>
      )}

      {/* Current contacts */}
      {contacts.length > 0 && (
        <div className="space-y-2">
          {contacts.map(id => (
            <div key={id} className="flex items-center justify-between gap-3 rounded-r2 border border-white/10 bg-white/5 px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <UserCheck size={14} className="text-accent-success flex-shrink-0" />
                <code className="text-[10px] text-white/60 font-mono truncate">{id.slice(0, 28)}…</code>
              </div>
              <button type="button" onClick={() => removeContact(id)} className="p-1.5 rounded-full hover:bg-accent-danger/10 text-white/30 hover:text-accent-danger transition-all flex-shrink-0"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}

      {/* Quick-add accepted friends */}
      {peerId && friendIds.length > 0 && (
        <div className="space-y-1.5">
          <div className="micro-label text-white/30">Add a friend as a guardian</div>
          <div className="flex flex-wrap gap-1.5">
            {friendIds.slice(0, 8).map(id => (
              <button key={id} type="button" onClick={() => void addContact(id)} disabled={busy} className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-[10px] text-white/60 hover:text-primary hover:border-primary/40 transition-all disabled:opacity-40 flex items-center gap-1.5">
                <Plus size={10} /> {id.slice(0, 12)}…
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Add by ID */}
      {peerId && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={addId}
            onChange={e => setAddId(e.target.value)}
            placeholder="Paste a trusted friend’s account ID"
            onKeyDown={e => { if (e.key === 'Enter') void addContact(addId); }}
            className="flex-1 h-10 px-4 rounded-full bg-surface-dark border border-stroke-subtle text-white text-xs placeholder:text-white/20 focus:border-primary focus:outline-none transition-colors"
          />
          <button type="button" onClick={() => void addContact(addId)} disabled={busy || !addId.trim()} className="px-4 h-10 rounded-full bg-primary text-bg-0 font-bold text-xs hover:shadow-glow transition-all disabled:opacity-40">Add</button>
        </div>
      )}

      {peerId && contacts.length > 0 && (
        <button type="button" onClick={() => void distribute(contacts)} disabled={busy} className="text-[10px] text-white/40 hover:text-primary transition-colors flex items-center gap-1.5">
          <RefreshCw size={11} className={busy ? 'animate-spin' : ''} /> Re-sync my backup to all contacts
        </button>
      )}
    </div>
  );
};

const AuthorizedSection: React.FC<{ user: UserType; showFeedback: (tone: FeedbackTone, message: string) => void }> = ({ user, showFeedback }) => {
  const [authorizedPrefs, setAuthorizedPrefs] = usePersistentState<AuthorizedPreferences>('harmolyn:settings:authorized', AUTHORIZED_DEFAULTS);
  const authContext = readBrowserAuthContext();

  const toggleRememberBrowser = () => {
    setAuthorizedPrefs((current) => ({ ...current, rememberBrowser: !current.rememberBrowser }));
    showFeedback('success', 'Browser trust preference saved locally.');
  };

  const clearStoredControlTokens = () => {
    for (const key of AUTH_TOKEN_STORAGE_KEYS) {
      safeStorageRemove(() => window.localStorage, key);
      safeStorageRemove(() => window.sessionStorage, key);
    }

    showFeedback('success', 'Cleared stored control tokens from this browser.');
  };

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">AUTHORIZED // HUBS</h2>
        <p className="micro-label text-white/30">LOCAL // TRUST // SESSION</p>
      </header>

      <div className="space-y-4">
        <div className="glass-card rounded-r2 p-5 border border-white/10">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-white font-bold text-sm">Remember this browser</div>
              <div className="text-[10px] text-white/40">Keep local trust markers for this device only</div>
            </div>
            <button type="button" onClick={toggleRememberBrowser} className={`w-11 h-6 rounded-full transition-all relative ${authorizedPrefs.rememberBrowser ? 'bg-primary/30' : 'bg-white/10'}`}>
              <div className={`w-5 h-5 rounded-full absolute top-0.5 transition-all ${authorizedPrefs.rememberBrowser ? 'left-[22px] bg-primary' : 'left-0.5 bg-white/35'}`} />
            </button>
          </div>
        </div>

        <div className="glass-card rounded-r2 p-5 border border-white/10 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-accent-success/10 flex items-center justify-center text-accent-success">
              <Globe size={18} />
            </div>
            <div>
              <div className="text-white font-bold text-sm">Current browser identity</div>
              <div className="text-[10px] text-white/40">{authContext.identityLabel}</div>
            </div>
          </div>

          <div className="text-[11px] text-white/50 leading-relaxed">
            Control bridge: {authContext.hasControlBridge ? 'ready' : 'missing'} · Control endpoint: {authContext.hasControlEndpoint ? 'available' : 'missing'}
          </div>

          <button type="button" onClick={clearStoredControlTokens} className="rounded-full border border-white/10 px-4 py-2 text-xs font-bold text-white/50 hover:border-primary/30 hover:text-primary transition-all">
            Clear stored control tokens
          </button>
        </div>

        <div className="glass-card rounded-r2 p-5 border border-white/10">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-white font-bold text-sm">{user.username} // hub access</div>
              <div className="text-[10px] text-white/40">No dedicated hub authorization screen exists in this preview yet.</div>
            </div>
            <ShieldAlert size={18} className="text-white/30" />
          </div>
        </div>
      </div>
    </>
  );
};

const MOCK_MESSAGES = [
  { id: '1', author: 'Aether', avatar: 'A', color: 'bg-primary/80', time: '12:01', content: 'Hey! Did the relay reconnect successfully?' },
  { id: '2', author: 'you', avatar: 'Y', color: 'bg-accent-purple/80', time: '12:02', content: 'Yeah, it picked up the backup circuit automatically. No data loss.' },
  { id: '3', author: 'Aether', avatar: 'A', color: 'bg-primary/80', time: '12:03', content: 'Perfect. The channel epoch rotated while you were gone, sync looks clean.' },
];

const ChatPreview: React.FC<{ layout: MessageLayout }> = ({ layout }) => (
  <div className="rounded-r2 bg-bg-0/60 border border-white/10 p-3 space-y-1 overflow-hidden select-none">
    {MOCK_MESSAGES.map((m, i) => (
      layout === 'terminal' ? (
        <div key={m.id} className="flex items-baseline gap-2 py-0.5 font-mono">
          <span className="text-[9px] text-white/25 w-7 text-right flex-shrink-0">{m.time}</span>
          <span className="text-[10px] font-bold flex-shrink-0" style={{ color: m.author === 'you' ? 'rgba(180,130,255,0.9)' : 'rgba(19,221,236,0.9)' }}>{m.author}</span>
          <span className="text-[10px] text-white/60 leading-snug">{m.content}</span>
        </div>
      ) : layout === 'bubbles' ? (
        <div key={m.id} className={`flex ${m.author === 'you' ? 'justify-end' : 'justify-start'} py-0.5`}>
          <div className={`max-w-[80%] rounded-2xl px-2.5 py-1 text-[10px] ${m.author === 'you' ? 'bg-primary/20 text-white rounded-tr-sm' : 'bg-white/8 text-white/80 rounded-tl-sm'}`}>
            {m.content}
          </div>
        </div>
      ) : (
        <div key={m.id} className={`flex gap-2.5 py-1 ${i > 0 ? 'pt-2' : ''}`}>
          <div className={`w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[9px] font-bold text-white ${m.color}`}>{m.avatar}</div>
          <div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[10px] font-bold" style={{ color: m.author === 'you' ? 'rgba(180,130,255,0.9)' : 'rgba(19,221,236,0.9)' }}>{m.author}</span>
              <span className="text-[9px] text-white/25">{m.time}</span>
            </div>
            <div className="text-[10px] text-white/60 leading-snug mt-0.5">{m.content}</div>
          </div>
        </div>
      )
    ))}
  </div>
);

const LAYOUTS: { key: MessageLayout; label: string; desc: string }[] = [
  { key: 'modern', label: 'Modern', desc: 'Avatar + name header, like Discord' },
  { key: 'bubbles', label: 'Bubbles', desc: 'Chat bubble style, sender on the right' },
  { key: 'terminal', label: 'Terminal', desc: 'IRC-style: time · name · message inline' },
];

const AppearanceSection: React.FC<{
  messageLayout: MessageLayout;
  onSetMessageLayout?: (layout: MessageLayout) => void;
  bgSeed: string;
  onSetBgSeed?: (seed: string) => void;
  showFeedback: (tone: FeedbackTone, message: string) => void;
}> = ({ messageLayout, onSetMessageLayout, bgSeed, onSetBgSeed, showFeedback }) => {
  const [accentHue, setAccentHue] = usePersistentState<number>('harmolyn:settings:accent-hue', 183);
  const [localSeed, setLocalSeed] = useState(bgSeed);
  const theme = useMemo(() => generateTheme(localSeed), [localSeed]);

  const applyAccentHue = useCallback((hue: number) => {
    const s = 85; const l = 50;
    document.documentElement.style.setProperty('--primary', `${hue} ${s}% ${l}%`);
    document.documentElement.style.setProperty('--primary-glow', `0 0 10px hsl(${hue} ${s}% ${l}% / 0.5), 0 0 20px hsl(${hue} ${s}% ${l}% / 0.3)`);
    document.documentElement.style.setProperty('--shadow-glow-sm', `0 0 5px hsl(${hue} ${s}% ${l}% / 0.4)`);
  }, []);

  useEffect(() => { applyAccentHue(accentHue); }, [accentHue, applyAccentHue]);

  const applySeed = (seed: string) => {
    setLocalSeed(seed);
    onSetBgSeed?.(seed);
  };

  const selectLayout = (key: MessageLayout) => {
    if (!onSetMessageLayout) { showFeedback('info', 'Layout switching unavailable in this session.'); return; }
    onSetMessageLayout(key);
  };

  const accent = `hsl(${accentHue}, 85%, 50%)`;

  return (
    <>
      <header className="mb-8">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">Appearance</h2>
        <p className="micro-label text-white/30">Layout, colors, and visual preferences</p>
      </header>

      {/* ── LARGE LIVE PREVIEW ──────────────────────────────────── */}
      <div className="mb-8 rounded-r2 overflow-hidden border border-white/10 shadow-2xl" style={{ background: theme.background, minHeight: 300 }}>
        {/* Simulated top bar */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ background: 'rgba(0,0,0,0.4)', borderColor: 'rgba(255,255,255,0.08)' }}>
          <div className="w-3 h-3 rounded-full mr-1" style={{ background: accent }} />
          <span className="text-xs font-bold" style={{ color: theme.themeVars['--theme-text'] as string }}>#general</span>
          <span className="ml-auto text-[10px]" style={{ color: theme.themeVars['--theme-text-dim'] as string }}>XOREIN · E2EE</span>
        </div>
        {/* Simulated messages */}
        <div className="p-4 space-y-3">
          {MOCK_MESSAGES.map((m, i) => (
            messageLayout === 'terminal' ? (
              <div key={m.id} className="flex items-baseline gap-2 font-mono">
                <span className="text-[9px] w-7 text-right flex-shrink-0" style={{ color: theme.themeVars['--theme-text-dim'] as string }}>{m.time}</span>
                <span className="text-[11px] font-bold flex-shrink-0" style={{ color: m.author === 'you' ? 'rgba(180,130,255,0.9)' : accent }}>{m.author}</span>
                <span className="text-[11px]" style={{ color: theme.themeVars['--theme-text-secondary'] as string }}>{m.content}</span>
              </div>
            ) : messageLayout === 'bubbles' ? (
              <div key={m.id} className={`flex ${m.author === 'you' ? 'justify-end' : 'justify-start'}`}>
                <div className="rounded-2xl px-3 py-2 text-xs max-w-[70%]" style={{
                  background: m.author === 'you' ? `${accent}33` : 'rgba(255,255,255,0.08)',
                  color: theme.themeVars['--theme-text'] as string,
                  borderRadius: m.author === 'you' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                }}>
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={m.id} className={`flex gap-2.5 ${i > 0 ? 'pt-1' : ''}`}>
                <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold text-white" style={{ background: m.author === 'you' ? 'rgba(180,130,255,0.5)' : `${accent}66` }}>{m.avatar}</div>
                <div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[11px] font-bold" style={{ color: m.author === 'you' ? 'rgba(180,130,255,0.9)' : accent }}>{m.author}</span>
                    <span className="text-[9px]" style={{ color: theme.themeVars['--theme-text-dim'] as string }}>{m.time}</span>
                  </div>
                  <div className="text-[11px] leading-snug" style={{ color: theme.themeVars['--theme-text-secondary'] as string }}>{m.content}</div>
                </div>
              </div>
            )
          ))}
        </div>
      </div>

      <div className="space-y-6">
        {/* Message Layout */}
        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Message Layout</h3>
          <div className="grid grid-cols-3 gap-2">
            {LAYOUTS.map(({ key, label, desc }) => (
              <button
                key={key}
                type="button"
                onClick={() => selectLayout(key)}
                className={`rounded-r2 border p-3 text-left transition-all ${messageLayout === key ? 'border-primary/40 bg-primary/10 shadow-glow-sm' : 'border-white/10 bg-white/3 hover:border-white/20'}`}
              >
                <div className="mb-2">
                  <ChatPreview layout={key} />
                </div>
                <div className="flex items-center gap-1.5 mt-2">
                  {messageLayout === key && <Check size={11} className="text-primary" />}
                  <span className="text-white font-bold text-xs">{label}</span>
                </div>
                <div className="text-[10px] text-white/40 leading-tight">{desc}</div>
              </button>
            ))}
          </div>
        </section>

        {/* Background / Theme */}
        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Background Theme</h3>
          <div className="glass-card rounded-r2 p-5 border border-white/10 space-y-4">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-12 h-12 rounded-r2 border border-white/10 flex-shrink-0" style={{ background: theme.background }} />
              <div>
                <div className="text-white font-bold text-sm">Theme seed</div>
                <div className="text-[10px] text-white/40">A short string generates a unique gradient background</div>
              </div>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={localSeed}
                onChange={e => setLocalSeed(e.target.value)}
                onBlur={() => applySeed(localSeed)}
                onKeyDown={e => e.key === 'Enter' && applySeed(localSeed)}
                className="flex-1 bg-white/5 border border-white/10 rounded-r1 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-primary/40"
                placeholder="e.g. midnight-city"
              />
              <button type="button" onClick={() => applySeed(Math.random().toString(36).substring(2, 9))}
                className="px-3 py-2 bg-primary/15 border border-primary/30 text-primary rounded-r1 text-xs font-bold hover:bg-primary/25 transition-colors flex items-center gap-1.5">
                <RefreshCw size={12} /> Randomize
              </button>
            </div>
            {/* Quick presets */}
            <div className="flex flex-wrap gap-1.5">
              {['nexus-default', 'midnight-city', 'aurora', 'ember', 'abyss', 'neon-tokyo', 'forest', 'cosmos'].map(preset => (
                <button key={preset} type="button" onClick={() => applySeed(preset)}
                  className={`px-2.5 py-1 rounded-full text-[10px] font-mono border transition-all ${localSeed === preset ? 'border-primary/40 bg-primary/10 text-primary' : 'border-white/10 text-white/40 hover:border-white/20 hover:text-white/70'}`}>
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Accent Color */}
        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Accent Color</h3>
          <div className="glass-card rounded-r2 p-5 border border-white/10 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-white font-bold text-sm">Primary hue — {accentHue}°</div>
                <div className="text-[10px] text-white/40">Controls buttons, highlights, glows — applied site-wide</div>
              </div>
              <div className="w-10 h-10 rounded-full border-2 border-white/20 flex-shrink-0" style={{ background: accent }} />
            </div>
            <input
              type="range" min={0} max={359} value={accentHue}
              onChange={e => setAccentHue(Number(e.target.value))}
              className="w-full h-3 rounded-full appearance-none cursor-pointer"
              style={{ background: 'linear-gradient(to right,hsl(0,85%,50%),hsl(45,85%,50%),hsl(90,85%,50%),hsl(135,85%,50%),hsl(180,85%,50%),hsl(225,85%,50%),hsl(270,85%,50%),hsl(315,85%,50%),hsl(360,85%,50%))' }}
            />
            {/* Preset swatches */}
            <div className="flex gap-2 flex-wrap">
              {[
                { label: 'Cyan', hue: 183 }, { label: 'Blue', hue: 220 }, { label: 'Purple', hue: 270 },
                { label: 'Pink', hue: 330 }, { label: 'Red', hue: 0 }, { label: 'Orange', hue: 25 },
                { label: 'Green', hue: 130 }, { label: 'Teal', hue: 170 },
              ].map(sw => (
                <button key={sw.hue} type="button" onClick={() => setAccentHue(sw.hue)} title={sw.label}
                  className={`w-7 h-7 rounded-full border-2 transition-all ${accentHue === sw.hue ? 'border-white scale-110' : 'border-white/20 hover:border-white/60'}`}
                  style={{ background: `hsl(${sw.hue}, 85%, 50%)` }} />
              ))}
              <button type="button" onClick={() => setAccentHue(Math.floor(Math.random() * 360))}
                className="w-7 h-7 rounded-full border-2 border-white/20 hover:border-white/60 transition-all flex items-center justify-center"
                style={{ background: 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)' }} title="Random">
              </button>
            </div>
          </div>
        </section>
      </div>
    </>
  );
};

const FONT_SIZE_MAP: Record<AccessibilityPreferences['fontSize'], string> = {
  small: '13px', default: '15px', large: '17px', xlarge: '19px',
};

const CB_FILTERS: Record<string, string> = {
  protanopia:   '0.567 0.433 0 0 0  0.558 0.442 0 0 0  0 0.242 0.758 0 0  0 0 0 1 0',
  deuteranopia: '0.625 0.375 0 0 0  0.7 0.3 0 0 0  0 0.3 0.7 0 0  0 0 0 1 0',
  tritanopia:   '0.95 0.05 0 0 0  0 0.433 0.567 0 0  0 0.475 0.525 0 0  0 0 0 1 0',
};

function ensureCbSvg() {
  if (document.getElementById('cb-filters-svg')) return;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.id = 'cb-filters-svg';
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  svg.setAttribute('aria-hidden', 'true');
  for (const [id, matrix] of Object.entries(CB_FILTERS)) {
    const filter = document.createElementNS(NS, 'filter');
    filter.id = `cb-${id}`;
    const fe = document.createElementNS(NS, 'feColorMatrix');
    fe.setAttribute('type', 'matrix');
    fe.setAttribute('values', matrix);
    filter.appendChild(fe);
    svg.appendChild(filter);
  }
  document.body.appendChild(svg);
}

function applyCbFilter(mode: AccessibilityPreferences['colorBlindMode']) {
  ensureCbSvg();
  document.body.style.removeProperty('filter');
  if (mode !== 'none') {
    document.body.style.filter = `url(#cb-${mode})`;
  }
}

const CB_MODE_LABELS: { key: AccessibilityPreferences['colorBlindMode']; label: string; desc: string; color: string }[] = [
  { key: 'none', label: 'None', desc: 'Normal vision', color: '#fff' },
  { key: 'protanopia', label: 'Protanopia', desc: 'Red-blind (1% of men)', color: '#4aa' },
  { key: 'deuteranopia', label: 'Deuteranopia', desc: 'Green-blind (6% of men)', color: '#a84' },
  { key: 'tritanopia', label: 'Tritanopia', desc: 'Blue-blind (rare)', color: '#86a' },
];

const AccessibilitySection: React.FC = () => {
  const [preferences, setPreferences] = usePersistentState<AccessibilityPreferences>('harmolyn:settings:accessibility', ACCESSIBILITY_DEFAULTS);
  const { perfMode, togglePerfMode } = usePerformanceMode();
  const [ttsTestResult, setTtsTestResult] = useState<string | null>(null);
  const [sttListening, setSttListening] = useState(false);
  const [sttPreview, setSttPreview] = useState('');

  // Apply visual effects
  useEffect(() => {
    document.documentElement.style.fontSize = FONT_SIZE_MAP[preferences.fontSize] ?? '15px';
    document.documentElement.classList.toggle('high-contrast', preferences.highContrast);
    document.documentElement.classList.toggle('reduce-motion', preferences.reducedMotion);
    document.documentElement.classList.toggle('dyslexic-font', preferences.dyslexicFont);
    // Saturation stacks with color-blind filter; apply as CSS filter on html element
    const satPart = preferences.saturation !== 100 ? `saturate(${preferences.saturation}%)` : '';
    document.documentElement.style.filter = satPart;
  }, [preferences.fontSize, preferences.highContrast, preferences.reducedMotion, preferences.dyslexicFont, preferences.saturation]);

  // Dyslexic font CDN load
  useEffect(() => {
    if (!preferences.dyslexicFont) return;
    if (document.getElementById('dyslexic-font-link')) return;
    const link = document.createElement('link');
    link.id = 'dyslexic-font-link';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.cdnfonts.com/css/opendyslexic';
    document.head.appendChild(link);
  }, [preferences.dyslexicFont]);

  // Color-blind filter on body
  useEffect(() => {
    applyCbFilter(preferences.colorBlindMode);
  }, [preferences.colorBlindMode]);

  const testTts = () => {
    if (!('speechSynthesis' in window)) { setTtsTestResult('Not supported in this browser.'); return; }
    const utterance = new SpeechSynthesisUtterance('Text to speech is working. Your messages will be read aloud.');
    utterance.onend = () => setTtsTestResult(null);
    setTtsTestResult('Speaking…');
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };

  const testStt = () => {
    const win = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SR) { setSttPreview('Not supported in this browser.'); return; }
    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => setSttListening(true);
    recognition.onresult = (e: SpeechRecognitionEventLike) => {
      const transcript = Array.from(e.results).map((r) => r[0].transcript).join('');
      setSttPreview(transcript);
    };
    recognition.onend = () => setSttListening(false);
    recognition.onerror = (e: SpeechRecognitionErrorEventLike) => { setSttListening(false); setSttPreview(`Error: ${e.error}`); };
    recognition.start();
  };

  const set = <K extends keyof AccessibilityPreferences>(key: K, val: AccessibilityPreferences[K]) =>
    setPreferences(cur => ({ ...cur, [key]: val }));

  return (
    <>
      <header className="mb-8">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">Accessibility</h2>
        <p className="micro-label text-white/30">Vision · Motion · Voice · Font settings</p>
      </header>

      <div className="space-y-6">
        {/* ── DYSLEXIA ──────────────────────── */}
        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Reading</h3>
          <div className="space-y-3">
            <div className="glass-card rounded-r2 p-4 border border-white/10 flex items-center justify-between">
              <div>
                <div className="text-white font-bold text-sm" style={preferences.dyslexicFont ? { fontFamily: "'OpenDyslexic', sans-serif" } : undefined}>
                  OpenDyslexic Font
                </div>
                <div className="text-[10px] text-white/40">A typeface designed to increase readability for readers with dyslexia</div>
                {preferences.dyslexicFont && <div className="text-[9px] text-primary/70 mt-0.5" style={{ fontFamily: "'OpenDyslexic', sans-serif" }}>Active — you're reading this in OpenDyslexic</div>}
              </div>
              <button type="button" onClick={() => set('dyslexicFont', !preferences.dyslexicFont)}
                className={`w-11 h-6 rounded-full transition-all relative flex-shrink-0 ${preferences.dyslexicFont ? 'bg-primary/40' : 'bg-white/10'}`}>
                <div className={`w-5 h-5 rounded-full absolute top-0.5 transition-all ${preferences.dyslexicFont ? 'left-[22px] bg-primary' : 'left-0.5 bg-white/35'}`} />
              </button>
            </div>

            {/* Font size */}
            <div className="glass-card rounded-r2 p-4 border border-white/10">
              <div className="text-white font-bold text-sm mb-3">Base Font Size</div>
              <div className="flex gap-2">
                {FONT_SIZES.map(fs => (
                  <button key={fs.key} type="button" onClick={() => set('fontSize', fs.key)}
                    className={`flex-1 py-3 rounded-r2 text-center border transition-all ${preferences.fontSize === fs.key ? 'bg-primary/10 border-primary/20 text-primary' : 'border-white/5 text-white/40 hover:bg-white/5'}`}>
                    <div className="font-bold" style={{ fontSize: fs.size }}>Aa</div>
                    <div className="micro-label mt-1">{fs.label}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── COLOR BLINDNESS ──────────────── */}
        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Color Vision</h3>
          <div className="glass-card rounded-r2 p-4 border border-white/10 space-y-4">
            <div className="text-white font-bold text-sm">Color-blindness simulation / correction</div>
            <div className="grid grid-cols-2 gap-2">
              {CB_MODE_LABELS.map(({ key, label, desc, color }) => (
                <button key={key} type="button" onClick={() => set('colorBlindMode', key)}
                  className={`rounded-r2 border p-3 text-left transition-all ${preferences.colorBlindMode === key ? 'border-primary/40 bg-primary/10' : 'border-white/10 bg-white/3 hover:border-white/20'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: color }} />
                    <span className="text-white font-bold text-xs">{label}</span>
                    {preferences.colorBlindMode === key && <Check size={10} className="text-primary ml-auto" />}
                  </div>
                  <div className="text-[10px] text-white/40">{desc}</div>
                </button>
              ))}
            </div>
            <div className="text-[10px] text-white/30">Applies an SVG color matrix to the entire UI; does not affect screen capture.</div>
          </div>
        </section>

        {/* ── VISUAL ───────────────────────── */}
        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Visual</h3>
          <div className="space-y-3">
            <ToggleCard label="High Contrast Mode" desc="Increase contrast for better visibility"
              checked={preferences.highContrast} onToggle={() => set('highContrast', !preferences.highContrast)} />
            <div className="glass-card rounded-r2 p-4 border border-white/10">
              <div className="text-white font-bold text-sm mb-1">Color Saturation — {preferences.saturation}%</div>
              <div className="text-[10px] text-white/40 mb-3">Reduce color intensity if colors are overwhelming</div>
              <input type="range" min={0} max={200} value={preferences.saturation}
                onChange={e => set('saturation', Number(e.target.value))} className="w-full accent-primary" />
              <div className="flex justify-between text-[9px] text-white/30 mt-1">
                <span>Grayscale</span><span>Normal</span><span>Vivid</span>
              </div>
            </div>
          </div>
        </section>

        {/* ── MOTION + PERFORMANCE ─────────── */}
        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Motion & Performance</h3>
          <div className="space-y-3">
            <ToggleCard label="Reduce Motion" desc="Minimize animations and transitions (respects prefers-reduced-motion)"
              checked={preferences.reducedMotion} onToggle={() => set('reducedMotion', !preferences.reducedMotion)} />
            <div className="glass-card rounded-r2 p-4 border border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${perfMode ? 'bg-accent-success/10 text-accent-success' : 'bg-primary/10 text-primary'}`}>
                  <Zap size={18} />
                </div>
                <div>
                  <div className="text-white font-bold text-sm">Performance Mode</div>
                  <div className="text-[10px] text-white/40">Disables blur, glows &amp; animations for low-end devices</div>
                  {perfMode && <div className="text-[9px] text-accent-success/70 mt-0.5">Active — effects reduced</div>}
                </div>
              </div>
              <button type="button" onClick={togglePerfMode} className={`w-11 h-6 rounded-full transition-all relative flex-shrink-0 ${perfMode ? 'bg-accent-success/30' : 'bg-white/10'}`}>
                <div className={`w-5 h-5 rounded-full absolute top-0.5 transition-all ${perfMode ? 'left-[22px] bg-accent-success' : 'left-0.5 bg-white/35'}`} />
              </button>
            </div>
          </div>
        </section>

        {/* ── VOICE (TTS / STT) ────────────── */}
        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Voice Assistance</h3>
          <div className="space-y-3">
            {/* TTS */}
            <div className="glass-card rounded-r2 p-4 border border-white/10 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-white font-bold text-sm">Text-to-Speech</div>
                  <div className="text-[10px] text-white/40">Read incoming messages aloud using the browser's TTS engine</div>
                </div>
                <button type="button" onClick={() => set('ttsEnabled', !preferences.ttsEnabled)}
                  className={`w-11 h-6 rounded-full transition-all relative flex-shrink-0 ${preferences.ttsEnabled ? 'bg-primary/40' : 'bg-white/10'}`}>
                  <div className={`w-5 h-5 rounded-full absolute top-0.5 transition-all ${preferences.ttsEnabled ? 'left-[22px] bg-primary' : 'left-0.5 bg-white/35'}`} />
                </button>
              </div>
              {preferences.ttsEnabled && (
                <div className="flex items-center gap-2">
                  <button type="button" onClick={testTts}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 transition-colors">
                    <Volume2 size={12} /> Test voice
                  </button>
                  {ttsTestResult && <span className="text-[10px] text-white/50">{ttsTestResult}</span>}
                </div>
              )}
            </div>

            {/* STT */}
            <div className="glass-card rounded-r2 p-4 border border-white/10 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-white font-bold text-sm">Speech-to-Text Input</div>
                  <div className="text-[10px] text-white/40">Adds a microphone button to the message composer for voice dictation</div>
                </div>
                <button type="button" onClick={() => set('sttEnabled', !preferences.sttEnabled)}
                  className={`w-11 h-6 rounded-full transition-all relative flex-shrink-0 ${preferences.sttEnabled ? 'bg-primary/40' : 'bg-white/10'}`}>
                  <div className={`w-5 h-5 rounded-full absolute top-0.5 transition-all ${preferences.sttEnabled ? 'left-[22px] bg-primary' : 'left-0.5 bg-white/35'}`} />
                </button>
              </div>
              {preferences.sttEnabled && (
                <div className="space-y-2">
                  <button type="button" onClick={testStt} disabled={sttListening}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-bold transition-colors ${sttListening ? 'border-red-400/40 bg-red-400/10 text-red-400 animate-pulse' : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'}`}>
                    <Mic size={12} /> {sttListening ? 'Listening… (speak now)' : 'Test microphone'}
                  </button>
                  {sttPreview && <div className="rounded-r1 bg-white/5 border border-white/10 px-3 py-2 text-xs text-white/60 font-mono">{sttPreview}</div>}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </>
  );
};

const MobileSection: React.FC<{ showFeedback: (tone: FeedbackTone, message: string) => void }> = ({ showFeedback }) => {
  const snapshot = useRuntimeSnapshot();
  const peerId = snapshot?.identity?.peer_id?.trim() ?? '';
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!peerId) { setQrDataUrl(null); return; }
    QRCode.toDataURL(peerId, { width: 220, margin: 2, color: { dark: '#0d1a1b', light: '#FFFFFF' } })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [peerId]);

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">Mobile Sync</h2>
        <p className="micro-label text-white/30">Key transfer and peer discovery</p>
      </header>

      <div className="space-y-4">
        {peerId && (
          <div className="glass-card rounded-r2 p-5 border border-white/10 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                <QrCode size={18} />
              </div>
              <div>
                <div className="text-white font-bold text-sm">Peer ID QR code</div>
                <div className="text-[10px] text-white/40">Scan this on another device to connect to you over P2P</div>
              </div>
            </div>
            {qrDataUrl && (
              <div className="flex justify-center">
                <img src={qrDataUrl} alt="Peer ID QR code" className="rounded-r2 border-4 border-white w-[180px] h-[180px]" />
              </div>
            )}
            <div className="rounded-r1 bg-bg-0/50 border border-white/10 px-3 py-2 font-mono text-[10px] text-white/60 break-all">{peerId}</div>
            <button
              type="button"
              onClick={() => void copyTextToClipboardSafely(peerId).then(ok => showFeedback(ok ? 'success' : 'info', ok ? 'Peer ID copied.' : 'Clipboard unavailable.'))}
              className="px-4 py-2 rounded-full border border-white/10 text-white/50 text-xs font-bold hover:border-primary/30 hover:text-primary transition-all flex items-center gap-2"
            >
              <Copy size={14} />
              Copy peer ID
            </button>
          </div>
        )}

        <div className="glass-card rounded-r2 p-5 border border-white/10">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-accent-warning/10 flex items-center justify-center text-accent-warning">
              <Download size={18} />
            </div>
            <div>
              <div className="text-white font-bold text-sm">Transfer your full identity to another device</div>
              <div className="text-[10px] text-white/40">Download the encrypted backup on this device, then import it on the other</div>
            </div>
          </div>
          <p className="text-[11px] text-white/50 leading-relaxed">
            Go to <strong className="text-white/70">Security → Encrypted Identity Backup → Download</strong> to get a portable
            encrypted copy of your private keys. Open Harmolyn on your other device, go to
            <strong className="text-white/70"> My Account → Saved Identities → Import</strong> and enter your password to unlock it.
          </p>
        </div>

        <div className="glass-card rounded-r2 p-5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <ShieldAlert size={18} className="text-white/30" />
            <div className="text-white font-bold text-sm">No native app required</div>
          </div>
          <div className="text-[11px] text-white/50 leading-relaxed">
            Harmolyn runs the full xorein P2P stack in-browser. Open the URL in any modern browser on
            your phone to get a full Harmolyn client — no install needed. Then use the key transfer
            flow above to bring your identity across.
          </div>
        </div>
      </div>
    </>
  );
};

// ── Streamer Mode ─────────────────────────────────────────────────────────────

const StreamerSection: React.FC<{ showFeedback: (tone: FeedbackTone, message: string) => void }> = ({ showFeedback }) => {
  const [streamerMode, setStreamerMode] = usePersistentState<boolean>('harmolyn:settings:streamer-mode', false);

  const toggle = () => {
    const next = !streamerMode;
    setStreamerMode(next);
    // Broadcast to other parts of the app via a custom event
    window.dispatchEvent(new CustomEvent('harmolyn:streamer-mode', { detail: { enabled: next } }));
    showFeedback('success', next ? 'Streamer mode enabled — sensitive content hidden.' : 'Streamer mode disabled.');
  };

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">Streamer Mode</h2>
        <p className="micro-label text-white/30">Hide sensitive information during screen sharing</p>
      </header>

      <div className="space-y-4">
        <div className="glass-card rounded-r2 p-5 border border-white/10 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${streamerMode ? 'bg-accent-danger/10 text-accent-danger' : 'bg-white/5 text-white/40'}`}>
              {streamerMode ? <EyeOff size={18} /> : <Eye size={18} />}
            </div>
            <div>
              <div className="text-white font-bold text-sm">Streamer Mode</div>
              <div className="text-[10px] text-white/40">{streamerMode ? 'Active — sensitive content is hidden' : 'Inactive'}</div>
            </div>
          </div>
          <button type="button" onClick={toggle} className={`w-11 h-6 rounded-full transition-all relative ${streamerMode ? 'bg-accent-danger/30' : 'bg-white/10'}`} aria-pressed={streamerMode}>
            <div className={`w-5 h-5 rounded-full absolute top-0.5 transition-all ${streamerMode ? 'left-[22px] bg-accent-danger' : 'left-0.5 bg-white/35'}`} />
          </button>
        </div>

        <div className="glass-card rounded-r2 p-5 border border-white/10 space-y-3">
          <h3 className="text-white font-bold text-sm">What streamer mode hides</h3>
          <ul className="space-y-1.5 text-[11px] text-white/55 leading-relaxed">
            {[
              'All toast notifications and pop-ups',
              'Your display name and avatar in the user bar',
              'Channel and server names (replaced with neutral labels)',
              'Message contents — blurred until you hover',
              'Peer IDs and cryptographic fingerprints',
              'Invite links and connection info',
            ].map(item => (
              <li key={item} className="flex items-start gap-2">
                <EyeOff size={11} className="text-white/30 mt-0.5 flex-shrink-0" />
                {item}
              </li>
            ))}
          </ul>
          <SecurityNote tone="info">
            Streamer mode is a local UI overlay only. It does not affect what is transmitted over the network.
            Others on the server can still see your messages and presence normally.
          </SecurityNote>
        </div>
      </div>
    </>
  );
};

// ── Audio & Video Settings ──────────────────────────────────────────────────

interface AudioVideoPreferences {
  micDevice: string;
  speakerDevice: string;
  cameraDevice: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  highFidelityAudio: boolean;
  ultraLowLatency: boolean;
  voiceBitrate: 'low' | 'medium' | 'high' | 'studio';
  videoBitrate: 'low' | 'medium' | 'high' | 'ultra';
  videoQuality: '360p' | '480p' | '720p' | '1080p' | '1440p' | '2160p';
  videoFrameRate: 30 | 60;
  micVolume: number;
  speakerVolume: number;
}

const AV_DEFAULTS: AudioVideoPreferences = {
  micDevice: 'default',
  speakerDevice: 'default',
  cameraDevice: 'default',
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  highFidelityAudio: false,
  ultraLowLatency: false,
  voiceBitrate: 'high',
  videoBitrate: 'high',
  videoQuality: '720p',
  videoFrameRate: 30,
  micVolume: 80,
  speakerVolume: 100,
};

// Live microphone input meter — real data via getUserMedia + AnalyserNode.
// No fabricated levels: it only animates while a real mic stream is active.
type MicMeterStatus = 'idle' | 'requesting' | 'active' | 'denied' | 'unsupported';

const MicInputMeter: React.FC<{ deviceId?: string }> = ({ deviceId }) => {
  const [status, setStatus] = useState<MicMeterStatus>('idle');
  const [level, setLevel] = useState(0); // 0..1 RMS
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      void audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
    setLevel(0);
  }, []);

  // Always release the mic + audio graph on unmount.
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioCtx) {
      setStatus('unsupported');
      return;
    }
    setStatus('requesting');
    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.fftSize);
      setStatus('active');

      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = (buffer[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / buffer.length);
        // Light scaling so normal speech reaches the upper band without clipping.
        setLevel(Math.min(1, rms * 2.2));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      stop();
      const name = err instanceof DOMException ? err.name : '';
      setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unsupported');
    }
  }, [deviceId, stop]);

  // Restart against the newly selected device while the meter is running.
  useEffect(() => {
    if (status === 'active') {
      stop();
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const running = status === 'active';
  const pct = Math.round(level * 100);
  // Green below ~60%, yellow to ~85%, red at the top — like a typical input meter.
  // Matches the Tailwind accent palette (accent-success/warning/danger).
  const barColor = pct >= 85 ? '#FF2A6D' : pct >= 60 ? '#FFB020' : '#05FFA1';

  return (
    <div className="glass-card rounded-r2 p-4 border border-white/10 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio size={14} className={running ? 'text-accent-success' : 'text-white/40'} />
          <div className="text-sm text-white font-medium">Mic input level</div>
        </div>
        <button
          type="button"
          onClick={() => (running || status === 'requesting' ? stop() : void start())}
          disabled={status === 'unsupported'}
          className={`px-3 py-1.5 rounded-full border text-[11px] font-bold transition-all focus-ring disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 ${running ? 'border-accent-danger/40 bg-accent-danger/10 text-accent-danger' : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'}`}
        >
          <Mic size={12} />
          {status === 'requesting' ? 'Starting…' : running ? 'Stop test' : 'Test mic'}
        </button>
      </div>

      {/* Meter track — width reflects real RMS; only animates while a stream is live. */}
      <div
        className="h-3 w-full rounded-full bg-bg-0/70 border border-white/10 overflow-hidden"
        role="meter"
        aria-label="Microphone input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={running ? pct : 0}
      >
        <div
          className="h-full rounded-full transition-[width] duration-75"
          style={{ width: `${running ? pct : 0}%`, background: barColor }}
        />
      </div>

      {status === 'idle' && (
        <p className="text-[10px] text-white/40">Press “Test mic” and speak — the bar shows your live input level. Your browser will ask for microphone permission.</p>
      )}
      {status === 'requesting' && (
        <p className="text-[10px] text-white/40">Waiting for microphone permission…</p>
      )}
      {status === 'active' && (
        <p className="text-[10px] text-accent-success/70">Listening — speak normally to see your level. Nothing is recorded or transmitted.</p>
      )}
      {status === 'denied' && (
        <p className="text-[10px] text-accent-danger/80">Microphone access was blocked. Allow microphone permission for this site, then try again.</p>
      )}
      {status === 'unsupported' && (
        <p className="text-[10px] text-white/40">Live mic metering is not available in this browser context.</p>
      )}
    </div>
  );
};

const AudioVideoSection: React.FC = () => {
  const [prefs, setPrefs] = usePersistentState<AudioVideoPreferences>('harmolyn:settings:audio-video', AV_DEFAULTS);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    const refresh = () => { navigator.mediaDevices?.enumerateDevices?.().then(setDevices).catch(() => {}); };
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => { navigator.mediaDevices?.removeEventListener?.('devicechange', refresh); };
  }, []);

  const mics = devices.filter(d => d.kind === 'audioinput');
  const speakers = devices.filter(d => d.kind === 'audiooutput');
  const cameras = devices.filter(d => d.kind === 'videoinput');

  const DeviceSelect = ({ label, icon, devices: devs, value, field }: { label: string; icon: React.ReactNode; devices: MediaDeviceInfo[]; value: string; field: keyof AudioVideoPreferences }) => (
    <div className="glass-card rounded-r2 p-4 border border-white/10 space-y-2">
      <div className="flex items-center gap-2">
        <div className="text-primary/70">{icon}</div>
        <div className="text-white font-bold text-sm">{label}</div>
      </div>
      {devs.length === 0 ? (
        <div className="text-[10px] text-white/30 italic">No devices found — browser permission may be required</div>
      ) : (
        <select
          value={value}
          onChange={e => setPrefs(p => ({ ...p, [field]: e.target.value }))}
          className="w-full h-10 px-3 rounded-r1 bg-surface-dark border border-stroke-subtle text-white text-[11px] focus:border-primary focus:outline-none"
        >
          <option value="default">System default</option>
          {devs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Device ${d.deviceId.slice(0, 8)}`}</option>)}
        </select>
      )}
    </div>
  );

  const TogglePref = ({ label, desc, field }: { label: string; desc: string; field: keyof AudioVideoPreferences }) => (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-white text-sm font-medium">{label}</div>
        <div className="text-[10px] text-white/40">{desc}</div>
      </div>
      <button
        type="button"
        onClick={() => setPrefs(p => ({ ...p, [field]: !p[field] }))}
        className={`w-11 h-6 rounded-full transition-all relative flex-shrink-0 ${prefs[field] ? 'bg-primary/30' : 'bg-white/10'}`}
      >
        <div className={`w-5 h-5 rounded-full absolute top-0.5 transition-all ${prefs[field] ? 'left-[22px] bg-primary' : 'left-0.5 bg-white/35'}`} />
      </button>
    </div>
  );

  const bitrateLabels = { low: 'Low (~48 kbps)', medium: 'Medium (~128 kbps)', high: 'High (~256 kbps)', studio: 'Studio (510 kbps · stereo)' };
  const videoBitrateLabels = { low: 'Low (~1 Mbps)', medium: 'Medium (~4 Mbps)', high: 'High (~12 Mbps)', ultra: 'Ultra (~40 Mbps)' };

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">Audio & Video</h2>
        <p className="micro-label text-white/30">Devices, codecs, and quality settings</p>
      </header>

      <div className="space-y-6">
        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Devices</h3>
          <div className="space-y-3">
            <DeviceSelect label="Microphone" icon={<Mic size={16} />} devices={mics} value={prefs.micDevice} field="micDevice" />
            <DeviceSelect label="Speaker / Headphones" icon={<Volume2 size={16} />} devices={speakers} value={prefs.speakerDevice} field="speakerDevice" />
            <DeviceSelect label="Camera" icon={<Camera size={16} />} devices={cameras} value={prefs.cameraDevice} field="cameraDevice" />
          </div>
        </section>

        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Volume</h3>
          <div className="glass-card rounded-r2 p-4 border border-white/10 space-y-4">
            <div>
              <div className="flex justify-between mb-1.5">
                <div className="text-sm text-white font-medium flex items-center gap-1.5"><Mic size={14} /> Microphone volume</div>
                <span className="text-[10px] text-white/40">{prefs.micVolume}%</span>
              </div>
              <input type="range" min={0} max={100} value={prefs.micVolume} onChange={e => { const v = Number(e.target.value); setPrefs(p => ({ ...p, micVolume: v })); setVoiceMicVolume(v); }} className="w-full accent-primary" />
            </div>
            <div>
              <div className="flex justify-between mb-1.5">
                <div className="text-sm text-white font-medium flex items-center gap-1.5"><Volume2 size={14} /> Speaker volume</div>
                <span className="text-[10px] text-white/40">{prefs.speakerVolume}%</span>
              </div>
              <input type="range" min={0} max={100} value={prefs.speakerVolume} onChange={e => setPrefs(p => ({ ...p, speakerVolume: Number(e.target.value) }))} className="w-full accent-primary" />
            </div>
          </div>
        </section>

        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Mic Test</h3>
          <MicInputMeter deviceId={prefs.micDevice} />
        </section>

        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Audio Processing</h3>
          <div className="glass-card rounded-r2 p-4 border border-white/10 space-y-4">
            <TogglePref label="High-fidelity / Music mode" desc="Studio-grade stereo Opus. Disables the filters below — best for music or with headphones (open speakers may echo)." field="highFidelityAudio" />
            <div className="border-t border-white/5" />
            <div className={prefs.highFidelityAudio ? 'opacity-40 pointer-events-none space-y-4' : 'space-y-4'} aria-disabled={prefs.highFidelityAudio}>
              <TogglePref label="Noise Suppression" desc="Filters background noise from your microphone" field="noiseSuppression" />
              <div className="border-t border-white/5" />
              <TogglePref label="Echo Cancellation" desc="Prevents your speakers from being picked up by your mic" field="echoCancellation" />
              <div className="border-t border-white/5" />
              <TogglePref label="Auto Gain Control" desc="Automatically adjusts microphone sensitivity" field="autoGainControl" />
            </div>
          </div>
        </section>

        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Voice Quality</h3>
          <div className="glass-card rounded-r2 p-4 border border-white/10 space-y-3">
            <div className="text-[10px] text-white/40 mb-1">Audio bitrate — codec is always Opus (full-band 48 kHz). It's peer-to-peer, so spend as much bandwidth as you like.</div>
            {(['low', 'medium', 'high', 'studio'] as const).map(b => (
              <button key={b} type="button" onClick={() => setPrefs(p => ({ ...p, voiceBitrate: b }))} className={`w-full flex items-center justify-between px-4 py-3 rounded-r1 border transition-all ${prefs.voiceBitrate === b ? 'border-primary/40 bg-primary/10 text-white' : 'border-white/5 text-white/50 hover:bg-white/5'}`}>
                <span className="font-bold text-xs capitalize">{b}</span>
                <span className="text-[10px] text-white/40">{bitrateLabels[b]}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Latency</h3>
          <div className="glass-card rounded-r2 p-4 border border-white/10 space-y-3">
            <TogglePref
              label="Ultra-low-latency mode"
              desc="10 ms Opus packets + minimal jitter buffer. Best on a fast/nearby link; may glitch over long-distance or lossy connections."
              field="ultraLowLatency"
            />
            <p className="text-[10px] text-white/35 leading-relaxed border-t border-white/5 pt-3">
              This only trims the part of latency we control (encoder + jitter buffer). The network distance between
              peers is the floor — the speed of light alone is ~35–80 ms each way between continents, which no setting can beat.
            </p>
          </div>
        </section>

        <section>
          <h3 className="micro-label text-white/40 border-b border-white/5 pb-2 mb-4">Video Quality</h3>
          <div className="glass-card rounded-r2 p-4 border border-white/10 space-y-3">
            <div className="text-[10px] text-white/40 mb-1">Resolution — codec negotiates AV1 ▸ VP9 ▸ H.264 ▸ VP8 (best both peers support). Peer-to-peer: push it as high as your hardware allows.</div>
            {(['360p', '480p', '720p', '1080p', '1440p', '2160p'] as const).map(q => (
              <button key={q} type="button" onClick={() => setPrefs(p => ({ ...p, videoQuality: q }))} className={`w-full flex items-center justify-between px-4 py-3 rounded-r1 border transition-all ${prefs.videoQuality === q ? 'border-primary/40 bg-primary/10 text-white' : 'border-white/5 text-white/50 hover:bg-white/5'}`}>
                <span className="font-bold text-xs">{q === '2160p' ? '2160p (4K)' : q}</span>
                {q === '720p' && <span className="text-[10px] text-primary/70 font-bold">RECOMMENDED</span>}
                {q === '2160p' && <span className="text-[10px] text-white/30 font-bold">DEMANDING</span>}
              </button>
            ))}
            <div className="border-t border-white/5 pt-3">
              <div className="text-[10px] text-white/40 mb-2">Frame rate</div>
              <div className="flex gap-2">
                {([30, 60] as const).map(fps => (
                  <button key={fps} type="button" onClick={() => setPrefs(p => ({ ...p, videoFrameRate: fps }))} className={`flex-1 px-4 py-2.5 rounded-r1 border text-xs font-bold transition-all ${prefs.videoFrameRate === fps ? 'border-primary/40 bg-primary/10 text-white' : 'border-white/5 text-white/50 hover:bg-white/5'}`}>
                    {fps} fps
                  </button>
                ))}
              </div>
            </div>
            <div className="border-t border-white/5 pt-3">
              <div className="text-[10px] text-white/40 mb-2">Video bitrate</div>
              {(['low', 'medium', 'high', 'ultra'] as const).map(b => (
                <button key={b} type="button" onClick={() => setPrefs(p => ({ ...p, videoBitrate: b }))} className={`w-full flex items-center justify-between px-4 py-3 rounded-r1 border transition-all mb-1 ${prefs.videoBitrate === b ? 'border-primary/40 bg-primary/10 text-white' : 'border-white/5 text-white/50 hover:bg-white/5'}`}>
                  <span className="font-bold text-xs capitalize">{b}</span>
                  <span className="text-[10px] text-white/40">{videoBitrateLabels[b]}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <SecurityNote tone="info">
          Mic volume applies live, in or out of a call. Other settings (devices, codec, resolution, bitrate) apply on your next call. All preferences are stored locally on this device.
          Latency is mostly the network distance between peers — the speed of light sets the floor — so these knobs control quality and the small encoder/buffer portion, not wall-clock latency across continents.
        </SecurityNote>
      </div>
    </>
  );
};

const NetworkSection: React.FC<{
  runtimeSnapshot?: XoreinRuntimeSnapshot | null;
  showFeedback: (tone: FeedbackTone, message: string) => void;
  registerRelayMutation: ReturnType<typeof useRegisterRelay>;
  removeRelayMutation: ReturnType<typeof useRemoveRelay>;
  onOpenNodeLaunch?: () => void;
}> = ({ runtimeSnapshot, showFeedback, registerRelayMutation, removeRelayMutation, onOpenNodeLaunch }) => {
  const [relayInput, setRelayInput] = useState('');
  const relayAddrs = normalizeRelayAddrs(runtimeSnapshot?.relay_addrs);

  const handleRegisterRelay = async () => {
    const multiaddr = relayInput.trim();
    if (!multiaddr) {
      showFeedback('error', 'Enter a relay multiaddr before adding it.');
      return;
    }
    try {
      await registerRelayMutation.mutateAsync({ multiaddr });
      setRelayInput('');
      showFeedback('success', 'Relay registered through xorein.');
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to add relay.');
    }
  };

  const handleRemoveRelay = async (multiaddr: string) => {
    try {
      await removeRelayMutation.mutateAsync({ multiaddr });
      showFeedback('success', 'Relay removed through xorein.');
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to remove relay.');
    }
  };

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">Network &amp; relays</h2>
        <p className="micro-label text-white/30">Node and relay routing</p>
      </header>

      <div className="space-y-4">
        <div className="glass-card rounded-r2 p-5 border border-white/10">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-white font-bold text-sm">Control node</div>
              <div className="text-[10px] text-white/40 break-all">
                {runtimeSnapshot?.control_endpoint || 'No control endpoint is active in this session.'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenNodeLaunch?.()}
              className="rounded-full bg-primary text-bg-0 px-4 py-2 font-bold text-xs hover:shadow-glow transition-all inline-flex items-center gap-2"
            >
              <Globe size={14} />
              Switch Node
            </button>
          </div>
        </div>

        <div className="glass-card rounded-r2 p-5 border border-white/10">
          <div className="text-white font-bold text-sm mb-3">Relay multiaddr</div>
          <div className="flex gap-2">
            <input
              aria-label="Relay multiaddr"
              value={relayInput}
              onChange={(e) => setRelayInput(e.target.value)}
              placeholder="/ip4/127.0.0.1/tcp/4001/p2p/..."
              className="flex-1 bg-surface-dark border border-white/10 rounded-full px-4 py-2 text-sm text-white placeholder:text-white/20 focus:border-primary/40 focus:outline-none"
            />
            <PendingButton
              type="button"
              onClick={() => void handleRegisterRelay()}
              pending={registerRelayMutation.isPending}
              pendingLabel="Adding…"
              spinnerSize={14}
              className="px-4 py-2 rounded-full bg-primary text-bg-0 text-xs font-bold flex items-center gap-2"
            >Add Relay</PendingButton>
          </div>
        </div>

        <div className="space-y-2">
          {relayAddrs.length > 0 ? relayAddrs.map((relay) => (
            <div key={relay} className="glass-card rounded-r2 p-4 border border-white/10 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-white font-mono text-xs break-all">{relay}</div>
              </div>
              <button type="button" className="text-accent-danger text-xs font-bold hover:underline" onClick={() => void handleRemoveRelay(relay)}>Remove</button>
            </div>
          )) : (
            <div className="text-white/30 text-xs">No relays are registered in the current runtime snapshot.</div>
          )}
        </div>
      </div>
    </>
  );
};

function normalizeRelayAddrs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const relay = entry.trim();
    if (!relay || seen.has(relay)) {
      continue;
    }
    seen.add(relay);
    normalized.push(relay);
  }
  return normalized;
}

const AboutSection: React.FC = () => {
  const [openDoc, setOpenDoc] = useState<'terms' | 'privacy' | 'guidelines' | null>(null);
  const legalLinks: { id: 'terms' | 'privacy' | 'guidelines'; title: string; desc: string }[] = [
    { id: 'terms', title: 'Terms of Service', desc: 'The agreement for using this instance' },
    { id: 'privacy', title: 'Privacy Policy', desc: 'What is (and isn’t) collected' },
    { id: 'guidelines', title: 'Community Guidelines', desc: 'Acceptable use — the rules for everyone' },
  ];
  return (
  <>
    <header className="mb-10">
      <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">ABOUT // LEGAL</h2>
      <p className="micro-label text-white/30">TERMS // PRIVACY // LICENSE</p>
    </header>

    {openDoc && <LegalDocViewer docId={openDoc} onClose={() => setOpenDoc(null)} />}

    <div className="space-y-4">
      <div className="grid gap-3">
        {legalLinks.map((link) => (
          <button
            key={link.id}
            onClick={() => setOpenDoc(link.id)}
            className="focus-ring text-left glass-card rounded-r2 p-5 border border-white/10 flex items-center justify-between group hover:border-primary/30 transition-all"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                <FileText size={18} />
              </div>
              <div>
                <div className="text-white font-bold text-sm">{link.title}</div>
                <div className="text-[10px] text-white/40">{link.desc}</div>
              </div>
            </div>
            <ExternalLink size={16} className="text-white/30 group-hover:text-primary" />
          </button>
        ))}
      </div>

      <div className="glass-card rounded-r2 p-5 border border-white/10">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
            <Shield size={18} />
          </div>
          <div>
            <div className="text-white font-bold text-sm">Harmolyn <span className="font-mono text-[10px] text-white/40 ml-1">v{APP_VERSION}</span></div>
            <div className="text-[10px] text-white/40">End-user chat client for the xorein P2P network</div>
          </div>
        </div>
        <p className="text-[11px] text-white/50 leading-relaxed">
          Harmolyn is free software, licensed under the GNU Affero General Public License,
          version 3 or later (AGPL-3.0-or-later).
        </p>
      </div>

      <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener" className="glass-card rounded-r2 p-5 border border-white/10 flex items-center justify-between group hover:border-primary/30 transition-all">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-accent-success/10 flex items-center justify-center text-accent-success">
            <Globe size={18} />
          </div>
          <div>
            <div className="text-white font-bold text-sm">Source code</div>
            <div className="text-[10px] text-white/40 break-all">{SOURCE_URL}</div>
          </div>
        </div>
        <ExternalLink size={16} className="text-white/30 group-hover:text-primary" />
      </a>

      <a href={LICENSE_URL} target="_blank" rel="noreferrer noopener" className="glass-card rounded-r2 p-5 border border-white/10 flex items-center justify-between group hover:border-primary/30 transition-all">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-accent-purple/10 flex items-center justify-center text-accent-purple">
            <Scale size={18} />
          </div>
          <div>
            <div className="text-white font-bold text-sm">License (AGPL-3.0)</div>
            <div className="text-[10px] text-white/40">Read the full GNU Affero General Public License</div>
          </div>
        </div>
        <ExternalLink size={16} className="text-white/30 group-hover:text-primary" />
      </a>

      <div className="glass-card rounded-r2 p-5 border border-white/10">
        <div className="text-white font-bold text-sm mb-1">Network use &amp; your rights</div>
        <p className="text-[11px] text-white/50 leading-relaxed">
          Because Harmolyn communicates over a network with a xorein node, the AGPL (section 13)
          entitles everyone who interacts with it to the complete corresponding source of this build.
          Operators who modify and deploy Harmolyn must publish their changes and point this link at them.
        </p>
      </div>

      <div className="glass-card rounded-r2 p-5 border border-white/10">
        <div className="text-white font-bold text-sm mb-1">Documentation &amp; protocol</div>
        <p className="text-[11px] text-white/50 leading-relaxed">
          Protocol specifications and documentation are licensed{' '}
          <a href={SPEC_LICENSE_URL} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">CC-BY-SA 4.0</a>.
        </p>
      </div>
    </div>
  </>
  );
};

const ToggleCard: React.FC<{ label: string; desc: string; checked: boolean; onToggle: () => void }> = ({ label, desc, checked, onToggle }) => (
  <div className="glass-card rounded-r2 p-4 border border-white/10 flex items-center justify-between">
    <div>
      <div className="text-white font-bold text-sm">{label}</div>
      <div className="text-[10px] text-white/40">{desc}</div>
    </div>
    <button type="button" onClick={onToggle} className={`w-11 h-6 rounded-full transition-all relative ${checked ? 'bg-primary/30' : 'bg-white/10'}`} aria-pressed={checked} aria-label={label}>
      <div className={`w-5 h-5 rounded-full absolute top-0.5 transition-all ${checked ? 'left-[22px] bg-primary' : 'left-0.5 bg-white/35'}`} />
    </button>
  </div>
);

function isValidIdentityLink(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:' || parsed.protocol === 'aether:';
  } catch {
    return false;
  }
}

function isValidImageUrl(value: string): boolean {
  if (/^data:image\//.test(value)) {
    return !/^data:image\/svg\+xml(?:;|,)/i.test(value);
  }

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    return false;
  }

  const url = safeParseUrl(value);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return false;
  }

  const path = `${url.pathname}${url.search}`.toLowerCase();
  return !/\.(svgz?|svg\+xml)(?:$|[?#])/i.test(path);
}

