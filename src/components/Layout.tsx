import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';
import { AnimatePresence, motion } from 'framer-motion';
import { FullScreenOverlay } from '@/lib/animationOverlays';
import { ServerRail } from '@/components/ServerRail';
import { ChannelRail } from '@/components/ChannelRail';
import { ChatArea } from '@/components/ChatArea';
import { MemberSidebar } from '@/components/MemberSidebar';
import { WelcomeEmptyState } from '@/components/WelcomeEmptyState';
import { CreateServerModal } from '@/components/CreateServerModal';
import { JoinServerModal } from '@/components/JoinServerModal';
import { FriendsPanel } from '@/components/FriendsPanel';
import { QuickSwitcher } from '@/components/QuickSwitcher';
import { KeyboardShortcutsOverlay } from '@/components/KeyboardShortcutsOverlay';
import { ForumChannel } from '@/components/ForumChannel';
import { AnnouncementChannel } from '@/components/AnnouncementChannel';
import { ChannelKindSwitcher, type ChannelKind } from '@/components/ChannelKindSwitcher';
import { ScreenSharePanel } from '@/components/voice/ScreenSharePanel';
import { VoiceAudioSinks } from '@/components/voice/VoiceAudioSinks';
import { VoiceVideoSinks } from '@/components/voice/VoiceVideoSinks';
import { RecoveryConsentPrompt } from '@/components/RecoveryConsentPrompt';
import { StreamerModeProvider, StreamerTopBar, StreamerServerReveal } from '@/components/streamer/StreamerMode';
import { AuthFlow, type AuthStep } from '@/components/auth/AuthFlow';
import { UnlockScreen } from '@/components/auth/UnlockScreen';
import { NodeLaunchScreen } from '@/components/NodeLaunchScreen';
import { useNativeEngine } from '@/native/engine/provider';
import { resetLocalIdentity } from '@/lib/xoreinClientProvider';
import { useFeature } from '@/hooks/useFeature';
import { type VoiceControlState } from '@/components/voice/VoiceControlBar';
import { deriveConnectionState, readShellRuntimeData, subscribeShellRuntimeData } from '@/data';
import {
  clearPreferredControlEndpoint,
  connectToControlEndpoint,
  connectToDefaultRuntime,
  type ControlEndpointTestResult,
  DEFAULT_CONTROL_ENDPOINT,
  normalizeLaunchControlEndpoint,
  readPreferredControlEndpoint,
  storePreferredControlEndpoint,
  testControlEndpoint,
} from '@/lib/xoreinControl';
import { consumePendingNativeDeepLinks } from '@/lib/xoreinControl';
import { useRuntimeMutations } from '@/hooks/runtime/useRuntimeMutations';
import { parseJoinDeepLink } from '@/protocol/deeplink';
import { copyTextToClipboardSafely } from '@/components/contextMenuUtils';
import { useToast } from '@/lib/toastBus';
import { handleNativeDeepLink } from '@/protocol/nativeDeepLink';
import { Channel, AppState, ConnectionState, MessageLayout, XoreinRuntimeSnapshot, XoreinRuntimeVoiceSession } from '@/types';
import { AlertTriangle, Home, Compass, Users as UsersIcon, Settings as SettingsIcon, Menu, Loader2 } from 'lucide-react';
import { generateTheme } from '@/utils/themeGenerator';
import { safeStorageGet, safeStorageSet } from '@/lib/browserStorage';
import { ProductTour, TOUR_DISMISSED_KEY } from '@/components/onboarding/ProductTour';
import { applyStoredAccessibilityPrefs } from '@/lib/accessibility';
import { usePersistentState } from '@/hooks/usePersistentState';
import { safeLocationSearch } from '@/lib/browserLocation';
import { safeViewportSize } from '@/lib/browserViewport';
import { normalizeLayoutUsers, normalizeRuntimePeerId, normalizeRuntimeVoiceSession, resolveLayoutDirectMessageUser } from './layoutRuntime';
import { useRuntimeBootstrapState } from '@/lib/xoreinRuntimeContext';
import {
  FRIEND_REQUEST_BADGE_PREFERENCE_EVENT,
  readFriendRequestBadgeEnabled,
  readNotificationPreferences,
  type FriendRequestBadgePreferenceDetail,
} from './NotificationSettings';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useNodeHealth } from '@/hooks/useNodeHealth';
import { NODE_OFFLINE_BANNER_TITLE, NODE_OFFLINE_BANNER_DETAIL } from '@/lib/nodeHealth';

const MESSAGE_LAYOUT_STORAGE_KEY = 'harmolyn:settings:message-layout';

const SettingsScreen = React.lazy(() => import('@/components/SettingsScreen').then((module) => ({ default: module.SettingsScreen })));
const ServerSettingsScreen = React.lazy(() => import('@/components/ServerSettingsScreen').then((module) => ({ default: module.ServerSettingsScreen })));
const ServerExplorer = React.lazy(() => import('@/components/ServerExplorer').then((module) => ({ default: module.ServerExplorer })));

const DeferredSurfaceFallback = ({ label }: { label: string }) => (
  <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center bg-bg-0" role="status" aria-label={`Loading ${label}`}>
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/55">
      <Loader2 size={15} className="animate-spin text-primary" />
      Loading {label}…
    </div>
  </div>
);

function readResponsiveMode(): { isMobile: boolean; isTablet: boolean } {
  const width = safeViewportSize().width;
  return {
    isMobile: width !== null && width < 600,
    isTablet: width !== null && width >= 600 && width < 1100,
  };
}

function readStoredMessageLayout(): MessageLayout {
  if (typeof window === 'undefined') {
    return 'modern';
  }

  const stored = safeStorageGet(() => window.localStorage, MESSAGE_LAYOUT_STORAGE_KEY);
  if (stored === 'modern' || stored === 'bubbles' || stored === 'terminal') {
    return stored;
  }

  return 'modern';
}

