# M5 repository audit

Audited 19 October 2026 against working tree based on commit `52274d2`. This is an implementation review and local verification, not an independent security audit or a fresh production certification. Existing uncommitted M4 changes were preserved. No application, schema, provider configuration, or production data was changed for M5.

## Evidence and method

Read README, M3 setup, integration setup/manual tests, and marketing documentation; inspected routing, authentication, domain operations, persistence, all three SQL migrations, three Edge Function handlers and shared runtime, integration guides, marketing content, and active tests. Cross-checked documentation against code and reran isolated checks. The requested DEVELOPMENT_ROADMAP.md, PRODUCT_OVERVIEW.md, and ARCHITECTURE.md were absent from the repository file inventory; M5 creates these canonical root documents rather than inventing an earlier roadmap.

Status vocabulary: **verified locally** means code exists and relevant checks passed; **partial** means implemented but materially restricted; **simulated** identifies test or UI behavior that is not an external service; **documented only** means a guide is not a native connector; **not implemented** means no corresponding product capability was found. A passing test is evidence only for the scenario it executes.

## Findings by milestone

| Area | Finding and status | Repository evidence | Boundary |
| --- | --- | --- | --- |
| M1 dashboard and leads | Verified locally: metrics, create/edit, search, source/status filters, status changes, detail views | `src/App.tsx`, `src/lib/model.ts`, `src/components/LeadForm.tsx`, `LeadTable.tsx`; `tests/m2.spec.ts` | Individual lead deletion has no UI; snapshot reset can replace records. Not a full sales CRM. |
| M1 follow-ups/history | Verified locally: due dates, complete/reopen, filters, history | `TaskList.tsx`, `ActivityTimeline.tsx`, `src/lib/dates.ts`, M2 browser tests | Tasks have no assignee/team, dependencies, recurring schedule, or automated client outreach. Activity is editable snapshot data, not an immutable audit log. |
| M1 samples/import/reset | Verified locally: explicit reset, import valid legacy browser data into an empty account, preserve old storage key | `src/App.tsx`, `src/lib/storage.ts`, `seed.ts`; M2 tests | No generic CSV import/export; reset is destructive to the caller's current workspace, with confirmation. |
| M1 notification bell | Implemented UI, partly simulated/session-only | `NotificationCenter.tsx`, in-memory `notice` in App | Not persistent delivery evidence; separate from the M3 email queue. |
| M2 persistence | Verified locally: real SQL transaction, refresh/reload, revision conflicts, same-request retries | `src/lib/backend.ts`; migration `202610180001_m2.sql`; `scripts/test-db.mjs` | Loads/saves whole workspace: 5 MB, 5,000 leads, 10,000 tasks, 20,000 history items limits. No pagination or Realtime subscription. |
| M2 auth/isolation | Verified locally: Auth gate and owner-scoped SQL grants/functions; two-owner and anonymous tests | `AuthGate.tsx`, `Dashboard.tsx`, migrations, DB tests | Hosted Auth/JWT transport simulated locally. Disabling public signup/anonymous sign-in is deployment configuration, not enforced by these source files alone. |
| Workspace architecture | Partial SaaS foundation: one `workspaces.owner_id` per Auth user | Migration 001, every owner filter, AuthGate user-keyed unmount | Record isolation exists. Shared organizations, memberships, invitations, RBAC, team switching, and billing do not. Calling it a shared agency workspace would be inaccurate. |
| M3 public form | Verified locally; prior live happy-path evidence recorded | `InquiryPage.tsx`, `Verification.tsx`, submit-inquiry handler, migration 002, M3 tests | Hosted form routes to server-configured WEBSITE_OWNER_ID/WEBSITE_ID. It is not a self-service per-agency public form router. |
| M3 validation/abuse | Verified locally: bounded body, normalized fields, CAPTCHA action/hostname, origin allowlist, honeypot, database quotas | `_shared/request.ts`, `_shared/inquiry.ts`, submit-inquiry handler, migration 002 | Origin checks are not authentication. Quotas are not a full edge DDoS defense. Real CAPTCHA/network behavior needs deployed verification. |
| M3 notifications | Verified locally: lead + outbox commit, leased sending, retries, idempotency, failure preservation | `_shared/runtime.ts`, retry-notifications handler, migration 002 | `accepted` means provider acceptance. No delivery/bounce webhook. Retry worker exists; its recurring scheduler is an operator setup step, not installed by migrations. Unknown jobs age into `uncertain` after 23 hours. |
| Inbound API/webhook | Verified locally: hashed bearer credential, owner-derived destination, revocation, quotas, request receipts | inbound-lead handler, migration 003, integration tests | Server-to-server lead creation only; not arbitrary triggers/actions, signed-contract ingestion, or outbound integrations. Source becomes `Other`, with integration label in activity/private receipt. |
| Integration hub | Verified locally: filters, method-specific instructions, copied iframe, metadata, receipt verification, revocation | `IntegrationsHub.tsx`, `src/lib/integrations.ts`, five integration browser tests | 13 cards are not 13 native connectors. Four website cards share the form; API/webhook/examples share inbound-lead; Zapier/Make/n8n/Sheets are HTTP setup guides. Credential issuance/rotation is administrator-managed; UI revokes only. |
| WordPress/custom/embed | Working iframe method, documented platform installation | Integration examples and cross-origin iframe browser test | No WordPress plugin or third-party site execution verified in M5. |
| CRM sync | Planned only | integration catalog `kind:'planned'` | No native OAuth connectors or two-way sync. |
| M4 public website | Verified locally: eight requested pages, signup access-request entry, login entry, responsive nav/FAQ/preview | `src/Routes.tsx`, `src/marketing/*`, marketing browser tests | Preview is deliberately fictional. `/signup` submits an inquiry, not account creation. Prices are provisional. No payment flows. |
| M4 routing/SEO | Partial production polish | Routes, Marketing, `vercel.json` | Native pathname navigation. `/app/integrations` is protected but opens Overview: App starts with `useState('Overview')`. Public `/integrations` is marketing. Metadata is client-rendered; unknown URLs return SPA HTTP 200 with not-found UI. No prerender/canonical/sitemap work verified. |
| Onboarding/assets/approvals | Not implemented | No corresponding models, routes, SQL tables, workers, or tests found | No client portal access, asset upload/storage policy, approval state, contract/payment trigger, project creation, client reminder sequence, or execution ledger. |

