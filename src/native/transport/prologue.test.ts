import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { AETHER_NOISE_PROLOGUE } from './prologue';

const NOISE_DOMAIN = '/aether/noise/1.0|ns=/aether|noise=XX_25519_ChaChaPoly_SHA256|v=1';

// Go-oracle golden vector — computed by running pkg/v0_1/transport.AetherNoisePrologue()
// against the live Go oracle at /home/hal9000/docker/xorein.
// Source: transport.AetherNoisePrologue() = sha256(noiseTranscriptDomain) from noise_prologue.go
const GO_ORACLE_PROLOGUE_HEX =
  '4203538c642bef4b487006819258300f5f0d8b82c05962f1b397917e98d37192';

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/../g)!.map(b => parseInt(b, 16)));
}

describe('AETHER_NOISE_PROLOGUE', () => {
  it('is 32 bytes', () => {
    expect(AETHER_NOISE_PROLOGUE.length).toBe(32);
  });

  it('matches Go oracle golden vector (transport.AetherNoisePrologue())', () => {
    expect([...AETHER_NOISE_PROLOGUE]).toEqual([...hexToBytes(GO_ORACLE_PROLOGUE_HEX)]);
  });

  it('equals SHA256 of the xorein noise transcript domain', () => {
    const expected = sha256(new TextEncoder().encode(NOISE_DOMAIN));
    expect([...AETHER_NOISE_PROLOGUE]).toEqual([...expected]);
  });
});
