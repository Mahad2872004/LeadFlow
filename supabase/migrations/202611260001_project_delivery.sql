-- M11 project and delivery management. Builds on M10 clients (contacts, confirmed services and scope, the onboarding
-- completion snapshot), M9/M10 follow-up tasks, the client activity history and M10 document storage, instead of adding
-- a second task, activity, contact or file system.
-- * Projects: a client can have several projects, each with its own scope brief (edited from confirmed onboarding data),
--   dates, status, priority, owner, tags, agreed value and recorded costs. Progress and health are computed, not stored.
-- * Planning: milestones (ordered, with dependencies inside the project) and deliverables (internal delivery statuses).
--   Reusable project templates hold milestones with their deliverables and tasks, as day offsets from the start date.
-- * Tasks: the existing follow-up tasks gain a project, milestone and deliverable, a work status, a start date, effort
--   estimates, labels and dependencies on other tasks of the same project (checked, never circular). They are still
--   saved with the workspace snapshot; functions that create tasks bump the workspace revision so stale clients reload.
-- * Activity and files: client_activities and client_documents gain project links. Project files are always internal.
-- Every new table is private; members act through role-checked functions.
-- Reverse with supabase/rollbacks/202611260001_project_delivery.down.sql.

-- ---------- Templates ----------

create table leadflow_private.project_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  description text not null default '' check (length(description) <= 1000),
  project_type text not null default 'other' check (project_type in ('website','marketing','seo','social','paid_ads','email','automation','software','chatbot','crm','other')),
  starter_key text check (starter_key in ('website','marketing','automation')),
  archived boolean not null default false,
  version integer not null default 1,
  creation_request_id uuid,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index project_templates_name on leadflow_private.project_templates(workspace_id, lower(btrim(name))) where not archived;
create unique index project_templates_starter on leadflow_private.project_templates(workspace_id, starter_key) where starter_key is not null;
create unique index project_templates_request on leadflow_private.project_templates(workspace_id, creation_request_id) where creation_request_id is not null;

create table leadflow_private.project_template_milestones (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  template_id uuid not null,
  position integer not null check (position between 0 and 100),
  name text not null check (length(btrim(name)) between 1 and 150),
  description text not null default '' check (length(description) <= 2000),
  -- Dates are relative to the project's start date.
  start_offset_days integer not null default 0 check (start_offset_days between 0 and 3650),
  duration_days integer not null default 7 check (duration_days between 1 and 3650),
  -- [{title, description}] and [{title, durationDays, priority}], checked by leadflow_private.clean_template_milestone.
  deliverables jsonb not null default '[]' check (jsonb_typeof(deliverables) = 'array' and jsonb_array_length(deliverables) <= 20),
  tasks jsonb not null default '[]' check (jsonb_typeof(tasks) = 'array' and jsonb_array_length(tasks) <= 30),
  foreign key (workspace_id, template_id) references leadflow_private.project_templates(workspace_id, id) on delete cascade,
  unique (template_id, position) deferrable initially deferred
);

-- ---------- Projects ----------

create table leadflow_private.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null,
  request_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 150),
  description text not null default '' check (length(description) <= 4000),
  project_type text not null default 'other' check (project_type in ('website','marketing','seo','social','paid_ads','email','automation','software','chatbot','crm','other')),
  status text not null default 'planning' check (status in ('planning','not_started','in_progress','on_hold','at_risk','completed','cancelled')),
  priority text not null default 'medium' check (priority in ('low','medium','high','critical')),
  owner_id uuid references public.profiles(id) on delete set null,
  start_date date,
  target_date date,
  -- The actual completion date, set when the project is completed.
  completed_on date,
  -- Agreed with the client for this project (not the whole deal); costs are what the agency records. Never computed.
  agreed_value numeric(14,2) check (agreed_value >= 0),
  estimated_cost numeric(14,2) check (estimated_cost >= 0),
  actual_cost numeric(14,2) check (actual_cost >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  tags jsonb not null default '[]' check (jsonb_typeof(tags) = 'array' and jsonb_array_length(tags) <= 20),
  -- The project's working brief: objectives, scope summary, success criteria, dependencies, constraints, assumptions,
  -- exclusions and notes, edited by a person from the confirmed onboarding data (sources keep where each part came from).
  brief jsonb not null default '{}' check (jsonb_typeof(brief) = 'object' and octet_length(brief::text) <= 40000),
  brief_sources jsonb not null default '{}' check (jsonb_typeof(brief_sources) = 'object' and octet_length(brief_sources::text) <= 40000),
  internal_notes text not null default '' check (length(internal_notes) <= 8000),
  source text not null check (source in ('onboarding','client','manual')),
  completion_id uuid references leadflow_private.client_onboarding_completions(id) on delete set null,
  deal_id uuid references leadflow_private.deals(id) on delete set null,
  template_id uuid references leadflow_private.project_templates(id) on delete set null,
  template_name text,
  status_reason text not null default '' check (length(status_reason) <= 1000),
  version integer not null default 1,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (target_date is null or start_date is null or target_date >= start_date),
  check ((status = 'completed') = (completed_on is not null)),
  foreign key (workspace_id, client_id) references leadflow_private.clients(workspace_id, id) on delete cascade
);
create unique index projects_request on leadflow_private.projects(workspace_id, request_id);
create index projects_board on leadflow_private.projects(workspace_id, status, updated_at desc);
create index projects_client on leadflow_private.projects(client_id, created_at desc);

-- Which of the client's agreed services and contacts the project covers.
create table leadflow_private.project_services (
  project_id uuid not null references leadflow_private.projects(id) on delete cascade,
  client_service_id uuid not null references leadflow_private.client_services(id) on delete cascade,
  primary key (project_id, client_service_id)
);
create table leadflow_private.project_contacts (
  project_id uuid not null references leadflow_private.projects(id) on delete cascade,
  contact_id uuid not null references leadflow_private.client_contacts(id) on delete cascade,
  primary key (project_id, contact_id)
);

create table leadflow_private.project_milestones (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  position integer not null check (position between 0 and 1000),
  name text not null check (length(btrim(name)) between 1 and 150),
  description text not null default '' check (length(description) <= 2000),
  start_date date,
  due_date date,
  status text not null default 'upcoming' check (status in ('upcoming','in_progress','completed','delayed','cancelled')),
  completed_at timestamptz,
  notes text not null default '' check (length(notes) <= 2000),
  -- Milestones of the same project this one waits for. Checked, never circular.
  depends_on jsonb not null default '[]' check (jsonb_typeof(depends_on) = 'array' and jsonb_array_length(depends_on) <= 20),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (due_date is null or start_date is null or due_date >= start_date),
  check ((status = 'completed') = (completed_at is not null)),
  foreign key (workspace_id, project_id) references leadflow_private.projects(workspace_id, id) on delete cascade
);
create index project_milestones_project on leadflow_private.project_milestones(project_id, position);

create table leadflow_private.project_deliverables (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  milestone_id uuid,
  position integer not null check (position between 0 and 10000),
  title text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '' check (length(description) <= 4000),
  owner_id uuid references public.profiles(id) on delete set null,
  due_date date,
  priority text not null default 'medium' check (priority in ('low','medium','high','critical')),
  -- Internal delivery statuses. Client review and approval are not part of M11.
  status text not null default 'not_started' check (status in ('not_started','in_progress','internal_review','ready_for_review','completed','blocked')),
  notes text not null default '' check (length(notes) <= 2000),
  client_service_id uuid references leadflow_private.client_services(id) on delete set null,
  completed_at timestamptz,
  version integer not null default 1,
  request_id uuid,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((status = 'completed') = (completed_at is not null)),
  foreign key (workspace_id, project_id) references leadflow_private.projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, milestone_id) references leadflow_private.project_milestones(workspace_id, id) on delete set null (milestone_id)
);
create index project_deliverables_project on leadflow_private.project_deliverables(project_id, position);
create unique index project_deliverables_request on leadflow_private.project_deliverables(workspace_id, request_id) where request_id is not null;

-- ---------- Existing tables ----------

-- Project history and notes live in the client's activity history, linked to the project (and milestone or deliverable
-- through entity_type/entity_id), so the client's timeline shows project events too.
alter table leadflow_private.client_activities add column project_id uuid,
  add constraint client_activities_project foreign key (workspace_id, project_id) references leadflow_private.projects(workspace_id, id) on delete cascade;
create index client_activities_project on leadflow_private.client_activities(project_id, at desc, id desc) where project_id is not null;

