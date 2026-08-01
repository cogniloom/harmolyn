// xorein native engine — unified API over the P0-P9 native P2P primitives.
// P10 cutover: replaces src/lib/xoreinControl.ts HTTP calls with native calls.
//
// The engine is gated behind feature flag 'nativeEngine'.
// When enabled, all data flows through the native P2P stack.
// When disabled (default), the existing HTTP control client is used unchanged.
import type { XoreinIdentity } from '../identity/identity.js';
import { generateIdentity, createIdentityCert, verifyIdentityCert, identitySigningKey } from '../identity/identity.js';
import { hybridSign, hybridVerify } from '../crypto/hybrid.js';
import { encryptIdentity, decryptIdentity, saveEncryptedIdentity, loadEncryptedIdentity, hasPersistedIdentity, loadOrCreateGuestIdentity, clearGuestIdentity, configureIdentityChatScopePersistence, type Argon2Params } from '../identity/storage.js';
import { XoreinTransportManager } from '../transport/manager.js';
import {
  RELAY_PEER_ID,
  RELAY_MULTIADDR,
  isTrustedPeerCircuitMultiaddr,
  isTrustedRelayMultiaddr,
  type Libp2p as Libp2pNode,
} from '../transport/node.js';
import { buildBundle, verifyBundle, x3dhInitiate, x3dhRespond, type PrekeyBundle, type PrekeyPrivate } from '../seal/bundle.js';
import { ratchetEncrypt, ratchetDecrypt, type RatchetState } from '../seal/ratchet.js';
import { newCrowdGroup, crowdEncrypt, crowdDecrypt, addSender, type CrowdState } from '../crowd/crowd.js';
import { newGroup as newTreeGroup, addMember, treeEncrypt, treeDecrypt, type GroupState } from '../tree/tree.js';
import { newPeerKey, encryptFrame, decryptFrame, type PeerKey } from '../voice/mediashield.js';
import { uploadBlob, downloadBlob, type BlobRef } from '../blobs/blobs.js';
import { seedBlobSwarm } from '../blobs/swarm.js';
import { deliverOffline, drainDeliveries } from '../delivery/mailbox.js';
import { serverRendezvousCID, rendezvousRegister, rendezvousDiscover } from '../transport/rendezvous.js';
import { initStore, setNativeIdentity, getState, updateState, upsertPeer, resetNativeStore, configureNativeStore, applyJoinedServer, mergeHistoryMessages, setStateEncryptionKey, pinPeerIdentity, removeServerMembership, setTransportState } from '../state/store.js';
import { identityKeyBlob } from '../identity/safetyNumber.js';
import { parseInviteMetadata } from '../../protocol/deeplink.js';
import type { XoreinRuntimeServer, XoreinRuntimeMessage } from '../../types.js';
import { publishNativeSnapshot } from '../state/snapshot.js';
import { PeerSync } from '../sync/peersync.js';
import {
  dispatchAuthenticatedOperation,
  registerInboundHandlers,
  ingestMailboxChat,
  replayBufferedChannelMessages,
} from '../sync/inbound.js';
import { registerPeerSync } from '../sync/registry.js';
import { SealSessions } from '../seal/session.js';
import { loadSealState, saveSealState } from '../seal/persist.js';
import { ChannelCrypto } from '../crowd/channel.js';
import { registerScopeCrypto, resetScopeCrypto, applyChannelRoot } from '../sync/secureEnvelope.js';
import { registerOfflineIdentity, resetOfflineIdentity, drainOfflineChat } from '../delivery/offline.js';
import {
  drainRecipientInbox,
  registerRecipientInboxIdentity,
  resetRecipientInboxIdentity,
} from '../delivery/recipientInbox.js';
import { PROTOCOLS, RECOVERY_OPS } from '../families/families.js';
import { frameMessage, encodePeerStreamResponse, serveFamilyStream, type InboundFamilyStream, type PeerStreamRequest } from '../families/peerstream.js';
import { VOICE_OPS, type VoicePresenceRequest, type VoiceOfferRequest, type VoiceIceRequest } from '../voice/signaling.js';
import {
  handleRecoveryStore, handleRecoveryStoreChunk, handleRecoveryRequest,
  handleRecoveryDeliver, handleRecoveryDeliverChunk,
  distributeRecovery, sendRecoveryRequest, approveRecovery, denyRecovery,
  type RecoveryDistributionResult,
} from '../recovery/recovery.js';
import { encryptSyncState, captureSyncState, restorePendingSyncState, registerStateSyncHandler, type EncryptedSyncBlob } from '../state/stateSync.js';
import { getRecoveryContacts } from '../recovery/custody.js';
import { VoiceSession } from '../voice/session.js';
import { registerVoiceSession, getVoiceSession, clearVoiceSession, rekeyVoiceForServer } from '../voice/registry.js';
import { resolveFeatureFlag } from '../../config/featureFlags.js';
import { decodeBase64Strict, isSafeBlobSwarmManifest } from '../security/limits.js';
import {
  registerHistoryIdentity,
  resetHistoryIdentity,
  selectNewestVerifiedVersions,
  verifySignedHistoryMessage,
} from '../sync/signedHistory.js';
import { registerReplicaIdentity, resetReplicaIdentity } from '../sync/replica.js';
import { fetchSwarmHistoryPage, type HistoryProviderKind } from '../sync/swarmHistory.js';
import { registerInviteIdentity, resetInviteIdentity } from '../sync/invite.js';
import {
  registerServerSigningIdentity,
  resetServerSigningIdentity,
  verifyServerRecord,
} from '../sync/signedServer.js';
import {
  ingestSignedPeerRecords,
  knownSignedPeerRecords,
  refreshLocalPeerRecord,
  registerPeerDiscoveryIdentity,
  resetPeerDiscovery,
  type SignedPeerRecord,
} from '../sync/peerDiscovery.js';
import { registerRouteIdentity, resetRouteIdentity } from '../sync/routedRequest.js';
import {
  nativeSendChannelMessage,
  nativeSendDmMessage,
  nativeEditMessage,
  nativeDeleteMessage,
  nativeAddReaction,
  nativeRemoveReaction,
  nativeCreateServer,
  nativeCreateChannel,
  nativeAddFriendRequest,
  nativeAcceptFriend,
  nativeDeclineFriend,
  nativeJoinVoice,
  nativeLeaveVoice,
  nativeAddRelay,
  nativeRemoveRelay,
  nativeUpdatePresence,
  nativeAnnouncePresence,
  nativeEnsureDm,
  nativeEnsureDirectMessage,
  nativeDrainOutbox,
} from '../state/mutations.js';

function isAuthoritativeJoinRecord(
  value: unknown,
  expectedServerId: string,
  expectedOwnerPeerId: string,
  localPeerId: string,
): value is XoreinRuntimeServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const server = value as Partial<XoreinRuntimeServer>;
  if (server.id !== expectedServerId || server.owner_peer_id !== expectedOwnerPeerId) return false;
  if (server.owner_proof && !verifyServerRecord(server as XoreinRuntimeServer)) return false;
  if (server.invite_secret !== undefined
    || !Array.isArray(server.members)
    || !server.members.includes(localPeerId)
    || !server.members.includes(expectedOwnerPeerId)
    || !server.channels
    || typeof server.channels !== 'object'
    || Array.isArray(server.channels)) return false;
  if (typeof server.crowd_root !== 'string' || decodeBase64Strict(server.crowd_root, 32)?.length !== 32) return false;
  if (server.channel_security_mode !== undefined
    && server.channel_security_mode !== 'tree'
    && server.channel_security_mode !== 'crowd') return false;
  if (server.channel_crypto_profile !== undefined
    && server.channel_crypto_profile !== 'scope-aad-v2') return false;
  if (server.replica_secret !== undefined
    && (typeof server.replica_secret !== 'string'
      || decodeBase64Strict(server.replica_secret, 32)?.length !== 32)) return false;
  if (server.crowd_epoch !== undefined
    && (!Number.isSafeInteger(server.crowd_epoch) || server.crowd_epoch < 0 || server.crowd_epoch > 0xffffffff)) return false;
  for (const [channelId, channel] of Object.entries(server.channels)) {
    if (!channel || channel.id !== channelId || channel.server_id !== expectedServerId) return false;
  }
  return true;
}

