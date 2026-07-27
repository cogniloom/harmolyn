export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';
export type DonationTier = 'coffee' | 'supporter' | 'champion';
export type MessageLayout = 'modern' | 'bubbles' | 'terminal';

export interface User {
  id: string;
  username: string;
  avatar: string;
  status: UserStatus;
  role?: string;
  color?: string;
  bio?: string;
  joinedAt?: string;
  muted?: boolean;
  donationTier?: DonationTier;
  /** Voice: currently transmitting audio above the speaking threshold. */
  speaking?: boolean;
  /** Voice: has a live camera track. */
  video?: boolean;
  /** Voice: is sharing a screen/game stream. */
  screenSharing?: boolean;
}

export interface Message {
  id: string;
  userId: string;
  content: string;
  timestamp: string;
  attachments?: string[];
  /** End-to-end encrypted attachments (decrypted on view). */
  media?: XoreinAttachment[];
  reactions?: { emoji: string; count: number; reacted: boolean }[];
  isSystem?: boolean;
  pinned?: boolean;
  replyToId?: string;
  editedAt?: string;
  sticker?: boolean;
  /** Set when the message is deleted — kept for moderation tombstone display. */
  deletedAt?: string;
  /** Peer ID of the user who performed the deletion. */
  deletedBy?: string;
  /** Outbound delivery state (inbound messages have no status). */
  delivery_status?: 'pending' | 'sent' | 'offline_queued' | 'failed';
  /** Poll votes from P2P notify.push events — option_index → peer_ids. */
  poll_votes?: Record<number, string[]>;
  /**
   * The real per-message security mode (stamped at the encrypt/decrypt site).
   * Used to drive the security badge and per-message lock indicators from what
   * actually happened on the wire, never from the scope type.
   */
  securityMode?: 'seal' | 'crowd' | 'clear';
  /** True when this message was end-to-end encrypted on the wire. */
  encrypted?: boolean;
}

export interface Channel {
  id: string;
  name: string;
  type: 'text' | 'voice' | 'forum' | 'announcement';
  categoryId: string;
  unreadCount?: number;
  activeUsers?: User[];
  /** Text channel topic / voice channel description. */
  topic?: string;
  /** Voice channel target bitrate in kbps. */
  bitrate?: number;
  /** Voice channel participant cap (0 = unlimited). */
  userLimit?: number;
}

export interface Category {
  id: string;
  name: string;
  channels: Channel[];
}

export interface Server {
  id: string;
  name: string;
  icon: string;
  ownerId: string;
  categories: Category[];
  members: User[];
  banner?: string;
  region?: string;
  description?: string;
}

export interface DirectMessageChannel {
  id: string;
  userId: string;
  lastMessage?: string;
  unreadCount?: number;
  timestamp?: string;
}

export interface AppState {
  activeServerId: string | 'home' | 'explore';
  activeChannelId: string;
  connectedVoiceChannelId: string | null;
  viewMode: 'chat' | 'settings' | 'server-settings' | 'explorer';
  messageLayout: MessageLayout;

  // UI Layout States
  mobileMenuOpen: boolean;
  memberListCollapsed: boolean;
  channelListCollapsed: boolean;

  // Modals
  showCreateServer: boolean;
  showSettings: boolean;
}

export interface XoreinRuntimeProfile {
  display_name?: string;
  bio?: string;
  /** Self-contained avatar image as a data: URI (downscaled), broadcast to peers. */
  avatar?: string;
}

export interface XoreinRuntimeIdentity {
  id: string;
  peer_id: string;
  public_key?: string;
  created_at?: string;
  profile?: XoreinRuntimeProfile;
  /** True when this is an ephemeral guest identity (no password, not persisted). */
  is_guest?: boolean;
  /**
   * Base64 of this identity's HYBRID public key (Ed25519 ‖ ML-DSA-65), used to
   * compute the safety number a contact verifies against. Public material only.
   */
  identity_key?: string;
}

export interface XoreinRuntimePeer {
  peer_id: string;
  role?: string;
  addresses?: string[];
  public_key?: string;
  source?: string;
  last_seen_at?: string;
  /** Opportunistically learned from presence broadcasts. */
  display_name?: string;
  /** Opportunistically learned avatar data: URI from presence broadcasts. */
  avatar?: string;
  /**
   * Base64 of the peer's HYBRID public identity (Ed25519 ‖ ML-DSA-65), TOFU-pinned
   * the first time we verify their signed prekey bundle. Used for safety-number
   * computation and change detection.
   */
  identity_key?: string;
  /** True once the user has confirmed this peer's safety number out of band. */
  identity_verified?: boolean;
  /**
   * True when a later bundle presented a DIFFERENT identity key than the pinned one
   * — a re-key or a relay swap. Surfaces a "safety number changed" warning and
   * clears the verified flag until re-confirmed.
   */
  identity_changed?: boolean;
}

/**
 * A durable outbound-queue entry: an ENCRYPTED envelope that could not be sent
 * because the relay/transport was down at send time. Persisted (encrypted at rest)
 * and replayed on reconnect, so a message shown as "queued" is genuinely queued and
 * not silently discarded. The payload is already E2EE ciphertext (seal/crowd).
 */