-- Project files: the same private storage and checks as M10, always internal (never on the client's portal).
alter table leadflow_private.client_documents add column project_id uuid, add column milestone_id uuid, add column deliverable_id uuid,
  add column task_id text check (length(task_id) <= 100),
  add constraint client_documents_project foreign key (workspace_id, project_id) references leadflow_private.projects(workspace_id, id) on delete cascade,
  add constraint client_documents_milestone foreign key (workspace_id, milestone_id) references leadflow_private.project_milestones(workspace_id, id) on delete set null (milestone_id),
  add constraint client_documents_deliverable foreign key (workspace_id, deliverable_id) references leadflow_private.project_deliverables(workspace_id, id) on delete set null (deliverable_id),
  add constraint client_documents_project_links check (project_id is not null or (milestone_id is null and deliverable_id is null and task_id is null)),
  add constraint client_documents_project_internal check (project_id is null or visibility = 'internal');
create index client_documents_project on leadflow_private.client_documents(project_id, status, created_at desc) where project_id is not null;

-- Tasks: the same follow-up tasks. Project tasks belong to the project's client and have no lead.
alter table public.follow_up_tasks
  add column "projectId" uuid,
  add column "milestoneId" uuid,
  add column "deliverableId" uuid,
  -- The work status of an open task; completed and cancelled stay as before.
  add column status text not null default 'todo' check (status in ('todo','in_progress','in_review','blocked')),
  add column "startDate" date,
  add column "estimateHours" numeric(7,2) check ("estimateHours" between 0 and 10000),
  add column "actualHours" numeric(7,2) check ("actualHours" between 0 and 10000),
  add column labels jsonb not null default '[]' check (jsonb_typeof(labels) = 'array' and jsonb_array_length(labels) <= 10),
  -- IDs of tasks of the same project this one waits for. Checked by leadflow_private.check_task_dependencies.
  add column "dependsOn" jsonb not null default '[]' check (jsonb_typeof("dependsOn") = 'array' and jsonb_array_length("dependsOn") <= 20),
  add constraint follow_up_tasks_start check ("startDate" is null or "startDate" <= due),
  add constraint follow_up_tasks_project foreign key (workspace_id, "projectId") references leadflow_private.projects(workspace_id, id) on delete cascade,
  add constraint follow_up_tasks_milestone foreign key (workspace_id, "milestoneId") references leadflow_private.project_milestones(workspace_id, id) on delete set null ("milestoneId"),
  add constraint follow_up_tasks_deliverable foreign key (workspace_id, "deliverableId") references leadflow_private.project_deliverables(workspace_id, id) on delete set null ("deliverableId");
alter table public.follow_up_tasks drop constraint "follow_up_tasks_taskType_check";
alter table public.follow_up_tasks add constraint "follow_up_tasks_taskType_check" check ("taskType" in ('follow_up','call','email','whatsapp','meeting','proposal','proposal_review','internal','custom',
  'welcome','request_info','review_form','collect_assets','review_requirements','confirm_scope','verify_integrations','prepare_handoff','delivery'));
create index follow_up_tasks_project on public.follow_up_tasks(workspace_id, "projectId") where "projectId" is not null;

alter table leadflow_private.project_templates enable row level security;
alter table leadflow_private.project_template_milestones enable row level security;
alter table leadflow_private.projects enable row level security;
alter table leadflow_private.project_services enable row level security;
alter table leadflow_private.project_contacts enable row level security;
alter table leadflow_private.project_milestones enable row level security;
alter table leadflow_private.project_deliverables enable row level security;
revoke all on leadflow_private.project_templates, leadflow_private.project_template_milestones, leadflow_private.projects, leadflow_private.project_services,
  leadflow_private.project_contacts, leadflow_private.project_milestones, leadflow_private.project_deliverables from public, anon, authenticated;
create trigger touch_updated_at before update on leadflow_private.project_templates for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on leadflow_private.projects for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on leadflow_private.project_milestones for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on leadflow_private.project_deliverables for each row execute function leadflow_private.touch_updated_at();

-- ---------- Helpers ----------

-- Today in the workspace's time zone: due dates, overdue work and health all use it.
create function leadflow_private.project_today(target_workspace uuid) returns date language sql stable set search_path = '' as $$
  select (now() at time zone coalesce((select s.timezone from public.workspace_settings s where s.workspace_id = target_workspace), 'UTC'))::date
$$;

-- Tasks are saved with the workspace snapshot. A function that writes tasks directly bumps the revision, so a session
-- holding an older snapshot gets a conflict and reloads instead of overwriting the new tasks.
create function leadflow_private.bump_workspace_revision(target_workspace uuid) returns void language sql security definer set search_path = '' as $$
  update public.workspaces set revision = revision + 1 where id = target_workspace
$$;

-- A project event in the client's activity history, linked to the project (and to a milestone or deliverable).
create function leadflow_private.project_event(target leadflow_private.projects, event_kind text, event_summary text, event_detail jsonb default '{}',
  target_entity_type text default 'project', target_entity_id text default null, event_request uuid default null) returns void
language sql security definer set search_path = '' as $$
  insert into leadflow_private.client_activities(workspace_id, client_id, project_id, kind, summary, detail, actor_type, actor_id, entity_type, entity_id, request_id)
  values (target.workspace_id, target.client_id, target.id, event_kind, left(event_summary, 300), coalesce(event_detail, '{}'), 'member', leadflow_private.valid_actor(),
    target_entity_type, coalesce(target_entity_id, target.id::text), event_request)
$$;

-- The project, locked for a change. Archived clients are read-only, and so are their projects.
create function leadflow_private.lock_project(target_workspace uuid, target_project uuid, expected_version integer) returns leadflow_private.projects
language plpgsql security definer set search_path = '' as $$
declare found_project leadflow_private.projects;
begin
  select * into found_project from leadflow_private.projects p where p.id = target_project and p.workspace_id = target_workspace for update;
  if not found then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  if expected_version is not null and found_project.version <> expected_version then
    raise exception 'This project was changed in another window. Reload it and try again.' using errcode = '40001';
  end if;
  if exists (select 1 from leadflow_private.clients c where c.id = found_project.client_id and c.status = 'archived') then
    raise exception 'This project''s client is archived. Unarchive the client to make changes.' using errcode = '55000';
  end if;
  return found_project;
end $$;

create function leadflow_private.clean_money(raw jsonb, label text) returns numeric language plpgsql immutable set search_path = '' as $$
declare value numeric;
begin
  if raw is null or raw = 'null'::jsonb or (jsonb_typeof(raw) = 'string' and btrim(raw #>> '{}') = '') then return null; end if;
  begin
    value := case jsonb_typeof(raw) when 'number' then (raw #>> '{}')::numeric when 'string' then replace(btrim(raw #>> '{}'), ',', '')::numeric end;
  exception when invalid_text_representation then value := null;
  end;
  if value is null or value < 0 or value > 999999999999 then raise exception '% must be a positive amount.', label using errcode = '22023'; end if;
  return round(value, 2);
end $$;

create function leadflow_private.clean_labels(raw jsonb, label text, max_items integer, max_length integer) returns jsonb language plpgsql immutable set search_path = '' as $$
declare result jsonb := '[]'; item jsonb; clean text;
begin
  if raw is null or raw = 'null'::jsonb then return '[]'; end if;
  if jsonb_typeof(raw) <> 'array' then raise exception '% must be a list.', label using errcode = '22023'; end if;
  for item in select value from jsonb_array_elements(raw) loop
    if jsonb_typeof(item) <> 'string' then raise exception '% must be text.', label using errcode = '22023'; end if;
    clean := leadflow_private.onboarding_clean_text(item #>> '{}', label, max_length);
    if clean <> '' and not result @> to_jsonb(clean) then result := result || to_jsonb(clean); end if;
  end loop;
  if jsonb_array_length(result) > max_items then raise exception 'Use at most % %.', max_items, lower(label) using errcode = '22023'; end if;
  return result;
end $$;

-- The project brief: what was agreed, edited by a person. Every part is optional text.
create function leadflow_private.clean_brief(raw jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare unknown_key text; result jsonb := '{}'; key text;
begin
  if raw is null or raw = 'null'::jsonb then return '{}'; end if;
  if jsonb_typeof(raw) <> 'object' then raise exception 'Send the brief as an object.' using errcode = '22023'; end if;
  select k into unknown_key from jsonb_object_keys(raw) k where k not in ('objectives','scopeSummary','successCriteria','expectations','dependencies','constraints','assumptions','exclusions','notes') limit 1;
  if unknown_key is not null then raise exception 'Unknown brief field: %.', unknown_key using errcode = '22023'; end if;
  for key in select k from jsonb_object_keys(raw) k loop
    if jsonb_typeof(raw->key) not in ('string','null') then raise exception 'The brief''s % must be text.', key using errcode = '22023'; end if;
    result := result || jsonb_build_object(key, leadflow_private.onboarding_clean_text(raw->>key, 'The brief''s ' || key, case when key = 'scopeSummary' then 8000 else 4000 end, false, false));
  end loop;
  return result;
end $$;

-- Project fields from the browser. Keys that are absent are left unchanged.
create function leadflow_private.clean_project_details(details jsonb) returns jsonb language plpgsql stable set search_path = '' as $$
declare unknown_key text; result jsonb := '{}';
begin
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the project details as an object.' using errcode = '22023'; end if;
  select k into unknown_key from jsonb_object_keys(details) k where k not in ('name','description','projectType','priority','ownerId','startDate','targetDate','agreedValue','estimatedCost',
    'actualCost','currency','tags','brief','internalNotes','serviceIds','contactIds') limit 1;
  if unknown_key is not null then raise exception 'Unknown project field: %.', unknown_key using errcode = '22023'; end if;
  if details ? 'name' then result := result || jsonb_build_object('name', leadflow_private.onboarding_clean_text(details->>'name', 'Project name', 150, true)); end if;
  if details ? 'description' then result := result || jsonb_build_object('description', leadflow_private.onboarding_clean_text(details->>'description', 'Description', 4000, false, false)); end if;
  if details ? 'projectType' then
    if coalesce(details->>'projectType', '') not in ('website','marketing','seo','social','paid_ads','email','automation','software','chatbot','crm','other') then raise exception 'Choose a project type.' using errcode = '22023'; end if;
    result := result || jsonb_build_object('projectType', details->>'projectType');
  end if;
  if details ? 'priority' then
    if coalesce(details->>'priority', '') not in ('low','medium','high','critical') then raise exception 'Choose a priority.' using errcode = '22023'; end if;
    result := result || jsonb_build_object('priority', details->>'priority');
  end if;
  if details ? 'ownerId' then result := result || jsonb_build_object('ownerId', nullif(details->>'ownerId', '')); end if;
  if details ? 'startDate' then result := result || jsonb_build_object('startDate', leadflow_private.onboarding_clean_date(details->>'startDate', 'Start date')); end if;
  if details ? 'targetDate' then result := result || jsonb_build_object('targetDate', leadflow_private.onboarding_clean_date(details->>'targetDate', 'Target completion date')); end if;
  if details ? 'agreedValue' then result := result || jsonb_build_object('agreedValue', leadflow_private.clean_money(details->'agreedValue', 'The agreed value')); end if;
  if details ? 'estimatedCost' then result := result || jsonb_build_object('estimatedCost', leadflow_private.clean_money(details->'estimatedCost', 'The estimated cost')); end if;
  if details ? 'actualCost' then result := result || jsonb_build_object('actualCost', leadflow_private.clean_money(details->'actualCost', 'The actual cost')); end if;
  if details ? 'currency' then
    if upper(btrim(coalesce(details->>'currency', ''))) !~ '^[A-Z]{3}$' then raise exception 'Choose a currency such as USD.' using errcode = '22023'; end if;
    result := result || jsonb_build_object('currency', upper(btrim(details->>'currency')));
  end if;
  if details ? 'tags' then result := result || jsonb_build_object('tags', leadflow_private.clean_labels(details->'tags', 'Tags', 20, 40)); end if;
  if details ? 'brief' then result := result || jsonb_build_object('brief', leadflow_private.clean_brief(details->'brief')); end if;
  if details ? 'internalNotes' then result := result || jsonb_build_object('internalNotes', leadflow_private.onboarding_clean_text(details->>'internalNotes', 'Internal notes', 8000, false, false)); end if;
  if details ? 'serviceIds' then
    if jsonb_typeof(details->'serviceIds') <> 'array' or jsonb_array_length(details->'serviceIds') > 30 then raise exception 'Choose up to 30 services.' using errcode = '22023'; end if;
    result := result || jsonb_build_object('serviceIds', details->'serviceIds');
  end if;
  if details ? 'contactIds' then
    if jsonb_typeof(details->'contactIds') <> 'array' or jsonb_array_length(details->'contactIds') > 50 then raise exception 'Choose up to 50 contacts.' using errcode = '22023'; end if;
    result := result || jsonb_build_object('contactIds', details->'contactIds');
  end if;
  return result;
end $$;

-- Replaces the project's services and contacts. Each must be the client's; services must be confirmed.
create function leadflow_private.set_project_links(target leadflow_private.projects, services jsonb, contacts jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare ref text;
begin
  if services is not null then
    for ref in select value #>> '{}' from jsonb_array_elements(services) loop
      if not exists (select 1 from leadflow_private.client_services s where s.client_id = target.client_id and s.id::text = ref and s.status = 'confirmed') then
        raise exception 'Choose services the client has confirmed.' using errcode = '22023';
      end if;
    end loop;
    delete from leadflow_private.project_services x where x.project_id = target.id;
    insert into leadflow_private.project_services(project_id, client_service_id) select distinct target.id, (value #>> '{}')::uuid from jsonb_array_elements(services);
  end if;
  if contacts is not null then
    for ref in select value #>> '{}' from jsonb_array_elements(contacts) loop
      if not exists (select 1 from leadflow_private.client_contacts c where c.client_id = target.client_id and c.id::text = ref) then
        raise exception 'Choose contacts of this client.' using errcode = '22023';
      end if;
    end loop;
    delete from leadflow_private.project_contacts x where x.project_id = target.id;
    insert into leadflow_private.project_contacts(project_id, contact_id) select distinct target.id, (value #>> '{}')::uuid from jsonb_array_elements(contacts);
  end if;
end $$;

-- Progress, from recorded completion only. The basis is the project's deliverables when it has any, otherwise its tasks
-- (cancelled tasks don't count). Milestones are reported but never mixed into the percentage.
create function leadflow_private.project_progress(target leadflow_private.projects, today date) returns jsonb language sql stable set search_path = '' as $$
  with t as (select * from public.follow_up_tasks x where x.workspace_id = target.workspace_id and x."projectId" = target.id and not x.cancelled),
  d as (select * from leadflow_private.project_deliverables x where x.project_id = target.id),
  m as (select * from leadflow_private.project_milestones x where x.project_id = target.id and x.status <> 'cancelled'),
  c as (select (select count(*) from t) as tasks, (select count(*) from t where completed) as tasks_done, (select count(*) from t where not completed and due < today) as tasks_overdue,
      (select count(*) from t where not completed and status = 'blocked') as tasks_blocked,
      (select count(*) from d) as deliverables, (select count(*) from d where status = 'completed') as deliverables_done,
      (select count(*) from d where status <> 'completed' and due_date < today) as deliverables_overdue, (select count(*) from d where status = 'blocked') as deliverables_blocked,
      (select count(*) from m) as milestones, (select count(*) from m where status = 'completed') as milestones_done,
      (select count(*) from m where status <> 'completed' and due_date < today) as milestones_overdue)
  select jsonb_build_object(
    'basis', case when c.deliverables > 0 then 'deliverables' when c.tasks > 0 then 'tasks' else 'none' end,
    'percent', case when c.deliverables > 0 then floor(100.0 * c.deliverables_done / c.deliverables)::integer when c.tasks > 0 then floor(100.0 * c.tasks_done / c.tasks)::integer else 0 end,
    'tasks', jsonb_build_object('total', c.tasks, 'completed', c.tasks_done, 'overdue', c.tasks_overdue, 'blocked', c.tasks_blocked),
    'deliverables', jsonb_build_object('total', c.deliverables, 'completed', c.deliverables_done, 'overdue', c.deliverables_overdue, 'blocked', c.deliverables_blocked),
    'milestones', jsonb_build_object('total', c.milestones, 'completed', c.milestones_done, 'overdue', c.milestones_overdue))
  from c
$$;

-- Health from measurable conditions only (documented in docs/PROJECTS.md). Completed, cancelled and on-hold projects
-- report their status. Otherwise: Delayed when the target date or a milestone's due date has passed with work open;
-- At risk when the team marked it so, a high-priority task or a deliverable is overdue, three or more tasks are overdue,
-- work is blocked, or a milestone due within 7 days is past the halfway point of its schedule (from its start date, or a
-- week before its due date) with less than half of its work done; On track otherwise.
create function leadflow_private.project_health(target leadflow_private.projects, today date) returns jsonb language sql stable set search_path = '' as $$
  with t as (select * from public.follow_up_tasks x where x.workspace_id = target.workspace_id and x."projectId" = target.id and not x.cancelled and not x.completed),
  d as (select * from leadflow_private.project_deliverables x where x.project_id = target.id and x.status <> 'completed'),
  m as (select * from leadflow_private.project_milestones x where x.project_id = target.id and x.status not in ('completed','cancelled')),
  reasons as (
    select 'delayed' as level, 'target_passed' as code, 1::bigint as n, 'The target completion date has passed' as text where target.target_date < today
    union all select 'delayed', 'milestones_overdue', count(*), count(*) || ' milestone(s) past their due date' from m where m.due_date < today having count(*) > 0
    union all select 'at_risk', 'marked_at_risk', 1, 'Marked at risk by the team' where target.status = 'at_risk'
    union all select 'at_risk', 'high_priority_overdue', count(*), count(*) || ' high-priority task(s) overdue' from t where t.priority = 'high' and t.due < today having count(*) > 0
    union all select 'at_risk', 'tasks_overdue', count(*), count(*) || ' tasks overdue' from t where t.due < today having count(*) >= 3
    union all select 'at_risk', 'deliverables_overdue', count(*), count(*) || ' deliverable(s) past their due date' from d where d.due_date < today having count(*) > 0
    union all select 'at_risk', 'blocked', count(*), count(*) || ' blocked task(s) or deliverable(s)' from (select 1 from t where t.status = 'blocked' union all select 1 from d where d.status = 'blocked') b having count(*) > 0
    union all select 'at_risk', 'milestone_slipping', count(*), count(*) || ' milestone(s) due within 7 days, past the halfway point, with less than half of their work done' from m
      where m.due_date between today and today + 7
        and 2 * (today - coalesce(m.start_date, m.due_date - 7)) >= m.due_date - coalesce(m.start_date, m.due_date - 7) + 1
        and (select count(*) > 0 and 2 * count(*) filter (where w.done) < count(*) from (
        select x.completed as done from public.follow_up_tasks x where x.workspace_id = target.workspace_id and x."milestoneId" = m.id and not x.cancelled
        union all select y.status = 'completed' from leadflow_private.project_deliverables y where y.milestone_id = m.id) w)
      having count(*) > 0)
  select jsonb_build_object(
    'state', case when target.status in ('completed','cancelled','on_hold') then target.status
      when exists (select 1 from reasons where level = 'delayed') then 'delayed' when exists (select 1 from reasons where level = 'at_risk') then 'at_risk' else 'on_track' end,
    'reasons', case when target.status in ('completed','cancelled','on_hold') then '[]'::jsonb
      else coalesce((select jsonb_agg(jsonb_build_object('level', level, 'code', code, 'count', n, 'text', text) order by level desc, code) from reasons), '[]'::jsonb) end)
$$;

create function leadflow_private.project_summary_json(target leadflow_private.projects, today date) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', target.id, 'name', target.name, 'clientId', target.client_id, 'clientName', c.name, 'clientStatus', c.status, 'projectType', target.project_type,
    'status', target.status, 'priority', target.priority, 'ownerId', target.owner_id, 'ownerName', coalesce(nullif(p.display_name, ''), u.email::text),
    'startDate', target.start_date, 'targetDate', target.target_date, 'completedOn', target.completed_on, 'tags', target.tags, 'source', target.source,
    'agreedValue', target.agreed_value, 'currency', target.currency, 'version', target.version, 'createdAt', target.created_at, 'updatedAt', target.updated_at,
    'overdue', target.status not in ('completed','cancelled') and target.target_date < today,
    'progress', leadflow_private.project_progress(target, today), 'health', leadflow_private.project_health(target, today),
    'nextDeadline', (select jsonb_build_object('kind', x.kind, 'title', x.title, 'date', x.date) from (
        select 'milestone' as kind, m.name as title, m.due_date as date from leadflow_private.project_milestones m where m.project_id = target.id and m.status not in ('completed','cancelled') and m.due_date >= today
        union all select 'deliverable', d.title, d.due_date from leadflow_private.project_deliverables d where d.project_id = target.id and d.status <> 'completed' and d.due_date >= today
        union all select 'project', target.name, target.target_date where target.status not in ('completed','cancelled') and target.target_date >= today) x order by x.date, x.kind limit 1))
  from leadflow_private.clients c left join public.profiles p on p.id = target.owner_id left join auth.users u on u.id = target.owner_id where c.id = target.client_id
$$;

-- A project task's dependencies: tasks of the same project, never itself, never in a circle. Checked after every
-- snapshot save and every direct task write, for the whole workspace (only tasks with dependencies take part).
create function leadflow_private.check_task_dependencies(target_workspace uuid) returns void language plpgsql security definer set search_path = '' as $$
declare bad text;
begin
  if not exists (select 1 from public.follow_up_tasks t where t.workspace_id = target_workspace and t."dependsOn" <> '[]'::jsonb) then return; end if;
  select t.notes into bad from public.follow_up_tasks t cross join jsonb_array_elements(t."dependsOn") e(dep)
    where t.workspace_id = target_workspace and t."dependsOn" <> '[]'::jsonb
      and (jsonb_typeof(e.dep) <> 'string' or t."projectId" is null or e.dep #>> '{}' = t.id
        or not exists (select 1 from public.follow_up_tasks o where o.workspace_id = target_workspace and o.id = e.dep #>> '{}' and o."projectId" = t."projectId"))
    limit 1;
  if bad is not null then raise exception 'The task “%” can only wait for other tasks of the same project.', left(bad, 80) using errcode = '22023'; end if;
  with recursive edges as (
    select t.id as task, e.dep #>> '{}' as dep from public.follow_up_tasks t cross join jsonb_array_elements(t."dependsOn") e(dep)
    where t.workspace_id = target_workspace and t."dependsOn" <> '[]'::jsonb),
  walk(task, dep) as (select task, dep from edges union select w.task, e.dep from walk w join edges e on e.task = w.dep)
  select t.notes into bad from walk w join public.follow_up_tasks t on t.workspace_id = target_workspace and t.id = w.task where w.task = w.dep limit 1;
  if bad is not null then raise exception 'Task dependencies can''t go in a circle: “%” would end up waiting for itself.', left(bad, 80) using errcode = '22023'; end if;
end $$;

-- The same for milestones of one project.
create function leadflow_private.check_milestone_dependencies(target_project uuid) returns void language plpgsql security definer set search_path = '' as $$
declare bad text;
begin
  select m.name into bad from leadflow_private.project_milestones m cross join jsonb_array_elements(m.depends_on) e(dep)
    where m.project_id = target_project and (jsonb_typeof(e.dep) <> 'string' or e.dep #>> '{}' = m.id::text
      or not exists (select 1 from leadflow_private.project_milestones o where o.project_id = target_project and o.id::text = e.dep #>> '{}'))
    limit 1;
  if bad is not null then raise exception 'The milestone “%” can only wait for other milestones of this project.', left(bad, 80) using errcode = '22023'; end if;
  with recursive edges as (select m.id::text as node, e.dep #>> '{}' as dep from leadflow_private.project_milestones m cross join jsonb_array_elements(m.depends_on) e(dep) where m.project_id = target_project),
  walk(node, dep) as (select node, dep from edges union select w.node, e.dep from walk w join edges e on e.node = w.dep)
  select m.name into bad from walk w join leadflow_private.project_milestones m on m.id::text = w.node where w.node = w.dep limit 1;
  if bad is not null then raise exception 'Milestone dependencies can''t go in a circle: “%” would end up waiting for itself.', left(bad, 80) using errcode = '22023'; end if;
end $$;

-- Adds a reviewed plan to a project in one go: milestones, deliverables and tasks, linked by the plan's own references
-- ("ref") or by existing IDs. Used by project creation, templates and approved AI suggestions. Tasks go into the
-- follow-up tasks of the project's client; when any are added the workspace revision is bumped.
-- plan: { milestones: [{ref, name, description, startDate, dueDate, dependsOn: [refs]}],
--         deliverables: [{ref, milestoneRef | milestoneId, title, description, dueDate, priority, clientServiceId}],
--         tasks: [{ref, title, description, milestoneRef | milestoneId, deliverableRef | deliverableId, startDate, dueDate, priority, estimateHours, labels, dependsOn: [refs]}] }
create function leadflow_private.apply_plan(target leadflow_private.projects, plan jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare item jsonb; refs jsonb := '{}'; task_refs jsonb := '{}'; next_position integer; new_id uuid; task_id text; clean_name text; start_value date; due_value date; milestone_ref uuid;
  deliverable_ref uuid; added_milestones integer := 0; added_deliverables integer := 0; added_tasks integer := 0; today date := leadflow_private.project_today(target.workspace_id);
  task_priority text; deps jsonb; dep jsonb;
begin
  if plan is null or plan = 'null'::jsonb then return jsonb_build_object('milestones', 0, 'deliverables', 0, 'tasks', 0, 'workspaceChanged', false); end if;
  if jsonb_typeof(plan) <> 'object' then raise exception 'Send the plan as an object.' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(plan->'milestones', '[]')) <> 'array' or jsonb_typeof(coalesce(plan->'deliverables', '[]')) <> 'array' or jsonb_typeof(coalesce(plan->'tasks', '[]')) <> 'array' then
    raise exception 'The plan''s milestones, deliverables and tasks must be lists.' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(plan->'milestones', '[]')) > 50 or jsonb_array_length(coalesce(plan->'deliverables', '[]')) > 200 or jsonb_array_length(coalesce(plan->'tasks', '[]')) > 300 then
    raise exception 'A plan can add at most 50 milestones, 200 deliverables and 300 tasks at once.' using errcode = '54000';
  end if;
  if (select count(*) from leadflow_private.project_milestones m where m.project_id = target.id) + jsonb_array_length(coalesce(plan->'milestones', '[]')) > 100 then
    raise exception 'A project can have at most 100 milestones.' using errcode = '54000';
  end if;
  if (select count(*) from leadflow_private.project_deliverables d where d.project_id = target.id) + jsonb_array_length(coalesce(plan->'deliverables', '[]')) > 500 then
    raise exception 'A project can have at most 500 deliverables.' using errcode = '54000';
  end if;
  if (select count(*) from public.follow_up_tasks t where t.workspace_id = target.workspace_id and t."projectId" = target.id) + jsonb_array_length(coalesce(plan->'tasks', '[]')) > 1000 then
    raise exception 'A project can have at most 1,000 tasks.' using errcode = '54000';
  end if;

  select coalesce(max(m.position) + 1, 0) into next_position from leadflow_private.project_milestones m where m.project_id = target.id;
  for item in select value from jsonb_array_elements(coalesce(plan->'milestones', '[]')) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'Each milestone must be an object.' using errcode = '22023'; end if;
    clean_name := leadflow_private.onboarding_clean_text(item->>'name', 'Milestone name', 150, true);
    start_value := leadflow_private.onboarding_clean_date(item->>'startDate', 'Milestone start date');
    due_value := leadflow_private.onboarding_clean_date(item->>'dueDate', 'Milestone due date');
    if start_value > due_value then raise exception 'The milestone “%” ends before it starts.', clean_name using errcode = '22023'; end if;
    insert into leadflow_private.project_milestones(workspace_id, project_id, position, name, description, start_date, due_date)
      values (target.workspace_id, target.id, next_position, clean_name, leadflow_private.onboarding_clean_text(item->>'description', 'Milestone description', 2000, false, false), start_value, due_value)
      returning id into new_id;
    if nullif(item->>'ref', '') is not null then
      if refs ? (item->>'ref') then raise exception 'The plan uses the reference “%” twice.', item->>'ref' using errcode = '22023'; end if;
      refs := refs || jsonb_build_object(item->>'ref', new_id);
    end if;
    next_position := next_position + 1; added_milestones := added_milestones + 1;
  end loop;
  -- Milestone dependencies, by reference or ID.
  for item in select value from jsonb_array_elements(coalesce(plan->'milestones', '[]')) loop
    if jsonb_typeof(item->'dependsOn') = 'array' and jsonb_array_length(item->'dependsOn') > 0 and nullif(item->>'ref', '') is not null then
      select coalesce(jsonb_agg(to_jsonb(coalesce(refs->>(d #>> '{}'), d #>> '{}'))), '[]') into deps from jsonb_array_elements(item->'dependsOn') d;
      update leadflow_private.project_milestones m set depends_on = deps where m.id = (refs->>(item->>'ref'))::uuid;
    end if;
  end loop;
  perform leadflow_private.check_milestone_dependencies(target.id);

  select coalesce(max(d.position) + 1, 0) into next_position from leadflow_private.project_deliverables d where d.project_id = target.id;
  for item in select value from jsonb_array_elements(coalesce(plan->'deliverables', '[]')) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'Each deliverable must be an object.' using errcode = '22023'; end if;
    milestone_ref := null;
    if nullif(item->>'milestoneRef', '') is not null then
      if not refs ? (item->>'milestoneRef') then raise exception 'A deliverable refers to a milestone that isn''t in the plan.' using errcode = '22023'; end if;
      milestone_ref := (refs->>(item->>'milestoneRef'))::uuid;
    elsif nullif(item->>'milestoneId', '') is not null then
      select m.id into milestone_ref from leadflow_private.project_milestones m where m.project_id = target.id and m.id::text = item->>'milestoneId';
      if milestone_ref is null then raise exception 'Choose a milestone of this project.' using errcode = '22023'; end if;
    end if;
    if coalesce(item->>'priority', 'medium') not in ('low','medium','high','critical') then raise exception 'Choose a priority for each deliverable.' using errcode = '22023'; end if;
    if nullif(item->>'clientServiceId', '') is not null and not exists (select 1 from leadflow_private.client_services s where s.client_id = target.client_id and s.id::text = item->>'clientServiceId') then
      raise exception 'Choose one of the client''s services.' using errcode = '22023';
    end if;
    insert into leadflow_private.project_deliverables(workspace_id, project_id, milestone_id, position, title, description, due_date, priority, client_service_id, created_by)
      values (target.workspace_id, target.id, milestone_ref, next_position, leadflow_private.onboarding_clean_text(item->>'title', 'Deliverable title', 200, true),
        leadflow_private.onboarding_clean_text(item->>'description', 'Deliverable description', 4000, false, false), leadflow_private.onboarding_clean_date(item->>'dueDate', 'Deliverable due date'),
        coalesce(item->>'priority', 'medium'), nullif(item->>'clientServiceId', '')::uuid, leadflow_private.valid_actor())
      returning id into new_id;
    if nullif(item->>'ref', '') is not null then
      if refs ? (item->>'ref') then raise exception 'The plan uses the reference “%” twice.', item->>'ref' using errcode = '22023'; end if;
      refs := refs || jsonb_build_object(item->>'ref', new_id);
    end if;
    next_position := next_position + 1; added_deliverables := added_deliverables + 1;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(plan->'tasks', '[]')) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'Each task must be an object.' using errcode = '22023'; end if;
    milestone_ref := null; deliverable_ref := null;
    if nullif(item->>'milestoneRef', '') is not null then
      if not refs ? (item->>'milestoneRef') then raise exception 'A task refers to a milestone that isn''t in the plan.' using errcode = '22023'; end if;
      milestone_ref := (refs->>(item->>'milestoneRef'))::uuid;
    elsif nullif(item->>'milestoneId', '') is not null then
      select m.id into milestone_ref from leadflow_private.project_milestones m where m.project_id = target.id and m.id::text = item->>'milestoneId';
      if milestone_ref is null then raise exception 'Choose a milestone of this project.' using errcode = '22023'; end if;
    end if;
    if nullif(item->>'deliverableRef', '') is not null then
      if not refs ? (item->>'deliverableRef') then raise exception 'A task refers to a deliverable that isn''t in the plan.' using errcode = '22023'; end if;
      deliverable_ref := (refs->>(item->>'deliverableRef'))::uuid;
    elsif nullif(item->>'deliverableId', '') is not null then
      select d.id into deliverable_ref from leadflow_private.project_deliverables d where d.project_id = target.id and d.id::text = item->>'deliverableId';
      if deliverable_ref is null then raise exception 'Choose a deliverable of this project.' using errcode = '22023'; end if;
    end if;
    -- A task always has a due date: its own, else its deliverable's, milestone's or the project's, else today.
    due_value := coalesce(leadflow_private.onboarding_clean_date(item->>'dueDate', 'Task due date'),
      (select d.due_date from leadflow_private.project_deliverables d where d.id = deliverable_ref),
      (select m.due_date from leadflow_private.project_milestones m where m.id = milestone_ref), target.target_date, today);
    start_value := leadflow_private.onboarding_clean_date(item->>'startDate', 'Task start date');
    if start_value > due_value then start_value := null; end if;
    task_priority := case coalesce(item->>'priority', 'medium') when 'critical' then 'high' when 'low' then 'low' when 'high' then 'high' when 'medium' then 'medium' end;
    if task_priority is null then raise exception 'Choose a priority for each task.' using errcode = '22023'; end if;
    task_id := gen_random_uuid()::text;
    insert into public.follow_up_tasks(workspace_id, id, "leadId", due, notes, completed, "taskType", priority, cancelled, description, "createdAt", "clientId", "projectId",
        "milestoneId", "deliverableId", status, "startDate", "estimateHours", labels)
      values (target.workspace_id, task_id, null, due_value, leadflow_private.onboarding_clean_text(item->>'title', 'Task title', 2000, true), false, 'delivery', task_priority, false,
        leadflow_private.onboarding_clean_text(item->>'description', 'Task description', 2000, false, false), now(), target.client_id, target.id, milestone_ref, deliverable_ref, 'todo', start_value,
        case when jsonb_typeof(item->'estimateHours') = 'number' then least(greatest((item->>'estimateHours')::numeric, 0), 10000) end,
        leadflow_private.clean_labels(item->'labels', 'Labels', 10, 30));
    if nullif(item->>'ref', '') is not null then
      if task_refs ? (item->>'ref') then raise exception 'The plan uses the reference “%” twice.', item->>'ref' using errcode = '22023'; end if;
      task_refs := task_refs || jsonb_build_object(item->>'ref', task_id);
    end if;
    added_tasks := added_tasks + 1;
  end loop;
  -- Task dependencies, by reference (or the ID of an existing task of the project).
  for item in select value from jsonb_array_elements(coalesce(plan->'tasks', '[]')) loop
    if jsonb_typeof(item->'dependsOn') = 'array' and jsonb_array_length(item->'dependsOn') > 0 and nullif(item->>'ref', '') is not null then
      deps := '[]';
      for dep in select value from jsonb_array_elements(item->'dependsOn') loop
        if jsonb_typeof(dep) <> 'string' then raise exception 'Task dependencies must be references.' using errcode = '22023'; end if;
        deps := deps || to_jsonb(coalesce(task_refs->>(dep #>> '{}'), dep #>> '{}'));
      end loop;
      update public.follow_up_tasks t set "dependsOn" = deps where t.workspace_id = target.workspace_id and t.id = task_refs->>(item->>'ref');
    end if;
  end loop;
  if added_tasks > 0 then
    perform leadflow_private.check_task_dependencies(target.workspace_id);
    perform leadflow_private.bump_workspace_revision(target.workspace_id);
  end if;
  return jsonb_build_object('milestones', added_milestones, 'deliverables', added_deliverables, 'tasks', added_tasks, 'workspaceChanged', added_tasks > 0);
end $$;

-- A template milestone definition: name, offsets, and the deliverables and tasks it usually has.
create function leadflow_private.clean_template_milestone(raw jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare deliverables jsonb := '[]'; tasks jsonb := '[]'; item jsonb; offset_value integer; duration_value integer; task_days integer;
begin
  if raw is null or jsonb_typeof(raw) <> 'object' then raise exception 'Each template milestone must be an object.' using errcode = '22023'; end if;
  if coalesce(jsonb_typeof(raw->'startOffsetDays'), 'number') <> 'number' or coalesce(jsonb_typeof(raw->'durationDays'), 'number') <> 'number' then
    raise exception 'Milestone offsets and durations are numbers of days.' using errcode = '22023';
  end if;
  offset_value := coalesce((raw->>'startOffsetDays')::numeric, 0)::integer; duration_value := coalesce((raw->>'durationDays')::numeric, 7)::integer;
  if offset_value not between 0 and 3650 or duration_value not between 1 and 3650 then raise exception 'Milestones start 0 to 3,650 days after the project start and last 1 to 3,650 days.' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(raw->'deliverables', '[]')) <> 'array' or jsonb_array_length(coalesce(raw->'deliverables', '[]')) > 20 then raise exception 'A template milestone can list up to 20 deliverables.' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(raw->'tasks', '[]')) <> 'array' or jsonb_array_length(coalesce(raw->'tasks', '[]')) > 30 then raise exception 'A template milestone can list up to 30 tasks.' using errcode = '22023'; end if;
  for item in select value from jsonb_array_elements(coalesce(raw->'deliverables', '[]')) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'Each template deliverable must be an object.' using errcode = '22023'; end if;
    deliverables := deliverables || jsonb_build_object('title', leadflow_private.onboarding_clean_text(item->>'title', 'Deliverable title', 200, true),
      'description', leadflow_private.onboarding_clean_text(item->>'description', 'Deliverable description', 1000, false, false));
  end loop;
  for item in select value from jsonb_array_elements(coalesce(raw->'tasks', '[]')) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'Each template task must be an object.' using errcode = '22023'; end if;
    task_days := coalesce((case when jsonb_typeof(item->'durationDays') = 'number' then (item->>'durationDays')::numeric end), 3)::integer;
    if task_days not between 1 and 3650 then raise exception 'Template tasks last 1 to 3,650 days.' using errcode = '22023'; end if;
    if coalesce(item->>'priority', 'medium') not in ('low','medium','high') then raise exception 'Choose a priority for each template task.' using errcode = '22023'; end if;
    tasks := tasks || jsonb_build_object('title', leadflow_private.onboarding_clean_text(item->>'title', 'Task title', 300, true), 'durationDays', task_days, 'priority', coalesce(item->>'priority', 'medium'));
  end loop;
  return jsonb_build_object('name', leadflow_private.onboarding_clean_text(raw->>'name', 'Milestone name', 150, true),
    'description', leadflow_private.onboarding_clean_text(raw->>'description', 'Milestone description', 2000, false, false),
    'startOffsetDays', offset_value, 'durationDays', duration_value, 'deliverables', deliverables, 'tasks', tasks);
end $$;

-- The three starter templates. Agencies edit, duplicate (save a project as a template) or archive them.
create function leadflow_private.project_starter_templates() returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_array(
    jsonb_build_object('key','website','name','Website design & development','projectType','website','description','From discovery to a launched, handed-over website.','milestones', jsonb_build_array(
      jsonb_build_object('name','Discovery & requirements','startOffsetDays',0,'durationDays',7,'deliverables',jsonb_build_array(jsonb_build_object('title','Project brief')),'tasks',jsonb_build_array(jsonb_build_object('title','Hold the kickoff meeting','durationDays',1,'priority','high'),jsonb_build_object('title','Collect brand assets and access','durationDays',5),jsonb_build_object('title','Confirm the requirements','durationDays',3))),
      jsonb_build_object('name','Sitemap & information architecture','startOffsetDays',7,'durationDays',5,'deliverables',jsonb_build_array(jsonb_build_object('title','Sitemap')),'tasks',jsonb_build_array(jsonb_build_object('title','Draft the sitemap','durationDays',3),jsonb_build_object('title','Review the sitemap internally','durationDays',1))),
      jsonb_build_object('name','Wireframes','startOffsetDays',12,'durationDays',7,'deliverables',jsonb_build_array(jsonb_build_object('title','Homepage wireframe'),jsonb_build_object('title','Key page wireframes')),'tasks',jsonb_build_array(jsonb_build_object('title','Wireframe the homepage','durationDays',3),jsonb_build_object('title','Wireframe the key pages','durationDays',4))),
      jsonb_build_object('name','UI/UX design','startOffsetDays',19,'durationDays',10,'deliverables',jsonb_build_array(jsonb_build_object('title','Homepage design'),jsonb_build_object('title','Inner page designs'),jsonb_build_object('title','Mobile responsive layouts')),'tasks',jsonb_build_array(jsonb_build_object('title','Design the homepage','durationDays',4),jsonb_build_object('title','Design the inner pages','durationDays',5),jsonb_build_object('title','Design the mobile layouts','durationDays',3))),
      jsonb_build_object('name','Design review','startOffsetDays',29,'durationDays',4,'deliverables','[]'::jsonb,'tasks',jsonb_build_array(jsonb_build_object('title','Review the designs internally','durationDays',2,'priority','high'),jsonb_build_object('title','Prepare the designs for the client','durationDays',2))),
      jsonb_build_object('name','Frontend development','startOffsetDays',33,'durationDays',14,'deliverables',jsonb_build_array(jsonb_build_object('title','Frontend implementation')),'tasks',jsonb_build_array(jsonb_build_object('title','Set up the project and hosting','durationDays',2),jsonb_build_object('title','Build the page templates','durationDays',8),jsonb_build_object('title','Build the responsive components','durationDays',6))),
      jsonb_build_object('name','Backend & integrations','startOffsetDays',40,'durationDays',10,'deliverables',jsonb_build_array(jsonb_build_object('title','CMS integration')),'tasks',jsonb_build_array(jsonb_build_object('title','Set up the CMS','durationDays',4),jsonb_build_object('title','Connect forms and integrations','durationDays',4))),
      jsonb_build_object('name','QA & testing','startOffsetDays',50,'durationDays',5,'deliverables',jsonb_build_array(jsonb_build_object('title','Testing checklist')),'tasks',jsonb_build_array(jsonb_build_object('title','Test across browsers and devices','durationDays',3,'priority','high'),jsonb_build_object('title','Fix the issues found','durationDays',2))),
      jsonb_build_object('name','Deployment','startOffsetDays',55,'durationDays',3,'deliverables',jsonb_build_array(jsonb_build_object('title','Production deployment')),'tasks',jsonb_build_array(jsonb_build_object('title','Deploy to production','durationDays',1,'priority','high'),jsonb_build_object('title','Check redirects, forms and analytics','durationDays',2))),
      jsonb_build_object('name','Handover','startOffsetDays',58,'durationDays',4,'deliverables',jsonb_build_array(jsonb_build_object('title','Handover documentation')),'tasks',jsonb_build_array(jsonb_build_object('title','Train the client''s team','durationDays',1),jsonb_build_object('title','Write the handover notes','durationDays',2))))),
    jsonb_build_object('key','marketing','name','Digital marketing & SEO','projectType','marketing','description','Audit, strategy, optimization and a first round of campaigns and reporting.','milestones', jsonb_build_array(
      jsonb_build_object('name','Initial audit','startOffsetDays',0,'durationDays',7,'deliverables',jsonb_build_array(jsonb_build_object('title','Technical SEO audit')),'tasks',jsonb_build_array(jsonb_build_object('title','Crawl the site','durationDays',2),jsonb_build_object('title','Review analytics and Search Console','durationDays',3))),
      jsonb_build_object('name','Strategy & planning','startOffsetDays',7,'durationDays',5,'deliverables',jsonb_build_array(jsonb_build_object('title','Marketing strategy')),'tasks',jsonb_build_array(jsonb_build_object('title','Define goals and KPIs','durationDays',2,'priority','high'),jsonb_build_object('title','Plan the channels','durationDays',3))),
      jsonb_build_object('name','Keyword research','startOffsetDays',12,'durationDays',5,'deliverables',jsonb_build_array(jsonb_build_object('title','Keyword research report')),'tasks',jsonb_build_array(jsonb_build_object('title','Research keywords','durationDays',3),jsonb_build_object('title','Map keywords to pages','durationDays',2))),
      jsonb_build_object('name','Content planning','startOffsetDays',17,'durationDays',5,'deliverables',jsonb_build_array(jsonb_build_object('title','Content strategy')),'tasks',jsonb_build_array(jsonb_build_object('title','Plan the content calendar','durationDays',3))),
      jsonb_build_object('name','Technical SEO','startOffsetDays',22,'durationDays',10,'deliverables','[]'::jsonb,'tasks',jsonb_build_array(jsonb_build_object('title','Fix crawl and indexing issues','durationDays',5,'priority','high'),jsonb_build_object('title','Improve page speed','durationDays',5))),
      jsonb_build_object('name','On-page optimization','startOffsetDays',32,'durationDays',10,'deliverables',jsonb_build_array(jsonb_build_object('title','On-page optimization')),'tasks',jsonb_build_array(jsonb_build_object('title','Optimize titles and meta descriptions','durationDays',5),jsonb_build_object('title','Improve internal links','durationDays',4))),
      jsonb_build_object('name','Campaign execution','startOffsetDays',42,'durationDays',30,'deliverables','[]'::jsonb,'tasks',jsonb_build_array(jsonb_build_object('title','Publish the planned content','durationDays',25),jsonb_build_object('title','Run outreach for links','durationDays',25))),
      jsonb_build_object('name','Performance review','startOffsetDays',72,'durationDays',5,'deliverables',jsonb_build_array(jsonb_build_object('title','Monthly performance report')),'tasks',jsonb_build_array(jsonb_build_object('title','Compile the performance report','durationDays',3),jsonb_build_object('title','Review results with the team','durationDays',1))))),
    jsonb_build_object('key','automation','name','AI automation & custom software','projectType','automation','description','Discovery, architecture, build, integrations, testing and handover.','milestones', jsonb_build_array(
      jsonb_build_object('name','Discovery','startOffsetDays',0,'durationDays',5,'deliverables',jsonb_build_array(jsonb_build_object('title','Discovery notes')),'tasks',jsonb_build_array(jsonb_build_object('title','Map the current processes','durationDays',3,'priority','high'))),
      jsonb_build_object('name','Technical requirements','startOffsetDays',5,'durationDays',5,'deliverables',jsonb_build_array(jsonb_build_object('title','Technical requirements')),'tasks',jsonb_build_array(jsonb_build_object('title','Document the requirements','durationDays',3),jsonb_build_object('title','Confirm systems and access','durationDays',2))),
      jsonb_build_object('name','Solution architecture','startOffsetDays',10,'durationDays',5,'deliverables',jsonb_build_array(jsonb_build_object('title','Workflow architecture')),'tasks',jsonb_build_array(jsonb_build_object('title','Design the architecture','durationDays',3),jsonb_build_object('title','Review the architecture internally','durationDays',1))),
      jsonb_build_object('name','Development','startOffsetDays',15,'durationDays',15,'deliverables',jsonb_build_array(jsonb_build_object('title','Automated workflows')),'tasks',jsonb_build_array(jsonb_build_object('title','Build the workflows','durationDays',10),jsonb_build_object('title','Write automated checks','durationDays',4))),
      jsonb_build_object('name','Integrations','startOffsetDays',25,'durationDays',10,'deliverables',jsonb_build_array(jsonb_build_object('title','CRM integration')),'tasks',jsonb_build_array(jsonb_build_object('title','Connect the CRM','durationDays',5),jsonb_build_object('title','Connect the messaging channels','durationDays',4))),
      jsonb_build_object('name','Testing','startOffsetDays',35,'durationDays',5,'deliverables',jsonb_build_array(jsonb_build_object('title','Testing report')),'tasks',jsonb_build_array(jsonb_build_object('title','Test end to end','durationDays',3,'priority','high'),jsonb_build_object('title','Fix the issues found','durationDays',2))),
      jsonb_build_object('name','User acceptance testing','startOffsetDays',40,'durationDays',5,'deliverables','[]'::jsonb,'tasks',jsonb_build_array(jsonb_build_object('title','Prepare the UAT scenarios','durationDays',2),jsonb_build_object('title','Run UAT with the client''s team','durationDays',3))),
      jsonb_build_object('name','Deployment','startOffsetDays',45,'durationDays',3,'deliverables',jsonb_build_array(jsonb_build_object('title','Production deployment')),'tasks',jsonb_build_array(jsonb_build_object('title','Deploy','durationDays',1,'priority','high'),jsonb_build_object('title','Monitor the first runs','durationDays',2))),
      jsonb_build_object('name','Documentation & handover','startOffsetDays',48,'durationDays',5,'deliverables',jsonb_build_array(jsonb_build_object('title','Deployment documentation')),'tasks',jsonb_build_array(jsonb_build_object('title','Write the documentation','durationDays',3),jsonb_build_object('title','Hand over to the client','durationDays',1))))))
$$;

-- Installs the starter templates the first time a workspace looks at templates. A workspace that already has templates
-- (even archived ones) never gets them again.
create function leadflow_private.ensure_project_templates(target_workspace uuid) returns void language plpgsql security definer set search_path = '' as $$
declare starter jsonb; created uuid; milestone jsonb; position_value integer;
begin
  if exists (select 1 from leadflow_private.project_templates t where t.workspace_id = target_workspace) then return; end if;
  for starter in select value from jsonb_array_elements(leadflow_private.project_starter_templates()) loop
    created := null;
    insert into leadflow_private.project_templates(workspace_id, name, description, project_type, starter_key)
      values (target_workspace, starter->>'name', starter->>'description', starter->>'projectType', starter->>'key') on conflict do nothing returning id into created;
    if created is null then continue; end if;
    position_value := 0;
    for milestone in select leadflow_private.clean_template_milestone(value) from jsonb_array_elements(starter->'milestones') loop
      insert into leadflow_private.project_template_milestones(workspace_id, template_id, position, name, description, start_offset_days, duration_days, deliverables, tasks)
        values (target_workspace, created, position_value, milestone->>'name', milestone->>'description', (milestone->>'startOffsetDays')::integer, (milestone->>'durationDays')::integer,
          milestone->'deliverables', milestone->'tasks');
      position_value := position_value + 1;
    end loop;
  end loop;
end $$;

create function leadflow_private.milestone_json(m leadflow_private.project_milestones, today date) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'position', m.position, 'name', m.name, 'description', m.description, 'startDate', m.start_date, 'dueDate', m.due_date, 'status', m.status,
    'completedAt', m.completed_at, 'notes', m.notes, 'dependsOn', m.depends_on, 'version', m.version, 'createdAt', m.created_at, 'updatedAt', m.updated_at,
    'overdue', m.status not in ('completed','cancelled') and m.due_date < today,
    'tasks', (select jsonb_build_object('total', count(*), 'completed', count(*) filter (where t.completed)) from public.follow_up_tasks t
      where t.workspace_id = m.workspace_id and t."milestoneId" = m.id and not t.cancelled),
    'deliverables', (select jsonb_build_object('total', count(*), 'completed', count(*) filter (where d.status = 'completed')) from leadflow_private.project_deliverables d where d.milestone_id = m.id))
$$;

create function leadflow_private.deliverable_json(d leadflow_private.project_deliverables, today date) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'position', d.position, 'milestoneId', d.milestone_id, 'title', d.title, 'description', d.description, 'ownerId', d.owner_id,
    'ownerName', (select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = d.owner_id),
    'dueDate', d.due_date, 'priority', d.priority, 'status', d.status, 'notes', d.notes, 'clientServiceId', d.client_service_id,
    'serviceName', (select s.name from leadflow_private.client_services s where s.id = d.client_service_id), 'completedAt', d.completed_at, 'version', d.version,
    'createdAt', d.created_at, 'updatedAt', d.updated_at, 'overdue', d.status <> 'completed' and d.due_date < today,
    'tasks', (select jsonb_build_object('total', count(*), 'completed', count(*) filter (where t.completed)) from public.follow_up_tasks t
      where t.workspace_id = d.workspace_id and t."deliverableId" = d.id and not t.cancelled),
    'files', (select count(*) from leadflow_private.client_documents f where f.deliverable_id = d.id and f.status = 'available'))
$$;

-- ---------- Project setup and creation ----------

-- A starting brief from confirmed services and requirements only. A person reviews and edits it before the project is
-- created; nothing here becomes a commitment on its own.
create function leadflow_private.compose_brief(services jsonb, requirements jsonb, outstanding text, note text) returns jsonb language sql immutable set search_path = '' as $$
  with r as (select x as item, x->>'category' as category from jsonb_array_elements(coalesce(requirements, '[]')) x),
  bullet as (select r.category, '• ' || (r.item->>'title') || coalesce(': ' || nullif(r.item->>'description', ''), '') as line from r),
  lines as (select category, string_agg(line, E'\n') as text from bullet group by category)
  select jsonb_strip_nulls(jsonb_build_object(
    'objectives', left((select string_agg(text, E'\n') from lines where category in ('objective','goal')), 4000),
    'scopeSummary', left(nullif(concat_ws(E'\n\n',
      (select string_agg('• ' || (s->>'name') || coalesce(': ' || nullif(s->>'agreedScope', ''), '') || coalesce(E'\n  Deliverables: ' || nullif(s->>'deliverables', ''), ''), E'\n')
        from jsonb_array_elements(coalesce(services, '[]')) s),
      (select 'Requirements:' || E'\n' || string_agg(text, E'\n') from lines where category in ('functional','technical','design','integration'))), ''), 8000),
    'successCriteria', left((select text from lines where category = 'success_criteria'), 4000),
    'expectations', left((select text from lines where category = 'expectation'), 4000),
    'dependencies', left((select text from lines where category = 'dependency'), 4000),
    'constraints', left((select text from lines where category = 'constraint'), 4000),
    'assumptions', left((select text from lines where category = 'assumption'), 4000),
    'exclusions', left((select string_agg('• ' || (s->>'name') || ': ' || (s->>'exclusions'), E'\n') from jsonb_array_elements(coalesce(services, '[]')) s where coalesce(s->>'exclusions', '') <> ''), 4000),
    'notes', left(nullif(concat_ws(E'\n\n', nullif(note, ''), 'Open questions: ' || nullif(outstanding, '')), ''), 4000)))
$$;

-- Any member. What a new project for this client would start from: the onboarding completion snapshot when onboarding
-- was completed (what was agreed then), otherwise the client's currently confirmed services and requirements.
-- Unconfirmed requirements and proposed services are never included.
create function public.project_setup_for(target_workspace uuid, target_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; completion leadflow_private.client_onboarding_completions; services jsonb; requirements jsonb; outstanding text; note_text text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into found_client from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace;
  if not found then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  select * into completion from leadflow_private.client_onboarding_completions c where c.client_id = target_client;
  if completion.id is not null then
    services := coalesce(completion.snapshot->'services', '[]'); requirements := coalesce(completion.snapshot->'requirements', '[]');
    outstanding := completion.snapshot->'scope'->>'outstandingQuestions'; note_text := completion.note;
  else
    services := coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'description', s.description, 'agreedScope', s.agreed_scope, 'deliverables', s.deliverables,
      'exclusions', s.exclusions, 'notes', s.notes) order by s.position, s.created_at) from leadflow_private.client_services s where s.client_id = target_client and s.status = 'confirmed'), '[]');
    requirements := coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'description', r.description, 'category', r.category, 'priority', r.priority,
      'service', (select s.name from leadflow_private.client_services s where s.id = r.client_service_id)) order by r.created_at)
      from leadflow_private.client_requirements r where r.client_id = target_client and r.status = 'confirmed'), '[]');
    outstanding := (select s.outstanding_questions from leadflow_private.client_scope_confirmations s where s.client_id = target_client and s.superseded_at is null);
  end if;
  return jsonb_build_object(
    'today', leadflow_private.project_today(target_workspace),
    'client', jsonb_build_object('id', found_client.id, 'name', found_client.name, 'status', found_client.status, 'website', found_client.website, 'industry', found_client.industry, 'ownerId', found_client.owner_id),
    'source', case when completion.id is not null then 'onboarding' else 'client' end,
    'completion', case when completion.id is null then null else jsonb_build_object('id', completion.id, 'completedAt', completion.completed_at, 'note', completion.note, 'overrideReason', completion.override_reason) end,
    'deal', (select jsonb_build_object('id', d.id, 'title', d.title, 'value', d.value, 'wonValue', d.won_value, 'currency', d.currency) from leadflow_private.deals d where d.id = found_client.deal_id),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', cc.id, 'fullName', cc.full_name, 'role', cc.role, 'email', cc.email, 'isPrimary', cc.is_primary) order by cc.is_primary desc, cc.created_at)
      from leadflow_private.client_contacts cc where cc.client_id = target_client), '[]'),
    -- Services as agreed; "current" says whether each is still a confirmed service of the client (only those can be linked).
    'services', coalesce((select jsonb_agg(s || jsonb_build_object('current', exists (select 1 from leadflow_private.client_services x where x.client_id = target_client and x.id::text = s->>'id' and x.status = 'confirmed')))
      from jsonb_array_elements(services) s), '[]'),
    'requirements', requirements,
    'outstandingQuestions', coalesce(outstanding, ''),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'fileName', d.file_name, 'category', d.category, 'size', d.size_bytes, 'uploaderType', d.uploader_type) order by d.created_at)
      from leadflow_private.client_documents d where d.status = 'available' and d.project_id is null
        and (d.client_id = target_client or d.request_id in (select r.id from leadflow_private.onboarding_requests r where r.client_id = target_client))), '[]'),
    'dates', coalesce((select jsonb_agg(x order by x->>'date') from (
        select jsonb_build_object('label', e->>'label', 'date', e->>'date') as x from jsonb_array_elements(found_client.important_dates) e
        union all select jsonb_build_object('label', 'Target kickoff: ' || r.title, 'date', r.target_kickoff_date) from leadflow_private.onboarding_requests r where r.client_id = target_client and r.target_kickoff_date is not null) y), '[]'),
    'brief', leadflow_private.compose_brief(services, requirements, outstanding, note_text),
    'existingProjects', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status) order by p.created_at) from leadflow_private.projects p where p.client_id = target_client), '[]'),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', coalesce(nullif(p.display_name, ''), u.email::text, 'Member')) order by coalesce(nullif(p.display_name, ''), u.email::text))
      from public.workspace_memberships m left join public.profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id where m.workspace_id = target_workspace), '[]'));
