-- Reverses 202610310001_lead_discovery.sql. Run it as one batch, then:
--   npx supabase migration repair --status reverted 202610310001
-- Imported leads are kept. Their business fields, provenance and the search history are removed. Leads without
-- an email get a placeholder address that cannot receive mail, because the earlier schema requires one, and the
-- new service and source values become "Other".
drop function public.import_leads(uuid, uuid, jsonb), public.lead_origins_for(uuid), public.start_discovery_search(uuid, uuid, text, jsonb),
  public.finish_discovery_search(uuid, text, integer, boolean, text), public.discovery_history_for(uuid), public.discovery_place(text),
  public.remember_discovery_place(text, jsonb), leadflow_private.import_text(jsonb, text, integer, boolean);
drop table leadflow_private.lead_origins, leadflow_private.discovery_searches, leadflow_private.discovery_places, leadflow_private.lead_import_requests;

-- The reserved .invalid domain (RFC 2606) can never deliver; search for it to find these leads afterwards.
update public.leads set email = 'no-email+' || left(md5(workspace_id::text || id), 12) || '@leadflow.invalid' where email = '';
update public.leads set service = 'Other' where service = 'Not specified';
update public.leads set source = 'Other' where source in ('Lead discovery','CSV import');
alter table public.leads drop constraint leads_email_check,
  add constraint leads_email_check check (length(email) <= 150 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
alter table public.leads drop constraint leads_service_check,
  add constraint leads_service_check check (service in ('Website design','Web development','Brand identity','Consulting','Other'));
alter table public.leads drop constraint leads_source_check,
  add constraint leads_source_check check (source in ('Website','Referral','LinkedIn','Email','Other'));

-- Definition from 202610200003_workspace_forms.sql.
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
  insert into public.leads(workspace_id, id, name, email, phone, company, service, source, message, status, "createdAt")
    select target_workspace, x.id, x.name, x.email, x.phone, x.company, x.service, x.source, x.message, x.status, x."createdAt"
    from jsonb_to_recordset(payload->'leads') as x(id text, name text, email text, phone text, company text, service text, source text, message text, status text, "createdAt" timestamptz);
  insert into public.follow_up_tasks(workspace_id, id, "leadId", due, notes, completed)
    select target_workspace, x.id, x."leadId", x.due, x.notes, x.completed
    from jsonb_to_recordset(payload->'tasks') as x(id text, "leadId" text, due date, notes text, completed boolean);
  insert into public.activity_history(workspace_id, id, "leadId", text, at)
    select target_workspace, x.id, x."leadId", x.text, x.at
    from jsonb_to_recordset(payload->'activities') as x(id text, "leadId" text, text text, at timestamptz);
  update public.workspaces set revision = revision + 1 where id = target_workspace returning revision into current_revision;
  insert into public.workspace_requests(workspace_id, request_id, payload_hash, revision, actor_id)
    values (target_workspace, request_id, fingerprint, current_revision, leadflow_private.valid_actor());
  return current_revision;
end $$;

drop function leadflow_private.lead_place_keys(text, text, text), leadflow_private.lead_phone_key(text), leadflow_private.lead_name_key(text),
  leadflow_private.lead_domain(text);
alter table public.leads drop column website, drop column industry, drop column address, drop column city, drop column region,
  drop column postcode, drop column country;
