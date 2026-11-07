-- M7 business intelligence: website analysis of a lead, evidence-backed findings, and opportunities matched to the
-- agency's service catalog.
-- * An analysis is a job advanced one step at a time by the business-analysis and analysis-worker Edge Functions. Each
--   step claims the job with a lease, does its work, and saves everything it produced in one transaction, so a step that
--   fails or loses its lease leaves nothing half-written and partial results from earlier steps survive.
-- * Every finding names the evidence it rests on (evidence rows of the same analysis); the database refuses findings
--   that point anywhere else. Findings are typed observed / measured / ai_interpretation / hypothesis.
-- * Analyses reference leads by ID with no foreign key, like onboarding and lead origins: snapshot saves replace leads.
-- * All tables are private; members read and act through role-checked functions, the Edge Functions through
--   service-role functions after checking the caller.
-- Reverse with supabase/rollbacks/202611080001_business_intelligence.down.sql.

create function leadflow_private.is_opportunity_type(candidate text) returns boolean language sql immutable set search_path = '' as $$
  select candidate in ('website_redesign','website_development','seo','performance','mobile_experience','conversion_optimization','booking_integration',
    'ai_chatbot','whatsapp_automation','crm_integration','workflow_automation','ecommerce','custom_software','social_media')
$$;

create table leadflow_private.agency_services (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 1000),
  category text not null default '' check (length(category) <= 60),
  -- Kinds of business this service suits, e.g. "dental clinics". Empty means any.
  target_categories text[] not null default '{}' check (cardinality(target_categories) <= 20),
  opportunity_types text[] not null default '{}' check (cardinality(opportunity_types) <= 14),
  pricing text not null default '' check (length(pricing) <= 200),
  active boolean not null default true,
  notes text not null default '' check (length(notes) <= 1000),
  starter_key text check (starter_key ~ '^[a-z_]{1,40}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index agency_services_name on leadflow_private.agency_services(workspace_id, lower(btrim(name)));
create unique index agency_services_starter on leadflow_private.agency_services(workspace_id, starter_key) where starter_key is not null;

create table leadflow_private.business_analyses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null check (length(lead_id) between 1 and 200),
  website text not null check (length(website) <= 300 and website ~* '^https?://'),
  request_id uuid not null,
  created_by uuid,
  status text not null default 'queued' check (status in ('queued','validating','crawling','measuring','analyzing','matching','completed','partial','failed','cancelled')),
  -- The next pipeline step to run; null once finished.
  step text check (step ~ '^[a-z_]{1,40}$'),
  -- Per-provider outcome: { site: {status, detail}, apify: {...}, pagespeed: {...}, ai: {...} }.
  providers jsonb not null default '{}' check (jsonb_typeof(providers) = 'object' and octet_length(providers::text) <= 8000),
  apify_run_id text check (apify_run_id ~ '^[A-Za-z0-9]{1,40}$'),
  apify_dataset_id text check (apify_dataset_id ~ '^[A-Za-z0-9]{1,40}$'),
  pages_analyzed integer not null default 0 check (pages_analyzed between 0 and 1000),
  -- The business overview: extracted facts with evidence references, kept apart from findings.
  overview jsonb check (jsonb_typeof(overview) = 'object' and octet_length(overview::text) <= 20000),
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
create index business_analyses_lead on leadflow_private.business_analyses(workspace_id, lead_id, created_at desc);
create index business_analyses_due on leadflow_private.business_analyses(next_run_at) where step is not null;

create table leadflow_private.analysis_evidence (
  id uuid primary key,
  analysis_id uuid not null references leadflow_private.business_analyses(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ref text not null check (ref ~ '^E[0-9]{1,4}$'),
  category text not null check (category ~ '^[a-z_]{1,30}$'),
  kind text not null check (kind ~ '^[a-z_]{1,40}$'),
  source_url text check (length(source_url) <= 500),
  provider text not null check (provider ~ '^[a-z_]{1,30}$'),
  value jsonb not null check (octet_length(value::text) <= 24000),
  observed_at timestamptz not null default now(),
  unique (analysis_id, ref)
);
create index analysis_evidence_analysis on leadflow_private.analysis_evidence(analysis_id);

create table leadflow_private.analysis_findings (
  id uuid primary key,
  analysis_id uuid not null references leadflow_private.business_analyses(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null,
  -- Stable across analyses of the same site, e.g. "seo.meta_description_missing", for comparing reports.
  key text not null check (key ~ '^[a-z0-9_.]{1,80}$'),
  category text not null check (category in ('overview','availability','structure','performance','seo','mobile','ux','conversion','communication','technology','social','automation')),
  title text not null check (length(title) between 1 and 200),
  description text not null default '' check (length(description) <= 2000),
  finding_type text not null check (finding_type in ('observed','measured','ai_interpretation','hypothesis')),
  severity text not null check (severity in ('high','medium','low','info')),
  confidence text not null check (confidence in ('high','medium','low')),
  evidence_ids uuid[] not null check (cardinality(evidence_ids) between 1 and 30),
  source text not null check (source ~ '^[a-z_]{1,30}$'),
  opportunity_type text check (leadflow_private.is_opportunity_type(opportunity_type)),
  recommended_action text not null default '' check (length(recommended_action) <= 600),
  business_relevance text not null default '' check (length(business_relevance) <= 600),
  verification_status text not null default 'unverified' check (verification_status in ('unverified','verified','disputed')),
  observed_at timestamptz not null default now()
);
create index analysis_findings_analysis on leadflow_private.analysis_findings(analysis_id);

create table leadflow_private.business_opportunities (
  id uuid primary key,
  analysis_id uuid not null references leadflow_private.business_analyses(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null,
  opportunity_type text not null check (leadflow_private.is_opportunity_type(opportunity_type)),
  title text not null check (length(title) between 1 and 200),
  finding_ids uuid[] not null check (cardinality(finding_ids) between 1 and 30),
  service_id uuid references leadflow_private.agency_services(id) on delete set null,
  -- The service's name when matched, kept if the service is later renamed or removed.
  service_name text not null default '' check (length(service_name) <= 80),
  why text not null default '' check (length(why) <= 1000),
  benefit text not null default '' check (length(benefit) <= 600),
  priority text not null check (priority in ('high','medium','low')),
  confidence text not null check (confidence in ('high','medium','low')),
  next_action text not null default '' check (length(next_action) <= 400),
  status text not null default 'suggested' check (status in ('suggested','accepted','dismissed','needs_verification')),
  notes text not null default '' check (length(notes) <= 2000),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create index business_opportunities_analysis on leadflow_private.business_opportunities(analysis_id);

create table leadflow_private.analysis_usage (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  analysis_id uuid references leadflow_private.business_analyses(id) on delete set null,
  provider text not null check (provider ~ '^[a-z_]{1,30}$'),
  quantity numeric(14,2) not null check (quantity >= 0),
  unit text not null check (unit ~ '^[a-z_]{1,30}$'),
  -- Only what a provider reported (Apify's usageTotalUsd); never an estimate.
  cost_usd numeric(12,4) check (cost_usd >= 0),
  at timestamptz not null default now()
);
create index analysis_usage_month on leadflow_private.analysis_usage(workspace_id, at);

alter table leadflow_private.agency_services enable row level security;
alter table leadflow_private.business_analyses enable row level security;
alter table leadflow_private.analysis_evidence enable row level security;
alter table leadflow_private.analysis_findings enable row level security;
alter table leadflow_private.business_opportunities enable row level security;
alter table leadflow_private.analysis_usage enable row level security;
revoke all on leadflow_private.agency_services, leadflow_private.business_analyses, leadflow_private.analysis_evidence, leadflow_private.analysis_findings,
  leadflow_private.business_opportunities, leadflow_private.analysis_usage from public, anon, authenticated;

-- ---------- Member functions (authenticated, role-checked) ----------

create function public.analysis_member_role(target_workspace uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  return leadflow_private.require_role(target_workspace, array['owner','admin','member']);
end $$;

create function leadflow_private.service_json(s leadflow_private.agency_services) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'description', s.description, 'category', s.category, 'targetCategories', to_jsonb(s.target_categories),
    'opportunityTypes', to_jsonb(s.opportunity_types), 'pricing', s.pricing, 'active', s.active, 'notes', s.notes, 'starterKey', s.starter_key, 'updatedAt', s.updated_at)
$$;

create function public.agency_services_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  -- Internal notes are for owners and admins.
  return coalesce((select jsonb_agg(leadflow_private.service_json(s) || case when actor_role = 'member' then jsonb_build_object('notes', '') else '{}'::jsonb end
      order by s.active desc, lower(s.name)) from leadflow_private.agency_services s where s.workspace_id = target_workspace), '[]'::jsonb);
end $$;

-- Creates or updates one service (owners and admins). Omitted fields keep their value on update.
create function public.save_agency_service(target_workspace uuid, service jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result leadflow_private.agency_services; service_id uuid; types text[]; targets text[];
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  if jsonb_typeof(service) is distinct from 'object' then raise exception 'Invalid service.' using errcode = '22023'; end if;
  if service ? 'opportunityTypes' then
    if jsonb_typeof(service->'opportunityTypes') <> 'array' then raise exception 'Choose opportunity types from the list.' using errcode = '22023'; end if;
    select coalesce(array_agg(distinct x), '{}') into types from jsonb_array_elements_text(service->'opportunityTypes') x;
    if exists (select 1 from unnest(types) t where not leadflow_private.is_opportunity_type(t)) then raise exception 'Choose opportunity types from the list.' using errcode = '22023'; end if;
  end if;
  if service ? 'targetCategories' then
    if jsonb_typeof(service->'targetCategories') <> 'array' then raise exception 'Enter business categories as a list.' using errcode = '22023'; end if;
    select coalesce(array_agg(distinct left(btrim(x), 60)), '{}') into targets from jsonb_array_elements_text(service->'targetCategories') x where btrim(x) <> '';
  end if;
  begin
    if service->>'id' is null then
      insert into leadflow_private.agency_services(workspace_id, name, description, category, target_categories, opportunity_types, pricing, active, notes)
        values (target_workspace, btrim(coalesce(service->>'name', '')), coalesce(service->>'description', ''), coalesce(service->>'category', ''), coalesce(targets, '{}'),
          coalesce(types, '{}'), coalesce(service->>'pricing', ''), coalesce((service->>'active')::boolean, true), coalesce(service->>'notes', ''))
        returning * into result;
    else
      service_id := (service->>'id')::uuid;
      update leadflow_private.agency_services s set
        name = coalesce(btrim(service->>'name'), s.name), description = coalesce(service->>'description', s.description), category = coalesce(service->>'category', s.category),
        target_categories = coalesce(targets, s.target_categories), opportunity_types = coalesce(types, s.opportunity_types), pricing = coalesce(service->>'pricing', s.pricing),
        active = coalesce((service->>'active')::boolean, s.active), notes = coalesce(service->>'notes', s.notes), updated_at = now()
        where s.id = service_id and s.workspace_id = target_workspace returning * into result;
      if result.id is null then raise exception 'Service not found.' using errcode = 'P0002'; end if;
    end if;
  exception
    when unique_violation then raise exception 'A service with this name already exists.' using errcode = '22023';
    when check_violation or invalid_text_representation then raise exception 'Check the service: a name of 1–80 characters, a description up to 1,000, pricing up to 200.' using errcode = '22023';
  end;
  return leadflow_private.service_json(result);
end $$;

create function public.delete_agency_service(target_workspace uuid, service_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  delete from leadflow_private.agency_services s where s.id = service_id and s.workspace_id = target_workspace;
  if not found then raise exception 'Service not found.' using errcode = 'P0002'; end if;
end $$;

-- Adds the starter services that aren't in the catalog yet. Returns how many were added.
create function public.install_starter_services(target_workspace uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare added integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  insert into leadflow_private.agency_services(workspace_id, starter_key, name, category, description, opportunity_types)
  select target_workspace, k, n, c, d, t from (values
    ('website_design', 'Website design', 'Web', 'New or refreshed design that makes the business clear and easy to contact.', array['website_redesign','mobile_experience','conversion_optimization']),
    ('website_development', 'Website development', 'Web', 'Building and improving websites: speed, features and integrations.', array['website_development','performance','booking_integration']),
    ('seo', 'SEO', 'Marketing', 'Technical and on-page search optimization.', array['seo','performance']),
    ('ai_chatbot', 'AI chatbot development', 'Automation', 'A website assistant that answers common questions and captures inquiries.', array['ai_chatbot']),
    ('whatsapp_automation', 'WhatsApp automation', 'Automation', 'WhatsApp contact options and automated replies.', array['whatsapp_automation']),
    ('crm_integration', 'CRM integration', 'Automation', 'Connecting website inquiries to a CRM.', array['crm_integration']),
    ('workflow_automation', 'Business workflow automation', 'Automation', 'Automating bookings, follow-ups and routine admin.', array['workflow_automation','booking_integration']),
    ('ecommerce', 'E-commerce development', 'Web', 'Online stores and checkout improvements.', array['ecommerce']),
    ('custom_software', 'Custom software', 'Software', 'Custom tools and portals for business processes.', array['custom_software']),
    ('api_integration', 'API integration', 'Software', 'Connecting the website and business tools.', array['crm_integration','workflow_automation','custom_software']),
    ('social_media', 'Social media automation', 'Marketing', 'Consistent social profiles linked from the website, and scheduled posting.', array['social_media'])
  ) as starter(k, n, c, d, t)
  where not exists (select 1 from leadflow_private.agency_services s where s.workspace_id = target_workspace and (s.starter_key = starter.k or lower(btrim(s.name)) = lower(starter.n)));
  get diagnostics added = row_count;
  return added;
end $$;

create function leadflow_private.analysis_summary_json(a leadflow_private.business_analyses) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', a.id, 'leadId', a.lead_id, 'website', a.website, 'status', a.status, 'step', a.step, 'providers', a.providers,
    'pagesAnalyzed', a.pages_analyzed, 'failure', a.failure, 'createdAt', a.created_at, 'startedAt', a.started_at, 'completedAt', a.completed_at,
    'findingCount', (select count(*) from leadflow_private.analysis_findings f where f.analysis_id = a.id),
    'opportunityCount', (select count(*) from leadflow_private.business_opportunities o where o.analysis_id = a.id))
$$;

create function public.business_analyses_for(target_workspace uuid, target_lead text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return coalesce((select jsonb_agg(leadflow_private.analysis_summary_json(a) order by a.created_at desc)
    from (select * from leadflow_private.business_analyses a where a.workspace_id = target_workspace and a.lead_id = target_lead order by a.created_at desc limit 50) a), '[]'::jsonb);
end $$;

-- One report: the analysis, its evidence, findings and opportunities, and the provider usage it caused.
create function public.business_analysis_report(target_workspace uuid, analysis_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a leadflow_private.business_analyses;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into a from leadflow_private.business_analyses x where x.id = analysis_id and x.workspace_id = target_workspace;
  if a.id is null then raise exception 'Analysis not found.' using errcode = 'P0002'; end if;
  return leadflow_private.analysis_summary_json(a) || jsonb_build_object('overview', a.overview,
    'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'ref', e.ref, 'category', e.category, 'kind', e.kind, 'sourceUrl', e.source_url, 'provider', e.provider,
        'value', e.value, 'observedAt', e.observed_at) order by length(e.ref), e.ref) from leadflow_private.analysis_evidence e where e.analysis_id = a.id), '[]'::jsonb),
    'findings', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'key', f.key, 'category', f.category, 'title', f.title, 'description', f.description, 'findingType', f.finding_type,
        'severity', f.severity, 'confidence', f.confidence, 'evidenceIds', to_jsonb(f.evidence_ids), 'source', f.source, 'opportunityType', f.opportunity_type,
        'recommendedAction', f.recommended_action, 'businessRelevance', f.business_relevance, 'verificationStatus', f.verification_status, 'observedAt', f.observed_at)
        order by case f.severity when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end, f.category, f.title) from leadflow_private.analysis_findings f where f.analysis_id = a.id), '[]'::jsonb),
    'opportunities', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'opportunityType', o.opportunity_type, 'title', o.title, 'findingIds', to_jsonb(o.finding_ids),
        'serviceId', o.service_id, 'serviceName', coalesce(s.name, o.service_name), 'why', o.why, 'benefit', o.benefit, 'priority', o.priority, 'confidence', o.confidence,
        'nextAction', o.next_action, 'status', o.status, 'notes', o.notes, 'updatedAt', o.updated_at)
        order by case o.priority when 'high' then 0 when 'medium' then 1 else 2 end, o.title)
      from leadflow_private.business_opportunities o left join leadflow_private.agency_services s on s.id = o.service_id where o.analysis_id = a.id), '[]'::jsonb),
    'usage', coalesce((select jsonb_agg(jsonb_build_object('provider', u.provider, 'quantity', u.quantity, 'unit', u.unit, 'costUsd', u.cost_usd, 'at', u.at) order by u.at)
      from leadflow_private.analysis_usage u where u.analysis_id = a.id), '[]'::jsonb),
    'previousId', (select p.id from leadflow_private.business_analyses p where p.workspace_id = target_workspace and p.lead_id = a.lead_id and p.created_at < a.created_at
      and p.status in ('completed','partial') order by p.created_at desc limit 1));
