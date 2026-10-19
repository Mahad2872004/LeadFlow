# Multi-tenant workspace foundation

Added 20 October 2026. The foundation (`202610200001`) was applied to the hosted LeadFlow project on 20 October 2026; see [hosted application](#hosted-application-20-october-2026).

The onboarding and workspace-management UI and its migration (`202610200002`) were added the same day and are **local only** so far; see [onboarding and workspace management](#onboarding-and-workspace-management). The hosted two-account checks and the manual dashboard and inquiry checks are still outstanding.

- Migration: [`supabase/migrations/202610200001_multi_tenant_foundation.sql`](../supabase/migrations/202610200001_multi_tenant_foundation.sql)
- Rollback: [`supabase/rollbacks/202610200001_multi_tenant_foundation.down.sql`](../supabase/rollbacks/202610200001_multi_tenant_foundation.down.sql)
- Security tests: [`scripts/test-tenancy.mjs`](../scripts/test-tenancy.mjs) (`npm run test:tenancy`)

## Audit findings that shaped the change

- **M2–M3 model.** Each Auth user had one `workspaces` row (`owner_id` was the primary key). Leads, follow-ups, history, save receipts, inquiry receipts and integration credentials were all keyed by `owner_id`. RLS allowed select-only access to your own rows. All writes went through security-definer RPCs that read the owner from `auth.uid()`. There were no profiles, memberships, roles or settings.
- **Draft migration `202610190001_workspace_foundation.sql` was unsafe and is superseded.** It is moved, unchanged, to `supabase/superseded/`. Running it in embedded PostgreSQL showed two problems:
  - It breaks `load_workspace`, `integration_overview` and the deployed `receive_inquiry`, because it renames `owner_id` while those functions still use it.
  - It leaves `receive_inquiry_for_workspace` executable by anonymous callers. Anyone could write leads into any workspace and queue email with a sender, recipient and text of their choosing.
  
  The draft has no `commit`, no client grants for its new functions, and no tests or docs reference it.
- **Earlier test harness gap.** It did not emulate Supabase's default grants to `anon`/`authenticated` on new public tables, so a forgotten `revoke` would have passed. The shared harness ([`tests/support/database.ts`](../tests/support/database.ts)) now emulates those grants, and every database and browser test uses it.

## Schema changes

Existing rows are not rewritten or reassigned. Each M2 workspace keeps its UUID, which is its owner's Auth user ID, so every existing `owner_id` value becomes the same `workspace_id` value. The migration backfills, then aborts the whole transaction if any row count changed or any workspace lacks exactly its owner's membership and settings.

| Table | Change |
| --- | --- |
| `profiles` (new) | `id` → `auth.users` (cascade), `display_name` (≤150, no control characters), timestamps. Backfilled for every Auth user. Users created later get a profile on first use. |
| `workspaces` | `owner_id` renamed to `id` (PK unchanged). New `owner_id` → `profiles` (**restrict**), `name` (1–100), `created_at`, `updated_at`, index on `owner_id`. A personal workspace is created for every Auth user that lacked one. |
| `workspace_memberships` (new) | PK `(workspace_id, user_id)`; `role` ∈ `owner`/`admin`/`member`; cascade from workspace and profile; a unique partial index allows only one `owner` row per workspace. Backfilled with one owner row per workspace. |
| `workspace_settings` (new) | One row per workspace, `timezone` (IANA name, default `UTC`), timestamps. |
| `leads`, `follow_up_tasks`, `activity_history` | `owner_id` renamed to `workspace_id`. Existing composite keys and foreign keys keep tasks and history inside their lead's workspace. |
| `workspace_requests` | `owner_id` renamed to `workspace_id`. Adds `actor_id` (who saved; earlier saves are attributed to the owner) and `created_at` (earlier receipts get the migration time). |
| `leadflow_private.inquiries`, `integration_keys` | `owner_id` renamed to `workspace_id`, with a foreign key to `workspaces` (cascade). Queued notifications belong to a workspace through their inquiry. `request_limits` remains global abuse throttling. |

Integrity rules:
- New workspaces always get their owner membership and settings (trigger).
- At commit, `workspaces.owner_id` must hold the workspace's only `owner` membership (deferred constraint trigger plus the unique index). This also applies to operator SQL.
- Lead-related tables get no server timestamps: the snapshot save deletes and reinserts them, so such timestamps would only record the last save.

**Deletion behaviour:**
- Deleting an Auth user who owns any workspace, including their personal one, **fails**. Shared data is never deleted as a side effect.
- Deleting a member's account removes only their memberships.
- Deleting a workspace (operator only) removes its leads, follow-ups, history, receipts, queued notifications, credentials, memberships and settings, and nothing else.

## Roles and permissions

| Action | Owner | Admin | Member | Not a member |
| --- | :-: | :-: | :-: | :-: |
| Read workspace, leads, follow-ups, history, settings, member list, teammates' display names | ✓ | ✓ | ✓ | ✗ |
| Add and update leads, follow-ups and history | ✓ | ✓ | ✓ | ✗ |
| Remove leads or follow-ups (including reset); change or remove history | ✓ | ✓ | ✗ | ✗ |
| Change the workspace's public form (turn off, re-key, recipient) | ✓ | ✓ | ✗ | ✗ |
| View integration metadata and verify receipts | ✓ | ✓ | ✓ | ✗ |
| Revoke integration credentials, rename workspace, change settings | ✓ | ✓ | ✗ | ✗ |
| Add members, remove members, set a role to `member` | ✓ | ✓ | ✗ | ✗ |
| Grant `admin`, change or remove an admin | ✓ | ✗ | ✗ | ✗ |
| Leave the workspace | ✗ | ✓ | ✓ | — |
| Create a workspace (becomes its owner) | Any signed-in user, at most 25 owned | | | |
| Transfer ownership, delete a workspace, create integration credentials | Operator SQL only | | | |

Nobody can assign the `owner` role, change their own membership, or change ownership through the API.

## RLS and grants

- RLS is enabled on every table in `public` and `leadflow_private`.
- `anon` has no table privileges and cannot execute any LeadFlow function.
- `authenticated` has `SELECT` only, on the eight public tables. Every insert, update and delete goes through the functions below.
- Policies:
  - `workspaces`, `workspace_memberships`, `workspace_settings`, `leads`, `follow_up_tasks`, `activity_history` and `workspace_requests` are readable when `workspace_id` (or `id`) is in `leadflow_private.member_workspace_ids()`.
  - `profiles` are readable for yourself and your current teammates (`visible_profile_ids()`).
- The two policy helpers are security-definer functions in the non-exposed `leadflow_private` schema. They are the only private functions `authenticated` can execute, and they reveal nothing beyond the caller's own memberships.
- Anonymous Auth sessions (`is_anonymous` JWT claim), and tokens whose user no longer exists in `auth.users`, are rejected by every function and see no rows.
- Every security-definer function sets `search_path = ''`.
- Each function checks the caller's membership and role on every call. A workspace ID supplied by the browser only selects a workspace; it never authorizes anything. Unknown workspaces and workspaces you don't belong to return the same error, so workspace IDs cannot be probed.
- Writes lock the workspace row before checking membership, so a removal and a concurrent save are serialized.

## Database functions

| Function | Who | Notes |
| --- | --- | --- |
| `load_workspace_for(ws)`, `save_workspace_for(ws, payload, expected_revision, request_id)` | Any member | Same snapshot, revision-conflict and idempotency rules as M2. Saves record `actor_id`. |
| `load_workspace()`, `save_workspace(...)`, `integration_overview()`, `verify_integration_receipt(id)`, `revoke_integration(id)` | Signed-in user | Unchanged signatures, now running on the caller's personal workspace. The current dashboard uses these. |
| `integration_overview_for(ws)`, `verify_integration_receipt_for(ws, id)` | Any member | Metadata only; no token hashes or recipients. |
| `revoke_integration_for(ws, id)` | Owner, admin | Returns `false` if the credential is not an active credential of that workspace. |
| `list_workspaces()` | Signed-in user | Your memberships with role, revision, business type and time zone. Since `202610200002` it no longer creates a workspace. |
| `create_workspace(name, business_type, request_id)` | Signed-in user | Caller becomes owner. Repeating a `request_id` with the same details returns the same workspace; different details are refused. |
| `update_workspace(ws, name, timezone, business_type)` | Owner, admin | `null` leaves a field unchanged; an empty business type clears it. |
| `list_workspace_members(ws)` | Any member | Members' names, emails, roles and join dates. |
| `set_workspace_member(ws, user, role)`, `remove_workspace_member(ws, user)` | Owner, admin | Role rules as in the table above. New members are identified by Auth user UUID. At most 100 members. |
| `leave_workspace(ws)`, `update_profile(name)` | Members / signed-in user | |
| `receive_workspace_inquiry(ws, …)` | `service_role` only | Intake for the deployment-wide `/inquiry` link. The workspace comes from server configuration. |
| `receive_form_inquiry(form_key, …)` | `service_role` only | Intake through a workspace's own form link. The database maps the key to its workspace and notification recipient. |
| `inquiry_form_for(ws)`, `update_inquiry_form(ws, enabled, recipient, new_key)` | Any member / owner, admin | The workspace's form key, state and recipient. |
| `receive_inquiry(owner, …)`, `receive_webhook(…)` | `service_role` only | `receive_inquiry` is kept for Edge Functions deployed before this change. Webhooks derive the workspace from the credential. |
| `leadflow_private.transfer_workspace_ownership(ws, new_owner)` | Operator SQL only | The new owner must already be a member. The previous owner becomes an admin. |

Front end: [`src/lib/backend.ts`](../src/lib/backend.ts) wraps these functions. The dashboard calls the `*_for` versions with the selected workspace's ID.

## Public intake

- The public form is separate from dashboard access. It keeps Turnstile, the origin allowlist, honeypot, size limits and durable quotas, and it calls only service-role functions.
- `submit-inquiry` now reads `WEBSITE_WORKSPACE_ID`. It falls back to `WEBSITE_OWNER_ID`, which holds the same value for a personal workspace. Existing deployments keep working without changes.
- Quotas and replay detection are per workspace. Earlier submission IDs remain idempotent because the fingerprint is unchanged for personal workspaces.

## Migration runbook

### Pre-flight

1. In the SQL editor, run `select version from supabase_migrations.schema_migrations order by version;`. Expect exactly `202610180001`, `202610180002` and `202610180003`.
   - If `202610190001` is listed, **stop**. The superseded draft was applied, and this migration will fail at its first rename. That project needs a reviewed repair migration instead.
   - If the table is missing or empty, the earlier migrations were applied by hand. Compare the live catalog against the three files first; the hosted LeadFlow project was in this state. If they match, run `npx supabase migration repair --status applied 202610180001 202610180002 202610180003 --linked`, which changes history only. Otherwise `db push` would try to re-run them.
2. Take a backup you can restore, for example `npx supabase db dump -f schema.sql` and `npx supabase db dump --data-only -f data.sql`. Store them privately; the data dump contains personal data.
3. Try it on a disposable or branch project first if you have one.

### Apply

- **CLI:** run `npx supabase link --project-ref YOUR_PROJECT_REF`, then `npx supabase db push --dry-run`. It should list only `202610200001_multi_tenant_foundation.sql`. Then run `npx supabase db push`. The CLI runs the file and its history record in one transaction.
- **SQL editor:** paste the whole file and run it once. It must run as a single statement batch: its row-count check uses a temporary table that only exists inside one transaction.

Any failed check rolls back everything. The tables are small and are locked only briefly.

### Verify

```sql
-- Every workspace is a personal workspace with exactly its owner as member (immediately after migrating).
select count(*) as workspaces, count(*) filter (where id = owner_id) as personal from public.workspaces;
select role, count(*) from public.workspace_memberships group by role;
-- RLS everywhere: expect no rows.
select c.oid::regclass from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public','leadflow_private') and c.relkind = 'r' and not c.relrowsecurity;
-- Nothing LeadFlow owns is executable by anon: expect no rows.
select p.oid::regprocedure from pg_proc p
where p.pronamespace in ('public'::regnamespace, 'leadflow_private'::regnamespace)
  and has_function_privilege('anon', p.oid, 'EXECUTE');
```

Then sign in to the dashboard and confirm that leads, follow-ups, history and integration metadata look as before. Submit one fictional `/inquiry`, confirm it appears after **Refresh**, and verify its reference in Integrations.

### Edge Functions (optional)

The deployed functions keep working unchanged. To route the public form to a specific workspace, set `WEBSITE_WORKSPACE_ID` and redeploy, after the migration has been applied: `npx supabase secrets set WEBSITE_WORKSPACE_ID=...`, then `npx supabase functions deploy submit-inquiry`. The new handler calls `receive_workspace_inquiry`, which exists only after the migration.

### Rollback

- The rollback refuses to run if any non-personal workspace, non-owner membership or ownership transfer exists. Export and deliberately remove those first.
- It drops profiles, workspace names and settings, and receipt `actor_id`/`created_at`. Personal workspaces and their data are kept.
- If the new `submit-inquiry` was deployed, redeploy the previous version **before** rolling back, because it depends on `receive_workspace_inquiry`.

Steps:
1. Run the rollback file in the SQL editor as one batch.
2. Run `npx supabase migration repair --status reverted 202610200001`.
3. Re-apply the migration later with the normal process.

## Manual Supabase dashboard steps

1. **Authentication:** keep public signup and anonymous sign-ins disabled (unchanged). Anonymous sessions are rejected anyway.
2. **Data API → exposed schemas:** must remain `public` (and `graphql_public`). Never expose `leadflow_private`.
3. **Adding a teammate** (until the UI exists): create or confirm their Auth user, then either:
   - as the owner, call `set_workspace_member` through the API with their user UUID; or
   - as an operator, in the SQL editor:

     ```sql
     insert into public.profiles(id) values ('USER_UUID') on conflict do nothing;
     insert into public.workspace_memberships(workspace_id, user_id, role)
     values ('WORKSPACE_ID', 'USER_UUID', 'member');
     ```
4. **Deleting a user** now fails while they own a workspace. Transfer ownership first, or deliberately delete their workspaces:

   ```sql
   select leadflow_private.transfer_workspace_ownership('WORKSPACE_ID', 'NEW_OWNER_UUID');
   -- or, removing all of that workspace's data:
   delete from public.workspaces where id = 'WORKSPACE_ID';
   ```

   A personal workspace is recreated empty if the user signs in again.
5. **Integration credentials:** provision with `workspace_id` instead of `owner_id` ([INTEGRATIONS.md](INTEGRATIONS.md)).
6. **Hosted security check:** before treating this as released, run the two-account checks below on the real project.

## Verification performed (local, 20 October 2026)

All in embedded PostgreSQL (PGlite) with the migrations exactly as committed. Supabase Auth, PostgREST, JWT verification and hosted grants are emulated, not exercised.

- `npm run test:tenancy` covers:
  - **Migration safety:** a lossless migration of seeded M2/M3 data, with per-workspace row counts, the dashboard snapshot, save-retry and inquiry-retry idempotency all unchanged.
  - **Catalog checks:** RLS on every table; exact allowlists of client table privileges and executable functions; empty `search_path` on definer functions.
  - **Permissions:** the owner/admin/member matrix; non-members using real, guessed and personal workspace IDs against every function, with identical errors and no side effects; non-members reading no rows; escalation attempts.
  - **Closed paths:** direct table writes and private-schema access denied, even for owners; service-only intake denied to clients; anonymous and deleted-user tokens rejected.
  - **Lifecycle:** removal and leaving take effect immediately; ownership invariants enforced at commit, including against operator SQL; deletion behaviour; the rollback refusing shared data, restoring the original schema losslessly, and re-applying.
- I ran three deliberate faults to confirm the suite detects them: leaving the intake function executable by clients, letting `require_role` admit non-members, and an always-true `leads` policy. Each made the suite fail.
- The existing `test:db`, `test:m3` and `test:integrations` suites, and the M2/M3/integrations browser tests, now run against all four migrations. `test:m3` also covers routing the public form by `WEBSITE_WORKSPACE_ID`.

**Not verified:**
- Hosted application of the migration.
- PostgREST/JWT behaviour and exposed-schema configuration.
- Concurrent removal-versus-save timing (row locks are used; PGlite is single-connection).
- Live Edge Function deployment.

Hosted two-account checks, on a disposable project:
1. Sign in as accounts A and B. Each sees only their personal workspace.
2. As A, run `create_workspace` and add B as a member. B can load and save it.
3. With B's token, calls to the `*_for` functions using A's personal workspace ID fail.
4. As a non-member C, every function using the shared workspace ID fails, and REST selects on all eight tables return only C's rows.
5. Calls with the anon key alone fail for every table and function.
6. Removing B immediately blocks B's next load.

## Hosted application (20 October 2026)

Project `fzgxpwmqzmvgmijviaar`, PostgreSQL 17.11, applied with Supabase CLI 2.121.0.

- **Pre-flight.** The hosted migration history was empty: the M2, M3 and integrations migrations had been applied by hand. The draft `202610190001` had never been applied (no `profiles` or membership tables existed). A read-only catalog fingerprint matched the three migration files exactly. The fingerprint covered tables, columns, constraints, indexes, policies, triggers, function signatures and body hashes, and table and function grants. The only differences were NOT NULL catalog rows that the local PostgreSQL 18 test engine records and PostgreSQL 17 does not.
- **Backup.** All LeadFlow table data was exported as JSON with `supabase db query`, because `db dump` needs Docker. It is stored outside the app at `E:\LeadFlow\backups\2026-10-20-pre-multi-tenant\` with the three schema files. It contains contact data, so keep it private.
- **Apply.** The three versions were recorded with `migration repair`. `db push --dry-run` listed only `202610200001`, then `db push` applied it.
- **Verified afterwards** with read-only queries:
  - All four versions are in the history.
  - The one existing account has one personal workspace, one owner membership, a profile and settings.
  - Every table has RLS, and anonymous callers can execute no LeadFlow function.
  - Row counts are unchanged: 2 leads, 2 history events, 2 inquiry receipts, 2 notifications, 1 credential.
  - Every row stayed in its owner's workspace.
  - The full catalog matches the four migration files, apart from the PostgreSQL 18 NOT NULL catalog rows.
  - Anonymous REST calls with the publishable key are denied on the new tables and on `list_workspaces`.
- **Not done.** Edge Functions and secrets were left unchanged (the existing `WEBSITE_OWNER_ID` keeps working). The hosted two-account checks above need a second account. The dashboard sign-in and test-inquiry checks need the account owner.

## Onboarding and workspace management

Added 20 October 2026: [`202610200002_workspace_onboarding.sql`](../supabase/migrations/202610200002_workspace_onboarding.sql), with a [rollback](../supabase/rollbacks/202610200002_workspace_onboarding.down.sql) that must run before the foundation rollback.

**What users get**
- **Sign-up (`/signup`)** follows the project's public Auth settings.
  - When sign-up is closed, the page offers the existing request-access path.
  - When it is open, the page has email, password (at least 8 characters) and confirmation fields.
  - If email confirmation is on, a "check your email" screen follows, with a resend button after a 60-second wait. Confirmation links return to `/app`.
- **Sign-in and route protection.**
  - Sign-in explains unconfirmed addresses and can send a new link.
  - Visiting `/app…` while signed out redirects to `/login?next=…` and returns there after sign-in. `next` accepts only `/app` paths.
  - Sessions are restored on reload, and signing out returns to `/login`.
- **Onboarding.** An account with no workspace is asked for a workspace name and an optional business type. Each attempt carries a request ID, so double submits and lost responses create only one workspace.
  - New accounts no longer get an automatic personal workspace. Existing accounts keep theirs.
- **Workspace switcher** (sidebar):
  - Lists your workspaces with your role in each and can create another.
  - Switching needs no page reload. The dashboard remounts, so every screen reloads that workspace's data.
  - It remembers the last workspace per user in local storage. An ID that isn't in your own list is ignored.
  - Switching is disabled while a save is unresolved.
- **Settings page:**
  - Owners and admins edit name, business type and time zone. Members see them read-only.
  - It shows members with their roles and your own permissions.
  - Invitations are labelled as not available yet.
- **Integrations hub.** It works on the open workspace. Members don't see Revoke, and the database refuses it anyway.

**Database changes**
- `workspace_settings.business_type`, limited to the list in [`workspaceOptions.ts`](../src/lib/workspaceOptions.ts).
- `workspaces.creation_request_id`, unique per owner.
- `list_workspaces()` now returns the business type and time zone, and no longer creates a workspace.
- New signatures for `create_workspace` and `update_workspace`, and a new `list_workspace_members`. All are granted only to `authenticated` and check roles in the database.

**Manual steps**
1. **Apply this migration and `202610200003` before deploying the new frontend,** following [deploy in this order](#workspace-forms-notifications-and-role-limits). The currently deployed frontend keeps working after them, because the old no-argument functions are unchanged.
2. Deploy `submit-inquiry`, then build and deploy the frontend.
3. **Decide whether to open public sign-up.** It is currently disabled on the hosted project, so `/signup` shows the request-access page. To open it:
   - Authentication → Sign In / Providers → allow new users to sign up.
   - URL Configuration: set the Site URL to the production origin. Add `https://YOUR_DOMAIN/app` (and `http://localhost:5173/app` for development) to Redirect URLs.
   - Configure custom SMTP, for example Resend's SMTP. Supabase's built-in email is heavily rate-limited and meant for testing.
   - Set the minimum password length to at least 8 to match the form.
   - **Don't enable Auth CAPTCHA yet.** The forms don't send a CAPTCHA token, so sign-in and sign-up would fail.
   - Set `VITE_PUBLIC_SIGNUP=true` in the frontend's build environment (for example, Vercel environment variables) and redeploy. This switches the marketing copy from "request access / by invitation" to "create an account": the buttons, FAQ, home, pricing, security and guide pages, and the `/signup` page title. Leave it unset while sign-up is closed. The `/signup` page itself always follows the live Auth setting.

**Verification (local).** `npm test` now includes [`tests/workspaces.spec.ts`](../tests/workspaces.spec.ts), and the earlier browser specs go through the same flow. They use [`tests/support/supabase.ts`](../tests/support/supabase.ts):
- Auth HTTP is simulated.
- Every RPC runs the real migration SQL in embedded PostgreSQL, as the user in the request's token.

The migration's rules are also covered by `npm run test:tenancy`. Not verified: hosted Auth emails and redirects, SMTP delivery, and PostgREST itself.

## Workspace forms, notifications and role limits

Added 20 October 2026: [`202610200003_workspace_forms.sql`](../supabase/migrations/202610200003_workspace_forms.sql), with a [rollback](../supabase/rollbacks/202610200003_workspace_forms.down.sql) that runs before the other two. Local only so far.

**Why.** Before this, there was one deployment-wide public form. The Integrations hub showed the same `/inquiry` link in every workspace, but submissions always landed in the workspace set in `WEBSITE_WORKSPACE_ID`, and notified the single `NOTIFICATION_TO` inbox. Another workspace installing "its" form would have sent its leads and emails to the wrong workspace.

**Forms**
- **One form per workspace.** Every workspace now has a form with a random public key; existing workspaces are backfilled, and new ones get theirs on creation. The key is never the workspace ID.
- **Link and embeds.** The Integrations hub builds `/inquiry?form=KEY` for the open workspace.
- **Routing.** The `submit-inquiry` function passes the key to `receive_form_inquiry`, which finds the enabled form and saves into its workspace. Visitors can't choose a workspace: an unknown or turned-off key is refused, and so is a workspace ID.
- **Notifications** go to the workspace owner's email, or a recipient that owners or admins set, from the deployment's `NOTIFICATION_FROM` sender. The text names the workspace.
- **Managing the form.** Owners and admins can turn the form off, change the recipient, or create a new key, which disables every old link and embed. Members see the link and settings read-only.
- **The old `/inquiry` link** without a key keeps working as before: it goes to `WEBSITE_WORKSPACE_ID`, or `WEBSITE_OWNER_ID`, and notifies `NOTIFICATION_TO`. Embeds already on live websites are unaffected.

**Roles.** Members can add and update leads, follow-ups and history, but the database refuses a member's save that removes a lead or follow-up, or changes or removes an existing history entry. Owners and admins keep full control, including **Reset demo data**, which members no longer see.

**Workspace switching.** The dashboard remounts for the newly selected workspace, so nothing from the previous workspace stays on screen while the new one loads. Each switch loads the workspace once; development mode's React StrictMode makes that twice. Every request carries the selected workspace ID, and the database checks it.

**Deploy in this order**
1. Apply the migrations: `npx supabase db push --linked --dry-run` should list `202610200002_workspace_onboarding.sql` and `202610200003_workspace_forms.sql`; then run `npx supabase db push --linked`.
2. Deploy the inquiry function: `npx supabase functions deploy submit-inquiry`. **Do this before the frontend.** The currently deployed function ignores form keys, so keyed links would deliver to the old deployment-wide workspace.
3. Build and deploy the frontend.
4. Optional: in each workspace, check the form's recipient under Integrations → Hosted inquiry form. Replace website embeds with the workspace's own link when convenient.

**Verification (local)**
- `npm run test:tenancy` covers:
  - form backfill, and forms on new workspaces;
  - keys distinct from workspace IDs;
  - routing and recipients for each workspace;
  - turned-off, re-keyed and unknown keys being refused;
  - service-only intake;
  - the member removal and history limits, alongside owner and admin resets.
- `npm run test:m3` covers form keys through the real Edge handler, including when the legacy settings are invalid.
- [`tests/isolation.spec.ts`](../tests/isolation.spec.ts) runs in the browser with two accounts and three workspaces:
  - dashboard metrics, leads, follow-ups, activity and integration credentials stay isolated across switching and reloads;
  - no stale data appears while a switch is loading;
  - the second account's token is refused for the first account's workspaces;
  - a workspace's own form link delivers to it and notifies its recipient;
  - members are limited in the UI and by the database.

Deliberately broken versions of the member limit, the turned-off-form check and the remount-on-switch were each caught by these tests.

## Known limitations and next steps

- **Snapshot protocol:** saves still send the whole workspace. Since `202610200003`, the database refuses a member's save that removes leads or follow-ups or changes existing history. Members can still edit any field of existing leads and follow-ups, and history text is written by the browser, so it is a working record, not an audit log. Save receipts record who saved.
- **No invitations:** members are added by Auth user UUID without their consent. There is no email lookup, which avoids account enumeration. An invitation flow with acceptance is the next step.
- **Team management UI:** members and roles are shown read-only. Adding, removing or promoting people still needs an operator, until invitations exist.
- **Activity history:** entries are not attributed to members. Save receipts record who saved.
- **Public form routing:** one destination workspace per Edge Function deployment. There is no self-service per-workspace public form yet.
