# LeadFlow — Marketing Website + M3 + Integrations Hub

LeadFlow is a React + TypeScript + Vite dashboard backed by Supabase PostgreSQL and Supabase Auth. It uses the Supabase Data API and database functions directly; no Express server, paid messaging service, or CRM integration is needed.

The public website starts at `/`. The protected dashboard lives at `/app`, with `/login` as its sign-in entry point. `/signup` creates accounts when public sign-up is enabled in Supabase Auth; otherwise it explains invitation-based access and links to the inquiry form. After sign-in, users without a workspace create one, and they can switch between workspaces from the sidebar ([details](docs/MULTI-TENANCY.md#onboarding-and-workspace-management)). See the [marketing website guide](docs/MARKETING.md) for routes, verification, and deployment limitations.

## Product direction and M5 research

See the [product overview](PRODUCT_OVERVIEW.md), [architecture](ARCHITECTURE.md), [development roadmap](DEVELOPMENT_ROADMAP.md), [M5 repository audit](docs/M5-AUDIT.md), and [market research and scoring](docs/M5-RESEARCH.md). M5 recommends investigating a narrow website kickoff-readiness workflow, while retaining LeadFlow as a Promptly implementation demonstration. Demand and willingness to pay are not validated. The owner has since asked for M6A, client onboarding for marketing agencies; it is implemented locally (see below), which is not evidence of demand. Earlier dated verification notes below remain historical; the M5 audit consolidates current local checks and the limited subsequent live evidence.

## Client onboarding (M6A)

The **Onboarding** section helps a marketing agency onboard a new client:
- service templates for paid advertising, SEO, social media management and email marketing;
- per-client checklists and one private, expiring, revocable client link (`/client-portal`);
- review, with requests for changes;
- deterministic readiness, an auditable handoff, and bounded reminders.

It is implemented and verified locally only. It is not deployed, and reminders need a scheduler that isn't configured. See [docs/CLIENT-ONBOARDING.md](docs/CLIENT-ONBOARDING.md) for the user journey, security model, deployment order and limitations.

## Set up a Supabase project

1. Create a Supabase project. In Authentication, disable anonymous sign-ins. Either keep public sign-up disabled and create users with a confirmed email in the dashboard, or enable it after following the [sign-up checklist](docs/MULTI-TENANCY.md#onboarding-and-workspace-management) (redirect URLs, SMTP, password length). Each account gets its own personal workspace. Accounts share data only through explicit workspace membership (see [multi-tenancy](docs/MULTI-TENANCY.md)).
2. Apply the SQL files in `supabase/migrations/` in filename order, once, in a new project. For an existing project, apply only migrations not already applied, including `202610180003_integrations.sql` for the hub and `202610200001_multi_tenant_foundation.sql` for workspaces. Follow the [multi-tenancy runbook](docs/MULTI-TENANCY.md#migration-runbook) before applying the latter to existing data. Alternatively install the Supabase CLI, `supabase login`, `supabase link --project-ref YOUR_PROJECT_REF`, then `supabase db push`. Review the target project before applying migrations.
3. Copy `.env.example` to `.env.local`. Set `VITE_SUPABASE_URL` to the project URL and `VITE_SUPABASE_PUBLISHABLE_KEY` to its publishable key (a legacy **anon** key also works). These values are included in the browser bundle. **Never put a service-role key, secret key, database password, or privileged token in any VITE variable.** Local environment files are ignored by Git.
4. Use Node.js 22.12+ and run `npm install`, then `npm run dev`. Sign in with the internal account. Missing configuration shows setup instructions instead of silently falling back to browser persistence.
5. The first database workspace is empty. Add a lead, explicitly import saved browser data, or confirm **Reset demo data** to load the eight fictional M1 leads and their tasks/history.

For local Supabase development, install Docker and the Supabase CLI, then run `supabase start` and `supabase db reset` in a disposable local project. `db reset` destroys the local database. Use the URL and anon/publishable key reported by the CLI in `.env.local`, and create a confirmed test account through the local Studio. The migration has no hosted-only dependencies. The CLI and Docker are not bundled with this repository.

## Persistence and access model

- Users can own several workspaces and be an owner, admin or member of others. `leads`, `follow_up_tasks`, and `activity_history` use composite workspace/record keys. Foreign keys prevent orphan records or cross-workspace links. Checks enforce required fields, allowed statuses/sources/services, email/phone lengths and formats, calendar dates, finite timestamps, and note/message lengths. Indexes cover status/source, creation time, due dates, and lead history.
- All eight exposed tables (including `profiles`, `workspaces`, `workspace_memberships`, `workspace_settings`, and `workspace_requests`) have RLS enabled. Authenticated accounts can select only rows of workspaces they belong to. Anonymous callers have no table privileges or RPC access. Direct insert/update/delete is revoked even for authenticated users.
- Workspace functions are narrowly scoped security-definer functions with an empty search path. They take the caller only from `auth.uid()` and reject absent identities and anonymous Auth sessions. They check the caller's membership and role in the database on every call, and filter every read and write by the authorized workspace. A workspace ID from the browser selects a workspace but never authorizes anything. Do not remove those checks: definer functions bypass RLS. The dashboard's `load_workspace` and `save_workspace` operate on the caller's personal workspace. Roles, functions, and the migration and rollback steps are in [docs/MULTI-TENANCY.md](docs/MULTI-TENANCY.md).
- Each save atomically replaces the workspace's three related collections, advances a revision, and records a request receipt. A locked workspace row serializes concurrent saves. Old revisions fail instead of overwriting newer edits. Retrying the same request ID and payload returns its original revision without repeating writes; using that ID with different data fails. Identical email addresses are allowed because separate inquiries can be legitimate.
- The UI only displays saved changes and success after the database acknowledges them. On failure, the intended snapshot and request ID remain in memory for **Retry saving**. **Reload workspace and discard attempt** explicitly abandons that attempt and fetches current server data. A browser refresh loses an unacknowledged in-memory draft, but any committed database changes remain. Refresh also retrieves edits from other sessions; no Realtime subscription is used.
- Supabase Auth manages its session tokens in browser storage. Leads/tasks/history are never automatically written to localStorage. Sign-out or an account change unmounts private workspace state.

This intentionally simple snapshot protocol is for small internal workspaces: maximum 5 MB per save, 5,000 leads, 10,000 tasks, and 20,000 history items. It is not a paginated large CRM. Activity history preserves M1 user-facing events and imports; it is **not an immutable security audit log**. Request receipts are retained for safe retries and grow with writes. No automatic deletion/retention job is installed.

The security approach follows Supabase's [RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security) and [database-function guidance](https://supabase.com/docs/guides/database/functions).

## Preserve and import M1 data

M1 used `leadflow.demo.v1` in localStorage. M2 never changes or deletes that key. Open M2 on the **same browser and origin/port** used for M1 to see **Import browser data** when the database workspace is empty. Confirming copies validated leads, follow-ups, IDs, timestamps, and history in one transaction. A changed server revision rejects the import safely. Existing database records are never automatically merged or replaced by import.

Invalid browser data produces an explicit message and remains untouched. If moving to another origin, export that key from the original browser first; this release has no file-upload import UI. Reset asks for confirmation and replaces only the signed-in account's database data with fictional samples; it cannot undo prior edits. It does not erase the M1 browser backup or another account's records.

## M1 workflows retained

Overview metrics and pipeline shortcuts, lead creation/full editing, search and combined filters, all five statuses, lead details, follow-up scheduling/completion/reopening, local-calendar due indicators, history, responsive layouts, and simulated notifications remain. Follow-up dates stay `YYYY-MM-DD`; past dates are permitted. The shared day hook updates due states at midnight and on tab return. Dashboard bell notifications are session-only. Website inquiry emails use the separate M3 queue. Reset is a transactional database operation. Individual lead deletion was not an M1 UI feature; removing records is supported by the database snapshot operation and tested through reset.

M3 adds an independent public `/inquiry` page, protected by Cloudflare Turnstile and durable quotas, and Resend notifications through a private outbox. The dashboard capture form remains authenticated. Public visitors cannot read leads or invoke dashboard CRUD. Follow the [M3 setup guide](docs/M3-SETUP.md) to configure and deploy the new migration and Edge Functions.

## Run checks

```powershell
npm run build
npm run lint
npm run test:db
npm run test:m3
npm run test:integrations
npm run test:tenancy
npm run test:onboarding
npm run check:edge
npm test
npm run test:production
```

Browser tests use installed Microsoft Edge. To use Chromium instead, change the channel in `playwright.config.ts` and install it using `npx playwright install chromium`.

`test:db` executes the actual migrations in embedded PostgreSQL (PGlite), with test implementations of `auth.uid()`/`auth.jwt()` and Supabase's default grants on new public tables and functions ([tests/support/database.ts](tests/support/database.ts)). It exercises constraints, transactions, CRUD/reset, follow-ups, duplicate requests, conflicts, grants, and RLS under anon and two authenticated identities. This is actual SQL execution, not a mocked database. `test:tenancy` covers workspace roles, cross-workspace denial, migration of existing data, and rollback; see [docs/MULTI-TENANCY.md](docs/MULTI-TENANCY.md#verification-performed-local-20-october-2026).

`tests/m2.spec.ts` drives the real UI and Supabase JS client against that migration in PGlite. Only the Auth service and HTTP transport are simulated. It covers login/logout, empty workspace, sample reset/cancel, CRUD/filtering, follow-ups/history, refresh and new-login persistence, explicit legacy import, lost-response retries, conflict recovery, load failure, and mobile layout. Test configuration uses a fake key and loopback URL; it never connects to your real project. Production tests build using `.env.test` before preview. Run `npm run build` again before deployment to replace that test build with your configured production build.

The original four M1 test files remain as historical regression references, but are excluded from the M2 test command: their direct localStorage writes and automatic demo seeding assumptions are obsolete. M2 test results must not be described as passing the old 23-test suite.

## Required live-project verification before release

Embedded tests do not verify Supabase's hosted Auth, JWT verification, PostgREST deployment, network configuration, or your actual project policies. After applying the migration to a disposable Supabase project:

1. Create two confirmed internal accounts A and B, disable signup and anonymous login, and sign in as A. Import or create data, edit contact/status, schedule and complete/reopen a task, then reload and restart Vite. Verify the same records and history remain.
2. Sign out. The dashboard must be inaccessible. Sign in as B; no A records should be visible. Create B data and reset A; B data must remain.
3. Using the project's public key with no user bearer token, call REST endpoints for every table and both RPCs. Expect permission errors and no data. With A's user token, table selects must expose only A rows; direct inserts/updates/deletes must fail. Repeat using B's token and A record IDs.
4. Open A in two tabs. Save in tab 1 and attempt an edit in stale tab 2. Expect a conflict and explicit reload recovery. Use network tooling to repeat the exact `save_workspace` payload/request ID; verify one revision advance and no duplicate lead/history. Reuse that ID with changed data; expect rejection.
5. Disconnect the network while saving. No false success should appear. Reconnect and retry; verify saved data after reload. Verify invalid inputs and orphan relationships are rejected through the API, not just in the UI.

The local repository includes project configuration, but this implementation did not deploy or verify changes against the live project. Deployment and the live checks above remain required.

## Main implementation files

- `src/lib/backend.ts`, `src/lib/supabase.ts`: configured client and RPC persistence.
- `src/components/AuthGate.tsx`, `AuthScreen.tsx`: session restoration, route protection, sign-in, sign-up and email confirmation.
- `src/components/WorkspaceShell.tsx`, `WorkspaceSwitcher.tsx`, `WorkspaceForm.tsx`, `WorkspaceSettings.tsx`: onboarding, switching, creation and settings.
- `src/App.tsx`: one workspace's dashboard: asynchronous workflows, import, retry, conflict recovery.
- `src/lib/model.ts`, `dates.ts`, `seed.ts`: retained M1 domain operations, dates, and fictional records.
- `src/lib/storage.ts`: retained legacy validator/helpers; automatic storage persistence is no longer used by the application.
- `supabase/migrations/202610180001_m2.sql`: schema, indexes, RLS, grants, transactional functions.
- `supabase/migrations/202610200001_multi_tenant_foundation.sql`, `supabase/rollbacks/`: profiles, workspaces, memberships, settings, role-checked functions, and the guarded rollback.
- `scripts/test-db.mjs`, `scripts/test-tenancy.mjs`, `tests/*.spec.ts`: database, tenancy and browser verification. Browser tests use `tests/support/supabase.ts`, which simulates Auth and runs every RPC's real SQL as the requesting user.

## M2 verification performed — 18 October 2026

- TypeScript/production build and lint passed.
- Actual migration checks passed in PGlite, including reloading a saved database image in a new engine, validation/rollback, access grants, owner isolation, and retry/conflict behavior.
- Five M2 browser tests passed against Vite development; the same five passed against built production assets.
- Supabase Auth and HTTP transport were simulated in browser tests. Hosted Auth/API/RLS deployment and real project restart persistence remain unverified.

## M3 setup and verification

The new **Integrations** sidebar page includes searchable guides, real hosted/embed examples, workspace receipt verification, safe credential metadata/revocation, and notification queue evidence. A separate token-authenticated `inbound-lead` function supports server automations. See [Integrations setup and verification](docs/INTEGRATIONS.md) for its migration/deployment, administrator credential provisioning and rotation, platform guides, and limitations. Native automation OAuth and CRM sync are not implemented.

Start with [docs/M3-SETUP.md](docs/M3-SETUP.md): destination account, migration, Turnstile keys, Resend verified sender/recipient, server secrets, function deployment, embedding, retry worker, operational inspection, and live verification. No provider secrets are bundled and no external email was sent during implementation.

M3 verification on 18 October 2026: build, lint, Edge TypeScript checks, M2 database tests against both migrations, and M3 handler/database tests passed. Nine browser tests passed in development and the same nine passed against production assets. Desktop and 360px public-form screenshots were visually inspected. Provider transport was simulated; hosted deployment, real Turnstile validation, scheduled retries, and external inbox delivery remain unverified.

## Integrations Hub verification — 18 October 2026

Build, lint, Edge TypeScript, M2 database, M3 handler/database, and Integrations handler/database checks passed. All 12 browser tests passed in development and all 12 passed against production assets; the production run also checked the embedded form preview. Desktop, tablet, and mobile directory layouts plus the mobile installation guide were inspected. Tests cover scoped metadata/receipts, revocation/rotation, duplicate prevention, quota enforcement, separate workspace notification destinations, and retaining leads during delivery failure.

Provider transport and hosted Auth/API transport were simulated. The new migration/function have not been deployed by this implementation, and real automation execution, CAPTCHA validation, and external inbox delivery remain unverified. Follow [Integrations setup](docs/INTEGRATIONS.md) before enabling live intake.

## Manual integration walkthroughs

See [the manual test guide](docs/INTEGRATIONS-MANUAL-TESTS.md) for steps covering all 13 cards, prerequisites, expected results, and the 19 October live hosted-form check. `node scripts/check-live-integrations.mjs` repeats six malformed/anonymous live endpoint checks without creating valid inquiries or printing secrets. Successful external automation execution and actual inbox delivery are tracked separately from local simulation and provider acceptance.
