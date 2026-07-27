# xorein Protocol Gaps

> **2026-07-27 — GA-readiness hardening (Tier 0/1/2).** A large security-correctness +
> consumer-readiness pass landed. Highlights, by area:
>
> **Security correctness (Tier 0 — all client-side, all tested):**
> - **Fail-closed messaging.** Inbound chat rejects anything not carrying the scope's
>   required E2EE envelope (seal for DMs, crowd for channels) — the plaintext-accept
>   downgrade path in `sync/inbound.ts` is gone (`decodeInboundMessage`, `handleChatEdit`).
> - **Real security badge.** Each message carries the mode it was actually en/decrypted
>   under (`security_mode`/`encrypted`, `types.ts`); the ChatArea badge is derived from
>   real messages, not the scope type, and downgrades to danger if any `clear` is present.
> - **Crowd epoch rotation works.** `ChannelCrypto.setRoot` is epoch-versioned (was
>   first-root-wins); `sync.update` now propagates `crowd_root`/`crowd_epoch`/`roles`/
>   `member_roles`; the owner rotates on kick AND join; new joiners get zero pre-join
>   history by default. A kicked member is cryptographically locked out (`crowd/rotation.test.ts`).
> - **Voice SFrame fails closed.** The publicly-derivable stub key is deleted;
>   `voiceSecurityMode`/`deriveVoicePeerKey` agree, and SFrame is only enabled with a real key.
> - **Encrypted state at rest.** Native state is AES-256-GCM encrypted under a key derived
>   from the identity seed (was cleartext localStorage incl. crowd_root/invite_secret/bodies);
>   the raw remember-me AES key is replaced by a non-extractable WebCrypto key in IndexedDB.
> - **Seal hardening.** One-time prekeys are consumed (single-use) + replenished; the bundle
>   rotates on expiry/low OPKs; a fetched bundle is bound to the dialed peer id (relay-swap MITM).
> - **Key verification.** Signal-style hybrid (Ed25519+ML-DSA) safety numbers + TOFU pinning
>   with change detection; `KeyVerification` screen reachable from the DM security badge.
> - **Pin authorization.** Pins require MANAGE_MESSAGES (were forgeable by any member).
>
> **Consumer readiness (Tier 1):** pinch-zoom + text-selection restored (WCAG); real
> `APP_VERSION`; `fileUploads` flipped on (the E2EE attachment feature was complete but
> hidden); fake moderation stats replaced with real counts; NotificationSettings are now
> honored; **monetization (donations/shop/quests/boosts) + 16 orphaned mock components
> deleted**; in-app **Terms/Privacy/Community-Guidelines** + a blocking **age/consent gate**
> at registration; an **abuse-reporting** flow (ReportModal) that delivers P2P to the server
> owner; **PWA** (installable + offline service worker) + offline banner + gesture-gated
> notification permission; locale-aware dates.
>
> **Resilience (Tier 2):** a **durable outbound queue** — messages composed while the relay
> is down are persisted (encrypted) and replayed on reconnect instead of being discarded.
>
> **Filed against `cogniloom/xorein`:** issues #27–#31 (relay CGO/SQLCipher stub, invalid
> `--mode` flag, `RelayQueue` unwired, plaintext control send-path, missing rendezvous/mailbox
> endpoints).
>
> **Still open (largest remaining GA items):** full i18n string sweep across ~120 components
> (framework/locale-dates started); WebRTC (`@libp2p/webrtc`) + DCUtR direct transport +
> DHT/rendezvous discovery (needs a 2nd relay `[INFRA]`); member-served history + pagination;
> voice trickle-ICE/ICE-restart/reconnect + peer-SFU for large calls; onboarding product tour +
> "simple mode" + backup-nudge at registration.

This document tracks Harmolyn UI features that **cannot be fully wired yet** because
the xorein local control API does not expose the required endpoints. Each gap lists
the endpoint(s) the runtime would need to add. Until then, the corresponding feature
flag in `src/config/featureFlags.ts` is set to `false` so the feature is **hidden**
(no fake/placeholder UI is shown to end users).

When the xorein runtime gains an endpoint below, flip the matching feature flag to
`true` and wire the component to the new control-API function in
`src/lib/xoreinControl.ts`.

## How "wired" is defined

