// Fair, zero-trust multi-source channel history reconstruction.
//
// Providers advertise only availability hints. Every fetched message is accepted
// solely on the original author's signature; neither a provider majority nor a
// preferred node can manufacture truth. Dedicated nodes are preferred for bulk
// transfer, while peer providers are rotated and request sizes are bounded.
import type { XoreinRuntimeMessage } from '../../types.js';
import {
  selectNewestVerifiedVersions,
  verifySignedHistoryMessage,
} from './signedHistory.js';

export interface HistoryCoverageEntry {
  id: string;
  created_at: string;
  content_hash: string;
  revision: number;
}

export interface HistoryCoverage {
  ok?: boolean;
  entries?: HistoryCoverageEntry[];
  has_more?: boolean;
}

export type HistoryProviderKind = 'archivist' | 'relay' | 'peer';

export interface SwarmHistoryProvider {
  peerId: string;
  kind: HistoryProviderKind;
  coverage(): Promise<HistoryCoverage | null>;
  fetch(messageIds: string[]): Promise<XoreinRuntimeMessage[] | null>;
}

export interface ProviderEvidence {
  successes: number;
  failures: number;
  invalidRecords: number;
  conflictingCopies: number;
  lastFailureAt?: number;
  quarantinedUntil?: number;
}

const evidence = new Map<string, ProviderEvidence>();
let auditRemaining = randomAuditInterval();

function randomAuditInterval(): number {
  const byte = new Uint8Array(1);
  try { crypto.getRandomValues(byte); } catch { byte[0] = Math.floor(Math.random() * 256); }
  return 20 + (byte[0] % 31); // uniformly-enough distributed 20..50
}

function providerEvidence(peerId: string): ProviderEvidence {
  let current = evidence.get(peerId);
  if (!current) {
    current = { successes: 0, failures: 0, invalidRecords: 0, conflictingCopies: 0 };
    evidence.set(peerId, current);
  }
  return current;
}

function recordSuccess(peerId: string): void {
  providerEvidence(peerId).successes++;
}

function recordFailure(peerId: string): void {
  const current = providerEvidence(peerId);
  current.failures++;
  current.lastFailureAt = Date.now();
}

function recordInvalid(peerId: string): void {
  const current = providerEvidence(peerId);
  current.invalidRecords++;
  current.lastFailureAt = Date.now();
  // Cryptographically invalid data is objective local evidence. Quarantine it
  // briefly, but never gossip this score (global reputation is Sybil/slanderable).
  current.quarantinedUntil = Date.now() + Math.min(60 * 60_000, 5 * 60_000 * current.invalidRecords);
}

function recordConflict(peerId: string): void {
  providerEvidence(peerId).conflictingCopies++;
}

export function providerEvidenceSnapshot(): Record<string, ProviderEvidence> {
  return Object.fromEntries([...evidence].map(([id, value]) => [id, { ...value }]));
}

/** Tests only: clears local evidence and controls when the next audit happens. */
export function resetSwarmHistoryState(nextAudit = randomAuditInterval()): void {
  evidence.clear();
  auditRemaining = nextAudit;
}

function providerScore(provider: SwarmHistoryProvider): number {
  const current = providerEvidence(provider.peerId);
  if ((current.quarantinedUntil ?? 0) > Date.now()) return Number.NEGATIVE_INFINITY;
  const kind = provider.kind === 'archivist' ? 300 : provider.kind === 'relay' ? 200 : 100;
  return kind + current.successes - current.failures * 2 - current.invalidRecords * 25;
}

function validCoverageEntry(value: unknown): value is HistoryCoverageEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<HistoryCoverageEntry>;
  return typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 256
    && typeof entry.created_at === 'string' && entry.created_at.length <= 96
    && typeof entry.content_hash === 'string' && entry.content_hash.length <= 128
    && Number.isSafeInteger(entry.revision) && Number(entry.revision) >= 0;
}

function messageOrder(a: HistoryCoverageEntry, b: HistoryCoverageEntry): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface SwarmFetchOptions {
  providers: SwarmHistoryProvider[];
  serverId: string;
  channelId: string;
  limit: number;
  existingMessageIds?: ReadonlySet<string>;
  /** Bounds discovery fan-out. A later page rotates providers at the caller. */
  maxProviders?: number;
  /** Bounds each provider request even if a malicious inventory is huge. */
  maxIDsPerFetch?: number;
}