end $$;

-- Stops an analysis (its creator, an owner or an admin). A step already running finishes, but its results are discarded.
create function public.cancel_business_analysis(target_workspace uuid, analysis_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare actor_role text;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  update leadflow_private.business_analyses a set status = 'cancelled', step = null, completed_at = now(), updated_at = now(), lease_id = null, lease_until = null
    where a.id = analysis_id and a.workspace_id = target_workspace and a.step is not null
      and (actor_role <> 'member' or a.created_by = leadflow_private.valid_actor());
  if not found then raise exception 'This analysis has finished or isn''t yours to stop.' using errcode = 'P0002'; end if;
end $$;

create function public.set_opportunity_status(target_workspace uuid, opportunity_id uuid, new_status text, new_notes text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if new_status is not null and new_status not in ('suggested','accepted','dismissed','needs_verification') then raise exception 'Choose a listed status.' using errcode = '22023'; end if;
  if new_notes is not null and length(new_notes) > 2000 then raise exception 'Notes can be up to 2,000 characters.' using errcode = '22023'; end if;
  update leadflow_private.business_opportunities o set status = coalesce(new_status, o.status), notes = coalesce(new_notes, o.notes), updated_by = leadflow_private.valid_actor(), updated_at = now()
    where o.id = opportunity_id and o.workspace_id = target_workspace;
  if not found then raise exception 'Opportunity not found.' using errcode = 'P0002'; end if;
end $$;

create function public.set_finding_verification(target_workspace uuid, finding_id uuid, new_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if new_status not in ('unverified','verified','disputed') then raise exception 'Choose a listed status.' using errcode = '22023'; end if;
  update leadflow_private.analysis_findings f set verification_status = new_status where f.id = finding_id and f.workspace_id = target_workspace;
  if not found then raise exception 'Finding not found.' using errcode = 'P0002'; end if;
end $$;

-- This month's analyses and provider usage for the workspace.
create function public.analysis_usage_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return jsonb_build_object('since', date_trunc('month', now()),
    'analyses', (select count(*) from leadflow_private.business_analyses a where a.workspace_id = target_workspace and a.created_at >= date_trunc('month', now())),
    'usage', coalesce((select jsonb_agg(jsonb_build_object('provider', u.provider, 'unit', u.unit, 'quantity', u.quantity, 'costUsd', u.cost_usd)) from (
      select provider, unit, sum(quantity) as quantity, sum(cost_usd) as cost_usd from leadflow_private.analysis_usage u
      where u.workspace_id = target_workspace and u.at >= date_trunc('month', now()) group by provider, unit order by provider, unit) u), '[]'::jsonb));
end $$;

-- ---------- Pipeline functions (service role, after the Edge Function checked the caller) ----------

-- Starts an analysis, or returns the one already running for this lead. limits: { monthlyAnalyses, maxConcurrent, recentHours }.
create function public.start_business_analysis(target_workspace uuid, actor uuid, target_lead text, request_id uuid, website_override text, force boolean, limits jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare lead_row public.leads; site text; existing leadflow_private.business_analyses; recent leadflow_private.business_analyses; created leadflow_private.business_analyses;
begin
  select * into existing from leadflow_private.business_analyses a where a.workspace_id = target_workspace and a.request_id = start_business_analysis.request_id;
  if found then return jsonb_build_object('id', existing.id, 'existing', true); end if;
  select * into lead_row from public.leads l where l.workspace_id = target_workspace and l.id = target_lead;
  if lead_row.id is null then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
  site := coalesce(nullif(btrim(website_override), ''), nullif(lead_row.website, ''));
  if site is null then raise exception 'Add the business website to this lead first.' using errcode = '22023'; end if;
  if site !~* '^https?://' then site := 'https://' || site; end if;
  if length(site) > 300 or site ~ '[[:space:]]' then raise exception 'Enter a valid website address.' using errcode = '22023'; end if;
  select * into existing from leadflow_private.business_analyses a where a.workspace_id = target_workspace and a.lead_id = target_lead and a.step is not null order by a.created_at desc limit 1;
  if found then return jsonb_build_object('id', existing.id, 'existing', true); end if;
  if (select count(*) from leadflow_private.business_analyses a where a.workspace_id = target_workspace and a.step is not null) >= coalesce((limits->>'maxConcurrent')::integer, 2) then
    raise exception 'Too many analyses are running in this workspace. Wait for one to finish.' using errcode = 'P0429';
  end if;
  if (select count(*) from leadflow_private.business_analyses a where a.workspace_id = target_workspace and a.created_at >= date_trunc('month', now())) >= coalesce((limits->>'monthlyAnalyses')::integer, 30) then
    raise exception 'This workspace has used its % analyses for this month.', coalesce((limits->>'monthlyAnalyses')::integer, 30) using errcode = 'P0429';
  end if;
  if not coalesce(force, false) then
    select * into recent from leadflow_private.business_analyses a where a.workspace_id = target_workspace and a.lead_id = target_lead and a.website = site
      and a.status in ('completed','partial') and a.created_at > now() - make_interval(hours => coalesce((limits->>'recentHours')::integer, 24)) order by a.created_at desc limit 1;
    if found then raise exception 'This website was analyzed % ago. Open that report, or choose Analyze again to run a new one.', to_char(now() - recent.created_at, 'HH24"h "MI"m"') using errcode = 'P0409'; end if;
  end if;
  insert into leadflow_private.business_analyses(workspace_id, lead_id, website, request_id, created_by, step)
    values (target_workspace, target_lead, site, start_business_analysis.request_id, actor, 'validate') returning * into created;
  return jsonb_build_object('id', created.id, 'existing', false);
end $$;

-- Claims one due analysis (or the given one) for a step, with a lease. Returns what the step needs, or null.
create function public.claim_business_analysis(target uuid, lease_seconds integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a leadflow_private.business_analyses; lead_row public.leads;
begin
  select * into a from leadflow_private.business_analyses x
    where x.step is not null and x.next_run_at <= now() and (x.lease_until is null or x.lease_until < now()) and (target is null or x.id = target)
    order by x.next_run_at limit 1 for update skip locked;
  if a.id is null then return null; end if;
  update leadflow_private.business_analyses x set lease_id = gen_random_uuid(), lease_until = now() + make_interval(secs => greatest(lease_seconds, 30)),
    attempts = x.attempts + 1, started_at = coalesce(x.started_at, now()), updated_at = now() where x.id = a.id returning * into a;
  select * into lead_row from public.leads l where l.workspace_id = a.workspace_id and l.id = a.lead_id;
  return jsonb_build_object('id', a.id, 'workspaceId', a.workspace_id, 'leadId', a.lead_id, 'website', a.website, 'status', a.status, 'step', a.step, 'providers', a.providers,
    'apifyRunId', a.apify_run_id, 'apifyDatasetId', a.apify_dataset_id, 'pagesAnalyzed', a.pages_analyzed, 'attempts', a.attempts, 'leaseId', a.lease_id, 'createdAt', a.created_at,
    'lead', case when lead_row.id is null then null else jsonb_build_object('name', lead_row.name, 'company', lead_row.company, 'industry', lead_row.industry, 'city', lead_row.city,
      'region', lead_row.region, 'country', lead_row.country) end,
    'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'ref', e.ref, 'category', e.category, 'kind', e.kind, 'sourceUrl', e.source_url, 'provider', e.provider,
      'value', e.value, 'observedAt', e.observed_at) order by length(e.ref), e.ref) from leadflow_private.analysis_evidence e where e.analysis_id = a.id), '[]'::jsonb),
    'findings', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'key', f.key, 'category', f.category, 'title', f.title, 'findingType', f.finding_type, 'severity', f.severity,
      'confidence', f.confidence, 'opportunityType', f.opportunity_type, 'evidenceIds', to_jsonb(f.evidence_ids))) from leadflow_private.analysis_findings f where f.analysis_id = a.id), '[]'::jsonb),
    'services', coalesce((select jsonb_agg(leadflow_private.service_json(s)) from leadflow_private.agency_services s where s.workspace_id = a.workspace_id and s.active), '[]'::jsonb),
    'monthUsage', coalesce((select jsonb_object_agg(provider || ':' || unit, quantity) from (select provider, unit, sum(quantity) as quantity from leadflow_private.analysis_usage u
      where u.workspace_id = a.workspace_id and u.at >= date_trunc('month', now()) group by provider, unit) m), '{}'::jsonb));
