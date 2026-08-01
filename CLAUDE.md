# CLAUDE.md

Read `AGENTS.md` first. It contains the authoritative repository commands and
security boundaries.

## Current architecture

Harmolyn is a React/Vite application whose default data plane is the in-browser
Xorein engine under `src/native/`. The Tauri shell packages the same client and
provides a narrow authenticated bridge to a separately installed local Xorein
control API; it does not bundle or launch a sidecar.

The main layers are:

```text
React UI                 src/components/
Runtime facade           src/hooks/runtime/useRuntimeMutations.ts
Peer-owned engine        src/native/engine/, state/, sync/, delivery/
Transport/discovery      src/native/transport/, peerServices/
Security modes           src/native/seal/, tree/, crowd/, voice/
Xorein Node client       src/lib/xoreinControl.ts, src/native/nodeOrigin.ts
Desktop boundary         src-tauri/src/lib.rs
```

The Xorein Node is an untrusted helper for first contact, circuit relay,
rendezvous, opaque replication/blob service, mailbox holding, and TURN. It is
not a message authority. Direct and routed peer operations must continue when a
Xorein Node disappears.

## Important implementation rules

1. Add user mutations through `useRuntimeMutations.ts`; do not call a remote
   control endpoint directly from a component.
2. Verify author signatures, destination binding, replay bounds, and size limits
   before applying remote data.
3. Keep identity/recovery secrets local or recipient-sealed. Password encryption
   alone is not sufficient for storage on arbitrary providers because it creates
   an offline password oracle.
4. Treat peer/node inventories as hints. History requires author proof;
   attachments require chunk and whole-ciphertext hashes.
5. Preserve the provider preference order: healthy nodes first for bulk work,
   then bounded round-robin peer fallback and repair.
6. Keep node health distinct from transport health. `ConnectionActivityPill`
   may show Connected only for a live peer/relay path.
7. Membership changes rotate the channel root/epoch. Tree is used through 50
   members, Crowd from 51, and re-entry occurs at 40. Do not add a plaintext or
   weaker-crypto size tier.
8. The current Tree implementation is custom and must not be marketed as audited
   RFC 9420 MLS without independent evidence.
9. Generated test artifacts belong under `.generated/`; do not commit ad-hoc
   browser screenshots.

## Node endpoint behavior

Xorein Node defaults are browser gateway `7711/tcp`, WebSocket transport
`9999/tcp`, TURN `3478/udp` and `3478/tcp`, optional TURN/TLS `5349/tcp`, and
TURN allocations `49152-65535/udp`. The private control API remains on a Unix
socket or private Windows loopback endpoint. A browser receiving `401` on
`7711` is normally talking to a mistakenly exposed private control port or an
obsolete node build.

`Settings -> Network -> Switch Node` opens `NodeLaunchScreen`. The explicit test
must execute from the same browser/native context that will use the endpoint and
must report authorization, CORS, malformed response, HTTP, and timeout failures
separately.

## Verification expectations

For local source changes, run the smallest focused tests first, then the relevant
full commands from `AGENTS.md`. A local simulated 1,000-peer model is useful
evidence but not a claim about 1,000 real browsers, WAN NAT behavior, signed
cross-platform packages, or production readiness. Retain that distinction in
code comments, docs, and handoff reports.
