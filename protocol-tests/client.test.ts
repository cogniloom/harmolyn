import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
  XoreinClient,
  XoreinControlTransport,
  type XoreinHandshakeRequest,
  type XoreinHandshakeResponse,
  type XoreinTransport,
} from "../src/protocol/client.js";

class MockTransport implements XoreinTransport {
  connectCalls = 0;
  disconnectCalls = 0;
  handshakeCalls = 0;
  requests: XoreinHandshakeRequest[] = [];
  responseFactory: (request: XoreinHandshakeRequest) => Promise<XoreinHandshakeResponse>;

  constructor(responseFactory: (request: XoreinHandshakeRequest) => Promise<XoreinHandshakeResponse>) {
    this.responseFactory = responseFactory;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }

  async performHandshake(request: XoreinHandshakeRequest): Promise<XoreinHandshakeResponse> {
    this.handshakeCalls += 1;
    this.requests.push({
      ...request,
      localCapabilities: [...request.localCapabilities],
      preferredSecurityModes: [...request.preferredSecurityModes],
      protocolOffers: [...request.protocolOffers],
    });
    return this.responseFactory(request);
  }
}

interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

function createFetchStub(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const key = `${method.toUpperCase()} ${url}`;
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: method.toUpperCase(),
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });

    const route = routes[key];
    if (!route) {
      throw new Error(`unexpected fetch: ${key}`);
    }

    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchStub, calls };
}

async function createSignedControlManifest(overrides: Partial<ControlManifestFixture> = {}): Promise<ControlManifestFixture> {
  const keyPair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const rawPublicKey = await webcrypto.subtle.exportKey("raw", keyPair.publicKey);
  const manifest: ControlManifestFixture = {
    server_id: "test-server",
    name: "Test Server",
    description: "preview",
    owner_peer_id: "remote-owner",
    owner_public_key: toBase64Url(new Uint8Array(rawPublicKey)),
    owner_addresses: ["/ip4/127.0.0.1/tcp/4001/p2p/peer-owner"],
    capabilities: ["cap.chat", "cap.voice", "cap.manifest"],
    issued_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    signature: "",
    ...overrides,
  };

  const payload = canonicalizeControlManifest(manifest);
  const signature = await webcrypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(payload));
  manifest.signature = toBase64Url(new Uint8Array(signature));
  return manifest;
}

function canonicalizeControlManifest(manifest: ControlManifestFixture): string {
  const payload: Record<string, unknown> = {
    server_id: manifest.server_id,
    name: manifest.name,
    owner_peer_id: manifest.owner_peer_id,
    owner_public_key: manifest.owner_public_key,
    owner_addresses: [...new Set(manifest.owner_addresses)].sort(),
    capabilities: [...new Set(manifest.capabilities)].sort(),
    issued_at: manifest.issued_at,
    updated_at: manifest.updated_at,
  };
  if (manifest.description) {
    payload.description = manifest.description;
  }
  if (manifest.bootstrap_addrs?.length) {
    payload.bootstrap_addrs = [...new Set(manifest.bootstrap_addrs)].sort();
  }
  if (manifest.relay_addrs?.length) {
    payload.relay_addrs = [...new Set(manifest.relay_addrs)].sort();
  }
  if (manifest.history_retention_messages) {
    payload.history_retention_messages = manifest.history_retention_messages;
  }
  if (manifest.history_coverage) {
    payload.history_coverage = manifest.history_coverage;
  }
  if (manifest.history_durability) {
    payload.history_durability = manifest.history_durability;
  }
  if (manifest.expires_at) {
    payload.expires_at = manifest.expires_at;
  }
  return JSON.stringify(payload);
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

interface ControlManifestFixture {
  server_id: string;
  name: string;
  description?: string;
  owner_peer_id: string;
  owner_public_key: string;
  owner_addresses: string[];
  bootstrap_addrs?: string[];
  relay_addrs?: string[];
  capabilities: string[];
  /** Advisory (not part of the signed canonical payload): the encrypted mode the server offers. */
  security_mode?: string;
  history_retention_messages?: number;
  history_coverage?: string;
  history_durability?: string;
  issued_at: string;
  updated_at: string;
  expires_at?: string;
  signature: string;
}

function controlServerRecord(manifest: ControlManifestFixture) {
  return {
    id: manifest.server_id,
    name: manifest.name,
    description: manifest.description,
    manifest,
  };
}

test("XoreinClient joins through the xorein control bridge and derives per-session feature gating", async () => {
  // The server advertises an encrypted mode; "clear" is never offered/accepted.
  const manifest = await createSignedControlManifest({ security_mode: "seal" });
  const { fetchStub, calls } = createFetchStub({
    "GET http://127.0.0.1:7711/v1/state": { body: { servers: [] } },
    "POST http://127.0.0.1:7711/v1/servers/join": { body: controlServerRecord(manifest) },
  });
  const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "bridge-token", fetch: fetchStub });

  const client = new XoreinClient({
    transport,
    features: {
      voiceJoinLeave: true,
      joinViaInvite: true,
      serverNavigation: true,
    },
    now: () => Date.parse("2026-01-01T00:01:00Z"),
  });

  const session = await client.connectByLink("aether://join/test-server?invite=signed-invite");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].headers.get("authorization"), "Bearer bridge-token");
  assert.equal(calls[1].body, JSON.stringify({ deeplink: "aether://join/test-server?invite=signed-invite" }));
  assert.equal(session.securityMode, "seal");
  assert.equal(session.acceptedProtocol?.family, "chat");
  assert.deepEqual(session.featureContract.blockedProtocolFeatures, []);
  assert.deepEqual(session.featureContract.localOnlyEnabledFeatures, ["serverNavigation"]);
  assert.equal(session.manifest.ownerPeerId, "remote-owner");

  session.manifest.description = "tampered locally";
  assert.equal(client.snapshot()?.manifest.description, "preview");
});

