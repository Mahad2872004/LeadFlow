# App UI/UX audit

18 November 2026. Covers the signed-in app and its public companion pages:
- sign-in and sign-up, and first-workspace setup;
- the shell and Overview;
- Leads and the lead detail, Follow-ups, Activity and notifications;
- Discovery (directory search, CSV import, search history, Apollo);
- business reports and agency services;
- client onboarding and the client portal;
- Integrations and Settings;
- the public inquiry form.

Method: every screen was captured at 1440 px and 390 px with `tests/screens.spec.ts`. It signs in through the same simulated services the browser tests use, loads the demo data and walks every flow. Findings were checked against the marketing redesign ([MARKETING-UX-AUDIT.md](MARKETING-UX-AUDIT.md)) so that the site and the product feel like one brand.

## Summary

The app is functional, accessible and thoroughly tested, but it looks like an earlier product than the one now being marketed:
- **It doesn't match the site.** The marketing site promises a premium AI product (dark emerald, lime accent, crisp type). The app still uses the old sage palette, the system font (Inter is requested but never loaded) and type down to 9–11 px.
- **The flagship AI features don't stand out.** Business reports and opportunities look the same as a settings form.
- **The chrome uses a lot of space and some technical language.** For example, "Supabase workspace" appears in the header.

## What works and should be kept

- **Accessibility.** Skip link, labelled controls, dialog focus trapping, keyboard tabs, and a mobile lead table that turns into cards.
- **Honesty in the UI.** Credit costs are shown before Apollo reveals, findings are labelled observed / measured / AI / hypothesis, and fictional data is marked.
- **Clear state handling.** Saving, retry, conflict recovery, empty states and loading skeletons.
- **Test coverage.** 41 browser tests that locate elements by role, label and text, so a visual revamp is safe if the markup semantics stay the same.

## Findings

Severity: **High** blocks the screen's main job or the brand promise. **Medium** clearly weakens it. **Low** is polish.

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | High | Everywhere | The brand doesn't match the new site: sage and cream palette, no dark surfaces, no lime accent. Moving from the landing page to sign-in to the app feels like three products. |
| 2 | High | Everywhere | The font is never loaded (Inter is requested but not shipped). Type sizes go as low as 9–11 px (eyebrows, table cells, hints), so text is hard to read and the hierarchy is flat. |
| 3 | High | Business report | The flagship AI output reads like a form. Score tiles, findings, evidence and opportunities all share one plain style, and the AI and evidence labels are tiny. |
| 4 | Medium | Shell | The sidebar is light, so it doesn't separate navigation from content. The demo card is copy-heavy ("A little pipeline. A lot of possibilities."). |
| 5 | Medium | Topbar | "Supabase workspace" is an implementation detail shown to every user. It is static, so it says nothing when a save is in progress or has failed. |
| 6 | Medium | Overview | The heading is poetic ("A clear view. A better follow-up."), counts are zero-padded ("09"), and the "make your next move" card is generic rather than stating what is due. |
| 7 | Medium | Tables and filters | 9–11 px headers and cells. Native selects of different heights. Status selects look like coloured boxes rather than pills. |
| 8 | Medium | Discovery and Apollo | Long forms with weak grouping. The tabs and result tables don't match the new card system. |
| 9 | Medium | Onboarding and portal | Readiness, the most important signal, doesn't stand out. The client portal is the page clients see and should look the most trustworthy, but it reuses the plain style. |
| 10 | Low | Dialogs | Small headings, no motion, and a heavy backdrop without blur. Action rows aren't separated from content. |
| 11 | Low | Sign-in | The story panel still uses the old positioning ("Every inquiry, organized"). |
| 12 | Low | Maintainability | The stylesheets are minified one-line files, about 106 KB in all. `App.css` has a base layer plus an override layer for the same selectors. |

## Direction

- **One design system.** Shared tokens in `src/index.css` (`--lf-*`), matching the marketing palette:
  - ink `#0a1813` and emerald `#0e7a55`;
  - lime `#c4f26a` on dark surfaces;
  - soft semantic colours for status;
  - violet for AI.
- **Fonts and type.** Inter Variable loaded globally, a 12 px minimum (11 px only for uppercase labels), tabular figures for metrics.
- **Shell.** A dark night sidebar with a lime active marker, and a translucent sticky topbar with a real save-state chip (All changes saved / Saving… / Not saved).
- **Primitives.** `App.css` holds the primitives every feature reuses: panels, section headings, ink primary buttons, 40 px inputs with a brand focus ring, pill status selects, uppercase table headers, dialogs with blur and a short entrance, and the empty state.
- **Dark accents, used sparingly.** One per screen: the "Next best action" card, the follow-ups metric, the welcome panel, the sign-in story, plus one hero element in each feature area.
- **Feature areas.** Restyled on the shared primitives without changing text, roles, labels or test-relied class names.