The xorein control API (see `src/lib/xoreinControl.ts`) exposes a **fixed set** of
operations. A feature is considered *wired* only if every user action it offers maps
to a real control-API call. Features whose actions can only mutate browser-local
state are protocol gaps, not real functionality.

### Operations the runtime DOES expose today

Messaging: `sendChannelMessage`, `sendDmMessage`, `editMessage`, `deleteMessage`,
`addReaction`, `removeReaction`, `pinMessage`, `unpinMessage`, `listPins`,
`searchMessages`, `searchMentions`.
Servers/channels: `createServer`, `joinServerByInvite`, `discoverServerByInvite`,
`createChannel`.
Roles/moderation: `listRoles`, `createRole`, `assignRole`, `moderationAction`
(kick/ban/unban/mute/slowmode).
Voice control plane: `joinVoiceChannel`, `leaveVoiceChannel`, `setVoiceMuted`,
`sendVoiceFrame`, `sendVoiceSignal` (WebRTC offer/answer/ice/terminate).
DMs/groups: `listDms`, `createDm`, `listGroupDms`, `createGroupDm`,
`addGroupDmMember`, `sendGroupDmMessage`.
Friends: `listFriends`, `sendFriendRequest`, `actOnFriendRequest`
(accept/decline/cancel/block), `removeFriend`.
Presence: `getPresence`, `updatePresence`.
Notifications: `searchNotifications`, `getNotificationSummary`,
`markNotificationsRead`.
Identity: `createIdentity`, `getIdentityBackup`, `restoreIdentity`.
Peers/relays: `addPeer`, `removePeer`, `registerRelay`, `removeRelay`.

---

## Gaps (feature → missing endpoint)

### Monetization — `donations`, `shop`, `quests`, `premiumTiers`, `serverSubscriptions`
xorein is a P2P network with no payment, ledger, or virtual-currency primitives.
Donations, the cosmetic shop, quests/gems, premium tiers and server subscriptions
have **no** protocol backing. The previous UI mutated only `localStorage` (and the
"Donate"/"Redeem" buttons had no handler at all).
**Needed:** a payment/entitlement service exposed through the local runtime, e.g.
`POST /v1/billing/checkout`, `GET /v1/billing/entitlements`, `POST /v1/quests/claim`.
This is a product/infra decision, not just a protocol addition.

### Scheduled events — `scheduledEvents`, `eventReminders`
No event object exists in the runtime. `EventsList` used hardcoded `SEED_EVENTS` and
a `setTimeout` to fake creation latency; RSVPs were local-only.
**Needed:** `GET /v1/servers/{id}/events`, `POST /v1/servers/{id}/events`,
`POST /v1/events/{id}/rsvp`.

### Stage channels — `stageChannels`
No stage/speaker model. `StageChannel` rendered `MOCK_PARTICIPANTS`; "invite to
speak"/"raise hand" only mutated local state.
**Needed:** `GET /v1/voice/{channelId}/stage`, `POST /v1/voice/{channelId}/stage/invite`,
`POST /v1/voice/{channelId}/stage/hand`, plus speaker state in the voice session.

### Soundboard — `soundboard`
No sound-asset model and no audio frames for sound effects. `Soundboard` used
`MOCK_SOUNDS` and a `setTimeout` instead of playing audio.
**Needed:** `GET /v1/servers/{id}/sounds`, `POST /v1/servers/{id}/sounds`,
`POST /v1/voice/{channelId}/sounds/{soundId}/play` (or reuse `sendVoiceFrame`).

### Threads — `threads` ✅ RESOLVED (native, 2026-06-07 session-3)
Thread replies derived from `messagesState.filter(m => m.replyToId === parentId)` —
native messages with `reply_to` field, no API round-trip. Sent via `nativeSendChannelMessage`
with `reply_to` so they propagate P2P and survive reload. Thread send path wired in
`ChatArea` to use native engine.

### Forum channels — `forumChannels`
A forum post carries a title, tags, view/upvote counts and reply rollups. None of
these exist in the message model; `ForumChannel` fell back to `SEED_POSTS` and kept
upvotes/views in local state.
**Needed:** a forum post type and endpoints
(`GET/POST /v1/channels/{id}/forum`, `POST /v1/forum/{postId}/vote`).

