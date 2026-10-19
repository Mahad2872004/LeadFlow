-- Multi-tenant workspace foundation. Users can own several workspaces and belong to other users'
-- workspaces as admin or member. Supersedes the unapplied draft 202610190001 (docs/MULTI-TENANCY.md).
-- Every existing row is preserved and keeps its association: each M2 per-user workspace keeps its UUID,
-- which is the owner's Auth user ID, so existing owner_id values become workspace_id values unchanged.
-- Run as one transaction: the Supabase CLI does; in the SQL editor, run the whole file at once.
-- Reverse with supabase/rollbacks/202610200001_multi_tenant_foundation.down.sql.

create temporary view migration_current_counts as
  select 'leads' as source, count(*) as total from public.leads
  union all select 'follow_up_tasks', count(*) from public.follow_up_tasks
  union all select 'activity_history', count(*) from public.activity_history
  union all select 'workspace_requests', count(*) from public.workspace_requests
  union all select 'inquiries', count(*) from leadflow_private.inquiries
  union all select 'notification_outbox', count(*) from leadflow_private.notification_outbox
  union all select 'integration_keys', count(*) from leadflow_private.integration_keys;
create temporary table migration_initial_counts on commit drop as select * from migration_current_counts;

-- Profiles mirror Auth identities. Display names are informational and never used for authorization.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 150 and display_name !~ '[[:cntrl:]]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.profiles(id) select id from auth.users;

-- M2 created a workspace on a user's first save. Create the rest now, so credentials and receipts of
-- users who never saved also have a workspace to belong to.
insert into public.workspaces(owner_id) select id from auth.users on conflict do nothing;
alter table public.workspaces rename column owner_id to id;
alter table public.workspaces drop constraint workspaces_owner_id_fkey;
alter table public.workspaces
  add column owner_id uuid,
  add column name text not null default 'Personal workspace' check (length(btrim(name)) between 1 and 100 and name !~ '[[:cntrl:]]'),
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();
update public.workspaces set owner_id = id;
-- Deleting a user who still owns a workspace fails rather than deleting data other members rely on.
alter table public.workspaces alter column owner_id set not null,
  add constraint workspaces_owner_id_fkey foreign key (owner_id) references public.profiles(id) on delete restrict;
create index workspaces_owner on public.workspaces(owner_id);

-- Existing composite keys and foreign keys keep tasks and history inside their lead's workspace.
alter table public.leads rename column owner_id to workspace_id;
alter table public.follow_up_tasks rename column owner_id to workspace_id;
alter table public.activity_history rename column owner_id to workspace_id;
alter table public.workspace_requests rename column owner_id to workspace_id;
-- Record which member made each save. Every earlier save was made by the workspace owner.
-- Earlier receipts get the migration time as created_at.
alter table public.workspace_requests
  add column actor_id uuid references public.profiles(id) on delete set null,
  add column created_at timestamptz not null default now();
update public.workspace_requests set actor_id = workspace_id;
create index workspace_requests_actor on public.workspace_requests(actor_id);

alter table leadflow_private.inquiries rename column owner_id to workspace_id;
alter table leadflow_private.inquiries drop constraint inquiries_owner_id_fkey,
  add constraint inquiries_workspace_id_fkey foreign key (workspace_id) references public.workspaces(id) on delete cascade;
alter table leadflow_private.integration_keys rename column owner_id to workspace_id;
alter table leadflow_private.integration_keys drop constraint integration_keys_owner_id_fkey,
  add constraint integration_keys_workspace_id_fkey foreign key (workspace_id) references public.workspaces(id) on delete cascade;
alter index leadflow_private.integration_keys_owner rename to integration_keys_workspace;
-- Notification jobs belong to a workspace through their required inquiry receipt.
-- request_limits is global abuse throttling, not workspace data.

create table public.workspace_memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_memberships_user on public.workspace_memberships(user_id);
create unique index workspace_memberships_one_owner on public.workspace_memberships(workspace_id) where role = 'owner';
insert into public.workspace_memberships(workspace_id, user_id, role) select id, owner_id, 'owner' from public.workspaces;

