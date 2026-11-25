-- M10 client onboarding and client management. Builds on M6A onboarding (templates, requests, checklist items, client
-- links and portal, readiness, handoff) and M9 deals, instead of adding a second onboarding or task system.
-- * Clients: one record per client relationship, with its own status (onboarding, active, paused, completed, archived),
--   separate from onboarding progress. A won deal converts once (unique per deal), keeping the lead, the deal, its M9
--   handoff and their history untouched. Contacts, agreed services, requirements, scope confirmations, documents, notes
--   and an activity history belong to the client.
-- * Onboarding: M6A requests become each client's onboarding instances (onboarding_requests.client_id). Workspace-level
--   stages group the work; checklist items gain more field types (email, phone, URL, number, date, multiple choice,
--   checkbox, file upload, headings and instructions), a stage and settings. Internal agency steps live in their own
--   tables, so the client portal and reminder emails never see them. Every client submission is kept.
-- * Forms: reusable groups of fields that are copied into templates or a client's onboarding, like M6A templates.
-- * Documents: files in a private Supabase Storage bucket, uploaded and downloaded only through short-lived signed URLs
--   that the client-files and client-portal Edge Functions create after checking access here.
-- * Tasks: the existing follow-up tasks can belong to a client (and an onboarding request or item) instead of a lead.
-- * Completion: an explicit, checked (or overridden with a reason) onboarding completion with the snapshot M11 needs.
-- Every new table is private; members act through role-checked functions, clients through service-role portal functions.
-- Reverse with supabase/rollbacks/202611250001_client_management.down.sql.

-- ---------- Workspace onboarding stages ----------

create table leadflow_private.onboarding_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The default stage it came from, so starter templates can place items after renames.
  key text check (key in ('created','welcome','business_info','requirements','access_assets','scope','final_review','completed')),
  name text not null check (length(btrim(name)) between 1 and 60),
  description text not null default '' check (length(description) <= 500),
  position integer not null check (position between 0 and 1000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index onboarding_stages_name on leadflow_private.onboarding_stages(workspace_id, lower(btrim(name))) where archived_at is null;
create unique index onboarding_stages_key on leadflow_private.onboarding_stages(workspace_id, key) where key is not null;

-- ---------- Clients ----------

create table leadflow_private.clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 150),
  logo_url text not null default '' check (logo_url = '' or (length(logo_url) <= 500 and logo_url ~* '^https://[^[:space:]@]+$')),
  website text not null default '' check (website = '' or (length(website) <= 300 and website ~* '^https?://[^[:space:]@]+$')),
  industry text not null default '' check (length(industry) <= 100),
  description text not null default '' check (length(description) <= 4000),
  address text not null default '' check (length(address) <= 300),
  city text not null default '' check (length(city) <= 100),
  region text not null default '' check (length(region) <= 100),
  postcode text not null default '' check (length(postcode) <= 20),
  country text not null default '' check (country = '' or country ~ '^[A-Z]{2}$'),
  timezone text not null default '' check (length(timezone) <= 64),
  status text not null default 'onboarding' check (status in ('onboarding','active','paused','completed','archived')),
  -- The status before archiving, restored by unarchiving.
  previous_status text check (previous_status in ('onboarding','active','paused','completed')),
  owner_id uuid references public.profiles(id) on delete set null,
  -- No foreign key to leads: snapshot saves replace them. The client keeps its own business details.
  lead_id text check (length(lead_id) between 1 and 200),
  deal_id uuid references leadflow_private.deals(id) on delete set null,
  deal_handoff_id uuid references leadflow_private.client_handoffs(id) on delete set null,
  -- The deal as it was when converted (title, values, stage, close date) and any eligibility override.
  conversion jsonb not null default '{}' check (jsonb_typeof(conversion) = 'object' and octet_length(conversion::text) <= 8000),
  internal_notes text not null default '' check (length(internal_notes) <= 8000),
  -- [{ label, date }]: kickoff, renewal, launch…
  important_dates jsonb not null default '[]' check (jsonb_typeof(important_dates) = 'array' and octet_length(important_dates::text) <= 4000),
  welcome_subject text not null default '' check (length(welcome_subject) <= 200),
  welcome_body text not null default '' check (length(welcome_body) <= 8000),
  welcome_updated_at timestamptz,
  welcome_sent_at timestamptz,
  welcome_sent_by uuid references public.profiles(id) on delete set null,
  welcome_channel text check (welcome_channel in ('email','whatsapp','phone','meeting','other')),
  version integer not null default 1 check (version > 0),
  status_changed_at timestamptz not null default now(),
  converted_at timestamptz,
  converted_by uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, request_id)
);
-- One client per deal, whoever converts it and however often the request is repeated.
create unique index clients_deal on leadflow_private.clients(deal_id) where deal_id is not null;
create index clients_directory on leadflow_private.clients(workspace_id, status, created_at desc);
create index clients_name on leadflow_private.clients(workspace_id, lower(name));
create index clients_lead on leadflow_private.clients(workspace_id, lead_id) where lead_id is not null;

create table leadflow_private.client_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id uuid not null,
  -- The M8 lead contact it was copied from, kept for provenance; the client's copy is edited independently.
  source_contact_id uuid references leadflow_private.lead_contacts(id) on delete set null,
  full_name text not null check (length(btrim(full_name)) between 1 and 150),
  job_title text not null default '' check (length(job_title) <= 150),
  role text not null default 'project' check (role in ('decision_maker','project','billing','technical','marketing','operations','other')),
  email text not null default '' check (email = '' or (length(email) <= 254 and email = lower(email) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  phone text not null default '' check (length(phone) <= 40),
  preferred_channel text not null default 'email' check (preferred_channel in ('email','phone','whatsapp','video','any')),
  notes text not null default '' check (length(notes) <= 2000),
  is_primary boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, client_id) references leadflow_private.clients(workspace_id, id) on delete cascade
);
create index client_contacts_client on leadflow_private.client_contacts(client_id, created_at);
create unique index client_contacts_primary on leadflow_private.client_contacts(client_id) where is_primary;

-- Services agreed with the client. Only services confirmed in the won deal's conversion or approved during onboarding are
-- confirmed; the catalog itself is never assumed to be purchased.
create table leadflow_private.client_services (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id uuid not null,
  service_id uuid references leadflow_private.agency_services(id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 1000),
  agreed_scope text not null default '' check (length(agreed_scope) <= 4000),
  deliverables text not null default '' check (length(deliverables) <= 4000),
  exclusions text not null default '' check (length(exclusions) <= 4000),
  notes text not null default '' check (length(notes) <= 2000),
  status text not null default 'proposed' check (status in ('proposed','confirmed','removed')),
  source text not null default 'manual' check (source in ('deal','onboarding','manual')),
  position integer not null default 0,
  version integer not null default 1,
  confirmed_at timestamptz,
  confirmed_by uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, client_id) references leadflow_private.clients(workspace_id, id) on delete cascade,
  check ((status = 'confirmed') = (confirmed_at is not null))
);
create unique index client_services_name on leadflow_private.client_services(client_id, lower(btrim(name))) where status <> 'removed';

create table leadflow_private.client_requirements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id uuid not null,
  request_id uuid,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '' check (length(description) <= 4000),
  category text not null check (category in ('objective','goal','functional','technical','design','integration','constraint','dependency','assumption','expectation','success_criteria')),
  priority text not null default 'medium' check (priority in ('low','medium','high','critical')),
  status text not null default 'draft' check (status in ('draft','under_review','confirmed','deferred','rejected')),
  -- Where it came from. client_form links to the onboarding answer it was taken from.
  source text not null default 'internal' check (source in ('client_form','client_meeting','deal','internal','other')),
  source_request_id uuid,
  source_item_id uuid,
  client_service_id uuid,
  notes text not null default '' check (length(notes) <= 2000),
  version integer not null default 1,
  confirmed_at timestamptz,
  confirmed_by uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, request_id),
  foreign key (workspace_id, client_id) references leadflow_private.clients(workspace_id, id) on delete cascade,
  foreign key (workspace_id, client_service_id) references leadflow_private.client_services(workspace_id, id) on delete set null (client_service_id),
  check ((status = 'confirmed') = (confirmed_at is not null))
);
create index client_requirements_client on leadflow_private.client_requirements(client_id, status, created_at);

-- Every version of every requirement, so changes after review stay visible.
create table leadflow_private.client_requirement_revisions (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requirement_id uuid not null references leadflow_private.client_requirements(id) on delete cascade,
  version integer not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now(),
  unique (requirement_id, version)
);

-- A confirmation of the agreed scope at a point in time. A newer one supersedes it; none is ever edited.
create table leadflow_private.client_scope_confirmations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id uuid not null,
  sequence integer not null check (sequence > 0),
  -- Confirmed services, confirmed requirements, dependencies, exclusions and expectations as they were.
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 200000),
  outstanding_questions text not null default '' check (length(outstanding_questions) <= 4000),
  notes text not null default '' check (length(notes) <= 2000),
  shared_with_client boolean not null default true,
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz not null default now(),
  superseded_at timestamptz,
  -- Set when the client opens their private link and acknowledges this scope. Not a contract or signature.
  client_acknowledged_at timestamptz,
  client_acknowledged_link uuid references leadflow_private.onboarding_links(id) on delete set null,
  unique (client_id, sequence),
  foreign key (workspace_id, client_id) references leadflow_private.clients(workspace_id, id) on delete cascade
);

create table leadflow_private.client_activities (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  client_id uuid not null,
  kind text not null check (kind ~ '^[a-z_]{1,40}$'),
  summary text not null check (length(summary) between 1 and 300),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 8000),
  actor_type text not null default 'member' check (actor_type in ('member','client','system')),
  actor_id uuid references public.profiles(id) on delete set null,
  entity_type text check (entity_type ~ '^[a-z_]{1,30}$'),
  entity_id text check (length(entity_id) <= 100),
  at timestamptz not null default now(),
  request_id uuid,
  foreign key (workspace_id, client_id) references leadflow_private.clients(workspace_id, id) on delete cascade
);
create index client_activities_client on leadflow_private.client_activities(client_id, at desc, id desc);
create unique index client_activities_request on leadflow_private.client_activities(workspace_id, request_id) where request_id is not null;

-- The structured handoff to project delivery (M11). One per client, created by an explicit completion.
create table leadflow_private.client_onboarding_completions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id uuid not null unique,
  completed_by uuid references public.profiles(id) on delete set null,
  completed_at timestamptz not null default now(),
  note text not null default '' check (length(note) <= 2000),
  -- Set only when an owner or admin completed it with requirements still outstanding, and what those were.
  override_reason text check (length(btrim(override_reason)) between 1 and 1000),
  outstanding jsonb not null default '[]' check (jsonb_typeof(outstanding) = 'array'),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 500000),
  foreign key (workspace_id, client_id) references leadflow_private.clients(workspace_id, id) on delete cascade
);

-- ---------- Onboarding (M6A) extensions ----------

alter table leadflow_private.onboarding_requests
  add column client_id uuid,
  add constraint onboarding_requests_client foreign key (workspace_id, client_id) references leadflow_private.clients(workspace_id, id) on delete set null (client_id);
create index onboarding_requests_client on leadflow_private.onboarding_requests(workspace_id, client_id) where client_id is not null;

-- Reusable forms: groups of fields copied into templates or a client's onboarding, never shared live.
create table leadflow_private.onboarding_forms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  description text not null default '' check (length(description) <= 1000),
  archived boolean not null default false,
  version integer not null default 1 check (version > 0),
  creation_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, creation_request_id)
);
create unique index onboarding_forms_name on leadflow_private.onboarding_forms(workspace_id, lower(btrim(name))) where not archived;

-- The field kinds shared by template items, form fields and request items. heading and info are display-only.
create function leadflow_private.is_onboarding_kind(candidate text) returns boolean language sql immutable set search_path = '' as $$
  select candidate in ('text','short_text','email','phone','url','number','date','choice','multi_choice','checkbox','links','access','file','heading','info')
$$;
create table leadflow_private.onboarding_form_fields (
  workspace_id uuid not null,
  form_id uuid not null,
  id uuid not null default gen_random_uuid(),
  position integer not null check (position between 0 and 199),
  section text not null check (length(btrim(section)) between 1 and 60),
  title text not null check (length(btrim(title)) between 1 and 200),
  guidance text not null default '' check (length(guidance) <= 2000),
  kind text not null check (leadflow_private.is_onboarding_kind(kind)),
  options jsonb not null default '[]' check (jsonb_typeof(options) = 'array'),
  required boolean not null default true,
  config jsonb not null default '{}' check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 2000),
  primary key (form_id, id),
  unique (form_id, position) deferrable initially deferred,
  foreign key (workspace_id, form_id) references leadflow_private.onboarding_forms(workspace_id, id) on delete cascade
);

-- A form added to one request; its fields become request items that point back here.
create table leadflow_private.onboarding_form_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  request_id uuid not null,
  form_id uuid references leadflow_private.onboarding_forms(id) on delete set null,
  form_name text not null,
  form_version integer not null,
  assigned_by uuid references public.profiles(id) on delete set null,
  assigned_at timestamptz not null default now(),
  foreign key (workspace_id, request_id) references leadflow_private.onboarding_requests(workspace_id, id) on delete cascade
);
create index onboarding_form_assignments_request on leadflow_private.onboarding_form_assignments(request_id);

alter table leadflow_private.onboarding_template_items drop constraint onboarding_template_items_kind_check;
alter table leadflow_private.onboarding_template_items
  add constraint onboarding_template_items_kind_check check (leadflow_private.is_onboarding_kind(kind)),
  add column stage_id uuid,
  add column config jsonb not null default '{}' check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 2000),
  add column form_name text check (length(form_name) <= 100),
  add constraint onboarding_template_items_stage foreign key (workspace_id, stage_id) references leadflow_private.onboarding_stages(workspace_id, id) on delete set null (stage_id);
alter table leadflow_private.onboarding_items drop constraint onboarding_items_kind_check;
alter table leadflow_private.onboarding_items
  add constraint onboarding_items_kind_check check (leadflow_private.is_onboarding_kind(kind)),
  add column stage_id uuid,
  add column config jsonb not null default '{}' check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 2000),
  add column form_name text check (length(form_name) <= 100),
  add column assignment_id uuid references leadflow_private.onboarding_form_assignments(id) on delete set null,
  add constraint onboarding_items_stage foreign key (workspace_id, stage_id) references leadflow_private.onboarding_stages(workspace_id, id) on delete set null (stage_id);

-- Internal agency steps of a template and of a request: never shown to clients or listed in reminder emails.
-- auto_key steps are completed by the event itself (welcome marked sent, scope confirmed, requirements decided).
create table leadflow_private.onboarding_template_steps (
  workspace_id uuid not null,
  template_id uuid not null,
  id uuid not null default gen_random_uuid(),
  position integer not null check (position between 0 and 99),
  stage_id uuid,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '' check (length(description) <= 2000),
  required boolean not null default true,
  auto_key text check (auto_key in ('welcome_sent','scope_confirmed','requirements_decided')),
  primary key (template_id, id),
  unique (template_id, position) deferrable initially deferred,
  foreign key (workspace_id, template_id) references leadflow_private.onboarding_templates(workspace_id, id) on delete cascade,
  foreign key (workspace_id, stage_id) references leadflow_private.onboarding_stages(workspace_id, id) on delete set null (stage_id)
);
create table leadflow_private.onboarding_steps (
  workspace_id uuid not null,
  request_id uuid not null,
  id uuid not null default gen_random_uuid(),
  position integer not null check (position between 0 and 199),
  stage_id uuid,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '' check (length(description) <= 2000),
  required boolean not null default true,
  auto_key text check (auto_key in ('welcome_sent','scope_confirmed','requirements_decided')),
  due_date date,
  assignee_id uuid references public.profiles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','done','not_required')),
  note text not null default '' check (length(note) <= 1000),
  revision integer not null default 1,
  done_at timestamptz,
  done_by uuid references public.profiles(id) on delete set null,
  primary key (request_id, id),
  foreign key (workspace_id, request_id) references leadflow_private.onboarding_requests(workspace_id, id) on delete cascade,
  foreign key (workspace_id, stage_id) references leadflow_private.onboarding_stages(workspace_id, id) on delete set null (stage_id),
  check ((status = 'pending') = (done_at is null))
);

-- Every client submission of every item, so resubmissions never overwrite what was reviewed.
create table leadflow_private.onboarding_item_responses (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  request_id uuid not null,
  item_id uuid not null,
  revision integer not null,
  response jsonb not null check (octet_length(response::text) <= 12000),
  submitted_at timestamptz not null default now(),
  link_id uuid references leadflow_private.onboarding_links(id) on delete set null,
  review_state text not null default 'pending' check (review_state in ('pending','accepted','changes_requested','not_required','superseded')),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  review_note text not null default '' check (length(review_note) <= 2000),
  foreign key (request_id, item_id) references leadflow_private.onboarding_items(request_id, id) on delete cascade
);
create index onboarding_item_responses_item on leadflow_private.onboarding_item_responses(request_id, item_id, id desc);

-- ---------- Documents ----------

create table leadflow_private.client_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid,
  request_id uuid,
  item_id uuid,
  -- workspace/document-id: unguessable, and never derived from a file name.
  storage_path text not null unique check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  file_name text not null check (length(btrim(file_name)) between 1 and 200 and file_name !~ '[[:cntrl:]/\\]'),
  extension text not null check (extension ~ '^[a-z0-9]{1,8}$'),
  mime_type text not null check (length(mime_type) between 3 and 100),
  size_bytes bigint not null check (size_bytes between 1 and 52428800),
  category text not null default 'other' check (category in ('brand','logo','image','video','content','requirements','design_reference','technical','access_instructions','other')),
  description text not null default '' check (length(description) <= 1000),
  -- shared: the client can download it through their link. internal: agency only.
  visibility text not null default 'internal' check (visibility in ('internal','shared')),
  -- pending until the upload is checked (size, type and content signature); only available files can be downloaded.
  status text not null default 'pending' check (status in ('pending','available','rejected','deleted')),
  rejected_reason text check (length(rejected_reason) <= 200),
  uploader_type text not null check (uploader_type in ('member','client')),
  uploaded_by uuid references public.profiles(id) on delete set null,
  uploaded_link uuid references leadflow_private.onboarding_links(id) on delete set null,
  stage_id uuid,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null,
  check (client_id is not null or request_id is not null),
  check ((status = 'deleted') = (deleted_at is not null)),
  foreign key (workspace_id, client_id) references leadflow_private.clients(workspace_id, id) on delete cascade,
  foreign key (workspace_id, request_id) references leadflow_private.onboarding_requests(workspace_id, id) on delete cascade,
  foreign key (request_id, item_id) references leadflow_private.onboarding_items(request_id, id) on delete set null (item_id),
  foreign key (workspace_id, stage_id) references leadflow_private.onboarding_stages(workspace_id, id) on delete set null (stage_id)
);
create index client_documents_client on leadflow_private.client_documents(client_id, status, created_at desc) where client_id is not null;
create index client_documents_request on leadflow_private.client_documents(request_id, item_id) where request_id is not null;

-- ---------- Follow-up tasks: the same task system, for clients too ----------

alter table public.follow_up_tasks
  alter column "leadId" drop not null,
  add column "clientId" uuid,
  add column "onboardingRequestId" uuid,
  add column "onboardingItemId" uuid,
  add constraint follow_up_tasks_owner check ("leadId" is not null or "clientId" is not null),
  add constraint follow_up_tasks_client foreign key (workspace_id, "clientId") references leadflow_private.clients(workspace_id, id) on delete cascade,
  add constraint follow_up_tasks_request foreign key (workspace_id, "onboardingRequestId") references leadflow_private.onboarding_requests(workspace_id, id) on delete set null ("onboardingRequestId"),
  add constraint follow_up_tasks_item foreign key ("onboardingRequestId", "onboardingItemId") references leadflow_private.onboarding_items(request_id, id) on delete set null ("onboardingItemId");
alter table public.follow_up_tasks drop constraint "follow_up_tasks_taskType_check";
alter table public.follow_up_tasks add constraint "follow_up_tasks_taskType_check" check ("taskType" in ('follow_up','call','email','whatsapp','meeting','proposal','proposal_review','internal','custom',
  'welcome','request_info','review_form','collect_assets','review_requirements','confirm_scope','verify_integrations','prepare_handoff'));
create index follow_up_tasks_client on public.follow_up_tasks(workspace_id, "clientId") where "clientId" is not null;

alter table leadflow_private.onboarding_stages enable row level security;
alter table leadflow_private.clients enable row level security;
alter table leadflow_private.client_contacts enable row level security;
alter table leadflow_private.client_services enable row level security;
alter table leadflow_private.client_requirements enable row level security;
alter table leadflow_private.client_requirement_revisions enable row level security;
alter table leadflow_private.client_scope_confirmations enable row level security;
alter table leadflow_private.client_activities enable row level security;
alter table leadflow_private.client_onboarding_completions enable row level security;
alter table leadflow_private.onboarding_forms enable row level security;
alter table leadflow_private.onboarding_form_fields enable row level security;
alter table leadflow_private.onboarding_form_assignments enable row level security;
alter table leadflow_private.onboarding_template_steps enable row level security;
alter table leadflow_private.onboarding_steps enable row level security;
alter table leadflow_private.onboarding_item_responses enable row level security;
alter table leadflow_private.client_documents enable row level security;
revoke all on leadflow_private.onboarding_stages, leadflow_private.clients, leadflow_private.client_contacts, leadflow_private.client_services,
  leadflow_private.client_requirements, leadflow_private.client_requirement_revisions, leadflow_private.client_scope_confirmations, leadflow_private.client_activities,
  leadflow_private.client_onboarding_completions, leadflow_private.onboarding_forms, leadflow_private.onboarding_form_fields, leadflow_private.onboarding_form_assignments,
  leadflow_private.onboarding_template_steps, leadflow_private.onboarding_steps, leadflow_private.onboarding_item_responses, leadflow_private.client_documents
  from public, anon, authenticated;
create trigger touch_updated_at before update on leadflow_private.onboarding_stages for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on leadflow_private.clients for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on leadflow_private.client_contacts for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on leadflow_private.client_services for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on leadflow_private.client_requirements for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on leadflow_private.onboarding_forms for each row execute function leadflow_private.touch_updated_at();

-- ---------- Helpers ----------

-- The eight default stages, installed once per workspace on first use. Agencies rename, reorder and archive them.
create function leadflow_private.ensure_onboarding_stages(target_workspace uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from leadflow_private.onboarding_stages s where s.workspace_id = target_workspace) then return; end if;
  insert into leadflow_private.onboarding_stages(workspace_id, key, name, description, position)
  select target_workspace, k, n, d, p from (values
    ('created', 'Client created', 'The client record exists, with its contacts and agreed services.', 0),
    ('welcome', 'Welcome & introduction', 'Introduce the team and explain how onboarding works.', 1),
    ('business_info', 'Business information', 'Who the client is, what they sell and who to.', 2),
    ('requirements', 'Requirements gathering', 'Goals, requirements, constraints and expectations.', 3),
    ('access_assets', 'Access & assets', 'Brand assets, content and access granted through each platform''s own sharing.', 4),
    ('scope', 'Scope confirmation', 'Agree the services, requirements, exclusions and dependencies.', 5),
    ('final_review', 'Final review', 'Check everything needed to start delivery is in place.', 6),
    ('completed', 'Onboarding completed', 'Ready for project delivery.', 7)) as d(k, n, d, p)
  on conflict do nothing;
end $$;

-- A stage reference from a definition: a stage ID or a default stage key, which must be an active stage of the workspace.
create function leadflow_private.onboarding_stage_ref(target_workspace uuid, raw text) returns uuid language plpgsql stable set search_path = '' as $$
declare found_id uuid;
begin
  if nullif(btrim(coalesce(raw, '')), '') is null then return null; end if;
  if raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select s.id into found_id from leadflow_private.onboarding_stages s where s.workspace_id = target_workspace and s.id = raw::uuid and s.archived_at is null;
  else
    select s.id into found_id from leadflow_private.onboarding_stages s where s.workspace_id = target_workspace and s.key = raw and s.archived_at is null;
  end if;
  if found_id is null then raise exception 'Choose an active onboarding stage from this workspace.' using errcode = '22023'; end if;
  return found_id;
end $$;

