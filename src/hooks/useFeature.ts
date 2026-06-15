import { resolveFeatureFlag, type FeatureKey } from '@/config/featureFlags';

/**
 * Returns whether a given feature flag is enabled.
 * Use in components for conditional logic beyond simple render gating.
 *
 * @example
 * const hasThreads = useFeature('threads');
 * if (hasThreads) { ... }
 */
export function useFeature(feature: FeatureKey): boolean {
  return resolveFeatureFlag(feature);
}