end $$;

-- Saves one step's results if the lease is still held: the analysis changes, new evidence, findings and opportunities,
-- and provider usage. Usage is recorded even if the analysis was cancelled meanwhile, because the provider was used.
-- patch: { status, step (null when finished), providers (merged), apifyRunId, apifyDatasetId, pagesAnalyzed, overview, failure, delaySeconds }.
create function public.save_business_analysis_step(analysis_id uuid, lease uuid, patch jsonb, evidence jsonb, findings jsonb, opportunities jsonb, usage jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare a leadflow_private.business_analyses; item jsonb;
begin
  select * into a from leadflow_private.business_analyses x where x.id = analysis_id for update;
  if a.id is null then raise exception 'Analysis not found.' using errcode = 'P0002'; end if;
  for item in select value from jsonb_array_elements(coalesce(usage, '[]')) loop
    insert into leadflow_private.analysis_usage(workspace_id, analysis_id, provider, quantity, unit, cost_usd)
      values (a.workspace_id, a.id, item->>'provider', (item->>'quantity')::numeric, item->>'unit', (item->>'costUsd')::numeric);
  end loop;
  if a.lease_id is distinct from lease then return case when a.status = 'cancelled' then 'cancelled' else 'lease_lost' end; end if;
  insert into leadflow_private.analysis_evidence(id, analysis_id, workspace_id, ref, category, kind, source_url, provider, value, observed_at)
    select (e->>'id')::uuid, a.id, a.workspace_id, e->>'ref', e->>'category', e->>'kind', left(e->>'sourceUrl', 500), e->>'provider', e->'value', coalesce((e->>'observedAt')::timestamptz, now())
    from jsonb_array_elements(coalesce(evidence, '[]')) e;
  -- Findings may only cite evidence of this analysis.
  if exists (select 1 from jsonb_array_elements(coalesce(findings, '[]')) f, jsonb_array_elements_text(f->'evidenceIds') ev
      where not exists (select 1 from leadflow_private.analysis_evidence e where e.analysis_id = a.id and e.id = ev::uuid)) then
    raise exception 'A finding cites evidence that is not part of this analysis.' using errcode = '22023';
  end if;
  insert into leadflow_private.analysis_findings(id, analysis_id, workspace_id, lead_id, key, category, title, description, finding_type, severity, confidence, evidence_ids,
      source, opportunity_type, recommended_action, business_relevance)
    select (f->>'id')::uuid, a.id, a.workspace_id, a.lead_id, f->>'key', f->>'category', left(f->>'title', 200), left(coalesce(f->>'description', ''), 2000), f->>'findingType',
      f->>'severity', f->>'confidence', array(select jsonb_array_elements_text(f->'evidenceIds')::uuid), f->>'source', nullif(f->>'opportunityType', ''),
      left(coalesce(f->>'recommendedAction', ''), 600), left(coalesce(f->>'businessRelevance', ''), 600)
    from jsonb_array_elements(coalesce(findings, '[]')) f;
  if exists (select 1 from jsonb_array_elements(coalesce(opportunities, '[]')) o, jsonb_array_elements_text(o->'findingIds') fi
      where not exists (select 1 from leadflow_private.analysis_findings f where f.analysis_id = a.id and f.id = fi::uuid)) then
    raise exception 'An opportunity cites a finding that is not part of this analysis.' using errcode = '22023';
  end if;
  insert into leadflow_private.business_opportunities(id, analysis_id, workspace_id, lead_id, opportunity_type, title, finding_ids, service_id, service_name, why, benefit, priority, confidence, next_action)
    select (o->>'id')::uuid, a.id, a.workspace_id, a.lead_id, o->>'opportunityType', left(o->>'title', 200), array(select jsonb_array_elements_text(o->'findingIds')::uuid),
      (select s.id from leadflow_private.agency_services s where s.id = (o->>'serviceId')::uuid and s.workspace_id = a.workspace_id), left(coalesce(o->>'serviceName', ''), 80),
      left(coalesce(o->>'why', ''), 1000), left(coalesce(o->>'benefit', ''), 600), o->>'priority', o->>'confidence', left(coalesce(o->>'nextAction', ''), 400)
    from jsonb_array_elements(coalesce(opportunities, '[]')) o;
  update leadflow_private.business_analyses x set
    status = coalesce(patch->>'status', x.status),
    step = case when patch ? 'step' then patch->>'step' else x.step end,
    providers = x.providers || coalesce(patch->'providers', '{}'),
    apify_run_id = coalesce(patch->>'apifyRunId', x.apify_run_id), apify_dataset_id = coalesce(patch->>'apifyDatasetId', x.apify_dataset_id),
    pages_analyzed = coalesce((patch->>'pagesAnalyzed')::integer, x.pages_analyzed), overview = coalesce(patch->'overview', x.overview),
    failure = case when patch ? 'failure' then left(patch->>'failure', 500) else x.failure end,
    next_run_at = now() + make_interval(secs => coalesce((patch->>'delaySeconds')::numeric, 0)),
    completed_at = case when patch ? 'step' and patch->>'step' is null then now() else x.completed_at end,
    lease_id = null, lease_until = null, updated_at = now()
    where x.id = a.id;
  return 'saved';
end $$;

revoke all on function leadflow_private.is_opportunity_type(text), leadflow_private.service_json(leadflow_private.agency_services),
  leadflow_private.analysis_summary_json(leadflow_private.business_analyses) from public, anon, authenticated;
revoke all on function public.analysis_member_role(uuid), public.agency_services_for(uuid), public.save_agency_service(uuid, jsonb), public.delete_agency_service(uuid, uuid),
  public.install_starter_services(uuid), public.business_analyses_for(uuid, text), public.business_analysis_report(uuid, uuid), public.cancel_business_analysis(uuid, uuid),
  public.set_opportunity_status(uuid, uuid, text, text), public.set_finding_verification(uuid, uuid, text), public.analysis_usage_for(uuid),
  public.start_business_analysis(uuid, uuid, text, uuid, text, boolean, jsonb), public.claim_business_analysis(uuid, integer),
  public.save_business_analysis_step(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.analysis_member_role(uuid), public.agency_services_for(uuid), public.save_agency_service(uuid, jsonb), public.delete_agency_service(uuid, uuid),
  public.install_starter_services(uuid), public.business_analyses_for(uuid, text), public.business_analysis_report(uuid, uuid), public.cancel_business_analysis(uuid, uuid),
  public.set_opportunity_status(uuid, uuid, text, text), public.set_finding_verification(uuid, uuid, text), public.analysis_usage_for(uuid) to authenticated;
grant execute on function public.start_business_analysis(uuid, uuid, text, uuid, text, boolean, jsonb), public.claim_business_analysis(uuid, integer),
  public.save_business_analysis_step(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;