-- A field definition (template item, form field or request item). Display-only kinds are never required.
create or replace function leadflow_private.onboarding_clean_item(item jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare item_kind text; raw_options jsonb; clean_options jsonb := '[]'; option_count integer; raw_config jsonb; clean_config jsonb := '{}'; display boolean; limit_value numeric; low numeric; high numeric;
begin
  if item is null or jsonb_typeof(item) <> 'object' then raise exception 'Each field must be an object.' using errcode = '22023'; end if;
  item_kind := item->>'kind';
  if item_kind is null or not leadflow_private.is_onboarding_kind(item_kind) then raise exception 'Choose a type for each field.' using errcode = '22023'; end if;
  if item ? 'required' and jsonb_typeof(item->'required') <> 'boolean' then raise exception 'Mark each field as required or optional.' using errcode = '22023'; end if;
  display := item_kind in ('heading','info');
  raw_options := coalesce(item->'options', '[]');
  if jsonb_typeof(raw_options) <> 'array' then raise exception 'Options must be a list.' using errcode = '22023'; end if;
  if item_kind in ('choice','multi_choice') then
    option_count := jsonb_array_length(raw_options);
    if option_count not between 2 and 20 then raise exception 'Choice fields need 2 to 20 options.' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_array_elements(raw_options) o where jsonb_typeof(o) <> 'string') then raise exception 'Options must be text.' using errcode = '22023'; end if;
    select jsonb_agg(leadflow_private.onboarding_clean_text(o #>> '{}', 'Each option', 100, true) order by n) into clean_options from jsonb_array_elements(raw_options) with ordinality as e(o, n);
    if (select count(distinct lower(o #>> '{}')) from jsonb_array_elements(clean_options) o) <> option_count then
      raise exception 'Choice options must all be different.' using errcode = '22023';
    end if;
  end if;
  raw_config := coalesce(item->'config', '{}');
  if jsonb_typeof(raw_config) <> 'object' then raise exception 'Field settings must be an object.' using errcode = '22023'; end if;
  if item_kind in ('text','short_text','email','phone','url','number') and nullif(raw_config->>'placeholder', '') is not null then
    clean_config := clean_config || jsonb_build_object('placeholder', leadflow_private.onboarding_clean_text(raw_config->>'placeholder', 'Placeholder', 150));
  end if;
  if item_kind in ('text','short_text') and raw_config ? 'maxLength' and raw_config->'maxLength' <> 'null' then
    if jsonb_typeof(raw_config->'maxLength') <> 'number' then raise exception 'The maximum length must be a number.' using errcode = '22023'; end if;
    limit_value := (raw_config->>'maxLength')::numeric;
    high := case item_kind when 'text' then 4000 else 300 end;
    if limit_value % 1 <> 0 or limit_value < 1 or limit_value > high then
      raise exception 'The maximum length must be a whole number from 1 to %.', high using errcode = '22023';
    end if;
    high := null;
    clean_config := clean_config || jsonb_build_object('maxLength', limit_value::integer);
  end if;
  if item_kind = 'number' then
    if raw_config ? 'min' and raw_config->'min' <> 'null' then
      if jsonb_typeof(raw_config->'min') <> 'number' then raise exception 'The minimum must be a number.' using errcode = '22023'; end if;
      low := (raw_config->>'min')::numeric; clean_config := clean_config || jsonb_build_object('min', low);
    end if;
    if raw_config ? 'max' and raw_config->'max' <> 'null' then
      if jsonb_typeof(raw_config->'max') <> 'number' then raise exception 'The maximum must be a number.' using errcode = '22023'; end if;
      high := (raw_config->>'max')::numeric; clean_config := clean_config || jsonb_build_object('max', high);
    end if;
    if low is not null and high is not null and low > high then raise exception 'The minimum cannot be more than the maximum.' using errcode = '22023'; end if;
  end if;
  if item_kind = 'file' then
    if raw_config ? 'maxFiles' and raw_config->'maxFiles' <> 'null' then
      if jsonb_typeof(raw_config->'maxFiles') <> 'number' or (raw_config->>'maxFiles')::numeric not between 1 and 10 or (raw_config->>'maxFiles')::numeric % 1 <> 0 then
        raise exception 'Allow 1 to 10 files.' using errcode = '22023';
      end if;
      clean_config := clean_config || jsonb_build_object('maxFiles', (raw_config->>'maxFiles')::integer);
    end if;
    if nullif(raw_config->>'category', '') is not null then
      if raw_config->>'category' not in ('brand','logo','image','video','content','requirements','design_reference','technical','access_instructions','other') then
        raise exception 'Choose a document category for uploaded files.' using errcode = '22023';
      end if;
      clean_config := clean_config || jsonb_build_object('category', raw_config->>'category');
    end if;
  end if;
  return jsonb_build_object(
    'section', coalesce(nullif(leadflow_private.onboarding_clean_text(item->>'section', 'Section', 60), ''), 'General'),
    'title', leadflow_private.onboarding_clean_text(item->>'title', case when display then 'Heading' else 'Field label' end, 200, true),
    'guidance', leadflow_private.onboarding_clean_text(item->>'guidance', 'Description', 2000, false, false),
    'kind', item_kind, 'options', clean_options,
    'required', case when display then false else coalesce((item->>'required')::boolean, true) end,
    'dueDate', leadflow_private.onboarding_clean_date(item->>'dueDate', 'Due date'),
    'config', clean_config,
    'stage', nullif(btrim(coalesce(item->>'stageId', item->>'stage', '')), ''),
    'formName', nullif(leadflow_private.onboarding_clean_text(item->>'formName', 'Form name', 100), ''));
end $$;

-- An internal agency step definition.
create function leadflow_private.onboarding_clean_step(step jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
begin
  if step is null or jsonb_typeof(step) <> 'object' then raise exception 'Each internal step must be an object.' using errcode = '22023'; end if;
  if step ? 'required' and jsonb_typeof(step->'required') <> 'boolean' then raise exception 'Mark each step as required or optional.' using errcode = '22023'; end if;
  if nullif(step->>'autoKey', '') is not null and step->>'autoKey' not in ('welcome_sent','scope_confirmed','requirements_decided') then
    raise exception 'Unknown automatic step.' using errcode = '22023';
  end if;
  return jsonb_build_object('title', leadflow_private.onboarding_clean_text(step->>'title', 'Step title', 200, true),
    'description', leadflow_private.onboarding_clean_text(step->>'description', 'Step description', 2000, false, false),
    'required', coalesce((step->>'required')::boolean, true), 'autoKey', nullif(step->>'autoKey', ''),
    'dueDate', leadflow_private.onboarding_clean_date(step->>'dueDate', 'Step due date'),
    'stage', nullif(btrim(coalesce(step->>'stageId', step->>'stage', '')), ''));
end $$;

-- A client answer for one item. Drafts may be incomplete; submissions must be complete and valid. File answers may only
-- list files the client uploaded to this item, that passed the upload checks.
create function leadflow_private.onboarding_clean_answer(target_item leadflow_private.onboarding_items, raw jsonb, for_submit boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare item_kind text := target_item.kind; cfg jsonb := target_item.config; note text; value text; number_value numeric; choices jsonb := '[]'; files jsonb := '[]'; file_ref text; limit_value integer;
begin
  if item_kind in ('heading','info') then raise exception 'This part of the checklist doesn''t take an answer.' using errcode = '22023'; end if;
  if item_kind in ('text','choice','links','access') then
    if item_kind = 'text' and cfg ? 'maxLength' and length(btrim(coalesce(raw->>'text', ''))) > (cfg->>'maxLength')::integer then
      raise exception 'Keep your answer under % characters.', cfg->>'maxLength' using errcode = '22023';
    end if;
    return leadflow_private.onboarding_clean_response(item_kind, target_item.options, raw, for_submit);
  end if;
  if raw is null or jsonb_typeof(raw) <> 'object' or octet_length(raw::text) > 12000 then raise exception 'Enter a response of up to 12 KB.' using errcode = '22023'; end if;
  if raw ? 'note' and jsonb_typeof(raw->'note') <> 'string' then raise exception 'Notes must be text.' using errcode = '22023'; end if;
  note := leadflow_private.onboarding_clean_text(raw->>'note', 'Note', 1000, false, false);
  if item_kind in ('short_text','email','phone','url') then
    if raw ? 'text' and jsonb_typeof(raw->'text') <> 'string' then raise exception 'Answers must be text.' using errcode = '22023'; end if;
    limit_value := case item_kind when 'short_text' then coalesce((cfg->>'maxLength')::integer, 300) when 'email' then 254 when 'phone' then 40 else 500 end;
    value := leadflow_private.onboarding_clean_text(raw->>'text', 'Your answer', limit_value, for_submit);
    if value <> '' and item_kind = 'email' then
      value := lower(value);
      if value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
    elsif value <> '' and item_kind = 'phone' then
      if value !~ '^\+?[0-9 ().-]{7,25}$' or length(regexp_replace(value, '\D', '', 'g')) < 7 then raise exception 'Enter a valid phone number.' using errcode = '22023'; end if;
    elsif value <> '' and item_kind = 'url' then
      if value !~* '^https?://[^[:space:]<>"]+$' then raise exception 'Enter a web address starting with https://.' using errcode = '22023'; end if;
      if value ~* '^https?://[^/?#]*@' then raise exception 'Remove usernames and passwords from the address. Share access through the provider instead.' using errcode = '22023'; end if;
    end if;
    return jsonb_build_object('text', value);
  elsif item_kind = 'number' then
    if raw ? 'number' and raw->'number' <> 'null' and jsonb_typeof(raw->'number') <> 'number' then raise exception 'Enter a number.' using errcode = '22023'; end if;
    number_value := (raw->>'number')::numeric;
    if number_value is null and for_submit then raise exception 'Enter a number.' using errcode = '22023'; end if;
    if number_value is not null and cfg ? 'min' and number_value < (cfg->>'min')::numeric then raise exception 'Enter a number of at least %.', cfg->>'min' using errcode = '22023'; end if;
    if number_value is not null and cfg ? 'max' and number_value > (cfg->>'max')::numeric then raise exception 'Enter a number of at most %.', cfg->>'max' using errcode = '22023'; end if;
    return jsonb_build_object('number', number_value, 'note', note);
  elsif item_kind = 'date' then
    if raw ? 'date' and raw->'date' <> 'null' and jsonb_typeof(raw->'date') <> 'string' then raise exception 'Enter a date.' using errcode = '22023'; end if;
    if nullif(raw->>'date', '') is null and for_submit then raise exception 'Enter a date.' using errcode = '22023'; end if;
    return jsonb_build_object('date', leadflow_private.onboarding_clean_date(raw->>'date', 'The date'), 'note', note);
  elsif item_kind = 'multi_choice' then
    if jsonb_typeof(coalesce(raw->'choices', '[]')) <> 'array' then raise exception 'Choose from the listed options.' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_array_elements(coalesce(raw->'choices', '[]')) c where jsonb_typeof(c) <> 'string' or not target_item.options ? (c #>> '{}')) then
      raise exception 'Choose from the listed options.' using errcode = '22023';
    end if;
    select coalesce(jsonb_agg(distinct c), '[]') into choices from jsonb_array_elements(coalesce(raw->'choices', '[]')) c;
    if for_submit and jsonb_array_length(choices) = 0 then raise exception 'Choose at least one option.' using errcode = '22023'; end if;
    return jsonb_build_object('choices', choices, 'note', note);
  elsif item_kind = 'checkbox' then
    if raw ? 'checked' and jsonb_typeof(raw->'checked') <> 'boolean' then raise exception 'Tick or untick the box.' using errcode = '22023'; end if;
    if for_submit and coalesce((raw->>'checked')::boolean, false) is not true then raise exception 'Tick the box to confirm before submitting.' using errcode = '22023'; end if;
    return jsonb_build_object('checked', coalesce((raw->>'checked')::boolean, false), 'note', note);
  elsif item_kind = 'file' then
    if jsonb_typeof(coalesce(raw->'files', '[]')) <> 'array' then raise exception 'Upload your files first.' using errcode = '22023'; end if;
    limit_value := coalesce((cfg->>'maxFiles')::integer, 5);
    for file_ref in select distinct f #>> '{}' from jsonb_array_elements(coalesce(raw->'files', '[]')) f loop
      if file_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or not exists (select 1 from leadflow_private.client_documents d
          where d.id = file_ref::uuid and d.request_id = target_item.request_id and d.item_id = target_item.id and d.status = 'available') then
        raise exception 'One of the files is no longer available. Upload it again.' using errcode = '22023';
      end if;
      files := files || to_jsonb(file_ref);
    end loop;
    if jsonb_array_length(files) > limit_value then raise exception 'Upload at most % file%.', limit_value, case when limit_value = 1 then '' else 's' end using errcode = '22023'; end if;
    if for_submit and jsonb_array_length(files) = 0 then raise exception 'Upload at least one file.' using errcode = '22023'; end if;
    return jsonb_build_object('files', files, 'note', note);
  end if;
  raise exception 'Unknown field type.' using errcode = '22023';
end $$;

-- Readiness now also counts the request's required internal steps. Display-only items never count. Still computed, never
-- stored: every unresolved required item or step is listed as a blocker, with who it waits on.
create or replace function leadflow_private.onboarding_readiness(target_request uuid) returns jsonb
language sql stable set search_path = '' as $$
  with request as (select * from leadflow_private.onboarding_requests where id = target_request),
  items as (select * from leadflow_private.onboarding_items where request_id = target_request and kind not in ('heading','info')),
  steps as (select * from leadflow_private.onboarding_steps where request_id = target_request),
  item_blockers as (select * from items where required and state not in ('accepted','not_required')),
  step_blockers as (select * from steps where required and status = 'pending'),
  totals as (select
      (select count(*) from items where required) + (select count(*) from steps where required) as required_total,
      (select count(*) from items where required and state = 'accepted') + (select count(*) from steps where required and status = 'done') as required_accepted,
      (select count(*) from items where required and state = 'not_required') + (select count(*) from steps where required and status = 'not_required') as required_waived,
      (select count(*) from items where not required) as optional_total,
      (select count(*) from items where not required and state not in ('accepted','not_required')) as optional_open)
  select jsonb_build_object(
    'state', case r.status when 'draft' then 'not_open' when 'cancelled' then 'cancelled' when 'completed' then 'handed_off' when 'paused' then 'paused'
      else case when not exists (select 1 from item_blockers) and not exists (select 1 from step_blockers) then 'ready'
        when exists (select 1 from item_blockers where state in ('not_started','changes_requested')) then 'waiting_on_client'
        when exists (select 1 from item_blockers) then 'awaiting_review'
        else 'agency_steps' end end,
    'requirementsMet', not exists (select 1 from item_blockers) and not exists (select 1 from step_blockers),
    'clientItemsMet', not exists (select 1 from item_blockers),
    'requiredTotal', t.required_total, 'requiredAccepted', t.required_accepted, 'requiredWaived', t.required_waived,
    'optionalTotal', t.optional_total, 'optionalOutstanding', t.optional_open,
    'percent', case when t.required_total = 0 then 100 else floor(100.0 * (t.required_accepted + t.required_waived) / t.required_total)::integer end,
    'blockers', coalesce((select jsonb_agg(jsonb_build_object('itemId', b.id, 'title', b.title, 'state', b.state, 'kind', b.kind, 'stageId', b.stage_id,
        'waitingOn', case when b.state = 'submitted' then 'agency' else 'client' end,
        'reason', case b.state
          when 'not_started' then 'Not yet provided by the client'
          when 'changes_requested' then 'Changes requested from the client'
          when 'submitted' then case when b.kind = 'access' then 'Client reports access granted; the agency has not confirmed it' else 'Submitted; waiting for agency review' end end)
        order by b.position) from item_blockers b), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('stepId', s.id, 'title', s.title, 'state', 'pending', 'kind', 'internal', 'stageId', s.stage_id, 'waitingOn', 'agency',
        'reason', case s.auto_key when 'welcome_sent' then 'Completes when the welcome message is marked as sent'
          when 'scope_confirmed' then 'Completes when the agreed scope is confirmed'
          when 'requirements_decided' then 'Completes when every requirement is confirmed, deferred or rejected'
          else 'Internal step not done yet' end) order by s.position) from step_blockers s), '[]'::jsonb))
  from request r cross join totals t
$$;

-- As before, with readiness from onboarding_readiness (items and internal steps).
create or replace function leadflow_private.refresh_onboarding(target_request uuid) returns void
language plpgsql set search_path = '' as $$
declare request leadflow_private.onboarding_requests; met boolean; client_open integer; link_ok boolean;
begin
  select * into request from leadflow_private.onboarding_requests where id = target_request;
  met := (leadflow_private.onboarding_readiness(target_request)->>'requirementsMet')::boolean;
  if request.status = 'active' and met and request.ready_since is null then
    update leadflow_private.onboarding_requests set ready_since = now() where id = target_request;
    perform leadflow_private.onboarding_event(target_request, null, 'system', null, 'became_ready', jsonb_build_object('requiredItems',
      (select count(*) from leadflow_private.onboarding_items i where i.request_id = target_request and i.required)
      + (select count(*) from leadflow_private.onboarding_steps s where s.request_id = target_request and s.required)));
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

-- Per-stage progress of one request, from its items and internal steps. Archived stages appear only while they still hold
-- work; unstaged work is grouped as "Other". A stage is complete when every required item and step in it is resolved.
create function leadflow_private.onboarding_stage_progress(target_request uuid) returns jsonb language sql stable set search_path = '' as $$
  with request as (select r.*, (now() at time zone coalesce(ws.timezone, 'UTC'))::date as today from leadflow_private.onboarding_requests r
      left join public.workspace_settings ws on ws.workspace_id = r.workspace_id where r.id = target_request),
  units as (
    select i.stage_id, i.required, i.state in ('accepted','not_required') as resolved, i.state in ('not_started','changes_requested') as client_waiting,
      i.state = 'submitted' as review_waiting, false as agency,
      i.required and i.state not in ('accepted','not_required') and coalesce(i.due_date, r.due_date) < r.today as overdue
    from leadflow_private.onboarding_items i cross join request r where i.request_id = target_request and i.kind not in ('heading','info')
    union all
    select s.stage_id, s.required, s.status <> 'pending', false, false, true, s.required and s.status = 'pending' and s.due_date < r.today
    from leadflow_private.onboarding_steps s cross join request r where s.request_id = target_request),
  stages as (select s.id, s.name, s.position, s.key from leadflow_private.onboarding_stages s join request r on r.workspace_id = s.workspace_id
    where s.archived_at is null or exists (select 1 from units u where u.stage_id = s.id)),
  per as (
    select s.id, s.name, s.position, s.key, count(u.*) as total, count(u.*) filter (where u.required) as required,
      count(u.*) filter (where u.required and u.resolved) as resolved, count(u.*) filter (where u.required and not u.resolved and u.client_waiting) as waiting_client,
      count(u.*) filter (where u.required and not u.resolved and u.review_waiting) as waiting_review, count(u.*) filter (where u.required and not u.resolved and u.agency) as waiting_agency,
      count(u.*) filter (where u.overdue) as overdue
    from stages s left join units u on u.stage_id = s.id group by s.id, s.name, s.position, s.key
    union all
    select null::uuid, 'Other', 1000000, null::text, count(*), count(*) filter (where u.required), count(*) filter (where u.required and u.resolved),
      count(*) filter (where u.required and not u.resolved and u.client_waiting), count(*) filter (where u.required and not u.resolved and u.review_waiting),
      count(*) filter (where u.required and not u.resolved and u.agency), count(*) filter (where u.overdue)
    from units u where u.stage_id is null having count(*) > 0)
  select coalesce(jsonb_agg(jsonb_build_object('stageId', p.id, 'name', p.name, 'key', p.key, 'total', p.total, 'required', p.required, 'resolved', p.resolved,
      'waitingOnClient', p.waiting_client, 'awaitingReview', p.waiting_review, 'agencySteps', p.waiting_agency, 'overdue', p.overdue,
      'state', case when p.total = 0 then 'empty' when p.resolved = p.required then 'complete' else 'open' end) order by p.position), '[]'::jsonb)
  from per p
$$;

create function leadflow_private.client_event(target_client uuid, event_kind text, event_summary text, event_detail jsonb default '{}', event_actor text default 'member',
  target_entity_type text default null, target_entity_id text default null) returns void language sql security definer set search_path = '' as $$
  insert into leadflow_private.client_activities(workspace_id, client_id, kind, summary, detail, actor_type, actor_id, entity_type, entity_id)
  select c.workspace_id, c.id, event_kind, left(event_summary, 300), coalesce(event_detail, '{}'), event_actor,
    case when event_actor = 'member' then leadflow_private.valid_actor() end, target_entity_type, target_entity_id
  from leadflow_private.clients c where c.id = target_client
$$;

create function leadflow_private.lock_client(target_workspace uuid, target_client uuid, expected_version integer) returns leadflow_private.clients
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients;
begin
  select * into found_client from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace for update;
  if not found then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  if expected_version is not null and found_client.version <> expected_version then
    raise exception 'This client was changed in another window. Reload it and try again.' using errcode = '40001';
  end if;
  return found_client;
end $$;

-- As lock_client, for changes: archived clients are read-only until unarchived.
create function leadflow_private.lock_active_client(target_workspace uuid, target_client uuid, expected_version integer) returns leadflow_private.clients
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients;
begin
  found_client := leadflow_private.lock_client(target_workspace, target_client, expected_version);
  if found_client.status = 'archived' then raise exception 'This client is archived. Unarchive it to make changes.' using errcode = '55000'; end if;
  return found_client;
end $$;

-- The client's onboarding status, from its onboarding requests and completion. Separate from the client's own status.
create function leadflow_private.client_onboarding_state(target_client uuid) returns jsonb language sql stable set search_path = '' as $$
  with reqs as (select r.id, r.status, leadflow_private.onboarding_readiness(r.id) as rd from leadflow_private.onboarding_requests r
      where r.client_id = target_client and r.status <> 'cancelled'),
  agg as (select count(*) as n, count(*) filter (where status = 'draft') as drafts, count(*) filter (where status = 'active') as active,
      count(*) filter (where status = 'paused') as paused, count(*) filter (where status = 'completed') as handed_off,
      count(*) filter (where status = 'active' and (rd->>'requirementsMet')::boolean) as ready,
      coalesce(sum((rd->>'requiredTotal')::integer), 0) as required_total,
      coalesce(sum((rd->>'requiredAccepted')::integer + (rd->>'requiredWaived')::integer), 0) as resolved,
      count(*) filter (where rd->>'state' = 'waiting_on_client') as waiting_client, count(*) filter (where rd->>'state' = 'awaiting_review') as awaiting_review,
      count(*) filter (where rd->>'state' = 'agency_steps') as agency_steps
    from reqs)
  select jsonb_build_object(
    'state', case when exists (select 1 from leadflow_private.client_onboarding_completions c where c.client_id = target_client) then 'completed'
      when a.n = 0 then 'not_started'
      when a.active = 0 and a.paused = 0 and a.handed_off = 0 then 'not_started'
      when a.active = 0 and a.paused > 0 then 'paused'
      when a.drafts = 0 and a.paused = 0 and a.active = a.ready then 'ready'
      else 'in_progress' end,
    'requests', a.n, 'requiredTotal', a.required_total, 'resolved', a.resolved,
    'percent', case when a.n = 0 then 0 when a.required_total = 0 then 100 else floor(100.0 * a.resolved / a.required_total)::integer end,
    'waitingOnClient', a.waiting_client, 'awaitingReview', a.awaiting_review, 'agencySteps', a.agency_steps)
  from agg a
$$;

-- Completes the automatic internal steps of a client's open onboarding requests when their event happens.
create function leadflow_private.complete_auto_steps(target_client uuid, step_key text, reason text) returns integer
language plpgsql security definer set search_path = '' as $$
declare completed integer := 0; step record;
begin
  for step in select s.request_id, s.id, s.title from leadflow_private.onboarding_steps s join leadflow_private.onboarding_requests r on r.id = s.request_id
      where r.client_id = target_client and r.status in ('draft','active','paused') and s.auto_key = step_key and s.status = 'pending' for update of s loop
    -- done_by stays empty: LeadFlow completed it, not a person, so it can be undone automatically too.
    update leadflow_private.onboarding_steps set status = 'done', done_at = now(), done_by = null, note = left(reason, 1000), revision = revision + 1
      where request_id = step.request_id and id = step.id;
    perform leadflow_private.onboarding_event(step.request_id, null, 'system', null, 'step_done', jsonb_build_object('stepId', step.id, 'title', step.title, 'automatic', true, 'reason', reason));
    perform leadflow_private.refresh_onboarding(step.request_id);
    completed := completed + 1;
  end loop;
  return completed;
end $$;

-- ---------- M6A onboarding, extended ----------

-- Two more service types for website and automation work.
create or replace function leadflow_private.is_onboarding_service(candidate text) returns boolean language sql immutable set search_path = '' as $$
  select candidate in ('paid_ads','seo','social','email','website','automation','other')
$$;
alter table leadflow_private.onboarding_templates drop constraint onboarding_templates_starter_key_check;
alter table leadflow_private.onboarding_templates add constraint onboarding_templates_starter_key_check check (starter_key in ('paid_ads','seo','social','email','website','marketing','automation'));

-- Where a starter item without an explicit stage belongs.
create function leadflow_private.onboarding_default_stage_key(section text, kind text) returns text language sql immutable set search_path = '' as $$
  select case when kind in ('access','links','file') or section in ('Access','Assets','Brand') then 'access_assets'
    when section ilike any (array['%goal%','%requirement%','%scope%','%advertising%','%seo%','%social%','%email%']) then 'requirements'
    else 'business_info' end
$$;

-- Starter items: the M6A four, plus website, digital marketing & SEO, and automation. Items may name their stage.
create or replace function leadflow_private.onboarding_starter_items(service text) returns jsonb
language sql immutable set search_path = '' as $$
  select case when service in ('website','marketing','automation') then jsonb_build_array(
      jsonb_build_object('section','Business','title','Business overview','kind','text','required',true,'stage','business_info','guidance','What you sell, who you sell to, and what makes you different.'),
      jsonb_build_object('section','Business','title','Main point of contact and approver','kind','short_text','required',true,'stage','business_info','guidance','Name and role of the person we work with day to day, and of the person who approves work if different.'),
      jsonb_build_object('section','Working together','title','How you prefer to communicate','kind','choice','required',true,'stage','welcome','options',jsonb_build_array('Email','Scheduled video calls','Phone','Shared Slack or Teams channel'),'guidance','How you''d like to receive updates and approve work.'))
    else jsonb_build_array(
    jsonb_build_object('section','Business','title','Business overview and goals','kind','text','required',true,'guidance','Describe what you sell, who you sell to, and what you want this engagement to achieve in the first 90 days.'),
    jsonb_build_object('section','Business','title','Main point of contact and approver','kind','text','required',true,'guidance','Name, role and email of the person we work with day to day, and of the person who approves campaigns and spend if different.'),
    jsonb_build_object('section','Business','title','Target audience and geographic market','kind','text','required',true,'guidance','Who your best customers are, and the countries, regions or cities we should target or avoid.'),
    jsonb_build_object('section','Brand','title','Brand guidelines and logo files','kind','links','required',true,'guidance','Links to your brand guidelines, logos and fonts in your own storage (for example Google Drive, Dropbox or OneDrive). Make sure the links can be opened by anyone with the link, or share them with our team.'),
    jsonb_build_object('section','Brand','title','Website and other relevant resources','kind','links','required',true,'guidance','Your website and any pages, documents or examples we should know about.'),
    jsonb_build_object('section','Working together','title','Communication and approval preferences','kind','choice','required',true,'options',jsonb_build_array('Email','Shared Slack or Teams channel','Scheduled video calls','Our project management tool'),'guidance','How you prefer to receive updates and approve work. Add details such as who joins calls.')) end
  || case service
    when 'paid_ads' then jsonb_build_array(
      jsonb_build_object('section','Advertising','title','Advertising objectives','kind','text','required',true,'guidance','What success looks like: leads, sales, bookings or awareness, and any target cost per result.'),
      jsonb_build_object('section','Advertising','title','Monthly budget and campaign priorities','kind','text','required',true,'guidance','Monthly media budget, how it should be split between platforms or products, and which campaigns come first.'),
      jsonb_build_object('section','Access','title','Ad account access (Google Ads and/or Meta)','kind','access','required',true,'guidance','Grant access using the platform''s own sharing: add our team as a user or link our manager account in Google Ads, and add us as a partner in Meta Business Manager. Never send passwords.'),
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
      jsonb_build_object('section','Social','title','Posting frequency','kind','choice','required',true,'options',jsonb_build_array('1–2 posts per week','3–4 posts per week','Daily','Not sure yet'),'guidance','How often you expect us to post. Add platform-specific notes if needed.'),
      jsonb_build_object('section','Social','title','Brand voice and content guidelines','kind','text','required',true,'guidance','How your brand sounds, words or topics to avoid, and anything that needs legal or compliance review.'),
      jsonb_build_object('section','Assets','title','Content assets and upcoming campaigns','kind','links','required',false,'guidance','Photos, videos and dates of launches or events we should plan around.'),
      jsonb_build_object('section','Access','title','Account access and approval process','kind','access','required',true,'guidance','Grant access through each platform''s business tools (for example Meta Business Suite partners or LinkedIn Page admins). Never send passwords.'))
    when 'email' then jsonb_build_array(
      jsonb_build_object('section','Access','title','Email platform and account access','kind','access','required',true,'guidance','Invite our team as a user from your email platform''s team or user settings. Never send passwords or API keys.'),
      jsonb_build_object('section','Email','title','Audience lists and consent requirements','kind','text','required',true,'guidance','Describe your lists or segments and how subscribers gave consent. Do not upload or paste subscriber data here.'),
      jsonb_build_object('section','Email','title','Existing campaigns and performance references','kind','links','required',false,'guidance','Recent campaigns or reports, if available.'),
      jsonb_build_object('section','Email','title','Brand templates and campaign goals','kind','text','required',true,'guidance','Links or notes about existing templates, and what the email programme should achieve.'),
      jsonb_build_object('section','Email','title','Approval and sending requirements','kind','text','required',true,'guidance','Who approves each send, sending times or days to avoid, and any legal footer requirements.'))
    when 'website' then jsonb_build_array(
      jsonb_build_object('section','Website','title','Website goals','kind','text','required',true,'stage','requirements','guidance','What the website must achieve: enquiries, bookings, sales, credibility, recruitment…'),
      jsonb_build_object('section','Website','title','Target audience','kind','text','required',true,'stage','requirements','guidance','Who the website is for, and what they need to find or do.'),
      jsonb_build_object('section','Website','title','Pages you need','kind','multi_choice','required',true,'stage','requirements','options',jsonb_build_array('Home','About','Services','Contact','Blog or news','Online shop','Booking','FAQ','Careers','Other'),'guidance','Tick every page you expect. Add others in the note.'),
      jsonb_build_object('section','Website','title','Design references','kind','links','required',false,'stage','requirements','guidance','Websites you like (or dislike), and what you like about them.'),
      jsonb_build_object('section','Website','title','Content','kind','choice','required',true,'stage','requirements','options',jsonb_build_array('We''ll provide all the content','We''ll provide some content','We need help writing the content'),'guidance','Who writes the text and supplies the images.'),
      jsonb_build_object('section','Website','title','Integrations','kind','text','required',false,'stage','requirements','guidance','Tools the website must connect to: booking, CRM, payments, newsletter, analytics…'),
      jsonb_build_object('section','Brand','title','Logo files','kind','file','required',true,'stage','access_assets','config',jsonb_build_object('category','logo','maxFiles',5),'guidance','Upload your logo in the best quality you have (PNG, PDF or vector files inside a ZIP).'),
      jsonb_build_object('section','Brand','title','Brand guidelines','kind','file','required',false,'stage','access_assets','config',jsonb_build_object('category','brand','maxFiles',3),'guidance','Colours, fonts and usage rules, if you have them.'),
      jsonb_build_object('section','Access','title','Domain and hosting','kind','access','required',true,'stage','access_assets','guidance','Add our team through your domain registrar''s and host''s own user management. Never send passwords.'),
      jsonb_build_object('section','Access','title','Existing website access','kind','access','required',false,'stage','access_assets','guidance','If you have a website already, invite our team as a user in its platform. Never send passwords.'))
    when 'marketing' then jsonb_build_array(
      jsonb_build_object('section','Business','title','Business goals','kind','text','required',true,'stage','business_info','guidance','What you want marketing to achieve in the next 6–12 months.'),
      jsonb_build_object('section','Business','title','Target audience','kind','text','required',true,'stage','business_info','guidance','Your best customers, and who you want more of.'),
      jsonb_build_object('section','Business','title','Target locations','kind','short_text','required',true,'stage','business_info','guidance','Countries, regions or cities to target.'),
      jsonb_build_object('section','Business','title','Services and products to promote','kind','text','required',true,'stage','business_info','guidance','What to promote first, and why.'),
      jsonb_build_object('section','Market','title','Competitors','kind','text','required',true,'stage','requirements','guidance','The competitors you compare yourself with, with their websites.'),
      jsonb_build_object('section','Market','title','Marketing channels you use today','kind','multi_choice','required',true,'stage','requirements','options',jsonb_build_array('Google Ads','Meta ads','SEO','Email','Social media','Content marketing','None yet'),'guidance','Tick every channel you use now.'),
      jsonb_build_object('section','SEO','title','SEO priorities','kind','text','required',true,'stage','requirements','guidance','Services, pages and searches that matter most.'),
      jsonb_build_object('section','SEO','title','Content requirements','kind','text','required',false,'stage','requirements','guidance','Content you expect us to create, and who approves it.'),
      jsonb_build_object('section','Reporting','title','Reporting expectations','kind','choice','required',true,'stage','requirements','options',jsonb_build_array('Weekly','Every two weeks','Monthly'),'guidance','How often you want a report.'),
      jsonb_build_object('section','Access','title','Analytics access','kind','access','required',true,'stage','access_assets','guidance','Add our email as a user in Google Analytics (Admin → property access management). Never send passwords.'),
      jsonb_build_object('section','Access','title','Google Search Console access','kind','access','required',true,'stage','access_assets','guidance','In Search Console, open Settings → Users and permissions and add our email. Never send passwords.'))
    when 'automation' then jsonb_build_array(
      jsonb_build_object('section','Process','title','Business process overview','kind','text','required',true,'stage','business_info','guidance','The process to automate or the software to build, step by step as it works today.'),
      jsonb_build_object('section','Process','title','Current tools','kind','text','required',true,'stage','business_info','guidance','The software and spreadsheets the process uses now.'),
      jsonb_build_object('section','Process','title','Process documents or diagrams','kind','file','required',false,'stage','business_info','config',jsonb_build_object('category','technical','maxFiles',5),'guidance','Any documents, screenshots or diagrams of the current workflow.'),
      jsonb_build_object('section','Goals','title','Automation objectives','kind','text','required',true,'stage','requirements','guidance','What should be faster, cheaper, more reliable or no longer manual.'),
      jsonb_build_object('section','Goals','title','Expected outcomes and acceptance criteria','kind','text','required',true,'stage','requirements','guidance','How we''ll both know it works: measurable results and the checks you''ll run.'),
      jsonb_build_object('section','Technical','title','Required integrations','kind','text','required',true,'stage','requirements','guidance','Systems it must read from or write to.'),
      jsonb_build_object('section','Technical','title','User roles','kind','text','required',true,'stage','requirements','guidance','Who uses it, and what each kind of user may see and do.'),
      jsonb_build_object('section','Technical','title','Data sources','kind','text','required',true,'stage','requirements','guidance','Where the data comes from and how much of it there is. Don''t paste real customer data here.'),
      jsonb_build_object('section','Technical','title','Security and compliance requirements','kind','text','required',true,'stage','requirements','guidance','Policies, regulations or approvals that apply.'),
      jsonb_build_object('section','Access','title','Tool and API access','kind','access','required',true,'stage','access_assets','guidance','Invite our team as users, or create credentials in a secrets manager you control and share access to it. Never paste passwords or API keys into this form.'))
    else '[]'::jsonb end
$$;

-- The internal agency steps every starter template includes. Three complete themselves when their event happens.
create function leadflow_private.onboarding_starter_steps() returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_array(
    jsonb_build_object('title','Send the welcome message','stage','welcome','autoKey','welcome_sent','description','Introduce the team, the next steps and the private onboarding link. Completes when the welcome message is marked as sent.'),
    jsonb_build_object('title','Review the business information','stage','business_info','description','Read the client''s answers and accept or request changes.'),
    jsonb_build_object('title','Decide on every requirement','stage','requirements','autoKey','requirements_decided','description','Completes when every recorded requirement is confirmed, deferred or rejected.'),
    jsonb_build_object('title','Verify access and assets','stage','access_assets','description','Check in each platform that access works and that the assets are usable.'),
    jsonb_build_object('title','Confirm the agreed scope','stage','scope','autoKey','scope_confirmed','description','Completes when the services, requirements, exclusions and dependencies are confirmed.'),
    jsonb_build_object('title','Prepare the project handoff','stage','final_review','description','Make sure the delivery team has everything it needs.'))
$$;

-- Owners and admins. Adds whichever starter templates the workspace does not have yet, with their stages and internal steps.
create or replace function public.install_starter_templates(target_workspace uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare added integer := 0; starter record; created uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  perform leadflow_private.ensure_onboarding_stages(target_workspace);
  for starter in select * from (values ('paid_ads','paid_ads','Paid advertising onboarding','Ad account access, tracking, budget and creative needed before the first campaign.'),
      ('seo','seo','SEO onboarding','Access, keywords, priority pages and baseline data needed before SEO work starts.'),
      ('social','social','Social media management onboarding','Profiles, content goals, brand voice and access needed before the first posts.'),
      ('email','email','Email marketing onboarding','Platform access, audience consent, templates and approvals needed before the first send.'),
      ('website','website','Website design & development onboarding','Goals, pages, content, brand assets and domain access needed before design starts.'),
      ('marketing','seo','Digital marketing & SEO onboarding','Goals, audience, locations, competitors, channels and analytics access needed before marketing starts.'),
      ('automation','automation','AI automation & custom software onboarding','Process, tools, objectives, integrations, roles, data and acceptance criteria needed before building starts.')) as s(key, service, name, description)
  loop
    insert into leadflow_private.onboarding_templates(workspace_id, name, service_type, description, starter_key)
      values (target_workspace, starter.name, starter.service, starter.description, starter.key) on conflict (workspace_id, starter_key) do nothing returning id into created;
    if created is not null then
      insert into leadflow_private.onboarding_template_items(workspace_id, template_id, position, section, title, guidance, kind, options, required, config, stage_id)
        select target_workspace, created, (n - 1)::integer, c->>'section', c->>'title', c->>'guidance', c->>'kind', c->'options', (c->>'required')::boolean, c->'config',
          leadflow_private.onboarding_stage_ref(target_workspace, coalesce(c->>'stage', leadflow_private.onboarding_default_stage_key(c->>'section', c->>'kind')))
        from jsonb_array_elements(leadflow_private.onboarding_starter_items(starter.key)) with ordinality as e(raw, n)
        cross join lateral (select leadflow_private.onboarding_clean_item(e.raw) as c) cleaned;
      insert into leadflow_private.onboarding_template_steps(workspace_id, template_id, position, stage_id, title, description, required, auto_key)
        select target_workspace, created, (n - 1)::integer, leadflow_private.onboarding_stage_ref(target_workspace, c->>'stage'), c->>'title', c->>'description', (c->>'required')::boolean, c->>'autoKey'
        from jsonb_array_elements(leadflow_private.onboarding_starter_steps()) with ordinality as e(raw, n)
        cross join lateral (select leadflow_private.onboarding_clean_step(e.raw) as c) cleaned;
      added := added + 1;
    end if;
    created := null;
  end loop;
  return added;
end $$;

-- Owners and admins. As before, with field types and settings, stages, form groupings and internal steps.
create or replace function public.save_onboarding_template(target_workspace uuid, definition jsonb, expected_version integer default null, request_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing leadflow_private.onboarding_templates; target uuid; clean_name text; clean_description text; items jsonb; steps jsonb := '[]'; item_count integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  perform leadflow_private.ensure_onboarding_stages(target_workspace);
  if definition is null or jsonb_typeof(definition) <> 'object' then raise exception 'Send the template as an object.' using errcode = '22023'; end if;
  clean_name := leadflow_private.onboarding_clean_text(definition->>'name', 'Template name', 100, true);
  clean_description := leadflow_private.onboarding_clean_text(definition->>'description', 'Description', 1000, false, false);
  if not leadflow_private.is_onboarding_service(definition->>'serviceType') then raise exception 'Choose a service type.' using errcode = '22023'; end if;
  if jsonb_typeof(definition->'items') is distinct from 'array' then raise exception 'Add the template''s checklist items.' using errcode = '22023'; end if;
  item_count := jsonb_array_length(definition->'items');
  if item_count not between 1 and 100 then raise exception 'A template needs 1 to 100 items.' using errcode = '22023'; end if;
  select jsonb_agg(leadflow_private.onboarding_clean_item(raw) order by n) into items from jsonb_array_elements(definition->'items') with ordinality as e(raw, n);
  if definition ? 'steps' then
    if jsonb_typeof(definition->'steps') <> 'array' or jsonb_array_length(definition->'steps') > 50 then raise exception 'A template can have up to 50 internal steps.' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(leadflow_private.onboarding_clean_step(raw) order by n), '[]') into steps from jsonb_array_elements(definition->'steps') with ordinality as e(raw, n);
  end if;
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
    -- Steps are replaced only when the definition includes them, so older editors keep a template's steps.
    if definition ? 'steps' then delete from leadflow_private.onboarding_template_steps where template_id = target; end if;
  end if;
  insert into leadflow_private.onboarding_template_items(workspace_id, template_id, position, section, title, guidance, kind, options, required, config, form_name, stage_id)
    select target_workspace, existing.id, (n - 1)::integer, c->>'section', c->>'title', c->>'guidance', c->>'kind', c->'options', (c->>'required')::boolean, c->'config', c->>'formName',
      leadflow_private.onboarding_stage_ref(target_workspace, c->>'stage')
    from jsonb_array_elements(items) with ordinality as e(c, n);
  if definition ? 'steps' then
    insert into leadflow_private.onboarding_template_steps(workspace_id, template_id, position, stage_id, title, description, required, auto_key)
      select target_workspace, existing.id, (n - 1)::integer, leadflow_private.onboarding_stage_ref(target_workspace, c->>'stage'), c->>'title', c->>'description', (c->>'required')::boolean, c->>'autoKey'
      from jsonb_array_elements(steps) with ordinality as e(c, n);
  end if;
  return jsonb_build_object('id', existing.id, 'version', existing.version);
end $$;

create or replace function public.onboarding_template_for(target_workspace uuid, target_template uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select jsonb_build_object('id', t.id, 'name', t.name, 'serviceType', t.service_type, 'description', t.description, 'starterKey', t.starter_key, 'archived', t.archived, 'version', t.version,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', ti.id, 'section', ti.section, 'title', ti.title, 'guidance', ti.guidance, 'kind', ti.kind, 'options', ti.options,
        'required', ti.required, 'config', ti.config, 'formName', ti.form_name, 'stageId', ti.stage_id) order by ti.position)
      from leadflow_private.onboarding_template_items ti where ti.template_id = t.id), '[]'),
    'steps', coalesce((select jsonb_agg(jsonb_build_object('id', ts.id, 'title', ts.title, 'description', ts.description, 'required', ts.required, 'autoKey', ts.auto_key, 'stageId', ts.stage_id) order by ts.position)
      from leadflow_private.onboarding_template_steps ts where ts.template_id = t.id), '[]'))
  into result from leadflow_private.onboarding_templates t where t.id = target_template and t.workspace_id = target_workspace;
  if result is null then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
  return result;
end $$;

-- Any member. As before; also copies the template's stages, settings and internal steps, and links a client of this
-- workspace when details.clientId is given. Automatic steps whose event already happened complete at once.
create or replace function public.create_onboarding_request(target_workspace uuid, details jsonb, request_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := leadflow_private.valid_actor(); existing leadflow_private.onboarding_requests; source leadflow_private.onboarding_templates; created uuid := gen_random_uuid(); template_ref uuid; client_ref uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  perform leadflow_private.ensure_onboarding_stages(target_workspace);
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
  if nullif(details->>'clientId', '') is not null then
    select c.id into client_ref from leadflow_private.clients c where c.workspace_id = target_workspace and c.id::text = details->>'clientId' and c.status <> 'archived';
    if client_ref is null then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  end if;
  insert into leadflow_private.onboarding_requests(id, workspace_id, title, client_name, service_type, template_id, template_name, created_by, owner_id, creation_request_id, client_id)
    values (created, target_workspace, leadflow_private.onboarding_clean_text(details->>'title', 'Project name', 150, true),
      leadflow_private.onboarding_clean_text(details->>'clientName', 'Client name', 150, true), coalesce(source.service_type, 'other'),
      source.id, source.name, actor, actor, request_id, client_ref);
  perform leadflow_private.write_onboarding_details(created, details - 'templateId' - 'clientId');
  insert into leadflow_private.onboarding_items(workspace_id, request_id, position, section, title, guidance, kind, options, required, config, form_name, stage_id)
    select target_workspace, created, ti.position, ti.section, ti.title, ti.guidance, ti.kind, ti.options, ti.required, ti.config, ti.form_name, ti.stage_id
    from leadflow_private.onboarding_template_items ti where ti.template_id = source.id;
  insert into leadflow_private.onboarding_steps(workspace_id, request_id, position, stage_id, title, description, required, auto_key)
    select target_workspace, created, ts.position, ts.stage_id, ts.title, ts.description, ts.required, ts.auto_key
    from leadflow_private.onboarding_template_steps ts where ts.template_id = source.id;
  perform leadflow_private.onboarding_event(created, null, 'member', actor, 'created',
    jsonb_build_object('template', source.name, 'items', (select count(*) from leadflow_private.onboarding_items i where i.request_id = created)));
  if client_ref is not null then
    perform leadflow_private.client_event(client_ref, 'onboarding_started', 'Onboarding started' || coalesce(' from “' || source.name || '”', ''),
      jsonb_build_object('requestId', created, 'template', source.name), 'member', 'onboarding_request', created::text);
    perform leadflow_private.sync_auto_steps(client_ref);
  end if;
  return created;
end $$;

-- Any member. As before, with field settings, stage and form grouping.
create or replace function public.save_onboarding_item(target_workspace uuid, target_request uuid, item jsonb, expected_version integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; clean jsonb; existing leadflow_private.onboarding_items; target uuid; internal text; stage_ref uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, expected_version);
  perform leadflow_private.require_open_onboarding(request);
  clean := leadflow_private.onboarding_clean_item(item);
  stage_ref := leadflow_private.onboarding_stage_ref(target_workspace, clean->>'stage');
  internal := leadflow_private.onboarding_clean_text(item->>'internalNote', 'Internal note', 2000, false, false);
  if nullif(item->>'id', '') is null then
    if (select count(*) from leadflow_private.onboarding_items i where i.request_id = target_request) >= 100 then
      raise exception 'A request can have at most 100 items.' using errcode = '54000';
    end if;
    insert into leadflow_private.onboarding_items(workspace_id, request_id, position, section, title, guidance, kind, options, required, due_date, internal_note, config, form_name, stage_id)
      values (target_workspace, target_request, coalesce((select max(i.position) + 1 from leadflow_private.onboarding_items i where i.request_id = target_request), 0),
        clean->>'section', clean->>'title', clean->>'guidance', clean->>'kind', clean->'options', (clean->>'required')::boolean, (clean->>'dueDate')::date, internal, clean->'config', clean->>'formName', stage_ref)
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
      required = (clean->>'required')::boolean, due_date = (clean->>'dueDate')::date, internal_note = internal, config = clean->'config', form_name = clean->>'formName', stage_id = stage_ref,
      revision = revision + 1
      where request_id = target_request and id = target;
    perform leadflow_private.onboarding_event(target_request, target, 'member', leadflow_private.valid_actor(), 'item_updated',
      jsonb_build_object('title', clean->>'title', 'required', clean->'required', 'requiredChanged', existing.required <> (clean->>'required')::boolean));
  end if;
  update leadflow_private.onboarding_requests set version = version + 1 where id = target_request;
  perform leadflow_private.refresh_onboarding(target_request);
  return target;
end $$;

-- Any member. As before; headings and instructions are not reviewed, and each decision is recorded on the submission it
-- reviewed, so earlier submissions keep their own outcome.
create or replace function public.review_onboarding_item(target_workspace uuid, target_request uuid, target_item uuid, decision text, review_note text, expected_revision integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; item leadflow_private.onboarding_items; clean text; next_state text; event_kind text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, null);
  perform leadflow_private.require_open_onboarding(request);
  select * into item from leadflow_private.onboarding_items i where i.request_id = target_request and i.id = target_item for update;
  if not found then raise exception 'Item not found in this request.' using errcode = 'P0002'; end if;
  if item.kind in ('heading','info') then raise exception 'Headings and instructions don''t need a review.' using errcode = '55000'; end if;
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
  if decision in ('accept','request_changes','not_required') then
    update leadflow_private.onboarding_item_responses r set review_state = case decision when 'accept' then 'accepted' when 'request_changes' then 'changes_requested' else 'not_required' end,
      reviewed_at = now(), reviewed_by = leadflow_private.valid_actor(), review_note = clean
      where r.id = (select max(x.id) from leadflow_private.onboarding_item_responses x where x.request_id = target_request and x.item_id = target_item);
  end if;
  perform leadflow_private.onboarding_event(target_request, target_item, 'member', leadflow_private.valid_actor(), event_kind,
    jsonb_strip_nulls(jsonb_build_object('comment', nullif(clean, ''), 'withoutSubmission', case when decision = 'accept' and item.submitted_at is null then true end, 'kind', item.kind)));
  perform leadflow_private.refresh_onboarding(target_request);
  return jsonb_build_object('state', item.state, 'revision', item.revision);
end $$;

-- Any member. As before; the snapshot also lists internal steps, and the client's history records the handoff.
create or replace function public.hand_off_onboarding(target_workspace uuid, target_request uuid, note text default null) returns jsonb
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
    raise exception 'Not ready: % required item(s) or step(s) are still outstanding.', jsonb_array_length(readiness->'blockers') using errcode = '55000';
  end if;
  insert into leadflow_private.onboarding_handoffs(workspace_id, request_id, request_version, handed_off_by, note, summary)
    values (target_workspace, target_request, request.version + 1, leadflow_private.valid_actor(), leadflow_private.onboarding_clean_text(note, 'Handoff note', 2000, false, false),
      jsonb_build_object('title', request.title, 'clientName', request.client_name, 'clientId', request.client_id, 'serviceType', request.service_type, 'targetKickoffDate', request.target_kickoff_date,
        'leadId', request.lead_id, 'readiness', readiness,
        'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'kind', i.kind, 'required', i.required, 'state', i.state,
          'response', case when i.state = 'accepted' then i.response end, 'reason', nullif(i.waive_reason, '')) order by i.position)
          from leadflow_private.onboarding_items i where i.request_id = target_request and i.kind not in ('heading','info')), '[]'),
        'steps', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'required', s.required, 'status', s.status, 'note', nullif(s.note, '')) order by s.position)
          from leadflow_private.onboarding_steps s where s.request_id = target_request), '[]')))
    returning * into existing;
  update leadflow_private.onboarding_requests set status = 'completed', completed_at = now(), version = version + 1, next_reminder_at = null where id = target_request;
  perform leadflow_private.cancel_onboarding_reminders(target_request, 'Stopped: handed off');
  perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(), 'handed_off', jsonb_build_object('handoffId', existing.id));
  if request.client_id is not null then
    perform leadflow_private.client_event(request.client_id, 'onboarding_handed_off', 'Checklist “' || request.title || '” completed',
      jsonb_build_object('requestId', target_request, 'handoffId', existing.id), 'member', 'onboarding_request', target_request::text);
  end if;
  return jsonb_build_object('id', existing.id, 'handedOffAt', existing.handed_off_at, 'repeated', false);
