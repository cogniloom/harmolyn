// Persistent multiplexed PeerStream channels — one long-lived stream per
// (peer, protocol), with responses correlated by request_id.
//
// PROTOCOL CHANGE (from one stream per request): opening a stream through a
// relay circuit was the single dominant cost of a message (~50ms median,
// measured). The wire format has always carried request_id in both directions,
// so requests can be pipelined on one stream and responses matched as they
// arrive, in any order.
//
// BACKWARD COMPATIBILITY — no protocol-ID bump needed, by construction:
//   - Old responder, new caller: every live responder (JS readFramedMessage,
//     Go readFrameBytes) acts on a COMPLETE FRAME, not on stream close. A
//     one-shot responder answers the first request and closes the stream; the
//     pump sees EOF, fails over, and the next request simply opens a fresh
//     stream — exactly the old per-request behavior, at the old cost.
//   - New responder, old caller: the caller half-closes after one request; the
//     responder loop (serveFamilyStream) drains and closes. Identical bytes on
//     the wire.
//
// FAILURE MODEL: any post-open stream failure (reset, idle abort, unresponsive
// zombie circuit, timeout) rejects all pending requests with MuxStreamError,
// drops the pool entry, and callFamily makes ONE legacy single-shot attempt on
// a genuinely fresh stream before giving up to the caller's outbox/mailbox
// fallback.

import type { Libp2p } from 'libp2p';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import {
  FrameDecoder,
  chunkBytes,
  decodePeerStreamResponse,
  type PeerStreamResponse,
  type StreamChunk,
} from './frames.js';

// ── Stream opening (shared with the legacy one-shot path) ──────────────────

// Stream-open options shared by the reuse and fresh-dial paths.
// - runOnLimitedConnection: relay circuits are 'limited' connections.
// - negotiateFully:false — LATENCY: with a single protocol, multistream-select may
//   write the protocol name together with the first data chunk instead of waiting a
//   full relay-circuit RTT for the ack. Harmless no-op on libp2p versions that do
//   not implement optimistic select. A protocol mismatch then surfaces on the
//   response read, which callers already treat as "peer unreachable".
export const STREAM_OPTS = { runOnLimitedConnection: true, negotiateFully: false } as const;

// Cap protocol negotiation on a REUSED connection. A relay-killed circuit can stay
// 'open' in the local pool (zombie); without this cap a send to it burns the full
// default 10s negotiation timeout before the fresh-dial fallback runs.
const REUSE_NEGOTIATION_TIMEOUT_MS = 5_000;

/** The target peer of a (possibly circuit) multiaddr: its LAST /p2p/ component. */
export function circuitTargetPeer(ma: Multiaddr): string | undefined {
  const comps = ma.getComponents();
  for (let i = comps.length - 1; i >= 0; i--) {
    if (comps[i].name === 'p2p') return comps[i].value;
  }
  return undefined;
}

/**
 * Open an outbound stream to the peer behind `ma`.
 *
 * LATENCY + CORRECTNESS: prefer `newStream` on an EXISTING open connection to the
 * peer instead of `dialProtocol(multiaddr)`. Dialing by circuit multiaddr makes
 * libp2p 3.x establish a whole new relayed connection (reservation + Noise +
 * muxer) per message and then abort it as a 'Duplicate multiaddr connection'
 * (connection-manager guard) whenever any connection to that peer+relay addr
 * already exists — returning the OLD connection, which may be a zombie whose
 * circuit the relay already reset. That both wasted a full circuit setup per
 * message and, once the first circuit died, made every send time out into the
 * mailbox fallback. Reusing the open connection directly skips the per-message
 * circuit dial entirely; if the reused connection turns out broken, every stale
 * connection to the peer is aborted and ONE genuinely fresh dial (`force:true`,
 * which bypasses both the reuse shortcut and the duplicate-multiaddr abort) is
 * attempted before giving up to the caller's mailbox/outbox fallback.
 */
