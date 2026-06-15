# Issues

## Bridge task findings
- The build emits a chunk-size warning from Vite, but it does not fail the build.
- `package-lock.json` changed as part of the protocol task and should be reviewed for whether the lockfile drift is acceptable to keep.

- `npm run test:protocol` initially failed in this checkout because dependencies were not installed (`tsc: not found`); running `npm install` was required before protocol verification.
- The protocol test tsconfig also needed `allowSyntheticDefaultImports` enabled so the existing `node:test` / `node:assert/strict` default imports continue compiling under `tsconfig.protocol.json`.

- The current xorein runtime snapshot shape does not expose peer display profiles for remote members, so the shell must fall back to abbreviated peer IDs for non-local users until richer profile/presence data is available from the bridge.

- The shared Playwright MCP browser can lock between QA steps; killing the stale MCP Chrome process was necessary to continue browser verification.
- Vite auto-selected port 4173/4174 style ports when fixed ports were busy, so the QA script had to read the dev server log before browser navigation.

- `useSyncExternalStore` will trigger an infinite render loop if `readShellRuntimeData()` creates a fresh object every render; the runtime adapter now caches the last parsed signature so unchanged snapshot reads stay referentially stable.
- Browser QA in this environment had to use the Vite port Vite selected (`8084`) because `8080`-`8083` were already occupied; the reconnect/offline evidence files still validated the intended shell behavior once the actual dev port was used.

- `npm run lint` is currently not a usable verification gate in this checkout because the repository has no ESLint config file; the command fails before reading source files, so Task 4 relied on `lsp_diagnostics`, `npm run build`, and browser QA instead.
- The join explorer hero input and the join modal reuse the same deeplink placeholder, so Playwright QA had to target the modal textbox explicitly when validating invite flows.

- [2026-04-22 11:43 UTC] Running the happy-path and failure Playwright flows in parallel can cause the shared MCP browser to abort one navigation (`net::ERR_ABORTED`); rerunning the success case serially avoids the session clash and still produces the required evidence reliably.

- [2026-04-22 12:04 UTC] Playwright could verify the copy-link success toast, but reading clipboard contents back via `navigator.clipboard.readText()` still failed in this environment with `NotAllowedError: Read permission denied`; UI feedback plus persisted state verification remained reliable evidence for Task 5 instead.

- [2026-04-22 12:30 UTC] Task 6 browser QA hit two deterministic fixture gotchas before passing: the login screen's native `type="email"` validation blocks submit before the custom invalid-auth banner, so the invalid path should use a syntactically valid email plus a short password; and friends-panel happy-path QA needs injected runtime users (`dms` or server members), otherwise the local-preview social state can show pending counts for `u*` IDs that do not yet exist in `USERS`.
- [2026-04-22 12:39 UTC] Follow-up QA confirmed the real fix for task 6 is disabling native form validation rather than changing the inputs: after adding `noValidate`, Playwright saw the intended custom feedback strings for invalid login (`Enter a valid identity link before authenticating.`) and invalid register (`Operator aliases must be 3-32 characters using letters, numbers, or underscores.`).

- [2026-04-22 13:02 UTC] The server-admin overlays are stateful and can confuse pointer-based Playwright clicks; for nested actions like approve/delete/timeout, using direct DOM clicks or exact `aria-label` selectors was more reliable than clicking the surrounding card/container.
- [2026-04-22 13:02 UTC] Applications approvals update the visible queue state, but the approval button only appears after expanding a pending card; QA has to open the card first or it will accidentally hit the approved/rejected filter chips instead.
- [2026-04-22 13:02 UTC] Invite copy in `ServerSettingsScreen` always shows success feedback after `navigator.clipboard.writeText()` is invoked; if clipboard access is blocked or unavailable, the UI can falsely report success.
- [2026-04-22 13:02 UTC] `MemberSidebar` only protects `Admin` users and `me` from timeout; it has no server-owner/permission-aware guard, so a privileged but non-Admin owner could still be timed out in the preview.
- [2026-04-22 13:28 UTC] The server settings and member sidebar are easier to exercise in Playwright when the shell identity is swapped to a non-admin runtime snapshot first; otherwise the moderation permission-denied path is hard to reach from the default owner identity.
- [2026-04-22 13:12 UTC] Vite could not bind to 8080-8084 in this checkout, so the dev server fell back to 8085; browser QA must target the selected port rather than assuming the default.
- [2026-04-22 13:12 UTC] Playwright browser tooling is currently not connected in this session, so the admin fixes were verified by diagnostics/build plus a live dev-server startup check rather than a click-through run.

- [2026-04-22 13:40 UTC] Voice controls still have a few obvious preview stubs: the `VoiceControlBar` settings button is disabled with an empty click handler, `ChannelRail` footer mic/headphone icons are inert, and the video/screen-share/activity flows only send xorein control frames (no browser `getUserMedia`/`getDisplayMedia` path or local media preview was found in these files).
- [2026-04-22 13:40 UTC] `VoiceTextChat` is not runtime-synced yet; it starts with canned messages and only appends local state, so it behaves like a mock text companion for voice rather than a real session-backed chat log.

- [2026-04-22 review] Task 8 should not be marked complete yet: `ChannelRail.tsx` still renders inert footer mic/headphone buttons with no click handlers, and `VoiceControlBar.tsx` still includes a disabled Voice Settings button with an empty handler, leaving existing voice controls non-functional.
- [2026-04-22 review] Task 8 verification evidence is still missing in this checkout: no `.sisyphus/evidence/task-8-voice-success.png` or `task-8-voice-failure.png` files were present, so the plan's required happy/failure QA scenarios are not yet satisfied.
- [2026-04-22 review] Video, screen-share, and activity toggles do send real xorein control frames, but their reflected on-screen state is optimistic/local-only (`voiceUi`) and no browser media capture path (`getUserMedia`/`getDisplayMedia`) was found in the reviewed voice files, so media behavior is only partially wired.

- [2026-04-22 task8-fix] Browser QA for voice needed a full browser-side fetch mock for `http://127.0.0.1:9001/v1/*`; simply injecting runtime/session snapshots was not enough because the real join path still attempted a cross-origin control request and hit CORS before the mocked voice state could update.

- [2026-04-22 task9] Playwright clicks on the appearance layout button were intercepted by the overlay shell unless the DOM click was triggered directly; the settings screen itself is still testable, but the browser script needs to target the exact button node for reliable QA.
- [2026-04-22 task9] The MFA invalid-code path was only reliable after targeting the concrete `input[placeholder="000000"]` and firing the `Verify` button through the DOM; the screenshot evidence still confirmed the failure banner and unchanged state.

- [2026-04-22 task10] The browser smoke suite needs a dedicated offline runtime mode because the happy-path runtime seeds and the missing-runtime failure path are mutually exclusive.
- [2026-04-22 task10] The friends smoke case is misleading if the runtime has no referenced peers: known peers alone do not populate `USERS`; the test runtime must include a DM/server/message seed for the friend target.
- [2026-04-22 task10] The missing-runtime assertion should key off the uppercase offline banner text, not the lower-case copy from the code path, otherwise the suite times out on a casing mismatch.

- [2026-04-22 fix] The prior F2 rejection came from the visible voice surface still allowing silent fallthrough; this was fixed by gating the footer controls on handler presence and surfacing a `Voice controls are unavailable in this shell.` state in `VoiceControlBar` when callbacks are absent.

- [2026-04-22 task9-fix] The MFA error banner auto-dismisses after ~2.6s, so delayed screenshots miss the failure state; the screenshot must be captured immediately after clicking `Verify`.
