-- M9 sales pipeline and deal management.
-- * Stages: a configurable pipeline per workspace (sales_stages), each open, won or lost, with an optional default
--   probability. The ten default stages are created on first use. Stages are archived, never deleted, and archiving one
--   that still has deals requires moving them to another stage of the same kind.
-- * Deals: a commercial opportunity with a lead, separate from the lead itself, so a lead can have several. A deal points
--   to the lead (by ID, like analyses and contacts, because snapshot saves replace leads), and may point to an M8 contact,
--   an M7 opportunity and an M8 outreach draft. Every stage change is recorded in deal_stage_history in the same
--   transaction, and a version number protects concurrent edits. Won and lost are explicit workflows that keep the full
--   history; reopening is explicit too. Deals are archived, not deleted.
-- * Activities: notes, replies, calls, proposals, meetings and lifecycle events in deal_activities. The deal timeline also
--   reads the deal's follow-up tasks, the lead's M8 outreach drafts and the lead's activity history, so nothing is copied.
-- * Follow-up tasks: the existing public.follow_up_tasks gain optional deal, contact, type, priority, cancelled, assignee,
--   description and timestamp columns. They are still saved with the workspace snapshot; a trigger checks that a task's
--   deal and contact belong to its lead and that an assignee is a member.
-- * Client handoff: one record per won deal, created only on explicit confirmation, for M10 to pick up.
-- All new tables are private; members act through role-checked functions.
-- Reverse with supabase/rollbacks/202611230001_sales_pipeline.down.sql.

-- ---------- Tables ----------

create table leadflow_private.sales_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  color text not null default '#64748b' check (color ~ '^#[0-9a-f]{6}$'),
  position integer not null check (position between 0 and 1000),
  category text not null check (category in ('open','won','lost')),
  -- Used for weighted pipeline when a deal has no probability of its own.
  probability integer check (probability between 0 and 100),
  -- The default stage it came from (new, contacted, replied…), so outreach events can suggest the right stage after renames.
  key text check (key in ('new','qualified','contacted','replied','interested','meeting','proposal','negotiation','won','lost')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index sales_stages_name on leadflow_private.sales_stages(workspace_id, lower(btrim(name))) where archived_at is null;
create unique index sales_stages_key on leadflow_private.sales_stages(workspace_id, key) where key is not null;
create index sales_stages_workspace on leadflow_private.sales_stages(workspace_id, position);

create table leadflow_private.sales_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  default_currency text not null default 'USD' check (default_currency ~ '^[A-Z]{3}$'),
  currencies text[] not null default '{USD}' check (cardinality(currencies) between 1 and 20),
  lost_reasons text[] not null default '{"Budget constraints","Chose a competitor","No response","Not interested","Timing not suitable","Service mismatch","Project cancelled","Other"}'
    check (cardinality(lost_reasons) between 1 and 20),
  default_stage_id uuid references leadflow_private.sales_stages(id) on delete set null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  check (default_currency = any(currencies))
);

create table leadflow_private.deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null check (length(lead_id) between 1 and 200),
  request_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 150),
  description text not null default '' check (length(description) <= 4000),
  stage_id uuid not null references leadflow_private.sales_stages(id) on delete restrict,
  -- The stage's category when the deal entered it; open, won or lost.
  outcome text not null default 'open' check (outcome in ('open','won','lost')),
  contact_id uuid references leadflow_private.lead_contacts(id) on delete set null,
  opportunity_id uuid references leadflow_private.business_opportunities(id) on delete set null,
  -- Snapshots, kept if the opportunity or service is later removed or renamed.
  opportunity_title text not null default '' check (length(opportunity_title) <= 200),
  opportunity_type text,
  service_id uuid references leadflow_private.agency_services(id) on delete set null,
  service_name text not null default '' check (length(service_name) <= 80),
  source text not null default 'manual' check (source in ('manual','lead','opportunity','outreach','pipeline')),
  source_draft_id uuid references leadflow_private.outreach_drafts(id) on delete set null,
  value numeric(14,2) check (value >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  probability integer check (probability between 0 and 100),
  expected_close_date date,
  actual_close_date date,
  won_value numeric(14,2) check (won_value >= 0),
  won_notes text not null default '' check (length(won_notes) <= 2000),
  lost_reason text check (length(lost_reason) between 1 and 60),
  lost_notes text not null default '' check (length(lost_notes) <= 2000),
  priority text not null default 'medium' check (priority in ('low','medium','high')),
  owner_id uuid references public.profiles(id) on delete set null,
  notes text not null default '' check (length(notes) <= 4000),
  version integer not null default 1,
  stage_entered_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  closed_at timestamptz,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, request_id),
  check ((outcome = 'open') = (closed_at is null)),
  check (outcome = 'lost' or lost_reason is null)
);
create index deals_board on leadflow_private.deals(workspace_id, stage_id, updated_at desc) where archived_at is null;
create index deals_lead on leadflow_private.deals(workspace_id, lead_id);
create index deals_outcome on leadflow_private.deals(workspace_id, outcome, closed_at) where archived_at is null;
create index deals_owner on leadflow_private.deals(workspace_id, owner_id) where archived_at is null;
create index deals_close on leadflow_private.deals(workspace_id, expected_close_date) where archived_at is null and outcome = 'open';

create table leadflow_private.deal_stage_history (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deal_id uuid not null references leadflow_private.deals(id) on delete cascade,
  from_stage_id uuid references leadflow_private.sales_stages(id) on delete set null,
  to_stage_id uuid references leadflow_private.sales_stages(id) on delete set null,
  -- Names and categories as they were, so renames don't rewrite history.
  from_name text check (length(from_name) <= 60),
  to_name text not null check (length(to_name) <= 60),
  to_category text not null check (to_category in ('open','won','lost')),
  moved_by uuid,
  moved_at timestamptz not null default now(),
  request_id uuid
);
create index deal_stage_history_deal on leadflow_private.deal_stage_history(deal_id, moved_at);
create unique index deal_stage_history_request on leadflow_private.deal_stage_history(workspace_id, request_id) where request_id is not null;

create table leadflow_private.deal_activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deal_id uuid not null references leadflow_private.deals(id) on delete cascade,
  kind text not null check (kind in ('deal_created','stage_changed','value_updated','details_updated','note','reply','call','proposal_sent',
    'meeting_scheduled','meeting_updated','meeting_completed','meeting_cancelled','meeting_no_show','won','lost','reopened','archived','restored','handoff_confirmed')),
  summary text not null check (length(summary) between 1 and 300),
  details text not null default '' check (length(details) <= 4000),
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4000),
  contact_id uuid references leadflow_private.lead_contacts(id) on delete set null,
  meeting_id uuid,
  occurred_at timestamptz not null default now(),
  actor uuid,
  created_at timestamptz not null default now(),
  request_id uuid
);
create index deal_activities_deal on leadflow_private.deal_activities(deal_id, occurred_at desc);
create unique index deal_activities_request on leadflow_private.deal_activities(workspace_id, request_id) where request_id is not null;

create table leadflow_private.deal_meetings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deal_id uuid not null references leadflow_private.deals(id) on delete cascade,
  request_id uuid not null,
  contact_id uuid references leadflow_private.lead_contacts(id) on delete set null,
  title text not null check (length(btrim(title)) between 1 and 150),
  starts_at timestamptz not null,
  duration_minutes integer not null default 30 check (duration_minutes between 5 and 480),
  timezone text not null default 'UTC' check (length(timezone) between 1 and 60),
  location text not null default '' check (length(location) <= 300),
  meeting_url text not null default '' check (meeting_url = '' or (length(meeting_url) <= 500 and meeting_url ~* '^https?://')),
  agenda text not null default '' check (length(agenda) <= 2000),
  notes text not null default '' check (length(notes) <= 4000),
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled','no_show')),
  version integer not null default 1,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, request_id)
);
create index deal_meetings_deal on leadflow_private.deal_meetings(deal_id, starts_at);
create index deal_meetings_upcoming on leadflow_private.deal_meetings(workspace_id, starts_at) where status = 'scheduled';

-- What M10 needs to start client work from a won deal. One per deal, created only when a person confirms.
create table leadflow_private.client_handoffs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deal_id uuid not null unique references leadflow_private.deals(id) on delete restrict,
  lead_id text not null,
  contact_id uuid references leadflow_private.lead_contacts(id) on delete set null,
  -- The deal as it was at handoff: title, value, currency, services, opportunity, contacts and notes.
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 20000),
  note text not null default '' check (length(note) <= 2000),
  confirmed_by uuid,
  created_at timestamptz not null default now()
);

alter table leadflow_private.sales_stages enable row level security;
alter table leadflow_private.sales_settings enable row level security;
alter table leadflow_private.deals enable row level security;
alter table leadflow_private.deal_stage_history enable row level security;
alter table leadflow_private.deal_activities enable row level security;
alter table leadflow_private.deal_meetings enable row level security;
alter table leadflow_private.client_handoffs enable row level security;
revoke all on leadflow_private.sales_stages, leadflow_private.sales_settings, leadflow_private.deals, leadflow_private.deal_stage_history,
  leadflow_private.deal_activities, leadflow_private.deal_meetings, leadflow_private.client_handoffs from public, anon, authenticated;

-- ---------- Follow-up tasks: the one task system, extended for deals ----------

alter table leadflow_private.lead_contacts add constraint lead_contacts_workspace_id unique (workspace_id, id);
alter table public.follow_up_tasks
  add column "dealId" uuid,
  add column "contactId" uuid,
  add column "taskType" text not null default 'follow_up' check ("taskType" in ('follow_up','call','email','whatsapp','meeting','proposal','proposal_review','internal','custom')),
  add column priority text not null default 'medium' check (priority in ('low','medium','high')),
  add column cancelled boolean not null default false,
  add column description text not null default '' check (length(description) <= 2000),
  add column "assigneeId" uuid,
  add column "createdAt" timestamptz check ("createdAt" is null or isfinite("createdAt")),
  add column "completedAt" timestamptz check ("completedAt" is null or isfinite("completedAt")),
  add constraint follow_up_tasks_state check (not (completed and cancelled)),
  -- Composite keys keep a task's deal and contact inside the task's workspace.
  add constraint follow_up_tasks_deal foreign key (workspace_id, "dealId") references leadflow_private.deals(workspace_id, id) on delete set null ("dealId"),
  add constraint follow_up_tasks_contact foreign key (workspace_id, "contactId") references leadflow_private.lead_contacts(workspace_id, id) on delete set null ("contactId");
create index follow_up_tasks_deal on public.follow_up_tasks(workspace_id, "dealId") where "dealId" is not null;

