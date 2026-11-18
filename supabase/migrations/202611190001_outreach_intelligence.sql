-- M8 contact intelligence and outreach drafts.
-- * Contacts: the people and business inboxes/lines of a lead, each with every source it came from (lead_contact_sources),
--   so discovered values survive a user's edits. Discovery merges into existing contacts and never overwrites a contact
--   the team confirmed or a field the team edited: differing values become suggestions the team accepts or dismisses.
--   Deleting a contact remembers hashes of its email, phone, provider ID and name, so discovery doesn't collect it again.
-- * Discovery jobs: advanced one short step at a time by the outreach and analysis-worker Edge Functions under a lease,
--   like business analyses. One active job per lead; request IDs make starts idempotent.
-- * Drafts: email, WhatsApp and LinkedIn drafts with every version kept (generated, regenerated, edited, restored).
--   Regenerating never replaces an edited version without the caller's explicit confirmation, and "sent" is only ever set
--   by a person's explicit action. Each draft keeps the claims it made and the findings and evidence behind them.
-- * Preferences: the workspace's outreach settings, with each member's own sender details on top.
-- * Usage: every provider call made for contacts or drafts, with quantities only as reported or counted.
-- Leads are referenced by ID without a foreign key (snapshot saves replace them), as in business analysis.
-- All tables are private; members act through role-checked functions, the Edge Functions through service-role functions.
-- Reverse with supabase/rollbacks/202611190001_outreach_intelligence.down.sql.

create function leadflow_private.is_contact_role(candidate text) returns boolean language sql immutable set search_path = '' as $$
  select candidate in ('owner','founder','ceo','managing_director','marketing','operations','business_development','sales','decision_maker','general','support','other')
$$;
-- The same rules as roleFor() in supabase/functions/_shared/outreach/contacts.ts, for titles that arrive from Apollo.
create function leadflow_private.role_for_title(title text) returns text language sql immutable set search_path = '' as $$
  select case
    when title ~* '(co-?founder|founder|founding partner)' then 'founder' when title ~* '(owner|proprietor)' then 'owner'
    when title ~* '(\mceo\M|chief executive|president)' then 'ceo' when title ~* '(managing director|general manager)' then 'managing_director'
    when title ~* '(\mcmo\M|chief marketing|marketing|brand|growth|digital|communications)' then 'marketing'
    when title ~* '(\mcoo\M|chief operating|operations|office manager|practice manager)' then 'operations'
    when title ~* '(business development|partnership)' then 'business_development' when title ~* '(sales|account executive|account manager)' then 'sales'
    when title ~* '(director|principal|partner|head of|vice president|\mvp\M|chief [a-z]+ officer|\mcto\M|\mcfo\M)' then 'decision_maker'
    else 'other' end
$$;
create function leadflow_private.name_key(name text) returns text language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(lower(btrim(coalesce(name, ''))), '^(dr|mr|mrs|ms|miss|mx|prof)\.?\s+', ''), '[^[:alpha:][:space:]''-]', '', 'g'), '\s+', ' ', 'g'))
$$;
create function leadflow_private.contact_hash(value text) returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(value, 'UTF8')), 'hex')
$$;
-- Hashes of what identifies a contact, remembered when it is deleted so discovery doesn't collect it again.
create function leadflow_private.contact_key_hashes(kind text, email text, phone_e164 text, provider text, provider_ref text, full_name text) returns text[]
language sql immutable set search_path = '' as $$
  select array_remove(array[
    case when coalesce(email, '') <> '' then leadflow_private.contact_hash('email:' || lower(email)) end,
    case when coalesce(phone_e164, '') <> '' and kind = 'business' then leadflow_private.contact_hash('phone:' || phone_e164) end,
    case when coalesce(provider_ref, '') <> '' then leadflow_private.contact_hash('ref:' || coalesce(provider, '') || ':' || provider_ref) end,
    case when kind = 'person' and leadflow_private.name_key(full_name) <> '' then leadflow_private.contact_hash('name:' || leadflow_private.name_key(full_name)) end], null)
$$;

create table leadflow_private.lead_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null check (length(lead_id) between 1 and 200),
  kind text not null check (kind in ('person','business')),
  -- For business contacts: what the inbox or line is for, e.g. "General inquiries".
  label text not null default '' check (length(label) <= 80),
  full_name text not null default '' check (length(full_name) <= 150),
  job_title text not null default '' check (length(job_title) <= 150),
  role text not null default 'other' check (leadflow_private.is_contact_role(role)),
  email text not null default '' check (email = '' or (length(email) <= 150 and email = lower(email) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  email_status text not null default 'unknown' check (email_status in ('verified','likely_valid','unverified','invalid','risky','unknown')),
  -- How the status was reached: { method, outcome, mx, detail, checkedAt }.
  email_check jsonb check (email_check is null or (jsonb_typeof(email_check) = 'object' and octet_length(email_check::text) <= 2000)),
  email_checked_at timestamptz,
  phone text not null default '' check (length(phone) <= 40),
  phone_e164 text not null default '' check (phone_e164 = '' or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_status text not null default 'unverified' check (phone_status in ('valid_format','invalid_format','unverified','provider_verified')),
  -- Set only from a WhatsApp link the business published (or a person entering it); a phone number alone never sets it.
  whatsapp text not null default '' check (whatsapp = '' or whatsapp ~ '^\+[1-9][0-9]{6,14}$'),
  linkedin_url text not null default '' check (linkedin_url = '' or (length(linkedin_url) <= 300 and linkedin_url ~* '^https?://')),
  profile_url text not null default '' check (profile_url = '' or (length(profile_url) <= 300 and profile_url ~* '^https?://')),
  provider text check (provider ~ '^[a-z_]{1,30}$'),
  provider_ref text check (length(provider_ref) between 1 and 100),
  notes text not null default '' check (length(notes) <= 2000),
  is_primary boolean not null default false,
  is_preferred boolean not null default false,
  confirmed boolean not null default false,
  confirmed_by uuid,
  confirmed_at timestamptz,
  -- Fields the team changed by hand; discovery never changes them.
  edited_fields text[] not null default '{}' check (cardinality(edited_fields) <= 20),
  -- Values discovery found that differ from protected ones: [{ field, value, source, sourceUrl, observedAt }].
  suggestions jsonb not null default '[]' check (jsonb_typeof(suggestions) = 'array' and octet_length(suggestions::text) <= 8000),
  dismissed_suggestions text[] not null default '{}' check (cardinality(dismissed_suggestions) <= 200),
  origin text not null check (origin in ('discovered','manual','apollo')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  check (full_name <> '' or email <> '' or phone <> '' or whatsapp <> '' or linkedin_url <> '' or profile_url <> ''),
  check (kind = 'business' or full_name <> '')
);
create index lead_contacts_lead on leadflow_private.lead_contacts(workspace_id, lead_id);
create unique index lead_contacts_email on leadflow_private.lead_contacts(workspace_id, lead_id, email) where email <> '';
create unique index lead_contacts_provider_ref on leadflow_private.lead_contacts(workspace_id, lead_id, provider, provider_ref) where provider_ref is not null;
create unique index lead_contacts_primary on leadflow_private.lead_contacts(workspace_id, lead_id) where is_primary;
create unique index lead_contacts_preferred on leadflow_private.lead_contacts(workspace_id, lead_id) where is_preferred;

create table leadflow_private.lead_contact_sources (
  id bigint generated always as identity primary key,
  contact_id uuid not null references leadflow_private.lead_contacts(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source text not null check (source in ('website','apollo','apollo_search','manual','lead_record')),
  how text not null check (how ~ '^[a-z_]{1,30}$'),
  field text not null check (field in ('name','title','email','phone','whatsapp','linkedin','profile')),
  value text not null check (length(value) between 1 and 300),
  source_url text check (length(source_url) <= 500),
  evidence_id uuid references leadflow_private.analysis_evidence(id) on delete set null,
  analysis_id uuid references leadflow_private.business_analyses(id) on delete set null,
  actor uuid,
  observed_at timestamptz not null default now(),
  unique (contact_id, source, field, value)
);
create index lead_contact_sources_contact on leadflow_private.lead_contact_sources(contact_id);

create table leadflow_private.lead_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null check (length(lead_id) between 1 and 200),
  channel text not null check (channel in ('contact_page','contact_form','booking_page','social','linkedin_company','address','whatsapp')),
  label text not null default '' check (length(label) <= 80),
  value text not null check (length(value) between 1 and 300),
  source text not null check (source in ('website','apollo','manual','lead_record')),
  source_url text check (length(source_url) <= 500),
  evidence_id uuid references leadflow_private.analysis_evidence(id) on delete set null,
  analysis_id uuid references leadflow_private.business_analyses(id) on delete set null,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (workspace_id, lead_id, channel, value)
);

create table leadflow_private.contact_suppressions (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null check (length(lead_id) between 1 and 200),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, lead_id, key_hash)
);

create table leadflow_private.contact_discovery_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null check (length(lead_id) between 1 and 200),
  request_id uuid not null,
  created_by uuid,
  mode text not null default 'full' check (mode in ('full','verify')),
  -- verify mode: { contactIds: [...] }.
  options jsonb not null default '{}' check (jsonb_typeof(options) = 'object' and octet_length(options::text) <= 4000),
  status text not null default 'pending' check (status in ('pending','running','completed','partial','failed','cancelled')),
  step text check (step ~ '^[a-z_]{1,30}$'),
  providers jsonb not null default '{}' check (jsonb_typeof(providers) = 'object' and octet_length(providers::text) <= 4000),
  progress jsonb not null default '{}' check (jsonb_typeof(progress) = 'object' and octet_length(progress::text) <= 2000),
  failure text check (length(failure) <= 500),
  attempts integer not null default 0,
  lease_id uuid,
  lease_until timestamptz,
  next_run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, request_id)
);
create unique index contact_discovery_jobs_active on leadflow_private.contact_discovery_jobs(workspace_id, lead_id) where step is not null;
create index contact_discovery_jobs_due on leadflow_private.contact_discovery_jobs(next_run_at) where step is not null;
create index contact_discovery_jobs_lead on leadflow_private.contact_discovery_jobs(workspace_id, lead_id, created_at desc);

