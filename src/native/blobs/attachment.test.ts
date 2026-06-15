// Verifies the encrypted-attachment round-trip (priv-4): a file is uploaded to
// the node as OPAQUE ciphertext and recovered only by a holder of the key, which
// travels inside the E2EE message — the node never sees plaintext.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { uploadEncryptedAttachment, downloadDecryptedAttachment } from './blobs.js';

function mockNodeUploads() {
  const store = new Map<string, string>();
  let n = 0;
  const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.endsWith('/uploads') && init?.method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}');
      const id = `u${++n}`;
      store.set(id, body.data);
      // The node stores opaque ciphertext + a forced opaque content_type.
      expect(body.content_type).toBe('application/octet-stream');
      return { ok: true, status: 200, json: async () => ({ id }) };
    }
    const m = u.match(/\/uploads\/([^/]+)$/);
    if (m) {
      const data = store.get(decodeURIComponent(m[1]));
      return { ok: !!data, status: data ? 200 : 404, json: async () => ({ data }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;
  return { store };
}

describe('encrypted attachments (priv-4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uploads opaque ciphertext and round-trips the file via the key in the message', async () => {
    const { store } = mockNodeUploads();
    const plaintext = new TextEncoder().encode('secret file contents 🔐 attack at dawn');

    const att = await uploadEncryptedAttachment(plaintext, 'plans.txt', 'text/plain');
    expect(att.id).toBeTruthy();
    expect(att.key.length).toBeGreaterThan(0);
    expect(att.nonce.length).toBeGreaterThan(0);
    expect(att.content_type).toBe('text/plain'); // preserved in the ref (E2EE), not at the node

    // What the node holds must be ciphertext — the plaintext must not be recoverable
    // from the stored blob without the key.
    const stored = [...store.values()][0];
    const storedBytes = atob(stored.startsWith('data:') ? stored.split(',')[1] : stored);
    expect(storedBytes).not.toContain('attack at dawn');

    // A holder of the attachment ref (key in the E2EE message) recovers the file.
    const got = await downloadDecryptedAttachment(att);
    expect(new TextDecoder().decode(got)).toBe('secret file contents 🔐 attack at dawn');
  });

  it('fails the integrity check if the ciphertext is tampered', async () => {
    const { store } = mockNodeUploads();
    const att = await uploadEncryptedAttachment(new TextEncoder().encode('hello'), 'f', 'text/plain');
    // Corrupt the stored blob.
    const id = [...store.keys()][0];
    store.set(id, 'data:application/octet-stream;base64,' + btoa('totally different bytes here!!'));
    await expect(downloadDecryptedAttachment(att)).rejects.toThrow();
  });
});
