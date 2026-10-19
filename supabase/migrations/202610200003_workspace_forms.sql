-- Workspace-scoped public forms and role-aware saves.
-- 1. Every workspace gets its own public inquiry form, identified by a random key that is never the
--    workspace ID. Owners and admins can turn it off, re-key it, or choose the notification recipient
--    (by default the workspace owner). The deployment-wide /inquiry link without a key keeps working.
-- 2. Members can add and update leads, follow-ups and history, but only owners and admins can remove
--    leads or follow-ups, and history is append-only for members.
-- Reverse with supabase/rollbacks/202610200003_workspace_forms.down.sql before the earlier rollbacks.

create table leadflow_private.inquiry_forms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  enabled boolean not null default true,
  notification_email text check (length(notification_email) <= 254 and notification_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table leadflow_private.inquiry_forms enable row level security;
revoke all on leadflow_private.inquiry_forms from public, anon, authenticated;
create trigger touch_updated_at before update on leadflow_private.inquiry_forms for each row execute function leadflow_private.touch_updated_at();
insert into leadflow_private.inquiry_forms(workspace_id) select id from public.workspaces;

-- New workspaces also start with their form. Definer, so any trusted insert path can create the private row.
create or replace function leadflow_private.initialize_workspace() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.workspace_memberships(workspace_id, user_id, role) values (new.id, new.owner_id, 'owner');
  insert into public.workspace_settings(workspace_id) values (new.id);
  insert into leadflow_private.inquiry_forms(workspace_id) values (new.id);
  return null;
end $$;

-- Public intake through a workspace form (service role only). The key selects an enabled form; the
-- workspace and notification recipient come from the database, never from the visitor.
create function public.receive_form_inquiry(form_key uuid, submission_id uuid, inquiry jsonb, email_hash text, notification_from text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare target_form leadflow_private.inquiry_forms; workspace_name text; recipient text;
begin
  if notification_from is null or length(notification_from) not between 3 and 200 or notification_from ~ '[\r\n]' then
    raise exception 'Invalid notification sender.' using errcode = '22023';
  end if;
  select * into target_form from leadflow_private.inquiry_forms where id = form_key and enabled;
  if not found then raise exception 'This form is not accepting inquiries.' using errcode = 'P0002'; end if;
  select w.name, coalesce(target_form.notification_email, u.email::text) into workspace_name, recipient
    from public.workspaces w join auth.users u on u.id = w.owner_id where w.id = target_form.workspace_id;
  if recipient is null then raise exception 'This form has no notification recipient.' using errcode = '55000'; end if;
  return public.receive_workspace_inquiry(target_form.workspace_id, 'form-' || replace(target_form.id::text, '-', ''), submission_id, inquiry, email_hash,
    jsonb_build_object('from', notification_from, 'to', jsonb_build_array(recipient),
      'subject', 'New website inquiry · ' || coalesce(inquiry->>'service', ''),
      'text', format(E'A new inquiry was saved in LeadFlow.\n\nWorkspace: %s\nName: %s\nEmail: %s\nCompany: %s\nService: %s\nReference: %s\n\nSign in to LeadFlow for the message, phone number, and follow-up actions.',
        workspace_name, inquiry->>'name', inquiry->>'email', coalesce(nullif(inquiry->>'company', ''), 'Not provided'), inquiry->>'service', submission_id)));
end $$;

-- Any member can see the form link and where its notifications go.
create function public.inquiry_form_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select jsonb_build_object('formKey', f.id, 'enabled', f.enabled, 'notificationEmail', f.notification_email, 'recipient', coalesce(f.notification_email, u.email::text))
    into result
    from leadflow_private.inquiry_forms f join public.workspaces w on w.id = f.workspace_id join auth.users u on u.id = w.owner_id
    where f.workspace_id = target_workspace;
  return result;
end $$;
-- Owners and admins. Null leaves a setting unchanged; an empty recipient restores the workspace owner.
-- A new key stops every existing link and embed of this workspace's form.
create function public.update_inquiry_form(target_workspace uuid, form_enabled boolean default null, recipient_email text default null, new_key boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare clean text := btrim(recipient_email);
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if clean <> '' and (length(clean) > 254 or clean !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'Enter a valid recipient email address.' using errcode = '22023';
  end if;
  update leadflow_private.inquiry_forms set enabled = coalesce(form_enabled, enabled),
    notification_email = case when recipient_email is null then notification_email else nullif(clean, '') end,
    id = case when new_key then gen_random_uuid() else id end
    where workspace_id = target_workspace;
  return public.inquiry_form_for(target_workspace);
end $$;

-- Same as 202610200001, plus: members may not remove leads or follow-ups, and may only add history.
-- Set differences keep the checks linear for the largest allowed snapshot.
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

revoke all on function public.receive_form_inquiry(uuid, uuid, jsonb, text, text), public.inquiry_form_for(uuid),
  public.update_inquiry_form(uuid, boolean, text, boolean) from public, anon, authenticated;
grant execute on function public.receive_form_inquiry(uuid, uuid, jsonb, text, text) to service_role;
grant execute on function public.inquiry_form_for(uuid), public.update_inquiry_form(uuid, boolean, text, boolean) to authenticated;