create table public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  timezone text not null default 'UTC' check (length(timezone) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.workspace_settings(workspace_id) select id from public.workspaces;

create function leadflow_private.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger touch_updated_at before update on public.profiles for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on public.workspaces for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on public.workspace_memberships for each row execute function leadflow_private.touch_updated_at();
create trigger touch_updated_at before update on public.workspace_settings for each row execute function leadflow_private.touch_updated_at();

-- Every new workspace starts with its owner's membership and default settings.
create function leadflow_private.initialize_workspace() returns trigger language plpgsql set search_path = '' as $$
begin
  insert into public.workspace_memberships(workspace_id, user_id, role) values (new.id, new.owner_id, 'owner');
  insert into public.workspace_settings(workspace_id) values (new.id);
  return null;
end $$;
create trigger initialize_workspace after insert on public.workspaces for each row execute function leadflow_private.initialize_workspace();

-- Checked at commit: workspaces.owner_id holds the workspace's only owner membership. Owner powers come
-- from that membership, so no code path can create a second owner or leave an owner without the role.
create function leadflow_private.check_workspace_owner() returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.workspaces w
    where w.id in ((to_jsonb(old) ->> tg_argv[0])::uuid, (to_jsonb(new) ->> tg_argv[0])::uuid)
      and not exists (select 1 from public.workspace_memberships m where m.workspace_id = w.id and m.user_id = w.owner_id and m.role = 'owner'))
  then raise exception 'A workspace owner must hold its owner membership.' using errcode = '23514'; end if;
  return null;
end $$;
create constraint trigger owner_membership_matches after insert or update of owner_id on public.workspaces
  deferrable initially deferred for each row execute function leadflow_private.check_workspace_owner('id');
create constraint trigger owner_membership_matches after insert or update or delete on public.workspace_memberships
  deferrable initially deferred for each row execute function leadflow_private.check_workspace_owner('workspace_id');

-- Anonymous Auth sessions never count as an internal identity.
create function leadflow_private.valid_actor() returns uuid language sql stable set search_path = '' as $$
  select case when coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then null else auth.uid() end
$$;
-- RLS helpers. Security definer so policies can read memberships without recursing into their RLS.
create function leadflow_private.member_workspace_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select workspace_id from public.workspace_memberships where user_id = leadflow_private.valid_actor()
$$;
create function leadflow_private.visible_profile_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select leadflow_private.valid_actor()
  union
  select teammate.user_id from public.workspace_memberships mine
  join public.workspace_memberships teammate on teammate.workspace_id = mine.workspace_id
  where mine.user_id = leadflow_private.valid_actor()
$$;
-- Returns the caller's role or raises. Unknown workspaces and non-members get the same error.
-- Writers pass for_write so they serialize with membership changes on the locked workspace row.
create function leadflow_private.require_role(target_workspace uuid, allowed_roles text[], for_write boolean default false)
returns text language plpgsql set search_path = '' as $$
declare actor uuid := leadflow_private.valid_actor(); actor_role text;
begin
  if actor is null then raise exception 'Sign in with an internal account.' using errcode = '42501'; end if;
  if for_write then perform 1 from public.workspaces where id = target_workspace for update; end if;
  select role into actor_role from public.workspace_memberships where workspace_id = target_workspace and user_id = actor;
  if actor_role is null then raise exception 'Workspace not found or access denied.' using errcode = '42501'; end if;
  if not actor_role = any(allowed_roles) then raise exception 'Your workspace role does not allow this action.' using errcode = '42501'; end if;
  return actor_role;
end $$;
-- Profiles of users created after this migration are created on first use.
create function leadflow_private.current_profile() returns uuid language plpgsql set search_path = '' as $$
declare actor uuid := leadflow_private.valid_actor();
begin
  if actor is null or not exists (select 1 from auth.users where id = actor) then
    raise exception 'Sign in with an internal account.' using errcode = '42501';
  end if;
  insert into public.profiles(id) values (actor) on conflict do nothing;
  return actor;
