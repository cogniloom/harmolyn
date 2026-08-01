/**
 * Capability routing manifest.
 *
 * Each entry describes one user-facing mutation: which transport path it uses
 * (native P2P engine, HTTP support node, or mixed) and whether it is P2P-propagated
 * to other peers. This is the single source of truth for the contract between the
 * mutation facade (`useRuntimeMutations`) and the rest of the system.
 *
 * CI test: `src/native/capabilityMap.test.ts` verifies that
 *   (a) every capability listed here has a corresponding export in the mutations
 *       facade, and
 *   (b) native-only capabilities never fall back to HTTP-only paths in code.
 *
 * Rule: a capability is 'native' only when ALL of the following are true:
 *   1. It writes to the NativeState store (no HTTP call on the default path).
 *   2. Its effects propagate to other peers (or the operation is purely local like
 *      setActiveScope).
 *   3. The feature flag `nativeEngine` being true routes it here — not a stub.
 */

export type CapabilityRoute =
  | 'native'        // NativeState write + P2P broadcast; no HTTP on default path
  | 'native-local'  // NativeState write only (local effect; no P2P needed)
  | 'http'          // HTTP support-node call only
  | 'mixed'         // Native write + HTTP best-effort (or engine picks one)
  | 'gap';          // Wired in facade but has no real backing (must stay hidden)

export interface CapabilityEntry {
  /** Mutation name as exported by useRuntimeMutations */
  name: string;
  /** How this operation is implemented on the native path */
  route: CapabilityRoute;
  /** True when the operation sends a P2P message to other peers */
  p2pPropagated: boolean;
  /** Short description of what this capability does */
  description: string;
}