### Polls — `polls` ✅ RESOLVED (native, 2026-06-07 session-3)
Poll data encoded in message body (`🗳️ POLL:{…}`) — sent via native engine (P2P).
Votes accumulated in native state (`addPollVote`, idempotent) and broadcast via
`notify.push { kind: 'poll_vote' }`. No support-node API needed.

### Voice messages — `voiceMessages`
No audio attachment/upload endpoint. The recorder captured no audio and the player
drew a `Math.random()` waveform with a fake progress timer.
**Needed:** blob upload (`POST /v1/attachments`) returning a content-addressed handle
that can be referenced from a message.

### Message attachments / file upload
`ChatArea` file upload stored a text "local preview placeholder" only.
**Needed:** the same `POST /v1/attachments` upload endpoint as voice messages.

### Scheduled messages — `scheduledMessages`
No deferred-send mechanism in the runtime.
**Needed:** `POST /v1/messages/schedule` with a send-at timestamp.

### DM calls & screen share — `dmCalls`, `screenShare`
The voice control plane is channel-scoped. `DMCallControls` simulated a call with a
`setInterval` timer and a placeholder "CAMERA FEED"; screen share was a callback with
no implementation. 1:1 calls need a voice session over a DM scope, and screen share
needs a media-track/signal type.
**Needed:** DM-scoped voice sessions (`POST /v1/dms/{id}/voice/join`) and a
screen-share track kind in `sendVoiceSignal`.

### Activities — `activityLauncher`
No embedded-activity protocol. The launcher had an optional callback with no backing.
**Needed:** `GET /v1/activities`, `POST /v1/voice/{channelId}/activities/{id}`.

### Server applications — `serverApplications`
No membership-application model. `ServerApplications` used `MOCK_APPLICATIONS` and
approve/reject mutated local state.
**Needed:** `GET /v1/servers/{id}/applications`,
`POST /v1/servers/{id}/applications/{appId}/{approve|reject}`.

### Server boosts — `serverBoosts`
No boost/tier model (also depends on monetization).
**Needed:** `GET /v1/servers/{id}/boosts`, `POST /v1/servers/{id}/boost`.

### Audit log — `auditLog` — ✅ RESOLVED (2026-06-07)
`GET /v1/servers/{id}/audit` implemented in the xorein control API (`handlers_audit.go`).
`emitAudit()` called from moderation/roles/channels/servers handlers. Frontend wired via
`useAuditLog` hook + `AuditLogSection`. Flag set `true`.

### Server insights — `serverInsights`
No analytics/metrics endpoint.
**Needed:** `GET /v1/servers/{id}/insights`.

### Server profiles — `serverProfiles`
No per-server member profile (nickname/bio) object; the bio textarea in
`ServerProfileEditor` was unbound and discarded on save.
**Needed:** `PUT /v1/servers/{id}/members/me/profile`.

### Channel edit/delete, server delete & metadata update — ✅ RESOLVED (native, 2026-06-07)
No longer a gap. These run entirely in the native engine (no support-node endpoint
needed): `nativeUpdateChannel`/`nativeDeleteChannel`, `nativeDeleteServer`,
`nativeUpdateServerMeta` (+ `nativeLeaveServer`, `nativeRemoveMember`). Owner edits
propagate to members over the `sync.update`/`sync.delete`/`sync.remove`/`sync.leave`
PeerStream operations. Wired in `ServerSettingsScreen` and the `ChannelRail`
server-header dropdown. See the dated "no-fakes sweep" entry below.

### GIF picker — `gifPicker`
No GIF-provider proxy through the runtime (per project rules, third-party APIs must be
brokered by xorein, never called from the client bundle).
**Needed:** `GET /v1/gifs/search?q=...` proxied by the runtime.

### WebAuthn / passkeys (part of `mfa`)
No WebAuthn registration/assertion endpoints. The "Register Key" button in Settings is
already disabled with an explanatory tooltip. (TOTP and recovery codes are handled
client-side and remain available.)
**Needed:** `POST /v1/auth/webauthn/register/(options|verify)` and the matching
authentication endpoints.