## Implementation status

Implemented on branch `feat/app-revamp`, 19 November 2026.

**Foundation**
- `src/index.css` holds the shared tokens. Inter is loaded in `main.tsx`.
- `App.css` and `Workspace.css` are rewritten as readable, sectioned files.

**Shell**
- The sidebar navigation is grouped into Pipeline, Grow and Workspace.
- The topbar has a save-state chip.
- A ⌘K / Ctrl+K command menu (`CommandPalette.tsx`) jumps to pages, runs actions and opens leads.

**Overview**
- A greeting with the date and a one-line summary.
- Metric cards with 14-day sparklines and pipeline-share meters (`lib/insights.ts`).
- A pipeline funnel with percentages and win rate.
- A "Next best action" panel with up to three more suggestions. These come from fixed rules over the pipeline data, not AI, and are labelled as suggestions.
- Recent activity next to "On your radar".

**Leads**
- A Table / Board toggle. `LeadBoard.tsx` shows status columns with inline status changes.
- Lead details open in a side panel (`Modal variant="drawer"`), which becomes a bottom sheet on phones.

**Feature areas**
- **Discovery and Apollo:** stepped search builder, chip toggles, result avatars, bulk action bar and credits ring.
- **Business report:** dark header band, ring gauges, severity bar, AI summary card, priority-railed opportunities with a segmented review control, and the agency services card grid.
- **Onboarding and portal:** request cards with readiness bars, a dark request hero with a readiness ring, status-railed checklist items, and a branded portal with progress tiles.
- **Integrations and inquiry form:** hub hero, app tiles, status pills, stepper guides, syntax-coloured code blocks and secure credential cards. The inquiry form uses a split brand/form card.

**Unchanged**
- Text, labels, roles and test-relied class names. Additions are decorative and `aria-hidden`.
- Every animation has a `prefers-reduced-motion` opt-out.

**Dark mode**

Scope:
- Dark mode covers the app, its sign-in pages and the client portal.
- The marketing site and the embeddable inquiry form always stay light. The inquiry form sits inside customers' own websites.

How a visitor picks a theme:
- It follows the device setting until the user chooses.
- The topbar and sign-in toggle (sun/moon) switches between light and dark.
- ⌘K also offers "Match system theme".
- The choice is stored per browser as `leadflow.theme` in `localStorage`.

How it works:
- `src/lib/theme.ts` sets `<html data-theme>`.
- An inline script in `index.html` applies the theme before the first paint, so dark mode never flashes white.
- **Design direction:**
  - The base UI is neutral graphite, with clear elevation steps between background, surfaces and raised elements.
  - Primary buttons are near-white with dark text. Emerald is used only for links, focus, success and status.
  - The signature green gradient cards keep their light-theme look: gradient, soft glow, fine grid, mint eyebrow and lime call to action.
  - The base never gets a green tint, a glow or a texture. Green everywhere is what made the first dark version feel generic and "AI-generated".
- The card list lives in `src/index.css`, after the dark tokens. Add any new card with a `var(--lf-night)` background to it.
- `src/index.css` defines every token for both themes, including these semantic ones:
  - surfaces: `--lf-surface`, `--lf-surface-2`, `--lf-tint`, `--lf-track`, `--lf-overlay`, `--lf-glass`;
  - actions: `--lf-primary-*` (ink in light, lime in dark), `--lf-accent-bg` (dark chips) and `--lf-on-lime`.
- Native controls follow through `color-scheme`.

Rules for future edits:
- Use these tokens, not hex values, for anything on a light surface.
- The block at the end of each feature stylesheet headed "Dark theme: pastel surfaces" was generated from that file's light pastel colours. If you change one of those colours, update its dark counterpart too.

Test coverage: `tests/theme.spec.ts` checks the system default, the toggle, persistence and the "Match system theme" command, and that the marketing site and inquiry form stay light. To review every screen in dark mode, run `SCREENS_THEME=dark npx playwright test --config playwright.screens.config.ts`.

Adding `SCREENS_AUDIT=1` also writes `audit.json` (helper: `tests/support/contrast.ts`) with two lists:
- text below 3:1 contrast against the background actually rendered behind it;
- large light surfaces.

Expect some intentional or false-positive results:
- Near-white and lime buttons, and the always-light inquiry form, are intentional.
- Gradient backgrounds are averaged, so text over a fading gradient can be a false positive. Confirm on the screenshot.

The screenshot run also covers every business report tab, a hovered integration card, an integration's detail view and Apollo's credits tab.

When restyling, also check light colours written in `rgba()`, in local custom properties (such as `--dv-track`) and in `:hover` states. Each needs a dark counterpart; the generated blocks at the end of each stylesheet show the pattern.

**Screenshots:** `tests/screens.spec.ts` with `playwright.screens.config.ts` captures every screen at 1440 and 390 px for visual review. It isn't part of `npm test`.
