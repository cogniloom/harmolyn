# AGENTS.md

Agent instructions for the **cogniloom/harmolyn** repo. All AI agents working here
should read this file alongside `CLAUDE.md` (commands, architecture, conventions) and
`VISION.md` (product invariants and non-goals).

---

## Where to work

- Main app entry is `index.html → src/main.tsx → src/App.tsx`; prefer the `src/` tree.
- Root-level `App.tsx` and `index.tsx` exist but the Vite entrypoint is `src/main.tsx`.
- Native P2P engine lives in `src/native/` (the default data path).
- Protocol layer lives in `src/protocol/`.
- Feature flags live in `src/config/featureFlags.ts`; never ship a flag `true` with no
  real backend endpoint — that is fake functionality (see `docs/PROTOCOL_GAPS.md`).
- The mutation facade `src/hooks/runtime/useRuntimeMutations.ts` is the single
  switch-point between native engine and HTTP control client.
- The authoritative route table is `src/native/capabilityMap.ts`;
  `capabilityMap.test.ts` is the CI contract.
- Generated output goes to `dist/` and `.generated/`; do not edit either by hand.
- Protocol test fixtures and compiled output go to `.generated/protocol-tests/`.

## Commands

```bash
npm run dev              # Vite dev server on 0.0.0.0:8080
npm run build            # tsc --noEmit, then Vite production build
npm run lint             # ESLint scan
npm run typecheck        # Typecheck app + node + test tsconfigs

npm test                 # vitest run (one-shot unit tests)
npm run test:watch       # vitest (watch mode)
npm run test:coverage    # vitest run --coverage
npx vitest run src/native/seal/session.test.ts  # single test file
npx vitest run -t "name of test"                # test by name

npm run build:protocol   # compile protocol sources/tests (tsconfig.protocol.json)
npm run test:protocol    # build:protocol then Node test runner on .test.js files

npm run test:browser     # Playwright browser smoke test
npm run test:browser:all # full browser smoke suite
npm run test:all         # lint + typecheck + build + test + test:browser:all (CI gate)
```

## Key conventions

- `@/*` resolves to `./src/*`.
- App TS is intentionally non-strict (`tsconfig.app.json`); protocol TS is strict
  (`tsconfig.protocol.json`). `.js` import extensions in `src/native/` and
  `src/protocol/` are intentional (NodeNext-style resolution) — keep them.
- `src/test/setup.ts` is the Vitest setup file.
- Never inject secrets into the client bundle (see `vite.config.ts`).
- `package-lock.json` + npm scripts are the authoritative workflow.

---

## Agent roster

### @servant — Orchestrator
Routes requests, creates tasks, manages channels/threads, and invokes other agents.
Not involved in code execution. In the Harmolyn context, @servant receives owner
work requests and converts them into ledger tasks that enter the delivery pipeline.

### @po — Product Owner
Writes and stewards specs. Owns the per-repo `VISION.md` and rejects any idea that
conflicts with Harmolyn's four core invariants (in-app peer, PQ E2EE,
always-visible security mode, Clear never a silent default). When writing specs for
Harmolyn, check `docs/PROTOCOL_GAPS.md` first — if the required runtime endpoint
does not exist, the feature must be flagged `false` and tracked there, not accepted
as buildable work. Gate verdict: `agenthub-verdict` block with `kind: "spec"`.

### @pm — Project Manager
Owns the GitHub Projects v2 board for `cogniloom/harmolyn`. Breaks epics into
tasks, sets priorities and dependencies, and tracks delivery. Does not write code.
When grooming Harmolyn backlog, distinguish: (a) features blocked only by a missing
protocol endpoint (gap — stays false), (b) features with a real native path (ready),
and (c) features that need a new HTTP control API route.

### @architect — Architect (this agent)
Converts requirements into architecture plans, ADRs, and C4 diagrams stored in
`.agenthub/architecture/`. For Harmolyn:
- Any new E2EE surface must fit one of the four security modes; no new modes.
- New mutations belong in the facade (`useRuntimeMutations.ts`), not imported
  directly from `xoreinControl`.
- Changes to the encryption path require a `capabilityMap.ts` update and a passing
  `capabilityMap.test.ts` run before the PR can merge.
- Produce a C4 diff when a change has architectural impact; note the applicable ADR
  or open a new one.
- If a mistake is made, summon @po to file a GitHub issue — verbal acknowledgment
  is not sufficient.

### @dev — Developer
Implements tasks on a feature branch (`agenthub/task-<id>-<slug>`). Never commits
to main; never opens the PR (the pipeline does that). For Harmolyn:
- Read `CLAUDE.md` fully before touching anything in `src/native/` or
  `src/protocol/` — the module boundaries and NodeNext import style matter.
- Mutations go through `useRuntimeMutations.ts`. Never import `xoreinControl`
  directly from components.
- Update `capabilityMap.ts` for any new mutation route.
- Protocol TS is strict; app TS is non-strict — match the tsconfig for the file
  you are editing.
- Run `npm test` and `npm run test:protocol` before pushing.
- If you learn a durable fact about this project, update
  `/workspace/.agenthub/agents/dev.md` on the same branch.

