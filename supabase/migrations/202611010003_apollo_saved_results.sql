-- Saved Apollo result pages, so repeating a search or returning to it later costs nothing. A page is keyed by a hash of
-- the search kind, its normalized filters, the page and the page size, and belongs to one workspace. Results are kept
-- for 90 days and refreshed only when a user asks. Apollo data stays workspace-private and is never sent elsewhere.
-- Reverse with supabase/rollbacks/202611010003_apollo_saved_results.down.sql.

create table leadflow_private.apollo_saved_results (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  signature text not null check (signature ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('people','organizations')),
  filters jsonb not null check (jsonb_typeof(filters) = 'object' and octet_length(filters::text) <= 16000),
  page integer not null check (page between 1 and 500),
  per_page integer not null check (per_page in (10,25,50,100)),
  account_id text references leadflow_private.apollo_accounts(id) on delete set null,
  -- { items, total, totalPages } exactly as the apollo function returned them.
  result jsonb not null check (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 400000),
  fetched_at timestamptz not null default now(),
  primary key (workspace_id, signature)
);
create index apollo_saved_results_age on leadflow_private.apollo_saved_results(fetched_at);
alter table leadflow_private.apollo_saved_results enable row level security;
revoke all on leadflow_private.apollo_saved_results from public, anon, authenticated;

-- Service role only: the apollo function reads and writes saved pages after checking the caller.
create function public.apollo_saved_result(target_workspace uuid, page_signature text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('result', r.result, 'fetchedAt', r.fetched_at, 'accountId', r.account_id)
  from leadflow_private.apollo_saved_results r
  where r.workspace_id = target_workspace and r.signature = page_signature and r.fetched_at > now() - interval '90 days'
$$;
create function public.apollo_save_result(target_workspace uuid, page_signature text, kind text, filters jsonb, page integer, per_page integer, account_id text, result jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from leadflow_private.apollo_saved_results r where r.fetched_at < now() - interval '90 days';
  insert into leadflow_private.apollo_saved_results(workspace_id, signature, kind, filters, page, per_page, account_id, result)
    values (target_workspace, page_signature, kind, filters, page, per_page, account_id, result)
    on conflict (workspace_id, signature) do update set result = excluded.result, account_id = excluded.account_id, fetched_at = now();
  -- At most 1,000 saved pages per workspace; the oldest go first.
  delete from leadflow_private.apollo_saved_results r where r.workspace_id = target_workspace and r.signature in (
    select x.signature from leadflow_private.apollo_saved_results x where x.workspace_id = target_workspace order by x.fetched_at desc offset 1000);
end $$;

revoke all on function public.apollo_saved_result(uuid, text), public.apollo_save_result(uuid, text, text, jsonb, integer, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.apollo_saved_result(uuid, text), public.apollo_save_result(uuid, text, text, jsonb, integer, integer, text, jsonb) to service_role;
