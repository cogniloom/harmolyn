# Learnings

## Bridge task findings
- `src/protocol/client.ts` now uses the local xorein control API and preserves the existing `XoreinClient` session shape.
- `protocol-tests/client.test.ts` is a strong template for future integration tasks because it already covers success and deterministic failure paths.
- `npm run test:protocol` and `npm run build` both pass after the bridge changes.

- The real xorein bridge seam is the local control API, not the old synthetic handshake transport: Harmolyn now maps `GET /v1/state` to reconnect/connect for known servers and `POST /v1/servers/join` to deeplink joins.
- Real xorein join links may carry a signed invite in the `invite` query parameter, so `parseJoinDeepLink()` must accept both the legacy bare server path and invite-bearing links.
- xorein manifests are Ed25519-signed over canonical JSON with sorted address/capability arrays; validating them in the frontend avoids trusting malformed bridge payloads even when the runtime is local.
- The bridge session currently negotiates `securityMode: "clear"` because the local control transport is an explicit local-only control channel; feature and protocol negotiation still derive from the remote server manifest capabilities.

- Task 2 replaced demo shell fixtures by making `src/data.ts` adapt injected xorein runtime/session snapshots into the existing `User`/`Server`/`DirectMessageChannel`/`Message` UI shapes, so most shell components can stay on the same imports while reading live data.
- The shell adapter currently accepts runtime/session snapshots from browser globals or storage keys (`__HARMOLYN_XOREIN_RUNTIME__`, `__HARMOLYN_SESSION_SNAPSHOT__`, `harmolyn:xorein:runtime`, `harmolyn:xorein:session`, plus compatibility aliases), which made Playwright QA and boot-time runtime hydration work without changing the app entry chain.
- `Layout.tsx` now derives its initial active server/channel from the runtime/session snapshot and remounts `ChatArea` per active scope so channel-specific message lists reset cleanly without touching deeper chat internals.

- Task 3 wired a live `ConnectionState` into `Layout`, `ServerRail`, and `ChannelRail`, and the reconnect path now updates from localStorage/runtime changes without a full reload.
- `deriveConnectionState()` now distinguishes `CONNECTED`, `OFFLINE`, `RECONNECTING`, `NO PEER`, and `NO RELAY`, which made browser QA easy to validate from the shell chrome alone.
- The browser QA server needs to be pinned explicitly because Vite may auto-pick a different port when 8080/8081 are busy.

- Task 3 made `src/data.ts` a live shell store instead of a one-shot bootstrap snapshot: `useSyncExternalStore` now works because unchanged runtime/session payloads return the same cached object identity, while polling + storage/focus listeners let the shell recover when the runtime appears after startup.
- The shell now derives explicit `connected` / `disconnected` / `reconnecting` / `no-peer` / `no-relay` states from runtime identity, selected server/session, known peers, relay-capable peers, and telemetry strings, which kept the existing layout while making failure modes visible in the rails and fallback channel state.
- Browser QA confirmed the intended lifecycle behavior using only injected localStorage snapshots: offline startup showed disabled create/explore/connectivity controls, then the app promoted itself to a connected server/channel shell without a page reload once runtime/session data was written.

- Task 4 wired the real server-entry seam through the local xorein control API: create uses `POST /v1/servers`, invite discovery uses `POST /v1/servers/preview`, and join uses `POST /v1/servers/join`, followed by a `GET /v1/state` refresh that republishes runtime/session snapshots back into the shell.
- The browser-side control token is not present in `GET /v1/state`, so the UI helper must read it from browser globals or localStorage (`harmolyn:xorein:control-token` and compatibility aliases) and fail explicitly when it is missing instead of silently pretending create/join worked.
- The explorer can stay truthful without inventing discovery cards by previewing signed `aether://join/...?...invite=...` deeplinks against the runtime and otherwise showing only tracked servers from live runtime state or an explicit empty state.

- [2026-04-22 11:43 UTC] Re-verified Task 4 end-to-end: the happy-path Playwright scenario now proves both `Alpha Node` creation and `Beta Node` join in live shell text, while the failure scenario still reports the unsupported-invite validation error with zero membership changes.

