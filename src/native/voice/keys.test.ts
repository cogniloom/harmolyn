// Unit tests for voice key derivation (src/native/voice/keys.ts).
//
// Checks:
//  1. Deterministic derivation — same crowd_root + peerId always yields the same bytes.
//  2. Two peers with the same crowd_root derive distinct keys (peerID info is in the IKM).
//  3. SFrame encrypt→decrypt round-trip: what one peer encrypts the other can decrypt.
//
// getState() is mocked so no real browser store is needed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveVoicePeerKey, voiceSecurityMode } from './keys';
import { encryptFrame, decryptFrame } from './mediashield';
import * as store from '../state/store';

// ── Test fixtures ─────────────────────────────────────────────────────────────

/** 32-byte test crowd_root, base64-encoded as stored on the server object. */
const TEST_ROOT_BYTES = new Uint8Array(32).fill(42);
const TEST_ROOT_B64 = btoa(String.fromCharCode(...TEST_ROOT_BYTES));

const CHANNEL_ID = 'test-voice-channel-0001';
const SERVER_ID  = 'test-server-001';
const PEER_A     = '12D3KooWBPeerAAAA';
const PEER_B     = '12D3KooWBPeerBBBB';

const fakeState = {
  servers: {
    [SERVER_ID]: {
      id: SERVER_ID,
      crowd_root: TEST_ROOT_B64,
      channels: {
        [CHANNEL_ID]: { id: CHANNEL_ID, type: 'voice', name: 'General' },
      },
      members: [PEER_A, PEER_B],
    },
  },
  dms: {},
  identity: { peer_id: PEER_A },
  messages: {},
  peers: {},
  relay_addrs: [],
  voice_sessions: [],
};

// ── Mock ─────────────────────────────────────────────────────────────────────

vi.mock('../state/store', () => ({
  getState: vi.fn(),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deriveVoicePeerKey', () => {
  beforeEach(() => {
    vi.mocked(store.getState).mockReturnValue(fakeState as unknown as ReturnType<typeof store.getState>);
  });

  it('returns a non-null key for a known server voice channel', () => {
    const k = deriveVoicePeerKey(CHANNEL_ID, PEER_A);
    expect(k).not.toBeNull();
    expect(k!.peerId).toBe(PEER_A);
    expect(k!.key).toBeInstanceOf(Uint8Array);
    expect(k!.key.length).toBe(32);
  });

  it('is deterministic — two derivations with the same inputs produce identical bytes', () => {
    const k1 = deriveVoicePeerKey(CHANNEL_ID, PEER_A);
    const k2 = deriveVoicePeerKey(CHANNEL_ID, PEER_A);
    expect(k1).not.toBeNull();
    expect(k2).not.toBeNull();
    expect(k1!.key).toEqual(k2!.key);
  });

  it('different peerIds yield different key bytes for the same crowd_root', () => {
    const kA = deriveVoicePeerKey(CHANNEL_ID, PEER_A);
    const kB = deriveVoicePeerKey(CHANNEL_ID, PEER_B);
    expect(kA).not.toBeNull();
    expect(kB).not.toBeNull();
    // Keys must differ so peers can't decrypt each other's streams.
    expect(kA!.key).not.toEqual(kB!.key);
  });

  it('SFrame encrypt→decrypt round-trip: derived key encrypts and decrypts correctly', () => {
    // Both sides derive the same key from the same crowd_root + peerId.
    const senderKey   = deriveVoicePeerKey(CHANNEL_ID, PEER_A)!;
    const receiverKey = deriveVoicePeerKey(CHANNEL_ID, PEER_A)!;

    const rtpHeader = new Uint8Array(12).fill(0xab);
    const plaintext = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);

    const [sframeHeader, ciphertext] = encryptFrame(senderKey, rtpHeader, plaintext);
    const recovered = decryptFrame(receiverKey, rtpHeader, sframeHeader, ciphertext);

    expect(recovered).toEqual(plaintext);
  });

  it('ciphertext differs from plaintext (encryption actually transforms bytes)', () => {
    const k = deriveVoicePeerKey(CHANNEL_ID, PEER_A)!;
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const [, ct] = encryptFrame(k, new Uint8Array(4), plaintext);
    // The ciphertext (+ GCM tag) must not be byte-identical to the plaintext.
    const ctPayload = ct.slice(0, plaintext.length);
    expect(ctPayload).not.toEqual(plaintext);
  });
});

// ── Fail-closed behaviour (Tier-0 A4) ──────────────────────────────────────────
// Without a real shared secret there is NO SFrame key and NO 'crowd' mode — the
// old code returned a publicly-derivable placeholder and reported 'crowd' anyway.

describe('deriveVoicePeerKey / voiceSecurityMode — fail closed', () => {
  const CHANNEL_NO_ROOT = 'voice-channel-no-root';
  const SERVER_NO_ROOT = 'server-no-root';
  const DM_CHANNEL = 'dm-voice-channel';

  const stateWithoutRoot = {
    servers: {
      [SERVER_NO_ROOT]: {
        id: SERVER_NO_ROOT,
        // no crowd_root seeded
        channels: { [CHANNEL_NO_ROOT]: { id: CHANNEL_NO_ROOT, type: 'voice', name: 'General' } },
        members: [PEER_A, PEER_B],
      },
    },
    dms: { [DM_CHANNEL]: { id: DM_CHANNEL, participants: [PEER_A, PEER_B] } },
    identity: { peer_id: PEER_A },
    messages: {},
    peers: {},
    relay_addrs: [],
    voice_sessions: [],
  };

  beforeEach(() => {
    vi.mocked(store.getState).mockReturnValue(stateWithoutRoot as unknown as ReturnType<typeof store.getState>);
  });

  it('returns null (no placeholder key) for a server channel without a crowd_root', () => {
    expect(deriveVoicePeerKey(CHANNEL_NO_ROOT, PEER_A)).toBeNull();
  });

  it('returns null for a DM voice channel (no shared voice-key export yet)', () => {
    expect(deriveVoicePeerKey(DM_CHANNEL, PEER_A)).toBeNull();
  });

  it("voiceSecurityMode is 'clear' when no real key can be derived", () => {
    expect(voiceSecurityMode(CHANNEL_NO_ROOT)).toBe('clear');
    expect(voiceSecurityMode(DM_CHANNEL)).toBe('clear');
  });

  it("voiceSecurityMode is 'crowd' only when a real crowd_root exists", () => {
    vi.mocked(store.getState).mockReturnValue({
      servers: { s: { id: 's', crowd_root: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))), channels: { c: { id: 'c' } }, members: [] } },
      dms: {}, identity: { peer_id: PEER_A }, messages: {}, peers: {}, relay_addrs: [], voice_sessions: [],
    } as unknown as ReturnType<typeof store.getState>);
    expect(voiceSecurityMode('c')).toBe('crowd');
  });
});