end $$;

-- Any member. Creates a project for a client, optionally with a reviewed plan (milestones, deliverables, tasks), in one
-- transaction. Repeating the request ID returns the same project. details: project fields plus { clientId, source,
-- completionId, templateId, briefSources, plan }.
create function public.create_project(target_workspace uuid, details jsonb, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing leadflow_private.projects; found_client leadflow_private.clients; clean jsonb; created leadflow_private.projects; template_row leadflow_private.project_templates;
  completion_ref uuid; source_value text; applied jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if request_id is null or details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the project details as an object.' using errcode = '22023'; end if;
  select * into existing from leadflow_private.projects p where p.workspace_id = target_workspace and p.request_id = create_project.request_id;
  if found then return jsonb_build_object('id', existing.id, 'existing', true, 'tasks', 0, 'workspaceChanged', false); end if;
  if (select count(*) from leadflow_private.projects p where p.workspace_id = target_workspace) >= 2000 then raise exception 'A workspace can have at most 2,000 projects.' using errcode = '54000'; end if;
  select * into found_client from leadflow_private.clients c where c.workspace_id = target_workspace and c.id::text = details->>'clientId' for update;
  if not found then raise exception 'Choose a client of this workspace.' using errcode = '22023'; end if;
  if found_client.status = 'archived' then raise exception 'Unarchive this client before starting a project.' using errcode = '55000'; end if;
  clean := leadflow_private.clean_project_details(details - 'clientId' - 'source' - 'completionId' - 'templateId' - 'briefSources' - 'plan');
  if clean->>'name' is null then raise exception 'Project name is required.' using errcode = '22023'; end if;
  if (clean->>'startDate')::date > (clean->>'targetDate')::date then raise exception 'The target completion date is before the start date.' using errcode = '22023'; end if;
  source_value := coalesce(nullif(details->>'source', ''), 'manual');
  if source_value not in ('onboarding','client','manual') then raise exception 'Unknown project source.' using errcode = '22023'; end if;
  if nullif(details->>'completionId', '') is not null then
    select c.id into completion_ref from leadflow_private.client_onboarding_completions c where c.client_id = found_client.id and c.id::text = details->>'completionId';
    if completion_ref is null then raise exception 'That onboarding completion isn''t this client''s.' using errcode = '22023'; end if;
  end if;
  if source_value = 'onboarding' and completion_ref is null then raise exception 'Complete the client''s onboarding before creating a project from it.' using errcode = '55000'; end if;
  if nullif(details->>'templateId', '') is not null then
    select * into template_row from leadflow_private.project_templates t where t.workspace_id = target_workspace and t.id::text = details->>'templateId';
    if not found then raise exception 'Template not found in this workspace.' using errcode = '22023'; end if;
  end if;
  insert into leadflow_private.projects(workspace_id, client_id, request_id, name, description, project_type, priority, owner_id, start_date, target_date, agreed_value, estimated_cost, actual_cost,
      currency, tags, brief, brief_sources, internal_notes, source, completion_id, deal_id, template_id, template_name, created_by)
    values (target_workspace, found_client.id, create_project.request_id, clean->>'name', coalesce(clean->>'description', ''), coalesce(clean->>'projectType', 'other'), coalesce(clean->>'priority', 'medium'),
      coalesce(leadflow_private.client_owner_ref(target_workspace, clean->>'ownerId'), found_client.owner_id, leadflow_private.valid_actor()),
      (clean->>'startDate')::date, (clean->>'targetDate')::date, (clean->>'agreedValue')::numeric, (clean->>'estimatedCost')::numeric, (clean->>'actualCost')::numeric,
      coalesce(clean->>'currency', (select d.currency from leadflow_private.deals d where d.id = found_client.deal_id), 'USD'), coalesce(clean->'tags', '[]'), coalesce(clean->'brief', '{}'),
      case when jsonb_typeof(details->'briefSources') = 'object' and octet_length((details->'briefSources')::text) <= 40000 then details->'briefSources' else '{}'::jsonb end,
      coalesce(clean->>'internalNotes', ''), source_value, completion_ref, found_client.deal_id, template_row.id, template_row.name, leadflow_private.valid_actor())
    returning * into created;
  perform leadflow_private.set_project_links(created, clean->'serviceIds', clean->'contactIds');
  perform leadflow_private.project_event(created, 'project_created', 'Project created: ' || created.name || case source_value when 'onboarding' then ' (from the completed onboarding)' else '' end,
    jsonb_strip_nulls(jsonb_build_object('source', source_value, 'templateName', template_row.name, 'completionId', completion_ref)));
  applied := leadflow_private.apply_plan(created, details->'plan');
  if (applied->>'milestones')::integer + (applied->>'deliverables')::integer + (applied->>'tasks')::integer > 0 then
    perform leadflow_private.project_event(created, 'plan_applied', 'Planned ' || (applied->>'milestones') || ' milestone(s), ' || (applied->>'deliverables') || ' deliverable(s) and ' || (applied->>'tasks') || ' task(s)'
      || coalesce(' from “' || template_row.name || '”', ''), applied);
  end if;
  return jsonb_build_object('id', created.id, 'existing', false, 'tasks', (applied->>'tasks')::integer, 'workspaceChanged', (applied->>'workspaceChanged')::boolean);
end $$;

-- Any member. Adds a reviewed plan (from a template or approved AI suggestions) to an existing project. Idempotent per request ID.
create function public.apply_project_plan(target_workspace uuid, target_project uuid, plan jsonb, origin text, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_project leadflow_private.projects; applied jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if request_id is null then raise exception 'Missing request identity.' using errcode = '22023'; end if;
  found_project := leadflow_private.lock_project(target_workspace, target_project, null);
  if exists (select 1 from leadflow_private.client_activities a where a.workspace_id = target_workspace and a.request_id = apply_project_plan.request_id) then
    return jsonb_build_object('repeated', true, 'milestones', 0, 'deliverables', 0, 'tasks', 0, 'workspaceChanged', false);
  end if;
  if coalesce(origin, '') not in ('template','assistant','breakdown') then raise exception 'Unknown plan origin.' using errcode = '22023'; end if;
  applied := leadflow_private.apply_plan(found_project, plan);
  perform leadflow_private.project_event(found_project, 'plan_applied',
    'Added ' || (applied->>'milestones') || ' milestone(s), ' || (applied->>'deliverables') || ' deliverable(s) and ' || (applied->>'tasks') || ' task(s)'
      || case origin when 'assistant' then ' suggested by the AI assistant and approved' when 'breakdown' then ' from an approved task breakdown' else ' from a template' end,
    applied || jsonb_build_object('origin', origin), 'project', found_project.id::text, apply_project_plan.request_id);
  return applied || jsonb_build_object('repeated', false);
end $$;

-- Any member. Changes project fields, links and the brief.
create function public.update_project(target_workspace uuid, target_project uuid, expected_version integer, changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare previous leadflow_private.projects; result leadflow_private.projects; clean jsonb; changed text[]; today date := leadflow_private.project_today(target_workspace);
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  previous := leadflow_private.lock_project(target_workspace, target_project, expected_version);
  clean := leadflow_private.clean_project_details(changes);
  if coalesce(case when clean ? 'startDate' then (clean->>'startDate')::date else previous.start_date end, '-infinity'::date)
     > coalesce(case when clean ? 'targetDate' then (clean->>'targetDate')::date else previous.target_date end, 'infinity'::date) then
    raise exception 'The target completion date is before the start date.' using errcode = '22023';
  end if;
  update leadflow_private.projects p set name = coalesce(clean->>'name', p.name), description = coalesce(clean->>'description', p.description),
    project_type = coalesce(clean->>'projectType', p.project_type), priority = coalesce(clean->>'priority', p.priority),
    owner_id = case when clean ? 'ownerId' then leadflow_private.client_owner_ref(target_workspace, clean->>'ownerId') else p.owner_id end,
    start_date = case when clean ? 'startDate' then (clean->>'startDate')::date else p.start_date end,
    target_date = case when clean ? 'targetDate' then (clean->>'targetDate')::date else p.target_date end,
    agreed_value = case when clean ? 'agreedValue' then (clean->>'agreedValue')::numeric else p.agreed_value end,
    estimated_cost = case when clean ? 'estimatedCost' then (clean->>'estimatedCost')::numeric else p.estimated_cost end,
    actual_cost = case when clean ? 'actualCost' then (clean->>'actualCost')::numeric else p.actual_cost end,
    currency = coalesce(clean->>'currency', p.currency), tags = coalesce(clean->'tags', p.tags), brief = coalesce(clean->'brief', p.brief),
    internal_notes = coalesce(clean->>'internalNotes', p.internal_notes), version = p.version + 1
    where p.id = target_project returning * into result;
  perform leadflow_private.set_project_links(result, clean->'serviceIds', clean->'contactIds');
  select array_agg(f) into changed from (values ('name', result.name is distinct from previous.name), ('description', result.description is distinct from previous.description),
      ('type', result.project_type is distinct from previous.project_type), ('priority', result.priority is distinct from previous.priority),
      ('start date', result.start_date is distinct from previous.start_date), ('budget', (result.agreed_value, result.estimated_cost, result.actual_cost, result.currency) is distinct from (previous.agreed_value, previous.estimated_cost, previous.actual_cost, previous.currency)),
      ('tags', result.tags is distinct from previous.tags), ('brief', result.brief is distinct from previous.brief), ('internal notes', result.internal_notes is distinct from previous.internal_notes),
      ('services', clean ? 'serviceIds'), ('contacts', clean ? 'contactIds')) as x(f, differs) where differs;
  if cardinality(changed) > 0 then
    perform leadflow_private.project_event(result, 'project_updated', 'Updated ' || array_to_string(changed, ', '), jsonb_build_object('fields', to_jsonb(changed)));
  end if;
  if result.target_date is distinct from previous.target_date then
    perform leadflow_private.project_event(result, 'deadline_changed', 'Target completion date ' || coalesce('changed from ' || previous.target_date || ' to ' || result.target_date, 'set to ' || result.target_date, 'removed'),
      jsonb_build_object('from', previous.target_date, 'to', result.target_date));
  end if;
  if result.owner_id is distinct from previous.owner_id then
    perform leadflow_private.project_event(result, 'owner_changed', 'Project owner changed', jsonb_build_object('from', previous.owner_id, 'to', result.owner_id));
  end if;
  return leadflow_private.project_summary_json(result, today);
end $$;

-- Any member. Statuses are set by people; completing with open work, and cancelling, need a reason that is kept.
create function public.set_project_status(target_workspace uuid, target_project uuid, next_status text, expected_version integer, reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_project leadflow_private.projects; result leadflow_private.projects; clean text; open_work integer; today date := leadflow_private.project_today(target_workspace); event_kind text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_project := leadflow_private.lock_project(target_workspace, target_project, expected_version);
  if next_status not in ('planning','not_started','in_progress','on_hold','at_risk','completed','cancelled') then raise exception 'Choose a project status.' using errcode = '22023'; end if;
  clean := leadflow_private.onboarding_clean_text(reason, 'Reason', 1000, false, false);
  if next_status = found_project.status then return leadflow_private.project_summary_json(found_project, today); end if;
  select (select count(*) from public.follow_up_tasks t where t.workspace_id = target_workspace and t."projectId" = target_project and not t.completed and not t.cancelled)
    + (select count(*) from leadflow_private.project_deliverables d where d.project_id = target_project and d.status <> 'completed')
    + (select count(*) from leadflow_private.project_milestones m where m.project_id = target_project and m.status not in ('completed','cancelled')) into open_work;
  if next_status = 'completed' and open_work > 0 and clean = '' then
    raise exception '% task(s), deliverable(s) or milestone(s) are still open. Finish them, or give a reason to complete the project anyway.', open_work using errcode = '55000';
  end if;
  if next_status = 'cancelled' and clean = '' then raise exception 'Give a reason for cancelling the project.' using errcode = '22023'; end if;
  update leadflow_private.projects p set status = next_status, completed_on = case when next_status = 'completed' then today end, status_reason = clean, status_changed_at = now(), version = p.version + 1
    where p.id = target_project returning * into result;
  event_kind := case when next_status = 'completed' then 'project_completed' when next_status = 'cancelled' then 'project_cancelled' when next_status = 'on_hold' then 'project_paused'
    when found_project.status = 'on_hold' then 'project_resumed' when found_project.status in ('completed','cancelled') then 'project_reopened' else 'status_changed' end;
  perform leadflow_private.project_event(result, event_kind, 'Status changed from ' || replace(found_project.status, '_', ' ') || ' to ' || replace(next_status, '_', ' ') || coalesce(': ' || nullif(clean, ''), ''),
    jsonb_strip_nulls(jsonb_build_object('from', found_project.status, 'to', next_status, 'reason', nullif(clean, ''), 'openWork', case when next_status = 'completed' then open_work end)));
  return leadflow_private.project_summary_json(result, today);
end $$;

-- Any member. Internal notes: agency-only, append-only, never part of anything the client sees.
create function public.add_project_note(target_workspace uuid, target_project uuid, note text, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_project leadflow_private.projects; clean text; existing bigint;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  select * into found_project from leadflow_private.projects p where p.id = target_project and p.workspace_id = target_workspace;
  if not found then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  if request_id is not null then
    select a.id into existing from leadflow_private.client_activities a where a.workspace_id = target_workspace and a.request_id = add_project_note.request_id;
    if existing is not null then return jsonb_build_object('id', existing, 'repeated', true); end if;
  end if;
  clean := leadflow_private.onboarding_clean_text(note, 'Note', 4000, true, false);
  insert into leadflow_private.client_activities(workspace_id, client_id, project_id, kind, summary, detail, actor_type, actor_id, entity_type, entity_id, request_id)
    values (target_workspace, found_project.client_id, found_project.id, 'note', 'Internal note on ' || left(found_project.name, 150), jsonb_build_object('text', clean), 'member',
      leadflow_private.valid_actor(), 'project', found_project.id::text, request_id)
    returning id into existing;
  return jsonb_build_object('id', existing, 'repeated', false);
end $$;

-- ---------- Reading projects ----------

-- Every project's name, client and status, for task labels and pickers.
create function public.project_index_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'clientId', p.client_id, 'status', p.status) order by lower(p.name))
    from (select * from leadflow_private.projects p where p.workspace_id = target_workspace order by p.updated_at desc limit 2000) p), '[]'::jsonb);
end $$;

-- filters: { search, status ('open' = not completed or cancelled, the default; 'all'; or one status), health, clientId, ownerId,
-- priority, projectType, sort: updated|name|target|created, direction, limit, offset }.
create function public.projects_for(target_workspace uuid, filters jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare page_limit integer := least(greatest(coalesce((filters->>'limit')::integer, 25), 1), 100); page_offset integer := greatest(coalesce((filters->>'offset')::integer, 0), 0);
  search text := lower(btrim(coalesce(filters->>'search', ''))); sort_key text := coalesce(filters->>'sort', 'updated'); descending boolean := coalesce(filters->>'direction', 'desc') <> 'asc';
  wanted_status text := coalesce(nullif(filters->>'status', ''), 'open'); today date := leadflow_private.project_today(target_workspace);
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return (with matching as (
    select p.id from leadflow_private.projects p join leadflow_private.clients c on c.id = p.client_id
    where p.workspace_id = target_workspace
      and (wanted_status = 'all' or (wanted_status = 'open' and p.status not in ('completed','cancelled')) or p.status = wanted_status)
      and (nullif(filters->>'clientId', '') is null or p.client_id::text = filters->>'clientId')
      and (nullif(filters->>'ownerId', '') is null or p.owner_id::text = filters->>'ownerId')
      and (nullif(filters->>'priority', '') is null or p.priority = filters->>'priority')
      and (nullif(filters->>'projectType', '') is null or p.project_type = filters->>'projectType')
      and (search = '' or position(search in lower(p.name || ' ' || c.name || ' ' || p.description || ' ' || p.tags::text)) > 0)
  ), scored as (select pr.id, leadflow_private.project_health(pr, today)->>'state' as health, pr.name, pr.target_date, pr.created_at, pr.updated_at
      from matching m join leadflow_private.projects pr on pr.id = m.id),
  filtered as (select * from scored s where nullif(filters->>'health', '') is null or s.health = filters->>'health'),
  ordered as (select f.id, row_number() over (order by
      case when descending then case sort_key when 'name' then lower(f.name) end end desc, case when not descending then case sort_key when 'name' then lower(f.name) end end asc,
      case when descending then case sort_key when 'target' then f.target_date end end desc nulls last, case when not descending then case sort_key when 'target' then f.target_date end end asc nulls last,
      case when descending then case sort_key when 'created' then f.created_at when 'updated' then f.updated_at end end desc,
      case when not descending then case sort_key when 'created' then f.created_at when 'updated' then f.updated_at end end asc, f.id) as ord from filtered f),
  page as (select o.id, o.ord from ordered o order by o.ord limit page_limit offset page_offset)
  select jsonb_build_object('items', coalesce((select jsonb_agg(leadflow_private.project_summary_json(p, today) order by pg.ord) from page pg join leadflow_private.projects p on p.id = pg.id), '[]'::jsonb),
    'total', (select count(*) from filtered), 'limit', page_limit, 'offset', page_offset, 'today', today));
end $$;

create function public.project_detail(target_workspace uuid, target_project uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text; found_project leadflow_private.projects; today date := leadflow_private.project_today(target_workspace);
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into found_project from leadflow_private.projects p where p.id = target_project and p.workspace_id = target_workspace;
  if not found then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  return leadflow_private.project_summary_json(found_project, today) || jsonb_build_object(
    'today', today, 'canManageTemplates', actor_role <> 'member',
    'description', found_project.description, 'brief', found_project.brief, 'briefSources', found_project.brief_sources, 'internalNotes', found_project.internal_notes,
    'estimatedCost', found_project.estimated_cost, 'actualCost', found_project.actual_cost, 'statusReason', found_project.status_reason, 'statusChangedAt', found_project.status_changed_at,
    'template', case when found_project.template_name is null then null else jsonb_build_object('id', found_project.template_id, 'name', found_project.template_name) end,
    'completion', (select jsonb_build_object('id', c.id, 'completedAt', c.completed_at) from leadflow_private.client_onboarding_completions c where c.id = found_project.completion_id),
    'deal', (select jsonb_build_object('id', d.id, 'title', d.title, 'value', d.value, 'wonValue', d.won_value, 'currency', d.currency, 'outcome', d.outcome) from leadflow_private.deals d where d.id = found_project.deal_id),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', cc.id, 'fullName', cc.full_name, 'role', cc.role, 'email', cc.email, 'phone', cc.phone, 'isPrimary', cc.is_primary,
        'linked', exists (select 1 from leadflow_private.project_contacts x where x.project_id = target_project and x.contact_id = cc.id)) order by cc.is_primary desc, cc.created_at)
      from leadflow_private.client_contacts cc where cc.client_id = found_project.client_id), '[]'),
    'services', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'status', s.status, 'agreedScope', s.agreed_scope, 'deliverables', s.deliverables,
        'linked', exists (select 1 from leadflow_private.project_services x where x.project_id = target_project and x.client_service_id = s.id)) order by s.position, s.created_at)
      from leadflow_private.client_services s where s.client_id = found_project.client_id and (s.status = 'confirmed'
        or exists (select 1 from leadflow_private.project_services x where x.project_id = target_project and x.client_service_id = s.id))), '[]'),
    'milestones', coalesce((select jsonb_agg(leadflow_private.milestone_json(m, today) order by m.position, m.created_at) from leadflow_private.project_milestones m where m.project_id = target_project), '[]'),
    'deliverables', coalesce((select jsonb_agg(leadflow_private.deliverable_json(d, today) order by d.position, d.created_at) from leadflow_private.project_deliverables d where d.project_id = target_project), '[]'),
    'documentCount', (select count(*) from leadflow_private.client_documents d where d.project_id = target_project and d.status = 'available'),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', coalesce(nullif(p.display_name, ''), u.email::text, 'Member')) order by coalesce(nullif(p.display_name, ''), u.email::text))
      from public.workspace_memberships m left join public.profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id where m.workspace_id = target_workspace), '[]'));
