# Client onboarding and campaign readiness (M6A)

Added 25 October 2026 at the owner's request. **Status: implemented and verified locally only.** Nothing has been applied to the hosted Supabase project or deployed. The verification gates in [the agency onboarding research](AGENCY-ONBOARDING-RESEARCH.md#12-validation-plan-and-go-no-go-gates-no-interviews-required-to-start) are still open. This milestone is a build, not evidence of demand.

- Migration: [`supabase/migrations/202610250001_client_onboarding.sql`](../supabase/migrations/202610250001_client_onboarding.sql)
- Rollback: [`supabase/rollbacks/202610250001_client_onboarding.down.sql`](../supabase/rollbacks/202610250001_client_onboarding.down.sql)
- Edge Functions:
  - [`client-portal`](../supabase/functions/client-portal/handler.ts): the client's checklist.
  - [`onboarding-reminders`](../supabase/functions/onboarding-reminders/handler.ts): the scheduled reminder worker.
- UI:
  - [`ClientOnboarding.tsx`](../src/components/ClientOnboarding.tsx): dashboard and request list.
  - [`OnboardingRequest.tsx`](../src/components/OnboardingRequest.tsx): one request.
  - [`OnboardingTemplates.tsx`](../src/components/OnboardingTemplates.tsx): templates.
  - [`ClientPortal.tsx`](../src/components/ClientPortal.tsx): the page clients open at `/client-portal`.
- Tests:
  - [`scripts/test-onboarding.mjs`](../scripts/test-onboarding.mjs) (`npm run test:onboarding`).
  - [`tests/onboarding.spec.ts`](../tests/onboarding.spec.ts).

## What it does

**For the agency** (the **Onboarding** item in the dashboard sidebar):
1. **Templates.**
   - Owners and admins add the four starter templates (paid advertising, SEO, social media management, email marketing), edit them, create their own, or archive them.
   - Each item has a section, title, client guidance, a response type and a required/optional flag. The response types are written answer, choose an option, asset links, and account access.
   - Starter items cover the common business, brand and approval requirements, then the service-specific ones.