-- One row per workspace (user_id null) and one per member who set their own sender details. Null means "inherit".
create table leadflow_private.outreach_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  agency_name text check (length(agency_name) <= 100),
  agency_description text check (length(agency_description) <= 600),
  agency_website text check (agency_website = '' or (length(agency_website) <= 300 and agency_website ~* '^https?://')),
  sender_name text check (length(sender_name) <= 100),
  sender_role text check (length(sender_role) <= 100),
  contact_details text check (length(contact_details) <= 300),
  tone text check (tone in ('professional','friendly','consultative','direct','conversational')),
  message_length text check (message_length in ('short','standard','detailed')),
  objective text check (objective in ('discovery_call','free_audit','case_study','proposal_permission','conversation')),
  preferred_cta text check (length(preferred_cta) <= 200),
  avoid_phrases text check (length(avoid_phrases) <= 500),
  custom_instructions text check (length(custom_instructions) <= 1500),
  case_study_links text[] check (cardinality(case_study_links) <= 5),
  followup_intervals integer[] check (cardinality(followup_intervals) <= 3 and 0 < all(followup_intervals) and 91 > all(followup_intervals)),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create unique index outreach_preferences_scope on leadflow_private.outreach_preferences(workspace_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table leadflow_private.outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null check (length(lead_id) between 1 and 200),
  contact_id uuid references leadflow_private.lead_contacts(id) on delete set null,
  -- Snapshots, kept if the contact or opportunity is later removed.
  contact_name text not null default '' check (length(contact_name) <= 150),
  analysis_id uuid references leadflow_private.business_analyses(id) on delete set null,
  opportunity_id uuid references leadflow_private.business_opportunities(id) on delete set null,
  opportunity_title text not null default '' check (length(opportunity_title) <= 200),
  service_id uuid references leadflow_private.agency_services(id) on delete set null,
  channel text not null check (channel in ('email','whatsapp','linkedin_connection','linkedin_message')),
  angle text not null check (angle in ('opportunity','value','consultative','audit_first','relationship')),
  sequence_step integer not null default 0 check (sequence_step between 0 and 3),
  parent_id uuid references leadflow_private.outreach_drafts(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','ready','sent','replied','follow_up','archived')),
  subject text not null default '' check (length(subject) <= 200),
  body text not null check (length(body) between 1 and 6000),
  claims jsonb not null default '[]' check (jsonb_typeof(claims) = 'array' and octet_length(claims::text) <= 20000),
  grounding text not null default 'general' check (grounding in ('evidence','general')),
  warnings jsonb not null default '[]' check (jsonb_typeof(warnings) = 'array' and octet_length(warnings::text) <= 4000),
  current_version integer not null default 1,
  current_origin text not null default 'generated' check (current_origin in ('generated','regenerated','edited','duplicated','restored')),
  notes text not null default '' check (length(notes) <= 2000),
  provider text check (provider ~ '^[a-z_]{1,30}$'),
  model text check (length(model) <= 100),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status_changed_at timestamptz,
  sent_at timestamptz,
  sent_by uuid,
  replied_at timestamptz
);
create index outreach_drafts_lead on leadflow_private.outreach_drafts(workspace_id, lead_id, created_at desc);

create table leadflow_private.outreach_draft_versions (
  id bigint generated always as identity primary key,
  draft_id uuid not null references leadflow_private.outreach_drafts(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  version integer not null check (version >= 1),
  -- Generation requests are idempotent by request ID; edits have none.
  request_id uuid,
  origin text not null check (origin in ('generated','regenerated','edited','duplicated','restored')),
  subject text not null default '' check (length(subject) <= 200),
  body text not null check (length(body) between 1 and 6000),
  claims jsonb not null default '[]' check (jsonb_typeof(claims) = 'array' and octet_length(claims::text) <= 20000),
  grounding text not null default 'general' check (grounding in ('evidence','general')),
  angle text not null check (angle in ('opportunity','value','consultative','audit_first','relationship')),
  provider text check (provider ~ '^[a-z_]{1,30}$'),
  model text check (length(model) <= 100),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  -- The settings used to generate: { tone, length, objective, channel, sequenceStep, instructions }.
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 4000),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (draft_id, version)
);
create unique index outreach_draft_versions_request on leadflow_private.outreach_draft_versions(workspace_id, request_id) where request_id is not null;

create table leadflow_private.outreach_usage (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  job_id uuid references leadflow_private.contact_discovery_jobs(id) on delete set null,
  draft_id uuid references leadflow_private.outreach_drafts(id) on delete set null,
  provider text not null check (provider ~ '^[a-z_]{1,30}$'),
  operation text not null check (operation ~ '^[a-z_]{1,40}$'),
  quantity numeric(14,2) not null check (quantity >= 0),
  unit text not null check (unit ~ '^[a-z_]{1,30}$'),
  -- Only what a provider reported; never estimated.
  credits numeric(12,2) check (credits >= 0),
  remaining numeric(14,2),
  status text not null check (status in ('ok','partial','failed')),
  detail text check (length(detail) <= 300),
  actor uuid,
  at timestamptz not null default now()
);
create index outreach_usage_month on leadflow_private.outreach_usage(workspace_id, at);

alter table leadflow_private.lead_contacts enable row level security;
alter table leadflow_private.lead_contact_sources enable row level security;
alter table leadflow_private.lead_channels enable row level security;
alter table leadflow_private.contact_suppressions enable row level security;
alter table leadflow_private.contact_discovery_jobs enable row level security;
alter table leadflow_private.outreach_preferences enable row level security;
alter table leadflow_private.outreach_drafts enable row level security;
alter table leadflow_private.outreach_draft_versions enable row level security;
alter table leadflow_private.outreach_usage enable row level security;
revoke all on leadflow_private.lead_contacts, leadflow_private.lead_contact_sources, leadflow_private.lead_channels, leadflow_private.contact_suppressions,
  leadflow_private.contact_discovery_jobs, leadflow_private.outreach_preferences, leadflow_private.outreach_drafts, leadflow_private.outreach_draft_versions,
  leadflow_private.outreach_usage from public, anon, authenticated;

-- ---------- JSON shapes ----------

create function leadflow_private.contact_json(c leadflow_private.lead_contacts) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'leadId', c.lead_id, 'kind', c.kind, 'label', c.label, 'fullName', c.full_name, 'jobTitle', c.job_title, 'role', c.role,
    'email', c.email, 'emailStatus', c.email_status, 'emailCheck', c.email_check, 'emailCheckedAt', c.email_checked_at, 'phone', c.phone, 'phoneE164', c.phone_e164,
    'phoneStatus', c.phone_status, 'whatsapp', c.whatsapp, 'linkedinUrl', c.linkedin_url, 'profileUrl', c.profile_url, 'provider', c.provider, 'providerRef', c.provider_ref,
    'notes', c.notes, 'isPrimary', c.is_primary, 'isPreferred', c.is_preferred, 'confirmed', c.confirmed, 'confirmedAt', c.confirmed_at, 'editedFields', to_jsonb(c.edited_fields),
    'suggestions', c.suggestions, 'origin', c.origin, 'createdBy', c.created_by, 'createdAt', c.created_at, 'updatedAt', c.updated_at, 'lastSeenAt', c.last_seen_at,
    'sources', coalesce((select jsonb_agg(jsonb_build_object('source', s.source, 'how', s.how, 'field', s.field, 'value', s.value, 'sourceUrl', s.source_url,
      'evidenceId', s.evidence_id, 'analysisId', s.analysis_id, 'observedAt', s.observed_at) order by s.observed_at, s.id) from leadflow_private.lead_contact_sources s where s.contact_id = c.id), '[]'::jsonb))
$$;
create function leadflow_private.contact_job_json(j leadflow_private.contact_discovery_jobs) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', j.id, 'leadId', j.lead_id, 'mode', j.mode, 'status', j.status, 'step', j.step, 'providers', j.providers, 'progress', j.progress,
    'failure', j.failure, 'createdBy', j.created_by, 'createdAt', j.created_at, 'completedAt', j.completed_at)
$$;
create function leadflow_private.draft_json(d leadflow_private.outreach_drafts) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'leadId', d.lead_id, 'contactId', d.contact_id, 'contactName', d.contact_name, 'analysisId', d.analysis_id, 'opportunityId', d.opportunity_id,
    'opportunityTitle', d.opportunity_title, 'serviceId', d.service_id, 'channel', d.channel, 'angle', d.angle, 'sequenceStep', d.sequence_step, 'parentId', d.parent_id,
    'status', d.status, 'subject', d.subject, 'body', d.body, 'claims', d.claims, 'grounding', d.grounding, 'warnings', d.warnings, 'version', d.current_version,
    'origin', d.current_origin, 'notes', d.notes, 'provider', d.provider, 'model', d.model, 'createdBy', d.created_by, 'createdAt', d.created_at, 'updatedAt', d.updated_at,
    'statusChangedAt', d.status_changed_at, 'sentAt', d.sent_at, 'repliedAt', d.replied_at)
$$;
-- Effective outreach settings for a member: their own sender details over the workspace's, over the defaults.
create function leadflow_private.outreach_preferences_json(target_workspace uuid, member uuid) returns jsonb language sql stable set search_path = '' as $$
  with w as (select * from leadflow_private.outreach_preferences p where p.workspace_id = target_workspace and p.user_id is null),
       u as (select * from leadflow_private.outreach_preferences p where p.workspace_id = target_workspace and p.user_id = member)
  select jsonb_build_object(
    'agencyName', coalesce(nullif((select agency_name from w), ''), (select ws.name from public.workspaces ws where ws.id = target_workspace), ''),
    'agencyDescription', coalesce((select agency_description from w), ''), 'agencyWebsite', coalesce((select agency_website from w), ''),
    'senderName', coalesce(nullif((select sender_name from u), ''), (select sender_name from w), ''), 'senderRole', coalesce(nullif((select sender_role from u), ''), (select sender_role from w), ''),
    'contactDetails', coalesce(nullif((select contact_details from u), ''), (select contact_details from w), ''),
    'tone', coalesce((select tone from u), (select tone from w), 'professional'), 'length', coalesce((select message_length from u), (select message_length from w), 'short'),
    'objective', coalesce((select objective from w), 'discovery_call'), 'preferredCta', coalesce((select preferred_cta from w), ''), 'avoidPhrases', coalesce((select avoid_phrases from w), ''),
    'customInstructions', coalesce((select custom_instructions from w), ''), 'caseStudyLinks', to_jsonb(coalesce((select case_study_links from w), '{}')),
    'followupIntervals', to_jsonb(coalesce((select followup_intervals from w), '{3,7,14}')))
$$;
create function leadflow_private.preference_row_json(p leadflow_private.outreach_preferences) returns jsonb language sql stable set search_path = '' as $$
  select case when p.id is null then null else jsonb_build_object('agencyName', p.agency_name, 'agencyDescription', p.agency_description, 'agencyWebsite', p.agency_website,
    'senderName', p.sender_name, 'senderRole', p.sender_role, 'contactDetails', p.contact_details, 'tone', p.tone, 'length', p.message_length, 'objective', p.objective,
    'preferredCta', p.preferred_cta, 'avoidPhrases', p.avoid_phrases, 'customInstructions', p.custom_instructions, 'caseStudyLinks', to_jsonb(p.case_study_links),
    'followupIntervals', to_jsonb(p.followup_intervals), 'updatedAt', p.updated_at) end
$$;

-- ---------- Merging discovered contacts ----------

-- What to do with one discovered value: keep the current one, set it (the field is empty, or a partly hidden name), or
-- suggest it to the team (it differs from a value that exists or is protected by a confirmation or an edit).
create function leadflow_private.merge_decision(current_value text, candidate text, field text, is_protected boolean, dismissed text[]) returns text
language sql immutable set search_path = '' as $$
  select case
    when coalesce(candidate, '') = '' or lower(candidate) = lower(coalesce(current_value, '')) then 'keep'
    when not is_protected and (coalesce(current_value, '') = '' or (field = 'name' and current_value ~ '\*')) then 'set'
    when (field || ':' || lower(candidate)) = any(dismissed) then 'keep'
    else 'suggest' end
$$;
-- Merges one discovered or provider contact into the lead's contacts. Returns added, updated, suggested, unchanged or suppressed.
-- Matching, in order: provider ID, email, LinkedIn/profile URL, a person's name, a business line's phone number.
create function leadflow_private.merge_contact(target_workspace uuid, target_lead text, candidate jsonb, actor uuid) returns text
language plpgsql set search_path = '' as $$
declare
  c leadflow_private.lead_contacts; kind_value text := candidate->>'kind'; source_value text := candidate->>'source';
  email_value text := lower(btrim(coalesce(candidate->>'email', ''))); e164 text := coalesce(candidate->>'phoneE164', '');
  name_value text := left(btrim(coalesce(candidate->>'fullName', '')), 150); ref text := nullif(left(btrim(coalesce(candidate->>'providerRef', '')), 100), '');
  provider_value text := case when ref is not null then case when source_value in ('apollo','apollo_search') then 'apollo' else source_value end end;
  profile text := coalesce(nullif(candidate->>'linkedinUrl', ''), nullif(candidate->>'profileUrl', ''), '');
  evidence uuid; analysis uuid; changed boolean := false; suggested boolean := false; outcome text; suggestion_list jsonb; decision text;
  locked_all boolean; field_name text; current_value text; new_value text; status_value text;
