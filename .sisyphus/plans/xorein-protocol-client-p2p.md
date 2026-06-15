# Harmolyn xorein Protocol Integration Plan

## TL;DR
> **Summary**: Wire Harmolyn’s existing UI surfaces to the xorein local control/protocol stack so the client can participate in P2P communication without redesigning the interface. Add verification around protocol compatibility and critical UI actions so every existing control maps to real behavior.
> **Deliverables**:
> - Client protocol bridge + transport/session wiring
> - UI action-to-runtime mapping for all existing controls
> - Compatibility/verification coverage for protocol + interactive flows
> - Clear failure states for offline/no-peer conditions
> **Effort**: Large
> **Parallel**: YES - 3 waves
> **Critical Path**: protocol bridge → shell state integration → action surface wiring → verification

## Context
### Original Request
Harmolyn must communicate on the xorein protocol with the server and other clients in a P2P fashion. Do not change the UI. Make sure all buttons/functions in the UI actually work and do something properly.

### Interview Summary
- Harmolyn already claims a local-only transport to xorein; the plan should wire the existing shell to that runtime rather than redesigning UI.
- xorein already exposes the protocol/runtime surfaces the client needs: local control API, protocol registry/capabilities, manifest/join flow, and peer/relay signaling.
- The current app is still demo-data driven and the protocol layer exists but is not visibly wired into the shell.
- The repo has Vitest and protocol tests, but no browser E2E harness, so the plan must add browser-level verification for critical user journeys.

### Metis Review (gaps addressed)
- Tightened scope to client-only Harmolyn behavior; no relay/bootstrap/server-role expansion.
- Allowed wiring/loading/error/disabled states as implementation necessities while preserving layout and visual structure.
- Defined the user-visible contract as `UI surface → xorein interaction → failure mode → verification method`.
- Defaulted offline/no-peer behavior to explicit failure states plus disabled actions, and defaulted shared state to protocol events plus local snapshot/cache.

## Work Objectives
### Core Objective
Make the existing Harmolyn client shell talk to xorein through the local control/protocol boundary and ensure every existing UI action is backed by a real runtime/protocol behavior.

### Deliverables
- Protocol bridge wired into the visible client shell
- Real connection/session state instead of demo data
- Functional action handlers for the existing UI surfaces
- QA evidence for protocol compatibility and critical flows

### Definition of Done (verifiable conditions with commands)
- `npm run lint` passes
- `npm run build` passes
- `npm run test:protocol` passes
- Browser/interactive QA evidence exists for critical UI journeys
- Every existing major control maps to a documented xorein action or an explicit disabled/error state

### Must Have
- No visual redesign
- Client-only Harmolyn role
- Additive protocol compatibility only unless backend docs require otherwise
- Clear failure states when peer/relay connectivity is unavailable

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- No new UI surfaces just to satisfy backend plumbing
- No protocol-breaking xorein changes without explicit evidence
- No invented behavior for buttons that lacks a backend/runtime meaning
- No burying connection failures behind silent no-ops

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: extend existing Vitest/protocol coverage + add browser-level interactive verification for critical user flows
- QA policy: Every task includes agent-executed happy-path and failure-path scenarios
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.

Wave 1: protocol bridge foundation, shell state source-of-truth, connection/bootstrap adapter
Wave 2: core user actions (chat, friends, server/channel actions, join/create/discover)
Wave 3: settings/voice/advanced actions, error states, verification harness and full-flow QA

### Dependency Matrix (full, all tasks)
1 → 2, 3, 4, 5, 6, 7, 8, 9, 10
2 → 4, 5, 6, 7, 8, 9, 10
3 → 4, 5, 6, 7, 8, 9, 10
4 → 10
5 → 10
6 → 10
7 → 10
8 → 10
9 → 10

Notes:
- Tasks 4-9 can proceed in parallel once the bridge/shell/connectivity foundation is in place.
- Task 10 is intentionally last because it must verify the final integrated UI flows.