end $$;
-- M2's single workspace per account. Its ID is the user's Auth ID; the no-argument RPCs use it.
create function leadflow_private.personal_workspace() returns uuid language plpgsql set search_path = '' as $$
declare actor uuid := leadflow_private.current_profile();
begin
  insert into public.workspaces(id, owner_id) values (actor, actor) on conflict do nothing;
  return actor;
end $$;
-- Trusted operators only (SQL editor). Not granted to any API role. The new owner must already be a
-- member; the previous owner becomes an admin.
create function leadflow_private.transfer_workspace_ownership(target_workspace uuid, new_owner uuid) returns void
language plpgsql set search_path = '' as $$
declare previous_owner uuid;
begin
  select owner_id into previous_owner from public.workspaces where id = target_workspace for update;
  if not found then raise exception 'Workspace not found.' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.workspace_memberships where workspace_id = target_workspace and user_id = new_owner) then
    raise exception 'The new owner must already be a workspace member.' using errcode = '23514';
  end if;
  update public.workspace_memberships set role = 'admin' where workspace_id = target_workspace and user_id = previous_owner;
  update public.workspace_memberships set role = 'owner' where workspace_id = target_workspace and user_id = new_owner;
  update public.workspaces set owner_id = new_owner where id = target_workspace;
end $$;

-- Clients read through RLS and write only through the functions below.
alter table public.profiles enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_settings enable row level security;
drop policy own_workspace on public.workspaces;
drop policy own_leads on public.leads;
drop policy own_tasks on public.follow_up_tasks;
drop policy own_history on public.activity_history;
drop policy own_requests on public.workspace_requests;
create policy member_read on public.workspaces for select to authenticated using (id in (select leadflow_private.member_workspace_ids()));
create policy member_read on public.workspace_memberships for select to authenticated using (workspace_id in (select leadflow_private.member_workspace_ids()));
create policy member_read on public.workspace_settings for select to authenticated using (workspace_id in (select leadflow_private.member_workspace_ids()));
create policy member_read on public.leads for select to authenticated using (workspace_id in (select leadflow_private.member_workspace_ids()));
create policy member_read on public.follow_up_tasks for select to authenticated using (workspace_id in (select leadflow_private.member_workspace_ids()));
create policy member_read on public.activity_history for select to authenticated using (workspace_id in (select leadflow_private.member_workspace_ids()));
create policy member_read on public.workspace_requests for select to authenticated using (workspace_id in (select leadflow_private.member_workspace_ids()));
create policy teammate_read on public.profiles for select to authenticated using (id in (select leadflow_private.visible_profile_ids()));
revoke all on public.profiles, public.workspace_memberships, public.workspace_settings from public, anon, authenticated;
grant select on public.profiles, public.workspace_memberships, public.workspace_settings to authenticated;
revoke all on all functions in schema leadflow_private from public, anon, authenticated;
grant execute on function leadflow_private.member_workspace_ids(), leadflow_private.visible_profile_ids() to authenticated;