// Re-export all primitives for use by consumers.
export {
  // Identity
  generateIdentity, createIdentityCert, verifyIdentityCert, identitySigningKey,
  encryptIdentity, decryptIdentity, saveEncryptedIdentity, loadEncryptedIdentity, hasPersistedIdentity,
  // Transport
  XoreinTransportManager,
  // Seal DM
  buildBundle, verifyBundle, x3dhInitiate, x3dhRespond, ratchetEncrypt, ratchetDecrypt,
  // Group E2EE
  newCrowdGroup, crowdEncrypt, crowdDecrypt, addSender,
  newTreeGroup, addMember, treeEncrypt, treeDecrypt,
  // Voice
  newPeerKey, encryptFrame, decryptFrame,
  // Blobs
  uploadBlob, downloadBlob,
  // Delivery
  deliverOffline, drainDeliveries,
  // Discovery
  serverRendezvousCID,
  // State
  publishNativeSnapshot,
  nativeSendChannelMessage, nativeSendDmMessage,
  nativeEditMessage, nativeDeleteMessage,
  nativeAddReaction, nativeRemoveReaction,
  nativeCreateServer, nativeCreateChannel,
  nativeAddFriendRequest, nativeAcceptFriend, nativeDeclineFriend,
  nativeJoinVoice, nativeLeaveVoice,
  nativeAddRelay, nativeRemoveRelay,
  nativeUpdatePresence, nativeEnsureDm, nativeEnsureDirectMessage,
};

export type {
  XoreinIdentity,
  Argon2Params,
  PrekeyBundle, PrekeyPrivate, RatchetState,
  CrowdState, GroupState,
  PeerKey, BlobRef,
};

// ── Native Engine ──────────────────────────────────────────────────────────

/** A user-facing phase of engine startup/connectivity, surfaced for transparency. */
export type EngineActivityPhase =
  | 'idle'
  | 'starting'
  | 'decrypting'
  | 'connecting-relay'
  | 'reconnecting-relay'
  | 'discovering-peers'
  | 'syncing'
  | 'connected'
  | 'error';

export interface EngineActivity {
  phase: EngineActivityPhase;
  message: string;
  detail?: string;
}

export interface NativeEngineOptions {
  passphrase?: string;
  relayMultiaddr?: string;
  onStateChange?: (state: 'disconnected' | 'connecting' | 'connected') => void;
  /** Reports human-facing startup/connectivity phases so the UI can show progress. */
  onActivity?: (activity: EngineActivity) => void;
  /**
   * Called after local identity + crypto are ready, BEFORE transport connects.
   * Allows the UI to switch to native-mode mutations (local creates, sends, etc.)
   * even while the relay is still connecting or offline.
   */
  onLocalReady?: () => void;
}

/**
 * XoreinNativeEngine — the batteries-included xorein P2P engine running
 * entirely in the browser. Provides all primitives needed to replace the
 * HTTP control client.
 *
 * Lifecycle:
 *   const engine = new XoreinNativeEngine(opts);
 *   await engine.start();       // loads/generates identity + connects to relay
 *   engine.identity             // the local identity
 *   engine.transport.getCircuitAddrs()  // reachable circuit addresses
 *   await engine.stop();        // clean shutdown
 */
// An authoritative "you are not a member here" rejection from a server owner's sync.join —
// distinct from a transient unreachable/malformed response (null). Used to reconcile a kick
// that was missed while offline by dropping the stale server locally.
function isMembershipRejection(error: string | undefined): boolean {
  return error === 'invalid_invite';
}

// The engine instance that currently owns the native snapshot keys and the
// module-level E2EE/offline registrations. The provider stops a superseded
// engine WITHOUT awaiting when it restarts (e.g. an unlock retry); that stale
// stop() must never release ownership a newer start() has already claimed.
let _activeEngine: XoreinNativeEngine | null = null;

export class XoreinNativeEngine {
  private readonly opts: NativeEngineOptions;
  private _identity: XoreinIdentity | null = null;
  private _transport: XoreinTransportManager | null = null;
  private _started = false;
  private _wiredNode: Libp2pNode | null = null;
  private _presenceTimer: ReturnType<typeof setInterval> | null = null;
  private _peerDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
  private _recoveryRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private _peerDiscoveryRunning = false;
  private _replicaRepairRunning = false;
  private _replicaRepairCursor = 0;
  private _blobRepairRunning = false;
  private _blobRepairCursor = 0;
  private _legacyMailboxCursor = 0;
  private _rendezvousCursor = 0;
  private _lastRendezvousRefresh = 0;
  // Whether the CURRENT identity is an ephemeral guest. Starts true and is
  // resolved by bootstrapLocalState(); register() flips it to false in-session
  // (guest → registered promotion happens WITHOUT an engine restart). Checked
  // dynamically by the seal persistence hook so ratchet state written after a
  // promotion is persisted even though the engine booted in guest mode.
  private _guestMode = true;
  // The live Seal session manager (X3DH + Double Ratchet), kept so register()
  // can snapshot its state to encrypted storage at promotion time.
  private _seal: SealSessions | null = null;
  private _historyProviderCursor = 0;
  private _wakeListenersInstalled = false;
  readonly peerSync: PeerSync;

  constructor(opts: NativeEngineOptions) {
    this.opts = opts;
    this.peerSync = new PeerSync(opts.relayMultiaddr);
    registerPeerSync(this.peerSync);
  }

  private emitActivity(phase: EngineActivityPhase, message: string, detail?: string): void {
    this.opts.onActivity?.({ phase, message, ...(detail ? { detail } : {}) });
  }

  /** A browser/native app wake or newly connected peer may expose a holder of
   * our inbox even when no relay exists. Retry custody drains immediately. */
  private readonly onNetworkWake = (event?: Event): void => {
    if (event?.type === 'visibilitychange') {
      // publishNativeSnapshot emits a synthetic visibilitychange for legacy UI
      // refreshes. Ignore that internal event to avoid a network-drain loop.
      if (!event.isTrusted || typeof document === 'undefined'
        || document.visibilityState !== 'visible') return;
    }
    if (!this._started || !this._wiredNode) return;
    this.drainDurableInbox(false);
    void nativeDrainOutbox();
    void this.discoverPeersAndRelays();
    this.scheduleRecoveryResync();
  };

