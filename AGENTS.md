# AGENTS.md

## Where to work
- Main app entry is `index.html -> src/main.tsx -> src/App.tsx`; prefer the `src/` tree.
- Root-level `App.tsx` and `index.tsx` exist, but the Vite entrypoint is `src/main.tsx`.
- Protocol code lives in `src/protocol/`; protocol fixtures/tests live in `protocol-tests/`.
- Generated protocol test output goes to `.generated/protocol-tests/`.

## Commands
- `npm run dev` — Vite dev server on `0.0.0.0:8080`.
- `npm run lint` — ESLint for the repo.
- `npm run build` — app typecheck + Vite production build.
- `npm run build:protocol` — compile protocol sources/tests with `tsconfig.protocol.json`.
- `npm run test:protocol` — build protocol code first, then run Node’s test runner on compiled `.test.js` files.
- There is no generic `npm test` or standalone `typecheck` script in `package.json`.

## Conventions
- `@/*` resolves to `./src/*`.
- `src/test/setup.ts` is the Vitest setup file; Vitest only picks up `src/**/*.{test,spec}.{ts,tsx}`.
- `tsconfig.app.json` is intentionally non-strict; protocol TS is strict via `tsconfig.protocol.json`.
- `src/config/featureFlags.ts` is the central feature-toggle registry.
- `vite.config.ts` explicitly warns not to inject secrets into client bundles.
- `dist/` and `.generated/` are generated; do not edit them by hand.

## Notes
- The repo has both `package-lock.json` and `bun.lockb`; the checked-in npm scripts are the authoritative workflow.
