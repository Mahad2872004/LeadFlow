-- Leads saved from Apollo say so in their history: "Saved from Apollo (account primary)" instead of the generic
-- "Lead imported from lead discovery" that import_leads writes. Existing Apollo leads are updated too.
-- Reverse with supabase/rollbacks/202611010002_apollo_lead_history.down.sql.

-- Same as 202611010001, plus the history wording. The revision advances when history changes, so open tabs reload.
create or replace function public.apollo_mark_imported(target_workspace uuid, account_id text, lead_ids jsonb, list_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare listed integer := 0; renamed integer;
begin
  if jsonb_typeof(lead_ids) is distinct from 'array' or jsonb_array_length(lead_ids) > 250 then raise exception 'Invalid leads.' using errcode = '22023'; end if;
  update leadflow_private.lead_origins o set account_ref = account_id
    where o.workspace_id = target_workspace and o.lead_id in (select jsonb_array_elements_text(lead_ids)) and o.provider like 'apollo\_%';
  update public.activity_history a set text = 'Saved from Apollo (account ' || account_id || ')'
    where a.workspace_id = target_workspace and a."leadId" in (select jsonb_array_elements_text(lead_ids)) and a.text = 'Lead imported from lead discovery'
      and exists (select 1 from leadflow_private.lead_origins o where o.workspace_id = target_workspace and o.lead_id = a."leadId" and o.provider like 'apollo\_%');
  get diagnostics renamed = row_count;
  if renamed > 0 then update public.workspaces set revision = revision + 1 where id = target_workspace; end if;
  if list_id is not null then
    if not exists (select 1 from leadflow_private.lead_lists l where l.id = list_id and l.workspace_id = target_workspace) then raise exception 'List not found.' using errcode = 'P0002'; end if;
    insert into leadflow_private.lead_list_members(list_id, workspace_id, lead_id)
      select list_id, target_workspace, x from jsonb_array_elements_text(lead_ids) x on conflict do nothing;
    get diagnostics listed = row_count;
  end if;
  return listed;
end $$;

-- Apollo leads saved before this migration.
with renamed as (
  update public.activity_history a set text = 'Saved from Apollo (account ' || coalesce(o.account_ref, 'unknown') || ')'
  from leadflow_private.lead_origins o
  where o.workspace_id = a.workspace_id and o.lead_id = a."leadId" and o.provider like 'apollo\_%' and a.text = 'Lead imported from lead discovery'
  returning a.workspace_id)
update public.workspaces w set revision = revision + 1 where w.id in (select distinct workspace_id from renamed);

revoke all on function public.apollo_mark_imported(uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.apollo_mark_imported(uuid, text, jsonb, uuid) to service_role;
