-- Reverses 202610200002_workspace_onboarding.sql. Run it before the foundation rollback, as one batch, then:
--   npx supabase migration repair --status reverted 202610200002
-- Business types are dropped. Workspaces created during onboarding remain.
drop function public.list_workspace_members(uuid), public.create_workspace(text, text, uuid),
  public.update_workspace(uuid, text, text, text), public.list_workspaces(), leadflow_private.is_business_type(text);
drop index public.workspaces_creation_request;
alter table public.workspaces drop column creation_request_id;
alter table public.workspace_settings drop column business_type;

-- Definitions from 202610200001_multi_tenant_foundation.sql.
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
  perform 1 from public.profiles where id = actor for update;
  if (select count(*) from public.workspaces where owner_id = actor) >= 25 then
    raise exception 'You can own at most 25 workspaces.' using errcode = '54000';
  end if;
  insert into public.workspaces(id, owner_id, name) values (created, actor, clean_name);
  return created;
end $$;
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
revoke all on function public.list_workspaces(), public.create_workspace(text), public.update_workspace(uuid, text, text) from public, anon, authenticated;
grant execute on function public.list_workspaces(), public.create_workspace(text), public.update_workspace(uuid, text, text) to authenticated;
