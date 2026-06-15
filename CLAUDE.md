# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Harmolyn is an end-user chat client for the **xorein** P2P network — Discord-like UX with explicit, verifiable security modes.

**Target architecture (in progress):** Harmolyn is a *batteries-included* xorein peer that runs the full protocol — networking, hybrid post-quantum E2EE, and the protocol families — directly in the app, including in the browser. There is no sidecar and no per-user node to install or manage. The hosted web app — a full in-browser peer, not a thin client — is served at `https://web.harmolyn.com`.

The hosted xorein node (`https://node.xorein.com`) is a *support service only*, not the engine:
- **Bootstrap / first contact** — a libp2p relay + rendezvous so a fresh client that has never reached any peer can join the P2P network.
- **Blob storage** — files and avatars, which are impractical to host on the pure P2P network.

**Current reality:** the native P2P engine (`src/native/`) is now the default (`nativeEngine: true` in featureFlags.ts). Message/server/channel mutations route through the native engine; the HTTP client (`src/lib/xoreinControl.ts`) handles the support-service role only: identity backup/restore, role creation/assignment, moderation actions, notification queries, file uploads (gated off via `fileUploads: false`), and raw voice frames. The mutation facade (`src/hooks/runtime/useRuntimeMutations.ts`) is the single switch-point. The authoritative route table is `src/native/capabilityMap.ts`; `capabilityMap.test.ts` is the CI contract check. The Tauri sidecar binary (`src-tauri/binaries/`) remains bundled for desktop builds but is not on the default data path.

## Commands

```bash
npm run dev              # Vite dev server on 0.0.0.0:8080
npm run build            # tsc -p tsconfig.app.json --noEmit, then Vite production build
npm run lint             # ESLint scan
npm run typecheck        # Typecheck app + node + test tsconfigs (no build)

# Unit tests (Vitest) — picks up src/**/*.{test,spec}.{ts,tsx}, see src/test/setup.ts
npm test                 # vitest run (one-shot)
npm run test:watch       # vitest (watch mode)
npm run test:coverage    # vitest run --coverage
npx vitest run src/native/seal/session.test.ts   # run a single test file
npx vitest run -t "name of test"                 # run tests matching a name

# Protocol tests (separate toolchain — compiled to .generated/, run under Node, NOT Vitest)
npm run build:protocol   # Compile protocol sources/tests with tsconfig.protocol.json
npm run test:protocol    # build:protocol, then Node test runner on compiled .test.js

# Browser / integration smoke (Playwright-driven, see scripts/)
npm run test:browser     # Browser smoke test
npm run test:browser:all # Full browser smoke suite
npm run test:browser:transport  # Native libp2p transport test
npm run test:voice:e2e   # Voice end-to-end test

npm run test:all         # lint + typecheck + build + test + test:browser:all (CI gate)

# Desktop (Tauri)
npm run tauri:dev        # Tauri dev shell
npm run build:linux:x64  # Local Tauri bundle for x86_64-unknown-linux-gnu (no CI)
```

`dist/` and `.generated/` are generated; do not edit them by hand.

## Architecture

The stack is layered:

```
UI Layer         src/components/        React components
Application      src/hooks/, data.ts    React Query, local state, polling (1s)
Mutation facade  src/hooks/runtime/useRuntimeMutations.ts  single switch-point: native engine vs. HTTP control
Native engine    src/native/            in-app P2P engine — the default data path (nativeEngine: true)
Protocol         src/protocol/          XoreinClient, capability negotiation, security modes
Control API      src/lib/xoreinControl.ts  REST client to the support node (bootstrap/relay + blob storage); now support-role only
```

**Entry point:** `index.html → src/main.tsx → src/App.tsx`. Root-level `App.tsx` and `index.tsx` exist but are not the Vite entrypoint.

### Native engine (`src/native/`) — the default data path

This is where the full xorein protocol runs in-app (no sidecar). `engine/engine.ts` (`XoreinNativeEngine`) is the unified API over a set of protocol subsystems, each its own folder:

