// Finding 10 regression: the default ICE configuration must never contain a
// third-party (public Google) STUN server — every ICE entry receives STUN binding
// requests carrying the user's real IP the moment a call starts, so a hardcoded
// public server discloses call participation + timing to a third party. The
// public fallback exists ONLY behind an explicit, default-off opt-in.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTurnCredentials, PUBLIC_STUN_OPT_IN_KEY, TURN_CREDENTIALS_TIMEOUT_MS } from './signaling.js';

afterEach(() => {
  vi.useRealTimers();
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

  it('bounds a hung TURN credential fetch and returns the private STUN fallback', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      // Deliberately ignore abort() to cover fetch implementations that leave a
      // promise pending: Promise.race must still let a watcher begin signaling.
      return new Promise<Response>(() => {});
    }));

    const pending = fetchTurnCredentials();
    await vi.advanceTimersByTimeAsync(TURN_CREDENTIALS_TIMEOUT_MS);

    const servers = await pending;
    expect(requestSignal?.aborted).toBe(true);
    expect(urlsOf(servers)).toEqual([expect.stringMatching(/^stun:.+:3478$/)]);
  });
});
