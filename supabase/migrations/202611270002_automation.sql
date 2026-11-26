-- M13: automation and workflow engine, part 1. Tables, the trigger and action registry, the condition engine, workflow
-- validation and compilation, and event capture from existing modules. Part 2 (202611270003_automation_engine.sql) holds
-- the execution engine, actions and the member functions. See docs/AUTOMATION.md.
--
-- Every table is private (leadflow_private, no client privileges). Members reach it through role-checked functions;
-- the automation-worker and automation-webhook Edge Functions use service-role functions. Nothing here executes code a
-- user wrote: workflows are data (a trigger, conditions over registered fields, and registered actions).

-- ---------- Tables ----------

-- Workspace switch: when paused, no new runs start and queued runs wait.
create table leadflow_private.automation_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  paused boolean not null default false,
  paused_reason text not null default '' check (length(paused_reason) <= 300),
  -- When the worker last advanced a run of this workspace: the worker serves workspaces in turn.
  served_at timestamptz,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table leadflow_private.automation_workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 1000),
  status text not null default 'draft' check (status in ('draft','active','paused','archived')),
  -- The editable draft: { trigger: { type, config, filter }, steps: [...] }. Published copies live in automation_versions.
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 60000),
  -- Increases on every change, for optimistic concurrency.
  version integer not null default 1,
  -- True when the draft differs from the published version.
  draft_changed boolean not null default true,
  published_version_id uuid,
  -- From the published version, for matching events (indexed).
  trigger_type text,
  -- Scheduled triggers and scheduled checks: when the worker next looks.
  next_fire_at timestamptz,
  -- Why the workflow needs attention (safety pause, throttling, repeated failures), shown in the Automation Center.
  attention_code text check (attention_code ~ '^[a-z_]{1,40}$'),
  attention text check (length(attention) <= 300),
  attention_at timestamptz,
  template_key text check (template_key ~ '^[a-z_]{1,40}$'),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  archived_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, request_id),
  check ((status = 'archived') = (archived_at is not null))
);
create index automation_workflows_match on leadflow_private.automation_workflows(workspace_id, trigger_type) where status = 'active';
create index automation_workflows_due on leadflow_private.automation_workflows(next_fire_at) where status = 'active' and next_fire_at is not null;
create index automation_workflows_list on leadflow_private.automation_workflows(workspace_id, updated_at desc);

-- Published versions are immutable. A run always references the exact version it executes; "test" versions hold the draft
-- a person ran as a live test and never match events.
create table leadflow_private.automation_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  workflow_id uuid not null,
  kind text not null default 'published' check (kind in ('published','test')),
  number integer check (number > 0),
  name text not null,
  definition jsonb not null,
  compiled jsonb not null,
  trigger_type text not null,
  -- The member whose authority the version's actions run with. Checked again on every action.
  published_by uuid references public.profiles(id) on delete set null,
  publisher_role text not null check (publisher_role in ('owner','admin','member')),
  note text not null default '' check (length(note) <= 300),
  published_at timestamptz not null default now(),
  unique (workflow_id, number),
  unique (workspace_id, id),
  check ((kind = 'published') = (number is not null)),
  foreign key (workspace_id, workflow_id) references leadflow_private.automation_workflows(workspace_id, id) on delete cascade
);
alter table leadflow_private.automation_workflows add constraint automation_workflows_published foreign key (published_version_id)
  references leadflow_private.automation_versions(id) on delete set null;

-- A transactional outbox of observed events. Written in the same transaction as the business change, and only when an
-- active workflow or a waiting run listens. dedupe_key makes repeated deliveries one event.
create table leadflow_private.automation_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_type text not null check (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type text not null check (entity_type ~ '^[a-z_]{1,30}$'),
  entity_id text not null check (length(entity_id) between 1 and 200),
  -- Keys a waiting run can match, e.g. lead:<id>, deliverable:<id>.
  keys text[] not null default '{}',
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 16000),
  source text not null default 'app' check (source in ('app','schedule','webhook')),
  dedupe_key text not null check (length(dedupe_key) between 1 and 300),
  -- Workflows whose actions caused this event, for loop protection.
  chain uuid[] not null default '{}',
  occurred_at timestamptz not null default now(),
  unique (workspace_id, dedupe_key)
);
create index automation_events_time on leadflow_private.automation_events(occurred_at);

create table leadflow_private.automation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  workflow_id uuid not null,
  version_id uuid not null references leadflow_private.automation_versions(id) on delete cascade,
  event_id uuid references leadflow_private.automation_events(id) on delete set null,
  -- live: started by an event. test: a live test a person confirmed, kept out of production metrics.
  mode text not null default 'live' check (mode in ('live','test')),
  status text not null default 'queued' check (status in ('queued','running','waiting','completed','failed','cancelled','attention')),
  -- How a finished run ended: completed, condition_not_met, wait_timed_out, loop_blocked, cancelled, failed...
  outcome text check (outcome ~ '^[a-z_]{1,40}$'),
  trigger_type text not null,
  entity_type text,
  entity_id text,
  -- { trigger, event, workspace, run, steps: { <nodeId>: output } }. Holds no credentials; see automation_redact.
  context jsonb not null default '{}' check (jsonb_typeof(context) = 'object' and octet_length(context::text) <= 120000),
  current_node text,
  next_run_at timestamptz not null default now(),
  -- An event wait: { node, event, key, until, onTimeout }.
  wait jsonb,
  lease_id uuid,
  lease_until timestamptz,
  -- Attempts of the current node; reset when a node completes.
  attempts integer not null default 0,
  retry_count integer not null default 0,
  steps_executed integer not null default 0,
  chain uuid[] not null default '{}',
  error_code text check (error_code ~ '^[a-z_]{1,40}$'),
  error_summary text check (length(error_summary) <= 500),
  failed_node text,
  started_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, workflow_id) references leadflow_private.automation_workflows(workspace_id, id) on delete cascade
);
-- One live run per workflow and event, however often the event is delivered.
create unique index automation_runs_event on leadflow_private.automation_runs(workflow_id, event_id) where event_id is not null and mode = 'live';
create index automation_runs_due on leadflow_private.automation_runs(next_run_at) where status in ('queued','waiting');
create index automation_runs_running on leadflow_private.automation_runs(workspace_id) where status = 'running';
create index automation_runs_waits on leadflow_private.automation_runs(workspace_id, ((wait->>'event'))) where status = 'waiting' and wait is not null;
create index automation_runs_history on leadflow_private.automation_runs(workspace_id, created_at desc, id desc);
create index automation_runs_workflow on leadflow_private.automation_runs(workflow_id, created_at desc);

create table leadflow_private.automation_run_steps (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  run_id uuid not null references leadflow_private.automation_runs(id) on delete cascade,
  sequence integer not null,
  node_id text not null check (node_id ~ '^[a-z0-9_]{1,24}$'),
  node_type text not null check (node_type in ('condition','branch','action','delay','wait')),
  action_type text,
  label text not null default '' check (length(label) <= 120),
  status text not null check (status in ('completed','failed','skipped','waiting','retrying','cancelled')),
  attempt integer not null default 1,
  -- Condition and branch results, and what a wait or delay decided.
  result jsonb check (result is null or octet_length(result::text) <= 8000),
  -- Sanitized summaries: rendered inputs and outputs, cut to size, with secrets, emails and phone numbers removed.
  input jsonb check (input is null or octet_length(input::text) <= 6000),
  output jsonb check (output is null or octet_length(output::text) <= 6000),
  error_code text check (error_code ~ '^[a-z_]{1,40}$'),
  error_message text check (length(error_message) <= 500),
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index automation_run_steps_run on leadflow_private.automation_run_steps(run_id, sequence);

-- Signed webhook endpoints, one per workflow with a webhook trigger. No secret is stored: the signing key is derived on the
-- server from EMAIL_HASH_SECRET, the endpoint ID and secret_version. Rotation increases the version.
create table leadflow_private.automation_webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  workflow_id uuid not null unique,
  secret_version integer not null default 1 check (secret_version > 0),
  status text not null default 'active' check (status in ('active','revoked')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_received_at timestamptz,
  received_count integer not null default 0,
  rejected_count integer not null default 0,
  check ((status = 'revoked') = (revoked_at is not null)),
  foreign key (workspace_id, workflow_id) references leadflow_private.automation_workflows(workspace_id, id) on delete cascade
);

-- Change detection for snapshot-saved leads and tasks: the last state seen per record, kept only while something listens.
create table leadflow_private.automation_entity_state (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('lead','task')),
  entity_id text not null,
  state text not null,
  primary key (workspace_id, kind, entity_id)
);
create table leadflow_private.automation_tracking (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('lead','task')),
  since timestamptz not null default now(),
  primary key (workspace_id, kind)
);

-- Daily counters per workflow: dashboards read these instead of scanning runs, and future plans can cap them.
create table leadflow_private.automation_usage_daily (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  day date not null,
  workflow_id uuid not null,
  runs integer not null default 0,
  succeeded integer not null default 0,
  failed integer not null default 0,
  cancelled integer not null default 0,
  actions integer not null default 0,
  ai_actions integer not null default 0,
  email_actions integer not null default 0,
  duration_ms bigint not null default 0,
  finished integer not null default 0,
  throttled integer not null default 0,
  blocked integer not null default 0,
  test_runs integer not null default 0,
  primary key (workspace_id, day, workflow_id)
);

alter table leadflow_private.automation_settings enable row level security;
alter table leadflow_private.automation_workflows enable row level security;
alter table leadflow_private.automation_versions enable row level security;
alter table leadflow_private.automation_events enable row level security;
alter table leadflow_private.automation_runs enable row level security;
alter table leadflow_private.automation_run_steps enable row level security;
alter table leadflow_private.automation_webhooks enable row level security;
alter table leadflow_private.automation_entity_state enable row level security;
alter table leadflow_private.automation_tracking enable row level security;
alter table leadflow_private.automation_usage_daily enable row level security;
revoke all on leadflow_private.automation_settings, leadflow_private.automation_workflows, leadflow_private.automation_versions, leadflow_private.automation_events,
  leadflow_private.automation_runs, leadflow_private.automation_run_steps, leadflow_private.automation_webhooks, leadflow_private.automation_entity_state,
  leadflow_private.automation_tracking, leadflow_private.automation_usage_daily from public, anon, authenticated;

-- Published versions and their history are never edited.
create function leadflow_private.automation_refuse_change() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'A published workflow version can''t be changed. Edit the draft and publish a new version.' using errcode = '55000';
end $$;
create trigger automation_versions_immutable before update on leadflow_private.automation_versions for each row execute function leadflow_private.automation_refuse_change();

-- ---------- Limits ----------

create function leadflow_private.automation_limits() returns jsonb language sql immutable set search_path = '' as $$
  select '{"workflowsPerWorkspace":100,"nodesPerWorkflow":40,"branchDepth":3,"casesPerBranch":5,"conditionDepth":3,"conditionsPerGroup":10,
    "conditionsPerWorkflow":60,"chainDepth":3,"runsPerWorkflowHour":100,"runsPerWorkspaceHour":1000,"concurrentRunsPerWorkspace":3,
    "stepsPerAdvance":10,"maxStepsPerRun":100,"maxRunDays":30,"maxDelayDays":90,"maxWaitDays":30,"maxRetries":3,"stepTimeoutSeconds":20,"eventRetentionDays":30,
    "runRetentionDays":180,"webhookFields":20,"webhookToleranceSeconds":300}'::jsonb
$$;

-- ---------- Registry ----------

