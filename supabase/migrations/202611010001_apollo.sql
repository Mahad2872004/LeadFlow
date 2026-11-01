-- Apollo.io lead generation: account settings, a credit ledger, revealed contacts, saved searches and lead lists.
-- * API keys are never stored here. They are Edge Function secrets (APOLLO_API_KEYS); this table holds only the
--   settings and usage figures for each configured account, keyed by the label given in that secret.
-- * The ledger is the record of every credit-consuming call made through LeadFlow. Reservations lock the account
--   row, so concurrent reveals cannot overspend, and each operation ID is used once, so a retry never charges twice.
-- * Revealed contact details are workspace-private and readable only through role-checked functions.
-- * Lists reference leads by ID with no foreign key, like lead origins: snapshot saves delete and reinsert leads.
-- Reverse with supabase/rollbacks/202611010001_apollo.down.sql.

-- Apollo search criteria (up to 100 domains, titles and so on) need more room than the 4 KB set for map searches.
alter table leadflow_private.discovery_searches drop constraint discovery_searches_criteria_check,
  add constraint discovery_searches_criteria_check check (jsonb_typeof(criteria) = 'object' and octet_length(criteria::text) <= 16000);
alter table leadflow_private.lead_origins add column account_ref text check (account_ref ~ '^[a-z0-9][a-z0-9_-]{0,39}$');

create table leadflow_private.apollo_accounts (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  nickname text not null default '' check (length(nickname) <= 60),
  active boolean not null default true,
  monthly_allowance integer not null default 70 check (monthly_allowance between 0 and 1000000),
  -- Day of the month the local cycle restarts when Apollo hasn't reported its billing cycle.
  reset_day integer not null default least(extract(day from now())::integer, 28) check (reset_day between 1 and 28),
  notes text not null default '' check (length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_connected_at timestamptz,
  last_connection_error text check (length(last_connection_error) <= 300),
  last_synced_at timestamptz,
  -- Apollo's credit_usage_stats, as last reported: { lead_credit: { limit, consumed, left_over }, direct_dial_credit: … }.
  synced_stats jsonb check (jsonb_typeof(synced_stats) = 'object' and octet_length(synced_stats::text) <= 8000),
  cycle_start timestamptz,
  cycle_end timestamptz
);

create table leadflow_private.apollo_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id text not null references leadflow_private.apollo_accounts(id) on delete restrict,
  workspace_id uuid references public.workspaces(id) on delete set null,
  operation_id uuid not null,
  operation text not null check (operation in ('email_reveal','phone_reveal','organization_search')),
  -- [{ id, name }] of the people (at most 10) or the search page this entry covers.
  subjects jsonb not null default '[]' check (jsonb_typeof(subjects) = 'array' and octet_length(subjects::text) <= 4000),
  estimated_credits numeric(10,2) not null check (estimated_credits >= 0),
  credits numeric(10,2) check (credits >= 0),
  -- reported: Apollo returned credits_consumed. documented: Apollo's fixed published rate. estimated: neither yet.
  credit_basis text not null default 'estimated' check (credit_basis in ('reported','documented','estimated')),
  status text not null default 'pending' check (status in ('pending','succeeded','no_match','failed','unknown')),
  reference text check (length(reference) <= 100),
  error text check (length(error) <= 300),
  webhook_token_hash text unique check (webhook_token_hash ~ '^[0-9a-f]{64}$'),
  actor_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (account_id, operation_id, operation)
);
create index apollo_ledger_recent on leadflow_private.apollo_ledger(account_id, created_at desc);

