

# Harmolyn Onboarding Guide Popup

## Overview
A 7-screen informational onboarding popup that explains how Harmolyn works -- its peer-to-peer architecture, cryptographic identity, encryption modes, search limitations, network indicators, and update policy. It appears on first launch, with a "Do not show again" checkbox that persists the preference to localStorage.

## Screens and Content
Each screen gets a unique icon illustration built from Lucide icons composed into a small SVG-style graphic area, plus the copy provided:

1. **"What you're running"** -- Icon: Monitor + Cpu (device-local processing). Three bullet cards explaining no central server, local encryption, and the Harmolyn/xorein relationship.
2. **"Your identity is a key"** -- Icon: KeyRound + Fingerprint. Explains cryptographic identity, backup urgency, and the risk of device loss.
3. **"Security is explicit, per surface"** -- Icon: ShieldCheck + four badge mini-illustrations (Seal, Tree, Crowd, Clear) with color-coded labels and short descriptions.
4. **"What E2EE does and does not protect"** -- Icon: Lock/Unlock split graphic. Two-column layout: "Protected" (green checkmarks) vs "Not hidden" (amber warnings).
5. **"Search and history have real limits"** -- Icon: Search + HardDrive. Explains local-only search, coverage labels (Full/Partial/Empty), and retention-bounded history.
6. **"Network behavior you can see"** -- Icon: Network + Activity. Shows indicator mock-ups: Connected via, Peers in scope, Store-and-forward, downgrade warnings.
7. **"Updates are part of security"** -- Icon: RefreshCw + Shield. Versioned protocol, backward compat note, "Update recommended" banner preview.

## Visual Approach
- Each screen has a centered icon area (64x64) with a primary icon and a smaller accent icon, rendered using Lucide React icons composed together in a styled container
- Bullet points use small inline icons (CheckCircle, AlertTriangle, Info) for scannability
- Badge illustrations on Screen 3 use colored pill components with icons (e.g., green Lock for Seal, amber TreePine for Tree)
- Two-column layout for Screen 4's "protected vs not hidden" comparison

## User Controls
- **SKIP** button (left) -- closes the popup immediately
- **BACK / NEXT** buttons for navigation
- **"Do not show again"** checkbox on every screen, persisted to `localStorage` key `harmolyn_onboarding_dismissed`
- Progress dots showing current position across 7 screens
- On the last screen, NEXT becomes **GOT IT**

## Integration
- Layout.tsx checks `localStorage` on mount; if the key is not set, it shows the onboarding popup
- A new state flag `showOnboarding` controls visibility
- The popup renders above everything at z-index 110 (matching existing overlay patterns)

---

## Technical Details

### New file: `src/components/onboarding/SecurityOnboarding.tsx`
- A self-contained component with all 7 screens defined as data
- Each screen object contains: `id`, `title`, `icon` (React node), and `content` (React node with the formatted copy and inline graphics)
- State: `currentStep` (number), `dontShowAgain` (boolean)
- On close/finish: if `dontShowAgain` is true, write `"true"` to `localStorage('harmolyn_onboarding_dismissed')`
- Uses the same glass-card styling pattern as `OnboardingWizard` (Neon Glass spec: `glass-card`, `rounded-r3`, `border-white/10`, cyan progress bar)
- Max width 580px, max content height scrollable for smaller viewports

### Modified file: `src/components/Layout.tsx`
- Import `SecurityOnboarding`
- Add state: `showOnboarding` initialized from `!localStorage.getItem('harmolyn_onboarding_dismissed')`
- Render `{showOnboarding && <SecurityOnboarding onClose={() => setShowOnboarding(false)} />}` at the top of the return, alongside existing overlays

### Modified file: `src/types.ts`
- No changes needed -- onboarding state is local to Layout and localStorage, not part of AppState

