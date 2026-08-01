// XoreinTransportManager — maintains the browser's libp2p node with automatic
// relay reconnection and exponential backoff. Wraps createXoreinNode.
import type { Libp2p } from 'libp2p';
import type { XoreinIdentity } from '../identity/identity.js';
import {
  createXoreinNode,
  circuitAddrs,
  isSafeRemoteRelayMultiaddr,
  isTrustedPeerCircuitMultiaddr,
  isTrustedRelayMultiaddr,
} from './node.js';
import { resolveRelayListAsync, reserveAnyRelay } from './relays.js';
import { ExponentialBackoff, DEFAULT_BACKOFF } from './backoff.js';
import { XOREIN_NODE_ENDPOINT_CHANGED_EVENT } from '../../lib/nodeEndpointEvents.js';
import { multiaddr } from '@multiformats/multiaddr';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface TransportManagerOptions {
  identity?: XoreinIdentity;
  relayMultiaddr?: string;
  onStateChange?: (state: ConnectionState) => void;
}

export class XoreinTransportManager {
  private static readonly MAX_DIAL_CANDIDATES = 4096;
  private static readonly MAX_AUTHENTICATED_PEERS = 2048;
  private static readonly MAX_DISCOVERED_RELAYS = 512;
  private node: Libp2p | null = null;
  private state: ConnectionState = 'disconnected';
  private running = false;
  private connecting = false; // prevents overlapping connectOnce calls
  // Endpoint changes are user intent and must not be dropped merely because a
  // background reconnect was already in flight. One queued attempt is enough:
  // it re-resolves the latest stored endpoint after the current attempt exits.
  private reconnectRequested = false;
  private replaceRelayOnNextAttempt = false;
  private activeRelay: string | null = null;
  // Keep the last relay identity long enough to distinguish it from a direct
  // browser-to-browser connection after the relay drops.
  private lastRelayPeerId: string | null = null;
  private readonly dialableCandidates = new Set<string>();
  private readonly dialableRelays = new Set<string>();
  private readonly authenticatedPeerIds = new Set<string>();
  private readonly discoveredRelays = new Set<string>();
  private backoff = new ExponentialBackoff(DEFAULT_BACKOFF);
  private readonly opts: TransportManagerOptions;
  private readonly onPreferredEndpointChanged = () => {
    if (this.running) void this.refreshSelectedNode();
  };

  constructor(opts: TransportManagerOptions = {}) {
    this.opts = opts;
  }

  get currentNode(): Libp2p | null { return this.node; }
  get connectionState(): ConnectionState { return this.state; }
  /** The relay this client actually reserved a circuit on (null until connected). */
  getActiveRelay(): string | null { return this.activeRelay; }

  /**
   * Start the manager. Connects immediately and auto-reconnects if the relay
   * drops. Returns once the initial connection attempt completes (success or fail).
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (typeof window !== 'undefined') {
      window.addEventListener(XOREIN_NODE_ENDPOINT_CHANGED_EVENT, this.onPreferredEndpointChanged);
    }
    await this.connectOnce();
    this.scheduleReconnect();
  }

  /**
   * Re-resolve and reserve the node the user just selected without reloading
   * the page or destroying existing direct peer connections.
   */
  async refreshSelectedNode(): Promise<void> {
    if (!this.running) return;
    if (this.connecting) {
      this.reconnectRequested = true;
      this.replaceRelayOnNextAttempt = true;
      return;
    }
    await this.connectOnce(true);
  }

