import { useSyncExternalStore } from 'react';
import { getNodeHealthState, subscribeNodeHealth, type NodeHealthState } from '@/lib/nodeHealth';

/**
 * Support-node health for UI gating. `nodeOffline` is true only when the node
 * has been positively observed unreachable ('unknown' does NOT gate anything —
 * a fresh session that never touched the node must not show warnings).
 */
export function useNodeHealth(): { state: NodeHealthState; nodeOffline: boolean } {
  const state = useSyncExternalStore(subscribeNodeHealth, getNodeHealthState, getNodeHealthState);
  return { state, nodeOffline: state === 'offline' };
}