-- A task's deal and contact must belong to the task's lead; an assignee must be a member.
create function leadflow_private.check_follow_up_task() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new."dealId" is not null and not exists (select 1 from leadflow_private.deals d where d.workspace_id = new.workspace_id and d.id = new."dealId" and d.lead_id = new."leadId") then
    raise exception 'A follow-up’s deal must belong to the same lead.' using errcode = '22023';
  end if;
  if new."contactId" is not null and not exists (select 1 from leadflow_private.lead_contacts c where c.workspace_id = new.workspace_id and c.id = new."contactId" and c.lead_id = new."leadId") then
    raise exception 'A follow-up’s contact must belong to the same lead.' using errcode = '22023';
  end if;
  -- A new assignment must be a member. The snapshot save re-inserts every task, so it lists the assignees tasks already
  -- had (leadflow.kept_assignees); those stay even if the person has since left the workspace.
  if new."assigneeId" is not null
      and (tg_op = 'INSERT' or new."assigneeId" is distinct from old."assigneeId")
      and not exists (select 1 from public.workspace_memberships m where m.workspace_id = new.workspace_id and m.user_id = new."assigneeId")
      and coalesce(nullif(current_setting('leadflow.kept_assignees', true), ''), '{}')::jsonb ->> new.id is distinct from new."assigneeId"::text then
    raise exception 'Assign follow-ups to members of this workspace.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger follow_up_task_check before insert or update on public.follow_up_tasks for each row execute function leadflow_private.check_follow_up_task();

-- The snapshot save, extended with the new task fields. Unchanged otherwise (202610310001_lead_discovery.sql).
-- An assignee who has left the workspace is kept on tasks that already had them.
create or replace function public.save_workspace_for(target_workspace uuid, payload jsonb, expected_revision bigint, request_id uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare actor_role text; current_revision bigint; receipt public.workspace_requests; fingerprint text; kept jsonb;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if request_id is null or expected_revision is null then raise exception 'Missing request identity or revision.'; end if;
  if payload is null or payload->>'version' is distinct from '1'
    or jsonb_typeof(payload->'leads') is distinct from 'array'
    or jsonb_typeof(payload->'tasks') is distinct from 'array'
    or jsonb_typeof(payload->'activities') is distinct from 'array' then raise exception 'Invalid workspace data.'; end if;
  if octet_length(payload::text) > 5000000 or jsonb_array_length(payload->'leads') > 5000
    or jsonb_array_length(payload->'tasks') > 10000 or jsonb_array_length(payload->'activities') > 20000 then raise exception 'Workspace is too large (5 MB maximum).'; end if;
  fingerprint := md5(payload::text || ':' || expected_revision::text);
  select revision into current_revision from public.workspaces where id = target_workspace;
  select * into receipt from public.workspace_requests r where r.workspace_id = target_workspace and r.request_id = save_workspace_for.request_id;
  if found then
    if receipt.payload_hash <> fingerprint then raise exception 'Request ID already used for different data.'; end if;
    return receipt.revision;
  end if;
  if current_revision <> expected_revision then raise exception 'Workspace changed in another session. Reload the workspace before trying again.' using errcode = '40001'; end if;
  if actor_role = 'member' then
    if exists ((select l.id from public.leads l where l.workspace_id = target_workspace) except (select x.id from jsonb_to_recordset(payload->'leads') as x(id text)))
      or exists ((select t.id from public.follow_up_tasks t where t.workspace_id = target_workspace) except (select x.id from jsonb_to_recordset(payload->'tasks') as x(id text))) then
      raise exception 'Only workspace owners and admins can remove leads or follow-ups.' using errcode = '42501';
    end if;
    if exists ((select a.id, a."leadId", a.text, a.at from public.activity_history a where a.workspace_id = target_workspace)
      except (select x.id, x."leadId", x.text, x.at from jsonb_to_recordset(payload->'activities') as x(id text, "leadId" text, text text, at timestamptz))) then
      raise exception 'Members can add to the activity history but not change or remove it.' using errcode = '42501';
    end if;
  end if;
  -- Assignees already on a task stay even if they left the workspace; any new assignment is checked by the trigger.
  select coalesce(jsonb_object_agg(t.id, t."assigneeId"), '{}') into kept from public.follow_up_tasks t where t.workspace_id = target_workspace and t."assigneeId" is not null;
  delete from public.leads where workspace_id = target_workspace;
  insert into public.leads(workspace_id, id, name, email, phone, company, service, source, message, status, "createdAt",
      website, industry, address, city, region, postcode, country)
    select target_workspace, x.id, x.name, x.email, x.phone, x.company, x.service, x.source, x.message, x.status, x."createdAt",
      coalesce(x.website, ''), coalesce(x.industry, ''), coalesce(x.address, ''), coalesce(x.city, ''), coalesce(x.region, ''), coalesce(x.postcode, ''), coalesce(x.country, '')
    from jsonb_to_recordset(payload->'leads') as x(id text, name text, email text, phone text, company text, service text, source text, message text, status text, "createdAt" timestamptz,
      website text, industry text, address text, city text, region text, postcode text, country text);
  perform set_config('leadflow.kept_assignees', kept::text, true);
  insert into public.follow_up_tasks(workspace_id, id, "leadId", due, notes, completed, "dealId", "contactId", "taskType", priority, cancelled, description, "assigneeId", "createdAt", "completedAt")
    select target_workspace, x.id, x."leadId", x.due, x.notes, x.completed, x."dealId", x."contactId", coalesce(x."taskType", 'follow_up'), coalesce(x.priority, 'medium'),
      coalesce(x.cancelled, false), coalesce(x.description, ''), x."assigneeId", x."createdAt", x."completedAt"
    from jsonb_to_recordset(payload->'tasks') as x(id text, "leadId" text, due date, notes text, completed boolean, "dealId" uuid, "contactId" uuid, "taskType" text, priority text,
      cancelled boolean, description text, "assigneeId" uuid, "createdAt" timestamptz, "completedAt" timestamptz);
  perform set_config('leadflow.kept_assignees', '', true);
  insert into public.activity_history(workspace_id, id, "leadId", text, at)
    select target_workspace, x.id, x."leadId", x.text, x.at
    from jsonb_to_recordset(payload->'activities') as x(id text, "leadId" text, text text, at timestamptz);
  delete from leadflow_private.lead_origins o where o.workspace_id = target_workspace
    and not exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = o.lead_id);
  update public.workspaces set revision = revision + 1 where id = target_workspace returning revision into current_revision;
  insert into public.workspace_requests(workspace_id, request_id, payload_hash, revision, actor_id)
    values (target_workspace, request_id, fingerprint, current_revision, leadflow_private.valid_actor());
  return current_revision;
end $$;

-- ---------- Helpers ----------

-- The ten default stages and the settings row, installed once per workspace on first use.
create function leadflow_private.ensure_sales_setup(target_workspace uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from leadflow_private.sales_settings s where s.workspace_id = target_workspace) then return; end if;
  insert into leadflow_private.sales_stages(workspace_id, name, color, position, category, probability, key)
  select target_workspace, n, c, p, cat, prob, k from (values
    ('New prospect', '#64748b', 0, 'open', 5, 'new'), ('Qualified', '#0ea5e9', 1, 'open', 10, 'qualified'), ('Contacted', '#6366f1', 2, 'open', 15, 'contacted'),
    ('Replied', '#8b5cf6', 3, 'open', 25, 'replied'), ('Interested', '#a855f7', 4, 'open', 35, 'interested'), ('Meeting scheduled', '#f59e0b', 5, 'open', 50, 'meeting'),
    ('Proposal sent', '#f97316', 6, 'open', 65, 'proposal'), ('Negotiation', '#eab308', 7, 'open', 80, 'negotiation'), ('Won', '#16a34a', 8, 'won', 100, 'won'), ('Lost', '#dc2626', 9, 'lost', 0, 'lost')
  ) as d(n, c, p, cat, prob, k)
  on conflict do nothing;
  insert into leadflow_private.sales_settings(workspace_id, default_stage_id)
    values (target_workspace, (select s.id from leadflow_private.sales_stages s where s.workspace_id = target_workspace and s.key = 'new'))
    on conflict do nothing;
end $$;

create function leadflow_private.stage_json(s leadflow_private.sales_stages) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'color', s.color, 'position', s.position, 'category', s.category, 'probability', s.probability, 'key', s.key,
    'archived', s.archived_at is not null, 'archivedAt', s.archived_at)
$$;

-- A deal as the board, list and detail views show it, with the lead, contact, stage, owner and next follow-up joined in.
create function leadflow_private.deal_json(d leadflow_private.deals) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'leadId', d.lead_id, 'title', d.title, 'description', d.description, 'stageId', d.stage_id, 'outcome', d.outcome,
    'contactId', d.contact_id, 'opportunityId', d.opportunity_id, 'opportunityTitle', d.opportunity_title, 'opportunityType', d.opportunity_type,
    'serviceId', d.service_id, 'serviceName', coalesce(sv.name, d.service_name), 'source', d.source, 'sourceDraftId', d.source_draft_id,
    'value', d.value, 'currency', d.currency, 'probability', d.probability, 'effectiveProbability', coalesce(d.probability, st.probability),
    'expectedCloseDate', d.expected_close_date, 'actualCloseDate', d.actual_close_date, 'wonValue', d.won_value, 'wonNotes', d.won_notes,
    'lostReason', d.lost_reason, 'lostNotes', d.lost_notes, 'priority', d.priority, 'ownerId', d.owner_id, 'ownerName', coalesce(nullif(p.display_name, ''), u.email),
    'notes', d.notes, 'version', d.version, 'stageEnteredAt', d.stage_entered_at, 'lastActivityAt', d.last_activity_at, 'closedAt', d.closed_at,
    'archived', d.archived_at is not null, 'createdBy', d.created_by, 'createdAt', d.created_at, 'updatedAt', d.updated_at,
    'stage', jsonb_build_object('name', st.name, 'color', st.color, 'category', st.category, 'archived', st.archived_at is not null),
    'lead', case when l.id is null then null else jsonb_build_object('name', l.name, 'company', l.company, 'status', l.status, 'website', l.website, 'industry', l.industry, 'source', l.source) end,
    'contact', case when c.id is null then null else jsonb_build_object('name', case when c.kind = 'person' then c.full_name else coalesce(nullif(c.label, ''), c.email) end,
      'jobTitle', c.job_title, 'email', c.email, 'phone', c.phone, 'whatsapp', c.whatsapp) end,
    'nextTask', (select jsonb_build_object('id', t.id, 'due', t.due, 'notes', t.notes, 'taskType', t."taskType") from public.follow_up_tasks t
      where t.workspace_id = d.workspace_id and t."dealId" = d.id and not t.completed and not t.cancelled order by t.due, t.id limit 1),
    'nextMeeting', (select jsonb_build_object('id', m.id, 'startsAt', m.starts_at, 'title', m.title) from leadflow_private.deal_meetings m
      where m.deal_id = d.id and m.status = 'scheduled' and m.starts_at >= now() - interval '1 hour' order by m.starts_at limit 1),
    'hasHandoff', exists (select 1 from leadflow_private.client_handoffs h where h.deal_id = d.id))
  from leadflow_private.sales_stages st
  left join public.leads l on l.workspace_id = d.workspace_id and l.id = d.lead_id
  left join leadflow_private.lead_contacts c on c.id = d.contact_id
  left join leadflow_private.agency_services sv on sv.id = d.service_id
  left join public.profiles p on p.id = d.owner_id
  left join auth.users u on u.id = d.owner_id
  where st.id = d.stage_id
$$;

create function leadflow_private.add_deal_activity(target_deal leadflow_private.deals, activity_kind text, activity_summary text, activity_details text, activity_metadata jsonb,
  activity_contact uuid, activity_at timestamptz, activity_request uuid) returns uuid language plpgsql security definer set search_path = '' as $$
