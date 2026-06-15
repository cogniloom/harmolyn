import { describe, it, expect } from 'vitest';
import { CAPABILITY_MAP, NATIVE_CAPABILITIES, HTTP_CAPABILITIES } from './capabilityMap';

describe('capabilityMap', () => {
  it('has no duplicate capability names', () => {
    const names = CAPABILITY_MAP.map(c => c.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `Duplicate capabilities: ${dupes.join(', ')}`).toHaveLength(0);
  });

  it('every capability has a non-empty name and description', () => {
    for (const cap of CAPABILITY_MAP) {
      expect(cap.name.trim(), 'empty name').not.toBe('');
      expect(cap.description.trim(), `empty description for ${cap.name}`).not.toBe('');
    }
  });

  it('p2pPropagated is false for all native-local and http capabilities', () => {
    for (const cap of CAPABILITY_MAP) {
      if (cap.route === 'native-local' || cap.route === 'http') {
        expect(cap.p2pPropagated, `${cap.name} is ${cap.route} but has p2pPropagated=true`).toBe(false);
      }
    }
  });

  it('NATIVE_CAPABILITIES and HTTP_CAPABILITIES are non-overlapping', () => {
    const nativeSet = new Set(NATIVE_CAPABILITIES);
    const overlap = HTTP_CAPABILITIES.filter(c => nativeSet.has(c));
    expect(overlap, `Capabilities in both lists: ${overlap.join(', ')}`).toHaveLength(0);
  });

  it('NATIVE_CAPABILITIES + HTTP_CAPABILITIES covers every capability', () => {
    const allRouted = new Set([...NATIVE_CAPABILITIES, ...HTTP_CAPABILITIES]);
    const missing = CAPABILITY_MAP
      .filter(c => c.route !== 'gap' && !allRouted.has(c.name))
      .map(c => c.name);
    expect(missing, `Unrouted capabilities: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('no capability has route gap (all gaps must be removed before shipping)', () => {
    const gaps = CAPABILITY_MAP.filter(c => c.route === 'gap').map(c => c.name);
    expect(gaps, `Gap capabilities that must not ship: ${gaps.join(', ')}`).toHaveLength(0);
  });

  it('native capabilities include the core messaging set', () => {
    const required = [
      'sendChannelMessage', 'sendDmMessage', 'editMessage', 'deleteMessage',
      'addReaction', 'removeReaction', 'pinMessage', 'unpinMessage',
    ];
    for (const name of required) {
      expect(NATIVE_CAPABILITIES, `${name} must be native`).toContain(name);
    }
  });
});
