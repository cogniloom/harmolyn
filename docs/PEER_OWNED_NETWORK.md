# Peer-owned network

Harmolyn treats dedicated Xorein nodes as untrusted accelerators, not as the
network's source of truth. Durable encrypted state belongs to its participants.

## Zero dedicated nodes

Once a client knows one authenticated edge into the graph, connected peers can
forward destination-sealed, hybrid-signed requests. Forwarders cannot read or
alter accepted payloads. Routed envelopes have hop, replay, loop, size, and
expiry bounds.

The implemented peer path covers friend requests/acceptance, Seal DMs, signed
space invites and joins, channel operations, notifications, bounded history,
recipient inbox packets, and encrypted attachment fragments. The libp2p host is
kept alive when a relay disappears, so existing direct links and known peer
routes remain useful while relay discovery continues.

If no holder is reachable, outbound encrypted operations stay in the local
queue. If storage peers are reachable, recipient-sealed inbox packets are placed
on rendezvous-selected holders and repaired toward three copies. This provides
delayed delivery; it cannot deliver bytes while every device that could hold or
receive them is unavailable.

## Discovery and failover

Harmolyn combines configured gateways, invite seed addresses, cached peers, LAN
discovery, signed peer exchange, and periodic peer-record gossip. Records are
address hints signed by the claimed peer; a subsequent Noise connection still
authenticates the actual peer. Learned Xorein Node addresses are promoted in the
background instead of pinning the session permanently to the launch node. The
built-in first-contact seed is `node.xorein.com`; an authenticated software
update can replace it if control of that domain is ever lost.

Xorein's Kademlia DHT is currently fail-closed because the selected upstream
dependency has an unresolved security advisory. mDNS, bootstrap, signed PEX,
manual addresses, invite seeds, cached records, and routed peer discovery remain
available. Re-enable DHT only after the dependency and threat model pass review.

No protocol can discover an address from zero information. A brand-new,
physically isolated client needs a cached route, invite seed, LAN peer,
configured bootstrap address, or another reachable participant. After that first
edge, discovery propagates through peers.

## Untrusted retrieval

Nodes and peers advertise availability only. Harmolyn prefers healthy Xorein
Nodes for bulk retrieval, then distributes missing requests among peers in
bounded round-robin batches.

- History is accepted only after the original author's hybrid signature and
  scope/revision bindings verify.
- Every 20-50 accepted history records, the client asks up to two other holders
  for a sampled record. Invalid providers are locally quarantined; distinct
  author-valid records at one revision are reported as author equivocation, not
  decided by majority vote.
- Attachments are encrypted before fragmentation. Every fragment has a SHA-256
  address and the complete ciphertext hash is verified before decryption.
- Recovery and offline-inbox packets are sealed to their recipient and retain
  the origin signature through storage and forwarding.

Provider reputation is local evidence, not a globally gossiped score that a
Sybil or slander campaign could manipulate.

## Node replication

Harmolyn targets three opaque copies across support nodes or eligible peers.
Xorein Node anti-entropy uses rendezvous placement, bounded batches,
quotas, authenticated forwarding peers, and replacement repair when the live
node set changes. A node may point a client at holders for missing records, but
the client still verifies every returned author proof.

This is replication, not yet erasure coding. Losing all holders delays recovery
until one returns. Nodes are motivated operationally by being preferred for
reads and by contributing availability; an economic incentive/reward mechanism
is not implemented.

## Automatic room security

Every space carries an owner-authorized `channel_security_mode` and epoch. Tree
is selected through 50 members. Joining member 51 advances the epoch and selects
Crowd. Crowd returns to Tree only at 40 or fewer members. The hysteresis avoids
repeated transitions around the boundary. Both modes use encrypted payloads and
hybrid author authentication; room size never enables Clear mode.

Normal owner-authorized joins, leaves, and removals rotate the root. Portable
owner-offline admission can preserve availability but does not yet provide an
authoritative threshold/delegated key transition. That is an explicit release
gate rather than a hidden security downgrade.

## TURN and media

Xorein Nodes embed STUN/TURN over UDP and TCP and issue ten-minute,
source-bound credentials through their browser-safe gateway. Optional TURN/TLS
uses TLS 1.2 or newer and requires a trusted certificate matching the client
hostname. TURN observes transport metadata and Harmolyn-encrypted media, not
media plaintext. An Internet or containerized operator must publish UDP/TCP
`3478`, the configured UDP allocation range, the real public IPv4 address, and
TCP `5349` when TLS is enabled.

The checked-in voice test creates two isolated Chromium contexts, forces
relay-only ICE, exchanges a data payload, and verifies one remote audio track in
each direction. This proves the local embedded TURN path, not every carrier NAT
or firewall on the Internet.

## Evidence boundary

The Xorein benchmark suite includes deterministic 1,000-peer zero-node and
node-assisted simulations with churn, a partition, hostile providers, repair,
and modeled regional latency. Those runs validate invariants in the model. They
do not replace a 1,000-process multi-region deployment, bandwidth capture,
long-duration soak, or hostile live implementation test.
