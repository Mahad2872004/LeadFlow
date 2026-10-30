-- M6 lead discovery: business details on leads, import provenance, discovery history and bulk imports.
-- * Leads gain optional business fields (website, industry, address, city, region, postcode, country).
--   They round-trip through the snapshot save, so save_workspace_for is replaced to carry them; payloads
--   from older clients that omit them store empty values.
-- * Email becomes optional: most businesses found through discovery publish no address. A non-empty email
--   must still be valid.
-- * Import provenance lives in leadflow_private.lead_origins, keyed by lead ID with no foreign key, like
--   onboarding requests: snapshot saves delete and reinsert leads, and a cascade would erase it. The save
--   deletes origins whose lead is gone.
-- * Provider results are never stored. History keeps the search criteria and counts; a lead stores only
--   the fields of a business a user chose to import.
-- * import_leads appends leads without the snapshot protocol and advances the workspace revision, so a stale
--   tab's snapshot cannot silently erase imported leads.
-- Reverse with supabase/rollbacks/202610310001_lead_discovery.down.sql.

alter table public.leads
  add column website text not null default '' check (website = '' or (length(website) <= 300 and website ~* '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$')),
  add column industry text not null default '' check (length(industry) <= 100),
  add column address text not null default '' check (length(address) <= 300),
  add column city text not null default '' check (length(city) <= 100),
  add column region text not null default '' check (length(region) <= 100),
  add column postcode text not null default '' check (length(postcode) <= 20),
  add column country text not null default '' check (country = '' or country ~ '^[A-Z]{2}$');
alter table public.leads drop constraint leads_email_check,
  add constraint leads_email_check check (email = '' or (length(email) <= 150 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));
alter table public.leads drop constraint leads_service_check,
  add constraint leads_service_check check (service in ('Website design','Web development','Brand identity','Consulting','Other','Not specified'));
alter table public.leads drop constraint leads_source_check,
  add constraint leads_source_check check (source in ('Website','Referral','LinkedIn','Email','Other','Lead discovery','CSV import'));

create table leadflow_private.lead_origins (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- No foreign key: leads are replaced on every snapshot save.
  lead_id text not null check (length(lead_id) between 1 and 200),
  method text not null check (method in ('discovery','csv')),
  provider text check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  provider_ref text check (length(provider_ref) between 1 and 200),
  search_id uuid,
  source_url text check (length(source_url) <= 300 and source_url ~ '^https://'),
  source_updated_at timestamptz check (isfinite(source_updated_at)),
  discovered_at timestamptz check (isfinite(discovered_at)),
  imported_at timestamptz not null default now(),
  imported_by uuid,
  primary key (workspace_id, lead_id),
  check ((method = 'discovery') = (provider is not null and provider_ref is not null))
);
create unique index lead_origins_provider_ref on leadflow_private.lead_origins(workspace_id, provider, provider_ref) where provider_ref is not null;

create table leadflow_private.discovery_searches (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid not null,
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  criteria jsonb not null check (jsonb_typeof(criteria) = 'object' and octet_length(criteria::text) <= 4000),
  status text not null default 'running' check (status in ('running','completed','failed')),
  result_count integer check (result_count between 0 and 1000),
  truncated boolean not null default false,
  failure text check (failure ~ '^[a-z_]{1,40}$'),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index discovery_searches_recent on leadflow_private.discovery_searches(workspace_id, created_at desc);

-- Geocoder answers for a normalized location. The Nominatim usage policy requires caching.
create table leadflow_private.discovery_places (
  query_key text primary key check (length(query_key) between 1 and 300),
  place jsonb not null check (jsonb_typeof(place) = 'object' and octet_length(place::text) <= 2000),
  fetched_at timestamptz not null default now()
);

create table leadflow_private.lead_import_requests (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid not null,
  payload_hash text not null,
  result jsonb not null,
  actor_id uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, request_id)
);

alter table leadflow_private.lead_origins enable row level security;
alter table leadflow_private.discovery_searches enable row level security;
alter table leadflow_private.discovery_places enable row level security;
alter table leadflow_private.lead_import_requests enable row level security;
revoke all on leadflow_private.lead_origins, leadflow_private.discovery_searches, leadflow_private.discovery_places,
  leadflow_private.lead_import_requests from public, anon, authenticated;

