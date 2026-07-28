// Voice-mesh reliability helpers, factored out of session.ts so the tricky bits
// (candidate buffering, reconnect backoff, coordinator election) are unit-testable
// without standing up a whole VoiceSession + libp2p + RTCPeerConnection.

import { ExponentialBackoff, type BackoffConfig } from '../transport/backoff.js';

/**
 * Buffers trickled ICE candidates that arrive before the peer connection has a
 * remote description, then flushes them in order once it does. Without this, a
 * candidate that races ahead of the SDP answer is silently dropped and the pair
 * may never nominate a working path.
 */
export class IceCandidateBuffer {
  private pending: RTCIceCandidateInit[] = [];
  private ready = false;

  /** Mark the remote description as set — buffered candidates can now be applied. */
  markRemoteReady(): void { this.ready = true; }

  /** Reset on ICE restart: a new remote description will re-open the gate. */
  reset(): void { this.ready = false; this.pending = []; }

  get isReady(): boolean { return this.ready; }
  get bufferedCount(): number { return this.pending.length; }

  /**
   * Add a candidate: apply immediately when ready, else buffer it. Returns the
   * candidates that should be applied NOW (0 or 1) so the caller owns the async
   * addIceCandidate call (and its error handling).
   */
  accept(candidate: RTCIceCandidateInit): RTCIceCandidateInit[] {
    if (this.ready) return [candidate];
    this.pending.push(candidate);
    return [];
  }

  /** Drain everything buffered so far (called right after markRemoteReady). */
  flush(): RTCIceCandidateInit[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

/**
 * Per-peer reconnect scheduler. On a recoverable connection loss the caller asks
 * to schedule a reconnect; the scheduler waits an exponentially-backed-off,
 * jittered delay then invokes the reconnect thunk — unless cancelled (peer left,
 * or the connection recovered on its own) or the max attempts are exhausted.
 */
export class ReconnectScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoff: ExponentialBackoff;
  private attempts = 0;
  private readonly maxAttempts: number;

  constructor(cfg?: BackoffConfig, maxAttempts = 6) {
    this.backoff = new ExponentialBackoff(cfg);
    this.maxAttempts = maxAttempts;
  }

  get scheduled(): boolean { return this.timer != null; }
  get attemptCount(): number { return this.attempts; }

  /**
   * Schedule one reconnect attempt. No-op if an attempt is already pending or the
   * budget is spent. Returns the delay used (ms), or null if not scheduled.
   */
  schedule(reconnect: () => void): number | null {
    if (this.timer != null) return null;
    if (this.attempts >= this.maxAttempts) return null;
    const delay = this.backoff.next();
    this.attempts++;
    this.timer = setTimeout(() => {
      this.timer = null;
      reconnect();
    }, delay);
    return delay;
  }

  /** Cancel a pending attempt (peer gone) without resetting the attempt budget. */
  cancel(): void {
    if (this.timer != null) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Connection recovered: cancel and clear the attempt budget for next time. */
  reset(): void {
    this.cancel();
    this.attempts = 0;
    this.backoff.reset();
  }
}

/**
 * Elect the peer-SFU coordinator for a voice channel: the lexicographically
 * smallest peer-id across the full roster (local peer included). Deterministic and
 * roster-order-independent, so every participant converges on the same coordinator
 * without a negotiation round. Returns the local peer id when it is alone.
 */
export function electVoiceCoordinator(localPeerId: string, roster: string[]): string {
  let winner = localPeerId;
  for (const p of roster) {
    if (p && p.localeCompare(winner) < 0) winner = p;
  }
  return winner;
}

/** True when the local peer is the elected coordinator for the given roster. */
export function isVoiceCoordinator(localPeerId: string, roster: string[]): boolean {
  return electVoiceCoordinator(localPeerId, roster) === localPeerId;
}

/**
 * The peers the local node should hold WebRTC connections to under the peer-SFU
 * topology: the coordinator connects to everyone; everyone else connects only to
 * the coordinator. Excludes self. When the flag is off the caller uses the full
 * mesh instead (this returns the full roster minus self for the coordinator).
 */
export function sfuConnectTargets(localPeerId: string, roster: string[]): string[] {
  const others = Array.from(new Set(roster)).filter(p => p && p !== localPeerId);
  const coordinator = electVoiceCoordinator(localPeerId, roster);
  if (coordinator === localPeerId) return others;              // coordinator ↔ all
  return [coordinator];                                        // member ↔ coordinator only
}

/** Whether TURN relay servers are present in an ICE-server list (vs STUN-only). */
export function hasTurnServer(iceServers: RTCIceServer[]): boolean {
  return iceServers.some(s => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some(u => typeof u === 'string' && u.toLowerCase().startsWith('turn'));
  });
}