- [2026-04-22 12:04 UTC] Task 5 wired chat actions through a scope-local persisted overlay in `src/protocol/client.ts` + `src/components/ChatArea.tsx`: send, slash commands, reply/edit/delete/pin/reaction, forward, thread replies, mute state, inbox reads, and local nickname now survive rerenders/reloads without pretending the current xorein control API already exposes message mutation endpoints.
- [2026-04-22 12:04 UTC] Browser QA on `http://127.0.0.1:8082/` passed for chat happy paths by injecting a live runtime/session snapshot into localStorage: sending `QA send path`, reacting `👍 1`, copying a message link, and then reloading still showed the locally persisted message + reaction in `#general`.
- [2026-04-22 12:04 UTC] Browser QA also passed the failure path truthfully: with runtime/session/control token removed, the composer switched to `offline preview`, uploading `README.md` produced the visible error `Attachments are disabled while the local xorein runtime is offline.`, and no attachment placeholder was fabricated.
- [2026-04-22 12:08 UTC] `tsconfig.protocol.json` is stricter than the app build about browser globals: keyed reads from `window` must use an `unknown`-first record cast (`window as unknown as Record<string, unknown>`) instead of `Window & Record<string, unknown>` or `npm run test:protocol` fails in `src/protocol/client.ts` even though runtime behavior is unchanged.

- [2026-04-22 12:30 UTC] Task 6 wired friends and auth flows without redesigning the screens: `FriendsPanel.tsx` now persists a deterministic local-preview social state (friend add/accept/decline/unblock, message-request accept/ignore, explicit call/open-DM responses), while `LoginScreen.tsx` and `RegisterScreen.tsx` now validate inputs and then report truthful unsupported auth states instead of faking success.
- [2026-04-22 12:30 UTC] Browser QA passed on `http://127.0.0.1:8091/` using query-param activation for previously unmounted surfaces: `?panel=friends` proved a happy-path add-friend flow for `u6` plus an open-DM jump into the existing `dm-u2` thread, and `?auth=login` proved the invalid-auth failure (`Access keys must be at least 8 characters long.`) plus the QR/deep-link unsupported message.
- [2026-04-22 12:39 UTC] The auth forms need `noValidate` on the existing `<form>` elements so Harmolyn's custom preview validation banners run for invalid credential input; without it, native HTML5 email validation blocks submit before `handleSubmit()` executes.

- [2026-04-22 13:02 UTC] Task 7 wires the admin surfaces the same way as the earlier preview flows: server settings now mutate local preview state for roles/channels/members/invites/automod, member moderation shows protected-user denials plus visible timeout badges, and applications approve/reject updates the review queue with an inline feedback banner.
- [2026-04-22 13:02 UTC] Playwright QA on the server-admin flow worked best after loading a runtime snapshot before navigation and using direct DOM clicks for nested overlay actions; the settings overlay and applications modal both render fine, but force-clicking can hit the wrong layer unless the target button is selected by its exact text or aria-label.
- [2026-04-22 13:02 UTC] The admin surfaces are intentionally preview-local: settings actions mutate component state, applications approve/reject rewrites the local queue, and member timeout state is tracked in-memory with visible badges rather than a backend write.
- [2026-04-22 13:28 UTC] Task 7 verification confirmed the invite clipboard path is truthful in both directions: success only appears after a real `writeText()` completes, and a rejected clipboard write shows `Clipboard access is unavailable in the local preview; invite link was not copied.`
- [2026-04-22 13:28 UTC] For the moderation failure path, switching the shell to a non-admin identity (`Peer Member`) made `MemberSidebar` surface `Permission denied: Peer Member cannot time out members in the local preview.` before any timeout mutation ran.
- [2026-04-22 13:12 UTC] Task 7 cleanup wired moderation truthfully through runtime state: `MemberSidebar` now distinguishes permission denial from protected-target denial using the current user plus server owner id, and `ServerSettingsScreen` only marks invite copy successful after the clipboard promise resolves.