### Agent Dispatch Summary (wave → task count → categories)
Wave 1 → 3 tasks → `deep`, `deep`, `deep`
Wave 2 → 3 tasks → `deep`, `deep`, `deep`
Wave 3 → 4 tasks → `unspecified-high`, `unspecified-high`, `unspecified-high`, `unspecified-high`

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Build the xorein client bridge

  **What to do**: Implement the real Harmolyn ↔ xorein client boundary in `src/protocol/client.ts` so handshake, manifest validation, capability negotiation, deeplink join, reconnect/backoff, and session snapshot updates all run through the local control/protocol runtime instead of demo stubs.
  **Must NOT do**: Do not alter the UI tree, do not add new protocol roles, and do not introduce any breaking wire change.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: this is the core integration seam and needs protocol/runtime reasoning.
  - Skills: `[]` - Reason: no special skill injection is required.
  - Omitted: `quick` - Reason: the task spans multiple files and protocol semantics.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2-10 | Blocked By: []

  **References**:
  - Pattern: `src/protocol/client.ts` - main transport/session API to wire.
  - Pattern: `src/protocol/featureBridge.ts` - UI feature flags to protocol capability mapping.
  - Pattern: `src/protocol/capabilities.ts`, `src/protocol/manifest.ts`, `src/protocol/deeplink.ts`, `src/protocol/backoff.ts`, `src/protocol/protocolId.ts` - negotiation, validation, join links, reconnect policy.
  - Test: `protocol-tests/client.test.ts`, `protocol-tests/manifest.test.ts` - existing transport/mock and manifest verification patterns.
  - External: `/home/hal9000/docker/xorein/docs/local-control-api-v1.md`, `/home/hal9000/docker/xorein/pkg/node/service.go`, `/home/hal9000/docker/xorein/pkg/node/wire.go`, `/home/hal9000/docker/xorein/pkg/network/runtime.go`, `/home/hal9000/docker/xorein/proto/aether.proto` - canonical local control and wire surfaces.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `connectToServer`/`connectByLink` produce a negotiated session from real transport data, not demo objects.
  - [ ] Invalid manifests, unknown capabilities, and reconnect failures return deterministic errors and never fake a connected session.
  - [ ] Protocol tests cover one successful handshake and one failure path for verification.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Happy path handshake
    Tool: Bash
    Steps: Run the protocol test command for the client bridge and confirm the handshake/manifest suite passes.
    Expected: Negotiation succeeds and the compiled protocol tests are green.
    Evidence: .sisyphus/evidence/task-1-bridge-success.txt

  Scenario: Failure path invalid manifest
    Tool: Bash
    Steps: Run the focused protocol test that feeds an invalid/expired manifest or unsupported capability.
    Expected: The client rejects the session with a deterministic error and no connected snapshot is produced.
    Evidence: .sisyphus/evidence/task-1-bridge-failure.txt
  ```

  **Commit**: YES | Message: `feat(protocol): wire xorein client bridge` | Files: [`src/protocol/*`, `protocol-tests/*`]

- [x] 2. Replace demo shell state

  **What to do**: Move `src/components/Layout.tsx` and the app shell off demo data so the visible rails, chat shell, side panels, and global context menu read from the runtime/session snapshot and update from protocol events.
  **Must NOT do**: Do not redesign the layout or invent new UI navigation.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: this is the top-level client state source-of-truth change.
  - Skills: `[]` - Reason: no special skill injection is required.
  - Omitted: `quick` - Reason: several shell components and shared types are involved.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 4-10 | Blocked By: 1

  **References**:
  - Pattern: `src/components/Layout.tsx` - app orchestrator and state owner.
  - Pattern: `src/types.ts`, `src/data.ts` - current domain model and demo data to remove.
  - Pattern: `src/components/GlobalContextMenu.tsx` - shared menu provider that must stay wired.
  - Pattern: `src/config/featureFlags.ts`, `src/hooks/useFeature.ts` - central UI gating already in place.
  - Pattern: `src/main.tsx`, `src/App.tsx` - boot path into the shell.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Active server/channel/DM state is derived from runtime/session state, not static demo data.
  - [ ] Shell loading and disconnected states render without changing the interface layout.
  - [ ] The app continues to mount from the existing boot chain and the context menu still functions.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Happy path runtime snapshot
    Tool: Playwright
    Steps: Launch the app with a populated runtime snapshot and verify the server rail, channel rail, and chat shell reflect live data.
    Expected: The visible shell matches the runtime snapshot and no demo rows remain.
    Evidence: .sisyphus/evidence/task-2-shell-success.png

  Scenario: Failure path no snapshot
    Tool: Playwright
    Steps: Launch without a connected runtime/session.
    Expected: The shell shows empty/loading/disabled states and never crashes or renders fake demo content.
    Evidence: .sisyphus/evidence/task-2-shell-failure.png
  ```

  **Commit**: YES | Message: `refactor(ui): source shell state from xorein` | Files: [`src/components/Layout.tsx`, `src/types.ts`, `src/data.ts`]

- [x] 3. Add connection lifecycle and offline states

  **What to do**: Wire app startup, connect/disconnect, reconnect, and no-peer/no-relay failure states so the client can surface the real runtime status and disable dependent actions cleanly.
  **Must NOT do**: Do not add new screens or hide failures behind silent no-ops.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: the app-wide connection lifecycle affects every feature surface.
  - Skills: `[]` - Reason: no special skill injection is required.
  - Omitted: `quick` - Reason: startup and fallback behavior are cross-cutting.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 4-10 | Blocked By: 1, 2

  **References**:
  - Pattern: `src/protocol/client.ts` - reconnect/backoff and session lifecycle hooks.
  - Pattern: `src/components/Layout.tsx` - where global enabled/disabled state is visible.
  - Pattern: `src/components/ServerRail.tsx`, `src/components/ChannelRail.tsx` - controls that must reflect connectivity.
  - External: `/home/hal9000/docker/xorein/docs/local-control-api-v1.md`, `/home/hal9000/docker/xorein/pkg/node/service.go`, `/home/hal9000/docker/xorein/pkg/network/runtime.go` - startup/status surfaces.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Connection loss and missing-peer conditions surface a clear failure state in the shell.
  - [ ] Controls that require connectivity become disabled or clearly inapplicable when offline.
  - [ ] Reconnect succeeds without a full app reload when the runtime becomes available again.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Happy path reconnect
    Tool: Playwright
    Steps: Start the app offline, then bring the runtime online and observe reconnect.
    Expected: The shell transitions to connected state without changing layout.
    Evidence: .sisyphus/evidence/task-3-reconnect-success.png

  Scenario: Failure path no peer/relay
    Tool: Playwright
    Steps: Keep the runtime unavailable and attempt a connectivity-dependent action.
    Expected: The action is blocked with an explicit error/disabled state.
    Evidence: .sisyphus/evidence/task-3-reconnect-failure.png
  ```

  **Commit**: YES | Message: `fix(ui): surface xorein connectivity state` | Files: [`src/protocol/client.ts`, `src/components/Layout.tsx`, `src/components/ServerRail.tsx`, `src/components/ChannelRail.tsx`]

- [x] 4. Wire server entry flows

  **What to do**: Connect the server entry surfaces (`ServerRail`, `ServerExplorer`, `CreateServerModal`, `JoinServerModal`) to real xorein join/create/discovery behavior, including invite/deeplink handling and validation.
  **Must NOT do**: Do not add new server-management screens or alter the existing modal flow.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: these flows bridge user intent to network membership state.
  - Skills: `[]` - Reason: no special skill injection is required.
  - Omitted: `quick` - Reason: multiple entry points and validation paths are involved.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 10 | Blocked By: 1, 2, 3

  **References**:
  - Pattern: `src/components/ServerRail.tsx`, `src/components/ServerExplorer.tsx`, `src/components/CreateServerModal.tsx`, `src/components/JoinServerModal.tsx` - entry point controls.
  - Pattern: `src/protocol/deeplink.ts`, `src/protocol/client.ts` - join-by-link and manifest selection.
  - External: `/home/hal9000/docker/xorein/pkg/node/service.go`, `/home/hal9000/docker/xorein/pkg/node/wire.go`, `/home/hal9000/docker/xorein/pkg/network/transport.go` - membership/discovery surfaces.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Create server submits a real create flow and updates the server rail.
  - [ ] Join server and invite/deeplink flows resolve to real membership or a precise validation error.
  - [ ] Explorer/discovery lists real network-backed entries or an explicit empty state.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Happy path create/join
    Tool: Playwright
    Steps: Click Create Server, submit a valid name, then open Join Server with a valid invite/link.
    Expected: The new server appears and the joined membership state updates in the rail.
    Evidence: .sisyphus/evidence/task-4-entry-success.png

  Scenario: Failure path invalid invite
    Tool: Playwright
    Steps: Paste an invalid/expired invite or malformed link into Join Server.
    Expected: Validation error is shown and no membership state changes.
    Evidence: .sisyphus/evidence/task-4-entry-failure.png
  ```

  **Commit**: YES | Message: `feat(ui): wire server entry flows to xorein` | Files: [`src/components/ServerRail.tsx`, `src/components/ServerExplorer.tsx`, `src/components/CreateServerModal.tsx`, `src/components/JoinServerModal.tsx`]

- [x] 5. Wire chat actions

  **What to do**: Connect `ChatArea` message composition and message-level controls to real xorein-backed behavior: send, slash commands, attachments, emoji picker, replies, edits, delete, pins, reactions, threads, forward/copy link, mute user, inbox, search, and jump-to-present/theme/member toggles where they have local meaning.
  **Must NOT do**: Do not invent new composer UX or redesign the chat timeline.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: chat actions are the main interaction surface and need protocol + UI wiring.
  - Skills: `[]` - Reason: no special skill injection is required.
  - Omitted: `quick` - Reason: many action branches and fallbacks exist.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 10 | Blocked By: 1, 2, 3

  **References**:
  - Pattern: `src/components/ChatArea.tsx` - primary chat action surface.
  - Pattern: `src/protocol/client.ts` - outbound message/session operations.
  - External: `/home/hal9000/docker/xorein/pkg/node/wire.go`, `/home/hal9000/docker/xorein/pkg/v02/dmtransport/contracts.go`, `/home/hal9000/docker/xorein/pkg/v02/dmqueue/contracts.go`, `/home/hal9000/docker/xorein/proto/aether.proto` - message and delivery contracts.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Send/edit/delete/reply/react/pin/forward/copy-link actions all invoke real behavior or deterministic local-state behavior.
  - [ ] Attachment and slash-command paths surface success and failure states instead of stubs.
  - [ ] Search/jump/member-toggle/theme-seed controls continue to work with live state.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Happy path send and react
    Tool: Playwright
    Steps: Type a message in the composer, send it, then add a reaction and copy the link.
    Expected: The message appears in the timeline and the interaction updates state visibly.
    Evidence: .sisyphus/evidence/task-5-chat-success.png

  Scenario: Failure path attachment or offline send
    Tool: Playwright
    Steps: Attempt to send an attachment or message while the runtime is offline.
    Expected: The UI shows a clear error or disabled action and does not lose the draft.
    Evidence: .sisyphus/evidence/task-5-chat-failure.png
  ```

  **Commit**: YES | Message: `feat(chat): wire message actions to xorein` | Files: [`src/components/ChatArea.tsx`, `src/protocol/client.ts`]

- [x] 6. Wire friends and auth flows

  **What to do**: Connect friend management, message requests, DM creation/opening, login/register, and QR/deep-link auth surfaces to the runtime/session model so those buttons actually complete the intended identity or friend-operation flow.
  **Must NOT do**: Do not add a new auth UI or change the current screen structure.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: identity and peer management affect the connection model.
  - Skills: `[]` - Reason: no special skill injection is required.
  - Omitted: `quick` - Reason: multiple screens and protocol states are involved.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 10 | Blocked By: 1, 2, 3

  **References**:
  - Pattern: `src/components/FriendsPanel.tsx`, `src/components/MessageRequests.tsx` - friend/DM actions.
  - Pattern: `src/components/auth/LoginScreen.tsx`, `src/components/auth/RegisterScreen.tsx` - auth entry surfaces.
  - External: `/home/hal9000/docker/xorein/pkg/phase6/handshake.go`, `/home/hal9000/docker/xorein/pkg/node/wire.go`, `/home/hal9000/docker/xorein/pkg/protocol/registry.go`, `/home/hal9000/docker/xorein/docs/v0.2/phase1/p1-t2-x3dh-profile.md` - handshake and DM bootstrap references.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Add friend / accept / decline / unblock / open DM actions perform a real state change or clear unsupported-state response.
  - [ ] Login/register/QR flows either authenticate successfully or fail with precise validation feedback.
  - [ ] The message-request surface can be exercised end-to-end without UI redesign.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Happy path friend request
    Tool: Playwright
    Steps: Add a friend, accept the request in Message Requests, then open the DM.
    Expected: The friend appears and the DM becomes accessible.
    Evidence: .sisyphus/evidence/task-6-friends-success.png

  Scenario: Failure path invalid auth
    Tool: Playwright
    Steps: Attempt login/register with invalid credentials or an invalid QR/link.
    Expected: Authentication fails cleanly and no session is created.
    Evidence: .sisyphus/evidence/task-6-friends-failure.png
  ```

  **Commit**: YES | Message: `feat(identity): wire friends and auth flows` | Files: [`src/components/FriendsPanel.tsx`, `src/components/MessageRequests.tsx`, `src/components/auth/LoginScreen.tsx`, `src/components/auth/RegisterScreen.tsx`]

- [x] 7. Wire server administration surfaces

  **What to do**: Hook up `ServerSettingsScreen`, `ServerApplications`, and `MemberSidebar` so roles, channels, members, invites, audit filters, and automod controls all mutate real state or present explicit unsupported states when xorein lacks the capability.
  **Must NOT do**: Do not add new admin dashboards or change the existing settings layout.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: this slice spans several admin sub-features and may require selective adaptation.
  - Skills: `[]` - Reason: no special skill injection is required.
  - Omitted: `quick` - Reason: it is broader than a one-file patch.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 10 | Blocked By: 1, 2, 3

  **References**:
  - Pattern: `src/components/ServerSettingsScreen.tsx`, `src/components/ServerApplications.tsx`, `src/components/MemberSidebar.tsx` - admin action surfaces.
  - External: `/home/hal9000/docker/xorein/pkg/node/service.go`, `/home/hal9000/docker/xorein/pkg/node/wire.go`, `/home/hal9000/docker/xorein/pkg/protocol/capabilities.go`, `/home/hal9000/docker/xorein/pkg/network/transport.go` - capability/state surfaces.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Role/channel/member/invite/audit/automod controls perform a real action or show a precise unsupported-state response.
  - [ ] Application approve/reject and member moderation actions visibly update state.
  - [ ] Copy-invite and related admin utilities remain functional.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Happy path admin mutation
    Tool: Playwright
    Steps: Create or edit a role/channel, then approve an application or moderate a member.
    Expected: The settings panel updates to reflect the change.
    Evidence: .sisyphus/evidence/task-7-admin-success.png

  Scenario: Failure path permission denied
    Tool: Playwright
    Steps: Attempt the same action from a context without permissions.
    Expected: The app shows a permission/unsupported error and does not mutate state.
    Evidence: .sisyphus/evidence/task-7-admin-failure.png
  ```

  **Commit**: YES | Message: `feat(admin): wire server settings actions` | Files: [`src/components/ServerSettingsScreen.tsx`, `src/components/ServerApplications.tsx`, `src/components/MemberSidebar.tsx`]

- [x] 8. Wire voice and media controls

  **What to do**: Connect the voice control bar and related voice components to real signaling/session state for join, mute, deafen, video, screen share, activity controls, and any required relay/session fallback.
  **Must NOT do**: Do not add new voice UX or change the visible control bar.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: voice wiring may require specialized runtime handling.
  - Skills: `[]` - Reason: no special skill injection is required.
  - Omitted: `quick` - Reason: this spans signaling, session state, and UI feedback.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 10 | Blocked By: 1, 2, 3

  **References**:
  - Pattern: `src/components/voice/VoiceControlBar.tsx`, `src/components/voice/*` - voice session controls.
  - External: `/home/hal9000/docker/xorein/pkg/phase8/signaling.go`, `/home/hal9000/docker/xorein/pkg/network/transport.go`, `/home/hal9000/docker/xorein/proto/aether.proto`, `/home/hal9000/docker/xorein/docs/v0.3/phase1/p1-voice-sfu-baseline.md` - signaling and session boundaries.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Join/mute/deafen/video/screen-share/activity controls send or reflect real voice session state.
  - [ ] Controls that require an active voice session are disabled or error clearly when no session exists.
  - [ ] Voice signaling failures surface deterministic feedback.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Happy path voice controls
    Tool: Playwright
    Steps: Join a voice session, mute/deafen, then toggle video or screen share.
    Expected: The control bar reflects the live voice state.
    Evidence: .sisyphus/evidence/task-8-voice-success.png

  Scenario: Failure path no voice session
    Tool: Playwright
    Steps: Click a voice control while no voice session is active.
    Expected: The app blocks the action or shows a precise error.
    Evidence: .sisyphus/evidence/task-8-voice-failure.png
  ```

  **Commit**: YES | Message: `feat(voice): wire voice controls to xorein` | Files: [`src/components/voice/*`, `src/components/ChannelRail.tsx`]

- [x] 9. Wire settings and local preferences

  **What to do**: Make the settings/account/privacy/MFA/notifications/accessibility/performance/donations/quests/shop controls persist and reflect real client state, keeping the current screen structure intact.
  **Must NOT do**: Do not redesign the settings screens or invent new product settings.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: this slice is mostly local-state and persistence work.
  - Skills: `[]` - Reason: no special skill injection is required.
  - Omitted: `quick` - Reason: the settings surface is broad and needs coherent state handling.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 10 | Blocked By: 1, 2, 3

  **References**:
  - Pattern: `src/components/SettingsScreen.tsx` - all local preference toggles and account sections.
  - Pattern: `src/config/featureFlags.ts`, `src/hooks/useFeature.ts` - central gating for settings-visible features.
  - Pattern: `src/components/auth/LoginScreen.tsx` - account-switching and session-aware settings interactions.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Each settings control updates persisted client state or opens its real destination.
  - [ ] Backup/MFA/password-related actions produce deterministic success/failure feedback.
  - [ ] Reloading the app preserves the toggled preferences that are meant to persist.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Happy path preference persistence
    Tool: Playwright
    Steps: Toggle a preference, reload the app, and revisit Settings.
    Expected: The setting remains on/off as expected.
    Evidence: .sisyphus/evidence/task-9-settings-success.png

  Scenario: Failure path invalid security input
    Tool: Playwright
    Steps: Enter an invalid MFA/passkey/backup-code value.
    Expected: The settings UI reports the validation error and keeps the prior state.
    Evidence: .sisyphus/evidence/task-9-settings-failure.png
  ```

  **Commit**: YES | Message: `feat(settings): persist local client preferences` | Files: [`src/components/SettingsScreen.tsx`, `src/config/featureFlags.ts`, `src/hooks/useFeature.ts`]

- [x] 10. Add browser E2E coverage

  **What to do**: Add the missing browser test harness and a small critical-flow suite that exercises the real UI against a running xorein client/runtime, then make the test command part of the normal verification path.
  **Must NOT do**: Do not replace the existing unit/protocol tests; this is additive verification only.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: this is a test infra task that spans config and coverage design.
  - Skills: `[]` - Reason: no special skill injection is required.
  - Omitted: `quick` - Reason: a browser harness plus flows is more than a small tweak.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [] | Blocked By: 1, 2, 3, 4, 5, 6, 7, 8, 9

  **References**:
  - Pattern: `vitest.config.ts`, `src/test/setup.ts`, `src/test/example.test.ts` - existing test infrastructure.
  - Pattern: `protocol-tests/client.test.ts`, `protocol-tests/manifest.test.ts` - protocol verification style.
  - Pattern: `package.json` - scripts that must be updated to expose the new browser test command.
  - Create: browser harness config and browser smoke tests - new files to be added by this task.

  **Acceptance Criteria** (agent-executable only):
  - [ ] A repeatable browser test command exists and runs headless.
  - [ ] Critical smoke flows cover create/join, send message, friend request, settings persistence, and one offline failure case.
  - [ ] The test suite captures evidence for both success and failure paths.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Happy path critical smoke
    Tool: Playwright
    Steps: Run the full browser smoke suite against a local xorein runtime.
    Expected: The suite passes and produces evidence for the core flows.
    Evidence: .sisyphus/evidence/task-10-e2e-success.txt

  Scenario: Failure path missing runtime
    Tool: Playwright
    Steps: Run the same suite without a runtime available.
    Expected: The suite fails for the expected connectivity reasons and reports the missing runtime cleanly.
    Evidence: .sisyphus/evidence/task-10-e2e-failure.txt
  ```

  **Commit**: YES | Message: `test(e2e): add browser smoke coverage` | Files: [`package.json`, `browser harness files`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high (+ playwright if UI)
- [x] F4. Scope Fidelity Check — deep
## Commit Strategy
## Success Criteria