2. **Start an onboarding.**
   - Any member can start one from a template or a blank checklist. They can also start it from a lead (**Start client onboarding** in the lead's details), which prefills the client and links the lead.
   - The request records the project, client and contact, service, owner, start date, target kickoff and client-inputs due date.
   - The template's items are **copied**: editing them for this client never changes the template, and editing the template never changes existing requests.
3. **Customise and open.**
   - A new request is a draft. Add, edit, remove (until the client answers) or mark items not required; set per-item due dates and agency-only notes.
   - **Open to client** makes it answerable.
4. **Share a link.**
   - **Create client link** shows a private link once. The agency sends it however they like; LeadFlow does not email it.
   - **Replace link** revokes earlier links. **Revoke** stops a link immediately.
5. **Review.**
   - For each submission: **Accept** (**Confirm access works** for access items), **Request changes** with a message the client sees, or **Mark not required** with an agency-only reason. Not-required items can be restored.
   - An item the client hasn't submitted can be accepted only with an explanation, for example "we already have admin access".
6. **Readiness and handoff.** The request page explains readiness and lists every required item that blocks delivery, and whether it waits on the client or on the agency. When nothing blocks, **Confirm readiness and hand off** records a handoff and closes the checklist.
7. **Pause, resume and cancel.**
   - Any member can pause or resume a request. Owners and admins can cancel it.
   - Pausing stops client edits and reminders.
   - Cancelling keeps the client's responses and shows the client that the onboarding is closed.

The dashboard shows:
- **Metrics:** requests in progress, requests waiting on the client, items to review, overdue items, and requests ready for handoff.
- **A list** with search and filters (status, service, owner, due date), and each request's progress, outstanding, review and overdue counts, owner, target kickoff and next action.
- **A timeline per request** of submissions, reviews, link changes, reminders and status changes.

**For the client** (`/client-portal#<token>`, no account needed):
- **What they see:**
  - the agency's instructions, progress and the next step;
  - the items by section, with a form for each type;
  - accepted items locked, and feedback on items sent back.
- **What they can do:** save drafts and come back later, submit and resubmit.
- **Banners** explain when the checklist isn't open yet, is paused, has been closed, or the agency has confirmed readiness.
- **Safety:** every page tells the client never to send passwords, API keys or recovery codes, and access items point to each platform's own sharing settings. Links containing a username or password are refused.

## Readiness rules

The database calculates readiness in `leadflow_private.onboarding_readiness`. The UI only displays the result.

- A request is **ready** when it is **open** (active) and every **required** item is either **accepted** or **marked not required** (with a reason) by the agency.
- **Optional items never block.**
- An item the client has submitted, including access they say they have granted, still blocks until a member accepts it. LeadFlow has no integration with ad, analytics or email platforms, so it never claims access is verified; the agency confirms it in the platform.
- Items sent back for changes block again. Accepting an item and later requesting changes makes the request not ready again.
- Drafts, paused, cancelled and handed-off requests are never "ready". The states shown are:
  - Not open yet
  - Waiting on client
  - Needs review
  - Ready for handoff
  - Paused
  - Handed off
  - Cancelled
- The percentage is (accepted + not required) ÷ required items. It is shown next to the full blocker list, never instead of it.
- Each time a request becomes ready, or stops being ready, a `became_ready` or `readiness_lost` event is recorded with its timestamp.

## Handoff and future project management

`hand_off_onboarding` records one row in `leadflow_private.onboarding_handoffs` per request. The row holds:
- who confirmed the handoff, and when;
- an optional note;
- the request version;
- a snapshot of every item, with its final state and accepted response.

Repeating the call returns the same handoff. The request becomes `completed` (shown as "Handed off"), and pending reminders are stopped. Nothing external happens: no campaign, task, email or webhook.

The handoff `id` is the stable link for a later project-management milestone. A future `projects` table can reference `onboarding_handoffs(id)` to carry agreed scope, deliverables, owners, milestones and approvals. No project tables or task management exist yet.

## Security model

**Workspace isolation (agency side)**
- **No client table access.** All eight tables live in `leadflow_private` and have RLS enabled. Clients have no table privileges at all.
- **Role-checked functions.** Signed-in users use 15 security-definer functions with an empty search path. Each one:
  - calls `leadflow_private.require_role` with the selected workspace;
  - locks the workspace row for writes;
  - filters every statement by that workspace.
- **Workspace IDs never authorize.** A request, template or item ID from another workspace gets "not found", and a workspace the caller doesn't belong to gets the standard access-denied error.
- **Roles:**

  | Action | Owner | Admin | Member |
  | --- | :-: | :-: | :-: |
  | View onboarding, templates and timelines | ✓ | ✓ | ✓ |
  | Create, edit, open, pause and resume requests; review items; create and revoke links; hand off | ✓ | ✓ | ✓ |
  | Add starter templates; create, edit and archive templates | ✓ | ✓ | ✗ |
  | Cancel a request | ✓ | ✓ | ✗ |

- **Validated references.** The owner must be a workspace member. A linked lead must exist in the same workspace when it is linked.

**Client links**
- **Token.** `lf_` plus 64 hex characters, made from two server-generated version-4 UUIDs (244 random bits).
- **Stored as a hash only.** Only `SHA-256(token)` is stored, in `onboarding_links.token_hash`. The plain token is returned once to the member who created the link and is never written to the database or the activity history (tested).
- **In the URL fragment** (`#…`). Browsers don't send fragments to servers or in Referer headers.
- **Page protections.**
  - The portal page sets `referrer: no-referrer` and `robots: noindex`, and `vercel.json` sends matching headers.
  - The page loads no third-party resources.
- **Checked on every call.**
  - The `client-portal` Edge Function hashes the token and calls service-role functions (`portal_open`, `portal_save_item`).
  - Those functions check, on every call, that the link exists, isn't revoked and hasn't expired.
  - Unknown, revoked and expired links get the same 404, so links can't be probed.
- **What the link can reach.** Only the request it belongs to. The client view contains no internal notes, waiver reasons, member details, workspace or request IDs, contact email, or other records (tested).
- **What the link can do.** Save or submit responses to items that aren't accepted or marked not required, and only while the request is open.
- **Limits.**
  - Links last 1–90 days (default 30); at most 20 can be active per request.
  - 60 portal requests per minute per link, using the existing durable rate-limit table.
  - The Edge Function only accepts requests from allowed origins. This is browser hygiene, not authorization.
- **Anonymous callers.** They still cannot execute any database function: the portal only works through the Edge Function's service role.

**Concurrency and retries**
- **Request edits and status changes** check `expected_version`. A stale tab gets a conflict; the UI reloads and shows the latest version.
- **Status changes are idempotent.** Repeating a transition that already happened succeeds without changing anything.
- **Reviews check the item revision**, so a newer client submission is never accepted blind.
- **Client saves check the item revision.** An identical retry after a lost response succeeds without changes.
- **Creating requests and templates is idempotent per request ID.** A lost response followed by a retry creates one record (tested in the browser).

## Reminders

**What runs, and when**
- **Settings, per request:**
  - an interval of 2, 3, 5, 7 or 14 days (off by default);
  - a maximum of 1–5 reminders (default 3);
  - the request's contact email as recipient.
- **When one is due.** The database schedules a reminder only while every one of these holds:
  - the request is open;
  - a recipient is set;
  - at least one **required** item is waiting on the client (not started or changes requested);
  - an unrevoked client link expires more than an hour from now;
  - the maximum hasn't been reached.

  Items waiting for agency review, and accepted or not-required items, never cause reminders.
- **When it is sent.** The first reminder is due one interval after the conditions are met. Resuming a request restarts the interval rather than sending immediately.
- **What it contains.** The email lists only the outstanding required items. It carries its own private link, with its own hashed token that expires no later than the shared link.

**Safety and history**
- **Idempotent.** Reminder rows are unique per `(request, sequence)`. A retry reuses the exact email body and the provider idempotency key `leadflow-onboarding/<reminder id>`.
- **Leases and backoff, as for inquiry emails.**
  - Leases last 2 minutes, and only the current lease holder can record an outcome.
  - Backoff is exponential, capped at one hour.
  - 4xx refusals are permanent.
  - After 23 hours an unknown outcome becomes `uncertain` and is not resent.
- **Stopping rules.**
  - Every claim and every retry rechecks all the conditions above.
  - Pausing, cancelling, handing off, replacing or revoking links, or resolving the outstanding items stops queued reminders.
  - If the provider had already accepted an email when the request stopped, it is recorded as accepted, because it may have been delivered.
- **Token clean-up.** The composed email, which contains a token, is kept only until the outcome is final, then cleared. A refused reminder's link is revoked.
- **History.** Each request shows reminders used, the next reminder time or why none is scheduled, and the outcome of each reminder. Reminder events appear in the timeline.

### Reminder scheduler

Configured on the hosted project on 25 October 2026 with Supabase Cron, from [`supabase/ops/schedule-workers.sql`](../supabase/ops/schedule-workers.sql). That file is kept outside `migrations/` because the local tests have no `pg_cron`. It sets up:
- **Extensions:** `pg_cron` and `pg_net`.
- **`leadflow-onboarding-reminders`:** every 15 minutes.
- **`leadflow-retry-notifications`:** at minutes 7, 22, 37 and 52, so the inquiry-email retry worker the M3 docs asked for now runs too.

How the jobs authenticate:
- Each job POSTs to its Edge Function with an `x-worker-secret` header.
- The header value comes from the Vault secret `leadflow_worker_secret`. The repository holds no secret.

**Cost.** At this frequency the two jobs make about 5,800 Edge Function invocations a month. Invocation quotas are organization-wide: 500,000 a month on Free, 2 million on Pro, then $2 per million. pg_cron and pg_net carry no separate charge that we found.

**Secret rotation (25 October).** The previous `NOTIFICATION_WORKER_SECRET` couldn't be read back from the CLI, so a new random 64-character value was generated. It was set on the Edge Functions and stored in Vault under the same value, without being printed or saved anywhere else. Any external caller still using the old secret now gets 401; none was documented.

To rotate it again, do both steps in one session:
1. `npx supabase secrets set NOTIFICATION_WORKER_SECRET=...`;
2. `select vault.update_secret((select id from vault.secrets where name = 'leadflow_worker_secret'), '...');`.

**Inspect and stop.** The queries for inspecting runs, and the `cron.unschedule` commands to stop the jobs, are at the end of the SQL file.

**Earlier operational prerequisites:**
1. **(Resolved 25 October; see above.)** Before then, no scheduler was installed or configured. `onboarding-reminders` runs only when something POSTs to it with the `x-worker-secret` header. Reminders are **not operational** until a scheduler is set up and verified, for example:
   - Supabase Cron (pg_cron with pg_net) calling the function hourly, with the secret held in Vault;
   - an external cron service.

   Check your plan and any costs before choosing one. The same applies to the existing `retry-notifications` worker.
2. **Secrets** on the functions:
   - `PORTAL_URL`, for example `https://YOUR_DOMAIN/client-portal`;
   - the existing `RESEND_API_KEY`, `NOTIFICATION_FROM` (a verified sender) and `NOTIFICATION_WORKER_SECRET`.

   Without them, the worker returns 503 and claims nothing, so no reminder is used up.
3. **Delivery and bounce tracking don't exist.** "Accepted by the email provider" is not a delivery confirmation.

## Compatibility with leads and snapshots

**Saving and resetting leads leaves onboarding untouched.**
- Requests store the linked lead's ID, with no foreign key.
- `save_workspace_for` deletes and reinserts every lead, and reset replaces them. Neither touches onboarding records (tested).
- If the linked lead disappears, the request says so ("Linked lead no longer exists") and keeps its own copy of the client and contact details.

**Deleting a workspace** (operator only) removes its onboarding data and nothing else.

**What is unchanged:**
- the snapshot format and the `load_workspace`/`save_workspace` functions;
- imports and inquiry intake;
- every existing grant. The only change to an existing check is that the exact allowlist of signed-in functions in `test:tenancy` gains the 15 new functions.

**Shared code changes.**
- The email-sending code in `_shared/runtime.ts` and the worker-secret check (now `_shared/worker.ts`) were factored out for reuse; their behaviour is unchanged (`test:m3` covers it).
- `RpcError` now also carries the database's message, which the portal shows for validation errors.

## Hosted rollout (25 October 2026)

Project `fzgxpwmqzmvgmijviaar`, Supabase CLI 2.122.0.

**Done:**
1. **Migration history: already complete.** The CLI history already listed `202610200002` and `202610200003`, so no repair was needed.
2. **Pre-flight schema check.**
   - A read-only catalog fingerprint of the hosted schema (tables, columns, constraints, indexes, policies, triggers, function bodies and grants) matched the six earlier migration files exactly.
   - The only difference: the 10 functions from `0002`/`0003` were stored with CRLF line endings. Their text is otherwise identical.
3. **Backup.** All 13 LeadFlow tables, every function definition and the catalog fingerprint were exported as JSON to `E:\LeadFlow\backups\2026-10-25-pre-client-onboarding\`, outside the repo. The export contains personal data.
4. **Migration applied.** `db push --dry-run` listed only `202610250001_client_onboarding.sql`, and `db push` then applied it.
5. **Verified after applying:**
   - all seven migrations are in the history;
   - the hosted catalog matches the seven files, apart from the same line endings: 604 entries, including grants and RLS;
   - row counts are unchanged;
   - every table has RLS, and `anon` can execute no function;
   - REST calls with only the publishable key to `onboarding_overview_for`, `portal_open` and `claim_onboarding_reminder` return 401.
6. **Secrets set:** `PORTAL_URL=https://leadflow-tau-five.vercel.app/client-portal` and `PORTAL_ALLOWED_ORIGINS=https://leadflow-tau-five.vercel.app`.
7. **Functions deployed:** `client-portal` v1 and `onboarding-reminders` v1, both with gateway JWT verification off. Live smoke tests, which created no records:
   - a preflight from the site returns 204, with the CORS origin limited to the site and `Referrer-Policy: no-referrer`;
   - another origin gets 403;
   - malformed and unknown tokens both get the same 404;
   - the worker returns 401 without the secret or with a wrong one.

   `retry-notifications` was not redeployed: its refactor doesn't change its behaviour.

**Not done:**
- **Frontend.** The GitHub repository has no Vercel deployments, so pushes don't deploy; the site was deployed another way. Deploying needs a Vercel login on this machine.
- **Scheduler.** Not configured.
- **End-to-end checks.** No end-to-end hosted onboarding has been run, and no reminder email has been sent.

## Deploying (reference; steps 1–4 were done on 25 October, see above)

1. **Check the CLI migration history.** [The research audit](AGENCY-ONBOARDING-RESEARCH.md#2-repository-findings-and-verified-current-capabilities) reports that `202610200002` and `202610200003` are live but missing from the history.
   - Confirm the catalog matches, then run `npx supabase migration repair --status applied 202610200002 202610200003 --linked`.
   - Then `npx supabase db push --linked --dry-run` must list only `202610250001_client_onboarding.sql`.
2. **Back up, then apply.** Take a private backup, then run `npx supabase db push --linked`. The migration is additive; the rollback drops only onboarding objects.
3. **Set the secrets:**
   - `npx supabase secrets set PORTAL_URL=https://YOUR_DOMAIN/client-portal`;
   - optionally `PORTAL_ALLOWED_ORIGINS=https://YOUR_DOMAIN`. Without it, the function falls back to `INQUIRY_ALLOWED_ORIGINS`.
4. **Deploy the functions:**
   - `npx supabase functions deploy client-portal`;
   - `npx supabase functions deploy onboarding-reminders`;
   - `npx supabase functions deploy retry-notifications`. Optional: its code was refactored, but its behaviour is unchanged.
5. **Deploy the frontend**, including the `vercel.json` headers.
6. **Optionally configure a scheduler** for the reminder worker, and verify it end to end with a disposable request and an inbox you control.

**Hosted checks still required** (disposable records, two accounts):
- a member of workspace A cannot load, change, link or hand off workspace B's requests through the REST API;
- revoked and expired links return 404 from the deployed function;
- the anonymous key alone cannot call any onboarding function;
- a reminder arrives once, carries a working link, and stops after pause or acceptance;
- scheduler failures and retries are visible.

## Verification performed (local, 25 October 2026)

| Check | Result | What ran |
| --- | --- | --- |
| `npm run test:onboarding` | Passed | Real migration SQL in PGlite (PostgreSQL 18), plus the real `client-portal` and `onboarding-reminders` handlers. The email provider was simulated. |
| Mutation check | 4/4 caught | Leaking internal notes to the client, skipping the expiry check, counting submitted items as resolved, and scheduling reminders with nothing outstanding each made `test:onboarding` fail. |
| `tests/onboarding.spec.ts` | 3/3 passed | The real UI and portal in Microsoft Edge. Auth and HTTP transport simulated; every RPC ran the real SQL. |
| Existing suites | See the [roadmap](../DEVELOPMENT_ROADMAP.md#current-verification-ledger) | Lint, Edge TypeScript, `test:db`, `test:m3`, `test:integrations`, `test:tenancy`, build, the full browser suite in development, and the production build. |

`test:onboarding` covers:
- exact client grants;
- templates, idempotent installation, and copies that stay independent of their template;
- workspace isolation, including another workspace's request, item, template and lead IDs;
- the lifecycle and version conflicts;
- link hashing, scope, replacement, revocation and expiry, and fields hidden from the client;
- drafts, submissions, validation (bad links, credentials in links, access not confirmed) and idempotent retries;
- review, resubmission, readiness transitions and optional items;
- the single handoff;
- reminders: scheduling, idempotency, retries, the maximum, leases, cancellation races, permanent failure, the uncertain window, and every stopping rule;
- snapshot save and reset compatibility, membership removal, workspace deletion, and rollback with re-apply.

The browser tests cover:
- the full agency-to-client journey (template editor, start from a lead, customisation, internal notes hidden from the client, saved drafts, validation, changes requested and resubmission, readiness, handoff, client confirmation, filters);
- invalid, unknown, paused, revoked, expired and cancelled links;
- phone, 700px and 1024px layouts without horizontal scrolling;
- member restrictions, a lost create response, a stale-version conflict, workspace isolation and membership removal.

**Not verified:**
- anything hosted: Auth, PostgREST, Edge Functions, secrets, Vercel headers;
- real Resend sending;
- any scheduler;
- concurrent lock contention between the reminder worker and a member (PGlite is single-connection);
- behaviour under load.

## Limitations

- **No scheduler,** so no automatic reminders until one is configured and verified.
- **The client link is shown once.** If it's lost, replace it. LeadFlow doesn't email the first link.
- **No file uploads:** external links only. LeadFlow doesn't fetch or check them, and the agency must open them.
- **No platform integrations.** Access is confirmed by a person, never verified by LeadFlow.
- **One contact email per request,** and the sender is deployment-wide (`NOTIFICATION_FROM`). There is no per-agency domain.
- **No team invitations** (as before), no internal task assignment per item, no escalation emails, and no Realtime updates: use **Check for updates**.
- **The activity timeline is append-only through the API,** but operators can change it in SQL. It is not a certified audit log.
- **No retention or deletion job** for onboarding data, which includes client-provided business information.