export interface SwarmFetchResult {
  messages: XoreinRuntimeMessage[];
  hasMore: boolean;
  answeredProviders: number;
  attemptedProviders: number;
  advertisedRecords: number;
  unresolvedRecords: number;
  conflicts: number;
}

/**
 * Reconstruct one page from multiple untrusted providers.
 *
 * Availability is unioned, bulk assignments prefer nodes, peer assignments are
 * round-robin, failed/invalid assignments retry another holder, and every 20–50
 * successful records one item is sampled from two additional holders.
 */
export async function fetchSwarmHistoryPage(options: SwarmFetchOptions): Promise<SwarmFetchResult> {
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit)));
  const maxProviders = Math.max(1, Math.min(32, options.maxProviders ?? 16));
  const maxIDs = Math.max(1, Math.min(100, options.maxIDsPerFetch ?? 50));
  const existing = options.existingMessageIds ?? new Set<string>();
  const providers = [...new Map(options.providers.map(p => [p.peerId, p])).values()]
    .filter(p => providerScore(p) > Number.NEGATIVE_INFINITY)
    .sort((a, b) => providerScore(b) - providerScore(a))
    .slice(0, maxProviders);

  const coverageResults = await Promise.all(providers.map(async provider => {
    try {
      const response = await provider.coverage();
      if (!response?.ok || !Array.isArray(response.entries)) {
        recordFailure(provider.peerId);
        return null;
      }
      recordSuccess(provider.peerId);
      return {
        provider,
        entries: response.entries.filter(validCoverageEntry).slice(-200),
        hasMore: Boolean(response.has_more),
      };
    } catch {
      recordFailure(provider.peerId);
      return null;
    }
  }));
  const answered = coverageResults.filter((v): v is NonNullable<typeof v> => v !== null);

  // id -> providers that claim it, and the highest advertised revision/time hint.
  const holders = new Map<string, SwarmHistoryProvider[]>();
  const inventory = new Map<string, HistoryCoverageEntry>();
  for (const response of answered) {
    for (const entry of response.entries) {
      if (existing.has(entry.id)) continue;
      const list = holders.get(entry.id) ?? [];
      if (!list.some(provider => provider.peerId === response.provider.peerId)) {
        list.push(response.provider);
        holders.set(entry.id, list);
      }
      const prior = inventory.get(entry.id);
      if (!prior || entry.revision > prior.revision
        || (entry.revision === prior.revision && messageOrder(prior, entry) < 0)) {
        inventory.set(entry.id, entry);
      }
    }
  }

  const wanted = [...inventory.values()].sort(messageOrder).slice(-limit);
  const assignments = new Map<string, string[]>();
  let rr = 0;
  for (const entry of wanted) {
    const candidates = (holders.get(entry.id) ?? [])
      .filter(provider => providerScore(provider) > Number.NEGATIVE_INFINITY)
      .sort((a, b) => providerScore(b) - providerScore(a));
    if (!candidates.length) continue;
    // Stay in the best available provider tier (nodes before clients), then
    // rotate inside that tier so one machine is not forced to serve the page.
    const bestKind = candidates[0].kind;
    const tier = candidates.filter(provider => provider.kind === bestKind);
    const selected = tier[rr++ % tier.length];
    assignments.set(selected.peerId, [...(assignments.get(selected.peerId) ?? []), entry.id]);
  }

  const accepted = new Map<string, { message: XoreinRuntimeMessage; providerId: string }>();
  const attemptedByID = new Map<string, Set<string>>();

  const acceptBatch = (provider: SwarmHistoryProvider, requested: ReadonlySet<string>, batch: XoreinRuntimeMessage[] | null) => {
    if (!batch) {
      recordFailure(provider.peerId);
      return;
    }
    for (const message of batch.slice(0, maxIDs)) {
      if (!requested.has(message?.id)
        || message.server_id !== options.serverId
        || message.scope_id !== options.channelId
        || message.scope_type !== 'channel') {
        recordInvalid(provider.peerId);
        continue;
      }
      const verified = verifySignedHistoryMessage(message);
      if (!verified.ok) {
        recordInvalid(provider.peerId);
        continue;
      }
      recordSuccess(provider.peerId);
      const prior = accepted.get(message.id);
      if (!prior || (message.author_revision ?? 0) > (prior.message.author_revision ?? 0)) {
        accepted.set(message.id, { message, providerId: provider.peerId });
      } else if ((message.author_revision ?? 0) === (prior.message.author_revision ?? 0)
        && message.author_proof?.content_hash !== prior.message.author_proof?.content_hash) {
        // Two distinct author-valid records at one revision are author
        // equivocation, not a majority vote. Preserve the first and surface conflict.
        recordConflict(provider.peerId);
        recordConflict(prior.providerId);
      }
    }
  };

  await Promise.all([...assignments].flatMap(([providerId, ids]) => {
    const provider = providers.find(candidate => candidate.peerId === providerId)!;
    return chunk(ids, maxIDs).map(async idsChunk => {
      const attempts = idsChunk.map(id => {
        const set = attemptedByID.get(id) ?? new Set<string>();
        set.add(provider.peerId);
        attemptedByID.set(id, set);
        return id;
      });
      try {
        acceptBatch(provider, new Set(attempts), await provider.fetch(attempts));
      } catch {
        recordFailure(provider.peerId);
      }
    });
  }));

  // Retry unresolved IDs from another holder. This is bounded to one request per
  // provider and never trusts the alternate merely because the first one failed.
  const unresolved = wanted.map(entry => entry.id).filter(id => !accepted.has(id));
  const retries = new Map<string, string[]>();
  for (const id of unresolved) {
    const tried = attemptedByID.get(id) ?? new Set<string>();
    const alternate = (holders.get(id) ?? []).find(provider =>
      !tried.has(provider.peerId) && providerScore(provider) > Number.NEGATIVE_INFINITY);
    if (alternate) retries.set(alternate.peerId, [...(retries.get(alternate.peerId) ?? []), id]);
  }
  await Promise.all([...retries].flatMap(([providerId, ids]) => {
    const provider = providers.find(candidate => candidate.peerId === providerId)!;
    return chunk(ids, maxIDs).map(async idsChunk => {
      try {
        acceptBatch(provider, new Set(idsChunk), await provider.fetch(idsChunk));
      } catch {
        recordFailure(provider.peerId);
      }
    });
  }));

  // Randomized 3-source audit. Signatures remain authoritative; comparison finds
  // stale/equivocating copies and exercises providers that were not selected for
  // bulk transfer.
  for (const [id, acceptedRecord] of accepted) {
    auditRemaining--;
    if (auditRemaining > 0) continue;
    auditRemaining = randomAuditInterval();
    const alternates = (holders.get(id) ?? [])
      .filter(provider => provider.peerId !== acceptedRecord.providerId)
      .slice(0, 2);
    const copies = await Promise.all(alternates.map(async provider => {
      try {
        const batch = await provider.fetch([id]);
        const copy = batch?.find(message => message.id === id);
        if (!copy) {
          recordFailure(provider.peerId);
          return null;
        }
        if (!verifySignedHistoryMessage(copy).ok) {
          recordInvalid(provider.peerId);
          return null;
        }
        recordSuccess(provider.peerId);
        return { provider, message: copy };
      } catch {
        recordFailure(provider.peerId);
        return null;
      }
    }));
    for (const copy of copies) {
      if (!copy) continue;
      const have = acceptedRecord.message;
      const haveRev = have.author_revision ?? 0;
      const copyRev = copy.message.author_revision ?? 0;
      if (copyRev > haveRev) {
        accepted.set(id, { message: copy.message, providerId: copy.provider.peerId });
      } else if (copyRev === haveRev
        && copy.message.author_proof?.content_hash !== have.author_proof?.content_hash) {
        recordConflict(copy.provider.peerId);
        recordConflict(acceptedRecord.providerId);
      }
    }
  }

  const messages = selectNewestVerifiedVersions([...accepted.values()].map(value => value.message))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
  const snapshot = providerEvidenceSnapshot();
  const conflicts = Object.values(snapshot).reduce((sum, current) => sum + current.conflictingCopies, 0);
  return {
    messages,
    hasMore: answered.some(response => response.hasMore),
    answeredProviders: answered.length,
    attemptedProviders: providers.length,
    advertisedRecords: wanted.length,
    unresolvedRecords: wanted.length - messages.length,
    conflicts,
  };
}
