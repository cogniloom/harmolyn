<div align="center">
  <h1>Harmolyn</h1>
  <p><b>Advanced chat client</b> for the <b>xorein</b> network — Discord-like UX with explicit, verifiable security modes.</p>

  <p>
    <img alt="status" src="https://img.shields.io/badge/status-active-blue" />
    <img alt="protocol" src="https://img.shields.io/badge/protocol-xorein-black" />
    <img alt="security" src="https://img.shields.io/badge/security-explicit%20modes%20%2B%20E2EE-success" />
    <img alt="local-api" src="https://img.shields.io/badge/local%20API-local--only%20transport-important" />
  </p>

  <p>
    <a href="https://github.com/kylhuk/harmolyn/releases"><img alt="release" src="https://img.shields.io/github/v/release/kylhuk/harmolyn?display_name=tag&sort=semver" /></a>
    <a href="https://github.com/kylhuk/harmolyn/releases"><img alt="downloads" src="https://img.shields.io/github/downloads/kylhuk/harmolyn/total" /></a>
    <a href="https://github.com/kylhuk/harmolyn/actions"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/kylhuk/harmolyn/ci.yml" /></a>
    <a href="https://github.com/kylhuk/harmolyn/security"><img alt="security-policy" src="https://img.shields.io/badge/security-policy-blue" /></a>
    <a href="https://opensource.org/licenses/AGPL-3.0"><img alt="license" src="https://img.shields.io/github/license/kylhuk/harmolyn" /></a>
  </p>

  <p>
    <a href="https://github.com/kylhuk/harmolyn/blob/main/README.md#security-model">Security</a> ·
    <a href="https://github.com/kylhuk/harmolyn/blob/main/README.md#what-e2ee-can-and-cannot-do">Limits</a> ·
    <a href="https://github.com/kylhuk/harmolyn/blob/main/README.md#verification">Verification</a> ·
    <a href="https://github.com/kylhuk/xorein">xorein protocol</a>
  </p>
</div>

---

## What Harmolyn is

Harmolyn is a **batteries-included xorein peer** — the full protocol (hybrid
post-quantum identity, Seal/Crowd E2EE, and the P2P families) runs **inside the
app itself**, including in the browser. There is no sidecar to install.

- The UI and the network engine are both Harmolyn (`src/native/`).
- Peer-to-peer links are established with **libp2p Noise** end-to-end to the
  target peer; message bodies are additionally **E2E-encrypted at the
  application layer** (Seal X3DH+Double-Ratchet for DMs, Crowd sender-key
  broadcast for channels) so neither the relay nor any other peer reads them.
- The hosted node (`node.xorein.com`) is an **untrusted support service** reached
  over WSS: libp2p **circuit relay + bootstrap** for first contact, an opaque
  store-and-forward mailbox, and blob/identity-backup storage. It is not the
  engine and is not trusted for plaintext.

> Status / honesty note: the in-app engine is the default data path
> (`nativeEngine: true`). A subset of operations (identity backup/restore,
> moderation/roles, notifications, file uploads, voice frames) still use the
> support node's HTTP control API; those are being migrated. See
> `docs/PROTOCOL_GAPS.md` and `docs/xorein-native-roadmap.md` for the precise,
> current wiring state — including which features are real vs. still gated off.

If you care about *how* it works, Harmolyn is for you: the UI surfaces real
security state (mode, coverage, retention) instead of hiding it behind marketing
words.

---

## Key features (end-user, power-user friendly)

- **Explicit security modes per conversation surface** (no silent E2EE “toggle”)
- **E2EE by default where it makes sense**, and **Clear** mode must be labeled
- **Coverage labels** for search and history (Full / Partial / Empty)
- **Retention-aware history** (no pretending history is “infinite”)
- **Runs on a P2P network**; relays help reliability but are not trusted for plaintext
- **Signed + reproducible release artifacts** (verify what you run)

---

## Security model

Every conversation shows a badge in the header:

