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
import { initStore, getState, setNativeIdentity, addServer, updateServer, addFriendRequest, ensureDm } from '../state/store.js';
import { ChannelCrypto } from '../crowd/channel.js';
import { SealSessions } from '../seal/session.js';
import { generateSigningIdentity } from '../crypto/hybrid.js';
import { generateIdentity, type XoreinIdentity } from '../identity/identity.js';
import { registerScopeCrypto, resetScopeCrypto, encryptChannelEnvelope, encryptDmEnvelope, applyCrowdRoot } from './secureEnvelope.js';
import { signChannelMessageVersion } from './signedHistory.js';
import { signServerRecord } from './signedServer.js';
import { ingestMailboxChat, classifyChannelNotification, handleSyncRequest, reconcileFriendAcceptFromPresence } from './inbound.js';
import type { ChannelSecurityMode } from '../security/channelMode.js';
import type { XoreinRuntimeMessage } from '../../types.js';

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

function seedServerWithRoot(member = ALICE): void {
  addServer({
    id: SRV,
    name: 'S',
    owner_peer_id: ME,
    members: [ME, member],
    channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } },
  });
  updateServer(SRV, { crowd_root: freshRootB64() });
}

function signedChannelBase(
  identity: XoreinIdentity,
  messageId: string,
  body: string,
  mode: ChannelSecurityMode = 'crowd',
): Record<string, unknown> {
  const createdAt = '2026-08-01T08:00:00.000Z';
  const message: XoreinRuntimeMessage = {
    id: messageId,
    scope_type: 'channel',
    scope_id: CHAN,
    server_id: SRV,
    sender_peer_id: identity.peerId,
    body,
    created_at: createdAt,
    security_mode: mode,
    encrypted: true,
    author_revision: 0,
  };
  const authorProof = signChannelMessageVersion(message, identity);
  if (!authorProof) throw new Error('test fixture failed to sign channel message');
  return {
    message_id: messageId,
    scope_id: CHAN,
    scope_type: 'channel',
    server_id: SRV,
    sender_id: identity.peerId,
    created_at: createdAt,
    author_revision: 0,
    author_proof: authorProof,
  };
}

describe('classifyChannelNotification', () => {
  const server = {
    roles: [{ id: 'r-mod', name: 'Moderator' }, { id: 'r-vip', name: 'VIP' }],
    member_roles: { [ME]: ['r-mod'] },
  };

  it('flags @everyone / @here as a broadcast ping', () => {
    expect(classifyChannelNotification(server, ME, 'Me', 'hey @everyone')).toBe('everyone');
    expect(classifyChannelNotification(server, ME, 'Me', 'psa @here please')).toBe('everyone');
  });

  it('flags a direct mention of my display name or peer id', () => {
    expect(classifyChannelNotification(server, ME, 'Neo', 'ping @Neo look')).toBe('mention');
    expect(classifyChannelNotification(server, ME, undefined, `yo @${ME}`)).toBe('mention');
  });

  it('requires a complete-token boundary so @Anna does not ping @Ann', () => {
    // A prefix collision must NOT count as a mention (would notify under "Mentions only").
    expect(classifyChannelNotification(server, ME, 'Ann', 'hey @Anna how are you')).toBe('channel');
    // The exact name (followed by punctuation or end) still counts.
    expect(classifyChannelNotification(server, ME, 'Ann', 'hey @Ann, ping')).toBe('mention');
    expect(classifyChannelNotification(server, ME, 'Ann', 'hey @Ann')).toBe('mention');
  });

  it('prioritizes a DIRECT mention over an @everyone broadcast so it survives Mentions-Only', () => {
    // A message that both @everyone's AND names me directly must classify as 'mention'
    // (a direct ping is meant to reach me even when I've muted broadcasts).
    expect(classifyChannelNotification(server, ME, 'Neo', 'hey @everyone — @Neo look at this')).toBe('mention');
    expect(classifyChannelNotification(server, ME, undefined, `@here and @${ME} specifically`)).toBe('mention');
  });

  it('flags a role ping only for a role I actually hold', () => {
    expect(classifyChannelNotification(server, ME, 'Me', 'attention @Moderator')).toBe('role');
    // I do not hold VIP, so an @VIP ping is ordinary channel traffic for me.
    expect(classifyChannelNotification(server, ME, 'Me', 'hello @VIP')).toBe('channel');
  });

  it('treats ordinary channel text as the plain channel kind', () => {
    expect(classifyChannelNotification(server, ME, 'Me', 'just chatting')).toBe('channel');
  });
});

