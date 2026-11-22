# Sales pipeline and deal management (M9)

Status: **implemented and verified locally, 23 November 2026.** Migration `202611230001_sales_pipeline.sql` has **not** been applied to the hosted project, and the frontend has not been deployed. No Edge Function was added or changed.

M9 turns leads into deals and tracks them to won or lost. It builds on what exists: leads and the workspace snapshot (M2), follow-up tasks, business report opportunities (M7), contacts and outreach drafts (M8), client onboarding (M6A) and workspace roles. It is not a separate CRM.

## What you can do

| Where | What |
|---|---|
| **Sales pipeline** (sidebar → Sales) | Board of deals by stage, or a sortable, paged list. Summary of open, weighted and recently won value per currency. Search, owner and priority filters. Drag a card to another stage, or use its **Move** menu (works with a keyboard and on phones). |
| **New deal** | From the pipeline, a lead's drawer (**Deals → New deal**), an opportunity in a business report (**Create deal**), after marking outreach sent (**Track this conversation as a deal?**), or the command menu. The deal keeps its lead, contact, opportunity, service and source draft. |
| **Deal view** | Overview (stage, value, probability, weighted value, expected close, owner, priority, business, contacts, opportunity with its findings, stage history, other deals with the lead), Timeline, Follow-ups & meetings, Outreach. |
| **Timeline** | One list of the deal's notes, calls, replies, proposals, stage changes, meetings, follow-ups (planned, completed, cancelled), the lead's outreach drafts (drafted, edited, sent, replied), contacts added and the lead's activity history. Filters by kind, newest first, with paging. |
| **Follow-ups** | The existing follow-up tasks, now with a type, priority, details, optional deal, contact and assignee, and cancellation. New filters: Today, Assigned to me, Deals, Cancelled. |
| **Meetings and calls** | Schedule, reschedule, complete, cancel or mark no-show; log calls with an outcome and next action. |
| **Won / lost / reopen** | Won asks for the final value and close date. Lost asks for a reason from the workspace's list. Reopening is explicit and keeps the close details in the timeline. |
| **Client handoff** | For a won deal, **Hand off to client work…** records one handoff with a snapshot of the deal, contacts and notes, after confirmation. It creates no client or account and sends nothing; **Start client onboarding** then opens the existing onboarding with the lead filled in. A handed-off deal can't be reopened. |
| **Sales analytics** | Period presets (7, 30, 90 days, this quarter, this year, custom). Open and weighted pipeline, won and lost value per currency, win rate, average won deal, average sales cycle, deals by stage, lost reasons, sources, services, overdue follow-ups and deals closing soon. |
| **Pipeline settings** | Owners and admins: rename, recolour, set default probability, add, reorder, archive (moving the stage's deals to another stage of the same kind) and restore stages; currencies, default currency, lost reasons and the stage new deals start in. Members can see the settings. |
| **Notifications** | The bell adds meetings in the next 48 hours and deals whose expected close date is within 3 days or past, next to due follow-ups (now marked "Assigned to you" when they are). |

## Definitions

- **Open pipeline:** the sum of values of open, non-archived deals, **per currency**. Deals without a value are counted separately.
- **Weighted value:** value × probability. The deal's own probability, or its stage's default when it has none. A deal with neither counts as 0.
- **Won value:** the final value confirmed when the deal was marked won (defaults to the deal value).
- **Win rate:** won ÷ (won + lost) among deals whose close date falls in the period. Open deals don't count. With no closed deals, it shows "—". With fewer than 5 closed deals, a caution explains the small sample.
- **Average sales cycle:** days from creation to close date, for deals won in the period.
- **Periods** are inclusive local calendar dates; "Last 7 days" includes today.
- **Currencies are never converted or added together.** There are no exchange rates in LeadFlow.
- Archived deals are left out of the board, list (unless asked), analytics and reminders.

## What is automatic and what isn't

Nothing in M9 sends a message, an invitation or a notification outside the app, and nothing changes a deal's stage on its own.

- After a person records a positive or neutral reply, an "interested" call, a sent proposal or a scheduled meeting, the deal view **offers** the matching stage (Replied, Interested, Proposal sent, Meeting scheduled) if the deal is behind it. It moves only if they click **Move to …**.
- After a person marks an outreach draft **sent** or **replied** in the outreach studio, the lead's open deals that are behind Contacted or Replied are listed with a **Move to …** button each. With no open deal, it offers to create one.
- Suggestions use the stage each default stage came from (`key`), so they still work after a stage is renamed. A stage added later has no key and is never suggested.
- LeadFlow doesn't read inboxes or calendars. Replies and meetings exist only when someone records them.
- The optional AI sales assistant from the brief was **not built**. Deal summaries and next-step suggestions would need the AI provider and evidence rules M7/M8 use; it's listed below as future work.

## Data model

All tables are in `leadflow_private`, with RLS enabled and no client privileges. Members use role-checked `security definer` functions in `public`, which take the caller from `auth.uid()` and check membership and role on every call. Workspace IDs from the browser only select a workspace.

| Table | Purpose |
|---|---|
| `sales_stages` | Per-workspace stages: name (unique among active stages), colour, position, category (`open`, `won`, `lost`), default probability, `key` for the ten defaults, `archived_at`. Created on first use. |
| `sales_settings` | Currencies, default currency (must be one of them), lost reasons, default stage. |
| `deals` | Lead (by ID, like analyses and contacts, because snapshot saves replace leads), title, description, stage and outcome, optional contact, opportunity, service and source draft (snapshots kept if those are removed), value, currency, probability, expected and actual close dates, won value and notes, lost reason and notes, priority, owner, notes, `version`, timestamps, `archived_at`, `request_id` (unique per workspace). |
| `deal_stage_history` | Every stage change with the stage names at the time, who moved it and when, and the request ID (unique) for idempotent moves. |
| `deal_activities` | Notes, replies, calls, proposals, meetings, value and detail changes, won, lost, reopened, archived, restored, handoff. |
| `deal_meetings` | Title, start, duration, time zone, location, link (http/https only), agenda, notes, status, contact, version. |
| `client_handoffs` | One per won deal (unique), with a snapshot of the deal and contacts, the note and who confirmed it. For M10. |
| `public.follow_up_tasks` (existing) | New optional columns: `dealId`, `contactId`, `taskType`, `priority`, `cancelled`, `description`, `assigneeId`, `createdAt`, `completedAt`. Composite foreign keys keep the deal and contact in the task's workspace; a trigger checks they belong to the task's lead and that a new assignee is a member. |

Indexes cover the board (workspace, stage, updated), list filters (lead, owner, outcome and close date), history and activity per deal, upcoming meetings and deal tasks.

### Concurrency, idempotency and integrity

- Edits, moves, closing and reopening send the deal `version` they started from; a stale version is refused (`40001`) and the UI reloads and explains. On the board, the card moves at once and goes back if the save fails.
- Creating a deal, moving, closing, reopening, recording an activity and scheduling a meeting take a request ID; repeating it returns the first result instead of acting twice.
- A second open deal for the same lead with the same opportunity or title is refused (`P0409`, with the existing deal's ID) unless the person chooses **Create another deal**.
- Each stage change writes history and the timeline entry in the same transaction as the move.
- Stages are archived, never deleted. Archiving one with deals requires a target stage of the same kind; each moved deal gets a history entry. The last active open, won or lost stage can't be archived. A stage's kind can only change while it has no deals.
- Deals are archived, not deleted. Members can archive deals they created or own; owners and admins any deal.
- A lead removed from the workspace leaves its deals and their history in place; the deal view says the lead was removed. Deleting a contact clears it from deals and tasks.
- Follow-up tasks still save with the workspace snapshot, so the existing rules apply: members can't remove tasks or rewrite history, and stale revisions are refused. Clients from before M9 keep working: missing fields get defaults. An assignee who leaves the workspace stays on tasks they already had.

### Functions

Signed-in members (owner, admin, member) call: `sales_pipeline_for`, `deals_for`, `pipeline_board_for`, `deal_detail`, `deal_timeline`, `create_deal`, `update_deal`, `move_deal`, `close_deal`, `reopen_deal`, `set_deal_archived`, `record_deal_activity`, `save_deal_meeting`, `confirm_client_handoff`, `sales_analytics`, `sales_reminders_for`. Owners and admins only: `save_sales_stage`, `reorder_sales_stages`, `archive_sales_stage`, `restore_sales_stage`, `save_sales_settings`. `test:tenancy` asserts this exact list.

## Deploying

1. Apply `supabase/migrations/202611230001_sales_pipeline.sql` (after `202611190001`). It also redefines `save_workspace_for` to store the new task fields; the previous definition is in the rollback.
2. Deploy the frontend. No Edge Function, secret or Cron job is needed.
3. Open **Sales pipeline** once as an owner: the default stages are created on first use. Review **Pipeline settings** (currencies, lost reasons).

Rollback: `supabase/rollbacks/202611230001_sales_pipeline.down.sql`, then `npx supabase migration repair --status reverted 202611230001`. It deletes every stage, deal, history entry, activity, meeting, handoff and the sales settings, and removes the new task columns (tasks themselves stay). Roll M9 back before M8 or M7, since deals reference contacts, drafts and opportunities.

## Tests

- `npm run test:sales` — the migration in embedded PostgreSQL: exact grants and private tables; default stages; stage configuration and roles; settings; deal creation from leads, opportunities and the pipeline with idempotency, duplicates and every reference checked; moves, version conflicts and replays; edits with value history; activities; meetings; deal-linked tasks through the snapshot; the merged timeline; detail, list, board and per-currency totals; won, lost, reopen and handoff; analytics by period; reminders; archiving; removed leads and contacts; workspace isolation; rollback and re-apply.
- `tests/sales.spec.ts` (Playwright, real UI against the same SQL): creating deals (pipeline, report opportunity, outreach), Move menu and drag and drop, duplicates, reply and meeting suggestions, follow-ups, won with final value, handoff and onboarding, lost from the board, list sorting, the Follow-ups page, analytics and a custom period; a lost race undone on the board; outreach-driven suggestions; pipeline settings (rename, add, reorder, archive with reassignment); the board on a phone.
- Existing suites were updated for the new task fields (`test:db`, `test:tenancy`), the new client functions (`test:tenancy`) and rollback order (`test:analysis`, `test:outreach`). The Supabase test double now returns PostgreSQL's DETAIL as `details`, as PostgREST does.
- `tests/screens.spec.ts` (visual review, not part of `npm test`) now also captures the board, list, new deal, deal tabs, won dialog, settings and analytics.

Results on 23 November 2026: all ten `test:*` database suites passed; `npx playwright test` 48/48; `npm run test:production` 48/48; lint, `tsc -b`, `check:edge` and `build` clean. See the [verification ledger](../DEVELOPMENT_ROADMAP.md#current-verification-ledger).

## Limitations and not built

- No AI sales assistant (deal summaries, next-step suggestions, risk notes). It would reuse the M7/M8 Gemini client and evidence rules; not started.
- No email, WhatsApp or calendar sending or syncing; no meeting invitations; no inbox reading.
- No exchange rates or a single "total in one currency".
- No custom deal fields, deal products or line items, quotes or proposals as documents, or forecasting beyond weighted value.
- No email or push notifications. Reminders show in the app's bell only, for whoever has the app open.
- The board shows up to 50 most recently active deals per stage (the list view pages through all of them), and won/lost columns show the last 90 days.
- Clients, portals, projects, contracts and invoicing are M10 and later. The handoff record is what M10 will start from.