export const CAPABILITY_MAP: CapabilityEntry[] = [
  // ── Messaging ─────────────────────────────────────────────────────────────
  { name: 'sendChannelMessage', route: 'native', p2pPropagated: true,
    description: 'Send a message to a server channel (crowd-encrypted)' },
  { name: 'sendDmMessage', route: 'native', p2pPropagated: true,
    description: 'Send a 1:1 DM (seal-encrypted per recipient)' },
  { name: 'editMessage', route: 'native', p2pPropagated: true,
    description: 'Edit an existing message body and broadcast the edit' },
  { name: 'deleteMessage', route: 'native', p2pPropagated: true,
    description: 'Tombstone a message and broadcast the deletion' },
  { name: 'addReaction', route: 'native', p2pPropagated: true,
    description: 'Add an emoji reaction and broadcast it to scope members' },
  { name: 'removeReaction', route: 'native', p2pPropagated: true,
    description: 'Remove an emoji reaction and broadcast the removal' },
  { name: 'pinMessage', route: 'native', p2pPropagated: true,
    description: 'Pin a channel message and broadcast the pin via notify' },
  { name: 'unpinMessage', route: 'native', p2pPropagated: true,
    description: 'Unpin a channel message and broadcast the unpin via notify' },

  // ── Server / channel ──────────────────────────────────────────────────────
  { name: 'createServer', route: 'native', p2pPropagated: false,
    description: 'Create a new server with a fresh crowd root and invite secret' },
  { name: 'joinServerByInvite', route: 'native', p2pPropagated: true,
    description: 'Join a server by deeplink; dials owner P2P to pull manifest' },
  { name: 'loadOlderHistory', route: 'native', p2pPropagated: true,
    description: 'Page older channel history from the owner or any reachable member (cursor pull)' },
  { name: 'createChannel', route: 'native', p2pPropagated: true,
    description: 'Create a channel and broadcast the updated server to members' },
  { name: 'updateChannel', route: 'native', p2pPropagated: true,
    description: 'Rename/edit a channel and broadcast to members' },
  { name: 'deleteChannel', route: 'native', p2pPropagated: true,
    description: 'Delete a channel and broadcast to members' },
  { name: 'updateServerMeta', route: 'native', p2pPropagated: true,
    description: 'Edit server name/description and broadcast to members' },
  { name: 'removeMember', route: 'native', p2pPropagated: true,
    description: 'Kick a member; tells that peer to forget the server' },
  { name: 'leaveServer', route: 'native', p2pPropagated: true,
    description: 'Leave a server; notifies the owner over P2P' },
  { name: 'deleteServer', route: 'native', p2pPropagated: true,
    description: 'Delete a server (owner only); notifies all members to forget it' },
  { name: 'inviteLink', route: 'native-local', p2pPropagated: false,
    description: 'Mint the shareable invite deeplink from the live invite secret (snapshot strips it)' },
  { name: 'previewServerInvite', route: 'native-local', p2pPropagated: false,
    description: 'Invite preview renders locally from the parsed deeplink on the native path — the support node is never told which server the user is about to join (HTTP preview is legacy-branch only)' },
  { name: 'rotateInvite', route: 'native-local', p2pPropagated: false,
    description: 'Rotate invite secret; new links are valid, old links rejected' },
  { name: 'revokeInvite', route: 'native-local', p2pPropagated: false,
    description: 'Revoke all invites by clearing the secret' },

  // ── Read state ────────────────────────────────────────────────────────────
  { name: 'setActiveScope', route: 'native-local', p2pPropagated: false,
    description: 'Set the viewed scope and clear its unread counter' },
  { name: 'markScopeRead', route: 'native-local', p2pPropagated: false,
    description: 'Explicitly clear a scope unread badge' },

  // ── Presence ──────────────────────────────────────────────────────────────
  { name: 'updatePresence', route: 'native', p2pPropagated: true,
    description: 'Update status/text/typing and broadcast to co-members + friends' },

  // ── Voice ─────────────────────────────────────────────────────────────────
  { name: 'joinVoiceChannel', route: 'native', p2pPropagated: true,
    description: 'Join voice; WebRTC mesh when voiceMediaTransport flag is on' },
  { name: 'leaveVoiceChannel', route: 'native', p2pPropagated: true,
    description: 'Leave voice; closes WebRTC connections to mesh peers' },
  { name: 'setVoiceMuted', route: 'mixed', p2pPropagated: true,
    description: 'Mute/unmute self; falls through to HTTP without voiceMediaTransport' },
  { name: 'setVoiceCamera', route: 'native', p2pPropagated: true,
    description: 'Enable/disable camera track (WebRTC add/remove)' },
  { name: 'startVoiceScreenShare', route: 'native', p2pPropagated: true,
    description: 'Start screen-share track (getDisplayMedia + WebRTC)' },
  { name: 'stopVoiceScreenShare', route: 'native', p2pPropagated: true,
    description: 'Stop screen-share track' },
  { name: 'isVoiceScreenSharing', route: 'native-local', p2pPropagated: false,
    description: 'Query whether screen share is active (sync, returns boolean)' },
  { name: 'sendVoiceFrame', route: 'http', p2pPropagated: false,
    description: 'Send a voice frame via HTTP (support-node bridge)' },

  // ── Relay ─────────────────────────────────────────────────────────────────
  { name: 'registerRelay', route: 'native', p2pPropagated: false,
    description: 'Add a relay override (persisted; used on reconnect)' },
  { name: 'removeRelay', route: 'native', p2pPropagated: false,
    description: 'Remove a relay override' },

  // ── Friends ───────────────────────────────────────────────────────────────
  { name: 'addFriendRequest', route: 'native', p2pPropagated: true,
    description: 'Send a friend request directly to the target peer' },
  { name: 'sendFriendRequest', route: 'native', p2pPropagated: true,
    description: 'Alias for addFriendRequest (facade compat)' },
  { name: 'acceptFriend', route: 'native', p2pPropagated: true,
    description: 'Accept a friend request and tell the requester over P2P' },
  { name: 'declineFriend', route: 'native-local', p2pPropagated: false,
    description: 'Decline a friend request (local removal; no P2P notification)' },
  { name: 'actOnFriendRequest', route: 'native', p2pPropagated: true,
    description: 'Accept/decline/cancel/block a friend request' },
  { name: 'removeFriend', route: 'http', p2pPropagated: false,
    description: 'Remove an accepted friend (HTTP support node)' },

  // ── DMs ───────────────────────────────────────────────────────────────────
  { name: 'ensureDirectMessage', route: 'native-local', p2pPropagated: false,
    description: 'Ensure a 1:1 DM thread exists for a peer (idempotent)' },

  // ── Identity ──────────────────────────────────────────────────────────────
  { name: 'createIdentity', route: 'mixed', p2pPropagated: false,
    description: 'Register identity; Argon2 encrypt + IndexedDB persist; HTTP best-effort' },
  { name: 'updateProfile', route: 'mixed', p2pPropagated: false,
    description: 'Update display name / bio / avatar; HTTP best-effort' },
  { name: 'restoreIdentity', route: 'http', p2pPropagated: false,
    description: 'Restore identity from encrypted backup via HTTP' },
  { name: 'getIdentityBackup', route: 'http', p2pPropagated: false,
    description: 'Download encrypted identity backup via HTTP' },

  // ── Roles / governance (native: owner-authoritative, synced via sync.update) ──
  { name: 'createRole', route: 'native', p2pPropagated: true,
    description: 'Create a server role; owner-authoritative, propagated via sync.update' },
  { name: 'updateRole', route: 'native', p2pPropagated: true,
    description: 'Rename/recolor/repermission a role; propagated via sync.update' },
  { name: 'deleteRole', route: 'native', p2pPropagated: true,
    description: 'Delete a server role; propagated via sync.update' },
  { name: 'assignRole', route: 'native', p2pPropagated: true,
    description: 'Assign roles to a member; propagated via sync.update' },
  { name: 'moderationAction', route: 'native', p2pPropagated: true,
    description: 'Kick/ban natively (owner removal + crowd-epoch rotation; ban also rotates the invite secret). Mute/slowmode/unban have no native primitive yet and reject honestly — moderation payloads are NEVER sent to the support node on the native path' },

  // ── Polls ─────────────────────────────────────────────────────────────────
  { name: 'castPollVote', route: 'native', p2pPropagated: true,
    description: 'Cast a poll vote; broadcast to scope members via notify.push' },

  // ── Search (client-side, local index) ─────────────────────────────────────
  { name: 'searchMessages', route: 'native-local', p2pPropagated: false,
    description: 'Full-text search over the local message store (no network)' },

  // ── Identity verification (safety numbers) ────────────────────────────────
  { name: 'setPeerVerified', route: 'native-local', p2pPropagated: false,
    description: 'Mark a peer identity verified out-of-band (local trust flag)' },

  // ── Abuse reporting ───────────────────────────────────────────────────────
  { name: 'submitReport', route: 'native', p2pPropagated: true,
    description: 'Submit an abuse report; delivered P2P to the server owner for server scope' },
  { name: 'resolveReport', route: 'native', p2pPropagated: false,
    description: 'Owner-side moderation: mark a received report resolved/dismissed (local state)' },

  // ── Notifications ─────────────────────────────────────────────────────────
  { name: 'markNotificationsRead', route: 'native-local', p2pPropagated: false,
    description: 'Clear a scope unread locally — read state never leaves the device' },
  { name: 'searchNotifications', route: 'native-local', p2pPropagated: false,
    description: 'Inbox items are derived client-side; no scope ids are sent to the support node' },

  // ── Blobs / uploads ───────────────────────────────────────────────────────
  { name: 'uploadAttachment', route: 'http', p2pPropagated: false,
    description: 'Legacy unscoped HTTP blob upload retained for old callers; ChatArea v1 attachments use the native node-preferred replica swarm' },
];

/** Quick lookup: route for a capability name. */
export function capabilityRoute(name: string): CapabilityRoute | undefined {
  return CAPABILITY_MAP.find(c => c.name === name)?.route;
}

/** All capabilities on the native (P2P) path. */
export const NATIVE_CAPABILITIES: string[] = CAPABILITY_MAP
  .filter(c => c.route === 'native' || c.route === 'native-local' || c.route === 'mixed')
  .map(c => c.name);

/** All capabilities still on the HTTP path. */
export const HTTP_CAPABILITIES: string[] = CAPABILITY_MAP
  .filter(c => c.route === 'http')
  .map(c => c.name);
