-- M6A: client onboarding and campaign readiness for marketing agencies.
-- Templates, per-client onboarding requests and checklist items, agency review, deterministic readiness,
-- an auditable delivery handoff, expiring/revocable client links and bounded reminders.
--
-- Design notes (docs/CLIENT-ONBOARDING.md):
-- * Every table lives in leadflow_private: clients get no table privileges. Signed-in members use the
--   role-checked functions below; the client portal and reminder worker use service-role functions that
--   an Edge Function calls. Anonymous callers still cannot execute any function.
-- * Requests reference leads by ID only, with no foreign key: save_workspace_for deletes and reinserts
--   leads on every save, and a cascade would erase onboarding history.
-- * Client links store only a SHA-256 hash of the token. Reminder emails carry their own token, which is
--   kept in the private reminder row only until the provider accepts or refuses the email.
-- Reverse with supabase/rollbacks/202610250001_client_onboarding.down.sql before the earlier rollbacks.

-- Keep these lists in step with src/lib/onboarding.ts.
create function leadflow_private.is_onboarding_service(candidate text) returns boolean language sql immutable set search_path = '' as $$
  select candidate in ('paid_ads','seo','social','email','other')
$$;

create table leadflow_private.onboarding_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100 and name !~ '[[:cntrl:]]'),
  service_type text not null check (leadflow_private.is_onboarding_service(service_type)),
  description text not null default '' check (length(description) <= 1000),
  -- Set on the four starter templates so installing them twice adds nothing.
  starter_key text check (starter_key in ('paid_ads','seo','social','email')),
  archived boolean not null default false,
  version integer not null default 1 check (version > 0),
  creation_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, starter_key),
  unique (workspace_id, creation_request_id)
);
create table leadflow_private.onboarding_template_items (
  workspace_id uuid not null,
  template_id uuid not null,
  id uuid not null default gen_random_uuid(),
  position integer not null check (position between 0 and 199),
  section text not null check (length(btrim(section)) between 1 and 60),
  title text not null check (length(btrim(title)) between 1 and 200),
  guidance text not null default '' check (length(guidance) <= 2000),
  kind text not null check (kind in ('text','choice','links','access')),
  options jsonb not null default '[]' check (jsonb_typeof(options) = 'array'),
  required boolean not null default true,
  primary key (template_id, id),
  unique (template_id, position) deferrable initially deferred,
  foreign key (workspace_id, template_id) references leadflow_private.onboarding_templates(workspace_id, id) on delete cascade
);

create table leadflow_private.onboarding_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 150),
  client_name text not null check (length(btrim(client_name)) between 1 and 150),
  contact_name text not null default '' check (length(contact_name) <= 150),
  contact_email text check (length(contact_email) <= 254 and contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  service_type text not null check (leadflow_private.is_onboarding_service(service_type)),
  owner_id uuid references public.profiles(id) on delete set null,
  start_date date,
  target_kickoff_date date,
  due_date date,
  status text not null default 'draft' check (status in ('draft','active','paused','completed','cancelled')),
  -- Advances on every agency change to the request or its item list; client responses use item revisions.
  version integer not null default 1 check (version > 0),
  template_id uuid references leadflow_private.onboarding_templates(id) on delete set null,
  template_name text,
  -- No foreign key: leads are replaced on every snapshot save. The UI reports a missing lead.
  lead_id text check (length(lead_id) between 1 and 200),
  client_instructions text not null default '' check (length(client_instructions) <= 4000),
  internal_note text not null default '' check (length(internal_note) <= 4000),
  reminder_interval_days integer check (reminder_interval_days between 2 and 14),
  reminder_max integer not null default 3 check (reminder_max between 1 and 5),
  reminders_scheduled integer not null default 0 check (reminders_scheduled between 0 and 5),
  next_reminder_at timestamptz,
  -- When every required item was last resolved while the request was active; null when not.
  ready_since timestamptz,
  cancel_reason text check (length(cancel_reason) <= 500),
  created_by uuid references public.profiles(id) on delete set null,
  creation_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, creation_request_id)
);
create index onboarding_requests_workspace on leadflow_private.onboarding_requests(workspace_id, status, created_at desc);
create index onboarding_requests_reminders on leadflow_private.onboarding_requests(next_reminder_at) where status = 'active' and next_reminder_at is not null;

create table leadflow_private.onboarding_items (
  workspace_id uuid not null,
  request_id uuid not null,
  id uuid not null default gen_random_uuid(),
  position integer not null check (position between 0 and 999),
  section text not null check (length(btrim(section)) between 1 and 60),
  title text not null check (length(btrim(title)) between 1 and 200),
  guidance text not null default '' check (length(guidance) <= 2000),
  kind text not null check (kind in ('text','choice','links','access')),
  options jsonb not null default '[]' check (jsonb_typeof(options) = 'array'),
  required boolean not null default true,
  due_date date,
  state text not null default 'not_started' check (state in ('not_started','submitted','changes_requested','accepted','not_required')),
  -- The client's last submitted response, and an unsubmitted draft the agency does not review.
  response jsonb check (octet_length(response::text) <= 12000),
  draft jsonb check (octet_length(draft::text) <= 12000),
  revision integer not null default 1 check (revision > 0),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  -- Shown to the client. Internal notes and waiver reasons are agency-only.
  client_feedback text not null default '' check (length(client_feedback) <= 2000),
  waive_reason text not null default '' check (length(waive_reason) <= 500),
  internal_note text not null default '' check (length(internal_note) <= 2000),
  primary key (request_id, id),
  foreign key (workspace_id, request_id) references leadflow_private.onboarding_requests(workspace_id, id) on delete cascade
);

create table leadflow_private.onboarding_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  request_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  -- shared: created by a member to send themselves; reminder: carried by one reminder email.
  purpose text not null check (purpose in ('shared','reminder')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  check (expires_at > created_at),
  foreign key (workspace_id, request_id) references leadflow_private.onboarding_requests(workspace_id, id) on delete cascade
);
create index onboarding_links_request on leadflow_private.onboarding_links(request_id);

create table leadflow_private.onboarding_reminders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  request_id uuid not null,
  sequence integer not null check (sequence between 1 and 5),
  status text not null default 'sending' check (status in ('pending','sending','accepted','failed','uncertain','cancelled')),
  recipient text not null,
  item_count integer not null check (item_count > 0),
  -- The composed email, including its link token. Cleared once the outcome is final.
  email jsonb,
  link_id uuid references leadflow_private.onboarding_links(id) on delete set null,
  attempts integer not null default 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  provider_id text,
  last_error text check (length(last_error) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per reminder number: scheduling the same reminder twice is impossible.
  unique (request_id, sequence),
  foreign key (workspace_id, request_id) references leadflow_private.onboarding_requests(workspace_id, id) on delete cascade
);
create index onboarding_reminders_ready on leadflow_private.onboarding_reminders(status, next_attempt_at);

-- Append-only: no function updates or deletes events.
create table leadflow_private.onboarding_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  request_id uuid not null,
  item_id uuid,
  actor_type text not null check (actor_type in ('member','client','system')),
  actor_id uuid references public.profiles(id) on delete set null,
  kind text not null check (kind ~ '^[a-z_]{1,40}$'),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4000),
  at timestamptz not null default now(),
  foreign key (workspace_id, request_id) references leadflow_private.onboarding_requests(workspace_id, id) on delete cascade
);
create index onboarding_events_request on leadflow_private.onboarding_events(request_id, at desc, id desc);

-- One handoff per request. A later project-management milestone attaches its project record to this ID.
create table leadflow_private.onboarding_handoffs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  request_id uuid not null unique,
  request_version integer not null,
  handed_off_by uuid references public.profiles(id) on delete set null,
  handed_off_at timestamptz not null default now(),
  note text not null default '' check (length(note) <= 2000),
  -- Required and optional items, their final states and accepted responses at the moment of handoff.
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  foreign key (workspace_id, request_id) references leadflow_private.onboarding_requests(workspace_id, id) on delete cascade
);

alter table leadflow_private.onboarding_templates enable row level security;
alter table leadflow_private.onboarding_template_items enable row level security;
alter table leadflow_private.onboarding_requests enable row level security;
alter table leadflow_private.onboarding_items enable row level security;
alter table leadflow_private.onboarding_links enable row level security;
alter table leadflow_private.onboarding_reminders enable row level security;
alter table leadflow_private.onboarding_events enable row level security;
alter table leadflow_private.onboarding_handoffs enable row level security;
revoke all on leadflow_private.onboarding_templates, leadflow_private.onboarding_template_items, leadflow_private.onboarding_requests,
  leadflow_private.onboarding_items, leadflow_private.onboarding_links, leadflow_private.onboarding_reminders,
  leadflow_private.onboarding_events, leadflow_private.onboarding_handoffs from public, anon, authenticated;
create trigger touch_updated_at before update on leadflow_private.onboarding_templates for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on leadflow_private.onboarding_requests for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on leadflow_private.onboarding_reminders for each row execute function leadflow_private.touch_updated_at();

-- Validation helpers. Messages are shown to people, so they say what to fix.
create function leadflow_private.onboarding_clean_text(raw text, label text, max_length integer, required boolean default false, single_line boolean default true)
returns text language plpgsql immutable set search_path = '' as $$
declare clean text := btrim(coalesce(raw, ''));
begin
  if required and clean = '' then raise exception '% is required.', label using errcode = '22023'; end if;
  if length(clean) > max_length then raise exception '% must be at most % characters.', label, max_length using errcode = '22023'; end if;
  if single_line and clean ~ '[[:cntrl:]]' then raise exception '% must be a single line.', label using errcode = '22023'; end if;
  if clean ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then raise exception '% contains unsupported characters.', label using errcode = '22023'; end if;
  return clean;