declare created uuid;
begin
  insert into leadflow_private.deal_activities(workspace_id, deal_id, kind, summary, details, metadata, contact_id, occurred_at, actor, request_id)
    values (target_deal.workspace_id, target_deal.id, activity_kind, left(activity_summary, 300), left(coalesce(activity_details, ''), 4000), coalesce(activity_metadata, '{}'),
      activity_contact, coalesce(activity_at, now()), leadflow_private.valid_actor(), activity_request) returning id into created;
  update leadflow_private.deals d set last_activity_at = greatest(d.last_activity_at, coalesce(activity_at, now())) where d.id = target_deal.id;
  return created;
end $$;

-- Locks the deal and checks the version the caller started from, so concurrent edits are reported instead of lost.
create function leadflow_private.lock_deal(target_workspace uuid, target_deal uuid, expected_version integer) returns leadflow_private.deals
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.deals;
begin
  select * into d from leadflow_private.deals x where x.id = target_deal and x.workspace_id = target_workspace for update;
  if d.id is null then raise exception 'Deal not found.' using errcode = 'P0002'; end if;
  if expected_version is not null and expected_version <> d.version then raise exception 'This deal changed in another window. Reload it and try again.' using errcode = '40001'; end if;
  return d;
end $$;

-- Moves a locked deal to a stage and records the history entry and activity in the same transaction.
create function leadflow_private.apply_stage(d leadflow_private.deals, target leadflow_private.sales_stages, move_request uuid, reason text) returns leadflow_private.deals
language plpgsql security definer set search_path = '' as $$
declare from_stage leadflow_private.sales_stages; result leadflow_private.deals;
begin
  select * into from_stage from leadflow_private.sales_stages s where s.id = d.stage_id;
  insert into leadflow_private.deal_stage_history(workspace_id, deal_id, from_stage_id, to_stage_id, from_name, to_name, to_category, moved_by, request_id)
    values (d.workspace_id, d.id, from_stage.id, target.id, from_stage.name, target.name, target.category, leadflow_private.valid_actor(), move_request);
  update leadflow_private.deals x set stage_id = target.id, outcome = target.category, stage_entered_at = now(), version = x.version + 1, updated_at = now(),
    closed_at = case when target.category = 'open' then null else coalesce(x.closed_at, now()) end,
    -- Close details belong to the outcome; reopening clears them (the timeline keeps what they were).
    actual_close_date = case when target.category = 'open' then null else x.actual_close_date end,
    won_value = case when target.category = 'won' then x.won_value end,
    lost_reason = case when target.category = 'lost' then x.lost_reason end
    where x.id = d.id returning * into result;
  perform leadflow_private.add_deal_activity(result, 'stage_changed', 'Moved from ' || from_stage.name || ' to ' || target.name, coalesce(reason, ''),
    jsonb_build_object('from', from_stage.name, 'to', target.name, 'fromStageId', from_stage.id, 'toStageId', target.id), null, now(), null);
  return result;
end $$;

-- ---------- Pipeline configuration ----------

create function public.sales_pipeline_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text; s leadflow_private.sales_settings;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  perform leadflow_private.ensure_sales_setup(target_workspace);
  select * into s from leadflow_private.sales_settings x where x.workspace_id = target_workspace;
  return jsonb_build_object(
    'stages', (select jsonb_agg(leadflow_private.stage_json(st) || jsonb_build_object('dealCount', (select count(*) from leadflow_private.deals d where d.stage_id = st.id and d.archived_at is null))
      order by st.archived_at is not null, st.position, st.created_at) from leadflow_private.sales_stages st where st.workspace_id = target_workspace),
    'settings', jsonb_build_object('defaultCurrency', s.default_currency, 'currencies', to_jsonb(s.currencies), 'lostReasons', to_jsonb(s.lost_reasons), 'defaultStageId', s.default_stage_id,
      'updatedAt', s.updated_at),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', coalesce(nullif(p.display_name, ''), u.email, 'Member'), 'role', m.role) order by m.role, p.display_name)
      from public.workspace_memberships m left join public.profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id where m.workspace_id = target_workspace), '[]'::jsonb),
    'canConfigure', actor_role <> 'member');
end $$;

