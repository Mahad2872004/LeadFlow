# LeadFlow development roadmap

Updated 19 October 2026 after M5 audit/research; M8 added 19 November 2026; M9 added 23 November 2026; M10 added 25 November 2026. This canonical file was absent before M5. Earlier completion claims are qualified below by actual repository and verification evidence; they are not blanket production-readiness claims.

## M1 — Lead-management UI

**Status: implementation complete; retained behavior locally verified.** Dashboard, lead create/edit/search/filter/status, follow-up tasks, history, fictional samples and reset remain functional in current M2-backed tests. The original browser-only storage is now legacy import material. Bell events are session-only; follow-ups do not send client outreach. Original M1 localStorage-based tests are historical and excluded, not claimed passing.

## M2 — Supabase persistence and internal access

**Status: implementation complete for individual owner accounts; locally verified.** PostgreSQL migrations, constraints, RLS/grants, authenticated snapshot RPCs, conflict/duplicate safeguards, safe legacy import and persistence tests pass. Auth/HTTP transport in tests is simulated. Hosted two-account authorization, operational restoration and full deployment configuration need the M7 evidence checklist. Shared agencies, team roles and self-service signup were not part of the completed capability.

## M3 — Website capture, notification and integrations hub

**Status: implemented and locally verified; external coverage partial.** Public inquiry, CAPTCHA/quotas, durable email outbox/retry function, scoped inbound lead API and integration guides are present. Prior hosted form submission persisted and appeared in dashboard after reload; user confirmed email inbox receipt on 19 October. This is limited happy-path evidence, not certification of all integrations.

WordPress/embed/custom websites share one form. Zapier/Make/n8n/Sheets are HTTP configuration guides, not native connected applications. Successful execution inside those external platforms is not verified. Retry scheduler configuration, delivery/bounce tracking and operational monitoring are not complete product features. Native CRM sync is planned only.

## M4 — Public marketing website

**Status: frontend implementation complete; local verification complete.** Eight public pages plus honest access-request/login entry points, responsive navigation, product illustration, FAQs and scoped styling are present. All 17 current browser tests passed in the M4 development/production runs; M5 reran the development suite successfully. Dashboard remains protected at `/app`/`/login`. No checkout, self-service signup, proven subscription prices or shared team capabilities are implied. Prerendered SEO and live marketing deployment smoke verification remain outside the completion claim.

## M5 — Desk research, competitive comparison and product decision

**Status: research/documentation completed; hypothesis approval pending.**

- [Repository audit](docs/M5-AUDIT.md): source-checked implementation and test boundaries.
- [Research](docs/M5-RESEARCH.md): dated evidence register, 14-product comparison, five-candidate weighted matrix, counterarguments, narrow hypothesis and go/no-go rules.
- [Product overview](PRODUCT_OVERVIEW.md): current product versus proposed direction and separate Promptly services/SaaS goals.
- [Architecture](ARCHITECTURE.md): existing boundaries and strictly proposed additive changes.

Decision: do not build broad onboarding automation or a generic engine. Keep LeadFlow as a working Promptly demonstration; investigate website kickoff readiness (client inputs, review, missing-item reminders and internal handoff). This is the best-supported hypothesis among those considered, not proof of underserved demand or willingness to pay. Existing Content Snare/Onthen/PM workflows must be compared fairly before choosing to build.

No application features, migrations, live configuration or production data changed in M5. No interviews, outreach, paid dependencies or pilot commitments occurred. Stop here until the owner approves the next milestone.

## M6 — One narrowly scoped workflow, conditional

**Status: the planned narrow workflow was superseded by M6A (below), which the owner requested on 25 October 2026.** The evidence gates described here were not met; they remain the way to judge whether the workflow is worth taking further.