end $$;

-- The delivery overview. Every figure is counted from this workspace's projects, milestones, deliverables and tasks.
create function public.projects_dashboard_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare today date := leadflow_private.project_today(target_workspace);
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return (with p as (select x.*, leadflow_private.project_health(x, today)->>'state' as health from leadflow_private.projects x where x.workspace_id = target_workspace),
  deadlines as (
    select 'project' as kind, p.id as id, p.name as title, p.target_date as date, p.id as project_id, p.name as project_name from p where p.status not in ('completed','cancelled') and p.target_date between today and today + 14
    union all select 'milestone', m.id, m.name, m.due_date, p.id, p.name from leadflow_private.project_milestones m join p on p.id = m.project_id
      where p.status not in ('completed','cancelled') and m.status not in ('completed','cancelled') and m.due_date between today and today + 14
    union all select 'deliverable', d.id, d.title, d.due_date, p.id, p.name from leadflow_private.project_deliverables d join p on p.id = d.project_id
      where p.status not in ('completed','cancelled') and d.status <> 'completed' and d.due_date between today and today + 14)
  select jsonb_build_object('today', today,
    'total', (select count(*) from p),
    'byStatus', coalesce((select jsonb_object_agg(status, n) from (select p.status, count(*) as n from p group by p.status) x), '{}'::jsonb),
    'active', (select count(*) from p where p.status in ('not_started','in_progress','at_risk')),
    'planning', (select count(*) from p where p.status = 'planning'),
    'onHold', (select count(*) from p where p.status = 'on_hold'),
    'completed', (select count(*) from p where p.status = 'completed'),
    'atRisk', (select count(*) from p where p.health = 'at_risk'),
    'delayed', (select count(*) from p where p.health = 'delayed'),
    'onTrack', (select count(*) from p where p.health = 'on_track'),
    'overdue', (select count(*) from p where p.status not in ('completed','cancelled') and p.target_date < today),
    'overdueTasks', (select count(*) from public.follow_up_tasks t join p on p.id = t."projectId" where t.workspace_id = target_workspace and not t.completed and not t.cancelled and t.due < today
      and p.status not in ('completed','cancelled')),
    'upcoming', coalesce((select jsonb_agg(jsonb_build_object('kind', d.kind, 'id', d.id, 'title', d.title, 'date', d.date, 'projectId', d.project_id, 'projectName', d.project_name) order by d.date, d.kind)
      from (select * from deadlines order by date, kind limit 25) d), '[]'::jsonb),
    'attention', coalesce((select jsonb_agg(jsonb_build_object('projectId', pr.id, 'name', pr.name, 'health', y.health, 'reasons', leadflow_private.project_health(pr, today)->'reasons') order by pr.name)
      from (select p.id, p.health from p where p.health in ('at_risk','delayed') order by p.name limit 20) y join leadflow_private.projects pr on pr.id = y.id), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'summary', a.summary, 'at', a.at, 'projectId', a.project_id, 'projectName', pr.name,
        'actorName', case a.actor_type when 'member' then coalesce(nullif(pf.display_name, ''), u.email::text) when 'client' then 'Client' else 'LeadFlow' end) order by a.at desc, a.id desc)
      from (select * from leadflow_private.client_activities a where a.workspace_id = target_workspace and a.project_id is not null and a.kind <> 'note' order by a.at desc, a.id desc limit 15) a
      join leadflow_private.projects pr on pr.id = a.project_id left join public.profiles pf on pf.id = a.actor_id left join auth.users u on u.id = a.actor_id), '[]'::jsonb)));