-- Creates or edits a stage (owners and admins). A stage's kind (open, won, lost) can only change while it has no deals.
-- stage: { id?, name, color, category, probability }.
create function public.save_sales_stage(target_workspace uuid, stage jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare current_stage leadflow_private.sales_stages; result leadflow_private.sales_stages; next_position integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  perform leadflow_private.ensure_sales_setup(target_workspace);
  if jsonb_typeof(stage) is distinct from 'object' then raise exception 'Invalid stage.' using errcode = '22023'; end if;
  if stage ? 'probability' and stage->'probability' <> 'null'::jsonb and (jsonb_typeof(stage->'probability') <> 'number' or (stage->>'probability')::numeric not between 0 and 100) then
    raise exception 'Probability is a whole number from 0 to 100.' using errcode = '22023';
  end if;
  begin
    if stage ? 'id' then
      select * into current_stage from leadflow_private.sales_stages s where s.id = (stage->>'id')::uuid and s.workspace_id = target_workspace for update;
      if current_stage.id is null then raise exception 'Stage not found.' using errcode = 'P0002'; end if;
      if stage ? 'category' and stage->>'category' is distinct from current_stage.category
          and exists (select 1 from leadflow_private.deals d where d.stage_id = current_stage.id and d.archived_at is null) then
        raise exception 'Move this stage’s deals to another stage before changing whether it is open, won or lost.' using errcode = '22023';
      end if;
      update leadflow_private.sales_stages s set name = coalesce(btrim(stage->>'name'), s.name), color = coalesce(lower(stage->>'color'), s.color),
        category = coalesce(stage->>'category', s.category),
        probability = case when stage ? 'probability' then (stage->>'probability')::numeric::integer else s.probability end, updated_at = now()
        where s.id = current_stage.id returning * into result;
    else
      select coalesce(max(position) + 1, 0) into next_position from leadflow_private.sales_stages s where s.workspace_id = target_workspace and s.archived_at is null and s.category = 'open';
      -- New stages go after the last open stage, before Won and Lost.
      update leadflow_private.sales_stages s set position = s.position + 1 where s.workspace_id = target_workspace and s.position >= next_position;
      insert into leadflow_private.sales_stages(workspace_id, name, color, position, category, probability)
        values (target_workspace, btrim(coalesce(stage->>'name', '')), lower(coalesce(stage->>'color', '#64748b')), next_position, coalesce(stage->>'category', 'open'),
          (stage->>'probability')::numeric::integer) returning * into result;
    end if;
  exception
    when unique_violation then raise exception 'A stage with this name already exists.' using errcode = '22023';
    when check_violation then raise exception 'Check the stage: a name of 1–60 characters, a colour like #22c55e, and open, won or lost.' using errcode = '22023';
  end;
  return leadflow_private.stage_json(result);
end $$;

-- Sets the order of the active stages (owners and admins). stage_ids lists every active stage once.
create function public.reorder_sales_stages(target_workspace uuid, stage_ids jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare active_count integer; given text[];
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  if jsonb_typeof(stage_ids) is distinct from 'array' then raise exception 'Send the stages in their new order.' using errcode = '22023'; end if;
  select array_agg(value) into given from jsonb_array_elements_text(stage_ids);
  select count(*) into active_count from leadflow_private.sales_stages s where s.workspace_id = target_workspace and s.archived_at is null;
  if cardinality(given) <> active_count or cardinality(given) <> (select count(distinct x) from unnest(given) x)
      or exists (select 1 from unnest(given) x where not exists (select 1 from leadflow_private.sales_stages s where s.workspace_id = target_workspace and s.archived_at is null and s.id::text = x)) then
    raise exception 'The order must list every active stage once. Reload and try again.' using errcode = '22023';
  end if;
  update leadflow_private.sales_stages s set position = o.ordinality - 1, updated_at = now()
    from unnest(given) with ordinality as o(id, ordinality) where s.id::text = o.id and s.workspace_id = target_workspace;
  update leadflow_private.sales_stages s set position = 500 + s.position where s.workspace_id = target_workspace and s.archived_at is not null and s.position < 500;
end $$;

-- Archives a stage (owners and admins). Its deals move to reassign_to, a stage of the same kind, each with a history entry.
-- The last active open, won or lost stage can't be archived.
create function public.archive_sales_stage(target_workspace uuid, stage_id uuid, reassign_to uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st leadflow_private.sales_stages; target leadflow_private.sales_stages; d leadflow_private.deals; moved integer := 0;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  select * into st from leadflow_private.sales_stages s where s.id = stage_id and s.workspace_id = target_workspace and s.archived_at is null for update;
  if st.id is null then raise exception 'Stage not found or already archived.' using errcode = 'P0002'; end if;
  if (select count(*) from leadflow_private.sales_stages s where s.workspace_id = target_workspace and s.archived_at is null and s.category = st.category) <= 1 then
    raise exception 'Keep at least one active % stage.', st.category using errcode = '22023';
  end if;
  if exists (select 1 from leadflow_private.deals x where x.stage_id = st.id and x.archived_at is null) then
    select * into target from leadflow_private.sales_stages s where s.id = reassign_to and s.workspace_id = target_workspace and s.archived_at is null and s.id <> st.id;
    if target.id is null then raise exception 'Choose an active stage to move this stage’s deals to.' using errcode = '22023'; end if;
    if target.category <> st.category then raise exception 'Move the deals to another % stage.', st.category using errcode = '22023'; end if;
    for d in select * from leadflow_private.deals x where x.stage_id = st.id and x.archived_at is null for update loop
      perform leadflow_private.apply_stage(d, target, null, 'The stage “' || st.name || '” was archived.');
      moved := moved + 1;
    end loop;
  end if;
  -- Archived deals keep pointing at the stage; they stay valid because the stage still exists.
  update leadflow_private.sales_stages s set archived_at = now(), updated_at = now() where s.id = st.id;
  update leadflow_private.sales_settings x set default_stage_id = (select s.id from leadflow_private.sales_stages s where s.workspace_id = target_workspace and s.archived_at is null
      and s.category = 'open' order by s.position limit 1)
    where x.workspace_id = target_workspace and (x.default_stage_id = st.id or x.default_stage_id is null);
  return jsonb_build_object('moved', moved);
end $$;

create function public.restore_sales_stage(target_workspace uuid, stage_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result leadflow_private.sales_stages;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  begin
    update leadflow_private.sales_stages s set archived_at = null, position = (select coalesce(max(x.position) + 1, 0) from leadflow_private.sales_stages x
        where x.workspace_id = target_workspace and x.archived_at is null), updated_at = now()
      where s.id = stage_id and s.workspace_id = target_workspace and s.archived_at is not null returning * into result;
  exception when unique_violation then raise exception 'An active stage already uses this name. Rename one of them first.' using errcode = '22023';
  end;
  if result.id is null then raise exception 'Stage not found or not archived.' using errcode = 'P0002'; end if;
  return leadflow_private.stage_json(result);
end $$;

-- settings: { defaultCurrency, currencies, lostReasons, defaultStageId } (owners and admins).
create function public.save_sales_settings(target_workspace uuid, settings jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare codes text[]; reasons text[];
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  perform leadflow_private.ensure_sales_setup(target_workspace);
  if jsonb_typeof(settings) is distinct from 'object' then raise exception 'Invalid settings.' using errcode = '22023'; end if;
  if settings ? 'currencies' then
    if jsonb_typeof(settings->'currencies') <> 'array' then raise exception 'List currencies as three-letter codes.' using errcode = '22023'; end if;
    select array_agg(distinct upper(btrim(x))) into codes from jsonb_array_elements_text(settings->'currencies') x where btrim(x) <> '';
    if codes is null or cardinality(codes) > 20 or exists (select 1 from unnest(codes) c where c !~ '^[A-Z]{3}$') then raise exception 'Use up to 20 three-letter currency codes, such as USD or GBP.' using errcode = '22023'; end if;
  end if;
  if settings ? 'lostReasons' then
    if jsonb_typeof(settings->'lostReasons') <> 'array' then raise exception 'List lost reasons as text.' using errcode = '22023'; end if;
    select array_agg(r order by ord) into reasons from (select distinct on (lower(btrim(x))) btrim(x) as r, ord from jsonb_array_elements_text(settings->'lostReasons') with ordinality as e(x, ord) where btrim(x) <> '' order by lower(btrim(x)), ord) y;
    if reasons is null or cardinality(reasons) > 20 or exists (select 1 from unnest(reasons) r where length(r) > 60) then raise exception 'Use 1 to 20 lost reasons of up to 60 characters.' using errcode = '22023'; end if;
  end if;
  if settings ? 'defaultStageId' and not exists (select 1 from leadflow_private.sales_stages s where s.workspace_id = target_workspace and s.id::text = settings->>'defaultStageId'
      and s.archived_at is null and s.category = 'open') then
    raise exception 'The default stage must be an active open stage.' using errcode = '22023';
  end if;
  begin
    update leadflow_private.sales_settings x set currencies = coalesce(codes, x.currencies), default_currency = coalesce(upper(settings->>'defaultCurrency'), x.default_currency),
      lost_reasons = coalesce(reasons, x.lost_reasons), default_stage_id = coalesce((settings->>'defaultStageId')::uuid, x.default_stage_id), updated_by = leadflow_private.valid_actor(), updated_at = now()
      where x.workspace_id = target_workspace;
  exception when check_violation then raise exception 'The default currency must be one of the listed currencies.' using errcode = '22023';
  end;
  return public.sales_pipeline_for(target_workspace);
end $$;

-- ---------- Deals ----------

-- Creates a deal, idempotently. A second open deal for the same lead and opportunity (or with the same title) is refused
-- with P0409 unless allow_duplicate is true, so a repeated click or a second tab doesn't create a copy.
-- deal: { leadId, title, description, stageId?, contactId?, opportunityId?, sourceDraftId?, source, value?, currency?, probability?, expectedCloseDate?, priority?, ownerId?, notes? }.
create function public.create_deal(target_workspace uuid, deal jsonb, request_id uuid, allow_duplicate boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing leadflow_private.deals; s leadflow_private.sales_settings; st leadflow_private.sales_stages; created leadflow_private.deals; lead_ref text; o leadflow_private.business_opportunities;
  contact_ref uuid; draft_ref uuid; title_value text; currency_value text; source_value text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  perform leadflow_private.ensure_sales_setup(target_workspace);
  if request_id is null or jsonb_typeof(deal) is distinct from 'object' then raise exception 'Invalid deal.' using errcode = '22023'; end if;
  select * into existing from leadflow_private.deals x where x.workspace_id = target_workspace and x.request_id = create_deal.request_id;
  if existing.id is not null then return leadflow_private.deal_json(existing) || jsonb_build_object('existing', true); end if;
  lead_ref := deal->>'leadId';
  if not exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = lead_ref) then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
  if nullif(deal->>'opportunityId', '') is not null then
    select * into o from leadflow_private.business_opportunities x where x.id = (deal->>'opportunityId')::uuid and x.workspace_id = target_workspace and x.lead_id = lead_ref;
    if o.id is null then raise exception 'That opportunity isn’t part of this lead’s reports.' using errcode = '22023'; end if;
  end if;
  if nullif(deal->>'contactId', '') is not null then
    select c.id into contact_ref from leadflow_private.lead_contacts c where c.id = (deal->>'contactId')::uuid and c.workspace_id = target_workspace and c.lead_id = lead_ref;
    if contact_ref is null then raise exception 'That contact isn’t one of this lead’s contacts.' using errcode = '22023'; end if;
  end if;
  if nullif(deal->>'sourceDraftId', '') is not null then
    select x.id into draft_ref from leadflow_private.outreach_drafts x where x.id = (deal->>'sourceDraftId')::uuid and x.workspace_id = target_workspace and x.lead_id = lead_ref;
    if draft_ref is null then raise exception 'That outreach draft isn’t part of this lead.' using errcode = '22023'; end if;
  end if;
  select * into s from leadflow_private.sales_settings x where x.workspace_id = target_workspace;
  select * into st from leadflow_private.sales_stages x where x.workspace_id = target_workspace and x.archived_at is null
    and x.id = coalesce(nullif(deal->>'stageId', '')::uuid, s.default_stage_id);
  if st.id is null then select * into st from leadflow_private.sales_stages x where x.workspace_id = target_workspace and x.archived_at is null and x.category = 'open' order by x.position limit 1; end if;
  if st.category <> 'open' then raise exception 'New deals start in an open stage. Mark them won or lost afterwards.' using errcode = '22023'; end if;
  title_value := btrim(coalesce(nullif(deal->>'title', ''), o.title, ''));
  currency_value := upper(coalesce(nullif(deal->>'currency', ''), s.default_currency));
  if not currency_value = any(s.currencies) then raise exception 'Use one of this workspace’s currencies: %.', array_to_string(s.currencies, ', ') using errcode = '22023'; end if;
  source_value := coalesce(nullif(deal->>'source', ''), case when o.id is not null then 'opportunity' when draft_ref is not null then 'outreach' else 'manual' end);
  if not coalesce(allow_duplicate, false) then
    select * into existing from leadflow_private.deals x where x.workspace_id = target_workspace and x.lead_id = lead_ref and x.outcome = 'open' and x.archived_at is null
      and ((o.id is not null and x.opportunity_id = o.id) or lower(btrim(x.title)) = lower(title_value)) limit 1;
    if existing.id is not null then raise exception 'This lead already has an open deal “%”. Open it, or create another anyway.', existing.title using errcode = 'P0409', detail = existing.id::text; end if;
  end if;
  if nullif(deal->>'ownerId', '') is not null and not exists (select 1 from public.workspace_memberships m where m.workspace_id = target_workspace and m.user_id::text = deal->>'ownerId') then
    raise exception 'The owner must be a member of this workspace.' using errcode = '22023';
  end if;
  begin
    insert into leadflow_private.deals(workspace_id, lead_id, request_id, title, description, stage_id, contact_id, opportunity_id, opportunity_title, opportunity_type, service_id, service_name,
        source, source_draft_id, value, currency, probability, expected_close_date, priority, owner_id, notes, created_by)
      values (target_workspace, lead_ref, create_deal.request_id, title_value, coalesce(deal->>'description', ''), st.id, contact_ref, o.id, coalesce(o.title, ''), o.opportunity_type,
        o.service_id, coalesce(o.service_name, ''), source_value, draft_ref, nullif(deal->>'value', '')::numeric, currency_value, nullif(deal->>'probability', '')::integer,
        nullif(deal->>'expectedCloseDate', '')::date, coalesce(nullif(deal->>'priority', ''), 'medium'), nullif(deal->>'ownerId', '')::uuid, coalesce(deal->>'notes', ''), leadflow_private.valid_actor())
      returning * into created;
  exception
    when check_violation then raise exception 'Check the deal: a title of 1–150 characters, a value of 0 or more, a probability from 0 to 100, and a listed priority.' using errcode = '22023';
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then raise exception 'Check the deal’s value, probability and close date.' using errcode = '22023';
  end;
  insert into leadflow_private.deal_stage_history(workspace_id, deal_id, from_stage_id, to_stage_id, from_name, to_name, to_category, moved_by)
    values (target_workspace, created.id, null, st.id, null, st.name, st.category, leadflow_private.valid_actor());
  perform leadflow_private.add_deal_activity(created, 'deal_created', 'Deal created in ' || st.name, '',
    jsonb_build_object('source', source_value, 'opportunityTitle', coalesce(o.title, ''), 'serviceName', coalesce(o.service_name, '')), contact_ref, now(), null);
  return leadflow_private.deal_json(created) || jsonb_build_object('existing', false);
end $$;

-- Edits a deal's details. Stage changes go through move_deal, won and lost through their own functions.
-- changes: any of { title, description, contactId, opportunityId, value, currency, probability, expectedCloseDate, priority, ownerId, notes }.
create function public.update_deal(target_workspace uuid, deal_id uuid, expected_version integer, changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.deals; result leadflow_private.deals; s leadflow_private.sales_settings; o leadflow_private.business_opportunities; key text; changed text[] := '{}';
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if jsonb_typeof(changes) is distinct from 'object' then raise exception 'Invalid changes.' using errcode = '22023'; end if;
  for key in select jsonb_object_keys(changes) loop
    if key not in ('title','description','contactId','opportunityId','value','currency','probability','expectedCloseDate','priority','ownerId','notes') then raise exception 'Unknown deal field %.', key using errcode = '22023'; end if;
  end loop;
  d := leadflow_private.lock_deal(target_workspace, deal_id, expected_version);
  select * into s from leadflow_private.sales_settings x where x.workspace_id = target_workspace;
  if changes ? 'currency' and not upper(changes->>'currency') = any(s.currencies) then raise exception 'Use one of this workspace’s currencies: %.', array_to_string(s.currencies, ', ') using errcode = '22023'; end if;
  if nullif(changes->>'contactId', '') is not null and not exists (select 1 from leadflow_private.lead_contacts c where c.id::text = changes->>'contactId' and c.workspace_id = target_workspace and c.lead_id = d.lead_id) then
    raise exception 'That contact isn’t one of this lead’s contacts.' using errcode = '22023';
  end if;
  if nullif(changes->>'opportunityId', '') is not null then
    select * into o from leadflow_private.business_opportunities x where x.id::text = changes->>'opportunityId' and x.workspace_id = target_workspace and x.lead_id = d.lead_id;
    if o.id is null then raise exception 'That opportunity isn’t part of this lead’s reports.' using errcode = '22023'; end if;
  end if;
  if nullif(changes->>'ownerId', '') is not null and not exists (select 1 from public.workspace_memberships m where m.workspace_id = target_workspace and m.user_id::text = changes->>'ownerId') then
    raise exception 'The owner must be a member of this workspace.' using errcode = '22023';
  end if;
  begin
    update leadflow_private.deals x set
      title = case when changes ? 'title' then btrim(changes->>'title') else x.title end,
      description = case when changes ? 'description' then coalesce(changes->>'description', '') else x.description end,
      contact_id = case when changes ? 'contactId' then nullif(changes->>'contactId', '')::uuid else x.contact_id end,
      opportunity_id = case when changes ? 'opportunityId' then o.id else x.opportunity_id end,
      opportunity_title = case when changes ? 'opportunityId' then coalesce(o.title, '') else x.opportunity_title end,
      opportunity_type = case when changes ? 'opportunityId' then o.opportunity_type else x.opportunity_type end,
      service_id = case when changes ? 'opportunityId' then o.service_id else x.service_id end,
      service_name = case when changes ? 'opportunityId' then coalesce(o.service_name, '') else x.service_name end,
      value = case when changes ? 'value' then nullif(changes->>'value', '')::numeric else x.value end,
      currency = case when changes ? 'currency' then upper(changes->>'currency') else x.currency end,
      probability = case when changes ? 'probability' then nullif(changes->>'probability', '')::integer else x.probability end,
      expected_close_date = case when changes ? 'expectedCloseDate' then nullif(changes->>'expectedCloseDate', '')::date else x.expected_close_date end,
      priority = case when changes ? 'priority' then changes->>'priority' else x.priority end,
      owner_id = case when changes ? 'ownerId' then nullif(changes->>'ownerId', '')::uuid else x.owner_id end,
      notes = case when changes ? 'notes' then coalesce(changes->>'notes', '') else x.notes end,
      version = x.version + 1, updated_at = now()
      where x.id = d.id returning * into result;
  exception
    when check_violation or not_null_violation then raise exception 'Check the deal: a title of 1–150 characters, a value of 0 or more, a probability from 0 to 100, and a listed priority.' using errcode = '22023';
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then raise exception 'Check the deal’s value, probability and close date.' using errcode = '22023';
  end;
  if result.value is distinct from d.value or result.currency <> d.currency or result.probability is distinct from d.probability then
    perform leadflow_private.add_deal_activity(result, 'value_updated',
      'Value ' || coalesce(to_char(d.value, 'FM999G999G999G990D00') || ' ' || d.currency, 'not set') || ' → ' || coalesce(to_char(result.value, 'FM999G999G999G990D00') || ' ' || result.currency, 'not set')
        || case when result.probability is distinct from d.probability then ', probability ' || coalesce(d.probability::text || '%', 'not set') || ' → ' || coalesce(result.probability::text || '%', 'not set') else '' end,
      '', jsonb_build_object('fromValue', d.value, 'toValue', result.value, 'fromCurrency', d.currency, 'toCurrency', result.currency, 'fromProbability', d.probability, 'toProbability', result.probability), null, now(), null);
  end if;
  if result.title <> d.title then changed := changed || 'title'::text; end if;
  if result.description <> d.description then changed := changed || 'description'::text; end if;
  if result.contact_id is distinct from d.contact_id then changed := changed || 'contact'::text; end if;
  if result.opportunity_id is distinct from d.opportunity_id then changed := changed || 'opportunity'::text; end if;
  if result.expected_close_date is distinct from d.expected_close_date then changed := changed || 'expected close date'::text; end if;
  if result.priority <> d.priority then changed := changed || 'priority'::text; end if;
  if result.owner_id is distinct from d.owner_id then changed := changed || 'owner'::text; end if;
  if result.notes <> d.notes then changed := changed || 'notes'::text; end if;
  if cardinality(changed) > 0 then
    perform leadflow_private.add_deal_activity(result, 'details_updated', 'Updated ' || array_to_string(changed, ', '), '', jsonb_build_object('fields', to_jsonb(changed)), result.contact_id, now(), null);
  end if;
  return leadflow_private.deal_json(result);
end $$;

-- Moves an open deal to another open stage. Won and lost use close_deal; a closed deal is reopened explicitly. A repeated
-- request ID returns the deal without moving it again.
create function public.move_deal(target_workspace uuid, deal_id uuid, stage_id uuid, expected_version integer, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.deals; target leadflow_private.sales_stages;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if request_id is not null and exists (select 1 from leadflow_private.deal_stage_history h where h.workspace_id = target_workspace and h.request_id = move_deal.request_id) then
    select * into d from leadflow_private.deals x where x.id = deal_id and x.workspace_id = target_workspace;
    return leadflow_private.deal_json(d) || jsonb_build_object('repeated', true);
  end if;
  d := leadflow_private.lock_deal(target_workspace, deal_id, expected_version);
  if d.archived_at is not null then raise exception 'Restore this deal before moving it.' using errcode = '22023'; end if;
  select * into target from leadflow_private.sales_stages s where s.id = stage_id and s.workspace_id = target_workspace and s.archived_at is null;
  if target.id is null then raise exception 'Stage not found.' using errcode = 'P0002'; end if;
  if target.category <> 'open' then raise exception 'Use Mark as won or Mark as lost to close a deal.' using errcode = '22023'; end if;
  if d.outcome <> 'open' then raise exception 'This deal is closed. Reopen it first.' using errcode = '22023'; end if;
  if target.id = d.stage_id then return leadflow_private.deal_json(d) || jsonb_build_object('repeated', false); end if;
  d := leadflow_private.apply_stage(d, target, request_id, null);
  return leadflow_private.deal_json(d) || jsonb_build_object('repeated', false);
end $$;

-- Closes a deal as won or lost. Won: the final value (defaults to the deal value), close date and notes. Lost: a reason from
-- the workspace's list and notes. stage_id picks among several won or lost stages; otherwise the first one is used.
-- details: { stageId?, wonValue?, closeDate?, notes?, reason? }.
create function public.close_deal(target_workspace uuid, deal_id uuid, outcome text, details jsonb, expected_version integer, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.deals; target leadflow_private.sales_stages; s leadflow_private.sales_settings; reason text; close_on date;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if outcome not in ('won','lost') then raise exception 'Choose won or lost.' using errcode = '22023'; end if;
  if request_id is not null and exists (select 1 from leadflow_private.deal_stage_history h where h.workspace_id = target_workspace and h.request_id = close_deal.request_id) then
    select * into d from leadflow_private.deals x where x.id = deal_id and x.workspace_id = target_workspace;
    return leadflow_private.deal_json(d) || jsonb_build_object('repeated', true);
  end if;
  d := leadflow_private.lock_deal(target_workspace, deal_id, expected_version);
  if d.archived_at is not null then raise exception 'Restore this deal first.' using errcode = '22023'; end if;
  if d.outcome <> 'open' then raise exception 'This deal is already closed. Reopen it to change the outcome.' using errcode = '22023'; end if;
  select * into target from leadflow_private.sales_stages st where st.workspace_id = target_workspace and st.archived_at is null and st.category = close_deal.outcome
    and (nullif(details->>'stageId', '') is null or st.id::text = details->>'stageId') order by st.position limit 1;
  if target.id is null then raise exception 'No active % stage. Add one in the pipeline settings.', close_deal.outcome using errcode = '22023'; end if;
  begin close_on := coalesce(nullif(details->>'closeDate', '')::date, current_date);
  exception when others then raise exception 'Enter a valid close date.' using errcode = '22023'; end;
  if close_deal.outcome = 'lost' then
    select * into s from leadflow_private.sales_settings x where x.workspace_id = target_workspace;
    reason := btrim(coalesce(details->>'reason', ''));
    if reason = '' then raise exception 'Choose why the deal was lost.' using errcode = '22023'; end if;
    if not reason = any(s.lost_reasons) then raise exception 'Choose a lost reason from the list.' using errcode = '22023'; end if;
  end if;
  d := leadflow_private.apply_stage(d, target, request_id, null);
  begin
    update leadflow_private.deals x set actual_close_date = close_on,
      won_value = case when close_deal.outcome = 'won' then coalesce(nullif(details->>'wonValue', '')::numeric, x.value) else null end,
      won_notes = case when close_deal.outcome = 'won' then left(coalesce(details->>'notes', ''), 2000) else x.won_notes end,
      lost_reason = case when close_deal.outcome = 'lost' then reason else null end,
      lost_notes = case when close_deal.outcome = 'lost' then left(coalesce(details->>'notes', ''), 2000) else x.lost_notes end
      where x.id = d.id returning * into d;
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range then raise exception 'Enter a final value of 0 or more.' using errcode = '22023';
  end;
  perform leadflow_private.add_deal_activity(d, close_deal.outcome,
    case when close_deal.outcome = 'won' then 'Deal won' || coalesce(' · ' || to_char(d.won_value, 'FM999G999G999G990D00') || ' ' || d.currency, '') else 'Deal lost · ' || reason end,
    left(coalesce(details->>'notes', ''), 4000), jsonb_build_object('closeDate', close_on, 'wonValue', d.won_value, 'reason', reason), null, now(), null);
  return leadflow_private.deal_json(d) || jsonb_build_object('repeated', false);
end $$;

-- Reopens a won or lost deal into an open stage. Close details stay in the history; a deal handed off to client work can't be reopened.
create function public.reopen_deal(target_workspace uuid, deal_id uuid, stage_id uuid, expected_version integer, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.deals; target leadflow_private.sales_stages; previous text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if request_id is not null and exists (select 1 from leadflow_private.deal_stage_history h where h.workspace_id = target_workspace and h.request_id = reopen_deal.request_id) then
    select * into d from leadflow_private.deals x where x.id = deal_id and x.workspace_id = target_workspace;
    return leadflow_private.deal_json(d) || jsonb_build_object('repeated', true);
  end if;
  d := leadflow_private.lock_deal(target_workspace, deal_id, expected_version);
  if d.outcome = 'open' then raise exception 'This deal is already open.' using errcode = '22023'; end if;
  if exists (select 1 from leadflow_private.client_handoffs h where h.deal_id = d.id) then raise exception 'This deal was handed off to client work and can’t be reopened.' using errcode = '22023'; end if;
  select * into target from leadflow_private.sales_stages s where s.id = stage_id and s.workspace_id = target_workspace and s.archived_at is null and s.category = 'open';
  if target.id is null then raise exception 'Choose an active open stage.' using errcode = '22023'; end if;
  previous := d.outcome;
  d := leadflow_private.apply_stage(d, target, request_id, null);
  perform leadflow_private.add_deal_activity(d, 'reopened', 'Reopened after it was ' || previous, '', jsonb_build_object('previousOutcome', previous), null, now(), null);
  return leadflow_private.deal_json(d) || jsonb_build_object('repeated', false);
end $$;

-- Archives or restores a deal (owners and admins, its creator or its owner). Archived deals leave the pipeline and analytics.
create function public.set_deal_archived(target_workspace uuid, deal_id uuid, archive boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text; d leadflow_private.deals; actor uuid := leadflow_private.valid_actor();
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  d := leadflow_private.lock_deal(target_workspace, deal_id, null);
  if actor_role = 'member' and d.created_by is distinct from actor and d.owner_id is distinct from actor then raise exception 'Only owners, admins, the deal owner or its creator can archive it.' using errcode = '42501'; end if;
  if archive = (d.archived_at is not null) then return leadflow_private.deal_json(d); end if;
  update leadflow_private.deals x set archived_at = case when archive then now() else null end, version = x.version + 1, updated_at = now() where x.id = d.id returning * into d;
  perform leadflow_private.add_deal_activity(d, case when archive then 'archived' else 'restored' end, case when archive then 'Deal archived' else 'Deal restored' end, '', '{}', null, now(), null);
  return leadflow_private.deal_json(d);
end $$;

-- Deals for the list view: filters, sorting and pagination in the database.
-- filters: { outcome: open|won|lost|all, stageId, ownerId, leadId, priority, search, closingBefore, includeArchived, sort: updated|value|close|created|activity, direction, limit, offset }.
create function public.deals_for(target_workspace uuid, filters jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare page_limit integer := least(greatest(coalesce((filters->>'limit')::integer, 50), 1), 200); page_offset integer := greatest(coalesce((filters->>'offset')::integer, 0), 0);
  search text := lower(btrim(coalesce(filters->>'search', ''))); sort_key text := coalesce(filters->>'sort', 'updated'); descending boolean := coalesce(filters->>'direction', 'desc') <> 'asc';
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  perform leadflow_private.ensure_sales_setup(target_workspace);
  return (with matching as (
    select d.* from leadflow_private.deals d left join public.leads l on l.workspace_id = d.workspace_id and l.id = d.lead_id
      left join leadflow_private.lead_contacts c on c.id = d.contact_id
    where d.workspace_id = target_workspace
      and (coalesce((filters->>'includeArchived')::boolean, false) or d.archived_at is null)
      and (coalesce(filters->>'outcome', 'all') = 'all' or d.outcome = filters->>'outcome')
      and (nullif(filters->>'stageId', '') is null or d.stage_id::text = filters->>'stageId')
      and (nullif(filters->>'ownerId', '') is null or d.owner_id::text = filters->>'ownerId')
      and (nullif(filters->>'leadId', '') is null or d.lead_id = filters->>'leadId')
      and (nullif(filters->>'priority', '') is null or d.priority = filters->>'priority')
      and (nullif(filters->>'closingBefore', '') is null or d.expected_close_date <= (filters->>'closingBefore')::date)
      and (search = '' or position(search in lower(d.title || ' ' || coalesce(l.company, '') || ' ' || coalesce(l.name, '') || ' ' || coalesce(c.full_name, '') || ' ' || d.service_name)) > 0)
  ), ordered as (
    select m.id, row_number() over (order by
      case when descending then case sort_key when 'value' then m.value end end desc nulls last,
      case when not descending then case sort_key when 'value' then m.value end end asc nulls last,
      case when descending then case sort_key when 'close' then m.expected_close_date end end desc nulls last,
      case when not descending then case sort_key when 'close' then m.expected_close_date end end asc nulls last,
      case when descending then case sort_key when 'created' then m.created_at when 'activity' then m.last_activity_at when 'updated' then m.updated_at end end desc nulls last,
      case when not descending then case sort_key when 'created' then m.created_at when 'activity' then m.last_activity_at when 'updated' then m.updated_at end end asc nulls last,
      m.id) as ord
    from matching m
  ), page as (select o.id, o.ord from ordered o order by o.ord limit page_limit offset page_offset)
  select jsonb_build_object('items', coalesce((select jsonb_agg(leadflow_private.deal_json(d) order by pg.ord) from page pg join leadflow_private.deals d on d.id = pg.id), '[]'::jsonb),
    'total', (select count(*) from matching), 'limit', page_limit, 'offset', page_offset));
end $$;

-- The board: active stages with their deals (newest activity first, at most per_stage each) and totals per currency.
-- Closed columns show deals closed in the last closed_days days. filters as for deals_for (ownerId, priority, search).
create function public.pipeline_board_for(target_workspace uuid, filters jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare per_stage integer := least(greatest(coalesce((filters->>'perStage')::integer, 50), 1), 200); closed_days integer := least(greatest(coalesce((filters->>'closedDays')::integer, 90), 1), 3650);
  search text := lower(btrim(coalesce(filters->>'search', '')));
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  perform leadflow_private.ensure_sales_setup(target_workspace);
  return (with visible as (
    select d.* from leadflow_private.deals d left join public.leads l on l.workspace_id = d.workspace_id and l.id = d.lead_id
      left join leadflow_private.lead_contacts c on c.id = d.contact_id
    where d.workspace_id = target_workspace and d.archived_at is null and (d.outcome = 'open' or d.closed_at > now() - make_interval(days => closed_days))
      and (nullif(filters->>'ownerId', '') is null or d.owner_id::text = filters->>'ownerId')
      and (nullif(filters->>'priority', '') is null or d.priority = filters->>'priority')
      and (search = '' or position(search in lower(d.title || ' ' || coalesce(l.company, '') || ' ' || coalesce(l.name, '') || ' ' || coalesce(c.full_name, '') || ' ' || d.service_name)) > 0)
  )
  select coalesce(jsonb_agg(leadflow_private.stage_json(st) || jsonb_build_object(
      'count', (select count(*) from visible v where v.stage_id = st.id),
      'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', t.currency, 'value', t.value, 'weighted', t.weighted, 'count', t.n) order by t.currency) from (
        -- Won columns count the final value; weighted is value × probability for open deals (deals without one count 0).
        select v.currency, sum(v.amount) as value, sum(v.amount * case st.category when 'open' then coalesce(v.probability, st.probability, 0) when 'won' then 100 else 0 end / 100.0) as weighted, count(*) as n
        from (select x.*, case when st.category = 'won' then coalesce(x.won_value, x.value) else x.value end as amount from visible x where x.stage_id = st.id) v
        where v.amount is not null group by v.currency) t), '[]'::jsonb),
      'deals', coalesce((select jsonb_agg(leadflow_private.deal_json(v) order by v.last_activity_at desc, v.id)
        from (select * from visible v where v.stage_id = st.id order by v.last_activity_at desc, v.id limit per_stage) v), '[]'::jsonb))
    order by st.position), '[]'::jsonb)
  from leadflow_private.sales_stages st where st.workspace_id = target_workspace and st.archived_at is null);
end $$;

-- One deal with everything its detail view shows.
create function public.deal_detail(target_workspace uuid, deal_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.deals;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into d from leadflow_private.deals x where x.id = deal_id and x.workspace_id = target_workspace;
  if d.id is null then raise exception 'Deal not found.' using errcode = 'P0002'; end if;
  return leadflow_private.deal_json(d) || jsonb_build_object(
    'leadExists', exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = d.lead_id),
    'opportunity', (select jsonb_build_object('id', o.id, 'title', o.title, 'opportunityType', o.opportunity_type, 'why', o.why, 'benefit', o.benefit, 'priority', o.priority,
        'confidence', o.confidence, 'status', o.status, 'analysisId', o.analysis_id, 'findingCount', cardinality(o.finding_ids),
        'findings', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'title', f.title, 'findingType', f.finding_type, 'confidence', f.confidence)), '[]'::jsonb)
          from leadflow_private.analysis_findings f where f.id = any(o.finding_ids)))
      from leadflow_private.business_opportunities o where o.id = d.opportunity_id),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'name', case when c.kind = 'person' then c.full_name else coalesce(nullif(c.label, ''), c.email) end,
        'jobTitle', c.job_title, 'email', c.email, 'emailStatus', c.email_status, 'phone', c.phone, 'whatsapp', c.whatsapp, 'isPreferred', c.is_preferred) order by c.is_preferred desc, c.is_primary desc, c.created_at)
      from leadflow_private.lead_contacts c where c.workspace_id = target_workspace and c.lead_id = d.lead_id), '[]'::jsonb),
    'stageHistory', coalesce((select jsonb_agg(jsonb_build_object('from', h.from_name, 'to', h.to_name, 'toCategory', h.to_category, 'movedAt', h.moved_at, 'movedBy', h.moved_by) order by h.moved_at, h.id)
      from leadflow_private.deal_stage_history h where h.deal_id = d.id), '[]'::jsonb),
    'meetings', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'startsAt', m.starts_at, 'durationMinutes', m.duration_minutes, 'timezone', m.timezone,
        'location', m.location, 'meetingUrl', m.meeting_url, 'agenda', m.agenda, 'notes', m.notes, 'status', m.status, 'contactId', m.contact_id, 'version', m.version) order by m.starts_at desc)
      from leadflow_private.deal_meetings m where m.deal_id = d.id), '[]'::jsonb),
    'drafts', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'channel', o.channel, 'subject', o.subject, 'status', o.status, 'contactId', o.contact_id, 'contactName', o.contact_name,
        'sentAt', o.sent_at, 'repliedAt', o.replied_at, 'sequenceStep', o.sequence_step, 'updatedAt', o.updated_at) order by o.updated_at desc)
      from leadflow_private.outreach_drafts o where o.workspace_id = target_workspace and o.lead_id = d.lead_id and o.status <> 'archived'), '[]'::jsonb),
    'handoff', (select jsonb_build_object('id', h.id, 'createdAt', h.created_at, 'note', h.note) from leadflow_private.client_handoffs h where h.deal_id = d.id),
    'otherDeals', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'outcome', x.outcome) order by x.created_at) from leadflow_private.deals x
      where x.workspace_id = target_workspace and x.lead_id = d.lead_id and x.id <> d.id and x.archived_at is null), '[]'::jsonb));
