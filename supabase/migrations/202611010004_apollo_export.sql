-- Everything Apollo has found for a workspace, for CSV export: each distinct person or company from the saved result
-- pages (newest copy of each), and every revealed contact in the workspace, including people whose result pages have
-- since expired. Service role only; the apollo function checks the caller first.
-- Reverse with supabase/rollbacks/202611010004_apollo_export.down.sql.
create function public.apollo_export(target_workspace uuid, kind text, max_items integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if kind not in ('people','organizations') or max_items not between 1 and 20000 then raise exception 'Invalid export.' using errcode = '22023'; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(x.item order by x.fetched_at desc, x.item->>'id') from (
        select distinct on (i->>'id') i as item, r.fetched_at
        from leadflow_private.apollo_saved_results r, jsonb_array_elements(r.result->'items') i
        where r.workspace_id = target_workspace and r.kind = apollo_export.kind and i->>'id' is not null
        order by i->>'id', r.fetched_at desc limit max_items) x), '[]'::jsonb),
    'contacts', case when kind = 'people' then coalesce((select jsonb_agg(jsonb_build_object('id', c.person_id, 'name', c.name, 'title', c.title, 'email', c.email,
        'emailStatus', c.email_status, 'phones', c.phones, 'linkedinUrl', c.linkedin_url, 'organizationName', c.organization_name, 'organizationDomain', c.organization_domain,
        'city', c.city, 'state', c.state, 'country', c.country, 'accountId', c.account_id, 'emailRevealedAt', c.email_revealed_at, 'phoneRequestedAt', c.phone_requested_at,
        'phoneRevealedAt', c.phone_revealed_at) order by c.updated_at desc)
      from (select * from leadflow_private.apollo_contacts c where c.workspace_id = target_workspace order by c.updated_at desc limit max_items) c), '[]'::jsonb) else '[]'::jsonb end);
end $$;
revoke all on function public.apollo_export(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.apollo_export(uuid, text, integer) to service_role;
