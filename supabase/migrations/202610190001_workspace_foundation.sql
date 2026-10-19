-- Multi-workspace foundation. Apply after 202610180003; no rows are discarded.
-- Legacy workspace IDs remain equal to the original Auth user UUID.
-- Run as one transaction (the Supabase migration runner does this); see the runbook.
begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check(length(display_name)<=150),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.profiles(id) select id from auth.users;
-- Also cover users whose only records were private credentials/receipts.
insert into public.workspaces(owner_id) select id from auth.users on conflict do nothing;
alter table public.workspaces rename column owner_id to id;
alter table public.workspaces drop constraint workspaces_owner_id_fkey;
alter table public.workspaces add column owner_id uuid references public.profiles(id) on delete restrict;
update public.workspaces set owner_id=id;
alter table public.workspaces alter column owner_id set not null;
alter table public.workspaces add column name text not null default 'Personal workspace' check(length(btrim(name)) between 1 and 100);
alter table public.workspaces add column created_at timestamptz not null default now();
alter table public.workspaces add column updated_at timestamptz not null default now();
create index workspaces_owner on public.workspaces(owner_id);

alter table public.leads rename column owner_id to workspace_id;
alter table public.follow_up_tasks rename column owner_id to workspace_id;
alter table public.activity_history rename column owner_id to workspace_id;
alter table public.workspace_requests rename column owner_id to workspace_id;
alter table leadflow_private.inquiries rename column owner_id to workspace_id;
alter table leadflow_private.inquiries drop constraint inquiries_owner_id_fkey;
alter table leadflow_private.inquiries add foreign key(workspace_id) references public.workspaces(id) on delete restrict;
alter table leadflow_private.integration_keys rename column owner_id to workspace_id;
alter table leadflow_private.integration_keys drop constraint integration_keys_owner_id_fkey;
alter table leadflow_private.integration_keys add foreign key(workspace_id) references public.workspaces(id) on delete restrict;

create table public.workspace_memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check(role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(workspace_id,user_id)
);
create index memberships_user on public.workspace_memberships(user_id,workspace_id);
create unique index memberships_one_owner on public.workspace_memberships(workspace_id) where role='owner';
insert into public.workspace_memberships(workspace_id,user_id,role) select id,owner_id,'owner' from public.workspaces;
-- A workspace cannot commit without its owner's membership.
alter table public.workspaces add constraint workspace_owner_membership foreign key(id,owner_id)
  references public.workspace_memberships(workspace_id,user_id) deferrable initially deferred;

create table public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  timezone text not null default 'UTC' check(length(timezone) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.workspace_settings(workspace_id) select id from public.workspaces;

-- Outbox rows inherit an immutable workspace through their required inquiry FK.
-- request_limits is global operational throttling, not customer-owned data.
create function leadflow_private.valid_actor() returns uuid language sql stable security definer set search_path='' as $$
 select case when coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then null else auth.uid() end;
$$;
create function leadflow_private.has_role(target_workspace uuid, allowed_roles text[] default array['owner','admin','member'])
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.workspace_memberships where workspace_id=target_workspace
   and user_id=leadflow_private.valid_actor() and role=any(allowed_roles));
$$;
-- Lock the workspace before checking membership so removals and writes serialize.
create function leadflow_private.require_role(target_workspace uuid, allowed_roles text[] default array['owner','admin','member'])
returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.workspaces where id=target_workspace for update;
 if not leadflow_private.has_role(target_workspace,allowed_roles) then
   raise exception 'Workspace access denied.' using errcode='42501';
 end if;
end $$;

create function leadflow_private.guard_membership() returns trigger language plpgsql security definer set search_path='' as $$
declare workspace_owner uuid;
begin
 select owner_id into workspace_owner from public.workspaces where id=new.workspace_id;
 if (new.role='owner') is distinct from (new.user_id=workspace_owner) then
   raise exception 'Owner membership must match workspace ownership.' using errcode='23514';
 end if;
 new.updated_at:=now(); return new;