-- Fields per kind of record, as variables. Paths are relative; triggers and actions add their prefix. No field holds an
-- email address, phone number, credential or internal note: workflows see what they need to decide and to write a title.
create function leadflow_private.automation_entity_fields(entity text) returns jsonb language sql immutable set search_path = '' as $$
  select case entity
    when 'lead' then '[{"path":"id","label":"Lead","type":"ref","entity":"lead"},{"path":"name","label":"Lead name","type":"text"},{"path":"company","label":"Company","type":"text"},
      {"path":"website","label":"Website","type":"text"},{"path":"hasWebsite","label":"Has a website","type":"boolean"},{"path":"hasEmail","label":"Has an email address","type":"boolean"},
      {"path":"hasPhone","label":"Has a phone number","type":"boolean"},{"path":"status","label":"Lead status","type":"enum","options":["New","Contacted","Qualified","Converted","Lost"]},
      {"path":"source","label":"Lead source","type":"text"},{"path":"service","label":"Service of interest","type":"text"},{"path":"industry","label":"Industry","type":"text"},
      {"path":"city","label":"City","type":"text"},{"path":"country","label":"Country","type":"text"},{"path":"createdAt","label":"Lead created","type":"datetime"}]'
    when 'lead_ref' then '[{"path":"id","label":"Lead","type":"ref","entity":"lead"},{"path":"name","label":"Lead name","type":"text"},{"path":"company","label":"Company","type":"text"}]'
    when 'task' then '[{"path":"id","label":"Task","type":"ref","entity":"task"},{"path":"title","label":"Task title","type":"text"},
      {"path":"type","label":"Task type","type":"enum","options":["follow_up","call","email","whatsapp","meeting","proposal","proposal_review","internal","custom","welcome","request_info","review_form","collect_assets","review_requirements","confirm_scope","verify_integrations","prepare_handoff","delivery"]},
      {"path":"priority","label":"Task priority","type":"enum","options":["low","medium","high"]},{"path":"dueDate","label":"Task due date","type":"date"},
      {"path":"status","label":"Task status","type":"enum","options":["todo","in_progress","in_review","blocked","completed","cancelled"]},
      {"path":"assigneeId","label":"Task assignee","type":"ref","entity":"member"},{"path":"leadId","label":"Task''s lead","type":"ref","entity":"lead"},
      {"path":"dealId","label":"Task''s deal","type":"ref","entity":"deal"},{"path":"clientId","label":"Task''s client","type":"ref","entity":"client"},
      {"path":"projectId","label":"Task''s project","type":"ref","entity":"project"},{"path":"milestoneId","label":"Task''s milestone","type":"ref","entity":"milestone"},
      {"path":"deliverableId","label":"Task''s deliverable","type":"ref","entity":"deliverable"},{"path":"createdByAutomation","label":"Created by an automation","type":"boolean"}]'
    when 'deal' then '[{"path":"id","label":"Deal","type":"ref","entity":"deal"},{"path":"title","label":"Deal title","type":"text"},{"path":"stage","label":"Deal stage","type":"text"},
      {"path":"stageCategory","label":"Stage category","type":"enum","options":["open","won","lost"]},{"path":"value","label":"Deal value","type":"number"},
      {"path":"currency","label":"Deal currency","type":"text"},{"path":"priority","label":"Deal priority","type":"enum","options":["low","medium","high"]},
      {"path":"ownerId","label":"Deal owner","type":"ref","entity":"member"},{"path":"expectedCloseDate","label":"Expected close date","type":"date"},
      {"path":"source","label":"Deal source","type":"enum","options":["manual","lead","opportunity","outreach","pipeline"]},
      {"path":"leadId","label":"Deal''s lead","type":"ref","entity":"lead"},{"path":"leadName","label":"Deal''s lead name","type":"text"}]'
    when 'client' then '[{"path":"id","label":"Client","type":"ref","entity":"client"},{"path":"name","label":"Client name","type":"text"},{"path":"industry","label":"Client industry","type":"text"},
      {"path":"status","label":"Client status","type":"enum","options":["onboarding","active","paused","completed","archived"]},
      {"path":"ownerId","label":"Client owner","type":"ref","entity":"member"},{"path":"dealId","label":"Client''s deal","type":"ref","entity":"deal"},
      {"path":"leadId","label":"Client''s lead","type":"ref","entity":"lead"},{"path":"hasOnboarding","label":"Has an onboarding checklist","type":"boolean"}]'
    when 'project' then '[{"path":"id","label":"Project","type":"ref","entity":"project"},{"path":"name","label":"Project name","type":"text"},
      {"path":"type","label":"Project type","type":"enum","options":["website","marketing","seo","social","paid_ads","email","automation","software","chatbot","crm","other"]},
      {"path":"status","label":"Project status","type":"enum","options":["planning","not_started","in_progress","on_hold","at_risk","completed","cancelled"]},
      {"path":"priority","label":"Project priority","type":"enum","options":["low","medium","high","critical"]},{"path":"ownerId","label":"Project owner","type":"ref","entity":"member"},
      {"path":"clientId","label":"Project''s client","type":"ref","entity":"client"},{"path":"clientName","label":"Project''s client name","type":"text"},
      {"path":"startDate","label":"Project start","type":"date"},{"path":"targetDate","label":"Target completion","type":"date"},
      {"path":"source","label":"Project source","type":"enum","options":["onboarding","client","manual"]},{"path":"portalShared","label":"Shared on the client portal","type":"boolean"}]'
    when 'milestone' then '[{"path":"id","label":"Milestone","type":"ref","entity":"milestone"},{"path":"name","label":"Milestone name","type":"text"},
      {"path":"status","label":"Milestone status","type":"enum","options":["upcoming","in_progress","completed","delayed","cancelled"]},{"path":"dueDate","label":"Milestone due date","type":"date"}]'
    when 'deliverable' then '[{"path":"id","label":"Deliverable","type":"ref","entity":"deliverable"},{"path":"title","label":"Deliverable title","type":"text"},
      {"path":"status","label":"Delivery status","type":"enum","options":["not_started","in_progress","internal_review","ready_for_review","completed","blocked"]},
      {"path":"priority","label":"Deliverable priority","type":"enum","options":["low","medium","high","critical"]},{"path":"dueDate","label":"Deliverable due date","type":"date"},
      {"path":"ownerId","label":"Deliverable owner","type":"ref","entity":"member"},{"path":"clientVisible","label":"Shared with the client","type":"boolean"},
      {"path":"reviewStatus","label":"Client review status","type":"enum","options":["not_shared","shared","awaiting_review","changes_requested","resubmitted","approved","rejected","withdrawn"]},
      {"path":"milestoneId","label":"Deliverable''s milestone","type":"ref","entity":"milestone"}]'
    when 'analysis' then '[{"path":"id","label":"Business report","type":"ref","entity":"analysis"},{"path":"status","label":"Report status","type":"enum","options":["completed","partial","failed"]},
      {"path":"pagesAnalyzed","label":"Pages analyzed","type":"number"},{"path":"opportunityCount","label":"Opportunities found","type":"number"},
      {"path":"highPriorityOpportunities","label":"High-priority opportunities","type":"number"},{"path":"topOpportunity","label":"Top opportunity","type":"text"},
      {"path":"topOpportunityService","label":"Top opportunity''s service","type":"text"},{"path":"matchedServices","label":"Matched services","type":"list"},
      {"path":"failure","label":"Why it failed","type":"text"}]'
    when 'contact' then '[{"path":"id","label":"Contact","type":"ref","entity":"contact"},{"path":"name","label":"Contact name","type":"text"},{"path":"role","label":"Contact role","type":"text"},
      {"path":"jobTitle","label":"Job title","type":"text"},{"path":"hasEmail","label":"Has an email address","type":"boolean"},{"path":"hasPhone","label":"Has a phone number","type":"boolean"}]'
    when 'draft' then '[{"path":"id","label":"Outreach draft","type":"ref","entity":"draft"},
      {"path":"channel","label":"Channel","type":"enum","options":["email","whatsapp","linkedin_connection","linkedin_message"]},
      {"path":"status","label":"Draft status","type":"enum","options":["draft","ready","sent","replied","follow_up","archived"]},{"path":"sequenceStep","label":"Follow-up number","type":"number"}]'
    when 'onboarding' then '[{"path":"id","label":"Onboarding checklist","type":"ref","entity":"onboarding"},{"path":"title","label":"Onboarding title","type":"text"},
      {"path":"status","label":"Onboarding status","type":"enum","options":["draft","active","paused","completed","cancelled"]},{"path":"templateName","label":"Onboarding template","type":"text"},
      {"path":"dueDate","label":"Onboarding due date","type":"date"}]'
    when 'item' then '[{"path":"title","label":"Item","type":"text"},{"path":"section","label":"Item section","type":"text"},{"path":"required","label":"Required item","type":"boolean"}]'
    when 'scope' then '[{"path":"sequence","label":"Scope version","type":"number"},{"path":"servicesConfirmed","label":"Confirmed services","type":"number"},
      {"path":"requirementsConfirmed","label":"Confirmed requirements","type":"number"},{"path":"sharedWithClient","label":"Shared with the client","type":"boolean"}]'
    when 'completion' then '[{"path":"id","label":"Onboarding completion","type":"ref","entity":"completion"},{"path":"override","label":"Completed with items outstanding","type":"boolean"},
      {"path":"outstandingItems","label":"Outstanding items","type":"number"},{"path":"confirmedServices","label":"Confirmed services","type":"number"},
      {"path":"confirmedRequirements","label":"Confirmed requirements","type":"number"}]'
    when 'review' then '[{"path":"id","label":"Review request","type":"ref","entity":"review"},{"path":"versionNumber","label":"Version number","type":"number"},
      {"path":"dueDate","label":"Review due date","type":"date"},{"path":"resubmission","label":"Revised version","type":"boolean"}]'
    when 'decision' then '[{"path":"versionNumber","label":"Version number","type":"number"},{"path":"feedbackItems","label":"Feedback items","type":"number"}]'
    when 'feedback' then '[{"path":"id","label":"Feedback","type":"ref","entity":"feedback"},{"path":"title","label":"Feedback title","type":"text"},
      {"path":"category","label":"Feedback category","type":"enum","options":["design","content","functional","technical","general"]}]'
    when 'comment' then '[{"path":"id","label":"Comment","type":"ref","entity":"comment"},{"path":"onDeliverable","label":"About a deliverable","type":"boolean"}]'
    when 'file' then '[{"path":"id","label":"File","type":"ref","entity":"file"},{"path":"name","label":"File name","type":"text"},{"path":"category","label":"File category","type":"text"}]'
    when 'update' then '[{"path":"id","label":"Project update","type":"ref","entity":"update"},{"path":"title","label":"Update title","type":"text"}]'
    when 'meeting' then '[{"path":"id","label":"Meeting","type":"ref","entity":"meeting"},{"path":"title","label":"Meeting title","type":"text"},
      {"path":"startsAt","label":"Meeting starts","type":"datetime"},{"path":"status","label":"Meeting status","type":"enum","options":["scheduled","completed","cancelled","no_show"]}]'
    when 'invitation' then '[{"path":"role","label":"Portal role","type":"enum","options":["admin","member","reviewer"]}]'
    when 'schedule' then '[{"path":"firedAt","label":"Fired at","type":"datetime"},{"path":"date","label":"Date","type":"date"},{"path":"weekday","label":"Weekday","type":"text"}]'
    else '[]' end::jsonb
$$;

-- Triggers: the events existing modules emit (see the capture functions below). uses: [entity, prefix] pairs whose fields
-- the trigger provides under trigger.<prefix>; extra: more fields; keys: what a waiting run can match; scan: a scheduled check.
create function leadflow_private.automation_trigger_list() returns jsonb language sql immutable set search_path = '' as $$
  select $json$[
  {"type":"lead.created","group":"Leads","label":"Lead created","description":"A lead is added by hand, from a website form, an API connection, discovery or an import.","subject":"lead","uses":[["lead","lead"]]},
  {"type":"lead.status_changed","group":"Leads","label":"Lead status changed","description":"A lead's status changes, for example to Qualified.","subject":"lead","uses":[["lead","lead"]],
    "extra":[{"path":"previousStatus","label":"Previous status","type":"enum","options":["New","Contacted","Qualified","Converted","Lost"]}]},
  {"type":"analysis.completed","group":"Leads","label":"Business report completed","description":"A business report finishes (fully or partly).","subject":"lead","uses":[["lead_ref","lead"],["analysis","analysis"]]},
  {"type":"analysis.failed","group":"Leads","label":"Business report failed","description":"A business report can't be completed.","subject":"lead","uses":[["lead_ref","lead"],["analysis","analysis"]]},
  {"type":"task.created","group":"Leads","label":"Follow-up task created","description":"A follow-up, onboarding or project task is created.","subject":"task","uses":[["task","task"]]},
  {"type":"task.completed","group":"Leads","label":"Task completed","description":"A task is marked complete.","subject":"task","uses":[["task","task"]]},
  {"type":"task.overdue","group":"Leads","label":"Task overdue","description":"Checked every hour: an open task's due date has passed. Fires once per task and due date.","subject":"task","scan":true,
    "uses":[["task","task"]],"extra":[{"path":"daysOverdue","label":"Days overdue","type":"number"}]},
  {"type":"contact.created","group":"Contacts & outreach","label":"Contact found or added","description":"A contact is added to a lead, by a person or a contact search.","subject":"lead","uses":[["lead_ref","lead"],["contact","contact"]]},
  {"type":"outreach.draft_created","group":"Contacts & outreach","label":"Outreach draft created","description":"An outreach draft is generated or written. Nothing is sent.","subject":"lead","uses":[["lead_ref","lead"],["draft","draft"]]},
  {"type":"outreach.marked_ready","group":"Contacts & outreach","label":"Outreach draft marked ready","description":"A person marks a draft ready to send.","subject":"lead","uses":[["lead_ref","lead"],["draft","draft"]]},
  {"type":"outreach.marked_sent","group":"Contacts & outreach","label":"Outreach marked as sent","description":"A person records that they sent a message themselves. LeadFlow sends nothing.","subject":"lead","uses":[["lead_ref","lead"],["draft","draft"]]},
  {"type":"deal.created","group":"Sales","label":"Deal created","description":"A deal is created in the sales pipeline.","subject":"deal","uses":[["deal","deal"]]},
  {"type":"deal.stage_changed","group":"Sales","label":"Deal stage changed","description":"A person moves a deal to another open stage, or reopens it.","subject":"deal","uses":[["deal","deal"]],
    "extra":[{"path":"previousStage","label":"Previous stage","type":"text"}]},
  {"type":"deal.won","group":"Sales","label":"Deal marked won","description":"A person marks a deal won.","subject":"deal","uses":[["deal","deal"]],"extra":[{"path":"wonValue","label":"Final value","type":"number"}]},
  {"type":"deal.lost","group":"Sales","label":"Deal marked lost","description":"A person marks a deal lost.","subject":"deal","uses":[["deal","deal"]],"extra":[{"path":"lostReason","label":"Lost reason","type":"text"}]},
  {"type":"deal.meeting_scheduled","group":"Sales","label":"Meeting scheduled","description":"A meeting is scheduled on a deal.","subject":"deal","uses":[["deal","deal"],["meeting","meeting"]]},
  {"type":"deal.close_approaching","group":"Sales","label":"Expected close date approaching","description":"Checked every hour: an open deal's expected close date is within the chosen number of days.","subject":"deal","scan":true,
    "uses":[["deal","deal"]],"extra":[{"path":"daysUntilClose","label":"Days until close","type":"number"}],"config":[{"key":"days","label":"Days ahead","type":"number","min":1,"max":60,"default":7}]},
  {"type":"client.created","group":"Clients & onboarding","label":"Client created","description":"A client is created, by hand or from a won deal.","subject":"client","uses":[["client","client"]]},
  {"type":"client.invited","group":"Clients & onboarding","label":"Client invited to the portal","description":"A member invites a client person to the client portal.","subject":"client","uses":[["client","client"],["invitation","invitation"]]},
  {"type":"client.activated","group":"Clients & onboarding","label":"Client activated portal access","description":"An invited client person sets up their portal account.","subject":"client","uses":[["client","client"],["invitation","access"]]},
  {"type":"onboarding.started","group":"Clients & onboarding","label":"Onboarding started","description":"An onboarding checklist is created.","subject":"onboarding","uses":[["client","client"],["onboarding","onboarding"]]},
  {"type":"onboarding.item_submitted","group":"Clients & onboarding","label":"Client submitted information","description":"A client submits an onboarding item for review.","subject":"onboarding","uses":[["client","client"],["onboarding","onboarding"],["item","item"]]},
  {"type":"scope.confirmed","group":"Clients & onboarding","label":"Scope confirmed","description":"A member confirms the client's scope. Automations never confirm scope.","subject":"client","uses":[["client","client"],["scope","scope"]]},
  {"type":"onboarding.completed","group":"Clients & onboarding","label":"Onboarding completed","description":"A member completes a client's onboarding.","subject":"client","uses":[["client","client"],["completion","completion"]],
    "extra":[{"path":"hasProject","label":"Already has a project from it","type":"boolean"}]},
  {"type":"project.created","group":"Projects","label":"Project created","description":"A project is created.","subject":"project","uses":[["project","project"]]},
  {"type":"project.status_changed","group":"Projects","label":"Project status changed","description":"A person changes a project's status (started, on hold, completed…).","subject":"project","uses":[["project","project"]],
    "extra":[{"path":"previousStatus","label":"Previous status","type":"enum","options":["planning","not_started","in_progress","on_hold","at_risk","completed","cancelled"]}]},
  {"type":"project.overdue","group":"Projects","label":"Project overdue","description":"Checked every hour: the target date passed and the project isn't completed or cancelled. Fires once per target date.","subject":"project","scan":true,
    "uses":[["project","project"]],"extra":[{"path":"daysOverdue","label":"Days overdue","type":"number"}]},
  {"type":"milestone.created","group":"Projects","label":"Milestone created","description":"A milestone is added to a project.","subject":"milestone","uses":[["project","project"],["milestone","milestone"]]},
  {"type":"milestone.completed","group":"Projects","label":"Milestone completed","description":"A milestone is marked completed.","subject":"milestone","uses":[["project","project"],["milestone","milestone"]]},
  {"type":"milestone.due_soon","group":"Projects","label":"Milestone deadline approaching","description":"Checked every hour: an open milestone is due within the chosen number of days. Fires once per milestone and due date.","subject":"milestone","scan":true,
    "uses":[["project","project"],["milestone","milestone"]],"extra":[{"path":"daysUntilDue","label":"Days until due","type":"number"}],"config":[{"key":"days","label":"Days ahead","type":"number","min":1,"max":60,"default":3}]},
  {"type":"milestone.overdue","group":"Projects","label":"Milestone overdue","description":"Checked every hour: an open milestone's due date passed. Fires once per milestone and due date.","subject":"milestone","scan":true,
    "uses":[["project","project"],["milestone","milestone"]],"extra":[{"path":"daysOverdue","label":"Days overdue","type":"number"}]},
  {"type":"deliverable.created","group":"Projects","label":"Deliverable created","description":"A deliverable is added to a project.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"]]},
  {"type":"deliverable.status_changed","group":"Projects","label":"Deliverable status changed","description":"A deliverable's internal delivery status changes, for example to Ready for client review.","subject":"deliverable",
    "uses":[["project","project"],["deliverable","deliverable"]],"extra":[{"path":"previousStatus","label":"Previous status","type":"enum","options":["not_started","in_progress","internal_review","ready_for_review","completed","blocked"]}]},
  {"type":"deliverable.shared","group":"Client collaboration","label":"Deliverable shared with the client","description":"A deliverable becomes visible on the client portal.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"]]},
  {"type":"review.requested","group":"Client collaboration","label":"Review requested","description":"A version is sent to the client for review (including revised versions).","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"],["review","review"]]},
  {"type":"feedback.submitted","group":"Client collaboration","label":"Client feedback submitted","description":"A client gives structured feedback on a deliverable.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"],["feedback","feedback"]]},
  {"type":"deliverable.changes_requested","group":"Client collaboration","label":"Client requested changes","description":"A client asks for changes to a version.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"],["decision","decision"]]},
  {"type":"deliverable.approved","group":"Client collaboration","label":"Deliverable approved","description":"A client approves a version.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"],["decision","decision"]]},
  {"type":"deliverable.rejected","group":"Client collaboration","label":"Deliverable rejected","description":"A client rejects a version.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"],["decision","decision"]]},
  {"type":"comment.client_created","group":"Client collaboration","label":"Client commented","description":"A client writes in a project discussion.","subject":"project","uses":[["project","project"],["comment","comment"]]},
  {"type":"file.client_uploaded","group":"Client collaboration","label":"Client uploaded a file","description":"A client's portal upload finishes checking and becomes available.","subject":"client","uses":[["client","client"],["file","file"]],
    "extra":[{"path":"project.id","label":"Project","type":"ref","entity":"project"},{"path":"project.name","label":"Project name","type":"text"}]},
  {"type":"update.published","group":"Client collaboration","label":"Project update published","description":"A member publishes a client-visible project update.","subject":"project","uses":[["project","project"],["update","update"]]},
  {"type":"schedule.time","group":"Schedules & webhooks","label":"On a schedule","description":"Daily, weekly, monthly or once, at a time in the workspace's time zone.","subject":null,"scan":true,"uses":[["schedule","schedule"]]},
  {"type":"webhook.received","group":"Schedules & webhooks","label":"Signed webhook received","description":"An external system (Zapier, Make, n8n, your CRM) sends a signed request to this workflow's endpoint.","subject":null,
    "uses":[],"extra":[{"path":"webhook.eventId","label":"Sender's event ID","type":"text"}]}
  ]$json$::jsonb