-- Duplicate keys. src/lib/discovery.ts computes the same keys to warn before importing; these are authoritative.
create function leadflow_private.lead_domain(website text) returns text language sql immutable set search_path = '' as $$
  select coalesce(lower(substring(website from '^[A-Za-z]+://(?:[Ww][Ww][Ww]\.)?([^/:?#@]+)')), '')
$$;
create function leadflow_private.lead_name_key(value text) returns text language sql immutable set search_path = '' as $$
  select regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]+', '', 'g')
$$;
-- The last nine digits, so "+1 512 555 0100" and "(512) 555-0100" match.
create function leadflow_private.lead_phone_key(phone text) returns text language sql immutable set search_path = '' as $$
  select case when length(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) < 7 then ''
    else right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) end
$$;
-- The same business name in the same city or postcode.
create function leadflow_private.lead_place_keys(business text, city text, postcode text) returns text[] language sql immutable set search_path = '' as $$
  select case when leadflow_private.lead_name_key(business) = '' then '{}'::text[] else array_remove(array[
    case when leadflow_private.lead_name_key(city) <> '' then leadflow_private.lead_name_key(business) || '|c|' || leadflow_private.lead_name_key(city) end,
    case when leadflow_private.lead_name_key(postcode) <> '' then leadflow_private.lead_name_key(business) || '|p|' || leadflow_private.lead_name_key(postcode) end], null) end
$$;