end $$;
create trigger membership_guard before insert or update on public.workspace_memberships
 for each row execute function leadflow_private.guard_membership();
create function leadflow_private.guard_workspace() returns trigger language plpgsql set search_path='' as $$
begin
 if new.id<>old.id or new.owner_id<>old.owner_id then raise exception 'Workspace ownership is immutable.' using errcode='42501'; end if;
 new.updated_at:=now(); return new;
end $$;
create trigger workspace_guard before update on public.workspaces for each row execute function leadflow_private.guard_workspace();
create function leadflow_private.initialize_workspace() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.workspace_memberships(workspace_id,user_id,role) values(new.id,new.owner_id,'owner');
 insert into public.workspace_settings(workspace_id) values(new.id);
 return new;
end $$;
create trigger initialize_workspace after insert on public.workspaces for each row execute function leadflow_private.initialize_workspace();
create function leadflow_private.initialize_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
 -- Do not trust user metadata for identity, role, or workspace membership.
 insert into public.profiles(id) values(new.id);
 insert into public.workspaces(id,owner_id) values(new.id,new.id);
 return new;
end $$;
create trigger leadflow_initialize_user after insert on auth.users for each row execute function leadflow_private.initialize_user();

alter table public.profiles enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_settings enable row level security;
drop policy own_workspace on public.workspaces;
drop policy own_leads on public.leads;
drop policy own_tasks on public.follow_up_tasks;
drop policy own_history on public.activity_history;
drop policy own_requests on public.workspace_requests;
create policy member_workspaces on public.workspaces for select to authenticated using(leadflow_private.has_role(id));
create policy member_leads on public.leads for select to authenticated using(leadflow_private.has_role(workspace_id));
create policy member_tasks on public.follow_up_tasks for select to authenticated using(leadflow_private.has_role(workspace_id));
create policy member_history on public.activity_history for select to authenticated using(leadflow_private.has_role(workspace_id));
create policy member_requests on public.workspace_requests for select to authenticated using(leadflow_private.has_role(workspace_id));
create policy member_memberships on public.workspace_memberships for select to authenticated using(leadflow_private.has_role(workspace_id));
create policy member_settings on public.workspace_settings for select to authenticated using(leadflow_private.has_role(workspace_id));
create policy own_profile on public.profiles for select to authenticated using(id=leadflow_private.valid_actor());
revoke all on public.profiles,public.workspace_memberships,public.workspace_settings from public,anon,authenticated;
grant select on public.profiles,public.workspace_memberships,public.workspace_settings to authenticated;
-- Helpers used by policies expose only a boolean/current identity; all other private
-- functions and all private tables remain inaccessible. Keep schema out of PostgREST.
grant usage on schema leadflow_private to authenticated;
revoke all on all functions in schema leadflow_private from public,anon,authenticated;
grant execute on function leadflow_private.has_role(uuid,text[]),leadflow_private.valid_actor() to authenticated;

create function public.create_workspace(workspace_name text) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=leadflow_private.valid_actor(); result uuid:=gen_random_uuid();
begin
 if actor is null then raise exception 'Sign in with an internal account.' using errcode='42501'; end if;
 insert into public.workspaces(id,owner_id,name) values(result,actor,btrim(workspace_name));
 return result;
end $$;
create function public.list_workspaces() returns jsonb language sql security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'ownerId',w.owner_id,'role',m.role,'revision',w.revision) order by w.created_at,w.id),'[]'::jsonb)
 from public.workspaces w join public.workspace_memberships m on m.workspace_id=w.id and m.user_id=auth.uid();
