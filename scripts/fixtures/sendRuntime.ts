// Test-build alias only; never imported by the production entrypoint.
import { useMemo } from 'react';
import { useRuntimeMutations as useRealMutations } from '../../src/hooks/runtime/useRuntimeMutations';
export * from '../../src/hooks/runtime/useRuntimeMutations';
export const isSendFixture = typeof location !== 'undefined' && new URLSearchParams(location.search).has('test-remote-send');
const calls: { scope: string; content: string; reply?: { reply_to?: string } }[] = [];
const listeners = new Set<() => void>();
let pending: { resolve: () => void; reject: (error: Error) => void } | null = null;
export const subscribeSends = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getSendCount = () => calls.length;
export const getSendCalls = () => calls;
export function settleSend(success: boolean) {
  const current = pending; pending = null;
  if (success) current?.resolve();
  else current?.reject(new Error('TEST-PRIVATE-DIAGNOSTIC: token=fixture-only'));
}
async function send(scope: string, content: string, reply?: { reply_to?: string }) {
  if (pending) throw new Error('Overlapping simulated sends');
  calls.push({ scope, content, ...(reply ? { reply } : {}) });
  const result = new Promise<void>((resolve, reject) => { pending = { resolve, reject }; });
  for (const listener of listeners) listener();
  await result;
}
export function useRuntimeMutations() {
  const facade = useRealMutations();
  return useMemo(() => isSendFixture ? { ...facade, sendChannelMessage: send, sendDmMessage: send } : facade, [facade]);
}