  /** Stop the manager and disconnect. */
  async stop(): Promise<void> {
    this.running = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener(XOREIN_NODE_ENDPOINT_CHANGED_EVENT, this.onPreferredEndpointChanged);
    }
    if (this.node) {
      await Promise.resolve(this.node.stop()).catch(() => {});
      this.node = null;
    }
    this.activeRelay = null;
    this.lastRelayPeerId = null;
    this.setState('disconnected');
  }

  /** Circuit multiaddrs for this peer (empty until relay reservation). */
  getCircuitAddrs(): string[] {
    return this.node ? circuitAddrs(this.node) : [];
  }

  /** True when the node still has a live peer path, including direct WebRTC. */
  hasLivePeerPath(): boolean {
    if (this.state === 'connected') return true;
    const connections = this.node?.getConnections?.() ?? [];
    return connections.some(connection => {
      const peerId = connection.remotePeer?.toString();
      return Boolean(peerId && peerId !== this.lastRelayPeerId);
    });
  }

  /**
   * Permit one exact, self-signed discovery address to be Noise-authenticated.
   * This does not make it a relay or data authority.
   */
  allowVerifiedCandidate(multiaddr: string): boolean {
    if (!isTrustedRelayMultiaddr(multiaddr)
      || (!this.dialableCandidates.has(multiaddr)
        && !isSafeRemoteRelayMultiaddr(multiaddr, undefined, this.activeRelay ?? undefined))) return false;
    return this.addDialCandidate(multiaddr);
  }

  /** Permit one peer-bound circuit learned from an authenticated stream or
   * hybrid-signed peer record. The exact address is bounded and does not grant
   * relay authority. */
  allowVerifiedPeerAddress(address: string, peerId: string): boolean {
    if (!isTrustedPeerCircuitMultiaddr(address, peerId)) return false;
    const relay = address.slice(0, address.indexOf('/p2p-circuit'));
    if (!this.dialableCandidates.has(relay)
      && !isSafeRemoteRelayMultiaddr(relay, undefined, this.activeRelay ?? undefined)) return false;
    return this.addDialCandidate(address);
  }

  /** Promote a candidate that answered peer.info as a relay and retry it. */
  addDiscoveredRelay(multiaddr: string): boolean {
    if (!this.allowVerifiedCandidate(multiaddr)) return false;
    this.dialableRelays.add(multiaddr);
    const newlyAdded = !this.discoveredRelays.has(multiaddr);
    if (newlyAdded
      && this.discoveredRelays.size >= XoreinTransportManager.MAX_DISCOVERED_RELAYS) {
      const oldest = this.discoveredRelays.values().next().value as string | undefined;
      if (oldest) {
        this.discoveredRelays.delete(oldest);
        if (oldest !== this.activeRelay) this.dialableRelays.delete(oldest);
      }
    }
    this.discoveredRelays.add(multiaddr);
    if (this.running && this.state !== 'connected' && newlyAdded) {
      void this.connectOnce();
    }
    return true;
  }

  private addDialCandidate(address: string): boolean {
    if (this.dialableCandidates.has(address)) return true;
    if (this.dialableCandidates.size >= XoreinTransportManager.MAX_DIAL_CANDIDATES) {
      const evictable = [...this.dialableCandidates]
        .find(candidate => !this.dialableRelays.has(candidate) && candidate !== this.activeRelay);
      if (!evictable) return false;
      this.dialableCandidates.delete(evictable);
    }
    this.dialableCandidates.add(address);
    return true;
  }

  private rememberAuthenticatedPeer(peerId: string | undefined): void {
    if (!peerId) return;
    if (this.authenticatedPeerIds.has(peerId)) {
      this.authenticatedPeerIds.delete(peerId);
    } else if (this.authenticatedPeerIds.size >= XoreinTransportManager.MAX_AUTHENTICATED_PEERS) {
      const oldest = this.authenticatedPeerIds.values().next().value as string | undefined;
      if (oldest) this.authenticatedPeerIds.delete(oldest);
    }
    this.authenticatedPeerIds.add(peerId);
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  private async connectOnce(replaceActiveRelay = false): Promise<void> {
    if (this.connecting) return; // guard against overlapping calls
    this.connecting = true;
    this.setState('connecting');
    try {
      // Resolve the list once per attempt. A loopback support node may advertise
      // a freshly-generated relay identity that differs from the build default;
      // that address must be tried before stale configured fallbacks.
      let relayList = [...new Set([
        ...(await resolveRelayListAsync(this.opts.relayMultiaddr)),
        ...this.discoveredRelays,
      ])];
      for (const relay of relayList) {
        this.dialableRelays.add(relay);
        this.addDialCandidate(relay);
      }
      // RESILIENCE: the libp2p node is created ONCE and kept alive across relay
      // loss. Rebuilding it per reconnect (the previous behavior) tore down every
      // connection — including direct browser↔browser WebRTC links that do not
      // depend on the relay at all — plus all inbound handlers and pooled
      // streams. With the node stable, losing the relay only pauses the
      // bootstrap path: peers that already know each other keep communicating.
      if (!this.node) {
        const node = await createXoreinNode({
          relayMultiaddr: this.opts.relayMultiaddr,
          trustedRelayMultiaddrs: relayList,
          dialableCandidateMultiaddrs: this.dialableCandidates,
          dialableRelayMultiaddrs: this.dialableRelays,
          authenticatedPeerIds: this.authenticatedPeerIds,
          identity: this.opts.identity,
        });

        // Monitor both connection-level and peer-level disconnects. A relay can
        // be killed abruptly before the connection-close event reaches the
        // browser; libp2p still emits peer:disconnect when its connection map is
        // reconciled, and that event is what guarantees the re-reservation loop.
        const onPeerPathChange = (peerId: string | undefined) => {
          const relayId = this.activeRelay?.split('/').at(-1) ?? this.lastRelayPeerId;
          if (relayId && peerId?.includes(relayId)) {
            this.activeRelay = null;
            this.setState('disconnected');
            if (this.running) this.scheduleReconnect();
          } else {
            // A direct peer appearing/disappearing changes whether a relay-less
            // client still has a usable network path, so let the engine publish
            // an honest snapshot even when the relay state itself is unchanged.
            this.opts.onStateChange?.(this.state);
          }
        };
        node.addEventListener('connection:close', (evt: CustomEvent) => {
          onPeerPathChange(evt.detail?.remotePeer?.toString());
        });
        node.addEventListener('peer:disconnect', (evt: CustomEvent) => {
          onPeerPathChange(evt.detail?.toString());
        });
        node.addEventListener('peer:connect', (evt: CustomEvent) => {
          this.rememberAuthenticatedPeer(evt.detail?.toString());
          this.opts.onStateChange?.(this.state);
        });

        this.node = node;
      }

      // CircuitSearch intentionally owns one discovered reservation slot. To
      // switch to a different relay identity, first authenticate/dial the new
      // candidate, then release the old reservation so the slot becomes
      // available. Existing direct WebRTC peer links remain on the same node.
      if (replaceActiveRelay && this.activeRelay && relayList.length > 0) {
        const previousRelay = this.activeRelay;
        const nextRelay = relayList[0];
        const previousPeer = previousRelay.split('/p2p/').at(-1);
        const nextPeer = nextRelay.split('/p2p/').at(-1);
        if (previousPeer && nextPeer && previousPeer !== nextPeer) {
          try {
            await this.node.dial(multiaddr(nextRelay), {
              signal: AbortSignal.timeout(10_000),
            });
            // Keep the prior relay as the final fallback. If reservation on the
            // selected node is rejected, the same live peer node can reserve
            // the old relay again instead of stranding the user.
            relayList = [...new Set([...relayList, previousRelay])];
            await this.node.hangUp(multiaddr(previousRelay));
            this.activeRelay = null;
          } catch {
            // The HTTP gateway answered but its advertised relay transport did
            // not. Preserve the working reservation and report the real state.
            this.setState('connected');
            return;
          }
        }
      }

      // Try each configured relay in order and reserve a circuit on the first that
      // answers (multi-relay failover). reserveCircuitRelay handles the generous
      // 30s dial + reservation timeouts per relay.
      const reserved = await reserveAnyRelay(this.node, relayList);
      if (!reserved) {
        // No relay answered. Keep the node RUNNING — existing direct connections
        // and inbound handlers stay live — and let the backoff retry reservation.
        this.activeRelay = null;
        this.setState('disconnected');
        return;
      }

      this.activeRelay = reserved;
      this.lastRelayPeerId = reserved.split('/p2p/').at(-1) ?? null;
      this.setState('connected');
      this.backoff.reset();
    } catch {
      this.setState('disconnected');
    } finally {
      this.connecting = false;
      if (this.reconnectRequested && this.running) {
        this.reconnectRequested = false;
        const replaceRelay = this.replaceRelayOnNextAttempt;
        this.replaceRelayOnNextAttempt = false;
        void this.connectOnce(replaceRelay);
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.backoff.next();
    setTimeout(async () => {
      if (!this.running) return;
      if (this.state !== 'connected') {
        await this.connectOnce();
        if (this.connectionState !== 'connected') this.scheduleReconnect();
      }
    }, delay);
  }
}