/**
 * Whether a connection's remoteAddr denotes a DIRECT link (not a relayed
 * circuit). Subtle: the DIALER side of a browser↔browser WebRTC connection
 * keeps the full dialed form `<relay>/p2p-circuit/webrtc/p2p/<peer>` as its
 * remoteAddr (only the listener sees a clean `/webrtc/p2p/<peer>`), so a bare
 * "contains p2p-circuit" test misclassifies genuinely-direct outbound WebRTC
 * links as relayed. Any addr with a /webrtc component IS direct — the circuit
 * in it was only the signaling path.
 */
export function isDirectAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr.includes('/webrtc') || !addr.includes('p2p-circuit');
}

// One background direct-upgrade dial attempt per peer per cooldown window —
// enough to converge quickly without dial-storming a peer whose WebRTC path
// is genuinely broken (NAT, disabled transport).
const UPGRADE_RETRY_MS = 30_000;
const upgradeAttempts = new WeakMap<Libp2p, Map<string, number>>();

/**
 * LATENCY + RESILIENCE: when every open connection to a peer is a relayed
 * circuit but the caller is dialing a /webrtc-capable addr (the peer
 * ADVERTISED WebRTC support), kick off a background dial of that addr. On
 * success the 'connection:open' watcher retires the relayed pooled channels
 * and traffic migrates to the direct link — which is both faster and survives
 * relay loss. Without this, connection reuse would pin traffic to whichever
 * connection formed first (usually the plain circuit from first contact) and
 * a direct link would never be attempted at all.
 */
function maybeUpgradeToDirect(node: Libp2p, ma: Multiaddr, targetPeer: string): void {
  const addr = ma.toString();
  if (!addr.includes('/webrtc')) return;
  // Already direct? Nothing to do. (Cheap: a client holds a handful of conns.)
  const hasDirect = node.getConnections?.().some(c =>
    c.status === 'open' && c.remotePeer.toString() === targetPeer && isDirectAddr(c.remoteAddr?.toString()));
  if (hasDirect) return;
  let attempts = upgradeAttempts.get(node);
  if (!attempts) {
    attempts = new Map();
    upgradeAttempts.set(node, attempts);
  }
  const now = Date.now();
  if (now - (attempts.get(targetPeer) ?? 0) < UPGRADE_RETRY_MS) return;
  attempts.set(targetPeer, now);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dial = (node as any).dial;
  if (typeof dial !== 'function') return; // test fakes
  try {
    void Promise.resolve(dial.call(node, ma)).catch(() => { /* stay relayed */ });
  } catch { /* stay relayed */ }
}

