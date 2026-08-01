// Automatic channel E2EE topology selection.
//
// Tree is the interactive small-group topology and has a protocol-enforced
// 50-member ceiling. Crowd uses sender-key broadcast and is the scalable mode.
// The switch is owner-authoritative and is always accompanied by a fresh epoch
// root; clients never infer a different mode from a locally-stale roster.

export type ChannelSecurityMode = 'tree' | 'crowd';
export const CHANNEL_CRYPTO_PROFILE = 'scope-aad-v2' as const;
export type ChannelCryptoProfile = typeof CHANNEL_CRYPTO_PROFILE;

/** Hard protocol limit shared with Xorein Tree mode. */
export const TREE_MAX_MEMBERS = 50;

/**
 * A Crowd space must shrink below the hard Tree ceiling before moving back.
 * This hysteresis prevents repeated 50/51-member join/leave churn from rotating
 * every member between modes.
 */
export const TREE_REENTRY_MEMBERS = 40;

export function isChannelSecurityMode(value: unknown): value is ChannelSecurityMode {
  return value === 'tree' || value === 'crowd';
}

/**
 * Missing means a pre-v1 development record and is migrated to the v1 baseline
 * profile. Any explicit unknown profile is rejected rather than downgraded.
 */
export function isSupportedChannelCryptoProfile(value: unknown): value is ChannelCryptoProfile | undefined {
  return value === undefined || value === CHANNEL_CRYPTO_PROFILE;
}

/**
 * Resolve the mode recorded by the owner. Missing pre-v1 records are Crowd,
 * because that is the only channel mode older Harmolyn builds emitted.
 */
export function recordedChannelSecurityMode(value: unknown): ChannelSecurityMode {
  return isChannelSecurityMode(value) ? value : 'crowd';
}

/** Select the next owner-authored mode after a membership change. */
export function selectChannelSecurityMode(
  memberCount: number,
  current: ChannelSecurityMode,
): ChannelSecurityMode {
  const count = Number.isFinite(memberCount) ? Math.max(0, Math.floor(memberCount)) : 0;
  if (current === 'tree') return count > TREE_MAX_MEMBERS ? 'crowd' : 'tree';
  return count <= TREE_REENTRY_MEMBERS ? 'tree' : 'crowd';
}
