import { safeStorageGet } from "../lib/browserStorage.js";

/**
 * Harmolyn Feature Flags
 *
 * Centralized feature toggle system. Set a flag to `true` to enable the feature UI.
 * Features flagged `false` are hidden but their code remains — flip to `true` when
 * the backend is ready.
 *
 * Features whose only behaviour would be browser-local (no Xorein protocol or
 * native-engine operation backs them) remain `false`. Re-enable one only after
 * the matching runtime operation exists and the UI is wired to it. Do NOT ship
 * a feature `true` if its actions can only mutate localStorage — that is fake
 * functionality.
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
  accountSwitching: true,

  // ─── Community / social tooling ─────────────────────────
  // No DM message-request inbox operation exists yet (friend requests are separate).
  messageRequests: false,

  // ─── Voice text & call helpers ───────────────────────────
  // No durable per-voice-channel text operation exists yet.
  voiceTextChat: false,

  // ─── Channel / forum extras ───────────────────────────────
  channelFollowing: false,

  // Monetization (donations/shop/quests/server boosts) and scheduled events were
  // removed for v1: xorein is a pure P2P network with no payment, ledger, or event
  // primitives, so those surfaces could only ever mutate localStorage. The dead
  // components + flags were deleted rather than shipped dark. Revisit only if the
  // network grows matching authenticated protocol operations.

  // ─── Server moderation / admin extras ────────────────────
  // The current xorein control API does not expose authenticated audit,
  // AutoMod, or bot handlers. Keep these hidden until the protocol and
  // owner-authority checks exist; a 404/501 support-node response is not a
  // feature implementation and must not be presented as one.
  auditLog: false,
  autoMod: false,
  bots: false,

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
  // Client-side-encrypted attachments: AES-256-GCM ciphertext is retained locally,
  // distributed to authenticated Xorein nodes first and then scope peers until the
  // replica target is met. The key travels only inside the E2EE message body.
  // AttachmentView verifies the signed manifest and SHA-256 content address.
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
  // No forum-post model exists yet (title, tags, votes, and views).
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
  // This is security-critical and cannot be overridden at runtime: the HTTP
  // control API is not an E2EE message transport.
  nativeEngine: true,
  // Every portable channel record now carries the original author's hybrid
  // signature. Members and archivists are untrusted availability providers; the
  // client verifies records locally and never treats provider quorum as truth.
  memberServedHistory: true,
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

// These flags are part of the confidentiality boundary, not product rollout
// switches. A same-origin value in localStorage must never be able to turn on
// an explicitly unsafe/unfinished path or turn off the native E2EE owner.
const NON_OVERRIDABLE_FEATURES: ReadonlySet<FeatureKey> = new Set([
  'nativeEngine',
  'memberServedHistory',
  'voiceScaleSfu',
]);

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
  if (NON_OVERRIDABLE_FEATURES.has(feature)) {
    return FEATURES[feature];
  }
  return overrides[feature] ?? FEATURES[feature];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