describe('future-epoch channel ciphertext is buffered then replayed on root install', () => {
  const R0 = freshRootB64();
  const R1 = freshRootB64();

  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
  });
  afterEach(() => resetScopeCrypto());

  it('holds a message under a not-yet-installed epoch and delivers it once the root arrives', async () => {
    const owner = await generateIdentity();
    const alice = await generateIdentity();
    addServer({ id: SRV, name: 'S', owner_peer_id: owner.peerId, members: [owner.peerId, ME, alice.peerId], channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } } });

    // 1) Build a genuine epoch-1 envelope with a sender crypto seeded at the NEW root.
    registerScopeCrypto({ seal: new SealSessions(ME, generateSigningIdentity()), channels: new ChannelCrypto(), fetchBundle: async () => null });
    updateServer(SRV, { crowd_root: R1, crowd_epoch: 1 });
    applyCrowdRoot(SRV);
    const base = signedChannelBase(alice, 'm-future', 'from the future');
    const envelope = encryptChannelEnvelope(SRV, alice.peerId, base, 'from the future')!;
    expect(envelope).toBeTruthy();

    // 2) A RECEIVER that is still behind at epoch 0 (fresh crypto, old root) gets it first.
    registerScopeCrypto({ seal: new SealSessions(ME, generateSigningIdentity()), channels: new ChannelCrypto(), fetchBundle: async () => null });
    updateServer(SRV, { crowd_root: R0, crowd_epoch: 0 });
    applyCrowdRoot(SRV);
    ingestMailboxChat(envelope, alice.peerId);
    // Can't decrypt yet → buffered, NOT stored (and not dropped).
    expect(getState().messages.some(m => m.id === 'm-future')).toBe(false);

    // 3) The owner distributes the epoch-1 root; installing it replays the buffer.
    const nextServer = {
      ...getState().servers[SRV],
      crowd_root: R1,
      crowd_epoch: 1,
      server_rev: 1,
    };
    nextServer.owner_proof = signServerRecord(nextServer, owner);
    handleSyncRequest('sync.update', {
      server_id: SRV,
      server: nextServer,
    }, owner.peerId);

    const stored = getState().messages.find(m => m.id === 'm-future');
    expect(stored).toBeTruthy();
    expect(stored!.body).toBe('from the future');
    expect(stored!.security_mode).toBe('crowd');
  });

  it('does NOT buffer a future-epoch message from a NON-member (anti-flood authorization)', async () => {
    const owner = await generateIdentity();
    // Server has OWNER + ME only — ALICE is NOT a member (kicked / never joined). Her
    // undecryptable "future epoch" envelope must be dropped, not buffered: otherwise any
    // authenticated non-member who knows the channel id could flood the bounded buffer.
    addServer({ id: SRV, name: 'S', owner_peer_id: owner.peerId, members: [owner.peerId, ME], channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } } });

    registerScopeCrypto({ seal: new SealSessions(ME, generateSigningIdentity()), channels: new ChannelCrypto(), fetchBundle: async () => null });
    updateServer(SRV, { crowd_root: R1, crowd_epoch: 1 });
    applyCrowdRoot(SRV);
    const base = { message_id: 'm-flood', scope_id: CHAN, scope_type: 'channel', server_id: SRV, sender_id: ALICE };
    const envelope = encryptChannelEnvelope(SRV, ALICE, base, 'junk')!;

    // Receiver behind at epoch 0; ALICE is not a member → not buffered.
    registerScopeCrypto({ seal: new SealSessions(ME, generateSigningIdentity()), channels: new ChannelCrypto(), fetchBundle: async () => null });
    updateServer(SRV, { crowd_root: R0, crowd_epoch: 0 });
    applyCrowdRoot(SRV);
    ingestMailboxChat(envelope, ALICE);

    // Even after the epoch-1 root arrives, nothing replays (it was never buffered).
    const nextServer = {
      ...getState().servers[SRV],
      crowd_root: R1,
      crowd_epoch: 1,
      server_rev: 1,
    };
    nextServer.owner_proof = signServerRecord(nextServer, owner);
    handleSyncRequest('sync.update', {
      server_id: SRV,
      server: nextServer,
    }, owner.peerId);
    expect(getState().messages.some(m => m.id === 'm-flood')).toBe(false);
  });
});