end $$;
create function leadflow_private.onboarding_clean_date(raw text, label text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if nullif(btrim(coalesce(raw, '')), '') is null then return null; end if;
  if raw !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '% must be a date (YYYY-MM-DD).', label using errcode = '22023'; end if;
  return raw::date;
exception when datetime_field_overflow or invalid_datetime_format then
  raise exception '% must be a valid calendar date.', label using errcode = '22023';
end $$;
-- A template or request item definition: section, title, guidance, kind, options, required, optional due date.
create function leadflow_private.onboarding_clean_item(item jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare item_kind text; raw_options jsonb; clean_options jsonb := '[]'; option_count integer;
begin
  if item is null or jsonb_typeof(item) <> 'object' then raise exception 'Each checklist item must be an object.' using errcode = '22023'; end if;
  item_kind := item->>'kind';
  if item_kind is null or item_kind not in ('text','choice','links','access') then raise exception 'Choose a type for each checklist item.' using errcode = '22023'; end if;
  if item ? 'required' and jsonb_typeof(item->'required') <> 'boolean' then raise exception 'Mark each item as required or optional.' using errcode = '22023'; end if;
  raw_options := coalesce(item->'options', '[]');
  if jsonb_typeof(raw_options) <> 'array' then raise exception 'Options must be a list.' using errcode = '22023'; end if;
  if item_kind = 'choice' then
    option_count := jsonb_array_length(raw_options);
    if option_count not between 2 and 20 then raise exception 'Choice items need 2 to 20 options.' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_array_elements(raw_options) o where jsonb_typeof(o) <> 'string') then raise exception 'Options must be text.' using errcode = '22023'; end if;
    select jsonb_agg(leadflow_private.onboarding_clean_text(o #>> '{}', 'Each option', 100, true) order by n) into clean_options from jsonb_array_elements(raw_options) with ordinality as e(o, n);
    if (select count(distinct lower(o #>> '{}')) from jsonb_array_elements(clean_options) o) <> option_count then
      raise exception 'Choice options must all be different.' using errcode = '22023';
    end if;
  end if;
  return jsonb_build_object(
    'section', coalesce(nullif(leadflow_private.onboarding_clean_text(item->>'section', 'Section', 60), ''), 'General'),
    'title', leadflow_private.onboarding_clean_text(item->>'title', 'Item title', 200, true),
    'guidance', leadflow_private.onboarding_clean_text(item->>'guidance', 'Guidance', 2000, false, false),
    'kind', item_kind, 'options', clean_options,
    'required', coalesce((item->>'required')::boolean, true),
    'dueDate', leadflow_private.onboarding_clean_date(item->>'dueDate', 'Item due date'));
end $$;
-- A client response for one item. Drafts may be incomplete; submissions must be complete.
create function leadflow_private.onboarding_clean_response(item_kind text, item_options jsonb, raw jsonb, for_submit boolean) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare note text; links jsonb := '[]'; link text;
begin
  if raw is null or jsonb_typeof(raw) <> 'object' or octet_length(raw::text) > 12000 then raise exception 'Enter a response of up to 12 KB.' using errcode = '22023'; end if;
  if raw ? 'note' and jsonb_typeof(raw->'note') <> 'string' then raise exception 'Notes must be text.' using errcode = '22023'; end if;
  note := leadflow_private.onboarding_clean_text(raw->>'note', 'Note', 1000, false, false);
  if item_kind = 'text' then
    if raw ? 'text' and jsonb_typeof(raw->'text') <> 'string' then raise exception 'Answers must be text.' using errcode = '22023'; end if;
    return jsonb_build_object('text', leadflow_private.onboarding_clean_text(raw->>'text', 'Your answer', 4000, for_submit, false));
  elsif item_kind = 'choice' then
    if raw ? 'choice' and jsonb_typeof(raw->'choice') <> 'string' then raise exception 'Choose one of the listed options.' using errcode = '22023'; end if;
    if nullif(raw->>'choice', '') is null then
      if for_submit then raise exception 'Choose one of the options.' using errcode = '22023'; end if;
    elsif not item_options ? (raw->>'choice') then raise exception 'Choose one of the listed options.' using errcode = '22023'; end if;
    return jsonb_build_object('choice', coalesce(raw->>'choice', ''), 'note', note);
  elsif item_kind = 'links' then
    if jsonb_typeof(coalesce(raw->'links', '[]')) <> 'array' or jsonb_array_length(coalesce(raw->'links', '[]')) > 10 then
      raise exception 'Add up to 10 links.' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(raw->'links', '[]')) l where jsonb_typeof(l) <> 'string') then raise exception 'Links must be text.' using errcode = '22023'; end if;
    for link in select btrim(l #>> '{}') from jsonb_array_elements(coalesce(raw->'links', '[]')) l where btrim(l #>> '{}') <> '' loop
      if length(link) > 500 or link !~* '^https?://[^[:space:]<>"]+$' then raise exception 'Each link must start with https:// or http:// and have no spaces.' using errcode = '22023'; end if;
      if link ~* '^https?://[^/?#]*@' then raise exception 'Remove usernames and passwords from links. Share access through the provider instead.' using errcode = '22023'; end if;
      links := links || to_jsonb(link);
    end loop;
    if for_submit and jsonb_array_length(links) = 0 then raise exception 'Add at least one link.' using errcode = '22023'; end if;
    return jsonb_build_object('links', links, 'note', note);
  elsif item_kind = 'access' then
    if raw ? 'granted' and jsonb_typeof(raw->'granted') <> 'boolean' then raise exception 'Say whether access has been granted.' using errcode = '22023'; end if;
    if for_submit and coalesce((raw->>'granted')::boolean, false) is not true then
      raise exception 'Confirm that you have granted access before submitting.' using errcode = '22023';
    end if;
    return jsonb_build_object('granted', coalesce((raw->>'granted')::boolean, false), 'note', note);
  end if;
  raise exception 'Unknown item type.' using errcode = '22023';
end $$;

-- Readiness is computed, never stored as a score: every unresolved required item is listed as a blocker.
-- Resolved means accepted, or marked not required by the agency with a reason.
create function leadflow_private.onboarding_readiness(target_request uuid) returns jsonb
language sql stable set search_path = '' as $$
  with request as (select * from leadflow_private.onboarding_requests where id = target_request),
  items as (select * from leadflow_private.onboarding_items where request_id = target_request),
  blockers as (select * from items where required and state not in ('accepted','not_required')),
  totals as (select count(*) filter (where required) as required_total,
      count(*) filter (where required and state = 'accepted') as required_accepted,
      count(*) filter (where required and state = 'not_required') as required_waived,
      count(*) filter (where not required) as optional_total,
      count(*) filter (where not required and state not in ('accepted','not_required')) as optional_open
    from items)
  select jsonb_build_object(
    'state', case r.status when 'draft' then 'not_open' when 'cancelled' then 'cancelled' when 'completed' then 'handed_off' when 'paused' then 'paused'
      else case when not exists (select 1 from blockers) then 'ready'
        when exists (select 1 from blockers where state in ('not_started','changes_requested')) then 'waiting_on_client'
        else 'awaiting_review' end end,
    'requirementsMet', not exists (select 1 from blockers),
    'requiredTotal', t.required_total, 'requiredAccepted', t.required_accepted, 'requiredWaived', t.required_waived,
    'optionalTotal', t.optional_total, 'optionalOutstanding', t.optional_open,
    'percent', case when t.required_total = 0 then 100 else floor(100.0 * (t.required_accepted + t.required_waived) / t.required_total)::integer end,
    'blockers', coalesce((select jsonb_agg(jsonb_build_object('itemId', b.id, 'title', b.title, 'state', b.state, 'kind', b.kind,
        'waitingOn', case when b.state = 'submitted' then 'agency' else 'client' end,
        'reason', case b.state
          when 'not_started' then 'Not yet provided by the client'
          when 'changes_requested' then 'Changes requested from the client'
          when 'submitted' then case when b.kind = 'access' then 'Client reports access granted; the agency has not confirmed it' else 'Submitted; waiting for agency review' end end)
        order by b.position) from blockers b), '[]'))
  from request r cross join totals t
$$;
create function leadflow_private.onboarding_event(target_request uuid, target_item uuid, actor_kind text, actor uuid, event_kind text, event_detail jsonb default '{}')
returns void language sql set search_path = '' as $$
  insert into leadflow_private.onboarding_events(workspace_id, request_id, item_id, actor_type, actor_id, kind, detail)
  select r.workspace_id, r.id, target_item, actor_kind, actor, event_kind, coalesce(event_detail, '{}') from leadflow_private.onboarding_requests r where r.id = target_request
$$;
-- Called with the request row locked after anything that can change readiness or reminder eligibility.
-- Records readiness transitions once and keeps next_reminder_at consistent with the stopping rules.
create function leadflow_private.refresh_onboarding(target_request uuid) returns void
language plpgsql set search_path = '' as $$
declare request leadflow_private.onboarding_requests; met boolean; client_open integer; link_ok boolean;
begin
  select * into request from leadflow_private.onboarding_requests where id = target_request;
  met := not exists (select 1 from leadflow_private.onboarding_items i where i.request_id = target_request and i.required and i.state not in ('accepted','not_required'));
  if request.status = 'active' and met and request.ready_since is null then
    update leadflow_private.onboarding_requests set ready_since = now() where id = target_request;
    perform leadflow_private.onboarding_event(target_request, null, 'system', null, 'became_ready', jsonb_build_object('requiredItems', (select count(*) from leadflow_private.onboarding_items i where i.request_id = target_request and i.required)));
  elsif not met and request.ready_since is not null and request.status in ('active','paused') then
    update leadflow_private.onboarding_requests set ready_since = null where id = target_request;
    perform leadflow_private.onboarding_event(target_request, null, 'system', null, 'readiness_lost', '{}');
  end if;
  select count(*) into client_open from leadflow_private.onboarding_items i where i.request_id = target_request and i.required and i.state in ('not_started','changes_requested');
  link_ok := exists (select 1 from leadflow_private.onboarding_links l where l.request_id = target_request and l.purpose = 'shared' and l.revoked_at is null and l.expires_at > now());
  if request.status = 'active' and request.reminder_interval_days is not null and request.contact_email is not null
    and request.reminders_scheduled < request.reminder_max and client_open > 0 and link_ok then
    update leadflow_private.onboarding_requests set next_reminder_at = now() + make_interval(days => request.reminder_interval_days)
      where id = target_request and next_reminder_at is null;
  else
    update leadflow_private.onboarding_requests set next_reminder_at = null where id = target_request and next_reminder_at is not null;
  end if;
end $$;
-- Stops queued reminders when a request is paused, cancelled or handed off, or its links are revoked.
-- A reminder already handed to the provider cannot be recalled; finish_onboarding_reminder records it truthfully.
create function leadflow_private.cancel_onboarding_reminders(target_request uuid, why text) returns integer
language plpgsql set search_path = '' as $$
declare stopped integer;
begin
  update leadflow_private.onboarding_reminders set status = 'cancelled', email = null, last_error = left(why, 200)
    where request_id = target_request and status in ('pending','sending');
  get diagnostics stopped = row_count;
  update leadflow_private.onboarding_links set revoked_at = now() where purpose = 'reminder' and revoked_at is null
    and id in (select m.link_id from leadflow_private.onboarding_reminders m where m.request_id = target_request and m.status = 'cancelled');
  return stopped;
end $$;
create function leadflow_private.lock_onboarding_request(target_workspace uuid, target_request uuid, expected_version integer)
returns leadflow_private.onboarding_requests language plpgsql set search_path = '' as $$
declare request leadflow_private.onboarding_requests;
begin
  select * into request from leadflow_private.onboarding_requests r where r.id = target_request and r.workspace_id = target_workspace for update;
  if not found then raise exception 'Onboarding request not found in this workspace.' using errcode = 'P0002'; end if;
  if expected_version is not null and request.version <> expected_version then
    raise exception 'This onboarding request was changed in another session. Reload it and try again.' using errcode = '40001';
  end if;
  return request;
end $$;
create function leadflow_private.require_open_onboarding(request leadflow_private.onboarding_requests) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if request.status in ('completed','cancelled') then
    raise exception 'This onboarding request is % and can no longer be changed.', case request.status when 'completed' then 'handed off' else 'cancelled' end using errcode = '55000';
  end if;
end $$;
-- Applies validated request details. Unknown keys are refused. Returns the names of changed fields.
create function leadflow_private.write_onboarding_details(target_request uuid, changes jsonb) returns text[]
language plpgsql set search_path = '' as $$
declare request leadflow_private.onboarding_requests; updated leadflow_private.onboarding_requests; unknown_key text; email text; owner uuid; lead text; changed text[] := '{}';
begin
  if changes is null or jsonb_typeof(changes) <> 'object' then raise exception 'Send the request details as an object.' using errcode = '22023'; end if;
  select k into unknown_key from jsonb_object_keys(changes) k where k not in ('title','clientName','contactName','contactEmail','serviceType','ownerId','startDate','targetKickoffDate','dueDate','leadId','clientInstructions','internalNote','reminderIntervalDays','reminderMax') limit 1;
  if unknown_key is not null then raise exception 'Unknown request field: %.', unknown_key using errcode = '22023'; end if;
  if exists (select 1 from jsonb_each(changes) e where e.key in ('reminderIntervalDays','reminderMax') and jsonb_typeof(e.value) not in ('number','null')) then
    raise exception 'Reminder settings must be numbers.' using errcode = '22023';
  end if;
  select * into request from leadflow_private.onboarding_requests where id = target_request;
  updated := request;
  if changes ? 'title' then updated.title := leadflow_private.onboarding_clean_text(changes->>'title', 'Project name', 150, true); end if;
  if changes ? 'clientName' then updated.client_name := leadflow_private.onboarding_clean_text(changes->>'clientName', 'Client name', 150, true); end if;
  if changes ? 'contactName' then updated.contact_name := leadflow_private.onboarding_clean_text(changes->>'contactName', 'Contact name', 150); end if;
  if changes ? 'contactEmail' then
    email := lower(leadflow_private.onboarding_clean_text(changes->>'contactEmail', 'Contact email', 254));
    if email <> '' and email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid contact email address.' using errcode = '22023'; end if;
    updated.contact_email := nullif(email, '');
  end if;
  if changes ? 'serviceType' then
    if not leadflow_private.is_onboarding_service(changes->>'serviceType') then raise exception 'Choose a service type.' using errcode = '22023'; end if;
    updated.service_type := changes->>'serviceType';
  end if;
  if changes ? 'ownerId' then
    if nullif(changes->>'ownerId', '') is null then updated.owner_id := null;
    else
      if changes->>'ownerId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Choose an owner from this workspace.' using errcode = '22023'; end if;
      owner := (changes->>'ownerId')::uuid;
      if not exists (select 1 from public.workspace_memberships m where m.workspace_id = request.workspace_id and m.user_id = owner) then
        raise exception 'Choose an owner from this workspace.' using errcode = '22023';
      end if;
      updated.owner_id := owner;
    end if;
  end if;
  if changes ? 'startDate' then updated.start_date := leadflow_private.onboarding_clean_date(changes->>'startDate', 'Start date'); end if;
  if changes ? 'targetKickoffDate' then updated.target_kickoff_date := leadflow_private.onboarding_clean_date(changes->>'targetKickoffDate', 'Target kickoff date'); end if;
  if changes ? 'dueDate' then updated.due_date := leadflow_private.onboarding_clean_date(changes->>'dueDate', 'Client inputs due date'); end if;
  if updated.start_date is not null and updated.target_kickoff_date is not null and updated.target_kickoff_date < updated.start_date then
    raise exception 'The target kickoff date cannot be before the start date.' using errcode = '22023';
  end if;
  if changes ? 'leadId' then
    lead := nullif(btrim(coalesce(changes->>'leadId', '')), '');
    -- Linking checks the lead exists in this workspace now; later snapshot edits may remove it.
    if lead is not null and not exists (select 1 from public.leads l where l.workspace_id = request.workspace_id and l.id = lead) then
      raise exception 'That lead is not in this workspace.' using errcode = '22023';
    end if;
    updated.lead_id := lead;
  end if;
  if changes ? 'clientInstructions' then updated.client_instructions := leadflow_private.onboarding_clean_text(changes->>'clientInstructions', 'Instructions for the client', 4000, false, false); end if;
  if changes ? 'internalNote' then updated.internal_note := leadflow_private.onboarding_clean_text(changes->>'internalNote', 'Internal note', 4000, false, false); end if;
  if changes ? 'reminderIntervalDays' then
    if changes->'reminderIntervalDays' <> 'null' and ((changes->>'reminderIntervalDays')::numeric not between 2 and 14 or (changes->>'reminderIntervalDays')::numeric % 1 <> 0) then
      raise exception 'Reminders can be sent every 2 to 14 days.' using errcode = '22023';
    end if;
    updated.reminder_interval_days := (changes->>'reminderIntervalDays')::integer;
  end if;
  if changes ? 'reminderMax' then
    if changes->'reminderMax' = 'null' or (changes->>'reminderMax')::numeric not between 1 and 5 or (changes->>'reminderMax')::numeric % 1 <> 0 then
      raise exception 'Send between 1 and 5 reminders.' using errcode = '22023';
    end if;
    updated.reminder_max := (changes->>'reminderMax')::integer;
  end if;
  select array_agg(field order by field) into changed from (values
    ('title', updated.title is distinct from request.title), ('clientName', updated.client_name is distinct from request.client_name),
    ('contactName', updated.contact_name is distinct from request.contact_name), ('contactEmail', updated.contact_email is distinct from request.contact_email),
    ('serviceType', updated.service_type is distinct from request.service_type), ('ownerId', updated.owner_id is distinct from request.owner_id),
    ('startDate', updated.start_date is distinct from request.start_date), ('targetKickoffDate', updated.target_kickoff_date is distinct from request.target_kickoff_date),
    ('dueDate', updated.due_date is distinct from request.due_date), ('leadId', updated.lead_id is distinct from request.lead_id),
    ('clientInstructions', updated.client_instructions is distinct from request.client_instructions), ('internalNote', updated.internal_note is distinct from request.internal_note),
    ('reminderIntervalDays', updated.reminder_interval_days is distinct from request.reminder_interval_days), ('reminderMax', updated.reminder_max is distinct from request.reminder_max)) as c(field, differs)
  where differs;
  update leadflow_private.onboarding_requests set title = updated.title, client_name = updated.client_name, contact_name = updated.contact_name, contact_email = updated.contact_email,
    service_type = updated.service_type, owner_id = updated.owner_id, start_date = updated.start_date, target_kickoff_date = updated.target_kickoff_date, due_date = updated.due_date,
    lead_id = updated.lead_id, client_instructions = updated.client_instructions, internal_note = updated.internal_note,
    reminder_interval_days = updated.reminder_interval_days, reminder_max = updated.reminder_max,
    -- Changed reminder settings or recipient restart the interval from now.
    next_reminder_at = case when updated.reminder_interval_days is distinct from request.reminder_interval_days or updated.reminder_max is distinct from request.reminder_max
      or updated.contact_email is distinct from request.contact_email then null else request.next_reminder_at end
    where id = target_request;
  return coalesce(changed, '{}');
end $$;

-- Starter templates: the common requirements followed by service-specific ones. Agencies edit their copies.
create function leadflow_private.onboarding_starter_items(service text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_array(
    jsonb_build_object('section','Business','title','Business overview and goals','kind','text','required',true,'guidance','Describe what you sell, who you sell to, and what you want this engagement to achieve in the first 90 days.'),
    jsonb_build_object('section','Business','title','Main point of contact and approver','kind','text','required',true,'guidance','Name, role and email of the person we work with day to day, and of the person who approves campaigns and spend if different.'),
    jsonb_build_object('section','Business','title','Target audience and geographic market','kind','text','required',true,'guidance','Who your best customers are, and the countries, regions or cities we should target or avoid.'),
    jsonb_build_object('section','Brand','title','Brand guidelines and logo files','kind','links','required',true,'guidance','Links to your brand guidelines, logos and fonts in your own storage (for example Google Drive, Dropbox or OneDrive). Make sure the links are shared with us.'),
    jsonb_build_object('section','Brand','title','Website and other relevant resources','kind','links','required',true,'guidance','Your website and any pages, documents or examples we should know about.'),
    jsonb_build_object('section','Working together','title','Communication and approval preferences','kind','choice','required',true,'options',jsonb_build_array('Email','Shared Slack or Teams channel','Scheduled video calls','Our project management tool'),'guidance','How you prefer to receive updates and approve work. Add anything else in the note.'))
  || case service
    when 'paid_ads' then jsonb_build_array(
      jsonb_build_object('section','Advertising','title','Advertising objectives','kind','text','required',true,'guidance','What success looks like: leads, sales, bookings or awareness, and any target cost per result.'),
      jsonb_build_object('section','Advertising','title','Monthly budget and campaign priorities','kind','text','required',true,'guidance','Monthly media budget, how it should be split between platforms or products, and which campaigns come first.'),
      jsonb_build_object('section','Access','title','Ad account access (Google Ads and/or Meta)','kind','access','required',true,'guidance','Grant access using the platform''s own sharing: add our team as a user or link our manager account in Google Ads, and assign our business as a partner in Meta Business Suite. Never send passwords. We will confirm once access works.'),
      jsonb_build_object('section','Access','title','Conversion tracking and analytics access','kind','access','required',true,'guidance','Add our email as a user in Google Analytics (Admin → property access management) and, if used, Google Tag Manager. Never send passwords.'),
      jsonb_build_object('section','Assets','title','Existing campaigns and performance references','kind','links','required',false,'guidance','Past reports, exports or screenshots of campaign performance, if you have them.'),
      jsonb_build_object('section','Assets','title','Landing pages and creative assets','kind','links','required',true,'guidance','Landing page URLs and links to images, videos and ad copy we can use.'))
    when 'seo' then jsonb_build_array(
      jsonb_build_object('section','SEO','title','Target services, locations and keywords','kind','text','required',true,'guidance','The services and locations that matter most, and any keywords you already track.'),
      jsonb_build_object('section','Access','title','Website and analytics access','kind','access','required',true,'guidance','Invite our team as a user in your website platform and in Google Analytics using their own user-management screens. Never send passwords.'),
      jsonb_build_object('section','Access','title','Google Search Console access','kind','access','required',true,'guidance','In Search Console, open Settings → Users and permissions and add our email. Never send passwords.'),
      jsonb_build_object('section','SEO','title','Existing SEO reports or baseline data','kind','links','required',false,'guidance','Previous audits, rank reports or exports, if any.'),
      jsonb_build_object('section','SEO','title','Priority pages and competitors','kind','text','required',true,'guidance','The pages that matter most to your business and the competitors you compare yourself with.'))
    when 'social' then jsonb_build_array(
      jsonb_build_object('section','Social','title','Platforms and profiles in scope','kind','text','required',true,'guidance','Which platforms we will manage, with links to each profile.'),
      jsonb_build_object('section','Social','title','Content goals','kind','text','required',true,'guidance','What the content should achieve and any themes, products or messages to focus on.'),
      jsonb_build_object('section','Social','title','Posting frequency','kind','choice','required',true,'options',jsonb_build_array('1–2 posts per week','3–4 posts per week','Daily','Not sure yet'),'guidance','How often you expect us to post. Add platform-specific needs in the note.'),
      jsonb_build_object('section','Social','title','Brand voice and content guidelines','kind','text','required',true,'guidance','How your brand sounds, words or topics to avoid, and anything that needs legal or compliance review.'),
      jsonb_build_object('section','Assets','title','Content assets and upcoming campaigns','kind','links','required',false,'guidance','Photos, videos and dates of launches or events we should plan around.'),
      jsonb_build_object('section','Access','title','Account access and approval process','kind','access','required',true,'guidance','Grant access through each platform''s business tools (for example Meta Business Suite partners or LinkedIn Page admins). Never send passwords. Note who approves posts in the note.'))
    when 'email' then jsonb_build_array(
      jsonb_build_object('section','Access','title','Email platform and account access','kind','access','required',true,'guidance','Invite our team as a user from your email platform''s team or user settings. Never send passwords or API keys.'),
      jsonb_build_object('section','Email','title','Audience lists and consent requirements','kind','text','required',true,'guidance','Describe your lists or segments and how subscribers gave consent. Do not upload or paste subscriber data here.'),
      jsonb_build_object('section','Email','title','Existing campaigns and performance references','kind','links','required',false,'guidance','Recent campaigns or reports, if available.'),
      jsonb_build_object('section','Email','title','Brand templates and campaign goals','kind','text','required',true,'guidance','Links or notes about existing templates, and what the email programme should achieve.'),
      jsonb_build_object('section','Email','title','Approval and sending requirements','kind','text','required',true,'guidance','Who approves each send, sending times or days to avoid, and any legal footer requirements.'))
    else '[]'::jsonb end
$$;

-- Signed-in members. Every function checks the caller's role in the database; a workspace ID only selects.
-- Members manage requests; owners and admins also manage templates and can cancel requests.
create function public.onboarding_overview_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb; today date;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select (now() at time zone s.timezone)::date into today from public.workspace_settings s where s.workspace_id = target_workspace;
  select jsonb_build_object('today', today,
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', coalesce(nullif(p.display_name, ''), u.email::text, 'Member')) order by coalesce(nullif(p.display_name, ''), u.email::text))
      from public.workspace_memberships m join public.profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id where m.workspace_id = target_workspace), '[]'),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'serviceType', t.service_type, 'description', t.description, 'starterKey', t.starter_key,
        'archived', t.archived, 'version', t.version, 'updatedAt', t.updated_at,
        'itemCount', (select count(*) from leadflow_private.onboarding_template_items ti where ti.template_id = t.id),
        'requiredCount', (select count(*) from leadflow_private.onboarding_template_items ti where ti.template_id = t.id and ti.required)) order by t.archived, t.name)
      from leadflow_private.onboarding_templates t where t.workspace_id = target_workspace), '[]'),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'clientName', r.client_name, 'serviceType', r.service_type,
        'ownerId', r.owner_id, 'status', r.status, 'version', r.version, 'startDate', r.start_date, 'targetKickoffDate', r.target_kickoff_date, 'dueDate', r.due_date,
        'createdAt', r.created_at, 'updatedAt', r.updated_at, 'readySince', r.ready_since, 'nextReminderAt', r.next_reminder_at,
        'hasActiveLink', exists (select 1 from leadflow_private.onboarding_links l where l.request_id = r.id and l.purpose = 'shared' and l.revoked_at is null and l.expires_at > now()),
        'counts', (select jsonb_build_object('total', count(*),
            'requiredOutstanding', count(*) filter (where i.required and i.state not in ('accepted','not_required')),
            'awaitingReview', count(*) filter (where i.state = 'submitted'),
            'changesRequested', count(*) filter (where i.state = 'changes_requested'),
            'overdue', count(*) filter (where i.required and i.state not in ('accepted','not_required') and coalesce(i.due_date, r.due_date) < today))
          from leadflow_private.onboarding_items i where i.request_id = r.id),
        'readiness', leadflow_private.onboarding_readiness(r.id)) order by r.created_at desc, r.id)
      from leadflow_private.onboarding_requests r where r.workspace_id = target_workspace), '[]'))
  into result;
  return result;
