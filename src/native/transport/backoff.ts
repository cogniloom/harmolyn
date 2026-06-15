// Exponential backoff with jitter for reconnection attempts.
// Mirrors the backoff strategy in src/protocol/backoff.ts but for the native engine.
export interface BackoffConfig {
  initialMs: number;   // first delay
  maxMs: number;       // cap
  factor: number;      // multiplier per attempt
  jitterMs: number;    // random jitter added to each delay
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  initialMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitterMs: 500,
};

export class ExponentialBackoff {
  private attempt = 0;
  private readonly cfg: BackoffConfig;

  constructor(cfg: BackoffConfig = DEFAULT_BACKOFF) {
    this.cfg = cfg;
  }

  reset(): void { this.attempt = 0; }

  /** Returns the next delay in ms (capped + jittered). */
  next(): number {
    const base = Math.min(this.cfg.initialMs * Math.pow(this.cfg.factor, this.attempt), this.cfg.maxMs);
    const jitter = Math.random() * this.cfg.jitterMs;
    this.attempt++;
    return base + jitter;
  }

  async sleep(): Promise<void> {
    await new Promise(r => setTimeout(r, this.next()));
  }
}