end $$;

-- A project's history, newest first: its events and notes, its tasks (planned, completed, cancelled) and its files
-- (uploaded, removed). groups: project, planning, tasks, files, notes. (before_at, before_id) pages back.
create function public.project_timeline(target_workspace uuid, target_project uuid, groups jsonb, before_at timestamptz, before_id text, page_size integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare wanted text[]; page_rows integer := least(greatest(coalesce(page_size, 50), 1), 200);
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.projects p where p.id = target_project and p.workspace_id = target_workspace) then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  select coalesce(array_agg(value), '{project,planning,tasks,files,notes}') into wanted
    from jsonb_array_elements_text(case when jsonb_typeof(groups) = 'array' and jsonb_array_length(groups) > 0 then groups else '[]'::jsonb end);
  return (with events as (
    select 'activity:' || a.id as id, case when a.kind = 'note' then 'notes' when a.kind like 'milestone%' or a.kind like 'deliverable%' or a.kind = 'plan_applied' then 'planning' else 'project' end as grp,
      a.kind, a.summary, a.detail, a.at, a.actor_type, a.actor_id, a.entity_type, a.entity_id
    from leadflow_private.client_activities a where a.project_id = target_project
    union all
    select 'task-created:' || t.id, 'tasks', 'task_created', 'Task planned: ' || t.notes, jsonb_build_object('due', t.due, 'taskId', t.id), t."createdAt", 'member', null::uuid, 'task', t.id
    from public.follow_up_tasks t where t.workspace_id = target_workspace and t."projectId" = target_project and t."createdAt" is not null
    union all
    select 'task-done:' || t.id, 'tasks', case when t.cancelled then 'task_cancelled' else 'task_completed' end, case when t.cancelled then 'Task cancelled: ' else 'Task completed: ' end || t.notes,
      jsonb_build_object('taskId', t.id), t."completedAt", 'member', null::uuid, 'task', t.id
    from public.follow_up_tasks t where t.workspace_id = target_workspace and t."projectId" = target_project and t."completedAt" is not null and (t.completed or t.cancelled)
    union all
    select 'file-up:' || d.id, 'files', 'file_uploaded', 'File uploaded: ' || d.file_name, jsonb_build_object('category', d.category, 'size', d.size_bytes), d.verified_at, 'member', d.uploaded_by, 'document', d.id::text
    from leadflow_private.client_documents d where d.project_id = target_project and d.verified_at is not null
    union all
    select 'file-removed:' || d.id, 'files', 'file_removed', 'File removed: ' || d.file_name, '{}'::jsonb, d.deleted_at, 'member', d.deleted_by, 'document', d.id::text
    from leadflow_private.client_documents d where d.project_id = target_project and d.deleted_at is not null)
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'group', e.grp, 'kind', e.kind, 'summary', e.summary, 'detail', e.detail, 'at', e.at,
      'actorType', e.actor_type, 'actorName', case e.actor_type when 'client' then 'Client' when 'system' then 'LeadFlow' else coalesce(nullif(p.display_name, ''), u.email::text) end,
      'entityType', e.entity_type, 'entityId', e.entity_id) order by e.at desc, e.id), '[]'::jsonb),
    'hasMore', (select count(*) from events x where x.grp = any(wanted) and (before_at is null or x.at < before_at or (x.at = before_at and before_id is not null and x.id > before_id))) > page_rows)
  from (select * from events x where x.grp = any(wanted) and (before_at is null or x.at < before_at or (x.at = before_at and before_id is not null and x.id > before_id)) order by x.at desc, x.id limit page_rows) e
  left join public.profiles p on p.id = e.actor_id left join auth.users u on u.id = e.actor_id);
