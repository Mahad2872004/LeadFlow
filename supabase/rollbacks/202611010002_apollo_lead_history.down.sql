-- Reverses 202611010002_apollo_lead_history.sql, then:
--   npx supabase migration repair --status reverted 202611010002
-- History entries already reworded stay as they are; new Apollo saves go back to the generic wording.
create or replace function public.apollo_mark_imported(target_workspace uuid, account_id text, lead_ids jsonb, list_id uuid) returns integer
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