end $$;

-- Any member. As before, with each request's client, internal-step counts and per-stage progress.
create or replace function public.onboarding_overview_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb; today date;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  perform leadflow_private.ensure_onboarding_stages(target_workspace);
  select (now() at time zone s.timezone)::date into today from public.workspace_settings s where s.workspace_id = target_workspace;
  select jsonb_build_object('today', today,
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', coalesce(nullif(p.display_name, ''), u.email::text, 'Member')) order by coalesce(nullif(p.display_name, ''), u.email::text))
      from public.workspace_memberships m join public.profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id where m.workspace_id = target_workspace), '[]'),
    'stages', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'key', s.key, 'name', s.name, 'description', s.description, 'position', s.position, 'archived', s.archived_at is not null) order by s.archived_at is not null, s.position)
      from leadflow_private.onboarding_stages s where s.workspace_id = target_workspace), '[]'),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'serviceType', t.service_type, 'description', t.description, 'starterKey', t.starter_key,
        'archived', t.archived, 'version', t.version, 'updatedAt', t.updated_at,
        'itemCount', (select count(*) from leadflow_private.onboarding_template_items ti where ti.template_id = t.id and ti.kind not in ('heading','info')),
        'requiredCount', (select count(*) from leadflow_private.onboarding_template_items ti where ti.template_id = t.id and ti.required),
        'stepCount', (select count(*) from leadflow_private.onboarding_template_steps ts where ts.template_id = t.id)) order by t.archived, t.name)
      from leadflow_private.onboarding_templates t where t.workspace_id = target_workspace), '[]'),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'clientName', r.client_name, 'clientId', r.client_id, 'serviceType', r.service_type,
        'ownerId', r.owner_id, 'status', r.status, 'version', r.version, 'startDate', r.start_date, 'targetKickoffDate', r.target_kickoff_date, 'dueDate', r.due_date,
        'templateId', r.template_id, 'createdAt', r.created_at, 'updatedAt', r.updated_at, 'readySince', r.ready_since, 'nextReminderAt', r.next_reminder_at,
        'hasActiveLink', exists (select 1 from leadflow_private.onboarding_links l where l.request_id = r.id and l.purpose = 'shared' and l.revoked_at is null and l.expires_at > now()),
        'counts', (select jsonb_build_object('total', count(*),
            'requiredOutstanding', count(*) filter (where i.required and i.state not in ('accepted','not_required')),
            'awaitingReview', count(*) filter (where i.state = 'submitted'),
            'changesRequested', count(*) filter (where i.state = 'changes_requested'),
            'overdue', count(*) filter (where i.required and i.state not in ('accepted','not_required') and coalesce(i.due_date, r.due_date) < today)
              + (select count(*) from leadflow_private.onboarding_steps s where s.request_id = r.id and s.required and s.status = 'pending' and s.due_date < today),
            'stepsOutstanding', (select count(*) from leadflow_private.onboarding_steps s where s.request_id = r.id and s.required and s.status = 'pending'))
          from leadflow_private.onboarding_items i where i.request_id = r.id and i.kind not in ('heading','info')),
        'readiness', leadflow_private.onboarding_readiness(r.id), 'stages', leadflow_private.onboarding_stage_progress(r.id)) order by r.created_at desc, r.id)
      from leadflow_private.onboarding_requests r where r.workspace_id = target_workspace), '[]'))
  into result;
  return result;
