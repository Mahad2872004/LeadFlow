-- Private per-user workspaces. All writes go through the transactional RPC.
create table public.workspaces (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0)
);
create table public.leads (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  id text not null check (length(btrim(id)) between 1 and 200),
  name text not null check (length(btrim(name)) between 1 and 150),
  email text not null check (length(email) <= 150 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  phone text not null check (phone = '' or (phone ~ '^[+0-9 ().-]{7,25}$' and length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 7)),
  company text not null check (length(company) <= 150),
  service text not null check (service in ('Website design','Web development','Brand identity','Consulting','Other')),
  source text not null check (source in ('Website','Referral','LinkedIn','Email','Other')),
  message text not null check (length(message) <= 2000),
  status text not null check (status in ('New','Contacted','Qualified','Converted','Lost')),
  "createdAt" timestamptz not null check (isfinite("createdAt")),
  primary key (owner_id, id)
);
create table public.follow_up_tasks (
  owner_id uuid not null,
  id text not null check (length(btrim(id)) between 1 and 200),
  "leadId" text not null,
  due date not null check (due between date '0001-01-01' and date '9999-12-31'),
  notes text not null check (length(btrim(notes)) between 1 and 2000),
  completed boolean not null,
  primary key (owner_id, id),
  foreign key (owner_id, "leadId") references public.leads(owner_id,id) on delete cascade
);
create table public.activity_history (
  owner_id uuid not null,
  id text not null check (length(btrim(id)) between 1 and 200),
  "leadId" text not null,
  text text not null check (length(btrim(text)) between 1 and 4000),
  at timestamptz not null check (isfinite(at)),
  primary key (owner_id,id),
  foreign key (owner_id,"leadId") references public.leads(owner_id,id) on delete cascade
);
create table public.workspace_requests (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  request_id uuid not null,
  payload_hash text not null,
  revision bigint not null,
  primary key(owner_id,request_id)
);
create index leads_status_source on public.leads(owner_id,status,source);
create index leads_created on public.leads(owner_id,"createdAt" desc);
create index tasks_due on public.follow_up_tasks(owner_id,completed,due);
create index tasks_lead on public.follow_up_tasks(owner_id,"leadId");
create index activity_lead_time on public.activity_history(owner_id,"leadId",at desc);

alter table public.workspaces enable row level security;
alter table public.leads enable row level security;
alter table public.follow_up_tasks enable row level security;
alter table public.activity_history enable row level security;
alter table public.workspace_requests enable row level security;
create policy own_workspace on public.workspaces for select to authenticated using ((select auth.uid()) = owner_id);
create policy own_leads on public.leads for select to authenticated using ((select auth.uid()) = owner_id);
create policy own_tasks on public.follow_up_tasks for select to authenticated using ((select auth.uid()) = owner_id);
create policy own_history on public.activity_history for select to authenticated using ((select auth.uid()) = owner_id);
create policy own_requests on public.workspace_requests for select to authenticated using ((select auth.uid()) = owner_id);
revoke all on public.workspaces, public.leads, public.follow_up_tasks, public.activity_history, public.workspace_requests from anon, authenticated;
grant select on public.workspaces, public.leads, public.follow_up_tasks, public.activity_history, public.workspace_requests to authenticated;

-- One statement provides a consistent read of all three collections and revision.
create function public.load_workspace() returns jsonb
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

-- Whole-workspace transaction keeps the existing M1 domain operations simple.
-- Explicit actor filters are mandatory: this definer function bypasses RLS.
create function public.save_workspace(payload jsonb, expected_revision bigint, request_id uuid) returns bigint
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
revoke all on function public.load_workspace() from public, anon;
revoke all on function public.save_workspace(jsonb,bigint,uuid) from public, anon;
grant execute on function public.load_workspace() to authenticated;
grant execute on function public.save_workspace(jsonb,bigint,uuid) to authenticated;
