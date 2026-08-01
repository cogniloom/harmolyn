// Codex round-6 #9: an edit that can't be encrypted must NOT be transmitted as a
// plaintext fallback. The fail-closed inbound edit handler rejects any edit lacking the
// scope's required encrypted envelope, so a plaintext broadcast would be silently
// discarded by every recipient (diverging the conversation) AND leak cleartext on the
// wire — pure downside. These assert the edit is only broadcast when it encrypted.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initStore, setNativeIdentity, addServer, updateServer } from './store';
import { ChannelCrypto } from '../crowd/channel';
import { SealSessions } from '../seal/session';
import { generateIdentity, identitySigningKey, type XoreinIdentity } from '../identity/identity';
import { registerScopeCrypto, resetScopeCrypto } from '../sync/secureEnvelope';
import { registerHistoryIdentity, resetHistoryIdentity } from '../sync/signedHistory';
import { registerPeerSync } from '../sync/registry';
import { nativeSendChannelMessage, nativeEditMessage } from './mutations';
import type { PeerSync } from '../sync/peersync';

let identity: XoreinIdentity;
let ME = '';
const ALICE = 'alice';
const SRV = 'srv1';
const CHAN = 'chan1';

function freshRootB64(): string {
  const r = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < r.length; i++) s += String.fromCharCode(r[i]);
  return btoa(s);
}

describe('nativeEditMessage fail-closed (round-6 #9)', () => {
  let broadcastToScope: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    identity = await generateIdentity();
    ME = identity.peerId;
  });

  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    registerHistoryIdentity(identity);
    registerScopeCrypto({ seal: new SealSessions(ME, identitySigningKey(identity)), channels: new ChannelCrypto(), fetchBundle: async () => null });
    addServer({ id: SRV, name: 'S', owner_peer_id: ME, members: [ME, ALICE], channel_security_mode: 'crowd', channel_crypto_profile: 'scope-aad-v2', channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } } });
    broadcastToScope = vi.fn().mockResolvedValue([]); // resolves to undelivered-peer list
    registerPeerSync({ broadcastToScope, sendToPeer: vi.fn().mockResolvedValue(true) } as unknown as PeerSync);
  });
  afterEach(() => {
    resetScopeCrypto();
    resetHistoryIdentity();
  });

  it('broadcasts an ENCRYPTED edit envelope (never plaintext) when a crowd root exists', () => {
    updateServer(SRV, { crowd_root: freshRootB64(), crowd_epoch: 0 });
    const msg = nativeSendChannelMessage(CHAN, 'original');
    broadcastToScope.mockClear();

    nativeEditMessage(msg.id, 'PLAINTEXT-EDIT-BODY');

    expect(broadcastToScope).toHaveBeenCalledTimes(1);
    const payload = broadcastToScope.mock.calls[0][3];
    expect(JSON.stringify(payload)).not.toContain('PLAINTEXT-EDIT-BODY');
    expect(payload.crowd).toBeTruthy(); // it's the encrypted envelope
  });

  it('does NOT broadcast an edit at all when the channel has no crowd root yet', () => {
    // Create the message while a root exists, then clear it so the edit cannot encrypt.
    updateServer(SRV, { crowd_root: freshRootB64(), crowd_epoch: 0 });
    const msg = nativeSendChannelMessage(CHAN, 'original');
    updateServer(SRV, { crowd_root: undefined });
    broadcastToScope.mockClear();

    nativeEditMessage(msg.id, 'UNENCRYPTABLE-EDIT');

    expect(broadcastToScope).not.toHaveBeenCalled();
  });
});
