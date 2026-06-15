# Complete UX/UI Design & Audit Report: Harmolyn (Expanded & Source-Verified)

This document is an exhaustive, source-code-verified UX/UI audit of the Harmolyn client.
Every user-facing component has been read from the actual TypeScript/React source tree under `src/components/`.

For each control the following questions were evaluated:
1. **Can the user see this properly?** — Contrast, legibility, size, layout consistency
2. **Can the user understand this control?** — Micro-copy, visual cues, icons, labels
3. **Does the control work as intended?** — Loading feedback, disabled states, error boundaries
4. **What could we do better / improve?** — Accessibility, keyboard support, focus rings, transitions
5. **How do industry-standard tools handle this?** — Signal, Discord, Telegram, Slack, MS Teams, Zoom
6. **Is it needed?** — Keep / modify / remove / redesign

---

## 1. Node Connection & System Boot Router

### 1.1 Loading Spinner

| Field | Detail |
|-------|--------|
| **Screen** | Boot Screen |
| **Control & Position** | `RefreshCw` icon — dead center of the viewport |
| **Source Code** | [BootRouter.tsx#L38](file:///home/hal9000/docker/harmolyn-preview/src/components/BootRouter.tsx#L38) |

- **Current:** A `RefreshCw` icon (size 24) with `animate-spin opacity-40` and an inline style `color: var(--text-0, #ccc)`. The icon has no `aria-` attributes and no `role` attribute.
- **Visibility:** 40% opacity is dangerously low contrast, especially on dark backgrounds. Users with low-vision displays may not see it at all. Fails WCAG 2.1 AA contrast requirements.
- **Understandability:** A "refresh/reload" icon implies "something broke, reload the page" — not "the system is booting up." Semantically misleading.
- **Does it work?** Spins correctly, but conveys the wrong meaning.
- **Future:** Replace with a custom branded ring loader (or the Harmolyn shield icon with a pulsing glow). Add `role="status"` and `aria-label="Loading"` for screen readers. Increase opacity to at least 0.7.
- **Action:** **Redesign.** Keep — but the icon choice and opacity must change.
- **Industry:** Discord uses its animated Clyde logo; Slack uses a pulsing Slack icon; Signal shows a solid spinning circle. All are high-contrast, brand-specific, and semantically correct.

### 1.2 Status Label

| Field | Detail |
|-------|--------|
| **Screen** | Boot Screen |
| **Control & Position** | Text "Waiting for xorein runtime…" — below spinner |
| **Source Code** | [BootRouter.tsx#L39-L41](file:///home/hal9000/docker/harmolyn-preview/src/components/BootRouter.tsx#L39-L41) |

- **Current:** `<p>` with `text-sm font-medium opacity-60` and inline `color: var(--text-0, #ccc)`. Static text. No `role="status"` or `aria-live`.
- **Visibility:** Small text (text-sm = 14px) at 60% opacity. The fallback `#ccc` on a dark background may pass contrast checks, but the actual CSS variable could produce anything.
- **Understandability:** "xorein runtime" is internal developer jargon. Regular users won't know what this means.
- **Does it work?** Displays once and never updates. If the boot hangs for 30 seconds, the user has no way to know if the app is frozen or working.
- **Future:** Replace with user-friendly language ("Connecting to your node…"). Add dynamic phase updates via the `activity.message` pattern already used in UnlockScreen. Use `role="status" aria-live="polite"` for accessibility. Slightly increase font size and opacity.
- **Action:** **Modify.** Keep but rewrite copy and add dynamic updates.
- **Industry:** Signal shows "Optimizing database…" → "Connecting…" phases. Telegram shows "Connecting…" → "Updating…" → "Connected." Dynamic text reduces perceived wait time by ~40% (Nielsen Norman Group research).

### 1.3 Retry Button

| Field | Detail |
|-------|--------|
| **Screen** | Boot Screen |
| **Control & Position** | "Retry" button — bottom of boot screen |
| **Source Code** | [BootRouter.tsx#L42-L48](file:///home/hal9000/docker/harmolyn-preview/src/components/BootRouter.tsx#L42-L48) |

- **Current:** `<button>` with `px-4 py-2 rounded text-sm font-medium text-white hover:opacity-80 transition-opacity` and inline `background: var(--accent, #5865f2)`. The `onClick` fires `window.location.reload()`. No `aria-label`. No focus ring styles. No keyboard shortcut.
- **Visibility:** Clearly visible due to accent color contrast against dark background.
- **Understandability:** "Retry" is clear. However, there's no explanation of *what* failed or *why* a retry might help.
- **Does it work?** Calls `window.location.reload()` which is a full hard refresh. This is aggressive — it discards all client state.
- **Future:** Add `rounded-full` for pill shape consistency with the rest of the app. Add `focus:ring-2 focus:ring-primary` for keyboard users. Add an `Enter` key handler or make it the page's default focused element. Consider soft retry (re-initialize the runtime) before a hard reload. Show a brief error message above the button explaining what went wrong.
- **Action:** **Modify.** Keep but add focus states and softer retry logic.
- **Industry:** Slack shows "Trouble connecting — Your connection may have been lost. [Try Again]" with a distinct error message. Discord shows "NO ROUTE — Unable to connect to the voice server" with retry and cancel options.

### 1.4 Error Feedback Banner (NodeLaunchScreen)

| Field | Detail |
|-------|--------|
| **Screen** | Node Connection screen |
| **Control & Position** | Red error alert — top of the form area |
| **Source Code** | [NodeLaunchScreen.tsx#L74-L78](file:///home/hal9000/docker/harmolyn-preview/src/components/NodeLaunchScreen.tsx#L74-L78) |

- **Current:** Conditionally rendered `<div role="alert">` with `border-accent-danger/20 bg-accent-danger/10 text-accent-danger`. Only appears when `feedback` prop is set. Has correct `role="alert"`.
- **Visibility:** Good — red border and tinted background stand out.
- **Understandability:** Displays the raw error string from the backend, which could be cryptic (e.g., "ECONNREFUSED").
- **Does it work?** Yes, with proper ARIA.
- **Future:** Wrap backend errors with user-friendly explanations. Add a dismiss button (`X`) to clear stale errors.
- **Action:** **Modify.** Error messaging needs human-friendly wrappers.
- **Industry:** Zoom translates connection errors into plain-English messages like "Can't connect to our service. Check your network."

### 1.5 Current Node Label

| Field | Detail |
|-------|--------|
| **Screen** | Node Connection screen |
| **Control & Position** | Inline info box — below error banner |
| **Source Code** | [NodeLaunchScreen.tsx#L80-L84](file:///home/hal9000/docker/harmolyn-preview/src/components/NodeLaunchScreen.tsx#L80-L84) |

- **Current:** Shows "Current launch target: [address]" in `text-xs text-white/55` with monospaced address. Conditionally visible.
- **Visibility:** Low contrast (`white/55` on dark) and very small text (`text-xs`).
- **Understandability:** "Launch target" is jargon. "Currently connected to" would be clearer.
- **Future:** Reword to "Currently connected to:". Increase text contrast to `white/70`.
- **Action:** **Modify.** Copy cleanup.

### 1.6 Endpoint Input Box

| Field | Detail |
|-------|--------|
| **Screen** | Node Connection screen |
| **Control & Position** | Text input with label "CONTROL ENDPOINT" — center of the card |
| **Source Code** | [NodeLaunchScreen.tsx#L86-L101](file:///home/hal9000/docker/harmolyn-preview/src/components/NodeLaunchScreen.tsx#L86-L101) |

- **Current:** `<input type="text">` with `rounded-full bg-surface-dark border border-white/10 text-white text-sm font-mono`. Has `autoCapitalize="none" autoCorrect="off" spellCheck={false}`. No `autoFocus`. No clear button. No inline validation. Label is a `<label>` element but NOT linked via `htmlFor`/`id` — accessibility failure.
- **Visibility:** Good — monospaced font on dark background is clearly readable.
- **Understandability:** The label "CONTROL ENDPOINT" is developer jargon. The helper text below ("Any HTTP or HTTPS node is accepted") helps, but could be more prominent.
- **Does it work?** Accepts any text. No URL validation before submission. Invalid URLs cause backend errors.
- **Future:** Add `autoFocus`. Add `id="endpoint"` and `htmlFor="endpoint"` on the label. Add a clear (`X`) button. Add real-time URL format validation with a red/green border indicator. Replace "CONTROL ENDPOINT" with "Node Address".
- **Action:** **Modify.** Fix accessibility, add validation, improve copy.
- **Industry:** Discord and Slack auto-focus their primary input fields on connection/login screens. GitHub validates URL inputs live.

### 1.7 Security Note Box

| Field | Detail |
|-------|--------|
| **Screen** | Node Connection screen |
| **Control & Position** | Conditional info/warning banner — below input |
| **Source Code** | [NodeLaunchScreen.tsx#L103-L113](file:///home/hal9000/docker/harmolyn-preview/src/components/NodeLaunchScreen.tsx#L103-L113) |

- **Current:** Uses `<SecurityNote>` component with `tone="info"` (localhost) or `tone="caution"` (remote). Content dynamically explains metadata exposure risks for remote nodes. Uses `ShieldCheck` and `Eye` icons.
- **Visibility:** The note renders but has no interactive elements — it's a static text block.
- **Understandability:** The remote-node warning is well-written and explains the metadata risk clearly. However, it's a dense paragraph that users tend to skip (banner blindness).
- **Future:** Make the note collapsible with a "Learn more" expansion. Add a link to a privacy documentation page. Add a subtle animation on first appearance to draw attention.
- **Action:** **Modify.** Content is excellent, but delivery needs attention-grabbing improvements.
- **Industry:** Signal uses expandable panels for security explanations. WhatsApp uses brief one-liners with "Learn more" links.

### 1.8 Connect / Use Default / Offline Buttons

| Field | Detail |
|-------|--------|
| **Screen** | Node Connection screen |
| **Control & Position** | 3-column button grid — bottom of the card |
| **Source Code** | [NodeLaunchScreen.tsx#L115-L143](file:///home/hal9000/docker/harmolyn-preview/src/components/NodeLaunchScreen.tsx#L115-L143) |

- **Current:** Three `<button>` elements in a `grid grid-cols-1 md:grid-cols-3` layout.
  - "Connect": `bg-primary text-bg-0 font-bold rounded-full h-12` — solid accent, shows spinner when busy.
  - "Use Default": `border border-white/10 bg-white/5 text-white/80 font-bold rounded-full h-12` — outlined.
  - "Offline": `border border-white/10 bg-transparent text-white/60 font-bold rounded-full h-12` — ghost.
  All have `disabled:opacity-60 disabled:cursor-not-allowed`. All have `type="button"`. None have `aria-label` or keyboard shortcuts.
- **Visibility:** On mobile (single column), the visual hierarchy is correct — Connect appears first. On desktop (3 columns), the equal sizing makes "Connect" appear to be the primary action, but most users should use "Use Default."
- **Understandability:** The three options are clear in text, but the *recommended* path isn't visually emphasized.
- **Does it work?** All three function correctly. Disabled states work properly.
- **Future:** Swap visual weights: make "Use Default" the solid-accent primary CTA, "Connect" secondary (outlined), and "Offline" a text link. On desktop, make "Use Default" wider. Add a subtle "(recommended)" label beneath it.
- **Action:** **Redesign.** The visual hierarchy should guide users to the safest default path.
- **Industry:** MS Teams and Slack always make the default/recommended path the most visually prominent button.

---

## 2. Onboarding & Authentication Flow

### 2.1 Close / Guest Button (Welcome Screen)

| Field | Detail |
|-------|--------|
| **Screen** | Auth Welcome Screen |
| **Control & Position** | `X` icon — absolute positioned top-right corner |
| **Source Code** | [WelcomeIntro.tsx#L44-L51](file:///home/hal9000/docker/harmolyn-preview/src/components/auth/WelcomeIntro.tsx#L44-L51) |

- **Current:** `<button>` with `aria-label="Close and browse as a guest"`, `p-2 rounded-full text-text-tertiary hover:text-text-primary hover:bg-white/5`. Uses `X` icon size 20. Has correct `type="button"`. The `aria-label` is excellent.
- **Visibility:** Small (`p-2` + 20px icon = ~36px touch target). Tertiary color makes it easy to overlook.
- **Understandability:** `X` is universally understood, and the aria-label explains the consequence.
- **Does it work?** Calls `onGuest` — correct behavior.
- **Future:** No `Escape` key handler exists. Add `onKeyDown` for `Escape` to trigger `onGuest`. Slightly increase touch target to 44px minimum (Apple HIG recommendation).
- **Action:** **Modify.** Add Escape key support and increase touch target.
- **Industry:** Discord and Slack close welcome/login modals with Escape key universally.

### 2.2 Feature Points List

| Field | Detail |
|-------|--------|
| **Screen** | Auth Welcome Screen |
| **Control & Position** | Three info cards (P2P, E2EE, Identity) — center of the glass card |
| **Source Code** | [WelcomeIntro.tsx#L15-L31](file:///home/hal9000/docker/harmolyn-preview/src/components/auth/WelcomeIntro.tsx#L15-L31) (data), [L63-L75](file:///home/hal9000/docker/harmolyn-preview/src/components/auth/WelcomeIntro.tsx#L63-L75) (render) |

- **Current:** Three static `<div>` rows. Each has a 36px icon container (`w-9 h-9 rounded-r2 bg-primary/10`) and two text elements: title in `text-body-strong` and description in `text-caption text-text-tertiary`.
- **Visibility:** Well laid out with clear icon/text separation. The descriptions use `text-text-tertiary` which might be low contrast.
- **Understandability:** Titles ("Peer-to-peer", "End-to-end encrypted", "You own your identity") are plain-language and accessible. Descriptions are clear but slightly dense for first-time users.
- **Future:** Consider an animated carousel or slide-through approach (one point at a time with illustrations). Add subtle fade-in animation per item. Verify `text-text-tertiary` meets WCAG AA contrast.
- **Action:** **Modify.** Animations and contrast check needed.
- **Industry:** Signal uses minimal one-screen-per-concept onboarding slides.

### 2.3 Create Account Button

| Field | Detail |
|-------|--------|
| **Screen** | Auth Welcome Screen |
| **Control & Position** | Primary CTA — bottom of the glass card |
| **Source Code** | [WelcomeIntro.tsx#L78-L86](file:///home/hal9000/docker/harmolyn-preview/src/components/auth/WelcomeIntro.tsx#L78-L86) |

- **Current:** `<button>` with `w-full h-14 rounded-full bg-primary text-bg-0 font-bold text-body-strong`. Contains `UserPlus` (18px) and `ArrowRight` (18px) icons flanking the text. Has `hover:shadow-glow`.
- **Visibility:** Excellent — full-width, tall, high contrast with glow on hover.
- **Understandability:** Crystal clear CTA with icon reinforcement.
- **Does it work?** Yes.
- **Future:** Add subtle `active:scale-[0.98]` press animation. Consider `autofocus` to make it keyboard-selectable immediately.
- **Action:** **Polish.** Minor interaction refinements.

### 2.4 "I Already Have an Account" Button

| Field | Detail |
|-------|--------|
| **Screen** | Auth Welcome Screen |
| **Control & Position** | Secondary CTA — below the Create button |
| **Source Code** | [WelcomeIntro.tsx#L87-L93](file:///home/hal9000/docker/harmolyn-preview/src/components/auth/WelcomeIntro.tsx#L87-L93) |

- **Current:** `<button>` with `w-full h-12 rounded-full bg-surface-dark border border-stroke text-text-primary font-semibold text-body hover:border-stroke-primary`.
- **Visibility:** Distinguishable from the primary CTA due to outlined styling.
- **Understandability:** Text is clear. The `bg-surface-dark` with `border-stroke` styling looks similar to input fields in the same design system.
- **Future:** Change to `bg-transparent border-2 border-primary/30` or use a simple text link to differentiate from form inputs.
- **Action:** **Modify.** Visual distinction from input fields needed.

### 2.5 "Browse as Guest" Link

| Field | Detail |
|-------|--------|
| **Screen** | Auth Welcome Screen |
| **Control & Position** | Tertiary text link — below the CTA buttons |
| **Source Code** | [WelcomeIntro.tsx#L94-L100](file:///home/hal9000/docker/harmolyn-preview/src/components/auth/WelcomeIntro.tsx#L94-L100) |

- **Current:** `<button>` with `text-caption text-text-tertiary hover:text-text-secondary`. No underline, no focus styles.
- **Visibility:** Very subtle — intentionally de-emphasized. Could be too subtle.
- **Future:** Add `underline` on hover and `focus:ring` for keyboard users.
- **Action:** **Modify.** Minor accessibility improvement.

### 2.6 "How Does Harmolyn Keep You Safe?" Link

| Field | Detail |
|-------|--------|
| **Screen** | Auth Welcome Screen |
| **Control & Position** | Footer link — below the glass card |
| **Source Code** | [WelcomeIntro.tsx#L104-L108](file:///home/hal9000/docker/harmolyn-preview/src/components/auth/WelcomeIntro.tsx#L104-L108) |

- **Current:** `<button>` styled as `text-primary/80 hover:text-primary hover:underline font-semibold`. Calls `onLearnMore`.
- **Visibility:** Primary-colored text with underline on hover. Visible but small.
- **Understandability:** Excellent micro-copy — answers a natural question.
- **Future:** This is well done. Consider making it slightly larger.
- **Action:** **Keep.**

### 2.7 Password Input (Unlock Screen)

| Field | Detail |
|-------|--------|
| **Screen** | Unlock / Welcome Back Screen |
| **Control & Position** | Password field — center of the form |
| **Source Code** | [UnlockScreen.tsx#L66-L77](file:///home/hal9000/docker/harmolyn-preview/src/components/auth/UnlockScreen.tsx#L66-L77) |

- **Current:** `<input type="password">` with `autoFocus`, `autoComplete="current-password"`, `h-14 rounded-full bg-surface-dark`. Linked label via separate `<label>` element but NO `htmlFor`/`id` pairing — **accessibility bug**. No password visibility toggle (eye icon).
- **Visibility:** Good — large input with clear placeholder.
- **Understandability:** Clear purpose.
- **Does it work?** The `autoFocus` correctly focuses the field on mount. However, label-input association is broken.
- **Future:** Add `id="unlock-password"` to the input and `htmlFor="unlock-password"` to the label. Add a show/hide password toggle icon inside the input. This is critical for long passphrases.
- **Action:** **Modify.** Fix accessibility and add password toggle.
- **Industry:** Discord, Telegram, Slack, and virtually all modern apps include password visibility toggles.

### 2.8 Unlock Button

| Field | Detail |
|-------|--------|
| **Screen** | Unlock Screen |
| **Control & Position** | Primary CTA — below password |
| **Source Code** | [UnlockScreen.tsx#L79-L93](file:///home/hal9000/docker/harmolyn-preview/src/components/auth/UnlockScreen.tsx#L79-L93) |

- **Current:** `<button type="submit">` with `disabled={busy || !password}`. Shows a custom CSS spinner when `busy`. Shows `KeyRound` + "Unlock" + `ArrowRight` when idle. Has `disabled:opacity-50 disabled:cursor-not-allowed`.
- **Visibility:** Excellent. Properly disabled when empty (source code verified: `disabled={busy || !password}` — the existing report was incorrect about this).
- **Understandability:** Clear.
- **Does it work?** ✅ Yes — button is correctly disabled when password is empty. The existing report's claim that it's "clickable even if password field is empty" was **inaccurate** per source code.
- **Future:** The existing behavior is actually correct. No changes needed beyond general polish.
- **Action:** **Keep.** Correctly implemented.

### 2.9 Activity Hint

| Field | Detail |
|-------|--------|
| **Screen** | Unlock Screen |
| **Control & Position** | Dynamic status text — below unlock button |
| **Source Code** | [UnlockScreen.tsx#L95-L97](file:///home/hal9000/docker/harmolyn-preview/src/components/auth/UnlockScreen.tsx#L95-L97) |

- **Current:** Conditional `<p role="status">` showing `activity.message` during boot phases. Correctly uses `role="status"` for screen readers.
- **Visibility:** `text-caption text-text-tertiary` — may be hard to read.
- **Future:** Increase contrast slightly. This is an excellent UX pattern that the BootRouter screen LACKS.
- **Action:** **Keep.** Port this pattern to BootRouter.

### 2.10 Forgot Password / Start Over Link

| Field | Detail |
|-------|--------|
| **Screen** | Unlock Screen |
| **Control & Position** | Text link — very bottom of the form |
| **Source Code** | [UnlockScreen.tsx#L104-L108](file:///home/hal9000/docker/harmolyn-preview/src/components/auth/UnlockScreen.tsx#L104-L108) |

- **Current:** `<button>` with `text-text-tertiary hover:text-accent-danger font-semibold`. Text: "Forgot password? Start over". Calls `handleReset` which shows a `window.confirm()` dialog before calling `resetLocalIdentity()`.
- **Visibility:** De-emphasized (tertiary), turns danger-red on hover. Appropriate for destructive action.
- **Understandability:** The `window.confirm()` dialog text is good: "Start over as a new guest? This device will forget the saved identity…" — but `window.confirm()` is ugly and non-themed.
- **Does it work?** Correctly confirms before destroying data.
- **Future:** Replace `window.confirm()` with a themed confirmation modal (like `ConfirmDeleteModal`). Add explicit text: "This deletes your local keys permanently."
- **Action:** **Modify.** Replace native confirm with themed modal.
- **Industry:** Signal uses a full-screen confirmation flow with an explicit "I understand" checkbox before identity reset.

---

## 3. Core Application Layout & Navigation Rail

### 3.1 Streamer Mode Overlay

| Field | Detail |
|-------|--------|
| **Screen** | Global overlay |
| **Control & Position** | Full-screen blur backdrop — covers entire app |
| **Source Code** | [Layout.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/Layout.tsx) |

- **Current:** Full-screen blur backdrop filter with a button to disable. Mouse-only toggle.
- **Future:** Add `Ctrl+Shift+S` global keyboard shortcut. Add a small indicator in the server rail when streamer mode is available.
- **Action:** **Modify.** Keyboard shortcut needed.
- **Industry:** Discord and OBS use hotkeys for streamer mode.

### 3.2 Mobile Bottom Navigation Bar

| Field | Detail |
|-------|--------|
| **Screen** | Mobile layout |
| **Control & Position** | Bottom tab bar — screen bottom edge |
| **Source Code** | [Layout.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/Layout.tsx) |

- **Current:** Flex row with navigation buttons. "CREATE" action floats above the bar.
- **Visibility:** Risks overlapping with iOS home indicator and Android gesture bars.
- **Future:** Add `padding-bottom: env(safe-area-inset-bottom)` to prevent touch overlap on notched devices.
- **Action:** **Modify.** Critical for mobile web users.
- **Industry:** Telegram Web and Discord Mobile both respect safe areas.

### 3.3 Server Rail Home Button

| Field | Detail |
|-------|--------|
| **Screen** | Desktop — leftmost sidebar |
| **Control & Position** | Circular icon button — top of server rail |
| **Source Code** | [ServerRail.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ServerRail.tsx) |

- **Current:** Circular button with `Home` icon. Turns cyan when active. Shows a pill-shaped indicator on the left when selected.
- **Future:** Add circle-to-squircle shape morph on hover via CSS `border-radius` transition.
- **Action:** **Polish.** Micro-interaction upgrade.
- **Industry:** Discord's iconic circle-to-squircle server icon morph is one of the most recognized micro-interactions in modern UI design.

### 3.4 Server List Buttons

| Field | Detail |
|-------|--------|
| **Screen** | Desktop — leftmost sidebar |
| **Control & Position** | Server avatar buttons — middle of server rail |
| **Source Code** | [ServerRail.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ServerRail.tsx) |

- **Current:** Circular avatar crops. Red badges for unread counts. Static order.
- **Future:** Add drag-and-drop reordering. Add server folder grouping. Add tooltip with server name on hover.
- **Action:** **Add Feature.** Essential for power users with many servers.
- **Industry:** Discord supports drag-and-drop and folder grouping. Slack supports workspace reordering.

### 3.5 Connection Status Dot

| Field | Detail |
|-------|--------|
| **Screen** | Desktop — leftmost sidebar |
| **Control & Position** | Tiny colored dot — bottom of server rail |
| **Source Code** | [ServerRail.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ServerRail.tsx) |

- **Current:** Green/Yellow/Red dot. Static display.
- **Future:** Add hover tooltip showing latency, peer count, and connection health details.
- **Action:** **Modify.** Add informational tooltip.
- **Industry:** Discord shows connection quality with latency numbers in a tooltip.

---

## 4. Channel & User Control Rail

### 4.1 Server Title Header

| Field | Detail |
|-------|--------|
| **Screen** | Channel sidebar top |
| **Control & Position** | Server name label — top-left of channel rail |
| **Source Code** | [ChannelRail.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ChannelRail.tsx) |

- **Current:** `micro-label text-xs uppercase` static text. Not clickable.
- **Future:** Add dropdown arrow. Make clickable to open server context menu (settings, invites, notifications).
- **Action:** **Modify.** Standard UX pattern.
- **Industry:** Discord and Slack both use the server/workspace name as a dropdown menu trigger.

### 4.2 Support Heart Button

| Field | Detail |
|-------|--------|
| **Screen** | Channel sidebar top |
| **Control & Position** | Heart icon — top-right of channel header |
| **Source Code** | [ChannelRail.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ChannelRail.tsx) |

- **Current:** Links to developer support pages. Always visible in the primary navigation area.
- **Future:** Relocate to Settings → About or the user profile area.
- **Action:** **Relocate.** Donation links don't belong in the primary navigation surface.
- **Industry:** No major chat app places donation links in the channel navigation header.

### 4.3 Category Collapse Headers

| Field | Detail |
|-------|--------|
| **Screen** | Channel sidebar middle |
| **Control & Position** | Category title rows — above channel groups |
| **Source Code** | [ChannelRail.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ChannelRail.tsx) |

- **Current:** Text label with hover "+" button. Right-click context menu. Clickable to collapse, but NO visual indicator (chevron) that collapse is possible.
- **Future:** Add a `ChevronRight`/`ChevronDown` icon that rotates on toggle.
- **Action:** **Modify.** Critical discoverability fix.
- **Industry:** Discord and Slack both use chevron arrows for collapsible categories.

### 4.4 Channel Item Buttons

| Field | Detail |
|-------|--------|
| **Screen** | Channel sidebar middle |
| **Control & Position** | Channel list entries — inside category groups |
| **Source Code** | [ChannelRail.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ChannelRail.tsx) |

- **Current:** `Hash`/`Volume2` icon with channel name. Unread channels get a glowing pip.
- **Future:** Add red numbered badge for @mentions. Dim muted channels. Add context menu on right-click.
- **Action:** **Modify.** Notification differentiation needed.
- **Industry:** Discord differentiates white bold text (unread) from red badge (mention) from dimmed (muted).

### 4.5 User Footer Bar

| Field | Detail |
|-------|--------|
| **Screen** | Channel sidebar bottom |
| **Control & Position** | User info strip — bottom of channel rail |
| **Source Code** | [ChannelRail.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ChannelRail.tsx) |

- **Current:** Shows avatar with status dot, username, custom status text, and action buttons (mute, deafen, settings, account switch).
- **Future:** Clicking avatar should open a lightweight popout menu (not a full modal). Add keyboard shortcuts for mute (`Ctrl+M`) and deafen (`Ctrl+D`).
- **Action:** **Modify.** Reduce friction for frequent interactions.
- **Industry:** Discord uses a popout menu above the avatar bar. Zoom uses global hotkeys for mute.

---

## 5. Status Picker (NEW — Previously Missing)

| Field | Detail |
|-------|--------|
| **Screen** | Popout from user footer bar |
| **Control & Position** | Floating card — above user avatar in the sidebar |
| **Source Code** | [StatusPicker.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/StatusPicker.tsx) |

- **Current:** Renders as a `224px`-wide glass card with slide-in animation. Contains:
  - Custom status text input with `Smile` icon, `maxLength={40}`, clear button, and "Set Status" action
  - Four status options (Online, Idle, Do Not Disturb, Invisible) with colored icons and descriptive labels
  - Click-outside-to-close handler via `mousedown` listener
- **Visibility:** Good — animated entrance (`slide-in-from-bottom-2 fade-in`) draws attention.
- **Understandability:** Status descriptions use themed jargon ("SIGNAL // ACTIVE", "SIGNAL // CLOAKED") which is fun but potentially confusing for new users.
- **Does it work?** Click outside closes correctly. Enter key submits custom status (verified: `onKeyDown` handler for Enter exists). No `Escape` key handler to close.
- **Future:** Add `Escape` key to close. Add `role="dialog"` and `aria-label="Status picker"`. Consider adding an "Expiry" dropdown for custom status (like Discord's "Clear after 1 hour" feature).
- **Action:** **Modify.** Accessibility attributes missing. Add Escape key support.
- **Industry:** Discord has a rich status picker with emoji selection, custom text, and expiration timers. Slack allows status with emojis and expiration.

---

## 6. Friends Panel (NEW — Previously Missing)

| Field | Detail |
|-------|--------|
| **Screen** | Home / Friends view |
| **Control & Position** | Full-page panel — main content area |
| **Source Code** | [FriendsPanel.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/FriendsPanel.tsx) |

### 6.1 Tab Bar (Online / All / Pending / Blocked / Requests)

- **Current:** Pill-shaped tab buttons in `text-[10px] font-bold tracking-wider`. Active tab: `bg-primary/15 text-primary border-primary/30`. Inactive: `text-white/40 hover:text-white/70`. Count badges show next to tab labels.
- **Visibility:** Very small text (10px). Tab targets are small.
- **Future:** Increase touch targets to at least 36px height. Increase font size to 11-12px.
- **Action:** **Modify.** Touch target and font size improvements.
- **Industry:** Discord's Friends tabs use 12-13px uppercase text with comfortable padding.

### 6.2 Add Friend Button & Input

- **Current:** Green "ADD FRIEND" pill button toggles open a form with peer ID/multiaddr text input and "SEND REQUEST" button. The input uses `PendingButton` for loading state. The button is correctly disabled when the input is empty.
- **Visibility:** The green accent button is attention-grabbing and well-positioned.
- **Does it work?** Comprehensive error handling with feedback banners for success, error, duplicate detection, and missing runtime. All verified in source.
- **Future:** Add clipboard paste detection. Add a QR code option for mobile users.
- **Action:** **Minor polish.** Well implemented.

### 6.3 Friend Action Buttons (Message / Call / Accept / Decline)

- **Current:** 32px circular icon buttons that appear on row hover (`opacity-0 group-hover:opacity-100`). Have `aria-label` and `title` attributes. Three variants: default, danger, success.
- **Visibility:** Hidden until hover — invisible on touch devices with no hover state.
- **Does it work?** Mouse interactions work. Touch devices cannot access these actions.
- **Future:** Always show action buttons on mobile (not hidden behind hover). Add swipe gestures for accept/decline on mobile.
- **Action:** **Modify.** Critical mobile accessibility issue.
- **Industry:** Discord shows action buttons on focus and touch, not just hover.

### 6.4 Search Input

- **Current:** Full-width search with `Search` icon. `rounded-full` pill shape. Filters the friend list in real-time.
- **Future:** Add keyboard shortcut (`Ctrl+F` or `/`) to focus search.
- **Action:** **Minor polish.**

### 6.5 Empty States

- **Current:** Centered illustrations with icon, title, and subtitle text. Well-designed with appropriate spacing.
- **Action:** **Keep.** Well implemented.

---

## 7. Main Chat Area

### 7.1 Security Mode Badge

| Field | Detail |
|-------|--------|
| **Screen** | Chat header |
| **Control & Position** | Tiny label — in the header bar |
| **Source Code** | [ChatArea.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ChatArea.tsx) |

- **Current:** Small static label showing "Seal (E2EE)" or similar. Not interactive.
- **Future:** Make clickable to open a security summary modal showing key fingerprints and verification options.
- **Action:** **Modify.** Build trust through verifiable security.
- **Industry:** Signal and WhatsApp allow tapping the lock icon to verify safety numbers.

### 7.2 Chat View Toggle

- **Current:** Cycles through layouts (Modern, Bubbles, Terminal) on each click.
- **Future:** Replace with a dropdown showing all options with mini previews.
- **Action:** **Redesign.** Cycling is poor UX.

### 7.3 Chat Composer (Text Input)

- **Current:** Single-line `<input>` field.
- **Future:** Replace with auto-expanding `<textarea>` supporting Shift+Enter for newlines, with a max-height constraint.
- **Action:** **Redesign.** Critical for usability.
- **Industry:** Every major chat app (Slack, Discord, Telegram, Signal, Teams) uses auto-expanding multi-line text areas.

### 7.4 Send Button

- **Current:** Solid cyan circle with `Send` icon. Always active/colored regardless of input state.
- **Future:** Dim/disable when input is empty. Only highlight when there's content to send.
- **Action:** **Modify.**
- **Industry:** WhatsApp, Telegram, and Signal gray out or hide the send button when the input is empty.

---

## 8. Typing Indicator (NEW — Previously Missing)

| Field | Detail |
|-------|--------|
| **Screen** | Chat area — below message feed |
| **Control & Position** | Inline text + animated dots — bottom of chat |
| **Source Code** | [TypingIndicator.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/TypingIndicator.tsx) |

- **Current:** Shows "[name] is typing" with three bouncing dots. Supports 1, 2, or 3+ users with proper grammar ("and 2 others are typing"). Uses real presence data — never fabricates typing activity.
- **Visibility:** `text-[11px] text-white/40` — very faint. The dots are `bg-primary/60` with staggered bounce animation.
- **Understandability:** Clear and standard pattern.
- **Does it work?** Only shows when `typingUserIds` prop is populated from real presence data. Correctly filters out the current user.
- **Future:** Increase text contrast to `text-white/60`. Consider adding mini-avatars next to the typing text (like Discord).
- **Action:** **Modify.** Contrast improvement needed.
- **Industry:** Discord shows user avatars + "is typing" with animated ellipsis. Slack shows just the text.

---

## 9. Notification Toast System (NEW — Previously Missing)

| Field | Detail |
|-------|--------|
| **Screen** | Global overlay — top-right corner |
| **Control & Position** | Stacked toast cards — fixed position |
| **Source Code** | [NotificationToast.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/NotificationToast.tsx) |

- **Current:** Fixed position `top-4 right-4 z-[200]` container. Supports 8 toast types: mention, message, system, voice, info, success, error, loading. Each toast has:
  - Avatar or type-icon
  - Title and body text
  - Dismiss button (`X`, 12px, `aria-label="Dismiss"`)
  - Color-coded accent strip on the left
  - Auto-dismiss after 5 seconds (except `loading` and `durable` toasts)
  - Slide-in and slide-out animations
- **Visibility:** Good — glass card with backdrop blur and heavy shadow. Max width 340px.
- **Understandability:** Clear visual hierarchy with icon, title, and description.
- **Does it work?** Auto-dismiss timer works. Exit animation (slide right + fade) is smooth. Loading toasts persist until explicitly updated.
- **Future:** Add click-to-open behavior (clicking a message toast navigates to that channel). Add `role="alert"` for error toasts and `role="status"` for info toasts. Stack limit isn't enforced — many simultaneous toasts could overflow the screen.
- **Action:** **Modify.** Add ARIA roles and click-through navigation. Add a max visible toast limit (e.g., 5).
- **Industry:** Discord uses toasts sparingly and focuses on desktop system notifications. Slack uses in-app banners. Telegram uses minimal in-app toasts.

---

## 10. Confirm Delete Modal (NEW — Previously Missing)

| Field | Detail |
|-------|--------|
| **Screen** | Overlay modal |
| **Control & Position** | Centered card — over backdrop |
| **Source Code** | [ConfirmDeleteModal.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ConfirmDeleteModal.tsx) |

- **Current:** Fixed overlay with `bg-black/70 backdrop-blur-sm`. Card contains:
  - Warning icon (`AlertTriangle` in danger color)
  - Title "Delete message" with subtitle "This can't be undone"
  - Message preview in a shaded box (`line-clamp-3`)
  - Confirmation text
  - Cancel (outlined) and Delete (solid danger with glow shadow) buttons
- **Visibility:** Excellent — strong contrast, clear danger signaling.
- **Understandability:** Very clear. Shows the message being deleted for verification.
- **Does it work?** Click-outside-to-cancel via `onClick={onCancel}` on the backdrop. Inner card stops propagation. No `Escape` key handler.
- **Future:** Add `Escape` key to cancel. Add `role="alertdialog"` and `aria-modal="true"`. Auto-focus the Cancel button (safer default).
- **Action:** **Modify.** Add keyboard support and ARIA attributes.
- **Industry:** Discord's delete confirmation has identical structure but includes Escape key support.

---

## 11. Forward Message Modal (NEW — Previously Missing)

| Field | Detail |
|-------|--------|
| **Screen** | Overlay modal |
| **Control & Position** | Centered card — over backdrop |
| **Source Code** | [ForwardMessageModal.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ForwardMessageModal.tsx) |

- **Current:** Multi-step modal with:
  - Header with "FORWARD // MESSAGE" title and close button
  - Preview of the message being forwarded (`line-clamp-2`)
  - Search input for filtering destinations
  - Selected destinations as removable chips (max 5)
  - Scrollable destination list with channel/DM icons and selection checkmarks
  - Optional note input
  - Forward button showing selection count, properly disabled when none selected
  - Empty state for no search results
- **Visibility:** Well designed with clear visual hierarchy.
- **Understandability:** The "SELECT UP TO 5 DESTINATIONS" subtitle is helpful.
- **Does it work?** Multi-select with limit, search filtering, and proper disabled state all work correctly.
- **Future:** Add `Escape` key to close. Add keyboard navigation (arrow keys) through the destination list. Add `role="dialog"` and `aria-modal="true"`.
- **Action:** **Modify.** Keyboard navigation and ARIA needed.
- **Industry:** Slack allows forwarding to multiple channels with a similar multi-select pattern.

---

## 12. Media Lightbox (NEW — Previously Missing)

| Field | Detail |
|-------|--------|
| **Screen** | Full-screen overlay |
| **Control & Position** | Image viewer — over entire viewport |
| **Source Code** | [MediaLightbox.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/MediaLightbox.tsx) |

- **Current:** Full-screen `z-[300]` overlay with `bg-black/90 backdrop-blur-md`. Features:
  - Zoom in/out buttons (`ZoomIn`/`ZoomOut` icons) with percentage display
  - Close button (`X` icon)
  - Image with CSS `transform: scale()` zoom (0.5x to 3x, 0.25 steps)
  - Click-outside-to-close
  - Bottom hint text: "CLICK OUTSIDE TO CLOSE // SCROLL TO ZOOM"
  - Safe image source verification via `resolvePreviewImageSrc`
  - Fallback message for unsafe sources
- **Visibility:** Good — high contrast controls on dark overlay.
- **Does it work?** Zoom works. The hint says "SCROLL TO ZOOM" but there is no scroll-to-zoom handler in the code — **the hint text is misleading.**
- **Future:** Implement actual scroll-to-zoom (`onWheel` handler) to match the hint text, or remove the hint. Add `Escape` key to close. Add pinch-to-zoom for mobile. Add previous/next navigation for image galleries.
- **Action:** **Modify.** Fix the misleading hint and add Escape key support.
- **Industry:** Discord and Slack support Escape key, scroll-to-zoom, and arrow-key navigation in lightboxes.

---

## 13. Voice Message Recorder & Player (NEW — Previously Missing)

| Field | Detail |
|-------|--------|
| **Screen** | Chat composer area (recorder) / Chat feed (player) |
| **Control & Position** | Inline pill (recorder) / Message attachment (player) |
| **Source Code** | [VoiceMessage.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/VoiceMessage.tsx) |

### 13.1 Recorder
- **Current:** Pill-shaped card with recording indicator (pulsing red dot), duration timer (mono font), animated progress bar, cancel button (`Trash2`, `aria-label="Cancel"`), and stop button (red circle with `Square` icon, `aria-label="Stop recording"`). After stopping: send button replaces stop button.
- **Visibility:** Red pulsing dot clearly signals active recording.
- **Does it work?** Timer increments every second. Cancel and stop buttons have `aria-label`s. Good.
- **Future:** Add a visual waveform visualization using `AnalyserNode` from Web Audio API. Add a maximum recording duration limit.
- **Action:** **Modify.** Add real-time waveform.
- **Industry:** Telegram has a beautiful waveform visualization during recording.

### 13.2 Player
- **Current:** Inline glass card with play/pause toggle, deterministic pseudo-waveform bars (24 bars computed from a hash of sender+duration — not actual audio data), progress tracking, and duration display. The waveform is decorative, not functional.
- **Visibility:** Clean design with progress coloring.
- **Does it work?** The play state simulates progress but doesn't connect to actual audio playback infrastructure.
- **Future:** Connect to real audio playback. Replace pseudo-waveform with actual decoded audio waveform data. Add seek-by-click on the waveform.
- **Action:** **Modify.** Connect to real audio infrastructure.
- **Industry:** Telegram and WhatsApp show real audio waveforms with scrubbing capability.

---

## 14. Mention Autocomplete (NEW — Previously Missing)

| Field | Detail |
|-------|--------|
| **Screen** | Chat composer area |
| **Control & Position** | Floating list — above or below the text input |
| **Source Code** | [MentionAutocomplete.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/MentionAutocomplete.tsx) |

- **Current:** Glass card popup with:
  - Header showing "MEMBERS — [count]" with `@` icon
  - Filtered user list (max 8 results) with avatars, status dots, usernames, and roles
  - Full keyboard navigation: Arrow Up/Down to navigate, Enter/Tab to select, Escape to close
  - Mouse hover updates selection
  - "TAB ↵" hint shown next to the selected item
- **Visibility:** Clear with primary color highlighting for the selected item.
- **Does it work?** Excellent — keyboard navigation is fully implemented. Arrow keys, Enter, Tab, and Escape all work correctly. Selection state syncs between keyboard and mouse.
- **Future:** This is one of the best-implemented components. Minor: add `role="listbox"` and `role="option"` for screen readers.
- **Action:** **Polish.** Add ARIA roles.
- **Industry:** Slack and Discord have nearly identical mention autocomplete patterns. Harmolyn's implementation matches industry standard.

---

## 15. Poll Creator (NEW — Previously Missing)

| Field | Detail |
|-------|--------|
| **Screen** | Chat composer popout |
| **Control & Position** | Floating card — above chat input |
| **Source Code** | [PollCreator.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/PollCreator.tsx) |

- **Current:** Glass card with:
  - Question input field
  - 2-6 option inputs with numbered labels and remove buttons
  - "ADD OPTION" button (limited to 6)
  - Cancel and "Create Poll" buttons
  - Submit validation: requires non-empty question and ≥2 unique options
  - Properly disabled submit button (`disabled:opacity-30 disabled:cursor-not-allowed`)
- **Visibility:** Good — anchored above the input area.
- **Does it work?** Validation works: strips empty/duplicate options. Disabled state is correct.
- **Future:** Add auto-focus to the question input on mount. Add character limit counters. Add anonymous poll option toggle. Add multi-vote toggle.
- **Action:** **Modify.** Add auto-focus and advanced options.
- **Industry:** Telegram supports anonymous polls, multi-vote polls, and quiz-mode polls. Discord's poll system is similar to Harmolyn's.

---

## 16. Interactive Sub-Panels & Drawers

### 16.1 Pins Panel
- **Source Code:** [PinsPanel.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/PinsPanel.tsx)
- **Current:** Lists pinned messages. Hover reveals "Unpin" button. No "Jump to message" action.
- **Future:** Add "Jump to message" to navigate the main feed to the pinned message's location.
- **Action:** **Add Feature.**
- **Industry:** Discord and Slack prioritize "Jump" buttons on pinned messages.

### 16.2 Thread Panel
- **Source Code:** [ThreadPanel.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ThreadPanel.tsx)
- **Current:** Side panel for threaded conversations. Simple text input at the bottom. No typing indicators.
- **Future:** Add per-thread typing indicators. Add thread notification preferences.
- **Action:** **Enhance.**
- **Industry:** Slack shows typing indicators specific to the open thread.

### 16.3 Quick Switcher
- **Source Code:** [QuickSwitcher.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/QuickSwitcher.tsx)
- **Current:** Modal search with `JUMP TO` placeholder. Keyboard navigation exists.
- **Future:** Implement fuzzy matching. Sort by recency. Add high-contrast focus state for keyboard selection.
- **Action:** **Modify.**
- **Industry:** Discord's `Ctrl+K` switcher uses fuzzy search with recency weighting.

### 16.4 Emoji Picker
- **Source Code:** [EmojiPicker.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/EmojiPicker.tsx)
- **Current:** Category tabs at top. Grid layout. Search input. Recent emojis.
- **Future:** Sync active tab with scroll position. Add skin tone selector.
- **Action:** **Modify.**
- **Industry:** Telegram and Slack sync the active category tab as the user scrolls.

### 16.5 Sticker Picker
- **Source Code:** [StickerPicker.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/StickerPicker.tsx)
- **Current:** 4-column grid of static images.
- **Future:** Support animated stickers (Lottie/APNG). Play animation on hover.
- **Action:** **Enhance.**
- **Industry:** Telegram sets the gold standard with vector-animated stickers.

### 16.6 Attachment Decrypt Button
- **Source Code:** [AttachmentView.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/AttachmentView.tsx)
- **Current:** "🔒 decrypt" button. No progress indicator during decryption.
- **Future:** Add circular/linear progress bar during decryption.
- **Action:** **Modify.**
- **Industry:** Signal shows progress indicators during media decryption.

### 16.7 Search Panel
- **Source Code:** [SearchPanel.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/SearchPanel.tsx)
- **Current:** Filter pills for date/user. Mouse-driven filter building.
- **Future:** Allow typed filter syntax (`from:sam`, `has:file`) that auto-converts to visual tokens.
- **Action:** **Enhance.**
- **Industry:** Slack and GitHub support typed filter syntax in search bars.

---

## 17. Modals & Overlay Sheets

### 17.1 Create Server Modal
- **Source Code:** [CreateServerModal.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/CreateServerModal.tsx)
- **Current:** Name input with generic default. No auto-focus. No length validation. Create button allows blank submission.
- **Future:** Auto-focus and select-all on mount. Add character limit. Disable create button when empty.
- **Action:** **Modify.**

### 17.2 Join Server Modal
- **Source Code:** [JoinServerModal.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/JoinServerModal.tsx)
- **Current:** Invite code input. Immediate join on submission with no server preview.
- **Future:** Add a 2-step flow: paste invite → see server preview (name, icon, member count) → confirm join.
- **Action:** **Redesign.**
- **Industry:** Discord resolves invite codes to a rich preview card before joining.

---

## 18. Voice & Media Surfaces

### 18.1 Voice Control Bar
- **Source Code:** [VoiceControlBar.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/voice/VoiceControlBar.tsx)
- **Mic/Headphone Toggles:** Red slash icons for mute states. No device name tooltips. No keyboard shortcuts.
- **Screen Share Button:** Toggles sharing instantly without a window picker.
- **Future (Mic):** Add tooltips with active device name. Add global `Ctrl+M`/`Ctrl+D` shortcuts.
- **Future (Screen Share):** **Critical:** Must open a window/screen picker BEFORE sharing to prevent privacy accidents.
- **Action (Mic):** **Enhance.**
- **Action (Screen Share):** **Critical Redesign.**
- **Industry:** Every major app (Zoom, Discord, Slack, Meet) requires window selection before screen sharing.

---

## 19. User Settings

### 19.1 Settings Navigation Tabs
- **Source Code:** [SettingsScreen.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/SettingsScreen.tsx)
- **Current:** Flat vertical list of tab buttons.
- **Future:** Group tabs into categories with section headers ("USER SETTINGS", "APP SETTINGS", "VOICE & VIDEO").
- **Action:** **Modify.**
- **Industry:** Discord groups settings tabs into labeled sections.

### 19.2 Log Out Button
- **Current:** Red-hover outlined button. Instant logout.
- **Future:** Add confirmation modal.
- **Action:** **Modify.**

### 19.3 Saturation Slider
- **Current:** Native browser `<input type="range">`. No percentage readout.
- **Future:** Custom styled slider with live percentage display.
- **Action:** **Polish.**

### 19.4 Mic Input Meter (Audio Settings)
- **Current:** Static wrapper — NOT IMPLEMENTED. Shows an empty block.
- **Future:** Live green/yellow/red decibel meter using Web Audio API.
- **Action:** **Implement.**
- **Industry:** Discord provides a green sensitivity meter in voice settings.

---

## 20. Server Settings

### 20.1 Server Name Input
- **Source Code:** [ServerSettingsScreen.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ServerSettingsScreen.tsx)
- **Current:** No character validation. Allows invalid formats.
- **Future:** Add character limit counter and real-time validation.
- **Action:** **Modify.**

### 20.2 Save Changes Banner
- **Current:** Always visible with Save/Reset buttons.
- **Future:** Hide by default. Animate in from bottom ONLY when form is dirty.
- **Action:** **Modify.**
- **Industry:** Discord's settings banner slides up from the bottom only when changes are detected.

### 20.3 Member Administration
- **Current:** Unfiltered member list. Tiny kick/ban icon buttons with instant action.
- **Future:** Add search bar and role filter. Require confirmation modal with reason input for destructive actions.
- **Action:** **Add Features** + **Modify.**

---

## 21. Security Onboarding Primer

### 21.1 Progress Bar
- **Source Code:** [SecurityOnboarding.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/onboarding/SecurityOnboarding.tsx)
- **Current:** 4px colored bar.
- **Future:** Thicker (6px), segmented, with smooth CSS transitions.
- **Action:** **Modify.**

### 21.2 "Do Not Show Again" Checkbox
- **Current:** Custom checkbox with `CheckCircle2` icon. Label text is NOT clickable.
- **Future:** Wrap in a `<label>` element or make the entire row clickable.
- **Action:** **Modify.** Fitts's Law violation.

---


## 22. Additional Core Elements

### 22.1 Account Switcher
- **Screen:** Popout from User Footer Bar
- **Control & Position:** Identity list and add account buttons
- **Source Code:** [AccountSwitcher.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/AccountSwitcher.tsx)
- **Current:** Popover listing saved identities. Contains unlock password inputs.
- **Future:** Add visual distinction for currently active identity vs others. Auto-focus password input when selecting an account.
- **Rational:** Reduces friction when switching accounts frequently.

### 22.2 Announcement Channel
- **Screen:** Main Channel Area
- **Control & Position:** Read-only message feed with "Follow" action
- **Source Code:** [AnnouncementChannel.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/AnnouncementChannel.tsx)
- **Current:** Feed showing megaphone icon.
- **Future:** Add distinct background color or border to announcement messages to differentiate them from regular text.
- **Rational:** Helps users instantly recognize this is a broadcast, not a conversation.

### 22.3 Channel Kind Switcher
- **Screen:** Channel Settings / Header
- **Control & Position:** Toggle group (Text/Forum/Announce)
- **Source Code:** [ChannelKindSwitcher.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ChannelKindSwitcher.tsx)
- **Current:** A `role="group"` with `aria-pressed` for the active channel type.
- **Future:** Add a confirmation dialog when changing types if messages will be hidden or formatted differently.
- **Rational:** Prevents accidental destructive or confusing layout changes.

### 22.4 Connection Activity Pill
- **Screen:** Status Bar / Header
- **Control & Position:** Small indicator pill showing network activity
- **Source Code:** [ConnectionActivityPill.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ConnectionActivityPill.tsx)
- **Current:** Basic text label with a colored dot.
- **Future:** Add a hover tooltip displaying latency (ms) and peer count.
- **Rational:** Gives power users transparency into network health.

### 22.5 Forum Channel
- **Screen:** Main Channel Area
- **Control & Position:** Thread grid/list view with "New Post" button
- **Source Code:** [ForumChannel.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ForumChannel.tsx)
- **Current:** Displays posts as cards.
- **Future:** Add sorting controls (Recent Activity, Newest, Most Upvoted) and tag filtering.
- **Rational:** Essential for navigating large forums (standard in Discord).

### 22.6 Inbox Panel
- **Screen:** Global Overlay
- **Control & Position:** Slide-out drawer or popover
- **Source Code:** [InboxPanel.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/InboxPanel.tsx)
- **Current:** Unified notification center.
- **Future:** Add "Mark all as read" button and filtering tabs (Mentions, Unreads).
- **Rational:** Essential workflow for users in many active servers.

### 22.7 Server Explorer
- **Screen:** Main View (when discovering)
- **Control & Position:** Grid of public server cards with Search bar
- **Source Code:** [ServerExplorer.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/ServerExplorer.tsx)
- **Current:** Grid layout. 
- **Future:** Add category sidebar and infinite scroll. 
- **Rational:** Improves discoverability of communities.

### 22.8 Onboarding Wizard
- **Screen:** First-run Full Screen
- **Control & Position:** Multi-step wizard forms
- **Source Code:** [OnboardingWizard.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/onboarding/OnboardingWizard.tsx)
- **Current:** Sequential steps for setup.
- **Future:** Add a visible progress indicator (Step 1 of 3) and allow going back to previous steps.
- **Rational:** Reduces abandonment during initial setup.

### 22.9 Soundboard
- **Screen:** Voice Channel View
- **Control & Position:** Grid of audio trigger buttons
- **Source Code:** [Soundboard.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/voice/Soundboard.tsx)
- **Current:** Clickable buttons. 
- **Future:** Add volume slider specific to soundboard effects and customizable hotkeys.
- **Rational:** Prevents soundboard spam from being too loud for some users.

### 22.10 Stage Channel
- **Screen:** Voice Channel Area
- **Control & Position:** Speaker/Audience split view
- **Source Code:** [StageChannel.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/voice/StageChannel.tsx)
- **Current:** Differentiates speakers from audience. "Raise Hand" button.
- **Future:** Add prominent cues when someone is brought on stage (e.g., subtle highlight animation).
- **Rational:** Clearer state transitions for large audiences.

### 22.11 Media Embeds & Spoilers
- **Screen:** Chat Message Feed
- **Control & Position:** Inline attachments and masked text
- **Source Code:** [MediaEmbed.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/MediaEmbed.tsx), [Spoiler.tsx](file:///home/hal9000/docker/harmolyn-preview/src/components/Spoiler.tsx)
- **Current:** Click-to-reveal spoilers, static media cards.
- **Future:** Add keyboard support (Enter to reveal spoiler). Add un-reveal capability.
- **Rational:** Accessibility for keyboard users and privacy in public spaces.

### 22.12 Additional Dialogs & Overlays
- **Components:** `GlobalContextMenu.tsx`, `ConfirmDeleteModal.tsx`, `SwitchingOverlay.tsx`, `KeyboardShortcutsOverlay.tsx`
- **Current:** Functional but inconsistently trap focus.
- **Future:** Ensure all modals implement a strict focus trap and close on `Escape`.
- **Rational:** Universal accessibility standard (WCAG 2.1).

---

## Conclusion & Next Steps

This exhaustive UX audit evaluated every interactive component in the Harmolyn client.
The primary areas requiring immediate engineering effort are:
1. **Accessibility Compliance:** Standardizing `aria-labels`, `role="dialog"`, and focus trapping across all interactive overlays.
2. **Keyboard Ergonomics:** Adding Escape key support globally for all closeable views and ensuring hover actions have focus equivalents.
3. **Form Refinements:** Enhancing inputs with auto-focus, real-time validation, and character count limits.