end $$;

create function public.onboarding_request_for(target_workspace uuid, target_request uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; result jsonb; today date; client_open integer; link_ok boolean;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into request from leadflow_private.onboarding_requests r where r.id = target_request and r.workspace_id = target_workspace;
  if not found then raise exception 'Onboarding request not found in this workspace.' using errcode = 'P0002'; end if;
  select (now() at time zone s.timezone)::date into today from public.workspace_settings s where s.workspace_id = target_workspace;
  select count(*) into client_open from leadflow_private.onboarding_items i where i.request_id = request.id and i.required and i.state in ('not_started','changes_requested');
  link_ok := exists (select 1 from leadflow_private.onboarding_links l where l.request_id = request.id and l.purpose = 'shared' and l.revoked_at is null and l.expires_at > now());
  select jsonb_build_object('id', request.id, 'title', request.title, 'clientName', request.client_name, 'contactName', request.contact_name, 'contactEmail', request.contact_email,
    'serviceType', request.service_type, 'ownerId', request.owner_id, 'status', request.status, 'version', request.version,
    'startDate', request.start_date, 'targetKickoffDate', request.target_kickoff_date, 'dueDate', request.due_date, 'today', today,
    'templateId', request.template_id, 'templateName', request.template_name, 'leadId', request.lead_id,
    'leadExists', request.lead_id is not null and exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = request.lead_id),
    'clientInstructions', request.client_instructions, 'internalNote', request.internal_note, 'cancelReason', request.cancel_reason,
    'createdAt', request.created_at, 'updatedAt', request.updated_at, 'activatedAt', request.activated_at, 'completedAt', request.completed_at, 'cancelledAt', request.cancelled_at,
    'readySince', request.ready_since, 'readiness', leadflow_private.onboarding_readiness(request.id),
    'reminders', jsonb_build_object('intervalDays', request.reminder_interval_days, 'max', request.reminder_max, 'scheduled', request.reminders_scheduled, 'nextAt', request.next_reminder_at,
      'blockedBy', case when request.status <> 'active' then 'not_active' when request.reminder_interval_days is null then 'disabled'
        when request.contact_email is null then 'no_email' when request.reminders_scheduled >= request.reminder_max then 'max_reached'
        when client_open = 0 then 'nothing_outstanding' when not link_ok then 'no_link' end,
      'history', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'sequence', m.sequence, 'status', m.status, 'recipient', m.recipient, 'itemCount', m.item_count,
          'attempts', m.attempts, 'createdAt', m.created_at, 'updatedAt', m.updated_at, 'lastError', m.last_error) order by m.sequence)
        from leadflow_private.onboarding_reminders m where m.request_id = request.id), '[]')),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'position', i.position, 'section', i.section, 'title', i.title, 'guidance', i.guidance, 'kind', i.kind,
        'options', i.options, 'required', i.required, 'dueDate', i.due_date, 'state', i.state, 'response', i.response, 'hasDraft', i.draft is not null,
        'revision', i.revision, 'submittedAt', i.submitted_at, 'reviewedAt', i.reviewed_at, 'clientFeedback', i.client_feedback, 'waiveReason', i.waive_reason,
        'internalNote', i.internal_note, 'overdue', i.required and i.state not in ('accepted','not_required') and coalesce(i.due_date, request.due_date) < today) order by i.position)
      from leadflow_private.onboarding_items i where i.request_id = request.id), '[]'),
    'links', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'purpose', l.purpose, 'createdAt', l.created_at, 'expiresAt', l.expires_at, 'revokedAt', l.revoked_at,
        'lastUsedAt', l.last_used_at, 'active', l.revoked_at is null and l.expires_at > now()) order by l.created_at desc)
      from leadflow_private.onboarding_links l where l.request_id = request.id), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'actorType', e.actor_type,
        'actorName', case e.actor_type when 'member' then coalesce(nullif(p.display_name, ''), u.email::text, 'Former member') when 'client' then 'Client' else 'LeadFlow' end,
        'itemId', e.item_id, 'itemTitle', i.title, 'detail', e.detail, 'at', e.at) order by e.at desc, e.id desc)
      from (select * from leadflow_private.onboarding_events where request_id = request.id order by at desc, id desc limit 300) e
      left join public.profiles p on p.id = e.actor_id left join auth.users u on u.id = e.actor_id
      left join leadflow_private.onboarding_items i on i.request_id = e.request_id and i.id = e.item_id), '[]'),
    'handoff', (select jsonb_build_object('id', h.id, 'handedOffAt', h.handed_off_at, 'note', h.note, 'requestVersion', h.request_version,
        'handedOffBy', coalesce(nullif(p.display_name, ''), u.email::text, 'Former member'))
      from leadflow_private.onboarding_handoffs h left join public.profiles p on p.id = h.handed_off_by left join auth.users u on u.id = h.handed_off_by where h.request_id = request.id))
  into result;
  return result;
