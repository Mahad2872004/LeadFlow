-- Additive M3 migration. No existing records, grants, or RLS policies are changed.
create schema if not exists leadflow_private;
revoke all on schema leadflow_private from public,anon,authenticated;
create table leadflow_private.inquiries (
  request_id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  website text not null check (website ~ '^[a-z0-9-]{1,64}$'),
  payload_hash text not null,
  email_hash text not null,
  created_at timestamptz not null default now()
);
create index inquiries_quota on leadflow_private.inquiries(owner_id,website,created_at);
create index inquiries_email on leadflow_private.inquiries(owner_id,website,email_hash,created_at);
-- No FK to leads: M2 replaces lead rows during saves. Receipts/outbox must survive.
create table leadflow_private.notification_outbox (
  request_id uuid primary key references leadflow_private.inquiries(request_id) on delete cascade,
  email jsonb not null,
  status text not null default 'pending' check (status in ('pending','sending','accepted','failed','uncertain')),
  attempts integer not null default 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  provider_id text,
  last_error text,
  updated_at timestamptz not null default now()
);
create index outbox_ready on leadflow_private.notification_outbox(status,next_attempt_at);
create table leadflow_private.request_limits (
  bucket text not null,
  minute timestamptz not null,
  hits integer not null,
  primary key(bucket,minute)
);
alter table leadflow_private.inquiries enable row level security;
alter table leadflow_private.notification_outbox enable row level security;
alter table leadflow_private.request_limits enable row level security;
-- Intentionally no client policies: these tables are accessible only via service RPCs.
revoke all on all tables in schema leadflow_private from public,anon,authenticated;

create function public.inquiry_rate_limit(bucket_key text) returns boolean
language plpgsql security definer set search_path='' as $$
declare hit_count integer;
begin
  delete from leadflow_private.request_limits where minute < now()-interval '2 days';
  insert into leadflow_private.request_limits values(bucket_key,date_trunc('minute',now()),1)
  on conflict(bucket,minute) do update set hits=leadflow_private.request_limits.hits+1 returning hits into hit_count;
  return hit_count<=60;
end $$;

create function public.receive_inquiry(target_owner uuid, website_id text, submission_id uuid, inquiry jsonb, email_hash text, notification jsonb) returns uuid
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
  -- Atomic quotas, independent of spoofable client IP headers. Retries do not consume quota.
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

create function public.claim_notification(submission_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item leadflow_private.notification_outbox;
begin
  -- Resend deduplicates for 24 hours. Stop before expiry if acceptance is uncertain.
  update leadflow_private.notification_outbox set status='uncertain',last_error='Retry window expired; reconcile with Resend before resending.',updated_at=now()
    where status in ('pending','sending') and first_attempt_at<now()-interval '23 hours';
  select * into item from leadflow_private.notification_outbox
    where status in ('pending','sending') and next_attempt_at<=now()
    and (submission_id is null or request_id=submission_id)
    order by next_attempt_at for update skip locked limit 1;
  if not found then return null; end if;
  update leadflow_private.notification_outbox set status='sending',attempts=attempts+1,
    first_attempt_at=coalesce(first_attempt_at,now()),next_attempt_at=now()+interval '2 minutes',
    lease_id=gen_random_uuid(),updated_at=now()
    where request_id=item.request_id returning * into item;
  return jsonb_build_object('request_id',item.request_id,'email',item.email,'lease_id',item.lease_id);
end $$;

create function public.finish_notification(submission_id uuid, lease uuid, outcome text, provider_reference text default null, failure_code text default null) returns void
language plpgsql security definer set search_path='' as $$
begin
  if outcome not in ('accepted','pending','failed') then raise exception 'Invalid notification outcome.'; end if;
  update leadflow_private.notification_outbox set status=outcome,provider_id=provider_reference,
    last_error=left(failure_code,200),next_attempt_at=now()+make_interval(secs=>least(3600,60*power(2,least(attempts,6)))::integer),updated_at=now()
    where request_id=submission_id and lease_id=lease and status='sending';
end $$;
revoke all on function public.inquiry_rate_limit(text) from public,anon,authenticated;
revoke all on function public.receive_inquiry(uuid,text,uuid,jsonb,text,jsonb) from public,anon,authenticated;
revoke all on function public.claim_notification(uuid) from public,anon,authenticated;
revoke all on function public.finish_notification(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.inquiry_rate_limit(text) to service_role;
grant execute on function public.receive_inquiry(uuid,text,uuid,jsonb,text,jsonb) to service_role;
grant execute on function public.claim_notification(uuid) to service_role;
grant execute on function public.finish_notification(uuid,uuid,text,text,text) to service_role;