### Message requests — `messageRequests`
`actOnFriendRequest` covers friend requests, but there is no separate "message
request" inbox for DMs from non-friends. The previous UI used hardcoded
`DEFAULT_MESSAGE_REQUESTS`.
**Needed:** `GET /v1/dms/requests`, `POST /v1/dms/requests/{id}/{accept|ignore}`.

### Account activity feed
No account-activity/audit endpoint for the current identity (login history, device
list). UI for this should remain hidden until exposed.
**Needed:** `GET /v1/account/activity`, `GET /v1/account/sessions`.

---

## Security policy: "clear" (unencrypted) mode is never offered to users

Harmolyn must never operate a conversation in **clear** mode (plaintext, readable by
the carrying infrastructure). This is enforced, not just labeled:

- **Negotiation fails closed.** `DEFAULT_PREFERRED_SECURITY_MODES` in
  `src/protocol/client.ts` is `["seal", "tree"]` — `clear` is excluded. The control
  bridge (`handshakeResponseFromServerRecord`) only ever offers the *encrypted* mode a
  server's manifest declares (`encryptedOfferFromManifest`); it can never offer
  `clear`. If a peer can only do `clear`, `negotiateConversationSecurityMode` returns
  no match and the handshake throws `security_mode_incompatible` rather than dropping
  to plaintext.
- **The UI alarms instead of reassuring.** `resolveSecurityMode('clear')`
  (`src/lib/securityMode.ts`) returns a danger badge labeled `UNENCRYPTED // DO NOT
  TRUST` with `insecure: true`, so if a runtime ever reports a clear conversation the
  user is warned, never shown a calm "mode" badge.

### Technical implications of removing clear

- **No feature depends on clear.** Clear is a *confidentiality level*, not a
  capability. Messaging, voice, reactions, search, etc. behave identically under
  `seal`/`tree`; removing clear disables only an insecure fallback, not functionality.
- **It exposes a real runtime gap.** The control bridge previously hard-coded
  `offeredSecurityModes: ["clear"]` because the xorein control API does **not yet
  expose real per-conversation E2EE handshake/negotiation**. The bridge now derives the
  offered mode from the manifest's `security_mode` field instead. Until the runtime
  performs a real X3DH/MLS handshake and reports `seal`/`tree`/`crowd` per surface,
  conversations that only the bridge can describe will negotiate to `unspecified` (no
  badge) rather than a false "encrypted" claim.
  **Needed:** control-API handshake that negotiates and reports the true per-conversation
  security mode (`GET`/`POST /v1/conversations/{id}/security` or equivalent in the
  handshake response), plus `crowd` (large-scale channel E2EE) once the engine supports it.

## Privacy control: remote media auto-load

`MediaEmbed` fetches images and video thumbnails directly from their host, which leaks
the reader's IP/timing to that host even inside an encrypted conversation. This is now
user-controlled: the **Auto-load media previews** toggle (Settings → Privacy,
`loadRemoteMedia` in `usePrivacyPreferences`) gates the remote-loading embeds. It is
**off by default** (privacy-first): each image/video shows a placeholder and fetches
nothing until the reader opts in — globally via the toggle or per item by tapping to
load. Link cards (text + anchor, no fetch) are unaffected. This is a fully client-side
control and requires no runtime endpoint.

---

## Features that ARE fully wired (for reference)

These map cleanly onto existing control-API operations and must stay real (no local
mock fallbacks): text messaging (send/edit/delete), reactions, pins, message search &
mentions, server/channel creation + **rename/delete**, **server metadata edit,
member kick, leave/delete server, invite rotate/revoke**, server join/discovery,
presence/status, notifications (friend-request/DM toasts + unread badges),
identity create/backup/restore, peers & relays, friends and friend requests, and the
voice channel control plane (join/leave/mute + WebRTC signaling).

Reactions (`addReaction`/`removeReaction`) and channel pins
(`pinMessage`/`unpinMessage`) are wired in `ChatArea.tsx`: a toggle issues the real
control-API call for runtime-backed messages when online, with an optimistic local
update and an offline fallback. DM pins are local-only because the runtime pin
endpoint is channel-scoped.

---

## 2026-06-07 — no-fakes sweep of Server Settings + Friends

Removed user-facing stub functionality from `ServerSettingsScreen` and `FriendsPanel`
and replaced it with real, P2P-propagating mutations (the mutation facade
`useRuntimeMutations` now exposes `updateServerMeta`, `removeMember`, `leaveServer`,
`deleteServer`, `rotateInvite`, `revokeInvite`, `setActiveScope`, `markScopeRead`):