describe('sync.update server_rev monotonic gate', () => {
  const OWNER = 'owner';
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    addServer({ id: SRV, name: 'S', owner_peer_id: OWNER, members: [OWNER, ME], channels: {}, server_rev: 4 });
  });

  const update = (rev: number, roles: { id: string; name: string }[], memberRoles: Record<string, string[]>) =>
    handleSyncRequest('sync.update', {
      server_id: SRV,
      server: { id: SRV, owner_peer_id: OWNER, members: [OWNER, ME], roles, member_roles: memberRoles, server_rev: rev },
    }, OWNER);

  it('rejects a stale whole snapshot so a revoked role is not restored', () => {
    // Newer update grants ME no roles (owner revoked the mod role at rev 6).
    update(6, [{ id: 'r-mod', name: 'Moderator' }], {});
    expect(getState().servers[SRV].member_roles?.[ME] ?? []).toEqual([]);
    expect(getState().servers[SRV].server_rev).toBe(6);

    // A DELAYED older snapshot (rev 5) that still grants the mod role must be ignored.
    update(5, [{ id: 'r-mod', name: 'Moderator' }], { [ME]: ['r-mod'] });
    expect(getState().servers[SRV].member_roles?.[ME] ?? []).toEqual([]); // not restored
    expect(getState().servers[SRV].server_rev).toBe(6);                    // rev unchanged
  });

  it('applies a strictly-newer snapshot', () => {
    update(7, [{ id: 'r-mod', name: 'Moderator' }], { [ME]: ['r-mod'] });
    expect(getState().servers[SRV].member_roles?.[ME]).toEqual(['r-mod']);
    expect(getState().servers[SRV].server_rev).toBe(7);
  });
});

describe('sync.update channel epoch immutability', () => {
  const ORIGINAL = freshRootB64();
  const REPLACEMENT = freshRootB64();
  let owner: XoreinIdentity;

  beforeEach(async () => {
    owner = await generateIdentity();
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    addServer({
      id: SRV,
      name: 'S',
      owner_peer_id: owner.peerId,
      members: [owner.peerId, ME],
      channels: {},
      crowd_root: ORIGINAL,
      crowd_epoch: 3,
      channel_security_mode: 'crowd',
      channel_crypto_profile: 'scope-aad-v2',
      server_rev: 1,
    });
  });

  it('rejects a different root reusing an installed epoch number', () => {
    const replacement = {
      ...getState().servers[SRV],
      crowd_root: REPLACEMENT,
      crowd_epoch: 3,
      server_rev: 2,
    };
    replacement.owner_proof = signServerRecord(replacement, owner);
    const result = handleSyncRequest('sync.update', {
      server_id: SRV,
      server: replacement,
    }, owner.peerId);
    expect(result).toEqual({ ok: false, error: 'channel_epoch_reused' });
    expect(getState().servers[SRV]?.crowd_root).toBe(ORIGINAL);
  });

  it('rejects a proof-less advancing channel epoch', () => {
    const result = handleSyncRequest('sync.update', {
      server_id: SRV,
      server: {
        ...getState().servers[SRV],
        crowd_root: REPLACEMENT,
        crowd_epoch: 4,
        server_rev: 2,
        owner_proof: undefined,
      },
    }, owner.peerId);
    expect(result).toEqual({ ok: false, error: 'missing_owner_proof' });
    expect(getState().servers[SRV]?.crowd_root).toBe(ORIGINAL);
  });
});

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

  it('accepts a signed Crowd envelope and stamps the real security mode (A2)', async () => {
    const alice = await generateIdentity();
    seedServerWithRoot(alice.peerId);
    // Build a real crowd envelope as ALICE would (same shared root from the server
    // record), then deliver it authenticated as ALICE.
    const base = signedChannelBase(alice, 'm-enc', 'real ciphertext body');
    const envelope = encryptChannelEnvelope(SRV, alice.peerId, base, 'real ciphertext body');
    expect(envelope).toBeTruthy();

    ingestMailboxChat(envelope!, alice.peerId);

    const stored = getState().messages.find(m => m.id === 'm-enc');
    expect(stored).toBeTruthy();
    expect(stored!.body).toBe('real ciphertext body');
    expect(stored!.security_mode).toBe('crowd');
    expect(stored!.encrypted).toBe(true);
  });

  it('rejects a valid shared-key envelope without a hybrid author proof', () => {
    seedServerWithRoot();
    const base = { message_id: 'm-unsigned', scope_id: CHAN, scope_type: 'channel', server_id: SRV, sender_id: ALICE };
    const envelope = encryptChannelEnvelope(SRV, ALICE, base, 'symmetric key alone is not identity');
    expect(envelope).toBeTruthy();

    ingestMailboxChat(envelope!, ALICE);

    expect(getState().messages.some(message => message.id === 'm-unsigned')).toBe(false);
  });
});