export interface XoreinOutboxEntry {
  id: string;
  /** Peers this envelope still needs to reach. */
  targets: string[];
  /** PeerStream protocol id (e.g. the chat family). */
  protocol: string;
  /** Operation name (e.g. 'chat.send'). */
  operation: string;
  /** The encrypted wire payload to deliver verbatim. */
  payload: Record<string, unknown>;
  /** The local message this entry delivers, so its status can be updated on drain. */
  message_id?: string;
  created_at: string;
  attempts: number;
}

/**
 * An abuse report. Reports about a server are delivered P2P to that server's owner
 * (the moderator who can act); reports about a DM are kept locally. Stored encrypted
 * at rest like the rest of the native state.
 */
export interface XoreinReport {
  id: string;
  reason: string;
  details?: string;
  target_kind: 'message' | 'user';
  target_id: string;           // message id or reported peer id
  reported_peer_id?: string;   // the author/user being reported
  server_id?: string;
  channel_id?: string;
  content_excerpt?: string;    // short context snippet (owner can already read server content)
  reporter_peer_id: string;    // local peer (outbound) or authenticated remote (inbound, owner side)
  created_at: string;
  /** True on the server owner's copy of a report received from a member. */
  inbound?: boolean;
}

export interface XoreinRuntimeChannel {
  id: string;
  server_id: string;
  name: string;
  voice: boolean;
  created_at?: string;
  /** Text topic / voice description. */
  topic?: string;
  /** Voice channel target bitrate (kbps). */
  bitrate?: number;
  /** Voice channel participant cap (0/undefined = unlimited). */
  user_limit?: number;
}

export interface XoreinRuntimeManifest {
  name?: string;
  description?: string;
  owner_addresses?: string[];
  bootstrap_addrs?: string[];
  relay_addrs?: string[];
  capabilities?: string[];
  history_coverage?: string;
  history_retention_messages?: number;
  /**
   * How many recent messages the owner serves to a BRAND-NEW joiner. Default 0
   * (zero pre-join history — forward secrecy on join): a new member sees only what
   * is sent after they join. A server may opt into a bounded recent window by
   * setting this > 0. Existing members re-pulling always receive the full
   * `history_retention_messages` window.
   */
  join_history_messages?: number;
}

export interface ServerRole {
  id: string;
  name: string;
  color?: string;
  permissions: string[];
  protected?: boolean;
}

export interface XoreinRuntimeServer {
  id: string;
  name: string;
  description?: string;
  owner_peer_id: string;
  created_at?: string;
  updated_at?: string;
  members: string[];
  channels: Record<string, XoreinRuntimeChannel>;
  manifest?: XoreinRuntimeManifest;
  invite?: string;
  /** P2P-synced server roles (owner-authoritative, synced via sync.update). */
  roles?: ServerRole[];
  /** Maps peer_id → list of role IDs assigned to that member. */
  member_roles?: Record<string, string[]>;
  /**
   * Base64 of the 32-byte shared Crowd epoch root for this server's channel
   * E2EE. Owner-generated, distributed to members over the authenticated P2P
   * join stream only — never published to the support node. Held in local state
   * to key channel message encryption/decryption.
   */
  crowd_root?: string;
  /**
   * Monotonic epoch number for `crowd_root`. Bumped every time the owner rotates
   * the root (on member join and on kick/leave), and carried alongside the root so
   * every member installs the same epoch. Messages carry their epoch id, so a
   * remaining member can still decrypt in-flight old-epoch traffic (kept in a small
   * legacy window) while a removed member — who never receives the new root — is
   * locked out of all traffic at the new epoch. Defaults to 0 when absent.
   */
  crowd_epoch?: number;
  /**
   * Base64 secret used to mint/verify invite tokens (owner-held, never sent to
   * the support node). A joiner must present HMAC(invite_secret, server_id) to be
   * admitted and served history.
   */
  invite_secret?: string;
}

export interface XoreinRuntimeDM {
  id: string;
  participants: string[];
  created_at?: string;
}

/**
 * Reference to an end-to-end encrypted attachment. The file is AES-256-GCM
 * encrypted client-side and stored on the support node as OPAQUE ciphertext; the
 * `key`/`nonce` travel only inside the E2EE message body, so the node can never
 * decrypt the file. Recipients download the ciphertext by `id` and decrypt locally.
 */
export interface XoreinAttachment {
  id: string;            // node upload handle (opaque to the node)
  name: string;
  content_type: string;
  size: number;
  key: string;           // base64url AES-256-GCM key — E2EE, never sent to the node
  nonce: string;         // base64url 12-byte nonce
  content_hash?: string; // sha256 hex of the plaintext (integrity)
}

