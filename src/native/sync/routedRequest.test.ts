import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../identity/identity';
import {
  createRoutedRequest,
  openRoutedRequest,
  openRoutedResponse,
  sealRoutedResponse,
  verifyRoutedRequest,
} from './routedRequest';

describe('end-to-end encrypted peer routing', () => {
  it('keeps inner operations opaque to routers and authenticates both directions', async () => {
    const origin = await generateIdentity();
    const target = await generateIdentity();
    const request = createRoutedRequest(target.peerId, {
      protocol: '/aether/sync/0.1.0',
      operation: 'sync.join',
      payload: { invite_token: 'owner-secret-capability' },
    }, origin)!;

    expect(verifyRoutedRequest(request)).toBe(true);
    expect(JSON.stringify(request)).not.toContain('owner-secret-capability');
    request.path.push('router-peer');
    expect(openRoutedRequest(request, target)).toEqual({
      protocol: '/aether/sync/0.1.0',
      operation: 'sync.join',
      payload: { invite_token: 'owner-secret-capability' },
    });

    const sealed = sealRoutedResponse(request, { ok: true, crowd_root: 'member-secret' }, target)!;
    expect(sealed).not.toContain('member-secret');
    expect(openRoutedResponse(request, sealed, origin)).toEqual({
      ok: true,
      crowd_root: 'member-secret',
    });
  });

  it('rejects path loops and ciphertext modification', async () => {
    const origin = await generateIdentity();
    const target = await generateIdentity();
    const request = createRoutedRequest(target.peerId, {
      protocol: '/aether/friends/0.1.0',
      operation: 'friends.request',
      payload: { hello: 'world' },
    }, origin)!;
    expect(verifyRoutedRequest({ ...request, path: [origin.peerId, origin.peerId] })).toBe(false);
    expect(verifyRoutedRequest({
      ...request,
      ciphertext: `${request.ciphertext.slice(0, -2)}AA`,
    })).toBe(false);
  });
});