create table leadflow_private.apollo_contacts (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  person_id text not null check (person_id ~ '^[A-Za-z0-9]{1,40}$'),
  account_id text references leadflow_private.apollo_accounts(id) on delete set null,
  name text not null default '' check (length(name) <= 150),
  title text not null default '' check (length(title) <= 200),
  email text not null default '' check (email = '' or (length(email) <= 150 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  email_status text not null default '' check (length(email_status) <= 40),
  phones jsonb not null default '[]' check (jsonb_typeof(phones) = 'array' and octet_length(phones::text) <= 4000),
  linkedin_url text not null default '' check (length(linkedin_url) <= 300),
  organization_name text not null default '' check (length(organization_name) <= 150),
  organization_domain text not null default '' check (length(organization_domain) <= 150),
  city text not null default '' check (length(city) <= 100),
  state text not null default '' check (length(state) <= 100),
  country text not null default '' check (length(country) <= 100),
  email_revealed_at timestamptz,
  phone_requested_at timestamptz,
  phone_revealed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, person_id)
);

create table leadflow_private.discovery_saved_searches (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  criteria jsonb not null check (jsonb_typeof(criteria) = 'object' and octet_length(criteria::text) <= 16000),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index discovery_saved_searches_workspace on leadflow_private.discovery_saved_searches(workspace_id, updated_at desc);

create table leadflow_private.lead_lists (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index lead_lists_name on leadflow_private.lead_lists(workspace_id, lower(btrim(name)));
create table leadflow_private.lead_list_members (
  list_id uuid not null references leadflow_private.lead_lists(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null check (length(lead_id) between 1 and 200),
  added_at timestamptz not null default now(),
  primary key (list_id, lead_id)
);

alter table leadflow_private.apollo_accounts enable row level security;
alter table leadflow_private.apollo_ledger enable row level security;
alter table leadflow_private.apollo_contacts enable row level security;
alter table leadflow_private.discovery_saved_searches enable row level security;
alter table leadflow_private.lead_lists enable row level security;
alter table leadflow_private.lead_list_members enable row level security;
revoke all on leadflow_private.apollo_accounts, leadflow_private.apollo_ledger, leadflow_private.apollo_contacts,
  leadflow_private.discovery_saved_searches, leadflow_private.lead_lists, leadflow_private.lead_list_members from public, anon, authenticated;

-- Same as 202610310001 with the larger criteria limit.
create or replace function public.start_discovery_search(target_workspace uuid, search_id uuid, provider text, criteria jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  actor := leadflow_private.valid_actor();
  if search_id is null or provider is null or provider !~ '^[a-z][a-z0-9_]{1,39}$' or criteria is null or jsonb_typeof(criteria) <> 'object' or octet_length(criteria::text) > 16000 then
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

-- Same as 202610310001, plus the Apollo account used and when contact details were revealed.
create or replace function public.lead_origins_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return coalesce((select jsonb_agg(jsonb_build_object('leadId', o.lead_id, 'method', o.method, 'provider', o.provider, 'providerRef', o.provider_ref,
      'searchId', o.search_id, 'sourceUrl', o.source_url, 'sourceUpdatedAt', o.source_updated_at, 'discoveredAt', o.discovered_at, 'importedAt', o.imported_at,
      'accountRef', o.account_ref, 'emailRevealedAt', c.email_revealed_at, 'phoneRevealedAt', c.phone_revealed_at)
    order by o.imported_at desc, o.lead_id)
    from leadflow_private.lead_origins o join public.leads l on l.workspace_id = o.workspace_id and l.id = o.lead_id
    left join leadflow_private.apollo_contacts c on o.provider = 'apollo_people' and c.workspace_id = o.workspace_id and c.person_id = substring(o.provider_ref from 8)
    where o.workspace_id = target_workspace), '[]'::jsonb);
end $$;

-- The apollo Edge Function calls this with the user's token before every action: membership, then the role.
create function public.apollo_member_role(target_workspace uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  return leadflow_private.require_role(target_workspace, array['owner','admin','member']);
end $$;

-- Revealed details for the given Apollo people in this workspace.
create function public.apollo_contacts_for(target_workspace uuid, person_ids jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if jsonb_typeof(person_ids) is distinct from 'array' or jsonb_array_length(person_ids) > 200 then raise exception 'Ask for up to 200 people.' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.person_id, 'name', c.name, 'title', c.title, 'email', c.email, 'emailStatus', c.email_status, 'phones', c.phones,
      'linkedinUrl', c.linkedin_url, 'organizationName', c.organization_name, 'organizationDomain', c.organization_domain, 'city', c.city, 'state', c.state, 'country', c.country,
      'accountId', c.account_id, 'emailRevealedAt', c.email_revealed_at, 'phoneRequestedAt', c.phone_requested_at, 'phoneRevealedAt', c.phone_revealed_at))
    from leadflow_private.apollo_contacts c where c.workspace_id = target_workspace and c.person_id in (select jsonb_array_elements_text(person_ids))), '[]'::jsonb);
end $$;

-- Saved searches: any member saves and reuses; the creator, an owner or an admin deletes.
create function public.discovery_saved_searches_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  actor := leadflow_private.valid_actor();
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'provider', s.provider, 'criteria', s.criteria, 'mine', s.created_by = actor,
      'createdAt', s.created_at, 'updatedAt', s.updated_at) order by s.updated_at desc, s.id)
    from leadflow_private.discovery_saved_searches s where s.workspace_id = target_workspace), '[]'::jsonb);
