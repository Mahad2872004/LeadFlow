# Marketing website UI/UX audit

18 November 2026. Scope: the public routes `/`, `/features`, `/integrations`, `/solutions`, `/pricing`, `/resources`, `/faq`, `/security` and the not-found page.

Method:
- read `src/marketing/` and its tests;
- captured screenshots at 1440 px and 390 px wide;
- compared the copy with what the product does today (README, BUSINESS-INTELLIGENCE, LEAD-DISCOVERY, APOLLO, CLIENT-ONBOARDING);
- checked the copy against the claim rules in PRODUCT_OVERVIEW.md.

## Summary

The site is honest, accessible and well tested, but it presents LeadFlow as a calm notebook for website inquiries and follow-ups. The product is now an AI-assisted prospecting workflow: find businesses, analyze their websites, pitch what they're missing, follow up, and onboard the client. The first screen says none of this, and the site doesn't look like the category it competes in.

Neither audience is well served:
- **Non-technical buyers** (agency owners, consultants) get poetic headlines instead of an outcome.
- **Technical evaluators** find implementation terms mixed into sales paragraphs, with no dedicated place to inspect the architecture or the API.

## What works and should be kept

- **Claim discipline.** Fictional data is labelled, planned features are marked, and there are no invented logos, testimonials, metrics or prices.
- **Accessibility basics.** Skip link, visible focus, native `<details>` FAQs, a keyboard-operable mobile menu that closes on Escape, and reduced-motion styles.
- **The business report illustration.** Its four evidence labels (Observed, Measured, AI interpretation, Hypothesis) are the strongest differentiator on the site.
- **Test coverage.** Every route, title, description, internal link, preview control and viewport overflow is covered.

## Findings

Severity: **High** blocks the page's main job. **Medium** clearly weakens it. **Low** is polish.

### Positioning and messaging

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | High | The first screen doesn't say what LeadFlow is, who it's for, or that it uses AI. | Hero: "A first hello. A clear next step. A better way to grow." |
| 2 | High | The site undersells the product and is behind it. Lead discovery, Apollo search and client onboarding are missing from the home page. AI reports only appear in the third section. | `Home.tsx`; README sections M6, M6A, M6B, M7 |
| 3 | Medium | One headline formula is used everywhere ("Sentence. *Italic serif sentence.*"), about 12 times on the home page. Nothing stands out because everything looks the same. | Every `h2` in `Home.tsx` |
| 4 | Medium | Owner-facing copy uses implementation terms (Supabase Auth, Edge Function, Turnstile, iframe, bearer credential). Meanwhile technical readers have no API sample or architecture view. | Home "trust" section, Integrations |
| 5 | Medium | Disclaimers are scattered and repeated where the page is trying to persuade ("Product illustration", "Fictional sample", "Fictional example", and fine print under each). Being honest is right, but this placement makes the product feel provisional. | Hero art, both previews |

### Visual design

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 6 | High | The look doesn't match the category. Sage and cream colours, Georgia italics and tilted paper cards read as a boutique studio, not AI software. There are no dark surfaces or depth. | `Marketing.css` palette |
| 7 | High | The hero visual shows neither the product nor the AI: an "inquiry slip" with decorative orbits. The real product preview is below the fold. | Hero screenshot, 1440 px |
| 8 | Medium | The intended typeface is never loaded. The CSS asks for Inter but no font file is shipped, so Windows shows Segoe UI and macOS shows SF. A headline weight of 550 is synthesized. | `.marketing { font-family: Inter, … }`, no font import |
| 9 | Medium | Weak hierarchy. Nine feature cards of equal weight and 11 similarly weighted sections leave no anchor for the most important capability. | Home feature grid |
| 10 | Low | Every button uses ↗, the usual "opens elsewhere" icon, including primary CTAs and links within the page. | `CTA` in `shared.tsx` |
| 11 | Low | The 88 px header uses a lot of vertical space. The mobile toggle uses text glyphs ("Menu ☰"). | `.mk-header` |