$$;

-- Wait-for-event: what a run can wait for, matched on the record the run names, and what the wait then provides.
create function leadflow_private.automation_waitable() returns jsonb language sql immutable set search_path = '' as $$
  select $json$[
  {"event":"analysis.completed","label":"Business report completed","entity":"lead","outputs":[{"path":"received","label":"Report completed","type":"boolean"},
    {"path":"analysisId","label":"Business report","type":"ref","entity":"analysis"},{"path":"opportunityCount","label":"Opportunities found","type":"number"},
    {"path":"topOpportunity","label":"Top opportunity","type":"text"}]},
  {"event":"task.completed","label":"Task completed","entity":"task","outputs":[{"path":"received","label":"Task completed","type":"boolean"}]},
  {"event":"deal.stage_changed","label":"Deal stage changed","entity":"deal","outputs":[{"path":"received","label":"Stage changed","type":"boolean"},{"path":"stage","label":"New stage","type":"text"}]},
  {"event":"deal.won","label":"Deal marked won","entity":"deal","outputs":[{"path":"received","label":"Deal won","type":"boolean"}]},
  {"event":"onboarding.item_submitted","label":"Client submits onboarding information","entity":"client","outputs":[{"path":"received","label":"Information submitted","type":"boolean"},{"path":"item","label":"Submitted item","type":"text"}]},
  {"event":"onboarding.completed","label":"Onboarding completed","entity":"client","outputs":[{"path":"received","label":"Onboarding completed","type":"boolean"}]},
  {"event":"deliverable.approved","label":"Client approves the deliverable","entity":"deliverable","outputs":[{"path":"received","label":"Approved","type":"boolean"}]},
  {"event":"deliverable.changes_requested","label":"Client requests changes","entity":"deliverable","outputs":[{"path":"received","label":"Changes requested","type":"boolean"}]},
  {"event":"feedback.submitted","label":"Client gives feedback","entity":"deliverable","outputs":[{"path":"received","label":"Feedback given","type":"boolean"},{"path":"category","label":"Feedback category","type":"text"}]}
  ]$json$::jsonb
$$;

-- Actions. side: internal (creates or changes internal records), consequential (status decisions or anything a client sees:
-- needs an explicit confirmation in the step and an owner or admin publisher). Every action runs through the existing
-- role-checked database functions as the member who published the workflow, so it can never do more than that member.
create function leadflow_private.automation_action_list() returns jsonb language sql immutable set search_path = '' as $$
  select $json$[
  {"type":"task.create","group":"Tasks & notes","label":"Create a task","description":"Adds a task to the workspace's follow-ups, on a lead, deal, client, project, milestone or deliverable.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"subject","label":"Attach the task to","kind":"subject","entities":["lead","deal","client","project","milestone","deliverable"],"required":true},
      {"key":"title","label":"Task title","kind":"template","max":200,"required":true,"help":"Use variables such as {{trigger.lead.name}}."},
      {"key":"description","label":"Description","kind":"template","max":2000,"multiline":true},
      {"key":"due","label":"Due","kind":"due","required":true},
      {"key":"priority","label":"Priority","kind":"enum","options":["low","medium","high"],"default":"medium"},
      {"key":"taskType","label":"Task type","kind":"enum","options":["follow_up","call","email","meeting","internal","delivery"],"default":"follow_up"},
      {"key":"assignee","label":"Assign to","kind":"assignee","default":"none"}],
    "outputs":[{"path":"taskId","label":"Created task","type":"ref","entity":"task"},{"path":"title","label":"Task title","type":"text"},{"path":"dueDate","label":"Task due date","type":"date"}]},
  {"type":"note.add","group":"Tasks & notes","label":"Add an internal note","description":"Adds an internal note to the history of a lead, deal, client or project. Clients never see it.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"subject","label":"Add the note to","kind":"subject","entities":["lead","deal","client","project"],"required":true},
      {"key":"text","label":"Note","kind":"template","max":2000,"required":true,"multiline":true}],
    "outputs":[{"path":"added","label":"Note added","type":"boolean"}]},
  {"type":"notify.members","group":"Notifications","label":"Notify team members","description":"Sends an in-app notification to members, and an email to those whose settings allow automation emails.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"recipients","label":"Notify","kind":"recipients","required":true},
      {"key":"about","label":"About (for record owner and links)","kind":"subject","entities":["lead","deal","client","project","milestone","deliverable","task"]},
      {"key":"title","label":"Title","kind":"template","max":150,"required":true},
      {"key":"body","label":"Message","kind":"template","max":500,"multiline":true},
      {"key":"email","label":"Also email them (respects each member's email settings)","kind":"boolean","default":false}],
    "outputs":[{"path":"recipients","label":"People notified","type":"number"},{"path":"emailed","label":"Emails queued","type":"number"}]},
  {"type":"lead.set_status","group":"Leads","label":"Update lead status","description":"Sets a lead's status to New, Contacted or Qualified. Converted and Lost stay a person's decision.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"subject","label":"Lead","kind":"subject","entities":["lead"],"required":true},{"key":"status","label":"New status","kind":"enum","options":["New","Contacted","Qualified"],"required":true}],
    "outputs":[{"path":"status","label":"Lead status","type":"text"},{"path":"changed","label":"Status changed","type":"boolean"}]},
  {"type":"analysis.start","group":"Leads","label":"Start a business report","description":"Analyzes the lead's public website, as Business report does. Uses the workspace's monthly analysis allowance.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"subject","label":"Lead","kind":"subject","entities":["lead"],"required":true}],
    "outputs":[{"path":"analysisId","label":"Business report","type":"ref","entity":"analysis"},{"path":"started","label":"Started","type":"boolean"}]},
  {"type":"contacts.discover","group":"Contacts & outreach","label":"Find contacts","description":"Searches the lead's public pages for business contacts, as Contacts does. Never guesses email addresses.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"subject","label":"Lead","kind":"subject","entities":["lead"],"required":true}],
    "outputs":[{"path":"started","label":"Search started","type":"boolean"}]},
  {"type":"outreach.generate_draft","group":"Contacts & outreach","label":"Generate an outreach draft","description":"Writes a draft from the lead's business report with AI, for a person to review. Never sends anything.","side":"internal","ai":true,"roles":["owner","admin","member"],"retries":2,
    "inputs":[{"key":"subject","label":"Lead","kind":"subject","entities":["lead"],"required":true},
      {"key":"channel","label":"Channel","kind":"enum","options":["email","whatsapp","linkedin_message","linkedin_connection"],"default":"email"},
      {"key":"angle","label":"Angle","kind":"enum","options":["recommended","opportunity","value","consultative","audit_first","relationship"],"default":"recommended"}],
    "outputs":[{"path":"draftId","label":"Outreach draft","type":"ref","entity":"draft"}]},
  {"type":"deal.create","group":"Sales","label":"Create a deal","description":"Opens a deal for the lead in an open stage. Skipped when the lead already has an open deal with that title.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"subject","label":"Lead","kind":"subject","entities":["lead"],"required":true},{"key":"title","label":"Deal title","kind":"template","max":150,"required":true},
      {"key":"stageId","label":"Stage","kind":"stage"},{"key":"owner","label":"Deal owner","kind":"assignee","default":"none"}],
    "outputs":[{"path":"dealId","label":"Deal","type":"ref","entity":"deal"},{"path":"title","label":"Deal title","type":"text"}]},
  {"type":"deal.add_activity","group":"Sales","label":"Log a deal note","description":"Adds an internal note to the deal's timeline.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"subject","label":"Deal","kind":"subject","entities":["deal"],"required":true},{"key":"text","label":"Note","kind":"template","max":2000,"required":true,"multiline":true}],
    "outputs":[{"path":"added","label":"Note added","type":"boolean"}]},
  {"type":"deal.move_stage","group":"Sales","label":"Move a deal to another open stage","description":"Changes the deal's stage. Won and lost stay a person's decision.","side":"consequential","roles":["owner","admin"],"retries":3,
    "inputs":[{"key":"subject","label":"Deal","kind":"subject","entities":["deal"],"required":true},{"key":"stageId","label":"Open stage","kind":"stage","required":true},
      {"key":"confirm","label":"I understand this changes the deal's stage without a person choosing it","kind":"confirm","required":true}],
    "outputs":[{"path":"stage","label":"New stage","type":"text"}]},
  {"type":"onboarding.start","group":"Clients & onboarding","label":"Start client onboarding","description":"Creates the client's onboarding checklist from a template. Skipped when the client already has one. Nothing is sent to the client.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"subject","label":"Client","kind":"subject","entities":["client"],"required":true},{"key":"templateId","label":"Onboarding template","kind":"onboarding_template"}],
    "outputs":[{"path":"onboardingId","label":"Onboarding checklist","type":"ref","entity":"onboarding"},{"path":"started","label":"Started","type":"boolean"}]},
  {"type":"project.create_from_onboarding","group":"Projects","label":"Create a project from the onboarding handoff","description":"Creates an internal project from the client's completed onboarding, using only confirmed services and requirements. Skipped when that handoff already has a project.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"subject","label":"Client","kind":"subject","entities":["client"],"required":true},{"key":"name","label":"Project name","kind":"template","max":150,"required":true},
      {"key":"templateId","label":"Project template (plan)","kind":"project_template"},{"key":"owner","label":"Project owner","kind":"assignee","default":"record_owner"}],
    "outputs":[{"path":"projectId","label":"Project","type":"ref","entity":"project"},{"path":"created","label":"Project created","type":"boolean"}]},
  {"type":"milestone.create","group":"Projects","label":"Create a milestone","description":"Adds a milestone to the project.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"subject","label":"Project","kind":"subject","entities":["project"],"required":true},{"key":"name","label":"Milestone name","kind":"template","max":150,"required":true},
      {"key":"due","label":"Due","kind":"due","required":true}],
    "outputs":[{"path":"milestoneId","label":"Milestone","type":"ref","entity":"milestone"}]},
  {"type":"deliverable.set_status","group":"Projects","label":"Update a deliverable's delivery status","description":"Sets the internal delivery status. It never completes the project.","side":"internal","roles":["owner","admin","member"],"retries":3,
    "inputs":[{"key":"subject","label":"Deliverable","kind":"subject","entities":["deliverable"],"required":true},
      {"key":"status","label":"New status","kind":"enum","options":["in_progress","internal_review","ready_for_review","completed"],"required":true}],
    "outputs":[{"path":"status","label":"Delivery status","type":"text"},{"path":"changed","label":"Status changed","type":"boolean"}]},
  {"type":"project.set_status","group":"Projects","label":"Change project status","description":"Moves a project to Not started, In progress or On hold. Completing or cancelling stays a person's decision.","side":"consequential","roles":["owner","admin"],"retries":3,
    "inputs":[{"key":"subject","label":"Project","kind":"subject","entities":["project"],"required":true},{"key":"status","label":"New status","kind":"enum","options":["not_started","in_progress","on_hold"],"required":true},
      {"key":"confirm","label":"I understand this changes the project's status without a person choosing it","kind":"confirm","required":true}],
    "outputs":[{"path":"status","label":"Project status","type":"text"}]},
  {"type":"review.request","group":"Client collaboration","label":"Send the latest version for client review","description":"Shares the deliverable's latest version on the client portal and asks for a review; the client is notified as usual. Requires the project to be shared on the portal.","side":"consequential","client":true,"roles":["owner","admin"],"retries":3,
    "inputs":[{"key":"subject","label":"Deliverable","kind":"subject","entities":["deliverable"],"required":true},{"key":"message","label":"Message to the client","kind":"template","max":2000,"multiline":true},
      {"key":"dueInDays","label":"Review due in (days, 0 for none)","kind":"number","min":0,"max":60,"default":0},
      {"key":"confirm","label":"I understand the client will see this version and be notified","kind":"confirm","required":true}],
    "outputs":[{"path":"versionNumber","label":"Version sent","type":"number"}]}
  ]$json$::jsonb
$$;

create function leadflow_private.automation_operators() returns jsonb language sql immutable set search_path = '' as $$
  select '{"text":["equals","not_equals","contains","not_contains","starts_with","is_empty","is_not_empty"],
    "enum":["equals","not_equals","in","not_in","is_empty","is_not_empty"],
    "number":["equals","gt","lt","gte","lte","between","is_empty","is_not_empty"],
    "date":["before","after","on","within_next_days","overdue","is_empty","is_not_empty"],
    "datetime":["before","after","on","within_next_days","overdue","is_empty","is_not_empty"],
    "boolean":["is_true","is_false"],
    "list":["contains_item","not_contains_item","is_empty","is_not_empty"],
    "ref":["is_empty","is_not_empty"]}'::jsonb
$$;

-- Fields that are always available.
create function leadflow_private.automation_common_fields() returns jsonb language sql immutable set search_path = '' as $$
  select '[{"path":"workspace.name","label":"Workspace name","type":"text"},{"path":"run.date","label":"Today (workspace time zone)","type":"date"},
    {"path":"run.startedAt","label":"Run started","type":"datetime"}]'::jsonb
$$;