## Security and reliability boundaries relevant to M6

Five public tables (`workspaces`, `leads`, `follow_up_tasks`, `activity_history`, `workspace_requests`) have RLS owner-select policies. Anonymous access and authenticated direct writes are revoked. Writes occur through security-definer RPCs with empty search paths and explicit identity/owner checks. Private inquiry, outbox, rate-limit, and integration-key tables also enable RLS and revoke application-role access. Privileged ingestion RPCs are service-role only; safe integration metadata and revocation RPCs check the signed-in owner. Frontend configuration uses a public key.

Gateway JWT verification is disabled for the three Edge Functions in `supabase/config.toml`. Each has its own protection: CAPTCHA/quotas for public inquiry, hashed bearer credential for inbound-lead, constant-time digest comparison of worker secret for retries. This is not permission for anonymous database access.

The main architectural trap for future workflow tables is `save_workspace`: it deletes and reinserts the owner's lead collection in a transaction. Adding cascading foreign keys from new runs to leads could silently delete workflow state on ordinary edits. New workflow state must live outside this replaceable snapshot, and linkage/deletion semantics need explicit design and tests before any migration.

Other limits: request receipts/outbox grow without a retention job; user-facing activity is not security evidence; no general credential vault for recoverable third-party OAuth tokens; no general-purpose workflow executor; no proof of hosted backup restoration, incident response, or scheduler operation. These are release requirements, not findings of a confirmed exploit. No blocking regression was reproduced in the active suite; that does not establish absence of bugs.

## Verification performed in M5

| Check | Result | What it establishes |
| --- | --- | --- |
| `npm run build` | Passed | TypeScript and production asset compilation |
| `npm run lint` | Passed | Configured static lint rules |
| `npm run check:edge` | Passed | Edge Function TypeScript checking |
| `npm run test:db` | Passed | Actual migrations in PGlite: constraints, persistence/restart, rollback, revisions, owner isolation, privileges |
| `npm run test:m3` | Passed | Actual handlers + SQL: validation, CAPTCHA rejection, quotas, duplicates, provider outages and recovery |
| `npm run test:integrations` | Passed | Handler + SQL scoped authorization, metadata, rotation/revocation, receipts and duplicate safety |
| `npm test` | 17 passed | Five M2, four M3, five integration, three marketing browser scenarios |

Browser tests use Microsoft Edge and actual UI/Supabase client with simulated Auth/HTTP/provider transport over actual PGlite SQL. No external email or real platform request was sent by these checks. Old localStorage-based M1 specs are excluded by `playwright.config.ts`; do not call them passing or current tests. Production-browser 17/17 results exist from the preceding M4 turn; they were not rerun in M5 because no application changes were made.

Prior live evidence: [manual integration record](INTEGRATIONS-MANUAL-TESTS.md#latest-live-check--19-october-2026) documents a hosted inquiry saved, visible after reload, and receipt-verified on 19 October. The user confirmed receiving its email; an email connector did not independently inspect the inbox. This single happy path does not verify every account, RLS deployment, retry schedule, external automation, or current uptime. M5 performed no live production mutation.

## Documentation discrepancies

- Early README verification paragraphs say deployment/email were unverified at the time of implementation. The later dated manual guide adds limited live evidence. Preserve both as history; use the newer evidence for that one flow, not as blanket certification.
- The manual guide's initial root-URL sign-in instruction predates marketing. The current entry is `/login` or `/app`; this doc-only link is corrected in M5.
- Integration availability is a method/guide status, not proof of connected third-party execution.
- M1–M4 can be marked implementation-complete only with the boundaries above. Production readiness remains M7 work.