end $$;
create function public.save_discovery_search(target_workspace uuid, search_id uuid, search_name text, provider text, criteria jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  actor := leadflow_private.valid_actor();
  if search_id is null or search_name is null or length(btrim(search_name)) not between 1 and 80 or search_name ~ '[[:cntrl:]]' then raise exception 'Name the search in 1–80 characters.' using errcode = '22023'; end if;
  if provider is null or provider !~ '^[a-z][a-z0-9_]{1,39}$' or criteria is null or jsonb_typeof(criteria) <> 'object' or octet_length(criteria::text) > 16000 then raise exception 'Invalid search.' using errcode = '22023'; end if;
  if (select count(*) from leadflow_private.discovery_saved_searches s where s.workspace_id = target_workspace) >= 200
    and not exists (select 1 from leadflow_private.discovery_saved_searches s where s.id = search_id) then raise exception 'A workspace can keep up to 200 saved searches.' using errcode = '22023'; end if;
  insert into leadflow_private.discovery_saved_searches(id, workspace_id, name, provider, criteria, created_by) values (search_id, target_workspace, btrim(search_name), provider, criteria, actor)
    on conflict (id) do update set name = excluded.name, criteria = excluded.criteria, provider = excluded.provider, updated_at = now()
    where leadflow_private.discovery_saved_searches.workspace_id = target_workspace;
  if not found then raise exception 'Saved search not found.' using errcode = 'P0002'; end if;
  return search_id;
end $$;
create function public.delete_discovery_search(target_workspace uuid, search_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare actor_role text;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  delete from leadflow_private.discovery_saved_searches s where s.id = search_id and s.workspace_id = target_workspace
    and (actor_role <> 'member' or s.created_by = leadflow_private.valid_actor());
  if not found then raise exception 'Saved search not found, or it belongs to a teammate.' using errcode = 'P0002'; end if;
end $$;

-- Lead lists. Members create lists and add leads; owners and admins delete lists. Removed leads drop out of lists.
create function public.lead_lists_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'createdAt', l.created_at,
      'leadIds', coalesce((select jsonb_agg(m.lead_id order by m.added_at, m.lead_id) from leadflow_private.lead_list_members m
        join public.leads x on x.workspace_id = m.workspace_id and x.id = m.lead_id where m.list_id = l.id), '[]'::jsonb)) order by lower(l.name), l.id)
    from leadflow_private.lead_lists l where l.workspace_id = target_workspace), '[]'::jsonb);
end $$;
create function public.create_lead_list(target_workspace uuid, list_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare list_id uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if list_name is null or length(btrim(list_name)) not between 1 and 80 or list_name ~ '[[:cntrl:]]' then raise exception 'Name the list in 1–80 characters.' using errcode = '22023'; end if;
  select l.id into list_id from leadflow_private.lead_lists l where l.workspace_id = target_workspace and lower(btrim(l.name)) = lower(btrim(list_name));
  if list_id is not null then return list_id; end if;
  if (select count(*) from leadflow_private.lead_lists l where l.workspace_id = target_workspace) >= 100 then raise exception 'A workspace can have up to 100 lists.' using errcode = '22023'; end if;
  insert into leadflow_private.lead_lists(workspace_id, name, created_by) values (target_workspace, btrim(list_name), leadflow_private.valid_actor()) returning id into list_id;
  return list_id;
end $$;
create function public.add_leads_to_list(target_workspace uuid, list_id uuid, lead_ids jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare added integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.lead_lists l where l.id = list_id and l.workspace_id = target_workspace) then raise exception 'List not found.' using errcode = 'P0002'; end if;
  if jsonb_typeof(lead_ids) is distinct from 'array' or jsonb_array_length(lead_ids) > 1000 then raise exception 'Add up to 1,000 leads at a time.' using errcode = '22023'; end if;
  insert into leadflow_private.lead_list_members(list_id, workspace_id, lead_id)
    select list_id, target_workspace, x.id from (select distinct jsonb_array_elements_text(lead_ids) as id) x
    where exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = x.id)
    on conflict do nothing;
  get diagnostics added = row_count;
  return added;