describe('inbound — automatic Tree/Crowd transition window', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    registerScopeCrypto({
      seal: new SealSessions(ME, generateSigningIdentity()),
      channels: new ChannelCrypto(),
      fetchBundle: async () => null,
    });
  });
  afterEach(() => resetScopeCrypto());

  it('accepts only the immediately previous mode epoch for in-flight traffic', async () => {
    const alice = await generateIdentity();
    addServer({
      id: SRV,
      name: 'S',
      owner_peer_id: ME,
      members: [ME, alice.peerId],
      channel_security_mode: 'tree',
      crowd_root: freshRootB64(),
      crowd_epoch: 0,
      channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } },
    });
    applyCrowdRoot(SRV);
    const inFlight = encryptChannelEnvelope(
      SRV,
      alice.peerId,
      signedChannelBase(alice, 'm-transition-ok', 'in flight', 'tree'),
      'in flight',
    )!;
    const expired = encryptChannelEnvelope(
      SRV,
      alice.peerId,
      signedChannelBase(alice, 'm-transition-old', 'too old', 'tree'),
      'too old',
    )!;
    expect(inFlight.enc).toBe('tree');

    updateServer(SRV, {
      channel_security_mode: 'crowd',
      crowd_root: freshRootB64(),
      crowd_epoch: 1,
    });
    applyCrowdRoot(SRV);
    ingestMailboxChat(inFlight, alice.peerId);
    expect(getState().messages.find(m => m.id === 'm-transition-ok')?.security_mode).toBe('tree');

    updateServer(SRV, { crowd_root: freshRootB64(), crowd_epoch: 2 });
    applyCrowdRoot(SRV);
    ingestMailboxChat(expired, alice.peerId);
    expect(getState().messages.some(m => m.id === 'm-transition-old')).toBe(false);
  });
});