-- Same as 202610200003, plus the business fields and removal of origins whose lead was removed.
create or replace function public.save_workspace_for(target_workspace uuid, payload jsonb, expected_revision bigint, request_id uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare actor_role text; current_revision bigint; receipt public.workspace_requests; fingerprint text;
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
  delete from public.leads where workspace_id = target_workspace;
  insert into public.leads(workspace_id, id, name, email, phone, company, service, source, message, status, "createdAt",
      website, industry, address, city, region, postcode, country)
    select target_workspace, x.id, x.name, x.email, x.phone, x.company, x.service, x.source, x.message, x.status, x."createdAt",
      coalesce(x.website, ''), coalesce(x.industry, ''), coalesce(x.address, ''), coalesce(x.city, ''), coalesce(x.region, ''), coalesce(x.postcode, ''), coalesce(x.country, '')
    from jsonb_to_recordset(payload->'leads') as x(id text, name text, email text, phone text, company text, service text, source text, message text, status text, "createdAt" timestamptz,
      website text, industry text, address text, city text, region text, postcode text, country text);
  insert into public.follow_up_tasks(workspace_id, id, "leadId", due, notes, completed)
    select target_workspace, x.id, x."leadId", x.due, x.notes, x.completed
    from jsonb_to_recordset(payload->'tasks') as x(id text, "leadId" text, due date, notes text, completed boolean);
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

-- One trimmed text field of an import row. Single-line fields reject control characters.
create function leadflow_private.import_text(item jsonb, field text, max_length integer, multiline boolean default false) returns text
language plpgsql immutable set search_path = '' as $$
declare value text;
begin
  if item->field is null or jsonb_typeof(item->field) = 'null' then return ''; end if;
  if jsonb_typeof(item->field) <> 'string' then raise exception 'Row %: % must be text.', item->>'key', field using errcode = '22023'; end if;
  value := btrim(item->>field);
  if length(value) > max_length then raise exception 'Row %: % must be at most % characters.', item->>'key', field, max_length using errcode = '22023'; end if;
  if (not multiline and value ~ '[[:cntrl:]]') or value ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' then
    raise exception 'Row %: % contains control characters.', item->>'key', field using errcode = '22023';
  end if;
  return value;
end $$;

-- Appends leads found through discovery or read from a CSV file. Any member may import. Existing leads are
-- never changed: a row matching one is skipped. Same email or provider record always skips; same website,
-- phone, or name in the same city/postcode skips unless the row sets allowDuplicate after the user reviewed it.
-- Retrying with the same request ID returns the first result.
create function public.import_leads(target_workspace uuid, request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid; receipt leadflow_private.lead_import_requests; fingerprint text; import_method text; import_provider text; import_search uuid;
  item jsonb; row_key text; business text; contact text; email text; phone text; website text; country text; city text; postcode text;
  provider_ref text; source_url text; source_updated timestamptz; discovered timestamptz; allow_duplicate boolean;
  lead_service text; lead_source text; new_id text; match_id text; reason text; place_key text; keys text[];
  by_ref jsonb; by_email jsonb; by_domain jsonb; by_phone jsonb; by_place jsonb;
  imported jsonb := '[]'; skipped jsonb := '[]'; current_revision bigint; result jsonb; lead_count integer; activity_count integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  actor := leadflow_private.valid_actor();
  if request_id is null or payload is null or jsonb_typeof(payload) <> 'object' or jsonb_typeof(payload->'rows') is distinct from 'array'
    or jsonb_array_length(payload->'rows') not between 1 and 250 or octet_length(payload::text) > 1000000 then
    raise exception 'Send between 1 and 250 rows to import.' using errcode = '22023';
  end if;
  fingerprint := md5(payload::text);
  select * into receipt from leadflow_private.lead_import_requests r where r.workspace_id = target_workspace and r.request_id = import_leads.request_id;
  if found then
    if receipt.payload_hash <> fingerprint then raise exception 'This import reference was already used for different rows. Start the import again.' using errcode = '23505'; end if;
    return receipt.result;
  end if;
  import_method := payload->>'method';
  if import_method is null or import_method not in ('discovery','csv') then raise exception 'Unknown import method.' using errcode = '22023'; end if;
  if import_method = 'discovery' then
    import_provider := payload->>'provider';
    if import_provider is null or import_provider !~ '^[a-z][a-z0-9_]{1,39}$' then raise exception 'Unknown discovery provider.' using errcode = '22023'; end if;
    if payload->>'searchId' is not null then
      if payload->>'searchId' !~ '^[0-9a-fA-F-]{36}$' then raise exception 'Unknown discovery search.' using errcode = '22023'; end if;
      import_search := (payload->>'searchId')::uuid;
      if not exists (select 1 from leadflow_private.discovery_searches s where s.id = import_search and s.workspace_id = target_workspace and s.provider = import_provider) then
        raise exception 'Unknown discovery search.' using errcode = '22023';
      end if;
    end if;
  end if;
  select count(*) into lead_count from public.leads where workspace_id = target_workspace;
  select count(*) into activity_count from public.activity_history where workspace_id = target_workspace;
  if lead_count + jsonb_array_length(payload->'rows') > 5000 or activity_count + jsonb_array_length(payload->'rows') > 20000 then
    raise exception 'This import would exceed the workspace limit of 5,000 leads and 20,000 history events.' using errcode = '22023';
  end if;

  -- Keys of current leads, built once. A matching key maps to that lead's ID.
  select coalesce(jsonb_object_agg(k, id), '{}') into by_ref from (select o.provider || ':' || o.provider_ref as k, min(o.lead_id) as id from leadflow_private.lead_origins o
    join public.leads l on l.workspace_id = o.workspace_id and l.id = o.lead_id where o.workspace_id = target_workspace and o.provider_ref is not null group by 1) s;
  select coalesce(jsonb_object_agg(k, id), '{}') into by_email from (select lower(l.email) as k, min(l.id) as id from public.leads l where l.workspace_id = target_workspace and l.email <> '' group by 1) s;
  select coalesce(jsonb_object_agg(k, id), '{}') into by_domain from (select leadflow_private.lead_domain(l.website) as k, min(l.id) as id from public.leads l where l.workspace_id = target_workspace and leadflow_private.lead_domain(l.website) <> '' group by 1) s;
  select coalesce(jsonb_object_agg(k, id), '{}') into by_phone from (select leadflow_private.lead_phone_key(l.phone) as k, min(l.id) as id from public.leads l where l.workspace_id = target_workspace and leadflow_private.lead_phone_key(l.phone) <> '' group by 1) s;
  select coalesce(jsonb_object_agg(k, id), '{}') into by_place from (select k, min(l.id) as id from public.leads l, unnest(leadflow_private.lead_place_keys(coalesce(nullif(l.company, ''), l.name), l.city, l.postcode)) as k where l.workspace_id = target_workspace group by 1) s;

  for item in select value from jsonb_array_elements(payload->'rows') loop
    if jsonb_typeof(item) <> 'object' or jsonb_typeof(item->'key') is distinct from 'string' or length(item->>'key') not between 1 and 100 then
      raise exception 'Every row needs a reference of up to 100 characters.' using errcode = '22023';
    end if;
    row_key := item->>'key';
    business := leadflow_private.import_text(item, 'businessName', 150);
    contact := leadflow_private.import_text(item, 'contactName', 150);
    if business = '' and contact = '' then raise exception 'Row %: add a business or contact name.', row_key using errcode = '22023'; end if;
    email := lower(leadflow_private.import_text(item, 'email', 150));
    if email <> '' and email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Row %: the email address is not valid.', row_key using errcode = '22023'; end if;
    phone := leadflow_private.import_text(item, 'phone', 25);
    if phone <> '' and (phone !~ '^[+0-9 ().-]{7,25}$' or length(regexp_replace(phone, '[^0-9]', '', 'g')) < 7) then raise exception 'Row %: the phone number is not valid.', row_key using errcode = '22023'; end if;
    website := leadflow_private.import_text(item, 'website', 300);
    if website <> '' and website !~* '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$' then raise exception 'Row %: the website must start with http:// or https://.', row_key using errcode = '22023'; end if;
    country := upper(leadflow_private.import_text(item, 'country', 2));
    if country <> '' and country !~ '^[A-Z]{2}$' then raise exception 'Row %: use a two-letter country code.', row_key using errcode = '22023'; end if;
    city := leadflow_private.import_text(item, 'city', 100);
    postcode := leadflow_private.import_text(item, 'postcode', 20);
    allow_duplicate := coalesce((item->>'allowDuplicate')::boolean, false);
    lead_service := coalesce(nullif(leadflow_private.import_text(item, 'service', 40), ''), 'Not specified');
    if lead_service not in ('Website design','Web development','Brand identity','Consulting','Other','Not specified') then raise exception 'Row %: choose a listed service.', row_key using errcode = '22023'; end if;
    lead_source := coalesce(nullif(leadflow_private.import_text(item, 'source', 40), ''), case import_method when 'discovery' then 'Lead discovery' else 'CSV import' end);
    if lead_source not in ('Website','Referral','LinkedIn','Email','Other','Lead discovery','CSV import') then raise exception 'Row %: choose a listed source.', row_key using errcode = '22023'; end if;
    provider_ref := null; source_url := null; source_updated := null; discovered := null;
    if import_method = 'discovery' then
      provider_ref := leadflow_private.import_text(item, 'providerRef', 200);
      if provider_ref = '' then raise exception 'Row %: the provider record is missing.', row_key using errcode = '22023'; end if;
      source_url := nullif(leadflow_private.import_text(item, 'sourceUrl', 300), '');
      if source_url is not null and source_url !~ '^https://' then raise exception 'Row %: the source link must use https.', row_key using errcode = '22023'; end if;
      begin
        source_updated := nullif(item->>'sourceUpdatedAt', '')::timestamptz;
        discovered := coalesce(nullif(item->>'discoveredAt', '')::timestamptz, now());
      exception when others then raise exception 'Row %: invalid date.', row_key using errcode = '22023';
      end;
    end if;

    reason := null; match_id := null;
    if provider_ref is not null and by_ref ? (import_provider || ':' || provider_ref) then reason := 'same_record'; match_id := by_ref->>(import_provider || ':' || provider_ref);
    elsif email <> '' and by_email ? email then reason := 'same_email'; match_id := by_email->>email;
    elsif not allow_duplicate then
      if leadflow_private.lead_domain(website) <> '' and by_domain ? leadflow_private.lead_domain(website) then reason := 'same_website'; match_id := by_domain->>leadflow_private.lead_domain(website);
      elsif leadflow_private.lead_phone_key(phone) <> '' and by_phone ? leadflow_private.lead_phone_key(phone) then reason := 'same_phone'; match_id := by_phone->>leadflow_private.lead_phone_key(phone);
      else
        foreach place_key in array leadflow_private.lead_place_keys(coalesce(nullif(business, ''), contact), city, postcode) loop
          if by_place ? place_key then reason := 'same_name_and_location'; match_id := by_place->>place_key; exit; end if;
        end loop;
      end if;
    end if;
    if reason is not null then
      skipped := skipped || jsonb_build_object('key', row_key, 'reason', reason, 'leadId', match_id, 'blocking', reason in ('same_record','same_email'));
      continue;
    end if;

    new_id := gen_random_uuid()::text;
    insert into public.leads(workspace_id, id, name, email, phone, company, service, source, message, status, "createdAt",
        website, industry, address, city, region, postcode, country)
      values (target_workspace, new_id, coalesce(nullif(contact, ''), business), email, phone, business, lead_service, lead_source,
        leadflow_private.import_text(item, 'notes', 2000, true), 'New', now(),
        website, leadflow_private.import_text(item, 'industry', 100), leadflow_private.import_text(item, 'address', 300), city,
        leadflow_private.import_text(item, 'region', 100), postcode, country);
    insert into public.activity_history(workspace_id, id, "leadId", text, at)
      values (target_workspace, gen_random_uuid()::text, new_id, case import_method when 'discovery' then 'Lead imported from lead discovery' else 'Lead imported from a CSV file' end, now());
    insert into leadflow_private.lead_origins(workspace_id, lead_id, method, provider, provider_ref, search_id, source_url, source_updated_at, discovered_at, imported_by)
      values (target_workspace, new_id, import_method, case when import_method = 'discovery' then import_provider end, provider_ref, import_search, source_url, source_updated, discovered, actor);
    imported := imported || jsonb_build_object('key', row_key, 'leadId', new_id);
    -- Later rows in this import are checked against the new lead too.
    if provider_ref is not null then by_ref := by_ref || jsonb_build_object(import_provider || ':' || provider_ref, new_id); end if;
    if email <> '' then by_email := by_email || jsonb_build_object(email, new_id); end if;
    if leadflow_private.lead_domain(website) <> '' then by_domain := by_domain || jsonb_build_object(leadflow_private.lead_domain(website), new_id); end if;
    if leadflow_private.lead_phone_key(phone) <> '' then by_phone := by_phone || jsonb_build_object(leadflow_private.lead_phone_key(phone), new_id); end if;
    keys := leadflow_private.lead_place_keys(coalesce(nullif(business, ''), contact), city, postcode);
    foreach place_key in array keys loop by_place := by_place || jsonb_build_object(place_key, new_id); end loop;
  end loop;

  if jsonb_array_length(imported) > 0 then
    update public.workspaces set revision = revision + 1 where id = target_workspace returning revision into current_revision;
  else
    select revision into current_revision from public.workspaces where id = target_workspace;
  end if;
  result := jsonb_build_object('revision', current_revision, 'imported', imported, 'skipped', skipped);
  insert into leadflow_private.lead_import_requests(workspace_id, request_id, payload_hash, result, actor_id)
    values (target_workspace, request_id, fingerprint, result, actor);
  return result;
end $$;

-- Provenance of imported leads that still exist. Any member may read it.
create function public.lead_origins_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return coalesce((select jsonb_agg(jsonb_build_object('leadId', o.lead_id, 'method', o.method, 'provider', o.provider, 'providerRef', o.provider_ref,
      'searchId', o.search_id, 'sourceUrl', o.source_url, 'sourceUpdatedAt', o.source_updated_at, 'discoveredAt', o.discovered_at, 'importedAt', o.imported_at)
    order by o.imported_at desc, o.lead_id)
    from leadflow_private.lead_origins o join public.leads l on l.workspace_id = o.workspace_id and l.id = o.lead_id
    where o.workspace_id = target_workspace), '[]'::jsonb);
end $$;

-- Called by the discover-leads Edge Function with the signed-in user's own token, so membership is checked
-- here exactly as for every other workspace call. Quotas protect the configured provider.
create function public.start_discovery_search(target_workspace uuid, search_id uuid, provider text, criteria jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  actor := leadflow_private.valid_actor();
  if search_id is null or provider is null or provider !~ '^[a-z][a-z0-9_]{1,39}$' or criteria is null or jsonb_typeof(criteria) <> 'object' or octet_length(criteria::text) > 4000 then
    raise exception 'Invalid search.' using errcode = '22023';
  end if;
  if exists (select 1 from leadflow_private.discovery_searches s where s.id = search_id) then
    raise exception 'This search was already started. Start a new search.' using errcode = '23505';
  end if;
  if (select count(*) from leadflow_private.discovery_searches s where s.actor_id = actor and s.created_at > now() - interval '1 minute') >= 6
    or (select count(*) from leadflow_private.discovery_searches s where s.workspace_id = target_workspace and s.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Search limit reached. Wait a few minutes before searching again.' using errcode = 'P0429';
  end if;
  insert into leadflow_private.discovery_searches(id, workspace_id, actor_id, provider, criteria) values (search_id, target_workspace, actor, provider, criteria);
  return search_id;
end $$;

-- Service role only: the Edge Function records the outcome. A finished search is never reopened.
create function public.finish_discovery_search(search_id uuid, outcome text, result_count integer, truncated boolean, failure text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if outcome not in ('completed','failed') then raise exception 'Invalid outcome.' using errcode = '22023'; end if;
  update leadflow_private.discovery_searches s set status = outcome, result_count = finish_discovery_search.result_count,
      truncated = coalesce(finish_discovery_search.truncated, false), failure = finish_discovery_search.failure, finished_at = now()
    where s.id = search_id and s.status = 'running';
end $$;

-- The 25 most recent searches in a workspace. Runs unfinished after two minutes are reported as interrupted.
create function public.discovery_history_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  actor := leadflow_private.valid_actor();
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'provider', s.provider, 'criteria', s.criteria,
      'status', case when s.status = 'running' and s.created_at < now() - interval '2 minutes' then 'interrupted' else s.status end,
      'resultCount', s.result_count, 'truncated', s.truncated, 'failure', s.failure, 'createdAt', s.created_at, 'finishedAt', s.finished_at, 'mine', s.actor_id = actor)
    order by s.created_at desc, s.id)
    from (select * from leadflow_private.discovery_searches s where s.workspace_id = target_workspace order by s.created_at desc, s.id limit 25) s), '[]'::jsonb);
end $$;

-- Service role only: the geocoder cache. Answers are reused for 30 days.
create function public.discovery_place(query_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select place from leadflow_private.discovery_places p where p.query_key = discovery_place.query_key and p.fetched_at > now() - interval '30 days'
$$;
create function public.remember_discovery_place(query_key text, place jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from leadflow_private.discovery_places p where p.fetched_at < now() - interval '30 days';
  insert into leadflow_private.discovery_places(query_key, place) values (remember_discovery_place.query_key, remember_discovery_place.place)
    on conflict on constraint discovery_places_pkey do update set place = excluded.place, fetched_at = now();
end $$;

revoke all on function leadflow_private.lead_domain(text), leadflow_private.lead_name_key(text), leadflow_private.lead_phone_key(text),
  leadflow_private.lead_place_keys(text, text, text), leadflow_private.import_text(jsonb, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.import_leads(uuid, uuid, jsonb), public.lead_origins_for(uuid), public.start_discovery_search(uuid, uuid, text, jsonb),
  public.finish_discovery_search(uuid, text, integer, boolean, text), public.discovery_history_for(uuid), public.discovery_place(text),
  public.remember_discovery_place(text, jsonb) from public, anon, authenticated;
grant execute on function public.import_leads(uuid, uuid, jsonb), public.lead_origins_for(uuid), public.start_discovery_search(uuid, uuid, text, jsonb),
  public.discovery_history_for(uuid) to authenticated;
grant execute on function public.finish_discovery_search(uuid, text, integer, boolean, text), public.discovery_place(text),
  public.remember_discovery_place(text, jsonb) to service_role;
