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

  // Monetization (donations/shop/quests/server boosts) and scheduled events were
  // removed for v1: xorein is a pure P2P network with no payment, ledger, or event
  // primitives, so those surfaces could only ever mutate localStorage. The dead
  // components + flags were deleted rather than shipped dark. Revisit only if the
  // network grows the matching protocol primitives (see docs/PROTOCOL_GAPS.md).

  // ─── Server moderation / admin extras ────────────────────
  // Real control-API endpoints: GET /v1/servers/{id}/audit, /v1/servers/{id}/automod/rules,
  // /v1/servers/{id}/bots. See docs/PROTOCOL_GAPS.md — resolved 2026-06-07.
  auditLog: true,
  autoMod: true,
  bots: true,

  // ─── User ────────────────────────────────────────────────
  userStatus: true,
  profileCustomization: true,
  friendsList: true,
  userPopout: true,

  // ─── Messaging ───────────────────────────────────────────
  markdownComposer: true,
  messageReactions: true,
  messageReplies: true,
  pinnedMessages: true,
  messageEditing: true,
  // Client-side-encrypted attachments: the file is AES-256-GCM encrypted in-browser
  // (src/native/blobs/), uploaded as OPAQUE ciphertext to the support node's
  // /v1/uploads, and the key travels only inside the E2EE message body. Fully wired
  // in ChatArea + AttachmentView with SHA-256 integrity verification on download.
  fileUploads: true,
  emojiPicker: true,
  typingIndicators: true,
  linkEmbeds: true,
  spoilerText: true,
  messageForwarding: true,
  // Polls: question+options encoded in message body, votes distributed P2P via notify.push.
  polls: true,
  // Threads: replies use reply_to field on messages, derived from messagesState P2P.
  threads: true,
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
  // voiceMediaTransport: master gate for real WebRTC media transport. Voice is a
  // peer-to-peer WebRTC MESH (no SFU) — signaling runs over /aether/voice/0.1.0
  // between peers, media is E2E-encrypted by DTLS (+ SFrame on server channels).
  // Joining is local-first: you appear in the channel the instant the mic is
  // captured, then the mesh connects best-effort.
  voiceMediaTransport: true,
  // voiceVideo: camera track add/remove via mesh renegotiation.
  voiceVideo: true,
  // screenShare: getDisplayMedia → screen/game track added to the mesh + a
  // kind-tagged signaling track so peers render it as a dedicated stream.
  screenShare: true,
  voiceControlBar: true,
  // voiceScaleSfu: opt-in peer-SFU topology for large voice channels. A single
  // elected coordinator (min peer-id over the roster) accepts each participant's
  // SFrame-opaque media and re-forwards it, so non-coordinators hold one connection
  // instead of N-1. SFrame keys are per-sender, so the coordinator relays ciphertext
  // it cannot read. Ships dark until the forwarding media path is smoke-tested live.
  voiceScaleSfu: false,

  // ─── Channels ────────────────────────────────────────────
  textVoiceChannels: true,
  channelCategories: true,
  // No forum-post model (title/tags/votes/views). See PROTOCOL_GAPS.md.
  forumChannels: false,
  announcementChannels: true,
  privateChannels: true,
  channelCreationFlow: true,
  channelPinsView: true,

  // ─── Server ──────────────────────────────────────────────
  serverSettings: true,
  serverDiscovery: true,
  // Roles: stored in server record (roles + member_roles), synced P2P via sync.update.
  // Owner-authoritative; role assignments propagate to all members via broadcastServerUpdate.
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
  // memberServedHistory: opt-in fallback that pulls a server's read-copy history from
  // ordinary MEMBERS (invite seeds / cursor paging) when the owner is offline. Ships
  // DARK: served messages aren't individually authenticated, so a malicious member
  // could serve forged history, and seeds can't verify the owner-only invite secret
  // anyway. Until history carries owner signatures, only the owner serves authoritative
  // history; with this flag off, paging/join fall back to owner-only + a local stub.
  memberServedHistory: false,
  // directTransport: direct browser↔browser WebRTC transport + DCUtR
  // hole-punching, upgrading relayed circuits to direct connections when the NAT
  // allows. ON by default: it only ADDS the /webrtc transport + dcutr service +
  // rendezvous discovery — the relayed path is unaffected, so it degrades
  // cleanly when hole-punching fails. Two payoffs: (1) LATENCY — messages and
  // voice signaling stop traversing the relay entirely once the direct link is
  // up; (2) RESILIENCE — direct connections survive relay loss (the transport
  // manager keeps the libp2p node alive across relay drops), so peers that
  // already know each other keep communicating with no infrastructure online.
  directTransport: true,
  // persistentPeerStreams: one long-lived multiplexed PeerStream per (peer,
  // protocol) with request_id-correlated responses, instead of a fresh stream
  // per request. Opening a stream through a relay circuit was the dominant cost
  // of a message (~50ms median, measured); with the pool it is paid once per
  // conversation, not once per message. Backward-compatible on the wire: every
  // deployed responder acts on complete length-prefixed frames (not stream
  // close), and one-shot peers simply close after the first response, which the
  // pool treats as a graceful drop. See src/native/families/streammux.ts.
  persistentPeerStreams: true,
} as const;

/** Union type of all feature flag keys */
export type FeatureKey = keyof typeof FEATURES;

export const FEATURE_OVERRIDES_STORAGE_KEY = 'harmolyn:feature-overrides';

export type FeatureOverrides = Partial<Record<FeatureKey, boolean>>;

export function readFeatureOverrides(): FeatureOverrides {
  if (typeof window === 'undefined') {
    return {};
  }

  const raw = safeStorageGet(() => window.localStorage, FEATURE_OVERRIDES_STORAGE_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      return {};
    }
    const overridesInput = parsed;
    const overrides: FeatureOverrides = {};

    for (const [key, value] of Object.entries(overridesInput)) {
      if (key in FEATURES && typeof value === 'boolean') {
        overrides[key as FeatureKey] = value;
      }
    }

    return overrides;
  } catch {
    return {};
  }
}

export function resolveFeatureFlag(feature: FeatureKey, overrides: FeatureOverrides = readFeatureOverrides()): boolean {
  return overrides[feature] ?? FEATURES[feature];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
