// xorein native engine — unified API over the P0-P9 native P2P primitives.
// P10 cutover: replaces src/lib/xoreinControl.ts HTTP calls with native calls.
//
// The engine is gated behind feature flag 'nativeEngine'.
// When enabled, all data flows through the native P2P stack.
// When disabled (default), the existing HTTP control client is used unchanged.
import type { XoreinIdentity } from '../identity/identity.js';
import { generateIdentity, createIdentityCert, verifyIdentityCert, identitySigningKey } from '../identity/identity.js';
import { hybridSign, hybridVerify } from '../crypto/hybrid.js';
import { encryptIdentity, decryptIdentity, saveEncryptedIdentity, loadEncryptedIdentity, hasPersistedIdentity, loadOrCreateGuestIdentity, clearGuestIdentity, loadSessionIdentity, saveSessionIdentity, type Argon2Params } from '../identity/storage.js';
import { XoreinTransportManager } from '../transport/manager.js';
import { RELAY_PEER_ID, RELAY_MULTIADDR, type Libp2p as Libp2pNode } from '../transport/node.js';
import { buildBundle, verifyBundle, x3dhInitiate, x3dhRespond, type PrekeyBundle, type PrekeyPrivate } from '../seal/bundle.js';
import { ratchetEncrypt, ratchetDecrypt, type RatchetState } from '../seal/ratchet.js';
import { newCrowdGroup, crowdEncrypt, crowdDecrypt, addSender, type CrowdState } from '../crowd/crowd.js';
import { newGroup as newTreeGroup, addMember, treeEncrypt, treeDecrypt, type GroupState } from '../tree/tree.js';
import { newPeerKey, encryptFrame, decryptFrame, type PeerKey } from '../voice/mediashield.js';
import { uploadBlob, downloadBlob, type BlobRef } from '../blobs/blobs.js';
import { deliverOffline, drainDeliveries } from '../delivery/mailbox.js';
import { serverRendezvousCID, rendezvousRegister, rendezvousDiscover } from '../transport/rendezvous.js';
import { initStore, setNativeIdentity, getState, updateState, upsertPeer, resetNativeStore, configureNativeStore, applyJoinedServer, mergeHistoryMessages, setStateEncryptionKey, pinPeerIdentity } from '../state/store.js';
import { identityKeyBlob } from '../identity/safetyNumber.js';
import { parseInviteMetadata } from '../../protocol/deeplink.js';
import type { XoreinRuntimeServer, XoreinRuntimeMessage } from '../../types.js';
import { publishNativeSnapshot } from '../state/snapshot.js';
import { PeerSync } from '../sync/peersync.js';
import { registerInboundHandlers, ingestMailboxChat } from '../sync/inbound.js';
import { registerPeerSync } from '../sync/registry.js';
import { SealSessions } from '../seal/session.js';
import { loadSealState, saveSealState } from '../seal/persist.js';
import { ChannelCrypto } from '../crowd/channel.js';
import { registerScopeCrypto, resetScopeCrypto } from '../sync/secureEnvelope.js';
import { registerOfflineIdentity, resetOfflineIdentity, drainOfflineChat } from '../delivery/offline.js';
import { PROTOCOLS, RECOVERY_OPS } from '../families/families.js';
import { unframeMessage, frameMessage, decodePeerStreamRequest, encodePeerStreamResponse } from '../families/peerstream.js';
import { VOICE_OPS, type VoicePresenceRequest, type VoiceOfferRequest, type VoiceIceRequest } from '../voice/signaling.js';
import {
  handleRecoveryStore, handleRecoveryRequest, handleRecoveryDeliver,
  distributeRecovery, sendRecoveryRequest, approveRecovery, denyRecovery,
} from '../recovery/recovery.js';
import { encryptSyncState, captureSyncState, restorePendingSyncState, registerStateSyncHandler, type EncryptedSyncBlob } from '../state/stateSync.js';
import { getRecoveryContacts } from '../recovery/custody.js';
import { VoiceSession } from '../voice/session.js';
import { registerVoiceSession, getVoiceSession, clearVoiceSession } from '../voice/registry.js';
import { resolveFeatureFlag } from '../../config/featureFlags.js';
import {
  nativeSendChannelMessage,
  nativeSendDmMessage,
  nativeEditMessage,
  nativeDeleteMessage,
  nativeAddReaction,
  nativeRemoveReaction,
  nativeCreateServer,
  nativeCreateChannel,
  nativeJoinServer,
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
export class XoreinNativeEngine {
  private readonly opts: NativeEngineOptions;
  private _identity: XoreinIdentity | null = null;
  private _transport: XoreinTransportManager | null = null;
  private _started = false;
  private _wiredNode: Libp2pNode | null = null;
  private _presenceTimer: ReturnType<typeof setInterval> | null = null;
  readonly peerSync: PeerSync;

  constructor(opts: NativeEngineOptions) {
    this.opts = opts;
    this.peerSync = new PeerSync(opts.relayMultiaddr);
    registerPeerSync(this.peerSync);
  }

  private emitActivity(phase: EngineActivityPhase, message: string, detail?: string): void {
    this.opts.onActivity?.({ phase, message, ...(detail ? { detail } : {}) });
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
   * Load or generate identity, then connect to the relay.
   * Idempotent — safe to call multiple times.
   */
  async start(): Promise<void> {
    if (this._started) return;
    this.emitActivity('starting', 'Starting up…');

    // Resolve the identity by mode:
    //  • a persisted (registered) identity requires the user passphrase to decrypt;
    //  • a passphrase with no persisted identity means we are registering now;
    //  • no passphrase + nothing persisted means a guest (ephemeral, sessionStorage).
    const stored = await loadEncryptedIdentity();
    const guestMode = !stored && !this.opts.passphrase;
    // Guests keep their app state in per-tab sessionStorage; registered/registering
    // identities use localStorage. Configure this BEFORE initStore() loads/persists.
    configureNativeStore({ guest: guestMode });
    // Mark the native engine as the live owner of the runtime snapshot keys for
    // this tab so HTTP support calls never overwrite them (see publishSnapshot).
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__HARMOLYN_NATIVE_ACTIVE__ = true;
    }
    if (stored) {
      // Try the 5-day session first — skips the expensive Argon2 KDF on repeat visits.
      const sessionIdentity = await loadSessionIdentity();
      if (sessionIdentity) {
        this._identity = sessionIdentity;
      } else {
        if (!this.opts.passphrase) {
          // Provider gates this; surface a clear locked error if it ever slips through.
          throw new Error('identity locked: passphrase required');
        }
        this.emitActivity('decrypting', 'Unlocking your account…');
        this._identity = await decryptIdentity(stored, this.opts.passphrase);
        // Save a 5-day session so subsequent loads skip the password prompt.
        void saveSessionIdentity(this._identity).catch(() => {});
      }
    } else if (this.opts.passphrase) {
      this._identity = await generateIdentity();
      await saveEncryptedIdentity(encryptIdentity(this._identity, this.opts.passphrase));
      clearGuestIdentity();
    } else {
      this._identity = await loadOrCreateGuestIdentity();
    }

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
    // If we just recovered this identity on a new device, a guardian delivered an
    // encrypted snapshot of the account state — decrypt it with the identity key
    // and merge in the servers/DMs/profile so the account looks the same here.
    restorePendingSyncState(this._identity);
    publishNativeSnapshot();

    // Keep recovery guardians' copies of the account state fresh: when servers/DMs
    // change, re-distribute the encrypted snapshot (debounced) so recovering on a
    // new device reflects recent state.
    registerStateSyncHandler(() => this.scheduleRecoveryResync());

    // Wire E2EE: our Seal prekey bundle + per-server Crowd channel keys. The
    // fetchBundle closure dials a peer's `seal.bundle` op over the relay circuit.
    // Registering BEFORE transport.start() so the seal.bundle inbound handler can
    // serve our bundle as soon as the data plane is wired.
    // Registered identities persist their ratchet sessions (encrypted at rest)
    // so a reload keeps decrypting in-flight DMs; guests stay ephemeral.
    const identity = this._identity;
    const persistedSeal = guestMode ? null : loadSealState(identity);
    const seal = new SealSessions(identity.peerId, identitySigningKey(identity), {
      persisted: persistedSeal,
      onChange: guestMode ? undefined : (state) => saveSealState(identity, state),
      // TOFU-pin each contact's verified hybrid identity so the UI can show a
      // safety number and warn if it ever changes (relay swap / re-key).
      onPeerIdentity: (peerId, identityKeyB64) => pinPeerIdentity(peerId, identityKeyB64),
    });
    const channels = new ChannelCrypto();
    registerScopeCrypto({ seal, channels, fetchBundle: (peerId) => this.peerSync.fetchBundle(peerId) });
    // Offline store-and-forward identity (zero-knowledge mailbox deposits/drains).
    registerOfflineIdentity(this._identity);

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
        this.opts.onStateChange?.(s);
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
          // Record the always-on bootstrap relay as a reachable known peer so the
          // UI sees a network path (fixes "no-peer" #PEER-UNREACHABLE for servers
          // whose remote members have not been dialed directly yet).
          this.seedBootstrapPeer();
          // resil-3: every (re)connect builds a NEW libp2p node. Re-point PeerSync
          // and re-register inbound family handlers at the live node so P2P
          // send/receive keeps working after a relay drop (previously this was
          // wired only once and stayed broken until a full page reload).
          void this.wireDataPlane(this._transport.currentNode);
          // Point PeerSync at whichever relay we actually reserved on (multi-relay
          // failover may have picked a backup), so peer fallback addresses resolve.
          const active = this._transport.getActiveRelay();
          if (active) this.peerSync.setRelay(active);
          this.emitActivity('syncing', 'Syncing your messages…');
          // resil-2: pull any messages deposited in our zero-knowledge mailbox
          // while we were offline.
          this.drainOfflineMailbox();
          // Replay our own durable outbound queue: messages composed while the relay
          // was down now go out (or into recipients' mailboxes) instead of being lost.
          void nativeDrainOutbox();
          // Announce we're online to friends + co-members (and keep a light
          // heartbeat) so they don't show us — and we don't show them — as offline.
          this.startPresenceHeartbeat();
          // Register ourselves in each joined server's rendezvous namespace so other
          // members can discover our circuit addresses for a direct WebRTC upgrade.
          // Gated on directTransport (dark by default) — the endpoint is the external
          // gateway, so this never fires on the default path.
          void this.registerServerRendezvous();
        } else if (s === 'disconnected') {
          this.stopPresenceHeartbeat();
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
      // Inbound VOICE MESH handler. Peers dial us directly over /aether/voice/0.1.0
      // (there is no SFU): voice.presence (join/leave/state), voice.offer (SDP
      // offer → we answer), voice.leave (teardown). Request/response — we reply
      // with a framed PeerStreamResponse the caller reads back.
      await node.handle(
        PROTOCOLS.voice,
        (async (
          stream: AsyncIterable<Uint8Array | { subarray(): Uint8Array }> & { send(d: Uint8Array): boolean; close(): Promise<void> },
          connection: { remotePeer: { toString(): string }; remoteAddr?: { toString(): string } },
        ) => {
          const reply = (obj: unknown, requestId?: string) => {
            try {
              const payload = new TextEncoder().encode(JSON.stringify(obj));
              stream.send(frameMessage(encodePeerStreamResponse({ payload, requestId })));
            } catch { /* peer hung up */ }
          };
          try {
            const remotePeerId = connection.remotePeer.toString();
            const remoteAddr = connection.remoteAddr?.toString();
            if (remoteAddr?.includes('p2p-circuit')) this.peerSync.registerPeer(remotePeerId, remoteAddr);
            const chunks: Uint8Array[] = [];
            for await (const chunk of stream) {
              chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
            }
            const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
            let off = 0; for (const c of chunks) { total.set(c, off); off += c.length; }
            const msg = unframeMessage(total);
            if (!msg) { reply({ ok: false, error: 'bad_frame' }); await stream.close().catch(() => undefined); return; }
            const req = decodePeerStreamRequest(msg);
            const payload = req.payload ? (JSON.parse(new TextDecoder().decode(req.payload)) as Record<string, unknown>) : {};
            const channelId = String(payload.session_id ?? '');
            const session = channelId ? getVoiceSession(channelId) : null;

            if (req.operation === VOICE_OPS.presence) {
              if (session) reply(session.handlePresence(payload as unknown as VoicePresenceRequest, remotePeerId), req.requestId);
              else reply({ ok: true, in_channel: false }, req.requestId);
            } else if (req.operation === VOICE_OPS.offer) {
              if (session) reply(await session.handleOffer(payload as unknown as VoiceOfferRequest, remotePeerId), req.requestId);
              else reply({ ok: false, error: 'not_in_channel' }, req.requestId);
            } else if (req.operation === VOICE_OPS.ice) {
              if (session) reply(session.handleIce(payload as unknown as VoiceIceRequest, remotePeerId), req.requestId);
              else reply({ ok: false }, req.requestId);
            } else if (req.operation === VOICE_OPS.leave) {
              session?.handlePresence({ session_id: channelId, action: 'leave' }, remotePeerId);
              reply({ ok: true }, req.requestId);
            } else {
              reply({ ok: false, error: 'unknown_op' }, req.requestId);
            }
            await stream.close().catch(() => undefined);
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
          stream: AsyncIterable<Uint8Array | { subarray(): Uint8Array }> & { send(d: Uint8Array): boolean; close(): Promise<void> },
          connection: { remotePeer: { toString(): string } },
        ) => {
          const reply = (obj: unknown, requestId?: string) => {
            try { stream.send(frameMessage(encodePeerStreamResponse({ payload: new TextEncoder().encode(JSON.stringify(obj)), requestId }))); }
            catch { /* peer hung up */ }
          };
          try {
            const remotePeerId = connection.remotePeer.toString();
            const chunks: Uint8Array[] = [];
            for await (const chunk of stream) chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
            const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
            let off = 0; for (const c of chunks) { total.set(c, off); off += c.length; }
            const msg = unframeMessage(total);
            if (!msg) { reply({ ok: false, error: 'bad_frame' }); await stream.close().catch(() => undefined); return; }
            const req = decodePeerStreamRequest(msg);
            const payload = req.payload ? (JSON.parse(new TextDecoder().decode(req.payload)) as Record<string, unknown>) : {};
            if (req.operation === RECOVERY_OPS.store) reply(await handleRecoveryStore(payload, remotePeerId), req.requestId);
            else if (req.operation === RECOVERY_OPS.request) reply(await handleRecoveryRequest(payload, remotePeerId), req.requestId);
            else if (req.operation === RECOVERY_OPS.deliver) reply(handleRecoveryDeliver(payload, remotePeerId), req.requestId);
            else reply({ ok: false, error: 'unknown_op' }, req.requestId);
            await stream.close().catch(() => undefined);
          } catch { /* non-fatal */ }
        }) as Parameters<typeof node.handle>[1],
        { runOnLimitedConnection: true },
      );
    } catch { /* handlers already registered on this node */ }
  }

  /**
   * Drain the zero-knowledge mailbox for every known contact (DM partners +
   * server co-members) and re-inject any recovered messages through the
   * authenticated inbound chat path. Idempotent: de-dup drops re-drained items.
   */
  private drainOfflineMailbox(): void {
    const st = getState();
    const contacts = new Set<string>();
    for (const dm of Object.values(st.dms)) for (const p of dm.participants ?? []) contacts.add(p);
    for (const srv of Object.values(st.servers)) for (const m of srv.members ?? []) contacts.add(m);
    void drainOfflineChat(contacts, ingestMailboxChat)
      .then((n) => { if (n > 0) publishNativeSnapshot(); this.emitActivity('connected', 'Connected'); })
      .catch(() => { /* mailbox unreachable — retried on next connect */ this.emitActivity('connected', 'Connected'); });
  }

  /**
   * Announce online presence to friends + co-members now and on a light heartbeat.
   * Re-announcing covers peers who connect after us or live on a different relay —
   * without it, presence only ever updates when someone happens to type.
   */
  private startPresenceHeartbeat(): void {
    this.stopPresenceHeartbeat();
    nativeAnnouncePresence();
    this._presenceTimer = setInterval(() => nativeAnnouncePresence(), 25_000);
  }

  private stopPresenceHeartbeat(): void {
    if (this._presenceTimer != null) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
  }

  async stop(): Promise<void> {
    this.stopPresenceHeartbeat();
    await this._transport?.stop();
    this._wiredNode = null;
    // Release native snapshot ownership + E2EE managers so a re-init starts clean
    // and HTTP support calls aren't permanently suppressed after teardown (bug-3).
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__HARMOLYN_NATIVE_ACTIVE__ = false;
    }
    resetScopeCrypto();
    resetOfflineIdentity();
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
    clearGuestIdentity();
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
   * us to its member list). Falls back to a local placeholder only when the
   * invite has no owner or the owner is currently unreachable.
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
          const server = data.server as XoreinRuntimeServer;
          applyJoinedServer(server, (data.messages ?? []) as XoreinRuntimeMessage[]);
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
        // Reached the owner but it declined or returned no server — surface why
        // instead of silently handing back a broken empty stub.
        console.warn('[xorein/join] owner reachable but join not granted:', data?.error ?? data);
      } catch (err) {
        // owner offline/unreachable — fall back to a local membership record, but
        // log it: a silent stub looks like a successful (yet empty) join.
        console.warn('[xorein/join] P2P join dial failed, using local stub:', err);
      }
    }

    // Member-served fallback: the owner is offline/unreachable. Try each seed member
    // carried in the invite. DARK by default (memberServedHistory): a joined member's
    // server record has the owner-only invite_secret stripped, so the seed's
    // verifyInviteToken always fails for a new joiner — the fallback can't actually be
    // granted without a delegatable capability — and served history isn't individually
    // authenticated. Until owner-signed invites/history exist, skip seeds and fall
    // through to the local stub (membership reconciles when the owner returns).
    const seeds = resolveFeatureFlag('memberServedHistory')
      ? (meta.seeds ?? []).filter(s => s && s !== me && s !== meta.ownerPeerId)
      : [];
    for (const seed of seeds) {
      try {
        const data = await this.peerSync.joinServer(
          seed,
          meta.serverId,
          getState().identity?.profile?.display_name,
          meta.inviteToken,
        );
        if (data?.ok && data.server) {
          const server = data.server as XoreinRuntimeServer;
          applyJoinedServer(server, (data.messages ?? []) as XoreinRuntimeMessage[]);
          upsertPeer({
            peer_id: seed,
            role: 'peer',
            addresses: Array.isArray(data.addresses) ? data.addresses : [],
            last_seen_at: new Date().toISOString(),
          });
          publishNativeSnapshot();
          console.info('[xorein/join] owner offline; joined via member seed', seed);
          return server;
        }
      } catch {
        // try the next seed
      }
    }

    return nativeJoinServer(deeplink, { name: meta.serverName, ownerPeerId: meta.ownerPeerId });
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

    // Authoritative history comes from the OWNER only: served message copies are not
    // individually signed, so trusting an arbitrary member's page would let it inject
    // forged messages into permanent channel history. Member-served fallback is opt-in
    // (memberServedHistory, dark) until history carries owner signatures.
    const candidates = resolveFeatureFlag('memberServedHistory')
      ? [server.owner_peer_id, ...server.members].filter((p, i, arr) => p && p !== me && arr.indexOf(p) === i)
      : [server.owner_peer_id].filter(p => p && p !== me);

    for (const peer of candidates) {
      // Paging is a member operation — the responder exempts existing members from
      // the invite-token check, so none is needed here.
      const data = await this.peerSync.pullHistory(peer, serverId, channelId, before, beforeId, 50);
      if (data?.ok && Array.isArray(data.messages)) {
        // Defense-in-depth: only merge messages actually scoped to THIS server+channel,
        // so a compromised/buggy responder can't smuggle records into other scopes.
        const scoped = (data.messages as XoreinRuntimeMessage[])
          .filter(m => m && m.server_id === serverId && m.scope_id === channelId);
        const added = mergeHistoryMessages(scoped);
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
  private seedBootstrapPeer(): void {
    upsertPeer({
      peer_id: RELAY_PEER_ID,
      role: 'bootstrap',
      addresses: [RELAY_MULTIADDR],
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
  async distributeRecovery(contacts: string[]): Promise<{ delivered: string[]; failed: string[] }> {
    const blob = await loadEncryptedIdentity();
    if (!blob) throw new Error('Set a password for your identity before adding recovery contacts.');
    const displayName = getState().identity?.profile?.display_name ?? '';
    // Bundle an encrypted snapshot of the account state (servers/DMs/profile) so a
    // recovered identity on a new device restores everything, not just the keypair.
    const state = this._identity ? encryptSyncState(this._identity, captureSyncState()) : undefined;
    return distributeRecovery(this.peerSync, contacts, displayName, blob, state);
  }

  /** Ask a guardian (by peer id) to release the backup for account `ownerPeerId`. */
  async requestRecovery(guardianPeerId: string, ownerPeerId: string): Promise<{ ok: boolean; pending?: boolean; error?: string }> {
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
