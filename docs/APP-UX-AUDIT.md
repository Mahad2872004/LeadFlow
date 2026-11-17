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

See the revamp notes in the pull request and [MARKETING.md](MARKETING.md). The foundation is in place: `index.css`, `App.css`, `Workspace.css`, the shell, the Overview copy and the sign-in story. The feature areas are being restyled in parallel on top of it.
