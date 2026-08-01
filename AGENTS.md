# AGENTS.md

## Repository map

- Production entry: `index.html -> src/main.tsx -> src/App.tsx`.
- Prefer `src/`; root `App.tsx` and `index.tsx` are not the Vite entrypoint.
- In-app network engine: `src/native/`.
- Runtime mutation switch point: `src/hooks/runtime/useRuntimeMutations.ts`.
- Legacy/interop protocol client: `src/protocol/`.
- Protocol fixtures/tests: `protocol-tests/`; generated output:
  `.generated/protocol-tests/`.
- Native shell: `src-tauri/`.
- Xorein node/runtime is the sibling repository `/home/wenga/src/xorein`.

## Commands

- `npm run dev` - Vite on `0.0.0.0:8080`.
- `npm run lint` - ESLint.
- `npm run typecheck` - app, Node, and test TypeScript projects.
- `npm run build` - app typecheck plus production Vite build.
- `npm test` - one-shot Vitest suite.
- `npm run test:protocol` - strict protocol build plus compiled Node tests.
- `npm run test:browser:all` - browser smoke suite.
- `npm run test:voice:e2e` - real two-context WebRTC/TURN smoke; set
  `VOICE_NODE_ENDPOINT` to a running relay gateway.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml` - native-shell tests.
- `npm run tauri:dev` / `npm run tauri:build` - desktop development/build.
- `npm run release:version -- --check` - verify synchronized app versions.

There is no reason to edit `dist/`, `.generated/`, or generated Tauri schemas by
hand. The checked-in npm scripts and `package-lock.json` are authoritative.

## Conventions and security boundaries

- `@/*` maps to `src/*`.
- Vitest discovers `src/**/*.{test,spec}.{ts,tsx}`; setup is
  `src/test/setup.ts`.
- App TypeScript is intentionally non-strict; protocol TypeScript is strict.
- `src/config/featureFlags.ts` is the feature registry. Unsupported actions stay
  disabled; do not ship local-only UI pretending a network mutation succeeded.
- Components do not bypass the runtime mutation facade.
- Support nodes receive ciphertext and public routing material only. Never send
  identity private keys, recovery passwords, invite capabilities, plaintext
  messages, or local bearer tokens to a remote endpoint.
- A local runtime being alive is not a connected peer path. UI connectivity must
  derive from live transport state.
- Room-size policy may change Tree/Crowd key management, never cipher strength or
  signature requirements. Mode changes require a signed epoch advance.
- User communities are **Spaces**. Infrastructure processes are **Xorein Nodes**.
  Preserve existing wire/storage identifiers such as `server_id` for backward
  compatibility; do not introduce “server” as new user-facing wording.
- The private Xorein control API and browser gateway are separate trust surfaces.
  Web clients use the read-only gateway; native mutation control stays
  loopback/socket-only and bearer-authenticated.
- Preserve unrelated dirty-worktree changes and never reset generated or user
  work blindly.

## Release discipline

- Official source repositories are `cogniloom/harmolyn` and
  `cogniloom/xorein`.
- Release automation consumes `staging`; platform builds must all succeed before
  `staging`, `main`, and the signed tag advance.
- Never make signing optional. Missing updater, Apple, or Windows credentials
  must fail the release.
- Never commit release private keys. Public verification keys belong in source;
  private keys belong in protected CI secrets and offline backup.