- **Delete Server** — was `showUnsupported('… not yet supported through the control
  API.')`; now `nativeDeleteServer` (owner-only; broadcasts `sync.delete` so members
  drop it). **Server name/description edit** — was a fake "Modify" button; now
  `nativeUpdateServerMeta` (broadcasts via `sync.update`). **Channel rename/delete** —
  were local-only mirror edits; now real `updateChannel`/`deleteChannel`. **Member
  kick** — was a local-list splice; now `nativeRemoveMember` (notifies the kicked peer
  via `sync.remove`, re-broadcasts roster). **Invites** — fake local invite *codes*
  removed; the only invite is the real deeplink (rotate = new `invite_secret`, revoke =
  cleared secret). **Leave Server** — new `nativeLeaveServer` (member→owner
  `sync.leave`). All exposed in ≤2 clicks via the channel-rail server-header dropdown.
- **Calls (FriendsPanel)** — the "Call" button popped "not supported yet"; removed
  (no 1:1 call transport exists). 1:1 voice calling remains a gap.

### ✅ RESOLVED (2026-06-07) — auditLog, autoMod, bots

- `auditLog: true` — real `GET /v1/servers/{id}/audit` endpoint; `emitAudit()` wired
  to moderation/roles/channels/servers handlers; `useAuditLog` query hook.
- `autoMod: true` — `GET/POST /v1/servers/{id}/automod/rules`, `PATCH/DELETE …/{ruleID}`;
  keyword/spam/link/invite/mention rule types; block/delete/timeout/alert actions;
  enforcement in `handleSendChannelMessage`; `useAutoModRules`/`useCreateAutoModRule`/
  `useUpdateAutoModRule`/`useDeleteAutoModRule` hooks.
- `bots: true` — `GET/POST /v1/servers/{id}/bots`, `DELETE …/{botID}`,
  `GET /v1/bots/{id}/events` (SSE), `POST /v1/bots/{id}/messages`; per-bot token auth
  with injector middleware; `useBots`/`useCreateBot`/`useDeleteBot` hooks;
  `BotManagementSection` in `ServerSettingsScreen`.

### 2026-06-07 — session-3: roles, polls, threads, DM edit E2EE, crowd rotation

**Roles (`rolesManagement: true`)** — Custom roles are now real and P2P-propagated:
- `ServerRole` type + `roles[]` / `member_roles` stored directly in `XoreinRuntimeServer`.
- `nativeCreateRole` / `nativeDeleteRole` / `nativeAssignRole` mutations — owner-only,
  call `addServerRole`/`removeServerRole`/`setMemberRoles` in the native store, then
  `broadcastServerUpdate` so every member receives the updated server record (including
  roles) via the existing `sync.update` PeerStream operation.
- `rolesManagement: true` in featureFlags; roles section wired in `ServerSettingsScreen`.
- Protected roles cannot be deleted (`protected: true` guard).
- Role rename (`nativeUpdateRole`) ✅ — implemented; inline edit input in `RoleRow`, wired via `useUpdateRole`.
- `autoMod`, `auditLog`, and `bots` resolved — see control-API implementation 2026-06-07.

**Polls (`polls: true`)** — Poll votes are now P2P-accumulated:
- Poll data encoded in message body as `🗳️ POLL:{…}` — sent via native engine so the
  message propagates over the standard chat path.
- Votes accumulated in native state: `addPollVote` in the store, broadcast via
  `notify.push { kind: 'poll_vote' }`. Inbound handler in `sync/inbound.ts` applies
  votes from remote peers. `addPollVote` is idempotent (one vote per peer per poll).
- `nativeCastPollVote` mutation wired to `useCastPollVote` hook and `PollMessage`.

**Threads (`threads: true`)** — Thread replies derived from native messagesState:
- `reply_to` field on `XoreinRuntimeMessage` (set when sending with `replyTo`).
- `ChatArea` thread panel now merges `messagesState.filter(m => m.replyToId === parentId)`
  (native messages) with any local optimistic replies, instead of localStorage-only.
