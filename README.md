# Harmolyn

Harmolyn is a browser and native desktop client for the Xorein peer-owned
communication network. The application contains its own browser-compatible
libp2p engine; a dedicated Xorein node improves discovery, storage, relay, and
NAT traversal, but it is not trusted with message plaintext and is not the
authority for user data.

Current version: `1.0.0-rc.1`. This is a release candidate, not an evidence-free
claim that v1.0 has shipped. The remaining release gates are listed below.

## What is implemented

- Hybrid classical/post-quantum identities and signatures.
- Seal direct messages using hybrid X3DH plus a Double Ratchet.
- End-to-end encrypted spaces with automatic key-management selection:
  Tree through 50 members, Crowd from 51 members, and Crowd-to-Tree re-entry at
  40 members to prevent mode flapping.
- A fresh signed epoch/root on authoritative membership changes. Room size
  never selects weaker cryptography and there is no plaintext fallback.
- Signed invites, joins, friends, presence, DMs, channel history, notifications,
  and bounded multi-hop peer routing.
- Recipient-addressed encrypted inbox replication and retry for offline peers.
- Encrypted attachment fragmentation, content-address verification, node-first
  retrieval, and round-robin peer fallback.
- Encrypted identity/account backups held by chosen recovery contacts and
  replicated as recipient-sealed, integrity-checked chunks with identity keys
  prioritized first. A storage provider cannot test the recovery password or
  read the backup.
- WebRTC voice/video with application media encryption. Xorein Nodes
  automatically provide short-lived credentials for embedded TURN
  over UDP/TCP and optional TLS.
- Node switching with an explicit `Test Node` action and persistent user choice.
- Signed native application updates from the official Cogniloom GitHub release
  repositories. Updates replace application binaries, not user data directories.

See [Peer-owned network](docs/PEER_OWNED_NETWORK.md) for routing and zero-node
behavior, [crypto compatibility and upgrade risk](docs/CRYPTO_COMPATIBILITY.md),
the [security review guide](AUDIT.md), and
[release process](docs/RELEASES.md) for the signing pipeline.

## Run Harmolyn locally

```bash
npm ci
npm run dev
```

Vite listens on `0.0.0.0:8080`. The production web container listens on host
port `8909` by default:

```bash
docker compose up --build
```

The JavaScript still runs in the user's browser when the site is served from a
container. Therefore `localhost` and `127.0.0.1` in the node picker refer to the
browser's machine, not to the Nginx container.

## Run a local Xorein support node

From the sibling Xorein repository:

```bash
make build
./bin/aether
```

Aether requires no parameters. It starts a full Xorein Node from safe binary
defaults, overlays a discovered `aether.toml`, then overlays explicit flags.
See the Xorein repository's `config/aether.toml` for the annotated template.
The defaults are:

| Purpose | Default |
|---|---|
| Browser-safe status/bootstrap gateway | TCP `7711` |
| Browser libp2p WebSocket transport | TCP `9999` |
| STUN/TURN over UDP | UDP `3478` |
| TURN over TCP | TCP `3478` |
| TURN over TLS | TCP `5349`, active only with a configured certificate/key |
| TURN media allocations | UDP `49152-65535` |
| Private mutation/control API | Unix socket, or private loopback address on Windows |

Then enter `127.0.0.1:7711` in Harmolyn and press **Test Node**. For another
device, use the actual LAN address of the Xorein machine and allow the listed
ports through the firewall. Do not bind the private `--control` API to `7711`;
it requires a bearer token and is intentionally unusable by a web client.

For Internet TURN, `--turn-public-ip` must resolve to the externally reachable
IPv4 address and UDP/TCP `3478` plus the UDP allocation range must be forwarded.
TURN/TLS additionally needs a publicly trusted certificate matching the client
hostname and TCP `5349`. No program inside a general NAT or Docker network can
infer an arbitrary router's public mapping with certainty.

An HTTPS-hosted Harmolyn page also requires an HTTPS/WSS browser gateway because
browsers block active HTTP mixed content. Native builds and locally served HTTP
builds may use private-LAN HTTP directly.

## Security and availability model

Dedicated nodes are untrusted accelerators. They may observe unavoidable
routing metadata, but accepted records are signed by their authors and message
contents remain end-to-end encrypted. Harmolyn prefers nodes for bandwidth and
storage, then falls back to known peers. It periodically cross-checks retrieved
history and attachment data, rejects invalid signatures/hashes, and quarantines
locally observed corrupt providers.

