# Dependency maintenance — 2026-09-06

Both npm lockfiles and the Rust lockfile are regenerated against the package
registries, then validated with clean installs. CI uses Node 26. All direct npm
dependencies are on the registry's current stable release except the intentional
compatibility constraints below. This is not an independent security audit.

## Compatibility constraints

- The application retains Tailwind CSS 3.4.19. Tailwind 4's CSS runtime requires
  Safari 16.4+, Chromium 111+ or Firefox 128+; the native application still declares
  a macOS 11 minimum. The independent marketing website uses current Tailwind 4.
- TypeScript stays on the latest 6.0 patch accepted by current typescript-eslint
  (its peer range is below 6.1). Installing TypeScript 7 would violate that peer
  contract. Do not hide the conflict with force or legacy-peer-deps.
- Rust dependencies retain their reviewed major versions; cargo update refreshes
  compatible transitive versions without changing protocol or signing semantics.

Sources: registry metadata retained in the dependency-refresh Actions artifacts;
https://tailwindcss.com/docs/upgrade-guide#browser-requirements

## Unpatched, non-browser dependency finding

npm audit still identifies image-size and its Metro dependents as high severity.
The dependency path is @libp2p/webrtc → react-native-webrtc → react-native → Metro
→ image-size. Every published image-size release is currently within the affected
range; do not claim an override to 2.0.2 fixes it, or invent an unpublished 2.0.3.
Harmolyn is a browser/Tauri frontend, not a React Native/Metro application.
The production build checks rendered chunk module identities and fails if
image-size, Metro, or React Native modules enter any emitted frontend chunk.
The P0 transport debugging page remains development-only rather than being
included in distributable bundles.

This reduces shipped exposure; it does not remove the vulnerable package from
node_modules or make npm audit clean. Do not process untrusted images through
Metro or enable a React Native build until the dependency is replaced or patched.
The brace-expansion and selector-parser advisories are handled by compatible
transitive overrides and verified lockfile resolution.

Advisories:
https://github.com/advisories/GHSA-w3rx-r6r6-pgpr
https://github.com/advisories/GHSA-5p2g-fcmc-qvqq

## Release assurance

Keep clean install, lint, TypeScript, application/website build, protocol vectors,
unit tests, production browser smoke, and native tests blocking. Browser checks
are not proof of real-WAN calls, iOS WebView behavior, signed native distribution,
or absence of all information/memory leaks. Cryptographic wire formats and
updater trust roots must not change as part of dependency maintenance.

## Native CI and connection-policy compatibility

The Linux CI job uses the single `self-hosted` label required by the available
runner pool; its observed runners are Linux. Build prerequisites remain inside
the Debian job container. Do not add unavailable labels merely because the
release workflow declares a separate macOS target. A mixed-OS pool sharing this
label would need an explicitly configured Linux runner group before container
jobs can be scheduled reliably.

CI compiles the actual Tauri application with `--debug --no-bundle --no-sign`.
It receives no signing key and publishes no installers or updater artifacts.
The release workflow, checked-in updater public key, HTTPS update endpoint and
mandatory release signing are unchanged. Successful CI is not a signed release.

The native CSP permits HTTP/WS connection schemes because it cannot express
arbitrary private IPv4/IPv6 CIDR ranges. Application-controlled support URLs
still reject credentials in URLs and require HTTPS for public Internet origins;
HTTP is accepted only for validated literal private/loopback addresses. Local
control bearer tokens are not attached to remote browser-gateway requests.
Identity backup/restore remains native-bridge-only. Peer data uses Noise/E2EE,
including on explicitly configured private-network transports. This is not a
claim that plaintext LAN support metadata is confidential, nor that a CSP alone
can prevent all network exfiltration. Use HTTPS on untrusted LANs as well.
