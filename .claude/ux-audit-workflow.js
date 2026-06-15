/* global phase, parallel, agent, log, args */

export const meta = {
  name: 'ux-audit-implement',
  description: 'Critically review the Harmolyn UX audit report per-component and implement the sound suggestions',
  phases: [
    { title: 'Implement', detail: 'one agent per file-group: audit + apply edits' },
    { title: 'Verify', detail: 'full build + vitest + lint' },
    { title: 'Fix', detail: 'repair build/test/lint failures' },
  ],
}

const REPORT = '/home/hal9000/docker/harmolyn-preview/ux_review_report.md'

const RUBRIC = [
  '1. VERIFY each claim against the CURRENT source FIRST. The report was written against possibly-stale source; the working tree has since changed. If a claim is already false (the feature is already present/correct), mark the item "skipped" with note "already correct".',
  '2. IMPLEMENT the suggestion if it is correct, scoped, safe, and uses existing tokens/primitives.',
  '3. IMPROVE & implement if the intent is right but the specifics do not fit this codebase (e.g. report says focus:ring-2 -> use the existing `focus-ring` class; report says add a per-component Escape handler -> use the shared useEscapeKey hook; report uses a wrong token/class name -> use the real one).',
  '4. SKIP (mark "skipped" + reason) if: the claim is simply wrong; OR it needs large infrastructure/data that does not exist in the current code (real decoded-audio playback, real decoded audio waveforms, WebRTC device/source enumeration beyond existing APIs, drag-and-drop reordering, animated-sticker/Lottie rendering, infinite-scroll over a non-paginated data source, a server-invite preview when no resolve API exists). For a big-but-correct suggestion, implement only the achievable, self-contained, correct subset (e.g. fix a misleading hint, add an onWheel handler, add a char counter, disable a button when empty) and SKIP the infra-dependent remainder with a clear note.',
  'Prefer correctness and a green build over coverage. A skipped item with a good reason is a success.',
].join('\n')

const CONVENTIONS = [
  'App TypeScript is intentionally NON-strict (tsconfig.app.json). `@/*` resolves to `./src/*`. Keep all imports valid.',
  'REUSE existing utilities — do NOT recreate them:',
  '  - Escape-to-close: `import { useEscapeKey } from "@/hooks/useEscapeKey"` then `useEscapeKey(onClose)`. (Just created for this pass.)',
  '  - Focus ring: add the `focus-ring` className (defined in index.css via :focus-visible, cyan ring). Do NOT use Tailwind `focus:ring-2 focus:ring-primary` — that ring color is not configured.',
  '  - Mobile safe area: add the `pb-safe` className (already in index.css = padding-bottom: env(safe-area-inset-bottom)).',
  '  - Spinner: `import { Spinner } from "@/components/ui/Spinner"`. PendingButton: `@/components/ui/PendingButton`.',
  '  - Toasts: the existing toast bus (see src/components/useToasts.ts).',
  'Design tokens (Tailwind): colors text-text-primary/secondary/tertiary/disabled, bg-0/1/2 (as bg-bg-0 etc.), surface-dark, primary, accent-success/danger/warning/purple, stroke + stroke-subtle/strong/primary; radii rounded-r1/r2/r3; type text-display-l/title/body/body-strong/caption + the `micro-label` class; surfaces glass-card/glass-panel; effects shadow-glow/shadow-glow-sm/btn-press/hover-lift. Match the existing styling idiom of the file you edit.',
  'DO NOT edit index.css, tailwind.config.ts, src/App.tsx, src/main.tsx, or ANY file outside your assigned list. If a change would require one of those, mark the item "skipped" with a note explaining the cross-file dependency.',
  'NO fabricated / mock / demo data — the project deliberately removed ALL mock data. If a suggested feature needs backend data or an API that is not present in the current code, SKIP it (do not fake a preview, meter, list, or waveform). Confirm the real data source exists before building UI on top of it.',
  'The native P2P engine is the default data path; do not wire new calls to dead HTTP endpoints. Data mutations flow through the useRuntimeMutations facade / runtime hooks.',
  'Preserve behavior covered by tests. Read sibling *.test.tsx files for your component. If a change intentionally alters tested behavior (e.g. the send button is now disabled when empty), UPDATE the test to assert the new, correct behavior — never weaken or delete assertions just to make it pass.',
  'Accessibility: link <label> to its input via htmlFor/id; add role/aria-* the report asks for when correct; modals get role="dialog" + aria-modal="true" (use role="alertdialog" for destructive confirmations); icon-only buttons get aria-label.',
  'Keep edits surgical and consistent with surrounding code. Do not reformat unrelated lines.',
].join('\n')

