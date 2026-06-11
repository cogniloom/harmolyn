# Harmolyn — Product Vision

## 1. Product One-Liner

Harmolyn is a Discord-like community platform where every conversation's encryption
state is visible, user-controlled, and cryptographically enforced — no promised E2EE,
only verifiable E2EE.

---

## 2. Target Users

**Privacy-conscious communicators** who need to verify their encryption guarantees, not
just trust a vendor's claim. This includes:

- Activists, journalists, and professionals who operate under adversarial conditions.
- Communities that want Discord-quality UX without routing private messages through a
  central server that can read them.
- Developers and power-users who will inspect the open-source code and the on-wire
  protocol to confirm the security properties hold.

What they care about: the difference between "encrypted in transit" and "only readable
by participants." Harmolyn must make that distinction visible and un-bypassable at every
interaction.

---

## 3. Core Value Proposition

**Discord-like UX + four explicit, always-visible security modes + a full in-browser P2P
peer — no sidecar, no thin-client compromise.**

### Security modes (live in `dist/assets/Layout-uyPNBzUp.js`, `Sa` object)

| Mode      | Label                         | Protocol                            | When used                                                                                      |
| --------- | ----------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Seal**  | `SEAL // 1:1 E2EE`            | X3DH key agreement + Double Ratchet | Direct messages between two peers                                                              |
| **Tree**  | `TREE // GROUP E2EE`          | MLS (Messaging Layer Security)      | Small groups with full member trees                                                            |
| **Crowd** | `CROWD // CHANNEL E2EE`       | Epoch-rotation channel encryption   | Large channels                                                                                 |
| **Clear** | `UNENCRYPTED // DO NOT TRUST` | None                                | Only in legacy or interop contexts; Harmolyn **never** negotiates this mode for its own spaces |

The mode badge is rendered on every conversation header. Clear mode carries an explicit
danger label and `insecure: true` in the data model — it is never a silent default.

When `HARMOLYN_NATIVE_ACTIVE` is set (Tauri desktop build, `src-tauri/`), the native
peer is authoritative: DMs default to Seal, channels to Crowd.

### Full in-app peer

The xorein P2P peer initialises inside the app process (browser or Tauri). The libp2p
node is created in `dist/assets/peerstream-CeMEa_Qx.js` (`g()` factory), using:

- Transport: WebSockets + circuit-relay-v2 (browser), WebTransport/QUIC when available
- Connection encryption: Noise XX with `ChaCha20-Poly1305 / SHA-256`
  (`/aether/noise/1.0|noise=XX_25519_ChaChaPoly_SHA256`)
- Identity: Ed25519 keypair (derived from user seed)
- Peer ID: libp2p multihash format

The support node (`node.xorein.com`, peer
`12D3KooWGWC3A4KawRYn9Mcyt9LjDg6TS7vF5uju7v6gTFsrEBS4`) provides bootstrap relay and
blob storage only. It is **not** on the default message path.

---

## 4. Architecture Constraints (non-negotiable product invariants)

### 4.1 The app IS the xorein peer

The full xorein protocol stack runs inside the app — both in the browser build and in the
Tauri desktop build (`src-tauri/`). There is no separate node process the user must
install. No thin-client mode where messages are decrypted server-side.

Evidence: `peerstream-CeMEa_Qx.js` exports `initNode()` (`g`), which is called
at app startup, not by a sidecar.

### 4.2 `node.xorein.com` is a support service, never on the message path

The support node provides circuit relay bootstrap and blob storage for async delivery.
It must never appear in the routing path of a live E2EE message between two online
peers.

Evidence: `peerstream-CeMEa_Qx.js` `_()` function — the app dials the relay to
acquire a `/p2p-circuit` address, then uses that address for peer reachability, not as
a message intermediary.

### 4.3 Hybrid post-quantum E2EE is the cryptographic foundation

The xorein hybrid scheme is the encryption baseline. No feature or protocol negotiation
may silently downgrade a private space to classical-only or unencrypted.

Reference: `https://github.com/xorein/hybrid` (`Nc` constant in bundle).

### 4.4 Security mode is always visible; Clear is never a silent default

Every conversation renders its current security mode badge from the `Ca()` resolver in
the Layout bundle. The `unspecified` state is distinct from `clear` — an unresolved
negotiation is shown as `NOT NEGOTIATED`, not silently rendered as safe.

The `clear` mode object carries `insecure: true` and the description explicitly states
"Harmolyn never negotiates this mode" for its own private spaces. It exists solely for
interoperability with external, non-E2EE contexts.

---

## 5. Explicit Non-Goals

Harmolyn will **not** become:

- **A thin client that proxies through a server.** Decryption must happen on the
  end-user device. Any architecture where the server holds decryption keys or routes
  plaintext is out of scope.
- **A classical-only encrypted messenger.** Downgrading from the hybrid post-quantum
  scheme to classical-only cryptography is not a product direction, even as a
  compatibility mode.
- **A general-purpose social network.** Harmolyn does not pursue public discovery feeds,
  algorithmic timelines, ad targeting, or growth-hacking features that require
  centralised user-data collection.
- **A web2 messaging app with optional encryption.** Encryption is not a premium or
  opt-in feature. The mode badge is always present; there is no "encryption-off" user
  preference for private spaces.
- **A platform that silently degrades to Clear mode.** Clear mode requires an explicit,
  visible negotiation. It is never the outcome of a failed encryption handshake presented
  as a successful connection.

---

## 6. Quality Bar

The following standards must hold before any feature ships:

| Dimension                 | Minimum bar                                                                                                                                  | Verification                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| E2EE correctness          | Seal/Tree/Crowd messages must not be decryptable by the support node or any party outside the negotiated member set                          | Protocol unit tests covering the crypto primitive round-trip    |
| Security-mode UI accuracy | The mode badge rendered in the channel header must match the actual negotiated mode object; mismatches are a P0 bug                          | E2E test asserting badge ↔ negotiated mode                     |
| No secrets in bundle      | Production bundles must not contain private keys, seed material, or API secrets                                                              | `dist/` static scan in CI (`.github/workflows/agenthub-ci.yml`) |
| Protocol test coverage    | Every crypto primitive used in Seal, Tree, and Crowd modes must have at least one test covering key generation, encrypt, and decrypt         | Test run passes before merge                                    |
| Feature-flag gating       | Experimental UI features (polls, threads, forums, etc.) must be gated behind a flag from `featureFlags.ts` and must not affect the E2EE path | Flag-off state tested alongside flag-on state                   |