With no dedicated nodes, known peers can continue direct communication, route
bounded requests, hold sealed recipient inboxes, and reconstruct data from peer
storage. A completely new client still needs one initial address from an
invite, cache, LAN discovery, configured seed, or reachable peer. No protocol
can discover an address or retrieve bytes when no reachable device possesses
either information.

Recovery is not MFA. A local encrypted key file plus its password is one
knowledge-protected credential. Recovery contacts improve hardware-loss
survivability; they do not create a second authentication factor. Choose a
strong, unique password because a guardian who receives the custody ciphertext
can attempt offline guesses.

## Verification commands

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:protocol
npm run test:browser:all
```

The real TURN smoke requires a running Xorein relay and creates two isolated
Chromium contexts with relay-only ICE, bidirectional fake audio, and a data
channel:

```bash
VOICE_NODE_ENDPOINT=http://127.0.0.1:7711 npm run test:voice:e2e
# Restrictive-network path: expose only TURN/TCP to both browsers.
VOICE_NODE_ENDPOINT=http://127.0.0.1:7711 VOICE_TURN_TRANSPORT=tcp npm run test:voice:e2e
```

Desktop checks:

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri:build
```

## Releases and updates

`.github/workflows/release.yml` is manually dispatched against `staging` with a
`stable`, `patch`, `minor`, or `major` version choice. It validates the exact
candidate tree, builds every platform before promotion, signs platform packages
and updater artifacts, atomically advances `staging` and `main` with the release
tag, then publishes the official GitHub release. The release tag is OpenPGP
signed and a failed post-promotion publication can be resumed without minting a
different version.

The workflow fails closed when any updater, Apple, or Windows signing credential
is absent. Configure these as environment secrets in the protected
`official-release` GitHub environment, using the exact value types shown:

| Secret | Expected value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Complete private-key text emitted by `npm exec tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The non-empty password used by that key |
| `APPLE_CERTIFICATE` | Base64 of a Developer ID Application certificate and private key exported together as `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Export password of that `.p12` |
| `APPLE_SIGNING_IDENTITY` | Exact Keychain name, normally `Developer ID Application: Legal Name (TEAMID)` |
| `APPLE_ID` | Apple Account email authorized for notarization |
| `APPLE_PASSWORD` | Apple app-specific password, not the normal account password |
| `APPLE_TEAM_ID` | Ten-character Apple Developer Team ID |
| `WINDOWS_CERTIFICATE` | Base64 of an Authenticode certificate and private key exported together as `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | Export password of that `.pfx` |
| `RELEASE_TAG_GPG_PRIVATE_KEY` | Complete ASCII-armored, passphrase-protected OpenPGP private key dedicated to official release tags |
| `RELEASE_TAG_GPG_PASSPHRASE` | Non-empty passphrase protecting that OpenPGP private key |
| `RELEASE_TAG_GPG_FINGERPRINT` | Exact 40-character uppercase hexadecimal primary-key fingerprint; register its public key on the official GitHub release identity |

Do not add shell quotes or JSON wrappers to secret values. See
[Release process](docs/RELEASES.md) for runner labels, key backup requirements,
and the complete release sequence.

Native Harmolyn checks only
`cogniloom/harmolyn` release metadata and accepts only artifacts bearing the
public updater key compiled into the application. Signed native updates are
checked and downloaded automatically by default. Installation waits for the
user's explicit **Install & restart** action so an active call or unsaved draft
is not terminated; account data and settings remain outside the application
bundle. Browser deployments update when their operator deploys a new web build.

## Remaining v1.0 release gates

- Run and retain successful signed macOS and Windows builds and native updater
  install/rollback tests on those operating systems.
- Provision all Apple/Windows signing secrets and retain a successful signed
  release run; exact formats are documented in the release guide.
- Retain a long-duration churn test for owner-issued portable invites. They now
  seal and sign one exact future epoch transition that peers can enact while the
  owner is offline; they do not delegate arbitrary owner powers or permit an
  ordinary member to invent a different roster transition.
- Perform a multi-host, real-WAN soak with churn, partitions, restrictive NATs,
  and hostile storage providers. The checked-in 1,000-peer result is a
  deterministic model, not 1,000 live browsers.
- Obtain an independent cryptographic/protocol review of the custom Tree/Crowd
  implementation before describing it as audited MLS-grade security.

## License

- Application/runtime code: AGPL-3.0-or-later.
- Xorein protocol specification text: CC BY-SA 4.0.