Entry requirements: explicit owner approval of one workflow; concrete target-agency examples and measurable baseline; documented residual gap against existing tools; agreed single-account/client permission model; realistic support/economic assumptions. The [research gates](docs/M5-RESEARCH.md#evidence-gates-and-next-decision) propose minimum evidence, not completed validation.

If kickoff readiness is approved, implement only: manual commercial-confirmation trigger, one template with text/asset links, scoped client response access, agency item acceptance, bounded reminders with pause/cancel, one internal ready handoff, durable execution/error/retry evidence. Resolve compatibility with whole-workspace lead replacement before schema changes. Reuse React/Vite/Supabase, existing styles and provider runtime patterns. Essential authorization and duplicate safety are M6 acceptance requirements, not postponed to M7.

No file hosting, AI, arbitrary workflow builder, cross-tool connector catalog, payments/contracts, sales outreach, reporting suite or shared-organization rewrite. An external PM adapter is deferred unless evidence shows it is necessary and repeatable. If configured existing tools win the comparison, choose a Promptly implementation offering instead of building a redundant SaaS.

Exit evidence: isolated positive/negative end-to-end tests; revoked/expired client links denied; other-owner reads/writes denied; replay/lost response cannot duplicate handoff/reminders; paused/cancelled requests stop future effects; partial failures visible and recoverable; existing M1–M4 regressions pass; measured workflow outcome from any separately authorized controlled tests. No public launch from a local test result alone.

## M6A — Marketing-agency client onboarding and campaign readiness

**Status: implemented and verified locally, 25 October 2026.**
- **Database and Edge Functions:** applied and deployed to the hosted project the same day. Schema, grants and anonymous denial were verified there ([hosted rollout](docs/CLIENT-ONBOARDING.md#hosted-rollout-25-october-2026)).
- **Frontend:** not deployed.
- **Reminders:** Supabase Cron was configured on 25 October; the scheduled runs' outcomes are not yet verified.

The owner asked for this build. The M6 entry requirements and the [research gates](docs/AGENCY-ONBOARDING-RESEARCH.md#12-validation-plan-and-go-no-go-gates-no-interviews-required-to-start) remain unmet, so this is a capability, not evidence of demand.

**Delivered:**
- **Agency side:** an Onboarding section with a readiness dashboard, filtered request list and request detail. It includes:
  - four editable starter templates (paid advertising, SEO, social media management, email marketing);
  - per-client customisation that never changes the template;
  - item review (accept, request changes, mark not required);
  - deterministic readiness with a blocker list and an explanation;
  - one auditable handoff record;
  - an activity timeline.
- **Client side:** a portal at `/client-portal#token`, opened by a hashed, expiring, revocable link scoped to one request.
- **Reminders:** a bounded, idempotent reminder outbox and worker.
- **Data:** migration `202610250001` with a rollback, and the `client-portal` and `onboarding-reminders` Edge Functions.

Details, security model and deployment order: [docs/CLIENT-ONBOARDING.md](docs/CLIENT-ONBOARDING.md).

**Not built (deliberately):** project management (scope, deliverables, timelines, tasks), file uploads, platform integrations or access verification, automatic campaign actions, team invitations, and escalation emails.

The handoff ID is the attachment point for a later project record.

**Next steps:**
1. Repair the CLI migration history and apply `202610250001`.
2. Deploy the two functions and the frontend.
3. Configure and verify a reminder scheduler.
4. Run the hosted two-account and client-link checks in the onboarding guide.

## M6 — Lead discovery engine (expanded vision)

**Status: implemented and verified locally, 31 October 2026. On the same day, migration `202610310001` was applied to the hosted project and `discover-leads` deployed; anonymous denial and the "not configured" answer were checked live. The frontend is not deployed, and no live provider has been configured or exercised.** The owner requested this as the first milestone of the expanded vision: helping agencies find prospective clients. It is separate from the narrow M6 workflow above, which M6A superseded.

**Delivered:**
- **Discovery section:**
  - an ideal-customer search (industry or custom niche, up to three US/UK/AU locations, contact filters);
  - results showing freshness, attribution and duplicate status, with filter, sort, exclude, details and copy;
  - single and bulk import with review of possible duplicates;
  - search history, with reopened criteria.
- **Manual and CSV entry:**
  - manual business entry with a duplicate warning; email is now optional;
  - CSV import with column matching, per-row validation, duplicate review, idempotent batches and a file of rows not imported.
- **Provider layer:** a provider interface (`supabase/functions/_shared/discovery`) and an OpenStreetMap provider (Nominatim + Overpass). It is off until an operator configures servers whose terms permit the use. Google Places was rejected for imports because its terms forbid storing business details.
- **Data:**
  - migration `202610310001` with a rollback;
  - business fields on the existing leads table;
  - private provenance, history, geocoder cache and import receipts;
  - an append-only, role-checked, idempotent `import_leads` that enforces duplicate rules in SQL and advances the revision so stale snapshots cannot erase imports.

Details, setup and limitations: [docs/LEAD-DISCOVERY.md](docs/LEAD-DISCOVERY.md).

**Provider change, 31 October 2026:** the public OpenStreetMap servers failed in live use (Overpass overloaded; Nominatim refused Supabase with 403). Discovery now searches an Overture Maps places directory loaded into Postgres (migration `202610310002`, `npm run directory:load`). The migration was applied and the function redeployed the same day. Texas was loaded as the starter data set; other states and countries load on demand. See [docs/LEAD-DISCOVERY.md](docs/LEAD-DISCOVERY.md#overture-directory-default-provider-since-31-october-2026).


**Not done:**
- live provider configuration and a real search;
- legal review of ODbL share-alike for stored records;
- hosted deployment and two-account checks;
- further providers;
- all analysis, enrichment and outreach, which are deferred to later milestones.

**Next steps (after owner approval):**
1. Choose and configure Nominatim/Overpass servers.
2. Set the `OSM_*` and `DISCOVERY_ALLOWED_ORIGINS` secrets and deploy the frontend. The migration and function are already live.
3. Run a real search per target country and record result quality.
4. Get legal review of storage terms.

## M6B — Apollo.io lead generation

**Status: implemented and verified locally with a simulated Apollo API, 1 November 2026. Migration `202611010001` applied and the `apollo` and `apollo-webhook` functions deployed to the hosted project the same day. No real Apollo key used yet; the frontend is not deployed.**

- **Discovery → Apollo:** people search (free), company search (1 credit per page, confirmed each time), every filter Apollo's API documents, chips, saved filters, recent searches, a results table with columns, sorting, in-page search and pagination.
- **Reveals:** email and phone reveals through bulk people enrichment, a cost confirmation, and phones delivered to a one-time-token webhook.
- **Credits:** a locked, idempotent credit ledger; Apollo-reported credits where available; Apollo balance and billing-cycle sync; a per-account and combined dashboard; filterable history.
- **Leads:** saving through `import_leads` with duplicate protection, provenance and the account used; lead lists with a Leads-page filter; reveals fill in masked names and empty fields on saved leads.
- **Not built:** automatic account rotation to stretch free credits, which Apollo's Terms (§4.2) prohibit; campaigns (none exist yet); paid organization enrichment.

Setup, endpoints, limits and security: [docs/APOLLO.md](docs/APOLLO.md).

**Setup status (1 November 2026):** `APOLLO_API_KEYS` and `APOLLO_WORKSPACE_IDS` are set. People search was confirmed live on the Free account (work email): 1,768,393 results for an owner/founder search. Reveals and company search on Free are not yet confirmed.

**Next:** push the frontend; add local addresses to `DISCOVERY_ALLOWED_ORIGINS` to test locally; then reveal one person (1 credit) to confirm reveals on this plan. See the troubleshooting table in [docs/APOLLO.md](docs/APOLLO.md#troubleshooting).

## M7 — AI business intelligence and opportunity analysis

**Status: implemented and verified locally with simulated websites, DNS, Apify, PageSpeed Insights and Gemini, 8 November 2026. Migration `202611080001` is applied to the hosted project and the `business-analysis` and `analysis-worker` functions are deployed. Gemini is the only AI provider (no Claude). No real Gemini key used yet.**

- **Report per lead:** Lead → **Business report** analyzes the lead's public website as a background job (validate → crawl → site checks → PageSpeed → interpret → match) with live progress, history, reanalysis with a "recent report" check, and comparison with the previous report.
- **Collection:** SSRF-safe fetching (every resolved address and redirect checked), LeadFlow's own page reader, optional Apify Website Content Crawler with polling, budgets and fallback, robots.txt, sitemap, broken links, social profiles, about 60 technology signatures, PageSpeed Insights mobile and desktop.
- **Evidence model:** every finding cites stored evidence; findings are typed (observed, measured, AI interpretation, hypothesis) with severity and confidence; absence findings are never high confidence; AI confidence is capped; teams mark findings confirmed or not accurate.
- **AI:** Gemini (Google AI Studio key) through its REST API with a fixed JSON schema; website text fenced as data against prompt injection; invalid citations dropped.
- **Opportunities:** matched to the workspace's agency service catalog (Settings, with 11 editable starter services), with priority, confidence, why, possible benefit and next action; accept, dismiss, needs verification and notes.
- **Controls:** monthly and concurrent analyses per workspace, an Apify page budget and per-run charge cap, usage recorded per provider (cost only when the provider reports it).
- **Not built:** outreach from reports, enrichment, scheduled re-analysis, PDF export, billing.

Details, configuration, security and limitations: [docs/BUSINESS-INTELLIGENCE.md](docs/BUSINESS-INTELLIGENCE.md).

**Next:** set `GEMINI_API_KEY` (and `APIFY_API_TOKEN` if wanted); schedule the worker; push the frontend; then analyze two or three real leads and review the findings by hand.

## M8 — Contact intelligence and AI outreach

**Status: implemented and verified locally with simulated websites, DNS, Apollo data and Gemini, 19 November 2026. The same day, migration `202611190001` was applied to the hosted project and the `outreach` and `analysis-worker` functions were deployed; boot, origin, sign-in and anonymous-access checks passed live ([hosted rollout](docs/OUTREACH.md#hosted-rollout-19-november-2026)). The frontend is not deployed and no real contact search or draft has been run.** Gemini remains the only AI provider.

**Contacts (lead → Contacts):**
- **Discovery:** a background job (website → verify) reads the latest business report's page evidence, plus up to 5 team, about and contact pages, respecting robots.txt.
- **What's extracted:** published email links, phone links and WhatsApp links; people only when a name and a job title appear together; business channels (contact page and form, booking page, social, LinkedIn company page, address).
- **Statuses:** emails get honest statuses from mail-server (MX) checks; phones are normalized with libphonenumber-js.
- **Confidence:** explainable and rule-based, with reasons and limitations.
- **Provenance:** every value keeps its source page, method and date, and the evidence ID when it came from the report.
- **Merging:** never duplicates, and never overwrites confirmed or edited details. Differences become suggestions.
- **Managing contacts:** add, edit, confirm, set primary and preferred, check again, delete (remembered as hashes, so it isn't collected again), and erase a lead's contact data.
- **Apollo decision-makers:** found through the existing `apollo` function and credit ledger; only the workspace's own Apollo records are copied.

**Outreach (lead → Outreach):**
- **Drafts:** email, WhatsApp, LinkedIn invitation note (200 characters, LinkedIn Help) and LinkedIn message.
- **Choices:** a recommended opportunity and five distinct angles, each explained.
- **Grounding:** drafts are grounded in M7 findings, with claims linked to finding and evidence IDs and source URLs. Without evidence, the draft is an honest general introduction.
- **Refused drafts:** drafts claiming lost customers, internal processes, guaranteed results, invented earlier contact or pressure are refused before saving.
- **Prompt injection:** untrusted text is fenced.
- **Versions:** edits, regeneration (only after confirmation if you edited), compare and restore.
- **Status:** changed only by a person. "Mark as sent" adds a lead activity entry; reminders become ordinary follow-up tasks. Follow-up drafts only after the first message is sent.
- **Settings → Outreach:** agency identity, tone, length, objective, call to action, words to avoid, case-study links and follow-up intervals; each member's own sender details; and usage.

**Platform:**
- Migration `202611190001` with a rollback; Edge Function `outreach`.
- `analysis-worker` also continues contact searches on the existing schedule.
- Usage recorded per provider, with credits only when reported.
- Monthly, concurrency, recent-search and rate limits; idempotent generation.

**Not built:** sending email or WhatsApp, inbox or reply sync, LinkedIn automation or invitations, bulk outreach, scheduled sequences, paid email verification, a workspace-wide outreach board.

Details, configuration, security and limitations: [docs/OUTREACH.md](docs/OUTREACH.md).

**Next:**
1. Deploy the frontend.
2. Fill in Settings → Outreach.
3. Run contact searches and drafts on two or three real leads, and review each detail and draft by hand.

## M9 — Sales pipeline and deal management

**Status: implemented and verified locally, 23 November 2026. Migration `202611230001` is in the hosted database. It was applied outside the migration history; on 26 November 2026 it was verified identical and recorded. The frontend isn't deployed. No Edge Function changes.**

- **Pipeline:** configurable stages (ten defaults; rename, colour, default probability, add, reorder, archive with same-kind reassignment, restore), board with drag and drop and a Move menu for keyboards and phones, sortable paged list, summary per currency.
- **Deals:** several per lead; created from the pipeline, a lead, a report opportunity or outreach, keeping those links; duplicate warning; value, currency, probability, weighted value, expected close, owner, priority, notes; versioned edits with history.
- **Deal view:** overview with business, contacts, opportunity and findings, stage history; a merged timeline (notes, calls, replies, proposals, stage changes, meetings, follow-ups, outreach, lead history) with filters; follow-ups and meetings; outreach drafts.
- **Follow-ups:** the existing tasks gain type, priority, details, deal, contact, assignee and cancellation, with Today, Assigned to me, Deals and Cancelled filters.
- **Won, lost, reopen and handoff:** final value; reasons from a configurable list; explicit reopen; one confirmed client handoff per won deal, then client onboarding.
- **Suggestions, not automation:** after a recorded reply, interested call, proposal or meeting, or outreach marked sent or replied, LeadFlow offers the matching stage. Nothing moves without a click.
- **Analytics:** periods (7/30/90 days, quarter, year, custom), open and weighted pipeline, won and lost per currency, win rate over closed deals with a small-sample caution, stages, lost reasons, sources, services, cycle length, overdue follow-ups, deals closing soon.
- **Notifications:** meetings in the next 48 hours and expected closes within 3 days or overdue, in the in-app bell.

**Not built:** the optional AI sales assistant; email, calendar or inbox integration; currency conversion; custom fields, products, quotes; email or push notifications.

Details: [docs/SALES-PIPELINE.md](docs/SALES-PIPELINE.md).

**Next:**
1. ~~Apply `202611230001`~~ (done, see M10). Deploy the frontend.
2. Review stages, currencies and lost reasons in Pipeline settings.
3. Move two or three real leads through the pipeline and check the analytics by hand.
4. M10 (client management) started from `client_handoffs`; see below.

## M10 — Client onboarding and client management

**Status: implemented and verified locally, 25 November 2026. On 26 November 2026:**
- migration `202611250001` was applied to the hosted project and checked (RLS, grants, columns);
- `client-files` was deployed and `client-portal` re-deployed, and both were smoke-tested.

**Not done:**
- the frontend isn't deployed, and M10 isn't committed;
- real Supabase Storage is untested; the tests use a simulation of its API, and no file has been uploaded on the hosted project.

- **Conversion:**
  - **Convert to client…** on a won deal opens a review: the deal, the lead, the report opportunity and summary, contacts with roles and a primary, services with scope, and a recommended onboarding template.
  - One transaction, idempotent, once per deal. It reuses or records the M9 handoff and resumes deals handed off before M10.
  - Owners and admins can convert deals that aren't won, with a reason.
- **Clients:** dashboard and directory (search, filters, sort, paging). Each client has a workspace with eight tabs: overview, contacts, onboarding, services and scope, documents, tasks, activity and notes, projects (an M11 placeholder).
  - Client status is separate from the computed onboarding status.
  - Archiving is read-only and revokes client links.
- **Onboarding engine (M6A, extended):**
  - configurable stages with per-stage progress;
  - internal agency steps, including automatic ones, and a new "Agency steps left" readiness state;
  - fifteen field types, including file uploads;
  - a forms library copied into checklists;
  - every submission kept with its review;
  - seven starter templates, adding website, SEO & digital marketing and automation.
- **Requirements and scope:** versioned requirements, and superseding scope confirmations with change detection. The client can acknowledge the scope in the portal. This is a record, not a contract or signature.
- **Documents:** private Storage, signed one-time uploads, size and content-signature checks before use, 60-second download links, sharing with the client, and role-checked deletion.
- **Tasks:** the existing follow-up tasks, now also for clients and their checklists, with onboarding task types.
- **Welcome message:** written, copied or opened in the user's email app, then marked sent. LeadFlow sends nothing.
- **Timeline and notes:** one paged history across client, onboarding, scope, files and tasks, plus append-only internal notes.
- **Completion:** a checklist. Completing with items outstanding takes an owner or admin and a reason. It hands off ready checklists and stores the snapshot M11 will start from.

**Not built:**
- AI (optional in the brief);
- any sending or delivery tracking;
- client accounts;
- e-signatures;
- antivirus scanning, previews and file versions;
- projects (M11).

Details: [docs/CLIENT-MANAGEMENT.md](docs/CLIENT-MANAGEMENT.md).

**Next:**
1. ~~Apply `202611250001`; deploy `client-files`; re-deploy `client-portal`; check the allowed-origin secrets~~ (done 26 November 2026). Commit, then deploy the frontend.
2. Run the manual Storage checks in the M10 doc on the hosted project.
3. Convert two or three real won deals and onboard them by hand.
4. M11 (projects and delivery) starts from `client_onboarding_completions.snapshot`. **Not started; awaiting approval.**

## Production readiness and controlled beta (formerly listed as M7; not scheduled)

**Status: not started; contingent on M6 and evidence.**

Validate deployed Auth/RLS/RPC/client-token boundaries with two accounts and disposable records; verify origin/secret setup and quotas; configure and exercise retry scheduling, alerts, secret rotation, backup restoration, retention/deletion and incident runbooks. Add delivery/bounce evidence and distinguish provider acceptance. Test cancellation races, delayed jobs, revocation and ambiguous external outcomes. Define acceptable operational costs, response ownership and beta limits.

Use consented, bounded beta accounts with a named operator and support channel. Measure touch time, completion/abandonment, errors, support effort and repeat use separately. The proposed paid-continuation gate is evidence to collect later, not a billing implementation mandate. Do not claim production readiness, compliance certification, product-market fit or recurring revenue without corresponding evidence.

## Multi-tenant workspace foundation — backend

**Status: implemented, locally verified, and applied to the hosted project 20 October 2026 (schema and grants verified there); hosted two-account checks pending; no UI.**

- Users can own several workspaces and be an owner, admin or member of others.
- Membership-based RLS and role-checked database functions.
- Lossless, guarded migration of existing per-user data, with a tested rollback.
- The unsafe, unapplied draft `202610190001` was superseded.
- The dashboard keeps using each user's personal workspace.

**Onboarding and workspace management: implemented and locally verified 20 October 2026; migration `202610200002` not yet applied to the hosted project.**

- Sign-up that follows the hosted Auth configuration (currently closed), sign-in, route protection and session restoration.
- First-workspace onboarding, a workspace switcher, and workspace settings with read-only members.

**Product features integrated with workspaces: implemented and locally verified 20 October 2026; migration `202610200003` and the `submit-inquiry` update not yet deployed.**

- Each workspace has its own public form link and notification recipient.
- Members can't remove records or rewrite history; the database enforces this.
- Isolation tests cover two accounts and three workspaces.

Next steps: apply `202610200002` and `202610200003`, deploy `submit-inquiry`, then the frontend; hosted two-account verification; a decision on opening public sign-up; then invitations and member management. See [docs/MULTI-TENANCY.md](docs/MULTI-TENANCY.md).

## Current verification ledger

**M10 client onboarding and client management, 25–26 November 2026 (local, then hosted).** All passed:
- `npx oxlint` (no warnings), `npx tsc -b`, `npm run check:edge` and `npm run build`;
- the new `npm run test:clients`, including paging the timeline by `(time, id)` so events written in one transaction are never skipped;
- `test:db`, `test:tenancy` (exact grant list updated), `test:m3`, `test:integrations`, `test:onboarding` (seven starters, internal steps), `test:discovery`, `test:apollo`, `test:analysis`, `test:outreach` and `test:sales` (all roll back M10 first where needed);
- `npx playwright test`: 51/51, including 2 new client tests and 1 new onboarding test;
- `npm run test:production`: 51/51.

Storage was simulated in these tests; no outside service was contacted and nothing was sent. On 26 November the migration was applied to the hosted project and the two Edge Functions deployed, with the read-only checks and smoke test described in [CLIENT-MANAGEMENT.md](docs/CLIENT-MANAGEMENT.md#hosted-rollout-26-november-2026).

**Found and fixed by these tests:**
- archived clients could still be edited;
- automatic steps recorded the triggering member, so they couldn't be told apart from manual completions or undone automatically;
- an `IF` condition with a `CASE … THEN` inside broke PL/pgSQL parsing;
- the M6A onboarding test assumed templates had no internal steps;
- client tasks have no lead, so the browser's data check would have refused to load a workspace containing them;
- the client timeline's page boundary could skip events that share a timestamp.

**M9 sales pipeline and deal management, 23 November 2026 (local).** All passed:
- `npx oxlint` (no warnings), `npx tsc -b`, `npm run check:edge` and `npm run build`;
- the new `npm run test:sales`;
- `test:db` and `test:tenancy` (new task fields; exact grant list updated), `test:m3`, `test:integrations`, `test:onboarding`, `test:discovery`, `test:apollo`, `test:analysis` and `test:outreach` (both now roll back M9 first);
- `npx playwright test`: 48/48, including 3 new sales tests;
- `npm run test:production`: 48/48.

No outside service was contacted; websites and the AI provider were simulated for the business report the tests use.

**Found and fixed by these tests:**
- the board's empty state never showed (it counted won columns, not won deals);
- a period with no activity showed "No deals to analyse yet" even though deals existed;
- a conflicting move's explanation disappeared when the board reloaded;
- reopening a lost deal tripped a check while its lost reason was still set;
- the Won column totalled the original value instead of the final won value;
- average sales cycle could be negative for a deal created and closed the same day;
- the "track this conversation as a deal" prompt took over the outreach dialog's status message;
- a paging query passed an extra column to the deal formatter; a missing parenthesis in `sales_analytics`.
- Unrelated to M9: `test:apollo` had started failing on 21 November because its simulated Apollo credit cycle ended on 20 November 2026; the fixture now uses dates around the day the test runs.

**M8 contact intelligence and outreach, 19 November 2026 (local).** All passed:
- `npm run lint` (no warnings), `npx tsc -b`, `npm run check:edge` and `npm run build`;
- the new `npm run test:outreach`;
- `test:db`, `test:m3`, `test:integrations`, `test:tenancy` (exact grant list updated), `test:onboarding`, `test:discovery`, `test:apollo` and `test:analysis` (which now rolls back M8 before M7);
- `npx playwright test`: 45/45, including 2 new outreach tests;
- `npm run test:production`: 45/45.

Websites, DNS (including MX records), Apollo data and Gemini were simulated; no external service was contacted, nothing was billed and no message was sent. LinkedIn's 200-character invitation-note limit was checked on LinkedIn Help on 19 November 2026.

**Found and fixed by these tests:**
- a job title ("Practice Manager") accepted as a person's name;
- a table alias clashing with a PL/pgSQL variable in `outreach_context`;
- an array-append type ambiguity in `save_lead_contact`;
- version comparisons interleaving words instead of grouping changes.

**M7 business intelligence, 8 November 2026 (local).** All passed:
- `npm run lint`, `npx tsc -b`, `npm run check:edge` and `npm run build`;
- `npm run test:db`, `test:m3`, `test:integrations`, `test:tenancy` (updated exact grant list), `test:onboarding`, `test:discovery`, `test:apollo` and the new `test:analysis`;
- `npx playwright test`: 41/41, including 2 new business-report tests; `npm run test:production`: 41/41.

Websites, DNS, Apify, PageSpeed Insights and the AI provider were simulated; no external service was contacted and nothing was billed. Found and fixed by these tests: IPv4-mapped IPv6 addresses in hexadecimal form (`::ffff:a00:1`) passed the private-address check; AI interpretations marked "high" were lowered to "low" instead of capped at "medium".

**M6 lead discovery, 31 October 2026 (local).** All passed:
- `npm run lint` (no warnings), `npx tsc -b`, `npm run check:edge` and `npm run build`;
- `npm run test:db`, `test:m3`, `test:integrations`, `test:tenancy`, `test:onboarding` and the new `test:discovery`;
- `npx playwright test`: 36/36 on the final two consecutive runs, including 5 new discovery tests. Two earlier full runs each had one intermittent failure in a pre-existing test (onboarding journey; integrations sign-in during a Vite dev-server "can't detect preamble" error), which passed on rerun;
- `npm run test:production`: 36/36.

The geocoder and directory were simulated; no external service was contacted.

**M6A, 25 October 2026 (local).** These all passed:
- `npm run lint` (no warnings);
- `npm run check:edge`;
- `npm run test:db`, `test:m3`, `test:integrations`, `test:tenancy` and the new `test:onboarding`;
- `npm run build`;
- `npx playwright test`: 31/31 in development, including the 3 new onboarding tests;
- `npm run test:production`: 31/31 against the production build.

Four deliberate faults injected into the onboarding migration were each caught by `test:onboarding`.

**How it was tested:**
- Databases ran in PGlite (PostgreSQL 18).
- In browser tests, Auth and HTTP transport were simulated, and every RPC ran the real SQL.
- The Edge handlers ran in Node with the email provider simulated.

**Not verified:** any hosted behaviour, real email, or a scheduler.

M5: build, lint, Edge TypeScript, database, M3 handler/SQL and integration handler/SQL checks passed; 17/17 browser tests passed. External services simulated in automated checks; no live write performed. Prior user-confirmed inbox receipt is recorded separately in the manual integration guide. Full details and limitations are in [M5 audit](docs/M5-AUDIT.md#verification-performed-in-m5).
