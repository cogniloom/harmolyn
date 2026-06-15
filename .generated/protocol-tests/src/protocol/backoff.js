export const DEFAULT_BACKOFF_POLICY = {
    baseDelayMs: 250,
    maxDelayMs: 8_000,
    multiplier: 2,
};
export function computeReconnectDelay(attempt, policy = {}) {
    const normalized = normalizeBackoffPolicy(policy);
    const safeAttempt = Math.max(1, Math.trunc(attempt || 1));
    const delay = normalized.baseDelayMs * normalized.multiplier ** (safeAttempt - 1);
    return Math.min(normalized.maxDelayMs, Math.trunc(delay));
}
export function normalizeBackoffPolicy(policy = {}) {
    const baseDelayMs = Math.max(1, Math.trunc(policy.baseDelayMs ?? DEFAULT_BACKOFF_POLICY.baseDelayMs));
    const multiplier = Math.max(1, policy.multiplier ?? DEFAULT_BACKOFF_POLICY.multiplier);
    const maxDelayMs = Math.max(baseDelayMs, Math.trunc(policy.maxDelayMs ?? DEFAULT_BACKOFF_POLICY.maxDelayMs));
    return { baseDelayMs, multiplier, maxDelayMs };
}