end $$;

-- The deal's timeline, newest first: its own activities, its follow-up tasks (created, completed, cancelled), the lead's
-- outreach drafts (generated, sent, reply recorded) and the lead's activity history, without copying any of them.
-- kinds filters by group: activity, stage, task, meeting, outreach, lead. before pages back in time.
create function public.deal_timeline(target_workspace uuid, deal_id uuid, kinds jsonb, before_at timestamptz, page_size integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.deals; wanted text[]; page_rows integer := least(greatest(coalesce(page_size, 50), 1), 200);
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into d from leadflow_private.deals x where x.id = deal_id and x.workspace_id = target_workspace;
  if d.id is null then raise exception 'Deal not found.' using errcode = 'P0002'; end if;
  select coalesce(array_agg(value), '{activity,stage,task,meeting,outreach,lead}') into wanted from jsonb_array_elements_text(case when jsonb_typeof(kinds) = 'array' and jsonb_array_length(kinds) > 0 then kinds else '[]'::jsonb end);
  return (with events as (
    select 'activity:' || a.id as id, case when a.kind = 'stage_changed' then 'stage' when a.kind like 'meeting_%' then 'meeting' else 'activity' end as grp, a.kind, a.summary, a.details, a.metadata,
      a.occurred_at as at, a.actor, a.contact_id
      from leadflow_private.deal_activities a where a.deal_id = d.id
    union all
    select 'task-created:' || t.id, 'task', 'task_created', 'Follow-up planned: ' || t.notes, t.description, jsonb_build_object('due', t.due, 'taskType', t."taskType", 'priority', t.priority, 'taskId', t.id), t."createdAt", null, t."contactId"
      from public.follow_up_tasks t where t.workspace_id = target_workspace and t."dealId" = d.id and t."createdAt" is not null
    union all
    select 'task-done:' || t.id, 'task', case when t.cancelled then 'task_cancelled' else 'task_completed' end, case when t.cancelled then 'Follow-up cancelled: ' else 'Follow-up completed: ' end || t.notes, '',
      jsonb_build_object('taskId', t.id), t."completedAt", null, t."contactId"
      from public.follow_up_tasks t where t.workspace_id = target_workspace and t."dealId" = d.id and t."completedAt" is not null and (t.completed or t.cancelled)
    union all
    select 'draft:' || o.id, 'outreach', 'outreach_drafted', 'Outreach drafted: ' || coalesce(nullif(o.subject, ''), o.channel), '', jsonb_build_object('draftId', o.id, 'channel', o.channel, 'contactName', o.contact_name), o.created_at, o.created_by, o.contact_id
      from leadflow_private.outreach_drafts o where o.workspace_id = target_workspace and o.lead_id = d.lead_id
    union all
    select 'draft-edit:' || v.id, 'outreach', 'outreach_edited', 'Outreach draft edited (version ' || v.version || ')', '', jsonb_build_object('draftId', v.draft_id), v.created_at, v.created_by, null
      from leadflow_private.outreach_draft_versions v join leadflow_private.outreach_drafts o on o.id = v.draft_id
      where o.workspace_id = target_workspace and o.lead_id = d.lead_id and v.origin = 'edited'
    union all
    select 'draft-sent:' || o.id, 'outreach', 'outreach_sent', 'Outreach marked as sent: ' || coalesce(nullif(o.subject, ''), o.channel), '', jsonb_build_object('draftId', o.id, 'channel', o.channel, 'contactName', o.contact_name), o.sent_at, o.sent_by, o.contact_id
      from leadflow_private.outreach_drafts o where o.workspace_id = target_workspace and o.lead_id = d.lead_id and o.sent_at is not null
    union all
    select 'draft-reply:' || o.id, 'outreach', 'outreach_replied', 'Reply recorded on outreach: ' || coalesce(nullif(o.subject, ''), o.channel), '', jsonb_build_object('draftId', o.id, 'channel', o.channel), o.replied_at, null, o.contact_id
      from leadflow_private.outreach_drafts o where o.workspace_id = target_workspace and o.lead_id = d.lead_id and o.replied_at is not null
    union all
    select 'contact:' || c.id, 'lead', 'contact_added', 'Contact added: ' || case when c.kind = 'person' then c.full_name else coalesce(nullif(c.label, ''), c.email, c.phone) end, '', '{}'::jsonb, c.created_at, c.created_by, c.id
      from leadflow_private.lead_contacts c where c.workspace_id = target_workspace and c.lead_id = d.lead_id
    union all
    select 'lead:' || h.id, 'lead', 'lead_history', h.text, '', '{}'::jsonb, h.at, null, null
      from public.activity_history h where h.workspace_id = target_workspace and h."leadId" = d.lead_id
  )
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'group', e.grp, 'kind', e.kind, 'summary', e.summary, 'details', e.details, 'metadata', e.metadata,
      'at', e.at, 'actorName', coalesce(nullif(p.display_name, ''), u.email), 'contactName', case when c.kind = 'person' then c.full_name else coalesce(nullif(c.label, ''), c.email) end) order by e.at desc, e.id), '[]'::jsonb),
    'hasMore', (select count(*) from events x where x.grp = any(wanted) and (before_at is null or x.at < before_at)) > page_rows)
  from (select * from events x where x.grp = any(wanted) and (before_at is null or x.at < before_at) order by x.at desc, x.id limit page_rows) e
  left join public.profiles p on p.id = e.actor left join auth.users u on u.id = e.actor left join leadflow_private.lead_contacts c on c.id = e.contact_id);