end $$;

create function public.onboarding_template_for(target_workspace uuid, target_template uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select jsonb_build_object('id', t.id, 'name', t.name, 'serviceType', t.service_type, 'description', t.description, 'starterKey', t.starter_key, 'archived', t.archived, 'version', t.version,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', ti.id, 'section', ti.section, 'title', ti.title, 'guidance', ti.guidance, 'kind', ti.kind, 'options', ti.options, 'required', ti.required) order by ti.position)
      from leadflow_private.onboarding_template_items ti where ti.template_id = t.id), '[]'))
  into result from leadflow_private.onboarding_templates t where t.id = target_template and t.workspace_id = target_workspace;
  if result is null then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
  return result;
end $$;

-- Owners and admins. Adds whichever of the four starter templates the workspace does not have yet.
create function public.install_starter_templates(target_workspace uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare added integer := 0; starter record; created uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  for starter in select * from (values ('paid_ads','Paid advertising onboarding','Ad account access, tracking, budget and creative needed before the first campaign.'),
      ('seo','SEO onboarding','Access, keywords, priority pages and baseline data needed before SEO work starts.'),
      ('social','Social media management onboarding','Profiles, content goals, brand voice and access needed before the first posts.'),
      ('email','Email marketing onboarding','Platform access, audience consent, templates and approvals needed before the first send.')) as s(key, name, description)
  loop
    insert into leadflow_private.onboarding_templates(workspace_id, name, service_type, description, starter_key)
      values (target_workspace, starter.name, starter.key, starter.description, starter.key) on conflict (workspace_id, starter_key) do nothing returning id into created;
    if created is not null then
      insert into leadflow_private.onboarding_template_items(workspace_id, template_id, position, section, title, guidance, kind, options, required)
        select target_workspace, created, (n - 1)::integer, c->>'section', c->>'title', c->>'guidance', c->>'kind', c->'options', (c->>'required')::boolean
        from jsonb_array_elements(leadflow_private.onboarding_starter_items(starter.key)) with ordinality as e(raw, n)
        cross join lateral (select leadflow_private.onboarding_clean_item(e.raw) as c) cleaned;
      added := added + 1;
    end if;
    created := null;
  end loop;
  return added;
end $$;

-- Owners and admins. Without an ID, creates a template (idempotent per request_id); with one, replaces its
-- details and items if expected_version matches. Requests already created keep their own copies.
create function public.save_onboarding_template(target_workspace uuid, definition jsonb, expected_version integer default null, request_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing leadflow_private.onboarding_templates; target uuid; clean_name text; clean_description text; items jsonb; item_count integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if definition is null or jsonb_typeof(definition) <> 'object' then raise exception 'Send the template as an object.' using errcode = '22023'; end if;
  clean_name := leadflow_private.onboarding_clean_text(definition->>'name', 'Template name', 100, true);
  clean_description := leadflow_private.onboarding_clean_text(definition->>'description', 'Description', 1000, false, false);
  if not leadflow_private.is_onboarding_service(definition->>'serviceType') then raise exception 'Choose a service type.' using errcode = '22023'; end if;
  if jsonb_typeof(definition->'items') is distinct from 'array' then raise exception 'Add the template''s checklist items.' using errcode = '22023'; end if;
  item_count := jsonb_array_length(definition->'items');
  if item_count not between 1 and 100 then raise exception 'A template needs 1 to 100 items.' using errcode = '22023'; end if;
  select jsonb_agg(leadflow_private.onboarding_clean_item(raw) order by n) into items from jsonb_array_elements(definition->'items') with ordinality as e(raw, n);
  if nullif(definition->>'id', '') is null then
    if request_id is not null then
      select * into existing from leadflow_private.onboarding_templates t where t.workspace_id = target_workspace and t.creation_request_id = save_onboarding_template.request_id;
      if found then
        if existing.name <> clean_name then raise exception 'This request already created a different template.' using errcode = '23505'; end if;
        return jsonb_build_object('id', existing.id, 'version', existing.version);
      end if;
    end if;
    if (select count(*) from leadflow_private.onboarding_templates t where t.workspace_id = target_workspace) >= 50 then
      raise exception 'A workspace can have at most 50 templates. Archive or reuse one instead.' using errcode = '54000';
    end if;
    insert into leadflow_private.onboarding_templates(workspace_id, name, service_type, description, creation_request_id)
      values (target_workspace, clean_name, definition->>'serviceType', clean_description, request_id) returning * into existing;
  else
    if definition->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
    target := (definition->>'id')::uuid;
    select * into existing from leadflow_private.onboarding_templates t where t.id = target and t.workspace_id = target_workspace for update;
    if not found then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
    if expected_version is null or existing.version <> expected_version then
      raise exception 'This template was changed in another session. Reload it and try again.' using errcode = '40001';
    end if;
    update leadflow_private.onboarding_templates set name = clean_name, service_type = definition->>'serviceType', description = clean_description, version = version + 1
      where id = target returning * into existing;
    delete from leadflow_private.onboarding_template_items where template_id = target;
  end if;
  insert into leadflow_private.onboarding_template_items(workspace_id, template_id, position, section, title, guidance, kind, options, required)
    select target_workspace, existing.id, (n - 1)::integer, c->>'section', c->>'title', c->>'guidance', c->>'kind', c->'options', (c->>'required')::boolean
    from jsonb_array_elements(items) with ordinality as e(c, n);
  return jsonb_build_object('id', existing.id, 'version', existing.version);
end $$;
create function public.set_onboarding_template_archived(target_workspace uuid, target_template uuid, archive boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  update leadflow_private.onboarding_templates set archived = coalesce(archive, archived), version = version + 1 where id = target_template and workspace_id = target_workspace;
  if not found then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
end $$;

-- Any member. Copies the template's items, so later template edits never change this request.
-- Retrying with the same request_id returns the request it already created.
create function public.create_onboarding_request(target_workspace uuid, details jsonb, request_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := leadflow_private.valid_actor(); existing leadflow_private.onboarding_requests; source leadflow_private.onboarding_templates; created uuid := gen_random_uuid(); template_ref uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if request_id is null then raise exception 'Missing request identity.' using errcode = '22023'; end if;
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the request details as an object.' using errcode = '22023'; end if;
  select * into existing from leadflow_private.onboarding_requests r where r.workspace_id = target_workspace and r.creation_request_id = create_onboarding_request.request_id;
  if found then
    if existing.title <> leadflow_private.onboarding_clean_text(details->>'title', 'Project name', 150, true) then
      raise exception 'This request already created a different onboarding request.' using errcode = '23505';
    end if;
    return existing.id;
  end if;
  if (select count(*) from leadflow_private.onboarding_requests r where r.workspace_id = target_workspace) >= 1000 then
    raise exception 'A workspace can have at most 1,000 onboarding requests.' using errcode = '54000';
  end if;
  if nullif(details->>'templateId', '') is not null then
    if details->>'templateId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
    template_ref := (details->>'templateId')::uuid;
    select * into source from leadflow_private.onboarding_templates t where t.id = template_ref and t.workspace_id = target_workspace and not t.archived;
    if not found then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
  end if;
  insert into leadflow_private.onboarding_requests(id, workspace_id, title, client_name, service_type, template_id, template_name, created_by, owner_id, creation_request_id)
    values (created, target_workspace, leadflow_private.onboarding_clean_text(details->>'title', 'Project name', 150, true),
      leadflow_private.onboarding_clean_text(details->>'clientName', 'Client name', 150, true), coalesce(source.service_type, 'other'),
      source.id, source.name, actor, actor, request_id);
  perform leadflow_private.write_onboarding_details(created, details - 'templateId');
  insert into leadflow_private.onboarding_items(workspace_id, request_id, position, section, title, guidance, kind, options, required)
    select target_workspace, created, ti.position, ti.section, ti.title, ti.guidance, ti.kind, ti.options, ti.required
    from leadflow_private.onboarding_template_items ti where ti.template_id = source.id;
  perform leadflow_private.onboarding_event(created, null, 'member', actor, 'created',
    jsonb_build_object('template', source.name, 'items', (select count(*) from leadflow_private.onboarding_items i where i.request_id = created)));
  return created;
end $$;

-- Any member, while the request is not handed off or cancelled.
create function public.update_onboarding_request(target_workspace uuid, target_request uuid, changes jsonb, expected_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; changed text[];
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, expected_version);
  perform leadflow_private.require_open_onboarding(request);
  changed := leadflow_private.write_onboarding_details(target_request, changes);
  if cardinality(changed) = 0 then return request.version; end if;
  update leadflow_private.onboarding_requests set version = version + 1 where id = target_request;
  perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(),
    case when changed <@ array['reminderIntervalDays','reminderMax'] then 'reminders_updated' else 'details_updated' end, jsonb_build_object('fields', to_jsonb(changed)));
  perform leadflow_private.refresh_onboarding(target_request);
  return request.version + 1;
end $$;

-- Any member. Adds an item (no id) or edits one. The type and options of an item the client has already
-- answered cannot change; mark it not required and add a new item instead.
create function public.save_onboarding_item(target_workspace uuid, target_request uuid, item jsonb, expected_version integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; clean jsonb; existing leadflow_private.onboarding_items; target uuid; internal text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, expected_version);
  perform leadflow_private.require_open_onboarding(request);
  clean := leadflow_private.onboarding_clean_item(item);
  internal := leadflow_private.onboarding_clean_text(item->>'internalNote', 'Internal note', 2000, false, false);
  if nullif(item->>'id', '') is null then
    if (select count(*) from leadflow_private.onboarding_items i where i.request_id = target_request) >= 100 then
      raise exception 'A request can have at most 100 items.' using errcode = '54000';
    end if;
    insert into leadflow_private.onboarding_items(workspace_id, request_id, position, section, title, guidance, kind, options, required, due_date, internal_note)
      values (target_workspace, target_request, coalesce((select max(i.position) + 1 from leadflow_private.onboarding_items i where i.request_id = target_request), 0),
        clean->>'section', clean->>'title', clean->>'guidance', clean->>'kind', clean->'options', (clean->>'required')::boolean, (clean->>'dueDate')::date, internal)
      returning id into target;
    perform leadflow_private.onboarding_event(target_request, target, 'member', leadflow_private.valid_actor(), 'item_added', jsonb_build_object('title', clean->>'title', 'required', clean->'required'));
  else
    if item->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Item not found in this request.' using errcode = 'P0002'; end if;
    target := (item->>'id')::uuid;
    select * into existing from leadflow_private.onboarding_items i where i.request_id = target_request and i.id = target for update;
    if not found then raise exception 'Item not found in this request.' using errcode = 'P0002'; end if;
    if (existing.response is not null or existing.draft is not null) and (existing.kind <> clean->>'kind' or existing.options <> clean->'options') then
      raise exception 'The client has already answered this item, so its type and options cannot change. Mark it not required and add a new item instead.' using errcode = '55000';
    end if;
    update leadflow_private.onboarding_items set section = clean->>'section', title = clean->>'title', guidance = clean->>'guidance', kind = clean->>'kind', options = clean->'options',
      required = (clean->>'required')::boolean, due_date = (clean->>'dueDate')::date, internal_note = internal, revision = revision + 1
      where request_id = target_request and id = target;
    perform leadflow_private.onboarding_event(target_request, target, 'member', leadflow_private.valid_actor(), 'item_updated',
      jsonb_build_object('title', clean->>'title', 'required', clean->'required', 'requiredChanged', existing.required <> (clean->>'required')::boolean));
  end if;
  update leadflow_private.onboarding_requests set version = version + 1 where id = target_request;
  perform leadflow_private.refresh_onboarding(target_request);
  return target;
end $$;
-- Any member, for items the client has not submitted. Submitted items are marked not required instead,
-- so their history stays visible.
create function public.remove_onboarding_item(target_workspace uuid, target_request uuid, target_item uuid, expected_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; existing leadflow_private.onboarding_items;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, expected_version);
  perform leadflow_private.require_open_onboarding(request);
  select * into existing from leadflow_private.onboarding_items i where i.request_id = target_request and i.id = target_item for update;
  if not found then raise exception 'Item not found in this request.' using errcode = 'P0002'; end if;
  if existing.response is not null then
    raise exception 'The client has submitted this item. Mark it not required instead of removing it.' using errcode = '55000';
  end if;
  delete from leadflow_private.onboarding_items where request_id = target_request and id = target_item;
  update leadflow_private.onboarding_requests set version = version + 1 where id = target_request;
  perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(), 'item_removed', jsonb_build_object('title', existing.title));
  perform leadflow_private.refresh_onboarding(target_request);
end $$;

-- Lifecycle: draft → active; active ⇄ paused; draft, active or paused → cancelled (owners and admins).
-- Handing off (hand_off_onboarding) is the only way to complete. Repeating a transition already made is a no-op.
create function public.set_onboarding_status(target_workspace uuid, target_request uuid, transition text, expected_version integer, reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text; request leadflow_private.onboarding_requests; target_status text; clean_reason text; allowed text[];
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  target_status := case transition when 'activate' then 'active' when 'resume' then 'active' when 'pause' then 'paused' when 'cancel' then 'cancelled' end;
  if target_status is null then raise exception 'Unknown status change.' using errcode = '22023'; end if;
  if transition = 'cancel' and actor_role = 'member' then raise exception 'Only workspace owners and admins can cancel onboarding requests.' using errcode = '42501'; end if;
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, null);
  allowed := case transition when 'activate' then array['draft'] when 'resume' then array['paused'] when 'pause' then array['active'] else array['draft','active','paused'] end;
  -- A retried change whose first attempt succeeded returns the current state.
  if request.status = target_status then return jsonb_build_object('status', request.status, 'version', request.version); end if;
  if expected_version is null or request.version <> expected_version then
    raise exception 'This onboarding request was changed in another session. Reload it and try again.' using errcode = '40001';
  end if;
  if not request.status = any(allowed) then
    raise exception 'A % request cannot be %.', case request.status when 'completed' then 'handed-off' else request.status end,
      case transition when 'activate' then 'opened' when 'resume' then 'resumed' when 'pause' then 'paused' else 'cancelled' end using errcode = '55000';
  end if;
  if transition = 'activate' and not exists (select 1 from leadflow_private.onboarding_items i where i.request_id = target_request) then
    raise exception 'Add at least one checklist item before opening the request.' using errcode = '55000';
  end if;
  clean_reason := nullif(leadflow_private.onboarding_clean_text(reason, 'Reason', 500, false, false), '');
  update leadflow_private.onboarding_requests set status = target_status, version = version + 1,
    activated_at = case when transition = 'activate' then now() else activated_at end,
    cancelled_at = case when transition = 'cancel' then now() else cancelled_at end,
    cancel_reason = case when transition = 'cancel' then clean_reason else cancel_reason end,
    -- Resuming restarts the reminder interval rather than sending immediately.
    next_reminder_at = null
    where id = target_request returning * into request;
  if transition in ('pause','cancel') then
    perform leadflow_private.cancel_onboarding_reminders(target_request, case transition when 'pause' then 'Stopped: request paused' else 'Stopped: request cancelled' end);
  end if;
  perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(),
    case transition when 'activate' then 'activated' when 'resume' then 'resumed' when 'pause' then 'paused' else 'cancelled' end,
    case when clean_reason is null then '{}'::jsonb else jsonb_build_object('reason', clean_reason) end);
  perform leadflow_private.refresh_onboarding(target_request);
  select * into request from leadflow_private.onboarding_requests where id = target_request;
  return jsonb_build_object('status', request.status, 'version', request.version);
end $$;

-- Any member. accept (comment required when the client has not submitted), request_changes (comment
-- required, shown to the client), not_required (reason required, agency-only), restore (undo not_required).
-- expected_revision is the item revision the reviewer saw, so a newer client submission is never reviewed blind.
create function public.review_onboarding_item(target_workspace uuid, target_request uuid, target_item uuid, decision text, review_note text, expected_revision integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; item leadflow_private.onboarding_items; clean text; next_state text; event_kind text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, null);
  perform leadflow_private.require_open_onboarding(request);
  select * into item from leadflow_private.onboarding_items i where i.request_id = target_request and i.id = target_item for update;
  if not found then raise exception 'Item not found in this request.' using errcode = 'P0002'; end if;
  if expected_revision is null or item.revision <> expected_revision then
    raise exception 'This item changed since you opened it, for example the client resubmitted it. Reload and review the latest version.' using errcode = '40001';
  end if;
  clean := leadflow_private.onboarding_clean_text(review_note, case decision when 'not_required' then 'Reason' else 'Comment' end, case decision when 'not_required' then 500 else 2000 end, false, false);
  if decision = 'accept' then
    if item.state = 'accepted' then raise exception 'This item is already accepted.' using errcode = '55000'; end if;
    if item.state = 'not_required' then raise exception 'Restore this item before accepting it.' using errcode = '55000'; end if;
    if item.state <> 'submitted' and clean = '' then
      raise exception 'Explain why you are accepting an item the client has not submitted, for example that access is already in place.' using errcode = '22023';
    end if;
    next_state := 'accepted'; event_kind := 'accepted';
  elsif decision = 'request_changes' then
    if item.state not in ('submitted','accepted') then raise exception 'Only submitted or accepted items can be sent back to the client.' using errcode = '55000'; end if;
    if clean = '' then raise exception 'Tell the client what to change.' using errcode = '22023'; end if;
    next_state := 'changes_requested'; event_kind := 'changes_requested';
  elsif decision = 'not_required' then
    if item.state = 'not_required' then raise exception 'This item is already marked not required.' using errcode = '55000'; end if;
    if clean = '' then raise exception 'Give a reason for marking this item not required.' using errcode = '22023'; end if;
    next_state := 'not_required'; event_kind := 'marked_not_required';
  elsif decision = 'restore' then
    if item.state <> 'not_required' then raise exception 'Only items marked not required can be restored.' using errcode = '55000'; end if;
    next_state := case when item.response is not null then 'submitted' else 'not_started' end; event_kind := 'restored';
  else
    raise exception 'Unknown review decision.' using errcode = '22023';
  end if;
  update leadflow_private.onboarding_items set state = next_state, revision = revision + 1, reviewed_at = now(), reviewed_by = leadflow_private.valid_actor(),
    client_feedback = case when decision in ('accept','request_changes') then clean when decision = 'not_required' then '' else client_feedback end,
    waive_reason = case when decision = 'not_required' then clean when decision = 'restore' then '' else waive_reason end
    where request_id = target_request and id = target_item returning * into item;
  perform leadflow_private.onboarding_event(target_request, target_item, 'member', leadflow_private.valid_actor(), event_kind,
    jsonb_strip_nulls(jsonb_build_object('comment', nullif(clean, ''), 'withoutSubmission', case when decision = 'accept' and item.submitted_at is null then true end, 'kind', item.kind)));
  perform leadflow_private.refresh_onboarding(target_request);
  return jsonb_build_object('state', item.state, 'revision', item.revision);
end $$;

-- Any member, while the request is not handed off or cancelled. Returns the token once; only its hash is
-- stored. replace_existing revokes every earlier link for the request, including reminder links.
create function public.issue_onboarding_link(target_workspace uuid, target_request uuid, expires_in_days integer default 30, replace_existing boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; token text; link leadflow_private.onboarding_links; revoked integer := 0;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, null);
  perform leadflow_private.require_open_onboarding(request);
  if expires_in_days is null or expires_in_days not between 1 and 90 then raise exception 'Links can last 1 to 90 days.' using errcode = '22023'; end if;
  if replace_existing then
    update leadflow_private.onboarding_links set revoked_at = now() where request_id = target_request and revoked_at is null;
    get diagnostics revoked = row_count;
    perform leadflow_private.cancel_onboarding_reminders(target_request, 'Stopped: link replaced');
  end if;
  if (select count(*) from leadflow_private.onboarding_links l where l.request_id = target_request and l.revoked_at is null and l.expires_at > now()) >= 20 then
    raise exception 'This request has too many active links. Replace them instead.' using errcode = '54000';
  end if;
  -- Two version-4 UUIDs from the server's cryptographic random generator: 244 random bits.
  token := 'lf_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into leadflow_private.onboarding_links(workspace_id, request_id, token_hash, purpose, created_by, expires_at)
    values (target_workspace, target_request, encode(sha256(convert_to(token, 'UTF8')), 'hex'), 'shared', leadflow_private.valid_actor(), now() + make_interval(days => expires_in_days))
    returning * into link;
  perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(), 'link_issued',
    jsonb_build_object('expiresAt', link.expires_at, 'replacedLinks', revoked));
  perform leadflow_private.refresh_onboarding(target_request);
  return jsonb_build_object('linkId', link.id, 'token', token, 'expiresAt', link.expires_at);