end $$;

-- The history of one milestone or deliverable (its own events, newest first).
create function public.project_entity_history(target_workspace uuid, target_project uuid, entity_kind text, target_entity uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if entity_kind not in ('milestone','deliverable') then raise exception 'Choose a milestone or deliverable.' using errcode = '22023'; end if;
  if not exists (select 1 from leadflow_private.projects p where p.id = target_project and p.workspace_id = target_workspace) then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'summary', a.summary, 'detail', a.detail, 'at', a.at,
      'actorName', coalesce(nullif(p.display_name, ''), u.email::text)) order by a.at desc, a.id desc)
    from (select * from leadflow_private.client_activities a where a.project_id = target_project and a.entity_type = entity_kind and a.entity_id = target_entity::text order by a.at desc, a.id desc limit 100) a
    left join public.profiles p on p.id = a.actor_id left join auth.users u on u.id = a.actor_id), '[]'::jsonb);
end $$;

-- Deadlines of projects, milestones, deliverables and project tasks between two dates (at most 400 days).
-- filters: { clientId, projectId, state: open|done|all, kinds: [project, milestone, deliverable, task] }.
create function public.project_calendar_for(target_workspace uuid, from_date date, to_date date, filters jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare today date := leadflow_private.project_today(target_workspace); wanted_state text := coalesce(nullif(filters->>'state', ''), 'all'); kinds text[];
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if from_date is null or to_date is null or to_date < from_date or to_date - from_date > 400 then raise exception 'Choose a date range of up to 400 days.' using errcode = '22023'; end if;
  select coalesce(array_agg(value), '{project,milestone,deliverable,task}') into kinds
    from jsonb_array_elements_text(case when jsonb_typeof(filters->'kinds') = 'array' and jsonb_array_length(filters->'kinds') > 0 then filters->'kinds' else '[]'::jsonb end);
  return (with p as (select x.*, c.name as client_name from leadflow_private.projects x join leadflow_private.clients c on c.id = x.client_id where x.workspace_id = target_workspace
      and (nullif(filters->>'clientId', '') is null or x.client_id::text = filters->>'clientId') and (nullif(filters->>'projectId', '') is null or x.id::text = filters->>'projectId')),
  items as (
    select 'project' as kind, p.id::text as id, p.name as title, p.target_date as date, p.id as project_id, p.name as project_name, p.client_id, p.client_name, p.status, p.priority,
      p.status in ('completed','cancelled') as done, null::uuid as assignee_id from p where p.target_date between from_date and to_date
    union all select 'milestone', m.id::text, m.name, m.due_date, p.id, p.name, p.client_id, p.client_name, m.status, null, m.status in ('completed','cancelled'), null
      from leadflow_private.project_milestones m join p on p.id = m.project_id where m.due_date between from_date and to_date
    union all select 'deliverable', d.id::text, d.title, d.due_date, p.id, p.name, p.client_id, p.client_name, d.status, d.priority, d.status = 'completed', d.owner_id
      from leadflow_private.project_deliverables d join p on p.id = d.project_id where d.due_date between from_date and to_date
    union all select 'task', t.id, t.notes, t.due, p.id, p.name, p.client_id, p.client_name, case when t.completed then 'completed' when t.cancelled then 'cancelled' else t.status end, t.priority,
      t.completed or t.cancelled, t."assigneeId"
      from public.follow_up_tasks t join p on p.id = t."projectId" where t.workspace_id = target_workspace and t.due between from_date and to_date)
  select jsonb_build_object('today', today, 'items', coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'id', i.id, 'title', i.title, 'date', i.date, 'projectId', i.project_id,
      'projectName', i.project_name, 'clientId', i.client_id, 'clientName', i.client_name, 'status', i.status, 'priority', i.priority, 'done', i.done, 'assigneeId', i.assignee_id,
      'overdue', not i.done and i.date < today) order by i.date, i.kind, i.title)
    from (select * from items where kind = any(kinds) and (wanted_state = 'all' or (wanted_state = 'open' and not done) or (wanted_state = 'done' and done)) order by date, kind, title limit 1500) i), '[]'::jsonb)));
end $$;

-- ---------- Milestones ----------

-- Any member. Adds (no id) or edits a milestone. A milestone's dependencies are other milestones of the project.
create function public.save_project_milestone(target_workspace uuid, target_project uuid, milestone jsonb, expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_project leadflow_private.projects; previous leadflow_private.project_milestones; result leadflow_private.project_milestones; clean_name text; description_value text;
  start_value date; due_value date; status_value text; notes_value text; deps jsonb; changed text[];
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_project := leadflow_private.lock_project(target_workspace, target_project, null);
  if milestone is null or jsonb_typeof(milestone) <> 'object' then raise exception 'Send the milestone as an object.' using errcode = '22023'; end if;
  clean_name := leadflow_private.onboarding_clean_text(milestone->>'name', 'Milestone name', 150, true);
  description_value := leadflow_private.onboarding_clean_text(milestone->>'description', 'Milestone description', 2000, false, false);
  start_value := leadflow_private.onboarding_clean_date(milestone->>'startDate', 'Milestone start date');
  due_value := leadflow_private.onboarding_clean_date(milestone->>'dueDate', 'Milestone due date');
  if start_value > due_value then raise exception 'The milestone ends before it starts.' using errcode = '22023'; end if;
  status_value := coalesce(nullif(milestone->>'status', ''), 'upcoming');
  if status_value not in ('upcoming','in_progress','completed','delayed','cancelled') then raise exception 'Choose a milestone status.' using errcode = '22023'; end if;
  notes_value := leadflow_private.onboarding_clean_text(milestone->>'notes', 'Milestone notes', 2000, false, false);
  if milestone ? 'dependsOn' then
    if jsonb_typeof(milestone->'dependsOn') <> 'array' or jsonb_array_length(milestone->'dependsOn') > 20 then raise exception 'A milestone can wait for up to 20 others.' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(distinct e), '[]') into deps from jsonb_array_elements(milestone->'dependsOn') e;
  end if;
  if nullif(milestone->>'id', '') is null then
    if (select count(*) from leadflow_private.project_milestones m where m.project_id = target_project) >= 100 then raise exception 'A project can have at most 100 milestones.' using errcode = '54000'; end if;
    insert into leadflow_private.project_milestones(workspace_id, project_id, position, name, description, start_date, due_date, status, completed_at, notes, depends_on)
      values (target_workspace, target_project, coalesce((select max(m.position) + 1 from leadflow_private.project_milestones m where m.project_id = target_project), 0), clean_name, description_value,
        start_value, due_value, status_value, case when status_value = 'completed' then now() end, notes_value, coalesce(deps, '[]'))
      returning * into result;
    perform leadflow_private.project_event(found_project, 'milestone_added', 'Milestone added: ' || clean_name, jsonb_build_object('dueDate', due_value), 'milestone', result.id::text);
  else
    select * into previous from leadflow_private.project_milestones m where m.project_id = target_project and m.id::text = milestone->>'id' for update;
    if not found then raise exception 'Milestone not found in this project.' using errcode = 'P0002'; end if;
    if expected_version is null or previous.version <> expected_version then raise exception 'This milestone was changed in another window. Reload and try again.' using errcode = '40001'; end if;
    update leadflow_private.project_milestones m set name = clean_name, description = description_value, start_date = start_value, due_date = due_value, status = status_value,
      completed_at = case when status_value = 'completed' then coalesce(previous.completed_at, now()) end, notes = notes_value, depends_on = coalesce(deps, m.depends_on), version = m.version + 1
      where m.id = previous.id returning * into result;
    if result.status <> previous.status then
      perform leadflow_private.project_event(found_project, case result.status when 'completed' then 'milestone_completed' else 'milestone_status' end,
        case result.status when 'completed' then 'Milestone completed: ' || result.name else 'Milestone “' || result.name || '” moved to ' || replace(result.status, '_', ' ') end,
        jsonb_build_object('from', previous.status, 'to', result.status), 'milestone', result.id::text);
    end if;
    if result.due_date is distinct from previous.due_date or result.start_date is distinct from previous.start_date then
      perform leadflow_private.project_event(found_project, 'deadline_changed', 'Dates of the milestone “' || result.name || '” changed' || coalesce(': due ' || result.due_date, ''),
        jsonb_build_object('from', jsonb_build_object('start', previous.start_date, 'due', previous.due_date), 'to', jsonb_build_object('start', result.start_date, 'due', result.due_date)), 'milestone', result.id::text);
    end if;
    select array_agg(f) into changed from (values ('name', result.name is distinct from previous.name), ('description', result.description is distinct from previous.description),
      ('notes', result.notes is distinct from previous.notes), ('dependencies', result.depends_on is distinct from previous.depends_on)) as x(f, differs) where differs;
    if cardinality(changed) > 0 then
      perform leadflow_private.project_event(found_project, 'milestone_updated', 'Milestone “' || result.name || '” updated: ' || array_to_string(changed, ', '), jsonb_build_object('fields', to_jsonb(changed)), 'milestone', result.id::text);
    end if;
  end if;
  perform leadflow_private.check_milestone_dependencies(target_project);
  return jsonb_build_object('id', result.id, 'version', result.version);
end $$;