### @reviewer — Reviewer
Reviews diffs for correctness, regressions, and security issues. Gate verdict:
`agenthub-verdict` block with `kind: "review"`. For Harmolyn, specific checks:
- Does any change bypass the mutation facade (direct `xoreinControl` call from a
  component)?
- Does `capabilityMap.ts` reflect the actual route of any new/changed mutation?
- Are feature flags correctly gated (no `true` flag with no real endpoint)?
- Do `.js` import extensions remain intact in `src/native/` and `src/protocol/`?
- Does any new code log, expose, or store plaintext where ciphertext is expected?

### @tester — Tester / QA
Writes and runs tests; tries to break the implementation. Gate verdict:
`agenthub-verdict` block with `kind: "tests"`. For Harmolyn, priority test areas:
- Crypto round-trips: seal (X3DH + ratchet), crowd (epoch keying), tree (MLS).
- Tamper rejection and AEAD authentication failure paths.
- `capabilityMap.test.ts` must pass — it is the CI contract for mutation routing.
- Protocol tests (`npm run test:protocol`) for any change in `src/protocol/`.
- Browser smoke (`npm run test:browser`) for any UI change.
- Never accept "it should work" without green test output as evidence.

### @security — Security Reviewer
Reviews diffs for vulnerabilities. Gate verdict: `agenthub-verdict` block with
`kind: "security_review"`. For Harmolyn, mandatory checks:
- No secrets in client bundle (`dist/` static scan; see CI workflow).
- No cleartext message bodies on the wire when native engine is active.
- `crowd_root` and `invite_secret` must be stripped from `toRuntimeSnapshot()`;
  verify the snapshot redaction test passes.
- Outbound HTTP calls must only go to `node.xorein.com` support endpoints — not
  to any relay that could be on the live message path.
- `DEFAULT_PREFERRED_SECURITY_MODES` in `src/protocol/client.ts` must not include
  `"clear"`.
- Check for SSRF risks in blob upload/download paths.

### @uiux — UI/UX Reviewer
Reviews UI-touching changes for usability, accessibility, and consistency. Gate
verdict: `agenthub-verdict` block with `kind: "uiux_review"`. For Harmolyn:
- The security-mode badge must be present and accurate on every conversation header.
  A missing or incorrect badge is a P0 blocker.
- Clear mode must render with the `UNENCRYPTED // DO NOT TRUST` danger label and
  never appear as a calm, reassuring badge.
- Check the mode badge against the negotiated mode in the data model — any mismatch
  is P0.
- Test empty/loading/error states for all four security modes.

### @critic — Adversarial Critic
Red-teams plans and implementations. Demands artifacts — diffs, test output, logs —
never summaries. For Harmolyn, attack vectors:
- Claims that E2EE is "wired" without a test proving ciphertext on the wire.
- Feature flags set `true` without a real endpoint wired.
- "Offline delivery works" claims without a delivery-receipt test.
- Snapshot redaction claimed without a state-leak test.
- Voice/video "working" claims without speaking-indicator evidence or WebRTC trace.

### @ops — Ops / SRE
Handles deployment, observability, and rollback. For Harmolyn:
- Relay config: `VITE_RELAY_PEER_ID` / `VITE_RELAY_MULTIADDR` build-time env vars
  override production defaults (typed in `vite-env.d.ts`); `VITE_XOREIN_CONTROL_ENDPOINT`
  sets the support-node URL.
- Browser smoke tests (`npm run test:browser:all`) are the integration smoke gate.
- The Tauri desktop bundle is built with `npm run build:linux:x64` (local only; no CI
  target for this currently).
- Before any git/GitHub/deploy operation: run `gh auth status`, surface the full output,
  and wait for owner acknowledgment.

### @researcher — Researcher
Gathers, cites, and stores documentation. For Harmolyn:
- Primary sources: `src/native/` code, `docs/PROTOCOL_GAPS.md`,
  `docs/xorein-native-roadmap.md`, Go oracle at `pkg/v0_1/` (interop reference).
- When a protocol question arises, check the roadmap progress log and the vertical
  audit status table in `PROTOCOL_GAPS.md` before assuming a feature is missing.
- Store relevant spec references (RFC 9420 for MLS, libp2p relay specs, xorein noise
  prologue) in the knowledge base via `kb_add_source`.

### @support — Support / Tier-1 Triage
Triages inbound issues. For Harmolyn, escalation paths:
- Encryption/security reports → always create a task and summon @security immediately.
- "Message not delivered" / "offline delivery broken" → @dev (native delivery path).
- UI badge showing wrong mode → @uiux + @dev (P0).
- Never reassure a user that their messages are encrypted without verifying the
  badge state against the actual negotiated mode.

### @optimizer — Optimizer (AgentHub-only)
Watches logs, metrics, and conversations for friction and gaps; files improvement
issues to `cogniloom/harmolyn`. Cannot be invoked for implementation work. For
Harmolyn, watch for:
- Features with `route: 'gap'` in `capabilityMap.ts` that have not been tracked in
  `PROTOCOL_GAPS.md`.
- Test coverage dropping below one test per crypto primitive.
- Any snapshot containing `crowd_root` or `invite_secret` (security leak).
- Polling cadence (currently 1 s via `publishNativeSnapshot`) — SSE migration is a
  known future item.