begin
  if kind_value not in ('person','business') or source_value not in ('website','apollo','apollo_search','manual','lead_record') then raise exception 'Invalid contact.' using errcode = '22023'; end if;
  if email_value <> '' and email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then email_value := ''; end if;
  if e164 !~ '^\+[1-9][0-9]{6,14}$' then e164 := ''; end if;
  if exists (select 1 from leadflow_private.contact_suppressions s where s.workspace_id = target_workspace and s.lead_id = target_lead
      and s.key_hash = any(leadflow_private.contact_key_hashes(kind_value, email_value, e164, provider_value, ref, name_value))) then return 'suppressed'; end if;
  if ref is not null then select * into c from leadflow_private.lead_contacts x where x.workspace_id = target_workspace and x.lead_id = target_lead and x.provider = provider_value and x.provider_ref = ref; end if;
  if c.id is null and email_value <> '' then select * into c from leadflow_private.lead_contacts x where x.workspace_id = target_workspace and x.lead_id = target_lead and x.email = email_value; end if;
  if c.id is null and profile <> '' then select * into c from leadflow_private.lead_contacts x where x.workspace_id = target_workspace and x.lead_id = target_lead
    and (lower(x.linkedin_url) = lower(profile) or lower(x.profile_url) = lower(profile)) limit 1; end if;
  if c.id is null and kind_value = 'person' and name_value <> '' then select * into c from leadflow_private.lead_contacts x where x.workspace_id = target_workspace and x.lead_id = target_lead
    and x.kind = 'person' and leadflow_private.name_key(x.full_name) = leadflow_private.name_key(name_value) and leadflow_private.name_key(name_value) <> '' order by x.created_at limit 1; end if;
  if c.id is null and kind_value = 'business' and e164 <> '' then select * into c from leadflow_private.lead_contacts x where x.workspace_id = target_workspace and x.lead_id = target_lead
    and x.kind = 'business' and x.phone_e164 = e164 and (x.email = '' or email_value = '') order by x.created_at limit 1; end if;
  select e.id into evidence from leadflow_private.analysis_evidence e where e.id = nullif(candidate->>'evidenceId', '')::uuid and e.workspace_id = target_workspace;
  select a.id into analysis from leadflow_private.business_analyses a where a.id = nullif(candidate->>'analysisId', '')::uuid and a.workspace_id = target_workspace;
  status_value := case when candidate->>'emailStatus' in ('verified','likely_valid','unverified','invalid','risky') then candidate->>'emailStatus' else 'unknown' end;

  if c.id is null then
    insert into leadflow_private.lead_contacts(workspace_id, lead_id, kind, label, full_name, job_title, role, email, email_status, phone, phone_e164, phone_status, whatsapp,
        linkedin_url, profile_url, provider, provider_ref, origin, created_by)
      values (target_workspace, target_lead, kind_value, left(coalesce(candidate->>'label', ''), 80), name_value, left(btrim(coalesce(candidate->>'jobTitle', '')), 150),
        case when leadflow_private.is_contact_role(candidate->>'role') then candidate->>'role' else 'other' end, email_value, case when email_value = '' then 'unknown' else status_value end,
        left(btrim(coalesce(candidate->>'phone', '')), 40), e164,
        case when candidate->>'phoneStatus' in ('valid_format','invalid_format','unverified','provider_verified') then candidate->>'phoneStatus' else 'unverified' end,
        case when coalesce(candidate->>'whatsapp', '') ~ '^\+[1-9][0-9]{6,14}$' then candidate->>'whatsapp' else '' end,
        case when coalesce(candidate->>'linkedinUrl', '') ~* '^https?://' then left(candidate->>'linkedinUrl', 300) else '' end,
        case when coalesce(candidate->>'profileUrl', '') ~* '^https?://' then left(candidate->>'profileUrl', 300) else '' end,
        provider_value, ref, case when source_value in ('apollo','apollo_search') then 'apollo' else 'discovered' end, actor)
      returning * into c;
    outcome := 'added';
  else
    suggestion_list := c.suggestions; locked_all := c.confirmed;
    foreach field_name in array array['name','title','email','phone','whatsapp','linkedin','profile'] loop
      current_value := case field_name when 'name' then c.full_name when 'title' then c.job_title when 'email' then c.email when 'phone' then coalesce(nullif(c.phone_e164, ''), c.phone)
        when 'whatsapp' then c.whatsapp when 'linkedin' then c.linkedin_url else c.profile_url end;
      new_value := case field_name when 'name' then name_value when 'title' then left(btrim(coalesce(candidate->>'jobTitle', '')), 150) when 'email' then email_value
        when 'phone' then coalesce(nullif(e164, ''), left(btrim(coalesce(candidate->>'phone', '')), 40)) when 'whatsapp' then case when coalesce(candidate->>'whatsapp', '') ~ '^\+[1-9][0-9]{6,14}$' then candidate->>'whatsapp' else '' end
        when 'linkedin' then case when coalesce(candidate->>'linkedinUrl', '') ~* '^https?://' then left(candidate->>'linkedinUrl', 300) else '' end
        else case when coalesce(candidate->>'profileUrl', '') ~* '^https?://' then left(candidate->>'profileUrl', 300) else '' end end;
      decision := leadflow_private.merge_decision(current_value, new_value, field_name, locked_all or field_name = any(c.edited_fields), c.dismissed_suggestions);
      -- An email that another contact of this lead already uses can't move here.
      if decision = 'set' and field_name = 'email' and exists (select 1 from leadflow_private.lead_contacts x where x.workspace_id = target_workspace and x.lead_id = target_lead and x.email = new_value and x.id <> c.id) then decision := 'keep'; end if;
      if decision = 'set' then
        changed := true;
        if field_name = 'name' then c.full_name := new_value; elsif field_name = 'title' then c.job_title := new_value;
        elsif field_name = 'email' then c.email := new_value; c.email_status := status_value; c.email_check := null; c.email_checked_at := null;
        elsif field_name = 'phone' then c.phone := left(btrim(coalesce(candidate->>'phone', new_value)), 40); c.phone_e164 := e164;
          c.phone_status := case when candidate->>'phoneStatus' in ('valid_format','invalid_format','unverified','provider_verified') then candidate->>'phoneStatus' else 'unverified' end;
        elsif field_name = 'whatsapp' then c.whatsapp := new_value; elsif field_name = 'linkedin' then c.linkedin_url := new_value; else c.profile_url := new_value; end if;
      elsif decision = 'suggest' and not suggestion_list @> jsonb_build_array(jsonb_build_object('field', field_name, 'value', new_value)) and jsonb_array_length(suggestion_list) < 20 then
        suggested := true;
        suggestion_list := suggestion_list || jsonb_build_array(jsonb_build_object('field', field_name, 'value', new_value, 'source', source_value, 'sourceUrl', left(candidate->>'sourceUrl', 500), 'observedAt', now()));
      end if;
    end loop;
    -- A provider's verdict on the same email updates its status; LeadFlow's own checks do that in the verify step.
    if source_value = 'apollo' and email_value <> '' and email_value = c.email and status_value <> 'unknown' and c.email_status is distinct from status_value then c.email_status := status_value; changed := true; end if;
    -- A generic role or label is replaced by a specific one unless the team set it.
    if not locked_all and not 'role' = any(c.edited_fields) and c.role in ('other','general') and leadflow_private.is_contact_role(candidate->>'role') and candidate->>'role' not in ('other','general') then c.role := candidate->>'role'; changed := true; end if;
    if not locked_all and not 'label' = any(c.edited_fields) and c.label in ('', 'Email', 'Phone', 'Main phone') and coalesce(candidate->>'label', '') not in ('', 'Email', 'Phone', 'Main phone') then c.label := left(candidate->>'label', 80); changed := true; end if;
    if c.provider is null and provider_value is not null and not exists (select 1 from leadflow_private.lead_contacts x where x.workspace_id = target_workspace and x.lead_id = target_lead and x.provider = provider_value and x.provider_ref = ref) then c.provider := provider_value; c.provider_ref := ref; end if;
    update leadflow_private.lead_contacts x set full_name = c.full_name, job_title = c.job_title, role = c.role, label = c.label, email = c.email, email_status = c.email_status, email_check = c.email_check,
      email_checked_at = c.email_checked_at, phone = c.phone, phone_e164 = c.phone_e164, phone_status = c.phone_status, whatsapp = c.whatsapp, linkedin_url = c.linkedin_url, profile_url = c.profile_url,
      provider = c.provider, provider_ref = c.provider_ref, suggestions = suggestion_list, last_seen_at = now(), updated_at = case when changed or suggested then now() else x.updated_at end
      where x.id = c.id;
    outcome := case when changed then 'updated' when suggested then 'suggested' else 'unchanged' end;
  end if;
  insert into leadflow_private.lead_contact_sources(contact_id, workspace_id, source, how, field, value, source_url, evidence_id, analysis_id, actor)
    select c.id, target_workspace, source_value, coalesce(nullif(candidate->>'how', ''), 'provider'), f.field, f.value, left(nullif(candidate->>'sourceUrl', ''), 500), evidence, analysis, actor
    from (values ('name', name_value), ('title', left(btrim(coalesce(candidate->>'jobTitle', '')), 150)), ('email', email_value),
      ('phone', coalesce(nullif(e164, ''), left(btrim(coalesce(candidate->>'phone', '')), 40))), ('whatsapp', coalesce(candidate->>'whatsapp', '')),
      ('linkedin', coalesce(candidate->>'linkedinUrl', '')), ('profile', coalesce(candidate->>'profileUrl', ''))) as f(field, value)
    where f.value <> '' and length(f.value) <= 300
    on conflict (contact_id, source, field, value) do update set observed_at = now(), source_url = coalesce(excluded.source_url, leadflow_private.lead_contact_sources.source_url),
      evidence_id = coalesce(excluded.evidence_id, leadflow_private.lead_contact_sources.evidence_id), analysis_id = coalesce(excluded.analysis_id, leadflow_private.lead_contact_sources.analysis_id);
  return outcome;
end $$;

-- ---------- Contacts (members) ----------

create function public.lead_contacts_for(target_workspace uuid, target_lead text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return jsonb_build_object(
    'contacts', coalesce((select jsonb_agg(leadflow_private.contact_json(c) order by c.is_primary desc, c.is_preferred desc, c.confirmed desc, case c.kind when 'person' then 0 else 1 end, c.created_at)
      from leadflow_private.lead_contacts c where c.workspace_id = target_workspace and c.lead_id = target_lead), '[]'::jsonb),
    'channels', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'channel', h.channel, 'label', h.label, 'value', h.value, 'source', h.source, 'sourceUrl', h.source_url,
      'evidenceId', h.evidence_id, 'analysisId', h.analysis_id, 'observedAt', h.observed_at) order by h.channel, h.value)
      from leadflow_private.lead_channels h where h.workspace_id = target_workspace and h.lead_id = target_lead), '[]'::jsonb),
    'job', (select leadflow_private.contact_job_json(j) from leadflow_private.contact_discovery_jobs j where j.workspace_id = target_workspace and j.lead_id = target_lead order by j.created_at desc limit 1));
end $$;

