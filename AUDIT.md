# Security audit guide

Harmolyn is the client-side trust boundary for identity keys, encrypted local
state, peer authorization, recovery, and message encryption. The maintainers
performed an internal review on 2026-08-01. It is not an independent audit,
certification, or guarantee that the software is free of vulnerabilities.

## Reporting a vulnerability

Use the private **Report a vulnerability** form in the
[Cogniloom/Harmolyn security advisories](https://github.com/Cogniloom/harmolyn/security/advisories/new).
Do not publish exploit details before a fix is available. Include affected
versions, platform, a minimal reproducer, the violated security property, and
impact. If the private form is unavailable, open a public issue without exploit
details and request a private contact channel.

There is no monetary reward or bug bounty at this time. With permission,
researchers and organizations that perform useful review or coordinated
disclosure will be credited in this file and the relevant release notes.

## Highest-value review targets

| Area | Primary code | Properties to test |
|---|---|---|
| Identity and local key storage | `src/native/identity/`, `src/native/state/store.ts` | password KDF, key-file confidentiality/integrity, rollback, account switching, secret redaction |
| Direct-message encryption | `src/native/seal/`, `src/native/crypto/` | bundle authentication, replay, skipped-key exhaustion, state rollback, Go/TypeScript interoperability |
| Space channel encryption | `src/native/tree/`, `src/native/crowd/`, `src/native/sync/secureEnvelope.ts` | scope-bound AAD, mode transition, epoch rollback/reuse, removed-member access, malformed wire data |
| Owner authority and membership | `src/native/sync/signedServer.ts`, `src/native/sync/inbound.ts`, `src/native/state/` | proof canonicalization, stale revisions, invite forgery, cross-Space substitution, offline owner behavior |
| Recovery | `src/native/recovery/` | guardian authorization, encrypted-state confidentiality, chunk reassembly, hash/length confusion, quota exhaustion, lost-device recovery |
| Peer routing and storage | `src/native/delivery/`, `src/native/discovery/`, `src/native/sync/`, `src/native/blobs/` | malicious relays/providers, signed graph routes, poisoning, eclipse resistance, replica uploader-proof substitution, corruption and repair |
| Voice and screen sharing | `src/native/voice/` | SFrame key binding, participant churn, replay, TURN privacy, two-browser media behavior |
| Desktop boundary and updates | `src-tauri/` | command authorization, localhost origin checks, signed-update verification, downgrade, settings preservation |

Run `npm run lint`, `npm run build`, `npm run test:protocol`, and the focused
Vitest suites under `src/native/`. Cross-check protocol behavior against the Go
implementation and audit guide in
[Cogniloom/Xorein](https://github.com/Cogniloom/xorein/blob/main/AUDIT.md).

## Internal review findings addressed on 2026-08-01

- Tree and Crowd live ciphertext is bound to its Space identifier.
- Channel roots cannot change without advancing the owner-signed epoch.
- An inactive Tree/Crowd mode is retained only for the immediately preceding
  transition epoch instead of remaining decryptable indefinitely.
- Unknown explicit channel crypto profiles fail closed; new Spaces advertise
  the signed `scope-aad-v2` profile and matching capability.
- Live Tree/Crowd messages now require the original author's hybrid signature.
  A shared epoch key proves group access, not sender identity; unsigned channel
  ciphertext is rejected even when it arrives over an authenticated connection.
- Tree application encryption uses the complete 32-byte AES-256-GCM epoch key;
  regression coverage changes the final key byte to detect accidental key
  truncation.
- History and attachment replicas carry a portable hybrid uploader proof over
  every replacement-relevant hint and the exact opaque envelope digest. Nodes
  can forward a record without gaining the ability to substitute ciphertext
  under the original uploader's identity.
- Oversized encrypted recovery state is split into bounded, independently
  sealed chunks, durably reassembled out of order, and verified by total length
  and SHA-256 before use.
- Portable v3 invites bind an owner-signed exact future revision/epoch/root,
  generation, mode, and profile. The transition is sealed under the current
  root; a bearer cannot decrypt existing history or choose a different roster.
  Revocation/removal rotates the invite generation and cached capability.
- Proof-less security-mode, epoch, and invite-generation changes fail closed;
  owner signatures and monotonic revisions remain authoritative across routed,
  mailbox, and peer-restored state.
- Remote PEX cannot induce DNS or private-network probes from a public source.
  Local relay discovery is accepted only from an authenticated relay in the
  same bounded loopback/private address scope.
- Recipient-inbox delivery does not clear the sender outbox merely because an
  unknown peer accepted storage; the holder must be a Node or share the
  recipient's Space/DM graph. Voice presence fanout retries unanswered peers
  without letting a fast negative response erase a later positive response.
- Blob cache quota accounting is transactional and O(1) during normal writes;
  sponsor identities are bounded and eviction cannot remove fragments in the
  write currently being admitted.

## Important residual risk

The custom Tree/Crowd protocol has not received independent cryptographic review
or formal verification. Browser cryptography also depends on JavaScript runtime
and dependency behavior that this review cannot prove constant-time. A real
multi-region hostile-network soak, restrictive-NAT voice test, long-duration
recovery test, and 1,000-live-peer bandwidth/disk run remain necessary before
making high-assurance deployment claims.

Tree is selected only through 50 Space members and Crowd above that threshold;
the topology changes automatically with hysteresis, but cryptographic strength
is never reduced because a Space grows. Unsupported old clients must update
rather than negotiate an unauthenticated weaker profile.

Crowd members share an epoch root and can derive every symmetric sender key.
Consequently the hybrid author-proof check in `signedHistory.ts` and
`inbound.ts` is a critical security boundary. Auditors should attempt direct,
routed, mailbox, replica, edit, deletion, replay, and cross-Space forgeries; a
valid AEAD tag without a valid author proof must never be accepted as a channel
message.

## Credits

No external audit has been recorded yet. Approved acknowledgements will list
the researcher or organization, reviewed area, disclosure date, advisory, and
release containing the fix.