-- Workspace data. Any member may read and save the workspace's leads, follow-ups and history.
create function public.load_workspace_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  -- One statement gives a consistent read of the revision and all three collections.
  select jsonb_build_object('revision', w.revision, 'data', jsonb_build_object('version', 1,
    'leads', coalesce((select jsonb_agg((to_jsonb(l) - 'workspace_id') || jsonb_build_object('createdAt', to_char(l."createdAt" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by l."createdAt" desc, l.id) from public.leads l where l.workspace_id = w.id), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(to_jsonb(t) - 'workspace_id' order by t.due, t.id) from public.follow_up_tasks t where t.workspace_id = w.id), '[]'::jsonb),
    'activities', coalesce((select jsonb_agg((to_jsonb(a) - 'workspace_id') || jsonb_build_object('at', to_char(a.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by a.at desc, a.id) from public.activity_history a where a.workspace_id = w.id), '[]'::jsonb)))
  into result from public.workspaces w where w.id = target_workspace;
  return result;
end $$;

-- Whole-workspace transaction keeps the M1 domain operations simple. Every statement filters by the
-- authorized workspace explicitly: this definer function bypasses RLS.
create function public.save_workspace_for(target_workspace uuid, payload jsonb, expected_revision bigint, request_id uuid) returns bigint
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

-- The original no-argument RPCs keep serving the current dashboard on the caller's personal workspace.
create or replace function public.load_workspace() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin return public.load_workspace_for(leadflow_private.personal_workspace()); end $$;
create or replace function public.save_workspace(payload jsonb, expected_revision bigint, request_id uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
begin return public.save_workspace_for(leadflow_private.personal_workspace(), payload, expected_revision, request_id); end $$;

-- Integration metadata and receipts: any member may view; owners and admins may revoke credentials.
create function public.integration_overview_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select jsonb_build_object(
    'credentials', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'label', k.label, 'provider', k.provider, 'revoked', k.revoked_at is not null, 'lastUsedAt', k.last_used_at) order by k.created_at desc)
      from leadflow_private.integration_keys k where k.workspace_id = target_workspace), '[]'::jsonb),
    'websiteLastReceivedAt', (select max(i.created_at) from leadflow_private.inquiries i where i.workspace_id = target_workspace and i.integration_id is null),
    'email', (select jsonb_build_object(
        'accepted', count(*) filter (where o.status = 'accepted'),
        'attention', count(*) filter (where o.status in ('failed','uncertain')),
        'pending', count(*) filter (where o.status in ('pending','sending')))
      from leadflow_private.notification_outbox o join leadflow_private.inquiries i using (request_id) where i.workspace_id = target_workspace))
  into result;
  return result;
