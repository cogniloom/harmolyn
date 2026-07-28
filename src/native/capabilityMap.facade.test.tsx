// Real contract check (the header of capabilityMap.ts promises this): every mutation
// the facade actually exposes must be documented in CAPABILITY_MAP. Renders the real
// useRuntimeMutations hook (context deps mocked) and enumerates its methods, so adding
// a facade mutation without documenting it fails CI.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { CAPABILITY_MAP } from './capabilityMap';

vi.mock('@/native/engine/provider', () => ({
  useNativeEngine: () => ({ engine: null, registerIdentity: vi.fn() }),
}));
vi.mock('@/lib/xoreinRuntimeContext', () => ({
  useRuntimeSnapshot: () => ({}),
}));

import { useRuntimeMutations } from '@/hooks/runtime/useRuntimeMutations';

describe('capabilityMap ↔ facade contract', () => {
  it('every facade mutation is documented in CAPABILITY_MAP', () => {
    const { result } = renderHook(() => useRuntimeMutations());
    const facadeNames = Object.keys(result.current as Record<string, unknown>)
      .filter((k) => typeof (result.current as Record<string, unknown>)[k] === 'function');
    expect(facadeNames.length).toBeGreaterThan(20); // sanity: the hook rendered

    const documented = new Set(CAPABILITY_MAP.map((c) => c.name));
    const undocumented = facadeNames.filter((n) => !documented.has(n));
    expect(undocumented, `facade methods missing from capabilityMap.ts: ${undocumented.join(', ')}`).toHaveLength(0);
  });
});