end $$;

-- Any member. As before, plus the client, stages, internal steps, forms, item settings, submission counts and files.
create or replace function public.onboarding_request_for(target_workspace uuid, target_request uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; result jsonb; today date; client_open integer; link_ok boolean;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  perform leadflow_private.ensure_onboarding_stages(target_workspace);
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
    'clientId', request.client_id, 'client', (select jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) from leadflow_private.clients c where c.id = request.client_id),
    'clientInstructions', request.client_instructions, 'internalNote', request.internal_note, 'cancelReason', request.cancel_reason,
    'createdAt', request.created_at, 'updatedAt', request.updated_at, 'activatedAt', request.activated_at, 'completedAt', request.completed_at, 'cancelledAt', request.cancelled_at,
    'readySince', request.ready_since, 'readiness', leadflow_private.onboarding_readiness(request.id), 'stages', leadflow_private.onboarding_stage_progress(request.id),
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
        'internalNote', i.internal_note, 'config', i.config, 'formName', i.form_name, 'stageId', i.stage_id, 'assignmentId', i.assignment_id,
        'submissions', (select count(*) from leadflow_private.onboarding_item_responses x where x.request_id = i.request_id and x.item_id = i.id),
        'files', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.file_name, 'size', d.size_bytes, 'mimeType', d.mime_type, 'status', d.status) order by d.created_at)
          from leadflow_private.client_documents d where d.request_id = i.request_id and d.item_id = i.id and d.status in ('available','pending')), '[]'),
        'overdue', i.required and i.state not in ('accepted','not_required') and coalesce(i.due_date, request.due_date) < today) order by i.position)
      from leadflow_private.onboarding_items i where i.request_id = request.id), '[]'),
    'steps', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'title', s.title, 'description', s.description, 'required', s.required, 'autoKey', s.auto_key,
        'stageId', s.stage_id, 'dueDate', s.due_date, 'assigneeId', s.assignee_id, 'status', s.status, 'note', s.note, 'revision', s.revision, 'doneAt', s.done_at,
        'doneBy', coalesce(nullif(p.display_name, ''), u.email::text), 'overdue', s.required and s.status = 'pending' and s.due_date < today) order by s.position)
      from leadflow_private.onboarding_steps s left join public.profiles p on p.id = s.done_by left join auth.users u on u.id = s.done_by where s.request_id = request.id), '[]'),
    'assignments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'formId', a.form_id, 'formName', a.form_name, 'formVersion', a.form_version, 'assignedAt', a.assigned_at,
        'fields', (select count(*) from leadflow_private.onboarding_items i where i.assignment_id = a.id and i.kind not in ('heading','info')),
        'submitted', (select count(*) from leadflow_private.onboarding_items i where i.assignment_id = a.id and i.state in ('submitted','accepted')),
        'accepted', (select count(*) from leadflow_private.onboarding_items i where i.assignment_id = a.id and i.state in ('accepted','not_required') and i.kind not in ('heading','info'))) order by a.assigned_at)
      from leadflow_private.onboarding_form_assignments a where a.request_id = request.id), '[]'),
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

-- Every submission of one item, newest first, with the review each received.
create function public.onboarding_item_history(target_workspace uuid, target_request uuid, target_item uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.onboarding_items i join leadflow_private.onboarding_requests r on r.id = i.request_id
      where r.workspace_id = target_workspace and i.request_id = target_request and i.id = target_item) then
    raise exception 'Item not found in this request.' using errcode = 'P0002';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'revision', x.revision, 'response', x.response, 'submittedAt', x.submitted_at, 'reviewState', x.review_state,
      'reviewedAt', x.reviewed_at, 'reviewNote', x.review_note, 'reviewedBy', coalesce(nullif(p.display_name, ''), u.email::text)) order by x.id desc)
    from leadflow_private.onboarding_item_responses x left join public.profiles p on p.id = x.reviewed_by left join auth.users u on u.id = x.reviewed_by
    where x.request_id = target_request and x.item_id = target_item), '[]'::jsonb);
end $$;

-- ---------- Internal steps ----------

-- Any member. Adds a step (no id) or edits one, while the request is not handed off or cancelled.
create function public.save_onboarding_step(target_workspace uuid, target_request uuid, step jsonb, expected_version integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; clean jsonb; target uuid; assignee uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, expected_version);
  perform leadflow_private.require_open_onboarding(request);
  clean := leadflow_private.onboarding_clean_step(step);
  if nullif(step->>'assigneeId', '') is not null then
    select m.user_id into assignee from public.workspace_memberships m where m.workspace_id = target_workspace and m.user_id::text = step->>'assigneeId';
    if assignee is null then raise exception 'Assign steps to members of this workspace.' using errcode = '22023'; end if;
  end if;
  if nullif(step->>'id', '') is null then
    if (select count(*) from leadflow_private.onboarding_steps s where s.request_id = target_request) >= 50 then raise exception 'A request can have at most 50 internal steps.' using errcode = '54000'; end if;
    insert into leadflow_private.onboarding_steps(workspace_id, request_id, position, stage_id, title, description, required, auto_key, due_date, assignee_id)
      values (target_workspace, target_request, coalesce((select max(s.position) + 1 from leadflow_private.onboarding_steps s where s.request_id = target_request), 0),
        leadflow_private.onboarding_stage_ref(target_workspace, clean->>'stage'), clean->>'title', clean->>'description', (clean->>'required')::boolean, clean->>'autoKey', (clean->>'dueDate')::date, assignee)
      returning id into target;
    perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(), 'step_added', jsonb_build_object('stepId', target, 'title', clean->>'title'));
  else
    if step->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Step not found in this request.' using errcode = 'P0002'; end if;
    update leadflow_private.onboarding_steps set title = clean->>'title', description = clean->>'description', required = (clean->>'required')::boolean, auto_key = clean->>'autoKey',
      due_date = (clean->>'dueDate')::date, assignee_id = assignee, stage_id = leadflow_private.onboarding_stage_ref(target_workspace, clean->>'stage'), revision = revision + 1
      where request_id = target_request and id = (step->>'id')::uuid returning id into target;
    if target is null then raise exception 'Step not found in this request.' using errcode = 'P0002'; end if;
    perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(), 'step_updated', jsonb_build_object('stepId', target, 'title', clean->>'title'));
  end if;
  update leadflow_private.onboarding_requests set version = version + 1 where id = target_request;
  if request.client_id is not null then perform leadflow_private.sync_auto_steps(request.client_id); end if;
  perform leadflow_private.refresh_onboarding(target_request);
  return target;
end $$;

create function public.remove_onboarding_step(target_workspace uuid, target_request uuid, target_step uuid, expected_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; removed text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, expected_version);
  perform leadflow_private.require_open_onboarding(request);
  delete from leadflow_private.onboarding_steps s where s.request_id = target_request and s.id = target_step and s.status = 'pending' returning title into removed;
  if removed is null then raise exception 'Only pending steps can be removed. Mark a finished step not required instead.' using errcode = '55000'; end if;
  update leadflow_private.onboarding_requests set version = version + 1 where id = target_request;
  perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(), 'step_removed', jsonb_build_object('title', removed));
  perform leadflow_private.refresh_onboarding(target_request);
end $$;

-- Any member. done (automatic steps only on requests without a client), pending (reopen), not_required (reason required).
create function public.set_onboarding_step_status(target_workspace uuid, target_request uuid, target_step uuid, next_status text, note text, expected_revision integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; step leadflow_private.onboarding_steps; clean text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, null);
  perform leadflow_private.require_open_onboarding(request);
  select * into step from leadflow_private.onboarding_steps s where s.request_id = target_request and s.id = target_step for update;
  if not found then raise exception 'Step not found in this request.' using errcode = 'P0002'; end if;
  if expected_revision is null or step.revision <> expected_revision then raise exception 'This step changed since you opened it. Reload and try again.' using errcode = '40001'; end if;
  if next_status not in ('done','pending','not_required') then raise exception 'Unknown step status.' using errcode = '22023'; end if;
  clean := leadflow_private.onboarding_clean_text(note, 'Note', 1000, false, false);
  if next_status = step.status then return jsonb_build_object('status', step.status, 'revision', step.revision); end if;
  -- An automatic step completes with its client event. Without a client there is no such event, so a person marks it.
  if next_status = 'done' and step.auto_key is not null and request.client_id is not null then
    raise exception 'This step completes itself when its event happens. Mark it not required to skip it.' using errcode = '55000';
  end if;
  if next_status = 'not_required' and clean = '' then raise exception 'Give a reason for skipping this step.' using errcode = '22023'; end if;
  update leadflow_private.onboarding_steps set status = next_status, note = clean, revision = revision + 1,
    done_at = case when next_status = 'pending' then null else now() end, done_by = case when next_status = 'pending' then null else leadflow_private.valid_actor() end
    where request_id = target_request and id = target_step returning * into step;
  perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(),
    case next_status when 'done' then 'step_done' when 'pending' then 'step_reopened' else 'step_skipped' end,
    jsonb_strip_nulls(jsonb_build_object('stepId', step.id, 'title', step.title, 'note', nullif(clean, ''))));
  if next_status = 'pending' and step.auto_key is not null and request.client_id is not null then perform leadflow_private.sync_auto_steps(request.client_id); end if;
  perform leadflow_private.refresh_onboarding(target_request);
  return jsonb_build_object('status', step.status, 'revision', step.revision);
end $$;

-- ---------- Clients ----------

-- The deal timeline gains a "converted to client" entry.
alter table leadflow_private.deal_activities drop constraint deal_activities_kind_check;
alter table leadflow_private.deal_activities add constraint deal_activities_kind_check check (kind in ('deal_created','stage_changed','value_updated','details_updated','note','reply','call','proposal_sent',
  'meeting_scheduled','meeting_updated','meeting_completed','meeting_cancelled','meeting_no_show','won','lost','reopened','archived','restored','handoff_confirmed','client_converted'));

-- Completes automatic internal steps whose event has already happened for the client.
create function leadflow_private.sync_auto_steps(target_client uuid) returns void language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; step record;
begin
  select * into found_client from leadflow_private.clients c where c.id = target_client;
  if found_client.welcome_sent_at is not null then perform leadflow_private.complete_auto_steps(target_client, 'welcome_sent', 'The welcome message was marked as sent.'); end if;
  if exists (select 1 from leadflow_private.client_scope_confirmations s where s.client_id = target_client and s.superseded_at is null) then
    perform leadflow_private.complete_auto_steps(target_client, 'scope_confirmed', 'The agreed scope was confirmed.');
  end if;
  if exists (select 1 from leadflow_private.client_requirements r where r.client_id = target_client)
      and not exists (select 1 from leadflow_private.client_requirements r where r.client_id = target_client and r.status in ('draft','under_review')) then
    perform leadflow_private.complete_auto_steps(target_client, 'requirements_decided', 'Every requirement is confirmed, deferred or rejected.');
  else
    -- A requirement added or reopened later undoes the automatic completion (never one a person recorded).
    for step in select s.request_id, s.id, s.title from leadflow_private.onboarding_steps s join leadflow_private.onboarding_requests r on r.id = s.request_id
        where r.client_id = target_client and r.status in ('draft','active','paused') and s.auto_key = 'requirements_decided' and s.status = 'done' and s.done_by is null for update of s loop
      update leadflow_private.onboarding_steps set status = 'pending', done_at = null, note = '', revision = revision + 1 where request_id = step.request_id and id = step.id;
      perform leadflow_private.onboarding_event(step.request_id, null, 'system', null, 'step_reopened', jsonb_build_object('stepId', step.id, 'title', step.title, 'automatic', true,
        'reason', 'A requirement is in draft or under review again.'));
      perform leadflow_private.refresh_onboarding(step.request_id);
    end loop;
  end if;
end $$;

-- Validated profile fields. Only the keys present are returned; unknown keys are refused.
create function leadflow_private.clean_client_details(details jsonb) returns jsonb language plpgsql stable set search_path = '' as $$
declare unknown_key text; result jsonb := '{}'; url text; dates jsonb := '[]'; entry jsonb;
begin
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the client details as an object.' using errcode = '22023'; end if;
  select k into unknown_key from jsonb_object_keys(details) k where k not in ('name','logoUrl','website','industry','description','address','city','region','postcode','country','timezone','ownerId','internalNotes','importantDates') limit 1;
  if unknown_key is not null then raise exception 'Unknown client field: %.', unknown_key using errcode = '22023'; end if;
  if details ? 'name' then result := result || jsonb_build_object('name', leadflow_private.onboarding_clean_text(details->>'name', 'Client name', 150, true)); end if;
  if details ? 'logoUrl' then
    url := leadflow_private.onboarding_clean_text(details->>'logoUrl', 'Logo address', 500);
    if url <> '' and url !~* '^https://[^[:space:]@]+$' then raise exception 'The logo address must start with https:// and have no spaces.' using errcode = '22023'; end if;
    result := result || jsonb_build_object('logoUrl', url);
  end if;
  if details ? 'website' then
    url := leadflow_private.onboarding_clean_text(details->>'website', 'Website', 300);
    if url <> '' and url !~* '^[a-z][a-z0-9+.-]*://' then url := 'https://' || url; end if;
    if url <> '' and url !~* '^https?://[^[:space:]@/]+\.[^[:space:]@]*$' then raise exception 'Enter a website such as https://example.com.' using errcode = '22023'; end if;
    result := result || jsonb_build_object('website', url);
  end if;
  if details ? 'industry' then result := result || jsonb_build_object('industry', leadflow_private.onboarding_clean_text(details->>'industry', 'Industry', 100)); end if;
  if details ? 'description' then result := result || jsonb_build_object('description', leadflow_private.onboarding_clean_text(details->>'description', 'Description', 4000, false, false)); end if;
  if details ? 'address' then result := result || jsonb_build_object('address', leadflow_private.onboarding_clean_text(details->>'address', 'Address', 300)); end if;
  if details ? 'city' then result := result || jsonb_build_object('city', leadflow_private.onboarding_clean_text(details->>'city', 'City', 100)); end if;
  if details ? 'region' then result := result || jsonb_build_object('region', leadflow_private.onboarding_clean_text(details->>'region', 'Region', 100)); end if;
  if details ? 'postcode' then result := result || jsonb_build_object('postcode', leadflow_private.onboarding_clean_text(details->>'postcode', 'Postcode', 20)); end if;
  if details ? 'country' then
    if coalesce(details->>'country', '') <> '' and upper(btrim(details->>'country')) !~ '^[A-Z]{2}$' then raise exception 'Choose a country.' using errcode = '22023'; end if;
    result := result || jsonb_build_object('country', upper(btrim(coalesce(details->>'country', ''))));
  end if;
  if details ? 'timezone' then
    if coalesce(details->>'timezone', '') <> '' and not exists (select 1 from pg_catalog.pg_timezone_names t where t.name = details->>'timezone') then
      raise exception 'Choose a time zone such as Europe/London.' using errcode = '22023';
    end if;
    result := result || jsonb_build_object('timezone', coalesce(details->>'timezone', ''));
  end if;
  if details ? 'internalNotes' then result := result || jsonb_build_object('internalNotes', leadflow_private.onboarding_clean_text(details->>'internalNotes', 'Internal notes', 8000, false, false)); end if;
  if details ? 'importantDates' then
    if jsonb_typeof(details->'importantDates') <> 'array' or jsonb_array_length(details->'importantDates') > 20 then raise exception 'Add up to 20 important dates.' using errcode = '22023'; end if;
    for entry in select value from jsonb_array_elements(details->'importantDates') loop
      if jsonb_typeof(entry) <> 'object' then raise exception 'Each important date needs a label and a date.' using errcode = '22023'; end if;
      dates := dates || jsonb_build_object('label', leadflow_private.onboarding_clean_text(entry->>'label', 'Date label', 60, true),
        'date', leadflow_private.onboarding_clean_date(coalesce(nullif(entry->>'date', ''), 'missing'), 'Important date'));
    end loop;
    result := result || jsonb_build_object('importantDates', dates);
  end if;
  if details ? 'ownerId' then result := result || jsonb_build_object('ownerId', nullif(details->>'ownerId', '')); end if;
  return result;
end $$;

create function leadflow_private.client_owner_ref(target_workspace uuid, raw text) returns uuid language plpgsql stable set search_path = '' as $$
declare owner_ref uuid;
begin
  if nullif(raw, '') is null then return null; end if;
  select m.user_id into owner_ref from public.workspace_memberships m where m.workspace_id = target_workspace and m.user_id::text = raw;
  if owner_ref is null then raise exception 'Choose an owner from this workspace.' using errcode = '22023'; end if;
  return owner_ref;
end $$;

create function leadflow_private.clean_client_contact(contact jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare email text;
begin
  if contact is null or jsonb_typeof(contact) <> 'object' then raise exception 'Each contact must be an object.' using errcode = '22023'; end if;
  email := lower(leadflow_private.onboarding_clean_text(contact->>'email', 'Email', 254));
  if email <> '' and email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid email address for %.', coalesce(nullif(contact->>'fullName', ''), 'the contact') using errcode = '22023'; end if;
  if coalesce(contact->>'role', 'project') not in ('decision_maker','project','billing','technical','marketing','operations','other') then raise exception 'Choose a contact role.' using errcode = '22023'; end if;
  if coalesce(contact->>'preferredChannel', 'email') not in ('email','phone','whatsapp','video','any') then raise exception 'Choose how the contact prefers to be reached.' using errcode = '22023'; end if;
  if contact ? 'isPrimary' and jsonb_typeof(contact->'isPrimary') <> 'boolean' then raise exception 'Mark the primary contact with true or false.' using errcode = '22023'; end if;
  return jsonb_build_object('fullName', leadflow_private.onboarding_clean_text(contact->>'fullName', 'Contact name', 150, true),
    'jobTitle', leadflow_private.onboarding_clean_text(contact->>'jobTitle', 'Job title', 150), 'role', coalesce(contact->>'role', 'project'),
    'email', email, 'phone', leadflow_private.onboarding_clean_text(contact->>'phone', 'Phone', 40),
    'preferredChannel', coalesce(contact->>'preferredChannel', 'email'), 'notes', leadflow_private.onboarding_clean_text(contact->>'notes', 'Contact notes', 2000, false, false),
    'isPrimary', coalesce((contact->>'isPrimary')::boolean, false), 'sourceContactId', nullif(contact->>'sourceContactId', ''));
end $$;

create function leadflow_private.clean_client_service(service jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
begin
  if service is null or jsonb_typeof(service) <> 'object' then raise exception 'Each service must be an object.' using errcode = '22023'; end if;
  return jsonb_build_object('name', leadflow_private.onboarding_clean_text(service->>'name', 'Service name', 80, true),
    'description', leadflow_private.onboarding_clean_text(service->>'description', 'Service description', 1000, false, false),
    'agreedScope', leadflow_private.onboarding_clean_text(service->>'agreedScope', 'Agreed scope', 4000, false, false),
    'deliverables', leadflow_private.onboarding_clean_text(service->>'deliverables', 'Deliverables', 4000, false, false),
    'exclusions', leadflow_private.onboarding_clean_text(service->>'exclusions', 'Exclusions', 4000, false, false),
    'notes', leadflow_private.onboarding_clean_text(service->>'notes', 'Service notes', 2000, false, false),
    'serviceId', nullif(service->>'serviceId', ''));
end $$;

-- Adds contacts and services to a new client. Contacts copied from M8 must belong to the client's lead; services from the
-- catalog must be this workspace's. With no primary chosen, the first contact becomes primary.
create function leadflow_private.add_client_people(target_client leadflow_private.clients, contacts jsonb, services jsonb, service_status text, service_source text)
returns void language plpgsql security definer set search_path = '' as $$
declare clean jsonb; source_ref uuid; service_ref uuid; primary_set boolean := false; position_value integer := 0;
begin
  if contacts is not null then
    if jsonb_typeof(contacts) <> 'array' or jsonb_array_length(contacts) > 50 then raise exception 'Add up to 50 contacts.' using errcode = '22023'; end if;
    if (select count(*) from jsonb_array_elements(contacts) c where (c->>'isPrimary')::boolean) > 1 then raise exception 'Choose one primary contact.' using errcode = '22023'; end if;
    primary_set := exists (select 1 from jsonb_array_elements(contacts) c where (c->>'isPrimary')::boolean);
    for clean in select leadflow_private.clean_client_contact(value) from jsonb_array_elements(contacts) loop
      source_ref := null;
      if clean->>'sourceContactId' is not null then
        select lc.id into source_ref from leadflow_private.lead_contacts lc where lc.workspace_id = target_client.workspace_id and lc.id::text = clean->>'sourceContactId'
          and lc.lead_id = target_client.lead_id;
        if source_ref is null then raise exception 'That contact isn''t one of this lead''s contacts.' using errcode = '22023'; end if;
      end if;
      insert into leadflow_private.client_contacts(workspace_id, client_id, source_contact_id, full_name, job_title, role, email, phone, preferred_channel, notes, is_primary, created_by)
        values (target_client.workspace_id, target_client.id, source_ref, clean->>'fullName', clean->>'jobTitle', clean->>'role', clean->>'email', clean->>'phone',
          clean->>'preferredChannel', clean->>'notes', (clean->>'isPrimary')::boolean or not primary_set, leadflow_private.valid_actor());
      primary_set := true;
    end loop;
  end if;
  if services is not null then
    if jsonb_typeof(services) <> 'array' or jsonb_array_length(services) > 30 then raise exception 'Add up to 30 services.' using errcode = '22023'; end if;
    for clean in select leadflow_private.clean_client_service(value) from jsonb_array_elements(services) loop
      service_ref := null;
      if clean->>'serviceId' is not null then
        select s.id into service_ref from leadflow_private.agency_services s where s.workspace_id = target_client.workspace_id and s.id::text = clean->>'serviceId';
        if service_ref is null then raise exception 'That service isn''t in this workspace''s catalog.' using errcode = '22023'; end if;
      end if;
      begin
        insert into leadflow_private.client_services(workspace_id, client_id, service_id, name, description, agreed_scope, deliverables, exclusions, notes, status, source, position,
            confirmed_at, confirmed_by, created_by)
          values (target_client.workspace_id, target_client.id, service_ref, clean->>'name', clean->>'description', clean->>'agreedScope', clean->>'deliverables', clean->>'exclusions',
            clean->>'notes', service_status, service_source, position_value, case when service_status = 'confirmed' then now() end,
            case when service_status = 'confirmed' then leadflow_private.valid_actor() end, leadflow_private.valid_actor());
      exception when unique_violation then raise exception 'The service “%” is listed twice.', clean->>'name' using errcode = '22023';
      end;
      position_value := position_value + 1;
    end loop;
  end if;
end $$;

create function leadflow_private.client_summary_json(target leadflow_private.clients) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', target.id, 'name', target.name, 'logoUrl', target.logo_url, 'website', target.website, 'industry', target.industry, 'city', target.city, 'country', target.country,
    'status', target.status, 'ownerId', target.owner_id, 'ownerName', coalesce(nullif(p.display_name, ''), u.email::text), 'leadId', target.lead_id, 'dealId', target.deal_id,
    'version', target.version, 'createdAt', target.created_at, 'updatedAt', target.updated_at, 'convertedAt', target.converted_at,
    'primaryContact', (select jsonb_build_object('id', cc.id, 'name', cc.full_name, 'email', cc.email, 'phone', cc.phone) from leadflow_private.client_contacts cc where cc.client_id = target.id and cc.is_primary),
    'contactCount', (select count(*) from leadflow_private.client_contacts cc where cc.client_id = target.id),
    'services', coalesce((select jsonb_agg(s.name order by s.position, s.created_at) from leadflow_private.client_services s where s.client_id = target.id and s.status = 'confirmed'), '[]'::jsonb),
    'onboarding', leadflow_private.client_onboarding_state(target.id),
    'scopeConfirmedAt', (select s.confirmed_at from leadflow_private.client_scope_confirmations s where s.client_id = target.id and s.superseded_at is null),
    'completedAt', (select c.completed_at from leadflow_private.client_onboarding_completions c where c.client_id = target.id),
    'openTasks', (select count(*) from public.follow_up_tasks t where t.workspace_id = target.workspace_id and t."clientId" = target.id and not t.completed and not t.cancelled))
  from (select 1) one left join public.profiles p on p.id = target.owner_id left join auth.users u on u.id = target.owner_id
$$;

-- Clients for the directory: filters, search, sorting and pagination in the database.
-- filters: { search, status (or 'all' / 'current' = not archived), onboarding, industry, ownerId, templateId, createdFrom, createdTo, sort: name|created|updated, direction, limit, offset }.
create function public.clients_for(target_workspace uuid, filters jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare page_limit integer := least(greatest(coalesce((filters->>'limit')::integer, 25), 1), 100); page_offset integer := greatest(coalesce((filters->>'offset')::integer, 0), 0);
  search text := lower(btrim(coalesce(filters->>'search', ''))); sort_key text := coalesce(filters->>'sort', 'updated'); descending boolean := coalesce(filters->>'direction', 'desc') <> 'asc';
  wanted_status text := coalesce(nullif(filters->>'status', ''), 'current');
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return (with matching as (
    select c.*, leadflow_private.client_onboarding_state(c.id)->>'state' as onboarding_state from leadflow_private.clients c
    where c.workspace_id = target_workspace
      and (wanted_status = 'all' or (wanted_status = 'current' and c.status <> 'archived') or c.status = wanted_status)
      and (nullif(filters->>'industry', '') is null or lower(c.industry) = lower(filters->>'industry'))
      and (nullif(filters->>'ownerId', '') is null or c.owner_id::text = filters->>'ownerId')
      and (nullif(filters->>'createdFrom', '') is null or c.created_at >= (filters->>'createdFrom')::date)
      and (nullif(filters->>'createdTo', '') is null or c.created_at < (filters->>'createdTo')::date + 1)
      and (nullif(filters->>'templateId', '') is null or exists (select 1 from leadflow_private.onboarding_requests r where r.client_id = c.id and r.template_id::text = filters->>'templateId'))
      and (search = '' or position(search in lower(c.name || ' ' || c.industry || ' ' || c.website || ' ' || c.city || ' '
        || coalesce((select string_agg(cc.full_name || ' ' || cc.email, ' ') from leadflow_private.client_contacts cc where cc.client_id = c.id), ''))) > 0)
  ), filtered as (select * from matching m where nullif(filters->>'onboarding', '') is null or m.onboarding_state = filters->>'onboarding'),
  ordered as (select f.id, row_number() over (order by
      case when descending then case sort_key when 'name' then lower(f.name) end end desc, case when not descending then case sort_key when 'name' then lower(f.name) end end asc,
      case when descending then case sort_key when 'created' then f.created_at when 'updated' then f.updated_at end end desc,
      case when not descending then case sort_key when 'created' then f.created_at when 'updated' then f.updated_at end end asc, f.id) as ord from filtered f),
  page as (select o.id, o.ord from ordered o order by o.ord limit page_limit offset page_offset)
  select jsonb_build_object('items', coalesce((select jsonb_agg(leadflow_private.client_summary_json(c) order by pg.ord) from page pg join leadflow_private.clients c on c.id = pg.id), '[]'::jsonb),
    'total', (select count(*) from filtered), 'limit', page_limit, 'offset', page_offset,
    'industries', coalesce((select jsonb_agg(distinct c.industry) from leadflow_private.clients c where c.workspace_id = target_workspace and c.industry <> ''), '[]'::jsonb)));
end $$;

-- Every client's name, status, lead and deal, for task labels, pickers and "Open client" on a converted deal.
create function public.client_index_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status, 'leadId', c.lead_id, 'dealId', c.deal_id) order by lower(c.name))
    from (select * from leadflow_private.clients c where c.workspace_id = target_workspace order by c.updated_at desc limit 2000) c), '[]'::jsonb);