-- Adds or edits a contact by hand. On edit, changed fields are protected from discovery and the new values are recorded as
-- the team's; the discovered originals stay in the sources. A changed email needs checking again.
-- contact: { id?, kind, label, fullName, jobTitle, role, email, phone, phoneE164, phoneStatus, whatsapp, linkedinUrl, profileUrl, notes }.
create function public.save_lead_contact(target_workspace uuid, target_lead text, contact jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid; current_row leadflow_private.lead_contacts; result leadflow_private.lead_contacts; edited text[] := '{}';
  v_kind text; v_label text; v_name text; v_title text; v_role text; v_email text; v_phone text; v_e164 text; v_phone_status text; v_whatsapp text; v_linkedin text; v_profile text; v_notes text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  actor := leadflow_private.valid_actor();
  if jsonb_typeof(contact) is distinct from 'object' then raise exception 'Invalid contact.' using errcode = '22023'; end if;
  if contact ? 'id' then
    select * into current_row from leadflow_private.lead_contacts c where c.id = (contact->>'id')::uuid and c.workspace_id = target_workspace and c.lead_id = target_lead for update;
    if current_row.id is null then raise exception 'Contact not found.' using errcode = 'P0002'; end if;
  elsif not exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = target_lead) then raise exception 'Lead not found.' using errcode = 'P0002';
  end if;
  v_kind := coalesce(contact->>'kind', current_row.kind);
  v_label := btrim(coalesce(contact->>'label', current_row.label, '')); v_name := btrim(coalesce(contact->>'fullName', current_row.full_name, ''));
  v_title := btrim(coalesce(contact->>'jobTitle', current_row.job_title, '')); v_role := coalesce(contact->>'role', current_row.role, 'other');
  v_email := lower(btrim(coalesce(contact->>'email', current_row.email, ''))); v_phone := btrim(coalesce(contact->>'phone', current_row.phone, ''));
  v_e164 := coalesce(contact->>'phoneE164', current_row.phone_e164, ''); v_phone_status := coalesce(contact->>'phoneStatus', current_row.phone_status, 'unverified');
  v_whatsapp := coalesce(contact->>'whatsapp', current_row.whatsapp, ''); v_linkedin := btrim(coalesce(contact->>'linkedinUrl', current_row.linkedin_url, ''));
  v_profile := btrim(coalesce(contact->>'profileUrl', current_row.profile_url, '')); v_notes := coalesce(contact->>'notes', current_row.notes, '');
  if v_kind not in ('person','business') then raise exception 'Choose a person or a business contact.' using errcode = '22023'; end if;
  if v_kind = 'person' and v_name = '' then raise exception 'Enter the person’s name.' using errcode = '22023'; end if;
  if v_email <> '' and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
  if v_phone = '' then v_e164 := ''; v_phone_status := 'unverified'; end if;
  -- People and the browser can establish a phone's format, never that a provider verified it.
  if v_phone_status not in ('valid_format','invalid_format','unverified') or (v_e164 <> '' and v_e164 !~ '^\+[1-9][0-9]{6,14}$') then raise exception 'Enter a valid phone number.' using errcode = '22023'; end if;
  if v_whatsapp <> '' and v_whatsapp !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'Enter the WhatsApp number in international format, such as +15125550100.' using errcode = '22023'; end if;
  if (v_linkedin <> '' and v_linkedin !~* '^https?://') or (v_profile <> '' and v_profile !~* '^https?://') then raise exception 'Profile links must start with https://.' using errcode = '22023'; end if;
  if not leadflow_private.is_contact_role(v_role) then raise exception 'Choose a role from the list.' using errcode = '22023'; end if;
  if v_kind = 'business' and v_email = '' and v_phone = '' and v_whatsapp = '' and v_linkedin = '' and v_profile = '' then raise exception 'Add an email, a phone number or a profile link.' using errcode = '22023'; end if;
  begin
    if current_row.id is null then
      insert into leadflow_private.lead_contacts(workspace_id, lead_id, kind, label, full_name, job_title, role, email, phone, phone_e164, phone_status, whatsapp, linkedin_url, profile_url, notes, origin, created_by)
        values (target_workspace, target_lead, v_kind, v_label, v_name, v_title, v_role, v_email, v_phone, v_e164, v_phone_status, v_whatsapp, v_linkedin, v_profile, v_notes, 'manual', actor)
        returning * into result;
      -- Adding a contact by hand overrides an earlier deletion of the same details.
      delete from leadflow_private.contact_suppressions s where s.workspace_id = target_workspace and s.lead_id = target_lead
        and s.key_hash = any(leadflow_private.contact_key_hashes(v_kind, v_email, v_e164, null, null, v_name));
    else
      if v_name <> current_row.full_name then edited := array_append(edited, 'name'); end if;
      if v_title <> current_row.job_title then edited := array_append(edited, 'title'); end if;
      if v_email <> current_row.email then edited := array_append(edited, 'email'); end if;
      if v_phone <> current_row.phone or v_e164 <> current_row.phone_e164 then edited := array_append(edited, 'phone'); end if;
      if v_whatsapp <> current_row.whatsapp then edited := array_append(edited, 'whatsapp'); end if;
      if v_linkedin <> current_row.linkedin_url then edited := array_append(edited, 'linkedin'); end if;
      if v_profile <> current_row.profile_url then edited := array_append(edited, 'profile'); end if;
      if v_role <> current_row.role then edited := array_append(edited, 'role'); end if;
      if v_label <> current_row.label then edited := array_append(edited, 'label'); end if;
      update leadflow_private.lead_contacts c set kind = v_kind, label = v_label, full_name = v_name, job_title = v_title, role = v_role, email = v_email,
        email_status = case when v_email <> current_row.email then 'unknown' else c.email_status end, email_check = case when v_email <> current_row.email then null else c.email_check end,
        email_checked_at = case when v_email <> current_row.email then null else c.email_checked_at end, phone = v_phone, phone_e164 = v_e164, phone_status = v_phone_status,
        whatsapp = v_whatsapp, linkedin_url = v_linkedin, profile_url = v_profile, notes = v_notes,
        edited_fields = array(select distinct unnest(c.edited_fields || edited)),
        suggestions = coalesce((select jsonb_agg(s) from jsonb_array_elements(c.suggestions) s where not (s->>'field') = any(edited)), '[]'::jsonb), updated_at = now()
        where c.id = current_row.id returning * into result;
    end if;
  exception
    when unique_violation then raise exception 'Another contact for this lead already uses this email address.' using errcode = '22023';
    when check_violation then raise exception 'Check the contact: names and titles up to 150 characters, notes up to 2,000.' using errcode = '22023';
  end;
  insert into leadflow_private.lead_contact_sources(contact_id, workspace_id, source, how, field, value, actor)
    select result.id, target_workspace, 'manual', 'manual', f.field, f.value, actor
    from (values ('name', v_name), ('title', v_title), ('email', v_email), ('phone', coalesce(nullif(v_e164, ''), v_phone)), ('whatsapp', v_whatsapp), ('linkedin', v_linkedin), ('profile', v_profile)) f(field, value)
    where f.value <> '' and length(f.value) <= 300 and (current_row.id is null or f.field = any(edited))
    on conflict (contact_id, source, field, value) do update set observed_at = now(), actor = excluded.actor;
  return leadflow_private.contact_json(result);
end $$;