- [2026-04-22 13:40 UTC] Task 8 voice/media wiring is runtime-backed in `Layout.tsx`: join/leave/mute/deafen/video/screen-share/activity actions all route through `xoreinControl` with `runtimeSnapshot` + current voice session/peer state, and `buildVoiceControlState()` is the single source of truth for whether the voice UI can interact.
- [2026-04-22 13:40 UTC] The voice UI is intentionally split between real control state and local-preview surfaces: `VoiceTextChat` keeps mock messages/client-side send, while `ActivityLauncher` and `ScreenSharePanel` are launcher/chooser overlays gated by a disabled reason rather than live browser media capture.

- [2026-04-22 review] Task 8 voice/media review: `Layout.tsx` now routes join/leave, mute/deafen, video, screen-share, and activity actions through `src/lib/xoreinControl.ts` real local-control endpoints (`/v1/voice/{channel}/join|leave|mute|frames`), while `buildVoiceControlState()` gives explicit offline, no-session, pending, and error feedback in the control bar.
- [2026-04-22 review] The current voice implementation mixes real control calls with local-only UI state: mute reflects `runtimeSnapshot.voice_sessions`, but video/screen-share/activity status is tracked only in local `voiceUi` state, and `VoiceTextChat.tsx` remains canned/local append-only rather than session-backed.

- [2026-04-22 task8-fix] `ChannelRail.tsx` footer mic/headphone buttons now use the same voice handlers/state as the control bar, so they either perform the real mute/deafen action for the active voice channel or surface the current voice-status reason instead of acting like decorative icons.
- [2026-04-22 task8-fix] `VoiceControlBar.tsx` no longer ships a dead voice-settings control: the button now routes to a task-8-scoped unsupported-state handler in `Layout.tsx`, which reports a deterministic runtime limitation directly in the visible voice status area.
- [2026-04-22 task8-fix] The control bar’s media text is now intentionally conservative: video/screen-share/activity toggles still send real xorein control frames, but the UI labels them as `... SENT` until the runtime exposes confirmed media/session state instead of over-claiming that those media modes are already live.
- [2026-04-22 task8-fix] Browser QA evidence for task 8 now exists: `.sisyphus/evidence/task-8-voice-success.png` shows join + footer mute/deafen + video control flow on a mocked local xorein runtime, and `.sisyphus/evidence/task-8-voice-failure.png` shows the explicit `No live voice session is reported for Voice Ops.` failure after a join that returns no session snapshot.

- [2026-04-22 task9] Settings state now survives refresh through browser storage-backed preferences: notifications and accessibility values persist locally, and message layout is shared with `Layout.tsx` so the appearance choice stays visible after reload.
- [2026-04-22 task9] MFA preview flows are safest when they generate a local 6-digit setup code and require an exact match before enabling; the invalid-code path should keep the previous state and show an explicit validation banner.

- [2026-04-22 task10] The browser smoke harness works best with `playwright-core` plus the system `google-chrome` binary, which keeps the command lightweight while still using a real headless browser.
- [2026-04-22 task10] The xorein control token must be seeded alongside the runtime snapshot; without it, create/join stays in the visible offline preview state and the browser smoke suite cannot advance.
- [2026-04-22 task10] Friends-panel smoke data has to reference the target user through a DM/server/message seed first, because `src/data.ts` only materializes `USERS` from runtime peers that are actually referenced by the shell snapshot.
- [2026-04-22 task10] The settings message-layout toggle needed a direct DOM click to avoid overlay pointer interception; a normal Playwright click was too brittle inside the fullscreen settings shell.

- [2026-04-22 fix] Task 8 voice controls now fail explicitly when callbacks are missing: `VoiceControlBar` disables unavailable actions instead of accepting silent fallthrough, and `ChannelRail` no longer passes `?? (() => undefined)` handlers.
- [2026-04-22 fix] `npm run build` passes after the voice fallback cleanup, with the existing Vite chunk-size warning still non-fatal.

- [2026-04-22 task9-fix] The reliable failure capture path is to click the exact `button` text `Enable`, fill `input[placeholder="000000"]` with an invalid code, click `Verify` via DOM, and screenshot immediately; a full-page capture then clearly shows the validation banner before it auto-dismisses.