end $$;

-- The onboarding dashboard. Every figure is counted from this workspace's clients, onboarding and tasks.
-- filters: { status, onboarding, templateId, ownerId, createdFrom, createdTo }, as for clients_for. today is the caller's date.
create function public.client_dashboard_for(target_workspace uuid, filters jsonb, today date) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return (with scoped as (
    select c.*, leadflow_private.client_onboarding_state(c.id) as onboarding from leadflow_private.clients c
    where c.workspace_id = target_workspace
      and (coalesce(nullif(filters->>'status', ''), 'current') = 'all' or (coalesce(nullif(filters->>'status', ''), 'current') = 'current' and c.status <> 'archived') or c.status = filters->>'status')
      and (nullif(filters->>'ownerId', '') is null or c.owner_id::text = filters->>'ownerId')
      and (nullif(filters->>'createdFrom', '') is null or c.created_at >= (filters->>'createdFrom')::date)
      and (nullif(filters->>'createdTo', '') is null or c.created_at < (filters->>'createdTo')::date + 1)
      and (nullif(filters->>'templateId', '') is null or exists (select 1 from leadflow_private.onboarding_requests r where r.client_id = c.id and r.template_id::text = filters->>'templateId'))
  ), filtered as (select * from scoped s where nullif(filters->>'onboarding', '') is null or s.onboarding->>'state' = filters->>'onboarding')
  select jsonb_build_object(
    'totalClients', (select count(*) from filtered),
    'byStatus', coalesce((select jsonb_object_agg(status, n) from (select f.status, count(*) as n from filtered f group by f.status) x), '{}'::jsonb),
    'byOnboarding', coalesce((select jsonb_object_agg(state, n) from (select f.onboarding->>'state' as state, count(*) as n from filtered f group by 1) x), '{}'::jsonb),
    'onboarding', (select count(*) from filtered f where f.onboarding->>'state' in ('in_progress','ready','paused','not_started') and f.status <> 'archived'),
    'completedOnboarding', (select count(*) from filtered f where f.onboarding->>'state' = 'completed'),
    'pendingSubmissions', (select count(*) from leadflow_private.onboarding_items i join leadflow_private.onboarding_requests r on r.id = i.request_id
      join filtered f on f.id = r.client_id where r.status = 'active' and i.state = 'submitted'),
    'waitingOnClient', (select count(*) from leadflow_private.onboarding_items i join leadflow_private.onboarding_requests r on r.id = i.request_id
      join filtered f on f.id = r.client_id where r.status = 'active' and i.required and i.state in ('not_started','changes_requested')),
    'overdueTasks', (select count(*) from public.follow_up_tasks t join filtered f on f.id = t."clientId" where t.workspace_id = target_workspace and not t.completed and not t.cancelled and t.due < today),
    'dueTodayTasks', (select count(*) from public.follow_up_tasks t join filtered f on f.id = t."clientId" where t.workspace_id = target_workspace and not t.completed and not t.cancelled and t.due = today),
    'awaitingScope', (select count(*) from filtered f where f.status <> 'archived' and f.onboarding->>'state' <> 'completed'
      and not exists (select 1 from leadflow_private.client_scope_confirmations s where s.client_id = f.id and s.superseded_at is null)),
    'recentlyOnboarded', coalesce((select jsonb_agg(jsonb_build_object('clientId', f.id, 'name', f.name, 'completedAt', co.completed_at, 'override', co.override_reason is not null) order by co.completed_at desc)
      from (select * from leadflow_private.client_onboarding_completions co order by co.completed_at desc) co join filtered f on f.id = co.client_id where co.completed_at > now() - interval '30 days'), '[]'::jsonb),
    'attention', coalesce((select jsonb_agg(x order by x->>'name') from (
      select jsonb_build_object('clientId', f.id, 'name', f.name, 'onboarding', f.onboarding, 'status', f.status) as x from filtered f
      where f.onboarding->>'state' in ('in_progress','ready','paused') and f.status <> 'archived' limit 50) y), '[]'::jsonb)));
end $$;

-- One client with everything its workspace shows.
create function public.client_detail(target_workspace uuid, target_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; scope_row leadflow_private.client_scope_confirmations;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into found_client from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace;
  if not found then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  select * into scope_row from leadflow_private.client_scope_confirmations s where s.client_id = target_client and s.superseded_at is null;
  return leadflow_private.client_summary_json(found_client) || jsonb_build_object(
    'description', found_client.description, 'address', found_client.address, 'region', found_client.region, 'postcode', found_client.postcode, 'timezone', found_client.timezone,
    'internalNotes', found_client.internal_notes, 'importantDates', found_client.important_dates, 'previousStatus', found_client.previous_status, 'statusChangedAt', found_client.status_changed_at,
    'conversion', found_client.conversion, 'convertedBy', (select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = found_client.converted_by),
    'welcome', jsonb_build_object('subject', found_client.welcome_subject, 'body', found_client.welcome_body, 'updatedAt', found_client.welcome_updated_at, 'sentAt', found_client.welcome_sent_at,
      'channel', found_client.welcome_channel, 'sentBy', (select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = found_client.welcome_sent_by)),
    'lead', (select jsonb_build_object('id', l.id, 'name', l.name, 'company', l.company, 'status', l.status) from public.leads l where l.workspace_id = target_workspace and l.id = found_client.lead_id),
    'deal', (select jsonb_build_object('id', d.id, 'title', d.title, 'outcome', d.outcome, 'value', d.value, 'wonValue', d.won_value, 'currency', d.currency, 'actualCloseDate', d.actual_close_date,
        'opportunityTitle', d.opportunity_title, 'serviceName', d.service_name, 'notes', d.notes) from leadflow_private.deals d where d.id = found_client.deal_id),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', cc.id, 'fullName', cc.full_name, 'jobTitle', cc.job_title, 'role', cc.role, 'email', cc.email, 'phone', cc.phone,
        'preferredChannel', cc.preferred_channel, 'notes', cc.notes, 'isPrimary', cc.is_primary, 'sourceContactId', cc.source_contact_id, 'updatedAt', cc.updated_at) order by cc.is_primary desc, cc.created_at)
      from leadflow_private.client_contacts cc where cc.client_id = target_client), '[]'::jsonb),
    'serviceRecords', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'serviceId', s.service_id, 'name', s.name, 'description', s.description, 'agreedScope', s.agreed_scope,
        'deliverables', s.deliverables, 'exclusions', s.exclusions, 'notes', s.notes, 'status', s.status, 'source', s.source, 'version', s.version, 'confirmedAt', s.confirmed_at,
        'updatedAt', s.updated_at) order by s.status = 'removed', s.position, s.created_at) from leadflow_private.client_services s where s.client_id = target_client), '[]'::jsonb),
    'requirements', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'description', r.description, 'category', r.category, 'priority', r.priority, 'status', r.status,
        'source', r.source, 'sourceRequestId', r.source_request_id, 'sourceItemId', r.source_item_id, 'clientServiceId', r.client_service_id, 'notes', r.notes, 'version', r.version,
        'confirmedAt', r.confirmed_at, 'createdAt', r.created_at, 'updatedAt', r.updated_at) order by r.created_at) from leadflow_private.client_requirements r where r.client_id = target_client), '[]'::jsonb),
    'scope', case when scope_row.id is null then null else jsonb_build_object('id', scope_row.id, 'sequence', scope_row.sequence, 'snapshot', scope_row.snapshot,
        'outstandingQuestions', scope_row.outstanding_questions, 'notes', scope_row.notes, 'sharedWithClient', scope_row.shared_with_client, 'confirmedAt', scope_row.confirmed_at,
        'confirmedBy', (select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = scope_row.confirmed_by),
        'clientAcknowledgedAt', scope_row.client_acknowledged_at,
        'changedSince', exists (select 1 from leadflow_private.client_services s where s.client_id = target_client and s.updated_at > scope_row.confirmed_at)
          or exists (select 1 from leadflow_private.client_requirements r where r.client_id = target_client and r.updated_at > scope_row.confirmed_at)) end,
    'scopeHistory', (select count(*) from leadflow_private.client_scope_confirmations s where s.client_id = target_client),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'status', r.status, 'serviceType', r.service_type, 'templateName', r.template_name,
        'version', r.version, 'dueDate', r.due_date, 'targetKickoffDate', r.target_kickoff_date, 'createdAt', r.created_at, 'readiness', leadflow_private.onboarding_readiness(r.id),
        'stages', leadflow_private.onboarding_stage_progress(r.id),
        'hasActiveLink', exists (select 1 from leadflow_private.onboarding_links l where l.request_id = r.id and l.purpose = 'shared' and l.revoked_at is null and l.expires_at > now()))
        order by r.created_at) from leadflow_private.onboarding_requests r where r.client_id = target_client), '[]'::jsonb),
    'documentCount', (select count(*) from leadflow_private.client_documents d where d.status = 'available'
      and (d.client_id = target_client or d.request_id in (select r.id from leadflow_private.onboarding_requests r where r.client_id = target_client))),
    'completion', (select jsonb_build_object('id', co.id, 'completedAt', co.completed_at, 'note', co.note, 'overrideReason', co.override_reason, 'outstanding', co.outstanding,
        'completedBy', (select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = co.completed_by))
      from leadflow_private.client_onboarding_completions co where co.client_id = target_client),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', coalesce(nullif(p.display_name, ''), u.email::text, 'Member')) order by coalesce(nullif(p.display_name, ''), u.email::text))
      from public.workspace_memberships m left join public.profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id where m.workspace_id = target_workspace), '[]'::jsonb));
end $$;

-- Any member. A client created by hand, optionally from a lead of this workspace. Idempotent per request ID.
-- details: profile fields plus { leadId, contacts: [...], services: [...] }.
create function public.create_client(target_workspace uuid, details jsonb, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing leadflow_private.clients; clean jsonb; created leadflow_private.clients; lead_ref text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if request_id is null or details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the client details as an object.' using errcode = '22023'; end if;
  select * into existing from leadflow_private.clients c where c.workspace_id = target_workspace and c.request_id = create_client.request_id;
  if found then return jsonb_build_object('id', existing.id, 'existing', true); end if;
  if (select count(*) from leadflow_private.clients c where c.workspace_id = target_workspace) >= 5000 then raise exception 'A workspace can have at most 5,000 clients.' using errcode = '54000'; end if;
  clean := leadflow_private.clean_client_details(details - 'leadId' - 'contacts' - 'services');
  if clean->>'name' is null then raise exception 'Client name is required.' using errcode = '22023'; end if;
  lead_ref := nullif(btrim(coalesce(details->>'leadId', '')), '');
  if lead_ref is not null and not exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = lead_ref) then
    raise exception 'That lead is not in this workspace.' using errcode = '22023';
  end if;
  insert into leadflow_private.clients(workspace_id, request_id, name, logo_url, website, industry, description, address, city, region, postcode, country, timezone, owner_id, lead_id,
      internal_notes, important_dates, created_by)
    values (target_workspace, create_client.request_id, clean->>'name', coalesce(clean->>'logoUrl', ''), coalesce(clean->>'website', ''), coalesce(clean->>'industry', ''),
      coalesce(clean->>'description', ''), coalesce(clean->>'address', ''), coalesce(clean->>'city', ''), coalesce(clean->>'region', ''), coalesce(clean->>'postcode', ''),
      coalesce(clean->>'country', ''), coalesce(clean->>'timezone', ''), coalesce(leadflow_private.client_owner_ref(target_workspace, clean->>'ownerId'), leadflow_private.valid_actor()),
      lead_ref, coalesce(clean->>'internalNotes', ''), coalesce(clean->'importantDates', '[]'), leadflow_private.valid_actor())
    returning * into created;
  perform leadflow_private.add_client_people(created, details->'contacts', details->'services', 'proposed', 'manual');
  perform leadflow_private.client_event(created.id, 'client_created', 'Client created' || case when lead_ref is not null then ' from a lead' else '' end,
    jsonb_strip_nulls(jsonb_build_object('leadId', lead_ref)), 'member', 'client', created.id::text);
  return jsonb_build_object('id', created.id, 'existing', false);
end $$;