export interface XoreinRuntimeMessage {
  id: string;
  scope_type: string;
  scope_id: string;
  server_id?: string;
  sender_peer_id: string;
  body: string;
  /** Encrypted attachments (keys carried inside the E2EE payload). */
  media?: XoreinAttachment[];
  reply_to?: string;
  forwarded_from?: string;
  reactions?: { emoji: string; count: number; reacted: boolean; reactedBy?: string[] }[];
  created_at?: string;
  updated_at?: string;
  deleted?: boolean;
  /** True when pinned in the channel by a member with pin permission. */
  pinned?: boolean;
  /**
   * Delivery status for outbound messages (inbound messages have no status).
   *  pending       — written locally, P2P broadcast in progress.
   *  sent          — at least one P2P broadcast succeeded or offline mailbox accepted it.
   *  offline_queued — all targets were offline; deposited in the zero-knowledge mailbox.
   *  failed        — broadcast failed and mailbox deposit also failed.
   */
  delivery_status?: 'pending' | 'sent' | 'offline_queued' | 'failed';
  /**
   * Poll votes accumulated from P2P notify.push events.
   * Key = option index (as string), value = array of peer_ids that voted for that option.
   */
  poll_votes?: Record<number, string[]>;
  /**
   * The security mode under which this specific message actually crossed the wire,
   * stamped at the encrypt/decrypt site — NOT inferred from the scope type. Inbound
   * messages are only stored after successful decryption, so they always carry the
   * real mode; outbound messages carry `clear` only when encryption was impossible
   * (e.g. no crowd_root seeded) and the message was kept local. Drives the security
   * badge so the UI never claims encryption the wire did not provide.
   */
  security_mode?: 'seal' | 'crowd' | 'clear';
  /** True when this message was end-to-end encrypted on the wire (see security_mode). */
  encrypted?: boolean;
}

export interface XoreinRuntimeVoiceParticipant {
  peer_id: string;
  muted?: boolean;
  joined_at?: string;
  last_frame_at?: string;
  // Added for real WebRTC media transport:
  video?: boolean;
  screen_sharing?: boolean;
  speaking?: boolean;
  connection_state?: string;
}

export interface XoreinRuntimeVoiceSession {
  channel_id: string;
  participants: Record<string, XoreinRuntimeVoiceParticipant>;
  // Added for real WebRTC media transport:
  security_mode?: 'seal' | 'crowd' | 'tree' | 'clear';
  connection_state?: 'connecting' | 'connected' | 'failed' | 'closed';
  self_muted?: boolean;
}

// SDP/ICE wire types for voice signaling over /aether/voice/0.1.0.
// These are NOT part of the runtime snapshot — they live only in-flight.
export interface VoiceJoinRequest {
  session_id: string;
  peer_id: string;
  security_mode?: string;
  sequence: number;
}

export interface VoiceJoinResponse {
  session_id: string;
  joined: string;
}

export interface VoiceOfferRequest {
  session_id: string;
  peer_id: string;
  sdp: string;
  sequence: number;
  expires_at?: number;
}

export interface VoiceOfferResponse {
  session_id: string;
  accepted: boolean;
  sdp?: string;
  mid_to_peer?: Record<string, string>;
}

export interface VoiceIceRequest {
  session_id: string;
  peer_id: string;
  candidate: string;
  sequence: number;
}

export interface VoiceAnswerRequest {
  session_id: string;
  peer_id: string;
  sdp: string;
  sequence: number;
}

export type XoreinFriendStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'blocked';

export interface XoreinFriendRecord {
  id: string;
  from_peer_id: string;
  to_peer_id?: string;
  to_peer_addr?: string;
  status: XoreinFriendStatus;
  created_at?: string;
}

export interface XoreinPresenceEntry {
  status: string;
  status_text?: string;
  typing_in_scope?: string;
  updated_at: string;
}

export interface XoreinRuntimeSnapshot {
  role?: string;
  peer_id?: string;
  control_endpoint?: string;
  identity?: Partial<XoreinRuntimeIdentity>;
  known_peers?: XoreinRuntimePeer[];
  servers?: XoreinRuntimeServer[];
  /** Server ids the local identity has explicitly joined/created (membership filter). */
  joined_server_ids?: string[];
  dms?: XoreinRuntimeDM[];
  messages?: XoreinRuntimeMessage[];
  friends?: XoreinFriendRecord[];
  friend_requests?: XoreinFriendRecord[];
  voice_sessions?: XoreinRuntimeVoiceSession[];
  relay_addrs?: string[];
  settings?: Record<string, string>;
  telemetry?: string[];
  presence?: Record<string, XoreinPresenceEntry>;
  /** Per-scope unread message counts, keyed by channel id or DM id. */
  unread?: Record<string, number>;
  /** Abuse reports (owner-received + local outbound copies). */
  reports?: XoreinReport[];
}

export interface XoreinSessionSnapshot {
  serverId: string;
  securityMode?: string;
  connectedAtMs?: number;
  reconnectAttempts?: number;
  manifest?: {
    name?: string;
    description?: string;
  };
  acceptedProtocol?: {
    family: string;
    name: string;
    version: {
      major: number;
      minor: number;
    };
  } | null;
}

export type ConnectionLifecycleStatus = 'connected' | 'disconnected' | 'reconnecting' | 'no-peer' | 'no-relay';

export interface ConnectionState {
  status: ConnectionLifecycleStatus;
  label: string;
  detail: string;
  canUseConnectivityActions: boolean;
}