$$;
create function public.set_workspace_member(target_workspace uuid, target_user uuid, member_role text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform leadflow_private.require_role(target_workspace,array['owner']);
 if member_role is null or member_role not in ('admin','member') or target_user is null
   or target_user=(select owner_id from public.workspaces where id=target_workspace) then
   raise exception 'Cannot assign or change an owner membership.' using errcode='42501'; end if;
 insert into public.workspace_memberships(workspace_id,user_id,role) values(target_workspace,target_user,member_role)
 on conflict(workspace_id,user_id) do update set role=excluded.role;
end $$;
create function public.remove_workspace_member(target_workspace uuid, target_user uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform leadflow_private.require_role(target_workspace,array['owner']);
 if target_user=(select owner_id from public.workspaces where id=target_workspace) then
   raise exception 'Cannot remove workspace owner.' using errcode='42501'; end if;
 delete from public.workspace_memberships where workspace_id=target_workspace and user_id=target_user;
end $$;
create function public.update_workspace_settings(target_workspace uuid, workspace_name text, workspace_timezone text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform leadflow_private.require_role(target_workspace,array['owner','admin']);
 if workspace_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=workspace_timezone) then
   raise exception 'Invalid timezone.' using errcode='22023'; end if;
 update public.workspaces set name=btrim(workspace_name) where id=target_workspace;
 update public.workspace_settings set timezone=workspace_timezone,updated_at=now() where workspace_id=target_workspace;
end $$;
create function public.update_profile(profile_name text) returns void language plpgsql security definer set search_path='' as $$
begin
 if leadflow_private.valid_actor() is null then raise exception 'Sign in.' using errcode='42501'; end if;
 update public.profiles set display_name=btrim(profile_name),updated_at=now() where id=leadflow_private.valid_actor();
end $$;

revoke all on function public.create_workspace(text),public.list_workspaces(),public.set_workspace_member(uuid,uuid,text),
 public.remove_workspace_member(uuid,uuid),public.update_workspace_settings(uuid,text,text),public.update_profile(text) from public,anon,authenticated;
grant execute on function public.create_workspace(text),public.list_workspaces(),public.set_workspace_member(uuid,uuid,text),
 public.remove_workspace_member(uuid,uuid),public.update_workspace_settings(uuid,text,text),public.update_profile(text) to authenticated;

-- Workspace-specific data and intake functions follow; compatibility wrappers keep
-- older dashboards and deployed Edge Functions on their original personal workspace.

create function public.load_workspace_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb; actor uuid := target_workspace;
begin
  perform leadflow_private.require_role(actor);
  select jsonb_build_object('revision',coalesce((select revision from public.workspaces where id=actor),0),
    'data',jsonb_build_object('version',1,
      'leads',coalesce((select jsonb_agg((to_jsonb(l)-'workspace_id') || jsonb_build_object('createdAt',to_char(l."createdAt" at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by l."createdAt" desc,id) from public.leads l where workspace_id=actor),'[]'::jsonb),
      'tasks',coalesce((select jsonb_agg(to_jsonb(t)-'workspace_id' order by due,id) from public.follow_up_tasks t where workspace_id=actor),'[]'::jsonb),
      'activities',coalesce((select jsonb_agg((to_jsonb(a)-'workspace_id') || jsonb_build_object('at',to_char(a.at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by a.at desc,id) from public.activity_history a where workspace_id=actor),'[]'::jsonb))) into result;
  return result;
end $$;

create function public.save_workspace_for(target_workspace uuid, payload jsonb, expected_revision bigint, request_id uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare actor uuid := target_workspace; current_revision bigint; receipt public.workspace_requests; fingerprint text;
begin
  perform leadflow_private.require_role(actor);
  if request_id is null or expected_revision is null then raise exception 'Missing request identity or revision.'; end if;
  if payload is null or payload->>'version' is distinct from '1'
    or jsonb_typeof(payload->'leads') is distinct from 'array'
    or jsonb_typeof(payload->'tasks') is distinct from 'array'
    or jsonb_typeof(payload->'activities') is distinct from 'array' then raise exception 'Invalid workspace data.'; end if;
  if octet_length(payload::text)>5000000 or jsonb_array_length(payload->'leads')>5000
    or jsonb_array_length(payload->'tasks')>10000 or jsonb_array_length(payload->'activities')>20000 then raise exception 'Workspace is too large (5 MB maximum).'; end if;
  fingerprint := md5(payload::text || ':' || expected_revision::text);
  select revision into current_revision from public.workspaces where id=actor for update;
  select * into receipt from public.workspace_requests r where r.workspace_id=actor and r.request_id=save_workspace_for.request_id;
  if found then
    if receipt.payload_hash <> fingerprint then raise exception 'Request ID already used for different data.'; end if;
    return receipt.revision;
  end if;
  if current_revision <> expected_revision then raise exception 'Workspace changed in another session. Reload the workspace before trying again.' using errcode='40001'; end if;
  delete from public.leads where workspace_id=actor;
  insert into public.leads
    select actor,x.id,x.name,x.email,x.phone,x.company,x.service,x.source,x.message,x.status,x."createdAt"
    from jsonb_to_recordset(payload->'leads') as x(id text,name text,email text,phone text,company text,service text,source text,message text,status text,"createdAt" timestamptz);
  insert into public.follow_up_tasks
    select actor,x.id,x."leadId",x.due,x.notes,x.completed
    from jsonb_to_recordset(payload->'tasks') as x(id text,"leadId" text,due date,notes text,completed boolean);
  insert into public.activity_history
    select actor,x.id,x."leadId",x.text,x.at
    from jsonb_to_recordset(payload->'activities') as x(id text,"leadId" text,text text,at timestamptz);
  update public.workspaces set revision=revision+1 where id=actor returning revision into current_revision;
  insert into public.workspace_requests values(actor,request_id,fingerprint,current_revision);
  return current_revision;
end $$;

create function public.receive_inquiry_for_workspace(target_workspace uuid, website_id text, submission_id uuid, inquiry jsonb, email_hash text, notification jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare fingerprint text; prior leadflow_private.inquiries;
begin
  if submission_id is null or target_workspace is null or website_id is null or website_id !~ '^[a-z0-9-]{1,64}$'
    or inquiry is null or octet_length(inquiry::text)>12000
    or length(btrim(coalesce(inquiry->>'message',''))) not between 1 and 2000
    or email_hash is null or length(email_hash)<>64
    or notification is null or jsonb_typeof(notification) <> 'object' then raise exception 'Invalid inquiry.' using errcode='22023'; end if;
  fingerprint:=md5(inquiry::text || website_id || target_workspace::text);
  perform 1 from public.workspaces where id=target_workspace for update;
  if not found then raise exception 'Unknown inquiry workspace.' using errcode='23503'; end if;
  select * into prior from leadflow_private.inquiries where request_id=submission_id;
  if found then
    if prior.payload_hash<>fingerprint then raise exception 'Submission ID already used.' using errcode='23505'; end if;
    return submission_id;
  end if;
  -- Atomic quotas, independent of spoofable client IP headers. Retries do not consume quota.
  if (select count(*) from leadflow_private.inquiries where workspace_id=target_workspace and website=website_id and created_at>now()-interval '24 hours')>=50
    or (select count(*) from leadflow_private.inquiries i where workspace_id=target_workspace and website=website_id and i.email_hash=receive_inquiry_for_workspace.email_hash and created_at>now()-interval '1 hour')>=5
    then raise exception 'Inquiry rate limit reached.' using errcode='P0429'; end if;
  insert into public.leads(workspace_id,id,name,email,phone,company,service,source,message,status,"createdAt")
    values(target_workspace,submission_id::text,inquiry->>'name',inquiry->>'email',inquiry->>'phone',inquiry->>'company',inquiry->>'service','Website',inquiry->>'message','New',now());
  insert into public.activity_history(workspace_id,id,"leadId",text,at)
    values(target_workspace,gen_random_uuid()::text,submission_id::text,'Website inquiry received (' || website_id || ')',now());
  insert into leadflow_private.inquiries(request_id,workspace_id,website,payload_hash,email_hash)
    values(submission_id,target_workspace,website_id,fingerprint,email_hash);
  insert into leadflow_private.notification_outbox(request_id,email) values(submission_id,notification);
  update public.workspaces set revision=revision+1 where id=target_workspace;
  return submission_id;
end $$;

create or replace function public.receive_webhook(key_hash text, submission_id uuid, inquiry jsonb, email_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare credential leadflow_private.integration_keys; existed boolean; notification jsonb;
begin
 select * into credential from leadflow_private.integration_keys where token_hash=key_hash and revoked_at is null for update;
 if not found then raise exception 'Invalid credential.' using errcode='28000'; end if;
 perform 1 from public.workspaces where id=credential.workspace_id for update;
 existed:=exists(select 1 from leadflow_private.inquiries where request_id=submission_id);
 if not existed and (select count(*) from leadflow_private.inquiries where workspace_id=credential.workspace_id and created_at>now()-interval '24 hours')>=50 then
   raise exception 'Workspace inquiry quota reached.' using errcode='P0429';
 end if;
 notification:=jsonb_build_object('from',credential.notification_from,'to',jsonb_build_array(credential.notification_to),
 'subject','New integration inquiry · ' || (inquiry->>'service'),
 'text','A new inquiry was saved in LeadFlow.' || E'\nName: ' || (inquiry->>'name') || E'\nEmail: ' || (inquiry->>'email') || E'\nCompany: ' || coalesce(inquiry->>'company','') || E'\nService: ' || (inquiry->>'service') || E'\nIntegration: ' || credential.label || E'\nReference: ' || submission_id::text || E'\nSign in to LeadFlow for the full inquiry.');
 perform public.receive_inquiry_for_workspace(credential.workspace_id,'hook-' || credential.id::text,submission_id,inquiry,email_hash,notification);
 if not existed then
   update public.leads set source='Other' where workspace_id=credential.workspace_id and id=submission_id::text;
   update public.activity_history set text='Integration inquiry received (' || credential.label || ')' where workspace_id=credential.workspace_id and "leadId"=submission_id::text;
   update leadflow_private.inquiries set integration_id=credential.id where request_id=submission_id;
 end if;
 update leadflow_private.integration_keys set last_used_at=now() where id=credential.id;
 return submission_id;
end $$;

create function public.integration_overview_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=target_workspace; result jsonb;
begin
 perform leadflow_private.require_role(actor);
 select jsonb_build_object(
 'credentials',coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'provider',provider,'revoked',revoked_at is not null,'lastUsedAt',last_used_at) order by created_at desc) from leadflow_private.integration_keys where workspace_id=actor),'[]'::jsonb),
 'websiteLastReceivedAt',(select max(created_at) from leadflow_private.inquiries where workspace_id=actor and integration_id is null),
 'email',jsonb_build_object('accepted',(select count(*) from leadflow_private.notification_outbox o join leadflow_private.inquiries i using(request_id) where i.workspace_id=actor and o.status='accepted'),
 'attention',(select count(*) from leadflow_private.notification_outbox o join leadflow_private.inquiries i using(request_id) where i.workspace_id=actor and o.status in ('failed','uncertain')),
 'pending',(select count(*) from leadflow_private.notification_outbox o join leadflow_private.inquiries i using(request_id) where i.workspace_id=actor and o.status in ('pending','sending')))) into result;
 return result;
end $$;

create function public.verify_integration_receipt_for(target_workspace uuid, submission_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=target_workspace; result jsonb;
begin
 perform leadflow_private.require_role(actor);
 select jsonb_build_object('reference',i.request_id,'receivedAt',i.created_at,'channel',case when i.integration_id is null then 'Website' else 'Webhook' end)
 into result from leadflow_private.inquiries i join public.leads l on l.workspace_id=i.workspace_id and l.id=i.request_id::text where i.workspace_id=actor and i.request_id=submission_id;
 if result is null then raise exception 'No matching inquiry exists in this workspace. Check the reference and destination account.' using errcode='P0002'; end if;
 return result;
end $$;
