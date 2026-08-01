# Official release process

Harmolyn releases are built by `.github/workflows/release.yml` from the official
`cogniloom/harmolyn` repository.

## One-time repository setup

1. Create `staging` as a fast-forward descendant of `main` and protect both
   branches. Require review and successful CI before changes enter `staging`.
2. Register runners with labels `self-hosted`, `linux`, `x64` and
   `self-hosted`, `macOS`. Windows uses GitHub's `windows-latest` image.
3. Configure these repository secrets:

| Secret | Exact expected value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Entire private-key text emitted by `npm exec tauri signer generate`; preserve its header/base64 formatting as one GitHub secret value |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Non-empty password supplied to that generator and kept in a separate offline backup |
| `APPLE_CERTIFICATE` | Base64 of a Developer ID Application certificate plus private key exported together as one `.p12`/PKCS#12 file |
| `APPLE_CERTIFICATE_PASSWORD` | Export password of that `.p12` file |
| `APPLE_SIGNING_IDENTITY` | Exact Keychain identity name, normally `Developer ID Application: Legal Name (TEAMID)` |
| `APPLE_ID` | Apple Account email authorized for notarization |
| `APPLE_PASSWORD` | Apple app-specific password, not the normal account password |
| `APPLE_TEAM_ID` | Ten-character Apple Developer Team ID owning the certificate |
| `WINDOWS_CERTIFICATE` | Base64 of an Authenticode code-signing certificate plus private key exported as one `.pfx`/PKCS#12 file |
| `WINDOWS_CERTIFICATE_PASSWORD` | Export password of that `.pfx` file |

Keep an offline backup of the updater private key and password. Losing it means
existing clients cannot trust artifacts signed by a replacement key without a
separately authenticated migration release.

The public key in `src-tauri/tauri.conf.json` must match
`TAURI_SIGNING_PRIVATE_KEY`. Do not regenerate either key during a release and
do not wrap base64 certificate values in shell quotes or JSON.

## Dispatch

Run **Promote staging and release** and choose one version operation:

- `stable`: remove the prerelease suffix, for example `1.0.0-rc.1 -> 1.0.0`.
- `patch`: increment patch.
- `minor`: increment minor and reset patch.
- `major`: increment major and reset minor/patch.

The workflow then:

1. Fails before checkout if any signing credential is absent.
2. Verifies `staging` is a fast-forward descendant of `main`.
3. Synchronizes npm, Cargo, and Tauri versions and pins the resulting Git tree.
4. Runs lint, all TypeScript/Vitest/protocol tests, a real Chromium production
   smoke, the production build, and Rust tests on the Linux runner.
5. Reproduces that exact tree and builds signed Linux, universal macOS, and
   Windows packages. macOS is notarized; Windows is Authenticode-signed.
6. Generates Tauri updater metadata from the completed platform artifacts.
7. Rechecks that neither `main` nor `staging` moved, creates the release commit,
   and atomically advances `staging`, `main`, and the annotated tag.
8. Uploads a draft GitHub release and publishes it only after every asset is
   present.

Failed validation/build jobs do not leave a version-only commit on `staging`.

## Update trust boundary

`src-tauri/tauri.conf.json` pins the updater public key and the official GitHub
`latest.json` endpoint. The client verifies the signature attached to the
platform updater archive before installation. Installation replaces application
files only; identities, IndexedDB, local preferences, and Xorein data directories
are outside the bundle path.

Do not publish unsigned fallback assets and do not change the updater key merely
to recover from a missing CI secret.