-- Any member, for a won deal; owners and admins can convert another deal with a recorded reason. One client per deal:
-- repeating the request, or converting the same deal again, returns that client. The lead, the deal, its history and its
-- M9 handoff are kept; a won deal handed off in M9 before M10 (an "incomplete" conversion) is completed by converting it.
-- details: profile fields plus { contacts, services, overrideReason, onboarding: { templateId, title } }.
create function public.convert_deal_to_client(target_workspace uuid, target_deal uuid, details jsonb, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text; deal_row leadflow_private.deals; existing leadflow_private.clients; clean jsonb; created leadflow_private.clients; handoff_ref uuid; override text;
  onboarding_ref uuid; template_ref text; stage_row leadflow_private.sales_stages; primary_contact jsonb;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if request_id is null or details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the client details as an object.' using errcode = '22023'; end if;
  select * into deal_row from leadflow_private.deals d where d.id = target_deal and d.workspace_id = target_workspace for update;
  if not found then raise exception 'Deal not found.' using errcode = 'P0002'; end if;
  select * into existing from leadflow_private.clients c where c.deal_id = target_deal or (c.workspace_id = target_workspace and c.request_id = convert_deal_to_client.request_id) limit 1;
  if found then return jsonb_build_object('id', existing.id, 'existing', true); end if;
  if deal_row.archived_at is not null then raise exception 'Restore this deal before converting it.' using errcode = '22023'; end if;
  override := nullif(leadflow_private.onboarding_clean_text(details->>'overrideReason', 'Reason', 1000, false, false), '');
  if deal_row.outcome <> 'won' then
    if actor_role = 'member' then raise exception 'Only won deals can be converted. Ask an owner or admin to convert this deal with a reason.' using errcode = '42501'; end if;
    if override is null then raise exception 'This deal isn''t won. Give a reason to convert it anyway.' using errcode = '22023'; end if;
  end if;
  clean := leadflow_private.clean_client_details(details - 'contacts' - 'services' - 'overrideReason' - 'onboarding');
  if clean->>'name' is null then raise exception 'Client name is required.' using errcode = '22023'; end if;
  -- A won deal gets its M9 handoff record now if it doesn't have one, so it can no longer be reopened by accident.
  if deal_row.outcome = 'won' then
    select h.id into handoff_ref from leadflow_private.client_handoffs h where h.deal_id = deal_row.id;
    if handoff_ref is null then handoff_ref := (public.confirm_client_handoff(target_workspace, deal_row.id, 'Converted to a client.')->>'id')::uuid; end if;
  end if;
  select * into stage_row from leadflow_private.sales_stages s where s.id = deal_row.stage_id;
  insert into leadflow_private.clients(workspace_id, request_id, name, logo_url, website, industry, description, address, city, region, postcode, country, timezone, owner_id, lead_id,
      deal_id, deal_handoff_id, conversion, internal_notes, important_dates, converted_at, converted_by, created_by)
    values (target_workspace, convert_deal_to_client.request_id, clean->>'name', coalesce(clean->>'logoUrl', ''), coalesce(clean->>'website', ''), coalesce(clean->>'industry', ''),
      coalesce(clean->>'description', ''), coalesce(clean->>'address', ''), coalesce(clean->>'city', ''), coalesce(clean->>'region', ''), coalesce(clean->>'postcode', ''),
      coalesce(clean->>'country', ''), coalesce(clean->>'timezone', ''),
      coalesce(leadflow_private.client_owner_ref(target_workspace, clean->>'ownerId'), deal_row.owner_id, leadflow_private.valid_actor()), deal_row.lead_id, deal_row.id, handoff_ref,
      jsonb_strip_nulls(jsonb_build_object('dealTitle', deal_row.title, 'outcome', deal_row.outcome, 'stage', stage_row.name, 'value', deal_row.value, 'wonValue', deal_row.won_value,
        'currency', deal_row.currency, 'actualCloseDate', deal_row.actual_close_date, 'opportunityTitle', nullif(deal_row.opportunity_title, ''), 'serviceName', nullif(deal_row.service_name, ''),
        'overrideReason', override, 'fromExistingHandoff', handoff_ref is not null and exists (select 1 from leadflow_private.client_handoffs h where h.id = handoff_ref and h.created_at < now()))),
      coalesce(clean->>'internalNotes', ''), coalesce(clean->'importantDates', '[]'), now(), leadflow_private.valid_actor(), leadflow_private.valid_actor())
    returning * into created;
  perform leadflow_private.add_client_people(created, details->'contacts', details->'services', 'confirmed', 'deal');
  perform leadflow_private.client_event(created.id, 'client_created', 'Client created from the deal “' || deal_row.title || '”',
    jsonb_strip_nulls(jsonb_build_object('dealId', deal_row.id, 'leadId', deal_row.lead_id)), 'member', 'deal', deal_row.id::text);
  perform leadflow_private.client_event(created.id, 'deal_converted', case when override is null then 'Won deal converted to a client' else 'Deal converted to a client by exception: ' || left(override, 200) end,
    jsonb_strip_nulls(jsonb_build_object('dealId', deal_row.id, 'value', deal_row.value, 'wonValue', deal_row.won_value, 'currency', deal_row.currency, 'overrideReason', override,
      'services', (select jsonb_agg(s.name) from leadflow_private.client_services s where s.client_id = created.id), 'contacts', (select count(*) from leadflow_private.client_contacts cc where cc.client_id = created.id))),
    'member', 'deal', deal_row.id::text);
  perform leadflow_private.add_deal_activity(deal_row, 'client_converted', 'Converted to the client “' || created.name || '”', coalesce(override, ''),
    jsonb_build_object('clientId', created.id), null, now(), null);
  -- Optionally start onboarding from a chosen template, in the same transaction.
  if jsonb_typeof(details->'onboarding') = 'object' then
    template_ref := nullif(details->'onboarding'->>'templateId', '');
    select jsonb_build_object('name', cc.full_name, 'email', cc.email) into primary_contact from leadflow_private.client_contacts cc where cc.client_id = created.id and cc.is_primary;
    onboarding_ref := public.create_onboarding_request(target_workspace, jsonb_strip_nulls(jsonb_build_object(
        'title', coalesce(nullif(btrim(details->'onboarding'->>'title'), ''), created.name || ' onboarding'), 'clientName', created.name, 'clientId', created.id,
        'templateId', template_ref, 'contactName', primary_contact->>'name', 'contactEmail', nullif(primary_contact->>'email', ''), 'leadId', deal_row.lead_id,
        'ownerId', created.owner_id)),
      md5(convert_deal_to_client.request_id::text || ':onboarding')::uuid);
  end if;
  return jsonb_build_object('id', created.id, 'existing', false, 'onboardingRequestId', onboarding_ref);
end $$;

-- Any member. Starts an onboarding request for the client, optionally from a template. Idempotent per request ID.
create function public.start_client_onboarding(target_workspace uuid, target_client uuid, details jsonb, request_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; primary_contact leadflow_private.client_contacts;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_client := leadflow_private.lock_client(target_workspace, target_client, null);
  if found_client.status = 'archived' then raise exception 'Unarchive this client first.' using errcode = '55000'; end if;
  select * into primary_contact from leadflow_private.client_contacts cc where cc.client_id = target_client and cc.is_primary;
  return public.create_onboarding_request(target_workspace, jsonb_strip_nulls(jsonb_build_object(
      'title', coalesce(nullif(btrim(coalesce(details->>'title', '')), ''), found_client.name || ' onboarding'), 'clientName', found_client.name, 'clientId', found_client.id,
      'templateId', nullif(details->>'templateId', ''), 'contactName', primary_contact.full_name, 'contactEmail', nullif(primary_contact.email, ''), 'leadId', found_client.lead_id,
      'ownerId', coalesce(nullif(details->>'ownerId', ''), found_client.owner_id::text), 'dueDate', nullif(details->>'dueDate', ''), 'targetKickoffDate', nullif(details->>'targetKickoffDate', ''))),
    request_id);
end $$;

-- Any member. Changes profile fields, the owner, notes and important dates.
create function public.update_client(target_workspace uuid, target_client uuid, expected_version integer, changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare previous leadflow_private.clients; result leadflow_private.clients; clean jsonb; changed text[];
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  previous := leadflow_private.lock_active_client(target_workspace, target_client, expected_version);
  clean := leadflow_private.clean_client_details(changes);
  update leadflow_private.clients c set name = coalesce(clean->>'name', c.name), logo_url = coalesce(clean->>'logoUrl', c.logo_url), website = coalesce(clean->>'website', c.website),
    industry = coalesce(clean->>'industry', c.industry), description = coalesce(clean->>'description', c.description), address = coalesce(clean->>'address', c.address),
    city = coalesce(clean->>'city', c.city), region = coalesce(clean->>'region', c.region), postcode = coalesce(clean->>'postcode', c.postcode), country = coalesce(clean->>'country', c.country),
    timezone = coalesce(clean->>'timezone', c.timezone), internal_notes = coalesce(clean->>'internalNotes', c.internal_notes), important_dates = coalesce(clean->'importantDates', c.important_dates),
    owner_id = case when clean ? 'ownerId' then leadflow_private.client_owner_ref(target_workspace, clean->>'ownerId') else c.owner_id end,
    version = c.version + 1
    where c.id = target_client returning * into result;
  select array_agg(f) into changed from (values ('name', result.name is distinct from previous.name), ('logo', result.logo_url is distinct from previous.logo_url),
      ('website', result.website is distinct from previous.website), ('industry', result.industry is distinct from previous.industry),
      ('description', result.description is distinct from previous.description),
      ('address', (result.address, result.city, result.region, result.postcode, result.country) is distinct from (previous.address, previous.city, previous.region, previous.postcode, previous.country)),
      ('time zone', result.timezone is distinct from previous.timezone), ('owner', result.owner_id is distinct from previous.owner_id),
      ('internal notes', result.internal_notes is distinct from previous.internal_notes), ('important dates', result.important_dates is distinct from previous.important_dates)) as x(f, differs) where differs;
  if cardinality(changed) > 0 then
    perform leadflow_private.client_event(target_client, 'details_updated', 'Updated ' || array_to_string(changed, ', '), jsonb_build_object('fields', to_jsonb(changed)), 'member', 'client', target_client::text);
  end if;
  return leadflow_private.client_summary_json(result);
end $$;

-- Client status: onboarding, active, paused, completed; archiving and unarchiving are for owners and admins.
create function public.set_client_status(target_workspace uuid, target_client uuid, next_status text, expected_version integer, reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text; found_client leadflow_private.clients; clean text; result leadflow_private.clients; restore_to text;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_client := leadflow_private.lock_client(target_workspace, target_client, expected_version);
  if next_status not in ('onboarding','active','paused','completed','archived','unarchive') then raise exception 'Choose a client status.' using errcode = '22023'; end if;
  if next_status in ('archived','unarchive') and actor_role = 'member' then raise exception 'Only owners and admins can archive or unarchive clients.' using errcode = '42501'; end if;
  clean := leadflow_private.onboarding_clean_text(reason, 'Reason', 500, false, false);
  if next_status = 'unarchive' then
    if found_client.status <> 'archived' then raise exception 'This client isn''t archived.' using errcode = '55000'; end if;
    restore_to := coalesce(found_client.previous_status, 'active');
  else
    if found_client.status = 'archived' then raise exception 'Unarchive this client first.' using errcode = '55000'; end if;
    if next_status = found_client.status then return leadflow_private.client_summary_json(found_client); end if;
    restore_to := next_status;
  end if;
  update leadflow_private.clients c set status = restore_to, previous_status = case when restore_to = 'archived' then found_client.status else null end,
    status_changed_at = now(), version = c.version + 1 where c.id = target_client returning * into result;
  if restore_to = 'archived' then
    -- Archived clients' onboarding links stop working; nothing is deleted.
    update leadflow_private.onboarding_links l set revoked_at = now() where l.revoked_at is null and l.request_id in (select r.id from leadflow_private.onboarding_requests r where r.client_id = target_client);
  end if;
  perform leadflow_private.client_event(target_client, 'status_changed', 'Status changed from ' || found_client.status || ' to ' || restore_to || coalesce(': ' || nullif(clean, ''), ''),
    jsonb_strip_nulls(jsonb_build_object('from', found_client.status, 'to', restore_to, 'reason', nullif(clean, ''))), 'member', 'client', target_client::text);
  return leadflow_private.client_summary_json(result);
end $$;

-- Any member. Adds (no id) or edits a contact. Marking one primary unmarks the previous primary.
create function public.save_client_contact(target_workspace uuid, target_client uuid, contact jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; clean jsonb; target uuid; previous leadflow_private.client_contacts;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_client := leadflow_private.lock_active_client(target_workspace, target_client, null);
  clean := leadflow_private.clean_client_contact(contact - 'id');
  if (clean->>'isPrimary')::boolean then update leadflow_private.client_contacts cc set is_primary = false where cc.client_id = target_client and cc.is_primary and cc.id::text is distinct from contact->>'id'; end if;
  if nullif(contact->>'id', '') is null then
    if (select count(*) from leadflow_private.client_contacts cc where cc.client_id = target_client) >= 50 then raise exception 'A client can have at most 50 contacts.' using errcode = '54000'; end if;
    insert into leadflow_private.client_contacts(workspace_id, client_id, full_name, job_title, role, email, phone, preferred_channel, notes, is_primary, created_by)
      values (target_workspace, target_client, clean->>'fullName', clean->>'jobTitle', clean->>'role', clean->>'email', clean->>'phone', clean->>'preferredChannel', clean->>'notes',
        (clean->>'isPrimary')::boolean or not exists (select 1 from leadflow_private.client_contacts cc where cc.client_id = target_client), leadflow_private.valid_actor())
      returning id into target;
    perform leadflow_private.client_event(target_client, 'contact_added', 'Contact added: ' || (clean->>'fullName'), '{}', 'member', 'contact', target::text);
  else
    select * into previous from leadflow_private.client_contacts cc where cc.client_id = target_client and cc.id::text = contact->>'id' for update;
    if not found then raise exception 'Contact not found for this client.' using errcode = 'P0002'; end if;
    update leadflow_private.client_contacts cc set full_name = clean->>'fullName', job_title = clean->>'jobTitle', role = clean->>'role', email = clean->>'email', phone = clean->>'phone',
      preferred_channel = clean->>'preferredChannel', notes = clean->>'notes', is_primary = (clean->>'isPrimary')::boolean or previous.is_primary and not exists
        (select 1 from leadflow_private.client_contacts o where o.client_id = target_client and o.is_primary and o.id <> previous.id)
      where cc.id = previous.id returning id into target;
    perform leadflow_private.client_event(target_client, 'contact_updated', 'Contact updated: ' || (clean->>'fullName'), '{}', 'member', 'contact', target::text);
  end if;
  return jsonb_build_object('id', target);
end $$;

-- Any member. The primary contact can be removed only after another contact is made primary.
create function public.delete_client_contact(target_workspace uuid, target_client uuid, target_contact uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare removed leadflow_private.client_contacts;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  perform leadflow_private.lock_active_client(target_workspace, target_client, null);
  select * into removed from leadflow_private.client_contacts cc where cc.client_id = target_client and cc.id = target_contact for update;
  if not found then raise exception 'Contact not found for this client.' using errcode = 'P0002'; end if;
  if removed.is_primary and exists (select 1 from leadflow_private.client_contacts cc where cc.client_id = target_client and cc.id <> target_contact) then
    raise exception 'Make another contact primary before removing the primary contact.' using errcode = '55000';
  end if;
  delete from leadflow_private.client_contacts cc where cc.id = target_contact;
  perform leadflow_private.client_event(target_client, 'contact_removed', 'Contact removed: ' || removed.full_name,
    jsonb_build_object('name', removed.full_name, 'email', removed.email, 'role', removed.role), 'member', 'contact', target_contact::text);
end $$;

-- Any member. Adds (no id) or edits an agreed service; status confirmed records who confirmed it and when.
-- service: { id?, serviceId?, name, description, agreedScope, deliverables, exclusions, notes, status, expectedVersion? }.
create function public.save_client_service(target_workspace uuid, target_client uuid, service jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare clean jsonb; service_ref uuid; next_status text := coalesce(nullif(service->>'status', ''), 'proposed'); previous leadflow_private.client_services; result leadflow_private.client_services;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  perform leadflow_private.lock_active_client(target_workspace, target_client, null);
  if next_status not in ('proposed','confirmed','removed') then raise exception 'Choose proposed, confirmed or removed.' using errcode = '22023'; end if;
  clean := leadflow_private.clean_client_service(service - 'id' - 'status' - 'expectedVersion');
  if clean->>'serviceId' is not null then
    select s.id into service_ref from leadflow_private.agency_services s where s.workspace_id = target_workspace and s.id::text = clean->>'serviceId';
    if service_ref is null then raise exception 'That service isn''t in this workspace''s catalog.' using errcode = '22023'; end if;
  end if;
  begin
    if nullif(service->>'id', '') is null then
      if (select count(*) from leadflow_private.client_services s where s.client_id = target_client) >= 30 then raise exception 'A client can have at most 30 services.' using errcode = '54000'; end if;
      insert into leadflow_private.client_services(workspace_id, client_id, service_id, name, description, agreed_scope, deliverables, exclusions, notes, status, source, position, confirmed_at, confirmed_by, created_by)
        values (target_workspace, target_client, service_ref, clean->>'name', clean->>'description', clean->>'agreedScope', clean->>'deliverables', clean->>'exclusions', clean->>'notes',
          next_status, 'onboarding', coalesce((select max(s.position) + 1 from leadflow_private.client_services s where s.client_id = target_client), 0),
          case when next_status = 'confirmed' then now() end, case when next_status = 'confirmed' then leadflow_private.valid_actor() end, leadflow_private.valid_actor())
        returning * into result;
      perform leadflow_private.client_event(target_client, 'service_added', 'Service added: ' || result.name || case when next_status = 'confirmed' then ' (confirmed)' else ' (proposed)' end,
        jsonb_build_object('status', next_status), 'member', 'service', result.id::text);
    else
      select * into previous from leadflow_private.client_services s where s.client_id = target_client and s.id::text = service->>'id' for update;
      if not found then raise exception 'Service not found for this client.' using errcode = 'P0002'; end if;
      if service ? 'expectedVersion' and (service->>'expectedVersion')::integer <> previous.version then
        raise exception 'This service was changed in another window. Reload and try again.' using errcode = '40001';
      end if;
      update leadflow_private.client_services s set service_id = service_ref, name = clean->>'name', description = clean->>'description', agreed_scope = clean->>'agreedScope',
        deliverables = clean->>'deliverables', exclusions = clean->>'exclusions', notes = clean->>'notes', status = next_status, version = s.version + 1,
        confirmed_at = case when next_status = 'confirmed' then coalesce(case when previous.status = 'confirmed' then s.confirmed_at end, now()) end,
        confirmed_by = case when next_status = 'confirmed' then case when previous.status = 'confirmed' then s.confirmed_by else leadflow_private.valid_actor() end end
        where s.id = previous.id returning * into result;
      perform leadflow_private.client_event(target_client, case when next_status <> previous.status then 'service_' || next_status else 'service_updated' end,
        case when next_status <> previous.status then 'Service ' || case next_status when 'confirmed' then 'confirmed' when 'removed' then 'removed' else 'set back to proposed' end || ': ' || result.name
          else 'Service updated: ' || result.name end,
        jsonb_build_object('from', jsonb_build_object('agreedScope', previous.agreed_scope, 'deliverables', previous.deliverables, 'exclusions', previous.exclusions, 'status', previous.status),
          'to', jsonb_build_object('agreedScope', result.agreed_scope, 'deliverables', result.deliverables, 'exclusions', result.exclusions, 'status', result.status)), 'member', 'service', result.id::text);
    end if;
  exception when unique_violation then raise exception 'This client already has a service called “%”.', clean->>'name' using errcode = '22023';
  end;
  return jsonb_build_object('id', result.id, 'version', result.version, 'status', result.status);
end $$;

-- Any member. Adds (no id; idempotent per request ID) or edits a requirement. Every version is kept.
-- requirement: { id?, title, description, category, priority, status, source, sourceRequestId, sourceItemId, clientServiceId, notes }.
create function public.save_client_requirement(target_workspace uuid, target_client uuid, requirement jsonb, expected_version integer, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare previous leadflow_private.client_requirements; result leadflow_private.client_requirements; title_value text; description_value text; notes_value text;
  category_value text; priority_value text; status_value text; source_value text; service_ref uuid; request_ref uuid; item_ref uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  perform leadflow_private.lock_active_client(target_workspace, target_client, null);
  if requirement is null or jsonb_typeof(requirement) <> 'object' then raise exception 'Send the requirement as an object.' using errcode = '22023'; end if;
  if nullif(requirement->>'id', '') is null and request_id is not null then
    select * into result from leadflow_private.client_requirements r where r.workspace_id = target_workspace and r.request_id = save_client_requirement.request_id;
    if found then return jsonb_build_object('id', result.id, 'version', result.version, 'repeated', true); end if;
  end if;
  title_value := leadflow_private.onboarding_clean_text(requirement->>'title', 'Requirement title', 200, true);
  description_value := leadflow_private.onboarding_clean_text(requirement->>'description', 'Description', 4000, false, false);
  notes_value := leadflow_private.onboarding_clean_text(requirement->>'notes', 'Notes', 2000, false, false);
  category_value := coalesce(nullif(requirement->>'category', ''), 'functional');
  priority_value := coalesce(nullif(requirement->>'priority', ''), 'medium');
  status_value := coalesce(nullif(requirement->>'status', ''), 'draft');
  source_value := coalesce(nullif(requirement->>'source', ''), 'internal');
  if category_value not in ('objective','goal','functional','technical','design','integration','constraint','dependency','assumption','expectation','success_criteria') then raise exception 'Choose a requirement category.' using errcode = '22023'; end if;
  if priority_value not in ('low','medium','high','critical') then raise exception 'Choose a priority.' using errcode = '22023'; end if;
  if status_value not in ('draft','under_review','confirmed','deferred','rejected') then raise exception 'Choose a requirement status.' using errcode = '22023'; end if;
  if source_value not in ('client_form','client_meeting','deal','internal','other') then raise exception 'Choose where the requirement came from.' using errcode = '22023'; end if;
  if nullif(requirement->>'clientServiceId', '') is not null then
    select s.id into service_ref from leadflow_private.client_services s where s.client_id = target_client and s.id::text = requirement->>'clientServiceId';
    if service_ref is null then raise exception 'Choose one of this client''s services.' using errcode = '22023'; end if;
  end if;
  if nullif(requirement->>'sourceRequestId', '') is not null then
    select r.id into request_ref from leadflow_private.onboarding_requests r where r.client_id = target_client and r.id::text = requirement->>'sourceRequestId';
    if request_ref is null then raise exception 'That onboarding request isn''t this client''s.' using errcode = '22023'; end if;
    if nullif(requirement->>'sourceItemId', '') is not null then
      select i.id into item_ref from leadflow_private.onboarding_items i where i.request_id = request_ref and i.id::text = requirement->>'sourceItemId';
      if item_ref is null then raise exception 'That answer isn''t part of the onboarding request.' using errcode = '22023'; end if;
    end if;
  end if;
  if nullif(requirement->>'id', '') is null then
    if (select count(*) from leadflow_private.client_requirements r where r.client_id = target_client) >= 300 then raise exception 'A client can have at most 300 requirements.' using errcode = '54000'; end if;
    insert into leadflow_private.client_requirements(workspace_id, client_id, request_id, title, description, category, priority, status, source, source_request_id, source_item_id,
        client_service_id, notes, confirmed_at, confirmed_by, created_by)
      values (target_workspace, target_client, save_client_requirement.request_id, title_value, description_value, category_value, priority_value, status_value, source_value, request_ref, item_ref,
        service_ref, notes_value, case when status_value = 'confirmed' then now() end, case when status_value = 'confirmed' then leadflow_private.valid_actor() end, leadflow_private.valid_actor())
      returning * into result;
    perform leadflow_private.client_event(target_client, 'requirement_added', 'Requirement added: ' || title_value, jsonb_build_object('status', status_value, 'category', category_value), 'member', 'requirement', result.id::text);
  else
    select * into previous from leadflow_private.client_requirements r where r.client_id = target_client and r.id::text = requirement->>'id' for update;
    if not found then raise exception 'Requirement not found for this client.' using errcode = 'P0002'; end if;
    if expected_version is null or previous.version <> expected_version then raise exception 'This requirement was changed in another window. Reload and try again.' using errcode = '40001'; end if;
    update leadflow_private.client_requirements r set title = title_value, description = description_value, category = category_value, priority = priority_value, status = status_value,
      source = source_value, source_request_id = request_ref, source_item_id = item_ref, client_service_id = service_ref, notes = notes_value, version = r.version + 1,
      confirmed_at = case when status_value = 'confirmed' then coalesce(case when previous.status = 'confirmed' then r.confirmed_at end, now()) end,
      confirmed_by = case when status_value = 'confirmed' then case when previous.status = 'confirmed' then r.confirmed_by else leadflow_private.valid_actor() end end
      where r.id = previous.id returning * into result;
    perform leadflow_private.client_event(target_client, case when status_value <> previous.status then 'requirement_' || status_value else 'requirement_updated' end,
      case when status_value <> previous.status then 'Requirement ' || replace(status_value, '_', ' ') || ': ' || title_value else 'Requirement updated: ' || title_value end,
      jsonb_build_object('fromStatus', previous.status, 'toStatus', status_value, 'version', result.version), 'member', 'requirement', result.id::text);
  end if;
  insert into leadflow_private.client_requirement_revisions(workspace_id, requirement_id, version, snapshot, changed_by)
    values (target_workspace, result.id, result.version, jsonb_build_object('title', result.title, 'description', result.description, 'category', result.category, 'priority', result.priority,
      'status', result.status, 'source', result.source, 'clientServiceId', result.client_service_id, 'notes', result.notes), leadflow_private.valid_actor());
  perform leadflow_private.sync_auto_steps(target_client);
  return jsonb_build_object('id', result.id, 'version', result.version, 'repeated', false);
end $$;

create function public.client_requirement_history(target_workspace uuid, target_requirement uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.client_requirements r where r.id = target_requirement and r.workspace_id = target_workspace) then
    raise exception 'Requirement not found.' using errcode = 'P0002';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('version', v.version, 'snapshot', v.snapshot, 'changedAt', v.changed_at, 'changedBy', coalesce(nullif(p.display_name, ''), u.email::text)) order by v.version desc)
    from leadflow_private.client_requirement_revisions v left join public.profiles p on p.id = v.changed_by left join auth.users u on u.id = v.changed_by
    where v.requirement_id = target_requirement), '[]'::jsonb);
end $$;

-- Any member. Records what was agreed: the confirmed services and requirements, dependencies, exclusions and expectations
-- as they are now. It supersedes the previous confirmation. This is an internal record, not a contract or signature.
create function public.confirm_client_scope(target_workspace uuid, target_client uuid, details jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; snapshot jsonb; created leadflow_private.client_scope_confirmations; questions text; notes_value text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_client := leadflow_private.lock_active_client(target_workspace, target_client, null);
  if not exists (select 1 from leadflow_private.client_services s where s.client_id = target_client and s.status = 'confirmed') then
    raise exception 'Confirm at least one service before confirming the scope.' using errcode = '55000';
  end if;
  questions := leadflow_private.onboarding_clean_text(details->>'outstandingQuestions', 'Outstanding questions', 4000, false, false);
  notes_value := leadflow_private.onboarding_clean_text(details->>'notes', 'Notes', 2000, false, false);
  snapshot := jsonb_build_object(
    'services', (select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'description', s.description, 'agreedScope', s.agreed_scope, 'deliverables', s.deliverables,
        'exclusions', s.exclusions) order by s.position, s.created_at) from leadflow_private.client_services s where s.client_id = target_client and s.status = 'confirmed'),
    'requirements', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'description', r.description, 'category', r.category, 'priority', r.priority,
        'service', (select s.name from leadflow_private.client_services s where s.id = r.client_service_id)) order by r.created_at)
      from leadflow_private.client_requirements r where r.client_id = target_client and r.status = 'confirmed'), '[]'::jsonb),
    'dependencies', coalesce((select jsonb_agg(jsonb_build_object('title', r.title, 'description', r.description, 'category', r.category) order by r.created_at)
      from leadflow_private.client_requirements r where r.client_id = target_client and r.status = 'confirmed' and r.category in ('dependency','constraint','assumption')), '[]'::jsonb),
    'expectations', coalesce((select jsonb_agg(jsonb_build_object('title', r.title, 'description', r.description, 'category', r.category) order by r.created_at)
      from leadflow_private.client_requirements r where r.client_id = target_client and r.status = 'confirmed' and r.category in ('expectation','success_criteria','objective','goal')), '[]'::jsonb),
    'exclusions', coalesce((select jsonb_agg(jsonb_build_object('service', s.name, 'text', s.exclusions) order by s.position) from leadflow_private.client_services s
      where s.client_id = target_client and s.status = 'confirmed' and s.exclusions <> ''), '[]'::jsonb),
    'undecided', (select count(*) from leadflow_private.client_requirements r where r.client_id = target_client and r.status in ('draft','under_review')));
  update leadflow_private.client_scope_confirmations s set superseded_at = now() where s.client_id = target_client and s.superseded_at is null;
  insert into leadflow_private.client_scope_confirmations(workspace_id, client_id, sequence, snapshot, outstanding_questions, notes, shared_with_client, confirmed_by)
    values (target_workspace, target_client, coalesce((select max(s.sequence) + 1 from leadflow_private.client_scope_confirmations s where s.client_id = target_client), 1), snapshot,
      questions, notes_value, coalesce((details->>'sharedWithClient')::boolean, true), leadflow_private.valid_actor())
    returning * into created;
  perform leadflow_private.client_event(target_client, 'scope_confirmed', 'Scope confirmed (version ' || created.sequence || ')',
    jsonb_build_object('services', jsonb_array_length(snapshot->'services'), 'requirements', jsonb_array_length(snapshot->'requirements'), 'sequence', created.sequence), 'member', 'scope', created.id::text);
  perform leadflow_private.sync_auto_steps(target_client);
  return jsonb_build_object('id', created.id, 'sequence', created.sequence, 'confirmedAt', created.confirmed_at);
end $$;

create function public.client_scope_history(target_workspace uuid, target_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace) then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'sequence', s.sequence, 'snapshot', s.snapshot, 'outstandingQuestions', s.outstanding_questions, 'notes', s.notes,
      'confirmedAt', s.confirmed_at, 'supersededAt', s.superseded_at, 'clientAcknowledgedAt', s.client_acknowledged_at,
      'confirmedBy', (select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = s.confirmed_by)) order by s.sequence desc)
    from leadflow_private.client_scope_confirmations s where s.client_id = target_client), '[]'::jsonb);
end $$;

-- Any member. Saves the welcome message draft; marking it sent records that someone sent it outside LeadFlow.
create function public.save_client_welcome(target_workspace uuid, target_client uuid, subject text, body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  perform leadflow_private.lock_active_client(target_workspace, target_client, null);
  update leadflow_private.clients c set welcome_subject = leadflow_private.onboarding_clean_text(subject, 'Subject', 200),
    welcome_body = leadflow_private.onboarding_clean_text(body, 'Message', 8000, false, false), welcome_updated_at = now() where c.id = target_client;
  return jsonb_build_object('updatedAt', now());
end $$;
create function public.mark_client_welcome_sent(target_workspace uuid, target_client uuid, channel text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_client := leadflow_private.lock_active_client(target_workspace, target_client, null);
  if coalesce(channel, '') not in ('email','whatsapp','phone','meeting','other') then raise exception 'Choose how the welcome message was sent.' using errcode = '22023'; end if;
  if btrim(found_client.welcome_body) = '' then raise exception 'Write and save the welcome message first.' using errcode = '55000'; end if;
  if found_client.welcome_sent_at is not null then return jsonb_build_object('sentAt', found_client.welcome_sent_at, 'repeated', true); end if;
  update leadflow_private.clients c set welcome_sent_at = now(), welcome_sent_by = leadflow_private.valid_actor(), welcome_channel = channel where c.id = target_client;
  perform leadflow_private.client_event(target_client, 'welcome_sent', 'Welcome message marked as sent by ' || channel || ' (sent outside LeadFlow)', jsonb_build_object('channel', channel), 'member', 'client', target_client::text);
  perform leadflow_private.sync_auto_steps(target_client);
  return jsonb_build_object('sentAt', now(), 'repeated', false);
end $$;

-- Any member. Internal notes: agency-only, append-only, never part of anything the client sees.
create function public.add_client_note(target_workspace uuid, target_client uuid, note text, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare clean text; existing bigint;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  perform leadflow_private.lock_client(target_workspace, target_client, null);
  if request_id is not null then
    select a.id into existing from leadflow_private.client_activities a where a.workspace_id = target_workspace and a.request_id = add_client_note.request_id;
    if existing is not null then return jsonb_build_object('id', existing, 'repeated', true); end if;
  end if;
  clean := leadflow_private.onboarding_clean_text(note, 'Note', 4000, true, false);
  insert into leadflow_private.client_activities(workspace_id, client_id, kind, summary, detail, actor_type, actor_id, entity_type, entity_id, request_id)
    values (target_workspace, target_client, 'note', 'Internal note', jsonb_build_object('text', clean), 'member', leadflow_private.valid_actor(), 'client', target_client::text, request_id)
    returning id into existing;
  return jsonb_build_object('id', existing, 'repeated', false);
end $$;

-- The client's history, newest first: its own events, its onboarding requests' events, and its tasks.
-- groups: client, onboarding, scope, documents, tasks, notes. (before_at, before_id) is the last event already shown, so
-- events written in the same transaction (the same time) are never skipped between pages.
create function public.client_timeline(target_workspace uuid, target_client uuid, groups jsonb, before_at timestamptz, page_size integer, before_id text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare wanted text[]; page_rows integer := least(greatest(coalesce(page_size, 50), 1), 200);
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace) then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  select coalesce(array_agg(value), '{client,onboarding,scope,documents,tasks,notes}') into wanted
    from jsonb_array_elements_text(case when jsonb_typeof(groups) = 'array' and jsonb_array_length(groups) > 0 then groups else '[]'::jsonb end);
  return (with events as (
    select 'client:' || a.id as id, case when a.kind = 'note' then 'notes' when a.kind like 'requirement%' or a.kind like 'service%' or a.kind like 'scope%' then 'scope'
        when a.kind like 'document%' then 'documents' when a.kind like 'onboarding%' or a.kind = 'welcome_sent' then 'onboarding' else 'client' end as grp,
      'client' as source, a.kind, a.summary, a.detail, a.at, a.actor_type, a.actor_id, null::text as request_title, null::text as item_title
    from leadflow_private.client_activities a where a.client_id = target_client
    union all
    select 'onboarding:' || e.id, 'onboarding', 'onboarding', e.kind, null, e.detail, e.at, e.actor_type, e.actor_id, r.title, i.title
    from leadflow_private.onboarding_events e join leadflow_private.onboarding_requests r on r.id = e.request_id
      left join leadflow_private.onboarding_items i on i.request_id = e.request_id and i.id = e.item_id
    where r.client_id = target_client
    union all
    select 'task-created:' || t.id, 'tasks', 'task', 'task_created', 'Task planned: ' || t.notes, jsonb_build_object('due', t.due, 'taskType', t."taskType", 'taskId', t.id), t."createdAt", 'member', null, null, null
    from public.follow_up_tasks t where t.workspace_id = target_workspace and t."clientId" = target_client and t."createdAt" is not null
    union all
    select 'task-done:' || t.id, 'tasks', 'task', case when t.cancelled then 'task_cancelled' else 'task_completed' end,
      case when t.cancelled then 'Task cancelled: ' else 'Task completed: ' end || t.notes, jsonb_build_object('taskId', t.id), t."completedAt", 'member', null, null, null
    from public.follow_up_tasks t where t.workspace_id = target_workspace and t."clientId" = target_client and t."completedAt" is not null and (t.completed or t.cancelled)
  )
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'group', e.grp, 'source', e.source, 'kind', e.kind, 'summary', e.summary, 'detail', e.detail, 'at', e.at,
      'actorType', e.actor_type, 'actorName', case e.actor_type when 'client' then 'Client' when 'system' then 'LeadFlow' else coalesce(nullif(p.display_name, ''), u.email::text) end,
      'requestTitle', e.request_title, 'itemTitle', e.item_title) order by e.at desc, e.id), '[]'::jsonb),
    'hasMore', (select count(*) from events x where x.grp = any(wanted) and (before_at is null or x.at < before_at or (x.at = before_at and before_id is not null and x.id > before_id))) > page_rows)
  from (select * from events x where x.grp = any(wanted) and (before_at is null or x.at < before_at or (x.at = before_at and before_id is not null and x.id > before_id)) order by x.at desc, x.id limit page_rows) e
  left join public.profiles p on p.id = e.actor_id left join auth.users u on u.id = e.actor_id);
end $$;

-- What blocks completing onboarding, item by item. Nothing here is a score.
create function leadflow_private.client_completion_items(target_client uuid) returns jsonb language sql stable set search_path = '' as $$
  with reqs as (select r.id, r.title, r.status, leadflow_private.onboarding_readiness(r.id) as rd from leadflow_private.onboarding_requests r
      where r.client_id = target_client and r.status <> 'cancelled'),
  scope_row as (select * from leadflow_private.client_scope_confirmations s where s.client_id = target_client and s.superseded_at is null)
  select jsonb_build_array(
    jsonb_build_object('key', 'contact', 'label', 'A primary contact', 'met', exists (select 1 from leadflow_private.client_contacts c where c.client_id = target_client and c.is_primary),
      'detail', 'Add the client''s main contact.'),
    jsonb_build_object('key', 'services', 'label', 'At least one confirmed service', 'met', exists (select 1 from leadflow_private.client_services s where s.client_id = target_client and s.status = 'confirmed'),
      'detail', 'Confirm the services agreed with the client.'),
    jsonb_build_object('key', 'requirements', 'label', 'Requirements recorded and decided',
      'met', exists (select 1 from leadflow_private.client_requirements r where r.client_id = target_client and r.status = 'confirmed')
        and not exists (select 1 from leadflow_private.client_requirements r where r.client_id = target_client and r.status in ('draft','under_review')),
      'detail', (select case when count(*) filter (where r.status = 'confirmed') = 0 then 'Record and confirm at least one requirement.'
          else count(*) filter (where r.status in ('draft','under_review')) || ' requirement(s) still in draft or under review.' end
        from leadflow_private.client_requirements r where r.client_id = target_client)),
    jsonb_build_object('key', 'scope', 'label', 'Scope confirmed and unchanged since',
      'met', exists (select 1 from scope_row) and not exists (select 1 from scope_row sr where exists (select 1 from leadflow_private.client_services s where s.client_id = target_client and s.updated_at > sr.confirmed_at)
        or exists (select 1 from leadflow_private.client_requirements r where r.client_id = target_client and r.updated_at > sr.confirmed_at)),
      'detail', case when exists (select 1 from scope_row) then 'Services or requirements changed after the scope was confirmed. Confirm it again.' else 'Confirm the agreed scope.' end),
    jsonb_build_object('key', 'onboarding', 'label', 'Onboarding checklists complete',
      'met', exists (select 1 from reqs) and not exists (select 1 from reqs where status in ('draft','paused') or (status = 'active' and not (rd->>'requirementsMet')::boolean)),
      'detail', case when not exists (select 1 from reqs) then 'Start an onboarding checklist for this client.'
        else coalesce((select string_agg('“' || title || '”: ' || case status when 'draft' then 'not opened yet' when 'paused' then 'paused'
            else jsonb_array_length(rd->'blockers') || ' required item(s) or step(s) outstanding' end, '; ')
          from reqs where status in ('draft','paused') or (status = 'active' and not (rd->>'requirementsMet')::boolean)), 'All checklists are complete.') end))
