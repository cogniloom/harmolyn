import { describe, expect, it, vi } from 'vitest';
import { handleNativeDeepLink } from './nativeDeepLink';

function makeXoreinInviteDeeplink(serverId = 'cyber') {
  const rawInvite = Buffer.from(JSON.stringify({
    server_id: serverId,
    owner_peer_id: 'owner-peer',
    owner_public_key: 'owner-public-key',
    manifest_hash: '0123456789abcdef0123456789abcdef',
    expires_at: '',
    security_mode: 'seal',
    signature: 'signed-payload',
  }), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `xorein://invite/${rawInvite}`;
}

describe('handleNativeDeepLink', () => {
  it('opens signed aether join links', () => {
    const onOpenJoin = vi.fn();

    const handled = handleNativeDeepLink('  aether://join/cyber?invite=signed  ', onOpenJoin);

    expect(handled).toBe(true);
    expect(onOpenJoin).toHaveBeenCalledWith('aether://join/cyber?invite=signed');
  });

  it('opens signed xorein invite links', () => {
    const onOpenJoin = vi.fn();
    const deeplink = makeXoreinInviteDeeplink();

    const handled = handleNativeDeepLink(`  ${deeplink}  `, onOpenJoin);

    expect(handled).toBe(true);
    expect(onOpenJoin).toHaveBeenCalledWith(deeplink);
  });

  it('rejects invite-less join records because the join modal requires a signed invite', () => {
    const onOpenJoin = vi.fn();

    const handled = handleNativeDeepLink('aether://join/cyber', onOpenJoin);

    expect(handled).toBe(false);
    expect(onOpenJoin).not.toHaveBeenCalled();
  });

  it('rejects malformed aether payloads', () => {
    const onOpenJoin = vi.fn();

    const handled = handleNativeDeepLink('aether://not-join/cyber?invite=signed', onOpenJoin);

    expect(handled).toBe(false);
    expect(onOpenJoin).not.toHaveBeenCalled();
  });

  it('ignores non-invite payloads', () => {
    const onOpenJoin = vi.fn();

    const handled = handleNativeDeepLink('https://example.com', onOpenJoin);

    expect(handled).toBe(false);
    expect(onOpenJoin).not.toHaveBeenCalled();
  });

  it('rejects non-string payloads from native events', () => {
    const onOpenJoin = vi.fn();

    const handled = handleNativeDeepLink(Object.create(null), onOpenJoin);

    expect(handled).toBe(false);
    expect(onOpenJoin).not.toHaveBeenCalled();
  });
});
