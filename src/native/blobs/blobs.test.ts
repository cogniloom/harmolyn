import { describe, it, expect } from 'vitest';
import {
  encryptBlob, decryptBlob, contentHash, verifyBlobIntegrity,
  type BlobRef,
} from './blobs';

describe('blob encryption', () => {
  it('encryptBlob / decryptBlob round-trip', () => {
    const data = new TextEncoder().encode('hello blob world');
    const { ciphertext, key, nonce } = encryptBlob(data);
    expect(ciphertext.length).toBeGreaterThan(data.length); // ciphertext + 16-byte GCM tag
    const recovered = decryptBlob(ciphertext, key, nonce);
    expect(new TextDecoder().decode(recovered)).toBe('hello blob world');
  });

  it('each encrypt call uses a fresh random key and nonce', () => {
    const data = new Uint8Array([1, 2, 3]);
    const a = encryptBlob(data);
    const b = encryptBlob(data);
    expect([...a.key]).not.toEqual([...b.key]);
    expect([...a.nonce]).not.toEqual([...b.nonce]);
    // But same plaintext → different ciphertexts
    expect([...a.ciphertext]).not.toEqual([...b.ciphertext]);
  });

  it('wrong key fails to decrypt', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const { ciphertext, nonce } = encryptBlob(data);
    const wrongKey = new Uint8Array(32).fill(0xff);
    expect(() => decryptBlob(ciphertext, wrongKey, nonce)).toThrow();
  });
});

describe('content hash', () => {
  it('is a 64-char hex string', () => {
    const h = contentHash(new TextEncoder().encode('test'));
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic', () => {
    const data = new TextEncoder().encode('same data');
    expect(contentHash(data)).toBe(contentHash(data));
  });

  it('differs for different data', () => {
    expect(contentHash(new Uint8Array([1]))).not.toBe(contentHash(new Uint8Array([2])));
  });
});

describe('verifyBlobIntegrity', () => {
  it('passes for matching data', () => {
    const data = new TextEncoder().encode('integrity check');
    const { key, nonce } = encryptBlob(data);
    const ref: BlobRef = { id: 'x', contentHash: contentHash(data), key, nonce, filename: 'f', contentType: 'text/plain', size: data.length };
    expect(verifyBlobIntegrity(data, ref)).toBe(true);
  });

  it('fails for tampered data', () => {
    const data = new TextEncoder().encode('original');
    const { key, nonce } = encryptBlob(data);
    const ref: BlobRef = { id: 'x', contentHash: contentHash(data), key, nonce, filename: 'f', contentType: 'text/plain', size: data.length };
    const tampered = new TextEncoder().encode('tampered');
    expect(verifyBlobIntegrity(tampered, ref)).toBe(false);
  });
});