-- Any member. ids lists every milestone of the project once, in the new order.
create function public.reorder_project_milestones(target_workspace uuid, target_project uuid, milestone_ids jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare given text[]; found_project leadflow_private.projects;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_project := leadflow_private.lock_project(target_workspace, target_project, null);
  if jsonb_typeof(milestone_ids) is distinct from 'array' then raise exception 'Send the milestones in their new order.' using errcode = '22023'; end if;
  select array_agg(value) into given from jsonb_array_elements_text(milestone_ids);
  if coalesce(cardinality(given), 0) <> (select count(*) from leadflow_private.project_milestones m where m.project_id = target_project)
      or cardinality(given) <> (select count(distinct x) from unnest(given) x)
      or exists (select 1 from unnest(given) x where not exists (select 1 from leadflow_private.project_milestones m where m.project_id = target_project and m.id::text = x)) then
    raise exception 'The order must list every milestone of the project once. Reload and try again.' using errcode = '22023';
  end if;
  update leadflow_private.project_milestones m set position = o.ordinality - 1 from unnest(given) with ordinality as o(id, ordinality) where m.id::text = o.id and m.project_id = target_project;
  perform leadflow_private.project_event(found_project, 'milestones_reordered', 'Milestones reordered', '{}'::jsonb);
end $$;

-- Any member. Its deliverables and tasks stay, without a milestone.
create function public.remove_project_milestone(target_workspace uuid, target_project uuid, target_milestone uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_project leadflow_private.projects; removed text; linked integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_project := leadflow_private.lock_project(target_workspace, target_project, null);
  select count(*) into linked from public.follow_up_tasks t where t.workspace_id = target_workspace and t."milestoneId" = target_milestone;
  delete from leadflow_private.project_milestones m where m.project_id = target_project and m.id = target_milestone returning name into removed;
  if removed is null then raise exception 'Milestone not found in this project.' using errcode = 'P0002'; end if;
  update leadflow_private.project_milestones m set depends_on = (select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(m.depends_on) e where e #>> '{}' <> target_milestone::text)
    where m.project_id = target_project and m.depends_on @> to_jsonb(target_milestone::text);
  if linked > 0 then perform leadflow_private.bump_workspace_revision(target_workspace); end if;
  perform leadflow_private.project_event(found_project, 'milestone_removed', 'Milestone removed: ' || removed, jsonb_build_object('tasksUnlinked', linked), 'milestone', target_milestone::text);
  return jsonb_build_object('workspaceChanged', linked > 0);
end $$;

-- ---------- Deliverables ----------

-- Any member. Adds (no id; idempotent per request ID) or edits a deliverable.
create function public.save_project_deliverable(target_workspace uuid, target_project uuid, deliverable jsonb, expected_version integer, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_project leadflow_private.projects; previous leadflow_private.project_deliverables; result leadflow_private.project_deliverables; title_value text; milestone_ref uuid;
  owner_ref uuid; due_value date; priority_value text; status_value text; service_ref uuid; changed text[];
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_project := leadflow_private.lock_project(target_workspace, target_project, null);
  if deliverable is null or jsonb_typeof(deliverable) <> 'object' then raise exception 'Send the deliverable as an object.' using errcode = '22023'; end if;
  if nullif(deliverable->>'id', '') is null and request_id is not null then
    select * into result from leadflow_private.project_deliverables d where d.workspace_id = target_workspace and d.request_id = save_project_deliverable.request_id;
    if found then return jsonb_build_object('id', result.id, 'version', result.version, 'repeated', true); end if;
  end if;
  title_value := leadflow_private.onboarding_clean_text(deliverable->>'title', 'Deliverable title', 200, true);
  if nullif(deliverable->>'milestoneId', '') is not null then
    select m.id into milestone_ref from leadflow_private.project_milestones m where m.project_id = target_project and m.id::text = deliverable->>'milestoneId';
    if milestone_ref is null then raise exception 'Choose a milestone of this project.' using errcode = '22023'; end if;
  end if;
  owner_ref := leadflow_private.client_owner_ref(target_workspace, deliverable->>'ownerId');
  due_value := leadflow_private.onboarding_clean_date(deliverable->>'dueDate', 'Deliverable due date');
  priority_value := coalesce(nullif(deliverable->>'priority', ''), 'medium');
  if priority_value not in ('low','medium','high','critical') then raise exception 'Choose a priority.' using errcode = '22023'; end if;
  status_value := coalesce(nullif(deliverable->>'status', ''), 'not_started');
  if status_value not in ('not_started','in_progress','internal_review','ready_for_review','completed','blocked') then raise exception 'Choose a deliverable status.' using errcode = '22023'; end if;
  if nullif(deliverable->>'clientServiceId', '') is not null then
    select s.id into service_ref from leadflow_private.client_services s where s.client_id = found_project.client_id and s.id::text = deliverable->>'clientServiceId';
    if service_ref is null then raise exception 'Choose one of the client''s services.' using errcode = '22023'; end if;
  end if;
  if nullif(deliverable->>'id', '') is null then
    if (select count(*) from leadflow_private.project_deliverables d where d.project_id = target_project) >= 500 then raise exception 'A project can have at most 500 deliverables.' using errcode = '54000'; end if;
    insert into leadflow_private.project_deliverables(workspace_id, project_id, milestone_id, position, title, description, owner_id, due_date, priority, status, notes, client_service_id,
        completed_at, request_id, created_by)
      values (target_workspace, target_project, milestone_ref, coalesce((select max(d.position) + 1 from leadflow_private.project_deliverables d where d.project_id = target_project), 0), title_value,
        leadflow_private.onboarding_clean_text(deliverable->>'description', 'Deliverable description', 4000, false, false), owner_ref, due_value, priority_value, status_value,
        leadflow_private.onboarding_clean_text(deliverable->>'notes', 'Deliverable notes', 2000, false, false), service_ref, case when status_value = 'completed' then now() end,
        save_project_deliverable.request_id, leadflow_private.valid_actor())
      returning * into result;
    perform leadflow_private.project_event(found_project, 'deliverable_added', 'Deliverable added: ' || title_value, jsonb_build_object('dueDate', due_value, 'status', status_value), 'deliverable', result.id::text);
  else
    select * into previous from leadflow_private.project_deliverables d where d.project_id = target_project and d.id::text = deliverable->>'id' for update;
    if not found then raise exception 'Deliverable not found in this project.' using errcode = 'P0002'; end if;
    if expected_version is null or previous.version <> expected_version then raise exception 'This deliverable was changed in another window. Reload and try again.' using errcode = '40001'; end if;
    update leadflow_private.project_deliverables d set title = title_value, description = leadflow_private.onboarding_clean_text(deliverable->>'description', 'Deliverable description', 4000, false, false),
      milestone_id = milestone_ref, owner_id = owner_ref, due_date = due_value, priority = priority_value, status = status_value,
      notes = leadflow_private.onboarding_clean_text(deliverable->>'notes', 'Deliverable notes', 2000, false, false), client_service_id = service_ref,
      completed_at = case when status_value = 'completed' then coalesce(previous.completed_at, now()) end, version = d.version + 1
      where d.id = previous.id returning * into result;
    if result.status <> previous.status then
      perform leadflow_private.project_event(found_project, case result.status when 'completed' then 'deliverable_completed' else 'deliverable_status' end,
        case result.status when 'completed' then 'Deliverable completed: ' || result.title else 'Deliverable “' || result.title || '” moved to ' || replace(replace(result.status, 'ready_for_review', 'ready for client review'), '_', ' ') end,
        jsonb_build_object('from', previous.status, 'to', result.status), 'deliverable', result.id::text);
    end if;
    if result.owner_id is distinct from previous.owner_id then
      perform leadflow_private.project_event(found_project, 'deliverable_assigned', 'Deliverable “' || result.title || '” ' || case when result.owner_id is null then 'unassigned' else 'assigned to ' ||
        coalesce((select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = result.owner_id), 'a member') end,
        jsonb_build_object('from', previous.owner_id, 'to', result.owner_id), 'deliverable', result.id::text);
    end if;
    if result.due_date is distinct from previous.due_date then
      perform leadflow_private.project_event(found_project, 'deadline_changed', 'Due date of the deliverable “' || result.title || '” ' || coalesce('changed to ' || result.due_date, 'removed'),
        jsonb_build_object('from', previous.due_date, 'to', result.due_date), 'deliverable', result.id::text);
    end if;
    select array_agg(f) into changed from (values ('title', result.title is distinct from previous.title), ('description', result.description is distinct from previous.description),
      ('milestone', result.milestone_id is distinct from previous.milestone_id), ('priority', result.priority is distinct from previous.priority), ('notes', result.notes is distinct from previous.notes),
      ('service', result.client_service_id is distinct from previous.client_service_id)) as x(f, differs) where differs;
    if cardinality(changed) > 0 then
      perform leadflow_private.project_event(found_project, 'deliverable_updated', 'Deliverable “' || result.title || '” updated: ' || array_to_string(changed, ', '), jsonb_build_object('fields', to_jsonb(changed)), 'deliverable', result.id::text);
    end if;
  end if;
  return jsonb_build_object('id', result.id, 'version', result.version, 'repeated', false);
end $$;

-- Any member. Its tasks and files stay, without a deliverable.
create function public.remove_project_deliverable(target_workspace uuid, target_project uuid, target_deliverable uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_project leadflow_private.projects; removed text; linked integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_project := leadflow_private.lock_project(target_workspace, target_project, null);
  select count(*) into linked from public.follow_up_tasks t where t.workspace_id = target_workspace and t."deliverableId" = target_deliverable;
  delete from leadflow_private.project_deliverables d where d.project_id = target_project and d.id = target_deliverable returning title into removed;
  if removed is null then raise exception 'Deliverable not found in this project.' using errcode = 'P0002'; end if;
  if linked > 0 then perform leadflow_private.bump_workspace_revision(target_workspace); end if;
  perform leadflow_private.project_event(found_project, 'deliverable_removed', 'Deliverable removed: ' || removed, jsonb_build_object('tasksUnlinked', linked), 'deliverable', target_deliverable::text);
  return jsonb_build_object('workspaceChanged', linked > 0);
end $$;

-- ---------- Templates ----------

create function public.project_templates_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  perform leadflow_private.ensure_project_templates(target_workspace);
  return jsonb_build_object('canEdit', actor_role <> 'member', 'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description,
      'projectType', t.project_type, 'starterKey', t.starter_key, 'archived', t.archived, 'version', t.version, 'updatedAt', t.updated_at,
      'milestoneCount', (select count(*) from leadflow_private.project_template_milestones m where m.template_id = t.id),
      'deliverableCount', (select coalesce(sum(jsonb_array_length(m.deliverables)), 0) from leadflow_private.project_template_milestones m where m.template_id = t.id),
      'taskCount', (select coalesce(sum(jsonb_array_length(m.tasks)), 0) from leadflow_private.project_template_milestones m where m.template_id = t.id),
      'durationDays', (select coalesce(max(m.start_offset_days + m.duration_days), 0) from leadflow_private.project_template_milestones m where m.template_id = t.id),
      'projects', (select count(*) from leadflow_private.projects p where p.template_id = t.id)) order by t.archived, lower(t.name))
    from leadflow_private.project_templates t where t.workspace_id = target_workspace), '[]'::jsonb));
end $$;

create function public.project_template_for(target_workspace uuid, target_template uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description, 'projectType', t.project_type, 'starterKey', t.starter_key, 'archived', t.archived, 'version', t.version,
    'milestones', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'description', m.description, 'startOffsetDays', m.start_offset_days, 'durationDays', m.duration_days,
        'deliverables', m.deliverables, 'tasks', m.tasks) order by m.position) from leadflow_private.project_template_milestones m where m.template_id = t.id), '[]'::jsonb))
  into result from leadflow_private.project_templates t where t.id = target_template and t.workspace_id = target_workspace;
  if result is null then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
  return result;
end $$;

-- Owners and admins. Creates (idempotent per request ID) or replaces a template. Projects already created keep their plan.
create function public.save_project_template(target_workspace uuid, definition jsonb, expected_version integer, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing leadflow_private.project_templates; clean_name text; clean_description text; type_value text; milestones jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if definition is null or jsonb_typeof(definition) <> 'object' then raise exception 'Send the template as an object.' using errcode = '22023'; end if;
  clean_name := leadflow_private.onboarding_clean_text(definition->>'name', 'Template name', 100, true);
  clean_description := leadflow_private.onboarding_clean_text(definition->>'description', 'Description', 1000, false, false);
  type_value := coalesce(nullif(definition->>'projectType', ''), 'other');
  if type_value not in ('website','marketing','seo','social','paid_ads','email','automation','software','chatbot','crm','other') then raise exception 'Choose a project type.' using errcode = '22023'; end if;
  if jsonb_typeof(definition->'milestones') is distinct from 'array' or jsonb_array_length(definition->'milestones') not between 1 and 30 then raise exception 'A template needs 1 to 30 milestones.' using errcode = '22023'; end if;
  select jsonb_agg(leadflow_private.clean_template_milestone(m) order by n) into milestones from jsonb_array_elements(definition->'milestones') with ordinality as e(m, n);
  begin
    if nullif(definition->>'id', '') is null then
      if request_id is not null then
        select * into existing from leadflow_private.project_templates t where t.workspace_id = target_workspace and t.creation_request_id = save_project_template.request_id;
        if found then return jsonb_build_object('id', existing.id, 'version', existing.version); end if;
      end if;
      if (select count(*) from leadflow_private.project_templates t where t.workspace_id = target_workspace) >= 100 then raise exception 'A workspace can have at most 100 project templates.' using errcode = '54000'; end if;
      perform leadflow_private.ensure_project_templates(target_workspace);
      insert into leadflow_private.project_templates(workspace_id, name, description, project_type, creation_request_id, created_by)
        values (target_workspace, clean_name, clean_description, type_value, request_id, leadflow_private.valid_actor()) returning * into existing;
    else
      select * into existing from leadflow_private.project_templates t where t.workspace_id = target_workspace and t.id::text = definition->>'id' for update;
      if not found then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
      if expected_version is null or existing.version <> expected_version then raise exception 'This template was changed in another session. Reload it and try again.' using errcode = '40001'; end if;
      update leadflow_private.project_templates t set name = clean_name, description = clean_description, project_type = type_value, version = t.version + 1 where t.id = existing.id returning * into existing;
      delete from leadflow_private.project_template_milestones m where m.template_id = existing.id;
    end if;
  exception when unique_violation then raise exception 'A template called “%” already exists.', clean_name using errcode = '22023';
  end;
  insert into leadflow_private.project_template_milestones(workspace_id, template_id, position, name, description, start_offset_days, duration_days, deliverables, tasks)
    select target_workspace, existing.id, (n - 1)::integer, m->>'name', m->>'description', (m->>'startOffsetDays')::integer, (m->>'durationDays')::integer, m->'deliverables', m->'tasks'
    from jsonb_array_elements(milestones) with ordinality as e(m, n);
  return jsonb_build_object('id', existing.id, 'version', existing.version);
end $$;

create function public.set_project_template_archived(target_workspace uuid, target_template uuid, archive boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  begin
    update leadflow_private.project_templates t set archived = coalesce(archive, t.archived), version = t.version + 1 where t.id = target_template and t.workspace_id = target_workspace;
    if not found then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
  exception when unique_violation then raise exception 'An active template already uses this name. Rename one of them first.' using errcode = '22023';
  end;
end $$;

-- Owners and admins. A reusable template from a project's milestones, deliverables and tasks, with dates turned into
-- day offsets from the project start. Work without a milestone goes into a last "Other work" milestone.
create function public.save_project_as_template(target_workspace uuid, target_project uuid, template_name text, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_project leadflow_private.projects; base date; milestones jsonb; loose jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  select * into found_project from leadflow_private.projects p where p.id = target_project and p.workspace_id = target_workspace;
  if not found then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  base := coalesce(found_project.start_date, (select min(coalesce(m.start_date, m.due_date)) from leadflow_private.project_milestones m where m.project_id = target_project), leadflow_private.project_today(target_workspace));
  select coalesce(jsonb_agg(jsonb_build_object('name', m.name, 'description', m.description,
      'startOffsetDays', least(greatest(coalesce(m.start_date, m.due_date, base) - base, 0), 3650),
      'durationDays', least(greatest(coalesce(m.due_date, m.start_date, base) - coalesce(m.start_date, m.due_date, base) + 1, 1), 3650),
      'deliverables', coalesce((select jsonb_agg(jsonb_build_object('title', d.title, 'description', left(d.description, 1000)) order by d.position) from (select * from leadflow_private.project_deliverables x where x.milestone_id = m.id order by x.position limit 20) d), '[]'),
      'tasks', coalesce((select jsonb_agg(jsonb_build_object('title', left(t.notes, 300), 'priority', t.priority, 'durationDays', least(greatest(t.due - coalesce(t."startDate", t.due) + 1, 1), 3650)) order by t.due)
        from (select * from public.follow_up_tasks x where x.workspace_id = target_workspace and x."milestoneId" = m.id and not x.cancelled order by x.due limit 30) t), '[]')) order by m.position), '[]'::jsonb)
    into milestones from (select * from leadflow_private.project_milestones x where x.project_id = target_project and x.status <> 'cancelled' order by x.position limit 29) m;
  select jsonb_build_object('name', 'Other work', 'description', '', 'startOffsetDays', 0,
      'durationDays', least(greatest(coalesce(found_project.target_date, base) - base + 1, 1), 3650),
      'deliverables', coalesce((select jsonb_agg(jsonb_build_object('title', d.title, 'description', left(d.description, 1000)) order by d.position) from (select * from leadflow_private.project_deliverables x where x.project_id = target_project and x.milestone_id is null order by x.position limit 20) d), '[]'),
      'tasks', coalesce((select jsonb_agg(jsonb_build_object('title', left(t.notes, 300), 'priority', t.priority, 'durationDays', least(greatest(t.due - coalesce(t."startDate", t.due) + 1, 1), 3650)) order by t.due)
        from (select * from public.follow_up_tasks x where x.workspace_id = target_workspace and x."projectId" = target_project and x."milestoneId" is null and not x.cancelled order by x.due limit 30) t), '[]'))
    into loose;
  if jsonb_array_length(loose->'deliverables') + jsonb_array_length(loose->'tasks') > 0 then milestones := milestones || jsonb_build_array(loose); end if;
  if jsonb_array_length(milestones) = 0 then raise exception 'Add milestones, deliverables or tasks to the project before saving it as a template.' using errcode = '55000'; end if;
  return public.save_project_template(target_workspace, jsonb_build_object('name', template_name, 'description', 'Saved from the project “' || left(found_project.name, 150) || '”.',
    'projectType', found_project.project_type, 'milestones', milestones), null, request_id);
end $$;

-- Any member. A template turned into a dated plan from a start date, to review and edit before it is applied.
create function public.project_template_plan(target_workspace uuid, target_template uuid, start_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare base date;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.project_templates t where t.id = target_template and t.workspace_id = target_workspace) then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
  base := coalesce(start_date, leadflow_private.project_today(target_workspace));
  return (with m as (select x.*, base + x.start_offset_days as m_start, base + x.start_offset_days + x.duration_days - 1 as m_due from leadflow_private.project_template_milestones x where x.template_id = target_template)
  select jsonb_build_object('startDate', base, 'targetDate', (select max(m_due) from m),
    'milestones', coalesce((select jsonb_agg(jsonb_build_object('ref', 'm' || m.position, 'name', m.name, 'description', m.description, 'startDate', m.m_start, 'dueDate', m.m_due) order by m.position) from m), '[]'::jsonb),
    'deliverables', coalesce((select jsonb_agg(jsonb_build_object('ref', 'm' || m.position || '-d' || d.n, 'milestoneRef', 'm' || m.position, 'title', d.item->>'title', 'description', d.item->>'description',
        'dueDate', m.m_due, 'priority', 'medium') order by m.position, d.n) from m cross join lateral jsonb_array_elements(m.deliverables) with ordinality as d(item, n)), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('ref', 'm' || m.position || '-t' || t.n, 'milestoneRef', 'm' || m.position, 'title', t.item->>'title', 'startDate', m.m_start,
        'dueDate', least(m.m_start + coalesce((t.item->>'durationDays')::integer, 3) - 1, m.m_due), 'priority', coalesce(t.item->>'priority', 'medium')) order by m.position, t.n)
      from m cross join lateral jsonb_array_elements(m.tasks) with ordinality as t(item, n)), '[]'::jsonb)));
end $$;

-- ---------- Files ----------

-- As M10 defined it, plus the project, milestone, deliverable and task a file belongs to.
create or replace function leadflow_private.document_json(d leadflow_private.client_documents) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'clientId', d.client_id, 'requestId', d.request_id, 'itemId', d.item_id, 'fileName', d.file_name, 'extension', d.extension, 'mimeType', d.mime_type,
    'size', d.size_bytes, 'category', d.category, 'description', d.description, 'visibility', d.visibility, 'status', d.status, 'rejectedReason', d.rejected_reason, 'uploaderType', d.uploader_type,
    'uploadedBy', case when d.uploader_type = 'client' then 'Client' else (select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = d.uploaded_by) end,
    'stageId', d.stage_id, 'createdAt', d.created_at, 'verifiedAt', d.verified_at,
    'itemTitle', (select i.title from leadflow_private.onboarding_items i where i.request_id = d.request_id and i.id = d.item_id),
    'projectId', d.project_id, 'projectName', (select p.name from leadflow_private.projects p where p.id = d.project_id), 'milestoneId', d.milestone_id, 'deliverableId', d.deliverable_id, 'taskId', d.task_id)
$$;

