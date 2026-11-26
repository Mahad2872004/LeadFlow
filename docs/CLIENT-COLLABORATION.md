# Client collaboration and approvals (M12)

Status: **implemented and verified locally, 27 November 2026, and live:**
- the database, the Edge Functions and the frontend are on production at https://leadflowglobal.vercel.app (see [Hosted rollout](#hosted-rollout-27-november-2026));
- portal email goes out only once the `portal-notifications` worker is scheduled;
- password-reset links need the Auth redirect URL below.

M12 connects the agency's workspace with its clients:

**Agency shares a project → shares a deliverable version for review → client reviews → client gives feedback or requests changes → agency answers and uploads a new version → client approves → delivery continues.**

It extends what exists rather than adding parallel systems:
- the M10 client is the client organization;
- M11 projects, milestones and deliverables are what gets shared;
- M10 private file storage holds every file;
- the client activity history records collaboration events;
- the M3/M6A lease-and-retry email pattern sends email;
- the M11 assistant and usage ledger provide AI help.

**Files:**
- Migration: [`supabase/migrations/202611270001_client_collaboration.sql`](../supabase/migrations/202611270001_client_collaboration.sql)
- Rollback: [`supabase/rollbacks/202611270001_client_collaboration.down.sql`](../supabase/rollbacks/202611270001_client_collaboration.down.sql)
- Edge Functions:
  - [`client-hub`](../supabase/functions/client-hub/handler.ts) (new): invitations, account activation and client file actions;
  - [`portal-notifications`](../supabase/functions/portal-notifications/handler.ts) (new): the email worker;
  - [`client-files`](../supabase/functions/client-files/handler.ts) (version, comment and update attachments);
  - [`project-assistant`](../supabase/functions/project-assistant/handler.ts) with [`_shared/projects/collaboration.ts`](../supabase/functions/_shared/projects/collaboration.ts) (collaboration help).
- Data access:
  - agency side: [`src/lib/collaboration.ts`](../src/lib/collaboration.ts);
  - client portal: [`src/lib/hub.ts`](../src/lib/hub.ts).
- UI, client portal (`/portal`, lazy-loaded) under [`src/components/hub/`](../src/components/hub/):
  - `ClientHub.tsx`: session and routes;
  - `HubAuth.tsx`: sign-in, forgot password, reset, invitation, no access;
  - `HubShell.tsx`: navigation and the client-space switcher;
  - `HubOverview.tsx`, `HubProject.tsx` and `HubDeliverable.tsx`, which holds the review, approval and feedback screens;
  - `HubComments.tsx`, `HubFiles.tsx` and `HubSettings.tsx`, which also holds notifications;
  - `hubShared.tsx`, `hubKit.ts` and `Hub.css`.
- UI, agency side:
  - `ProjectCollaboration.tsx`, the project's **Client portal** tab, with `CollabThread`, `CollabUpdates`, `CollabPreview` and `CollabBits`;
  - `DeliverableReview.tsx`: versions, review requests, feedback and history, with `CollabAssistant`;
  - `ClientPortalAccess.tsx`, the client's **Portal access** tab;
  - `ReviewQueue.tsx`, **Projects → Client reviews**;
  - client activity in `NotificationCenter.tsx`;
  - `CollabEmailSettings.tsx` in Settings;
  - sharing for project files in `ProjectFiles.tsx` and `ClientDocuments.tsx`.
- The agency app shows client accounts a "This is a client portal account" notice (`AuthGate.tsx`).
- Tests:
  - [`scripts/test-collaboration.mjs`](../scripts/test-collaboration.mjs) (`npm run test:collaboration`);
  - [`tests/collaboration.spec.ts`](../tests/collaboration.spec.ts);
  - the harness [`tests/support/collaboration.ts`](../tests/support/collaboration.ts).

## Client accounts and invitations

Client people sign in with **their own Supabase Auth account**. There is no shared password and no unrestricted portal link. The M10 onboarding link stays as it was, for onboarding checklists only.