- **Seal** — 1:1 E2EE (X3DH + Double Ratchet)
- **Tree** — small-group E2EE (MLS)
- **Crowd / Channel** — large-scale E2EE using epoch rotation (revocation happens on rotation)
- **Clear** — readable by infrastructure (explicitly labeled; not default for private spaces)

Tap the badge to see:
- the mode name,
- algorithm family,
- whether history is locked across epochs,
- search coverage label,
- connection type (direct vs relay).

---

## What E2EE can and cannot do

E2EE protects **content** (message bodies, attachments; media where supported). It does not magically remove:
- metadata (who/when/where routing),
- endpoint compromise risk,
- usability trade-offs (e.g., server-side full-text search is not available in strict E2EE chats).

Harmolyn shows this honestly in the UI via labels instead of burying it in docs.

---

## Quick start

1) Install from Releases  
- Download Harmolyn (and the bundled xorein runtime if your build ships them together).

2) First launch  
- Create your identity.
- Make an encrypted backup (recommended immediately).

3) Connect  
- Add a friend via key / QR / deep link, or join a space via invite.

## Choosing a node

On first launch Harmolyn opens a node picker before the main UI. Enter a trusted local control endpoint such as `http://127.0.0.1:7711`, or use the bundled default node if your build provides one.

- The chosen endpoint is remembered for the next launch.
- You can reopen the picker from `Settings -> Network -> Switch Node`.
- The app only accepts loopback endpoints or the preconfigured public endpoint baked into the build.

---

## Verification

Harmolyn releases ship with:
- checksums,
- code signatures **when signing secrets are configured** (the release workflow
  otherwise produces unsigned artifacts — see Releasing below),
- a release manifest recording build inputs.

Note: bit-for-bit reproducible builds are a goal, not yet a guarantee — the
manifest currently records a build timestamp and the updater public key must be
configured before updater signatures verify. Verify checksums/signatures before
running if you’re strict about supply chain.

## Local build

To build Harmolyn for Linux x64 on your machine, run:

```bash
npm run build:linux:x64
```

This produces the local Tauri bundles for `x86_64-unknown-linux-gnu` without using GitHub Actions.

---

## FAQ (short)

**Can the network read my DMs?**  
No in Seal mode (E2EE). The network can still see unavoidable routing metadata.

**Why does search say “Partial”?**  
Because E2EE prevents plaintext server-side indexing. “Partial” means your device searched only the history it currently has access to.

**Can I run my own relay?**  
Yes — xorein can run in relay/bootstrap modes. Harmolyn stays a client.

---

## Releasing

Releases are created automatically by pushing a semver tag:

```bash
git tag v1.2.3 && git push origin v1.2.3
```

This triggers `.github/workflows/release.yml` which builds signed installers for Linux (`.deb`, `.AppImage`), macOS (`.dmg`), and Windows (`.msi`, `.exe`), then publishes a GitHub Release with auto-generated notes.

**Required GitHub repository secrets:**

| Secret | Purpose |
|--------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | Updater bundle signing key (generate: `npx tauri signer generate`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the above key |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application certificate (macOS signing) |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the certificate |
| `APPLE_SIGNING_IDENTITY` | Developer ID string (e.g. `Developer ID Application: Your Name (TEAMID)`) |
| `APPLE_ID` | Apple ID email (notarization) |
| `APPLE_PASSWORD` | App-specific password (notarization) |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `WINDOWS_CERTIFICATE` | Base64-encoded Windows code-signing certificate (optional) |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the Windows certificate |

If signing secrets are absent the workflow still produces unsigned artifacts.

To update the updater public key in `src-tauri/tauri.conf.json`, run `npx tauri signer generate` once and paste the public key into the `plugins.updater.pubkey` field.

**Icons:** Replace the placeholder files in `src-tauri/icons/` with real icons. Run `npx tauri icon path/to/your-icon-1024.png` to auto-generate all required sizes from a single source image.

---

## License

- Runtime/client code: **AGPL-3.0** (see LICENSE)
- Protocol/spec text: **CC-BY-SA 4.0** (see spec files)