-- A trigger's variables: its records' fields under trigger.<prefix>, its extra fields and, for webhooks, the configured fields.
create function leadflow_private.automation_trigger_fields(trigger_def jsonb, trigger_config jsonb default null) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare fields jsonb := '[]'; pair jsonb; f jsonb;
begin
  for pair in select value from jsonb_array_elements(coalesce(trigger_def->'uses', '[]')) loop
    for f in select value from jsonb_array_elements(leadflow_private.automation_entity_fields(pair->>0)) loop
      fields := fields || jsonb_build_array(f || jsonb_build_object('path', 'trigger.' || (pair->>1) || '.' || (f->>'path')));
    end loop;
  end loop;
  for f in select value from jsonb_array_elements(coalesce(trigger_def->'extra', '[]')) loop
    fields := fields || jsonb_build_array(f || jsonb_build_object('path', 'trigger.' || (f->>'path')));
  end loop;
  if trigger_def->>'type' = 'webhook.received' and jsonb_typeof(trigger_config->'fields') = 'array' then
    for f in select value from jsonb_array_elements(trigger_config->'fields') loop
      if jsonb_typeof(f) = 'object' and coalesce(f->>'key', '') ~ '^[a-zA-Z][a-zA-Z0-9_]{0,39}$' and f->>'type' in ('text','number','boolean','date') then
        fields := fields || jsonb_build_array(jsonb_build_object('path', 'trigger.data.' || (f->>'key'), 'label', left(coalesce(nullif(f->>'label', ''), f->>'key'), 60), 'type', f->>'type'));
      end if;
    end loop;
  end if;
  return fields || leadflow_private.automation_common_fields();
end $$;

-- The whole registry, as the builder and the AI drafter read it.
create function leadflow_private.automation_catalog() returns jsonb language plpgsql immutable set search_path = '' as $$
declare triggers jsonb := '[]'; t jsonb;
begin
  for t in select value from jsonb_array_elements(leadflow_private.automation_trigger_list()) loop
    triggers := triggers || jsonb_build_array((t - 'uses' - 'extra') || jsonb_build_object('fields', leadflow_private.automation_trigger_fields(t)));
  end loop;
  return jsonb_build_object('triggers', triggers, 'actions', leadflow_private.automation_action_list(), 'waits', leadflow_private.automation_waitable(),
    'operators', leadflow_private.automation_operators(), 'limits', leadflow_private.automation_limits(), 'commonFields', leadflow_private.automation_common_fields());
end $$;

create function leadflow_private.automation_trigger_def(trigger_type text) returns jsonb language sql immutable set search_path = '' as $$
  select t from jsonb_array_elements(leadflow_private.automation_trigger_list()) t where t->>'type' = trigger_type
$$;
create function leadflow_private.automation_action_def(action_type text) returns jsonb language sql immutable set search_path = '' as $$
  select a from jsonb_array_elements(leadflow_private.automation_action_list()) a where a->>'type' = action_type
$$;
create function leadflow_private.automation_wait_def(event_type text) returns jsonb language sql immutable set search_path = '' as $$
  select w from jsonb_array_elements(leadflow_private.automation_waitable()) w where w->>'event' = event_type
$$;

-- ---------- Values, templates and redaction ----------

-- A registered path's value. Paths are validated against the registry before publishing; at run time only these roots are
-- read, segment by segment, so nothing outside the run's own context can be reached.
create function leadflow_private.automation_value(ctx jsonb, path text) returns jsonb language plpgsql immutable set search_path = '' as $$
begin
  if path is null or path !~ '^(trigger|steps|workspace|run)(\.[A-Za-z0-9_]{1,40}){1,5}$' then return null; end if;
  return ctx #> string_to_array(path, '.');
end $$;