- `identity/` — hybrid PQ identity (Ed25519+ML-DSA-65), certs, encrypted-at-rest storage (guest = sessionStorage, registered = Argon2id password + IndexedDB)
- `crypto/` — hybrid (X25519+ML-KEM-768 / Ed25519+ML-DSA-65) sign/verify/KEM primitives; ciphersuite `0xFF01`
- `seal/` — 1:1 E2EE: X3DH prekey bundles + Double Ratchet (`session.ts`, `ratchet.ts`, `bundle.ts`, `persist.ts`)
- `tree/` — small-group E2EE (MLS-style, epoch-keyed AES-128-GCM)
- `crowd/` — large-scale channel E2EE with sender keys / epoch rotation (ChaCha20-Poly1305; `channel.ts`)
- `voice/` — MediaShield SFrame E2EE (`mediashield.ts`, AES-128-GCM per frame) + WebRTC voice sessions
- `transport/` — js-libp2p node (`node.ts`), transport manager with multi-relay failover (`manager.ts`), relay resolver (`relays.ts`), Noise prologue (`prologue.ts`), backoff
- `delivery/` — zero-knowledge mailbox (pairwise-blinded tokens, `offline.ts`), store-and-forward + drain
- `sync/` — peer sync, invite authorization (`invite.ts`), inbound handlers, secure envelopes (`secureEnvelope.ts`), registry
- `families/` — PeerStream protobuf framing (`peerstream.ts`, 4-byte length prefix), presence, friends, typing
- `blobs/` — client-side AES-256-GCM blob encryption before upload; content-addressed SHA-256 integrity
- `recovery/` — identity + session recovery flows
- `state/` — the native store, snapshot publisher (`toRuntimeSnapshot` strips `crowd_root`/`invite_secret`), and `mutations.ts` (all `nativeXxx` mutation impls)
- `capabilityMap.ts` — authoritative route table (native / native-local / http / mixed / gap) for every mutation; `capabilityMap.test.ts` is the CI contract check

**The mutation facade is the contract.** `src/hooks/runtime/useRuntimeMutations.ts` is the single place that decides, per operation, whether to call the native engine (`nativeXxx` from `state/mutations.ts`) or fall through to the HTTP control client (`xoreinControl.ts`). Add or change a data mutation *here*, not by importing `xoreinControl` directly from components. Operations still on the HTTP path (see `capabilityMap.ts` for the full, authoritative list): identity backup/restore, role creation/assignment, moderation actions (kick/ban/mute), notification queries, file uploads (gated off), and raw voice frames. Pins, reactions, presence, server CRUD, friends requests, and voice signaling are all native P2P.

**Snapshot ownership:** when the native engine is active it is the *sole* writer of the runtime snapshot (gated by the `__HARMOLYN_NATIVE_ACTIVE__` flag); UI reads via `useRuntimeSnapshot` / `xoreinRuntimeContext`. See `docs/PROTOCOL_GAPS.md` and `docs/xorein-native-roadmap.md` for which features are real vs. still gated off.

### Protocol layer (`src/protocol/`)

- `client.ts` — `XoreinClient` with pluggable `XoreinTransport` interface; `DEFAULT_PREFERRED_SECURITY_MODES = ["seal", "tree"]` (clear excluded)
- `capabilities.ts` — feature negotiation between client and runtime
- `manifest.ts` — manifest validation with SHA256 digests
- `deeplink.ts` — invite/join URL parsing (also `nativeDeepLink.ts` for native-engine join)
- `featureBridge.ts` — maps protocol capability flags to `featureFlags.ts` toggles
- `backoff.ts` — reconnection backoff
- `protocolId.ts` — protocol version parsing
- `url.ts` — canonical URL helpers

Protocol TypeScript is **strict** (`tsconfig.protocol.json`). App TypeScript is intentionally **non-strict** (`tsconfig.app.json`) to allow rapid UI iteration.

### Feature flags (`src/config/featureFlags.ts`)

~90 toggles (`FEATURES` object) covering auth, messaging, voice, monetization, and moderation. Runtime overrides via `localStorage` key `harmolyn:feature-overrides`. Use the `useFeature` hook to read flags in components. This is the single source of truth for staged rollouts and A/B tests. **Rule (stated in the file header):** never ship a flag `true` if its actions can only mutate `localStorage` with no backing runtime endpoint — that is fake functionality; such flags stay `false` and are tracked in `docs/PROTOCOL_GAPS.md`.

### Security modes

Every conversation surface carries one of four explicit modes (surfaced as a badge in the UI):
- **Seal** — 1:1 E2EE (X3DH + Double Ratchet)
- **Tree** — small-group E2EE (MLS)
- **Crowd / Channel** — large-scale E2EE with epoch rotation
- **Clear** — readable by infrastructure (explicitly labeled, never the default for private spaces)

## Conventions

- `@/*` resolves to `./src/*`
- Never inject secrets into the client bundle (see `vite.config.ts`)
- `package-lock.json` + npm scripts are the authoritative workflow (the older `bun.lockb` is gone)
- Protocol tests compile to `.generated/protocol-tests/` and run via Node (not Vitest)
- App TS is non-strict (`tsconfig.app.json`); protocol TS is strict (`tsconfig.protocol.json`). `.js` import extensions in `src/native/` and `src/protocol/` are intentional (NodeNext-style resolution) — keep them.
