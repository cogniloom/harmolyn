import test from "node:test";
import assert from "node:assert/strict";
import { parseProtocolId, stringifyProtocolId } from "../src/protocol/protocolId.js";
test("protocol identifiers round-trip in the frontend parser", () => {
    const parsed = parseProtocolId("/aether/chat/0.1");
    assert.deepEqual(parsed, {
        family: "chat",
        version: { major: 0, minor: 1 },
        name: "chat/0.1",
    });
    assert.equal(stringifyProtocolId(parsed), "/aether/chat/0.1");
});
test("protocol parser rejects malformed versions and empty families", () => {
    assert.throws(() => parseProtocolId("/bad/chat/0.1"), /invalid protocol namespace/);
    assert.throws(() => parseProtocolId("/aether//0.1"), /protocol family required/);
    assert.throws(() => parseProtocolId("/aether/chat/zero"), /unexpected version syntax|invalid minor version|invalid major version/);
    assert.throws(() => parseProtocolId("/aether/chat/-1.0"), /invalid major version/);
    assert.throws(() => parseProtocolId("/aether/chat/+1.0"), /invalid major version/);
});
