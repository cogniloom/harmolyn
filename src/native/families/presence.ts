// xorein presence family — /aether/presence/0.2.0
// Byte-compatible with Go oracle: pkg/v0_1/family/presence/handler.go
import type { Libp2p } from 'libp2p';
import { callFamily, encodePeerStreamRequest, frameMessage } from './peerstream.js';

export const PRESENCE_PROTOCOL = '/aether/presence/0.2.0';

export type PresenceStatus = 'online' | 'away' | 'offline' | 'idle' | 'dnd' | 'invisible';

export interface PresenceRecord {
  peer_id: string;
  status: PresenceStatus;
  status_text?: string;
  updated_at: string; // ISO8601
  status_version?: number;
  is_typing?: boolean;
  typing_in_scope?: string;
}

const enc = (o: object) => new TextEncoder().encode(JSON.stringify(o));

/** Announce our presence to a connected peer. */
export async function announcePresence(
  node: Libp2p,
  peerAddr: string,
  record: PresenceRecord,
): Promise<void> {
  await callFamily(node, peerAddr, PRESENCE_PROTOCOL, 'presence.announce', enc(record));
}

/** Query a peer's presence status. */
export async function queryPresence(
  node: Libp2p,
  peerAddr: string,
  targetPeerId: string,
): Promise<PresenceRecord | null> {
  const resp = await callFamily(
    node, peerAddr, PRESENCE_PROTOCOL, 'presence.query',
    enc({ peer_id: targetPeerId }),
  );
  if (resp.error || !resp.payload) return null;
  return JSON.parse(new TextDecoder().decode(resp.payload)) as PresenceRecord;
}

/** Register a presence handler on the local node to respond to peer queries. */
export function registerPresenceHandler(node: Libp2p, selfRecord: () => PresenceRecord): void {
  node.handle(
    PRESENCE_PROTOCOL,
    async (stream) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk.subarray());
      // Respond with our presence record.
      const respPayload = new TextEncoder().encode(JSON.stringify(selfRecord()));
      const resp = new Uint8Array([
        ...pbBytes(4, respPayload), // field 4 = payload
      ]);
      stream.send(frameMessage(resp));
      await stream.close();
    },
    { runOnLimitedConnection: true },
  );
}

function varint(n: number): Uint8Array {
  const buf: number[] = [];
  while (n > 0x7f) { buf.push((n & 0x7f) | 0x80); n >>>= 7; }
  buf.push(n & 0x7f); return new Uint8Array(buf);
}
function pbBytes(fieldNum: number, b: Uint8Array): Uint8Array {
  const tag = new Uint8Array([(fieldNum << 3) | 2]);
  const len = varint(b.length);
  const out = new Uint8Array(tag.length + len.length + b.length);
  out.set(tag, 0); out.set(len, tag.length); out.set(b, tag.length + len.length);
  return out;
}