const GROUPS = [
  { label: 'BootRouter', files: ['src/components/BootRouter.tsx'], sections: '1.1-1.3', lines: '18-64',
    notes: 'Replace the RefreshCw spinner with the shared <Spinner/> (semantically a loader, not a refresh icon); add role="status" + aria-label and raise opacity. Rewrite "Waiting for xorein runtime…" to user-friendly copy with role="status"/aria-live="polite". For 1.2 dynamic phases: only wire to a REAL activity source if one is readily available from @/data or the engine provider — otherwise keep static copy (do not invent fake phases). Retry button: add the `focus-ring` class; window.location.reload() is acceptable as the hard-retry.' },
  { label: 'NodeLaunchScreen', files: ['src/components/NodeLaunchScreen.tsx', 'src/components/SecurityNote.tsx'], sections: '1.4-1.8', lines: '66-145',
    notes: 'Add htmlFor/id linking the CONTROL ENDPOINT label to its input; add autoFocus; reword jargon ("CONTROL ENDPOINT"->"Node address", "Current launch target"->"Currently connected to"). Add light URL-format validation feedback (no hard block). 1.8 hierarchy: the report wants "Use Default" emphasized as primary — but "Connect" is the explicit user action; a reasonable IMPROVEMENT is to keep Connect as primary and add a subtle "(recommended)" hint to Use Default rather than fully inverting. Use your judgment and document it. SecurityNote: only add a collapsible/Learn-more affordance if it stays self-contained.' },
  { label: 'WelcomeIntro', files: ['src/components/auth/WelcomeIntro.tsx'], sections: '2.1-2.6', lines: '151-236',
    notes: 'Add useEscapeKey(onGuest) for the close/guest affordance. Add `focus-ring` to the guest link and bump touch target on the close X to >=44px. Differentiate "I already have an account" from input fields visually. Note 2.5/2.6 are largely fine. Verify contrast claims against actual token usage.' },
  { label: 'UnlockScreen', files: ['src/components/auth/UnlockScreen.tsx'], sections: '2.7-2.10', lines: '238-296',
    notes: 'Link PASSWORD label via htmlFor/id. Add a show/hide password toggle (Eye/EyeOff lucide icon) inside the input. 2.8 is already correct (button disabled when empty) — confirm and skip. 2.10: replace window.confirm with an INLINE themed confirmation state inside this component (do NOT create a new shared modal file — that would be a cross-file dependency); make the destructive consequence explicit.' },
  { label: 'Layout', files: ['src/components/Layout.tsx'], sections: '3.1-3.2', lines: '303-327',
    notes: 'Mobile bottom nav: add `pb-safe` so it clears the iOS home indicator / Android gesture bar. Streamer mode: add a Ctrl+Shift+S keyboard toggle ONLY if streamer-mode state lives in this file and is easy to wire; otherwise skip with a note.' },
  { label: 'ServerRail', files: ['src/components/ServerRail.tsx'], sections: '3.3-3.5', lines: '329-366',
    notes: 'Add hover tooltips with server names (title attr or existing tooltip pattern). Add a circle->squircle border-radius hover transition to server icons (3.3/3.4 polish). Connection dot (3.5): add a tooltip describing status; only include latency/peer-count if that data is actually available. Drag-and-drop reordering & folders: SKIP (large feature) with a note.' },
  { label: 'ChannelRail', files: ['src/components/ChannelRail.tsx'], sections: '4.1-4.5', lines: '370-435',
    notes: 'Category headers (4.3): add a Chevron that rotates on collapse — high-value discoverability fix. Channel items (4.4): dim muted channels and differentiate mention badges if that state exists. Server title (4.1): add a dropdown affordance/clickability only if a server menu already exists to open. 4.2 (relocate the support/heart donation button out of nav): this is a cross-file product move (target is Settings/About) — do NOT move it across files; SKIP with a note (out of scope for this pass). User footer (4.5): add Ctrl+M / Ctrl+D shortcuts only if mute/deafen handlers live here and are easy to wire.' },
  { label: 'StatusPicker', files: ['src/components/StatusPicker.tsx'], sections: '5', lines: '439-456',
    notes: 'Add useEscapeKey(onClose); add role="dialog" + aria-label="Status picker". An expiry dropdown is optional/advanced — skip unless trivial and backed by real state.' },
  { label: 'FriendsPanel', files: ['src/components/FriendsPanel.tsx'], sections: '6.1-6.5', lines: '460-502',
    notes: 'Tab bar (6.1): bump font to ~11-12px and ensure >=32-36px tap targets. Action buttons (6.3): make them visible on focus and on touch devices, not hover-only (e.g. always-visible on small screens / focus-within) — real mobile a11y fix. Search (6.4): add a focus shortcut. Add `focus-ring` where useful. Clipboard paste / QR: skip QR (large); clipboard paste is optional.' },
  { label: 'ChatArea', files: ['src/components/ChatArea.tsx'], sections: '7.1-7.4', lines: '506-539',
    notes: 'HIGH RISK FILE with multiple test files (ChatArea.test.tsx, ChatArea.forward.test.tsx, ChatArea.inbox.test.tsx) — read them first. 7.4 Send button: disable/dim when the composer is empty (small, safe, high-value) and update tests accordingly. 7.3 Composer: convert the single-line <input> to an auto-expanding <textarea> (max-height capped) where Enter sends and Shift+Enter inserts a newline — PRESERVE the existing send-on-Enter behavior and keyboard handling exactly, keep mention-autocomplete and all existing handlers wired, keep tests green. 7.1 Security badge: make it clickable to open a lightweight summary ONLY if key/fingerprint data is readily available; otherwise skip. 7.2 view toggle: converting cycling->dropdown is optional; keep low-risk. If any sub-item risks destabilizing this complex file, prefer to SKIP it with a note rather than ship something fragile.' },
  { label: 'TypingIndicator', files: ['src/components/TypingIndicator.tsx'], sections: '8', lines: '543-557',
    notes: 'Raise text contrast from white/40 to ~white/60. Mini-avatars optional — only if presence data already carries avatars.' },
  { label: 'NotificationToast', files: ['src/components/NotificationToast.tsx', 'src/components/useToasts.ts'], sections: '9', lines: '561-581',
    notes: 'Add role="alert" for error toasts and role="status" for the rest. Enforce a max visible toast limit (~5) so the stack cannot overflow the screen. Click-through navigation: only wire if a navigation handler is readily threadable; otherwise skip. Keep the toast bus API backward compatible.' },
  { label: 'ConfirmDeleteModal', files: ['src/components/ConfirmDeleteModal.tsx'], sections: '10', lines: '585-604',
    notes: 'Add useEscapeKey(onCancel); add role="alertdialog" + aria-modal="true" + aria-label; auto-focus the Cancel button (safer default).' },
  { label: 'ForwardMessageModal', files: ['src/components/ForwardMessageModal.tsx'], sections: '11', lines: '608-630',
    notes: 'Add useEscapeKey(onClose); role="dialog" + aria-modal="true". Arrow-key navigation through the destination list is a nice-to-have — add if low-risk, else skip. Read ForwardMessageModal.test.tsx.' },
  { label: 'MediaLightbox', files: ['src/components/MediaLightbox.tsx'], sections: '12', lines: '634-654',
    notes: 'Real bug: the hint says "SCROLL TO ZOOM" but there is no onWheel handler. Implement onWheel scroll-to-zoom (clamp 0.5x..3x) to match the hint. Add useEscapeKey(onClose). Read MediaLightbox.test.tsx. Pinch-zoom / gallery nav: skip (out of scope).' },
  { label: 'VoiceMessage', files: ['src/components/VoiceMessage.tsx'], sections: '13', lines: '658-680',
    notes: 'Recorder (13.1): add a maximum recording duration cap (auto-stop) — achievable & self-contained. Real-time AnalyserNode waveform: only if the recorder already holds a MediaStream; else skip. Player (13.2): connecting to real decoded audio playback + real decoded waveform is large infra — SKIP with a note (the pseudo-waveform is intentionally decorative).' },
  { label: 'MentionAutocomplete', files: ['src/components/MentionAutocomplete.tsx'], sections: '14', lines: '684-702',
    notes: 'This component is already excellent (full keyboard nav). Only add role="listbox" on the list and role="option" + aria-selected on items. Read MentionAutocomplete.test.tsx.' },
  { label: 'PollCreator', files: ['src/components/PollCreator.tsx'], sections: '15', lines: '706-725',
    notes: 'Add auto-focus to the question input on mount; add character-limit counters on question/option inputs (with maxLength). Anonymous/multi-vote toggles: only if the poll payload + downstream actually support them; else skip. Read PollCreator.test.tsx.' },
  { label: 'SubpanelsA', files: ['src/components/PinsPanel.tsx', 'src/components/ThreadPanel.tsx', 'src/components/QuickSwitcher.tsx'], sections: '16.1-16.3', lines: '731-750',
    notes: 'PinsPanel (16.1): add a "Jump to message" action only if a jump/scroll-to-message handler exists or is threadable; else skip. ThreadPanel (16.2): per-thread typing indicators need real presence — skip if not wired. QuickSwitcher (16.3): add a small inline fuzzy matcher + recency sort (no new dependency) and a high-contrast focus state for the keyboard-selected row. Read the sibling tests.' },
  { label: 'SubpanelsB', files: ['src/components/EmojiPicker.tsx', 'src/components/StickerPicker.tsx', 'src/components/AttachmentView.tsx', 'src/components/SearchPanel.tsx'], sections: '16.4-16.7', lines: '752-778',
    notes: 'EmojiPicker (16.4): sync the active category tab to scroll position; skin-tone selector optional. StickerPicker (16.5): animated/Lottie stickers = large — SKIP. AttachmentView (16.6): add a progress/working indicator during decrypt (a spinner state on the button is enough; do not fake a percentage). SearchPanel (16.7): typed filter syntax (from:/has:) -> visual tokens is medium; add only if low-risk, else skip. Read sibling tests.' },
  { label: 'ServerModals', files: ['src/components/CreateServerModal.tsx', 'src/components/JoinServerModal.tsx'], sections: '17.1-17.2', lines: '784-795',
    notes: 'CreateServerModal (17.1): auto-focus + select-all the name input on mount; add a char-limit counter; disable Create when blank. JoinServerModal (17.2): a 2-step invite->preview->confirm flow needs an invite-RESOLVE API that returns server name/icon/member-count. Check whether such a resolve call exists. If it does NOT, SKIP the preview (do not fabricate preview data) — at most add input validation/auto-focus. Read sibling tests.' },
  { label: 'VoiceControlBar', files: ['src/components/voice/VoiceControlBar.tsx', 'src/components/voice/ScreenSharePanel.tsx'], sections: '18', lines: '799-809',
    notes: 'Mic/headphone: add device-name tooltips only if device info is available; add Ctrl+M/Ctrl+D shortcuts only if handlers are local & easy to wire. Screen share: the report flags sharing without a picker as a privacy risk. ScreenSharePanel.tsx exists — inspect it. If getDisplayMedia (the browser screen picker) is already invoked, the OS-level picker already protects the user: document that and skip. Only add an in-app source picker if the code currently shares with NO browser prompt. Do not break existing voice wiring.' },
  { label: 'SettingsScreen', files: ['src/components/SettingsScreen.tsx'], sections: '19', lines: '813-836',
    notes: 'Group settings tabs under section headers (19.1). Log Out (19.2): add a confirmation step (inline themed confirm, no new shared file). Saturation slider (19.3): add a live percentage readout. Mic input meter (19.4): if it is currently an empty/unimplemented block, implement a real meter via getUserMedia + AnalyserNode (self-contained, real data — acceptable), with graceful permission handling; if mic capture is unavailable, show a clear disabled state (do not fake levels). Read SettingsScreen.test.tsx.' },
  { label: 'ServerSettingsScreen', files: ['src/components/ServerSettingsScreen.tsx'], sections: '20', lines: '840-857',
    notes: 'Server name input: add char-limit counter + light validation. Save banner (20.2): show only when the form is dirty (animate in) instead of always-visible. Member admin (20.3): add a search/filter field; require a confirmation step for destructive kick/ban. Read ServerSettingsScreen.test.tsx.' },
  { label: 'SecurityOnboarding', files: ['src/components/onboarding/SecurityOnboarding.tsx'], sections: '21', lines: '861-872',
    notes: 'Progress bar: thicken (~6px) with smooth transition; segmented is optional. "Do not show again" (21.2): wrap the control + label in a <label> (or make the whole row clickable) so the label text is clickable — Fitts\'s Law fix.' },
  { label: 'MiscA', files: ['src/components/AccountSwitcher.tsx', 'src/components/AnnouncementChannel.tsx', 'src/components/ChannelKindSwitcher.tsx', 'src/components/ConnectionActivityPill.tsx'], sections: '22.1-22.4', lines: '878-909',
    notes: 'AccountSwitcher (22.1): visually mark the active identity vs others; auto-focus the password input when an account is selected. AnnouncementChannel (22.2): give announcement messages a distinct background/border. ChannelKindSwitcher (22.3): add a confirmation when switching kinds only if a switch handler exists and the change is destructive; else skip. ConnectionActivityPill (22.4): add a tooltip; include latency/peer-count only if that data exists. Read sibling tests.' },
  { label: 'MiscB', files: ['src/components/ForumChannel.tsx', 'src/components/InboxPanel.tsx', 'src/components/ServerExplorer.tsx', 'src/components/onboarding/OnboardingWizard.tsx'], sections: '22.5-22.8', lines: '911-941',
    notes: 'ForumChannel (22.5): add client-side sort controls (Recent/Newest) over the posts already loaded; tag filtering only if posts carry tags. InboxPanel (22.6): add a "Mark all as read" action (if a mark-read handler exists) + filter tabs over existing items. ServerExplorer (22.7): infinite scroll needs a paginated API — if the list is static/finite, SKIP infinite scroll; add a category filter only if servers carry categories. OnboardingWizard (22.8): add a visible "Step X of N" indicator and a Back button if step state is local. Read sibling tests.' },
  { label: 'MiscC', files: ['src/components/voice/Soundboard.tsx', 'src/components/voice/StageChannel.tsx', 'src/components/MediaEmbed.tsx', 'src/components/Spoiler.tsx', 'src/components/GlobalContextMenu.tsx', 'src/components/SwitchingOverlay.tsx', 'src/components/KeyboardShortcutsOverlay.tsx'], sections: '22.9-22.12', lines: '943-971',
    notes: 'Soundboard (22.9): add a soundboard-effects volume slider only if playback volume is controllable locally; custom hotkeys optional/skip. StageChannel (22.10): add a subtle highlight/animation cue when someone is brought on stage. Spoiler (22.11): add keyboard support (Enter/Space to reveal) + role="button"/tabIndex; add un-reveal (toggle) capability. MediaEmbed: minor. GlobalContextMenu / KeyboardShortcutsOverlay / SwitchingOverlay (22.12): ensure Escape closes (useEscapeKey) and focusable overlays have role + aria — verify what already exists before adding (GlobalContextMenu likely already handles Escape). Read sibling tests.' },
]

