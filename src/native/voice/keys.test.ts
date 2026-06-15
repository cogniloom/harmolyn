// Unit tests for voice key derivation (src/native/voice/keys.ts).
//
// Checks:
//  1. Deterministic derivation — same crowd_root + peerId always yields the same bytes.
//  2. Two peers with the same crowd_root derive distinct keys (peerID info is in the IKM).
//  3. SFrame encrypt→decrypt round-trip: what one peer encrypts the other can decrypt.
//
// getState() is mocked so no real browser store is needed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveVoicePeerKey } from './keys';
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