end $$;
-- Any member. Revokes one link, or every link of the request when target_link is null. Works on any status.
create function public.revoke_onboarding_links(target_workspace uuid, target_request uuid, target_link uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare revoked integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  perform leadflow_private.lock_onboarding_request(target_workspace, target_request, null);
  update leadflow_private.onboarding_links set revoked_at = now() where request_id = target_request and revoked_at is null and (target_link is null or id = target_link);
  get diagnostics revoked = row_count;
  if revoked > 0 then
    update leadflow_private.onboarding_reminders set status = 'cancelled', email = null, last_error = 'Stopped: link revoked'
      where request_id = target_request and status in ('pending','sending') and (target_link is null or link_id = target_link);
    perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(), 'links_revoked', jsonb_build_object('count', revoked));
    perform leadflow_private.refresh_onboarding(target_request);
  end if;
  return revoked;
end $$;

-- Any member. Records the delivery handoff once, only for an active request whose required items are all
-- accepted or marked not required. Repeating it returns the original handoff. Nothing external is triggered.
create function public.hand_off_onboarding(target_workspace uuid, target_request uuid, note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; existing leadflow_private.onboarding_handoffs; readiness jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, null);
  select * into existing from leadflow_private.onboarding_handoffs h where h.request_id = target_request;
  if found then return jsonb_build_object('id', existing.id, 'handedOffAt', existing.handed_off_at, 'repeated', true); end if;
  if request.status <> 'active' then
    raise exception 'Only an open request can be handed off. This request is %.', case request.status when 'draft' then 'not open yet' else request.status end using errcode = '55000';
  end if;
  readiness := leadflow_private.onboarding_readiness(target_request);
  if not (readiness->>'requirementsMet')::boolean then
    raise exception 'Not ready: % required item(s) are still outstanding.', jsonb_array_length(readiness->'blockers') using errcode = '55000';
  end if;
  insert into leadflow_private.onboarding_handoffs(workspace_id, request_id, request_version, handed_off_by, note, summary)
    values (target_workspace, target_request, request.version + 1, leadflow_private.valid_actor(), leadflow_private.onboarding_clean_text(note, 'Handoff note', 2000, false, false),
      jsonb_build_object('title', request.title, 'clientName', request.client_name, 'serviceType', request.service_type, 'targetKickoffDate', request.target_kickoff_date,
        'leadId', request.lead_id, 'readiness', readiness,
        'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'required', i.required, 'state', i.state,
          'response', case when i.state = 'accepted' then i.response end, 'reason', nullif(i.waive_reason, '')) order by i.position)
          from leadflow_private.onboarding_items i where i.request_id = target_request), '[]')))
    returning * into existing;
  update leadflow_private.onboarding_requests set status = 'completed', completed_at = now(), version = version + 1, next_reminder_at = null where id = target_request;
  perform leadflow_private.cancel_onboarding_reminders(target_request, 'Stopped: handed off');
  perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(), 'handed_off', jsonb_build_object('handoffId', existing.id));
  return jsonb_build_object('id', existing.id, 'handedOffAt', existing.handed_off_at, 'repeated', false);