export const Layout: React.FC = () => {
  // Apply saved accessibility preferences on startup so they take effect before
  // the user opens the settings page (e.g. font size persists across reloads).
  useEffect(() => {
    applyStoredAccessibilityPrefs();
  }, []);

  const shellData = useSyncExternalStore(subscribeShellRuntimeData, readShellRuntimeData, readShellRuntimeData);
  const initialUtilityScreen = readRequestedUtilityScreen();
  const [state, setState] = useState<AppState>(() => {
    const initialResponsiveMode = readResponsiveMode();
    const compact = initialResponsiveMode.isMobile || initialResponsiveMode.isTablet;
    return {
      activeServerId: shellData.initialServerId,
      activeChannelId: shellData.initialChannelId,
      connectedVoiceChannelId: null,
      viewMode: 'chat',
      messageLayout: readStoredMessageLayout(),
      mobileMenuOpen: false,
      memberListCollapsed: compact,
      channelListCollapsed: compact,
      showCreateServer: false,
      showSettings: false,
    };
  });

  // First-run welcome: shown once to a brand-new visitor (no dismissed flag yet).
  // It opens the AuthFlow on its friendly welcome step rather than dumping the
  // heavy security primer on load (the primer is one tap away via "learn more").
  const [showWelcome, setShowWelcome] = useState(() => !safeStorageGet(() => window.localStorage, 'harmolyn_onboarding_dismissed'));
  const [showTour, setShowTour] = useState(false);
  const hasProductTour = useFeature('communityOnboarding');
  const [showFriends, setShowFriends] = useState(initialUtilityScreen === 'friends');
  const [friendRequestBadgeEnabled, setFriendRequestBadgeEnabled] = useState(readFriendRequestBadgeEnabled);
  const [authScreen, setAuthScreen] = useState<'welcome' | 'login' | 'register' | null>(initialUtilityScreen === 'login' || initialUtilityScreen === 'register' ? initialUtilityScreen : null);
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false);
  const [showJoinServer, setShowJoinServer] = useState(false);
  const [joinDraft, setJoinDraft] = useState('');
  const hasQuickSwitcher = useFeature('quickSwitcher');
  const hasForumChannels = useFeature('forumChannels');
  const hasAnnouncementChannels = useFeature('announcementChannels');
  const hasServerDiscovery = useFeature('serverDiscovery');
  const hasScreenShare = useFeature('screenShare');
  const currentPeerId = normalizeRuntimePeerId(shellData.runtimeSnapshot?.identity?.peer_id);
  const identityDisplayName = typeof shellData.runtimeSnapshot?.identity?.profile?.display_name === 'string'
    ? shellData.runtimeSnapshot.identity.profile.display_name.trim()
    : '';
  const hasIdentity = Boolean(currentPeerId && identityDisplayName);
  const connectedVoiceSession = state.connectedVoiceChannelId
    ? normalizeRuntimeVoiceSession(shellData.runtimeSnapshot?.voice_sessions?.find((session) => session.channel_id === state.connectedVoiceChannelId) ?? null)
    : null;
  const hasSeenRuntimeRef = useRef(Boolean(currentPeerId));
  const bootstrapState = useRuntimeBootstrapState();
  const runtimeMutations = useRuntimeMutations();
  const toast = useToast();
  const { engine: nativeEngine, hasRegisteredIdentity } = useNativeEngine();

  // Incoming friend requests waiting on us (used for the rail/Friends badge).
  const incomingFriendRequests = (shellData.runtimeSnapshot?.friend_requests ?? [])
    .filter((r) => r.status === 'pending' && r.from_peer_id && r.from_peer_id !== currentPeerId).length;

  // The badge is deliberately opt-out: it is a durable indication that an incoming
  // request still needs action, unlike the transient toast. Keep it synchronised
  // in this tab and across other tabs/settings windows without polling storage.
  useEffect(() => {
    const sync = (event?: Event) => {
      const detail = (event as CustomEvent<FriendRequestBadgePreferenceDetail> | undefined)?.detail;
      setFriendRequestBadgeEnabled(typeof detail?.enabled === 'boolean'
        ? detail.enabled
        : readFriendRequestBadgeEnabled());
    };
    window.addEventListener(FRIEND_REQUEST_BADGE_PREFERENCE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(FRIEND_REQUEST_BADGE_PREFERENCE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const desktopNotifications = useFeature('desktopNotifications');
  const isOnline = useOnlineStatus();
  const { nodeOffline } = useNodeHealth();

  // Request desktop Notification permission on the FIRST user gesture, never on
  // cold load. A permission prompt before the user has interacted is a dark pattern
  // and browsers tend to auto-block it; deferring to a real interaction is both
  // more respectful and more likely to be granted.
  useEffect(() => {
    if (!desktopNotifications || typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    // Honor the user's stored Desktop Notifications toggle: if they've turned it off we
    // must NOT prompt — otherwise the very pointer-down that flips the toggle off would
    // itself open the OS permission dialog before the toggle's click handler runs.
    if (!readNotificationPreferences().desktopEnabled) return;
    const ask = () => {
      window.removeEventListener('pointerdown', ask);
      window.removeEventListener('keydown', ask);
      // Re-check at gesture time: the preference may have changed since we registered.
      if (Notification.permission === 'default' && readNotificationPreferences().desktopEnabled) {
        void Notification.requestPermission();
      }
    };
    window.addEventListener('pointerdown', ask, { once: true });
    window.addEventListener('keydown', ask, { once: true });
    return () => {
      window.removeEventListener('pointerdown', ask);
      window.removeEventListener('keydown', ask);
    };
  }, [desktopNotifications]);

  // Notifications: the native layer dispatches `harmolyn:notify` CustomEvents for
  // friend requests, DMs, and server membership changes (it runs outside React and
  // can't reach the toast bus directly). Forward them to the toast stack so the
  // recipient actually sees them. When the tab is hidden, also fire a desktop
  // Notification so the user sees the event without needing the tab focused.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { kind?: string; title?: string; body?: string } | undefined;
      if (!detail || !detail.body) return;
      // Honor the user's notification preferences (previously stored but never read):
      //  • "Nothing" mutes everything;
      //  • "Mentions only" keeps direct events (DMs, friend requests, direct
      //    mentions) but drops broadcast @everyone/@role notices;
      //  • suppressEveryone/suppressRoles drop those broadcast pings specifically.
      const prefs = readNotificationPreferences();
      if (prefs.globalLevel === 'none') return;
      const kind = detail.kind ?? '';
      if (prefs.suppressEveryone && kind === 'everyone') return;
      if (prefs.suppressRoles && kind === 'role') return;
      if (prefs.globalLevel === 'mentions' && (kind === 'everyone' || kind === 'role' || kind === 'channel')) return;
      toast.info(detail.body, detail.title || 'Harmolyn');
      if (
        desktopNotifications &&
        prefs.desktopEnabled &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        typeof document !== 'undefined' &&
        document.hidden
      ) {
        try {
          new Notification(detail.title || 'Harmolyn', { body: detail.body });
        } catch { /* non-fatal: some environments block Notification construction */ }
      }
    };
    window.addEventListener('harmolyn:notify', handler as EventListener);
    return () => window.removeEventListener('harmolyn:notify', handler as EventListener);
  }, [toast, desktopNotifications]);
  // Show the unlock overlay whenever a registered (password-protected) identity
  // exists but the engine has not been unlocked yet (no live engine). Keying on
  // engine presence — not the transient 'locked'/'starting' state — keeps the
  // overlay mounted across an unlock attempt so its error/retry state survives,
  // and never re-pops it after a later transport hiccup once unlocked.
  const identityLocked = hasRegisteredIdentity && !nativeEngine;

  // Which AuthFlow step to show, if any. Once opened, the flow stays mounted until
  // explicitly closed — so registering (which flips hasIdentity true) does NOT
  // unmount it mid-flow and skip the key-reveal step. The locked-unlock screen
  // takes precedence over all of these (handled at the render site).
  const authFlowStep: AuthStep | null =
    authScreen === 'welcome' ? 'welcome'
    : authScreen === 'register' ? 'create'
    : authScreen === 'login' ? 'picker'
    : null;
  const closeAuthFlow = useCallback(() => {
    setAuthScreen(null);
    setShowWelcome(false);
    safeStorageSet(() => window.localStorage, 'harmolyn_onboarding_dismissed', 'true');
  }, []);

  // Auto-open the first-run welcome once for a brand-new guest (no identity, not
  // locked). Latched into authScreen so it survives the hasIdentity flip on create.
  useEffect(() => {
    if (showWelcome && !hasIdentity && !identityLocked && authScreen === null) {
      setAuthScreen('welcome');
    }
  }, [showWelcome, hasIdentity, identityLocked, authScreen]);

  // Product tour: a plain-language walkthrough shown once, right after a new user
  // has an identity and the auth flow has closed. Distinct from the security primer
  // (that lives in AuthFlow) — this answers "how do I use the app?". Gated on the
  // communityOnboarding flag and a one-time localStorage key.
  useEffect(() => {
    if (!hasProductTour) return;
    if (hasIdentity && !identityLocked && authFlowStep === null && !state.showSettings) {
      if (!safeStorageGet(() => window.localStorage, TOUR_DISMISSED_KEY)) {
        setShowTour(true);
      }
    }
  }, [hasProductTour, hasIdentity, identityLocked, authFlowStep, state.showSettings]);

  useEffect(() => {
    if (currentPeerId) {
      hasSeenRuntimeRef.current = true;
    }
  }, [currentPeerId]);

  const connectionState = deriveConnectionState(shellData, state.activeServerId, hasSeenRuntimeRef.current);
  const currentUser = shellData.currentUser;
  const directMessages = shellData.directMessages;
  const servers = shellData.servers;
  const users = shellData.users;
  const normalizedUsers = normalizeLayoutUsers(users);

  const [bgSeed, setBgSeed] = usePersistentState<string>('harmolyn:settings:bg-seed', 'nexus-default');
  // Channel kind (text/forum/announcement) is SERVER STRUCTURE, not per-client view
  // state: it lives on the channel record in the native store, so it persists across
  // reloads and propagates to every member exactly like a rename. Absent kind = text
  // (backward compatible with channels created before the field existed).
  const setChannelKind = useCallback((serverId: string, channelId: string, kind: ChannelKind) => {
    void runtimeMutations.updateChannel?.(serverId, channelId, { kind });
  }, [runtimeMutations]);
  const [themeStyle, setThemeStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    const theme = generateTheme(bgSeed);
    setThemeStyle(theme.themeVars);
  }, [bgSeed]);

  const [{ isMobile, isTablet }, setResponsiveMode] = useState(readResponsiveMode);
  const compactViewportRef = useRef(isMobile || isTablet);

  const [channelListHovered, setChannelListHovered] = useState(false);
  const [memberListHovered, setMemberListHovered] = useState(false);
  const channelHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const memberHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChannelEnter = useCallback(() => {
    if (channelHoverTimer.current) clearTimeout(channelHoverTimer.current);
    if (state.channelListCollapsed && !isMobile) setChannelListHovered(true);
  }, [state.channelListCollapsed, isMobile]);
  const handleChannelLeave = useCallback(() => {
    channelHoverTimer.current = setTimeout(() => setChannelListHovered(false), 200);
  }, []);
  const handleMemberEnter = useCallback(() => {
    if (memberHoverTimer.current) clearTimeout(memberHoverTimer.current);
    if (state.memberListCollapsed && !isMobile) setMemberListHovered(true);
  }, [state.memberListCollapsed, isMobile]);
  const handleMemberLeave = useCallback(() => {
    memberHoverTimer.current = setTimeout(() => setMemberListHovered(false), 200);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const next = readResponsiveMode();
      const nextCompact = next.isMobile || next.isTablet;
      setResponsiveMode((current) => (
        current.isMobile === next.isMobile && current.isTablet === next.isTablet
          ? current
          : next
      ));

      // A desktop-open rail must never become an unsolicited blocking overlay
      // after rotation or a window resize. Reconcile only when crossing the
      // compact breakpoint so keyboard-driven resize events do not close a
      // drawer the user intentionally opened on mobile.
      if (compactViewportRef.current !== nextCompact) {
        compactViewportRef.current = nextCompact;
        setState((current) => ({
          ...current,
          mobileMenuOpen: false,
          memberListCollapsed: nextCompact ? true : current.memberListCollapsed,
          channelListCollapsed: nextCompact ? true : current.channelListCollapsed,
        }));
      }
    };

    handleResize();

    if ((safeViewportSize().width ?? 0) < 1100) {
      setState((s) => ({ ...s, memberListCollapsed: true, channelListCollapsed: true }));
    }

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false);
  const hasKeyboardShortcuts = useFeature('keyboardShortcuts');
  const [showScreenSharePanel, setShowScreenSharePanel] = useState(false);
  const [voiceUi, setVoiceUi] = useState({
    deafened: false,
    preDeafenMuted: null as boolean | null,
    videoOn: false,
    screenSharing: false,
    // Kept against a channel ID rather than inferred from mute state: a regular
    // user may be muted, but only an explicit Watch session is receive-only.
    receiveOnlyChannelId: null as string | null,
  });
  const [voiceActionStatus, setVoiceActionStatus] = useState<{ pending: string | null; error: string | null }>({
    pending: null,
    error: null,
  });
  // When opening Settings from a specific entry point (e.g. the voice settings
  // cog), jump straight to that section.
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const initialPreferredEndpoint = readPreferredControlEndpoint();
  const [showNodeLaunch, setShowNodeLaunch] = useState(false);
  const [nodeEndpointDraft, setNodeEndpointDraft] = useState(() => initialPreferredEndpoint || DEFAULT_CONTROL_ENDPOINT || 'http://127.0.0.1:7711');
  const [nodeLaunchFeedback, setNodeLaunchFeedback] = useState<string | null>(null);
  const [nodeLaunchBusy, setNodeLaunchBusy] = useState(false);
  const [nodeTestResult, setNodeTestResult] = useState<ControlEndpointTestResult | null>(null);
  const [nodeTestBusy, setNodeTestBusy] = useState(false);
  const nodeLaunchInteractionRef = useRef(false);

  useEffect(() => {
    setVoiceUi((prev) => ({
      ...prev,
      deafened: false,
      preDeafenMuted: null,
      videoOn: false,
      screenSharing: false,
      receiveOnlyChannelId: prev.receiveOnlyChannelId === state.connectedVoiceChannelId
        ? prev.receiveOnlyChannelId
        : null,
    }));
    setVoiceActionStatus({ pending: null, error: null });
    setShowScreenSharePanel(false);
  }, [state.connectedVoiceChannelId]);

  useEffect(() => {
    if (bootstrapState.status !== 'failed' || shellData.runtimeSnapshot) {
      return;
    }
    setShowNodeLaunch(true);
    // Bootstrap retries may emit several failure snapshots. Once the user has
    // opened or edited this screen, never replace their draft/feedback from a
    // background retry. In particular, a newly arrived runtime snapshot must
    // not dismiss the manually opened Switch Node screen.
    if (!nodeLaunchInteractionRef.current) {
      setNodeLaunchFeedback(bootstrapState.message);
      setNodeEndpointDraft(
        readPreferredControlEndpoint()
        || DEFAULT_CONTROL_ENDPOINT
        || 'http://127.0.0.1:7711',
      );
    }
  }, [bootstrapState.message, bootstrapState.status, shellData.runtimeSnapshot]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && hasQuickSwitcher) {
        e.preventDefault();
        setShowQuickSwitcher((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/' && hasKeyboardShortcuts) {
        e.preventDefault();
        setShowKeyboardShortcuts((prev) => !prev);
      }
      // Ctrl/Cmd+Shift+S toggles streamer mode globally (matches Discord/OBS).
      // Read the canonical value from localStorage at fire-time and broadcast the
      // same CustomEvent the Settings toggle and overlay button use, so every
      // listener stays in sync regardless of which surface flipped it.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault();
        const next = localStorage.getItem('harmolyn:settings:streamer-mode') !== 'true';
        localStorage.setItem('harmolyn:settings:streamer-mode', String(next));
        window.dispatchEvent(new CustomEvent('harmolyn:streamer-mode', { detail: { enabled: next } }));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasQuickSwitcher, hasKeyboardShortcuts]);

  useEffect(() => {
    setState((prev) => {
      const nextServerId = resolveActiveServerId(prev.activeServerId, shellData);
      const nextChannelId = resolveActiveChannelId(nextServerId, prev.activeChannelId, shellData);
      const nextVoiceChannelId = hasVoiceChannel(nextServerId, prev.connectedVoiceChannelId, shellData)
        ? prev.connectedVoiceChannelId
        : null;
      if (
        nextServerId === prev.activeServerId
        && nextChannelId === prev.activeChannelId
        && nextVoiceChannelId === prev.connectedVoiceChannelId
      ) {
        return prev;
      }
      return {
        ...prev,
        activeServerId: nextServerId,
        activeChannelId: nextChannelId,
        connectedVoiceChannelId: nextVoiceChannelId,
        viewMode: nextServerId === 'explore' ? 'explorer' : prev.viewMode === 'explorer' ? 'chat' : prev.viewMode,
      };
    });
  }, [shellData]);

  const handleQuickNavigate = (serverId: string, channelId: string) => {
    setState((prev) => ({
      ...prev,
      activeServerId: serverId,
      activeChannelId: channelId || resolveDefaultChannelId(serverId, shellData),
      viewMode: serverId === 'explore' ? 'explorer' : 'chat',
      mobileMenuOpen: false,
    }));
    setShowFriends(false);
  };

  const openJoinServerModal = useCallback((initialValue = '') => {
    setJoinDraft(initialValue);
    setShowJoinServer(true);
  }, []);

  useEffect(() => {
    void consumePendingNativeDeepLinks()
      .then((payloads) => {
        payloads.forEach((payload) => {
          handleNativeDeepLink(payload, openJoinServerModal);
        });
      })
      .catch(() => undefined);

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<string>('harmolyn://deeplink', (event) => {
      handleNativeDeepLink(event.payload, openJoinServerModal);
      void consumePendingNativeDeepLinks().catch(() => undefined);
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openJoinServerModal]);

  const handleCreateServer = useCallback(async (input: { name: string; description?: string }) => {
    // Route through the mutation facade so the server is created in the native
    // engine (owned by the local identity) rather than via the support node.
    const created = await runtimeMutations.createServer(input) as
      | { id?: string; channels?: Record<string, { id: string; voice?: boolean; created_at?: string }> }
      | undefined;
    const nextServerId = created?.id ?? 'home';
    const nextChannelId = created?.channels ? firstTextChannelId(created as Parameters<typeof firstTextChannelId>[0]) : '';

    setState((prev) => ({
      ...prev,
      activeServerId: nextServerId,
      activeChannelId: nextChannelId,
      viewMode: 'chat',
      mobileMenuOpen: false,
      showCreateServer: false,
    }));
  }, [runtimeMutations]);

  const handleJoinServer = useCallback(async (rawInvite: string) => {
    const deeplink = parseJoinDeepLink(rawInvite.trim());
    // Route through the facade (native join records membership locally).
    await runtimeMutations.joinServerByInvite(rawInvite);
    const nextServerId = deeplink.serverId;

    setState((prev) => ({
      ...prev,
      activeServerId: nextServerId,
      activeChannelId: resolveDefaultChannelId(nextServerId, shellData),
      viewMode: 'chat',
      mobileMenuOpen: false,
    }));
    setShowJoinServer(false);
    setJoinDraft('');
  }, [runtimeMutations, shellData]);

  const activeServer = servers.find((server) => server.id === state.activeServerId);
  const isHome = state.activeServerId === 'home';
  const isExplore = state.activeServerId === 'explore';
  const allChannels = activeServer ? activeServer.categories.flatMap((category) => category.channels) : [];
  const fallbackChannel: Channel = createFallbackChannel(connectionState, shellData.runtimeSnapshot !== null);

  let activeChannel = allChannels.find((channel) => channel.id === state.activeChannelId) || allChannels[0] || fallbackChannel;
  let isDM = false;

  if (isHome && state.activeChannelId) {
    const dm = directMessages.find((entry) => entry.id === state.activeChannelId);
    if (dm) {
      const dmUser = resolveLayoutDirectMessageUser(normalizedUsers, dm.userId);
      activeChannel = { id: dm.id, name: dmUser.username, type: 'text', categoryId: 'dm' };
      isDM = true;
    }
  }

  // Use activeChannel.id (not state.activeChannelId) so messages sent to the
  // fallback "empty-shell" channel render even when no server is selected yet.
  const activeMessages = shellData.messagesByScope.get(activeChannel.id) ?? [];

  const handleServerSelect = (id: string | 'home' | 'explore') => {
    if ((id === 'explore' || (id !== 'home' && id !== 'explore')) && !connectionState.canUseConnectivityActions) {
      return;
    }
    setState((prev) => ({
      ...prev,
      activeServerId: id,
      activeChannelId: resolveDefaultChannelId(id, shellData),
      viewMode: id === 'explore' ? 'explorer' : 'chat',
      mobileMenuOpen: false,
    }));
    // Home's landing IS the Friends panel (friends, requests, add-friend). Opening
    // Home shows it in one click, so Add Friend / Accept are reachable in two.
    // Selecting a DM from the rail flips this back off (handled in onSelectChannel).
    setShowFriends(id === 'home');
  };

  const handleOpenDM = (userId: string) => {
    if (!connectionState.canUseConnectivityActions) {
      return { ok: false, message: connectionState.detail };
    }
    const existing = directMessages.find((entry) => entry.userId === userId);
    // Create the thread on demand when none exists yet — opening a DM with a
    // friend you've never messaged should just work, not error out.
    const dmId = existing?.id ?? runtimeMutations.ensureDirectMessage?.(userId);
    if (!dmId) {
      return { ok: false, message: 'Could not open a direct message with this peer.' };
    }
    setState((prev) => ({ ...prev, activeServerId: 'home', activeChannelId: dmId, mobileMenuOpen: false }));
    setShowFriends(false);
    return { ok: true };
  };

  // Tell the native store which scope is on screen so inbound messages there don't
  // accumulate as unread, and the badge clears when you open a channel/DM. Depends
  // only on the scope id: runtimeMutations re-creates on every snapshot publish and
  // setActiveScope itself publishes, so depending on it would loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeChannel?.id) runtimeMutations.setActiveScope?.(activeChannel.id); }, [activeChannel?.id]);

  const handleCopyInvite = useCallback(async () => {
    const serverId = state.activeServerId;
    if (!serverId || serverId === 'home' || serverId === 'explore') { toast.error('No Space selected.'); return; }
    // Mint from the live native store — the runtime snapshot strips invite_secret,
    // so a snapshot-derived link would carry no capability token and be rejected.
    const link = runtimeMutations.inviteLink?.(serverId) ?? '';
    if (link && await copyTextToClipboardSafely(link)) {
      toast.success('Invite link copied to clipboard.', 'Invite');
    } else {
      toast.error('Only the Space Owner can create invite links (or invites are revoked).');
    }
  }, [state.activeServerId, runtimeMutations, toast]);

  const handleLeaveServer = useCallback(async () => {
    const serverId = state.activeServerId;
    if (serverId === 'home' || serverId === 'explore') return;
    await runtimeMutations.leaveServer?.(serverId);
    toast.success('You left the Space.', 'Left Space');
    setState((prev) => ({ ...prev, activeServerId: 'home', activeChannelId: resolveDefaultChannelId('home', shellData), viewMode: 'chat', mobileMenuOpen: false }));
  }, [runtimeMutations, state.activeServerId, shellData, toast]);

  const handleDeleteServer = useCallback(async () => {
    const serverId = state.activeServerId;
    if (serverId === 'home' || serverId === 'explore') return;
    await runtimeMutations.deleteServer?.(serverId);
    toast.success('Space deleted.', 'Deleted');
    setState((prev) => ({ ...prev, activeServerId: 'home', activeChannelId: resolveDefaultChannelId('home', shellData), viewMode: 'chat', mobileMenuOpen: false }));
  }, [runtimeMutations, state.activeServerId, shellData, toast]);

  const setMessageLayout = (layout: MessageLayout) => {
    setState((prev) => ({ ...prev, messageLayout: layout }));
  };

  const toggleMessageLayout = () => {
    const layouts: MessageLayout[] = ['modern', 'bubbles', 'terminal'];
    const currentIndex = layouts.indexOf(state.messageLayout);
    setState((prev) => ({ ...prev, messageLayout: layouts[(currentIndex + 1) % layouts.length] }));
  };

  useEffect(() => {
    safeStorageSet(() => window.localStorage, MESSAGE_LAYOUT_STORAGE_KEY, state.messageLayout);
  }, [state.messageLayout]);

  const handleSettingsLogout = () => {
    // Full local reset: forget the identity and reload as a fresh guest.
    setState((prev) => ({ ...prev, showSettings: false }));
    void resetLocalIdentity();
  };

  const openNodeLaunch = useCallback(() => {
    nodeLaunchInteractionRef.current = true;
    setShowNodeLaunch(true);
    setNodeLaunchFeedback(null);
    setNodeTestResult(null);
  }, []);

  const handleNodeEndpointChange = useCallback((value: string) => {
    nodeLaunchInteractionRef.current = true;
    setNodeEndpointDraft(value);
    setNodeTestResult(null);
    setNodeLaunchFeedback(null);
  }, []);

  const handleTestNode = useCallback(async () => {
    setNodeTestBusy(true);
    setNodeTestResult(null);
    try {
      setNodeTestResult(await testControlEndpoint(nodeEndpointDraft));
    } finally {
      setNodeTestBusy(false);
    }
  }, [nodeEndpointDraft]);

  const handleConnectNode = useCallback(async () => {
    const normalized = normalizeLaunchControlEndpoint(nodeEndpointDraft);
    if (!normalized) {
      setNodeTestResult(await testControlEndpoint(nodeEndpointDraft));
      return;
    }

    setNodeLaunchBusy(true);
    setNodeTestResult(null);
    setNodeLaunchFeedback(null);
    const previousEndpoint = readPreferredControlEndpoint();

    try {
      // The native bridge authorizes the selected loopback endpoint. Stage the
      // selection before probing so first-time local connections are checked
      // through that authenticated bridge, then restore the previous choice if
      // the probe fails.
      storePreferredControlEndpoint(normalized);
      const testResult = await testControlEndpoint(normalized);
      setNodeTestResult(testResult);
      if (testResult.status !== 'reachable') {
        if (previousEndpoint) storePreferredControlEndpoint(previousEndpoint);
        else clearPreferredControlEndpoint();
        return;
      }

      setNodeLaunchFeedback(`Connecting to ${normalized}...`);
      const snapshot = await connectToControlEndpoint(normalized);
      if (snapshot) {
        nodeLaunchInteractionRef.current = false;
        setShowNodeLaunch(false);
        setShowWelcome(false);
        setState((prev) => ({ ...prev, showSettings: false }));
        return;
      }
      if (previousEndpoint) storePreferredControlEndpoint(previousEndpoint);
      else clearPreferredControlEndpoint();
      setNodeLaunchFeedback(`Unable to reach ${normalized}. Check the node and try again.`);
    } catch (error) {
      if (previousEndpoint) storePreferredControlEndpoint(previousEndpoint);
      else clearPreferredControlEndpoint();
      setNodeLaunchFeedback(
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : `Unable to reach ${normalized}. Check the node and try again.`,
      );
    } finally {
      setNodeLaunchBusy(false);
    }
  }, [nodeEndpointDraft]);

  const handleUseDefaultNode = useCallback(async () => {
    setNodeLaunchBusy(true);
    setNodeLaunchFeedback(null);
    setNodeTestResult(null);
    clearPreferredControlEndpoint();

    try {
      const snapshot = await connectToDefaultRuntime();
      if (snapshot) {
        nodeLaunchInteractionRef.current = false;
        setShowNodeLaunch(false);
        setShowWelcome(false);
        setState((prev) => ({ ...prev, showSettings: false }));
        return;
      }
      setNodeLaunchFeedback(DEFAULT_CONTROL_ENDPOINT
        ? `Unable to reach the bundled node at ${DEFAULT_CONTROL_ENDPOINT}.`
        : 'No bundled node is configured. Enter a local endpoint instead.');
    } finally {
      setNodeLaunchBusy(false);
    }
  }, []);

  const handleContinueOffline = useCallback(() => {
    nodeLaunchInteractionRef.current = false;
    setShowNodeLaunch(false);
    setNodeLaunchFeedback(null);
    setNodeTestResult(null);
  }, []);

  const showMemberSidebar = !isDM && Boolean(activeServer) && !isExplore;
  const isTouchDevice = isMobile || isTablet;
  const mainRef = useRef<HTMLDivElement>(null);

  const openChannelDrawer = useCallback(() => {
    setState((current) => ({
      ...current,
      mobileMenuOpen: true,
      memberListCollapsed: true,
    }));
  }, []);

  const toggleChannelDrawer = useCallback(() => {
    setState((current) => ({
      ...current,
      mobileMenuOpen: !current.mobileMenuOpen,
      memberListCollapsed: current.mobileMenuOpen ? current.memberListCollapsed : true,
    }));
  }, []);

  const openMemberDrawer = useCallback(() => {
    setState((current) => ({
      ...current,
      mobileMenuOpen: false,
      memberListCollapsed: false,
    }));
  }, []);

  const toggleMemberDrawer = useCallback(() => {
    setState((current) => {
      const memberListCollapsed = !current.memberListCollapsed;
      return {
        ...current,
        mobileMenuOpen: memberListCollapsed ? current.mobileMenuOpen : false,
        memberListCollapsed,
      };
    });
  }, []);

  useSwipeGesture(mainRef, {
    edgeZone: 30,
    edge: 'left',
    enabled: isTouchDevice && !state.mobileMenuOpen && state.memberListCollapsed,
    onSwipeRight: openChannelDrawer,
  });

  useSwipeGesture(mainRef, {
    edgeZone: 30,
    edge: 'right',
    enabled: isTouchDevice && !state.mobileMenuOpen && !!showMemberSidebar && state.memberListCollapsed,
    onSwipeLeft: openMemberDrawer,
  });

  useSwipeGesture(mainRef, {
    enabled: isTouchDevice && state.mobileMenuOpen,
    onSwipeLeft: () => setState((s) => ({ ...s, mobileMenuOpen: false })),
  });

  useSwipeGesture(mainRef, {
    enabled: isTouchDevice && !state.memberListCollapsed,
    onSwipeRight: () => setState((s) => ({ ...s, memberListCollapsed: true })),
  });

  const connectedVoiceChannel = state.connectedVoiceChannelId
    ? allChannels.find((channel) => channel.id === state.connectedVoiceChannelId && channel.type === 'voice') ?? null
    : null;

  const voiceControlState = buildVoiceControlState({
    connectionState,
    connectedVoiceChannelId: state.connectedVoiceChannelId,
    connectedVoiceChannelName: connectedVoiceChannel?.name ?? 'Voice',
    connectedVoiceSession,
    localMuted: connectedVoiceSession?.participants[currentPeerId]?.muted ?? false,
    voiceUi: {
      ...voiceUi,
      receiveOnly: Boolean(state.connectedVoiceChannelId)
        && voiceUi.receiveOnlyChannelId === state.connectedVoiceChannelId,
    },
    voiceActionStatus,
  });

  const voiceActionError = (error: unknown) => {
    const message = formatVoiceActionError(error);
    setVoiceActionStatus({ pending: null, error: message });
    return message;
  };

  const handleJoinVoice = async (id: string, options: { receiveOnly?: boolean } = {}) => {
    const nextChannel = id.trim();
    if (!nextChannel) {
      await handleLeaveVoice();
      return;
    }
    if (!hasIdentity) {
      setAuthScreen('register');
      return;
    }
    const alreadyConnectedToTarget = state.connectedVoiceChannelId === nextChannel;

    // Voice is a local-first P2P mesh. A regular join captures the mic once inside
    // the session; an explicit Watch joins receive-only and never prompts for it.
    setVoiceActionStatus({ pending: 'join', error: null });
    try {
      if (state.connectedVoiceChannelId && state.connectedVoiceChannelId !== nextChannel) {
        await runtimeMutations.leaveVoiceChannel(state.connectedVoiceChannelId);
      }
      // Optimistically reflect the join so the control bar appears instantly even
      // while the mesh connects.
      if (!alreadyConnectedToTarget) {
        setVoiceUi((prev) => ({
          ...prev,
          receiveOnlyChannelId: options.receiveOnly ? nextChannel : null,
        }));
        setState((prev) => ({ ...prev, connectedVoiceChannelId: nextChannel }));
      }
      await runtimeMutations.joinVoiceChannel(nextChannel, options);
      setVoiceActionStatus({ pending: null, error: null });
    } catch (error) {
      // Only roll back an optimistic channel change. A same-channel request may
      // be rejected because it would cross the Watch/capture privacy boundary;
      // its existing live session must remain visible and leaveable.
      if (!alreadyConnectedToTarget) {
        setState((prev) => ({ ...prev, connectedVoiceChannelId: prev.connectedVoiceChannelId === nextChannel ? null : prev.connectedVoiceChannelId }));
        setVoiceUi((prev) => prev.receiveOnlyChannelId === nextChannel
          ? { ...prev, receiveOnlyChannelId: null }
          : prev);
      }
      voiceActionError(error);
    }
  };

  const handleWatchVoice = async (id: string) => {
    await handleJoinVoice(id, { receiveOnly: true });
  };

  const handleLeaveVoice = async () => {
    if (!state.connectedVoiceChannelId) {
      return;
    }

    // Leaving is a privacy-sensitive local action: always release the mic,
    // camera, screen and peer connections even while the relay is unavailable.
    setVoiceActionStatus({ pending: 'leave', error: null });
    try {
      await runtimeMutations.leaveVoiceChannel(state.connectedVoiceChannelId);
      setState((prev) => ({ ...prev, connectedVoiceChannelId: null }));
      setVoiceActionStatus({ pending: null, error: null });
    } catch (error) {
      voiceActionError(error);
    }
  };

  const handleToggleVoiceMute = async () => {
    // Mute is a local microphone-track toggle — it must work even when the relay
    // is offline. Only require an active voice session.
    if (voiceControlState.receiveOnly) {
      voiceActionError(new Error('Watch mode does not permit microphone capture.'));
      return;
    }
    if (!state.connectedVoiceChannelId || !connectedVoiceSession) {
      voiceActionError(new Error('Join a voice channel first.'));
      return;
    }

    const nextMuted = !(connectedVoiceSession.participants[currentPeerId]?.muted ?? false);
    setVoiceActionStatus({ pending: 'mute', error: null });
    try {
      if (voiceUi.deafened) {
        setVoiceUi((prev) => ({ ...prev, preDeafenMuted: nextMuted }));
      }
      await runtimeMutations.setVoiceMuted(state.connectedVoiceChannelId, nextMuted);
      setVoiceActionStatus({ pending: null, error: null });
    } catch (error) {
      voiceActionError(error);
    }
  };

  const handleToggleVoiceDeafen = async () => {
    // Deafen is local (mute + silence remote audio sinks) — no relay required.
    if (!state.connectedVoiceChannelId || !connectedVoiceSession) {
      voiceActionError(new Error('Join a voice channel first.'));
      return;
    }

    const nextDeafened = !voiceUi.deafened;
    // A watcher has no microphone and must remain receive-only. Deafen only
    // controls the local audio sinks here; calling setVoiceMuted(false) while
    // undeafening would violate that invariant if a stale snapshot said muted.
    if (voiceControlState.receiveOnly) {
      setVoiceUi((prev) => ({
        ...prev,
        deafened: nextDeafened,
        preDeafenMuted: null,
      }));
      setVoiceActionStatus({ pending: null, error: null });
      return;
    }
    const currentMuted = connectedVoiceSession.participants[currentPeerId]?.muted ?? false;
    const nextMuted = nextDeafened ? true : (voiceUi.preDeafenMuted ?? currentMuted);
    setVoiceActionStatus({ pending: 'deafen', error: null });
    try {
      setVoiceUi((prev) => ({
        ...prev,
        deafened: nextDeafened,
        preDeafenMuted: nextDeafened ? currentMuted : null,
      }));
      await runtimeMutations.setVoiceMuted(state.connectedVoiceChannelId, nextMuted);
      setVoiceActionStatus({ pending: null, error: null });
    } catch (error) {
      voiceActionError(error);
    }
  };

  const handleToggleVoiceVideo = async () => {
    // Camera is a local mesh track — only the live voice session is required
    // (works peer-to-peer even when the relay is flaky).
    if (voiceControlState.receiveOnly) {
      voiceActionError(new Error('Watch mode does not permit camera capture.'));
      return;
    }
    if (!state.connectedVoiceChannelId) {
      voiceActionError(new Error(voiceControlState.statusDetail));
      return;
    }

    const nextVideoOn = !voiceUi.videoOn;
    setVoiceActionStatus({ pending: 'video', error: null });
    try {
      await runtimeMutations.setVoiceCamera(state.connectedVoiceChannelId, nextVideoOn);
      setVoiceUi((prev) => ({ ...prev, videoOn: nextVideoOn }));
      setVoiceActionStatus({ pending: null, error: null });
    } catch (error) {
      // getUserMedia denied / no camera, etc.
      const name = error instanceof Error ? error.name : '';
      const msg = name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access and try again.'
        : name === 'NotFoundError' ? 'No camera found.'
        : error;
      voiceActionError(msg);
    }
  };

  const handleToggleVoiceScreenShare = async () => {
    if (voiceControlState.receiveOnly) {
      voiceActionError(new Error('Watch mode does not permit screen sharing.'));
      return;
    }
    if (!state.connectedVoiceChannelId) {
      voiceActionError(new Error(voiceControlState.statusDetail));
      return;
    }

    if (voiceUi.screenSharing) {
      setVoiceActionStatus({ pending: 'screen-share', error: null });
      try {
        await runtimeMutations.stopVoiceScreenShare(state.connectedVoiceChannelId);
        setVoiceUi((prev) => ({ ...prev, screenSharing: false }));
        setVoiceActionStatus({ pending: null, error: null });
      } catch (error) {
        voiceActionError(error);
      }
      return;
    }

    setShowScreenSharePanel(true);
  };

  const handleStartScreenShare = async (type: 'screen' | 'window' | 'tab', quality: string) => {
    if (voiceControlState.receiveOnly) {
      throw new Error('Watch mode does not permit screen sharing.');
    }
    if (!state.connectedVoiceChannelId) {
      throw new Error(voiceControlState.statusDetail);
    }

    setVoiceActionStatus({ pending: 'screen-share', error: null });
    try {
      // The browser's getDisplayMedia picker selects screen/window/tab natively;
      // we pass the chosen quality + a surface hint as constraints.
      await runtimeMutations.startVoiceScreenShare(state.connectedVoiceChannelId, {
        withAudio: true,
        quality,
        surface: type,
      });
      setVoiceUi((prev) => ({ ...prev, screenSharing: true }));
      setShowScreenSharePanel(false);
      setVoiceActionStatus({ pending: null, error: null });
    } catch (error) {
      // User cancelled the picker (NotAllowedError/AbortError) — close quietly.
      const name = error instanceof Error ? error.name : '';
      if (name === 'NotAllowedError' || name === 'AbortError') {
        setShowScreenSharePanel(false);
        setVoiceActionStatus({ pending: null, error: null });
        return;
      }
      voiceActionError(error);
      throw error;
    }
  };

  const handleOpenVoiceSettings = () => {
    // Open Settings directly on the Audio & Video section (mic/camera devices,
    // input volume, noise suppression, video quality).
    setSettingsSection('audio-video');
    setState((s) => ({ ...s, showSettings: true }));
  };

  return (
   <StreamerModeProvider activeServerId={isHome || isExplore ? null : state.activeServerId}>
    <div ref={mainRef} className="app-viewport safe-inline safe-top flex flex-col bg-bg-0 overflow-hidden font-sans relative" style={themeStyle}>
      {/* Streamer mode: slim top-bar notification (no full-screen blocker). */}
      <StreamerTopBar />
      {/* Connectivity banners are STATIC flow (not fixed overlays): they push
          the app down instead of covering the top chrome — a fixed banner sat
          on top of the server-menu/header row and swallowed its clicks. Kept
          BELOW the full-screen overlays' z-[100] (FullScreenOverlay anchors to
          this h-screen root at y=0): Settings/ServerSettings legitimately
          cover the banners; a high-z banner strip covered their close button. */}
      {(!isOnline || nodeOffline) && (
        <div className="relative z-10 w-full shrink-0 flex flex-col">
          {!isOnline && (
            <div role="status" className="bg-accent-warning/90 text-black text-center text-[12px] font-semibold py-1.5 px-3">
              You’re offline. Messages you send will be delivered when your connection returns.
            </div>
          )}
          {nodeOffline && (
            <div role="status" data-testid="node-offline-banner" className="bg-accent-warning/80 text-black text-center text-[12px] py-1.5 px-3">
              <span className="font-semibold">{NODE_OFFLINE_BANNER_TITLE}</span>
              <span> — {NODE_OFFLINE_BANNER_DETAIL}</span>
            </div>
          )}
        </div>
      )}
      {bootstrapState.status !== 'idle' && bootstrapState.status !== 'ready' && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[280] w-[min(720px,calc(100vw-24px))]">
          <div className={`glass-card rounded-r3 backdrop-blur-xl shadow-2xl px-4 py-3 flex items-center gap-3 ${
            bootstrapState.status === 'failed'
              ? 'border border-accent-danger/30 bg-accent-danger/10'
              : 'border border-primary/20 bg-bg-1/90'
          }`}>
            {bootstrapState.status === 'failed' ? (
              <AlertTriangle size={16} className="text-accent-danger shrink-0" />
            ) : (
              <Loader2 size={16} className="text-primary animate-spin shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-sm font-bold text-white">
                {bootstrapState.status === 'failed' ? 'xorein startup failed' : 'Preparing xorein'}
              </div>
              <div className="text-[11px] text-white/55 truncate">
                {bootstrapState.message || 'Starting the local runtime.'}
              </div>
              {bootstrapState.detail && (
                <div className="text-[10px] text-white/35 truncate">
                  {bootstrapState.detail}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {showNodeLaunch && (
        <NodeLaunchScreen
          endpoint={nodeEndpointDraft}
          feedback={nodeLaunchFeedback}
          busy={nodeLaunchBusy}
          testBusy={nodeTestBusy}
          testResult={nodeTestResult}
          currentNodeLabel={shellData.runtimeSnapshot?.control_endpoint || initialPreferredEndpoint || DEFAULT_CONTROL_ENDPOINT || ''}
          onEndpointChange={handleNodeEndpointChange}
          onTest={() => { void handleTestNode(); }}
          onConnect={() => { void handleConnectNode(); }}
          onUseDefault={() => { void handleUseDefaultNode(); }}
          onContinueOffline={handleContinueOffline}
        />
      )}
      {identityLocked && <UnlockScreen />}
      {!identityLocked && authFlowStep && (
        <AuthFlow initialStep={authFlowStep} onClose={closeAuthFlow} />
      )}
      {showTour && !identityLocked && !authFlowStep && (
        <ProductTour onClose={() => setShowTour(false)} />
      )}
      <AnimatePresence mode="wait">
        {state.showSettings && (
          <FullScreenOverlay key="settings">
            <React.Suspense fallback={<DeferredSurfaceFallback label="settings" />}>
              <SettingsScreen
                user={currentUser}
                initialSection={settingsSection ?? undefined}
                onClose={() => { setState((s) => ({ ...s, showSettings: false })); setSettingsSection(null); }}
                onLogOut={handleSettingsLogout}
                messageLayout={state.messageLayout}
                onSetMessageLayout={setMessageLayout}
                runtimeSnapshot={shellData.runtimeSnapshot}
                onOpenNodeLaunch={openNodeLaunch}
                bgSeed={bgSeed}
                onSetBgSeed={setBgSeed}
              />
            </React.Suspense>
          </FullScreenOverlay>
        )}
        {state.viewMode === 'server-settings' && activeServer && (
          <FullScreenOverlay key="server-settings">
            <React.Suspense fallback={<DeferredSurfaceFallback label="Space settings" />}>
              <ServerSettingsScreen server={activeServer} onClose={() => setState((s) => ({ ...s, viewMode: 'chat' }))} />
            </React.Suspense>
          </FullScreenOverlay>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {state.showCreateServer && (
          <CreateServerModal
            key="create"
            onClose={() => setState((s) => ({ ...s, showCreateServer: false }))}
            onCreate={handleCreateServer}
            onOpenJoin={() => {
              setState((s) => ({ ...s, showCreateServer: false }));
              openJoinServerModal();
            }}
          />
        )}
        {showJoinServer && (
          <JoinServerModal
            key="join"
            initialValue={joinDraft}
            runtimeSnapshot={shellData.runtimeSnapshot}
            onClose={() => {
              setShowJoinServer(false);
              setJoinDraft('');
            }}
            onJoin={handleJoinServer}
          />
        )}
        {showScreenSharePanel && (
          <ScreenSharePanel
            key="screen-share"
            onClose={() => setShowScreenSharePanel(false)}
            onStartShare={handleStartScreenShare}
            disabledReason={voiceControlState.canInteract ? undefined : voiceControlState.statusDetail}
            isSharing={voiceUi.screenSharing}
          />
        )}
        {showQuickSwitcher && hasQuickSwitcher && (
          <QuickSwitcher key="quickswitcher" onClose={() => setShowQuickSwitcher(false)} onNavigate={handleQuickNavigate} />
        )}
        {showKeyboardShortcuts && hasKeyboardShortcuts && (
          <KeyboardShortcutsOverlay key="shortcuts" onClose={() => setShowKeyboardShortcuts(false)} />
        )}
      </AnimatePresence>

      {/* Hidden audio sinks for remote voice participants — one <audio> per stream.
          Must be outside AnimatePresence so they are never unmounted mid-call. */}
      <VoiceAudioSinks channelId={state.connectedVoiceChannelId} deafened={voiceUi.deafened} />
      <VoiceVideoSinks channelId={state.connectedVoiceChannelId} />
      <RecoveryConsentPrompt />

      {!hasIdentity && (
        <div data-testid="guest-account-banner" className="relative z-20 shrink-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2 sm:px-6 sm:py-3 bg-bg-1/95 backdrop-blur-sm border-b border-white/10">
          <span className="min-w-0 basis-full flex-1 text-[11px] sm:basis-auto sm:text-xs text-white/60 tracking-wide">
            <span className="sm:hidden">Guest mode: sign in to post, react, and join Spaces.</span>
            <span className="hidden sm:inline">You're browsing as a guest. Create a free account to post, react, and join Spaces.</span>
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setAuthScreen('login')}
              className="touch-target px-4 rounded-full text-xs font-bold tracking-wide text-white/70 hover:text-white border border-white/15 hover:border-white/30 transition-all"
            >
              Sign in
            </button>
            <button
              onClick={() => setAuthScreen('register')}
              className="touch-target px-4 rounded-full text-xs font-bold tracking-wide bg-primary text-bg-0 hover:shadow-glow transition-all"
            >
              Create account
            </button>
          </div>
        </div>
      )}

      {/* Main app row — everything below the (static) banners. */}
      <div className="flex flex-1 min-h-0 w-full overflow-hidden relative">
      {!isMobile && !isTablet && (
        <div className="relative z-50">
          <ServerRail
            servers={servers}
            activeServerId={state.activeServerId}
            connectionState={connectionState}
            onSelectServer={handleServerSelect}
            onCreateServer={() => hasIdentity && connectionState.canUseConnectivityActions && setState((s) => ({ ...s, showCreateServer: true }))}
            showExplore={hasServerDiscovery}
            homeBadge={friendRequestBadgeEnabled ? incomingFriendRequests : 0}
          />
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative">
        {/* Streamer mode: blur this server's channels/chat/members behind a reveal
            card. The server rail stays sharp (it's outside this region). */}
        <StreamerServerReveal serverId={isHome || isExplore ? null : state.activeServerId} />
        {!isExplore && ((!isMobile && !isTablet) || state.mobileMenuOpen) && (
          <>
            <div className={`transition-all duration-300 ease-in-out flex-shrink-0 ${!state.channelListCollapsed && !isMobile && !isTablet ? 'w-[224px]' : 'w-0'}`}></div>

            {(isMobile || isTablet) && (
              <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[55] animate-in fade-in" onClick={() => setState((s) => ({ ...s, mobileMenuOpen: false, channelListCollapsed: true }))}></div>
            )}

            <div
              className={`
                absolute left-0 top-0 bottom-0 z-[60] flex h-full
                ${(isMobile || isTablet) ? 'w-[min(25rem,calc(100vw-1rem))] pointer-events-auto' : ''}
                ${!(isMobile || isTablet) && (state.channelListCollapsed && !channelListHovered) ? 'w-[10px] pointer-events-auto' : ''}
                ${!(isMobile || isTablet) && (!state.channelListCollapsed || channelListHovered) ? 'w-[224px] pointer-events-auto' : ''}
              `}
              onMouseEnter={!(isMobile || isTablet) ? handleChannelEnter : undefined}
              onMouseLeave={!(isMobile || isTablet) ? handleChannelLeave : undefined}
            >
              {(isMobile || isTablet) && (
                <ServerRail
                  servers={servers}
                  activeServerId={state.activeServerId}
                  connectionState={connectionState}
                  onSelectServer={handleServerSelect}
                  onCreateServer={() => hasIdentity && connectionState.canUseConnectivityActions && setState((s) => ({ ...s, showCreateServer: true }))}
                  showExplore={hasServerDiscovery}
                  homeBadge={friendRequestBadgeEnabled ? incomingFriendRequests : 0}
                />
              )}
              <ChannelRail
                server={activeServer}
                activeChannelId={state.activeChannelId}
                currentUser={currentUser}
                users={users}
                directMessages={directMessages}
                connectionState={connectionState}
                connectedVoiceChannelId={state.connectedVoiceChannelId}
                collapsed={!(isMobile || isTablet) && state.channelListCollapsed && !channelListHovered}
                onToggleCollapse={() => setState((s) => ({ ...s, channelListCollapsed: !s.channelListCollapsed, mobileMenuOpen: false }))}
                onSelectChannel={(id) => {
                  if (!connectionState.canUseConnectivityActions) {
                    return;
                  }
                  setState((s) => ({
                    ...s,
                    activeChannelId: id,
                    mobileMenuOpen: false,
                    channelListCollapsed: (isMobile || isTablet) ? true : s.channelListCollapsed,
                  }));
                  setShowFriends(false);
                }}
                onJoinVoice={handleJoinVoice}
                onWatchVoice={handleWatchVoice}
                onOpenSettings={() => setState((s) => ({ ...s, showSettings: true, mobileMenuOpen: false, memberListCollapsed: true }))}
                onOpenNodeLaunch={openNodeLaunch}
                onOpenAuth={() => setAuthScreen('login')}
                onOpenServerSettings={!isHome && activeServer ? () => setState((s) => ({ ...s, viewMode: 'server-settings', mobileMenuOpen: false, memberListCollapsed: true })) : undefined}
                onInvite={!isHome && activeServer ? handleCopyInvite : undefined}
                onLeaveServer={!isHome && activeServer ? handleLeaveServer : undefined}
                onDeleteServer={!isHome && activeServer ? handleDeleteServer : undefined}
                onOpenVoiceSettings={handleOpenVoiceSettings}
                voiceControlState={voiceControlState}
                onToggleVoiceMute={handleToggleVoiceMute}
                onToggleVoiceDeafen={handleToggleVoiceDeafen}
                onToggleVoiceVideo={handleToggleVoiceVideo}
                onToggleVoiceScreenShare={hasScreenShare ? handleToggleVoiceScreenShare : undefined}
                isHome={isHome}
                onShowFriends={isHome ? () => setShowFriends(true) : undefined}
                friendRequestBadge={friendRequestBadgeEnabled ? incomingFriendRequests : 0}
              />
            </div>
          </>
        )}

        <div className="flex-1 flex flex-col min-w-0 relative">
          <div className="flex-1 flex min-w-0 overflow-hidden relative">
            {isExplore ? (
              <React.Suspense fallback={<DeferredSurfaceFallback label="Space explorer" />}>
                <ServerExplorer
                  servers={servers}
                  runtimeSnapshot={shellData.runtimeSnapshot}
                  onSelectServer={handleServerSelect}
                  onOpenJoin={openJoinServerModal}
                />
              </React.Suspense>
            ) : isHome && showFriends ? (
              <FriendsPanel onOpenDM={handleOpenDM} hasIdentity={hasIdentity} onOpenAuth={() => setAuthScreen('register')} />
            ) : (
              <>
                {(() => {
                  // Connected, but the user has no servers and nothing is selected
                  // (the system fallback). Show a friendly getting-started screen
                  // instead of the cryptic "Initiate Hub: #empty-shell" placeholder.
                  if (activeChannel.id === 'empty-shell') {
                    return (
                      <WelcomeEmptyState
                        hasIdentity={hasIdentity}
                        canUseConnectivity={connectionState.canUseConnectivityActions}
                        onCreateServer={() => setState((s) => ({ ...s, showCreateServer: true }))}
                        onJoinServer={() => openJoinServerModal()}
                        onAddFriend={() => { handleServerSelect('home'); setShowFriends(true); }}
                        onOpenAuth={() => setAuthScreen('register')}
                      />
                    );
                  }
                  // The synced kind lives on the runtime channel record (owner-set,
                  // P2P-propagated, persisted). Fall back to the mapped channel type
                  // for records that don't carry a kind.
                  const runtimeServer = shellData.runtimeSnapshot?.servers?.find((srv) => srv.id === state.activeServerId);
                  const rawKind = (!isDM
                    ? runtimeServer?.channels?.[activeChannel.id]?.kind
                    : undefined) ?? activeChannel.type;
                  const channelKind: ChannelKind =
                    (!isDM && rawKind === 'forum' && hasForumChannels) ? 'forum'
                    : (!isDM && rawKind === 'announcement' && hasAnnouncementChannels) ? 'announcement'
                    : 'text';
                  const availableKinds: ChannelKind[] = [
                    'text',
                    ...(hasForumChannels ? (['forum'] as ChannelKind[]) : []),
                    ...(hasAnnouncementChannels ? (['announcement'] as ChannelKind[]) : []),
                  ];
                  // Channel type is owner-authoritative server structure (like a
                  // rename): only the owner gets the switcher — a member's local
                  // change would never sync and would be reverted by the next
                  // owner broadcast.
                  const isServerOwner = Boolean(currentPeerId) && runtimeServer?.owner_peer_id === currentPeerId;
                  const kindSwitcher = !isDM && isServerOwner && activeServer
                    ? <ChannelKindSwitcher value={channelKind} available={availableKinds} onChange={(k) => setChannelKind(activeServer.id, activeChannel.id, k)} />
                    : null;

                  if (channelKind === 'forum') {
                    return <ForumChannel key={`forum:${activeChannel.id}`} channel={activeChannel} headerControl={kindSwitcher} users={activeServer?.members.length ? activeServer.members : users} />;
                  }
                  if (channelKind === 'announcement') {
                    return <AnnouncementChannel key={`ann:${activeChannel.id}`} channel={activeChannel} headerControl={kindSwitcher} />;
                  }
                  return (
                    <ChatArea
                      key={`${state.activeServerId}:${activeChannel.id}`}
                      channel={activeChannel}
                      messages={activeMessages}
                      users={activeServer?.members.length ? activeServer.members : users}
                      mobileMenuOpen={state.mobileMenuOpen}
                      messageLayout={state.messageLayout}
                      onToggleMobileMenu={toggleChannelDrawer}
                      onToggleMemberList={toggleMemberDrawer}
                      onToggleLayout={toggleMessageLayout}
                      isDM={isDM}
                      securityMode={isDM ? shellData.sessionSnapshot?.securityMode : activeServer?.securityMode}
                      headerControl={kindSwitcher}
                      hasIdentity={hasIdentity}
                      onOpenAuth={() => setAuthScreen('register')}
                    />
                  );
                })()}

                {showMemberSidebar && activeServer && (
                  <>
                    <div className={`transition-all duration-300 ease-in-out flex-shrink-0 ${!state.memberListCollapsed && !isMobile && !isTablet ? 'w-[224px]' : 'w-0'}`}></div>

                    {(isMobile || isTablet) && !state.memberListCollapsed && (
                      <div
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm z-30 animate-in fade-in"
                        onClick={() => setState((s) => ({ ...s, memberListCollapsed: true }))}
                      ></div>
                    )}

                    {(!(isMobile || isTablet) || !state.memberListCollapsed) && (
                      <div
                        className={`
                          absolute right-0 top-0 bottom-0 z-40 h-full
                          ${(isMobile || isTablet) ? 'z-[60] w-[min(20rem,calc(100vw-3rem))] pointer-events-auto' : ''}
                          ${!(isMobile || isTablet) && (state.memberListCollapsed && !memberListHovered) ? 'w-[10px] pointer-events-auto' : ''}
                          ${!(isMobile || isTablet) && (!state.memberListCollapsed || memberListHovered) ? 'w-[224px] pointer-events-auto' : ''}
                        `}
                        onMouseEnter={!(isMobile || isTablet) ? handleMemberEnter : undefined}
                        onMouseLeave={!(isMobile || isTablet) ? handleMemberLeave : undefined}
                      >
                        <MemberSidebar
                          members={activeServer.members}
                          currentUser={currentUser}
                          serverOwnerId={activeServer.ownerId}
                          serverId={activeServer.id}
                          runtimeSnapshot={shellData.runtimeSnapshot}
                          collapsed={!(isMobile || isTablet) && state.memberListCollapsed && !memberListHovered}
                          onToggleCollapse={() => {
                            setMemberListHovered(false);
                            toggleMemberDrawer();
                          }}
                          isOverlay={(isMobile || isTablet) || (memberListHovered && state.memberListCollapsed)}
                          onOpenDM={handleOpenDM}
                        />
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          {(isMobile || isTablet) && (
            <motion.div
              initial={{ y: 88 }}
              animate={{ y: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="min-h-[72px] w-full glass-panel flex items-center justify-around gap-0.5 px-1 pt-2 border-t border-white/5 pb-safe z-50 relative"
            >
              <BottomNavItem active={isHome} onClick={() => handleServerSelect('home')} icon={<Home size={22} />} label="HOME" />
              <BottomNavItem active={!isHome && !isExplore} onClick={openChannelDrawer} icon={<Menu size={22} />} label="CHANNELS" />
              <BottomNavItem active={false} disabled={!hasIdentity || !connectionState.canUseConnectivityActions} onClick={() => hasIdentity && connectionState.canUseConnectivityActions && setState((s) => ({ ...s, showCreateServer: true }))} icon={<div className="w-11 h-11 rounded-full bg-primary flex items-center justify-center text-bg-0 shadow-glow"><UsersIcon size={21} /></div>} label="CREATE" isCore />
              {hasServerDiscovery && <BottomNavItem active={isExplore} disabled={!connectionState.canUseConnectivityActions} onClick={() => handleServerSelect('explore')} icon={<Compass size={22} />} label="EXPLORE" />}
              <BottomNavItem active={false} onClick={() => setState((s) => ({ ...s, showSettings: true }))} icon={<SettingsIcon size={22} />} label="SETTINGS" />
            </motion.div>
          )}
        </div>
      </div>
      </div>
    </div>
   </StreamerModeProvider>
  );
};

const BottomNavItem = ({ active, disabled = false, onClick, icon, label, isCore = false }: { active: boolean; disabled?: boolean; onClick: () => void; icon: React.ReactNode; label: string; isCore?: boolean }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`flex flex-1 max-w-[88px] min-w-[48px] min-h-[48px] flex-col items-center justify-center gap-1 px-1 py-1 rounded-r1 transition-all ${disabled ? 'opacity-40 cursor-not-allowed' : 'active:scale-95'} ${active ? 'text-primary' : 'text-white/50 active:text-white/70'}`}
    aria-label={label}
    title={disabled ? 'Requires an active xorein connection' : label}
  >
    <div className={`transition-transform ${active ? 'scale-110' : ''}`}>{icon}</div>
    {!isCore && <span className="micro-label text-[8px] font-bold tracking-widest">{label}</span>}
  </button>
);

function resolveActiveServerId(currentServerId: string | 'home' | 'explore', shellData: ReturnType<typeof readShellRuntimeData>): string | 'home' | 'explore' {
  if (currentServerId === 'home' || currentServerId === 'explore') {
    return currentServerId;
  }
  if (shellData.servers.some((server) => server.id === currentServerId)) {
    return currentServerId;
  }
  return shellData.initialServerId;
}

function resolveActiveChannelId(
  serverId: string | 'home' | 'explore',
  currentChannelId: string,
  shellData: ReturnType<typeof readShellRuntimeData>,
): string {
  if (!currentChannelId) {
    return resolveDefaultChannelId(serverId, shellData);
  }
  if (serverId === 'home') {
    return shellData.directMessages.some((dm) => dm.id === currentChannelId)
      ? currentChannelId
      : resolveDefaultChannelId(serverId, shellData);
  }
  if (serverId === 'explore') {
    return '';
  }
  const server = shellData.servers.find((entry) => entry.id === serverId);
  const channels = server?.categories.flatMap((category) => category.channels) ?? [];
  return channels.some((channel) => channel.id === currentChannelId)
    ? currentChannelId
    : resolveDefaultChannelId(serverId, shellData);
}

function resolveDefaultChannelId(serverId: string | 'home' | 'explore', shellData: ReturnType<typeof readShellRuntimeData>): string {
  if (serverId === 'explore') {
    return '';
  }
  if (serverId === 'home') {
    return shellData.directMessages[0]?.id ?? '';
  }
  const server = shellData.servers.find((entry) => entry.id === serverId);
  const channels = server?.categories.flatMap((category) => category.channels) ?? [];
  return channels.find((channel) => channel.type === 'text')?.id ?? channels[0]?.id ?? '';
}

function hasVoiceChannel(
  serverId: string | 'home' | 'explore',
  voiceChannelId: string | null,
  shellData: ReturnType<typeof readShellRuntimeData>,
): boolean {
  if (!voiceChannelId || serverId === 'home' || serverId === 'explore') {
    return false;
  }
  const server = shellData.servers.find((entry) => entry.id === serverId);
  return (server?.categories.flatMap((category) => category.channels) ?? []).some(
    (channel) => channel.id === voiceChannelId && channel.type === 'voice',
  );
}

function createFallbackChannel(connectionState: ConnectionState, hasRuntimeSnapshot: boolean): Channel {
  const fallbackByState: Record<ConnectionState['status'], { id: string; name: string }> = {
    connected: {
      id: hasRuntimeSnapshot ? 'empty-shell' : 'runtime-pending',
      name: hasRuntimeSnapshot ? 'empty-shell' : 'waiting-for-runtime',
    },
    disconnected: { id: 'runtime-offline', name: 'runtime-offline' },
    reconnecting: { id: 'runtime-reconnecting', name: 'runtime-reconnecting' },
    'no-peer': { id: 'peer-unreachable', name: 'peer-unreachable' },
    'no-relay': { id: 'relay-unavailable', name: 'relay-unavailable' },
  };
  const fallback = fallbackByState[connectionState.status];
  return {
    id: fallback.id,
    name: fallback.name,
    type: 'text',
    categoryId: 'system',
  };
}

function buildVoiceControlState(input: {
  connectionState: ConnectionState;
  connectedVoiceChannelId: string | null;
  connectedVoiceChannelName: string;
  connectedVoiceSession: XoreinRuntimeVoiceSession | null;
  localMuted: boolean;
  voiceUi: {
    deafened: boolean;
    preDeafenMuted: boolean | null;
    videoOn: boolean;
    screenSharing: boolean;
    receiveOnly: boolean;
  };
  voiceActionStatus: { pending: string | null; error: string | null };
}): VoiceControlState {
  const participantCount = Object.keys(input.connectedVoiceSession?.participants ?? {}).length;
  const sessionAvailable = Boolean(input.connectedVoiceSession);
  // Voice controls are LOCAL (mute/deafen/video/screen/disconnect) and work even
  // when the relay is offline — only an active session is required.
  const canInteract = Boolean(input.connectedVoiceChannelId)
    && sessionAvailable
    && !input.voiceActionStatus.pending;

  let statusLabel = 'VOICE IDLE';
  let statusDetail = 'Join a voice channel to enable media controls.';

  if (input.connectedVoiceChannelId) {
    if (input.voiceActionStatus.pending) {
      statusLabel = 'VOICE SYNCING';
      statusDetail = `Updating ${input.voiceActionStatus.pending}…`;
    } else if (!sessionAvailable) {
      statusLabel = 'VOICE SESSION MISSING';
      statusDetail = `No live voice session is reported for ${input.connectedVoiceChannelName}.`;
    } else {
      const liveState = input.voiceUi.receiveOnly
        ? input.voiceUi.deafened ? 'WATCHING · DEAFENED' : 'WATCHING'
        : input.voiceUi.screenSharing
          ? 'SCREEN SHARING'
          : input.voiceUi.videoOn
            ? 'VIDEO ON'
            : input.voiceUi.deafened
              ? 'DEAFENED'
              : input.localMuted
                ? 'MUTED'
                : 'VOICE LIVE';
      statusLabel = liveState;
      const offlineNote = input.connectionState.canUseConnectivityActions
        ? ''
        : input.voiceUi.receiveOnly
          ? ' · relay offline (stream may be interrupted)'
          : ' · relay offline (others may not hear you)';
      const detailSuffix = input.voiceUi.receiveOnly
        ? input.voiceUi.deafened
          ? 'Watching live media; audio is deafened.'
          : 'Watching live media; microphone, camera and screen sharing are disabled.'
        : input.voiceUi.screenSharing
          ? 'Sharing your screen.'
          : input.voiceUi.videoOn
            ? 'Camera on.'
            : input.voiceUi.deafened
              ? 'Deafened.'
              : input.localMuted
                ? 'Muted.'
                : 'Connected.';
      statusDetail = `${participantCount} participant${participantCount === 1 ? '' : 's'} · ${detailSuffix}${offlineNote}`;
    }
  }

  if (input.voiceActionStatus.error) {
    statusLabel = 'VOICE ERROR';
    statusDetail = input.voiceActionStatus.error;
  }

  return {
    statusLabel,
    statusDetail,
    participantCount,
    muted: input.voiceUi.receiveOnly || input.localMuted,
    deafened: input.voiceUi.deafened,
    videoOn: input.voiceUi.receiveOnly ? false : input.voiceUi.videoOn,
    screenSharing: input.voiceUi.receiveOnly ? false : input.voiceUi.screenSharing,
    receiveOnly: input.voiceUi.receiveOnly,
    canInteract,
    pendingAction: input.voiceActionStatus.pending,
    error: input.voiceActionStatus.error,
    sessionAvailable,
    channelId: input.connectedVoiceChannelId,
  };
}

function formatVoiceActionError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return 'The local voice action failed.';
}

function firstTextChannelId(server: NonNullable<ReturnType<typeof readShellRuntimeData>['runtimeSnapshot']>['servers'][number]): string {
  const channels = Object.values(server.channels ?? {}).sort((left, right) => {
    const leftTime = Date.parse(left.created_at ?? '') || 0;
    const rightTime = Date.parse(right.created_at ?? '') || 0;
    return leftTime - rightTime;
  });
  return channels.find((channel) => !channel.voice)?.id ?? channels[0]?.id ?? '';
}

function readRequestedUtilityScreen(): 'friends' | 'login' | 'register' | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const search = safeLocationSearch();
  if (!search) {
    return null;
  }

  const params = new URLSearchParams(search);
  const auth = params.get('auth');
  if (auth === 'login' || auth === 'register') {
    return auth;
  }

  const panel = params.get('panel');
  return panel === 'friends' ? 'friends' : null;
}
