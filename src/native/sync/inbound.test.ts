// Fail-closed inbound policy (Tier-0 A1) + real per-message security mode (A2).
//
// These exercise the authenticated inbound chat path via `ingestMailboxChat`
// (which funnels into `handleChatSend`) with the native store + scope crypto
// seeded, proving that:
//   • an unencrypted / mode-mismatched message is DROPPED, never stored as
//     plaintext (no downgrade path), and
//   • a genuinely Crowd-encrypted message is stored carrying the real mode so the
//     UI badge reflects encryption that actually happened.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initStore, getState, setNativeIdentity, addServer, updateServer } from '../state/store.js';
import { ChannelCrypto } from '../crowd/channel.js';
import { SealSessions } from '../seal/session.js';
import { generateSigningIdentity } from '../crypto/hybrid.js';
import { registerScopeCrypto, resetScopeCrypto, encryptChannelEnvelope } from './secureEnvelope.js';
import { ingestMailboxChat } from './inbound.js';

const ME = 'me';
const ALICE = 'alice';
const SRV = 'srv1';
const CHAN = 'chan1';

function freshRootB64(): string {
  const r = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < r.length; i++) s += String.fromCharCode(r[i]);
  return btoa(s);
}

function seedServerWithRoot(): void {
  addServer({
    id: SRV,
    name: 'S',
    owner_peer_id: ME,
    members: [ME, ALICE],
    channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } },
  });
  updateServer(SRV, { crowd_root: freshRootB64() });
}

describe('inbound — fail-closed encryption policy (A1)', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    registerScopeCrypto({ seal: new SealSessions(ME, generateSigningIdentity()), channels: new ChannelCrypto(), fetchBundle: async () => null });
  });
  afterEach(() => resetScopeCrypto());

  it('drops a channel message with no `enc` (no plaintext downgrade)', () => {
    seedServerWithRoot();
    ingestMailboxChat(
      { message_id: 'm-plain', scope_id: CHAN, scope_type: 'channel', sender_id: ALICE, body: btoa('sneaky plaintext') },
      ALICE,
    );
    expect(getState().messages.some(m => m.id === 'm-plain')).toBe(false);
  });

  it('drops a DM message with a mismatched mode (crowd on a dm scope)', () => {
    // Even a validly-encrypted-looking envelope is rejected if its mode is not the
    // one the scope requires (DMs must be seal).
    ingestMailboxChat(
      { message_id: 'm-mism', scope_id: 'dm-x', scope_type: 'dm', sender_id: ALICE, enc: 'crowd', crowd: { epoch: 0, sndr: ALICE, nonce: '', ct: '' } },
      ALICE,
    );
    expect(getState().messages.some(m => m.id === 'm-mism')).toBe(false);
  });

  it('rejects a genuine Crowd envelope from a sender who is no longer a member (kick)', () => {
    // Seed the server WITHOUT Alice (she was kicked) but keep the crowd_root — the
    // legacy epoch still exists so her in-flight ciphertext would decrypt. A real
    // envelope she mints under that retained epoch must still be REJECTED because she
    // is no longer in server.members; otherwise a kicked peer keeps posting.
    addServer({
      id: SRV, name: 'S', owner_peer_id: ME, members: [ME],
      channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } },
    });
    updateServer(SRV, { crowd_root: freshRootB64() });
    const base = { message_id: 'm-kicked', scope_id: CHAN, scope_type: 'channel', server_id: SRV, sender_id: ALICE };
    const envelope = encryptChannelEnvelope(SRV, ALICE, base, 'post-kick message');
    expect(envelope).toBeTruthy();

    ingestMailboxChat(envelope!, ALICE);

    expect(getState().messages.some(m => m.id === 'm-kicked')).toBe(false);
  });

  it('accepts a genuine Crowd envelope and stamps the real security mode (A2)', () => {
    seedServerWithRoot();
    // Build a real crowd envelope as ALICE would (same shared root from the server
    // record), then deliver it authenticated as ALICE.
    const base = { message_id: 'm-enc', scope_id: CHAN, scope_type: 'channel', server_id: SRV, sender_id: ALICE };
    const envelope = encryptChannelEnvelope(SRV, ALICE, base, 'real ciphertext body');
    expect(envelope).toBeTruthy();

    ingestMailboxChat(envelope!, ALICE);

    const stored = getState().messages.find(m => m.id === 'm-enc');
    expect(stored).toBeTruthy();
    expect(stored!.body).toBe('real ciphertext body');
    expect(stored!.security_mode).toBe('crowd');
    expect(stored!.encrypted).toBe(true);
  });
});
