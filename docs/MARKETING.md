# Public marketing website

Public routes: `/`, `/features`, `/integrations`, `/solutions`, `/pricing`, `/resources`, `/faq`, `/security`, and `/signup`. `/login` and `/app` retain the existing dashboard Auth gate. `/inquiry` remains the existing public form. Update old dashboard bookmarks to `/app`; browser data remains on the same origin.

## Design and behavior

Redesigned on 18 November 2026 after a UI/UX audit ([MARKETING-UX-AUDIT.md](MARKETING-UX-AUDIT.md)). The site now positions LeadFlow as AI-assisted prospecting: find, analyze, pitch, follow through.

Files in `src/marketing/`:
- `Home.tsx`, `Pages.tsx` and `Guides.tsx`: the pages.
- `shared.tsx`: brand, buttons, page intro, status chips, FAQ list, workspace preview and report preview.
- `visuals.tsx`: illustrations, including the animated hero analysis and the API code sample.
- `content.ts`: page metadata, FAQs, capabilities, evidence labels and the feature-status table.
- `Glyph.tsx`: marketing-only icons. The dashboard keeps `Icon`.
- `Marketing.css`: scoped styles, organised by section.

Design system:
- dark ink and emerald surfaces for the hero and AI sections, on a light canvas, or on a dark canvas in dark mode (below);
- one emerald-to-lime accent;
- Inter Variable with an Instrument Serif italic accent. Both are self-hosted through `@fontsource` and imported only by the lazy-loaded marketing bundle;
- the system monospace font for code.

Two audiences:
- outcome-led copy in the main flow;
- "For technical teams" content: the architecture points and the `inbound-lead` request sample, which matches [INTEGRATIONS.md](INTEGRATIONS.md).

Availability language:
- Every capability carries a status chip: **Available**, **Needs setup**, **Beta**, **Planned** or **Not available**.
- `featureStatus` in `content.ts` is the single source for the Pricing table.
- Client onboarding is shown as **Beta** because it isn't applied to the hosted project yet. Remove it from `capabilities`, `featureStatus` and Features stage 06 if it won't ship with the frontend.

Illustrations:
- They use fictional businesses and never read the database.
- The hero analysis replays the real report steps (Checking the website → Reading pages → Measuring → Interpreting → Matching services).
- Visitors who prefer reduced motion see its finished state.
- Sections fade in on scroll, also only without reduced motion.
- One footer line covers the "fictional data" disclosure. Each visual keeps a single "Illustration" tag.

Accessibility:
- native FAQ disclosures;
- a keyboard-accessible mobile menu that closes on Escape;
- "How it works" uses arrow-key tabs;
- visible focus and skip navigation;
- page copy is at least 12 px.

No tracking scripts were added.

The site uses the existing pathname approach with native links and lazy page bundles. Titles and descriptions update per route. The existing Vercel SPA rewrite supports direct navigation and refreshes.

## Business reports (M7)

The home page (`#business-reports`) and Features (`/features#business-reports`) present business reports with an illustrated, fictional report (`ReportPreview` in `shared.tsx`): what is checked, the four finding labels (observed, measured, AI interpretation, hypothesis), opportunity matching, and the limits (public pages only, no bypassing protections, "not found" means not found on the pages analyzed, no promised results). The FAQ, Solutions, Pricing comparison, Security and Resources (field note 04) were updated to match. Copy names Google PageSpeed Insights and Google Gemini because website text is sent to them. Copy also reflects that CSV import and workspace roles exist, while team invitations and a general lead export are still planned.

## Contacts and outreach (M8)

The site presents M8 as "Reach out", between pitching and following through:
- **Home:**
  - The announcement and the hero copy mention contacts and drafts.
  - "How it works" step 3 now covers contacts and drafts.
  - A large **Contacts and outreach drafts** card was added to the platform grid, which was reordered so it has no gaps at six or two columns.
  - The owner and technical points were extended, and the agency flow ends in "Outreach".
- **Features:** a new stage, **04 · Reach out** (`/features#outreach`), with the `OutreachVisual` illustration. Following through and onboarding are now 05 and 06.
- **Elsewhere:** Integrations (Apollo decision-makers, Gemini drafts), Solutions, Pricing (plan items, and three rows in `featureStatus`), Security (a contacts and outreach card) and Resources (field note 05, "Outreach that says only what you saw").
- **FAQ:** a new question about finding contacts, and the sending question rewritten.
- **Claims stay accurate:**
  - LeadFlow never sends messages; "Sending messages from LeadFlow" is listed as **Not available**.
  - Email addresses are never guessed.
  - Drafts that claim more than the evidence are refused.
  - Follow-ups are reminders, not scheduled sends.

## Dark mode

The marketing site follows the visitor's choice or their system setting, with a light/dark switch in the header. On phones the switch sits beside the menu button.
- **Shared choice:** it's the same choice as the app (`leadflow.theme`), and `index.html` applies it before the first paint.
- **The inquiry form** (`/inquiry`) stays light, because businesses embed it in their own websites.
- **Styling:** in `Marketing.css`, "Dark theme" swaps the page tokens and the few light surfaces outside illustrations. Product illustrations (`.mk-window`, `.mk-mock`) keep their light tokens and brand colours, so they read as light screenshots of the app. The bands that are dark in both themes get a faint edge.
- **Tested:** `tests/theme.spec.ts` covers the switch, the shared choice across pages and the app, and the light inquiry form.

## Access and accurate claims

Request access leads to `/signup`, then `/inquiry?topic=leadflow-access` with a prefilled message. It uses the existing configured inquiry destination and notification flow. It does not provision an account or promise approval. Existing accounts sign in through `/login`.

Pricing is a proposed packaging direction with no finalized prices or checkout. Shared teams, permissions, billing, and CRM sync are clearly planned. Automation platforms are documented HTTP methods, not native installed apps. Security copy describes current controls without asserting certifications or production readiness. No backend migrations or RLS changes are required for these pages.

## Verification

Run `npm run build`, `npm run lint`, `npm test`, and `npm run test:production`. The production test builds with test configuration; run `npm run build` afterward to restore the normal deployment build. Existing database and handler checks remain `npm run test:db`, `npm run test:m3`, `npm run test:integrations`, and `npm run check:edge`.

Marketing browser tests cover every public route and refresh, titles/descriptions, internal destinations, no private data requests, preview controls, FAQ expansion, access-inquiry prefill, signed-out dashboard protection, mobile navigation and Escape, keyboard skip navigation, and widths 360/768/1440. Existing M1–M3 browser tests now enter through `/app`; database and provider traffic in those tests is simulated.

Manual deployment smoke check: open each route directly, refresh, follow Request access to the inquiry form, sign in to `/app`, and confirm your existing records. Check the deployed Turnstile and notification configuration independently; local browser tests do not verify live email delivery.

## Remaining launch considerations

- Not automatically deployed by local changes. Keep Vercel frontend environment variables and existing Supabase function secrets configured.
- Route-specific metadata is client-rendered. Social crawlers that do not execute JavaScript see the base HTML metadata. Prerendering, canonical URLs, social images, and a sitemap are future SEO work.
- Unknown routes show an accessible not-found page, but the SPA host returns HTTP 200.
- Final commercial terms and privacy policies need business review before public commercial onboarding. No invented legal policy is included.
- Self-service signup, payments, shared team access, and third-party account execution are outside this phase.