create function leadflow_private.automation_text(value jsonb) returns text language sql immutable set search_path = '' as $$
  select case jsonb_typeof(value) when 'string' then value #>> '{}' when 'number' then value #>> '{}' when 'boolean' then case when value = 'true'::jsonb then 'yes' else 'no' end
    when 'array' then (select string_agg(x #>> '{}', ', ') from jsonb_array_elements(value) x where jsonb_typeof(x) in ('string','number')) else '' end
$$;

-- Fills {{path}} variables. Unknown or missing values become empty text; nothing in a template is evaluated.
create function leadflow_private.automation_render(template text, ctx jsonb, max_length integer default 2000) returns text
language plpgsql immutable set search_path = '' as $$
declare result text := coalesce(template, ''); m text[];
begin
  for m in select regexp_matches(coalesce(template, ''), '(\{\{\s*([A-Za-z0-9_.]{1,120})\s*\}\})', 'g') loop
    result := replace(result, m[1], coalesce(leadflow_private.automation_text(leadflow_private.automation_value(ctx, m[2])), ''));
  end loop;
  return left(btrim(regexp_replace(result, '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), max_length);
end $$;

-- What execution logs may keep: credentials, signing keys, bearer tokens, email addresses and phone numbers are removed.
create function leadflow_private.automation_redact(raw text) returns text language sql immutable set search_path = '' as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(raw, ''),
    '(lf|whsec|sk|pk|re)_[A-Za-z0-9]{16,}', '[redacted]', 'g'),
    '(?i)bearer\s+[A-Za-z0-9._~+/-]{8,}=*', 'Bearer [redacted]', 'g'),
    'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}', '[redacted]', 'g'),
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
    '(\+[0-9][0-9 ().-]{6,}[0-9])|(\y\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}\y)', '[phone]', 'g')
$$;

-- A log-safe copy of a JSON value: strings redacted and cut to 300 characters, at most 30 keys or items per level, 3 levels.
create function leadflow_private.automation_sanitize(value jsonb, depth integer default 0) returns jsonb language plpgsql immutable set search_path = '' as $$
declare result jsonb; k text; v jsonb; n integer := 0;
begin
  if value is null then return null; end if;
  case jsonb_typeof(value)
    when 'string' then return to_jsonb(left(leadflow_private.automation_redact(value #>> '{}'), 300));
    when 'object' then
      if depth >= 3 then return '"…"'::jsonb; end if;
      result := '{}';
      for k, v in select key, x from jsonb_each(value) as e(key, x) loop
        n := n + 1; exit when n > 30;
        if k ~* '(secret|token|password|apikey|api_key|authorization|signature)' then result := result || jsonb_build_object(k, '[redacted]');
        else result := result || jsonb_build_object(k, leadflow_private.automation_sanitize(v, depth + 1)); end if;
      end loop;
      return result;
    when 'array' then
      if depth >= 3 then return '"…"'::jsonb; end if;
      select coalesce(jsonb_agg(leadflow_private.automation_sanitize(x, depth + 1)), '[]') into result from (select x from jsonb_array_elements(value) x limit 30) s;
      return result;
    else return value;
  end case;
end $$;

-- ---------- Condition engine ----------

-- One condition: { path, op, value, value2 }. Missing values count as empty: is_empty is true, a positive comparison is false
-- and its negation (not_equals, not_contains, not_in, not_contains_item) is true. Text compares without case.
create function leadflow_private.automation_eval_condition(c jsonb, ctx jsonb, today date) returns boolean language plpgsql immutable set search_path = '' as $$
declare v jsonb := leadflow_private.automation_value(ctx, c->>'path'); op text := c->>'op'; t text; num numeric; d date; empty boolean;
  target text := lower(coalesce(c->>'value', ''));
begin
  empty := v is null or v = 'null'::jsonb or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '') or (jsonb_typeof(v) = 'array' and jsonb_array_length(v) = 0);
  if op = 'is_empty' then return empty; end if;
  if op = 'is_not_empty' then return not empty; end if;
  if op in ('not_equals','not_contains','not_in','not_contains_item') then
    return not leadflow_private.automation_eval_condition(c || jsonb_build_object('op', case op when 'not_equals' then 'equals' when 'not_contains' then 'contains'
      when 'not_in' then 'in' else 'contains_item' end), ctx, today);
  end if;
  if op = 'is_true' then return coalesce(v = 'true'::jsonb, false); end if;
  if op = 'is_false' then return coalesce(v = 'false'::jsonb, false); end if;
  if empty then return false; end if;
  t := lower(leadflow_private.automation_text(v));
  case op
    when 'equals' then
      if jsonb_typeof(v) = 'number' and c->>'value' ~ '^-?[0-9]+(\.[0-9]+)?$' then return (v #>> '{}')::numeric = (c->>'value')::numeric; end if;
      return t = target;
    when 'contains' then return position(target in t) > 0;
    when 'starts_with' then return left(t, length(target)) = target;
    when 'in' then return jsonb_typeof(c->'value') = 'array' and exists (select 1 from jsonb_array_elements_text(c->'value') x where lower(x) = t);
    when 'contains_item' then return jsonb_typeof(v) = 'array' and exists (select 1 from jsonb_array_elements(v) x where lower(x #>> '{}') = target);
    when 'gt', 'lt', 'gte', 'lte', 'between' then
      if jsonb_typeof(v) <> 'number' or coalesce(c->>'value', '') !~ '^-?[0-9]+(\.[0-9]+)?$' then return false; end if;
      num := (v #>> '{}')::numeric;
      return case op when 'gt' then num > (c->>'value')::numeric when 'lt' then num < (c->>'value')::numeric when 'gte' then num >= (c->>'value')::numeric
        when 'lte' then num <= (c->>'value')::numeric
        else coalesce(c->>'value2', '') ~ '^-?[0-9]+(\.[0-9]+)?$' and num between (c->>'value')::numeric and (c->>'value2')::numeric end;
    when 'before', 'after', 'on', 'within_next_days', 'overdue' then
      begin d := left(v #>> '{}', 10)::date; exception when others then return false; end;
      if op = 'overdue' then return d < today; end if;
      if op = 'within_next_days' then
        if coalesce(c->>'value', '') !~ '^[0-9]{1,3}$' then return false; end if;
        return d >= today and d <= today + (c->>'value')::integer;
      end if;
      begin
        return case op when 'before' then d < (c->>'value')::date when 'after' then d > (c->>'value')::date else d = (c->>'value')::date end;
      exception when others then return false; end;
    else return false;
  end case;
end $$;

-- A group: { match: all|any, conditions: [condition or group] }. An empty group is true. Depth is limited at validation and here.
create function leadflow_private.automation_eval_group(g jsonb, ctx jsonb, today date, depth integer default 1) returns boolean language plpgsql immutable set search_path = '' as $$
declare item jsonb; result boolean; any_mode boolean := coalesce(g->>'match', 'all') = 'any';
begin
  if g is null or g = 'null'::jsonb or jsonb_typeof(g->'conditions') is distinct from 'array' or jsonb_array_length(g->'conditions') = 0 then return true; end if;
  if depth > 3 then raise exception 'Conditions are nested too deeply.' using errcode = '22023'; end if;
  for item in select value from jsonb_array_elements(g->'conditions') loop
    -- An undecided comparison never counts as a match.
    result := coalesce(case when item ? 'conditions' then leadflow_private.automation_eval_group(item, ctx, today, depth + 1) else leadflow_private.automation_eval_condition(item, ctx, today) end, false);
    if any_mode and result then return true; end if;
    if not any_mode and not result then return false; end if;
  end loop;
  return not any_mode;
end $$;

-- ---------- Validation ----------

create function leadflow_private.automation_issue(node text, field text, message text) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('node', node, 'field', field, 'message', message)
$$;

create function leadflow_private.automation_field_at(visible jsonb, path text) returns jsonb language sql immutable set search_path = '' as $$
  select f from jsonb_array_elements(visible) f where f->>'path' = path limit 1
$$;

-- Checks a condition group against the fields visible at that point. Returns issues; counts conditions in total.
create function leadflow_private.automation_check_group(g jsonb, visible jsonb, node text, depth integer, inout issues jsonb, inout total integer)
language plpgsql immutable set search_path = '' as $$
declare item jsonb; f jsonb; ops jsonb := leadflow_private.automation_operators(); op text;
begin
  if g is null or g = 'null'::jsonb then return; end if;
  if jsonb_typeof(g) <> 'object' or jsonb_typeof(g->'conditions') is distinct from 'array' then
    issues := issues || leadflow_private.automation_issue(node, 'conditions', 'Conditions must be a group with a list of conditions.'); return;
  end if;
  if coalesce(g->>'match', 'all') not in ('all','any') then issues := issues || leadflow_private.automation_issue(node, 'conditions', 'Choose whether all or any conditions must match.'); end if;
  if depth > 3 then issues := issues || leadflow_private.automation_issue(node, 'conditions', 'Condition groups can be nested at most 3 levels deep.'); return; end if;
  if jsonb_array_length(g->'conditions') > 10 then issues := issues || leadflow_private.automation_issue(node, 'conditions', 'A group can hold at most 10 conditions.'); end if;
  for item in select value from jsonb_array_elements(g->'conditions') loop
    if jsonb_typeof(item) <> 'object' then issues := issues || leadflow_private.automation_issue(node, 'conditions', 'Each condition must be an object.'); continue; end if;
    if item ? 'conditions' then
      select x.issues, x.total into issues, total from leadflow_private.automation_check_group(item, visible, node, depth + 1, issues, total) x;
      continue;
    end if;
    total := total + 1;
    f := leadflow_private.automation_field_at(visible, item->>'path');
    if f is null then issues := issues || leadflow_private.automation_issue(node, 'conditions', format('“%s” isn''t a field available here.', left(coalesce(item->>'path', ''), 80))); continue; end if;
    op := item->>'op';
    if not coalesce(ops->(f->>'type') ? op, false) then
      issues := issues || leadflow_private.automation_issue(node, 'conditions', format('“%s” can''t be used with %s.', coalesce(op, 'no operator'), f->>'label')); continue;
    end if;
    if op in ('is_empty','is_not_empty','is_true','is_false','overdue') then continue; end if;
    if f->>'type' = 'number' and (coalesce(item->>'value', '') !~ '^-?[0-9]+(\.[0-9]+)?$' or (op = 'between' and coalesce(item->>'value2', '') !~ '^-?[0-9]+(\.[0-9]+)?$')) then
      issues := issues || leadflow_private.automation_issue(node, 'conditions', format('Enter a number for %s.', f->>'label'));
    elsif op = 'between' and (item->>'value')::numeric > (item->>'value2')::numeric then
      issues := issues || leadflow_private.automation_issue(node, 'conditions', format('The range for %s starts after it ends.', f->>'label'));
    elsif f->>'type' in ('date','datetime') and op = 'within_next_days' and coalesce(item->>'value', '') !~ '^[0-9]{1,3}$' then
      issues := issues || leadflow_private.automation_issue(node, 'conditions', format('Enter a number of days (0–999) for %s.', f->>'label'));
    elsif f->>'type' in ('date','datetime') and op in ('before','after','on') and coalesce(item->>'value', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      issues := issues || leadflow_private.automation_issue(node, 'conditions', format('Enter a date (YYYY-MM-DD) for %s.', f->>'label'));
    elsif f->>'type' = 'enum' and op in ('equals') and not coalesce(f->'options' ? (item->>'value'), false) then
      issues := issues || leadflow_private.automation_issue(node, 'conditions', format('Choose one of the listed values for %s.', f->>'label'));
    elsif f->>'type' = 'enum' and op = 'in' and (jsonb_typeof(item->'value') <> 'array' or jsonb_array_length(item->'value') = 0
        or exists (select 1 from jsonb_array_elements_text(item->'value') x where not f->'options' ? x)) then
      issues := issues || leadflow_private.automation_issue(node, 'conditions', format('Choose one or more listed values for %s.', f->>'label'));
    elsif f->>'type' in ('text','list') and length(coalesce(item->>'value', '')) not between 1 and 200 then
      issues := issues || leadflow_private.automation_issue(node, 'conditions', format('Enter a value (up to 200 characters) for %s.', f->>'label'));
    end if;
  end loop;
end $$;

-- Variables used in a template must be visible here.
create function leadflow_private.automation_check_template(template text, visible jsonb, node text, field text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare issues jsonb := '[]'; m text[];
begin
  for m in select regexp_matches(coalesce(template, ''), '\{\{\s*([^}]{0,200})\s*\}\}', 'g') loop
    if leadflow_private.automation_field_at(visible, btrim(m[1])) is null then
      issues := issues || leadflow_private.automation_issue(node, field, format('The variable {{%s}} isn''t available here.', left(btrim(m[1]), 80)));
    end if;
  end loop;
  return issues;
end $$;

-- An action step's inputs. Returns issues.
create function leadflow_private.automation_check_inputs(def jsonb, inputs jsonb, visible jsonb, node text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare issues jsonb := '[]'; input jsonb; v jsonb; f jsonb; k text; selector text;
begin
  if inputs is null or jsonb_typeof(inputs) <> 'object' then return jsonb_build_array(leadflow_private.automation_issue(node, 'inputs', 'Configure this action.')); end if;
  for k in select key from jsonb_each(inputs) loop
    if not exists (select 1 from jsonb_array_elements(def->'inputs') i where i->>'key' = k) then
      issues := issues || leadflow_private.automation_issue(node, k, format('“%s” isn''t a setting of this action.', left(k, 40)));
    end if;
  end loop;
  for input in select value from jsonb_array_elements(def->'inputs') loop
    k := input->>'key'; v := inputs->k;
    if v is null or v = 'null'::jsonb or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '') then
      if coalesce((input->>'required')::boolean, false) then issues := issues || leadflow_private.automation_issue(node, k, format('%s is required.', input->>'label')); end if;
      continue;
    end if;
    case input->>'kind'
      when 'template' then
        if jsonb_typeof(v) <> 'string' or length(v #>> '{}') > (input->>'max')::integer then
          issues := issues || leadflow_private.automation_issue(node, k, format('%s can be up to %s characters.', input->>'label', input->>'max'));
        else issues := issues || leadflow_private.automation_check_template(v #>> '{}', visible, node, k); end if;
      when 'enum' then
        if not coalesce(input->'options' ? (v #>> '{}'), false) or jsonb_typeof(v) <> 'string' then issues := issues || leadflow_private.automation_issue(node, k, format('Choose a listed option for %s.', input->>'label')); end if;
      when 'boolean' then
        if jsonb_typeof(v) <> 'boolean' then issues := issues || leadflow_private.automation_issue(node, k, format('%s must be on or off.', input->>'label')); end if;
      when 'confirm' then
        if v <> 'true'::jsonb then issues := issues || leadflow_private.automation_issue(node, k, 'Confirm this consequential action before publishing.'); end if;
      when 'number' then
        if (case when jsonb_typeof(v) <> 'number' then true else (v #>> '{}')::numeric not between coalesce((input->>'min')::numeric, -1e9) and coalesce((input->>'max')::numeric, 1e9)
            or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) end) then
          issues := issues || leadflow_private.automation_issue(node, k, format('%s must be a whole number from %s to %s.', input->>'label', input->>'min', input->>'max'));
        end if;
      when 'subject' then
        f := leadflow_private.automation_field_at(visible, v #>> '{}');
        if jsonb_typeof(v) <> 'string' or f is null or f->>'type' <> 'ref' or not coalesce(input->'entities' ? (f->>'entity'), false) then
          issues := issues || leadflow_private.automation_issue(node, k, format('Choose which %s this applies to from the trigger or an earlier step.',
            (select string_agg(x, ' or ') from jsonb_array_elements_text(input->'entities') x)));
        end if;
      when 'assignee' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}' not in ('none','record_owner','publisher') and v #>> '{}' !~ '^[0-9a-f-]{36}$') then
          issues := issues || leadflow_private.automation_issue(node, k, format('Choose who %s should be.', lower(input->>'label')));
        end if;
      when 'recipients' then
        if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) not between 1 and 10 then
          issues := issues || leadflow_private.automation_issue(node, k, 'Choose between 1 and 10 recipients.');
        else
          for selector in select x from jsonb_array_elements_text(v) x loop
            if selector not in ('publisher','admins','record_owner') and selector !~ '^[0-9a-f-]{36}$' then
              issues := issues || leadflow_private.automation_issue(node, k, 'Recipients must be members of this workspace, the record owner, owners and admins, or the publisher.');
            end if;
          end loop;
        end if;
      when 'due' then
        if jsonb_typeof(v) <> 'object' or coalesce(v->>'mode', '') not in ('days','relative') then
          issues := issues || leadflow_private.automation_issue(node, k, 'Choose when it is due.');
        elsif v->>'mode' = 'days' and (case when jsonb_typeof(v->'days') <> 'number' then true else (v->>'days')::numeric not between 0 and 365 end) then
          issues := issues || leadflow_private.automation_issue(node, k, 'Due in 0 to 365 days.');
        elsif v->>'mode' = 'relative' then
          f := leadflow_private.automation_field_at(visible, v->>'path');
          if f is null or f->>'type' not in ('date','datetime') then issues := issues || leadflow_private.automation_issue(node, k, 'Choose a date from the trigger or an earlier step.');
          elsif (case when jsonb_typeof(v->'offset') <> 'number' then true else (v->>'offset')::numeric not between -365 and 365 end) then issues := issues || leadflow_private.automation_issue(node, k, 'The offset must be from −365 to 365 days.'); end if;
        end if;
      when 'stage', 'onboarding_template', 'project_template' then
        if jsonb_typeof(v) <> 'string' or v #>> '{}' !~ '^[0-9a-f-]{36}$' then issues := issues || leadflow_private.automation_issue(node, k, format('Choose a %s.', lower(input->>'label'))); end if;
      else issues := issues || leadflow_private.automation_issue(node, k, 'Unknown setting.');
    end case;
  end loop;
  return issues;
end $$;

-- Walks the steps. visible: fields readable at this point (a branch's outputs stay inside the branch). Returns issues and
-- counts; ids collects node IDs to catch duplicates.
create function leadflow_private.automation_check_steps(steps jsonb, visible jsonb, depth integer, publisher_role text,
  inout issues jsonb, inout nodes integer, inout conditions integer, inout actions integer, inout ids text[], inout consequential boolean)
language plpgsql immutable set search_path = '' as $$
declare step jsonb; id text; def jsonb; f jsonb; c jsonb; amount numeric; seen_otherwise boolean;
begin
  if steps is null or jsonb_typeof(steps) <> 'array' then issues := issues || leadflow_private.automation_issue(null, 'steps', 'Steps must be a list.'); return; end if;
  for step in select value from jsonb_array_elements(steps) loop
    nodes := nodes + 1;
    id := step->>'id';
    if jsonb_typeof(step) <> 'object' or coalesce(id, '') !~ '^[a-z0-9_]{1,24}$' then
      issues := issues || leadflow_private.automation_issue(null, 'steps', 'Each step needs an ID of up to 24 lowercase letters, digits or underscores.'); continue;
    end if;
    if id = any(ids) then issues := issues || leadflow_private.automation_issue(id, 'id', 'Two steps share this ID.'); end if;
    ids := ids || id;
    if length(coalesce(step->>'label', '')) > 120 then issues := issues || leadflow_private.automation_issue(id, 'label', 'Step names can be up to 120 characters.'); end if;
    case step->>'type'
      when 'condition' then
        if (case when jsonb_typeof(step->'when'->'conditions') is distinct from 'array' then true else jsonb_array_length(step->'when'->'conditions') = 0 end) then
          issues := issues || leadflow_private.automation_issue(id, 'conditions', 'Add at least one condition.');
        end if;
        select x.issues, x.total into issues, conditions from leadflow_private.automation_check_group(step->'when', visible, id, 1, issues, conditions) x;
      when 'branch' then
        if depth >= 3 then issues := issues || leadflow_private.automation_issue(id, 'branch', 'Branches can be nested at most 3 levels deep.'); continue; end if;
        if (case when jsonb_typeof(step->'cases') is distinct from 'array' then true else jsonb_array_length(step->'cases') not between 1 and 5 end) then
          issues := issues || leadflow_private.automation_issue(id, 'cases', 'A branch needs 1 to 5 paths besides Otherwise.'); continue;
        end if;
        for c in select value from jsonb_array_elements(step->'cases') loop
          if coalesce(c->>'id', '') !~ '^[a-z0-9_]{1,24}$' then issues := issues || leadflow_private.automation_issue(id, 'cases', 'Each path needs an ID.'); continue; end if;
          if c->>'id' = any(ids) then issues := issues || leadflow_private.automation_issue(id, 'cases', 'A path shares its ID with another step.'); end if;
          ids := ids || (c->>'id');
          if length(btrim(coalesce(c->>'label', ''))) not between 1 and 60 then issues := issues || leadflow_private.automation_issue(id, 'cases', 'Name each path (up to 60 characters).'); end if;
          if (case when jsonb_typeof(c->'when'->'conditions') is distinct from 'array' then true else jsonb_array_length(c->'when'->'conditions') = 0 end) then
            issues := issues || leadflow_private.automation_issue(id, 'cases', format('Path “%s” needs at least one condition. Use Otherwise for everything else.', left(coalesce(c->>'label', ''), 60)));
          end if;
          select x.issues, x.total into issues, conditions from leadflow_private.automation_check_group(c->'when', visible, id, 1, issues, conditions) x;
          select x.issues, x.nodes, x.conditions, x.actions, x.ids, x.consequential into issues, nodes, conditions, actions, ids, consequential
            from leadflow_private.automation_check_steps(coalesce(c->'steps', '[]'), visible, depth + 1, publisher_role, issues, nodes, conditions, actions, ids, consequential) x;
        end loop;
        seen_otherwise := jsonb_typeof(step->'otherwise') = 'object';
        if seen_otherwise then
          select x.issues, x.nodes, x.conditions, x.actions, x.ids, x.consequential into issues, nodes, conditions, actions, ids, consequential
            from leadflow_private.automation_check_steps(coalesce(step->'otherwise'->'steps', '[]'), visible, depth + 1, publisher_role, issues, nodes, conditions, actions, ids, consequential) x;
        end if;
      when 'delay' then
        if step->>'mode' = 'until' then
          begin
            if (step->>'until')::timestamptz <= now() then issues := issues || leadflow_private.automation_issue(id, 'until', 'Choose a date and time in the future.');
            elsif (step->>'until')::timestamptz > now() + interval '1 year' then issues := issues || leadflow_private.automation_issue(id, 'until', 'Choose a date within a year.'); end if;
          exception when others then issues := issues || leadflow_private.automation_issue(id, 'until', 'Enter a valid date and time.'); end;
        elsif step->>'mode' = 'duration' or step->>'mode' is null then
          if jsonb_typeof(step->'amount') is distinct from 'number' or coalesce(step->>'unit', '') not in ('minutes','hours','days') then
            issues := issues || leadflow_private.automation_issue(id, 'amount', 'Enter how long to wait.');
          else
            amount := (step->>'amount')::numeric * case step->>'unit' when 'minutes' then 1 when 'hours' then 60 else 1440 end;
            if amount < 1 or amount > 90 * 1440 or (step->>'amount')::numeric <> trunc((step->>'amount')::numeric) then
              issues := issues || leadflow_private.automation_issue(id, 'amount', 'Wait between 1 minute and 90 days, in whole units.');
            end if;
          end if;
        else issues := issues || leadflow_private.automation_issue(id, 'mode', 'Choose how to delay.'); end if;
      when 'wait' then
        def := leadflow_private.automation_wait_def(step->>'event');
        if def is null then issues := issues || leadflow_private.automation_issue(id, 'event', 'Choose an event to wait for.'); continue; end if;
        f := leadflow_private.automation_field_at(visible, step->>'subject');
        if f is null or f->>'type' <> 'ref' or f->>'entity' <> def->>'entity' then
          issues := issues || leadflow_private.automation_issue(id, 'subject', format('Choose which %s to wait for, from the trigger or an earlier step.', def->>'entity'));
        end if;
        if (case when jsonb_typeof(step->'timeout'->'amount') is distinct from 'number' or coalesce(step->'timeout'->>'unit', '') not in ('hours','days') then true
            else (step->'timeout'->>'amount')::numeric * case step->'timeout'->>'unit' when 'hours' then 1 else 24 end not between 1 and 30 * 24 end) then
          issues := issues || leadflow_private.automation_issue(id, 'timeout', 'Wait between 1 hour and 30 days.');
        end if;
        if coalesce(step->>'onTimeout', '') not in ('continue','stop') then issues := issues || leadflow_private.automation_issue(id, 'onTimeout', 'Choose what happens if nothing arrives in time.'); end if;
        for f in select value from jsonb_array_elements(def->'outputs') loop
          visible := visible || jsonb_build_array(f || jsonb_build_object('path', 'steps.' || id || '.' || (f->>'path'), 'label', (f->>'label') || ' (' || coalesce(nullif(step->>'label', ''), 'wait') || ')'));
        end loop;
      when 'action' then
        actions := actions + 1;
        def := leadflow_private.automation_action_def(step->>'action');
        if def is null then issues := issues || leadflow_private.automation_issue(id, 'action', 'This action isn''t available.'); continue; end if;
        issues := issues || leadflow_private.automation_check_inputs(def, step->'inputs', visible, id);
        if def->>'side' = 'consequential' then
          consequential := true;
          if publisher_role is not null and publisher_role not in ('owner','admin') then
            issues := issues || leadflow_private.automation_issue(id, 'action', 'Only owners and admins can publish this consequential action.');
          end if;
        end if;
        for f in select value from jsonb_array_elements(def->'outputs') loop
          visible := visible || jsonb_build_array(f || jsonb_build_object('path', 'steps.' || id || '.' || (f->>'path'), 'label', (f->>'label') || ' (' || coalesce(nullif(step->>'label', ''), def->>'label') || ')'));
        end loop;
      else issues := issues || leadflow_private.automation_issue(id, 'type', 'Unknown step type.');
    end case;
  end loop;
end $$;

-- Schedule settings: { frequency: daily|weekly|monthly|once, time: HH:MM, weekday 0–6 (Sunday 0), dayOfMonth 1–28, date }.
create function leadflow_private.automation_check_schedule(config jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare issues jsonb := '[]';
begin
  if coalesce(config->>'frequency', '') not in ('daily','weekly','monthly','once') then return jsonb_build_array(leadflow_private.automation_issue('trigger', 'frequency', 'Choose how often it runs.')); end if;
  if coalesce(config->>'time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then issues := issues || leadflow_private.automation_issue('trigger', 'time', 'Choose a time (HH:MM).'); end if;
  if config->>'frequency' = 'weekly' and coalesce(config->>'weekday', '') !~ '^[0-6]$' then issues := issues || leadflow_private.automation_issue('trigger', 'weekday', 'Choose a day of the week.'); end if;
  if config->>'frequency' = 'monthly' and coalesce(config->>'dayOfMonth', '') !~ '^([1-9]|1[0-9]|2[0-8])$' then issues := issues || leadflow_private.automation_issue('trigger', 'dayOfMonth', 'Choose a day from 1 to 28.'); end if;
  if config->>'frequency' = 'once' then
    begin
      if (config->>'date')::date < current_date - 1 then issues := issues || leadflow_private.automation_issue('trigger', 'date', 'Choose a date from today on.'); end if;
    exception when others then issues := issues || leadflow_private.automation_issue('trigger', 'date', 'Choose a date.'); end;
  end if;
  return issues;
end $$;

-- The whole definition. Returns { valid, issues, nodes, actions, conditions, consequential, triggerType }.
create function leadflow_private.automation_check(definition jsonb, publisher_role text default null) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare issues jsonb := '[]'; t jsonb; tdef jsonb; visible jsonb; nodes integer := 0; conditions integer := 0; actions integer := 0; ids text[] := '{}'; consequential boolean := false;
  cfg jsonb; f jsonb; keys text[] := '{}'; limits jsonb := leadflow_private.automation_limits();
begin
  if definition is null or jsonb_typeof(definition) <> 'object' then
    return jsonb_build_object('valid', false, 'issues', jsonb_build_array(leadflow_private.automation_issue(null, 'definition', 'The workflow is empty.')));
  end if;
  t := definition->'trigger';
  tdef := leadflow_private.automation_trigger_def(t->>'type');
  if tdef is null then
    issues := issues || leadflow_private.automation_issue('trigger', 'type', 'Choose a trigger.');
    visible := leadflow_private.automation_common_fields();
  else
    cfg := coalesce(t->'config', '{}');
    if jsonb_typeof(cfg) <> 'object' then issues := issues || leadflow_private.automation_issue('trigger', 'config', 'Trigger settings must be an object.'); cfg := '{}'; end if;
    for f in select value from jsonb_array_elements(coalesce(tdef->'config', '[]')) loop
      if cfg ? (f->>'key') and (case when jsonb_typeof(cfg->(f->>'key')) <> 'number' then true else (cfg->>(f->>'key'))::numeric not between (f->>'min')::numeric and (f->>'max')::numeric end) then
        issues := issues || leadflow_private.automation_issue('trigger', f->>'key', format('%s must be from %s to %s.', f->>'label', f->>'min', f->>'max'));
      end if;
    end loop;
    if t->>'type' = 'schedule.time' then issues := issues || leadflow_private.automation_check_schedule(cfg); end if;
    if t->>'type' = 'webhook.received' then
      if (case when jsonb_typeof(coalesce(cfg->'fields', '[]')) <> 'array' then true else jsonb_array_length(coalesce(cfg->'fields', '[]')) > (limits->>'webhookFields')::integer end) then
        issues := issues || leadflow_private.automation_issue('trigger', 'fields', 'A webhook can define up to 20 fields.');
      else
        for f in select value from jsonb_array_elements(coalesce(cfg->'fields', '[]')) loop
          if coalesce(f->>'key', '') !~ '^[a-zA-Z][a-zA-Z0-9_]{0,39}$' or coalesce(f->>'type', '') not in ('text','number','boolean','date') then
            issues := issues || leadflow_private.automation_issue('trigger', 'fields', 'Each webhook field needs a key (letters, digits, underscores) and a type: text, number, true/false or date.');
          elsif f->>'key' = any(keys) then issues := issues || leadflow_private.automation_issue('trigger', 'fields', format('The field “%s” is listed twice.', f->>'key'));
          end if;
          keys := keys || (f->>'key');
        end loop;
      end if;
    end if;
    visible := leadflow_private.automation_trigger_fields(tdef, cfg);
    select x.issues, x.total into issues, conditions from leadflow_private.automation_check_group(t->'filter', visible, 'trigger', 1, issues, conditions) x;
  end if;
  select x.issues, x.nodes, x.conditions, x.actions, x.ids, x.consequential into issues, nodes, conditions, actions, ids, consequential
    from leadflow_private.automation_check_steps(definition->'steps', visible, 0, publisher_role, issues, nodes, conditions, actions, ids, consequential) x;
  if nodes > (limits->>'nodesPerWorkflow')::integer then issues := issues || leadflow_private.automation_issue(null, 'steps', format('A workflow can have at most %s steps.', limits->>'nodesPerWorkflow')); end if;
  if conditions > (limits->>'conditionsPerWorkflow')::integer then issues := issues || leadflow_private.automation_issue(null, 'steps', 'A workflow can have at most 60 conditions.'); end if;
  if actions = 0 then issues := issues || leadflow_private.automation_issue(null, 'steps', 'Add at least one action.'); end if;
  return jsonb_build_object('valid', jsonb_array_length(issues) = 0, 'issues', issues, 'nodes', nodes, 'actions', actions, 'conditions', conditions,
    'consequential', consequential, 'triggerType', t->>'type');
end $$;

-- ---------- Compilation ----------

-- The tree becomes a map of nodes with explicit next pointers: { entry, nodes: { id: { type, label, ..., next } } }.
-- Each branch path continues with the step after the branch. A tree has no cycles and no unreachable steps.
create function leadflow_private.automation_compile_steps(steps jsonb, continuation text, inout nodes jsonb, out entry text)
language plpgsql immutable set search_path = '' as $$
declare i integer; step jsonb; next_id text; cases jsonb; c jsonb; case_entry text; otherwise_entry text; n integer := jsonb_array_length(coalesce(steps, '[]'));
begin
  entry := continuation;
  for i in reverse n - 1 .. 0 loop
    step := steps->i;
    next_id := entry;
    if step->>'type' = 'branch' then
      cases := '[]';
      for c in select value from jsonb_array_elements(step->'cases') loop
        select x.nodes, x.entry into nodes, case_entry from leadflow_private.automation_compile_steps(coalesce(c->'steps', '[]'), next_id, nodes) x;
        cases := cases || jsonb_build_array(jsonb_build_object('id', c->>'id', 'label', c->>'label', 'when', c->'when', 'next', case_entry));
      end loop;
      select x.nodes, x.entry into nodes, otherwise_entry from leadflow_private.automation_compile_steps(coalesce(step->'otherwise'->'steps', '[]'), next_id, nodes) x;
      nodes := nodes || jsonb_build_object(step->>'id', jsonb_build_object('type', 'branch', 'label', coalesce(step->>'label', ''), 'cases', cases, 'otherwise', otherwise_entry));
    else
      nodes := nodes || jsonb_build_object(step->>'id', (step - 'id') || jsonb_build_object('next', next_id));
    end if;
    entry := step->>'id';
  end loop;
end $$;

create function leadflow_private.automation_compile(definition jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare nodes jsonb := '{}'; entry text;
begin
  select x.nodes, x.entry into nodes, entry from leadflow_private.automation_compile_steps(definition->'steps', null, nodes) x;
  return jsonb_build_object('entry', entry, 'nodes', nodes, 'trigger', definition->'trigger');
end $$;

-- ---------- Scheduling ----------

-- The next time a schedule fires after a moment, in the workspace's time zone. Null for a one-off that has passed.
create function leadflow_private.automation_next_fire(config jsonb, zone text, after_time timestamptz) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare local_after timestamp := after_time at time zone zone; d date := (after_time at time zone zone)::date; t time; candidate timestamp; i integer;
begin
  begin t := (config->>'time')::time; exception when others then return null; end;
  if config->>'frequency' = 'once' then
    candidate := (config->>'date')::date + t;
    return case when candidate > local_after then candidate at time zone zone end;
  end if;
  for i in 0 .. 62 loop
    candidate := (d + i) + t;
    if candidate > local_after and (config->>'frequency' = 'daily'
        or (config->>'frequency' = 'weekly' and extract(dow from d + i)::integer = (config->>'weekday')::integer)
        or (config->>'frequency' = 'monthly' and extract(day from d + i)::integer = (config->>'dayOfMonth')::integer)) then
      return candidate at time zone zone;
    end if;
  end loop;
  return null;
end $$;

-- ---------- Event capture ----------

-- Whether something in the workspace listens for any of these event types: an active workflow, or a run waiting for one.
create function leadflow_private.automation_listens(target_workspace uuid, event_types text[]) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from leadflow_private.automation_workflows w where w.workspace_id = target_workspace and w.status = 'active' and w.trigger_type = any(event_types))
    or exists (select 1 from leadflow_private.automation_runs r where r.workspace_id = target_workspace and r.status = 'waiting' and r.wait->>'event' = any(event_types))
$$;

create function leadflow_private.automation_kind_events(kind text) returns text[] language sql immutable set search_path = '' as $$
  select case kind when 'lead' then array['lead.created','lead.status_changed'] when 'task' then array['task.created','task.completed'] else '{}'::text[] end
$$;

-- Snapshot change detection is only kept while something listens. Starting to track records the current state, so
-- existing leads and tasks don't look new; changes made while nothing listened are not replayed.
create function leadflow_private.automation_track(target_workspace uuid, kind text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from leadflow_private.automation_tracking t where t.workspace_id = target_workspace and t.kind = automation_track.kind) then return; end if;
  delete from leadflow_private.automation_entity_state s where s.workspace_id = target_workspace and s.kind = automation_track.kind;
  if kind = 'lead' then
    insert into leadflow_private.automation_entity_state(workspace_id, kind, entity_id, state) select l.workspace_id, 'lead', l.id, l.status from public.leads l where l.workspace_id = target_workspace;
  else
    insert into leadflow_private.automation_entity_state(workspace_id, kind, entity_id, state)
      select t.workspace_id, 'task', t.id, case when t.completed then 'completed' when t.cancelled then 'cancelled' else 'open' end from public.follow_up_tasks t where t.workspace_id = target_workspace;
  end if;
  insert into leadflow_private.automation_tracking(workspace_id, kind) values (target_workspace, kind) on conflict do nothing;
end $$;

-- Payloads. Only what workflows need: no email addresses, phone numbers, messages or internal notes.
create function leadflow_private.automation_lead_data(l public.leads) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', l.id, 'name', l.name, 'company', l.company, 'website', l.website, 'hasWebsite', coalesce(l.website, '') <> '', 'hasEmail', coalesce(l.email, '') <> '',
    'hasPhone', coalesce(l.phone, '') <> '', 'status', l.status, 'source', l.source, 'service', l.service, 'industry', l.industry, 'city', l.city, 'country', l.country, 'createdAt', l."createdAt")
$$;
create function leadflow_private.automation_lead_ref(target_workspace uuid, target_lead text) returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('id', l.id, 'name', l.name, 'company', l.company) from public.leads l where l.workspace_id = target_workspace and l.id = target_lead),
    jsonb_build_object('id', target_lead))
$$;
create function leadflow_private.automation_task_data(t public.follow_up_tasks) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'title', left(t.notes, 300), 'type', t."taskType", 'priority', t.priority, 'dueDate', t.due,
    'status', case when t.completed then 'completed' when t.cancelled then 'cancelled' else t.status end, 'assigneeId', t."assigneeId", 'leadId', t."leadId", 'dealId', t."dealId",
    'clientId', t."clientId", 'projectId', t."projectId", 'milestoneId', t."milestoneId", 'deliverableId', t."deliverableId", 'createdByAutomation', t.id like 'auto-%')
$$;
create function leadflow_private.automation_task_keys(t public.follow_up_tasks) returns text[] language sql immutable set search_path = '' as $$
  select array_remove(array['task:' || t.id, 'lead:' || t."leadId", 'deal:' || t."dealId"::text, 'client:' || t."clientId"::text, 'project:' || t."projectId"::text,
    'deliverable:' || t."deliverableId"::text], null)
$$;
create function leadflow_private.automation_deal_data(d leadflow_private.deals) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'title', d.title, 'stage', s.name, 'stageCategory', s.category, 'value', d.value, 'currency', d.currency, 'priority', d.priority, 'ownerId', d.owner_id,
    'expectedCloseDate', d.expected_close_date, 'source', d.source, 'leadId', d.lead_id, 'leadName', (select l.name from public.leads l where l.workspace_id = d.workspace_id and l.id = d.lead_id))
  from leadflow_private.sales_stages s where s.id = d.stage_id
$$;
create function leadflow_private.automation_client_data(c leadflow_private.clients) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'industry', c.industry, 'status', c.status, 'ownerId', c.owner_id, 'dealId', c.deal_id, 'leadId', c.lead_id,
    'hasOnboarding', exists (select 1 from leadflow_private.onboarding_requests r where r.workspace_id = c.workspace_id and r.client_id = c.id and r.status <> 'cancelled'))
$$;
create function leadflow_private.automation_client_ref(target_client uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select leadflow_private.automation_client_data(c) from leadflow_private.clients c where c.id = target_client), '{}'::jsonb)
$$;
create function leadflow_private.automation_project_data(p leadflow_private.projects) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'type', p.project_type, 'status', p.status, 'priority', p.priority, 'ownerId', p.owner_id, 'clientId', p.client_id,
    'clientName', (select c.name from leadflow_private.clients c where c.id = p.client_id), 'startDate', p.start_date, 'targetDate', p.target_date, 'source', p.source,
    'portalShared', coalesce(p.portal_shared, false))
$$;
create function leadflow_private.automation_project_ref(target_project uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select leadflow_private.automation_project_data(p) from leadflow_private.projects p where p.id = target_project), '{}'::jsonb)
$$;
create function leadflow_private.automation_milestone_data(m leadflow_private.project_milestones) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'name', m.name, 'status', m.status, 'dueDate', m.due_date)
$$;
create function leadflow_private.automation_deliverable_data(d leadflow_private.project_deliverables) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'title', d.title, 'status', d.status, 'priority', d.priority, 'dueDate', d.due_date, 'ownerId', d.owner_id, 'clientVisible', d.client_visible,
    'reviewStatus', d.review_status, 'milestoneId', d.milestone_id)
$$;

-- Which of a run's context fields a waiting run gets when the event it waits for arrives.
create function leadflow_private.automation_wait_output(event_type text, data jsonb) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('received', true) || case event_type
    when 'analysis.completed' then jsonb_build_object('analysisId', data->'analysis'->'id', 'opportunityCount', data->'analysis'->'opportunityCount', 'topOpportunity', data->'analysis'->'topOpportunity')
    when 'deal.stage_changed' then jsonb_build_object('stage', data->'deal'->'stage')
    when 'onboarding.item_submitted' then jsonb_build_object('item', data->'item'->'title')
    when 'feedback.submitted' then jsonb_build_object('category', data->'feedback'->'category')
    else '{}'::jsonb end
$$;

-- Records an event and starts the workflows listening for it, in the caller's transaction (a transactional outbox).
-- The trigger filter is evaluated here, so only matching events create runs. Waiting runs whose key matches wake up.
-- target_workflow limits the event to one workflow (schedules, scheduled checks and webhooks).
-- Loop protection: an event caused by a workflow's own action never starts that workflow again, and chains stop after 3.
create function leadflow_private.automation_emit(target_workspace uuid, event_type text, entity_type text, entity_id text, event_data jsonb, event_keys text[],
  dedupe text, event_source text default 'app', target_workflow uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare chain uuid[]; new_event uuid; w leadflow_private.automation_workflows; v leadflow_private.automation_versions; r leadflow_private.automation_runs; matched boolean;
  limits jsonb := leadflow_private.automation_limits(); today date := leadflow_private.project_today(target_workspace); ctx jsonb; workspace_name text; created integer := 0;
  clean jsonb := leadflow_private.automation_sanitize_payload(event_data);
begin
  if exists (select 1 from leadflow_private.automation_settings s where s.workspace_id = target_workspace and s.paused) then return null; end if;
  if not exists (select 1 from leadflow_private.automation_workflows x where x.workspace_id = target_workspace and x.status = 'active' and x.trigger_type = event_type
      and (target_workflow is null or x.id = target_workflow))
    and not exists (select 1 from leadflow_private.automation_runs x where x.workspace_id = target_workspace and x.status = 'waiting' and x.wait->>'event' = event_type
      and x.wait->>'key' = any(event_keys)) then
    return null;
  end if;
  chain := coalesce(nullif(current_setting('leadflow.automation_chain', true), '')::uuid[], '{}');
  insert into leadflow_private.automation_events(workspace_id, event_type, entity_type, entity_id, keys, data, source, dedupe_key, chain)
    values (target_workspace, event_type, entity_type, left(entity_id, 200), coalesce(event_keys, '{}'), clean, event_source, left(dedupe, 300), chain)
    on conflict (workspace_id, dedupe_key) do nothing returning id into new_event;
  if new_event is null then return null; end if;
  select w2.name into workspace_name from public.workspaces w2 where w2.id = target_workspace;

  for w in select x.* from leadflow_private.automation_workflows x where x.workspace_id = target_workspace and x.status = 'active' and x.trigger_type = event_type
      and x.published_version_id is not null and (target_workflow is null or x.id = target_workflow) order by x.created_at loop
    select * into v from leadflow_private.automation_versions x where x.id = w.published_version_id;
    ctx := jsonb_build_object('trigger', clean, 'event', jsonb_build_object('id', new_event, 'type', event_type, 'entityType', entity_type, 'entityId', entity_id, 'source', event_source),
      'workspace', jsonb_build_object('name', workspace_name), 'run', jsonb_build_object('date', today, 'startedAt', now()), 'steps', '{}'::jsonb);
    -- Only workflows whose filter matches are considered; then loop protection, then rate limits.
    begin
      matched := leadflow_private.automation_eval_group(v.compiled->'trigger'->'filter', ctx, today);
    exception when others then matched := false;
      update leadflow_private.automation_workflows x set attention_code = 'filter_error', attention = 'The trigger filter couldn''t be evaluated. Check and republish it.', attention_at = now() where x.id = w.id;
    end;
    continue when not matched;
    if w.id = any(chain) or coalesce(cardinality(chain), 0) >= (limits->>'chainDepth')::integer then
      insert into leadflow_private.automation_runs(workspace_id, workflow_id, version_id, event_id, status, outcome, trigger_type, entity_type, entity_id, context, chain, error_code,
          error_summary, completed_at)
        values (target_workspace, w.id, v.id, new_event, 'cancelled', 'loop_blocked', event_type, entity_type, left(entity_id, 200), ctx, chain, 'loop_blocked',
          case when w.id = any(chain) then 'Not started: this event was caused by this workflow''s own action, which would repeat it.'
            else 'Not started: a chain of more than 3 workflows triggering each other was stopped.' end, now())
        on conflict do nothing;
      perform leadflow_private.automation_count(target_workspace, w.id, jsonb_build_object('blocked', 1));
      continue;
    end if;
    if (select count(*) from leadflow_private.automation_runs x where x.workflow_id = w.id and x.created_at > now() - interval '1 hour') >= (limits->>'runsPerWorkflowHour')::integer
      or (select count(*) from leadflow_private.automation_runs x where x.workspace_id = target_workspace and x.created_at > now() - interval '1 hour') >= (limits->>'runsPerWorkspaceHour')::integer then
      update leadflow_private.automation_workflows x set attention_code = 'throttled', attention_at = now(),
        attention = format('More than %s runs in an hour: further events were skipped. Check the trigger filter.', limits->>'runsPerWorkflowHour') where x.id = w.id;
      perform leadflow_private.automation_count(target_workspace, w.id, jsonb_build_object('throttled', 1));
      continue;
    end if;
    insert into leadflow_private.automation_runs(workspace_id, workflow_id, version_id, event_id, trigger_type, entity_type, entity_id, context, current_node, chain)
      values (target_workspace, w.id, v.id, new_event, event_type, entity_type, left(entity_id, 200), ctx, v.compiled->>'entry', chain)
      on conflict do nothing;
    if found then created := created + 1; perform leadflow_private.automation_count(target_workspace, w.id, jsonb_build_object('runs', 1)); end if;
  end loop;

  -- Runs waiting for this event on one of its records.
  for r in select x.* from leadflow_private.automation_runs x where x.workspace_id = target_workspace and x.status = 'waiting' and x.wait->>'event' = event_type
      and x.wait->>'key' = any(event_keys) for update skip locked loop
    update leadflow_private.automation_runs x set status = 'queued', next_run_at = now(), updated_at = now(),
      wait = r.wait || jsonb_build_object('arrived', new_event),
      context = jsonb_set(x.context, array['steps', r.wait->>'node'], leadflow_private.automation_wait_output(event_type, clean) || jsonb_build_object('receivedAt', now()))
      where x.id = r.id;
  end loop;
  return new_event;
end $$;

-- Event data is kept small and free of secrets. Strings longer than 500 characters are cut.
create function leadflow_private.automation_sanitize_payload(value jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare result jsonb := '{}'; k text; v jsonb;
begin
  if value is null or jsonb_typeof(value) <> 'object' then return '{}'; end if;
  for k, v in select key, x from jsonb_each(value) as e(key, x) loop
    result := result || jsonb_build_object(k, case jsonb_typeof(v) when 'string' then to_jsonb(left(leadflow_private.automation_redact_secrets(v #>> '{}'), 500))
      when 'object' then leadflow_private.automation_sanitize_payload(v) else v end);
  end loop;
  return result;
end $$;
-- Credentials only (event data may carry business text a workflow uses in a title, so emails stay there; logs remove them).
create function leadflow_private.automation_redact_secrets(raw text) returns text language sql immutable set search_path = '' as $$
  select regexp_replace(regexp_replace(regexp_replace(coalesce(raw, ''), '(lf|whsec|sk|pk|re)_[A-Za-z0-9]{16,}', '[redacted]', 'g'),
    '(?i)bearer\s+[A-Za-z0-9._~+/-]{8,}=*', 'Bearer [redacted]', 'g'), 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}', '[redacted]', 'g')
$$;

-- Daily usage counters. delta: any of runs, succeeded, failed, cancelled, actions, aiActions, emailActions, durationMs, finished, throttled, blocked, testRuns.
create function leadflow_private.automation_count(target_workspace uuid, target_workflow uuid, delta jsonb) returns void language sql security definer set search_path = '' as $$
  insert into leadflow_private.automation_usage_daily as u(workspace_id, day, workflow_id, runs, succeeded, failed, cancelled, actions, ai_actions, email_actions, duration_ms, finished,
      throttled, blocked, test_runs)
    values (target_workspace, leadflow_private.project_today(target_workspace), target_workflow, coalesce((delta->>'runs')::integer, 0), coalesce((delta->>'succeeded')::integer, 0),
      coalesce((delta->>'failed')::integer, 0), coalesce((delta->>'cancelled')::integer, 0), coalesce((delta->>'actions')::integer, 0), coalesce((delta->>'aiActions')::integer, 0),
      coalesce((delta->>'emailActions')::integer, 0), coalesce((delta->>'durationMs')::bigint, 0), coalesce((delta->>'finished')::integer, 0), coalesce((delta->>'throttled')::integer, 0),
      coalesce((delta->>'blocked')::integer, 0), coalesce((delta->>'testRuns')::integer, 0))
  on conflict (workspace_id, day, workflow_id) do update set runs = u.runs + excluded.runs, succeeded = u.succeeded + excluded.succeeded, failed = u.failed + excluded.failed,
    cancelled = u.cancelled + excluded.cancelled, actions = u.actions + excluded.actions, ai_actions = u.ai_actions + excluded.ai_actions,
    email_actions = u.email_actions + excluded.email_actions, duration_ms = u.duration_ms + excluded.duration_ms, finished = u.finished + excluded.finished,
    throttled = u.throttled + excluded.throttled, blocked = u.blocked + excluded.blocked, test_runs = u.test_runs + excluded.test_runs
$$;

-- Capture functions never break the business change that fired them: a failure is logged as a warning and skipped.

-- Leads (snapshot saves, intake, imports): statement triggers compare each written lead with the last state seen.
create function leadflow_private.automation_capture_leads() returns trigger language plpgsql security definer set search_path = '' as $$
declare ws uuid; l public.leads; prior text; rec record;
begin
  for ws in select distinct n.workspace_id from new_rows n loop
    begin
      if not leadflow_private.automation_listens(ws, leadflow_private.automation_kind_events('lead')) then
        delete from leadflow_private.automation_tracking t where t.workspace_id = ws and t.kind = 'lead';
        continue;
      end if;
      if not exists (select 1 from leadflow_private.automation_tracking t where t.workspace_id = ws and t.kind = 'lead') then
        perform leadflow_private.automation_track(ws, 'lead'); continue;
      end if;
      for rec in select n as row_value, s.state as prior_state from new_rows n left join leadflow_private.automation_entity_state s on s.workspace_id = ws and s.kind = 'lead' and s.entity_id = n.id
          where n.workspace_id = ws and (s.state is null or s.state <> n.status) loop
        l := rec.row_value; prior := rec.prior_state;
        if prior is null then
          perform leadflow_private.automation_emit(ws, 'lead.created', 'lead', l.id, jsonb_build_object('lead', leadflow_private.automation_lead_data(l)), array['lead:' || l.id], 'lead.created:' || l.id);
        else
          perform leadflow_private.automation_emit(ws, 'lead.status_changed', 'lead', l.id, jsonb_build_object('lead', leadflow_private.automation_lead_data(l), 'previousStatus', prior),
            array['lead:' || l.id], 'lead.status:' || l.id || ':' || md5(prior || '>' || l.status || ':' || clock_timestamp()::text));
        end if;
      end loop;
      insert into leadflow_private.automation_entity_state(workspace_id, kind, entity_id, state) select ws, 'lead', n.id, n.status from new_rows n where n.workspace_id = ws
        on conflict (workspace_id, kind, entity_id) do update set state = excluded.state where leadflow_private.automation_entity_state.state is distinct from excluded.state;
    exception when others then raise warning 'automation: lead capture skipped (%)', sqlstate;
    end;
  end loop;
  return null;
end $$;
create trigger automation_leads_inserted after insert on public.leads referencing new table as new_rows for each statement execute function leadflow_private.automation_capture_leads();
create trigger automation_leads_updated after update on public.leads referencing new table as new_rows for each statement execute function leadflow_private.automation_capture_leads();

create function leadflow_private.automation_capture_tasks() returns trigger language plpgsql security definer set search_path = '' as $$
declare ws uuid; t public.follow_up_tasks; prior text; current_state text; rec record;
begin
  for ws in select distinct n.workspace_id from new_rows n loop
    begin
      if not leadflow_private.automation_listens(ws, leadflow_private.automation_kind_events('task')) then
        delete from leadflow_private.automation_tracking x where x.workspace_id = ws and x.kind = 'task';
        continue;
      end if;
      if not exists (select 1 from leadflow_private.automation_tracking x where x.workspace_id = ws and x.kind = 'task') then
        perform leadflow_private.automation_track(ws, 'task'); continue;
      end if;
      for rec in select n as row_value, s.state as prior_state from new_rows n left join leadflow_private.automation_entity_state s on s.workspace_id = ws and s.kind = 'task' and s.entity_id = n.id
          where n.workspace_id = ws and (s.state is null or s.state <> case when n.completed then 'completed' when n.cancelled then 'cancelled' else 'open' end) loop
        t := rec.row_value; prior := rec.prior_state;
        current_state := case when t.completed then 'completed' when t.cancelled then 'cancelled' else 'open' end;
        if prior is null and current_state = 'open' then
          perform leadflow_private.automation_emit(ws, 'task.created', 'task', t.id, jsonb_build_object('task', leadflow_private.automation_task_data(t)),
            leadflow_private.automation_task_keys(t), 'task.created:' || t.id);
        elsif current_state = 'completed' and prior is distinct from 'completed' then
          perform leadflow_private.automation_emit(ws, 'task.completed', 'task', t.id, jsonb_build_object('task', leadflow_private.automation_task_data(t)),
            leadflow_private.automation_task_keys(t), 'task.completed:' || t.id || ':' || md5(clock_timestamp()::text));
        end if;
      end loop;
      insert into leadflow_private.automation_entity_state(workspace_id, kind, entity_id, state)
        select ws, 'task', n.id, case when n.completed then 'completed' when n.cancelled then 'cancelled' else 'open' end from new_rows n where n.workspace_id = ws
        on conflict (workspace_id, kind, entity_id) do update set state = excluded.state where leadflow_private.automation_entity_state.state is distinct from excluded.state;
    exception when others then raise warning 'automation: task capture skipped (%)', sqlstate;
    end;
  end loop;
  return null;
end $$;
create trigger automation_tasks_inserted after insert on public.follow_up_tasks referencing new table as new_rows for each statement execute function leadflow_private.automation_capture_tasks();
create trigger automation_tasks_updated after update on public.follow_up_tasks referencing new table as new_rows for each statement execute function leadflow_private.automation_capture_tasks();

-- Row events on private tables fire at commit (deferred constraint triggers), so related rows written later in the same
-- transaction (opportunities, feedback items, history) are visible, and each record is read as it finally is.
create function leadflow_private.automation_capture() returns trigger language plpgsql security definer set search_path = '' as $$
declare ws uuid := new.workspace_id; data jsonb; keys text[]; kind text; dedupe text; d leadflow_private.deals; p leadflow_private.projects; c leadflow_private.clients;
  dl leadflow_private.project_deliverables; m leadflow_private.project_milestones; a leadflow_private.business_analyses; ob leadflow_private.onboarding_requests;
  dr leadflow_private.outreach_drafts; lc leadflow_private.lead_contacts; top leadflow_private.business_opportunities; cu leadflow_private.client_users;
begin
  case tg_table_name
    when 'business_analyses' then
      select * into a from leadflow_private.business_analyses x where x.id = new.id;
      if a.status not in ('completed','partial','failed') then return null; end if;
      select * into top from leadflow_private.business_opportunities o where o.analysis_id = a.id and o.status <> 'dismissed'
        order by case o.priority when 'high' then 0 when 'medium' then 1 else 2 end, case o.confidence when 'high' then 0 when 'medium' then 1 else 2 end limit 1;
      kind := case when a.status = 'failed' then 'analysis.failed' else 'analysis.completed' end;
      data := jsonb_build_object('lead', leadflow_private.automation_lead_ref(ws, a.lead_id), 'analysis', jsonb_build_object('id', a.id, 'status', a.status, 'pagesAnalyzed', a.pages_analyzed,
        'opportunityCount', (select count(*) from leadflow_private.business_opportunities o where o.analysis_id = a.id and o.status <> 'dismissed'),
        'highPriorityOpportunities', (select count(*) from leadflow_private.business_opportunities o where o.analysis_id = a.id and o.status <> 'dismissed' and o.priority = 'high'),
        'topOpportunity', coalesce(top.title, ''), 'topOpportunityService', coalesce(top.service_name, ''),
        'matchedServices', coalesce((select jsonb_agg(distinct o.service_name) from leadflow_private.business_opportunities o where o.analysis_id = a.id and o.service_name <> ''), '[]'),
        'failure', left(coalesce(a.failure, ''), 200)));
      perform leadflow_private.automation_emit(ws, kind, 'analysis', a.id::text, data, array['lead:' || a.lead_id, 'analysis:' || a.id], kind || ':' || a.id);
    when 'lead_contacts' then
      select * into lc from leadflow_private.lead_contacts x where x.id = new.id;
      if lc.id is null then return null; end if;
      perform leadflow_private.automation_emit(ws, 'contact.created', 'contact', lc.id::text, jsonb_build_object('lead', leadflow_private.automation_lead_ref(ws, lc.lead_id),
        'contact', jsonb_build_object('id', lc.id, 'name', coalesce(nullif(lc.full_name, ''), lc.label), 'role', lc.role, 'jobTitle', lc.job_title, 'hasEmail', lc.email <> '', 'hasPhone', lc.phone <> '')),
        array['lead:' || lc.lead_id, 'contact:' || lc.id], 'contact.created:' || lc.id);
    when 'outreach_drafts' then
      select * into dr from leadflow_private.outreach_drafts x where x.id = new.id;
      if dr.id is null then return null; end if;
      kind := case when tg_op = 'INSERT' then 'outreach.draft_created' when dr.status = 'ready' then 'outreach.marked_ready' when dr.status = 'sent' then 'outreach.marked_sent' end;
      if kind is null or (tg_op = 'UPDATE' and old.status = new.status) then return null; end if;
      perform leadflow_private.automation_emit(ws, kind, 'draft', dr.id::text, jsonb_build_object('lead', leadflow_private.automation_lead_ref(ws, dr.lead_id),
        'draft', jsonb_build_object('id', dr.id, 'channel', dr.channel, 'status', dr.status, 'sequenceStep', dr.sequence_step)), array['lead:' || dr.lead_id, 'draft:' || dr.id],
        kind || ':' || dr.id || case when tg_op = 'UPDATE' then ':' || md5(clock_timestamp()::text) else '' end);
    when 'deal_stage_history' then
      select * into d from leadflow_private.deals x where x.id = new.deal_id;
      if d.id is null then return null; end if;
      kind := case when new.from_stage_id is null and new.from_name is null then 'deal.created' when new.to_category = 'won' then 'deal.won' when new.to_category = 'lost' then 'deal.lost'
        else 'deal.stage_changed' end;
      data := jsonb_build_object('deal', leadflow_private.automation_deal_data(d), 'previousStage', new.from_name, 'wonValue', d.won_value, 'lostReason', d.lost_reason);
      perform leadflow_private.automation_emit(ws, kind, 'deal', d.id::text, data, array['deal:' || d.id, 'lead:' || d.lead_id], kind || ':' || new.id);
    when 'deal_meetings' then
      select * into d from leadflow_private.deals x where x.id = new.deal_id;
      if d.id is null then return null; end if;
      perform leadflow_private.automation_emit(ws, 'deal.meeting_scheduled', 'deal', d.id::text, jsonb_build_object('deal', leadflow_private.automation_deal_data(d),
        'meeting', jsonb_build_object('id', new.id, 'title', new.title, 'startsAt', new.starts_at, 'status', new.status)), array['deal:' || d.id], 'deal.meeting:' || new.id);
    when 'clients' then
      select * into c from leadflow_private.clients x where x.id = new.id;
      if c.id is null then return null; end if;
      perform leadflow_private.automation_emit(ws, 'client.created', 'client', c.id::text, jsonb_build_object('client', leadflow_private.automation_client_data(c)),
        array_remove(array['client:' || c.id, 'deal:' || c.deal_id::text, 'lead:' || c.lead_id], null), 'client.created:' || c.id);
    when 'client_invitations' then
      perform leadflow_private.automation_emit(ws, 'client.invited', 'client', new.client_id::text, jsonb_build_object('client', leadflow_private.automation_client_ref(new.client_id),
        'invitation', jsonb_build_object('role', new.role)), array['client:' || new.client_id], 'client.invited:' || new.id);
    when 'client_users' then
      select * into cu from leadflow_private.client_users x where x.id = new.id;
      if cu.id is null or cu.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then return null; end if;
      perform leadflow_private.automation_emit(ws, 'client.activated', 'client', cu.client_id::text, jsonb_build_object('client', leadflow_private.automation_client_ref(cu.client_id),
        'access', jsonb_build_object('role', cu.role)), array['client:' || cu.client_id], 'client.activated:' || cu.id || ':' || md5(clock_timestamp()::text));
    when 'onboarding_requests' then
      select * into ob from leadflow_private.onboarding_requests x where x.id = new.id;
      if ob.id is null then return null; end if;
      perform leadflow_private.automation_emit(ws, 'onboarding.started', 'onboarding', ob.id::text, jsonb_build_object('client', leadflow_private.automation_client_ref(ob.client_id),
        'onboarding', jsonb_build_object('id', ob.id, 'title', ob.title, 'status', ob.status, 'templateName', coalesce(ob.template_name, ''), 'dueDate', ob.due_date)),
        array_remove(array['onboarding:' || ob.id, 'client:' || ob.client_id::text], null), 'onboarding.started:' || ob.id);
    when 'onboarding_items' then
      if new.state <> 'submitted' or (tg_op = 'UPDATE' and old.state = 'submitted' and old.revision = new.revision) then return null; end if;
      select * into ob from leadflow_private.onboarding_requests x where x.id = new.request_id;
      perform leadflow_private.automation_emit(ws, 'onboarding.item_submitted', 'onboarding', ob.id::text, jsonb_build_object('client', leadflow_private.automation_client_ref(ob.client_id),
        'onboarding', jsonb_build_object('id', ob.id, 'title', ob.title, 'status', ob.status, 'templateName', coalesce(ob.template_name, ''), 'dueDate', ob.due_date),
        'item', jsonb_build_object('title', new.title, 'section', new.section, 'required', new.required)),
        array_remove(array['onboarding:' || ob.id, 'client:' || ob.client_id::text], null), 'onboarding.item:' || new.id || ':' || new.revision);
    when 'client_scope_confirmations' then
      perform leadflow_private.automation_emit(ws, 'scope.confirmed', 'client', new.client_id::text, jsonb_build_object('client', leadflow_private.automation_client_ref(new.client_id),
        'scope', jsonb_build_object('sequence', new.sequence, 'servicesConfirmed', jsonb_array_length(coalesce(new.snapshot->'services', '[]')),
          'requirementsConfirmed', jsonb_array_length(coalesce(new.snapshot->'requirements', '[]')), 'sharedWithClient', new.shared_with_client)),
        array['client:' || new.client_id], 'scope.confirmed:' || new.id);
    when 'client_onboarding_completions' then
      perform leadflow_private.automation_emit(ws, 'onboarding.completed', 'client', new.client_id::text, jsonb_build_object('client', leadflow_private.automation_client_ref(new.client_id),
        'completion', jsonb_build_object('id', new.id, 'override', new.override_reason is not null, 'outstandingItems', jsonb_array_length(new.outstanding),
          'confirmedServices', jsonb_array_length(coalesce(new.snapshot->'services', '[]')), 'confirmedRequirements', jsonb_array_length(coalesce(new.snapshot->'requirements', '[]'))),
        'hasProject', exists (select 1 from leadflow_private.projects x where x.completion_id = new.id)),
        array['client:' || new.client_id, 'completion:' || new.id], 'onboarding.completed:' || new.id);
    when 'projects' then
      select * into p from leadflow_private.projects x where x.id = new.id;
      if p.id is null then return null; end if;
      if tg_op = 'INSERT' then
        perform leadflow_private.automation_emit(ws, 'project.created', 'project', p.id::text, jsonb_build_object('project', leadflow_private.automation_project_data(p)),
          array['project:' || p.id, 'client:' || p.client_id], 'project.created:' || p.id);
      elsif old.status is distinct from new.status then
        perform leadflow_private.automation_emit(ws, 'project.status_changed', 'project', p.id::text, jsonb_build_object('project', leadflow_private.automation_project_data(p), 'previousStatus', old.status),
          array['project:' || p.id, 'client:' || p.client_id], 'project.status:' || p.id || ':' || md5(old.status || '>' || new.status || clock_timestamp()::text));
      end if;
    when 'project_milestones' then
      select * into m from leadflow_private.project_milestones x where x.id = new.id;
      if m.id is null then return null; end if;
      if tg_op = 'INSERT' then
        perform leadflow_private.automation_emit(ws, 'milestone.created', 'milestone', m.id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(m.project_id),
          'milestone', leadflow_private.automation_milestone_data(m)), array['milestone:' || m.id, 'project:' || m.project_id], 'milestone.created:' || m.id);
      elsif new.status = 'completed' and old.status <> 'completed' then
        perform leadflow_private.automation_emit(ws, 'milestone.completed', 'milestone', m.id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(m.project_id),
          'milestone', leadflow_private.automation_milestone_data(m)), array['milestone:' || m.id, 'project:' || m.project_id], 'milestone.completed:' || m.id || ':' || md5(clock_timestamp()::text));
      end if;
    when 'project_deliverables' then
      select * into dl from leadflow_private.project_deliverables x where x.id = new.id;
      if dl.id is null then return null; end if;
      keys := array['deliverable:' || dl.id, 'project:' || dl.project_id];
      if tg_op = 'INSERT' then
        perform leadflow_private.automation_emit(ws, 'deliverable.created', 'deliverable', dl.id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(dl.project_id),
          'deliverable', leadflow_private.automation_deliverable_data(dl)), keys, 'deliverable.created:' || dl.id);
      else
        if old.status is distinct from new.status then
          perform leadflow_private.automation_emit(ws, 'deliverable.status_changed', 'deliverable', dl.id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(dl.project_id),
            'deliverable', leadflow_private.automation_deliverable_data(dl), 'previousStatus', old.status), keys,
            'deliverable.status:' || dl.id || ':' || md5(old.status || '>' || new.status || clock_timestamp()::text));
        end if;
        if new.client_visible and not old.client_visible then
          perform leadflow_private.automation_emit(ws, 'deliverable.shared', 'deliverable', dl.id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(dl.project_id),
            'deliverable', leadflow_private.automation_deliverable_data(dl)), keys, 'deliverable.shared:' || dl.id || ':' || md5(clock_timestamp()::text));
        end if;
      end if;
    when 'deliverable_reviews' then
      select * into dl from leadflow_private.project_deliverables x where x.id = new.deliverable_id;
      perform leadflow_private.automation_emit(ws, 'review.requested', 'deliverable', dl.id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(dl.project_id),
        'deliverable', leadflow_private.automation_deliverable_data(dl), 'review', jsonb_build_object('id', new.id, 'versionNumber', (select v.number from leadflow_private.deliverable_versions v where v.id = new.version_id),
          'dueDate', new.due_date, 'resubmission', exists (select 1 from leadflow_private.deliverable_reviews r where r.deliverable_id = new.deliverable_id and r.id <> new.id
            and r.status in ('changes_requested','rejected')))), array['deliverable:' || dl.id, 'project:' || dl.project_id], 'review.requested:' || new.id);
    when 'deliverable_decisions' then
      select * into dl from leadflow_private.project_deliverables x where x.id = new.deliverable_id;
      kind := case new.decision when 'approved' then 'deliverable.approved' when 'rejected' then 'deliverable.rejected' else 'deliverable.changes_requested' end;
      perform leadflow_private.automation_emit(ws, kind, 'deliverable', dl.id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(dl.project_id),
        'deliverable', leadflow_private.automation_deliverable_data(dl), 'decision', jsonb_build_object('versionNumber', (select v.number from leadflow_private.deliverable_versions v where v.id = new.version_id),
          'feedbackItems', (select count(*) from leadflow_private.deliverable_feedback f where f.review_id = new.review_id))),
        array['deliverable:' || dl.id, 'project:' || dl.project_id], kind || ':' || new.id);
    when 'deliverable_feedback' then
      select * into dl from leadflow_private.project_deliverables x where x.id = new.deliverable_id;
      perform leadflow_private.automation_emit(ws, 'feedback.submitted', 'deliverable', dl.id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(dl.project_id),
        'deliverable', leadflow_private.automation_deliverable_data(dl), 'feedback', jsonb_build_object('id', new.id, 'title', new.title, 'category', new.category)),
        array['deliverable:' || dl.id, 'project:' || dl.project_id], 'feedback.submitted:' || new.id);
    when 'project_comments' then
      if new.author_type <> 'client' then return null; end if;
      perform leadflow_private.automation_emit(ws, 'comment.client_created', 'project', new.project_id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(new.project_id),
        'comment', jsonb_build_object('id', new.id, 'onDeliverable', new.deliverable_id is not null)), array['project:' || new.project_id], 'comment.client:' || new.id);
    when 'client_documents' then
      if new.status <> 'available' or new.uploaded_client_user is null or (tg_op = 'UPDATE' and old.status = 'available') then return null; end if;
      perform leadflow_private.automation_emit(ws, 'file.client_uploaded', 'client', new.client_id::text, jsonb_build_object('client', leadflow_private.automation_client_ref(new.client_id),
        'file', jsonb_build_object('id', new.id, 'name', left(new.file_name, 200), 'category', new.category),
        'project', case when new.project_id is null then null else jsonb_build_object('id', new.project_id, 'name', (select x.name from leadflow_private.projects x where x.id = new.project_id)) end),
        array_remove(array['client:' || new.client_id, 'project:' || new.project_id::text], null), 'file.client:' || new.id);
    when 'project_updates' then
      if new.status <> 'published' or (tg_op = 'UPDATE' and old.status = 'published') then return null; end if;
      perform leadflow_private.automation_emit(ws, 'update.published', 'project', new.project_id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(new.project_id),
        'update', jsonb_build_object('id', new.id, 'title', new.title)), array['project:' || new.project_id], 'update.published:' || new.id);
    else null;
  end case;
  return null;
