import test from "node:test";
import assert from "node:assert/strict";
import { buildFeatureProtocolContract, deriveLocalCapabilities, } from "../src/protocol/featureBridge.js";
test("deriveLocalCapabilities maps enabled frontend features onto protocol capabilities", () => {
    const features = {
        directMessages: true,
        voiceJoinLeave: true,
        serverNavigation: true,
        autoMod: true,
    };
    assert.deepEqual(deriveLocalCapabilities(features), ["cap.dm", "cap.moderation", "cap.voice"]);
});
test("buildFeatureProtocolContract isolates blocked protocol features from local-only UI features", () => {
    const features = {
        directMessages: true,
        voiceJoinLeave: true,
        serverNavigation: true,
        autoMod: true,
    };
    const contract = buildFeatureProtocolContract({
        accepted: ["cap.dm"],
        ignoredRemote: [],
        missingRequired: [],
        feedback: "none",
    }, features);
    assert.deepEqual(contract.blockedProtocolFeatures, ["autoMod", "voiceJoinLeave"]);
    assert.deepEqual(contract.localOnlyEnabledFeatures, ["serverNavigation"]);
    assert.deepEqual(contract.localSupported, ["cap.dm", "cap.moderation", "cap.voice"]);
});