const LEDGER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['group', 'summary', 'filesEdited', 'items'],
  properties: {
    group: { type: 'string' },
    summary: { type: 'string', description: 'one-paragraph summary of what changed and why' },
    filesEdited: { type: 'array', items: { type: 'string' } },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'decision', 'note'],
        properties: {
          ref: { type: 'string', description: 'report section number + control name, e.g. "1.1 Loading Spinner"' },
          decision: { type: 'string', enum: ['implemented', 'improved', 'skipped'] },
          note: { type: 'string', description: 'what was done, or why skipped' },
        },
      },
    },
  },
}

function buildPrompt(g) {
  return [
    'You are improving the Harmolyn React/TypeScript chat client as part of a source-verified UX/UI audit pass. You are a CRITICAL reviewer, not a rubber stamp: implement the sound suggestions, improve the improvable ones, and skip the wrong or infeasible ones with a clear reason.',
    '',
    'YOUR FILES (you may ONLY create/edit these exact files, plus their sibling *.test.* files):',
    g.files.map(f => '  - ' + f).join('\n'),
    '',
    'Read the audit report at ' + REPORT + ' — your sections: ' + g.sections + ' (around lines ' + g.lines + '). Read each of your files IN FULL, plus their sibling test files, before editing.',
    '',
    'GROUP-SPECIFIC GUIDANCE:\n' + g.notes,
    '',
    'DECISION RUBRIC:\n' + RUBRIC,
    '',
    'CONVENTIONS (follow exactly):\n' + CONVENTIONS,
    '',
    'Apply your edits with the Edit/Write tools now. After editing, double-check imports resolve and TypeScript/JSX is valid. Then return the ledger as your structured output. Your structured output IS the deliverable — do not address a human.',
  ].join('\n')
}