end $$;

-- Client portal (service role only, called by the client-portal Edge Function with the token's SHA-256).
-- Unknown, revoked and expired links all get the same error, so links cannot be probed. The client sees
-- only this request's client-facing fields: never internal notes, waiver reasons, members or other records.
create function leadflow_private.portal_link(key_hash text) returns leadflow_private.onboarding_links
language plpgsql set search_path = '' as $$
declare link leadflow_private.onboarding_links;
begin
  select * into link from leadflow_private.onboarding_links l where l.token_hash = key_hash and l.revoked_at is null and l.expires_at > now();
  if not found then raise exception 'This link is not valid.' using errcode = 'P0002'; end if;
  return link;
end $$;
create function leadflow_private.portal_view(target_request uuid, link leadflow_private.onboarding_links) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('agencyName', w.name, 'title', r.title, 'clientName', r.client_name, 'status', r.status,
    'linkExpiresAt', link.expires_at,
    'instructions', case when r.status in ('active','paused','completed') then r.client_instructions else '' end,
    'dueDate', case when r.status in ('active','paused') then r.due_date end,
    'allAccepted', (leadflow_private.onboarding_readiness(r.id)->>'requirementsMet')::boolean and r.status in ('active','completed'),
    'confirmedAt', r.completed_at,
    'items', case when r.status in ('active','paused','completed') then coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'section', i.section, 'title', i.title,
        'guidance', i.guidance, 'kind', i.kind, 'options', i.options, 'required', i.required, 'dueDate', coalesce(i.due_date, r.due_date), 'state', i.state,
        'value', coalesce(i.draft, i.response), 'hasDraft', i.draft is not null, 'submittedAt', i.submitted_at, 'revision', i.revision,
        'feedback', case when i.state in ('changes_requested','accepted') then nullif(i.client_feedback, '') end) order by i.position)
      from leadflow_private.onboarding_items i where i.request_id = r.id), '[]') else '[]'::jsonb end)
  from leadflow_private.onboarding_requests r join public.workspaces w on w.id = r.workspace_id where r.id = target_request