test("XoreinClient rejects invalid manifests returned by the xorein control bridge", async () => {
  const manifest = await createSignedControlManifest();
  manifest.description = "tampered after signing";
  const { fetchStub } = createFetchStub({
    "GET http://127.0.0.1:7711/v1/state": { body: { servers: [controlServerRecord(manifest)] } },
  });
  const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "bridge-token", fetch: fetchStub });

  const client = new XoreinClient({
    transport,
    features: { voiceJoinLeave: true },
    now: () => Date.parse("2026-01-01T00:01:00Z"),
  });

  await assert.rejects(
    () => client.connectToServer("test-server"),
    /manifest signature invalid/,
  );
  assert.equal(client.snapshot(), null);
});

test("XoreinClient rejects invalid manifest capabilities returned by the xorein control bridge", async () => {
  const manifest = await createSignedControlManifest({ capabilities: ["cap.voice", "CAP.INVALID"] });
  const { fetchStub } = createFetchStub({
    "GET http://127.0.0.1:7711/v1/state": { body: { servers: [controlServerRecord(manifest)] } },
  });
  const transport = new XoreinControlTransport({ endpoint: "http://127.0.0.1:7711", token: "bridge-token", fetch: fetchStub });

  const client = new XoreinClient({
    transport,
    features: { voiceJoinLeave: true },
    now: () => Date.parse("2026-01-01T00:01:00Z"),
  });

  await assert.rejects(
    () => client.connectToServer("test-server"),
    /invalid manifest capability: CAP.INVALID/,
  );
  assert.equal(client.snapshot(), null);
});

test("XoreinClient selfHeal coalesces concurrent reconnects and uses deterministic backoff", async () => {
  const manifest = await createSignedControlManifest({ capabilities: ["cap.voice"] });
  const transport = new MockTransport(async () => ({
    manifest: {
      serverId: manifest.server_id,
      identity: manifest.owner_peer_id,
      version: 1,
      name: manifest.name,
      description: manifest.description ?? "",
      ownerPeerId: manifest.owner_peer_id,
      ownerPublicKey: manifest.owner_public_key,
      ownerAddresses: manifest.owner_addresses,
      updatedAt: manifest.updated_at,
      issuedAt: manifest.issued_at,
      capabilities: [...manifest.capabilities],
      signature: manifest.signature,
    },
    advertisedCapabilities: ["cap.voice"],
    requiredCapabilities: [],
    offeredSecurityModes: ["seal"],
    acceptedProtocol: "/aether/voice/0.1",
  }));

  const sleeps: number[] = [];
  const client = new XoreinClient({
    transport,
    features: { voiceJoinLeave: true },
    now: () => Date.parse("2026-01-01T00:01:00Z"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  await client.connectToServer("test-server");
  await client.disconnect();

  const [first, second] = await Promise.all([client.selfHeal(), client.selfHeal()]);

  assert.equal(transport.connectCalls, 2);
  assert.equal(transport.handshakeCalls, 2);
  assert.deepEqual(sleeps, [250]);
  assert.equal(first.serverId, "test-server");
  assert.equal(second.serverId, "test-server");
  assert.equal(first.reconnectAttempts, 1);
  assert.equal(second.reconnectAttempts, 1);
});