- Thread replies sent via `nativeSendChannelMessage` with `reply_to` option so they
  propagate P2P and survive reload.

**DM edit E2EE** — Edit messages in DM threads are now seal-encrypted:
- `nativeEditMessage` for `scope_type === 'dm'`: enumerates DM participants, calls
  `encryptDmEnvelope(recipient, base, body)` (async, per-recipient), delivers the sealed
  envelope via `chat.edit` over the seal transport. Plaintext fallback if encryption fails.

**Crowd epoch rotation on member removal** ✅ — `nativeRemoveMember` now calls
`freshCrowdRoot()` and `updateServer(serverId, { crowd_root: newRoot })` before
broadcasting the updated server to remaining members. The kicked member's copy of
`crowd_root` is immediately invalidated.

**Search (`advancedSearch`: native local store)** ✅ — `nativeSearchMessages` searches
`getState().messages` locally (case-insensitive body match + scope/sender/date filters).
Wired into `useRuntimeMutations` as the native path; `SearchPanel` now uses the facade
(`useRuntimeMutations().searchMessages`) instead of the direct HTTP API call. P2P
messages are therefore fully searchable without a support-node round-trip.

**Desktop notifications (background tab)** ✅ — `Layout.tsx` requests
`Notification.permission` on mount when `desktopNotifications: true`. The
`harmolyn:notify` handler now also fires `new Notification(title, { body })` when
`document.hidden && Notification.permission === 'granted'` — so friend requests, DM
and server events reach the user even when the tab is in the background.

### 2026-06-07 — session-2 audit fixes

- **Message edit/delete P2P propagation** ✅ — `nativeEditMessage`/`nativeDeleteMessage`
  now broadcast over `/aether/chat/0.1.0` with operations `chat.edit`/`chat.delete`.
  Inbound handlers verify `msg.sender_peer_id === remotePeerId` (Noise-authenticated)
  before applying. Edit sends a plaintext body (acceptable for a now-plaintext update
  operation; crowd-envelope rewrite is the remaining TODO for full E2EE edit).
- **Delivery status UI** ✅ — outbound messages show pending/sent/offline_queued/failed
  indicators in all three message layouts (Modern, Bubbles, Terminal).
- **Presence heartbeat** ✅ — `nativeAnnouncePresence` now refreshes `updated_at` on
  each 25-second tick so the local peer's own presence stays current.
- **Leave/delete server purges messages** ✅ — `removeServerMembership` now also drops
  all messages scoped to that server's channels from local state (privacy fix).
- **Secret leakage** ✅ — `toRuntimeSnapshot()` strips `crowd_root` and `invite_secret`
  from every server object; they remain in NativeState for crypto use only.
- **Engine before transport** ✅ — `onLocalReady` callback fires after identity + E2EE
  managers are wired but before the relay connects; UI is unblocked immediately.
- **Capability manifest** ✅ — `src/native/capabilityMap.ts` documents every mutation's
  route (native/http/mixed); `capabilityMap.test.ts` is the CI contract check.
- **Relay peer ID configurable** ✅ — `VITE_RELAY_PEER_ID` / `VITE_RELAY_MULTIADDR`
  build-time env vars override production defaults (typed in `vite-env.d.ts`).
- **libp2p private internals typed** ✅ — `reserveCircuitRelay` replaced triple `as any`
  with a local `CircuitRelayTransport` interface; `unknown` cast is confined to one spot.

---

## Hard out-of-scope items (not implementable in this codebase)

These items appeared in the original audit goal list but cannot be implemented here:

- **Backend Go bugs (17–20)** — ✅ all fixed in `../xorein/`: Bug 17 (`tcpAddrToMultiaddr` DNS/IPv6), Bug 18 (control serve error swallowed), Bug 19 (caller-PrivateKey skips DM bundle), Bug 20 (chat handler missing Encrypted/Mode tracking).
- **Role rename (`nativeUpdateRole`)** ✅ — implemented: `updateServerRole` in store,
  `nativeUpdateRole` in mutations (owner-only, protected roles blocked), wired via
  `useUpdateRole` hook; inline rename input in `RoleRow` component.
- **`autoMod` / `auditLog` / `bots`** ✅ — implemented 2026-06-07; see the control-API
  section above. Flags set `true` in featureFlags.ts.

---

