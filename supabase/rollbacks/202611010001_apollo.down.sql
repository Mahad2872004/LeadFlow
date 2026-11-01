-- Reverses 202611010001_apollo.sql. Run it as one batch, then:
--   npx supabase migration repair --status reverted 202611010001
-- Removes Apollo account settings, the credit ledger, revealed contacts, saved searches and lead lists. Leads already
-- saved (with any revealed email or phone) are kept. Searches with criteria over 4 KB are trimmed to an empty object.
drop function public.apollo_member_role(uuid), public.apollo_contacts_for(uuid, jsonb), public.discovery_saved_searches_for(uuid),
  public.save_discovery_search(uuid, uuid, text, text, jsonb), public.delete_discovery_search(uuid, uuid), public.lead_lists_for(uuid), public.create_lead_list(uuid, text),
  public.add_leads_to_list(uuid, uuid, jsonb), public.delete_lead_list(uuid, uuid), public.apollo_accounts_status(text[]), public.apollo_update_account(text, jsonb),
  public.apollo_record_connection(text, boolean, text), public.apollo_record_sync(text, jsonb, timestamptz, timestamptz),
  public.apollo_reserve(text, uuid, uuid, text, numeric, jsonb, uuid, text), public.apollo_settle(uuid, text, numeric, text, text, text),
  public.apollo_store_contacts(uuid, text, jsonb, boolean), public.apollo_phone_result(text, jsonb), public.apollo_mark_imported(uuid, text, jsonb, uuid),
  public.apollo_ledger_for(uuid, jsonb), leadflow_private.apollo_apply_to_leads(uuid, leadflow_private.apollo_contacts, text),
  leadflow_private.apollo_account_json(leadflow_private.apollo_accounts), leadflow_private.apollo_used(leadflow_private.apollo_accounts, text),
  leadflow_private.apollo_cycle_start(leadflow_private.apollo_accounts);
drop table leadflow_private.lead_list_members, leadflow_private.lead_lists, leadflow_private.discovery_saved_searches, leadflow_private.apollo_contacts,
  leadflow_private.apollo_ledger, leadflow_private.apollo_accounts;
alter table leadflow_private.lead_origins drop column account_ref;
update leadflow_private.discovery_searches set criteria = '{}' where octet_length(criteria::text) > 4000;
alter table leadflow_private.discovery_searches drop constraint discovery_searches_criteria_check,
  add constraint discovery_searches_criteria_check check (jsonb_typeof(criteria) = 'object' and octet_length(criteria::text) <= 4000);

-- Definitions from 202610310001_lead_discovery.sql.
create or replace function public.start_discovery_search(target_workspace uuid, search_id uuid, provider text, criteria jsonb) returns uuid
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
create or replace function public.lead_origins_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return coalesce((select jsonb_agg(jsonb_build_object('leadId', o.lead_id, 'method', o.method, 'provider', o.provider, 'providerRef', o.provider_ref,
      'searchId', o.search_id, 'sourceUrl', o.source_url, 'sourceUpdatedAt', o.source_updated_at, 'discoveredAt', o.discovered_at, 'importedAt', o.imported_at)
    order by o.imported_at desc, o.lead_id)
    from leadflow_private.lead_origins o join public.leads l on l.workspace_id = o.workspace_id and l.id = o.lead_id
    where o.workspace_id = target_workspace), '[]'::jsonb);
end $$;