exception when others then
  raise warning 'automation: % capture skipped (%)', tg_table_name, sqlstate;
  return null;
end $$;

create constraint trigger automation_capture after update of status on leadflow_private.business_analyses deferrable initially deferred for each row
  when (old.status is distinct from new.status and new.status in ('completed','partial','failed')) execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.lead_contacts deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert or update of status on leadflow_private.outreach_drafts deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.deal_stage_history deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.deal_meetings deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.clients deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.client_invitations deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert or update of status on leadflow_private.client_users deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.onboarding_requests deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert or update of state, revision on leadflow_private.onboarding_items deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.client_scope_confirmations deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.client_onboarding_completions deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert or update of status on leadflow_private.projects deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert or update of status on leadflow_private.project_milestones deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert or update of status, client_visible on leadflow_private.project_deliverables deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.deliverable_reviews deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.deliverable_decisions deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.deliverable_feedback deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert on leadflow_private.project_comments deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert or update of status on leadflow_private.client_documents deferrable initially deferred for each row execute function leadflow_private.automation_capture();
create constraint trigger automation_capture after insert or update of status on leadflow_private.project_updates deferrable initially deferred for each row execute function leadflow_private.automation_capture();

-- Automation alerts are a member notification event: members choose in Settings whether they also get them by email.
create or replace function leadflow_private.member_events() returns jsonb language sql immutable set search_path = '' as $$
  select '["client_activated","feedback_submitted","changes_requested","deliverable_approved","deliverable_rejected","client_commented","client_file_uploaded","automation_alert"]'::jsonb
$$;
create or replace function leadflow_private.member_email_defaults() returns jsonb language sql immutable set search_path = '' as $$
  select '["client_activated","feedback_submitted","changes_requested","deliverable_approved","deliverable_rejected","automation_alert"]'::jsonb
$$;
