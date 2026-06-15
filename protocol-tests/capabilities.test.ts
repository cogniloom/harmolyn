import test from "node:test";
import assert from "node:assert/strict";

import {
  negotiateCapabilities,
  negotiateConversationSecurityMode,
  validFeatureFlagName,
} from "../src/protocol/capabilities.js";

test("validFeatureFlagName enforces the backend naming rules", () => {
  assert.equal(validFeatureFlagName("cap.chat"), true);
  assert.equal(validFeatureFlagName("cap.voice.low-latency"), true);
  assert.equal(validFeatureFlagName("cap.voice.v2"), true);
  assert.equal(validFeatureFlagName("chat"), false);
  assert.equal(validFeatureFlagName("cap.Chat"), false);
  assert.equal(validFeatureFlagName("cap.voice..opus"), false);
  assert.equal(validFeatureFlagName("cap.-voice"), false);
  assert.equal(validFeatureFlagName("cap.voice-"), false);
});

test("negotiateCapabilities accepts supported flags and reports missing required flags", () => {
  const result = negotiateCapabilities(
    ["cap.chat", "cap.voice", "cap.identity"],
    ["cap.chat", "cap.future", "bad"],
    ["cap.identity", "cap.sync", "cap.voice..opus"],
  );

  assert.deepEqual(result.accepted, ["cap.chat"]);
  assert.deepEqual(result.ignoredRemote, ["bad", "cap.future"]);
  assert.deepEqual(result.missingRequired, ["cap.sync", "cap.voice..opus"]);
  assert.equal(result.feedback, "upgrade-required");
});

test("negotiateConversationSecurityMode chooses the first shared preferred mode", () => {
  assert.deepEqual(
    negotiateConversationSecurityMode(["seal", "tree"], ["tree", "clear"]),
    { mode: "tree", reason: "matched" },
  );
  assert.deepEqual(
    negotiateConversationSecurityMode(["seal"], ["clear"]),
    { mode: "unspecified", reason: "unsupported-mode" },
  );
  assert.deepEqual(
    negotiateConversationSecurityMode(["seal"], []),
    { mode: "unspecified", reason: "no-offer" },
  );
});