### Conversion and UX

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 12 | High | Pricing looks unfinished. Three identical "Price to be announced" cards have identical "Discuss access" buttons, and two of them list only "Proposed …" items. | `/pricing` screenshot |
| 13 | Medium | There is only one path. Every CTA is "Request access", and the only way to evaluate further is an anchor to a static preview. | Home |
| 14 | Medium | Nothing replaces social proof. The claim rules correctly forbid logos, testimonials and metrics. The evidence-based method, the real data providers and a transparent feature status could do that job, but they aren't presented as proof. | — |
| 15 | Low | The home page is about 7,500 px tall at 1440 px and repeats itself: "Capture, understand, follow through", "The essentials", use cases, and trust all overlap. | Full-page screenshot |

### Accessibility, performance and maintainability

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 16 | Medium | Page copy outside the product illustrations is too small: eyebrows are 10 px (9 px on mobile), the audience label is 9 px and fine print is 11–12 px. Some of it is low-contrast green on cream. | `.mk-eyebrow`, `.mk-audience span` |
| 17 | Low | Nothing on the page signals a live product. Any added motion must respect reduced-motion settings; the current CSS already enforces this. | — |
| 18 | Low | The code is hard to maintain. The stylesheet is mostly one 25 KB line and the components are one-line JSX, which makes them hard to review, theme or extend. | `Marketing.css`, `Home.tsx` |

## Design direction

- **Positioning:** AI-assisted prospecting for agencies and service businesses. Find businesses, let AI read their website, pitch what they're missing with evidence attached, and keep every follow-up moving.
- **Two tracks for two audiences:** outcome-led, plain-language copy in the main flow, plus a "for technical teams" track with the architecture, a real inbound API sample and the security controls.
- **Visual system:**
  - dark ink and emerald surfaces for the hero and the AI sections, on a crisp light canvas for reading;
  - one emerald-to-lime accent;
  - Inter Variable with an Instrument Serif italic accent, self-hosted and loaded only with the marketing bundle;
  - the system monospace font for technical details;
  - a 12 px minimum for page copy.
- **Product-first hero:** an animated analysis that uses the real report pipeline steps (Checking the website, Reading pages, Measuring, Interpreting, Matching services), with a reduced-motion final state.
- **Proof without invented data:**
  - evidence labels;
  - named data providers, as text rather than logos;
  - status chips on every capability (Available, Needs setup, Beta, Planned).
- **Unchanged:** routes, per-page metadata, the claim rules and the browser-test contracts (one `h1` per page, link destinations, preview controls, FAQ text, mobile menu behaviour, no horizontal overflow at 360, 768 or 1440 px).

## Implementation plan

1. Design tokens and a new, readable `Marketing.css`.
2. Shared components: header, footer, buttons, page intro, status chips, FAQ list, product preview, report preview.
3. Rebuild the home page:
   - hero;
   - providers strip;
   - workspace preview;
   - interactive "How it works" (find, analyze, pitch, follow through);
   - AI reports;
   - feature bento;
   - owners and builders;
   - use cases;
   - FAQ;
   - final CTA.
4. Move Features, Integrations, Solutions, Pricing, Resources, Security, FAQ and the not-found page to the new system. Restructure Pricing around a status table.
5. Verify: build, lint, marketing browser tests, and screenshots at 360, 768 and 1440 px.

## Implementation status

Implemented on 18 November 2026. See [MARKETING.md](MARKETING.md#design-and-behavior) for the resulting structure.

Verification:
- `npm run build` and `npm run lint` are clean.
- The full browser suite passes (41 tests), including the three marketing tests, which were not changed.
- A separate geometry check found no element extending beyond the viewport on any route at 360, 390, 768, 1024 or 1440 px. This check is needed because `.marketing` clips horizontal overflow, so the suite's `scrollWidth` assertion can't detect it.

Fonts add about 70 KB (Latin subsets), loaded only on marketing routes.

**Open decision:** client onboarding (M6A) is presented with a **Beta** label. It is implemented in the app but hasn't been applied to the hosted project (see [CLIENT-ONBOARDING.md](CLIENT-ONBOARDING.md)). Remove it from the marketing copy if it won't be deployed with this release.