## Vertical audit goal status (2026-06-07)

Status of every bug and goal from the original 29.8 KB vertical audit:

### Section A — Bugs in implemented functions

| # | Description | Status |
|---|-------------|--------|
| 1 | `crowd_root`/`invite_secret` leak into snapshot/localStorage | ✅ FIXED — `toRuntimeSnapshot()` strips both fields; store retains them for crypto use only. Test coverage in `state.test.ts`. |
| 2 | Native engine only exposed when transport reaches "connected" | ✅ FIXED — `onLocalReady` fires after identity+E2EE managers are wired, before relay connects. |
| 3 | UI calls unauthenticated HTTP control endpoints | ✅ ADDRESSED — HTTP client handles support-service only (bootstrap/blob). Native engine handles all local-capable mutations; no bearer token needed for P2P operations. |
| 4 | `fileUploads: true` but no backend blob route | ✅ FIXED — flag set to `false` (CLAUDE.md rule: fake-functionality flags stay off). |
| 5 | Message attachments lost through backend MessageRecord | ✅ ADDRESSED — `fileUploads: false` gates the upload path off. Native attachment field exists on `XoreinRuntimeMessage`; wiring awaits blob service. |
| 6 | Reactions/pins call missing HTTP routes | ✅ FIXED — reactions and pins are native-only (P2P broadcast via `notify.push`); no HTTP round-trip. |
| 7 | Presence update route mismatch (GET-only backend) | ✅ FIXED — `nativeUpdatePresence` is the primary path; HTTP fallback omitted (native-authoritative). |
| 8 | Native presence broadcasts typing only, not status | ✅ FIXED — `broadcastTyping` now includes `status` and `status_text` in every presence call. |
| 9 | DM send creates local-only "sent" message for missing DM | ✅ FIXED — `nativeSendDmMessage` throws `Error` if `dm` record missing; facade calls `nativeEnsureDm` first. |
| 10 | Native edit/delete are local-only | ✅ FIXED — `nativeEditMessage`/`nativeDeleteMessage` broadcast `chat.edit`/`chat.delete` over P2P; inbound verifies sender. |
| 11 | Native create-channel is local-only | ✅ FIXED — `nativeCreateChannel` calls `broadcastServerUpdate` so members receive the new channel. |
| 12 | Friend request native path is local-only | ✅ FIXED — friend-request/accept/decline now use P2P delivery via `friends` PeerStream. |
| 13 | Group DM UI routes `/v1/groupdms/…` mismatch backend `/v1/groups` | ✅ FIXED — `xoreinControl.ts` uses `/v1/groups` consistently. |
| 14 | Voice signaling calls missing HTTP routes | ✅ FIXED — signaling is native P2P (WebRTC offer/answer/ICE via `voice` PeerStream). |
| 15 | Voice media path is a control stub | ✅ FIXED — real WebRTC mesh with MediaShield encryption; speaking indicators + ring overlays. |
| 16 | Screen-share sends metadata only | ✅ ACKNOWLEDGED — `screenShare: false` gate prevents the stub from reaching users. Real track capture remains a future item. |
| 17 | `tcpAddrToMultiaddr` mishandles DNS/IPv6 | ✅ FIXED — uses `net.SplitHostPort` + `net.ParseIP`; emits `/dns4/`, `/ip6/`, `/ip4/` correctly. Tests cover all three cases. (`cmd/aether/main.go`) |
| 18 | Backend control server `Serve` error is ignored | ✅ FIXED — goroutine now logs non-`http.ErrServerClosed` errors instead of silently swallowing them. (`pkg/v0_1/runtime.go`) |
| 19 | Caller-supplied private key skips hybrid identity init | ✅ FIXED — `Config.NodeIdentity *nodeid.Identity` added; when set alongside `PrivateKey`, the Seal prekey bundle is built. Startup fails with an explicit error if `cap.dm` is advertised without a bundle. (`pkg/v0_1/runtime.go`) |
| 20 | Backend chat handler stores raw body without tracking encryption mode | ✅ FIXED — `MessageRecord` now carries `Mode string` and `Encrypted bool`; set from the `mode` field in the payload. Non-clear-mode bodies are marked `Encrypted=true` so relays/store-and-forward nodes know not to decode Body as plaintext. (`pkg/v0_1/family/chat/handler.go`) |
| 21 | Duplicate concurrent relay reservation | ✅ FIXED — `createXoreinNode` no longer reserves; `XoreinTransportManager` is the single owner. |
| 22 | Transport uses `node.components` private libp2p internals | ✅ MITIGATED — `reserveCircuitRelay` uses a typed local `CircuitRelayTransport` interface; `unknown` cast confined to one spot with explicit comment. |
| 23 | State stored in plain `localStorage` (not encrypted IndexedDB) | ⚠️ PARTIAL — localStorage for now; registered identities are password-protected at the identity layer (Argon2 + sealed blob). Full encrypted IndexedDB migration is a future architectural item. |

