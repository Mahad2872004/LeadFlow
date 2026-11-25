# Public marketing website

Public routes: `/`, `/features`, `/integrations`, `/solutions`, `/pricing`, `/resources`, `/faq`, `/security`, and `/signup`. `/login` and `/app` retain the existing dashboard Auth gate. `/inquiry` remains the existing public form. Update old dashboard bookmarks to `/app`; browser data remains on the same origin.

## Design and behavior

Redesigned on 18 November 2026 after a UI/UX audit ([MARKETING-UX-AUDIT.md](MARKETING-UX-AUDIT.md)). Since 26 November 2026 the site tells the whole lifecycle: find, analyze, reach out, win, onboard, deliver (see [Sales, clients and projects](#sales-clients-and-projects-m9m11-and-interactive-demos)).

Files in `src/marketing/`:
- `Home.tsx`, `Pages.tsx` and `Guides.tsx`: the pages.
- `shared.tsx`: brand, buttons, page intro, status chips, FAQ list, number counters, workspace preview and report preview.
- `visuals.tsx`: illustrations, including the animated hero analysis and the API code sample.
- `Demos.tsx`: the hands-on win, onboarding and delivery demos on the home page.
- `motion.ts`: reduced-motion check, an in-view hook and the pointer spotlight.
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
- `New` is used once, for projects and delivery, with the Available colour. It means available and recent, nothing else.
- Client management and onboarding are **Available** (M10 is applied to the hosted project). The AI project assistant and onboarding reminder emails are **Needs setup**. A client project portal with approvals is **Planned**. Sending messages, time tracking, invoicing and billing are **Not available**.
- If the M9–M11 frontend doesn't ship with the site, take those rows out of `capabilities`, `featureStatus`, the home demos and Features stages 06–08.

Illustrations:
- They use fictional businesses and never read the database.
- The hero analysis replays the real report steps (Checking the website → Reading pages → Measuring → Interpreting → Matching services).
- Visitors who prefer reduced motion see its finished state.
- Sections fade in on scroll, also only without reduced motion.
- Counters (workspace preview stats, product facts) count up once when they scroll into view. Screen readers and reduced-motion visitors get the final number.
- Cards get a soft pointer spotlight and a small lift on hover, only on devices that hover and without reduced motion.
- One footer line covers the "fictional data" disclosure. Each visual keeps a single "Illustration" tag.

Accessibility:
- native FAQ disclosures;
- a keyboard-accessible mobile menu that closes on Escape;
- "How it works" uses arrow-key tabs (arrows, Home, End). Its autoplay pauses on hover and while focus is inside, stops as soon as a visitor picks a stage, has a visible Pause/Play control, and is off with reduced motion;
- every demo control is a native button, checkbox or switch with a name; moving a card or finishing a step keeps keyboard focus in place, and a polite status message announces each change;
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

## Sales, clients and projects (M9–M11) and interactive demos

Added on 26 November 2026. The site now follows the work past the first conversation.

- **Home:**
  - The announcement reads "Client onboarding and project delivery" and links to `#after-the-win`. The hero copy covers the full lifecycle, and a row of six stage links (Find → Deliver) opens the matching step in "How it works".
  - "How it works" has six stages: Find, Analyze, Reach out, Win, Onboard and Deliver, with an illustration each (`PipelineVisual`, the updated `OnboardVisual`, `ProjectVisual`). It autoplays (7 s a stage, with a progress line on the active tab) under the rules in Accessibility above.
  - The workspace preview has a third view, **Projects preview**, and its sidebar lists Sales, Clients and Projects.
  - **After the win** (`#after-the-win`) has three hands-on demos, each labelled "Interactive demo · fictional data", with Reset:
    - **Win:** mark a deal won, review what carries over (contact, confirmed service, onboarding checklist) and create the client.
    - **Onboard:** resolve client items and agency steps; the readiness ring and state follow the app ("Waiting on the client", "Agency steps left", "Ready to complete"), and completion unlocks only when everything is resolved.
    - **Deliver:** move tasks across a board with buttons. Progress counts tasks (the demo project has no deliverables) and says so. Health follows the documented rules: an overdue high-priority task makes it At risk until that task is done, and a passed target date makes it Delayed. A small timeline fills as milestones' tasks finish.
  - The platform grid adds Sales pipeline, Client workspace and onboarding, Projects and delivery (New) and AI project assistant (Needs setup), still gap-free at six, two and one columns. Four product facts count up below it (10 pages per report, 11 starter services, 8 onboarding stages, 3 project templates); each is a product fact, not a result claim.
- **Features:** new stages 06 · Win (`#sales-pipeline`), 07 · Onboard (`#onboarding`) and 08 · Deliver (`#projects`, with the AI assistant marked Needs setup). The "not included" note lists the client project portal and approvals, time tracking, invoicing, resource planning, calendar sync and e-signatures.
- **Elsewhere:** Pricing (plan items and seven `featureStatus` rows), Solutions (flows that end in onboarding and projects), Integrations (Gemini powers the project assistant), Security (client links and files; projects and the AI assistant), Resources (field note 06, "From a won deal to a delivered project") and the FAQ (three new questions).
- **Claims stay accurate:** LeadFlow never sends the welcome message or any outreach; the scope confirmation is a record, not a contract or signature; AI suggestions change nothing until a person approves them; project files and notes never reach the client link; currencies are never converted.
- **No network calls:** demos are local state with fictional data, and nothing is saved.

## Dark mode

The marketing site follows the visitor's choice or their system setting, with a light/dark switch in the header. On phones the switch sits beside the menu button.
- **Shared choice:** it's the same choice as the app (`leadflow.theme`), and `index.html` applies it before the first paint.
- **The inquiry form** (`/inquiry`) stays light, because businesses embed it in their own websites.
- **Styling:** in `Marketing.css`, "Dark theme" swaps the page tokens and the few light surfaces outside illustrations. Product illustrations and demo screens (`.mk-window`, `.mk-mock`, `.mk-demo-ui`) keep their light tokens and brand colours, so they read as light screenshots of the app. The bands that are dark in both themes get a faint edge.
- **Tested:** `tests/theme.spec.ts` covers the switch, the shared choice across pages and the app, and the light inquiry form.

## Access and accurate claims

Request access leads to `/signup`, then `/inquiry?topic=leadflow-access` with a prefilled message. It uses the existing configured inquiry destination and notification flow. It does not provision an account or promise approval. Existing accounts sign in through `/login`.

Pricing is a proposed packaging direction with no finalized prices or checkout. Shared teams, permissions, billing, and CRM sync are clearly planned. Automation platforms are documented HTTP methods, not native installed apps. Security copy describes current controls without asserting certifications or production readiness. No backend migrations or RLS changes are required for these pages.

## Verification

Run `npm run build`, `npm run lint`, `npm test`, and `npm run test:production`. The production test builds with test configuration; run `npm run build` afterward to restore the normal deployment build. Existing database and handler checks remain `npm run test:db`, `npm run test:m3`, `npm run test:integrations`, and `npm run check:edge`.

Marketing browser tests cover every public route and refresh, titles/descriptions, internal destinations, no private data requests, preview controls, FAQ expansion, access-inquiry prefill, signed-out dashboard protection, mobile navigation and Escape, keyboard skip navigation, and widths 360/768/1440. They also cover the six-stage walkthrough (autoplay with a controlled clock, pause on hover, stop on choice, keyboard tabs, hero shortcuts), the three demos and their rules, the truthful status rows, and reduced motion (no autoplay, counters at their final values). Existing M1–M3 browser tests now enter through `/app`; database and provider traffic in those tests is simulated.

Manual deployment smoke check: open each route directly, refresh, follow Request access to the inquiry form, sign in to `/app`, and confirm your existing records. Check the deployed Turnstile and notification configuration independently; local browser tests do not verify live email delivery.

## Remaining launch considerations

- Not automatically deployed by local changes. Keep Vercel frontend environment variables and existing Supabase function secrets configured.
- Route-specific metadata is client-rendered. Social crawlers that do not execute JavaScript see the base HTML metadata. Prerendering, canonical URLs, social images, and a sitemap are future SEO work.
- Unknown routes show an accessible not-found page, but the SPA host returns HTTP 200.
- Final commercial terms and privacy policies need business review before public commercial onboarding. No invented legal policy is included.
- Self-service signup, payments, shared team access, and third-party account execution are outside this phase.