end $$;
create function public.delete_lead_list(target_workspace uuid, list_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  delete from leadflow_private.lead_lists l where l.id = list_id and l.workspace_id = target_workspace;
  if not found then raise exception 'List not found.' using errcode = 'P0002'; end if;
end $$;

-- Credit accounting (service role, called by the apollo Edge Function after it has checked the caller).
-- The current cycle: Apollo's billing cycle when synced and current, otherwise the latest reset day.
create function leadflow_private.apollo_cycle_start(account leadflow_private.apollo_accounts) returns timestamptz
language sql stable set search_path = '' as $$
  select case when account.cycle_start is not null and account.cycle_start <= now() and coalesce(account.cycle_end, 'infinity') > now() then account.cycle_start
    else (case when extract(day from now()) >= account.reset_day then date_trunc('month', now()) else date_trunc('month', now()) - interval '1 month' end)
      + make_interval(days => account.reset_day - 1) end
$$;
-- Credits charged in the current cycle. Pending and unknown outcomes count at their estimate until settled.
create function leadflow_private.apollo_used(account leadflow_private.apollo_accounts, kind text default null) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(case when e.status in ('failed','no_match') then coalesce(e.credits, 0) else coalesce(e.credits, e.estimated_credits) end), 0)
  from leadflow_private.apollo_ledger e where e.account_id = account.id and e.created_at >= leadflow_private.apollo_cycle_start(account) and (kind is null or e.operation = kind)
$$;
create function leadflow_private.apollo_account_json(account leadflow_private.apollo_accounts) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', account.id, 'nickname', account.nickname, 'active', account.active, 'monthlyAllowance', account.monthly_allowance,
    'resetDay', account.reset_day, 'notes', account.notes, 'createdAt', account.created_at, 'lastConnectedAt', account.last_connected_at,
    'lastConnectionError', account.last_connection_error, 'lastSyncedAt', account.last_synced_at, 'synced', account.synced_stats,
    'cycleStart', leadflow_private.apollo_cycle_start(account),
    'cycleEnd', case when account.cycle_end is not null and account.cycle_end > now() and account.cycle_start <= now() then account.cycle_end
      else leadflow_private.apollo_cycle_start(account) + interval '1 month' end,
    'cycleSource', case when account.cycle_start is not null and account.cycle_start <= now() and coalesce(account.cycle_end, 'infinity') > now() then 'apollo' else 'reset_day' end,
    'used', leadflow_private.apollo_used(account), 'usedEmail', leadflow_private.apollo_used(account, 'email_reveal'),
    'usedPhone', leadflow_private.apollo_used(account, 'phone_reveal'), 'usedSearch', leadflow_private.apollo_used(account, 'organization_search'),
    'pending', (select count(*) from leadflow_private.apollo_ledger e where e.account_id = account.id and e.status = 'pending'))
$$;

