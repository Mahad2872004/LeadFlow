# LeadFlow — M2

LeadFlow is a React + TypeScript + Vite dashboard backed by Supabase PostgreSQL and Supabase Auth. It uses the Supabase Data API and database functions directly; no Express server, paid messaging service, or CRM integration is needed.

## Set up a Supabase project

1. Create a Supabase project. In Authentication, disable public signup and anonymous sign-ins. Create an internal user with an email/password and confirmed email in the dashboard. Each account has its own isolated workspace; accounts do not share leads.
2. Apply `supabase/migrations/202610180001_m2.sql` using the Supabase SQL editor, once, in a new project. Alternatively install the Supabase CLI, run `supabase init` if no CLI config exists, `supabase login`, `supabase link --project-ref YOUR_PROJECT_REF`, then `supabase db push`. Review the target project before applying migrations.
3. Copy `.env.example` to `.env.local`. Set `VITE_SUPABASE_URL` to the project URL and `VITE_SUPABASE_PUBLISHABLE_KEY` to its publishable key (a legacy **anon** key also works). These values are included in the browser bundle. **Never put a service-role key, secret key, database password, or privileged token in any VITE variable.** Local environment files are ignored by Git.
4. Use Node.js 22.12+ and run `npm install`, then `npm run dev`. Sign in with the internal account. Missing configuration shows setup instructions instead of silently falling back to browser persistence.
5. The first database workspace is empty. Add a lead, explicitly import saved browser data, or confirm **Reset demo data** to load the eight fictional M1 leads and their tasks/history.

For local Supabase development, install Docker and the Supabase CLI, then run `supabase init`, `supabase start`, and `supabase db reset` in a disposable local project. `db reset` destroys the local database. Use the URL and anon/publishable key reported by the CLI in `.env.local`, and create a confirmed test account through the local Studio. The migration has no hosted-only dependencies. The CLI and Docker are not bundled with this repository.

## Persistence and access model

- `leads`, `follow_up_tasks`, and `activity_history` use composite owner/record keys. Foreign keys prevent orphan records or cross-owner links. Checks enforce required fields, allowed statuses/sources/services, email/phone lengths and formats, calendar dates, finite timestamps, and note/message lengths. Indexes cover status/source, creation time, due dates, and lead history.
- All five exposed tables (including `workspaces` and `workspace_requests`) have RLS enabled. Authenticated accounts can select only their own rows. Anonymous callers have no table privileges or RPC access. Direct insert/update/delete is revoked even for authenticated users.
- `load_workspace` and `save_workspace` are narrowly scoped security-definer functions with an empty search path. They derive the owner exclusively from `auth.uid()`, reject absent identities and anonymous Auth sessions, and explicitly filter every read/write by owner. No client-supplied owner is accepted. Do not remove those checks: definer functions bypass RLS. Function execution is revoked from PUBLIC and anon, then granted to authenticated.
- Each save atomically replaces the caller's three related collections, advances a revision, and records a request receipt. A locked workspace row serializes concurrent saves. Old revisions fail instead of overwriting newer edits. Retrying the same request ID and payload returns its original revision without repeating writes; using that ID with different data fails. Identical email addresses are allowed because separate inquiries can be legitimate.
- The UI only displays saved changes and success after the database acknowledges them. On failure, the intended snapshot and request ID remain in memory for **Retry saving**. **Reload workspace and discard attempt** explicitly abandons that attempt and fetches current server data. A browser refresh loses an unacknowledged in-memory draft, but any committed database changes remain. Refresh also retrieves edits from other sessions; no Realtime subscription is used.
- Supabase Auth manages its session tokens in browser storage. Leads/tasks/history are never automatically written to localStorage. Sign-out or an account change unmounts private workspace state.

This intentionally simple snapshot protocol is for small internal workspaces: maximum 5 MB per save, 5,000 leads, 10,000 tasks, and 20,000 history items. It is not a paginated large CRM. Activity history preserves M1 user-facing events and imports; it is **not an immutable security audit log**. Request receipts are retained for safe retries and grow with writes. No automatic deletion/retention job is installed.

The security approach follows Supabase's [RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security) and [database-function guidance](https://supabase.com/docs/guides/database/functions).

## Preserve and import M1 data

M1 used `leadflow.demo.v1` in localStorage. M2 never changes or deletes that key. Open M2 on the **same browser and origin/port** used for M1 to see **Import browser data** when the database workspace is empty. Confirming copies validated leads, follow-ups, IDs, timestamps, and history in one transaction. A changed server revision rejects the import safely. Existing database records are never automatically merged or replaced by import.

Invalid browser data produces an explicit message and remains untouched. If moving to another origin, export that key from the original browser first; this release has no file-upload import UI. Reset asks for confirmation and replaces only the signed-in account's database data with fictional samples; it cannot undo prior edits. It does not erase the M1 browser backup or another account's records.