-- Primary (the main contact for the business), preferred (the one to reach out to) and confirmed (the team checked it).
create function public.set_lead_contact_flags(target_workspace uuid, contact_id uuid, flags jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c leadflow_private.lead_contacts;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into c from leadflow_private.lead_contacts x where x.id = contact_id and x.workspace_id = target_workspace for update;
  if c.id is null then raise exception 'Contact not found.' using errcode = 'P0002'; end if;
  if (flags->>'primary')::boolean then update leadflow_private.lead_contacts x set is_primary = false where x.workspace_id = target_workspace and x.lead_id = c.lead_id and x.is_primary and x.id <> c.id; end if;
  if (flags->>'preferred')::boolean then update leadflow_private.lead_contacts x set is_preferred = false where x.workspace_id = target_workspace and x.lead_id = c.lead_id and x.is_preferred and x.id <> c.id; end if;
  update leadflow_private.lead_contacts x set is_primary = coalesce((flags->>'primary')::boolean, x.is_primary), is_preferred = coalesce((flags->>'preferred')::boolean, x.is_preferred),
    confirmed = coalesce((flags->>'confirmed')::boolean, x.confirmed),
    confirmed_by = case when (flags->>'confirmed')::boolean then leadflow_private.valid_actor() when (flags->>'confirmed')::boolean is false then null else x.confirmed_by end,
    confirmed_at = case when (flags->>'confirmed')::boolean then now() when (flags->>'confirmed')::boolean is false then null else x.confirmed_at end, updated_at = now()
    where x.id = c.id returning * into c;
  return leadflow_private.contact_json(c);
end $$;

-- Accepts or dismisses a value discovery suggested. An accepted value counts as the team's; a dismissed one isn't suggested again.
create function public.resolve_contact_suggestion(target_workspace uuid, contact_id uuid, suggestion_field text, suggestion_value text, accept boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c leadflow_private.lead_contacts; suggestion jsonb; changes jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into c from leadflow_private.lead_contacts x where x.id = contact_id and x.workspace_id = target_workspace;
  if c.id is null then raise exception 'Contact not found.' using errcode = 'P0002'; end if;
  select s into suggestion from jsonb_array_elements(c.suggestions) s where s->>'field' = suggestion_field and s->>'value' = suggestion_value limit 1;
  if suggestion is null then raise exception 'This suggestion is no longer available.' using errcode = 'P0002'; end if;
  update leadflow_private.lead_contacts x set suggestions = coalesce((select jsonb_agg(s) from jsonb_array_elements(x.suggestions) s where not (s->>'field' = suggestion_field and s->>'value' = suggestion_value)), '[]'::jsonb),
    dismissed_suggestions = case when accept then x.dismissed_suggestions else array(select distinct unnest(x.dismissed_suggestions || (suggestion_field || ':' || lower(suggestion_value)))) end
    where x.id = c.id;
  if accept then
    changes := jsonb_build_object('id', c.id, case suggestion_field when 'name' then 'fullName' when 'title' then 'jobTitle' when 'linkedin' then 'linkedinUrl' when 'profile' then 'profileUrl' else suggestion_field end, suggestion_value);
    -- A suggested phone is stored in international format; its format is known to be valid.
    if suggestion_field = 'phone' then changes := changes || jsonb_build_object('phoneE164', case when suggestion_value ~ '^\+[1-9][0-9]{6,14}$' then suggestion_value else '' end,
      'phoneStatus', case when suggestion_value ~ '^\+[1-9][0-9]{6,14}$' then 'valid_format' else 'unverified' end); end if;
    return public.save_lead_contact(target_workspace, c.lead_id, changes);
  end if;
  select * into c from leadflow_private.lead_contacts x where x.id = contact_id;
  return leadflow_private.contact_json(c);
end $$;

-- Deletes a contact and remembers it (as hashes) so discovery doesn't add it again. Owners and admins delete any contact;
-- members delete contacts they added themselves.
create function public.delete_lead_contact(target_workspace uuid, contact_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare actor_role text; c leadflow_private.lead_contacts;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into c from leadflow_private.lead_contacts x where x.id = contact_id and x.workspace_id = target_workspace for update;
  if c.id is null then raise exception 'Contact not found.' using errcode = 'P0002'; end if;
  if actor_role = 'member' and (c.origin <> 'manual' or c.created_by is distinct from leadflow_private.valid_actor()) then
    raise exception 'Only owners and admins can delete contacts that someone else added or discovery found.' using errcode = '42501';
  end if;
  insert into leadflow_private.contact_suppressions(workspace_id, lead_id, key_hash, created_by)
    select target_workspace, c.lead_id, h, leadflow_private.valid_actor() from unnest(leadflow_private.contact_key_hashes(c.kind, c.email, c.phone_e164, c.provider, c.provider_ref, c.full_name)) h
    on conflict do nothing;
  delete from leadflow_private.lead_contacts x where x.id = c.id;
end $$;

-- Erases a lead's contact data: contacts, their sources, channels and discovery jobs (owners and admins). Drafts keep their
-- text but lose the link to the contact. Deleted contacts are remembered as hashes so they aren't collected again.
create function public.delete_lead_contact_data(target_workspace uuid, target_lead text) returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  insert into leadflow_private.contact_suppressions(workspace_id, lead_id, key_hash, created_by)
    select target_workspace, target_lead, h, leadflow_private.valid_actor() from leadflow_private.lead_contacts c,
      unnest(leadflow_private.contact_key_hashes(c.kind, c.email, c.phone_e164, c.provider, c.provider_ref, c.full_name)) h
    where c.workspace_id = target_workspace and c.lead_id = target_lead on conflict do nothing;
  delete from leadflow_private.lead_contacts c where c.workspace_id = target_workspace and c.lead_id = target_lead;
  get diagnostics removed = row_count;
  delete from leadflow_private.lead_channels h where h.workspace_id = target_workspace and h.lead_id = target_lead;
  delete from leadflow_private.contact_discovery_jobs j where j.workspace_id = target_workspace and j.lead_id = target_lead;
  return removed;
end $$;

-- Adds Apollo people the workspace already has: revealed people from apollo_contacts, others from saved Apollo search
-- pages (name partly hidden). Nothing the browser sends is stored as contact data, only the Apollo person IDs it chose.
create function public.add_apollo_people_as_contacts(target_workspace uuid, target_lead text, person_ids jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pid text; revealed leadflow_private.apollo_contacts; saved_person jsonb; outcome text; added integer := 0; updated integer := 0; missing jsonb := '[]';
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if jsonb_typeof(person_ids) is distinct from 'array' or jsonb_array_length(person_ids) not between 1 and 25 then raise exception 'Choose between 1 and 25 people.' using errcode = '22023'; end if;
  if not exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = target_lead) then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
  for pid in select distinct value from jsonb_array_elements_text(person_ids) loop
    if pid !~ '^[A-Za-z0-9]{1,40}$' then continue; end if;
    select * into revealed from leadflow_private.apollo_contacts c where c.workspace_id = target_workspace and c.person_id = pid and c.email_revealed_at is not null;
    if revealed.person_id is not null then
      outcome := leadflow_private.merge_contact(target_workspace, target_lead, jsonb_build_object('kind', 'person', 'fullName', revealed.name, 'jobTitle', revealed.title,
        'role', leadflow_private.role_for_title(revealed.title), 'email', revealed.email,
        'emailStatus', case lower(revealed.email_status) when 'verified' then 'verified' when 'likely to engage' then 'likely_valid' when 'unverified' then 'unverified' when 'guessed' then 'unverified'
          when 'extrapolated' then 'unverified' when 'invalid' then 'invalid' when 'bounced' then 'invalid' when 'accept_all' then 'risky' when 'catch_all' then 'risky' else 'unknown' end,
        'phone', coalesce(revealed.phones->0->>'number', ''), 'phoneE164', case when coalesce(revealed.phones->0->>'number', '') ~ '^\+[1-9][0-9]{6,14}$' then revealed.phones->0->>'number' else '' end,
        'phoneStatus', case when coalesce(revealed.phones->0->>'status', '') ~* 'valid' and coalesce(revealed.phones->0->>'number', '') ~ '^\+[1-9][0-9]{6,14}$' then 'provider_verified' else 'unverified' end,
        'linkedinUrl', revealed.linkedin_url, 'source', 'apollo', 'how', 'provider', 'providerRef', pid), leadflow_private.valid_actor());
    else
      select i into saved_person from leadflow_private.apollo_saved_results r, jsonb_array_elements(r.result->'items') i
        where r.workspace_id = target_workspace and r.kind = 'people' and i->>'id' = pid order by r.fetched_at desc limit 1;
      if saved_person is null then missing := missing || to_jsonb(pid); continue; end if;
      outcome := leadflow_private.merge_contact(target_workspace, target_lead, jsonb_build_object('kind', 'person', 'fullName', left(coalesce(nullif(saved_person->>'name', ''), 'Apollo person'), 150),
        'jobTitle', left(coalesce(saved_person->>'title', ''), 150), 'role', leadflow_private.role_for_title(coalesce(saved_person->>'title', '')), 'source', 'apollo_search', 'how', 'provider_search', 'providerRef', pid), leadflow_private.valid_actor());
    end if;
    if outcome = 'added' then added := added + 1; elsif outcome in ('updated','suggested') then updated := updated + 1; end if;
  end loop;
  return jsonb_build_object('added', added, 'updated', updated, 'notFound', missing);
end $$;

create function public.cancel_contact_discovery(target_workspace uuid, job_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare actor_role text;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  update leadflow_private.contact_discovery_jobs j set status = 'cancelled', step = null, completed_at = now(), updated_at = now(), lease_id = null, lease_until = null
    where j.id = job_id and j.workspace_id = target_workspace and j.step is not null and (actor_role <> 'member' or j.created_by = leadflow_private.valid_actor());
  if not found then raise exception 'This contact search has finished or isn''t yours to stop.' using errcode = 'P0002'; end if;
end $$;

-- ---------- Preferences (members) ----------

create function public.outreach_preferences_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text; actor uuid; w leadflow_private.outreach_preferences; u leadflow_private.outreach_preferences;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  actor := leadflow_private.valid_actor();
  select * into w from leadflow_private.outreach_preferences p where p.workspace_id = target_workspace and p.user_id is null;
  select * into u from leadflow_private.outreach_preferences p where p.workspace_id = target_workspace and p.user_id = actor;
  return jsonb_build_object('workspace', leadflow_private.preference_row_json(w), 'mine', leadflow_private.preference_row_json(u),
    'effective', leadflow_private.outreach_preferences_json(target_workspace, actor), 'canEditWorkspace', actor_role <> 'member');
end $$;
-- scope 'workspace' (owners and admins): agency identity and writing defaults. scope 'user' (any member, for themselves):
-- sender name, role, contact details, tone and length.
create function public.save_outreach_preferences(target_workspace uuid, scope text, preferences jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid; owner_user uuid; links text[]; intervals integer[];
begin
  if scope = 'workspace' then perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  elsif scope = 'user' then perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  else raise exception 'Choose workspace or personal settings.' using errcode = '22023'; end if;
  if jsonb_typeof(preferences) is distinct from 'object' then raise exception 'Invalid settings.' using errcode = '22023'; end if;
  actor := leadflow_private.valid_actor();
  owner_user := case when scope = 'user' then actor end;
  if scope = 'user' and exists (select 1 from jsonb_object_keys(preferences) k where k not in ('senderName','senderRole','contactDetails','tone','length')) then
    raise exception 'Personal settings cover your sender details, tone and length.' using errcode = '22023';
  end if;
  if preferences ? 'caseStudyLinks' then
    if jsonb_typeof(preferences->'caseStudyLinks') <> 'array' then raise exception 'Enter case-study links as a list.' using errcode = '22023'; end if;
    select coalesce(array_agg(btrim(x)), '{}') into links from jsonb_array_elements_text(preferences->'caseStudyLinks') x where btrim(x) <> '';
    if exists (select 1 from unnest(links) l where l !~* '^https?://[^[:space:]]+$' or length(l) > 300) or cardinality(links) > 5 then raise exception 'Enter up to 5 case-study links starting with https://.' using errcode = '22023'; end if;
  end if;
  if preferences ? 'followupIntervals' then
    if jsonb_typeof(preferences->'followupIntervals') <> 'array' then raise exception 'Enter follow-up intervals as days.' using errcode = '22023'; end if;
    begin select coalesce(array_agg(x::integer order by x::integer), '{}') into intervals from jsonb_array_elements_text(preferences->'followupIntervals') x;
    exception when invalid_text_representation then raise exception 'Follow-up intervals are whole numbers of days.' using errcode = '22023'; end;
    if cardinality(intervals) > 3 or exists (select 1 from unnest(intervals) i where i < 1 or i > 90) then raise exception 'Use up to 3 follow-up intervals of 1 to 90 days.' using errcode = '22023'; end if;
  end if;
  begin
    insert into leadflow_private.outreach_preferences as p(workspace_id, user_id, agency_name, agency_description, agency_website, sender_name, sender_role, contact_details, tone, message_length,
        objective, preferred_cta, avoid_phrases, custom_instructions, case_study_links, followup_intervals, updated_by)
      values (target_workspace, owner_user, btrim(preferences->>'agencyName'), btrim(preferences->>'agencyDescription'), btrim(preferences->>'agencyWebsite'), btrim(preferences->>'senderName'),
        btrim(preferences->>'senderRole'), btrim(preferences->>'contactDetails'), nullif(preferences->>'tone', ''), nullif(preferences->>'length', ''), nullif(preferences->>'objective', ''),
        btrim(preferences->>'preferredCta'), btrim(preferences->>'avoidPhrases'), btrim(preferences->>'customInstructions'), links, intervals, actor)
      on conflict (workspace_id, (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid))) do update set
        agency_name = case when preferences ? 'agencyName' then excluded.agency_name else p.agency_name end,
        agency_description = case when preferences ? 'agencyDescription' then excluded.agency_description else p.agency_description end,
        agency_website = case when preferences ? 'agencyWebsite' then excluded.agency_website else p.agency_website end,
        sender_name = case when preferences ? 'senderName' then excluded.sender_name else p.sender_name end,
        sender_role = case when preferences ? 'senderRole' then excluded.sender_role else p.sender_role end,
        contact_details = case when preferences ? 'contactDetails' then excluded.contact_details else p.contact_details end,
        tone = case when preferences ? 'tone' then excluded.tone else p.tone end, message_length = case when preferences ? 'length' then excluded.message_length else p.message_length end,
        objective = case when preferences ? 'objective' then excluded.objective else p.objective end,
        preferred_cta = case when preferences ? 'preferredCta' then excluded.preferred_cta else p.preferred_cta end,
        avoid_phrases = case when preferences ? 'avoidPhrases' then excluded.avoid_phrases else p.avoid_phrases end,
        custom_instructions = case when preferences ? 'customInstructions' then excluded.custom_instructions else p.custom_instructions end,
        case_study_links = case when preferences ? 'caseStudyLinks' then excluded.case_study_links else p.case_study_links end,
        followup_intervals = case when preferences ? 'followupIntervals' then excluded.followup_intervals else p.followup_intervals end,
        updated_by = actor, updated_at = now();
  exception when check_violation then
    raise exception 'Check the settings: choose tone, length and objective from the lists; the website must start with https://; descriptions up to 600 characters, instructions up to 1,500.' using errcode = '22023';
  end;
  return public.outreach_preferences_for(target_workspace);
end $$;

-- ---------- Drafts (members) ----------

create function public.outreach_drafts_for(target_workspace uuid, target_lead text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return coalesce((select jsonb_agg(leadflow_private.draft_json(d) order by d.created_at desc) from leadflow_private.outreach_drafts d
    where d.workspace_id = target_workspace and d.lead_id = target_lead), '[]'::jsonb);
end $$;
create function public.outreach_draft_versions(target_workspace uuid, draft_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.outreach_drafts d where d.id = draft_id and d.workspace_id = target_workspace) then raise exception 'Draft not found.' using errcode = 'P0002'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('version', v.version, 'origin', v.origin, 'subject', v.subject, 'body', v.body, 'claims', v.claims, 'grounding', v.grounding,
    'angle', v.angle, 'provider', v.provider, 'model', v.model, 'inputTokens', v.input_tokens, 'outputTokens', v.output_tokens, 'settings', v.settings, 'createdBy', v.created_by, 'createdAt', v.created_at)
    order by v.version desc) from leadflow_private.outreach_draft_versions v where v.draft_id = outreach_draft_versions.draft_id), '[]'::jsonb);
end $$;
-- Saves a person's edit as a new version. expected_version must be the version the editor started from, so an edit made
-- elsewhere in the meantime is never silently replaced. Notes change without a new version.
create function public.save_outreach_draft(target_workspace uuid, draft_id uuid, expected_version integer, new_subject text, new_body text, new_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.outreach_drafts; subject_value text; body_value text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into d from leadflow_private.outreach_drafts x where x.id = draft_id and x.workspace_id = target_workspace for update;
  if d.id is null then raise exception 'Draft not found.' using errcode = 'P0002'; end if;
  if expected_version is distinct from d.current_version then raise exception 'This draft changed in another window. Reload it before saving.' using errcode = '40001'; end if;
  if new_notes is not null and length(new_notes) > 2000 then raise exception 'Notes can be up to 2,000 characters.' using errcode = '22023'; end if;
  subject_value := btrim(coalesce(new_subject, d.subject)); body_value := btrim(coalesce(new_body, d.body));
  if body_value = '' or length(body_value) > 6000 or length(subject_value) > 200 then raise exception 'The message needs text (up to 6,000 characters) and a subject of up to 200 characters.' using errcode = '22023'; end if;
  if d.channel = 'linkedin_connection' and length(body_value) > 200 then raise exception 'LinkedIn invitation notes can be up to 200 characters.' using errcode = '22023'; end if;
  if d.channel <> 'email' then subject_value := ''; end if;
  if subject_value <> d.subject or body_value <> d.body then
    insert into leadflow_private.outreach_draft_versions(draft_id, workspace_id, version, origin, subject, body, claims, grounding, angle, provider, model, created_by)
      values (d.id, target_workspace, d.current_version + 1, 'edited', subject_value, body_value, d.claims, d.grounding, d.angle, null, null, leadflow_private.valid_actor());
    update leadflow_private.outreach_drafts x set subject = subject_value, body = body_value, current_version = d.current_version + 1, current_origin = 'edited', updated_at = now()
      where x.id = d.id;
  end if;
  update leadflow_private.outreach_drafts x set notes = coalesce(new_notes, x.notes), updated_at = now() where x.id = d.id returning * into d;
  return leadflow_private.draft_json(d);
end $$;
-- Makes an earlier version current again, as a new version.
create function public.restore_outreach_draft_version(target_workspace uuid, draft_id uuid, restore_version integer, expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.outreach_drafts; v leadflow_private.outreach_draft_versions;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into d from leadflow_private.outreach_drafts x where x.id = draft_id and x.workspace_id = target_workspace for update;
  if d.id is null then raise exception 'Draft not found.' using errcode = 'P0002'; end if;
  if expected_version is distinct from d.current_version then raise exception 'This draft changed in another window. Reload it before restoring.' using errcode = '40001'; end if;
  select * into v from leadflow_private.outreach_draft_versions x where x.draft_id = d.id and x.version = restore_version;
  if v.id is null then raise exception 'Version not found.' using errcode = 'P0002'; end if;
  insert into leadflow_private.outreach_draft_versions(draft_id, workspace_id, version, origin, subject, body, claims, grounding, angle, provider, model, created_by)
    values (d.id, target_workspace, d.current_version + 1, 'restored', v.subject, v.body, v.claims, v.grounding, v.angle, v.provider, v.model, leadflow_private.valid_actor());
  update leadflow_private.outreach_drafts x set subject = v.subject, body = v.body, claims = v.claims, grounding = v.grounding, angle = v.angle, current_version = d.current_version + 1,
    current_origin = 'restored', updated_at = now() where x.id = d.id returning * into d;
  return leadflow_private.draft_json(d);
end $$;
-- Status is only ever changed by a person: copying a message never marks it sent.
create function public.set_outreach_draft_status(target_workspace uuid, draft_id uuid, new_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.outreach_drafts;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if new_status not in ('draft','ready','sent','replied','follow_up','archived') then raise exception 'Choose a listed status.' using errcode = '22023'; end if;
  update leadflow_private.outreach_drafts x set status = new_status, status_changed_at = now(), updated_at = now(),
    sent_at = case when new_status = 'sent' then coalesce(x.sent_at, now()) when new_status in ('draft','ready') then null else x.sent_at end,
    sent_by = case when new_status = 'sent' then coalesce(x.sent_by, leadflow_private.valid_actor()) when new_status in ('draft','ready') then null else x.sent_by end,
    replied_at = case when new_status = 'replied' then coalesce(x.replied_at, now()) when new_status in ('draft','ready','sent') then null else x.replied_at end
    where x.id = draft_id and x.workspace_id = target_workspace returning * into d;
  if d.id is null then raise exception 'Draft not found.' using errcode = 'P0002'; end if;
  return leadflow_private.draft_json(d);
end $$;
-- A copy to rework, as a new draft. The request ID makes a repeated click return the same copy.
create function public.duplicate_outreach_draft(target_workspace uuid, draft_id uuid, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.outreach_drafts; copy leadflow_private.outreach_drafts; existing uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select v.draft_id into existing from leadflow_private.outreach_draft_versions v where v.workspace_id = target_workspace and v.request_id = duplicate_outreach_draft.request_id;
  if existing is not null then select * into copy from leadflow_private.outreach_drafts x where x.id = existing; return leadflow_private.draft_json(copy); end if;
  select * into d from leadflow_private.outreach_drafts x where x.id = draft_id and x.workspace_id = target_workspace;
  if d.id is null then raise exception 'Draft not found.' using errcode = 'P0002'; end if;
  insert into leadflow_private.outreach_drafts(workspace_id, lead_id, contact_id, contact_name, analysis_id, opportunity_id, opportunity_title, service_id, channel, angle, sequence_step, parent_id,
      subject, body, claims, grounding, warnings, current_origin, provider, model, created_by)
    values (target_workspace, d.lead_id, d.contact_id, d.contact_name, d.analysis_id, d.opportunity_id, d.opportunity_title, d.service_id, d.channel, d.angle, d.sequence_step, d.parent_id,
      d.subject, d.body, d.claims, d.grounding, d.warnings, 'duplicated', d.provider, d.model, leadflow_private.valid_actor()) returning * into copy;
  insert into leadflow_private.outreach_draft_versions(draft_id, workspace_id, version, request_id, origin, subject, body, claims, grounding, angle, provider, model, created_by)
    values (copy.id, target_workspace, 1, duplicate_outreach_draft.request_id, 'duplicated', d.subject, d.body, d.claims, d.grounding, d.angle, d.provider, d.model, leadflow_private.valid_actor());
  return leadflow_private.draft_json(copy);
end $$;
create function public.delete_outreach_draft(target_workspace uuid, draft_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare actor_role text;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  delete from leadflow_private.outreach_drafts d where d.id = draft_id and d.workspace_id = target_workspace and (actor_role <> 'member' or d.created_by = leadflow_private.valid_actor());
  if not found then raise exception 'This draft doesn’t exist or isn’t yours to delete.' using errcode = 'P0002'; end if;
end $$;

-- This month's contact searches, generated drafts and provider usage, and the latest events.
create function public.outreach_usage_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return jsonb_build_object('since', date_trunc('month', now()),
    'contactSearches', (select count(*) from leadflow_private.contact_discovery_jobs j where j.workspace_id = target_workspace and j.mode = 'full' and j.created_at >= date_trunc('month', now())),
    'generations', (select count(*) from leadflow_private.outreach_draft_versions v where v.workspace_id = target_workspace and v.origin in ('generated','regenerated') and v.created_at >= date_trunc('month', now())),
    'usage', coalesce((select jsonb_agg(jsonb_build_object('provider', u.provider, 'operation', u.operation, 'unit', u.unit, 'quantity', u.quantity, 'credits', u.credits, 'failed', u.failed)) from (
      select provider, operation, unit, sum(quantity) as quantity, sum(credits) as credits, count(*) filter (where status = 'failed') as failed from leadflow_private.outreach_usage x
      where x.workspace_id = target_workspace and x.at >= date_trunc('month', now()) group by provider, operation, unit order by provider, operation) u), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('provider', r.provider, 'operation', r.operation, 'quantity', r.quantity, 'unit', r.unit, 'credits', r.credits, 'remaining', r.remaining,
      'status', r.status, 'detail', r.detail, 'at', r.at) order by r.at desc) from (select * from leadflow_private.outreach_usage x where x.workspace_id = target_workspace order by x.at desc limit 15) r), '[]'::jsonb));
end $$;

-- ---------- Service role (Edge Functions, after checking the caller) ----------

-- Starts contact discovery for a lead, or returns the job already running. limits: { monthlySearches, maxConcurrent, recentHours }.
create function public.start_contact_discovery(target_workspace uuid, actor uuid, target_lead text, request_id uuid, job_mode text, contact_ids jsonb, force boolean, limits jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing leadflow_private.contact_discovery_jobs; created leadflow_private.contact_discovery_jobs; ids jsonb := '[]';
begin
  select * into existing from leadflow_private.contact_discovery_jobs j where j.workspace_id = target_workspace and j.request_id = start_contact_discovery.request_id;
  if found then return jsonb_build_object('id', existing.id, 'existing', true); end if;
  if job_mode not in ('full','verify') then raise exception 'Unknown discovery mode.' using errcode = '22023'; end if;
  if not exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = target_lead) then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
  if job_mode = 'verify' then
    select coalesce(jsonb_agg(c.id), '[]') into ids from leadflow_private.lead_contacts c where c.workspace_id = target_workspace and c.lead_id = target_lead
      and c.id::text in (select jsonb_array_elements_text(coalesce(contact_ids, '[]')));
    if jsonb_array_length(ids) = 0 then raise exception 'Choose contacts of this lead to check.' using errcode = '22023'; end if;
  end if;
  select * into existing from leadflow_private.contact_discovery_jobs j where j.workspace_id = target_workspace and j.lead_id = target_lead and j.step is not null;
  if found then return jsonb_build_object('id', existing.id, 'existing', true); end if;
  if (select count(*) from leadflow_private.contact_discovery_jobs j where j.workspace_id = target_workspace and j.step is not null) >= coalesce((limits->>'maxConcurrent')::integer, 3) then
    raise exception 'Too many contact searches are running in this workspace. Wait for one to finish.' using errcode = 'P0429';
  end if;
  if job_mode = 'full' then
    if (select count(*) from leadflow_private.contact_discovery_jobs j where j.workspace_id = target_workspace and j.mode = 'full' and j.created_at >= date_trunc('month', now())) >= coalesce((limits->>'monthlySearches')::integer, 60) then
      raise exception 'This workspace has used its % contact searches for this month.', coalesce((limits->>'monthlySearches')::integer, 60) using errcode = 'P0429';
    end if;
    if not coalesce(force, false) and exists (select 1 from leadflow_private.contact_discovery_jobs j where j.workspace_id = target_workspace and j.lead_id = target_lead and j.mode = 'full'
        and j.status in ('completed','partial') and j.created_at > now() - make_interval(hours => coalesce((limits->>'recentHours')::integer, 6))) then
      raise exception 'Contacts for this lead were searched in the last % hours. Search again anyway?', coalesce((limits->>'recentHours')::integer, 6) using errcode = 'P0409';
    end if;
  end if;
  insert into leadflow_private.contact_discovery_jobs(workspace_id, lead_id, request_id, created_by, mode, options, status, step)
    values (target_workspace, target_lead, start_contact_discovery.request_id, actor, job_mode, jsonb_build_object('contactIds', ids), 'running', case when job_mode = 'full' then 'website' else 'verify' end)
    returning * into created;
  return jsonb_build_object('id', created.id, 'existing', false);
end $$;

-- Claims one due job (or the given one) with a lease, and returns what its step needs: the lead, the latest business
-- report's page evidence and the lead's contacts with their sources.
create function public.claim_contact_discovery(target uuid, lease_seconds integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j leadflow_private.contact_discovery_jobs; lead_row public.leads; analysis leadflow_private.business_analyses;
begin
  select * into j from leadflow_private.contact_discovery_jobs x
    where x.step is not null and x.next_run_at <= now() and (x.lease_until is null or x.lease_until < now()) and (target is null or x.id = target)
    order by x.next_run_at limit 1 for update skip locked;
  if j.id is null then return null; end if;
  update leadflow_private.contact_discovery_jobs x set lease_id = gen_random_uuid(), lease_until = now() + make_interval(secs => greatest(lease_seconds, 30)), attempts = x.attempts + 1,
    started_at = coalesce(x.started_at, now()), updated_at = now() where x.id = j.id returning * into j;
  select * into lead_row from public.leads l where l.workspace_id = j.workspace_id and l.id = j.lead_id;
  select * into analysis from leadflow_private.business_analyses a where a.workspace_id = j.workspace_id and a.lead_id = j.lead_id and a.status in ('completed','partial') order by a.created_at desc limit 1;
  return jsonb_build_object('id', j.id, 'workspaceId', j.workspace_id, 'leadId', j.lead_id, 'step', j.step, 'status', j.status, 'options', j.options || jsonb_build_object('mode', j.mode),
    'providers', j.providers, 'progress', j.progress, 'attempts', j.attempts, 'leaseId', j.lease_id, 'createdAt', j.created_at,
    'lead', case when lead_row.id is null then null else jsonb_build_object('name', lead_row.name, 'company', lead_row.company, 'email', lead_row.email, 'phone', lead_row.phone,
      'website', lead_row.website, 'country', lead_row.country) end,
    'analysis', case when analysis.id is null then null else jsonb_build_object('id', analysis.id, 'completedAt', analysis.completed_at) end,
    'pages', case when analysis.id is null or j.step <> 'website' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('evidenceId', e.id, 'sourceUrl', e.source_url, 'observedAt', e.observed_at, 'value', e.value))
      from (select * from leadflow_private.analysis_evidence e where e.analysis_id = analysis.id and e.kind = 'page' order by length(e.ref), e.ref limit 30) e), '[]'::jsonb) end,
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'email', c.email, 'emailStatus', c.email_status, 'emailCheckedAt', c.email_checked_at, 'phone', c.phone,
      'phoneE164', c.phone_e164, 'phoneStatus', c.phone_status, 'sources', coalesce((select jsonb_agg(jsonb_build_object('source', s.source, 'how', s.how, 'field', s.field)) from leadflow_private.lead_contact_sources s where s.contact_id = c.id), '[]'::jsonb)))
      from leadflow_private.lead_contacts c where c.workspace_id = j.workspace_id and c.lead_id = j.lead_id), '[]'::jsonb));
