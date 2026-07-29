// XoreinTransportManager — maintains the browser's libp2p node with automatic
// relay reconnection and exponential backoff. Wraps createXoreinNode.
import type { Libp2p } from 'libp2p';
import type { XoreinIdentity } from '../identity/identity.js';
import { createXoreinNode, circuitAddrs } from './node.js';
import { resolveRelayList, reserveAnyRelay } from './relays.js';
import { ExponentialBackoff, DEFAULT_BACKOFF } from './backoff.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface TransportManagerOptions {
  identity?: XoreinIdentity;
  relayMultiaddr?: string;
  onStateChange?: (state: ConnectionState) => void;
}

export class XoreinTransportManager {
  private node: Libp2p | null = null;
  private state: ConnectionState = 'disconnected';
  private running = false;
  private connecting = false; // prevents overlapping connectOnce calls
  private activeRelay: string | null = null;
  private backoff = new ExponentialBackoff(DEFAULT_BACKOFF);
  private readonly opts: TransportManagerOptions;

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
    await this.connectOnce();
    this.scheduleReconnect();
  }

  /** Stop the manager and disconnect. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.node) {
      await Promise.resolve(this.node.stop()).catch(() => {});
      this.node = null;
    }
    this.activeRelay = null;
    this.setState('disconnected');
  }

  /** Circuit multiaddrs for this peer (empty until relay reservation). */
  getCircuitAddrs(): string[] {
    return this.node ? circuitAddrs(this.node) : [];
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  private async connectOnce(): Promise<void> {
    if (this.connecting) return; // guard against overlapping calls
    this.connecting = true;
    this.setState('connecting');
    try {
      // RESILIENCE: the libp2p node is created ONCE and kept alive across relay
      // loss. Rebuilding it per reconnect (the previous behavior) tore down every
      // connection — including direct browser↔browser WebRTC links that do not
      // depend on the relay at all — plus all inbound handlers and pooled
      // streams. With the node stable, losing the relay only pauses the
      // bootstrap path: peers that already know each other keep communicating.
      if (!this.node) {
        const node = await createXoreinNode({
          relayMultiaddr: this.opts.relayMultiaddr,
          identity: this.opts.identity,
        });

        // Monitor for ACTIVE-relay disconnect so we can trigger a reconnect (which
        // will fail over to the next relay in the list if the current one is gone).
        node.addEventListener('connection:close', (evt: CustomEvent) => {
          const relayId = this.activeRelay?.split('/').at(-1);
          if (relayId && evt.detail?.remotePeer?.toString().includes(relayId)) {
            this.setState('disconnected');
            if (this.running) this.scheduleReconnect();
          }
        });

        this.node = node;
      }

      // Try each configured relay in order and reserve a circuit on the first that
      // answers (multi-relay failover). reserveCircuitRelay handles the generous
      // 30s dial + reservation timeouts per relay.
      const reserved = await reserveAnyRelay(this.node, resolveRelayList(this.opts.relayMultiaddr));
      if (!reserved) {
        // No relay answered. Keep the node RUNNING — existing direct connections
        // and inbound handlers stay live — and let the backoff retry reservation.
        this.activeRelay = null;
        this.setState('disconnected');
        return;
      }

      this.activeRelay = reserved;
      this.setState('connected');
      this.backoff.reset();
    } catch {
      this.setState('disconnected');
    } finally {
      this.connecting = false;
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
