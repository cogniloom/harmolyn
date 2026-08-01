// Support-node health tracking — PASSIVE by design.
//
// The support node (bootstrap/relay + blob storage) is NOT the P2P engine:
// peer-to-peer messaging keeps working without it. This module classifies the
// outcomes of requests the app already makes to the node; it must NEVER poll
// the node while it is believed online. During a normal chat session the
// client makes ZERO requests to the support node (the scenario-06 zero-trust
// audit asserts this), so any periodic "health check" while online would be a
// privacy regression.
//
// Active recovery probing (GET /v1/state on the support-node origin) is
// allowed ONLY while the state is 'offline', with backoff, and stops the
// moment a probe succeeds.
//
// Framework-free: no React imports. UI reads it via src/hooks/useNodeHealth.ts.
import { supportNodeOrigin } from '../native/nodeOrigin';

export type NodeHealthState = 'unknown' | 'online' | 'offline';

// Canonical user-facing strings — centralized so E2E tests can assert them.
export const NODE_OFFLINE_MESSAGE = 'No node currently available. This feature only works with at least one node online.';
export const NODE_OFFLINE_BANNER_TITLE = 'Node offline';
export const NODE_OFFLINE_BANNER_DETAIL = 'Peer routing, contacts, joins, messages, attachments, mailbox delivery, and rendezvous remain active through available peers. Only node-exclusive services pause.';

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_INITIAL_DELAY_MS = 5_000;
const PROBE_MAX_DELAY_MS = 30_000;

type Listener = (state: NodeHealthState) => void;

let state: NodeHealthState = 'unknown';
const listeners = new Set<Listener>();

let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeDelayMs = PROBE_INITIAL_DELAY_MS;
let probeInFlight = false;

export function getNodeHealthState(): NodeHealthState {
  return state;
}

/** Subscribe to health-state changes. Returns an unsubscribe function. */
export function subscribeNodeHealth(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function setState(next: NodeHealthState): void {
  if (state === next) return;
  state = next;
  for (const cb of [...listeners]) {
    try {
      cb(next);
    } catch {
      // One broken listener must not starve the others.
    }
  }
}

/** A request to the support node got a response (any HTTP status counts). */
export function reportNodeRequestSuccess(): void {
  stopRecoveryProber();
  setState('online');
}

/**
 * A request to the support node failed. Only transport-level problems mark the
 * node offline: fetch network errors (TypeError), aborts/timeouts, and
 * XoreinControlError code 'transport_unavailable'. An error that carries an
 * HTTP status (e.g. code 'http_404') means the node responded — that is a
 * SUCCESS for health purposes. Unrecognized errors are ignored (no transition).
 */
export function reportNodeRequestFailure(err?: unknown): void {
  const kind = classifyFailure(err);
  if (kind === 'reachable') {
    reportNodeRequestSuccess();
    return;
  }
  if (kind === 'ignore') return;
  setState('offline');
  startRecoveryProber();
}

/** Test-only: reset state, listeners, and any pending recovery probe. */
export function resetNodeHealthForTests(): void {
  stopRecoveryProber();
  probeInFlight = false;
  state = 'unknown';
  listeners.clear();
}

// ── Failure classification ──────────────────────────────────────────────────

type FailureKind = 'transport' | 'reachable' | 'ignore';

function classifyFailure(err: unknown): FailureKind {
  // No error object: the caller already decided this was a transport failure.
  if (err === undefined || err === null) return 'transport';

  // XoreinControlError-like: carries a string `code`.
  const code = typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
    ? (err as { code: string }).code
    : null;
  if (code !== null) {
    if (code === 'transport_unavailable') return 'transport';
    // Thrown before any request left the client — says nothing about the node.
    if (code === 'runtime_unavailable' || code === 'invalid_endpoint') return 'ignore';
    // Any other code (http_4xx/http_5xx/invalid_response/…) means the node answered.
    return 'reachable';
  }

  // fetch rejects with TypeError on network failure; aborts/timeouts surface as
  // DOMException/Error named AbortError or TimeoutError.
  if (err instanceof TypeError) return 'transport';
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'transport';

  // Anything else (JSON parse errors, app-level throws…) proves nothing.
  return 'ignore';
}

// ── Recovery prober (runs ONLY while offline) ──────────────────────────────

function canProbe(): boolean {
  // Guard for non-browser test/build environments.
  return typeof window !== 'undefined' && typeof fetch === 'function';
}

function startRecoveryProber(): void {
  if (!canProbe()) return;
  // Idempotent: keep the existing schedule (and its backoff) if already running.
  if (probeTimer !== null || probeInFlight) return;
  probeDelayMs = PROBE_INITIAL_DELAY_MS;
  scheduleProbe();
}

function stopRecoveryProber(): void {
  if (probeTimer !== null) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
  probeDelayMs = PROBE_INITIAL_DELAY_MS;
}

function scheduleProbe(): void {
  probeTimer = setTimeout(() => {
    probeTimer = null;
    void runProbe();
  }, probeDelayMs);
}

async function runProbe(): Promise<void> {
  if (state !== 'offline') return;
  probeInFlight = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Any response — even an error status — means the node is reachable again.
    await fetch(`${supportNodeOrigin()}/v1/state`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    probeInFlight = false;
    reportNodeRequestSuccess();
  } catch {
    probeInFlight = false;
    if (state === 'offline' && probeTimer === null) {
      probeDelayMs = Math.min(probeDelayMs * 2, PROBE_MAX_DELAY_MS);
      scheduleProbe();
    }
  } finally {
    clearTimeout(timer);
  }
}
