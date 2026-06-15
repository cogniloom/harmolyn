import re

content = """
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
"""

with open("/home/hal9000/docker/harmolyn-preview/ux_review_report.md", "r") as f:
    orig = f.read()

# Find the header "## 22. Additional Components Identified But Not Yet Detailed"
split_str = "## 22. Additional Components Identified But Not Yet Detailed"
if split_str in orig:
    new_doc = orig.split(split_str)[0] + content
    with open("/home/hal9000/docker/harmolyn-preview/ux_review_report.md", "w") as f:
        f.write(new_doc)
    print("Successfully expanded report.")
else:
    print("Could not find split string.")
