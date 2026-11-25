# Client onboarding and client management (M10)

Status: **implemented and verified locally on 25 November 2026. On 26 November 2026, the database and Edge Functions went to the hosted project:**
- migration `202611250001_client_management.sql` was applied;
- the new `client-files` Edge Function and the updated `client-portal` were deployed.

**The frontend is not deployed.** Real Supabase Storage hasn't been exercised yet: the tests use an in-memory stand-in for its REST API, and nobody has uploaded a file on the hosted project. See [Hosted rollout](#hosted-rollout-26-november-2026).

M10 turns won deals into clients and runs their onboarding. It builds on what exists, not beside it:
- leads and the workspace snapshot (M2);
- the onboarding engine, client portal and readiness rules (M6A);
- contacts (M8);
- deals, their handoff record, follow-up tasks and workspace roles (M9).

There is one client record per client, one task system, one onboarding engine and one portal.

- Migration: [`supabase/migrations/202611250001_client_management.sql`](../supabase/migrations/202611250001_client_management.sql)
- Rollback: [`supabase/rollbacks/202611250001_client_management.down.sql`](../supabase/rollbacks/202611250001_client_management.down.sql)
- Edge Functions:
  - [`client-files`](../supabase/functions/client-files/handler.ts) (new): member uploads and downloads.
  - [`client-portal`](../supabase/functions/client-portal/handler.ts) (extended): client uploads, files and scope acknowledgement.
  - [`_shared/files.ts`](../supabase/functions/_shared/files.ts): Storage access and file checks.
- UI:
  - [`Clients.tsx`](../src/components/Clients.tsx): dashboard and directory.
  - [`ClientWorkspace.tsx`](../src/components/ClientWorkspace.tsx), [`ClientScope.tsx`](../src/components/ClientScope.tsx), [`ClientDocuments.tsx`](../src/components/ClientDocuments.tsx), [`ClientActivity.tsx`](../src/components/ClientActivity.tsx): one client.
  - [`ConvertDealDialog.tsx`](../src/components/ConvertDealDialog.tsx): converting a deal.
  - The onboarding screens extended from M6A: `ClientOnboarding.tsx`, `OnboardingRequest.tsx`, `OnboardingTemplates.tsx`, `OnboardingForms.tsx`, `OnboardingStages.tsx`, `ClientPortal.tsx`.
- Data access: [`src/lib/clients.ts`](../src/lib/clients.ts), [`src/lib/onboarding.ts`](../src/lib/onboarding.ts), [`src/lib/portal.ts`](../src/lib/portal.ts).

## What you can do