$$;

create function public.client_completion_check(target_workspace uuid, target_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare items jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace) then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  items := leadflow_private.client_completion_items(target_client);
  return jsonb_build_object('items', items, 'ready', not exists (select 1 from jsonb_array_elements(items) x where not (x->>'met')::boolean),
    'completed', exists (select 1 from leadflow_private.client_onboarding_completions c where c.client_id = target_client));
end $$;

-- Completes onboarding once and records the M11 handoff. When something is outstanding, only an owner or admin can
-- complete, with a reason that is kept with what was outstanding. Ready, open checklists are handed off in the same step.
create function public.complete_client_onboarding(target_workspace uuid, target_client uuid, note text, override_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text; found_client leadflow_private.clients; existing leadflow_private.client_onboarding_completions; items jsonb; outstanding jsonb; override text; request record; snapshot jsonb;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  found_client := leadflow_private.lock_client(target_workspace, target_client, null);
  select * into existing from leadflow_private.client_onboarding_completions c where c.client_id = target_client;
  if found then return jsonb_build_object('id', existing.id, 'completedAt', existing.completed_at, 'repeated', true); end if;
  if found_client.status = 'archived' then raise exception 'Unarchive this client first.' using errcode = '55000'; end if;
  items := leadflow_private.client_completion_items(target_client);
  select coalesce(jsonb_agg(x), '[]') into outstanding from jsonb_array_elements(items) x where not (x->>'met')::boolean;
  override := nullif(leadflow_private.onboarding_clean_text(override_reason, 'Reason', 1000, false, false), '');
  if jsonb_array_length(outstanding) > 0 then
    if actor_role = 'member' then raise exception 'Not ready: % item(s) still outstanding. An owner or admin can complete onboarding anyway with a reason.', jsonb_array_length(outstanding) using errcode = '55000'; end if;
    if override is null then raise exception 'Not ready: % item(s) still outstanding. Give a reason to complete onboarding anyway.', jsonb_array_length(outstanding) using errcode = '55000'; end if;
  else
    override := null;
  end if;
  for request in select r.id from leadflow_private.onboarding_requests r where r.client_id = target_client and r.status = 'active'
      and (leadflow_private.onboarding_readiness(r.id)->>'requirementsMet')::boolean loop
    perform public.hand_off_onboarding(target_workspace, request.id, 'Completed with the client''s onboarding.');
  end loop;
  snapshot := jsonb_build_object(
    'client', (select jsonb_build_object('id', c.id, 'name', c.name, 'website', c.website, 'industry', c.industry, 'description', c.description, 'address', c.address, 'city', c.city,
        'region', c.region, 'postcode', c.postcode, 'country', c.country, 'timezone', c.timezone, 'ownerId', c.owner_id, 'leadId', c.lead_id, 'importantDates', c.important_dates)
      from leadflow_private.clients c where c.id = target_client),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', cc.id, 'name', cc.full_name, 'jobTitle', cc.job_title, 'role', cc.role, 'email', cc.email, 'phone', cc.phone,
        'preferredChannel', cc.preferred_channel, 'isPrimary', cc.is_primary) order by cc.is_primary desc, cc.created_at) from leadflow_private.client_contacts cc where cc.client_id = target_client), '[]'::jsonb),
    'services', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'serviceId', s.service_id, 'name', s.name, 'description', s.description, 'agreedScope', s.agreed_scope,
        'deliverables', s.deliverables, 'exclusions', s.exclusions, 'notes', s.notes) order by s.position) from leadflow_private.client_services s where s.client_id = target_client and s.status = 'confirmed'), '[]'::jsonb),
    'scope', (select jsonb_build_object('id', s.id, 'sequence', s.sequence, 'confirmedAt', s.confirmed_at, 'snapshot', s.snapshot, 'outstandingQuestions', s.outstanding_questions,
        'clientAcknowledgedAt', s.client_acknowledged_at) from leadflow_private.client_scope_confirmations s where s.client_id = target_client and s.superseded_at is null),
    'requirements', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'description', r.description, 'category', r.category, 'priority', r.priority,
        'service', (select s.name from leadflow_private.client_services s where s.id = r.client_service_id)) order by r.created_at)
      from leadflow_private.client_requirements r where r.client_id = target_client and r.status = 'confirmed'), '[]'::jsonb),
    'dependencies', coalesce((select jsonb_agg(jsonb_build_object('title', r.title, 'description', r.description, 'category', r.category))
      from leadflow_private.client_requirements r where r.client_id = target_client and r.status = 'confirmed' and r.category in ('dependency','constraint','assumption')), '[]'::jsonb),
    'expectations', coalesce((select jsonb_agg(jsonb_build_object('title', r.title, 'description', r.description))
      from leadflow_private.client_requirements r where r.client_id = target_client and r.status = 'confirmed' and r.category in ('expectation','success_criteria')), '[]'::jsonb),
    'exclusions', coalesce((select jsonb_agg(jsonb_build_object('service', s.name, 'text', s.exclusions)) from leadflow_private.client_services s
      where s.client_id = target_client and s.status = 'confirmed' and s.exclusions <> ''), '[]'::jsonb),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.file_name, 'category', d.category, 'mimeType', d.mime_type, 'size', d.size_bytes, 'visibility', d.visibility) order by d.created_at)
      from leadflow_private.client_documents d where d.status = 'available'
        and (d.client_id = target_client or d.request_id in (select r.id from leadflow_private.onboarding_requests r where r.client_id = target_client))), '[]'::jsonb),
    'onboarding', coalesce((select jsonb_agg(jsonb_build_object('requestId', r.id, 'title', r.title, 'status', r.status,
        'handoffId', (select h.id from leadflow_private.onboarding_handoffs h where h.request_id = r.id)) order by r.created_at)
      from leadflow_private.onboarding_requests r where r.client_id = target_client), '[]'::jsonb),
    'notes', found_client.internal_notes,
    'deal', (select jsonb_build_object('id', d.id, 'title', d.title, 'value', d.value, 'wonValue', d.won_value, 'currency', d.currency, 'actualCloseDate', d.actual_close_date,
        'opportunityTitle', d.opportunity_title, 'handoffId', found_client.deal_handoff_id) from leadflow_private.deals d where d.id = found_client.deal_id));
  insert into leadflow_private.client_onboarding_completions(workspace_id, client_id, completed_by, note, override_reason, outstanding, snapshot)
    values (target_workspace, target_client, leadflow_private.valid_actor(), leadflow_private.onboarding_clean_text(note, 'Note', 2000, false, false), override, outstanding, snapshot)
    returning * into existing;
  update leadflow_private.clients c set status = case when c.status = 'onboarding' then 'active' else c.status end, status_changed_at = case when c.status = 'onboarding' then now() else c.status_changed_at end,
    version = c.version + 1 where c.id = target_client;
  perform leadflow_private.client_event(target_client, 'onboarding_completed', case when override is null then 'Onboarding completed: ready for project delivery'
      else 'Onboarding completed with ' || jsonb_array_length(outstanding) || ' item(s) outstanding: ' || left(override, 150) end,
    jsonb_strip_nulls(jsonb_build_object('completionId', existing.id, 'overrideReason', override, 'outstanding', case when override is not null then outstanding end)), 'member', 'completion', existing.id::text);
  return jsonb_build_object('id', existing.id, 'completedAt', existing.completed_at, 'repeated', false);
end $$;

-- The M11 handoff record, as completed.
create function public.client_handoff_for(target_workspace uuid, target_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return (select jsonb_build_object('id', c.id, 'clientId', c.client_id, 'completedAt', c.completed_at, 'note', c.note, 'overrideReason', c.override_reason, 'outstanding', c.outstanding, 'snapshot', c.snapshot)
    from leadflow_private.client_onboarding_completions c where c.client_id = target_client and c.workspace_id = target_workspace);
end $$;

-- ---------- Snapshot save and task checks ----------

-- The snapshot save as M9 defined it, with the client and onboarding task fields (202611230001_sales_pipeline.sql).
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
      "clientId", "onboardingRequestId", "onboardingItemId")
    select target_workspace, x.id, x."leadId", x.due, x.notes, x.completed, x."dealId", x."contactId", coalesce(x."taskType", 'follow_up'), coalesce(x.priority, 'medium'),
      coalesce(x.cancelled, false), coalesce(x.description, ''), x."assigneeId", x."createdAt", x."completedAt", x."clientId", x."onboardingRequestId", x."onboardingItemId"
    from jsonb_to_recordset(payload->'tasks') as x(id text, "leadId" text, due date, notes text, completed boolean, "dealId" uuid, "contactId" uuid, "taskType" text, priority text,
      cancelled boolean, description text, "assigneeId" uuid, "createdAt" timestamptz, "completedAt" timestamptz, "clientId" uuid, "onboardingRequestId" uuid, "onboardingItemId" uuid);
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

-- As M9 defined it, plus: an onboarding task's request must belong to the task's client.
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
  return new;
end $$;

-- ---------- Stages ----------

create function public.onboarding_stages_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  perform leadflow_private.ensure_onboarding_stages(target_workspace);
  return jsonb_build_object('canConfigure', actor_role <> 'member', 'stages', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'key', s.key, 'name', s.name, 'description', s.description,
      'position', s.position, 'archived', s.archived_at is not null,
      'inUse', (select count(*) from leadflow_private.onboarding_items i where i.stage_id = s.id) + (select count(*) from leadflow_private.onboarding_steps x where x.stage_id = s.id)
        + (select count(*) from leadflow_private.onboarding_template_items i where i.stage_id = s.id) + (select count(*) from leadflow_private.onboarding_template_steps x where x.stage_id = s.id))
    order by s.archived_at is not null, s.position) from leadflow_private.onboarding_stages s where s.workspace_id = target_workspace), '[]'::jsonb));
end $$;

-- Owners and admins. Adds (no id) or renames a stage. New stages go before "Onboarding completed".
create function public.save_onboarding_stage(target_workspace uuid, stage jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare target uuid; clean_name text; clean_description text; last_position integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  perform leadflow_private.ensure_onboarding_stages(target_workspace);
  if stage is null or jsonb_typeof(stage) <> 'object' then raise exception 'Send the stage as an object.' using errcode = '22023'; end if;
  clean_name := leadflow_private.onboarding_clean_text(stage->>'name', 'Stage name', 60, true);
  clean_description := leadflow_private.onboarding_clean_text(stage->>'description', 'Stage description', 500, false, false);
  begin
    if nullif(stage->>'id', '') is null then
      if (select count(*) from leadflow_private.onboarding_stages s where s.workspace_id = target_workspace) >= 30 then raise exception 'A workspace can have at most 30 stages.' using errcode = '54000'; end if;
      select coalesce((select s.position from leadflow_private.onboarding_stages s where s.workspace_id = target_workspace and s.key = 'completed' and s.archived_at is null),
        (select max(s.position) + 1 from leadflow_private.onboarding_stages s where s.workspace_id = target_workspace and s.archived_at is null), 0) into last_position;
      update leadflow_private.onboarding_stages s set position = s.position + 1 where s.workspace_id = target_workspace and s.position >= last_position;
      insert into leadflow_private.onboarding_stages(workspace_id, name, description, position) values (target_workspace, clean_name, clean_description, last_position) returning id into target;
    else
      update leadflow_private.onboarding_stages s set name = clean_name, description = clean_description where s.workspace_id = target_workspace and s.id::text = stage->>'id' returning id into target;
      if target is null then raise exception 'Stage not found in this workspace.' using errcode = 'P0002'; end if;
    end if;
  exception when unique_violation then raise exception 'A stage called “%” already exists.', clean_name using errcode = '22023';
  end;
  return target;
end $$;

-- Owners and admins. stage_ids lists every active stage once, in the new order.
create function public.reorder_onboarding_stages(target_workspace uuid, stage_ids jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare given text[];
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if jsonb_typeof(stage_ids) is distinct from 'array' then raise exception 'Send the stages in their new order.' using errcode = '22023'; end if;
  select array_agg(value) into given from jsonb_array_elements_text(stage_ids);
  if coalesce(cardinality(given), 0) <> (select count(*) from leadflow_private.onboarding_stages s where s.workspace_id = target_workspace and s.archived_at is null)
      or cardinality(given) <> (select count(distinct x) from unnest(given) x)
      or exists (select 1 from unnest(given) x where not exists (select 1 from leadflow_private.onboarding_stages s where s.workspace_id = target_workspace and s.archived_at is null and s.id::text = x)) then
    raise exception 'The order must list every active stage once. Reload and try again.' using errcode = '22023';
  end if;
  update leadflow_private.onboarding_stages s set position = o.ordinality - 1 from unnest(given) with ordinality as o(id, ordinality) where s.id::text = o.id and s.workspace_id = target_workspace;
  update leadflow_private.onboarding_stages s set position = 500 + s.position where s.workspace_id = target_workspace and s.archived_at is not null and s.position < 500;
end $$;

-- Owners and admins. Archived stages stay attached to existing items and steps (shown while they hold work) but can't be
-- chosen for new ones. At least two stages stay active.
create function public.set_onboarding_stage_archived(target_workspace uuid, target_stage uuid, archive boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if archive and (select count(*) from leadflow_private.onboarding_stages s where s.workspace_id = target_workspace and s.archived_at is null) <= 2 then
    raise exception 'Keep at least two active stages.' using errcode = '55000';
  end if;
  begin
    update leadflow_private.onboarding_stages s set archived_at = case when archive then now() end,
      position = case when archive then s.position else (select coalesce(max(x.position) + 1, 0) from leadflow_private.onboarding_stages x where x.workspace_id = target_workspace and x.archived_at is null) end
      where s.workspace_id = target_workspace and s.id = target_stage and (s.archived_at is null) = archive;
    if not found then raise exception 'Stage not found, or already %.', case when archive then 'archived' else 'active' end using errcode = 'P0002'; end if;
  exception when unique_violation then raise exception 'An active stage already uses this name. Rename one of them first.' using errcode = '22023';
  end;
end $$;

-- ---------- Forms ----------

create function public.onboarding_forms_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return jsonb_build_object('canEdit', actor_role <> 'member', 'forms', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'description', f.description, 'archived', f.archived,
      'version', f.version, 'updatedAt', f.updated_at,
      'fieldCount', (select count(*) from leadflow_private.onboarding_form_fields x where x.form_id = f.id and x.kind not in ('heading','info')),
      'requiredCount', (select count(*) from leadflow_private.onboarding_form_fields x where x.form_id = f.id and x.required),
      'assignments', (select count(*) from leadflow_private.onboarding_form_assignments a where a.form_id = f.id)) order by f.archived, lower(f.name))
    from leadflow_private.onboarding_forms f where f.workspace_id = target_workspace), '[]'::jsonb));
end $$;

create function public.onboarding_form_for(target_workspace uuid, target_form uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select jsonb_build_object('id', f.id, 'name', f.name, 'description', f.description, 'archived', f.archived, 'version', f.version,
    'fields', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'section', x.section, 'title', x.title, 'guidance', x.guidance, 'kind', x.kind, 'options', x.options,
        'required', x.required, 'config', x.config) order by x.position) from leadflow_private.onboarding_form_fields x where x.form_id = f.id), '[]'::jsonb))
  into result from leadflow_private.onboarding_forms f where f.id = target_form and f.workspace_id = target_workspace;
  if result is null then raise exception 'Form not found in this workspace.' using errcode = 'P0002'; end if;
  return result;
end $$;

