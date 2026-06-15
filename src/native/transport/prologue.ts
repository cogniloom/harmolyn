// xorein noise prologue — must match the Go node's aetherNoisePrologue exactly.
// Go source: pkg/v0_1/transport/noise_prologue.go
// Formula: SHA256("/aether/noise/1.0|ns=/aether|noise=XX_25519_ChaChaPoly_SHA256|v=1")
import { sha256 } from '@noble/hashes/sha2.js';

const NOISE_TRANSCRIPT_DOMAIN =
  '/aether/noise/1.0|ns=/aether|noise=XX_25519_ChaChaPoly_SHA256|v=1';

export const AETHER_NOISE_PROLOGUE: Uint8Array = sha256(
  new TextEncoder().encode(NOISE_TRANSCRIPT_DOMAIN),
);