end $$;

-- Records a note, a reply, a call or a sent proposal. Replies and calls are what people tell LeadFlow happened; nothing
-- here is inferred. activity: { kind: note|reply|call|proposal_sent, summary, details, contactId, occurredAt, sentiment, outcome, nextAction, channel }.
create function public.record_deal_activity(target_workspace uuid, deal_id uuid, activity jsonb, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.deals; kind_value text := activity->>'kind'; contact_ref uuid; summary_value text; meta jsonb := '{}'; created uuid; occurred timestamptz;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if request_id is not null and exists (select 1 from leadflow_private.deal_activities a where a.workspace_id = target_workspace and a.request_id = record_deal_activity.request_id) then
    return (select jsonb_build_object('id', a.id, 'repeated', true) from leadflow_private.deal_activities a where a.workspace_id = target_workspace and a.request_id = record_deal_activity.request_id);
  end if;
  if kind_value not in ('note','reply','call','proposal_sent') then raise exception 'Record a note, a reply, a call or a sent proposal.' using errcode = '22023'; end if;
  d := leadflow_private.lock_deal(target_workspace, deal_id, null);
  if nullif(activity->>'contactId', '') is not null then
    select c.id into contact_ref from leadflow_private.lead_contacts c where c.id::text = activity->>'contactId' and c.workspace_id = target_workspace and c.lead_id = d.lead_id;
    if contact_ref is null then raise exception 'That contact isn’t one of this lead’s contacts.' using errcode = '22023'; end if;
  end if;
  begin occurred := coalesce(nullif(activity->>'occurredAt', '')::timestamptz, now());
  exception when others then raise exception 'Enter a valid date and time.' using errcode = '22023'; end;
  if occurred > now() + interval '5 minutes' then raise exception 'A recorded % can’t be in the future.', replace(kind_value, '_', ' ') using errcode = '22023'; end if;
  if kind_value = 'reply' then
    if coalesce(activity->>'sentiment', '') not in ('positive','neutral','negative') then raise exception 'Choose whether the reply was positive, neutral or negative.' using errcode = '22023'; end if;
    meta := jsonb_build_object('sentiment', activity->>'sentiment', 'channel', left(coalesce(activity->>'channel', ''), 40));
    summary_value := initcap(activity->>'sentiment') || ' reply recorded' || coalesce(' via ' || nullif(left(activity->>'channel', 40), ''), '');
  elsif kind_value = 'call' then
    if coalesce(activity->>'outcome', '') not in ('connected','no_answer','voicemail','interested','not_interested','callback_requested') then raise exception 'Choose the call outcome.' using errcode = '22023'; end if;
    meta := jsonb_build_object('outcome', activity->>'outcome', 'nextAction', left(coalesce(activity->>'nextAction', ''), 300));
    summary_value := 'Call logged · ' || replace(activity->>'outcome', '_', ' ');
  elsif kind_value = 'proposal_sent' then
    summary_value := 'Proposal sent' || coalesce(' · ' || nullif(left(btrim(activity->>'summary'), 200), ''), '');
  else
    if btrim(coalesce(activity->>'details', '')) = '' then raise exception 'Write the note first.' using errcode = '22023'; end if;
    summary_value := coalesce(nullif(left(btrim(activity->>'summary'), 200), ''), 'Note added');
  end if;
  if length(coalesce(activity->>'details', '')) > 4000 then raise exception 'Notes can be up to 4,000 characters.' using errcode = '22023'; end if;
  created := leadflow_private.add_deal_activity(d, kind_value, summary_value, activity->>'details', meta, contact_ref, occurred, request_id);
  return jsonb_build_object('id', created, 'repeated', false);
end $$;

-- Schedules a meeting (meeting.id absent) or updates one. Status changes (completed, cancelled, no-show) are recorded on the
-- timeline. meeting: { id?, version?, title, startsAt, durationMinutes, timezone, location, meetingUrl, agenda, notes, status, contactId }.
create function public.save_deal_meeting(target_workspace uuid, deal_id uuid, meeting jsonb, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.deals; m leadflow_private.deal_meetings; result leadflow_private.deal_meetings; contact_ref uuid; status_value text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if jsonb_typeof(meeting) is distinct from 'object' then raise exception 'Invalid meeting.' using errcode = '22023'; end if;
  d := leadflow_private.lock_deal(target_workspace, deal_id, null);
  if nullif(meeting->>'contactId', '') is not null then
    select c.id into contact_ref from leadflow_private.lead_contacts c where c.id::text = meeting->>'contactId' and c.workspace_id = target_workspace and c.lead_id = d.lead_id;
    if contact_ref is null then raise exception 'That contact isn’t one of this lead’s contacts.' using errcode = '22023'; end if;
  end if;
  status_value := coalesce(nullif(meeting->>'status', ''), 'scheduled');
  if status_value not in ('scheduled','completed','cancelled','no_show') then raise exception 'Choose a listed meeting status.' using errcode = '22023'; end if;
  begin
    if meeting ? 'id' then
      select * into m from leadflow_private.deal_meetings x where x.id::text = meeting->>'id' and x.deal_id = d.id for update;
      if m.id is null then raise exception 'Meeting not found.' using errcode = 'P0002'; end if;
      if (meeting->>'version')::integer is distinct from m.version then raise exception 'This meeting changed in another window. Reload it and try again.' using errcode = '40001'; end if;
      update leadflow_private.deal_meetings x set title = coalesce(btrim(meeting->>'title'), x.title), starts_at = coalesce((meeting->>'startsAt')::timestamptz, x.starts_at),
        duration_minutes = coalesce((meeting->>'durationMinutes')::integer, x.duration_minutes), timezone = coalesce(meeting->>'timezone', x.timezone),
        location = coalesce(meeting->>'location', x.location), meeting_url = coalesce(btrim(meeting->>'meetingUrl'), x.meeting_url), agenda = coalesce(meeting->>'agenda', x.agenda),
        notes = coalesce(meeting->>'notes', x.notes), status = status_value, contact_id = case when meeting ? 'contactId' then contact_ref else x.contact_id end,
        version = x.version + 1, updated_at = now() where x.id = m.id returning * into result;
      if result.status <> m.status then
        perform leadflow_private.add_deal_activity(d, 'meeting_' || result.status, 'Meeting ' || replace(result.status, '_', '-') || ': ' || result.title, result.notes,
          jsonb_build_object('meetingId', result.id, 'startsAt', result.starts_at), result.contact_id, case when result.status = 'completed' then least(now(), result.starts_at + make_interval(mins => result.duration_minutes)) else now() end, null);
      elsif result.starts_at <> m.starts_at then
        perform leadflow_private.add_deal_activity(d, 'meeting_updated', 'Meeting moved: ' || result.title, '', jsonb_build_object('meetingId', result.id, 'from', m.starts_at, 'to', result.starts_at), result.contact_id, now(), null);
      end if;
    else
      select * into result from leadflow_private.deal_meetings x where x.workspace_id = target_workspace and x.request_id = save_deal_meeting.request_id;
      if result.id is not null then return to_jsonb(result) || jsonb_build_object('repeated', true); end if;
      insert into leadflow_private.deal_meetings(workspace_id, deal_id, request_id, contact_id, title, starts_at, duration_minutes, timezone, location, meeting_url, agenda, notes, status, created_by)
        values (target_workspace, d.id, save_deal_meeting.request_id, contact_ref, btrim(coalesce(meeting->>'title', '')), (meeting->>'startsAt')::timestamptz,
          coalesce((meeting->>'durationMinutes')::integer, 30), coalesce(nullif(meeting->>'timezone', ''), 'UTC'), coalesce(meeting->>'location', ''), btrim(coalesce(meeting->>'meetingUrl', '')),
          coalesce(meeting->>'agenda', ''), coalesce(meeting->>'notes', ''), status_value, leadflow_private.valid_actor()) returning * into result;
      perform leadflow_private.add_deal_activity(d, 'meeting_scheduled', 'Meeting scheduled: ' || result.title || ' · ' || to_char(result.starts_at at time zone result.timezone, 'Mon DD, HH24:MI') || ' ' || result.timezone,
        result.agenda, jsonb_build_object('meetingId', result.id, 'startsAt', result.starts_at, 'timezone', result.timezone), result.contact_id, now(), null);
    end if;
  exception
    when check_violation or not_null_violation then raise exception 'Check the meeting: a title of up to 150 characters, a start time, 5–480 minutes, and a link starting with https://.' using errcode = '22023';
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or invalid_parameter_value then raise exception 'Check the meeting’s start time, duration and time zone.' using errcode = '22023';
  end;
  return to_jsonb(result) || jsonb_build_object('repeated', false);
end $$;

-- Confirms the handoff of a won deal to client work, once. Returns the existing handoff when it was already confirmed.
create function public.confirm_client_handoff(target_workspace uuid, deal_id uuid, note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.deals; h leadflow_private.client_handoffs;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  d := leadflow_private.lock_deal(target_workspace, deal_id, null);
  select * into h from leadflow_private.client_handoffs x where x.deal_id = d.id;
  if h.id is not null then return jsonb_build_object('id', h.id, 'createdAt', h.created_at, 'repeated', true); end if;
  if d.outcome <> 'won' then raise exception 'Only won deals can be handed off to client work.' using errcode = '22023'; end if;
  insert into leadflow_private.client_handoffs(workspace_id, deal_id, lead_id, contact_id, snapshot, note, confirmed_by)
    values (target_workspace, d.id, d.lead_id, d.contact_id, leadflow_private.deal_json(d) || jsonb_build_object(
      'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', case when c.kind = 'person' then c.full_name else coalesce(nullif(c.label, ''), c.email) end, 'email', c.email, 'phone', c.phone,
        'jobTitle', c.job_title)) from leadflow_private.lead_contacts c where c.workspace_id = target_workspace and c.lead_id = d.lead_id), '[]'::jsonb)),
      left(coalesce(note, ''), 2000), leadflow_private.valid_actor()) returning * into h;
  perform leadflow_private.add_deal_activity(d, 'handoff_confirmed', 'Handed off to client work', coalesce(note, ''), jsonb_build_object('handoffId', h.id), d.contact_id, now(), null);
  return jsonb_build_object('id', h.id, 'createdAt', h.created_at, 'repeated', false);
