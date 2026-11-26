# Project and delivery management (M11)

Status: **implemented and verified locally, 26 November 2026; database and Edge Functions deployed the same day** (see [Hosted rollout](#hosted-rollout-26-november-2026)). The frontend went live the same day: commit `33e859a` on `main`, which Vercel builds for production. The real AI model and real Storage haven't been exercised on the hosted project yet.

M11 connects onboarded clients to delivery: **Client → confirmed scope → project setup → plan → execution → completion**. It builds on what exists rather than adding parallel systems:
- clients, contacts, confirmed services, requirements, the scope confirmation and the onboarding completion snapshot (M10);
- the workspace's follow-up tasks (M2/M9/M10), the client activity history and M10's private file storage;
- the Gemini client and AI usage ledger from M7/M8, and workspace roles.

**Files:**
- Migration: [`supabase/migrations/202611260001_project_delivery.sql`](../supabase/migrations/202611260001_project_delivery.sql)
- Rollback: [`supabase/rollbacks/202611260001_project_delivery.down.sql`](../supabase/rollbacks/202611260001_project_delivery.down.sql)
- Edge Functions:
  - [`project-assistant`](../supabase/functions/project-assistant/handler.ts) (new), with its prompt and checks in [`_shared/projects/assistant.ts`](../supabase/functions/_shared/projects/assistant.ts);
  - [`client-files`](../supabase/functions/client-files/handler.ts) (project links and previews).
- UI:
  - `Projects.tsx`: overview, all projects, my tasks, calendar and templates;
  - `NewProjectDialog.tsx`, `ProjectTemplates.tsx`, `ProjectCalendar.tsx`, and `ClientProjects.tsx` (the client's Projects tab);
  - `ProjectWorkspace.tsx`, with `ProjectTimeline`, `ProjectPlanning`, `ProjectTasks`, `ProjectFiles`, `ProjectActivity` and `ProjectAssistant`;
  - `ProjectBits.tsx`: status, health and progress.
- Data access: [`src/lib/projects.ts`](../src/lib/projects.ts); project tasks are in [`src/lib/model.ts`](../src/lib/model.ts).

## Project lifecycle

1. **Create.** There are three entry points:
   - **from a completed onboarding**: the client's Projects tab or New project. The setup starts from the M10 completion snapshot, which is what was agreed when onboarding was completed;
   - **from a client**: the client's currently *confirmed* services and requirements;
   - **by hand**: blank, for any non-archived client.

   Before anything is created, the setup review shows:
   - the client, its contacts and confirmed services;
   - a brief composed from **confirmed** requirements (objectives, success criteria, expectations, dependencies, constraints, assumptions), the services' agreed scope and exclusions, and the open questions and completion note;
   - the client's files and important dates;
   - a plan from a template (milestones, deliverables and tasks with dates from the start date), with deliverables suggested from the services' deliverables text.

   **What carries over:**
   - The member edits everything, and unticks or renames any part of the plan.
   - Draft and under-review requirements, proposed services, and requirements confirmed after completion never appear.
   - Only services the client still has confirmed can be linked.
   - Creation is one transaction: the project, its links, the plan and its first history entries. Retrying the same request returns the same project. A client can have any number of projects.
2. **Plan.**
   - **Milestones:** ordered, with start and due dates, a status and dependencies on other milestones of the project.
   - **Deliverables:** in a milestone or not, with owner, due date, priority, internal status and linked service.
   - **Tasks:** the work itself.
   - **More planning later:** templates and approved AI suggestions can add milestones, deliverables and tasks at any time.
3. **Execute.**
   - Move tasks across the board or edit them in the list.
   - Complete deliverables and milestones.
   - Upload files, write internal notes, and watch progress and health.
4. **Finish.**
   - Completing a project is an explicit status change; it never happens because tasks were ticked. Completing with open tasks, deliverables or milestones requires a reason, which is kept.
   - Cancelling requires a reason.
   - A completed or cancelled project can be reopened, which clears its completion date.

### Statuses

| Status | Meaning |
|---|---|
| Planning | Default for new projects: scope and plan being set up. |
| Not started | Planned, work not begun. |
| In progress | Work under way. |
| On hold | Paused (a reason can be recorded). Resuming is recorded. |
| At risk | Set by the team. Also feeds health, see below. |
| Completed | Explicitly completed; the actual completion date is recorded. |
| Cancelled | Cancelled with a reason. |

These seven statuses are fixed. They aren't customizable per workspace: health covers the computed side, and fixed statuses keep reports comparable.

**Milestone statuses:** upcoming, in progress, completed, delayed, cancelled.

**Deliverable statuses:** not started, in progress, internal review, ready for client review, completed, blocked. These are internal: there is no client approval in M11.

**Task work statuses:** to do, in progress, in review, blocked. "Completed" and "cancelled" are the existing task flags.

## Progress

Computed in the database from recorded completion; there is no editable percentage.
- **The basis:**
  - if the project has deliverables, progress = completed deliverables ÷ all deliverables;
  - otherwise, completed tasks ÷ tasks that aren't cancelled;
  - with neither, 0% and "No deliverables or tasks yet".
- The two are **never mixed**. The UI always names the basis ("3 of 5 deliverables completed").
- Milestone completion is shown separately and doesn't affect the percentage.

## Health

Computed from measurable conditions; never an AI judgment. Each state lists its reasons.
- **Completed, Cancelled, On hold:** the project's status.
- **Delayed** when the target completion date has passed, or a milestone that isn't completed or cancelled is past its due date.
- **At risk** (when not delayed) when any of these holds:
  - the team set the status to At risk;
  - a high-priority task is overdue;
  - three or more tasks are overdue;
  - a deliverable is past its due date;
  - a task or deliverable is blocked;
  - a milestone due within 7 days is past the halfway point of its schedule (counted from its start date, or a week before its due date) with less than half of its tasks and deliverables done.
- **On track** otherwise.

"Overdue" means a due date before today, in the workspace's time zone (Workspace settings).

## Tasks and dependencies

Project tasks are the workspace's existing follow-up tasks: the same list, Follow-ups page (filter **Projects**), notification bell and snapshot save. A project task:
- has a project, the project's client and no lead;
- can have a milestone and deliverable of the same project;
- has a work status, start and due dates, estimated and actual hours, labels, an assignee and dependencies.

The database checks every save:
- the project, milestone and deliverable belong together;
- labels are short;
- **dependencies** name tasks of the same project, never the task itself, and never form a circle (checked across the whole workspace with a recursive query).

The UI checks circles before saving, shows "Waiting for …" for open dependencies, and marks blocked work.

**Server-side task changes:**
- Creating a project with a plan, applying a plan, and removing a milestone or deliverable change tasks on the server.
- Those functions bump the workspace revision, and the UI reloads the snapshot.
- A session holding an older snapshot gets the usual conflict and reloads, rather than overwriting the new tasks.

## Views

| Where | What |
|---|---|
| **Projects → Overview** | Totals, active, planning, at risk + delayed, on hold, completed, overdue projects and overdue tasks (each filters the list); projects needing attention with their health reasons; deadlines in the next 14 days; recent project activity. |
| **All projects** | Search (name, client, description, tags); filters for status (open by default), health, client, owner, priority and type; sorting; paging. Rows show status, health, progress with basis, target date, owner and next deadline. |
| **My tasks** | Project tasks assigned to you: open, due today, overdue, upcoming, completed; complete or change work status. |
| **Calendar** | Month or week view, plus upcoming deadlines, for project target dates, milestones, deliverables and project tasks. Filters for client, project, open or done, and kinds. Phones get an agenda list. |
| **Templates** | Three starters, installed on first use: Website design & development, Digital marketing & SEO, AI automation & custom software. Owners and admins create, edit, archive and restore templates; members use them. Any project can be saved as a template (owners and admins), with its dates turned into day offsets. |
| **Project workspace** | Header with client, status, priority, owner, deadline, health and progress. Tabs: **Overview** (brief, dates, budget, deal, links), **Timeline** (Gantt-style), **Milestones**, **Deliverables** (list or by status), **Tasks** (list or board), **Files**, **Activity** (history and internal notes) and **Settings** (status, template, save as template). |
| **Client → Projects** | The client's projects and New project. The onboarding handoff record stays below them. |

The timeline is a straightforward Gantt-style view:
- the project span, milestone bars, deliverable markers and task bars, on a date axis with a today line;
- completed, outstanding and overdue styling, and dependency hints.

It doesn't reschedule, compute a critical path or level resources.

## Budget (lightweight)

- **Agreed value:** agreed with the client for *this* project; a client can have several projects with their own values.
- **Estimated and actual cost:** what the team records, in the project's currency.
- **The originating deal** is shown separately for reference. Its value is the whole deal and isn't assumed to be any project's value.
- **Budget used** is shown only when both an agreed value and an actual cost are recorded: actual cost ÷ agreed value.

There's no invoicing, payment or time tracking.

## Activity and notes

Project events go into the client's activity history with a project link, so they also appear on the client's timeline. They cover:
- the project: created, updated, status changes, paused and resumed, completed, cancelled and reopened;
- the plan: plans applied, deadlines changed, and owners changed;
- milestones and deliverables: added, updated, completed, status changed, assigned, reordered and removed.

The project timeline also shows tasks (planned, completed, cancelled) and files (uploaded, removed) from their own records. Milestones and deliverables each have a history.

Internal notes are append-only and idempotent. They are **never** returned by any client-facing function. Neither are project files, the brief, budget or activity: the portal only sees what M10 gave it.

## Files

Project files use M10's private `client-documents` bucket and the `client-files` function, with the same checks: type, size, content signature, pending until checked, and 60-second signed links.
- **Links:** a file can belong to the project, a milestone, a deliverable or a task, and the database checks they belong together.
- **Always internal:** project files can't be shared with the client (refused with a clear message), and the portal never lists them.
- **Preview:** images and PDFs (`preview`) open in the browser from a signed link without the download disposition, served from Storage's own domain. Everything else downloads.
- **Client files:** the client's onboarding files are listed next to the project's for reference.

## AI project assistant

`project-assistant` reuses the Gemini client of M7/M8. It uses `PROJECT_AI_MODEL` or else `ANALYSIS_AI_MODEL`.

**Operations:**
- **Summary:** overview, completed, outstanding, blockers and upcoming.
- **Risks:** each tied to recorded facts.
- **Plan:** milestones, deliverables and tasks, optionally following a template.
- **Breakdown:** tasks for one deliverable.

**Guardrails:**
- **Facts first.** The project's recorded data is reduced to numbered facts (status, dates, progress, health reasons, overdue and blocked work, upcoming and completed items). They are shown to the member as they are, separately from the suggestions.
- **Suggestions only.** The function never writes project records. A plan or breakdown becomes records only when the member reviews, edits and approves it ("Add selected"), through `apply_project_plan`; the history records "suggested by the AI assistant and approved". It never changes status, deadlines or assignments.
- **Untrusted data stays data:**
  - the project data, including client-written requirements and the brief, is sent as JSON inside `<project_data>` tags, with `<` escaped so it can't close the block;
  - the system prompt says to treat it as data and to ignore instructions inside it;
  - member instructions are limited to 500 characters and can't override the rules.
- **Strict validation:**
  - answers must match a JSON schema, and lengths and counts are capped;
  - invalid dates are dropped;
  - links to milestones or deliverables that aren't in the plan are removed;
  - circular dependencies are removed, and deliverables that already exist aren't suggested again;
  - risks not tied to a recorded fact are dropped;
  - empty answers are rejected;
  - every adjustment is listed as a warning.
- **Limits:**
  - `PROJECT_AI_MONTHLY_LIMIT` requests per workspace per month (default 200), counted before the model is called, in the same usage ledger as outreach (operation `project_*`);
  - a per-minute rate limit;
  - one retry after a timeout.

Without `GEMINI_API_KEY` the assistant says it isn't set up; everything else works without AI.

## Data model and functions

All tables are in `leadflow_private` with RLS and no client privileges:
- `projects`
- `project_services` and `project_contacts` (links)
- `project_milestones`
- `project_deliverables`
- `project_templates` and `project_template_milestones` (deliverables and tasks as validated JSON)

Changed tables:
- `public.follow_up_tasks`: `projectId`, `milestoneId`, `deliverableId`, `status`, `startDate`, `estimateHours`, `actualHours`, `labels`, `dependsOn` and the `delivery` task type;
- `client_activities`: `project_id`;
- `client_documents`: `project_id`, `milestone_id`, `deliverable_id`, `task_id`.

Composite foreign keys keep everything in its workspace. The task trigger checks project, client, milestone and deliverable consistency.

**Signed-in members** (owner, admin or member) call:
- projects: `project_setup_for`, `create_project`, `apply_project_plan`, `update_project`, `set_project_status`, `add_project_note`;
- reading: `project_index_for`, `projects_for`, `project_detail`, `projects_dashboard_for`, `project_timeline`, `project_entity_history`, `project_calendar_for`;
- milestones and deliverables: `save_project_milestone`, `reorder_project_milestones`, `remove_project_milestone`, `save_project_deliverable`, `remove_project_deliverable`;
- templates: `project_templates_for`, `project_template_for`, `save_project_template`, `set_project_template_archived`, `save_project_as_template`, `project_template_plan`;
- files and AI: `project_documents_for`, `project_ai_context`.

**Inside them, roles narrow further:** template editing and saving a project as a template are for owners and admins, and file deletion follows M10's rules.

**The service role** (Edge Functions only) calls `project_ai_reserve`.

**Redefined from M10:** `save_workspace_for`, the task trigger, `document_json`, `begin_client_document` and `update_client_document`. The rollback restores them.

**Integrity:**
- every function finds records inside the caller's workspace, so a workspace ID from the browser only selects one;
- archived clients make their projects read-only (`55000`);
- edits are versioned (`40001`), and creations are idempotent per request ID;
- limits (`54000`): 2,000 projects per workspace, 100 milestones, 500 deliverables and 1,000 tasks per project, 100 templates.

## Hosted rollout (26 November 2026)

Done at the owner's request, on project `fzgxpwmqzmvgmijviaar`:
1. **Before:** a read-only check found no M11 tables, columns or functions on the hosted database. `npx supabase db push --remote` then applied `202611260001`.
2. **Read-only checks afterwards:**
   - the migration history lists it;
   - all 7 new tables exist, and every `leadflow_private` table has RLS with no `anon` or `authenticated` read access;
   - `anon` can run none of the new functions, and members can run all 26 member functions but none of the new private helpers;
   - only the service role can run `project_ai_reserve`;
   - `follow_up_tasks` has the 9 new columns, and no existing task changed.
3. **Functions:** deployed `project-assistant` (version 1) and re-deployed `client-files` (version 2), both `verify_jwt = false`.
4. **Smoke test with harmless requests:**
   - `project-assistant` refuses a request without an origin (403);
   - from the app's origin without a session it asks for sign-in (401), and the CORS preflight returns 204;
   - `client-files` asks for sign-in (401).
5. **Secrets:** `GEMINI_API_KEY` is set, so the assistant is configured. `PROJECT_AI_MONTHLY_LIMIT` isn't set, so the limit is 200 requests per workspace per month.
6. **Frontend:** `33e859a` was pushed to `main`. Vercel reported the production deployment complete, the live bundles contain the Projects workspace and the new home page demos, and `/`, `/features`, `/pricing`, `/app` and `/login` return 200.

**Still to do:** the manual checks in step 6 below (they also exercise the real Gemini model and Storage).

## Deploying (reference; steps 1–5 were done on 26 November 2026, see above)

1. Apply `202611260001_project_delivery.sql` with `npx supabase db push --remote`.
2. Deploy `project-assistant`: `npx supabase functions deploy project-assistant --use-api`. `config.toml` sets `verify_jwt = false`, because the function checks the caller through the database.
3. Re-deploy `client-files`, which gained project links and `preview`.
4. Secrets:
   - optional `PROJECT_AI_MONTHLY_LIMIT` (default 200) and `PROJECT_AI_MODEL`;
   - `GEMINI_API_KEY` is already used by M7/M8;
   - the allowed-origin secrets are the same as `client-files`.
5. Deploy the frontend.
6. Check by hand:
   - create a project from a completed onboarding and one by hand;
   - move tasks on the board;
   - try a circular dependency;
   - upload and preview a PDF;
   - run each assistant operation and add an approved plan;
   - check the portal doesn't show project files.

**Rollback:**
1. Run `supabase/rollbacks/202611260001_project_delivery.down.sql`, then `npx supabase migration repair --status reverted 202611260001`.
2. It deletes projects, milestones, deliverables and project templates, and the project links of tasks, files and history.
3. Project tasks stay as tasks of the client, and `delivery` tasks become `custom`.
4. Project events and notes stay in the client's history. Files stay in storage as internal client files.
5. Roll M11 back before M10.

## Tests

- `npm run test:projects` runs the migration in embedded PostgreSQL, with the real `client-files`, `client-portal` and `project-assistant` handlers; Storage and the AI model are simulated. It covers:
  - grants and private tables;
  - templates;
  - setup from the completion snapshot, confirmed scope only;
  - creation: transactional and idempotent, guards, several projects per client;
  - snapshot tasks with dependency and cycle checks, and stale sessions after server-side task writes;
  - edits, milestones (dependencies, order, removal, history) and deliverables;
  - progress and every health rule;
  - status rules;
  - lists, dashboard, calendar and timeline paging;
  - notes, files (internal, preview, portal exclusion) and plans;
  - save as template;
  - the assistant: facts, injection containment, validation, approval, risks, breakdown, limit;
  - isolation, archived clients and rollback.
- `tests/projects.spec.ts` (Playwright): the UI end to end.
- **Existing suites updated:** the new task fields (`test:db`, `test:tenancy`, `test:sales`), the function allowlist (`test:tenancy`), M11-first rollback order (`test:onboarding`, `test:sales`, `test:clients`, `test:outreach`, `test:analysis`) and the client Projects tab (`tests/clients.spec.ts`).

Results on 26 November 2026: all 12 `test:*` database suites passed; `npx playwright test` 53/53; `npm run test:production` 53/53; lint, `tsc -b`, `check:edge` and `build` clean. See the [verification ledger](../DEVELOPMENT_ROADMAP.md#current-verification-ledger).

## M12 changes

[M12](CLIENT-COLLABORATION.md) lets the agency share projects with the client portal:
- Project files can now be **shared**, and the portal checks project access on every download. Onboarding links still never show project files.
- Milestones and deliverables gain a client-visible flag. Deliverables gain a client review status, kept apart from the internal statuses above.

## Known limitations

- No client-facing project portal, client approvals, revision requests, comments or messaging (later milestone).
- **Planning:** no time tracking or timesheets, resource capacity planning, critical path or automatic rescheduling. The timeline doesn't drag to reschedule.
- **Calendar:** no external calendar sync and no notifications outside the app.
- **Statuses:** project statuses are fixed, not customizable per workspace.
- **Tasks:** they share the workspace snapshot's limits (10,000 tasks in all). Per-task comments use the description and the project's notes.
- **Files:** project files can't be shared with the client yet. Previews cover images and PDFs only, with no antivirus scanning (as in M10).
- **AI:** summaries and risks are suggestions from recorded data. The quality of plans depends on the brief, and every plan needs review.