$$;
create function public.portal_open(key_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare link leadflow_private.onboarding_links;
begin
  link := leadflow_private.portal_link(key_hash);
  update leadflow_private.onboarding_links set last_used_at = now() where id = link.id and (last_used_at is null or last_used_at < now() - interval '5 minutes');
  return leadflow_private.portal_view(link.request_id, link);
end $$;
-- Saves a draft (submit = false) or submits an item for review. Accepted and not-required items are locked.
-- Repeating an identical save after a lost response succeeds without changing anything.
create function public.portal_save_item(key_hash text, target_item uuid, response_value jsonb, submit boolean, expected_revision integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare link leadflow_private.onboarding_links; request leadflow_private.onboarding_requests; item leadflow_private.onboarding_items; clean jsonb; previous_state text;
begin
  link := leadflow_private.portal_link(key_hash);
  select * into request from leadflow_private.onboarding_requests r where r.id = link.request_id for update;
  if request.status <> 'active' then raise exception 'This onboarding request is not accepting responses right now.' using errcode = '55000'; end if;
  select * into item from leadflow_private.onboarding_items i where i.request_id = link.request_id and i.id = target_item for update;
  if not found then raise exception 'This item is no longer part of the request.' using errcode = '22023'; end if;
  if item.state in ('accepted','not_required') then raise exception 'This item has already been accepted or is no longer needed.' using errcode = '55000'; end if;
  clean := leadflow_private.onboarding_clean_response(item.kind, item.options, response_value, coalesce(submit, false));
  if coalesce(submit, false) and item.state = 'submitted' and item.response = clean and item.draft is null then
    return jsonb_build_object('state', item.state, 'revision', item.revision, 'unchanged', true);
  end if;
  if not coalesce(submit, false) and item.draft = clean then
    return jsonb_build_object('state', item.state, 'revision', item.revision, 'unchanged', true);
  end if;
  if expected_revision is null or item.revision <> expected_revision then
    raise exception 'This item was updated elsewhere. Reload the page to see the latest version.' using errcode = '40001';
  end if;
  previous_state := item.state;
  if coalesce(submit, false) then
    update leadflow_private.onboarding_items set response = clean, draft = null, state = 'submitted', submitted_at = now(), revision = revision + 1
      where request_id = link.request_id and id = target_item returning * into item;
    perform leadflow_private.onboarding_event(link.request_id, target_item, 'client', null, case previous_state when 'not_started' then 'submitted' else 'resubmitted' end, jsonb_build_object('kind', item.kind));
    perform leadflow_private.refresh_onboarding(link.request_id);
  else
    update leadflow_private.onboarding_items set draft = clean, revision = revision + 1 where request_id = link.request_id and id = target_item returning * into item;
  end if;
  update leadflow_private.onboarding_links set last_used_at = now() where id = link.id;
  return jsonb_build_object('state', item.state, 'revision', item.revision, 'unchanged', false);
end $$;

-- Reminder worker (service role only, called by the onboarding-reminders Edge Function on a schedule).
-- Each call returns one job: a retry of a reminder whose lease expired, or a newly scheduled reminder.
-- Rechecks every stopping rule before sending: active status, outstanding client items, a recipient,
-- an unexpired unrevoked link, and the per-request maximum. Returns {skipped:true} when it stopped one.
create function public.claim_onboarding_reminder(portal_url text, sender text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare reminder leadflow_private.onboarding_reminders; request leadflow_private.onboarding_requests; open_items jsonb; why text; token text; link_expiry timestamptz; new_link uuid; next_sequence integer;
begin
  if portal_url is null or length(portal_url) > 300 or portal_url !~ '^https?://[^[:space:]#?]+$' then raise exception 'Invalid portal URL.' using errcode = '22023'; end if;
  if sender is null or length(sender) not between 3 and 200 or sender ~ '[\r\n]' then raise exception 'Invalid notification sender.' using errcode = '22023'; end if;
  -- Resend deduplicates for 24 hours. Stop before that window ends if the outcome is still unknown.
  with expired as (update leadflow_private.onboarding_reminders set status = 'uncertain', email = null,
      last_error = 'Retry window expired; check the provider before sending again.'
    where status in ('pending','sending') and first_attempt_at < now() - interval '23 hours' returning request_id, sequence)
  insert into leadflow_private.onboarding_events(workspace_id, request_id, actor_type, kind, detail)
    select r.workspace_id, r.id, 'system', 'reminder_uncertain', jsonb_build_object('sequence', e.sequence) from expired e join leadflow_private.onboarding_requests r on r.id = e.request_id;

  select * into reminder from leadflow_private.onboarding_reminders m where m.status in ('pending','sending') and m.next_attempt_at <= now()
    order by m.next_attempt_at for update skip locked limit 1;
  if found then
    -- Never wait for the request row: a member pausing it holds that lock and then needs this reminder's.
    select * into request from leadflow_private.onboarding_requests r where r.id = reminder.request_id for update skip locked;
    if not found then return jsonb_build_object('skipped', true, 'busy', true); end if;
    why := case when request.status <> 'active' then 'Stopped: request is ' || request.status
      when not exists (select 1 from leadflow_private.onboarding_items i where i.request_id = request.id and i.required and i.state in ('not_started','changes_requested')) then 'Stopped: nothing outstanding'
      when not exists (select 1 from leadflow_private.onboarding_links l where l.id = reminder.link_id and l.revoked_at is null and l.expires_at > now()) then 'Stopped: link revoked or expired' end;
    if why is not null then
      update leadflow_private.onboarding_reminders set status = 'cancelled', email = null, last_error = why where id = reminder.id;
      update leadflow_private.onboarding_links set revoked_at = coalesce(revoked_at, now()) where id = reminder.link_id;
      perform leadflow_private.onboarding_event(request.id, null, 'system', null, 'reminder_stopped', jsonb_build_object('sequence', reminder.sequence, 'reason', why));
      return jsonb_build_object('skipped', true);
    end if;
    update leadflow_private.onboarding_reminders set status = 'sending', attempts = attempts + 1, first_attempt_at = coalesce(first_attempt_at, now()),
      next_attempt_at = now() + interval '2 minutes', lease_id = gen_random_uuid() where id = reminder.id returning * into reminder;
    return jsonb_build_object('id', reminder.id, 'lease_id', reminder.lease_id, 'email', reminder.email);
  end if;

  select * into request from leadflow_private.onboarding_requests r where r.status = 'active' and r.next_reminder_at <= now()
    order by r.next_reminder_at for update skip locked limit 1;
  if not found then return null; end if;
  select jsonb_agg(i.title order by i.position) into open_items from leadflow_private.onboarding_items i
    where i.request_id = request.id and i.required and i.state in ('not_started','changes_requested');
  select max(l.expires_at) into link_expiry from leadflow_private.onboarding_links l where l.request_id = request.id and l.purpose = 'shared' and l.revoked_at is null and l.expires_at > now() + interval '1 hour';
  why := case when request.reminder_interval_days is null then 'disabled' when request.contact_email is null then 'no recipient'
    when request.reminders_scheduled >= request.reminder_max then 'maximum reached' when open_items is null then 'nothing outstanding'
    when link_expiry is null then 'no unexpired client link' end;
  if why is not null then
    update leadflow_private.onboarding_requests set next_reminder_at = null where id = request.id;
    perform leadflow_private.onboarding_event(request.id, null, 'system', null, 'reminder_skipped', jsonb_build_object('reason', why));
    return jsonb_build_object('skipped', true);
  end if;
  next_sequence := request.reminders_scheduled + 1;
  token := 'lf_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into leadflow_private.onboarding_links(workspace_id, request_id, token_hash, purpose, expires_at)
    values (request.workspace_id, request.id, encode(sha256(convert_to(token, 'UTF8')), 'hex'), 'reminder', link_expiry) returning id into new_link;
  insert into leadflow_private.onboarding_reminders(workspace_id, request_id, sequence, status, recipient, item_count, link_id, attempts, first_attempt_at, next_attempt_at, lease_id, email)
    values (request.workspace_id, request.id, next_sequence, 'sending', request.contact_email, jsonb_array_length(open_items), new_link, 1, now(), now() + interval '2 minutes', gen_random_uuid(),
      jsonb_build_object('from', sender, 'to', jsonb_build_array(request.contact_email),
        'subject', format('Reminder: %s item%s needed for %s', jsonb_array_length(open_items), case when jsonb_array_length(open_items) = 1 then '' else 's' end, request.title),
        'text', format(E'Hello%s,\n\n%s is waiting for the following before work on "%s" can start:\n\n%s\n\nOpen your onboarding checklist to add them:\n%s#%s\n\nThis link is private to you and expires on %s. Please never send passwords or API keys; share account access through each platform''s own permission settings.\n\nIf you have already sent these, you can ignore this email.',
          coalesce(' ' || nullif(request.contact_name, ''), ''), (select w.name from public.workspaces w where w.id = request.workspace_id), request.title,
          (select string_agg('- ' || t, E'\n') from (select jsonb_array_elements_text(open_items) t limit 15) x)
            || case when jsonb_array_length(open_items) > 15 then format(E'\n- and %s more', jsonb_array_length(open_items) - 15) else '' end,
          portal_url, token, to_char(link_expiry at time zone 'UTC', 'DD Mon YYYY'))))
    on conflict on constraint onboarding_reminders_request_id_sequence_key do nothing
    returning * into reminder;
  if reminder.id is null then return jsonb_build_object('skipped', true); end if;
  update leadflow_private.onboarding_requests set reminders_scheduled = next_sequence,
    next_reminder_at = case when next_sequence < reminder_max then now() + make_interval(days => reminder_interval_days) end where id = request.id;
  perform leadflow_private.onboarding_event(request.id, null, 'system', null, 'reminder_queued', jsonb_build_object('sequence', next_sequence, 'items', jsonb_array_length(open_items)));
  return jsonb_build_object('id', reminder.id, 'lease_id', reminder.lease_id, 'email', reminder.email);
end $$;
-- Only the current lease holder can record an outcome. A reminder cancelled while its email was already with
-- the provider is recorded as accepted if the provider accepted it, because it may have been delivered.
create function public.finish_onboarding_reminder(reminder_id uuid, lease uuid, outcome text, provider_reference text default null, failure_code text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare reminder leadflow_private.onboarding_reminders;
begin
  if outcome not in ('accepted','pending','failed') then raise exception 'Invalid reminder outcome.' using errcode = '22023'; end if;
  update leadflow_private.onboarding_reminders set status = case when status = 'cancelled' and outcome <> 'accepted' then 'cancelled' else outcome end,
    provider_id = provider_reference, last_error = case when status = 'cancelled' and outcome = 'accepted' then 'Accepted by the provider after the request stopped' else left(failure_code, 200) end,
    email = case when outcome = 'pending' and status = 'sending' then email end,
    next_attempt_at = now() + make_interval(secs => least(3600, 60 * power(2, least(attempts, 6)))::integer)
    where id = reminder_id and lease_id = lease and (status = 'sending' or (status = 'cancelled' and outcome = 'accepted')) returning * into reminder;
  if not found then return; end if;
  if reminder.status = 'failed' then update leadflow_private.onboarding_links set revoked_at = coalesce(revoked_at, now()) where id = reminder.link_id; end if;
  if reminder.status in ('accepted','failed') then
    perform leadflow_private.onboarding_event(reminder.request_id, null, 'system', null, case reminder.status when 'accepted' then 'reminder_sent' else 'reminder_failed' end,
      jsonb_strip_nulls(jsonb_build_object('sequence', reminder.sequence, 'error', reminder.last_error)));
  end if;
end $$;

-- Supabase grants new public functions to anon and authenticated by default; restate every grant.
revoke all on function leadflow_private.is_onboarding_service(text), leadflow_private.onboarding_clean_text(text, text, integer, boolean, boolean),
  leadflow_private.onboarding_clean_date(text, text), leadflow_private.onboarding_clean_item(jsonb), leadflow_private.onboarding_clean_response(text, jsonb, jsonb, boolean),
  leadflow_private.onboarding_readiness(uuid), leadflow_private.onboarding_event(uuid, uuid, text, uuid, text, jsonb), leadflow_private.refresh_onboarding(uuid),
  leadflow_private.cancel_onboarding_reminders(uuid, text), leadflow_private.lock_onboarding_request(uuid, uuid, integer),
  leadflow_private.require_open_onboarding(leadflow_private.onboarding_requests), leadflow_private.write_onboarding_details(uuid, jsonb),
  leadflow_private.onboarding_starter_items(text), leadflow_private.portal_link(text), leadflow_private.portal_view(uuid, leadflow_private.onboarding_links)
  from public, anon, authenticated;
revoke all on function public.onboarding_overview_for(uuid), public.onboarding_request_for(uuid, uuid), public.onboarding_template_for(uuid, uuid),
  public.install_starter_templates(uuid), public.save_onboarding_template(uuid, jsonb, integer, uuid), public.set_onboarding_template_archived(uuid, uuid, boolean),
  public.create_onboarding_request(uuid, jsonb, uuid), public.update_onboarding_request(uuid, uuid, jsonb, integer),
  public.save_onboarding_item(uuid, uuid, jsonb, integer), public.remove_onboarding_item(uuid, uuid, uuid, integer),
  public.set_onboarding_status(uuid, uuid, text, integer, text), public.review_onboarding_item(uuid, uuid, uuid, text, text, integer),
  public.issue_onboarding_link(uuid, uuid, integer, boolean), public.revoke_onboarding_links(uuid, uuid, uuid), public.hand_off_onboarding(uuid, uuid, text),
  public.portal_open(text), public.portal_save_item(text, uuid, jsonb, boolean, integer),
  public.claim_onboarding_reminder(text, text), public.finish_onboarding_reminder(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.onboarding_overview_for(uuid), public.onboarding_request_for(uuid, uuid), public.onboarding_template_for(uuid, uuid),
  public.install_starter_templates(uuid), public.save_onboarding_template(uuid, jsonb, integer, uuid), public.set_onboarding_template_archived(uuid, uuid, boolean),
  public.create_onboarding_request(uuid, jsonb, uuid), public.update_onboarding_request(uuid, uuid, jsonb, integer),
  public.save_onboarding_item(uuid, uuid, jsonb, integer), public.remove_onboarding_item(uuid, uuid, uuid, integer),
  public.set_onboarding_status(uuid, uuid, text, integer, text), public.review_onboarding_item(uuid, uuid, uuid, text, text, integer),
  public.issue_onboarding_link(uuid, uuid, integer, boolean), public.revoke_onboarding_links(uuid, uuid, uuid), public.hand_off_onboarding(uuid, uuid, text)
  to authenticated;
grant execute on function public.portal_open(text), public.portal_save_item(text, uuid, jsonb, boolean, integer),
  public.claim_onboarding_reminder(text, text), public.finish_onboarding_reminder(uuid, uuid, text, text, text) to service_role;
