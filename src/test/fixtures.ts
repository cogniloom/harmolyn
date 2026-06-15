import type {
  XoreinRuntimePeer,
  XoreinRuntimeServer,
  XoreinRuntimeSnapshot,
  XoreinSessionSnapshot,
} from "@/types";

export const CONTROL_ENDPOINT = "http://127.0.0.1:7711";
export const LOCAL_TIMESTAMP = "2026-04-22T00:00:00Z";

function peer(
  peerId: string,
  role: string,
  publicKey: string,
  source: string,
  addresses: string[],
): XoreinRuntimePeer {
  return {
    peer_id: peerId,
    role,
    addresses,
    public_key: publicKey,
    source,
    last_seen_at: LOCAL_TIMESTAMP,
  };
}

export function createRuntimeServer(opts: {
  id: string;
  name: string;
  description?: string;
  ownerPeerId: string;
  invite?: string;
  memberPeerIds: string[];
}): XoreinRuntimeServer {
  const { id, name, description, ownerPeerId, invite, memberPeerIds } = opts;
  return {
    id,
    name,
    description,
    owner_peer_id: ownerPeerId,
    created_at: LOCAL_TIMESTAMP,
    updated_at: LOCAL_TIMESTAMP,
    members: Array.from(new Set([...memberPeerIds, ownerPeerId])),
    channels: {
      [`${id}-general`]: {
        id: `${id}-general`,
        server_id: id,
        name: "general",
        voice: false,
        created_at: LOCAL_TIMESTAMP,
      },
      [`${id}-voice`]: {
        id: `${id}-voice`,
        server_id: id,
        name: "Voice Lounge",
        voice: true,
        created_at: LOCAL_TIMESTAMP,
      },
    },
    manifest: {
      name,
      description,
      owner_addresses: ["127.0.0.1:4101"],
      capabilities: ["cap.chat", "cap.manifest", "cap.identity", "cap.dm", "cap.voice", "cap.presence"],
      history_coverage: "local-window",
      history_retention_messages: 50,
    },
    invite,
  };
}

/** A connected, healthy runtime snapshot with one server, one DM, and a message. */
export function createHappyRuntime(): XoreinRuntimeSnapshot {
  return {
    role: "client",
    peer_id: "peer-local",
    control_endpoint: CONTROL_ENDPOINT,
    identity: {
      id: "identity-local",
      peer_id: "peer-local",
      public_key: "local-pub",
      profile: { display_name: "Local User", bio: "Connected test user" },
      created_at: LOCAL_TIMESTAMP,
    },
    known_peers: [
      peer("peer-local", "client", "local-pub", "self", ["127.0.0.1:4100"]),
      peer("peer-owner-base", "client", "base-pub", "bootstrap", ["127.0.0.1:4101"]),
      peer("u2", "client", "u2-pub", "bootstrap", ["127.0.0.1:4110"]),
      peer("u3", "client", "u3-pub", "bootstrap", ["127.0.0.1:4111"]),
    ],
    servers: [
      createRuntimeServer({
        id: "base-node",
        name: "Base Node",
        description: "Seed runtime for tests.",
        ownerPeerId: "peer-owner-base",
        invite: "aether://join/base-node?invite=signed-base",
        memberPeerIds: ["peer-local", "peer-owner-base", "u2", "u3"],
      }),
    ],
    dms: [{ id: "dm-u2", participants: ["peer-local", "u2"], created_at: LOCAL_TIMESTAMP }],
    messages: [
      {
        id: "msg-base-1",
        scope_type: "channel",
        scope_id: "base-node-general",
        server_id: "base-node",
        sender_peer_id: "u2",
        body: "hello from the base node",
        created_at: LOCAL_TIMESTAMP,
      },
    ],
    voice_sessions: [],
    settings: { control_endpoint: CONTROL_ENDPOINT },
    telemetry: [],
  };
}

export function createSessionSnapshot(
  overrides: Partial<XoreinSessionSnapshot> = {},
): XoreinSessionSnapshot {
  return {
    serverId: "base-node",
    securityMode: "seal",
    connectedAtMs: Date.parse(LOCAL_TIMESTAMP),
    reconnectAttempts: 0,
    manifest: { name: "Base Node", description: "Seed runtime for tests." },
    acceptedProtocol: null,
    ...overrides,
  };
}