| Where | What |
|---|---|
| **Deal view → Convert to client…** | For a won deal. A review screen shows the deal (value, close date), the lead, the report opportunity, a summary of the latest business report and the deal notes. You choose the client's name, website, industry and owner, which of the lead's contacts carry over (with their role and the primary contact), the agreed services (from the deal, your service catalog or custom, each with scope, deliverables and exclusions) and whether to start onboarding. A template is **recommended** when its service matches the deal's service or opportunity; it's a suggestion only. Owners and admins can also convert a deal that isn't won, with a reason. |
| **Clients** (sidebar → Clients) | Dashboard: clients, onboarding in progress and ready, items waiting on clients, submissions to review, clients without a confirmed scope, overdue and due-today tasks, who each onboarding waits on, and recently onboarded clients. Directory: search (name, contacts, website, city), status, onboarding, industry and owner filters, sorting and paging. **New client**: from a won deal (opens the review), or by hand, optionally from a lead. |
| **Client workspace** | A header with the logo, status, onboarding progress, primary contact, owner, confirmed services, open tasks and the deal or lead it came from. Then eight tabs: **Overview**, **Contacts**, **Onboarding**, **Services & scope**, **Documents**, **Tasks**, **Activity & notes** and **Projects**. |
| **Overview** | Profile (website, industry, logo address, description, address, time zone, owner), important dates, internal notes, the welcome message, the conversion record and **Ready for delivery?**, the completion checklist. |
| **Welcome message** | Starts from a draft built from the client, its primary contact and services; you edit and save it. **Copy** puts it on the clipboard; **Open in your email app** opens a `mailto:` draft to the primary contact. LeadFlow never sends it. **Mark as sent…** records that someone sent it, how (email, WhatsApp, phone, meeting, other), when and by whom; the UI says delivery isn't tracked. |
| **Contacts** | Add, edit and remove contacts with role (decision-maker, project, billing, technical, marketing, operations, other), job title, email, phone, preferred channel and notes. Exactly one is primary; the primary can't be removed while others remain. |
| **Onboarding** | The client's checklists, with readiness, progress and per-stage counts. **Start onboarding** creates a draft checklist from a template (or blank), linked to the client, with the primary contact filled in. Opening one shows the full checklist view: review answers, the client link, internal steps and forms. |
| **Services & scope** | Services are **proposed**, **confirmed** or **removed**, each with agreed scope, deliverables, exclusions and notes. Requirements have a category (objective, goal, functional, technical, design, integration, constraint, dependency, assumption, expectation, success criteria), priority, status (draft, under review, confirmed, deferred, rejected), source and optional service. Every edit keeps a version you can open. **Confirm scope…** saves a dated record of the confirmed services, confirmed requirements, exclusions, dependencies, expectations and outstanding questions; it replaces the previous confirmation, which stays in the history. If services or requirements change afterwards, the scope is flagged as changed until it is confirmed again. |
| **Documents** | Upload files (category, and whether the client can see them), download, edit category, description and visibility, delete. Files the client uploads through the checklist appear here too. |
| **Tasks** | The client's follow-up tasks, which also appear on the Follow-ups page (filter **Clients**) and in the notification bell. Onboarding task types: send the welcome message, request information, review a submission, collect assets, review requirements, confirm the scope, verify access and integrations, prepare the project handoff, plus call, meeting, internal and custom. **Plan standard tasks** adds the usual five with due dates. |
| **Activity & notes** | One history: client changes, contacts, services, requirements, scope, welcome message, files, onboarding events (submissions, reviews, steps, forms, readiness), tasks planned, completed and cancelled. Filters by kind and older pages. Internal notes are added here; they can't be edited and are never shown to the client. |
| **Projects** | Project delivery is M11 and **not built**. After onboarding is completed this tab shows the handoff record M11 will start from. |
| **Onboarding → Forms / Stages** (owners and admins edit; members view) | A library of reusable forms, which you add to a checklist (the fields are copied, so later edits never change a client's checklist), and the workspace's onboarding stages. |
| **Client portal** | The client's private link now also takes the new field types, file uploads, shows files your team shared and the confirmed scope (when shared), which the client can acknowledge as read. |

### Client status and onboarding status

They are separate:
- **Client status** is set by people: Onboarding, Active, Paused, Completed or Archived. A new client starts as Onboarding, and completing onboarding moves it to Active.
- **Onboarding status** is computed by the database from the client's checklists and completion: Not started, In progress, Ready to complete, Paused or Onboarded.

**Archiving** is for owners and admins:
- the client becomes read-only, and its client links are revoked;
- nothing is deleted;
- unarchiving restores the status it had before.

### Completing onboarding

The checklist on the Overview tab lists what blocks completion:
- a primary contact;
- at least one confirmed service;
- requirements recorded and decided (at least one confirmed, none in draft or under review);
- the scope confirmed and unchanged since;
- every onboarding checklist complete (none left in draft or paused, and every open one has all its required items and internal steps resolved).

With all of them met, any member can **Complete onboarding**. Otherwise only an owner or admin can, with a reason; the reason and what was outstanding are kept.

Completion happens once. It does the following:
- hands off checklists that are ready;
- moves an Onboarding client to Active;
- records a **handoff snapshot** for M11. The snapshot holds the client, contacts, confirmed services, the current scope, confirmed requirements, dependencies, expectations, exclusions, documents, checklists with their handoffs, internal notes and the deal with its M9 handoff.

The snapshot doesn't change when the client changes later.

## Onboarding engine extensions (M6A → M10)

- **Stages.** Each workspace gets eight default stages on first use: Client created, Welcome & introduction, Business information, Requirements gathering, Access & assets, Scope confirmation, Final review, Onboarding completed. Owners and admins can rename, describe, add (before "completed"), reorder and archive them, keeping at least two active. Archived stages stay attached to existing work and can't be chosen for new work. Checklist items and internal steps belong to a stage. Each request shows per-stage progress: resolved over required, and how many items wait on the client, on review or on agency steps, and how many are overdue.
- **Internal steps.** Agency-only work on a checklist, with a title, description, required flag, due date, assignee and stage. You can mark a step done, reopen it, or mark it not required with a reason. Steps never reach the portal. Three kinds complete **automatically** from client events: the welcome message marked sent, the scope confirmed, and every requirement decided. They reopen if the requirement event is undone. On a client's checklist they can't be marked done by hand, only skipped with a reason. Readiness now needs required steps too: a new state, **Agency steps left**, means the client's part is done but the agency's isn't.
- **Field types.** Long and short answer, email, phone, web address, number (with min/max), date, choose one, choose several, confirmation checkbox, asset links, account access, file upload (1–10 files, with a document category), section heading and instructions. The last two display text and take no answer. The database validates definitions and answers, for example email and URL formats, URLs without embedded credentials, number limits, and that file answers name only files uploaded to that item which passed the checks.
- **Forms library.** Owners and admins create, edit, duplicate, archive and restore forms of 1–100 fields; members use them. **Add a form** copies a form's fields into a checklist under the form's name, in a chosen stage.
- **Submission history.** Every client submission of an item is kept with the review it got: accepted, changes requested with the note, not required, or superseded by a resubmission.
- **Starter templates.** Seven, now with stages and internal steps: paid advertising, SEO, social media, email marketing, and new **Website development**, **SEO & digital marketing** and **Automation**. Two service types were added: `website` and `automation`.
- **Tasks.** `follow_up_tasks` gains `clientId`, `onboardingRequestId` and `onboardingItemId`. `leadId` becomes optional, and a task needs a lead or a client. Client tasks are saved with the workspace snapshot like every other task. A trigger checks that a task's checklist belongs to its client.

## Documents and file security

- Files are stored in a **private** Supabase Storage bucket, `client-documents`, under `<workspace id>/<document id>`. The bucket is created on the first upload, with the size limit and the allowed MIME types. Nothing in it is public.
- **Allowed types:** PDF, PNG, JPG, GIF, WebP, TXT, CSV, Markdown, DOC/DOCX, XLS/XLSX, PPT/PPTX, ZIP, MP4, MOV, WebM, MP3 and PSD.
- **Size limit:** set by the `DOCUMENT_MAX_MB` secret on the Edge Functions. The default is 25 MB and the maximum 50 MB. The project's own Storage upload limit also applies.
- **Upload flow:**
  1. The browser asks the Edge Function to prepare an upload.
  2. The database checks the caller's access, the file name, type, size and limits, and records the file as **pending**. For a client, it also checks the link and the item.
  3. The function signs a one-time upload URL for the path the database chose.
  4. The browser sends the file straight to Storage.
  5. The browser asks the function to **finish**. The function reads the first 4 KB of the stored object and checks the size and the content signature the extension requires; a script renamed `.png` fails, for example. A file that fails is deleted and recorded as rejected.
- Only checked files can be downloaded or used in an answer. Uploads never checked are rejected after a day. A workspace can have at most 50 pending uploads, and a client at most 1,000 files.
- **Downloads** use a signed link that expires after 60 seconds and is served as an attachment under the file's name.
- **Who can do what:**
  - **Members** can upload, download, share and edit files of clients in their workspace.
  - **Deleting** a file is for owners, admins or the member who uploaded it. A file that is part of an accepted answer can't be deleted until changes are requested on that answer.
  - **Clients** can upload, see, download and remove only their own uploads, only while the checklist is open and only through their link. They can also download the files your team marked as shared. They never see internal files.
- Every upload, deletion and sharing change appears in the client's history. Logs carry IDs and outcomes, never file contents or names.
- **No antivirus scanning.** The checks are type, size and content signature. Treat downloaded files from clients like any email attachment.
- Never ask for passwords in a checklist. Account access items ask the client to grant access through each platform's own sharing. URL answers with embedded credentials are refused, and the field editors warn when a label mentions passwords or secrets.

## What is automatic and what isn't

- Nothing in M10 sends a message, an email or an invitation. The welcome message is copied or opened in the user's email app. "Marked as sent" records what a person says they did; LeadFlow has no provider confirmation and says delivery isn't tracked. (M6A's optional reminder emails are unchanged and still need a configured scheduler.)
- The template recommendation and the stage suggestions are suggestions. Nothing converts, completes or moves on its own, except internal steps marked automatic, which follow their event.
- The scope confirmation is an internal record. The client's acknowledgement means they read it; it is not a contract, signature or legal acceptance, and the UI says so.
- The portal link is a bearer token for one checklist: it can only read that checklist and act on it. It is not a client account or a login.
- **AI was not built.** The brief made it optional (summaries, requirement extraction); no AI provider is called in M10.

## Data model

All tables are in `leadflow_private` with RLS enabled and no client privileges. Members use role-checked `security definer` functions in `public`. These take the caller from `auth.uid()`, check membership and role on every call, and find each record within the caller's workspace: workspace IDs from the browser only select a workspace.

| Table | Purpose |
|---|---|
| `clients` | Profile, status and previous status, owner, lead, deal and its M9 handoff (unique per deal), the conversion record, internal notes, important dates, the welcome message and when, how and by whom it was marked sent, `version`, `request_id` (unique per workspace). |
| `client_contacts` | Contacts with role, preferred channel and one primary (unique); the M8 contact each came from. |
| `client_services` | Services, proposed, confirmed or removed, with scope, deliverables, exclusions, the catalog service and who confirmed them. Names are unique per client. |
| `client_requirements`, `client_requirement_revisions` | Requirements and every version of each. |
| `client_scope_confirmations` | Numbered confirmations with their snapshot and outstanding questions; one current; the client's acknowledgement. |
| `client_activities` | The client's history and internal notes (append-only), with idempotent notes. |
| `client_onboarding_completions` | One per client: who, when, note, override reason, what was outstanding, the M11 snapshot. |
| `onboarding_stages` | Per-workspace stages. |
| `onboarding_forms`, `onboarding_form_fields`, `onboarding_form_assignments` | The forms library and each copy made into a checklist. |
| `onboarding_template_steps`, `onboarding_steps` | Internal steps of templates and checklists. |
| `onboarding_item_responses` | Every submission with its review. |
| `client_documents` | File records: client, checklist and item, storage path, name, type, size, category, visibility, status (pending, available, rejected, deleted), uploader. |
| Existing tables | `onboarding_requests.client_id`. Items and template items gain a stage, settings and form name. `follow_up_tasks` as above. `deal_activities` gains `client_converted`. |

### Conversion, idempotency and integrity

- **Converting a deal:**
  - The conversion runs in **one transaction**: it creates the client, contacts and services, records the M9 handoff if the deal has none, adds the deal and client history and, if chosen, creates the onboarding checklist. A failure leaves nothing behind.
  - Each conversion is idempotent per request ID, and each deal converts **once**. Converting it again returns the existing client.
  - Deals handed off in M9 before M10 have a handoff but no client. Converting them completes the conversion and reuses that handoff.
  - The lead, deal and deal history are never changed or deleted.
- **Optimistic concurrency.** Profile and status changes, service edits, requirement edits and checklist changes send the version they started from. A stale version is refused (`40001`), and the UI reloads and explains.
- **Idempotent requests.** Creating clients, requirements, forms and notes and starting onboarding take request IDs.
- **Archived clients are read-only.** Every change function refuses them (`55000`).
- **Limits** (`54000`): 5,000 clients per workspace, 50 contacts, 30 services and 300 requirements per client, 30 stages, 100 forms, 100 fields per form or checklist, 50 internal steps per checklist.

### Functions

**Signed-in members** (owner, admin or member) call:
- clients and the directory: `clients_for`, `client_index_for`, `client_dashboard_for`, `client_detail`, `create_client`, `convert_deal_to_client`, `start_client_onboarding`, `update_client`, `set_client_status`;
- contacts, services and requirements: `save_client_contact`, `delete_client_contact`, `save_client_service`, `save_client_requirement`, `client_requirement_history`;
- scope, welcome message and notes: `confirm_client_scope`, `client_scope_history`, `save_client_welcome`, `mark_client_welcome_sent`, `add_client_note`;
- history and completion: `client_timeline`, `client_completion_check`, `complete_client_onboarding`, `client_handoff_for`;
- stages and forms: `onboarding_stages_for`, `save_onboarding_stage`, `reorder_onboarding_stages`, `set_onboarding_stage_archived`, `onboarding_forms_for`, `onboarding_form_for`, `save_onboarding_form`, `duplicate_onboarding_form`, `set_onboarding_form_archived`, `assign_onboarding_form`;
- items and internal steps: `onboarding_item_history`, `save_onboarding_step`, `remove_onboarding_step`, `set_onboarding_step_status`;
- documents: `begin_client_document`, `client_document_access`, `client_documents_for`, `update_client_document`, `delete_client_document`.

**Inside the functions, roles narrow further:**
- archiving and unarchiving clients, converting a deal that isn't won and completing with items outstanding are for owners and admins;
- stage and form editing is for owners and admins;
- members delete only the files they uploaded.

**The service role** (Edge Functions only) calls `finish_client_document`, `portal_begin_upload`, `portal_document_access`, `portal_remove_upload` and `portal_acknowledge_scope`.

`test:tenancy` asserts the exact list of functions signed-in users can call; `test:clients` asserts the grants of the new ones.

## Hosted rollout (26 November 2026)

Done at the owner's request, on project `fzgxpwmqzmvgmijviaar`:

1. **M9 was already in the hosted database but not in its migration history**, so `db push` stopped at its first statement and changed nothing. All 38 M9 tables, columns and functions were present. Checksums of every M9 function body, column, constraint and trigger matched a local database built from the same migration files (243 items); the only differences were the named NOT NULL constraints PostgreSQL 18 records and 17 doesn't. M9 was then recorded as applied without being re-run: `npx supabase migration repair --status applied 202611230001`.
2. `npx supabase db push --remote` applied `202611250001`. Read-only checks afterwards:
   - the history lists both migrations;
   - all 16 new tables exist, and every `leadflow_private` table has RLS with no `anon` or `authenticated` read access;
   - `anon` can run none of the new functions, members can run the client functions, and members can't run the service-role functions (`finish_client_document`, `portal_*`);
   - `follow_up_tasks` has the three new columns.
3. Deployed `client-files` (version 1) and re-deployed `client-portal` (version 10), both `verify_jwt = false`, with `npx supabase functions deploy … --use-api`. Smoke test with harmless requests:
   - `client-files` refuses a request without an origin (403);
   - from the app's origin without a session it asks for sign-in (401), which shows the origin is on its allowlist;
   - the CORS preflight returns 204;
   - the portal rejects a fake link (404).
4. **Secrets:** `DISCOVERY_ALLOWED_ORIGINS`, `PORTAL_ALLOWED_ORIGINS` and the Supabase keys are set. `DOCUMENT_MAX_MB` isn't set, so the limit is 25 MB.

**Still to do:**
- deploy the frontend; M10 isn't committed yet;
- the manual Storage checks in step 7 below, which also create the `client-documents` bucket on the first upload.

## Deploying (reference; steps 1–4 were done on 26 November 2026, see above)

1. Apply `supabase/migrations/202611250001_client_management.sql`, after `202611230001`. It redefines several M6A functions, `save_workspace_for` and the M9 task trigger; the previous definitions are in the rollback. Use `npx supabase db push` or the SQL editor.
2. Deploy the new Edge Function: `npx supabase functions deploy client-files`. `supabase/config.toml` sets `verify_jwt = false` because the function checks each caller's token through the database, like `outreach`.
3. Re-deploy `client-portal`: `npx supabase functions deploy client-portal`. It gained upload, finish, download, remove and acknowledge.
4. Secrets:
   - The functions use `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY`, which Supabase provides.
   - The app's origin must be listed in `DISCOVERY_ALLOWED_ORIGINS` (or `PORTAL_ALLOWED_ORIGINS`) for `client-files`, and in `PORTAL_ALLOWED_ORIGINS` for the portal.
   - Optional: `DOCUMENT_MAX_MB`, default 25 and at most 50.
5. Storage: nothing to create by hand. The first upload creates the private `client-documents` bucket. If you change `DOCUMENT_MAX_MB` later, also change the bucket's file size limit in the dashboard, because the function only sets it when it creates the bucket.
6. Deploy the frontend.
7. Check by hand on the hosted project: upload, download and delete a small PDF as a member; open a client link and upload a file to a file field; try a renamed file and an oversized file; confirm downloads expire; confirm another workspace's member can't reach the file.

**Rollback:**
1. Run `supabase/rollbacks/202611250001_client_management.down.sql`, then `npx supabase migration repair --status reverted 202611250001`.
2. The rollback deletes clients and everything attached to them, forms, stages, internal steps, submission history, document records and client tasks. It removes items of the new field types, and turns website and automation templates and checklists into "other".
3. It restores the M6A and M9 function definitions. Leads, deals and their history are untouched.
4. It does **not** delete stored files: remove the bucket in Storage.
5. Roll M10 back before M9 or M6A.

## Tests

- `npm run test:clients` runs the migration in embedded PostgreSQL, with the real `client-files` and `client-portal` handlers and simulated Storage. It covers:
  - grants and private tables;
  - stages and the seven starter templates;
  - conversion: reviewed details, M8 contacts, confirmed services and onboarding, idempotent and once per deal, transactional on failure, resuming M9 handoffs, owner and admin exceptions;
  - manual clients, versioned edits, status separate from onboarding, archive and unarchive;
  - directory search, filters, sorting and paging;
  - contacts, services and versioned requirements;
  - superseding scope confirmations with change detection;
  - internal and automatic steps, stage progress and overdue work;
  - new field types validated on definition and answer;
  - the forms library;
  - a portal that hides internal steps, notes and deal values and keeps every submission and review;
  - files through signed URLs, checked by signature, type and size, shared files, scope acknowledgement and revoked links;
  - member files with role checks;
  - client tasks through the snapshot;
  - timeline paging, the dashboard, and completion with override and M11 snapshot;
  - workspace isolation, rollback and re-apply.
- `tests/clients.spec.ts` (Playwright, real UI against the same SQL and Edge handlers):
  - converting a won deal from the review, with a recommended template;
  - the welcome message;
  - requirements and the scope;
  - contacts;
  - documents (upload, a rejected fake image, download, sharing);
  - standard tasks on the Follow-ups page;
  - notes and the history;
  - completion by exception and the M11 record;
  - archive and unarchive;
  - the directory and the dashboard;
  - the deal linking to its client;
  - phone width;
  - member restrictions;
  - a client added by hand from a lead.
- `tests/onboarding.spec.ts` covers the extended checklist, forms, stages and portal.
- Existing suites were updated for the new task fields and functions (`test:db`, `test:tenancy`), the seven starters and internal steps (`test:onboarding`), the rollback order (`test:sales`, `test:outreach`, `test:analysis`) and the conversion replacing the M9 handoff button (`tests/sales.spec.ts`).

Results: see the [verification ledger](../DEVELOPMENT_ROADMAP.md#current-verification-ledger).

## Limitations and not built

- **Projects and delivery (M11)** are not built; only the handoff snapshot exists.
- **No AI** (client summaries, requirement extraction from answers, risk notes).
- **No sending:** no email or chat sending, no read receipts or delivery tracking, and no client accounts or logins (the portal link is per checklist).
- **No e-signatures, contracts or legal acceptance.**
- **Files:** no antivirus scanning, previews or thumbnails, and no folders or versions of the same file.
- **Real Storage untested:** hosted Storage behaviour (signed upload URLs, range reads, CORS, the bucket size limit) is verified only against the simulation and needs the manual checks above.
- **Snapshot limits:** client tasks share the workspace snapshot's limits (10,000 tasks). Task names use the 2,000 most recently updated clients.
- **Dashboard scope:** dashboard figures count clients that aren't archived.