end $$;

-- Saves one step if the lease is still held: merged contacts, channels, verification results and usage. Usage is recorded
-- even when the job was cancelled meanwhile, because the provider was used.
create function public.save_contact_discovery_step(job_id uuid, lease uuid, patch jsonb, contacts jsonb, channels jsonb, verifications jsonb, usage jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j leadflow_private.contact_discovery_jobs; item jsonb; outcome text; added integer := 0; updated integer := 0; suggested integer := 0; evidence uuid; analysis uuid;
begin
  select * into j from leadflow_private.contact_discovery_jobs x where x.id = job_id for update;
  if j.id is null then raise exception 'Job not found.' using errcode = 'P0002'; end if;
  for item in select value from jsonb_array_elements(coalesce(usage, '[]')) loop
    insert into leadflow_private.outreach_usage(workspace_id, job_id, provider, operation, quantity, unit, status, actor)
      values (j.workspace_id, j.id, item->>'provider', item->>'operation', (item->>'quantity')::numeric, item->>'unit', coalesce(item->>'status', 'ok'), j.created_by);
  end loop;
  if j.lease_id is distinct from lease then return jsonb_build_object('outcome', case when j.status = 'cancelled' then 'cancelled' else 'lease_lost' end); end if;
  for item in select value from jsonb_array_elements(coalesce(contacts, '[]')) loop
    outcome := leadflow_private.merge_contact(j.workspace_id, j.lead_id, item, null);
    if outcome = 'added' then added := added + 1; elsif outcome = 'updated' then updated := updated + 1; elsif outcome = 'suggested' then suggested := suggested + 1; end if;
  end loop;
  for item in select value from jsonb_array_elements(coalesce(channels, '[]')) loop
    select e.id into evidence from leadflow_private.analysis_evidence e where e.id = nullif(item->>'evidenceId', '')::uuid and e.workspace_id = j.workspace_id;
    select a.id into analysis from leadflow_private.business_analyses a where a.id = nullif(item->>'analysisId', '')::uuid and a.workspace_id = j.workspace_id;
    insert into leadflow_private.lead_channels(workspace_id, lead_id, channel, label, value, source, source_url, evidence_id, analysis_id)
      values (j.workspace_id, j.lead_id, item->>'channel', left(coalesce(item->>'label', ''), 80), left(item->>'value', 300), coalesce(item->>'source', 'website'), left(nullif(item->>'sourceUrl', ''), 500), evidence, analysis)
      on conflict (workspace_id, lead_id, channel, value) do update set observed_at = now(), label = excluded.label, source_url = coalesce(excluded.source_url, leadflow_private.lead_channels.source_url),
        evidence_id = coalesce(excluded.evidence_id, leadflow_private.lead_channels.evidence_id), analysis_id = coalesce(excluded.analysis_id, leadflow_private.lead_channels.analysis_id);
  end loop;
  for item in select value from jsonb_array_elements(coalesce(verifications, '[]')) loop
    update leadflow_private.lead_contacts c set
      email_status = case when item->>'emailStatus' in ('verified','likely_valid','unverified','invalid','risky','unknown') then item->>'emailStatus' else c.email_status end,
      email_check = case when item ? 'emailCheck' then item->'emailCheck' else c.email_check end, email_checked_at = case when item ? 'emailStatus' then now() else c.email_checked_at end,
      phone_status = case when c.phone_status <> 'provider_verified' and item->>'phoneStatus' in ('valid_format','invalid_format','unverified') then item->>'phoneStatus' else c.phone_status end,
      phone_e164 = case when c.phone_status <> 'provider_verified' and item ? 'phoneE164' and coalesce(item->>'phoneE164', '') ~ '^(\+[1-9][0-9]{6,14})?$' then item->>'phoneE164' else c.phone_e164 end,
      updated_at = now()
      where c.id = (item->>'contactId')::uuid and c.workspace_id = j.workspace_id and c.lead_id = j.lead_id;
  end loop;
  update leadflow_private.contact_discovery_jobs x set
    status = coalesce(patch->>'status', x.status), step = case when patch ? 'step' then patch->>'step' else x.step end, providers = x.providers || coalesce(patch->'providers', '{}'),
    progress = x.progress || coalesce(patch->'progress', '{}') || jsonb_build_object('contactsAdded', coalesce((x.progress->>'contactsAdded')::integer, 0) + added,
      'contactsUpdated', coalesce((x.progress->>'contactsUpdated')::integer, 0) + updated, 'suggestions', coalesce((x.progress->>'suggestions')::integer, 0) + suggested,
      'channelsFound', (select count(*) from leadflow_private.lead_channels h where h.workspace_id = x.workspace_id and h.lead_id = x.lead_id)),
    failure = case when patch ? 'failure' then left(patch->>'failure', 500) else x.failure end, next_run_at = now() + make_interval(secs => coalesce((patch->>'delaySeconds')::numeric, 0)),
    completed_at = case when patch ? 'step' and patch->>'step' is null then now() else x.completed_at end, lease_id = null, lease_until = null, updated_at = now()
    where x.id = j.id;
  return jsonb_build_object('outcome', 'saved', 'added', added, 'updated', updated, 'suggested', suggested);
end $$;

-- What the outreach generator may use for a lead: the lead, the business report (the selected opportunity's, or the latest
-- finished one), its findings, evidence references and opportunities, the active services, the chosen contact, the member's
-- effective settings and, for a follow-up, the first message.
-- request: { requestId, draftId, expectedVersion, replaceEdited, opportunityId, contactId, parentId }; limits: { monthlyGenerations }.
create function public.outreach_context(target_workspace uuid, actor uuid, target_lead text, request jsonb, limits jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare lead_row public.leads; analysis leadflow_private.business_analyses; c leadflow_private.lead_contacts; p leadflow_private.outreach_drafts; o leadflow_private.business_opportunities;
  d leadflow_private.outreach_drafts; existing uuid; opportunity uuid := nullif(request->>'opportunityId', '')::uuid; contact uuid := nullif(request->>'contactId', '')::uuid;
  parent uuid := nullif(request->>'parentId', '')::uuid;
begin
  -- A repeated request returns the draft it already produced, without calling the AI again.
  select v.draft_id into existing from leadflow_private.outreach_draft_versions v where v.workspace_id = target_workspace and v.request_id = nullif(request->>'requestId', '')::uuid;
  if existing is not null then select * into d from leadflow_private.outreach_drafts x where x.id = existing; return jsonb_build_object('existingDraft', leadflow_private.draft_json(d)); end if;
  -- Regeneration is checked before the AI is called, so a refused request costs nothing.
  if nullif(request->>'draftId', '') is not null then
    select * into d from leadflow_private.outreach_drafts x where x.id = (request->>'draftId')::uuid and x.workspace_id = target_workspace and x.lead_id = target_lead;
    if d.id is null then raise exception 'Draft not found.' using errcode = 'P0002'; end if;
    if d.status in ('sent','replied') then raise exception 'This message was marked as sent. Duplicate it to write a new version.' using errcode = '22023'; end if;
    if (request->>'expectedVersion')::integer is distinct from d.current_version then raise exception 'This draft changed in another window. Reload it before regenerating.' using errcode = '40001'; end if;
    if d.current_origin in ('edited','restored') and not coalesce((request->>'replaceEdited')::boolean, false) then
      raise exception 'You edited this draft. Regenerating creates a new version; your edit stays in the history. Confirm to continue.' using errcode = 'P0409';
    end if;
  end if;
  if (select count(*) from leadflow_private.outreach_draft_versions v where v.workspace_id = target_workspace and v.origin in ('generated','regenerated') and v.created_at >= date_trunc('month', now()))
      >= coalesce((limits->>'monthlyGenerations')::integer, 300) then
    raise exception 'This workspace has generated its % drafts for this month.', coalesce((limits->>'monthlyGenerations')::integer, 300) using errcode = 'P0429';
  end if;
  select * into lead_row from public.leads l where l.workspace_id = target_workspace and l.id = target_lead;
  if lead_row.id is null then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
  if opportunity is not null then
    select * into o from leadflow_private.business_opportunities x where x.id = opportunity and x.workspace_id = target_workspace and x.lead_id = target_lead;
    if o.id is null then raise exception 'That opportunity isn’t part of this lead’s reports.' using errcode = 'P0002'; end if;
    select * into analysis from leadflow_private.business_analyses a where a.id = o.analysis_id;
  else
    select * into analysis from leadflow_private.business_analyses a where a.workspace_id = target_workspace and a.lead_id = target_lead and a.status in ('completed','partial') order by a.created_at desc limit 1;
  end if;
  if contact is not null then
    select * into c from leadflow_private.lead_contacts x where x.id = contact and x.workspace_id = target_workspace and x.lead_id = target_lead;
    if c.id is null then raise exception 'That contact isn’t one of this lead’s contacts.' using errcode = 'P0002'; end if;
  end if;
  if parent is not null then
    select * into p from leadflow_private.outreach_drafts x where x.id = parent and x.workspace_id = target_workspace and x.lead_id = target_lead;
    if p.id is null then raise exception 'The first message wasn’t found.' using errcode = 'P0002'; end if;
    if p.status not in ('sent','replied','follow_up') then raise exception 'Mark the first message as sent before preparing a follow-up.' using errcode = '22023'; end if;
  end if;
  return jsonb_build_object(
    'lead', jsonb_build_object('id', lead_row.id, 'name', lead_row.name, 'company', lead_row.company, 'industry', lead_row.industry, 'city', lead_row.city, 'region', lead_row.region,
      'country', lead_row.country, 'website', lead_row.website),
    'analysis', case when analysis.id is null then null else jsonb_build_object('id', analysis.id, 'status', analysis.status, 'completedAt', analysis.completed_at,
      'summary', coalesce(analysis.overview->'ai'->'summary'->>'text', '')) end,
    'findings', case when analysis.id is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'key', f.key, 'category', f.category, 'title', f.title,
      'description', f.description, 'findingType', f.finding_type, 'severity', f.severity, 'confidence', f.confidence, 'verificationStatus', f.verification_status,
      'opportunityType', f.opportunity_type, 'evidenceIds', to_jsonb(f.evidence_ids), 'businessRelevance', f.business_relevance)) from leadflow_private.analysis_findings f where f.analysis_id = analysis.id), '[]'::jsonb) end,
    'evidence', case when analysis.id is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'ref', e.ref, 'kind', e.kind, 'sourceUrl', e.source_url))
      from leadflow_private.analysis_evidence e where e.analysis_id = analysis.id), '[]'::jsonb) end,
    'opportunities', case when analysis.id is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'opportunityType', x.opportunity_type, 'title', x.title,
      'findingIds', to_jsonb(x.finding_ids), 'serviceId', x.service_id, 'serviceName', coalesce(s.name, x.service_name), 'why', x.why, 'benefit', x.benefit, 'priority', x.priority,
      'confidence', x.confidence, 'status', x.status)) from leadflow_private.business_opportunities x left join leadflow_private.agency_services s on s.id = x.service_id where x.analysis_id = analysis.id), '[]'::jsonb) end,
    'services', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'description', s.description, 'opportunityTypes', to_jsonb(s.opportunity_types)) order by s.name)
      from leadflow_private.agency_services s where s.workspace_id = target_workspace and s.active), '[]'::jsonb),
    'contact', case when c.id is null then null else jsonb_build_object('id', c.id, 'kind', c.kind, 'fullName', c.full_name, 'jobTitle', c.job_title, 'role', c.role, 'label', c.label, 'email', c.email) end,
    'preferences', leadflow_private.outreach_preferences_json(target_workspace, actor),
    'parent', case when p.id is null then null else jsonb_build_object('id', p.id, 'channel', p.channel, 'subject', p.subject, 'body', p.body, 'status', p.status, 'sentAt', p.sent_at,
      'notes', p.notes, 'sequenceStep', p.sequence_step) end,
    'history', case when p.id is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('channel', h.channel, 'status', h.status, 'sentAt', h.sent_at, 'sequenceStep', h.sequence_step))
      from leadflow_private.outreach_drafts h where h.workspace_id = target_workspace and h.parent_id = p.id), '[]'::jsonb) end);
