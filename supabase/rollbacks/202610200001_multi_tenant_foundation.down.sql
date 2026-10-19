-- Reverses 202610200001_multi_tenant_foundation.sql. It lives outside supabase/migrations so `db push`
-- never runs it. Run the whole file at once (one transaction), then record the reversal with:
--   npx supabase migration repair --status reverted 202610200001
-- It refuses to run while data exists that the single-owner schema cannot represent. Profiles, workspace
-- names and settings, and receipt actor/timestamps have no single-owner equivalent and are dropped.
do $$
begin
  if exists (select 1 from public.workspaces where id <> owner_id)
    or exists (select 1 from public.workspace_memberships where role <> 'owner') then
    raise exception 'Rollback refused: shared or additional workspaces, memberships, or ownership transfers exist. Export and remove them deliberately first.';
  end if;
end $$;

drop function public.load_workspace_for(uuid), public.save_workspace_for(uuid, jsonb, bigint, uuid),
  public.integration_overview_for(uuid), public.verify_integration_receipt_for(uuid, uuid), public.revoke_integration_for(uuid, uuid),
  public.list_workspaces(), public.create_workspace(text), public.update_workspace(uuid, text, text),
  public.set_workspace_member(uuid, uuid, text), public.remove_workspace_member(uuid, uuid), public.leave_workspace(uuid),
  public.update_profile(text), public.receive_workspace_inquiry(uuid, text, uuid, jsonb, text, jsonb);
drop policy member_read on public.workspaces;
drop policy member_read on public.leads;
drop policy member_read on public.follow_up_tasks;
drop policy member_read on public.activity_history;
drop policy member_read on public.workspace_requests;
drop table public.workspace_settings, public.workspace_memberships;
drop trigger owner_membership_matches on public.workspaces;
drop trigger initialize_workspace on public.workspaces;
drop trigger touch_updated_at on public.workspaces;

alter table public.workspace_requests drop column actor_id, drop column created_at;
alter table public.workspace_requests rename column workspace_id to owner_id;
alter table public.leads rename column workspace_id to owner_id;
alter table public.follow_up_tasks rename column workspace_id to owner_id;
alter table public.activity_history rename column workspace_id to owner_id;
alter index leadflow_private.integration_keys_workspace rename to integration_keys_owner;
alter table leadflow_private.integration_keys drop constraint integration_keys_workspace_id_fkey;
alter table leadflow_private.integration_keys rename column workspace_id to owner_id;
alter table leadflow_private.integration_keys add constraint integration_keys_owner_id_fkey foreign key (owner_id) references auth.users(id) on delete cascade;
alter table leadflow_private.inquiries drop constraint inquiries_workspace_id_fkey;
alter table leadflow_private.inquiries rename column workspace_id to owner_id;
alter table leadflow_private.inquiries add constraint inquiries_owner_id_fkey foreign key (owner_id) references auth.users(id) on delete cascade;
alter table public.workspaces drop column owner_id, drop column name, drop column created_at, drop column updated_at;
alter table public.workspaces rename column id to owner_id;
alter table public.workspaces add constraint workspaces_owner_id_fkey foreign key (owner_id) references auth.users(id) on delete cascade;
drop table public.profiles;

create policy own_workspace on public.workspaces for select to authenticated using ((select auth.uid()) = owner_id);
create policy own_leads on public.leads for select to authenticated using ((select auth.uid()) = owner_id);
create policy own_tasks on public.follow_up_tasks for select to authenticated using ((select auth.uid()) = owner_id);
create policy own_history on public.activity_history for select to authenticated using ((select auth.uid()) = owner_id);
create policy own_requests on public.workspace_requests for select to authenticated using ((select auth.uid()) = owner_id);

