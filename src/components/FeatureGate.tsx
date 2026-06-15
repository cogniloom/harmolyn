import React from 'react';
import { resolveFeatureFlag, type FeatureKey } from '@/config/featureFlags';

interface FeatureGateProps {
  /** The feature flag key to check */
  feature: FeatureKey;
  /** Content to render when the feature is enabled */
  children: React.ReactNode;
  /** Optional fallback to render when the feature is disabled */
  fallback?: React.ReactNode;
}

/**
 * Conditionally renders children based on a feature flag.
 *
 * @example
 * <FeatureGate feature="threads">
 *   <ThreadPanel />
 * </FeatureGate>
 */
export const FeatureGate: React.FC<FeatureGateProps> = ({ feature, children, fallback = null }) => {
  if (resolveFeatureFlag(feature)) {
    return <>{children}</>;
  }
  return <>{fallback}</>;
};
