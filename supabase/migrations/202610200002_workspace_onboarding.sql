-- Workspace onboarding. New accounts no longer get an automatic personal workspace from
-- list_workspaces(): they create their first workspace during onboarding. Adds an optional business
-- type, idempotent workspace creation, and a role-checked member list. Existing workspaces are unchanged.
-- Reverse with supabase/rollbacks/202610200002_workspace_onboarding.down.sql before the foundation rollback.

-- Keep this list in step with src/lib/workspaceOptions.ts.
alter table public.workspace_settings add column business_type text
  check (business_type in ('Design studio','Development agency','Marketing agency','Freelancer','Consultancy','Other'));
-- A retried creation request returns the workspace it already created instead of a duplicate.
alter table public.workspaces add column creation_request_id uuid;
create unique index workspaces_creation_request on public.workspaces(owner_id, creation_request_id) where creation_request_id is not null;

create function leadflow_private.is_business_type(candidate text) returns boolean language sql immutable set search_path = '' as $$
  select candidate in ('Design studio','Development agency','Marketing agency','Freelancer','Consultancy','Other')
$$;

drop function public.list_workspaces();
create function public.list_workspaces() returns table (id uuid, name text, owner_id uuid, role text, revision bigint, created_at timestamptz, business_type text, timezone text)
language plpgsql security definer set search_path = '' as $$
declare actor uuid := leadflow_private.current_profile();
begin
  return query select w.id, w.name, w.owner_id, m.role, w.revision, w.created_at, s.business_type, s.timezone
    from public.workspaces w
    join public.workspace_memberships m on m.workspace_id = w.id
    join public.workspace_settings s on s.workspace_id = w.id
    where m.user_id = actor order by w.created_at, w.id;
end $$;

drop function public.create_workspace(text);
create function public.create_workspace(workspace_name text, business_type text default null, request_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := leadflow_private.current_profile(); clean_name text := btrim(workspace_name); existing public.workspaces; existing_type text; created uuid := gen_random_uuid();
begin
  if clean_name is null or length(clean_name) not between 1 and 100 or clean_name ~ '[[:cntrl:]]' then
    raise exception 'Workspace names must be 1 to 100 characters.' using errcode = '22023';
  end if;
  if business_type is not null and not leadflow_private.is_business_type(business_type) then
    raise exception 'Choose a listed business type.' using errcode = '22023';
  end if;
  -- The profile lock serializes this user's creations, so neither retries nor the limit can race.
  perform 1 from public.profiles where id = actor for update;
  if request_id is not null then
    select * into existing from public.workspaces w where w.owner_id = actor and w.creation_request_id = create_workspace.request_id;
    if found then
      select s.business_type into existing_type from public.workspace_settings s where s.workspace_id = existing.id;
      if existing.name <> clean_name or existing_type is distinct from create_workspace.business_type then
        raise exception 'This request already created a different workspace.' using errcode = '23505';
      end if;
      return existing.id;
    end if;
  end if;
  if (select count(*) from public.workspaces where owner_id = actor) >= 25 then
    raise exception 'You can own at most 25 workspaces.' using errcode = '54000';
  end if;
  insert into public.workspaces(id, owner_id, name, creation_request_id) values (created, actor, clean_name, request_id);
  update public.workspace_settings set business_type = create_workspace.business_type where workspace_id = created;
  return created;
end $$;

drop function public.update_workspace(uuid, text, text);
-- Null leaves a field unchanged; an empty business type clears it.
create function public.update_workspace(target_workspace uuid, workspace_name text default null, workspace_timezone text default null, workspace_business_type text default null) returns void
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
  if nullif(workspace_business_type, '') is not null and not leadflow_private.is_business_type(workspace_business_type) then
    raise exception 'Choose a listed business type.' using errcode = '22023';
  end if;
  update public.workspaces set name = clean_name where id = target_workspace and clean_name is not null;
  update public.workspace_settings set timezone = coalesce(workspace_timezone, timezone),
    business_type = case when workspace_business_type is null then business_type else nullif(workspace_business_type, '') end
    where workspace_id = target_workspace;
end $$;

-- Teammates' names, emails and roles, for members of the workspace only.
create function public.list_workspace_members(target_workspace uuid) returns table (user_id uuid, role text, display_name text, email text, joined_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return query select m.user_id, m.role, p.display_name, u.email::text, m.created_at
    from public.workspace_memberships m
    join public.profiles p on p.id = m.user_id
    join auth.users u on u.id = m.user_id
    where m.workspace_id = target_workspace
    order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.created_at, m.user_id;
end $$;

revoke all on function leadflow_private.is_business_type(text) from public, anon, authenticated;
revoke all on function public.list_workspaces(), public.create_workspace(text, text, uuid),
  public.update_workspace(uuid, text, text, text), public.list_workspace_members(uuid) from public, anon, authenticated;
grant execute on function public.list_workspaces(), public.create_workspace(text, text, uuid),
  public.update_workspace(uuid, text, text, text), public.list_workspace_members(uuid) to authenticated;