describe('inbound DM — scope cross-labeling (both participants must belong to the thread)', () => {
  const BOB = 'bob';
  const MALLORY = 'mallory';
  const DM_ID = 'dm-me-bob'; // deterministically derived from (ME, BOB) in real code

  let meSeal: SealSessions;

  beforeEach(async () => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    meSeal = new SealSessions(ME, generateSigningIdentity());
    // An existing 1:1 conversation between ME and BOB — the target Mallory will
    // try to inject a message into by reusing its scope id.
    ensureDm(DM_ID, [ME, BOB]);
  });
  afterEach(() => resetScopeCrypto());

  it('drops a message from a non-participant who labels it with someone else\'s DM scope id', async () => {
    // Mallory is a real, unrelated contact of ME's (a normal Seal session — DMing
    // ME is not gated on anything) but has never spoken with Bob and is not part
    // of DM_ID. The DM scope id is derived deterministically from the two peer
    // ids, so Mallory CAN compute DM_ID even though she isn't a participant.
    const mallorySeal = new SealSessions(MALLORY, generateSigningIdentity());
    registerScopeCrypto({ seal: mallorySeal, channels: new ChannelCrypto(), fetchBundle: async () => meSeal.serveBundle() });
    const envelope = await encryptDmEnvelope(
      ME,
      { message_id: 'm-spoof', scope_id: DM_ID, scope_type: 'dm', sender_id: MALLORY },
      'mallory injecting into me+bob\'s conversation',
    );
    expect(envelope).toBeTruthy();

    // ME's device receives it, authenticated (Noise-bound) as Mallory.
    registerScopeCrypto({ seal: meSeal, channels: new ChannelCrypto(), fetchBundle: async () => null });
    ingestMailboxChat(envelope!, MALLORY);

    expect(getState().messages.some(m => m.id === 'm-spoof')).toBe(false);
    // The existing me+bob thread's participant list must be untouched.
    expect(getState().dms[DM_ID]?.participants).toEqual([ME, BOB]);
  });

  it('accepts a genuine message from an actual participant of the DM', async () => {
    const bobSeal = new SealSessions(BOB, generateSigningIdentity());
    registerScopeCrypto({ seal: bobSeal, channels: new ChannelCrypto(), fetchBundle: async () => meSeal.serveBundle() });
    const envelope = await encryptDmEnvelope(
      ME,
      { message_id: 'm-legit', scope_id: DM_ID, scope_type: 'dm', sender_id: BOB },
      'hey it\'s really bob',
    );
    expect(envelope).toBeTruthy();

    registerScopeCrypto({ seal: meSeal, channels: new ChannelCrypto(), fetchBundle: async () => null });
    ingestMailboxChat(envelope!, BOB);

    const stored = getState().messages.find(m => m.id === 'm-legit');
    expect(stored).toBeTruthy();
    expect(stored!.body).toBe('hey it\'s really bob');
  });
});

describe('reconcileFriendAcceptFromPresence (lost friends.accept recovery)', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
  });

  const outgoingRequest = () => addFriendRequest({
    id: 'out-1',
    from_peer_id: ME,
    to_peer_id: ALICE,
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  it('flips an outgoing pending request to accepted when presence arrives from a non-co-member', () => {
    // A peer only broadcasts presence to co-members and ACCEPTED friends. We share no
    // server with ALICE, so her presence proves she accepted our request even if the
    // friends.accept itself was lost.
    outgoingRequest();

    expect(reconcileFriendAcceptFromPresence(ALICE)).toBe(true);

    expect(getState().friend_requests.length).toBe(0);
    const friend = getState().friends.find(f => f.id === 'out-1');
    expect(friend?.status).toBe('accepted');
  });

  it('does NOT flip when we share a server with the peer (presence proves nothing)', () => {
    outgoingRequest();
    addServer({ id: SRV, name: 'S', owner_peer_id: ALICE, members: [ALICE, ME], channels: {} });

    expect(reconcileFriendAcceptFromPresence(ALICE)).toBe(false);

    expect(getState().friend_requests.find(r => r.id === 'out-1')?.status).toBe('pending');
    expect(getState().friends.length).toBe(0);
  });

  it('does NOT auto-accept an INCOMING request (only the user may accept)', () => {
    addFriendRequest({
      id: 'in-1',
      from_peer_id: ALICE,
      to_peer_id: ME,
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    expect(reconcileFriendAcceptFromPresence(ALICE)).toBe(false);

    expect(getState().friend_requests.find(r => r.id === 'in-1')?.status).toBe('pending');
    expect(getState().friends.length).toBe(0);
  });

  it('is a no-op for peers with no pending request (and for self)', () => {
    expect(reconcileFriendAcceptFromPresence(ALICE)).toBe(false);
    expect(reconcileFriendAcceptFromPresence(ME)).toBe(false);
    expect(getState().friends.length).toBe(0);
  });
});
