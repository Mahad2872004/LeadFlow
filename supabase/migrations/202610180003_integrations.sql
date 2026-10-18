-- Workspace-scoped server integrations. Browser clients can read safe metadata only.
create table leadflow_private.integration_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  label text not null check(length(btrim(label)) between 1 and 80),
  provider text not null check(provider in ('webhook','zapier','make','n8n','sheets')),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  notification_from text not null check(length(notification_from) between 3 and 200 and notification_from !~ E'[\\r\\n]'),
  notification_to text not null check(notification_to ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table leadflow_private.integration_keys enable row level security;
revoke all on leadflow_private.integration_keys from public,anon,authenticated;
create index integration_keys_owner on leadflow_private.integration_keys(owner_id);
alter table leadflow_private.inquiries add column integration_id uuid references leadflow_private.integration_keys(id);
create index inquiries_integration on leadflow_private.inquiries(integration_id);

create function public.authorize_integration(key_hash text) returns boolean
language sql security definer set search_path='' as $$
 select exists(select 1 from leadflow_private.integration_keys where token_hash=key_hash and revoked_at is null);
$$;
create function public.receive_webhook(key_hash text, submission_id uuid, inquiry jsonb, email_hash text) returns uuid
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

create function public.integration_overview() returns jsonb
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
create function public.verify_integration_receipt(submission_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); result jsonb;
begin
 if actor is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception 'Sign in.' using errcode='42501'; end if;
 select jsonb_build_object('reference',i.request_id,'receivedAt',i.created_at,'channel',case when i.integration_id is null then 'Website' else 'Webhook' end)
 into result from leadflow_private.inquiries i join public.leads l on l.owner_id=i.owner_id and l.id=i.request_id::text where i.owner_id=actor and i.request_id=submission_id;
 if result is null then raise exception 'No matching inquiry exists in this workspace. Check the reference and destination account.' using errcode='P0002'; end if;
 return result;
end $$;
create function public.revoke_integration(credential_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception 'Sign in.' using errcode='42501'; end if;
 update leadflow_private.integration_keys set revoked_at=now() where id=credential_id and owner_id=auth.uid();
end $$;
revoke all on function public.authorize_integration(text),public.receive_webhook(text,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.authorize_integration(text),public.receive_webhook(text,uuid,jsonb,text) to service_role;
revoke all on function public.integration_overview(),public.verify_integration_receipt(uuid),public.revoke_integration(uuid) from public,anon;
grant execute on function public.integration_overview(),public.verify_integration_receipt(uuid),public.revoke_integration(uuid) to authenticated;
