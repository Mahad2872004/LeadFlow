# LeadFlow development roadmap

Updated 19 October 2026 after M5 audit/research. This canonical file was absent before M5. Earlier completion claims are qualified below by actual repository and verification evidence; they are not blanket production-readiness claims.

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

## M7 — Production readiness and controlled beta

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
