export const CONTROL_ENDPOINT = 'http://127.0.0.1:7711';
export const LOCAL_TIMESTAMP = '2026-04-22T00:00:00Z';
export const HAPPY_CHAT_MESSAGE = 'Browser smoke message';
export const FRIEND_REQUEST_USERNAME = 'u6';
export const CREATED_SERVER_NAME = 'Alpha Node';
export const JOINED_SERVER_NAME = 'Beta Node';
export function makeXoreinInvite(serverId, ownerPeerId, ownerPublicKeySuffix) {
  const invite = {
    server_id: serverId,
    owner_peer_id: ownerPeerId,
    owner_public_key: `${ownerPeerId}${ownerPublicKeySuffix ? `-${ownerPublicKeySuffix}` : ''}`,
    manifest_hash: `${serverId}-manifest-hash`,
    expires_at: '',
    security_mode: 'seal',
    signature: `${serverId}-signature`,
  };
  const rawInvite = Buffer.from(JSON.stringify(invite), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `xorein://invite/${rawInvite}`;
}

export const JOIN_INVITE = makeXoreinInvite('beta-node', 'peer-owner-joined', 'pub');

export function parseXoreinInvite(rawInvite) {
  const normalized = String(rawInvite ?? '').trim();
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'xorein:' || parsed.hostname !== 'invite') {
      return null;
    }
    const payload = decodeXoreinInvitePayload(parsed.pathname.replace(/^\/+|\/+$/g, ''));
    return payload;
  } catch {
    return decodeXoreinInvitePayload(normalized);
  }
}

function decodeXoreinInvitePayload(rawInvite) {
  const normalized = String(rawInvite ?? '').trim();
  if (!normalized) {
    return null;
  }
  const base64 = normalized.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function createHappyRuntime() {
  return {
    role: 'client',
    peer_id: 'peer-local',
    control_endpoint: CONTROL_ENDPOINT,
    identity: {
      id: 'identity-local',
      peer_id: 'peer-local',
      public_key: 'local-pub',
      profile: { display_name: 'Local User', bio: 'Connected test user' },
      created_at: LOCAL_TIMESTAMP,
    },
    known_peers: [
      peer('peer-local', 'client', 'local-pub', 'self', ['127.0.0.1:4100']),
      peer('peer-owner-base', 'client', 'base-pub', 'bootstrap', ['127.0.0.1:4101']),
      peer('peer-owner-created', 'client', 'created-pub', 'bootstrap', ['127.0.0.1:4102']),
      peer('peer-owner-joined', 'archivist', 'joined-pub', 'bootstrap', ['127.0.0.1:4103']),
      peer('u2', 'client', 'u2-pub', 'bootstrap', ['127.0.0.1:4110']),
      peer('u3', 'client', 'u3-pub', 'bootstrap', ['127.0.0.1:4111']),
      peer('u4', 'client', 'u4-pub', 'bootstrap', ['127.0.0.1:4112']),
      peer('u5', 'client', 'u5-pub', 'bootstrap', ['127.0.0.1:4113']),
      peer('u6', 'client', 'u6-pub', 'bootstrap', ['127.0.0.1:4114']),
    ],
    servers: [createRuntimeServer({
      id: 'base-node',
      name: 'Base Node',
      description: 'Seed runtime for browser smoke coverage.',
      ownerPeerId: 'peer-owner-base',
      invite: makeXoreinInvite('base-node', 'peer-owner-base', 'pub'),
      memberPeerIds: ['peer-local', 'peer-owner-base', 'u2', 'u3', 'u4', 'u5', 'u6'],
    })],
    dms: [
      {
        id: 'dm-u2',
        participants: ['peer-local', 'u2'],
        created_at: LOCAL_TIMESTAMP,
      },
    ],
    messages: [
      {
        id: 'msg-base-1',
        scope_type: 'channel',
        scope_id: 'base-node-general',
        server_id: 'base-node',
        sender_peer_id: 'u2',
        body: 'hello from the base node',
        created_at: LOCAL_TIMESTAMP,
      },
    ],
    voice_sessions: [],
    relay_addrs: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay'],
    settings: { control_endpoint: CONTROL_ENDPOINT },
    telemetry: [],
  };
}

export function createRuntimeServer({
  id,
  name,
  description,
  ownerPeerId,
  invite,
  memberPeerIds,
}) {
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
        name: 'general',
        voice: false,
        created_at: LOCAL_TIMESTAMP,
      },
    },
    manifest: {
      name,
      description,
      owner_addresses: ['127.0.0.1:4101'],
      capabilities: ['cap.chat', 'cap.manifest', 'cap.friends', 'cap.notify', 'cap.identity', 'cap.dm', 'cap.presence'],
      history_coverage: 'local-window',
      history_retention_messages: 50,
    },
    invite,
  };
}

export function createControlServerRecord({
  id,
  name,
  description,
  ownerPeerId,
  ownerAddresses,
  invite,
}) {
  return {
    id,
    name,
    description,
    invite,
    manifest: {
      server_id: id,
      name,
      description,
      owner_peer_id: ownerPeerId,
      owner_public_key: `${ownerPeerId}-pub`,
      owner_addresses: ownerAddresses,
      bootstrap_addrs: ['127.0.0.1:4101'],
      relay_addrs: [],
      capabilities: ['cap.chat', 'cap.manifest', 'cap.friends', 'cap.notify', 'cap.identity', 'cap.dm', 'cap.presence'],
      history_retention_messages: 50,
      history_coverage: 'local-window',
      history_durability: 'volatile',
      issued_at: LOCAL_TIMESTAMP,
      updated_at: LOCAL_TIMESTAMP,
      signature: `signed-${id}`,
    },
    channels: {
      [`${id}-general`]: {
        id: `${id}-general`,
        server_id: id,
        name: 'general',
        voice: false,
        created_at: LOCAL_TIMESTAMP,
      },
    },
  };
}

export function createJoinPreview() {
  return {
    invite: {
      server_id: 'beta-node',
      expires_at: '2026-04-23T00:00:00Z',
    },
    manifest: {
      server_id: 'beta-node',
      name: JOINED_SERVER_NAME,
      description: 'Joined through a signed invite.',
      history_coverage: 'local-window',
    },
    owner_role: 'archivist',
    member_count: 2,
    channels: [
      {
        id: 'beta-node-general',
        server_id: 'beta-node',
        name: 'general',
        voice: false,
        created_at: LOCAL_TIMESTAMP,
      },
    ],
    safety_labels: ['owner-archivist'],
  };
}

function peer(peerId, role, publicKey, source, addresses) {
  return {
    peer_id: peerId,
    role,
    addresses,
    public_key: publicKey,
    source,
    last_seen_at: LOCAL_TIMESTAMP,
  };
}