-- Original function bodies from 202610180001, 202610180002 and 202610180003. Replacing keeps their grants.
create or replace function public.load_workspace() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb; actor uuid := auth.uid();
begin
  if actor is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception 'Sign in with an internal account.' using errcode = '42501'; end if;
  select jsonb_build_object('revision',coalesce((select revision from public.workspaces where owner_id=actor),0),
    'data',jsonb_build_object('version',1,
      'leads',coalesce((select jsonb_agg((to_jsonb(l)-'owner_id') || jsonb_build_object('createdAt',to_char(l."createdAt" at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by l."createdAt" desc,id) from public.leads l where owner_id=actor),'[]'::jsonb),
      'tasks',coalesce((select jsonb_agg(to_jsonb(t)-'owner_id' order by due,id) from public.follow_up_tasks t where owner_id=actor),'[]'::jsonb),
      'activities',coalesce((select jsonb_agg((to_jsonb(a)-'owner_id') || jsonb_build_object('at',to_char(a.at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by a.at desc,id) from public.activity_history a where owner_id=actor),'[]'::jsonb))) into result;
  return result;
end $$;
create or replace function public.save_workspace(payload jsonb, expected_revision bigint, request_id uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); current_revision bigint; receipt public.workspace_requests; fingerprint text;
begin
  if actor is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception 'Sign in with an internal account.' using errcode = '42501'; end if;
  if request_id is null or expected_revision is null then raise exception 'Missing request identity or revision.'; end if;
  if payload is null or payload->>'version' is distinct from '1'
    or jsonb_typeof(payload->'leads') is distinct from 'array'
    or jsonb_typeof(payload->'tasks') is distinct from 'array'
    or jsonb_typeof(payload->'activities') is distinct from 'array' then raise exception 'Invalid workspace data.'; end if;
  if octet_length(payload::text)>5000000 or jsonb_array_length(payload->'leads')>5000
    or jsonb_array_length(payload->'tasks')>10000 or jsonb_array_length(payload->'activities')>20000 then raise exception 'Workspace is too large (5 MB maximum).'; end if;
  fingerprint := md5(payload::text || ':' || expected_revision::text);
  insert into public.workspaces(owner_id) values(actor) on conflict do nothing;
  select revision into current_revision from public.workspaces where owner_id=actor for update;
  select * into receipt from public.workspace_requests r where r.owner_id=actor and r.request_id=save_workspace.request_id;
  if found then
    if receipt.payload_hash <> fingerprint then raise exception 'Request ID already used for different data.'; end if;
    return receipt.revision;
  end if;
  if current_revision <> expected_revision then raise exception 'Workspace changed in another session. Reload the workspace before trying again.' using errcode='40001'; end if;
  delete from public.leads where owner_id=actor;
  insert into public.leads
    select actor,x.id,x.name,x.email,x.phone,x.company,x.service,x.source,x.message,x.status,x."createdAt"
    from jsonb_to_recordset(payload->'leads') as x(id text,name text,email text,phone text,company text,service text,source text,message text,status text,"createdAt" timestamptz);
  insert into public.follow_up_tasks
    select actor,x.id,x."leadId",x.due,x.notes,x.completed
    from jsonb_to_recordset(payload->'tasks') as x(id text,"leadId" text,due date,notes text,completed boolean);
  insert into public.activity_history
    select actor,x.id,x."leadId",x.text,x.at
    from jsonb_to_recordset(payload->'activities') as x(id text,"leadId" text,text text,at timestamptz);
  update public.workspaces set revision=revision+1 where owner_id=actor returning revision into current_revision;
  insert into public.workspace_requests values(actor,request_id,fingerprint,current_revision);
  return current_revision;
end $$;
create or replace function public.receive_inquiry(target_owner uuid, website_id text, submission_id uuid, inquiry jsonb, email_hash text, notification jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare fingerprint text; prior leadflow_private.inquiries;
begin
  if submission_id is null or target_owner is null or website_id is null or website_id !~ '^[a-z0-9-]{1,64}$'
    or inquiry is null or octet_length(inquiry::text)>12000
    or length(btrim(coalesce(inquiry->>'message',''))) not between 1 and 2000
    or email_hash is null or length(email_hash)<>64
    or notification is null or jsonb_typeof(notification) <> 'object' then raise exception 'Invalid inquiry.' using errcode='22023'; end if;
  fingerprint:=md5(inquiry::text || website_id || target_owner::text);
  insert into public.workspaces(owner_id) values(target_owner) on conflict do nothing;
  perform 1 from public.workspaces where owner_id=target_owner for update;
  select * into prior from leadflow_private.inquiries where request_id=submission_id;
  if found then
    if prior.payload_hash<>fingerprint then raise exception 'Submission ID already used.' using errcode='23505'; end if;
    return submission_id;
  end if;
  if (select count(*) from leadflow_private.inquiries where owner_id=target_owner and website=website_id and created_at>now()-interval '24 hours')>=50
    or (select count(*) from leadflow_private.inquiries i where owner_id=target_owner and website=website_id and i.email_hash=receive_inquiry.email_hash and created_at>now()-interval '1 hour')>=5
    then raise exception 'Inquiry rate limit reached.' using errcode='P0429'; end if;
  insert into public.leads(owner_id,id,name,email,phone,company,service,source,message,status,"createdAt")
    values(target_owner,submission_id::text,inquiry->>'name',inquiry->>'email',inquiry->>'phone',inquiry->>'company',inquiry->>'service','Website',inquiry->>'message','New',now());
  insert into public.activity_history(owner_id,id,"leadId",text,at)
    values(target_owner,gen_random_uuid()::text,submission_id::text,'Website inquiry received (' || website_id || ')',now());
  insert into leadflow_private.inquiries(request_id,owner_id,website,payload_hash,email_hash)
    values(submission_id,target_owner,website_id,fingerprint,email_hash);
  insert into leadflow_private.notification_outbox(request_id,email) values(submission_id,notification);
  update public.workspaces set revision=revision+1 where owner_id=target_owner;
  return submission_id;
end $$;
create or replace function public.receive_webhook(key_hash text, submission_id uuid, inquiry jsonb, email_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare credential leadflow_private.integration_keys; existed boolean; notification jsonb;
begin
 select * into credential from leadflow_private.integration_keys where token_hash=key_hash and revoked_at is null for update;
 if not found then raise exception 'Invalid credential.' using errcode='28000'; end if;
 insert into public.workspaces(owner_id) values(credential.owner_id) on conflict do nothing;
 perform 1 from public.workspaces where owner_id=credential.owner_id for update;
 existed:=exists(select 1 from leadflow_private.inquiries where request_id=submission_id);
 if not existed and (select count(*) from leadflow_private.inquiries where owner_id=credential.owner_id and created_at>now()-interval '24 hours')>=50 then
   raise exception 'Workspace inquiry quota reached.' using errcode='P0429';
 end if;
 notification:=jsonb_build_object('from',credential.notification_from,'to',jsonb_build_array(credential.notification_to),
 'subject','New integration inquiry · ' || (inquiry->>'service'),
 'text','A new inquiry was saved in LeadFlow.' || E'\nName: ' || (inquiry->>'name') || E'\nEmail: ' || (inquiry->>'email') || E'\nCompany: ' || coalesce(inquiry->>'company','') || E'\nService: ' || (inquiry->>'service') || E'\nIntegration: ' || credential.label || E'\nReference: ' || submission_id::text || E'\nSign in to LeadFlow for the full inquiry.');
 perform public.receive_inquiry(credential.owner_id,'hook-' || credential.id::text,submission_id,inquiry,email_hash,notification);
 if not existed then
   update public.leads set source='Other' where owner_id=credential.owner_id and id=submission_id::text;
   update public.activity_history set text='Integration inquiry received (' || credential.label || ')' where owner_id=credential.owner_id and "leadId"=submission_id::text;
   update leadflow_private.inquiries set integration_id=credential.id where request_id=submission_id;
 end if;
 update leadflow_private.integration_keys set last_used_at=now() where id=credential.id;
 return submission_id;
end $$;
create or replace function public.integration_overview() returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); result jsonb;
begin
 if actor is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception 'Sign in.' using errcode='42501'; end if;
 select jsonb_build_object(
 'credentials',coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'provider',provider,'revoked',revoked_at is not null,'lastUsedAt',last_used_at) order by created_at desc) from leadflow_private.integration_keys where owner_id=actor),'[]'::jsonb),
 'websiteLastReceivedAt',(select max(created_at) from leadflow_private.inquiries where owner_id=actor and integration_id is null),
 'email',jsonb_build_object('accepted',(select count(*) from leadflow_private.notification_outbox o join leadflow_private.inquiries i using(request_id) where i.owner_id=actor and o.status='accepted'),
 'attention',(select count(*) from leadflow_private.notification_outbox o join leadflow_private.inquiries i using(request_id) where i.owner_id=actor and o.status in ('failed','uncertain')),
 'pending',(select count(*) from leadflow_private.notification_outbox o join leadflow_private.inquiries i using(request_id) where i.owner_id=actor and o.status in ('pending','sending')))) into result;
 return result;
end $$;
create or replace function public.verify_integration_receipt(submission_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); result jsonb;
begin
 if actor is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception 'Sign in.' using errcode='42501'; end if;
 select jsonb_build_object('reference',i.request_id,'receivedAt',i.created_at,'channel',case when i.integration_id is null then 'Website' else 'Webhook' end)
 into result from leadflow_private.inquiries i join public.leads l on l.owner_id=i.owner_id and l.id=i.request_id::text where i.owner_id=actor and i.request_id=submission_id;
 if result is null then raise exception 'No matching inquiry exists in this workspace. Check the reference and destination account.' using errcode='P0002'; end if;
 return result;
end $$;
create or replace function public.revoke_integration(credential_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception 'Sign in.' using errcode='42501'; end if;
 update leadflow_private.integration_keys set revoked_at=now() where id=credential_id and owner_id=auth.uid();
end $$;

drop function leadflow_private.transfer_workspace_ownership(uuid, uuid), leadflow_private.personal_workspace(),
  leadflow_private.current_profile(), leadflow_private.require_role(uuid, text[], boolean),
  leadflow_private.visible_profile_ids(), leadflow_private.member_workspace_ids(), leadflow_private.valid_actor(),
  leadflow_private.check_workspace_owner(), leadflow_private.initialize_workspace(), leadflow_private.touch_updated_at();