end $$;

-- ---------- Analytics and reminders ----------

-- Sales analytics for a period (from and to are dates, inclusive). Open pipeline is as of now; won, lost, win rate, average
-- value and cycle count deals closed in the period; created-by-source counts deals created in it. Amounts are grouped by
-- currency and never added across currencies. Archived deals are excluded throughout. today is the caller's local date.
create function public.sales_analytics(target_workspace uuid, period_from date, period_to date, today date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare from_ts timestamptz; to_ts timestamptz;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  perform leadflow_private.ensure_sales_setup(target_workspace);
  if period_from is null or period_to is null or period_from > period_to or period_to - period_from > 3660 then raise exception 'Choose a period of up to ten years.' using errcode = '22023'; end if;
  from_ts := period_from::timestamptz; to_ts := (period_to + 1)::timestamptz;
  return (with live as (select d.*, coalesce(d.probability, st.probability) as effective_probability, st.name as stage_name, st.position, st.color
      from leadflow_private.deals d join leadflow_private.sales_stages st on st.id = d.stage_id where d.workspace_id = target_workspace and d.archived_at is null),
    closed as (select * from live where outcome <> 'open' and actual_close_date between period_from and period_to)
  select jsonb_build_object('from', period_from, 'to', period_to,
    'open', jsonb_build_object('count', (select count(*) from live where outcome = 'open'), 'withoutValue', (select count(*) from live where outcome = 'open' and value is null),
      'byCurrency', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'count', n, 'value', v, 'weighted', w, 'weightedCount', wn) order by currency) from (
        select currency, count(*) as n, sum(value) as v, sum(value * effective_probability / 100.0) as w, count(effective_probability) as wn from live where outcome = 'open' and value is not null group by currency) t), '[]'::jsonb)),
    'won', jsonb_build_object('count', (select count(*) from closed where outcome = 'won'),
      'byCurrency', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'count', n, 'value', v, 'average', a) order by currency) from (
        select currency, count(*) as n, sum(coalesce(won_value, value)) as v, avg(coalesce(won_value, value)) as a from closed where outcome = 'won' and coalesce(won_value, value) is not null group by currency) t), '[]'::jsonb),
      -- Whole days from the day it was created to the close date (never negative when created and closed the same day).
      'averageCycleDays', (select round(avg(greatest(actual_close_date - created_at::date, 0))::numeric, 1) from closed where outcome = 'won')),
    'lost', jsonb_build_object('count', (select count(*) from closed where outcome = 'lost'),
      'byCurrency', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'count', n, 'value', v) order by currency) from (
        select currency, count(*) as n, sum(value) as v from closed where outcome = 'lost' and value is not null group by currency) t), '[]'::jsonb),
      'reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', lost_reason, 'count', n) order by n desc, lost_reason) from (select lost_reason, count(*) as n from closed where outcome = 'lost' group by lost_reason) t), '[]'::jsonb)),
    'winRate', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where outcome = 'won') / count(*), 1) end from closed),
    'closedCount', (select count(*) from closed),
    'stages', coalesce((select jsonb_agg(jsonb_build_object('stageId', s.id, 'name', s.name, 'color', s.color, 'count', (select count(*) from live l where l.stage_id = s.id and l.outcome = 'open'),
        'byCurrency', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'value', v) order by currency) from (select currency, sum(value) as v from live l where l.stage_id = s.id and l.outcome = 'open' and value is not null group by currency) t), '[]'::jsonb))
      order by s.position) from leadflow_private.sales_stages s where s.workspace_id = target_workspace and s.archived_at is null and s.category = 'open'), '[]'::jsonb),
    'bySource', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'count', n) order by n desc, source) from (select source, count(*) as n from live where created_at >= from_ts and created_at < to_ts group by source) t), '[]'::jsonb),
    'byService', coalesce((select jsonb_agg(jsonb_build_object('service', service, 'count', n, 'won', w) order by n desc, service) from (
      select coalesce(nullif(service_name, ''), nullif(opportunity_title, ''), 'No service linked') as service, count(*) as n, count(*) filter (where outcome = 'won') as w
      from live where created_at >= from_ts and created_at < to_ts group by 1) t), '[]'::jsonb),
    'createdCount', (select count(*) from live where created_at >= from_ts and created_at < to_ts),
    'totalDeals', (select count(*) from live),
    'overdueTasks', (select count(*) from public.follow_up_tasks t join live l on l.id = t."dealId" where t.workspace_id = target_workspace and not t.completed and not t.cancelled and t.due < today),
    'upcomingCloses', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'expectedCloseDate', expected_close_date, 'value', value, 'currency', currency, 'overdue', expected_close_date < today) order by expected_close_date)
      from (select * from live where outcome = 'open' and expected_close_date is not null and expected_close_date <= today + 30 order by expected_close_date limit 10) t), '[]'::jsonb),
    'upcomingMeetings', (select count(*) from leadflow_private.deal_meetings m join live l on l.id = m.deal_id where m.status = 'scheduled' and m.starts_at >= now() and m.starts_at < now() + interval '7 days')));
