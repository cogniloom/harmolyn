import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeManifest,
  signManifest,
  validateManifestFreshness,
  validateStoredSignature,
  type Manifest,
} from "../src/protocol/manifest.js";

const BASE_MANIFEST: Omit<Manifest, "identity" | "signature"> = {
  serverId: "signed-server",
  version: 1,
  description: "signed",
  updatedAt: "2026-01-01T00:00:00Z",
  capabilities: { chat: true, voice: false },
};

const EXPECTED_SIGNATURE = "702939e6a4ef681c50364a8df2811bfdd099e459c97632a5594a332c5196566e";

test("signManifest matches the backend deterministic sha256 signature", async () => {
  const signed = await signManifest(BASE_MANIFEST, "remote-signer");

  assert.equal(
    canonicalizeManifest(signed),
    '{"server_id":"signed-server","identity":"remote-signer","version":1,"description":"signed","updated_at":"2026-01-01T00:00:00Z","capabilities":{"chat":true,"voice":false}}',
  );
  assert.equal(signed.signature, EXPECTED_SIGNATURE);
  await assert.doesNotReject(() => validateStoredSignature(signed));
});

test("validateStoredSignature rejects tampered manifests", async () => {
  const signed = await signManifest(BASE_MANIFEST, "remote-signer");
  signed.description = "tampered";
  await assert.rejects(() => validateStoredSignature(signed), /manifest signature invalid/);
});

test("validateManifestFreshness rejects stale manifests when a max age is enforced", () => {
  validateManifestFreshness(
    { ...BASE_MANIFEST, identity: "remote-signer", signature: EXPECTED_SIGNATURE },
    new Date("2026-01-01T00:04:59Z"),
    5 * 60_000,
  );
  assert.throws(
    () =>
      validateManifestFreshness(
        { ...BASE_MANIFEST, identity: "remote-signer", signature: EXPECTED_SIGNATURE },
        new Date("2026-01-01T00:06:00Z"),
        5 * 60_000,
      ),
    /manifest is stale/,
  );
});