**Inviting:**
- Owners and admins invite a person from the client's **Portal access** tab, or from a project's Client portal tab.
- Each invitation has an email address, a name, a role and project access (all of the client's shared projects, or selected ones).
- The invitation token (`lfi_` followed by 64 hex characters, from the database's cryptographic random generator):
  - is shown once;
  - is stored only as its SHA-256;
  - works once and expires after 7 days.
- **Renew** issues a new token (the old link stops working). **Revoke** withdraws the invitation.
- One pending invitation per address and client; at most 50 pending per client. A repeated request returns the same invitation without the token.
- With **Also send by email**, the invitation is queued in the portal email outbox (see [Email](#email)). Otherwise the agency copies the link (`/portal/invite#<token>`) and sends it itself.
- The token sits in the URL fragment, so it never reaches a server log, and the page removes it from the address bar.

**Accepting:**
- **New person:**
  1. `client-hub` checks the invitation.
  2. It creates the account through the Auth admin API with `email_confirm: true` and `app_metadata.account_type = 'client'`.
  3. It links the account (`hub_activate_invitation`), and the page signs in with the password just chosen.

  Holding the single-use link the agency sent to that address is what confirms the address. Passwords must be 8 to 128 characters.
- **Existing account** (for example a person invited by two agencies):
  1. The person signs in.
  2. The browser sends the token's hash to `hub_accept_invitation`.
  3. The account's email must be the invited address.
- Agency members of the same workspace can't accept, so one account is never both sides of one workspace.

**Signing in and out, password recovery and sessions** use Supabase Auth:
- sign in with email and password;
- `resetPasswordForEmail`, with the redirect to `/portal/reset`;
- `updateUser` for a new password;
- `signOut`, and `signOut({ scope: 'others' })` to sign out other devices.

Password-recovery emails come from Supabase Auth's own email settings (see [Configuration](#configuration)).

**Revocation is immediate:**
- An owner or admin revokes a person (or archives the client), and every portal function refuses them on the next request.
- Unsent emails to that person are cancelled.
- Restoring access reactivates the same person.

**Client accounts can't use the agency app:**
- `current_profile()` refuses accounts marked `account_type = 'client'`. That covers listing, creating and opening workspaces, so a client account can never create a workspace.
- Every agency function checks workspace membership anyway.
- The app's sign-in shows "This is a client portal account" with a link to `/portal`.

## Roles and permissions

| | Client admin | Client member | Client reviewer |
|---|---|---|---|
| Projects | Every shared project | All or selected shared projects | All or selected shared projects |
| Approve, request changes, reject | ✓ (any open review) | — | ✓ (when the review is unassigned or assigned to them) |
| Give feedback without deciding | ✓ | ✓ | ✓ |
| Comment and reply | ✓ | ✓ | ✓ |
| Upload project files | ✓ | ✓ | Only attachments to their own feedback or comments |
| Edit or delete | Their own comments, and their own uploads except feedback attachments | Same | Same |
| Notification and email preferences | Their own | Their own | Their own |

Agency side:
- owners and admins manage invitations, roles, project access and revocation;
- every member can see them, share projects and deliverables, request reviews, comment and publish updates.

Client admins don't manage other client people in this milestone; the agency does.

## What the client sees

Nothing is visible until the agency shares it, and every portal query checks it again:

| Agency action | Client sees |
|---|---|
| **Share the project** (the project's Client portal tab) | Name, category, a client-facing status, progress percentage, start and target dates, the client-facing summary and objectives written for them, agreed services, and a contact if one is entered. |
| **Show a milestone** | Its name, description, dates and a client-facing status. |
| **Share a deliverable** (or send it for review) | Its title, description, due date and review status, its **published** versions with their files, its reviews, decisions and feedback. |
| **Publish an update** | The update and its attachments. |
| **Share a project file** | The file, if the person can open the project. |
| **Mark a comment visible to the client** | The comment and its attachments. |

Never shown to clients:
- internal notes, the internal brief, money (agreed value, costs), health and its reasons;
- internal delivery statuses, tasks and draft versions;
- internal comments, unshared files and other clients' anything.

"At risk" and "Delayed" project and milestone statuses show as "In progress". Storage paths never leave the database and Edge Functions.

**Preview as client** (`project_portal_preview`) renders the project exactly as the client would see it, before or after sharing.

## Review lifecycle

The internal delivery status (M11) and the client review status are separate fields. A deliverable can be complete internally and still await the client's approval.

```
Not shared ──share──▶ Shared ──request review──▶ Awaiting client review
                                                    │
               ┌──────────────┬─────────────────────┼─────────────────┐
               ▼              ▼                     ▼                 ▼
           Approved     Changes requested       Rejected          Withdrawn (agency)
                              │                     │
                              └──new version + request review──▶ Resubmitted ─▶ (decision again)
```

**Versions:**
- A **version** collects the files of one submission, with notes on what changed.
- It's a draft until it's published, either by a review request or by **Share without review**. Then it never changes: no files added, removed or re-shared, and no notes edited.
- One draft at a time. A review can only be requested for the latest version.

**Reviews and decisions:**
- One open review per deliverable. It has an optional message, due date and assigned reviewers.
- Opening a deliverable with an open review records the **first view** (time and person). That is the only "viewed" signal LeadFlow reports; a delivered notification is not a view.
- **Decisions** (approve, request changes, reject) are recorded once per review, for that review's version only, with the reviewer's name and email at that moment. A trigger refuses any change to them.
- Requesting changes needs at least one feedback item or a comment. Rejecting needs a reason.
- A version that was already approved can't be sent for review again.
- A new version after an approval needs its own review. The approval stays with the version it was given for.
- **Withdraw** closes an open review; withdrawn reviews aren't shown to the client. Hiding a deliverable withdraws its open review.

**Feedback:**
- Feedback items have a title, a category (design, content, functional, technical, general), a description and attachments.
- They are never deleted. The agency moves each one through Open → Acknowledged / Question for the client / Addressed (optionally "in version N") / Won't change, with a note the client sees.
- Each item has its own reply thread.

## Comments and discussions

Threads:
- the project discussion;
- each deliverable's discussion;
- each feedback item's replies.

One level of replies.

**Visibility:**
- Every comment is **Internal** or **Visible to the client**. Agency comments default to internal; client comments are always client-visible.
- A client-visible reply to an internal note is refused.
- The client can't see, or reply to, internal notes; their IDs return "not found".

**Text and edits:**
- Comments are plain text: stored and returned as typed, and rendered as text, never as HTML.
- Authors edit and delete their own comments; owners and admins can delete any.
- The earlier text of every edit and deletion is kept for the agency (`project_comment_history`). A deleted comment shows as "Comment deleted".

There's no real-time chat. The pages fetch when opened, and notifications tell people something new arrived. Unread client messages are tracked per member (`mark_project_discussion_read`).

## Files

Files use M10's private `client-documents` bucket and the same checks: an allowed type, a size limit, a content-signature check before a file counts, and signed links that expire after 60 seconds. M12 adds attachments to versions, comments, feedback and updates, and client uploads.

| Scope | Who can download |
|---|---|
| Internal file (client or project) | Members only |
| Client-level shared file (M10) | The client's portal people (and the onboarding link, as before) |
| Shared project file | Portal people who can open the project |
| Version file | Same, once the version is published and the deliverable shared |
| Comment attachment | Same, while the comment is client-visible and not deleted |
| Feedback attachment | Same, while the deliverable is shared |
| Update attachment | Same, once the update is published |

- Every download, preview and removal is authorized by `hub_document_access`, with the person's own token, at the moment the link is signed.
- Client uploads go through `client-hub` → `hub_begin_document`, then Storage, then the content check (`finish_client_document`).
- Files of a shared version, and feedback attachments, can't be deleted: they're part of the review record.
- The M10 onboarding link never shows or serves project files, even shared ones.

## Notifications

In-app notifications are stored per person. A dedupe key per person and event means retries never notify twice.

| Client events | Agency events |
|---|---|
| Project shared; milestone added; ready for review; revised version ready; reply to their feedback (or a question about it); new message; update published; new shared files | Client activated their access; feedback given; changes requested; deliverable approved; deliverable rejected; client message; client upload |

Who gets notified:
- **Clients:** everyone who can open the project, except the person who acted.
- **Agency:** the project's owner, or the workspace's owners and admins when the project has none, plus the member who requested the review, for decisions.

Members never get notifications about their own actions.

Read state:
- clients mark notifications read in the portal;
- members mark them read in the notification center.

Email preferences:
- **Clients** choose which events also send email, in portal settings. All client events are on by default.
- **Members** choose in Settings → Client activity emails. Defaults: activation, feedback, changes requested, approvals and rejections.

### Email

Emails (invitations and notification emails) go through `portal_email_outbox` and the `portal-notifications` worker:
- `claim_portal_email` composes each email **once**, from the app address and sender the worker passes in, and leases it.
- The worker sends it through Resend with the idempotency key `leadflow-portal/<job>`.
- `finish_portal_email` records the provider's answer. Unknown outcomes are retried with the same key and body, with backoff, for up to 8 attempts.
- Emails to people who lost access, and invitations no longer pending, are cancelled instead of sent.
- Invitation tokens and email bodies are cleared once the outcome is final.
- A provider acceptance is recorded as "accepted by the email provider", never as delivered.

Content:
- Emails name the agency, the client and the project, and say what's needed.
- They link to `/portal/...` (clients) or `/app` (members), and never include internal notes or money.

**Nothing runs the worker automatically.** A scheduler must call it (see [Configuration](#configuration)). Until email is configured, everything stays queued, the in-app notifications still work, and the agency's invitation list shows "Queued (sent when email delivery is configured)".

## Published updates

- Members write updates as drafts, preview them, and publish them to the client (a notification goes out).
- Internal activity never becomes an update by itself.
- Correcting a published update keeps the earlier text (`project_update_revisions`) and marks it "Corrected" for the client.
- Published updates can't be deleted.

## AI collaboration help

`project-assistant` gains four operations for members:
- **Summarize feedback:** grouped into content, design, functional, technical and clarification points.
- **Draft a reply:** to one feedback item.
- **Prepare review notes:** what changed in the latest version, which feedback it addresses, and what's unresolved.
- **Summarize discussion:** decisions and open questions.

Safeguards:
- The assistant reads the project as the member (`project_collab_ai_context`, shared deliverables only) and reduces it to numbered facts.
- Client text is sent only inside the escaped JSON data block, and every point must cite facts. Uncited points are dropped, with a warning.
- Reply drafts never see internal comments.
- The answer is a suggestion: "Use as reply draft" fills the reply box, and a person edits it, chooses who sees it, and sends it.
- Nothing is sent, resolved or approved by the AI.
- Requests count against the same `PROJECT_AI_MONTHLY_LIMIT` (default 200 per workspace per month).
- Collaboration works fully without AI.

## Data model and functions

**New tables** (all in `leadflow_private`, RLS on, no client grants):

| Group | Tables |
|---|---|
| Access | `client_users`, `client_user_projects`, `client_invitations` |
| Reviews | `deliverable_versions`, `deliverable_reviews`, `deliverable_feedback`, `deliverable_decisions` |
| Conversation and updates | `project_comments`, `project_comment_revisions`, `project_comment_reads`, `project_updates`, `project_update_revisions` |
| Notifications and email | `portal_notifications`, `portal_member_preferences`, `portal_email_outbox` |

**Extended tables:**

| Table | Added |
|---|---|
| `projects` | `portal_shared`, `portal_shared_at`, `portal_summary`, `portal_objectives`, `portal_contact_name`, `portal_contact_email` |
| `project_milestones` | `client_visible` |
| `project_deliverables` | `client_visible`, `shared_at`, `review_status` |
| `client_documents` | `version_id`, `comment_id`, `feedback_id`, `update_id`, `uploaded_client_user`; the M11 "project files are internal" constraint is dropped |
| `client_activities` | `client_user_id` |

**Integrity:**
- Composite foreign keys keep every row in its workspace, client, project and deliverable.
- One draft version and one open review per deliverable.
- Decisions reference their review and version, and a trigger blocks updates to them.
- Request IDs make creations idempotent.
- A login deleted from Auth clears the person's link but keeps their feedback and decisions, with name and email snapshots.

**Functions:**

| Caller | Functions |
|---|---|
| Members (role-checked) | `client_portal_access_for`, `invite_client_user`, `renew_client_invitation`, `revoke_client_invitation`, `update_client_user`, `set_client_user_active`, `set_project_portal`, `set_client_visibility`, `project_portal_preview`, `project_collab_for`, `deliverable_collab_for`, `collab_queue_for`, `create_deliverable_version`, `update_deliverable_version`, `discard_deliverable_version`, `request_deliverable_review`, `publish_deliverable_version`, `withdraw_deliverable_review`, `set_feedback_status`, `project_comments_for`, `add_project_comment`, `edit_project_comment`, `delete_project_comment`, `project_comment_history`, `mark_project_discussion_read`, `save_project_update`, `publish_project_update`, `delete_project_update`, `member_notifications_for`, `mark_member_notifications`, `member_notification_settings`, `save_member_notification_settings`, `project_collab_ai_context` |
| Client people | `hub_accounts`, `hub_home`, `hub_project`, `hub_deliverable`, `hub_decide`, `hub_add_feedback`, `hub_comments`, `hub_add_comment`, `hub_edit_comment`, `hub_delete_comment`, `hub_files`, `hub_begin_document`, `hub_document_access`, `hub_remove_document`, `hub_notifications`, `hub_mark_notifications`, `hub_settings`, `hub_save_settings`, `hub_accept_invitation` |
| Service role only | `hub_invitation_status`, `hub_activate_invitation`, `claim_portal_email`, `finish_portal_email` |

**Redefined, with the earlier versions in the rollback:**
- `current_profile` (refuses client accounts);
- `document_json`;
- `begin_client_document`, `update_client_document`, `delete_client_document` and `finish_client_document` (attachments, sharing and the review record);
- `portal_view` and `portal_document_access` (no project files on onboarding links);
- `project_ai_reserve` (the new operations).

## Security

- **Authorization is in the database.** Every `hub_` function starts from the caller's active `client_users` row for the record's client (`hub_access`), then checks:
  - project access (`hub_can_see_project`);
  - what was shared (`client_visible`, published, client-visible comments);
  - the role.

  Anything outside that returns the same "Not found" (P0002), so changing an ID in a URL or request reveals nothing.
- **Identity:** workspace IDs from the browser only select a workspace for members; client functions take no workspace ID.
- **Separate roles:** client accounts can't run agency functions; agency members can't run client functions (they have no client access) and can't accept client invitations for their own workspace.
- **No impersonation:** agency members can't record decisions or feedback for a client.
- **Tokens:** invitation tokens are hashed, single-use, expiring and revocable, and rate-limited per token in `client-hub`. Uploads are rate-limited per project and capped at 200 per person per day.
- **Input:** text is cleaned of control characters and length-checked in the database; comments are rendered as plain text.
- **Files:** they keep M10's type, size and signature checks; signed links last 60 seconds.
- **Audit:** collaboration events are written by the database functions themselves (not by the browser) into the client's activity history. Decisions, feedback, comment revisions and update revisions are kept.
- **Errors and logs:** error messages are written for people and don't reveal other records. Edge Function logs carry IDs and outcomes only; no tokens, passwords or email addresses.

## Configuration

| Setting | Where | Needed for |
|---|---|---|
| `PORTAL_ALLOWED_ORIGINS` (or `DISCOVERY_ALLOWED_ORIGINS`) | Edge Function secrets | `client-hub`: the app's origin must be listed |
| `APP_URL` (production: `https://leadflowglobal.vercel.app`) | Edge Function secrets | Links in portal emails |
| `RESEND_API_KEY`, `NOTIFICATION_FROM` | Edge Function secrets (already used by M3/M6A) | Sending portal email |
| `NOTIFICATION_WORKER_SECRET` | Edge Function secrets (already used by M3/M6A) | Calling `portal-notifications` |
| A scheduler that POSTs to `portal-notifications` with `x-worker-secret` every few minutes | Supabase Cron, GitHub Actions or similar | Email actually going out |
| Auth → URL configuration: add `<site>/portal/reset` to the redirect URLs | Supabase dashboard | Password recovery links |
| Auth → SMTP settings | Supabase dashboard | Password-recovery emails to anyone outside the Supabase team (the default sender only reaches team members) |

Client accounts are created by `client-hub` with the service role, so the project's public sign-up setting doesn't affect invitations.

## Deploying (reference; steps 1–4 were done on 27 November 2026, except scheduling the worker and the Auth redirect URL; see above)

1. Apply `202611270001_client_collaboration.sql` with `npx supabase db push --remote`.
2. Deploy the functions with `npx supabase functions deploy <name> --use-api`:
   - `client-hub` and `portal-notifications` (new);
   - `client-files` and `project-assistant` (updated).

   All four have `verify_jwt = false` in `config.toml`; each checks its callers itself.
3. Set `APP_URL` and check the other settings in [Configuration](#configuration). Add the password-reset redirect URL, then schedule the worker.
4. Deploy the frontend (push `main`; Vercel builds it). Production is `https://leadflowglobal.vercel.app`. `vercel.json` serves `/portal` with `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`.
5. Check by hand (below).

## Hosted rollout (27 November 2026)

Done at the owner's request, on project `fzgxpwmqzmvgmijviaar`:
1. **Before:** the migration history matched the repository up to `202611260001`. A read-only check found:
   - no M12 tables, `hub_` functions or new columns;
   - no project files.
2. **Migration:**
   - `npx supabase db push --remote --dry-run` listed only `202611270001`;
   - `npx supabase db push --remote` applied it.
3. **Read-only checks afterwards:**
   - the history lists `202611270001`;
   - all 15 new tables exist with RLS, and `anon` and `authenticated` have no table privileges on them;
   - of the 56 new public functions, `anon` can run none and `authenticated` exactly 52; the 4 service functions run only as the service role;
   - the private helpers can't be run by signed-in users;
   - the 15 new columns exist, the M11 "project files are internal" constraint is gone, and the decision trigger is in place;
   - no project is shared.
4. **Functions** (all with `verify_jwt = false`), deployed with `npx supabase functions deploy … --use-api`:
   - `client-hub` (version 1) and `portal-notifications` (version 1), new;
   - `client-files` (version 3) and `project-assistant` (version 2), re-deployed.
5. **Smoke test with harmless requests:**
   - `client-hub`:
     - refuses a request without an origin (403);
     - answers the CORS preflight from the app's origin (204);
     - rejects a malformed invitation token (404);
     - reports a well-formed unknown token as invalid (200, through the database);
     - asks for sign-in on uploads (401).
   - `portal-notifications` refuses a call without the worker secret (401).
   - `client-files` and `project-assistant` ask for sign-in (401).
6. **Secrets:**
   - set: `PORTAL_ALLOWED_ORIGINS`, `DISCOVERY_ALLOWED_ORIGINS`, `RESEND_API_KEY`, `NOTIFICATION_FROM` and `NOTIFICATION_WORKER_SECRET`;
   - **`APP_URL` isn't set**, so the worker won't claim or send portal email.

7. **Frontend:** commit `e5ac376` was fast-forwarded to `main`, and Vercel reported the production deployment complete.
8. **New production address:** production moved from `https://leadflow-tau-five.vercel.app`, which now answers "deployment not found", to **`https://leadflowglobal.vercel.app`**.
   - On the new address:
     - every route answers 200;
     - the bundles contain the client portal and the new agency screens;
     - `/portal` is served with `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`;
     - no bundle contains the old address.
   - Every Edge Function refused the new origin (403). At the owner's request, these secrets were set:
     - `DISCOVERY_ALLOWED_ORIGINS`, `PORTAL_ALLOWED_ORIGINS` and `INQUIRY_ALLOWED_ORIGINS` = `https://leadflowglobal.vercel.app,https://leadflow-tau-five.vercel.app,http://localhost:5173`;
     - `PORTAL_URL=https://leadflowglobal.vercel.app/client-portal`;
     - `APP_URL=https://leadflowglobal.vercel.app`.
   - Afterwards, all nine origin-checked functions accept both addresses and still refuse an unknown origin (403).
   - **Supabase Auth.** The hosted Site URL was `http://localhost:3000`, and the only redirect URL was the old address's `/app`. So sign-up confirmations and password resets from the new address would have fallen back to localhost.
     - `npx supabase config push`, from a file declaring only these two settings and checked first with `config diff`, set:
       - the Site URL to `https://leadflowglobal.vercel.app`;
       - the redirect URLs to the new address's `/app`, `/portal/reset` and `/**`, plus the old address's `/app`.
     - A fresh `config pull` confirmed both, with every other Auth setting unchanged.
   - **Live browser check on the new address:**
     - the marketing pages, sign-in, the `/app` redirect, portal sign-in and forgot password work;
     - the invitation page reaches `client-hub` across origins;
     - the onboarding link page loads;
     - **the inquiry form's Turnstile widget shows error 110200 (hostname not authorized)**.

Before the frontend went out, the rollout was backward compatible with the deployed (M11) frontend:
- the redefined functions only add fields, or refuse client accounts;
- `client-files` and `project-assistant` keep their M11 behaviour.

**Still to do** (dashboard settings, not code):
- ~~Supabase Auth Site URL and redirect URLs~~ (done, see above).
- **Cloudflare Turnstile:** add `leadflowglobal.vercel.app` to the widget's hostnames. Until then, the inquiry form's CAPTCHA fails with error 110200 (confirmed on the live site).
- **Email:** schedule `portal-notifications` (POST with `x-worker-secret`, every few minutes).
- **Checks:** the manual checks below, on the new address.

## Manual verification (hosted)

1. **Invite and activate:**
   1. As an owner, open a client → **Portal access** → **Invite**.
   2. Copy the link and open it in a private window.
   3. Set a password; you land on the portal.
   4. In the app, the person shows as active, and the owner gets "joined the client portal".
2. **Sharing:**
   1. In a project's **Client portal** tab, share the project and write the summary.
   2. Show one milestone. **Preview as client** matches what the client sees.
   3. The client sees no money, notes, brief, health or hidden items.
3. **Review cycle:**
   1. On a deliverable, start a version, upload a PDF and request a review.
   2. As the client, open it: the agency sees "opened".
   3. Request changes with two feedback items and an attachment.
   4. As the agency, reply to one item (visible to the client) and add an internal note: the client sees only the reply.
   5. Upload version 2 and request review: the status is "Resubmitted".
   6. Approve as the client: the approval names version 2, and version 1 keeps "Changes requested".
4. **Boundaries:**
   - A second client's person can't open the first client's project URL (they see "not found").
   - A client account at `/app` sees the client-account notice.
   - Revoke the person, and their next click shows no access.
5. **Files:**
   - A shared project file downloads.
   - An internal file doesn't appear.
   - The download link stops working after a minute.
6. **Email** (once configured):
   - Run the worker.
   - The invitation and notification emails arrive with working links.
   - The outbox rows show `accepted`.
7. **Password recovery:** "Forgot password" on `/portal` sends the reset email, and `/portal/reset` sets a new password.

## Tests

See the verification ledger in [DEVELOPMENT_ROADMAP.md](../DEVELOPMENT_ROADMAP.md#current-verification-ledger) for the latest results.

- **`npm run test:collaboration`**: the real migration in embedded PostgreSQL. It covers:
  - grants and RLS;
  - invitations: hashing, single use, expiry, renewal, revocation, email match, and members refused;
  - client accounts refused by agency functions, with no workspace creation;
  - visibility before and after sharing, and per-person project access;
  - cross-client and cross-workspace denial (including IDOR attempts on projects, deliverables, reviews, comments, files and notifications);
  - role permissions;
  - versions, reviews, decisions (immutable, per version), feedback, resubmission, withdrawal, rejection and hiding;
  - comment visibility, replies, edit/delete history and plain text;
  - unread state;
  - published and corrected updates;
  - file access per scope, upload validation, and the review record kept;
  - notifications, dedupe and preferences;
  - the email outbox (composition, retries, cancellation, payload clearing);
  - `client-hub` (origin, activation, account-exists path, checked uploads, downloads, removals);
  - the worker (secret, configuration, outage and retry, one email per job);
  - the collaboration assistant (fact citations, escaping, internal notes excluded from reply drafts, not configured);
  - rollback and re-apply.
- **`tests/collaboration.spec.ts`**: the agency and client UIs end to end in the browser.
- Every earlier suite runs with M12 applied (and rolls it back first where it tests earlier rollbacks).

## Known limitations

- No real-time updates: pages fetch when opened. Notifications aren't pushed.
- **Client admins can't invite or manage** other client people; the agency does.
- Agency email notifications go to the project owner, or owners and admins. There's no per-project subscription.
- "Viewed" means a client person opened the deliverable page while a review was open. File downloads aren't tracked as views.
- Password-recovery emails depend on Supabase Auth's email settings. Portal emails depend on Resend, `APP_URL` and a scheduler; none is set up by the migration.
- Out of scope, as specified: chat, video, billing, contracts or e-signatures, time tracking, resource scheduling, external sync, automation builders, automated scope or deadline changes, AI approvals.
