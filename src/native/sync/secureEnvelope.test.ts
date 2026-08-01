// Verifies that E2EE attachments ride INSIDE the encrypted payload: the
// attachment key is never present in the wire envelope, and the recipient
// recovers both the text body and the attachment refs.
import { describe, it, expect, afterEach } from 'vitest';
import { SealSessions } from '../seal/session.js';
import { ChannelCrypto } from '../crowd/channel.js';
import { generateSigningIdentity } from '../crypto/hybrid.js';
import {
  registerScopeCrypto, resetScopeCrypto,
  encryptDmEnvelope, decryptInboundEnvelope,
} from './secureEnvelope.js';
import type { XoreinAttachment } from '../../types.js';

describe('secureEnvelope — encrypted attachments', () => {
  afterEach(() => resetScopeCrypto());

  it('carries the attachment key end-to-end (never in cleartext) and recovers body+media', async () => {
    const alice = new SealSessions('alice', generateSigningIdentity());
    const bob = new SealSessions('bob', generateSigningIdentity());

    const media: XoreinAttachment[] = [{
      id: 'upload-123',
      name: 'secret-plans.png',
      content_type: 'image/png',
      size: 4096,
      key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      nonce: 'AAAAAAAAAAAAAAAA',
      content_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    }];

    // Alice's device encrypts a DM (with attachment) to bob.
    registerScopeCrypto({ seal: alice, channels: new ChannelCrypto(), fetchBundle: async () => bob.serveBundle() });
    const base = { message_id: 'm1', scope_id: 'dm-1', scope_type: 'dm', sender_id: 'alice' };
    const envelope = (await encryptDmEnvelope('bob', base, 'here are the plans', media))!;
    expect(envelope).toBeTruthy();

    // The attachment key/nonce MUST NOT appear anywhere in the wire envelope.
    const wire = JSON.stringify(envelope);
    expect(wire).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(wire).not.toContain('AAAAAAAAAAAAAAAA');
    expect(wire).not.toContain('here are the plans');

    // Bob's device decrypts it.
    registerScopeCrypto({ seal: bob, channels: new ChannelCrypto(), fetchBundle: async () => null });
    const decoded = decryptInboundEnvelope('seal', envelope, 'alice', 'dm-1', 'dm');
    expect(decoded).toBeTruthy();
    expect(decoded!.body).toBe('here are the plans');
    expect(decoded!.media).toEqual(media);
  });

  it('round-trips a text-only message with no media field', async () => {
    const a = new SealSessions('a', generateSigningIdentity());
    const b = new SealSessions('b', generateSigningIdentity());
    registerScopeCrypto({ seal: a, channels: new ChannelCrypto(), fetchBundle: async () => b.serveBundle() });
    const env = (await encryptDmEnvelope('b', { scope_id: 'd', scope_type: 'dm', sender_id: 'a' }, 'plain text'))!;
    registerScopeCrypto({ seal: b, channels: new ChannelCrypto(), fetchBundle: async () => null });
    const decoded = decryptInboundEnvelope('seal', env, 'a', 'd', 'dm');
    expect(decoded!.body).toBe('plain text');
    expect(decoded!.media).toBeUndefined();
  });
});