export async function openFamilyStream(node: Libp2p, ma: Multiaddr, protocol: string) {
  const targetPeer = circuitTargetPeer(ma);
  // Among reusable connections, prefer a DIRECT one (e.g. an upgraded
  // browser↔browser WebRTC link) over a relayed circuit: it is faster (no
  // relay traversal) and survives relay loss.
  const candidates = targetPeer == null ? [] : node
    .getConnections()
    .filter(c => c.status === 'open' && c.remotePeer.toString() === targetPeer);
  const existing =
    candidates.find(c => isDirectAddr(c.remoteAddr?.toString()))
    ?? candidates[0];


  if (existing != null) {
    try {
      return await existing.newStream(protocol, {
        ...STREAM_OPTS,
        signal: AbortSignal.timeout(REUSE_NEGOTIATION_TIMEOUT_MS),
      });
    } catch (err) {
      // Broken/zombie connection: evict every connection to this peer so the
      // fresh dial below (and future sends) cannot be pinned back onto it.
      for (const c of node.getConnections()) {
        if (c.remotePeer.toString() === targetPeer) {
          try { c.abort(err instanceof Error ? err : new Error('peerstream: stale connection')); } catch { /* already closed */ }
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (node as any).dialProtocol(ma, protocol, { ...STREAM_OPTS, force: true });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (node as any).dialProtocol(ma, protocol, STREAM_OPTS);
}

// ── Mux channel ────────────────────────────────────────────────────────────

/** A pooled-stream failure — retryable via one legacy single-shot attempt. */
export class MuxStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MuxStreamError';
  }
}

/** Reply deadline per pipelined request. Handlers answer in well under a second;
 * a silent stream this long is a zombie circuit, so the whole channel is torn
 * down (and the caller's legacy retry re-dials fresh). */
const REQUEST_TIMEOUT_MS = 15_000;

/** Keep pooled streams alive well past libp2p's 120s default inactivity abort,
 * so a quiet-but-open conversation doesn't pay stream re-setup per message. An
 * idle abort is still handled gracefully (pump EOF → pool entry dropped). */
const POOLED_STREAM_INACTIVITY_MS = 600_000;

interface MuxStream extends AsyncIterable<StreamChunk> {
  send(d: Uint8Array): boolean;
  abort?(err: Error): void;
  inactivityTimeout?: number;
  addEventListener?(type: string, cb: () => void, opts?: { once?: boolean }): void;
}

interface Pending {
  resolve(resp: PeerStreamResponse): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class MuxChannel {
  private readonly pending = new Map<string, Pending>();
  private dead = false;
  private drainGate: Promise<void> | null = null;
  private releaseDrainGate: (() => void) | null = null;

  constructor(
    private readonly stream: MuxStream,
    private readonly onDead: () => void,
  ) {
    try { stream.inactivityTimeout = POOLED_STREAM_INACTIVITY_MS; } catch { /* readonly on fakes */ }
    void this.pump();
  }

  get pendingCount(): number { return this.pending.size; }
  get isDead(): boolean { return this.dead; }

  async request(framed: Uint8Array, requestId: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<PeerStreamResponse> {
    if (this.dead) throw new MuxStreamError('mux: stream closed');
    if (this.drainGate) {
      await this.drainGate;
      if (this.dead) throw new MuxStreamError('mux: stream closed');
    }
    return await new Promise<PeerStreamResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // An unresponsive pooled stream is indistinguishable from a zombie
        // circuit: fail EVERYTHING on it so the next attempt re-dials fresh,
        // rather than letting each request burn its own timeout.
        this.destroy(new MuxStreamError(`mux: no response within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      let accepted = false;
      try {
        accepted = this.stream.send(framed);
        try {
          if (typeof localStorage !== 'undefined' && localStorage.getItem('harmolyn:debug:latency') === '1') {
            console.debug(`[lat] mux sent rid=${requestId.slice(0, 8)} at=${Date.now()}`);
          }
        } catch { /* debug tap only */ }
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        const wrapped = new MuxStreamError(`mux: send failed: ${err instanceof Error ? err.message : String(err)}`);
        this.destroy(wrapped);
        reject(wrapped);
        return;
      }
      if (!accepted) this.armDrainGate();
    });
  }

  /** send() returned false: the write buffer is full. Hold further requests
   * until the stream emits 'drain' (already-sent data is buffered, not lost).
   *
   * DEADLOCK GUARD: a stream that hits backpressure may never drain — the
   * libp2p abstract stream RESETS on write-buffer overflow ('close', never
   * 'drain'), and a timeout/retirement destroy() can land while the gate is
   * armed. destroy() therefore releases the gate too; woken waiters re-check
   * `dead` and fail over to the single-shot retry instead of hanging (which
   * previously wedged the whole outbox drain chain behind one dead channel). */
  private armDrainGate(): void {
    if (this.drainGate || typeof this.stream.addEventListener !== 'function') return;
    this.drainGate = new Promise<void>(resolve => {
      this.releaseDrainGate = () => {
        this.drainGate = null;
        this.releaseDrainGate = null;
        resolve();
      };
      this.stream.addEventListener!('drain', () => this.releaseDrainGate?.(), { once: true });
    });
  }

  private async pump(): Promise<void> {
    const decoder = new FrameDecoder();
    try {
      for await (const chunk of this.stream) {
        for (const frame of decoder.push(chunkBytes(chunk))) {
          this.settle(decodePeerStreamResponse(frame));
        }
      }
      // Clean EOF — a one-shot (legacy) responder closing after its single
      // response, or an idle close. Not an error; pending (if any) fail over.
      this.destroy(new MuxStreamError('mux: stream ended'));
    } catch (err) {
      this.destroy(new MuxStreamError(`mux: stream failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private settle(resp: PeerStreamResponse): void {
    let key = resp.requestId;
    let entry = key ? this.pending.get(key) : undefined;
    if (!entry && !resp.requestId && this.pending.size === 1) {
      // Defensive: a responder that failed to echo request_id (e.g. the Go
      // frame-parse error path replies with an empty id). Only safe when
      // unambiguous.
      [key, entry] = this.pending.entries().next().value as [string, Pending];
    }
    if (!entry || !key) return; // response for a timed-out or unknown request
    this.pending.delete(key);
    clearTimeout(entry.timer);
    entry.resolve(resp);
  }

  destroy(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.onDead();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    // Wake anyone parked on the drain gate — they re-check `dead` and throw.
    this.releaseDrainGate?.();
    try { this.stream.abort?.(err); } catch { /* already gone */ }
  }
}

// ── Pool ───────────────────────────────────────────────────────────────────

interface PoolEntry { promise: Promise<MuxChannel> }

// Keyed by node so a stopped/replaced libp2p node's channels are unreachable
// and collectable; entries self-remove when their channel dies.
const pools = new WeakMap<Libp2p, Map<string, PoolEntry>>();

/** Test/diagnostic aid: live channel count for a node. */
export function muxPoolSize(node: Libp2p): number {
  return pools.get(node)?.size ?? 0;
}

/**
 * LATENCY: when a DIRECT connection to a peer comes up (DCUtR upgrade or a
 * fresh browser↔browser WebRTC dial), channels pooled on the old relayed
 * circuit would otherwise keep every message on the relay path forever (the
 * pool only re-opens on death). Retire them: pending requests fail over via
 * callFamily's single-shot retry, which now reuses the direct connection
 * (openFamilyStream prefers non-circuit connections), and the next pooled
 * open lands on the direct link too.
 */
function watchDirectUpgrades(node: Libp2p, pool: Map<string, PoolEntry>): void {
  if (typeof node.addEventListener !== 'function') return; // test fakes
  node.addEventListener('connection:open', (evt: CustomEvent) => {
    const conn = evt.detail as { remotePeer?: { toString(): string }; remoteAddr?: { toString(): string } } | undefined;
    const peer = conn?.remotePeer?.toString();
    if (!peer || !isDirectAddr(conn?.remoteAddr?.toString())) return;
    for (const [key, entry] of pool) {
      if (!key.startsWith(`${peer}|`)) continue;
      entry.promise
        .then(ch => ch.destroy(new MuxStreamError('mux: retired in favor of a direct connection')))
        .catch(() => { /* open already failed; entry self-removed */ });
    }
  });
}

/**
 * Send one framed request over the persistent channel for (peer, protocol),
 * opening it on first use. Concurrent first calls share a single open. Throws
 * MuxStreamError for post-open stream failures (retryable via the legacy
 * one-shot path); dial failures propagate as-is (the peer is unreachable —
 * a second dial would fail the same way).
 */
export async function muxRequest(
  node: Libp2p,
  peer: Multiaddr | string,
  protocol: string,
  framed: Uint8Array,
  requestId: string,
): Promise<PeerStreamResponse> {
  const ma = typeof peer === 'string' ? multiaddr(peer) : peer;
  const targetPeer = circuitTargetPeer(ma);
  const key = `${targetPeer ?? ma.toString()}|${protocol}`;

  // Direct-upgrade check runs on EVERY request, not just pool opens: the pool
  // pins traffic to whatever connection formed first (usually the plain
  // circuit from first contact), while the peer's advertised /webrtc addr —
  // which the caller resolves fresh per send — often only arrives via
  // presence AFTER the pool exists. Cooldown-guarded, no-ops once direct.
  if (targetPeer != null) maybeUpgradeToDirect(node, ma, targetPeer);

  let pool = pools.get(node);
  if (!pool) {
    pool = new Map();
    pools.set(node, pool);
    watchDirectUpgrades(node, pool);
  }

  let entry = pool.get(key);
  if (!entry) {
    const created: PoolEntry = { promise: undefined as unknown as Promise<MuxChannel> };
    created.promise = openFamilyStream(node, ma, protocol).then(
      stream => new MuxChannel(stream as MuxStream, () => {
        if (pool.get(key) === created) pool.delete(key);
      }),
      err => {
        if (pool.get(key) === created) pool.delete(key);
        throw err;
      },
    );
    pool.set(key, created);
    entry = created;
  }

  const channel = await entry.promise;
  return await channel.request(framed, requestId);
}