export default async function run() {
// ---- Phase 1: audit + implement, one agent per disjoint file-group ----
phase('Implement')
const ledgers = (await parallel(
  GROUPS.map(g => () => agent(buildPrompt(g), { label: g.label, phase: 'Implement', schema: LEDGER_SCHEMA }))
)).filter(Boolean)

log('Implemented ' + ledgers.length + '/' + GROUPS.length + ' groups. Running full verification…')

// ---- Phase 2: verify the whole tree once ----
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['buildOk', 'testOk', 'lintOk', 'failures'],
  properties: {
    buildOk: { type: 'boolean' },
    testOk: { type: 'boolean' },
    lintOk: { type: 'boolean' },
    rawTail: { type: 'string', description: 'last ~30 lines of the first failing command, for triage' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'kind', 'detail'],
        properties: {
          file: { type: 'string' },
          kind: { type: 'string', enum: ['build', 'test', 'lint'] },
          detail: { type: 'string' },
        },
      },
    },
  },
}

const BASELINE = (args && args.baseline) || { tests: [], lintNote: '' }

function verifyPrompt() {
  return [
    'Run the full verification for the Harmolyn repo at /home/hal9000/docker/harmolyn-preview. Run these commands (bash), in order, capturing output:',
    '  1) npm run build      (TypeScript typecheck + Vite production build)',
    '  2) npx vitest run      (component/unit tests; non-watch)',
    '  3) npm run lint        (ESLint)',
    '',
    'IMPORTANT — a baseline was captured BEFORE any edits. These failures PRE-EXIST and are OUT OF SCOPE. Report them only if they look different; otherwise ignore them entirely:',
    '  - Pre-existing FAILING TESTS (by title): ' + (BASELINE.tests.length ? BASELINE.tests.map(t => '"' + t + '"').join('; ') : '(none)'),
    '  - Pre-existing LINT: ' + (BASELINE.lintNote || '(none)'),
    '  - Baseline build was GREEN (exit 0), so ANY build error is a regression.',
    '',
    'Set buildOk = (build exited 0). Set testOk = (NO failing test beyond the pre-existing baseline list — i.e. no regressions). Set lintOk = (NO lint error beyond the pre-existing baseline). In failures[], include ONLY regressions (new failures not in the baseline), each with the offending file path, kind (build|test|lint), and a concise detail (message + line). Keep details short. Put the last ~30 lines of the FIRST regressing command in rawTail. Do NOT attempt any fixes. Your structured output IS the deliverable.',
  ].join('\n')
}