end $$;

-- Reminders for the notification centre: scheduled meetings in the next two days and open deals whose expected close date
-- is within three days or past. Nothing is sent; the app shows them to whoever is signed in.
create function public.sales_reminders_for(target_workspace uuid, today date) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return jsonb_build_object(
    'meetings', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'dealId', d.id, 'dealTitle', d.title, 'title', m.title, 'startsAt', m.starts_at, 'timezone', m.timezone) order by m.starts_at)
      from leadflow_private.deal_meetings m join leadflow_private.deals d on d.id = m.deal_id where m.workspace_id = target_workspace and d.archived_at is null and m.status = 'scheduled'
        and m.starts_at >= now() - interval '1 hour' and m.starts_at < now() + interval '48 hours'), '[]'::jsonb),
    'closing', coalesce((select jsonb_agg(jsonb_build_object('dealId', d.id, 'title', d.title, 'expectedCloseDate', d.expected_close_date, 'overdue', d.expected_close_date < today, 'ownerId', d.owner_id) order by d.expected_close_date)
      from leadflow_private.deals d where d.workspace_id = target_workspace and d.archived_at is null and d.outcome = 'open' and d.expected_close_date <= today + 3), '[]'::jsonb));
end $$;

revoke all on function leadflow_private.check_follow_up_task(), leadflow_private.ensure_sales_setup(uuid), leadflow_private.stage_json(leadflow_private.sales_stages),
  leadflow_private.deal_json(leadflow_private.deals), leadflow_private.add_deal_activity(leadflow_private.deals, text, text, text, jsonb, uuid, timestamptz, uuid),
  leadflow_private.lock_deal(uuid, uuid, integer), leadflow_private.apply_stage(leadflow_private.deals, leadflow_private.sales_stages, uuid, text) from public, anon, authenticated;
revoke all on function public.sales_pipeline_for(uuid), public.save_sales_stage(uuid, jsonb), public.reorder_sales_stages(uuid, jsonb), public.archive_sales_stage(uuid, uuid, uuid),
  public.restore_sales_stage(uuid, uuid), public.save_sales_settings(uuid, jsonb), public.create_deal(uuid, jsonb, uuid, boolean), public.update_deal(uuid, uuid, integer, jsonb),
  public.move_deal(uuid, uuid, uuid, integer, uuid), public.close_deal(uuid, uuid, text, jsonb, integer, uuid), public.reopen_deal(uuid, uuid, uuid, integer, uuid),
  public.set_deal_archived(uuid, uuid, boolean), public.deals_for(uuid, jsonb), public.pipeline_board_for(uuid, jsonb), public.deal_detail(uuid, uuid),
  public.deal_timeline(uuid, uuid, jsonb, timestamptz, integer), public.record_deal_activity(uuid, uuid, jsonb, uuid), public.save_deal_meeting(uuid, uuid, jsonb, uuid),
  public.confirm_client_handoff(uuid, uuid, text), public.sales_analytics(uuid, date, date, date), public.sales_reminders_for(uuid, date) from public, anon, authenticated;
grant execute on function public.sales_pipeline_for(uuid), public.save_sales_stage(uuid, jsonb), public.reorder_sales_stages(uuid, jsonb), public.archive_sales_stage(uuid, uuid, uuid),
  public.restore_sales_stage(uuid, uuid), public.save_sales_settings(uuid, jsonb), public.create_deal(uuid, jsonb, uuid, boolean), public.update_deal(uuid, uuid, integer, jsonb),
  public.move_deal(uuid, uuid, uuid, integer, uuid), public.close_deal(uuid, uuid, text, jsonb, integer, uuid), public.reopen_deal(uuid, uuid, uuid, integer, uuid),
  public.set_deal_archived(uuid, uuid, boolean), public.deals_for(uuid, jsonb), public.pipeline_board_for(uuid, jsonb), public.deal_detail(uuid, uuid),
  public.deal_timeline(uuid, uuid, jsonb, timestamptz, integer), public.record_deal_activity(uuid, uuid, jsonb, uuid), public.save_deal_meeting(uuid, uuid, jsonb, uuid),
  public.confirm_client_handoff(uuid, uuid, text), public.sales_analytics(uuid, date, date, date), public.sales_reminders_for(uuid, date) to authenticated;