## M1 workflows retained

Overview metrics and pipeline shortcuts, lead creation/full editing, search and combined filters, all five statuses, lead details, follow-up scheduling/completion/reopening, local-calendar due indicators, history, responsive layouts, and simulated notifications remain. Follow-up dates stay `YYYY-MM-DD`; past dates are permitted. The shared day hook updates due states at midnight and on tab return. Notifications are session-only; no messages are sent. Reset is a transactional database operation. Individual lead deletion was not an M1 UI feature; removing records is supported by the database snapshot operation and tested through reset.

There was no public inquiry page in M1. M2's capture form is **private and authenticated**. No public ingestion endpoint or Edge Function is exposed, so anonymous visitors cannot use dashboard CRUD. If public inquiries are added later, implement a separate Edge Function with server-side validation, CAPTCHA/rate limiting, an explicit destination workspace, and idempotency; never relax these RLS policies to enable a public form.

## Run checks

```powershell
npm run build
npm run lint
npm run test:db
npm test
npm run test:production
```

Browser tests use installed Microsoft Edge. To use Chromium instead, change the channel in `playwright.config.ts` and install it using `npx playwright install chromium`.

`test:db` executes the actual migration in embedded PostgreSQL (PGlite), with test implementations of `auth.uid()`/`auth.jwt()`. It exercises constraints, transactions, CRUD/reset, follow-ups, duplicate requests, conflicts, grants, and RLS under anon and two authenticated identities. This is actual SQL execution, not a mocked database.

`tests/m2.spec.ts` drives the real UI and Supabase JS client against that migration in PGlite. Only the Auth service and HTTP transport are simulated. It covers login/logout, empty workspace, sample reset/cancel, CRUD/filtering, follow-ups/history, refresh and new-login persistence, explicit legacy import, lost-response retries, conflict recovery, load failure, and mobile layout. Test configuration uses a fake key and loopback URL; it never connects to your real project. Production tests build using `.env.test` before preview. Run `npm run build` again before deployment to replace that test build with your configured production build.

The original four M1 test files remain as historical regression references, but are excluded from the M2 test command: their direct localStorage writes and automatic demo seeding assumptions are obsolete. M2 test results must not be described as passing the old 23-test suite.

## Required live-project verification before release

Embedded tests do not verify Supabase's hosted Auth, JWT verification, PostgREST deployment, network configuration, or your actual project policies. After applying the migration to a disposable Supabase project:

1. Create two confirmed internal accounts A and B, disable signup and anonymous login, and sign in as A. Import or create data, edit contact/status, schedule and complete/reopen a task, then reload and restart Vite. Verify the same records and history remain.
2. Sign out. The dashboard must be inaccessible. Sign in as B; no A records should be visible. Create B data and reset A; B data must remain.
3. Using the project's public key with no user bearer token, call REST endpoints for every table and both RPCs. Expect permission errors and no data. With A's user token, table selects must expose only A rows; direct inserts/updates/deletes must fail. Repeat using B's token and A record IDs.
4. Open A in two tabs. Save in tab 1 and attempt an edit in stale tab 2. Expect a conflict and explicit reload recovery. Use network tooling to repeat the exact `save_workspace` payload/request ID; verify one revision advance and no duplicate lead/history. Reuse that ID with changed data; expect rejection.
5. Disconnect the network while saving. No false success should appear. Reconnect and retry; verify saved data after reload. Verify invalid inputs and orphan relationships are rejected through the API, not just in the UI.

No live Supabase project was configured during implementation. Deployment and the live checks above are required to complete the hosted definition of done.

## Main implementation files

- `src/lib/backend.ts`, `src/lib/supabase.ts`: configured client and RPC persistence.
- `src/components/AuthGate.tsx`: internal email/password sign-in and session changes.
- `src/App.tsx`: asynchronous workspace workflows, import, retry, conflict recovery.
- `src/lib/model.ts`, `dates.ts`, `seed.ts`: retained M1 domain operations, dates, and fictional records.
- `src/lib/storage.ts`: retained legacy validator/helpers; automatic storage persistence is no longer used by the application.
- `supabase/migrations/202610180001_m2.sql`: schema, indexes, RLS, grants, transactional functions.
- `scripts/test-db.mjs`, `tests/m2.spec.ts`: database and browser verification.

## Verification performed — 18 October 2026

- TypeScript/production build and lint passed.
- Actual migration checks passed in PGlite, including reloading a saved database image in a new engine, validation/rollback, access grants, owner isolation, and retry/conflict behavior.
- Five M2 browser tests passed against Vite development; the same five passed against built production assets.
- Supabase Auth and HTTP transport were simulated in browser tests. Hosted Auth/API/RLS deployment and real project restart persistence remain unverified.
