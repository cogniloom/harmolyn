import { safeStorageGet } from "../lib/browserStorage.js";
/**
 * Harmolyn Feature Flags
 *
 * Centralized feature toggle system. Set a flag to `true` to enable the feature UI.
 * Features flagged `false` are hidden but their code remains — flip to `true` when
 * the backend is ready.
 *
 * Features whose only behaviour would be browser-local (no xorein control-API
 * endpoint backs them) are flagged `false` and tracked in docs/PROTOCOL_GAPS.md.
 * Re-enable them once the matching runtime endpoint exists and the UI is wired to
 * a real call in src/lib/xoreinControl.ts. Do NOT ship a feature `true` if its
 * actions can only mutate localStorage — that is fake functionality.
 */
export const FEATURES = {
    // ─── App Shell ───────────────────────────────────────────
    multiPaneLayout: true,
    serverNavigation: true,
    relayAutoConnect: true,
    mobileBottomNav: true,
    contextMenus: true,
    quickSwitcher: true,
    serverFolders: true,
    // ─── Auth ────────────────────────────────────────────────
    loginScreen: true,
    registerScreen: true,
    qrLogin: true,
    mfa: true,
    accountSwitching: true,
    // ─── Community / social tooling ─────────────────────────
    // No DM message-request inbox endpoint (only friend requests). See PROTOCOL_GAPS.md.
    messageRequests: false,
    // ─── Voice text & call helpers ───────────────────────────
    // Local-only scratchpad; no per-voice-channel text endpoint. See PROTOCOL_GAPS.md.
    voiceTextChat: false,
    // ─── Channel / forum extras ───────────────────────────────
    channelFollowing: false,
    // ─── Settings / support surfaces ─────────────────────────
    // No payment/entitlement or event endpoints in xorein. See PROTOCOL_GAPS.md.
    donations: false,
    shop: false,
    quests: false,
    serverBoost: false,
    scheduledEvents: false,
    // ─── Server moderation / admin extras ────────────────────
    // No audit-event stream endpoint. (autoMod uses cap.moderation and stays on.)
    auditLog: false,
    autoMod: true,
    // ─── User ────────────────────────────────────────────────
    userStatus: true,
    profileCustomization: true,
    // No per-server member profile (nickname/bio) endpoint. See PROTOCOL_GAPS.md.
    serverProfile: false,
    friendsList: true,
    userPopout: true,
    // ─── Messaging ───────────────────────────────────────────
    markdownComposer: true,
    messageReactions: true,
    messageReplies: true,
    pinnedMessages: true,
    messageEditing: true,
    // No attachment/blob upload endpoint in xorein. See PROTOCOL_GAPS.md.
    fileUploads: false,
    emojiPicker: true,
    typingIndicators: true,
    linkEmbeds: true,
    spoilerText: true,
    messageForwarding: true,
    // Poll vote tallies are not stored server-side (votes would be local-only). See PROTOCOL_GAPS.md.
    polls: false,
    // No thread create/list endpoint. See PROTOCOL_GAPS.md.
    threads: false,
    slashCommands: true,
    messageLinks: true,
    superReactions: true,
    slowmode: true,
    jumpToPresent: true,
    unreadDivider: true,
    imageLightbox: true,
    deleteConfirmation: true,
    mentionAutocomplete: true,
    // ─── Voice & Video ───────────────────────────────────────
    voiceJoinLeave: true,
    // No screen-share track kind in the voice signaling endpoint. See PROTOCOL_GAPS.md.
    screenShare: false,
    voiceControlBar: true,
    // No sound-asset model or sound-effect playback endpoint. See PROTOCOL_GAPS.md.
    soundboard: false,
    // ─── Channels ────────────────────────────────────────────
    textVoiceChannels: true,
    channelCategories: true,
    // No forum-post model (title/tags/votes/views). See PROTOCOL_GAPS.md.
    forumChannels: false,
    announcementChannels: true,
    privateChannels: true,
    channelCreationFlow: true,
    channelPinsView: true,
    // No membership-application model. See PROTOCOL_GAPS.md.
    serverApplications: false,
    // ─── Server ──────────────────────────────────────────────
    serverSettings: true,
    serverDiscovery: true,
    rolesManagement: true,
    membersManagement: true,
    joinViaInvite: true,
    vanityUrls: true,
    // ─── Community ───────────────────────────────────────────
    communityOnboarding: true,
    serverGuide: true,
    browseChannels: true,
    discoverTab: true,
    // ─── Direct Messages ─────────────────────────────────────
    directMessages: true,
    // ─── Moderation ──────────────────────────────────────────
    timeout: true,
    roleHierarchyDragDrop: true,
    duplicateChannel: true,
    // ─── Search & Navigation ─────────────────────────────────
    advancedSearch: true,
    inbox: true,
    searchShortcuts: true,
    // ─── Settings ────────────────────────────────────────────
    themeSelection: true,
    accessibilitySettings: true,
    keyboardShortcuts: true,
    notificationSettings: true,
    // ─── Notifications ───────────────────────────────────────
    desktopNotifications: true,
    muteChannel: true,
    roleMentionSuppression: true,
    // ─── Community monetization and tagging ─────────────────
    serverTags: false,
    // ─── Other Implemented ───────────────────────────────────
    memberListPanel: true,
    // ─── Native P2P Engine (P10 cutover) ─────────────────────
    // When true, routes message/server/channel mutations through the native
    // browser P2P engine. The HTTP control client is still used for support-
    // service operations: joinServerByInvite, identity backup/restore, pins,
    // moderation/roles, notifications, file uploads, and voice frames.
    // Override via localStorage 'harmolyn:feature-overrides' to revert to
    // full HTTP for one release if issues are found in production.
    nativeEngine: true,
};
export const FEATURE_OVERRIDES_STORAGE_KEY = 'harmolyn:feature-overrides';
export function readFeatureOverrides() {
    if (typeof window === 'undefined') {
        return {};
    }
    const raw = safeStorageGet(() => window.localStorage, FEATURE_OVERRIDES_STORAGE_KEY);
    if (!raw) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) {
            return {};
        }
        const overridesInput = parsed;
        const overrides = {};
        for (const [key, value] of Object.entries(overridesInput)) {
            if (key in FEATURES && typeof value === 'boolean') {
                overrides[key] = value;
            }
        }
        return overrides;
    }
    catch {
        return {};
    }
}
export function resolveFeatureFlag(feature, overrides = readFeatureOverrides()) {
    return overrides[feature] ?? FEATURES[feature];
}
function isPlainObject(value) {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}