phase('Verify')
let verify = await agent(verifyPrompt(), { label: 'verify', phase: 'Verify', schema: VERIFY_SCHEMA })

// ---- Phase 3: fix failures (bounded loop) ----
let round = 0
while (verify && !(verify.buildOk && verify.testOk && verify.lintOk) && round < 2) {
  round++
  const failures = (verify.failures || []).filter(Boolean)
  if (failures.length === 0) {
    log('Commands failing but no per-file failures parsed; stopping fix loop for manual triage.')
    break
  }
  // group failures by file so no two fixers touch the same file
  const byFile = {}
  for (const f of failures) {
    const key = f.file || 'unknown'
    if (!byFile[key]) byFile[key] = []
    byFile[key].push(f)
  }
  const fileList = Object.keys(byFile).filter(k => k !== 'unknown')
  log('Fix round ' + round + ': repairing ' + fileList.length + ' file(s).')

  phase('Fix')
  await parallel(fileList.map(file => () => agent([
    'A UX-audit change introduced failures in the Harmolyn repo (/home/hal9000/docker/harmolyn-preview). Fix the file: ' + file,
    '',
    'Failures to resolve:',
    byFile[file].map(f => '  [' + f.kind + '] ' + f.detail).join('\n'),
    '',
    'Read the file (and its sibling *.test.* if a test failed), find the root cause, and fix it MINIMALLY while preserving the intended UX improvement. If a test now asserts old behavior that was intentionally changed, update the test to assert the new correct behavior (do not weaken it). Do not edit files other than ' + file + ' and its sibling test(s). Verify TypeScript/JSX validity. Return a one-line summary of the fix.',
  ].join('\n'), { label: 'fix:' + file.split('/').pop(), phase: 'Fix' })))

  verify = await agent(verifyPrompt(), { label: 'verify-r' + round, phase: 'Verify', schema: VERIFY_SCHEMA })
}

return {
  groupsImplemented: ledgers.length,
  ledgers,
  finalVerify: verify,
  fixRounds: round,
}
}
