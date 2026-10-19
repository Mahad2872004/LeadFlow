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

**Status: not started; blocked by product decision gate, not by a technical failure.**

Entry requirements: explicit owner approval of one workflow; concrete target-agency examples and measurable baseline; documented residual gap against existing tools; agreed single-account/client permission model; realistic support/economic assumptions. The [research gates](docs/M5-RESEARCH.md#evidence-gates-and-next-decision) propose minimum evidence, not completed validation.

If kickoff readiness is approved, implement only: manual commercial-confirmation trigger, one template with text/asset links, scoped client response access, agency item acceptance, bounded reminders with pause/cancel, one internal ready handoff, durable execution/error/retry evidence. Resolve compatibility with whole-workspace lead replacement before schema changes. Reuse React/Vite/Supabase, existing styles and provider runtime patterns. Essential authorization and duplicate safety are M6 acceptance requirements, not postponed to M7.

No file hosting, AI, arbitrary workflow builder, cross-tool connector catalog, payments/contracts, sales outreach, reporting suite or shared-organization rewrite. An external PM adapter is deferred unless evidence shows it is necessary and repeatable. If configured existing tools win the comparison, choose a Promptly implementation offering instead of building a redundant SaaS.

Exit evidence: isolated positive/negative end-to-end tests; revoked/expired client links denied; other-owner reads/writes denied; replay/lost response cannot duplicate handoff/reminders; paused/cancelled requests stop future effects; partial failures visible and recoverable; existing M1–M4 regressions pass; measured workflow outcome from any separately authorized controlled tests. No public launch from a local test result alone.

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

M5: build, lint, Edge TypeScript, database, M3 handler/SQL and integration handler/SQL checks passed; 17/17 browser tests passed. External services simulated in automated checks; no live write performed. Prior user-confirmed inbox receipt is recorded separately in the manual integration guide. Full details and limitations are in [M5 audit](docs/M5-AUDIT.md#verification-performed-in-m5).