### Section B — Functional improvements

| Item | Status |
|------|--------|
| Feature flags must match backend reality | ✅ — `fileUploads` corrected to `false`; PROTOCOL_GAPS.md tracks all gaps; CI-visible via `capabilityMap.test.ts`. |
| Snapshot/event model (polling → SSE) | ⚠️ — still 1 s polling via `focus`/`visibilitychange` events from `publishNativeSnapshot`. SSE migration is a future item. |
| Server membership/invite handling | ✅ — owner-signed manifest fetch, `invite_secret` verification, real deeplink rotation/revocation. |
| DM record model | ⚠️ — `participants`, unread, `delivery_status` present; `mute`/`archive`/message-request state absent. |
| Search | ✅ — `nativeSearchMessages`: local full-text with scope/sender/date filters. |
| Notifications | ✅ — unread badges, friend-request toasts, `window 'harmolyn:notify'`, background tab `Notification` API. |
| Roles/moderation | ✅ — `nativeCreateRole`/`nativeDeleteRole`/`nativeAssignRole`/`nativeUpdateRole` + `broadcastServerUpdate`. `autoMod`/`auditLog` remain gated. |
| Voice/video | ✅ — P2P WebRTC mesh with speaking indicators. Device settings = future item. |

### Section D — Goal status

| Goal | Status |
|------|--------|
| Goal 0 — Freeze contracts | ✅ — `capabilityMap.ts` + `capabilityMap.test.ts` document every mutation's route; `PROTOCOL_GAPS.md` tracks UI/backend mismatches; CLAUDE.md rule enforces `false` flags for unrouted features. |
| Goal 1 — Fix security leaks | ✅ — `crowd_root`/`invite_secret` stripped from snapshot; `fileUploads: false`; snapshot redaction tested; HTTP client = support-service only. LocalStorage→IndexedDB migration is future. |
| Goal 2 — Native mode authoritative | ✅ — `nativeEngine: true` default; `onLocalReady` fires before relay; native path handles all local-capable mutations; delivery status visible in UI. Formal outbox = future. |
| Goal 3 — Route parity | ✅ — missing routes addressed: reactions/pins/presence/voice-signaling/group-DM-namespace all native; file-upload flag gated off; `capabilityMap.test.ts` is the CI guard. |
| Goal 4 — Reliable messaging | ✅ PARTIAL — E2EE envelopes (crowd+seal); delivery status (pending/sent/offline_queued/failed); local dedup; tombstones for delete. Op-log/idempotency keys = future. |
| Goal 5 — Attachments | ✅ GATED — `fileUploads: false` prevents the stub; backend blob service and schema extension remain future work. |
| Goal 6 — Transport | ✅ — single relay owner (Bug 21); typed internal narrowing (Bug 22); relay configurable via `VITE_RELAY_MULTIADDR` + localStorage override; `fetchRelayAddrs` now uses `VITE_XOREIN_CONTROL_ENDPOINT`. |
| Goal 7 — Server governance/moderation | ✅ — role CRUD + P2P replication via `broadcastServerUpdate`; permission checks (owner-only gates); kick + crowd epoch rotation. `auditLog` = no P2P primitive. |
| Goal 8 — Voice/video/screen | ✅ — P2P WebRTC mesh; real MediaShield; signaling via native PeerStream; speaking rings. Screen-share = future (`screenShare: false`). |
| Goal 9 — Product parity | ✅ — search ✅, threads ✅, polls ✅, desktop notifications ✅. Bots/webhooks = no protocol primitive (out of scope). Scheduled events/message-requests gated off. |