end $$;
create function public.verify_integration_receipt_for(target_workspace uuid, submission_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select jsonb_build_object('reference', i.request_id, 'receivedAt', i.created_at, 'channel', case when i.integration_id is null then 'Website' else 'Webhook' end)
  into result from leadflow_private.inquiries i join public.leads l on l.workspace_id = i.workspace_id and l.id = i.request_id::text
  where i.workspace_id = target_workspace and i.request_id = submission_id;
  if result is null then raise exception 'No matching inquiry exists in this workspace. Check the reference and destination workspace.' using errcode = 'P0002'; end if;
  return result;
end $$;
-- Returns false when the credential is not an active credential of this workspace.
create function public.revoke_integration_for(target_workspace uuid, credential_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  update leadflow_private.integration_keys set revoked_at = now() where id = credential_id and workspace_id = target_workspace and revoked_at is null;
  return found;
end $$;
create or replace function public.integration_overview() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin return public.integration_overview_for(leadflow_private.personal_workspace()); end $$;
create or replace function public.verify_integration_receipt(submission_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin return public.verify_integration_receipt_for(leadflow_private.personal_workspace(), submission_id); end $$;
create or replace function public.revoke_integration(credential_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin perform public.revoke_integration_for(leadflow_private.personal_workspace(), credential_id); end $$;

-- Workspace management. Ownership is never assigned or changed through these functions.
create function public.list_workspaces() returns table (id uuid, name text, owner_id uuid, role text, revision bigint, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare actor uuid := leadflow_private.personal_workspace();
begin
  return query select w.id, w.name, w.owner_id, m.role, w.revision, w.created_at
    from public.workspaces w join public.workspace_memberships m on m.workspace_id = w.id
    where m.user_id = actor order by w.created_at, w.id;
end $$;
create function public.create_workspace(workspace_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := leadflow_private.current_profile(); clean_name text := btrim(workspace_name); created uuid := gen_random_uuid();
begin
  if clean_name is null or length(clean_name) not between 1 and 100 or clean_name ~ '[[:cntrl:]]' then
    raise exception 'Workspace names must be 1 to 100 characters.' using errcode = '22023';
  end if;
  -- The profile lock stops concurrent requests from exceeding the limit.
  perform 1 from public.profiles where id = actor for update;
  if (select count(*) from public.workspaces where owner_id = actor) >= 25 then
    raise exception 'You can own at most 25 workspaces.' using errcode = '54000';
  end if;
  insert into public.workspaces(id, owner_id, name) values (created, actor, clean_name);
  return created;
end $$;
-- Null leaves a field unchanged.
create function public.update_workspace(target_workspace uuid, workspace_name text default null, workspace_timezone text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare clean_name text := btrim(workspace_name);
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if workspace_name is not null and (length(clean_name) not between 1 and 100 or clean_name ~ '[[:cntrl:]]') then
    raise exception 'Workspace names must be 1 to 100 characters.' using errcode = '22023';
  end if;
  if workspace_timezone is not null and not exists (select 1 from pg_catalog.pg_timezone_names where name = workspace_timezone) then
    raise exception 'Choose a valid IANA time zone.' using errcode = '22023';
  end if;
  update public.workspaces set name = clean_name where id = target_workspace and clean_name is not null;
  update public.workspace_settings set timezone = workspace_timezone where workspace_id = target_workspace and workspace_timezone is not null;
end $$;
-- Owners grant admin or member; admins grant member only. Nobody changes their own membership here.
create function public.set_workspace_member(target_workspace uuid, target_user uuid, member_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare actor_role text := leadflow_private.require_role(target_workspace, array['owner','admin'], true); existing_role text;
begin
  if member_role is null or member_role not in ('admin','member') then raise exception 'Role must be admin or member.' using errcode = '22023'; end if;
  if target_user is null or target_user = leadflow_private.valid_actor() then raise exception 'You cannot change your own membership.' using errcode = '42501'; end if;
  if actor_role = 'admin' and member_role <> 'member' then raise exception 'Only the workspace owner can grant the admin role.' using errcode = '42501'; end if;
  select role into existing_role from public.workspace_memberships where workspace_id = target_workspace and user_id = target_user;
  if existing_role = 'owner' then raise exception 'The owner role cannot be changed.' using errcode = '42501'; end if;
  if actor_role = 'admin' and existing_role = 'admin' then raise exception 'Only the workspace owner can change an admin.' using errcode = '42501'; end if;
  if existing_role is not null then
    update public.workspace_memberships set role = member_role where workspace_id = target_workspace and user_id = target_user;
    return;
  end if;
  if not exists (select 1 from auth.users where id = target_user) then raise exception 'User not found.' using errcode = 'P0002'; end if;
  if (select count(*) from public.workspace_memberships where workspace_id = target_workspace) >= 100 then
    raise exception 'A workspace can have at most 100 members.' using errcode = '54000';
  end if;
  insert into public.profiles(id) values (target_user) on conflict do nothing;
  insert into public.workspace_memberships(workspace_id, user_id, role) values (target_workspace, target_user, member_role);
end $$;
create function public.remove_workspace_member(target_workspace uuid, target_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare actor_role text := leadflow_private.require_role(target_workspace, array['owner','admin'], true); existing_role text;
begin
  if target_user = leadflow_private.valid_actor() then raise exception 'Use leave_workspace to leave a workspace.' using errcode = '42501'; end if;
  select role into existing_role from public.workspace_memberships where workspace_id = target_workspace and user_id = target_user;
  if existing_role is null then raise exception 'Member not found.' using errcode = 'P0002'; end if;
  if existing_role = 'owner' then raise exception 'The workspace owner cannot be removed.' using errcode = '42501'; end if;
  if actor_role = 'admin' and existing_role = 'admin' then raise exception 'Only the workspace owner can remove an admin.' using errcode = '42501'; end if;
  delete from public.workspace_memberships where workspace_id = target_workspace and user_id = target_user;
end $$;
create function public.leave_workspace(target_workspace uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if leadflow_private.require_role(target_workspace, array['owner','admin','member'], true) = 'owner' then
    raise exception 'The workspace owner cannot leave it.' using errcode = '42501';
  end if;
  delete from public.workspace_memberships where workspace_id = target_workspace and user_id = leadflow_private.valid_actor();
end $$;
create function public.update_profile(profile_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := leadflow_private.current_profile(); clean_name text := btrim(coalesce(profile_name, ''));
begin
  if length(clean_name) > 150 or clean_name ~ '[[:cntrl:]]' then raise exception 'Display names can have at most 150 characters.' using errcode = '22023'; end if;
  update public.profiles set display_name = clean_name where id = actor;
end $$;

-- Public intake (service role only). The destination comes from server configuration or the integration
-- credential, never from the visitor. Same fingerprint as M3 for personal workspaces, whose ID is the
-- former owner ID, so retries of earlier submissions stay idempotent.
create function public.receive_workspace_inquiry(target_workspace uuid, website_id text, submission_id uuid, inquiry jsonb, email_hash text, notification jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare fingerprint text; prior leadflow_private.inquiries;
begin
  if submission_id is null or target_workspace is null or website_id is null or website_id !~ '^[a-z0-9-]{1,64}$'
    or inquiry is null or octet_length(inquiry::text) > 12000
    or length(btrim(coalesce(inquiry->>'message', ''))) not between 1 and 2000
    or email_hash is null or length(email_hash) <> 64
    or notification is null or jsonb_typeof(notification) <> 'object' then raise exception 'Invalid inquiry.' using errcode = '22023'; end if;
  fingerprint := md5(inquiry::text || website_id || target_workspace::text);
  perform 1 from public.workspaces where id = target_workspace for update;
  if not found then raise exception 'Unknown inquiry workspace.' using errcode = '23503'; end if;
  select * into prior from leadflow_private.inquiries where request_id = submission_id;
  if found then
    if prior.payload_hash <> fingerprint then raise exception 'Submission ID already used.' using errcode = '23505'; end if;
    return submission_id;
  end if;
  -- Atomic quotas, independent of spoofable client IP headers. Retries do not consume quota.
  if (select count(*) from leadflow_private.inquiries i where i.workspace_id = target_workspace and i.website = website_id and i.created_at > now() - interval '24 hours') >= 50
    or (select count(*) from leadflow_private.inquiries i where i.workspace_id = target_workspace and i.website = website_id and i.email_hash = receive_workspace_inquiry.email_hash and i.created_at > now() - interval '1 hour') >= 5
    then raise exception 'Inquiry rate limit reached.' using errcode = 'P0429'; end if;
  insert into public.leads(workspace_id, id, name, email, phone, company, service, source, message, status, "createdAt")
    values (target_workspace, submission_id::text, inquiry->>'name', inquiry->>'email', inquiry->>'phone', inquiry->>'company', inquiry->>'service', 'Website', inquiry->>'message', 'New', now());
  insert into public.activity_history(workspace_id, id, "leadId", text, at)
    values (target_workspace, gen_random_uuid()::text, submission_id::text, 'Website inquiry received (' || website_id || ')', now());
  insert into leadflow_private.inquiries(request_id, workspace_id, website, payload_hash, email_hash)
    values (submission_id, target_workspace, website_id, fingerprint, email_hash);
  insert into leadflow_private.notification_outbox(request_id, email) values (submission_id, notification);
  update public.workspaces set revision = revision + 1 where id = target_workspace;
  return submission_id;
end $$;
-- Edge Functions deployed before this migration pass the owner's Auth ID, which is also the ID of
-- that owner's personal workspace. Like M3, the personal workspace is created if it is missing.
create or replace function public.receive_inquiry(target_owner uuid, website_id text, submission_id uuid, inquiry jsonb, email_hash text, notification jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from auth.users where id = target_owner) then
    insert into public.profiles(id) values (target_owner) on conflict do nothing;
    insert into public.workspaces(id, owner_id) values (target_owner, target_owner) on conflict do nothing;
  end if;
  return public.receive_workspace_inquiry(target_owner, website_id, submission_id, inquiry, email_hash, notification);
end $$;
-- The credential, never the caller, determines the workspace.
create or replace function public.receive_webhook(key_hash text, submission_id uuid, inquiry jsonb, email_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare credential leadflow_private.integration_keys; existed boolean; notification jsonb;
begin
  select * into credential from leadflow_private.integration_keys where token_hash = key_hash and revoked_at is null for update;
  if not found then raise exception 'Invalid credential.' using errcode = '28000'; end if;
  perform 1 from public.workspaces where id = credential.workspace_id for update;
  existed := exists (select 1 from leadflow_private.inquiries where request_id = submission_id);
  if not existed and (select count(*) from leadflow_private.inquiries where workspace_id = credential.workspace_id and created_at > now() - interval '24 hours') >= 50 then
    raise exception 'Workspace inquiry quota reached.' using errcode = 'P0429';
  end if;
  notification := jsonb_build_object('from', credential.notification_from, 'to', jsonb_build_array(credential.notification_to),
    'subject', 'New integration inquiry · ' || (inquiry->>'service'),
    'text', 'A new inquiry was saved in LeadFlow.' || E'\nName: ' || (inquiry->>'name') || E'\nEmail: ' || (inquiry->>'email') || E'\nCompany: ' || coalesce(inquiry->>'company', '') || E'\nService: ' || (inquiry->>'service') || E'\nIntegration: ' || credential.label || E'\nReference: ' || submission_id::text || E'\nSign in to LeadFlow for the full inquiry.');
  perform public.receive_workspace_inquiry(credential.workspace_id, 'hook-' || credential.id::text, submission_id, inquiry, email_hash, notification);
  if not existed then
    update public.leads set source = 'Other' where workspace_id = credential.workspace_id and id = submission_id::text;
    update public.activity_history set text = 'Integration inquiry received (' || credential.label || ')' where workspace_id = credential.workspace_id and "leadId" = submission_id::text;
    update leadflow_private.inquiries set integration_id = credential.id where request_id = submission_id;
  end if;
  update leadflow_private.integration_keys set last_used_at = now() where id = credential.id;
  return submission_id;
end $$;

-- Supabase grants new public functions to anon and authenticated by default; restate every grant.
revoke all on function public.load_workspace_for(uuid), public.save_workspace_for(uuid, jsonb, bigint, uuid),
  public.integration_overview_for(uuid), public.verify_integration_receipt_for(uuid, uuid), public.revoke_integration_for(uuid, uuid),
  public.list_workspaces(), public.create_workspace(text), public.update_workspace(uuid, text, text),
  public.set_workspace_member(uuid, uuid, text), public.remove_workspace_member(uuid, uuid), public.leave_workspace(uuid),
  public.update_profile(text), public.receive_workspace_inquiry(uuid, text, uuid, jsonb, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.load_workspace_for(uuid), public.save_workspace_for(uuid, jsonb, bigint, uuid),
  public.integration_overview_for(uuid), public.verify_integration_receipt_for(uuid, uuid), public.revoke_integration_for(uuid, uuid),
  public.list_workspaces(), public.create_workspace(text), public.update_workspace(uuid, text, text),
  public.set_workspace_member(uuid, uuid, text), public.remove_workspace_member(uuid, uuid), public.leave_workspace(uuid),
  public.update_profile(text) to authenticated;
grant execute on function public.receive_workspace_inquiry(uuid, text, uuid, jsonb, text, jsonb) to service_role;

-- Abort the whole migration unless every row survived and every workspace has exactly its owner.
do $$
begin
  if exists (select * from migration_initial_counts except select * from migration_current_counts) then
    raise exception 'Migration check failed: row counts changed.';
  end if;
  if exists (select 1 from public.workspaces w where w.owner_id <> w.id
      or not exists (select 1 from public.workspace_memberships m where m.workspace_id = w.id and m.user_id = w.owner_id and m.role = 'owner')
      or not exists (select 1 from public.workspace_settings s where s.workspace_id = w.id))
    or exists (select 1 from public.workspace_memberships where role <> 'owner')
  then raise exception 'Migration check failed: workspace ownership backfill is inconsistent.'; end if;
end $$;
drop view migration_current_counts;