-- As M10 defined it; a file can also belong to one of the client's projects (and its milestone, deliverable or task).
-- Project files are always internal.
create or replace function public.begin_client_document(target_workspace uuid, target_client uuid, details jsonb, max_bytes bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; request_ref uuid; project_ref uuid; milestone_ref uuid; deliverable_ref uuid; task_ref text; created jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into found_client from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace;
  if not found then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  if found_client.status = 'archived' then raise exception 'Unarchive this client before adding files.' using errcode = '55000'; end if;
  if nullif(details->>'requestId', '') is not null then
    select r.id into request_ref from leadflow_private.onboarding_requests r where r.client_id = target_client and r.id::text = details->>'requestId';
    if request_ref is null then raise exception 'That onboarding request isn''t this client''s.' using errcode = '22023'; end if;
  end if;
  if nullif(details->>'projectId', '') is not null then
    select p.id into project_ref from leadflow_private.projects p where p.client_id = target_client and p.id::text = details->>'projectId';
    if project_ref is null then raise exception 'That project isn''t this client''s.' using errcode = '22023'; end if;
    if nullif(details->>'milestoneId', '') is not null then
      select m.id into milestone_ref from leadflow_private.project_milestones m where m.project_id = project_ref and m.id::text = details->>'milestoneId';
      if milestone_ref is null then raise exception 'Choose a milestone of this project.' using errcode = '22023'; end if;
    end if;
    if nullif(details->>'deliverableId', '') is not null then
      select d.id into deliverable_ref from leadflow_private.project_deliverables d where d.project_id = project_ref and d.id::text = details->>'deliverableId';
      if deliverable_ref is null then raise exception 'Choose a deliverable of this project.' using errcode = '22023'; end if;
    end if;
    if nullif(details->>'taskId', '') is not null then
      select t.id into task_ref from public.follow_up_tasks t where t.workspace_id = target_workspace and t."projectId" = project_ref and t.id = details->>'taskId';
      if task_ref is null then raise exception 'Choose a task of this project.' using errcode = '22023'; end if;
    end if;
  elsif coalesce(details->>'milestoneId', details->>'deliverableId', details->>'taskId', '') <> '' then
    raise exception 'Choose the project the file belongs to.' using errcode = '22023';
  end if;
  created := leadflow_private.begin_document(target_workspace, target_client, request_ref, null,
    (details - 'requestId' - 'projectId' - 'milestoneId' - 'deliverableId' - 'taskId') || case when project_ref is not null then '{"visibility":"internal"}'::jsonb else '{}'::jsonb end,
    'member', leadflow_private.valid_actor(), null, max_bytes);
  if project_ref is not null then
    update leadflow_private.client_documents d set project_id = project_ref, milestone_id = milestone_ref, deliverable_id = deliverable_ref, task_id = task_ref where d.id = (created->>'id')::uuid;
  end if;
  return created;
end $$;

-- As M10 defined it; project files can't be shared with the client.
create or replace function public.update_client_document(target_workspace uuid, target_document uuid, changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.client_documents;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if changes is null or jsonb_typeof(changes) <> 'object' then raise exception 'Send the changes as an object.' using errcode = '22023'; end if;
  if changes ? 'category' and changes->>'category' not in ('brand','logo','image','video','content','requirements','design_reference','technical','access_instructions','other') then raise exception 'Choose a document category.' using errcode = '22023'; end if;
  if changes ? 'visibility' and changes->>'visibility' not in ('internal','shared') then raise exception 'Choose who can see the file.' using errcode = '22023'; end if;
  if changes->>'visibility' = 'shared' and exists (select 1 from leadflow_private.client_documents x where x.id = target_document and x.workspace_id = target_workspace and x.project_id is not null) then
    raise exception 'Project files stay internal. Client sharing of project files isn''t available yet.' using errcode = '22023';
  end if;
  update leadflow_private.client_documents x set category = coalesce(changes->>'category', x.category), visibility = coalesce(changes->>'visibility', x.visibility),
    description = case when changes ? 'description' then leadflow_private.onboarding_clean_text(changes->>'description', 'Description', 1000, false, false) else x.description end
    where x.id = target_document and x.workspace_id = target_workspace and x.status = 'available' returning * into d;
  if d.id is null then raise exception 'File not found.' using errcode = 'P0002'; end if;
  if d.client_id is not null and changes ? 'visibility' then
    perform leadflow_private.client_event(d.client_id, 'document_updated', case d.visibility when 'shared' then 'File shared with the client: ' else 'File made internal: ' end || d.file_name,
      jsonb_build_object('visibility', d.visibility), 'member', 'document', d.id::text);
  end if;
  return leadflow_private.document_json(d);
end $$;

-- Any member. The project's own files (pending uploads for a day), and the client's other files for reference.
create function public.project_documents_for(target_workspace uuid, target_project uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_project leadflow_private.projects;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into found_project from leadflow_private.projects p where p.id = target_project and p.workspace_id = target_workspace;
  if not found then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'project', coalesce((select jsonb_agg(leadflow_private.document_json(d) order by d.created_at desc) from leadflow_private.client_documents d
      where d.project_id = target_project and d.status in ('available','pending') and (d.status = 'available' or d.created_at > now() - interval '1 day')), '[]'::jsonb),
    'client', coalesce((select jsonb_agg(leadflow_private.document_json(d) order by d.created_at desc) from leadflow_private.client_documents d
      where d.workspace_id = target_workspace and d.status = 'available' and d.project_id is null
        and (d.client_id = found_project.client_id or d.request_id in (select r.id from leadflow_private.onboarding_requests r where r.client_id = found_project.client_id))), '[]'::jsonb));
end $$;

-- ---------- AI assistant context ----------

-- Any member, called by the project-assistant Edge Function with the member's own token. The project's recorded facts,
-- for suggestions the member reviews; the brief and requirements may contain text the client wrote.
create function public.project_ai_context(target_workspace uuid, target_project uuid, target_deliverable uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_project leadflow_private.projects; today date := leadflow_private.project_today(target_workspace);
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into found_project from leadflow_private.projects p where p.id = target_project and p.workspace_id = target_workspace;
  if not found then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  if target_deliverable is not null and not exists (select 1 from leadflow_private.project_deliverables d where d.id = target_deliverable and d.project_id = target_project) then
    raise exception 'Deliverable not found in this project.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('today', today,
    'project', jsonb_build_object('id', found_project.id, 'name', found_project.name, 'type', found_project.project_type, 'status', found_project.status, 'priority', found_project.priority,
      'startDate', found_project.start_date, 'targetDate', found_project.target_date, 'completedOn', found_project.completed_on, 'description', found_project.description, 'brief', found_project.brief),
    'client', (select jsonb_build_object('name', c.name, 'industry', c.industry) from leadflow_private.clients c where c.id = found_project.client_id),
    'services', coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'agreedScope', s.agreed_scope, 'deliverables', s.deliverables, 'exclusions', s.exclusions))
      from leadflow_private.client_services s join leadflow_private.project_services x on x.client_service_id = s.id where x.project_id = target_project), '[]'::jsonb),
    'milestones', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'startDate', m.start_date, 'dueDate', m.due_date, 'status', m.status,
        'overdue', m.status not in ('completed','cancelled') and m.due_date < today) order by m.position) from leadflow_private.project_milestones m where m.project_id = target_project), '[]'::jsonb),
    'deliverables', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'description', left(d.description, 1500), 'status', d.status, 'priority', d.priority, 'dueDate', d.due_date,
        'milestone', (select m.name from leadflow_private.project_milestones m where m.id = d.milestone_id), 'overdue', d.status <> 'completed' and d.due_date < today) order by d.position)
      from leadflow_private.project_deliverables d where d.project_id = target_project), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', left(t.notes, 300), 'status', case when t.completed then 'completed' when t.cancelled then 'cancelled' else t.status end,
        'priority', t.priority, 'startDate', t."startDate", 'dueDate', t.due, 'overdue', not t.completed and not t.cancelled and t.due < today,
        'milestone', (select m.name from leadflow_private.project_milestones m where m.id = t."milestoneId"), 'deliverable', (select d.title from leadflow_private.project_deliverables d where d.id = t."deliverableId"),
        'waitingFor', (select coalesce(jsonb_agg(left(o.notes, 300)), '[]'::jsonb) from public.follow_up_tasks o where o.workspace_id = target_workspace and o.id in (select e #>> '{}' from jsonb_array_elements(t."dependsOn") e) and not o.completed))
        order by t.due) from (select * from public.follow_up_tasks x where x.workspace_id = target_workspace and x."projectId" = target_project order by x.completed, x.due limit 300) t), '[]'::jsonb),
    'progress', leadflow_private.project_progress(found_project, today), 'health', leadflow_private.project_health(found_project, today),
    'deliverable', case when target_deliverable is null then null else (select jsonb_build_object('id', d.id, 'title', d.title, 'description', d.description, 'dueDate', d.due_date, 'status', d.status,
        'milestoneId', d.milestone_id, 'milestone', (select m.name from leadflow_private.project_milestones m where m.id = d.milestone_id))
      from leadflow_private.project_deliverables d where d.id = target_deliverable) end);
end $$;

-- Service role (project-assistant). Counts one AI request against the workspace's monthly limit before the AI is called,
-- in the outreach usage ledger the other AI features use. P0429 when the limit is reached.
create function public.project_ai_reserve(target_workspace uuid, actor uuid, operation text, monthly_limit integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare used integer;
begin
  if operation not in ('project_plan','project_breakdown','project_summary','project_risks') then raise exception 'Unknown AI operation.' using errcode = '22023'; end if;
  if not exists (select 1 from public.workspace_memberships m where m.workspace_id = target_workspace and m.user_id = actor) then raise exception 'You don''t have access to this workspace.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('project_ai:' || target_workspace::text));
  select count(*) into used from leadflow_private.outreach_usage u where u.workspace_id = target_workspace and u.operation like 'project\_%' and u.unit = 'requests'
    and u.at >= date_trunc('month', now());
  if used >= greatest(coalesce(monthly_limit, 0), 0) then
    raise exception 'This workspace has used its % AI project requests for this month.', monthly_limit using errcode = 'P0429';
  end if;
  insert into leadflow_private.outreach_usage(workspace_id, provider, operation, quantity, unit, status, actor) values (target_workspace, 'gemini', operation, 1, 'requests', 'ok', actor);
  return greatest(coalesce(monthly_limit, 0), 0) - used - 1;
end $$;

-- ---------- Snapshot save and task checks ----------

-- The snapshot save as M10 defined it (202611250001_client_management.sql), with the project task fields, label checks
-- and the dependency check.
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
  -- Client tasks have no lead, so the lead cascade above doesn't remove them: every task is replaced explicitly.
  delete from public.follow_up_tasks where workspace_id = target_workspace;
  insert into public.follow_up_tasks(workspace_id, id, "leadId", due, notes, completed, "dealId", "contactId", "taskType", priority, cancelled, description, "assigneeId", "createdAt", "completedAt",
      "clientId", "onboardingRequestId", "onboardingItemId", "projectId", "milestoneId", "deliverableId", status, "startDate", "estimateHours", "actualHours", labels, "dependsOn")
    select target_workspace, x.id, x."leadId", x.due, x.notes, x.completed, x."dealId", x."contactId", coalesce(x."taskType", 'follow_up'), coalesce(x.priority, 'medium'),
      coalesce(x.cancelled, false), coalesce(x.description, ''), x."assigneeId", x."createdAt", x."completedAt", x."clientId", x."onboardingRequestId", x."onboardingItemId",
      x."projectId", x."milestoneId", x."deliverableId", coalesce(x.status, 'todo'), x."startDate", x."estimateHours", x."actualHours", coalesce(x.labels, '[]'), coalesce(x."dependsOn", '[]')
    from jsonb_to_recordset(payload->'tasks') as x(id text, "leadId" text, due date, notes text, completed boolean, "dealId" uuid, "contactId" uuid, "taskType" text, priority text,
      cancelled boolean, description text, "assigneeId" uuid, "createdAt" timestamptz, "completedAt" timestamptz, "clientId" uuid, "onboardingRequestId" uuid, "onboardingItemId" uuid,
      "projectId" uuid, "milestoneId" uuid, "deliverableId" uuid, status text, "startDate" date, "estimateHours" numeric, "actualHours" numeric, labels jsonb, "dependsOn" jsonb);
  perform set_config('leadflow.kept_assignees', '', true);
  -- Labels are short text; dependencies are other tasks of the same project, never circular.
  if exists (select 1 from public.follow_up_tasks t cross join jsonb_array_elements(t.labels) l where t.workspace_id = target_workspace and t.labels <> '[]'::jsonb
      and (jsonb_typeof(l) <> 'string' or length(l #>> '{}') not between 1 and 30)) then
    raise exception 'Task labels must be text of 1 to 30 characters.' using errcode = '22023';
  end if;
  perform leadflow_private.check_task_dependencies(target_workspace);
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

-- As M10 defined it, plus: a project task belongs to its project's client, and its milestone and deliverable to its project.
create or replace function leadflow_private.check_follow_up_task() returns trigger language plpgsql security definer set search_path = '' as $$
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
  -- Onboarding tasks belong to a client, and their request to that client.
  if new."onboardingRequestId" is not null and (new."clientId" is null or not exists (select 1 from leadflow_private.onboarding_requests r
      where r.workspace_id = new.workspace_id and r.id = new."onboardingRequestId" and r.client_id = new."clientId")) then
    raise exception 'An onboarding task''s request must belong to its client.' using errcode = '22023';
  end if;
  -- Project tasks belong to the project's client and to no lead; their milestone and deliverable to the same project.
  if new."projectId" is not null and (new."leadId" is not null or new."clientId" is distinct from (select p.client_id from leadflow_private.projects p
      where p.workspace_id = new.workspace_id and p.id = new."projectId")) then
    raise exception 'A project task belongs to the project''s client and to no lead.' using errcode = '22023';
  end if;
  if new."milestoneId" is not null and (new."projectId" is null or not exists (select 1 from leadflow_private.project_milestones m
      where m.workspace_id = new.workspace_id and m.id = new."milestoneId" and m.project_id = new."projectId")) then
    raise exception 'A task''s milestone must belong to its project.' using errcode = '22023';
  end if;
  if new."deliverableId" is not null and (new."projectId" is null or not exists (select 1 from leadflow_private.project_deliverables d
      where d.workspace_id = new.workspace_id and d.id = new."deliverableId" and d.project_id = new."projectId")) then
    raise exception 'A task''s deliverable must belong to its project.' using errcode = '22023';
  end if;
  return new;
end $$;

-- ---------- Grants ----------
-- Supabase grants new public functions to anon and authenticated by default; restate every grant. Redefined functions
-- (document_json, begin_client_document, update_client_document, save_workspace_for, check_follow_up_task) keep theirs.
revoke all on function leadflow_private.project_today(uuid), leadflow_private.bump_workspace_revision(uuid),
  leadflow_private.project_event(leadflow_private.projects, text, text, jsonb, text, text, uuid), leadflow_private.lock_project(uuid, uuid, integer),
  leadflow_private.clean_money(jsonb, text), leadflow_private.clean_labels(jsonb, text, integer, integer), leadflow_private.clean_brief(jsonb), leadflow_private.clean_project_details(jsonb),
  leadflow_private.set_project_links(leadflow_private.projects, jsonb, jsonb), leadflow_private.project_progress(leadflow_private.projects, date),
  leadflow_private.project_health(leadflow_private.projects, date), leadflow_private.project_summary_json(leadflow_private.projects, date),
  leadflow_private.check_task_dependencies(uuid), leadflow_private.check_milestone_dependencies(uuid), leadflow_private.apply_plan(leadflow_private.projects, jsonb),
  leadflow_private.clean_template_milestone(jsonb), leadflow_private.project_starter_templates(), leadflow_private.ensure_project_templates(uuid),
  leadflow_private.milestone_json(leadflow_private.project_milestones, date), leadflow_private.deliverable_json(leadflow_private.project_deliverables, date),
  leadflow_private.compose_brief(jsonb, jsonb, text, text)
  from public, anon, authenticated;
revoke all on function public.project_setup_for(uuid, uuid), public.create_project(uuid, jsonb, uuid), public.apply_project_plan(uuid, uuid, jsonb, text, uuid),
  public.update_project(uuid, uuid, integer, jsonb), public.set_project_status(uuid, uuid, text, integer, text), public.add_project_note(uuid, uuid, text, uuid),
  public.project_index_for(uuid), public.projects_for(uuid, jsonb), public.project_detail(uuid, uuid), public.projects_dashboard_for(uuid),
  public.project_timeline(uuid, uuid, jsonb, timestamptz, text, integer), public.project_entity_history(uuid, uuid, text, uuid), public.project_calendar_for(uuid, date, date, jsonb),
  public.save_project_milestone(uuid, uuid, jsonb, integer), public.reorder_project_milestones(uuid, uuid, jsonb), public.remove_project_milestone(uuid, uuid, uuid),
  public.save_project_deliverable(uuid, uuid, jsonb, integer, uuid), public.remove_project_deliverable(uuid, uuid, uuid),
  public.project_templates_for(uuid), public.project_template_for(uuid, uuid), public.save_project_template(uuid, jsonb, integer, uuid), public.set_project_template_archived(uuid, uuid, boolean),
  public.save_project_as_template(uuid, uuid, text, uuid), public.project_template_plan(uuid, uuid, date), public.project_documents_for(uuid, uuid),
  public.project_ai_context(uuid, uuid, uuid), public.project_ai_reserve(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.project_setup_for(uuid, uuid), public.create_project(uuid, jsonb, uuid), public.apply_project_plan(uuid, uuid, jsonb, text, uuid),
  public.update_project(uuid, uuid, integer, jsonb), public.set_project_status(uuid, uuid, text, integer, text), public.add_project_note(uuid, uuid, text, uuid),
  public.project_index_for(uuid), public.projects_for(uuid, jsonb), public.project_detail(uuid, uuid), public.projects_dashboard_for(uuid),
  public.project_timeline(uuid, uuid, jsonb, timestamptz, text, integer), public.project_entity_history(uuid, uuid, text, uuid), public.project_calendar_for(uuid, date, date, jsonb),
  public.save_project_milestone(uuid, uuid, jsonb, integer), public.reorder_project_milestones(uuid, uuid, jsonb), public.remove_project_milestone(uuid, uuid, uuid),
  public.save_project_deliverable(uuid, uuid, jsonb, integer, uuid), public.remove_project_deliverable(uuid, uuid, uuid),
  public.project_templates_for(uuid), public.project_template_for(uuid, uuid), public.save_project_template(uuid, jsonb, integer, uuid), public.set_project_template_archived(uuid, uuid, boolean),
  public.save_project_as_template(uuid, uuid, text, uuid), public.project_template_plan(uuid, uuid, date), public.project_documents_for(uuid, uuid),
  public.project_ai_context(uuid, uuid, uuid)
  to authenticated;
grant execute on function public.project_ai_reserve(uuid, uuid, text, integer) to service_role;