  private installWakeListeners(): void {
    if (this._wakeListenersInstalled || typeof window === 'undefined') return;
    window.addEventListener('online', this.onNetworkWake);
    window.addEventListener('pageshow', this.onNetworkWake);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onNetworkWake);
    }
    this._wakeListenersInstalled = true;
  }

  private removeWakeListeners(): void {
    if (!this._wakeListenersInstalled || typeof window === 'undefined') return;
    window.removeEventListener('online', this.onNetworkWake);
    window.removeEventListener('pageshow', this.onNetworkWake);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onNetworkWake);
    }
    this._wakeListenersInstalled = false;
  }

  get identity(): XoreinIdentity {
    if (!this._identity) throw new Error('engine: not started');
    return this._identity;
  }

  get transport(): XoreinTransportManager {
    if (!this._transport) throw new Error('engine: not started');
    return this._transport;
  }

  get isStarted(): boolean { return this._started; }

  /**
   * Resolve the local identity, configure the store's storage backend for the
   * resolved mode, and load + publish the persisted state. Extracted from
   * start() so the identity/state bootstrap can be tested without a transport.
   *
   * Identity modes:
   *  • a persisted (registered) identity always requires the user passphrase
   *    to decrypt;
   *  • a passphrase with no persisted identity means we are registering now;
   *  • no passphrase + nothing persisted means a guest (ephemeral).
   *
   * ORDER MATTERS: configureNativeStore() must run AFTER identity resolution
   * and IMMEDIATELY before initStore(), with no awaits in between. Configuring
   * the store to localStorage any earlier opens an async window in which a
   * stray UI mutation (e.g. a setActiveScope effect firing while the identity
   * is still locked) persists the EMPTY pre-init state to localStorage as
   * plaintext — permanently destroying the registered user's encrypted state
   * blob before it was ever loaded (the reload-wipes-account P0).
   */
  async bootstrapLocalState(): Promise<{ guestMode: boolean }> {
    const stored = await loadEncryptedIdentity();
    const guestMode = !stored && !this.opts.passphrase;
    this._guestMode = guestMode;
    // Mark the native engine as the live owner of the runtime snapshot keys for
    // this tab so HTTP support calls never overwrite them (see publishSnapshot).
    // Registering the instance in a module-scoped singleton is the point here —
    // this is not the `const self = this` closure workaround the rule targets.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    _activeEngine = this;
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__HARMOLYN_NATIVE_ACTIVE__ = true;
    }
    if (stored) {
      if (!this.opts.passphrase) {
        // Provider gates this; surface a clear locked error if it ever slips through.
        throw new Error('identity locked: passphrase required');
      }
      this.emitActivity('decrypting', 'Unlocking your account…');
      this._identity = await decryptIdentity(stored, this.opts.passphrase);
    } else if (this.opts.passphrase) {
      // Registering right now: persist the encrypted identity. A reload still
      // requires the password; no identity key is recoverable from storage alone.
      this._identity = await generateIdentity();
      await saveEncryptedIdentity(encryptIdentity(this._identity, this.opts.passphrase));
      clearGuestIdentity();
    } else {
      this._identity = await loadOrCreateGuestIdentity();
    }

    if (!guestMode) configureIdentityChatScopePersistence(this._identity);

    // Guests keep their app state in per-tab sessionStorage; registered
    // identities use localStorage. Configured AFTER identity resolution and
    // IMMEDIATELY before initStore() — no awaits in between (see docstring).
    configureNativeStore({ guest: guestMode });
    // Install the at-rest state-encryption key (derived from the unlocked identity
    // seed) BEFORE initStore() so it can decrypt an existing encrypted blob and so
    // every subsequent persist() writes ciphertext — crowd roots, invite secrets and
    // message bodies never touch disk in cleartext.
    setStateEncryptionKey(this._identity.edSeed);
    // Bootstrap the local state store with this identity.
    initStore();
    // If the persisted store belongs to a *different* identity (a new guest
    // session, or a different account), wipe it so identities never inherit each
    // other's servers/messages.
    const priorPeerId = getState().identity?.peer_id;
    if (priorPeerId && priorPeerId !== this._identity.peerId) {
      resetNativeStore();
    }
    // Preserve any profile (display_name, bio) that was persisted from a prior
    // session — e.g. after createIdentity synced it via mergeNativeIdentityProfile.
    // Without this, every page reload would wipe the display_name.
    const persistedProfile = getState().identity?.profile;
    setNativeIdentity({
      id: this._identity.peerId,
      peer_id: this._identity.peerId,
      created_at: new Date().toISOString(),
      ...(persistedProfile ? { profile: persistedProfile } : {}),
      // Our own hybrid public identity, so the UI can render the safety number a
      // contact verifies against.
      identity_key: identityKeyBlob(this._identity.edPub, this._identity.mldsaPub),
    });
    registerHistoryIdentity(this._identity);
    registerReplicaIdentity(this._identity);
    registerInviteIdentity(this._identity);
    registerServerSigningIdentity(this._identity);
    registerPeerDiscoveryIdentity(this._identity);
    registerRouteIdentity(this._identity);
    registerRecipientInboxIdentity(this._identity);
    // If we just recovered this identity on a new device, a guardian delivered an
    // encrypted snapshot of the account state — decrypt it with the identity key
    // and merge in the servers/DMs/profile so the account looks the same here.
    restorePendingSyncState(this._identity);
    publishNativeSnapshot();
    return { guestMode };
  }

  /**
   * Wire E2EE: our Seal prekey bundle + per-server Crowd channel keys. The
   * fetchBundle closure dials a peer's `seal.bundle` op over the relay circuit.
   * Called from start() BEFORE transport start so the seal.bundle inbound handler
   * can serve our bundle as soon as the data plane is wired. Extracted so the
   * promotion path (guest boot → register → reload) is testable sans transport.
   *
   * Registered identities persist their ratchet sessions (encrypted at rest) so
   * a reload keeps decrypting in-flight DMs; guests stay ephemeral. The persist
   * hook checks `_guestMode` at CALL time, not boot time: a guest who registers
   * mid-session (promotion — no engine restart) must have every subsequent
   * ratchet step persisted, or a reload silently loses all Seal sessions and
   * inbound DMs become undecryptable (post-reload delivery P0). While still a
   * guest it stays a no-op so ephemeral key material never touches localStorage.
   */
  private wireScopeCrypto(guestMode: boolean): void {
    const identity = this.identity;
    const persistedSeal = guestMode ? null : loadSealState(identity);
    const seal = new SealSessions(identity.peerId, identitySigningKey(identity), {
      persisted: persistedSeal,
      onChange: (state) => { if (!this._guestMode) saveSealState(identity, state); },
      // TOFU-pin each contact's verified hybrid identity so the UI can show a
      // safety number and warn if it ever changes (relay swap / re-key).
      onPeerIdentity: (peerId, identityKeyB64) => pinPeerIdentity(peerId, identityKeyB64),
    });
    this._seal = seal;
    const channels = new ChannelCrypto();
    registerScopeCrypto({ seal, channels, fetchBundle: (peerId) => this.peerSync.fetchBundle(peerId) });
    // Offline store-and-forward identity (zero-knowledge mailbox deposits/drains).
    registerOfflineIdentity(identity);
  }

  /**
   * Load or generate identity, then connect to the relay.
   * Idempotent — safe to call multiple times.
   */
  async start(): Promise<void> {
    if (this._started) return;
    this.emitActivity('starting', 'Starting up…');

    const { guestMode } = await this.bootstrapLocalState();

    // Keep recovery guardians' copies of the account state fresh: when servers/DMs
    // change, re-distribute the encrypted snapshot (debounced) so recovering on a
    // new device reflects recent state.
    registerStateSyncHandler(() => this.scheduleRecoveryResync());

    this.wireScopeCrypto(guestMode);

    // Signal local readiness: identity is loaded, E2EE managers are wired, and
    // local mutations (createServer, sendMessage, etc.) are safe to call. We emit
    // this BEFORE starting the transport so offline-capable ops don't wait for a
    // relay connection that may never arrive (e.g. offline device).
    this.opts.onLocalReady?.();

    // Start transport manager with the persistent identity.
    this._transport = new XoreinTransportManager({
      identity: this._identity,
      relayMultiaddr: this.opts.relayMultiaddr,
      onStateChange: (s) => {
        // The local control endpoint only proves that the runtime process exists.
        // Publish the transport lifecycle separately so the UI cannot call a
        // relay-less client "connected".
        const effectiveState = s === 'connected' || this._transport?.hasLivePeerPath() === true
          ? 'connected'
          : s;
        setTransportState(effectiveState);
        this.opts.onStateChange?.(effectiveState);
        if (s === 'connecting') {
          this.emitActivity(
            this._started ? 'reconnecting-relay' : 'connecting-relay',
            'Connecting to the network…',
          );
        }
        // Sync circuit relay addresses into the store so they appear in the
        // runtime snapshot and the Network settings panel.
        if (s === 'connected' && this._transport) {
          const circuitAddrs = this._transport.getCircuitAddrs();
          if (circuitAddrs.length > 0) {
            updateState(() => ({ relay_addrs: circuitAddrs }));
          }
          // Point PeerSync at whichever relay we actually reserved on (multi-relay
          // failover may have picked a backup), so peer fallback addresses resolve.
          const active = this._transport.getActiveRelay();
          if (active) this.peerSync.setRelay(active);
          // Record the actual bootstrap relay, not the build-time fallback, as a
          // reachable known peer. Local relays generate a fresh peer ID per data
          // directory, so seeding the stale production ID breaks first-contact
          // joins and friend requests even after reservation succeeds.
          this.seedBootstrapPeer(active ?? undefined);
          // resil-3: every (re)connect builds a NEW libp2p node. Re-point PeerSync
          // and re-register inbound family handlers at the live node so P2P
          // send/receive keeps working after a relay drop (previously this was
          // wired only once and stayed broken until a full page reload).
          void this.wireDataPlane(this._transport.currentNode);
          this.emitActivity('syncing', 'Syncing your messages…');
          // resil-2: pull any messages deposited in our zero-knowledge mailbox
          // while we were offline.
          this.drainOfflineMailbox();
          this.drainDurableInbox(true);
          // Reconcile joined servers: re-pull each owner's authoritative record so a
          // membership/epoch change we missed while offline (new crowd_root, roles) is
          // applied — otherwise we'd stay stuck on a stale epoch and fail to decrypt.
          void this.reconcileJoinedServers();
          // Replay our own durable outbound queue: messages composed while the relay
          // was down now go out (or into recipients' mailboxes) instead of being lost.
          void nativeDrainOutbox();
          this.scheduleRecoveryResync();
          // Announce we're online to friends + co-members (and keep a light
          // heartbeat) so they don't show us — and we don't show them — as offline.
          this.startPresenceHeartbeat();
          // Register ourselves in each joined server's rendezvous namespace so other
          // members can discover our circuit addresses for a direct WebRTC upgrade.
          // Gated on directTransport (dark by default) — the endpoint is the external
          // gateway, so this never fires on the default path.
          void this.registerServerRendezvous();
        } else if (s === 'disconnected') {
          this.emitActivity(
            this._started ? 'reconnecting-relay' : 'connecting-relay',
            'Reconnecting to the network…',
          );
          // Clear stale circuit addrs when the relay disconnects.
          updateState(st => ({
            relay_addrs: st.relay_addrs.filter(a => !a.includes('p2p-circuit')),
          }));
        }
        publishNativeSnapshot();
      },
    });
    await this._transport.start();
    // Ensure the data plane is wired even if 'connected' was emitted before we
    // got here (idempotent — wireDataPlane no-ops on an already-wired node).
    await this.wireDataPlane(this._transport?.currentNode ?? null);

    this._started = true;
    this.installWakeListeners();
    this.startRecoveryRefresh();
    // If the initial relay connection failed, upgrade the activity to the
    // non-blocking 'reconnecting-relay' phase so the startup banner clears.
    // Background retries will continue via scheduleReconnect.
    if (this._transport?.connectionState !== 'connected') {
      this.emitActivity('reconnecting-relay', 'Reconnecting to the network…');
    }
  }

  /**
   * Point PeerSync at the live libp2p node and register inbound family handlers.
   * Called on initial connect AND on every reconnect (each reconnect creates a
   * fresh node), so P2P send/receive survives relay drops. Idempotent per node.
   */
  private async wireDataPlane(node: Libp2pNode | null): Promise<void> {
    if (!node || this._wiredNode === node || !this._identity) return;
    this._wiredNode = node;
    this.peerSync.setNode(node);
    try {
      await registerInboundHandlers(node, this._identity.peerId, this.peerSync);
      node.addEventListener('peer:connect', () => this.onNetworkWake());
      refreshLocalPeerRecord(this.peerSync.localCircuitAddrs());
      this.startPeerDiscoveryLoop();
      // Presence and durable outbox retries belong to the peer node, not to a
      // dedicated relay reservation. Keep them alive in zero-node mode so a
      // newly discovered direct peer immediately participates in routing.
      this.startPresenceHeartbeat();
      // Inbound VOICE MESH handler. Peers dial us directly over /aether/voice/0.1.0
      // (there is no SFU): voice.presence (join/leave/state), voice.offer (SDP
      // offer → we answer), voice.leave (teardown). Request/response — we reply
      // with a framed PeerStreamResponse the caller reads back.
      await node.handle(
        PROTOCOLS.voice,
        (async (
          stream: InboundFamilyStream,
          connection: { remotePeer: { toString(): string }; remoteAddr?: { toString(): string } },
        ) => {
          try {
            const remotePeerId = connection.remotePeer.toString();
            const remoteAddr = connection.remoteAddr?.toString();
            if (remoteAddr?.includes('p2p-circuit')) this.peerSync.registerPeer(remotePeerId, remoteAddr);
            // Streams are persistent: a peer pipelines presence/offer/ice ops on
            // ONE stream, each answered by requestId (out-of-order safe).
            await serveFamilyStream(stream, async (req: PeerStreamRequest) => {
              const framedReply = (obj: unknown) =>
                frameMessage(encodePeerStreamResponse({ payload: new TextEncoder().encode(JSON.stringify(obj)), requestId: req.requestId }));
              let payload: Record<string, unknown> = {};
              try {
                payload = req.payload ? (JSON.parse(new TextDecoder().decode(req.payload)) as Record<string, unknown>) : {};
              } catch { return framedReply({ ok: false, error: 'bad_frame' }); }
              const channelId = String(payload.session_id ?? '');
              const session = channelId ? getVoiceSession(channelId) : null;

              if (req.operation === VOICE_OPS.presence) {
                return framedReply(session ? session.handlePresence(payload as unknown as VoicePresenceRequest, remotePeerId) : { ok: true, in_channel: false });
              } else if (req.operation === VOICE_OPS.offer) {
                return framedReply(session ? await session.handleOffer(payload as unknown as VoiceOfferRequest, remotePeerId) : { ok: false, error: 'not_in_channel' });
              } else if (req.operation === VOICE_OPS.ice) {
                return framedReply(session ? session.handleIce(payload as unknown as VoiceIceRequest, remotePeerId) : { ok: false });
              } else if (req.operation === VOICE_OPS.leave) {
                session?.handlePresence({ session_id: channelId, action: 'leave' }, remotePeerId);
                return framedReply({ ok: true });
              }
              return framedReply({ ok: false, error: 'unknown_op' });
            });
          } catch { /* non-fatal: malformed frame / unknown peer */ }
        }) as Parameters<typeof node.handle>[1],
        { runOnLimitedConnection: true },
      );

      // Inbound SOCIAL RECOVERY handler. recovery.store (hold a friend's backup),
      // recovery.request (surface a consent prompt), recovery.deliver (a guardian
      // sent back our backup). Request/response, framed reply.
      await node.handle(
        PROTOCOLS.recovery,
        (async (
          stream: InboundFamilyStream,
          connection: { remotePeer: { toString(): string } },
        ) => {
          try {
            const remotePeerId = connection.remotePeer.toString();
            // Streams are persistent: serve every framed request the peer sends.
            await serveFamilyStream(stream, async (req: PeerStreamRequest) => {
              const framedReply = (obj: unknown) =>
                frameMessage(encodePeerStreamResponse({ payload: new TextEncoder().encode(JSON.stringify(obj)), requestId: req.requestId }));
              let payload: Record<string, unknown> = {};
              try {
                payload = req.payload ? (JSON.parse(new TextDecoder().decode(req.payload)) as Record<string, unknown>) : {};
              } catch { return framedReply({ ok: false, error: 'bad_frame' }); }
              if (req.operation === RECOVERY_OPS.store) return framedReply(await handleRecoveryStore(payload, remotePeerId));
              if (req.operation === RECOVERY_OPS.storeChunk) return framedReply(await handleRecoveryStoreChunk(payload, remotePeerId));
              if (req.operation === RECOVERY_OPS.request) return framedReply(await handleRecoveryRequest(payload, remotePeerId));
              if (req.operation === RECOVERY_OPS.deliver) return framedReply(await handleRecoveryDeliver(payload, remotePeerId));
              if (req.operation === RECOVERY_OPS.deliverChunk) return framedReply(await handleRecoveryDeliverChunk(payload, remotePeerId));
              return framedReply({ ok: false, error: 'unknown_op' });
            });
          } catch { /* non-fatal */ }
        }) as Parameters<typeof node.handle>[1],
        { runOnLimitedConnection: true },
      );
    } catch { /* handlers already registered on this node */ }
  }

  /**
   * Drain the legacy pairwise mailbox for DM partners and re-inject any
   * recovered messages through the
   * authenticated inbound chat path. Idempotent: de-dup drops re-drained items.
   *
   * Channel history is reconstructed from the signed multi-source history
   * swarm; polling one pairwise token per server member does not scale.
   */
  private drainOfflineMailbox(): void {
    const st = getState();
    const contacts = new Set<string>();
    for (const dm of Object.values(st.dms)) for (const p of dm.participants ?? []) contacts.add(p);
    contacts.delete(this._identity?.peerId ?? '');
    const eligible = [...contacts];
    if (!eligible.length) {
      this.emitCurrentConnectivity();
      return;
    }
    const offset = this._legacyMailboxCursor % eligible.length;
    const batch = [...eligible.slice(offset), ...eligible.slice(0, offset)].slice(0, 16);
    this._legacyMailboxCursor = (offset + batch.length) % eligible.length;
    void drainOfflineChat(batch, ingestMailboxChat)
      .then((n) => { if (n > 0) publishNativeSnapshot(); this.emitCurrentConnectivity(); })
      .catch(() => { /* mailbox unreachable — retried on next connect */ this.emitCurrentConnectivity(); });
  }

  /** Report the actual authenticated network path after background sync work.
   * Finishing a local mailbox scan is not evidence of network connectivity. */
  private emitCurrentConnectivity(): void {
    if (this._transport?.hasLivePeerPath()) {
      this.emitActivity('connected', 'Connected');
      return;
    }
    this.emitActivity(
      'discovering-peers',
      'Finding peers…',
      'No live peer path is available yet. Peer and relay discovery continues automatically.',
    );
  }

  /**
   * Pull the account's single recipient-addressed inbox. New contacts and any
   * other targeted operation can be recovered without polling every possible
   * sender. Packets are opened and hybrid-authenticated before dispatch.
   */
  private drainDurableInbox(fullWindow = false): void {
    void drainRecipientInbox(
      operation => dispatchAuthenticatedOperation({
        protocol: operation.protocol,
        operation: operation.operation,
        payload: operation.payload,
      }, operation.origin_peer_id, this.peerSync),
      fullWindow,
    ).then((count) => {
      if (count > 0) publishNativeSnapshot();
    }).catch(() => { /* provider set is transient; the discovery loop retries */ });
  }

  private startPeerDiscoveryLoop(): void {
    if (this._peerDiscoveryTimer != null) return;
    void this.discoverPeersAndRelays();
    this._peerDiscoveryTimer = setInterval(() => {
      void this.discoverPeersAndRelays();
    }, 30_000);
  }

  private stopPeerDiscoveryLoop(): void {
    if (this._peerDiscoveryTimer != null) {
      clearInterval(this._peerDiscoveryTimer);
      this._peerDiscoveryTimer = null;
    }
  }

  /**
   * Continuously exchange self-authenticating address records with the active
   * relay and a rotating sample of connected peers. Candidate nodes are probed
   * over Noise; only responders that identify as relays enter failover.
   */
  private async discoverPeersAndRelays(): Promise<void> {
    if (this._peerDiscoveryRunning || !this._wiredNode || !this._transport) return;
    this._peerDiscoveryRunning = true;
    try {
      // Inbox/outbox recovery is latency-sensitive and only needs the existing
      // authenticated graph. Never serialize it behind a dead relay probe,
      // replica repair, or rendezvous maintenance.
      this.drainDurableInbox(false);
      void nativeDrainOutbox();
      refreshLocalPeerRecord(this.peerSync.localCircuitAddrs());
      const knownIDs = knownSignedPeerRecords().map(record => record.peer_id).slice(0, 200);
      const batches: (SignedPeerRecord[] | null)[] = [];
      const activeRelay = this._transport.getActiveRelay();
      if (activeRelay) {
        batches.push(await this.peerSync.exchangePeersAt(activeRelay, knownIDs));
      }
      const connected = [...new Set(this._wiredNode.getConnections()
        .map(connection => connection.remotePeer?.toString())
        .filter((peer): peer is string => Boolean(peer))
        .filter(peer => peer !== activeRelay?.split('/p2p/').at(-1)))]
        .slice(0, 4);
      batches.push(...await Promise.all(connected.map(peer =>
        this.peerSync.exchangePeersWith(peer, knownIDs),
      )));

      const accepted = ingestSignedPeerRecords(
        batches.flatMap(batch => batch ?? []),
        this._identity?.peerId,
      );
      for (const record of accepted) {
        const circuitAddresses = record.addresses.filter(address =>
          isTrustedPeerCircuitMultiaddr(address, record.peer_id),
        );
        if (circuitAddresses.length) {
          this.peerSync.registerPeer(record.peer_id, circuitAddresses[0]);
        }
        upsertPeer({
          peer_id: record.peer_id,
          role: getState().peers[record.peer_id]?.role ?? 'peer',
          addresses: record.addresses,
          source: 'pex',
          last_seen_at: new Date().toISOString(),
        });

        // Direct WSS/WebTransport addresses are safe to probe only because the
        // record is hybrid-signed and the final /p2p id pins the Noise identity.
        for (const address of record.addresses) {
          if (!isTrustedRelayMultiaddr(address, record.peer_id)
            || !this._transport.allowVerifiedCandidate(address)) continue;
          const info = await this.peerSync.peerInfoAt(address);
          if (!info || info.peer_id !== record.peer_id) continue;
          const role = info.role === 'relay' || info.role === 'archivist'
            || info.role === 'bootstrap' || info.role === 'client'
            ? info.role
            : 'peer';
          upsertPeer({
            peer_id: record.peer_id,
            role,
            addresses: record.addresses,
            source: 'pex',
            last_seen_at: new Date().toISOString(),
          });
          if (role === 'relay') this._transport.addDiscoveredRelay(address);
          break;
        }
      }
      if (accepted.length) publishNativeSnapshot();
      await this.repairHistoryReplicas();
      await this.repairBlobReplicas();
      await this.refreshRendezvousMesh();
      this.drainOfflineMailbox();
      this.drainDurableInbox(false);
    } finally {
      this._peerDiscoveryRunning = false;
    }
  }

  /**
   * Continuously repair recent signed channel history toward three node-held
   * ciphertext copies. The scan is bounded and rotating, so a large server does
   * not burst-upload its entire local database when one new node appears.
   */
  private async repairHistoryReplicas(): Promise<void> {
    if (this._replicaRepairRunning) return;
    const state = getState();
    const hasStorageNode = Object.values(state.peers)
      .some(peer => peer.role === 'relay' || peer.role === 'archivist');
    if (!hasStorageNode) return;
    this._replicaRepairRunning = true;
    try {
      const eligible: XoreinRuntimeMessage[] = [];
      for (const server of Object.values(state.servers)) {
        if (!server.replica_secret) continue;
        const retention = Math.max(1, Math.min(
          10_000,
          server.manifest?.history_retention_messages ?? 100,
        ));
        const joinWindow = Math.max(0, Math.min(
          retention,
          server.manifest?.join_history_messages ?? 0,
        ));
        const currentBoundaries = (server.members ?? [])
          .map(member => server.member_since?.[member])
          .filter((value): value is string => Boolean(value))
          .sort();
        const newestJoin = currentBoundaries.at(-1);
        for (const channelId of Object.keys(server.channels ?? {})) {
          const scoped = state.messages
            .filter(message => message.server_id === server.id
              && message.scope_type === 'channel'
              && message.scope_id === channelId
              && verifySignedHistoryMessage(message).ok)
            .sort((a, b) =>
              String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
              || a.id.localeCompare(b.id))
            .slice(-retention);
          if (!newestJoin) {
            eligible.push(...scoped);
            continue;
          }
          const beforeJoin = scoped.filter(message => String(message.created_at ?? '') < newestJoin);
          const afterJoin = scoped.filter(message => String(message.created_at ?? '') >= newestJoin);
          // Re-encrypt only the pre-join window the newest member is entitled to.
          // Older replicas remain under prior Crowd epochs and cannot be read by
          // that member after the join-triggered key rotation.
          eligible.push(...beforeJoin.slice(-joinWindow), ...afterJoin);
        }
      }
      if (!eligible.length) return;
      const offset = this._replicaRepairCursor % eligible.length;
      const batch = [
        ...eligible.slice(offset),
        ...eligible.slice(0, offset),
      ].slice(0, 12);
      this._replicaRepairCursor = (offset + batch.length) % eligible.length;
      // Four concurrent records × at most eight bounded node attempts prevents
      // one client from spiking node bandwidth during repair.
      for (let index = 0; index < batch.length; index += 4) {
        await Promise.all(batch.slice(index, index + 4).map(message =>
          this.peerSync.repairHistoryReplica(message, 3),
        ));
      }
    } finally {
      this._replicaRepairRunning = false;
    }
  }

  /**
   * Re-audit locally complete attachment swarms and fill missing replicas.
   * Only a small rotating batch is touched each discovery tick.
   */
  private async repairBlobReplicas(): Promise<void> {
    if (this._blobRepairRunning) return;
    const manifests = new Map<string, NonNullable<XoreinRuntimeMessage['media']>[number]['swarm']>();
    for (const message of getState().messages) {
      for (const attachment of message.media ?? []) {
        if (isSafeBlobSwarmManifest(attachment.swarm)) {
          manifests.set(attachment.swarm.blob_id, attachment.swarm);
        }
      }
    }
    const eligible = [...manifests.values()].filter(
      (manifest): manifest is NonNullable<typeof manifest> => Boolean(manifest),
    );
    if (!eligible.length) return;
    this._blobRepairRunning = true;
    try {
      const offset = this._blobRepairCursor % eligible.length;
      const batch = [...eligible.slice(offset), ...eligible.slice(0, offset)].slice(0, 4);
      this._blobRepairCursor = (offset + batch.length) % eligible.length;
      await Promise.allSettled(batch.map(manifest => seedBlobSwarm(manifest)));
    } finally {
      this._blobRepairRunning = false;
    }
  }

  /**
   * Keep peer-hosted rendezvous records fresh and continuously sample joined
   * namespaces. This runs even when no support relay answered PEX.
   */
  private async refreshRendezvousMesh(): Promise<void> {
    if (!resolveFeatureFlag('directTransport')) return;
    const now = Date.now();
    if (now - this._lastRendezvousRefresh >= 5 * 60_000) {
      this._lastRendezvousRefresh = now;
      await this.registerServerRendezvous();
    }
    const ids = getState().joined_server_ids;
    if (!ids.length) return;
    const offset = this._rendezvousCursor % ids.length;
    const batch = [...ids.slice(offset), ...ids.slice(0, offset)].slice(0, 2);
    this._rendezvousCursor = (offset + batch.length) % ids.length;
    await Promise.allSettled(batch.map(serverId => this.discoverServerPeers(serverId)));
  }

  /**
   * Announce online presence to friends + co-members now and on a light heartbeat.
   * Re-announcing covers peers who connect after us or live on a different relay —
   * without it, presence only ever updates when someone happens to type.
   */
  /**
   * On (re)connect, re-pull each joined server's authoritative record from its owner.
   * Membership/epoch changes (join/kick/leave) are distributed by a fire-and-forget
   * sync.update; a member who was OFFLINE when it fired never receives the new crowd_root
   * and would be stuck on a stale epoch — unable to decrypt any subsequent channel traffic.
   * A re-pull (sync.join is exempt from the invite check for an existing member) reconciles
   * the root/epoch, roles/membership, and any messages missed while offline. Best-effort and
   * idempotent (applyJoinedServer de-dups by id; the crypto re-seeds the new root lazily).
   */
  private async reconcileJoinedServers(): Promise<void> {
    const me = this._identity?.peerId;
    if (!me) return;
    const displayName = getState().identity?.profile?.display_name;
    const servers = Object.values(getState().servers)
      .filter(s => s.owner_peer_id && s.owner_peer_id !== me && (s.members ?? []).includes(me));
    let changed = false;
    for (const s of servers) {
      try {
        const priorEpoch = typeof s.crowd_epoch === 'number' ? s.crowd_epoch : -1;
        const data = await this.peerSync.joinServer(
          s.owner_peer_id,
          s.id,
          displayName,
          s.admission_capability,
        );
        // Reconcile a MISSED KICK: if we were removed while offline, our persisted snapshot
        // still lists us as a member, so this re-pull reaches the owner and is authoritatively
        // rejected ({ ok:false } with a membership error). Drop the stale server locally so it
        // stops showing indefinitely. A null response is "unreachable/malformed" (not a
        // rejection) and is retried on the next reconnect, so it must NOT trigger removal.
        if (data && data.ok === false && isMembershipRejection(data.error)) {
          removeServerMembership(s.id);
          changed = true;
          continue;
        }
        if (data?.ok && data.server) {
          const nextServer = data.server as XoreinRuntimeServer;
          if (!isAuthoritativeJoinRecord(nextServer, s.id, s.owner_peer_id, me)) continue;
          const supplied = (data.messages ?? []) as XoreinRuntimeMessage[];
          const verified = selectNewestVerifiedVersions(supplied);
          const legacyOwnerAuthored = supplied.filter(message =>
            !message.author_proof && message.sender_peer_id === s.owner_peer_id);
          if (!applyJoinedServer(s.id, nextServer, [...verified, ...legacyOwnerAuthored])) {
            continue; // owner answered for a different server — ignore
          }
          changed = true;
          // If the re-pulled snapshot advanced the Crowd epoch while we were offline (a
          // rotation we missed — e.g. a member was kicked), install the new root into the
          // live channel crypto, replay any future-epoch ciphertext that raced ahead of it,
          // and rekey any active voice call. applyJoinedServer only updates the store; the
          // crypto/voice side must be re-seeded here or we'd stay on the stale key and fail
          // to decrypt current-epoch channel and voice traffic.
          const nextEpoch = typeof nextServer.crowd_epoch === 'number' ? nextServer.crowd_epoch : -1;
          if (typeof nextServer.crowd_root === 'string' && nextEpoch > priorEpoch) {
            applyChannelRoot(nextServer.id);
            replayBufferedChannelMessages(nextServer.id);
            rekeyVoiceForServer(nextServer.id);
          }
        } else if (s.admission_capability) {
          // The owner is still unreachable. Re-announce the owner-signed
          // admission to a rotating set of members so membership converges
          // without waiting for any dedicated node.
          void this.propagatePortableAdmission(s, s.admission_capability);
        }
      } catch {
        if (s.admission_capability) {
          void this.propagatePortableAdmission(s, s.admission_capability);
        }
      }
    }
    if (changed) publishNativeSnapshot();
  }

  private async propagatePortableAdmission(
    server: XoreinRuntimeServer,
    capability: string,
    skipPeerId?: string,
  ): Promise<void> {
    const me = this._identity?.peerId;
    if (!me || !capability) return;
    const peers = [...new Set((server.members ?? []).filter(peer =>
      peer && peer !== me && peer !== skipPeerId,
    ))];
    // Bound concurrency so a 1,000-member server cannot make a newly joined
    // client stampede every peer at once.
    for (let offset = 0; offset < peers.length; offset += 8) {
      await Promise.allSettled(peers.slice(offset, offset + 8).map(peer =>
        this.peerSync.joinServer(
          peer,
          server.id,
          getState().identity?.profile?.display_name,
          capability,
        ),
      ));
    }
  }

  private startPresenceHeartbeat(): void {
    if (this._presenceTimer != null) return;
    nativeAnnouncePresence();
    this._presenceTimer = setInterval(() => {
      nativeAnnouncePresence();
      // Also drain the outbound queue on the heartbeat, not only on our own transport
      // (re)connect. A first-contact pending_seal DM is queued while WE are already
      // connected but the RECIPIENT is offline; when they later come online there is no
      // sender-side connect event, so without this periodic retry it would never ship.
      void nativeDrainOutbox();
    }, 25_000);
  }

  private stopPresenceHeartbeat(): void {
    if (this._presenceTimer != null) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
  }

  async stop(): Promise<void> {
    this.stopPresenceHeartbeat();
    this.stopPeerDiscoveryLoop();
    this.removeWakeListeners();
    if (this._recoveryResyncTimer) {
      clearTimeout(this._recoveryResyncTimer);
      this._recoveryResyncTimer = null;
    }
    if (this._recoveryRefreshTimer) {
      clearInterval(this._recoveryRefreshTimer);
      this._recoveryRefreshTimer = null;
    }
    await this._transport?.stop();
    this._wiredNode = null;
    // Release native snapshot ownership + E2EE managers so a re-init starts clean
    // and HTTP support calls aren't permanently suppressed after teardown (bug-3).
    // ONLY if a newer engine hasn't already claimed ownership: the provider stops
    // a superseded engine without awaiting when it restarts (e.g. unlock retry),
    // and that late teardown must not wipe the replacement's registrations.
    if (_activeEngine === this) {
      _activeEngine = null;
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).__HARMOLYN_NATIVE_ACTIVE__ = false;
      }
      resetScopeCrypto();
      resetOfflineIdentity();
      resetHistoryIdentity();
      resetReplicaIdentity();
      resetInviteIdentity();
      resetServerSigningIdentity();
      resetPeerDiscovery();
      resetRouteIdentity();
      resetRecipientInboxIdentity();
    }
    this._started = false;
  }

  /**
   * Promote the current (guest) identity to a registered, password-protected one:
   * encrypt the in-memory private key under the user passphrase, persist it to
   * IndexedDB, drop the throwaway guest copy, and attach the profile. The peer_id
   * is preserved (no re-keying), and no engine restart is required.
   */
  async register(passphrase: string, displayName?: string, bio?: string): Promise<void> {
    if (!this._identity) throw new Error('engine: not started');
    if (!passphrase) throw new Error('engine: a passphrase is required to register');
    await saveEncryptedIdentity(encryptIdentity(this._identity, passphrase));
    // Switch chat-scope persistence from the guest's memory-only mode to an
    // identity-derived encrypted mode. The identity itself remains password-
    // gated across reloads.
    configureIdentityChatScopePersistence(this._identity);
    clearGuestIdentity();
    // Promotion: this identity is registered from here on. Flip BEFORE the seal
    // snapshot below so the dynamic guest check in the seal onChange hook starts
    // persisting, then snapshot the CURRENT seal state (published prekey bundle +
    // any ratchets already established as a guest) to encrypted storage right now —
    // otherwise nothing is saved until the next ratchet step, and a reload in
    // between regenerates the bundle/drops the sessions, breaking in-flight DMs.
    this._guestMode = false;
    if (this._seal) saveSealState(this._identity, this._seal.serialize());
    // Promote app-state storage from per-session guest storage (sessionStorage)
    // to persistent localStorage now that this is a registered identity. The next
    // updateState/persist writes the full in-memory state (identity + any servers
    // created as a guest) to localStorage so it survives reload + unlock.
    configureNativeStore({ guest: false });
    const cur = getState().identity ?? { id: this._identity.peerId, peer_id: this._identity.peerId };
    // Merge into any existing profile so a previously-set display_name/bio is
    // preserved, and never drop the display_name passed in here (the old ternary
    // omitted the whole profile when the name was falsy).
    const mergedProfile = {
      ...(cur.profile ?? {}),
      ...(displayName ? { display_name: displayName } : {}),
      ...(bio ? { bio } : {}),
    };
    setNativeIdentity({
      ...cur,
      id: this._identity.peerId,
      peer_id: this._identity.peerId,
      ...(Object.keys(mergedProfile).length ? { profile: mergedProfile } : {}),
    });
    // Drop the now-orphaned guest app-state copy from sessionStorage.
    try {
      if (typeof window !== 'undefined') window.sessionStorage.removeItem('harmolyn:native:state');
    } catch { /* best effort */ }
    publishNativeSnapshot();
  }

  /** Whether a registered (password-protected) identity is persisted on this device. */
  static hasRegisteredIdentity(): Promise<boolean> {
    return hasPersistedIdentity();
  }

  /**
   * Join a server from an invite over P2P: parse the owner peer id from the
   * invite, dial the owner across the relay circuit, pull the server's
   * manifest/channels/history, and store it (membership recorded; the owner adds
   * us to its member list). Unreachable or malformed owners are reported as a
   * failed join; no local placeholder can grant membership or encryption state.
   */
  async joinServer(deeplink: string): Promise<XoreinRuntimeServer> {
    const meta = parseInviteMetadata(deeplink);
    const me = this._identity?.peerId;
    if (meta.ownerPeerId && meta.ownerPeerId !== me) {
      try {
        const data = await this.peerSync.joinServer(
          meta.ownerPeerId,
          meta.serverId,
          getState().identity?.profile?.display_name,
          meta.inviteToken,
        );
        if (data?.ok && data.server) {
          if (!isAuthoritativeJoinRecord(data.server, meta.serverId, meta.ownerPeerId, me ?? '')) {
            throw new Error('join: owner response failed authority or encryption validation');
          }
          const server = data.server;
          const supplied = (data.messages ?? []) as XoreinRuntimeMessage[];
          const verified = selectNewestVerifiedVersions(supplied);
          // Transitional compatibility: over the authenticated OWNER stream, an
          // unsigned record authored by that same owner is still self-assertion,
          // not impersonation. Unsigned copies attributed to anyone else are
          // never accepted.
          const legacyOwnerAuthored = supplied.filter(message =>
            !message.author_proof && message.sender_peer_id === meta.ownerPeerId);
          if (!applyJoinedServer(meta.serverId, server, [...verified, ...legacyOwnerAuthored])) {
            throw new Error('join: owner returned a different server than the invite');
          }
          // Record the owner as a reachable known peer (with the circuit addresses
          // it advertised) so future delivery works even across different relays.
          upsertPeer({
            peer_id: meta.ownerPeerId,
            role: 'peer',
            addresses: Array.isArray(data.addresses) ? data.addresses : [],
            last_seen_at: new Date().toISOString(),
          });
          publishNativeSnapshot();
          return server;
        }
      } catch {
        // The owner may be offline; continue with an owner-signed portable
        // capability against the invite's seed members below.
      }
    }

    // Owner offline: a portable owner-signed invite lets any current seed verify
    // admission. The seed transports an owner-signed server record and
    // author-signed history; neither its local software nor a provider majority
    // can rewrite either.
    for (const seed of [...new Set(meta.seeds ?? [])]) {
      if (!seed || seed === me || seed === meta.ownerPeerId) continue;
      try {
        const data = await this.peerSync.joinServer(
          seed,
          meta.serverId,
          getState().identity?.profile?.display_name,
          meta.inviteToken,
        );
        if (!data?.ok || !data.server) continue;
        const served = data.server as XoreinRuntimeServer;
        if (!served.owner_proof || !verifyServerRecord(served)
          || !isAuthoritativeJoinRecord(
            served, meta.serverId, meta.ownerPeerId ?? '', me ?? '',
          )) continue;
        const portable: XoreinRuntimeServer = {
          ...served,
          admission_capability: meta.inviteToken,
        };
        const verifiedMessages = selectNewestVerifiedVersions(
          (data.messages ?? []) as XoreinRuntimeMessage[],
        );
        if (!applyJoinedServer(meta.serverId, portable, verifiedMessages)) continue;
        upsertPeer({
          peer_id: seed,
          role: 'peer',
          addresses: Array.isArray(data.addresses) ? data.addresses : [],
          last_seen_at: new Date().toISOString(),
        });
        publishNativeSnapshot();
        void this.propagatePortableAdmission(portable, meta.inviteToken ?? '', seed);
        return portable;
      } catch {
        // Try the next independently authenticated seed.
      }
    }

    throw new Error('join failed: no owner or invite-authorized member was reachable');
  }

  /**
   * Load older history for a channel by paging backwards from the oldest message
   * we currently hold. Dials the server owner first, then falls back to other
   * members, asking each for the page before our earliest known message. Returns
   * how many new messages were merged and whether more remain older than the page
   * (`hasMore`), so the UI can decide whether to keep the "load older" affordance.
   */
  async pullOlderHistory(serverId: string, channelId: string): Promise<{ added: number; hasMore: boolean; unavailable?: boolean }> {
    const state = getState();
    const server = state.servers[serverId];
    const me = this._identity?.peerId;
    if (!server) return { added: 0, hasMore: false };

    // Oldest local message for this channel is our cursor (exclusive). The cursor is
    // (created_at, id) — a total order — so a page boundary that lands on a timestamp
    // shared by several messages doesn't skip the rest of them on the next pull.
    const scopeMsgs = state.messages
      .filter(m => m.server_id === serverId && m.scope_id === channelId && m.created_at)
      .sort((a, b) =>
        String(a.created_at).localeCompare(String(b.created_at)) ||
        String(a.id).localeCompare(String(b.id)));
    const oldest = scopeMsgs[0];
    // For an EMPTY channel use a max cursor (not our local clock): if the owner's clock
    // is ahead, a now()-based cursor would exclude their newer messages and, once an
    // older page merges, later pulls cursor from that older record — leaving a
    // permanent gap for the omitted interval. A far-future sentinel bounds nothing, so
    // the first page is simply the newest retained messages. Once we hold history, the
    // oldest record's (created_at, id) bounds the next page.
    const before = oldest ? String(oldest.created_at) : '9999-12-31T23:59:59.999Z';
    const beforeId = oldest ? String(oldest.id) : '￿';

    // Query a bounded rotating slice of the swarm. Storage nodes are preferred;
    // ordinary members are round-robin fallbacks. Availability advertisements are
    // hints only — fetchSwarmHistoryPage verifies the original author's hybrid
    // signature on every record and periodically cross-checks two extra providers.
    const infrastructure = Object.values(state.peers)
      .filter(peer => peer.peer_id !== me && (peer.role === 'archivist' || peer.role === 'relay'))
      .map(peer => peer.peer_id);
    const memberCandidates = [...new Set([
      server.owner_peer_id,
      ...(server.members ?? []),
    ].filter(peer => peer && peer !== me))];
    const offset = memberCandidates.length
      ? this._historyProviderCursor % memberCandidates.length
      : 0;
    const rotatedMembers = [
      ...memberCandidates.slice(offset),
      ...memberCandidates.slice(0, offset),
    ];
    this._historyProviderCursor += 8;
    const candidates = [...new Set([...infrastructure, ...rotatedMembers])];

    const swarm = await fetchSwarmHistoryPage({
      providers: candidates.map(peerId => {
        const role = state.peers[peerId]?.role;
        const kind: HistoryProviderKind = role === 'archivist'
          ? 'archivist'
          : role === 'relay'
            ? 'relay'
            : 'peer';
        return {
          peerId,
          kind,
          coverage: () => this.peerSync.historyCoverage(
            peerId, serverId, channelId, before, beforeId, 50,
          ),
          fetch: (messageIds: string[]) => this.peerSync.fetchHistoryRecords(
            peerId, serverId, channelId, messageIds,
          ),
        };
      }),
      serverId,
      channelId,
      limit: 50,
      existingMessageIds: new Set(scopeMsgs.map(message => message.id)),
      maxProviders: 16,
      maxIDsPerFetch: 25,
    });
    if (swarm.messages.length) {
      const added = mergeHistoryMessages(swarm.messages);
      publishNativeSnapshot();
      return { added, hasMore: swarm.hasMore };
    }
    if (swarm.answeredProviders > 0 && swarm.advertisedRecords === 0) {
      return { added: 0, hasMore: swarm.hasMore };
    }

    // Compatibility fallback for an old owner that predates sync.coverage. Only
    // the authenticated owner is consulted on this path; arbitrary members never
    // get to inject unsigned legacy history.
    const legacyCandidates = [server.owner_peer_id].filter(p => p && p !== me);
    for (const peer of legacyCandidates) {
      // Paging is a member operation — the responder exempts existing members from
      // the invite-token check, so none is needed here.
      const data = await this.peerSync.pullHistory(peer, serverId, channelId, before, beforeId, 50);
      if (data?.ok && Array.isArray(data.messages)) {
        // Defense-in-depth: only merge messages actually scoped to THIS server+channel,
        // so a compromised/buggy responder can't smuggle records into other scopes.
        const scoped = (data.messages as XoreinRuntimeMessage[])
          .filter(m => m && m.server_id === serverId && m.scope_id === channelId);
        const added = mergeHistoryMessages(scoped, {
          allowUnsignedFromPeerId: server.owner_peer_id,
        });
        if (added > 0 || scoped.length > 0) {
          publishNativeSnapshot();
          return { added, hasMore: Boolean(data.has_more) };
        }
        // Peer answered but had nothing new — a definitive "no older here".
        return { added: 0, hasMore: Boolean(data.has_more) };
      }
    }
    // No candidate answered (owner/members all unreachable right now). This is a
    // TRANSIENT failure, not proven exhaustion — signal `unavailable` so the UI keeps
    // the "load older" affordance for a retry when connectivity returns, rather than
    // treating it as authoritative end-of-history.
    return { added: 0, hasMore: false, unavailable: true };
  }

  /**
   * Register this node in the rendezvous namespace of each joined server so other
   * members can discover our circuit addresses for a direct WebRTC upgrade. The
   * namespace is derived from a member-shared secret (the crowd_root), so it is not
   * enumerable by non-members (spec 31 §3.5). Gated on `directTransport` — the
   * endpoint is the external gateway, so nothing fires on the default path.
   */
  private async registerServerRendezvous(): Promise<void> {
    if (!resolveFeatureFlag('directTransport')) return;
    const me = this._identity?.peerId;
    if (!me) return;
    const addrs = this.peerSync.localCircuitAddrs();
    if (!addrs.length) return;
    const state = getState();
    for (const serverId of state.joined_server_ids) {
      const server = state.servers[serverId];
      const rootB64 = server?.crowd_root;
      if (!rootB64) continue;
      try {
        const secret = Uint8Array.from(atob(rootB64), c => c.charCodeAt(0));
        const namespace = serverRendezvousCID(secret);
        if (!namespace) continue;
        await rendezvousRegister(namespace, me, addrs);
      } catch { /* gateway unavailable / bad root — best effort, dark feature */ }
    }
  }

  /**
   * Discover other members' circuit addresses for a server via rendezvous and
   * record them as known peers, so a direct WebRTC upgrade (DCUtR) has addresses to
   * dial. Gated on `directTransport`. Returns the number of peers learned.
   */
  async discoverServerPeers(serverId: string): Promise<number> {
    if (!resolveFeatureFlag('directTransport')) return 0;
    const server = getState().servers[serverId];
    const rootB64 = server?.crowd_root;
    if (!rootB64) return 0;
    const me = this._identity?.peerId;
    try {
      const secret = Uint8Array.from(atob(rootB64), c => c.charCodeAt(0));
      const namespace = serverRendezvousCID(secret);
      if (!namespace) return 0;
      const peers = await rendezvousDiscover(namespace);
      let learned = 0;
      for (const p of peers) {
        if (!p.peer_id || p.peer_id === me) continue;
        upsertPeer({
          peer_id: p.peer_id,
          role: 'peer',
          addresses: Array.isArray(p.addrs) ? p.addrs : [],
          last_seen_at: new Date().toISOString(),
        });
        learned++;
      }
      if (learned) publishNativeSnapshot();
      return learned;
    } catch {
      return 0;
    }
  }

  /** Record the always-on bootstrap relay as a reachable known peer. */
  private seedBootstrapPeer(relay = RELAY_MULTIADDR): void {
    const peerId = relay.split('/p2p/').pop() || RELAY_PEER_ID;
    upsertPeer({
      peer_id: peerId,
      // reserveAnyRelay succeeded against this address, so this is a verified
      // relay, not merely a bootstrap hint. Marking it correctly also lets the
      // replica scheduler prefer it immediately.
      role: 'relay',
      addresses: [relay],
      source: 'bootstrap',
      last_seen_at: new Date().toISOString(),
    });
  }

  /** Sign a message with this node's hybrid signing key. */
  sign(message: Uint8Array): Uint8Array {
    return hybridSign(message, identitySigningKey(this.identity));
  }

  /** Verify a hybrid signature against a known signing public key. */
  verify(message: Uint8Array, sig: Uint8Array, edPub: Uint8Array, mldsaPub: Uint8Array): boolean {
    return hybridVerify(message, sig, { edPublic: edPub, mldsaPublic: mldsaPub });
  }

  // ── State / mutation delegation ──────────────────────────────────────────
  // These wrap the state module operations for callers that hold a reference
  // to the engine rather than importing state helpers directly.

  sendChannelMessage = nativeSendChannelMessage;
  sendDmMessage = nativeSendDmMessage;
  editMessage = nativeEditMessage;
  deleteMessage = nativeDeleteMessage;
  addReaction = nativeAddReaction;
  removeReaction = nativeRemoveReaction;
  createServer = nativeCreateServer;
  createChannel = nativeCreateChannel;
  addFriendRequest = nativeAddFriendRequest;
  acceptFriend = nativeAcceptFriend;
  declineFriend = nativeDeclineFriend;
  addRelay = nativeAddRelay;
  removeRelay = nativeRemoveRelay;
  updatePresence = nativeUpdatePresence;
  ensureDm = nativeEnsureDm;
  ensureDirectMessage = nativeEnsureDirectMessage;

  /**
   * Join a voice channel as a P2P WebRTC mesh peer (local-first: see VoiceSession).
   * When `voiceMediaTransport` is off, falls back to a store-only join. When the
   * transport isn't wired yet we ALSO fall back to a store-only join rather than
   * throwing — clicking a voice channel must always "join" the UI even offline.
   */
  async joinVoice(channelId: string): Promise<void> {
    if (getVoiceSession(channelId)) return; // idempotent
    // Create a real media session whenever we have an identity — local voice (mic
    // capture, mute, speaking, camera/screen) does NOT require the relay node. The
    // mesh layer connects best-effort once a node is wired. Only fall back to a
    // store-only join if voice media is disabled or there's no identity yet.
    if (!resolveFeatureFlag('voiceMediaTransport') || !this._identity) {
      nativeJoinVoice(channelId);
      publishNativeSnapshot();
      return;
    }
    const session = new VoiceSession(channelId, this._wiredNode, this._identity.peerId, {});
    registerVoiceSession(session);
    await session.start();
  }

  /** Leave the voice channel: release media and tear down peer connections. */
  async leaveVoice(channelId: string): Promise<void> {
    const session = getVoiceSession(channelId);
    if (session) {
      await session.stop();
      clearVoiceSession(channelId);
    } else {
      nativeLeaveVoice(channelId);
      publishNativeSnapshot();
    }
  }

  /** Toggle local microphone mute. No-op when not in a media session. */
  setVoiceMuted(channelId: string, muted: boolean): void {
    getVoiceSession(channelId)?.setMuted(muted);
  }

  /** Toggle the local camera in a voice channel (adds/removes a video track). */
  async setVoiceCamera(channelId: string, on: boolean): Promise<void> {
    await getVoiceSession(channelId)?.setCameraEnabled(on);
  }

  /** Start/stop sharing the screen (game stream) in a voice channel. */
  async startVoiceScreenShare(channelId: string, opts: { withAudio?: boolean; quality?: string; surface?: 'screen' | 'window' | 'tab' } = {}): Promise<void> {
    await getVoiceSession(channelId)?.startScreenShare(opts);
  }

  async stopVoiceScreenShare(channelId: string): Promise<void> {
    await getVoiceSession(channelId)?.stopScreenShare();
  }

  /** Whether the local user is currently sharing their screen in this channel. */
  isVoiceScreenSharing(channelId: string): boolean {
    return getVoiceSession(channelId)?.isScreenSharing ?? false;
  }

  // ── Social recovery (friend-held identity backup) ───────────────────────────

  /**
   * Distribute my password-encrypted identity backup to the chosen guardian
   * peers. They store opaque ciphertext only. Returns which peers received it.
   */
  async distributeRecovery(contacts: string[]): Promise<RecoveryDistributionResult> {
    const blob = await loadEncryptedIdentity();
    if (!blob) throw new Error('Set a password for your identity before adding recovery contacts.');
    const displayName = getState().identity?.profile?.display_name ?? '';
    // Bundle an encrypted snapshot of the account state (servers/DMs/profile) so a
    // recovered identity on a new device restores everything, not just the keypair.
    const state = this._identity ? encryptSyncState(this._identity, captureSyncState()) : undefined;
    return distributeRecovery(this.peerSync, contacts, displayName, blob, state);
  }

  /** Ask a guardian (by peer id) to release the backup for account `ownerPeerId`. */
  async requestRecovery(guardianPeerId: string, ownerPeerId: string): Promise<{ ok: boolean; pending?: boolean; queued?: boolean; error?: string }> {
    return sendRecoveryRequest(this.peerSync, guardianPeerId, ownerPeerId);
  }

  /** Guardian approves a pending request → deliver the held backup to the requester. */
  approveRecovery(requestId: string): Promise<boolean> {
    return approveRecovery(this.peerSync, requestId);
  }

  /** Guardian denies a pending request. */
  denyRecovery(requestId: string): void {
    denyRecovery(requestId);
  }

  /**
   * Encrypted snapshot of the account state (servers/DMs/profile) for inclusion in
   * a downloaded backup file, so restoring it on a new device brings everything
   * back — not just the keypair. Encrypted with the identity key; null if no identity.
   */
  encryptedStateForBackup(): EncryptedSyncBlob | null {
    return this._identity ? encryptSyncState(this._identity, captureSyncState()) : null;
  }

  private _recoveryResyncTimer: ReturnType<typeof setTimeout> | null = null;
  private startRecoveryRefresh(): void {
    this.scheduleRecoveryResync();
    if (this._recoveryRefreshTimer) return;
    // Recipient-inbox packets have a bounded lifetime. A daily refresh keeps an
    // offline guardian's sealed copy alive while this device remains active,
    // and automatically repairs it to newly discovered providers.
    this._recoveryRefreshTimer = setInterval(() => this.scheduleRecoveryResync(), 24 * 60 * 60 * 1000);
  }
  /** Debounced re-push of the account-state snapshot to recovery contacts. */
  private scheduleRecoveryResync(): void {
    const contacts = getRecoveryContacts();
    if (!contacts.length || !this._identity) return;
    if (this._recoveryResyncTimer) clearTimeout(this._recoveryResyncTimer);
    this._recoveryResyncTimer = setTimeout(() => {
      this._recoveryResyncTimer = null;
      void this.distributeRecovery(contacts).catch(() => { /* offline guardians retry on next change */ });
    }, 5000);
  }
}