-- Owners and admins. Creates (idempotent per request ID) or replaces a form. Forms already assigned keep their copies.
create function public.save_onboarding_form(target_workspace uuid, definition jsonb, expected_version integer, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing leadflow_private.onboarding_forms; clean_name text; clean_description text; fields jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if definition is null or jsonb_typeof(definition) <> 'object' then raise exception 'Send the form as an object.' using errcode = '22023'; end if;
  clean_name := leadflow_private.onboarding_clean_text(definition->>'name', 'Form name', 100, true);
  clean_description := leadflow_private.onboarding_clean_text(definition->>'description', 'Description', 1000, false, false);
  if jsonb_typeof(definition->'fields') is distinct from 'array' or jsonb_array_length(definition->'fields') not between 1 and 100 then raise exception 'A form needs 1 to 100 fields.' using errcode = '22023'; end if;
  select jsonb_agg(leadflow_private.onboarding_clean_item(raw - 'stageId' - 'stage' - 'dueDate') order by n) into fields from jsonb_array_elements(definition->'fields') with ordinality as e(raw, n);
  begin
    if nullif(definition->>'id', '') is null then
      if request_id is not null then
        select * into existing from leadflow_private.onboarding_forms f where f.workspace_id = target_workspace and f.creation_request_id = save_onboarding_form.request_id;
        if found then return jsonb_build_object('id', existing.id, 'version', existing.version); end if;
      end if;
      if (select count(*) from leadflow_private.onboarding_forms f where f.workspace_id = target_workspace) >= 100 then raise exception 'A workspace can have at most 100 forms.' using errcode = '54000'; end if;
      insert into leadflow_private.onboarding_forms(workspace_id, name, description, creation_request_id) values (target_workspace, clean_name, clean_description, request_id) returning * into existing;
    else
      select * into existing from leadflow_private.onboarding_forms f where f.workspace_id = target_workspace and f.id::text = definition->>'id' for update;
      if not found then raise exception 'Form not found in this workspace.' using errcode = 'P0002'; end if;
      if expected_version is null or existing.version <> expected_version then raise exception 'This form was changed in another session. Reload it and try again.' using errcode = '40001'; end if;
      update leadflow_private.onboarding_forms f set name = clean_name, description = clean_description, version = f.version + 1 where f.id = existing.id returning * into existing;
      delete from leadflow_private.onboarding_form_fields x where x.form_id = existing.id;
    end if;
  exception when unique_violation then raise exception 'A form called “%” already exists.', clean_name using errcode = '22023';
  end;
  insert into leadflow_private.onboarding_form_fields(workspace_id, form_id, position, section, title, guidance, kind, options, required, config)
    select target_workspace, existing.id, (n - 1)::integer, c->>'section', c->>'title', c->>'guidance', c->>'kind', c->'options', (c->>'required')::boolean, c->'config'
    from jsonb_array_elements(fields) with ordinality as e(c, n);
  return jsonb_build_object('id', existing.id, 'version', existing.version);
end $$;

create function public.duplicate_onboarding_form(target_workspace uuid, target_form uuid, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare source leadflow_private.onboarding_forms; created leadflow_private.onboarding_forms; copy_name text; attempt integer := 1;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  select * into created from leadflow_private.onboarding_forms f where f.workspace_id = target_workspace and f.creation_request_id = duplicate_onboarding_form.request_id;
  if found then return jsonb_build_object('id', created.id, 'version', created.version); end if;
  select * into source from leadflow_private.onboarding_forms f where f.workspace_id = target_workspace and f.id = target_form;
  if not found then raise exception 'Form not found in this workspace.' using errcode = 'P0002'; end if;
  loop
    copy_name := left(source.name, 90) || ' (copy' || case when attempt > 1 then ' ' || attempt else '' end || ')';
    exit when not exists (select 1 from leadflow_private.onboarding_forms f where f.workspace_id = target_workspace and not f.archived and lower(btrim(f.name)) = lower(copy_name));
    attempt := attempt + 1;
  end loop;
  insert into leadflow_private.onboarding_forms(workspace_id, name, description, creation_request_id) values (target_workspace, copy_name, source.description, request_id) returning * into created;
  insert into leadflow_private.onboarding_form_fields(workspace_id, form_id, position, section, title, guidance, kind, options, required, config)
    select target_workspace, created.id, x.position, x.section, x.title, x.guidance, x.kind, x.options, x.required, x.config from leadflow_private.onboarding_form_fields x where x.form_id = source.id;
  return jsonb_build_object('id', created.id, 'version', created.version);
end $$;

create function public.set_onboarding_form_archived(target_workspace uuid, target_form uuid, archive boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  begin
    update leadflow_private.onboarding_forms f set archived = coalesce(archive, f.archived), version = f.version + 1 where f.id = target_form and f.workspace_id = target_workspace;
    if not found then raise exception 'Form not found in this workspace.' using errcode = 'P0002'; end if;
  exception when unique_violation then raise exception 'An active form already uses this name. Rename one of them first.' using errcode = '22023';
  end;
end $$;

-- Any member. Copies a form's fields into a request as items grouped under the form, in the chosen stage.
create function public.assign_onboarding_form(target_workspace uuid, target_request uuid, target_form uuid, stage text, expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; source leadflow_private.onboarding_forms; assignment leadflow_private.onboarding_form_assignments; stage_ref uuid; next_position integer; added integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, expected_version);
  perform leadflow_private.require_open_onboarding(request);
  select * into source from leadflow_private.onboarding_forms f where f.id = target_form and f.workspace_id = target_workspace and not f.archived;
  if not found then raise exception 'Form not found in this workspace.' using errcode = 'P0002'; end if;
  stage_ref := leadflow_private.onboarding_stage_ref(target_workspace, stage);
  if (select count(*) from leadflow_private.onboarding_items i where i.request_id = target_request)
      + (select count(*) from leadflow_private.onboarding_form_fields x where x.form_id = source.id) > 100 then
    raise exception 'A request can have at most 100 items. Remove some before adding this form.' using errcode = '54000';
  end if;
  insert into leadflow_private.onboarding_form_assignments(workspace_id, request_id, form_id, form_name, form_version, assigned_by)
    values (target_workspace, target_request, source.id, source.name, source.version, leadflow_private.valid_actor()) returning * into assignment;
  select coalesce(max(i.position) + 1, 0) into next_position from leadflow_private.onboarding_items i where i.request_id = target_request;
  insert into leadflow_private.onboarding_items(workspace_id, request_id, position, section, title, guidance, kind, options, required, config, form_name, assignment_id, stage_id)
    select target_workspace, target_request, next_position + x.position, x.section, x.title, x.guidance, x.kind, x.options, x.required, x.config, source.name, assignment.id, stage_ref
    from leadflow_private.onboarding_form_fields x where x.form_id = source.id;
  get diagnostics added = row_count;
  update leadflow_private.onboarding_requests set version = version + 1 where id = target_request;
  perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(), 'form_assigned', jsonb_build_object('form', source.name, 'fields', added));
  if request.client_id is not null then
    perform leadflow_private.client_event(request.client_id, 'onboarding_form_assigned', 'Form “' || source.name || '” added to “' || request.title || '”',
      jsonb_build_object('requestId', target_request, 'formId', source.id), 'member', 'onboarding_request', target_request::text);
  end if;
  perform leadflow_private.refresh_onboarding(target_request);
  return jsonb_build_object('assignmentId', assignment.id, 'fields', added, 'version', request.version + 1);
end $$;

-- ---------- Documents ----------

-- Allowed file types, by extension and the MIME type LeadFlow stores for it. Keep in step with
-- supabase/functions/_shared/files.ts, which also checks each file's content signature.
create function leadflow_private.document_type_allowed(file_extension text, file_mime text) returns boolean language sql immutable set search_path = '' as $$
  select (file_extension, file_mime) in (values ('pdf','application/pdf'), ('png','image/png'), ('jpg','image/jpeg'), ('jpeg','image/jpeg'), ('gif','image/gif'), ('webp','image/webp'),
    ('txt','text/plain'), ('csv','text/csv'), ('md','text/markdown'), ('doc','application/msword'), ('docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ('xls','application/vnd.ms-excel'), ('xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), ('ppt','application/vnd.ms-powerpoint'),
    ('pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation'), ('zip','application/zip'), ('mp4','video/mp4'), ('mov','video/quicktime'),
    ('webm','video/webm'), ('mp3','audio/mpeg'), ('psd','image/vnd.adobe.photoshop'))
$$;

-- Validates an upload request and records it as pending. The file is usable only after the upload is checked.
create function leadflow_private.begin_document(target_workspace uuid, target_client uuid, target_request uuid, target_item uuid, details jsonb, kind_of_uploader text, uploader uuid, link uuid, max_bytes bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare clean_name text; ext text; mime text; size_value numeric; category_value text; created leadflow_private.client_documents; document_id uuid := gen_random_uuid();
begin
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the file details as an object.' using errcode = '22023'; end if;
  clean_name := leadflow_private.onboarding_clean_text(regexp_replace(coalesce(details->>'fileName', ''), '[/\\[:cntrl:]]', '_', 'g'), 'File name', 200, true);
  ext := lower(coalesce(substring(clean_name from '\.([A-Za-z0-9]{1,8})$'), ''));
  mime := coalesce(details->>'mimeType', '');
  if not leadflow_private.document_type_allowed(ext, mime) then
    raise exception 'This type of file can''t be uploaded. Use PDF, images (PNG, JPG, GIF, WebP), Office documents, text, CSV, ZIP, MP4, MOV, WebM, MP3 or PSD.' using errcode = '22023';
  end if;
  if jsonb_typeof(details->'size') <> 'number' then raise exception 'Send the file size.' using errcode = '22023'; end if;
  size_value := (details->>'size')::numeric;
  if size_value < 1 or size_value % 1 <> 0 then raise exception 'The file is empty.' using errcode = '22023'; end if;
  if size_value > least(coalesce(max_bytes, 26214400), 52428800) then
    raise exception 'Files can be up to % MB.', least(coalesce(max_bytes, 26214400), 52428800) / 1048576 using errcode = '22023';
  end if;
  category_value := coalesce(nullif(details->>'category', ''), 'other');
  if category_value not in ('brand','logo','image','video','content','requirements','design_reference','technical','access_instructions','other') then raise exception 'Choose a document category.' using errcode = '22023'; end if;
  if coalesce(details->>'visibility', 'internal') not in ('internal','shared') then raise exception 'Choose who can see the file.' using errcode = '22023'; end if;
  -- Abandoned uploads (never checked) stop counting after a day.
  update leadflow_private.client_documents d set status = 'rejected', rejected_reason = 'Upload not completed'
    where d.workspace_id = target_workspace and d.status = 'pending' and d.created_at < now() - interval '1 day';
  if (select count(*) from leadflow_private.client_documents d where d.workspace_id = target_workspace and d.status = 'pending') >= 50 then
    raise exception 'Too many uploads are in progress. Finish or retry them first.' using errcode = '54000';
  end if;
  if target_client is not null and (select count(*) from leadflow_private.client_documents d where d.client_id = target_client and d.status in ('pending','available')) >= 1000 then
    raise exception 'A client can have at most 1,000 files.' using errcode = '54000';
  end if;
  insert into leadflow_private.client_documents(id, workspace_id, client_id, request_id, item_id, storage_path, file_name, extension, mime_type, size_bytes, category, description, visibility,
      uploader_type, uploaded_by, uploaded_link, stage_id)
    values (document_id, target_workspace, target_client, target_request, target_item, target_workspace::text || '/' || document_id::text, clean_name, ext, mime, size_value::bigint, category_value,
      leadflow_private.onboarding_clean_text(details->>'description', 'Description', 1000, false, false), coalesce(details->>'visibility', 'internal'),
      kind_of_uploader, uploader, link, leadflow_private.onboarding_stage_ref(target_workspace, details->>'stageId'))
    returning * into created;
  return jsonb_build_object('id', created.id, 'path', created.storage_path, 'fileName', created.file_name, 'mimeType', created.mime_type, 'size', created.size_bytes);
end $$;

create function leadflow_private.document_json(d leadflow_private.client_documents) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'clientId', d.client_id, 'requestId', d.request_id, 'itemId', d.item_id, 'fileName', d.file_name, 'extension', d.extension, 'mimeType', d.mime_type,
    'size', d.size_bytes, 'category', d.category, 'description', d.description, 'visibility', d.visibility, 'status', d.status, 'rejectedReason', d.rejected_reason, 'uploaderType', d.uploader_type,
    'uploadedBy', case when d.uploader_type = 'client' then 'Client' else (select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = d.uploaded_by) end,
    'stageId', d.stage_id, 'createdAt', d.created_at, 'verifiedAt', d.verified_at,
    'itemTitle', (select i.title from leadflow_private.onboarding_items i where i.request_id = d.request_id and i.id = d.item_id))
$$;

-- Any member, called by the client-files Edge Function with the member's own token. max_bytes is the function's limit.
-- details: { fileName, mimeType, size, category, description, visibility, requestId?, stageId? }.
create function public.begin_client_document(target_workspace uuid, target_client uuid, details jsonb, max_bytes bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; request_ref uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into found_client from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace;
  if not found then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  if found_client.status = 'archived' then raise exception 'Unarchive this client before adding files.' using errcode = '55000'; end if;
  if nullif(details->>'requestId', '') is not null then
    select r.id into request_ref from leadflow_private.onboarding_requests r where r.client_id = target_client and r.id::text = details->>'requestId';
    if request_ref is null then raise exception 'That onboarding request isn''t this client''s.' using errcode = '22023'; end if;
  end if;
  return leadflow_private.begin_document(target_workspace, target_client, request_ref, null, details - 'requestId', 'member', leadflow_private.valid_actor(), null, max_bytes);
end $$;

-- Any member. The stored file's path for a download or an upload check; only this workspace's files.
create function public.client_document_access(target_workspace uuid, target_document uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.client_documents;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into d from leadflow_private.client_documents x where x.id = target_document and x.workspace_id = target_workspace and x.status in ('pending','available');
  if not found then raise exception 'File not found.' using errcode = 'P0002'; end if;
  return leadflow_private.document_json(d) || jsonb_build_object('path', d.storage_path);
end $$;

create function public.client_documents_for(target_workspace uuid, target_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace) then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  return coalesce((select jsonb_agg(leadflow_private.document_json(d) order by d.created_at desc) from leadflow_private.client_documents d
    where d.workspace_id = target_workspace and d.status in ('available','pending') and (d.status = 'available' or d.created_at > now() - interval '1 day')
      and (d.client_id = target_client or d.request_id in (select r.id from leadflow_private.onboarding_requests r where r.client_id = target_client))), '[]'::jsonb);
end $$;

-- Any member: category, description and who can see a file.
create function public.update_client_document(target_workspace uuid, target_document uuid, changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.client_documents;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if changes is null or jsonb_typeof(changes) <> 'object' then raise exception 'Send the changes as an object.' using errcode = '22023'; end if;
  if changes ? 'category' and changes->>'category' not in ('brand','logo','image','video','content','requirements','design_reference','technical','access_instructions','other') then raise exception 'Choose a document category.' using errcode = '22023'; end if;
  if changes ? 'visibility' and changes->>'visibility' not in ('internal','shared') then raise exception 'Choose who can see the file.' using errcode = '22023'; end if;
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

-- Owners, admins, or the member who uploaded it. Marks the file deleted and returns its path for removal from storage.
create function public.delete_client_document(target_workspace uuid, target_document uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text; d leadflow_private.client_documents;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  select * into d from leadflow_private.client_documents x where x.id = target_document and x.workspace_id = target_workspace and x.status <> 'deleted' for update;
  if not found then raise exception 'File not found.' using errcode = 'P0002'; end if;
  if actor_role = 'member' and (d.uploader_type <> 'member' or d.uploaded_by is distinct from leadflow_private.valid_actor()) then
    raise exception 'Only owners, admins or the person who uploaded a file can delete it.' using errcode = '42501';
  end if;
  if d.item_id is not null and exists (select 1 from leadflow_private.onboarding_items i where i.request_id = d.request_id and i.id = d.item_id and i.response->'files' ? d.id::text and i.state = 'accepted') then
    raise exception 'This file is part of an accepted answer. Request changes on the answer first.' using errcode = '55000';
  end if;
  update leadflow_private.client_documents x set status = 'deleted', deleted_at = now(), deleted_by = leadflow_private.valid_actor() where x.id = d.id;
  if d.client_id is not null then
    perform leadflow_private.client_event(d.client_id, 'document_removed', 'File removed: ' || d.file_name, jsonb_build_object('category', d.category), 'member', 'document', d.id::text);
  end if;
  return jsonb_build_object('path', d.storage_path);
end $$;

-- Service role, after the Edge Function checked the stored object. ok = false rejects it (wrong type, size or signature).
create function public.finish_client_document(target_document uuid, ok boolean, actual_size bigint, reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.client_documents;
begin
  select * into d from leadflow_private.client_documents x where x.id = target_document for update;
  if not found then raise exception 'File not found.' using errcode = 'P0002'; end if;
  if d.status <> 'pending' then return leadflow_private.document_json(d); end if;
  if ok then
    update leadflow_private.client_documents x set status = 'available', verified_at = now(), size_bytes = coalesce(actual_size, x.size_bytes) where x.id = d.id returning * into d;
    if d.client_id is not null then
      perform leadflow_private.client_event(d.client_id, 'document_uploaded', 'File uploaded' || case when d.uploader_type = 'client' then ' by the client' else '' end || ': ' || d.file_name,
        jsonb_build_object('category', d.category, 'size', d.size_bytes, 'visibility', d.visibility, 'itemId', d.item_id), case when d.uploader_type = 'client' then 'client' else 'system' end,
        'document', d.id::text);
    end if;
  else
    update leadflow_private.client_documents x set status = 'rejected', rejected_reason = left(coalesce(reason, 'The file failed the upload checks.'), 200) where x.id = d.id returning * into d;
  end if;
  return leadflow_private.document_json(d);
end $$;

-- ---------- Client portal ----------

-- As before, plus field settings, uploaded file names, the client's shared files and the agreed scope when the agency
-- shares it. Still nothing internal: no notes, deal values, AI analysis, internal steps, members or other clients.
create or replace function leadflow_private.portal_view(target_request uuid, link leadflow_private.onboarding_links) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('agencyName', w.name, 'title', r.title, 'clientName', r.client_name, 'status', r.status,
    'linkExpiresAt', link.expires_at,
    'instructions', case when r.status in ('active','paused','completed') then r.client_instructions else '' end,
    'dueDate', case when r.status in ('active','paused') then r.due_date end,
    'allAccepted', (leadflow_private.onboarding_readiness(r.id)->>'clientItemsMet')::boolean and r.status in ('active','completed'),
    'confirmedAt', r.completed_at,
    'items', case when r.status in ('active','paused','completed') then coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'section', i.section, 'title', i.title,
        'guidance', i.guidance, 'kind', i.kind, 'options', i.options, 'required', i.required, 'dueDate', coalesce(i.due_date, r.due_date), 'state', i.state,
        'value', coalesce(i.draft, i.response), 'hasDraft', i.draft is not null, 'submittedAt', i.submitted_at, 'revision', i.revision,
        'config', i.config - 'category', 'stage', (select s.name from leadflow_private.onboarding_stages s where s.id = i.stage_id),
        'files', case when i.kind = 'file' then coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.file_name, 'size', d.size_bytes, 'status', d.status) order by d.created_at)
          from leadflow_private.client_documents d where d.request_id = r.id and d.item_id = i.id and d.status in ('available','pending') and d.uploader_type = 'client'), '[]'::jsonb) end,
        'feedback', case when i.state in ('changes_requested','accepted') then nullif(i.client_feedback, '') end) order by i.position)
      from leadflow_private.onboarding_items i where i.request_id = r.id), '[]') else '[]'::jsonb end,
    'sharedFiles', case when r.status in ('active','paused','completed') and r.client_id is not null then coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.file_name,
        'size', d.size_bytes, 'category', d.category, 'description', d.description) order by d.created_at desc)
      from leadflow_private.client_documents d where d.client_id = r.client_id and d.visibility = 'shared' and d.status = 'available' and d.uploader_type = 'member'), '[]'::jsonb) else '[]'::jsonb end,
    'scope', (select jsonb_build_object('id', s.id, 'version', s.sequence, 'confirmedAt', s.confirmed_at, 'acknowledgedAt', s.client_acknowledged_at,
        'services', coalesce((select jsonb_agg(jsonb_build_object('name', x->>'name', 'agreedScope', x->>'agreedScope', 'deliverables', x->>'deliverables', 'exclusions', x->>'exclusions'))
          from jsonb_array_elements(s.snapshot->'services') x), '[]'::jsonb),
        'requirements', coalesce((select jsonb_agg(jsonb_build_object('title', x->>'title', 'description', x->>'description', 'category', x->>'category'))
          from jsonb_array_elements(s.snapshot->'requirements') x), '[]'::jsonb),
        'outstandingQuestions', s.outstanding_questions)
      from leadflow_private.client_scope_confirmations s where r.client_id is not null and s.client_id = r.client_id and s.superseded_at is null and s.shared_with_client
        and r.status in ('active','paused','completed')))
  from leadflow_private.onboarding_requests r join public.workspaces w on w.id = r.workspace_id where r.id = target_request
$$;

-- As before, with the new field types, and every submission kept: a resubmission supersedes the unreviewed one before it,
-- and reviewed submissions keep their review.
create or replace function public.portal_save_item(key_hash text, target_item uuid, response_value jsonb, submit boolean, expected_revision integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare link leadflow_private.onboarding_links; request leadflow_private.onboarding_requests; item leadflow_private.onboarding_items; clean jsonb; previous_state text;
begin
  link := leadflow_private.portal_link(key_hash);
  select * into request from leadflow_private.onboarding_requests r where r.id = link.request_id for update;
  if request.status <> 'active' then raise exception 'This onboarding request is not accepting responses right now.' using errcode = '55000'; end if;
  select * into item from leadflow_private.onboarding_items i where i.request_id = link.request_id and i.id = target_item for update;
  if not found then raise exception 'This item is no longer part of the request.' using errcode = '22023'; end if;
  if item.state in ('accepted','not_required') then raise exception 'This item has already been accepted or is no longer needed.' using errcode = '55000'; end if;
  clean := leadflow_private.onboarding_clean_answer(item, response_value, coalesce(submit, false));
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
    update leadflow_private.onboarding_item_responses x set review_state = 'superseded' where x.request_id = link.request_id and x.item_id = target_item and x.review_state = 'pending';
    insert into leadflow_private.onboarding_item_responses(workspace_id, request_id, item_id, revision, response, link_id)
      values (request.workspace_id, link.request_id, target_item, item.revision, clean, link.id);
    perform leadflow_private.onboarding_event(link.request_id, target_item, 'client', null, case previous_state when 'not_started' then 'submitted' else 'resubmitted' end, jsonb_build_object('kind', item.kind));
    perform leadflow_private.refresh_onboarding(link.request_id);
  else
    update leadflow_private.onboarding_items set draft = clean, revision = revision + 1 where request_id = link.request_id and id = target_item returning * into item;
  end if;
  update leadflow_private.onboarding_links set last_used_at = now() where id = link.id;
  return jsonb_build_object('state', item.state, 'revision', item.revision, 'unchanged', false);
end $$;

-- Service role (client-portal). A file upload for a file item of the link's open request.
create function public.portal_begin_upload(key_hash text, target_item uuid, details jsonb, max_bytes bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare link leadflow_private.onboarding_links; request leadflow_private.onboarding_requests; item leadflow_private.onboarding_items; limit_value integer;
begin
  link := leadflow_private.portal_link(key_hash);
  select * into request from leadflow_private.onboarding_requests r where r.id = link.request_id for update;
  if request.status <> 'active' then raise exception 'This onboarding request is not accepting responses right now.' using errcode = '55000'; end if;
  select * into item from leadflow_private.onboarding_items i where i.request_id = link.request_id and i.id = target_item;
  if not found or item.kind <> 'file' then raise exception 'This item doesn''t take files.' using errcode = '22023'; end if;
  if item.state in ('accepted','not_required') then raise exception 'This item has already been accepted or is no longer needed.' using errcode = '55000'; end if;
  limit_value := coalesce((item.config->>'maxFiles')::integer, 5);
  if (select count(*) from leadflow_private.client_documents d where d.request_id = link.request_id and d.item_id = target_item and d.status in ('pending','available')
      and (d.status = 'available' or d.created_at > now() - interval '1 day')) >= limit_value then
    raise exception 'You can upload up to % file% here. Remove one first.', limit_value, case when limit_value = 1 then '' else 's' end using errcode = '22023';
  end if;
  update leadflow_private.onboarding_links set last_used_at = now() where id = link.id;
  return leadflow_private.begin_document(request.workspace_id, request.client_id, request.id, item.id,
    jsonb_build_object('fileName', details->>'fileName', 'mimeType', details->>'mimeType', 'size', details->'size', 'category', coalesce(item.config->>'category', 'other'), 'visibility', 'internal'),
    'client', null, link.id, max_bytes);
end $$;

-- Service role (client-portal). A file the link may download or check: the client's own uploads for this request, or a
-- file the agency shared with this client. purpose 'finish' allows only the link's own pending upload.
create function public.portal_document_access(key_hash text, target_document uuid, purpose text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare link leadflow_private.onboarding_links; request leadflow_private.onboarding_requests; d leadflow_private.client_documents;
begin
  link := leadflow_private.portal_link(key_hash);
  select * into request from leadflow_private.onboarding_requests r where r.id = link.request_id;
  select * into d from leadflow_private.client_documents x where x.id = target_document
    and ((x.request_id = request.id and x.uploader_type = 'client' and x.status in ('pending','available'))
      or (purpose = 'download' and request.client_id is not null and x.client_id = request.client_id and x.visibility = 'shared' and x.uploader_type = 'member' and x.status = 'available'));
  if not found or (purpose = 'finish' and d.status <> 'pending') or (purpose = 'download' and d.status <> 'available') then raise exception 'File not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', d.id, 'path', d.storage_path, 'fileName', d.file_name, 'mimeType', d.mime_type, 'size', d.size_bytes, 'status', d.status);
end $$;

-- Service role (client-portal). Removes one of the client's uploads while its item is still open, and from the draft answer.
create function public.portal_remove_upload(key_hash text, target_document uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare link leadflow_private.onboarding_links; request leadflow_private.onboarding_requests; d leadflow_private.client_documents; item leadflow_private.onboarding_items;
begin
  link := leadflow_private.portal_link(key_hash);
  select * into request from leadflow_private.onboarding_requests r where r.id = link.request_id for update;
  if request.status <> 'active' then raise exception 'This onboarding request is not accepting changes right now.' using errcode = '55000'; end if;
  select * into d from leadflow_private.client_documents x where x.id = target_document and x.request_id = request.id and x.uploader_type = 'client' and x.status in ('pending','available') for update;
  if not found then raise exception 'File not found.' using errcode = 'P0002'; end if;
  select * into item from leadflow_private.onboarding_items i where i.request_id = request.id and i.id = d.item_id for update;
  if item.state in ('accepted','not_required') then raise exception 'This answer has been accepted, so its files can''t be removed.' using errcode = '55000'; end if;
  if item.state = 'submitted' and item.response->'files' ? d.id::text then raise exception 'This file is part of your submitted answer. Your agency can ask for changes if it needs replacing.' using errcode = '55000'; end if;
  update leadflow_private.client_documents x set status = 'deleted', deleted_at = now() where x.id = d.id;
  if item.draft ? 'files' then
    update leadflow_private.onboarding_items i set draft = jsonb_set(i.draft, '{files}', coalesce((select jsonb_agg(f) from jsonb_array_elements(i.draft->'files') f where f #>> '{}' <> d.id::text), '[]'::jsonb)),
      revision = revision + 1 where i.request_id = request.id and i.id = item.id;
  end if;
  return jsonb_build_object('path', d.storage_path);
end $$;

-- Service role (client-portal). Records that the client opened their link and acknowledged the current shared scope.
-- An acknowledgement, not a contract or signature.
create function public.portal_acknowledge_scope(key_hash text, target_confirmation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare link leadflow_private.onboarding_links; request leadflow_private.onboarding_requests; s leadflow_private.client_scope_confirmations;
begin
  link := leadflow_private.portal_link(key_hash);
  select * into request from leadflow_private.onboarding_requests r where r.id = link.request_id;
  select * into s from leadflow_private.client_scope_confirmations x where x.id = target_confirmation and request.client_id is not null and x.client_id = request.client_id
    and x.superseded_at is null and x.shared_with_client for update;
  if not found then raise exception 'This scope is no longer current. Reload the page.' using errcode = '22023'; end if;
  if s.client_acknowledged_at is not null then return jsonb_build_object('acknowledgedAt', s.client_acknowledged_at, 'repeated', true); end if;
  update leadflow_private.client_scope_confirmations x set client_acknowledged_at = now(), client_acknowledged_link = link.id where x.id = s.id;
  perform leadflow_private.client_event(s.client_id, 'scope_acknowledged', 'The client acknowledged the agreed scope (version ' || s.sequence || ') through their private link',
    jsonb_build_object('sequence', s.sequence, 'requestId', request.id), 'client', 'scope', s.id::text);
  perform leadflow_private.onboarding_event(request.id, null, 'client', null, 'scope_acknowledged', jsonb_build_object('sequence', s.sequence));
  return jsonb_build_object('acknowledgedAt', now(), 'repeated', false);
end $$;

-- ---------- Grants ----------
-- Supabase grants new public functions to anon and authenticated by default; restate every grant.
revoke all on function leadflow_private.ensure_onboarding_stages(uuid), leadflow_private.onboarding_stage_ref(uuid, text), leadflow_private.onboarding_clean_step(jsonb),
  leadflow_private.onboarding_clean_answer(leadflow_private.onboarding_items, jsonb, boolean), leadflow_private.onboarding_stage_progress(uuid),
  leadflow_private.client_event(uuid, text, text, jsonb, text, text, text), leadflow_private.lock_client(uuid, uuid, integer), leadflow_private.lock_active_client(uuid, uuid, integer), leadflow_private.client_onboarding_state(uuid),
  leadflow_private.complete_auto_steps(uuid, text, text), leadflow_private.is_onboarding_kind(text), leadflow_private.onboarding_default_stage_key(text, text),
  leadflow_private.onboarding_starter_steps(), leadflow_private.sync_auto_steps(uuid), leadflow_private.clean_client_details(jsonb), leadflow_private.client_owner_ref(uuid, text),
  leadflow_private.clean_client_contact(jsonb), leadflow_private.clean_client_service(jsonb), leadflow_private.add_client_people(leadflow_private.clients, jsonb, jsonb, text, text),
  leadflow_private.client_summary_json(leadflow_private.clients), leadflow_private.client_completion_items(uuid), leadflow_private.document_type_allowed(text, text),
  leadflow_private.begin_document(uuid, uuid, uuid, uuid, jsonb, text, uuid, uuid, bigint), leadflow_private.document_json(leadflow_private.client_documents)
  from public, anon, authenticated;
revoke all on function public.onboarding_item_history(uuid, uuid, uuid), public.save_onboarding_step(uuid, uuid, jsonb, integer), public.remove_onboarding_step(uuid, uuid, uuid, integer),
  public.set_onboarding_step_status(uuid, uuid, uuid, text, text, integer), public.clients_for(uuid, jsonb), public.client_index_for(uuid), public.client_dashboard_for(uuid, jsonb, date),
  public.client_detail(uuid, uuid), public.create_client(uuid, jsonb, uuid), public.convert_deal_to_client(uuid, uuid, jsonb, uuid), public.start_client_onboarding(uuid, uuid, jsonb, uuid),
  public.update_client(uuid, uuid, integer, jsonb), public.set_client_status(uuid, uuid, text, integer, text), public.save_client_contact(uuid, uuid, jsonb),
  public.delete_client_contact(uuid, uuid, uuid), public.save_client_service(uuid, uuid, jsonb), public.save_client_requirement(uuid, uuid, jsonb, integer, uuid),
  public.client_requirement_history(uuid, uuid), public.confirm_client_scope(uuid, uuid, jsonb), public.client_scope_history(uuid, uuid), public.save_client_welcome(uuid, uuid, text, text),
  public.mark_client_welcome_sent(uuid, uuid, text), public.add_client_note(uuid, uuid, text, uuid), public.client_timeline(uuid, uuid, jsonb, timestamptz, integer, text),
  public.client_completion_check(uuid, uuid), public.complete_client_onboarding(uuid, uuid, text, text), public.client_handoff_for(uuid, uuid),
  public.onboarding_stages_for(uuid), public.save_onboarding_stage(uuid, jsonb), public.reorder_onboarding_stages(uuid, jsonb), public.set_onboarding_stage_archived(uuid, uuid, boolean),
  public.onboarding_forms_for(uuid), public.onboarding_form_for(uuid, uuid), public.save_onboarding_form(uuid, jsonb, integer, uuid), public.duplicate_onboarding_form(uuid, uuid, uuid),
  public.set_onboarding_form_archived(uuid, uuid, boolean), public.assign_onboarding_form(uuid, uuid, uuid, text, integer),
  public.begin_client_document(uuid, uuid, jsonb, bigint), public.client_document_access(uuid, uuid), public.client_documents_for(uuid, uuid), public.update_client_document(uuid, uuid, jsonb),
  public.delete_client_document(uuid, uuid), public.finish_client_document(uuid, boolean, bigint, text),
  public.portal_begin_upload(text, uuid, jsonb, bigint), public.portal_document_access(text, uuid, text), public.portal_remove_upload(text, uuid), public.portal_acknowledge_scope(text, uuid)
  from public, anon, authenticated;
grant execute on function public.onboarding_item_history(uuid, uuid, uuid), public.save_onboarding_step(uuid, uuid, jsonb, integer), public.remove_onboarding_step(uuid, uuid, uuid, integer),
  public.set_onboarding_step_status(uuid, uuid, uuid, text, text, integer), public.clients_for(uuid, jsonb), public.client_index_for(uuid), public.client_dashboard_for(uuid, jsonb, date),
  public.client_detail(uuid, uuid), public.create_client(uuid, jsonb, uuid), public.convert_deal_to_client(uuid, uuid, jsonb, uuid), public.start_client_onboarding(uuid, uuid, jsonb, uuid),
  public.update_client(uuid, uuid, integer, jsonb), public.set_client_status(uuid, uuid, text, integer, text), public.save_client_contact(uuid, uuid, jsonb),
  public.delete_client_contact(uuid, uuid, uuid), public.save_client_service(uuid, uuid, jsonb), public.save_client_requirement(uuid, uuid, jsonb, integer, uuid),
  public.client_requirement_history(uuid, uuid), public.confirm_client_scope(uuid, uuid, jsonb), public.client_scope_history(uuid, uuid), public.save_client_welcome(uuid, uuid, text, text),
  public.mark_client_welcome_sent(uuid, uuid, text), public.add_client_note(uuid, uuid, text, uuid), public.client_timeline(uuid, uuid, jsonb, timestamptz, integer, text),
  public.client_completion_check(uuid, uuid), public.complete_client_onboarding(uuid, uuid, text, text), public.client_handoff_for(uuid, uuid),
  public.onboarding_stages_for(uuid), public.save_onboarding_stage(uuid, jsonb), public.reorder_onboarding_stages(uuid, jsonb), public.set_onboarding_stage_archived(uuid, uuid, boolean),
  public.onboarding_forms_for(uuid), public.onboarding_form_for(uuid, uuid), public.save_onboarding_form(uuid, jsonb, integer, uuid), public.duplicate_onboarding_form(uuid, uuid, uuid),
  public.set_onboarding_form_archived(uuid, uuid, boolean), public.assign_onboarding_form(uuid, uuid, uuid, text, integer),
  public.begin_client_document(uuid, uuid, jsonb, bigint), public.client_document_access(uuid, uuid), public.client_documents_for(uuid, uuid), public.update_client_document(uuid, uuid, jsonb),
  public.delete_client_document(uuid, uuid)
  to authenticated;
grant execute on function public.finish_client_document(uuid, boolean, bigint, text), public.portal_begin_upload(text, uuid, jsonb, bigint), public.portal_document_access(text, uuid, text),
  public.portal_remove_upload(text, uuid), public.portal_acknowledge_scope(text, uuid) to service_role;
