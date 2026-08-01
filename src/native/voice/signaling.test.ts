// Finding 10 regression: the default ICE configuration must never contain a
// third-party (public Google) STUN server — every ICE entry receives STUN binding
// requests carrying the user's real IP the moment a call starts, so a hardcoded
// public server discloses call participation + timing to a third party. The
// public fallback exists ONLY behind an explicit, default-off opt-in.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTurnCredentials, PUBLIC_STUN_OPT_IN_KEY } from './signaling.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(PUBLIC_STUN_OPT_IN_KEY);
});

function urlsOf(servers: RTCIceServer[]): string[] {
  return servers.flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls]));
}

describe('fetchTurnCredentials — no third-party STUN by default', () => {
  it('success path returns ONLY the support node servers (no Google STUN)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ urls: ['turn:node.example:3478'], username: 'u', credential: 'c' }),
    })));

    const servers = await fetchTurnCredentials();
    const urls = urlsOf(servers);
    expect(urls).toEqual(['turn:node.example:3478']);
    expect(urls.some(u => u.includes('google'))).toBe(false);
  });

  it('fallback path returns ONLY the support node STUN (no Google STUN)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('node down'); }));

    const servers = await fetchTurnCredentials();
    const urls = urlsOf(servers);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^stun:.+:3478$/);
    expect(urls[0].includes('google')).toBe(false);
  });

  it('includes the public STUN fallback ONLY behind the explicit default-off opt-in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('node down'); }));

    // Default (no opt-in): private.
    expect(urlsOf(await fetchTurnCredentials()).some(u => u.includes('stun.l.google.com'))).toBe(false);

    // Explicit opt-in: the public fallback appears (after the node's own STUN).
    localStorage.setItem(PUBLIC_STUN_OPT_IN_KEY, 'true');
    const optedIn = urlsOf(await fetchTurnCredentials());
    expect(optedIn.some(u => u.includes('stun.l.google.com'))).toBe(true);
    expect(optedIn[0]).toMatch(/^stun:.+:3478$/); // the node's STUN still leads
  });
});
