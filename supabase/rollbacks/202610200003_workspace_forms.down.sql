-- Reverses 202610200003_workspace_forms.sql. Run it before the earlier rollbacks, as one batch, then:
--   npx supabase migration repair --status reverted 202610200003
-- Workspace form links stop working; inquiries already received through them are kept.
drop function public.receive_form_inquiry(uuid, uuid, jsonb, text, text), public.inquiry_form_for(uuid),
  public.update_inquiry_form(uuid, boolean, text, boolean);
drop table leadflow_private.inquiry_forms;

-- Definitions from 202610200001_multi_tenant_foundation.sql.
create or replace function leadflow_private.initialize_workspace() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.workspace_memberships(workspace_id, user_id, role) values (new.id, new.owner_id, 'owner');
  insert into public.workspace_settings(workspace_id) values (new.id);
  return null;
end $$;
create or replace function public.save_workspace_for(target_workspace uuid, payload jsonb, expected_revision bigint, request_id uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare current_revision bigint; receipt public.workspace_requests; fingerprint text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
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