end $$;

-- Saves a generated draft (draft_id null) or a regenerated version (draft_id set). Idempotent by request ID. Regenerating
-- refuses (P0409) to replace a version a person edited or restored unless replace_edited is true; that version stays in
-- the history either way. A message marked as sent is never regenerated.
-- draft: { contactId, contactName, analysisId, opportunityId, opportunityTitle, serviceId, channel, angle, sequenceStep, parentId,
--          subject, body, claims, grounding, warnings, provider, model, inputTokens, outputTokens, settings }.
create function public.save_generated_draft(target_workspace uuid, actor uuid, target_lead text, request_id uuid, draft_id uuid, expected_version integer, replace_edited boolean, draft jsonb, usage jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing uuid; d leadflow_private.outreach_drafts; item jsonb; contact_ref uuid; opportunity_ref uuid; analysis_ref uuid; service_ref uuid; parent_ref uuid;
begin
  select v.draft_id into existing from leadflow_private.outreach_draft_versions v where v.workspace_id = target_workspace and v.request_id = save_generated_draft.request_id;
  if existing is not null then select * into d from leadflow_private.outreach_drafts x where x.id = existing; return leadflow_private.draft_json(d) || jsonb_build_object('existing', true); end if;
  select x.id into contact_ref from leadflow_private.lead_contacts x where x.id = nullif(draft->>'contactId', '')::uuid and x.workspace_id = target_workspace and x.lead_id = target_lead;
  select x.id into opportunity_ref from leadflow_private.business_opportunities x where x.id = nullif(draft->>'opportunityId', '')::uuid and x.workspace_id = target_workspace and x.lead_id = target_lead;
  select x.id into analysis_ref from leadflow_private.business_analyses x where x.id = nullif(draft->>'analysisId', '')::uuid and x.workspace_id = target_workspace and x.lead_id = target_lead;
  select x.id into service_ref from leadflow_private.agency_services x where x.id = nullif(draft->>'serviceId', '')::uuid and x.workspace_id = target_workspace;
  select x.id into parent_ref from leadflow_private.outreach_drafts x where x.id = nullif(draft->>'parentId', '')::uuid and x.workspace_id = target_workspace and x.lead_id = target_lead;
  if draft_id is null then
    insert into leadflow_private.outreach_drafts(workspace_id, lead_id, contact_id, contact_name, analysis_id, opportunity_id, opportunity_title, service_id, channel, angle, sequence_step, parent_id,
        subject, body, claims, grounding, warnings, provider, model, created_by)
      values (target_workspace, target_lead, contact_ref, left(coalesce(draft->>'contactName', ''), 150), analysis_ref, opportunity_ref, left(coalesce(draft->>'opportunityTitle', ''), 200), service_ref,
        draft->>'channel', draft->>'angle', coalesce((draft->>'sequenceStep')::integer, 0), parent_ref, coalesce(draft->>'subject', ''), draft->>'body', coalesce(draft->'claims', '[]'),
        coalesce(draft->>'grounding', 'general'), coalesce(draft->'warnings', '[]'), draft->>'provider', draft->>'model', actor) returning * into d;
    insert into leadflow_private.outreach_draft_versions(draft_id, workspace_id, version, request_id, origin, subject, body, claims, grounding, angle, provider, model, input_tokens, output_tokens, settings, created_by)
      values (d.id, target_workspace, 1, save_generated_draft.request_id, 'generated', d.subject, d.body, d.claims, d.grounding, d.angle, d.provider, d.model,
        (draft->>'inputTokens')::integer, (draft->>'outputTokens')::integer, coalesce(draft->'settings', '{}'), actor);
  else
    select * into d from leadflow_private.outreach_drafts x where x.id = draft_id and x.workspace_id = target_workspace and x.lead_id = target_lead for update;
    if d.id is null then raise exception 'Draft not found.' using errcode = 'P0002'; end if;
    if d.status in ('sent','replied') then raise exception 'This message was marked as sent. Duplicate it to write a new version.' using errcode = '22023'; end if;
    if expected_version is distinct from d.current_version then raise exception 'This draft changed in another window. Reload it before regenerating.' using errcode = '40001'; end if;
    if d.current_origin in ('edited','restored') and not coalesce(replace_edited, false) then
      raise exception 'You edited this draft. Regenerating creates a new version; your edit stays in the history. Confirm to continue.' using errcode = 'P0409';
    end if;
    insert into leadflow_private.outreach_draft_versions(draft_id, workspace_id, version, request_id, origin, subject, body, claims, grounding, angle, provider, model, input_tokens, output_tokens, settings, created_by)
      values (d.id, target_workspace, d.current_version + 1, save_generated_draft.request_id, 'regenerated', coalesce(draft->>'subject', ''), draft->>'body', coalesce(draft->'claims', '[]'),
        coalesce(draft->>'grounding', 'general'), draft->>'angle', draft->>'provider', draft->>'model', (draft->>'inputTokens')::integer, (draft->>'outputTokens')::integer, coalesce(draft->'settings', '{}'), actor);
    update leadflow_private.outreach_drafts x set subject = coalesce(draft->>'subject', ''), body = draft->>'body', claims = coalesce(draft->'claims', '[]'), grounding = coalesce(draft->>'grounding', 'general'),
      warnings = coalesce(draft->'warnings', '[]'), angle = draft->>'angle', contact_id = coalesce(contact_ref, x.contact_id), contact_name = case when contact_ref is null then x.contact_name else left(coalesce(draft->>'contactName', ''), 150) end,
      opportunity_id = opportunity_ref, opportunity_title = left(coalesce(draft->>'opportunityTitle', ''), 200), service_id = service_ref, analysis_id = coalesce(analysis_ref, x.analysis_id),
      provider = draft->>'provider', model = draft->>'model', current_version = d.current_version + 1, current_origin = 'regenerated', status = case when x.status = 'ready' then 'draft' else x.status end, updated_at = now()
      where x.id = d.id returning * into d;
  end if;
  for item in select value from jsonb_array_elements(coalesce(usage, '[]')) loop
    insert into leadflow_private.outreach_usage(workspace_id, draft_id, provider, operation, quantity, unit, status, actor)
      values (target_workspace, d.id, item->>'provider', item->>'operation', (item->>'quantity')::numeric, item->>'unit', coalesce(item->>'status', 'ok'), actor);
  end loop;
  return leadflow_private.draft_json(d) || jsonb_build_object('existing', false);
end $$;
-- Provider usage that didn't produce a draft (a failed or rejected generation).
create function public.record_outreach_usage(target_workspace uuid, actor uuid, usage jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare item jsonb;
begin
  for item in select value from jsonb_array_elements(coalesce(usage, '[]')) loop
    insert into leadflow_private.outreach_usage(workspace_id, provider, operation, quantity, unit, status, detail, actor)
      values (target_workspace, item->>'provider', item->>'operation', (item->>'quantity')::numeric, item->>'unit', coalesce(item->>'status', 'ok'), left(item->>'detail', 300), actor);
  end loop;
end $$;

revoke all on function leadflow_private.is_contact_role(text), leadflow_private.role_for_title(text), leadflow_private.name_key(text), leadflow_private.contact_hash(text),
  leadflow_private.contact_key_hashes(text, text, text, text, text, text), leadflow_private.contact_json(leadflow_private.lead_contacts),
  leadflow_private.contact_job_json(leadflow_private.contact_discovery_jobs), leadflow_private.draft_json(leadflow_private.outreach_drafts),
  leadflow_private.outreach_preferences_json(uuid, uuid), leadflow_private.preference_row_json(leadflow_private.outreach_preferences),
  leadflow_private.merge_decision(text, text, text, boolean, text[]), leadflow_private.merge_contact(uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.lead_contacts_for(uuid, text), public.save_lead_contact(uuid, text, jsonb), public.set_lead_contact_flags(uuid, uuid, jsonb),
  public.resolve_contact_suggestion(uuid, uuid, text, text, boolean), public.delete_lead_contact(uuid, uuid), public.delete_lead_contact_data(uuid, text),
  public.add_apollo_people_as_contacts(uuid, text, jsonb), public.cancel_contact_discovery(uuid, uuid), public.outreach_preferences_for(uuid), public.save_outreach_preferences(uuid, text, jsonb),
  public.outreach_drafts_for(uuid, text), public.outreach_draft_versions(uuid, uuid), public.save_outreach_draft(uuid, uuid, integer, text, text, text),
  public.restore_outreach_draft_version(uuid, uuid, integer, integer), public.set_outreach_draft_status(uuid, uuid, text), public.duplicate_outreach_draft(uuid, uuid, uuid),
  public.delete_outreach_draft(uuid, uuid), public.outreach_usage_for(uuid),
  public.start_contact_discovery(uuid, uuid, text, uuid, text, jsonb, boolean, jsonb), public.claim_contact_discovery(uuid, integer),
  public.save_contact_discovery_step(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb), public.outreach_context(uuid, uuid, text, jsonb, jsonb),
  public.save_generated_draft(uuid, uuid, text, uuid, uuid, integer, boolean, jsonb, jsonb), public.record_outreach_usage(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.lead_contacts_for(uuid, text), public.save_lead_contact(uuid, text, jsonb), public.set_lead_contact_flags(uuid, uuid, jsonb),
  public.resolve_contact_suggestion(uuid, uuid, text, text, boolean), public.delete_lead_contact(uuid, uuid), public.delete_lead_contact_data(uuid, text),
  public.add_apollo_people_as_contacts(uuid, text, jsonb), public.cancel_contact_discovery(uuid, uuid), public.outreach_preferences_for(uuid), public.save_outreach_preferences(uuid, text, jsonb),
  public.outreach_drafts_for(uuid, text), public.outreach_draft_versions(uuid, uuid), public.save_outreach_draft(uuid, uuid, integer, text, text, text),
  public.restore_outreach_draft_version(uuid, uuid, integer, integer), public.set_outreach_draft_status(uuid, uuid, text), public.duplicate_outreach_draft(uuid, uuid, uuid),
  public.delete_outreach_draft(uuid, uuid), public.outreach_usage_for(uuid) to authenticated;
grant execute on function public.start_contact_discovery(uuid, uuid, text, uuid, text, jsonb, boolean, jsonb), public.claim_contact_discovery(uuid, integer),
  public.save_contact_discovery_step(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb), public.outreach_context(uuid, uuid, text, jsonb, jsonb),
  public.save_generated_draft(uuid, uuid, text, uuid, uuid, integer, boolean, jsonb, jsonb), public.record_outreach_usage(uuid, uuid, jsonb) to service_role;