-- Ensures a settings row exists for every configured account and returns them all. Rows for accounts whose key was
-- removed stay, so their history remains, and are reported with configured=false.
create function public.apollo_accounts_status(configured text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  insert into leadflow_private.apollo_accounts(id, nickname) select x, x from unnest(coalesce(configured, '{}')) x
    where x ~ '^[a-z0-9][a-z0-9_-]{0,39}$' on conflict do nothing;
  return coalesce((select jsonb_agg(leadflow_private.apollo_account_json(a) || jsonb_build_object('configured', a.id = any(coalesce(configured, '{}'))) order by a.created_at, a.id)
    from leadflow_private.apollo_accounts a), '[]'::jsonb);
end $$;

create function public.apollo_update_account(account_id text, changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare account leadflow_private.apollo_accounts;
begin
  if jsonb_typeof(changes) is distinct from 'object' then raise exception 'Invalid changes.' using errcode = '22023'; end if;
  begin
    update leadflow_private.apollo_accounts a set
      nickname = coalesce(btrim(changes->>'nickname'), a.nickname),
      active = coalesce((changes->>'active')::boolean, a.active),
      monthly_allowance = coalesce((changes->>'monthlyAllowance')::integer, a.monthly_allowance),
      reset_day = coalesce((changes->>'resetDay')::integer, a.reset_day),
      notes = coalesce(changes->>'notes', a.notes),
      updated_at = now()
    where a.id = account_id returning * into account;
  exception when invalid_text_representation or numeric_value_out_of_range or check_violation then
    raise exception 'Check the values: nickname up to 60 characters, allowance 0–1,000,000, reset day 1–28, notes up to 1,000 characters.' using errcode = '22023';
  end;
  if account.id is null then raise exception 'Account not found.' using errcode = 'P0002'; end if;
  return leadflow_private.apollo_account_json(account);
end $$;

create function public.apollo_record_connection(account_id text, ok boolean, failure text) returns void
language sql security definer set search_path = '' as $$
  update leadflow_private.apollo_accounts a set last_connected_at = case when ok then now() else a.last_connected_at end,
    last_connection_error = case when ok then null else left(failure, 300) end where a.id = account_id
$$;

-- Apollo's credit_usage_stats: balances per credit type and the billing cycle.
create function public.apollo_record_sync(account_id text, stats jsonb, cycle_start timestamptz, cycle_end timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare account leadflow_private.apollo_accounts;
begin
  update leadflow_private.apollo_accounts a set synced_stats = stats, cycle_start = apollo_record_sync.cycle_start, cycle_end = apollo_record_sync.cycle_end,
    last_synced_at = now(), last_connected_at = now(), last_connection_error = null where a.id = account_id returning * into account;
  if account.id is null then raise exception 'Account not found.' using errcode = 'P0002'; end if;
  return leadflow_private.apollo_account_json(account);
end $$;

-- Reserves the estimated credits for one operation, or returns the existing entry when the operation ID was used.
-- The account row is locked, so concurrent reservations see each other.
create function public.apollo_reserve(account_id text, target_workspace uuid, operation_id uuid, operation text, estimate numeric, subjects jsonb,
  actor uuid, webhook_token_hash text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare account leadflow_private.apollo_accounts; entry leadflow_private.apollo_ledger; remaining numeric;
begin
  select * into account from leadflow_private.apollo_accounts a where a.id = account_id for update;
  if account.id is null then raise exception 'This Apollo account is not configured.' using errcode = 'P0002'; end if;
  select * into entry from leadflow_private.apollo_ledger e where e.account_id = apollo_reserve.account_id and e.operation_id = apollo_reserve.operation_id and e.operation = apollo_reserve.operation;
  if found then return to_jsonb(entry) - 'webhook_token_hash' || jsonb_build_object('existing', true); end if;
  if not account.active then raise exception 'This Apollo account is switched off. Switch it on in Credits & accounts, or choose another account.' using errcode = '55000'; end if;
  remaining := greatest(account.monthly_allowance - leadflow_private.apollo_used(account), 0);
  if estimate > remaining then
    raise exception 'Not enough credits left on this account this cycle: % needed at most, % left of %.', trim_scale(estimate), trim_scale(remaining), account.monthly_allowance using errcode = 'P0402';
  end if;
  insert into leadflow_private.apollo_ledger(account_id, workspace_id, operation_id, operation, subjects, estimated_credits, actor_id, webhook_token_hash)
    values (account_id, target_workspace, operation_id, operation, coalesce(subjects, '[]'), estimate, actor, webhook_token_hash) returning * into entry;
  return to_jsonb(entry) - 'webhook_token_hash' || jsonb_build_object('existing', false);
end $$;

-- Settles a pending entry once. A settled entry is never changed again.
create function public.apollo_settle(ledger_id uuid, outcome text, credits numeric, basis text, reference text, failure text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if outcome not in ('succeeded','no_match','failed','unknown','pending') or basis not in ('reported','documented','estimated') then raise exception 'Invalid outcome.' using errcode = '22023'; end if;
  update leadflow_private.apollo_ledger e set status = outcome, credits = apollo_settle.credits, credit_basis = basis,
      reference = coalesce(left(apollo_settle.reference, 100), e.reference), error = left(failure, 300),
      completed_at = case when outcome = 'pending' then null else now() end
    where e.id = ledger_id and e.status = 'pending';
end $$;

-- Applies revealed details to the workspace's saved leads that came from the same Apollo person: fills an empty
-- email or phone and replaces a masked name. Other values are never overwritten. Returns how many leads changed.
create function leadflow_private.apollo_apply_to_leads(target_workspace uuid, contact leadflow_private.apollo_contacts, change text) returns integer
language plpgsql set search_path = '' as $$
declare changed integer; phone_number text := (select p->>'number' from jsonb_array_elements(contact.phones) p where p->>'number' ~ '^[+0-9 ().-]{7,25}$' limit 1);
begin
  with updated as (
    update public.leads l set
      email = case when l.email = '' and contact.email <> '' then contact.email else l.email end,
      phone = case when l.phone = '' and phone_number is not null then phone_number else l.phone end,
      name = case when l.name like '%*%' and contact.name <> '' then left(contact.name, 150) else l.name end
    from leadflow_private.lead_origins o
    where o.workspace_id = target_workspace and o.provider = 'apollo_people' and o.provider_ref = 'person:' || contact.person_id
      and l.workspace_id = target_workspace and l.id = o.lead_id
      and ((l.email = '' and contact.email <> '') or (l.phone = '' and phone_number is not null) or (l.name like '%*%' and contact.name <> ''))
    returning l.id)
  insert into public.activity_history(workspace_id, id, "leadId", text, at) select target_workspace, gen_random_uuid()::text, u.id, change, now() from updated u;
  get diagnostics changed = row_count;
  if changed > 0 then update public.workspaces set revision = revision + 1 where id = target_workspace; end if;
  return changed;
end $$;

-- Stores contacts returned by a reveal (people/bulk_match) and updates matching saved leads.
create function public.apollo_store_contacts(target_workspace uuid, account_id text, contacts jsonb, phone_requested boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare item jsonb; contact leadflow_private.apollo_contacts; changed integer := 0;
begin
  if jsonb_typeof(contacts) is distinct from 'array' or jsonb_array_length(contacts) > 10 then raise exception 'Invalid contacts.' using errcode = '22023'; end if;
  for item in select value from jsonb_array_elements(contacts) loop
    insert into leadflow_private.apollo_contacts as c(workspace_id, person_id, account_id, name, title, email, email_status, phones, linkedin_url, organization_name,
        organization_domain, city, state, country, email_revealed_at, phone_requested_at)
      values (target_workspace, item->>'id', account_id, coalesce(item->>'name', ''), coalesce(item->>'title', ''), coalesce(item->>'email', ''), coalesce(item->>'emailStatus', ''),
        coalesce(item->'phones', '[]'), coalesce(item->>'linkedinUrl', ''), coalesce(item->>'organizationName', ''), coalesce(item->>'organizationDomain', ''),
        coalesce(item->>'city', ''), coalesce(item->>'state', ''), coalesce(item->>'country', ''), now(), case when phone_requested then now() end)
      on conflict (workspace_id, person_id) do update set account_id = excluded.account_id,
        name = case when excluded.name <> '' then excluded.name else c.name end, title = case when excluded.title <> '' then excluded.title else c.title end,
        email = case when excluded.email <> '' then excluded.email else c.email end, email_status = case when excluded.email_status <> '' then excluded.email_status else c.email_status end,
        phones = case when jsonb_array_length(excluded.phones) > 0 then excluded.phones else c.phones end,
        linkedin_url = case when excluded.linkedin_url <> '' then excluded.linkedin_url else c.linkedin_url end,
        organization_name = case when excluded.organization_name <> '' then excluded.organization_name else c.organization_name end,
        organization_domain = case when excluded.organization_domain <> '' then excluded.organization_domain else c.organization_domain end,
        city = case when excluded.city <> '' then excluded.city else c.city end, state = case when excluded.state <> '' then excluded.state else c.state end,
        country = case when excluded.country <> '' then excluded.country else c.country end,
        email_revealed_at = now(), phone_requested_at = coalesce(excluded.phone_requested_at, c.phone_requested_at), updated_at = now()
      returning * into contact;
    changed := changed + leadflow_private.apollo_apply_to_leads(target_workspace, contact, 'Contact details revealed through Apollo');
  end loop;
  return changed;
end $$;

-- Apollo's asynchronous phone result, delivered to the apollo-webhook function. The token in the webhook URL selects
-- the ledger entry; Apollo may retry, so a second delivery changes nothing.
create function public.apollo_phone_result(token_hash text, payload jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare entry leadflow_private.apollo_ledger; person jsonb; contact leadflow_private.apollo_contacts; phones jsonb; found_any boolean := false;
begin
  select * into entry from leadflow_private.apollo_ledger e where e.webhook_token_hash = token_hash for update;
  if entry.id is null then raise exception 'Unknown delivery.' using errcode = 'P0002'; end if;
  if entry.status <> 'pending' then return 'already_recorded'; end if;
  if jsonb_typeof(payload) is distinct from 'object' or octet_length(payload::text) > 200000 then raise exception 'Invalid payload.' using errcode = '22023'; end if;
  for person in select value from jsonb_array_elements(case when jsonb_typeof(payload->'people') = 'array' then payload->'people' else '[]' end) loop
    -- Only people this entry asked for, and only the phone fields LeadFlow shows.
    continue when entry.workspace_id is null or not exists (select 1 from jsonb_array_elements(entry.subjects) s where s->>'id' = person->>'id');
    select coalesce(jsonb_agg(jsonb_build_object('number', left(coalesce(nullif(p->>'sanitized_number', ''), p->>'raw_number'), 30), 'type', left(coalesce(p->>'type_cd', p->>'type', ''), 40),
        'status', left(coalesce(p->>'status_cd', p->>'status', ''), 40))), '[]')
      into phones from jsonb_array_elements(case when jsonb_typeof(person->'phone_numbers') = 'array' then person->'phone_numbers' else '[]' end) p
      where coalesce(nullif(p->>'sanitized_number', ''), p->>'raw_number') is not null;
    if jsonb_array_length(phones) > 0 then found_any := true; end if;
    insert into leadflow_private.apollo_contacts as c(workspace_id, person_id, account_id, phones, phone_requested_at, phone_revealed_at)
      values (entry.workspace_id, person->>'id', entry.account_id, phones, entry.created_at, now())
      on conflict (workspace_id, person_id) do update set phones = case when jsonb_array_length(excluded.phones) > 0 then excluded.phones else c.phones end,
        phone_revealed_at = now(), updated_at = now()
      returning * into contact;
    perform leadflow_private.apollo_apply_to_leads(entry.workspace_id, contact, 'Phone number revealed through Apollo');
  end loop;
  update leadflow_private.apollo_ledger e set status = case when found_any then 'succeeded' else 'no_match' end,
      credits = case when jsonb_typeof(payload->'credits_consumed') = 'number' then (payload->>'credits_consumed')::numeric end,
      credit_basis = case when jsonb_typeof(payload->'credits_consumed') = 'number' then 'reported' else 'estimated' end, completed_at = now()
    where e.id = entry.id;
  return case when found_any then 'succeeded' else 'no_match' end;
end $$;

-- After an import through the apollo function: the account used, and the list to add the new leads to.
create function public.apollo_mark_imported(target_workspace uuid, account_id text, lead_ids jsonb, list_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare listed integer := 0;
begin
  if jsonb_typeof(lead_ids) is distinct from 'array' or jsonb_array_length(lead_ids) > 250 then raise exception 'Invalid leads.' using errcode = '22023'; end if;
  update leadflow_private.lead_origins o set account_ref = account_id
    where o.workspace_id = target_workspace and o.lead_id in (select jsonb_array_elements_text(lead_ids)) and o.provider like 'apollo\_%';
  if list_id is not null then
    if not exists (select 1 from leadflow_private.lead_lists l where l.id = list_id and l.workspace_id = target_workspace) then raise exception 'List not found.' using errcode = 'P0002'; end if;
    insert into leadflow_private.lead_list_members(list_id, workspace_id, lead_id)
      select list_id, target_workspace, x from jsonb_array_elements_text(lead_ids) x on conflict do nothing;
    get diagnostics listed = row_count;
  end if;
  return listed;
end $$;

-- The credit ledger, newest first. Subject names are shown only for entries from the asking workspace.
create function public.apollo_ledger_for(target_workspace uuid, filters jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'accountId', e.account_id, 'operation', e.operation, 'status', e.status,
      'estimatedCredits', e.estimated_credits, 'credits', e.credits, 'creditBasis', e.credit_basis, 'reference', e.reference, 'error', e.error,
      'createdAt', e.created_at, 'completedAt', e.completed_at, 'thisWorkspace', e.workspace_id = target_workspace,
      'subjects', case when e.workspace_id = target_workspace then e.subjects else jsonb_build_array(jsonb_build_object('name', jsonb_array_length(e.subjects) || ' from another workspace')) end)
    order by e.created_at desc, e.id)
    from (select * from leadflow_private.apollo_ledger e
      where (filters->>'accountId' is null or e.account_id = filters->>'accountId')
        and (filters->>'operation' is null or e.operation = filters->>'operation')
        and (filters->>'status' is null or e.status = filters->>'status')
        and (filters->>'from' is null or e.created_at >= (filters->>'from')::date)
        and (filters->>'to' is null or e.created_at < (filters->>'to')::date + 1)
      order by e.created_at desc, e.id limit 200) e), '[]'::jsonb);
end $$;

revoke all on function leadflow_private.apollo_cycle_start(leadflow_private.apollo_accounts), leadflow_private.apollo_used(leadflow_private.apollo_accounts, text),
  leadflow_private.apollo_account_json(leadflow_private.apollo_accounts), leadflow_private.apollo_apply_to_leads(uuid, leadflow_private.apollo_contacts, text) from public, anon, authenticated;
revoke all on function public.apollo_member_role(uuid), public.apollo_contacts_for(uuid, jsonb), public.discovery_saved_searches_for(uuid),
  public.save_discovery_search(uuid, uuid, text, text, jsonb), public.delete_discovery_search(uuid, uuid), public.lead_lists_for(uuid), public.create_lead_list(uuid, text),
  public.add_leads_to_list(uuid, uuid, jsonb), public.delete_lead_list(uuid, uuid), public.apollo_accounts_status(text[]), public.apollo_update_account(text, jsonb),
  public.apollo_record_connection(text, boolean, text), public.apollo_record_sync(text, jsonb, timestamptz, timestamptz),
  public.apollo_reserve(text, uuid, uuid, text, numeric, jsonb, uuid, text), public.apollo_settle(uuid, text, numeric, text, text, text),
  public.apollo_store_contacts(uuid, text, jsonb, boolean), public.apollo_phone_result(text, jsonb), public.apollo_mark_imported(uuid, text, jsonb, uuid),
  public.apollo_ledger_for(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apollo_member_role(uuid), public.apollo_contacts_for(uuid, jsonb), public.discovery_saved_searches_for(uuid),
  public.save_discovery_search(uuid, uuid, text, text, jsonb), public.delete_discovery_search(uuid, uuid), public.lead_lists_for(uuid), public.create_lead_list(uuid, text),
  public.add_leads_to_list(uuid, uuid, jsonb), public.delete_lead_list(uuid, uuid) to authenticated;
grant execute on function public.apollo_accounts_status(text[]), public.apollo_update_account(text, jsonb), public.apollo_record_connection(text, boolean, text),
  public.apollo_record_sync(text, jsonb, timestamptz, timestamptz), public.apollo_reserve(text, uuid, uuid, text, numeric, jsonb, uuid, text),
  public.apollo_settle(uuid, text, numeric, text, text, text), public.apollo_store_contacts(uuid, text, jsonb, boolean), public.apollo_phone_result(text, jsonb),
  public.apollo_mark_imported(uuid, text, jsonb, uuid), public.apollo_ledger_for(uuid, jsonb) to service_role;
