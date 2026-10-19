# Public marketing website

Public routes: `/`, `/features`, `/integrations`, `/solutions`, `/pricing`, `/resources`, `/faq`, `/security`, and `/signup`. `/login` and `/app` retain the existing dashboard Auth gate. `/inquiry` remains the existing public form. Update old dashboard bookmarks to `/app`; browser data remains on the same origin.

## Design and behavior

`src/marketing/` contains shared components, page content, and scoped styles. The warm neutral and forest-green palette builds on the dashboard. Product illustrations use fictional records, never database reads. The preview switches between pipeline and follow-up examples. Native FAQ disclosures, a keyboard-accessible mobile menu, visible focus, skip navigation, and reduced-motion styles are included. No extra fonts, tracking scripts, or dependencies were added.

The site uses the existing pathname approach with native links and lazy page bundles. Titles and descriptions update per route. The existing Vercel SPA rewrite supports direct navigation and refreshes.

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
