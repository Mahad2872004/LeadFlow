-- M12: client collaboration and approvals.
--
-- Client people get their own Supabase Auth accounts (marked app_metadata.account_type = 'client' when an invitation
-- creates them) and reach a dedicated portal (/portal) through functions prefixed hub_. Every hub_ function finds the
-- caller's active client access row for the record's client, then checks project access, the client role and what the
-- agency explicitly shared. Internal functions keep refusing them: they aren't workspace members, and client accounts
-- can't create workspaces. M12 extends M10/M11 (clients, projects, milestones, deliverables, client_documents,
-- client_activities) instead of duplicating them. The M10 onboarding link portal is unchanged, except that it never
-- shows project files.

-- ---------- Client access ----------

create table leadflow_private.client_users (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null check (length(email) between 3 and 254),
  name text not null default '' check (length(name) <= 150 and name !~ '[[:cntrl:]]'),
  -- admin: every shared project, decisions, uploads. member: comments, feedback, uploads. reviewer: feedback and decisions.
  role text not null check (role in ('admin','member','reviewer')),
  project_access text not null default 'all' check (project_access in ('all','selected')),
  status text not null default 'active' check (status in ('active','revoked')),
  -- Events the person gets by email; in-app notifications are always kept.
  email_events jsonb not null default '["project_shared","review_requested","review_resubmitted","feedback_reply","comment_added","update_published","file_shared"]'
    check (jsonb_typeof(email_events) = 'array' and jsonb_array_length(email_events) <= 20),
  invitation_id uuid,
  activated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete set null,
  last_seen_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (client_id, user_id),
  check ((status = 'revoked') = (revoked_at is not null)),
  check (role <> 'admin' or project_access = 'all'),
  foreign key (workspace_id, client_id) references leadflow_private.clients(workspace_id, id) on delete cascade
);
create index client_users_user on leadflow_private.client_users(user_id, status);

-- Projects a client person with "selected" access may open (the project must still be shared).
create table leadflow_private.client_user_projects (
  client_user_id uuid not null references leadflow_private.client_users(id) on delete cascade,
  project_id uuid not null references leadflow_private.projects(id) on delete cascade,
  primary key (client_user_id, project_id)
);
create index client_user_projects_project on leadflow_private.client_user_projects(project_id);

-- Single-use invitations. Only the SHA-256 of the token is stored; the token is shown once (and kept in the email outbox
-- until that email's outcome is final). Expired = pending and past expires_at.
create table leadflow_private.client_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id uuid not null,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  name text not null default '' check (length(name) <= 150 and name !~ '[[:cntrl:]]'),
  role text not null check (role in ('admin','member','reviewer')),
  project_access text not null default 'all' check (project_access in ('all','selected')),
  project_ids jsonb not null default '[]' check (jsonb_typeof(project_ids) = 'array' and jsonb_array_length(project_ids) <= 200),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  accepted_at timestamptz,
  accepted_user uuid references auth.users(id) on delete set null,
  client_user_id uuid,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete set null,
  request_id uuid,
  unique (workspace_id, id),
  check (role <> 'admin' or project_access = 'all'),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'revoked') = (revoked_at is not null)),
  foreign key (workspace_id, client_id) references leadflow_private.clients(workspace_id, id) on delete cascade
);
create unique index client_invitations_pending on leadflow_private.client_invitations(client_id, email) where status = 'pending';
create unique index client_invitations_request on leadflow_private.client_invitations(workspace_id, request_id) where request_id is not null;

-- ---------- What the client can see ----------

alter table leadflow_private.projects
  add column portal_shared boolean not null default false,
  add column portal_shared_at timestamptz,
  -- Written for the client; the internal brief, notes, money and health are never shown.
  add column portal_summary text not null default '' check (length(portal_summary) <= 4000),
  add column portal_objectives jsonb not null default '[]' check (jsonb_typeof(portal_objectives) = 'array' and jsonb_array_length(portal_objectives) <= 20),
  add column portal_contact_name text not null default '' check (length(portal_contact_name) <= 150 and portal_contact_name !~ '[[:cntrl:]]'),
  add column portal_contact_email text not null default '' check (length(portal_contact_email) <= 254 and portal_contact_email !~ '[[:cntrl:][:space:]]');

alter table leadflow_private.project_milestones add column client_visible boolean not null default false;

-- Client review is tracked apart from the internal delivery status: a deliverable can be complete internally and still
-- await the client's approval.
alter table leadflow_private.project_deliverables
  add column client_visible boolean not null default false,
  add column shared_at timestamptz,
  add column review_status text not null default 'not_shared' check (review_status in ('not_shared','shared','awaiting_review','changes_requested','resubmitted','approved','rejected','withdrawn')),
  add constraint project_deliverables_review_visible check (client_visible or review_status = 'not_shared');

-- ---------- Versions, reviews, feedback and decisions ----------

-- A version collects the files of one submission. It's a draft until published (shared, or sent for review); a published
-- version and its files never change, so every decision refers to exactly what the client saw.
create table leadflow_private.deliverable_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  deliverable_id uuid not null,
  number integer not null check (number between 1 and 500),
  notes text not null default '' check (length(notes) <= 4000),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  published_by uuid references public.profiles(id) on delete set null,
  unique (workspace_id, id),
  unique (deliverable_id, number),
  foreign key (workspace_id, project_id) references leadflow_private.projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, deliverable_id) references leadflow_private.project_deliverables(workspace_id, id) on delete cascade
);
-- At most one draft per deliverable.
create unique index deliverable_versions_draft on leadflow_private.deliverable_versions(deliverable_id) where published_at is null;

create table leadflow_private.deliverable_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  deliverable_id uuid not null,
  version_id uuid not null,
  message text not null default '' check (length(message) <= 4000),
  due_date date,
  -- Client people (client_users) asked to decide; empty means any client admin or reviewer with access.
  reviewer_ids jsonb not null default '[]' check (jsonb_typeof(reviewer_ids) = 'array' and jsonb_array_length(reviewer_ids) <= 20),
  status text not null default 'open' check (status in ('open','changes_requested','approved','rejected','withdrawn')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  -- When a client person first opened the review in the portal (recorded by the database when the page loads).
  first_viewed_at timestamptz,
  first_viewed_by uuid,
  closed_at timestamptz,
  withdrawn_by uuid references public.profiles(id) on delete set null,
  withdrawn_reason text not null default '' check (length(withdrawn_reason) <= 1000),
  request_id uuid,
  unique (workspace_id, id),
  check ((status = 'open') = (closed_at is null)),
  foreign key (workspace_id, deliverable_id) references leadflow_private.project_deliverables(workspace_id, id) on delete cascade,
  foreign key (workspace_id, version_id) references leadflow_private.deliverable_versions(workspace_id, id) on delete cascade
);
create unique index deliverable_reviews_open on leadflow_private.deliverable_reviews(deliverable_id) where status = 'open';
create unique index deliverable_reviews_request on leadflow_private.deliverable_reviews(workspace_id, request_id) where request_id is not null;
create index deliverable_reviews_project on leadflow_private.deliverable_reviews(project_id, created_at desc);

-- Structured feedback from a client person, on one version. Never deleted; the agency moves it through its statuses.
create table leadflow_private.deliverable_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  deliverable_id uuid not null,
  version_id uuid not null,
  review_id uuid,
  -- Cleared only if the person's login is deleted; author_name keeps who wrote it.
  client_user_id uuid,
  author_name text not null default '' check (length(author_name) <= 254),
  title text not null check (length(btrim(title)) between 1 and 150 and title !~ '[[:cntrl:]]'),
  body text not null default '' check (length(body) <= 4000),
  category text not null default 'general' check (category in ('design','content','functional','technical','general')),
  status text not null default 'open' check (status in ('open','acknowledged','clarification_requested','addressed','declined')),
  status_note text not null default '' check (length(status_note) <= 1000),
  addressed_in_version uuid,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  request_id uuid,
  unique (workspace_id, id),
  foreign key (workspace_id, deliverable_id) references leadflow_private.project_deliverables(workspace_id, id) on delete cascade,
  foreign key (workspace_id, version_id) references leadflow_private.deliverable_versions(workspace_id, id) on delete cascade,
  foreign key (workspace_id, client_user_id) references leadflow_private.client_users(workspace_id, id) on delete set null (client_user_id)
);
create index deliverable_feedback_deliverable on leadflow_private.deliverable_feedback(deliverable_id, created_at);
create unique index deliverable_feedback_request on leadflow_private.deliverable_feedback(workspace_id, request_id) where request_id is not null;

-- A client person's decision on one review, and so on one version. Rows are never updated (see the trigger below).
create table leadflow_private.deliverable_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  deliverable_id uuid not null,
  version_id uuid not null,
  review_id uuid not null,
  -- Cleared only if the person's login is deleted; user_id, reviewer_name and reviewer_email keep who decided.
  client_user_id uuid,
  user_id uuid not null,
  reviewer_name text not null default '' check (length(reviewer_name) <= 254),
  reviewer_email text not null default '' check (length(reviewer_email) <= 254),
  decision text not null check (decision in ('approved','changes_requested','rejected')),
  comment text not null default '' check (length(comment) <= 4000),
  created_at timestamptz not null default now(),
  request_id uuid,
  unique (review_id),
  foreign key (workspace_id, deliverable_id) references leadflow_private.project_deliverables(workspace_id, id) on delete cascade,
  foreign key (workspace_id, version_id) references leadflow_private.deliverable_versions(workspace_id, id) on delete cascade,
  foreign key (workspace_id, client_user_id) references leadflow_private.client_users(workspace_id, id) on delete set null (client_user_id)
);
create index deliverable_decisions_deliverable on leadflow_private.deliverable_decisions(deliverable_id, created_at);
create unique index deliverable_decisions_request on leadflow_private.deliverable_decisions(workspace_id, request_id) where request_id is not null;

-- The only change allowed is the database clearing client_user_id when a login is deleted.
create function leadflow_private.refuse_change() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.client_user_id is null and old.client_user_id is not null and (to_jsonb(new) - 'client_user_id') = (to_jsonb(old) - 'client_user_id') then return new; end if;
  raise exception 'This record is part of the approval history and can''t be changed.' using errcode = '55000';
end $$;
create trigger deliverable_decisions_immutable before update on leadflow_private.deliverable_decisions for each row execute function leadflow_private.refuse_change();

-- ---------- Conversations and updates ----------

-- Every comment says who can see it. Client comments are always client-visible; agency comments default to internal.
create table leadflow_private.project_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  deliverable_id uuid,
  feedback_id uuid,
  version_id uuid,
  parent_id uuid,
  author_type text not null check (author_type in ('member','client')),
  member_id uuid references public.profiles(id) on delete set null,
  client_user_id uuid,
  visibility text not null check (visibility in ('internal','client')),
  body text not null check (length(body) <= 5000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by_type text check (deleted_by_type in ('member','client')),
  request_id uuid,
  unique (workspace_id, id),
  check (author_type = 'member' or visibility = 'client'),
  author_name text not null default '' check (length(author_name) <= 254),
  check ((deleted_at is null) = (deleted_by_type is null)),
  foreign key (workspace_id, project_id) references leadflow_private.projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, deliverable_id) references leadflow_private.project_deliverables(workspace_id, id) on delete cascade,
  foreign key (workspace_id, feedback_id) references leadflow_private.deliverable_feedback(workspace_id, id) on delete cascade,
  foreign key (workspace_id, parent_id) references leadflow_private.project_comments(workspace_id, id) on delete cascade,
  foreign key (workspace_id, client_user_id) references leadflow_private.client_users(workspace_id, id) on delete set null (client_user_id)
);
create index project_comments_project on leadflow_private.project_comments(project_id, created_at);
create unique index project_comments_request on leadflow_private.project_comments(workspace_id, request_id) where request_id is not null;

-- Earlier text of edited or deleted comments, for the agency's audit only.
create table leadflow_private.project_comment_revisions (
  id bigint generated always as identity primary key,
  comment_id uuid not null references leadflow_private.project_comments(id) on delete cascade,
  body text not null,
  action text not null check (action in ('edited','deleted')),
  actor_type text not null check (actor_type in ('member','client')),
  actor_id uuid,
  at timestamptz not null default now()
);

-- When each member last read a project's discussion, for "unread client messages".
create table leadflow_private.project_comment_reads (
  project_id uuid not null references leadflow_private.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- Updates the agency publishes to the client. Internal activity never becomes an update by itself.
create table leadflow_private.project_updates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 150 and title !~ '[[:cntrl:]]'),
  body text not null default '' check (length(body) <= 8000),
  status text not null default 'draft' check (status in ('draft','published')),
  author_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  published_by uuid references public.profiles(id) on delete set null,
  corrected_at timestamptz,
  version integer not null default 1,
  request_id uuid,
  unique (workspace_id, id),
  check ((status = 'published') = (published_at is not null)),
  foreign key (workspace_id, project_id) references leadflow_private.projects(workspace_id, id) on delete cascade
);
create index project_updates_project on leadflow_private.project_updates(project_id, status, published_at desc);
create unique index project_updates_request on leadflow_private.project_updates(workspace_id, request_id) where request_id is not null;

-- The text of a published update before each correction.
create table leadflow_private.project_update_revisions (
  id bigint generated always as identity primary key,
  update_id uuid not null references leadflow_private.project_updates(id) on delete cascade,
  title text not null,
  body text not null,
  edited_by uuid references public.profiles(id) on delete set null,
  at timestamptz not null default now()
);

-- ---------- Notifications ----------

-- In-app notifications for members and client people. dedupe_key makes every event notify each person once, however
-- often a request is retried.
create table leadflow_private.portal_notifications (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  recipient_type text not null check (recipient_type in ('member','client')),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_user_id uuid references leadflow_private.client_users(id) on delete cascade,
  event text not null check (event ~ '^[a-z_]{1,40}$'),
  project_id uuid references leadflow_private.projects(id) on delete cascade,
  deliverable_id uuid,
  title text not null check (length(title) between 1 and 200),
  body text not null default '' check (length(body) <= 500),
  link text not null default '' check (length(link) <= 300),
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check ((recipient_type = 'client') = (client_user_id is not null)),
  unique (user_id, dedupe_key)
);
create index portal_notifications_member on leadflow_private.portal_notifications(workspace_id, user_id, created_at desc) where recipient_type = 'member';
create index portal_notifications_client on leadflow_private.portal_notifications(client_user_id, created_at desc) where recipient_type = 'client';

-- Which client-activity events a member also gets by email, per workspace. No row means the defaults.
create table leadflow_private.portal_member_preferences (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  email_events jsonb not null check (jsonb_typeof(email_events) = 'array' and jsonb_array_length(email_events) <= 20),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- Emails for notifications and invitations, sent by the portal-notifications worker with the same lease, retry and
-- idempotency rules as M3 and M6A. payload holds what the email needs (an invitation's link token too) and is cleared
-- once the outcome is final. A provider acceptance is not a delivery confirmation.
create table leadflow_private.portal_email_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('notification','invitation')),
  notification_id bigint unique references leadflow_private.portal_notifications(id) on delete cascade,
  invitation_id uuid references leadflow_private.client_invitations(id) on delete cascade,
  recipient text not null check (length(recipient) between 3 and 254),
  payload jsonb not null default '{}' check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8000),
  email jsonb,
  status text not null default 'pending' check (status in ('pending','sending','accepted','failed','uncertain','cancelled')),
  attempts integer not null default 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  provider_id text,
  last_error text check (length(last_error) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'notification') = (notification_id is not null)),
  check ((kind = 'invitation') = (invitation_id is not null))
);
create index portal_email_outbox_ready on leadflow_private.portal_email_outbox(status, next_attempt_at);
create index portal_email_outbox_invitation on leadflow_private.portal_email_outbox(invitation_id) where invitation_id is not null;

-- ---------- Existing tables ----------

-- Collaboration events join the client's activity history; client actions name the client person.
alter table leadflow_private.client_activities add column client_user_id uuid references leadflow_private.client_users(id) on delete set null;

-- Files: version, comment, feedback and update attachments, and the client person who uploaded a file. Project files can
-- now be shared; the portal still checks project access and what each attachment belongs to on every request.
alter table leadflow_private.client_documents
  drop constraint client_documents_project_internal,
  add column version_id uuid,
  add column comment_id uuid,
  add column feedback_id uuid,
  add column update_id uuid,
  add column uploaded_client_user uuid references leadflow_private.client_users(id) on delete set null,
  add constraint client_documents_version foreign key (workspace_id, version_id) references leadflow_private.deliverable_versions(workspace_id, id) on delete cascade,
  add constraint client_documents_comment foreign key (workspace_id, comment_id) references leadflow_private.project_comments(workspace_id, id) on delete cascade,
  add constraint client_documents_feedback foreign key (workspace_id, feedback_id) references leadflow_private.deliverable_feedback(workspace_id, id) on delete cascade,
  add constraint client_documents_update foreign key (workspace_id, update_id) references leadflow_private.project_updates(workspace_id, id) on delete cascade,
  add constraint client_documents_attachment_project check (project_id is not null or (version_id is null and comment_id is null and feedback_id is null and update_id is null)),
  add constraint client_documents_one_attachment check (num_nonnulls(version_id, comment_id, feedback_id, update_id) <= 1);
create index client_documents_version on leadflow_private.client_documents(version_id) where version_id is not null;

alter table leadflow_private.client_users enable row level security;
alter table leadflow_private.client_user_projects enable row level security;
alter table leadflow_private.client_invitations enable row level security;
alter table leadflow_private.deliverable_versions enable row level security;
alter table leadflow_private.deliverable_reviews enable row level security;
alter table leadflow_private.deliverable_feedback enable row level security;
alter table leadflow_private.deliverable_decisions enable row level security;
alter table leadflow_private.project_comments enable row level security;
alter table leadflow_private.project_comment_revisions enable row level security;
alter table leadflow_private.project_comment_reads enable row level security;
alter table leadflow_private.project_updates enable row level security;
alter table leadflow_private.project_update_revisions enable row level security;
alter table leadflow_private.portal_notifications enable row level security;
alter table leadflow_private.portal_member_preferences enable row level security;
alter table leadflow_private.portal_email_outbox enable row level security;
revoke all on leadflow_private.client_users, leadflow_private.client_user_projects, leadflow_private.client_invitations, leadflow_private.deliverable_versions,
  leadflow_private.deliverable_reviews, leadflow_private.deliverable_feedback, leadflow_private.deliverable_decisions, leadflow_private.project_comments,
  leadflow_private.project_comment_revisions, leadflow_private.project_comment_reads, leadflow_private.project_updates, leadflow_private.project_update_revisions,
  leadflow_private.portal_notifications, leadflow_private.portal_member_preferences, leadflow_private.portal_email_outbox from public, anon, authenticated;

-- ---------- Client accounts never act inside the agency app ----------

-- Accounts created by a client invitation carry app_metadata.account_type = 'client', which only the server can set.
create function leadflow_private.is_client_account() returns boolean language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '') = 'client'
$$;

-- As M2 defined it, and client accounts are refused: they can't create, list or open workspaces.
create or replace function leadflow_private.current_profile() returns uuid language plpgsql set search_path = '' as $$
declare actor uuid := leadflow_private.valid_actor();
begin
  if actor is null or not exists (select 1 from auth.users where id = actor) then
    raise exception 'Sign in with an internal account.' using errcode = '42501';
  end if;
  if leadflow_private.is_client_account() then
    raise exception 'This is a client portal account. Sign in to your client portal instead.' using errcode = '42501';
  end if;
  insert into public.profiles(id) values (actor) on conflict do nothing;
  return actor;
end $$;

-- ---------- Small helpers ----------

create function leadflow_private.clean_email(raw text) returns text language plpgsql immutable set search_path = '' as $$
declare clean text := lower(btrim(coalesce(raw, '')));
begin
  if clean !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(clean) > 254 or clean ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  return clean;
end $$;

create function leadflow_private.client_user_label(cu leadflow_private.client_users) returns text language sql immutable set search_path = '' as $$
  select coalesce(nullif(cu.name, ''), cu.email)
$$;

-- How a member appears to clients: their display name, never their email.
create function leadflow_private.member_public_name(member uuid) returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select nullif(p.display_name, '') from public.profiles p where p.id = member), 'Your agency team')
$$;

-- How a member appears to other members.
create function leadflow_private.member_label(member uuid) returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = member), 'A former member')
$$;

-- Client-facing status words: internal health ("at risk", "delayed") is never shown to the client.
create function leadflow_private.client_project_status(status text) returns text language sql immutable set search_path = '' as $$
  select case status when 'at_risk' then 'in_progress' else status end
$$;
create function leadflow_private.client_milestone_status(status text) returns text language sql immutable set search_path = '' as $$
  select case status when 'delayed' then 'in_progress' else status end
$$;

-- ---------- Portal access ----------

-- The caller's active access to a client, or "not found" (also for archived clients and revoked people).
create function leadflow_private.hub_access(target_client uuid) returns leadflow_private.client_users
language plpgsql stable security definer set search_path = '' as $$
declare cu leadflow_private.client_users; actor uuid := leadflow_private.valid_actor();
begin
  if actor is null then raise exception 'Sign in to your client portal.' using errcode = '42501'; end if;
  select x.* into cu from leadflow_private.client_users x join leadflow_private.clients c on c.id = x.client_id and c.workspace_id = x.workspace_id
    where x.client_id = target_client and x.user_id = actor and x.status = 'active' and c.status <> 'archived';
  if not found then raise exception 'Not found.' using errcode = 'P0002'; end if;
  return cu;
end $$;

create function leadflow_private.hub_access_by_id(target_access uuid) returns leadflow_private.client_users
language plpgsql stable security definer set search_path = '' as $$
declare found_client uuid;
begin
  select x.client_id into found_client from leadflow_private.client_users x where x.id = target_access and x.user_id = leadflow_private.valid_actor();
  if found_client is null then raise exception 'Not found.' using errcode = 'P0002'; end if;
  return leadflow_private.hub_access(found_client);
end $$;

create function leadflow_private.hub_can_see_project(p leadflow_private.projects, cu leadflow_private.client_users) returns boolean
language sql stable security definer set search_path = '' as $$
  select p.portal_shared and p.client_id = cu.client_id and p.workspace_id = cu.workspace_id and cu.status = 'active'
    and (cu.project_access = 'all' or exists (select 1 from leadflow_private.client_user_projects a where a.client_user_id = cu.id and a.project_id = p.id))
$$;

-- The caller's access row for a project they may open; "not found" for anything else, so IDs can't be probed.
create function leadflow_private.hub_open_project(target_project uuid) returns leadflow_private.client_users
language plpgsql stable security definer set search_path = '' as $$
declare p leadflow_private.projects; cu leadflow_private.client_users;
begin
  select * into p from leadflow_private.projects x where x.id = target_project;
  if not found then raise exception 'Not found.' using errcode = 'P0002'; end if;
  cu := leadflow_private.hub_access(p.client_id);
  if not leadflow_private.hub_can_see_project(p, cu) then raise exception 'Not found.' using errcode = 'P0002'; end if;
  return cu;
end $$;

-- The deliverable when it's shared and the caller may open its project.
create function leadflow_private.hub_open_deliverable(target_deliverable uuid) returns leadflow_private.project_deliverables
language plpgsql stable security definer set search_path = '' as $$
declare d leadflow_private.project_deliverables;
begin
  select * into d from leadflow_private.project_deliverables x where x.id = target_deliverable and x.client_visible;
  if not found then raise exception 'Not found.' using errcode = 'P0002'; end if;
  perform leadflow_private.hub_open_project(d.project_id);
  return d;
end $$;

create function leadflow_private.hub_can_see_document(d leadflow_private.client_documents, cu leadflow_private.client_users) returns boolean
language sql stable security definer set search_path = '' as $$
  select d.status = 'available' and d.workspace_id = cu.workspace_id and d.client_id = cu.client_id and case
    -- Client-level files: those the agency shared, and those this client's people uploaded here.
    when d.project_id is null then (d.visibility = 'shared' and d.uploader_type = 'member') or d.uploaded_client_user is not null
    else exists (select 1 from leadflow_private.projects p where p.id = d.project_id and leadflow_private.hub_can_see_project(p, cu)) and case
      when d.version_id is not null then exists (select 1 from leadflow_private.deliverable_versions v join leadflow_private.project_deliverables x on x.id = v.deliverable_id
        where v.id = d.version_id and v.published_at is not null and x.client_visible)
      when d.comment_id is not null then exists (select 1 from leadflow_private.project_comments c where c.id = d.comment_id and c.visibility = 'client' and c.deleted_at is null)
      when d.feedback_id is not null then exists (select 1 from leadflow_private.deliverable_feedback f join leadflow_private.project_deliverables x on x.id = f.deliverable_id
        where f.id = d.feedback_id and x.client_visible)
      when d.update_id is not null then exists (select 1 from leadflow_private.project_updates u where u.id = d.update_id and u.status = 'published')
      else d.visibility = 'shared'
    end
  end
$$;

-- ---------- History ----------

-- A collaboration event in the client's activity history, linked to the project. cu names the client person when they acted.
create function leadflow_private.collab_event(p leadflow_private.projects, event_kind text, event_summary text, event_detail jsonb default '{}',
  target_entity_type text default 'project', target_entity_id text default null, cu leadflow_private.client_users default null) returns void
language sql security definer set search_path = '' as $$
  insert into leadflow_private.client_activities(workspace_id, client_id, project_id, kind, summary, detail, actor_type, actor_id, client_user_id, entity_type, entity_id)
  values (p.workspace_id, p.client_id, p.id, event_kind, left(event_summary, 300), coalesce(event_detail, '{}'),
    case when cu.id is null then 'member' else 'client' end, case when cu.id is null then leadflow_private.valid_actor() end, cu.id,
    target_entity_type, coalesce(target_entity_id, p.id::text))
$$;

-- ---------- Notifications ----------

create function leadflow_private.member_email_defaults() returns jsonb language sql immutable set search_path = '' as $$
  select '["client_activated","feedback_submitted","changes_requested","deliverable_approved","deliverable_rejected"]'::jsonb
$$;

-- One notification, once per person and dedupe key, with an email when the person asked for this event by email.
create function leadflow_private.queue_notification(target_workspace uuid, kind_of_recipient text, recipient uuid, recipient_access uuid, event_name text,
  target_project uuid, target_deliverable uuid, heading text, detail text, target_link text, dedupe text, email_to text) returns void
language plpgsql security definer set search_path = '' as $$
declare created bigint;
begin
  insert into leadflow_private.portal_notifications(workspace_id, recipient_type, user_id, client_user_id, event, project_id, deliverable_id, title, body, link, dedupe_key)
    values (target_workspace, kind_of_recipient, recipient, recipient_access, event_name, target_project, target_deliverable, left(heading, 200), left(coalesce(detail, ''), 500),
      coalesce(target_link, ''), left(dedupe, 200))
    on conflict (user_id, dedupe_key) do nothing returning id into created;
  if created is not null and email_to is not null and email_to ~ '^[^@\s]+@[^@\s]+$' then
    insert into leadflow_private.portal_email_outbox(workspace_id, kind, notification_id, recipient) values (target_workspace, 'notification', created, email_to);
  end if;
end $$;

-- Client people who can open the project (optionally only some), except the one who acted.
create function leadflow_private.notify_clients(p leadflow_private.projects, event_name text, heading text, detail text, target_link text, dedupe text,
  target_deliverable uuid default null, actor_access uuid default null, only_people uuid[] default null) returns void
language plpgsql security definer set search_path = '' as $$
declare cu leadflow_private.client_users;
begin
  if not p.portal_shared then return; end if;
  for cu in select x.* from leadflow_private.client_users x where x.client_id = p.client_id and x.status = 'active' and x.id is distinct from actor_access
    and (only_people is null or x.id = any(only_people)) loop
    if leadflow_private.hub_can_see_project(p, cu) then
      perform leadflow_private.queue_notification(p.workspace_id, 'client', cu.user_id, cu.id, event_name, p.id, target_deliverable, heading, detail, target_link,
        dedupe, case when cu.email_events ? event_name then cu.email end);
    end if;
  end loop;
end $$;

-- The project's owner, or the workspace's owners and admins when it has none; plus extra members; never the member who acted.
create function leadflow_private.notify_members(p leadflow_private.projects, event_name text, heading text, detail text, dedupe text,
  target_deliverable uuid default null, extra uuid[] default '{}') returns void
language plpgsql security definer set search_path = '' as $$
declare member uuid; wanted jsonb; address text;
begin
  for member in
    select distinct m.user_id from public.workspace_memberships m where m.workspace_id = p.workspace_id
      and (m.user_id = p.owner_id or m.user_id = any(coalesce(extra, '{}'))
        or (m.role in ('owner','admin') and not exists (select 1 from public.workspace_memberships o where o.workspace_id = p.workspace_id and o.user_id = p.owner_id)))
      and m.user_id is distinct from leadflow_private.valid_actor()
  loop
    select coalesce((select q.email_events from leadflow_private.portal_member_preferences q where q.workspace_id = p.workspace_id and q.user_id = member), leadflow_private.member_email_defaults())
      into wanted;
    select u.email into address from auth.users u where u.id = member;
    perform leadflow_private.queue_notification(p.workspace_id, 'member', member, null, event_name, p.id, target_deliverable, heading, detail, '', dedupe,
      case when wanted ? event_name then address end);
  end loop;
end $$;

-- ---------- Review status ----------

-- Derived from the latest review; drafts never change what the client sees. A new version after an approval needs its
-- own review: the approval stays with the version it was given for.
create function leadflow_private.refresh_review_status(target_deliverable uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.project_deliverables; latest leadflow_private.deliverable_reviews; next_status text;
begin
  select * into d from leadflow_private.project_deliverables x where x.id = target_deliverable for update;
  if not d.client_visible then next_status := 'not_shared';
  else
    select * into latest from leadflow_private.deliverable_reviews r where r.deliverable_id = d.id order by r.created_at desc, r.id desc limit 1;
    if latest.id is null then next_status := 'shared';
    elsif latest.status = 'open' then
      next_status := case when exists (select 1 from leadflow_private.deliverable_reviews r where r.deliverable_id = d.id and r.id <> latest.id and r.status in ('changes_requested','rejected'))
        then 'resubmitted' else 'awaiting_review' end;
    else next_status := latest.status;
    end if;
  end if;
  update leadflow_private.project_deliverables x set review_status = next_status where x.id = d.id and x.review_status is distinct from next_status;
  return next_status;
end $$;

-- ---------- JSON ----------

create function leadflow_private.client_user_json(cu leadflow_private.client_users) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', cu.id, 'clientId', cu.client_id, 'email', cu.email, 'name', cu.name, 'role', cu.role, 'projectAccess', cu.project_access,
    'projectIds', coalesce((select jsonb_agg(a.project_id) from leadflow_private.client_user_projects a where a.client_user_id = cu.id), '[]'::jsonb),
    'status', cu.status, 'activatedAt', cu.activated_at, 'revokedAt', cu.revoked_at, 'lastSeenAt', cu.last_seen_at, 'version', cu.version)
$$;

create function leadflow_private.invitation_json(i leadflow_private.client_invitations) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', i.id, 'clientId', i.client_id, 'email', i.email, 'name', i.name, 'role', i.role, 'projectAccess', i.project_access, 'projectIds', i.project_ids,
    'status', case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end, 'expiresAt', i.expires_at, 'createdAt', i.created_at,
    'rotatedAt', i.rotated_at, 'acceptedAt', i.accepted_at, 'revokedAt', i.revoked_at, 'invitedBy', leadflow_private.member_label(i.created_by),
    'emailStatus', (select o.status from leadflow_private.portal_email_outbox o where o.invitation_id = i.id order by o.created_at desc limit 1))
$$;

-- A file as the client sees it: no storage path, no internal uploader details.
create function leadflow_private.hub_document_json(d leadflow_private.client_documents) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'fileName', d.file_name, 'extension', d.extension, 'mimeType', d.mime_type, 'size', d.size_bytes, 'category', d.category,
    'description', d.description, 'createdAt', d.created_at, 'projectId', d.project_id, 'deliverableId', d.deliverable_id, 'versionId', d.version_id,
    'commentId', d.comment_id, 'feedbackId', d.feedback_id, 'updateId', d.update_id,
    'uploadedBy', case when d.uploader_type = 'member' then leadflow_private.member_public_name(d.uploaded_by)
      else coalesce((select leadflow_private.client_user_label(cu) from leadflow_private.client_users cu where cu.id = d.uploaded_client_user), 'Client') end,
    'fromClient', d.uploader_type = 'client', 'uploaderAccessId', d.uploaded_client_user)
$$;

create function leadflow_private.version_files(v leadflow_private.deliverable_versions, for_client boolean) returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(case when for_client then leadflow_private.hub_document_json(d) else leadflow_private.document_json(d) end order by d.created_at), '[]'::jsonb)
  from leadflow_private.client_documents d where d.version_id = v.id and (d.status = 'available' or (not for_client and d.status = 'pending' and d.created_at > now() - interval '1 day'))
$$;

create function leadflow_private.version_json(v leadflow_private.deliverable_versions, for_client boolean) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', v.id, 'deliverableId', v.deliverable_id, 'number', v.number, 'notes', v.notes, 'createdAt', v.created_at, 'publishedAt', v.published_at,
    'createdBy', case when for_client then leadflow_private.member_public_name(v.created_by) else leadflow_private.member_label(v.created_by) end,
    'files', leadflow_private.version_files(v, for_client))
$$;

create function leadflow_private.decision_json(x leadflow_private.deliverable_decisions) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', x.id, 'reviewId', x.review_id, 'versionId', x.version_id,
    'versionNumber', (select v.number from leadflow_private.deliverable_versions v where v.id = x.version_id),
    'decision', x.decision, 'comment', x.comment, 'reviewer', coalesce(nullif(x.reviewer_name, ''), nullif(x.reviewer_email, ''), 'Client'), 'createdAt', x.created_at)
$$;

create function leadflow_private.review_json(r leadflow_private.deliverable_reviews, for_client boolean) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', r.id, 'deliverableId', r.deliverable_id, 'versionId', r.version_id,
    'versionNumber', (select v.number from leadflow_private.deliverable_versions v where v.id = r.version_id),
    'message', r.message, 'dueDate', r.due_date, 'status', r.status, 'createdAt', r.created_at, 'closedAt', r.closed_at, 'reviewerIds', r.reviewer_ids,
    'reviewers', coalesce((select jsonb_agg(leadflow_private.client_user_label(cu)) from leadflow_private.client_users cu where r.reviewer_ids ? cu.id::text), '[]'::jsonb),
    'requestedBy', case when for_client then leadflow_private.member_public_name(r.created_by) else leadflow_private.member_label(r.created_by) end,
    'decision', (select leadflow_private.decision_json(x) from leadflow_private.deliverable_decisions x where x.review_id = r.id))
  || case when for_client then '{}'::jsonb else jsonb_build_object('firstViewedAt', r.first_viewed_at,
    'firstViewedBy', (select leadflow_private.client_user_label(cu) from leadflow_private.client_users cu where cu.id = r.first_viewed_by),
    'withdrawnReason', r.withdrawn_reason) end
$$;

create function leadflow_private.feedback_json(f leadflow_private.deliverable_feedback, for_client boolean) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', f.id, 'deliverableId', f.deliverable_id, 'versionId', f.version_id,
    'versionNumber', (select v.number from leadflow_private.deliverable_versions v where v.id = f.version_id), 'reviewId', f.review_id,
    'title', f.title, 'body', f.body, 'category', f.category, 'status', f.status, 'statusNote', f.status_note,
    'addressedInVersion', (select v.number from leadflow_private.deliverable_versions v where v.id = f.addressed_in_version),
    'author', coalesce((select leadflow_private.client_user_label(cu) from leadflow_private.client_users cu where cu.id = f.client_user_id), nullif(f.author_name, ''), 'Client'),
    'authorAccessId', f.client_user_id, 'createdAt', f.created_at, 'updatedAt', f.updated_at,
    'files', coalesce((select jsonb_agg(case when for_client then leadflow_private.hub_document_json(d) else leadflow_private.document_json(d) end order by d.created_at)
      from leadflow_private.client_documents d where d.feedback_id = f.id and d.status = 'available'), '[]'::jsonb))
$$;

create function leadflow_private.comment_json(c leadflow_private.project_comments, for_client boolean) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'projectId', c.project_id, 'deliverableId', c.deliverable_id, 'feedbackId', c.feedback_id, 'versionId', c.version_id,
    'parentId', c.parent_id, 'authorType', c.author_type, 'visibility', c.visibility,
    'author', case when c.author_type = 'member' then case when for_client then leadflow_private.member_public_name(c.member_id) else leadflow_private.member_label(c.member_id) end
      else coalesce((select leadflow_private.client_user_label(cu) from leadflow_private.client_users cu where cu.id = c.client_user_id), nullif(c.author_name, ''), 'Client') end,
    'memberId', case when for_client then null else c.member_id end, 'authorAccessId', c.client_user_id,
    'body', case when c.deleted_at is null then c.body else '' end, 'deleted', c.deleted_at is not null,
    'createdAt', c.created_at, 'editedAt', c.edited_at, 'deletedAt', c.deleted_at,
    'files', case when c.deleted_at is not null then '[]'::jsonb else coalesce((select jsonb_agg(case when for_client then leadflow_private.hub_document_json(d) else leadflow_private.document_json(d) end
      order by d.created_at) from leadflow_private.client_documents d where d.comment_id = c.id and d.status = 'available'), '[]'::jsonb) end)
  || case when for_client then '{}'::jsonb else jsonb_build_object('revisions', (select count(*) from leadflow_private.project_comment_revisions r where r.comment_id = c.id)) end
$$;

create function leadflow_private.update_json(u leadflow_private.project_updates, for_client boolean) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', u.id, 'projectId', u.project_id, 'title', u.title, 'body', u.body, 'status', u.status, 'publishedAt', u.published_at,
    'correctedAt', u.corrected_at, 'author', case when for_client then leadflow_private.member_public_name(coalesce(u.published_by, u.author_id)) else leadflow_private.member_label(u.author_id) end,
    'files', coalesce((select jsonb_agg(case when for_client then leadflow_private.hub_document_json(d) else leadflow_private.document_json(d) end order by d.created_at)
      from leadflow_private.client_documents d where d.update_id = u.id and d.status = 'available'), '[]'::jsonb))
  || case when for_client then '{}'::jsonb else jsonb_build_object('version', u.version, 'createdAt', u.created_at, 'updatedAt', u.updated_at,
    'revisions', (select count(*) from leadflow_private.project_update_revisions r where r.update_id = u.id)) end
$$;

-- What the client sees of a deliverable (also the agency's preview).
create function leadflow_private.hub_deliverable_card(d leadflow_private.project_deliverables) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'title', d.title, 'description', d.description, 'dueDate', d.due_date, 'reviewStatus', d.review_status,
    'milestoneId', (select m.id from leadflow_private.project_milestones m where m.id = d.milestone_id and m.client_visible),
    'completed', d.status = 'completed', 'sharedAt', d.shared_at,
    'latestVersion', (select v.number from leadflow_private.deliverable_versions v where v.deliverable_id = d.id and v.published_at is not null order by v.number desc limit 1),
    'openReview', (select jsonb_build_object('id', r.id, 'dueDate', r.due_date, 'versionNumber', (select v.number from leadflow_private.deliverable_versions v where v.id = r.version_id))
      from leadflow_private.deliverable_reviews r where r.deliverable_id = d.id and r.status = 'open'))
$$;

-- A project as the client sees it: only what the agency wrote for them or marked visible. No money, health, brief or notes.
create function leadflow_private.hub_project_json(p leadflow_private.projects, today date, detailed boolean) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'category', p.project_type, 'status', leadflow_private.client_project_status(p.status),
    'progress', (leadflow_private.project_progress(p, today) ->> 'percent')::integer,
    'startDate', p.start_date, 'targetDate', p.target_date, 'completedOn', p.completed_on, 'sharedAt', p.portal_shared_at,
    'nextMilestone', (select jsonb_build_object('id', m.id, 'name', m.name, 'dueDate', m.due_date) from leadflow_private.project_milestones m
      where m.project_id = p.id and m.client_visible and m.status not in ('completed','cancelled') order by m.due_date nulls last, m.position limit 1),
    'awaitingReview', (select count(*) from leadflow_private.deliverable_reviews r join leadflow_private.project_deliverables d on d.id = r.deliverable_id
      where r.project_id = p.id and r.status = 'open' and d.client_visible))
  || case when not detailed then '{}'::jsonb else jsonb_build_object(
    'summary', p.portal_summary, 'objectives', p.portal_objectives,
    'contact', case when p.portal_contact_name <> '' or p.portal_contact_email <> '' then jsonb_build_object('name', p.portal_contact_name, 'email', p.portal_contact_email) end,
    'services', coalesce((select jsonb_agg(s.name order by s.name) from leadflow_private.project_services ps join leadflow_private.client_services s on s.id = ps.client_service_id
      where ps.project_id = p.id), '[]'::jsonb),
    'milestones', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'description', m.description, 'startDate', m.start_date, 'dueDate', m.due_date,
        'status', leadflow_private.client_milestone_status(m.status), 'completedAt', m.completed_at) order by m.position, m.due_date nulls last)
      from leadflow_private.project_milestones m where m.project_id = p.id and m.client_visible and m.status <> 'cancelled'), '[]'::jsonb),
    'deliverables', coalesce((select jsonb_agg(leadflow_private.hub_deliverable_card(d) order by d.position, d.created_at)
      from leadflow_private.project_deliverables d where d.project_id = p.id and d.client_visible), '[]'::jsonb),
    'updates', coalesce((select jsonb_agg(leadflow_private.update_json(u, true) order by u.published_at desc) from leadflow_private.project_updates u
      where u.project_id = p.id and u.status = 'published'), '[]'::jsonb)) end
$$;

-- ---------- Agency: client portal access ----------

-- Any member. The client's portal people and invitations, and the client's projects for choosing access.
create function public.client_portal_access_for(target_workspace uuid, target_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace) then
    raise exception 'Client not found in this workspace.' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'people', coalesce((select jsonb_agg(leadflow_private.client_user_json(cu) order by cu.status, lower(coalesce(nullif(cu.name, ''), cu.email)))
      from leadflow_private.client_users cu where cu.client_id = target_client), '[]'::jsonb),
    'invitations', coalesce((select jsonb_agg(leadflow_private.invitation_json(i) order by i.created_at desc) from leadflow_private.client_invitations i
      where i.client_id = target_client and (i.status = 'pending' or coalesce(i.accepted_at, i.revoked_at) > now() - interval '30 days')), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'shared', p.portal_shared, 'status', p.status) order by p.created_at desc)
      from leadflow_private.projects p where p.client_id = target_client), '[]'::jsonb));
end $$;

create function leadflow_private.clean_project_ids(target_client uuid, raw jsonb) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare cleaned jsonb;
begin
  if raw is null or raw = 'null'::jsonb then return '[]'::jsonb; end if;
  if jsonb_typeof(raw) <> 'array' or jsonb_array_length(raw) > 200 then raise exception 'Choose up to 200 projects.' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(distinct p.id), '[]'::jsonb) into cleaned from jsonb_array_elements_text(raw) x
    join leadflow_private.projects p on p.id::text = x and p.client_id = target_client;
  if jsonb_array_length(cleaned) <> (select count(distinct x) from jsonb_array_elements_text(raw) x) then
    raise exception 'Choose projects of this client.' using errcode = '22023';
  end if;
  return cleaned;
end $$;

create function leadflow_private.queue_invitation_email(i leadflow_private.client_invitations, token text) returns void
language sql security definer set search_path = '' as $$
  update leadflow_private.portal_email_outbox o set status = 'cancelled', payload = '{}', email = null, updated_at = now()
    where o.invitation_id = i.id and o.status in ('pending','sending','uncertain');
  insert into leadflow_private.portal_email_outbox(workspace_id, kind, invitation_id, recipient, payload)
    values (i.workspace_id, 'invitation', i.id, i.email, jsonb_build_object('token', token))
$$;

-- Owners and admins. A single-use invitation for one email address, valid 7 days; the token is returned once. With
-- sendEmail the invitation is also queued for email (sent only when email delivery is configured).
create function public.invite_client_user(target_workspace uuid, target_client uuid, details jsonb, request_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; clean_address text; role_value text; access_value text; ids jsonb; token text; created leadflow_private.client_invitations;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the invitation as an object.' using errcode = '22023'; end if;
  found_client := leadflow_private.lock_client(target_workspace, target_client, null);
  if found_client.status = 'archived' then raise exception 'Unarchive this client before inviting people.' using errcode = '55000'; end if;
  if request_id is not null then
    select * into created from leadflow_private.client_invitations i where i.workspace_id = target_workspace and i.request_id = invite_client_user.request_id;
    if found then return jsonb_build_object('invitation', leadflow_private.invitation_json(created), 'token', null, 'replayed', true); end if;
  end if;
  clean_address := leadflow_private.clean_email(details->>'email');
  role_value := coalesce(nullif(details->>'role', ''), 'member');
  if role_value not in ('admin','member','reviewer') then raise exception 'Choose Client admin, Client member or Client reviewer.' using errcode = '22023'; end if;
  access_value := case when role_value = 'admin' then 'all' else coalesce(nullif(details->>'projectAccess', ''), 'all') end;
  if access_value not in ('all','selected') then raise exception 'Choose all projects or selected projects.' using errcode = '22023'; end if;
  ids := case when access_value = 'selected' then leadflow_private.clean_project_ids(target_client, details->'projectIds') else '[]'::jsonb end;
  if access_value = 'selected' and jsonb_array_length(ids) = 0 then raise exception 'Choose at least one project.' using errcode = '22023'; end if;
  if exists (select 1 from leadflow_private.client_users cu join auth.users u on u.id = cu.user_id where cu.client_id = target_client and cu.status = 'active'
      and (lower(cu.email) = clean_address or lower(u.email) = clean_address)) then
    raise exception 'This person already has portal access.' using errcode = '23505';
  end if;
  if exists (select 1 from leadflow_private.client_invitations i where i.client_id = target_client and i.email = clean_address and i.status = 'pending') then
    raise exception 'An invitation to this address is already pending. Renew or revoke it.' using errcode = '23505';
  end if;
  if (select count(*) from leadflow_private.client_invitations i where i.client_id = target_client and i.status = 'pending') >= 50 then
    raise exception 'A client can have at most 50 pending invitations.' using errcode = '54000';
  end if;
  -- Two version-4 UUIDs from the server's cryptographic random generator: 244 random bits.
  token := 'lfi_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into leadflow_private.client_invitations(workspace_id, client_id, email, name, role, project_access, project_ids, token_hash, expires_at, created_by, request_id)
    values (target_workspace, target_client, clean_address, leadflow_private.onboarding_clean_text(details->>'name', 'Name', 150, false, true), role_value, access_value, ids,
      encode(sha256(convert_to(token, 'UTF8')), 'hex'), now() + interval '7 days', leadflow_private.valid_actor(), request_id)
    returning * into created;
  if coalesce((details->>'sendEmail')::boolean, false) then perform leadflow_private.queue_invitation_email(created, token); end if;
  perform leadflow_private.client_event(target_client, 'portal_invited', 'Portal invitation created for ' || clean_address,
    jsonb_build_object('role', role_value, 'projectAccess', access_value, 'emailQueued', coalesce((details->>'sendEmail')::boolean, false)), 'member', 'client_invitation', created.id::text);
  return jsonb_build_object('invitation', leadflow_private.invitation_json(created), 'token', token);
end $$;

-- Owners and admins. A new token and 7 more days for a pending or expired invitation; the old link stops working.
create function public.renew_client_invitation(target_workspace uuid, target_invitation uuid, send_email boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i leadflow_private.client_invitations; token text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  select * into i from leadflow_private.client_invitations x where x.id = target_invitation and x.workspace_id = target_workspace for update;
  if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
  if i.status <> 'pending' then raise exception 'Only pending or expired invitations can be renewed.' using errcode = '55000'; end if;
  perform leadflow_private.lock_client(target_workspace, i.client_id, null);
  if exists (select 1 from leadflow_private.clients c where c.id = i.client_id and c.status = 'archived') then raise exception 'Unarchive this client first.' using errcode = '55000'; end if;
  token := 'lfi_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update leadflow_private.client_invitations x set token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'), expires_at = now() + interval '7 days', rotated_at = now()
    where x.id = i.id returning * into i;
  update leadflow_private.portal_email_outbox o set status = 'cancelled', payload = '{}', email = null, updated_at = now()
    where o.invitation_id = i.id and o.status in ('pending','sending','uncertain');
  if send_email then perform leadflow_private.queue_invitation_email(i, token); end if;
  perform leadflow_private.client_event(i.client_id, 'portal_invitation_renewed', 'Portal invitation renewed for ' || i.email, jsonb_build_object('emailQueued', send_email), 'member', 'client_invitation', i.id::text);
  return jsonb_build_object('invitation', leadflow_private.invitation_json(i), 'token', token);
end $$;

create function public.revoke_client_invitation(target_workspace uuid, target_invitation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i leadflow_private.client_invitations;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  update leadflow_private.client_invitations x set status = 'revoked', revoked_at = now(), revoked_by = leadflow_private.valid_actor()
    where x.id = target_invitation and x.workspace_id = target_workspace and x.status = 'pending' returning * into i;
  if i.id is null then raise exception 'Pending invitation not found.' using errcode = 'P0002'; end if;
  update leadflow_private.portal_email_outbox o set status = 'cancelled', payload = '{}', email = null, updated_at = now()
    where o.invitation_id = i.id and o.status in ('pending','sending','uncertain');
  perform leadflow_private.client_event(i.client_id, 'portal_invitation_revoked', 'Portal invitation revoked for ' || i.email, '{}', 'member', 'client_invitation', i.id::text);
  return leadflow_private.invitation_json(i);
end $$;

-- Owners and admins. Role, name and project access of a client person.
create function public.update_client_user(target_workspace uuid, target_access uuid, changes jsonb, expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cu leadflow_private.client_users; role_value text; access_value text; ids jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if changes is null or jsonb_typeof(changes) <> 'object' then raise exception 'Send the changes as an object.' using errcode = '22023'; end if;
  select * into cu from leadflow_private.client_users x where x.id = target_access and x.workspace_id = target_workspace for update;
  if not found then raise exception 'Portal user not found.' using errcode = 'P0002'; end if;
  if expected_version is not null and cu.version <> expected_version then raise exception 'This person was changed in another window. Reload and try again.' using errcode = '40001'; end if;
  role_value := coalesce(nullif(changes->>'role', ''), cu.role);
  if role_value not in ('admin','member','reviewer') then raise exception 'Choose Client admin, Client member or Client reviewer.' using errcode = '22023'; end if;
  access_value := case when role_value = 'admin' then 'all' else coalesce(nullif(changes->>'projectAccess', ''), cu.project_access) end;
  if access_value not in ('all','selected') then raise exception 'Choose all projects or selected projects.' using errcode = '22023'; end if;
  if access_value = 'selected' then
    ids := case when changes ? 'projectIds' then leadflow_private.clean_project_ids(cu.client_id, changes->'projectIds')
      else coalesce((select jsonb_agg(a.project_id) from leadflow_private.client_user_projects a where a.client_user_id = cu.id), '[]'::jsonb) end;
    if jsonb_array_length(ids) = 0 then raise exception 'Choose at least one project.' using errcode = '22023'; end if;
  end if;
  update leadflow_private.client_users x set role = role_value, project_access = access_value,
    name = case when changes ? 'name' then leadflow_private.onboarding_clean_text(changes->>'name', 'Name', 150, false, true) else x.name end,
    version = x.version + 1, updated_at = now() where x.id = cu.id returning * into cu;
  delete from leadflow_private.client_user_projects a where a.client_user_id = cu.id;
  if access_value = 'selected' then
    insert into leadflow_private.client_user_projects(client_user_id, project_id) select cu.id, x::uuid from jsonb_array_elements_text(ids) x;
  end if;
  perform leadflow_private.client_event(cu.client_id, 'portal_access_changed', 'Portal access changed for ' || cu.email,
    jsonb_build_object('role', role_value, 'projectAccess', access_value), 'member', 'client_user', cu.id::text);
  return leadflow_private.client_user_json(cu);
end $$;

-- Owners and admins. Revokes (or restores) a client person's portal access; every portal request checks it.
create function public.set_client_user_active(target_workspace uuid, target_access uuid, active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cu leadflow_private.client_users;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  select * into cu from leadflow_private.client_users x where x.id = target_access and x.workspace_id = target_workspace for update;
  if not found then raise exception 'Portal user not found.' using errcode = 'P0002'; end if;
  if active and cu.status = 'revoked' then
    update leadflow_private.client_users x set status = 'active', revoked_at = null, revoked_by = null, version = x.version + 1, updated_at = now() where x.id = cu.id returning * into cu;
    perform leadflow_private.client_event(cu.client_id, 'portal_access_restored', 'Portal access restored for ' || cu.email, '{}', 'member', 'client_user', cu.id::text);
  elsif not active and cu.status = 'active' then
    update leadflow_private.client_users x set status = 'revoked', revoked_at = now(), revoked_by = leadflow_private.valid_actor(), version = x.version + 1, updated_at = now()
      where x.id = cu.id returning * into cu;
    -- Emails not yet sent to this person are cancelled.
    update leadflow_private.portal_email_outbox o set status = 'cancelled', payload = '{}', email = null, updated_at = now()
      where o.status in ('pending','sending','uncertain') and o.notification_id in (select n.id from leadflow_private.portal_notifications n where n.client_user_id = cu.id);
    perform leadflow_private.client_event(cu.client_id, 'portal_access_revoked', 'Portal access revoked for ' || cu.email, '{}', 'member', 'client_user', cu.id::text);
  end if;
  return leadflow_private.client_user_json(cu);
end $$;

-- ---------- Agency: what the client sees ----------

-- Any member. Shares the project with the client (or stops), with the overview written for them.
create function public.set_project_portal(target_workspace uuid, target_project uuid, settings jsonb, expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p leadflow_private.projects; was_shared boolean; objectives jsonb; contact_email text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if settings is null or jsonb_typeof(settings) <> 'object' then raise exception 'Send the settings as an object.' using errcode = '22023'; end if;
  p := leadflow_private.lock_project(target_workspace, target_project, expected_version);
  was_shared := p.portal_shared;
  if settings ? 'objectives' then
    if jsonb_typeof(settings->'objectives') <> 'array' or jsonb_array_length(settings->'objectives') > 20 then raise exception 'Add up to 20 objectives.' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(leadflow_private.onboarding_clean_text(x, 'Objective', 300, true, true)), '[]'::jsonb) into objectives
      from jsonb_array_elements_text(settings->'objectives') x where btrim(x) <> '';
  end if;
  contact_email := case when settings ? 'contactEmail' then case when btrim(coalesce(settings->>'contactEmail', '')) = '' then '' else leadflow_private.clean_email(settings->>'contactEmail') end end;
  update leadflow_private.projects x set
    portal_shared = coalesce((settings->>'shared')::boolean, x.portal_shared),
    portal_shared_at = case when coalesce((settings->>'shared')::boolean, x.portal_shared) and not x.portal_shared then now() else x.portal_shared_at end,
    portal_summary = case when settings ? 'summary' then leadflow_private.onboarding_clean_text(settings->>'summary', 'Summary', 4000, false, false) else x.portal_summary end,
    portal_objectives = coalesce(objectives, x.portal_objectives),
    portal_contact_name = case when settings ? 'contactName' then leadflow_private.onboarding_clean_text(settings->>'contactName', 'Contact name', 150, false, true) else x.portal_contact_name end,
    portal_contact_email = coalesce(contact_email, x.portal_contact_email),
    version = x.version + 1, updated_at = now()
    where x.id = p.id returning * into p;
  if p.portal_shared and not was_shared then
    perform leadflow_private.collab_event(p, 'portal_project_shared', 'Project shared on the client portal');
    perform leadflow_private.notify_clients(p, 'project_shared', 'New project: ' || p.name, 'Your agency shared this project with you.', '/portal/projects/' || p.id,
      'project_shared:' || p.id || ':' || extract(epoch from p.portal_shared_at)::bigint);
  elsif was_shared and not p.portal_shared then
    perform leadflow_private.collab_event(p, 'portal_project_unshared', 'Project removed from the client portal');
  elsif p.portal_shared then
    perform leadflow_private.collab_event(p, 'portal_project_updated', 'Client-facing project overview edited');
  end if;
  return jsonb_build_object('version', p.version, 'shared', p.portal_shared, 'sharedAt', p.portal_shared_at);
end $$;

-- Any member. Shows or hides a milestone or deliverable on the portal. Hiding a deliverable withdraws its open review.
create function public.set_client_visibility(target_workspace uuid, target_kind text, target_id uuid, visible boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p leadflow_private.projects; m leadflow_private.project_milestones; d leadflow_private.project_deliverables;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if visible is null then raise exception 'Choose shown or hidden.' using errcode = '22023'; end if;
  if target_kind = 'milestone' then
    select * into m from leadflow_private.project_milestones x where x.id = target_id and x.workspace_id = target_workspace;
    if not found then raise exception 'Milestone not found.' using errcode = 'P0002'; end if;
    p := leadflow_private.lock_project(target_workspace, m.project_id, null);
    update leadflow_private.project_milestones x set client_visible = visible, updated_at = now() where x.id = m.id and x.client_visible <> visible returning * into m;
    if m.id is not null then
      perform leadflow_private.collab_event(p, case when visible then 'portal_milestone_shared' else 'portal_milestone_hidden' end,
        case when visible then 'Milestone shown to the client: ' else 'Milestone hidden from the client: ' end || m.name, '{}', 'milestone', m.id::text);
      if visible then
        perform leadflow_private.notify_clients(p, 'milestone_shared', 'Milestone added: ' || m.name, p.name, '/portal/projects/' || p.id, 'milestone_shared:' || m.id);
      end if;
    end if;
    return jsonb_build_object('id', target_id, 'clientVisible', visible);
  elsif target_kind = 'deliverable' then
    select * into d from leadflow_private.project_deliverables x where x.id = target_id and x.workspace_id = target_workspace;
    if not found then raise exception 'Deliverable not found.' using errcode = 'P0002'; end if;
    p := leadflow_private.lock_project(target_workspace, d.project_id, null);
    if d.client_visible = visible then return jsonb_build_object('id', d.id, 'clientVisible', visible, 'reviewStatus', d.review_status); end if;
    if not visible then
      update leadflow_private.deliverable_reviews r set status = 'withdrawn', closed_at = now(), withdrawn_by = leadflow_private.valid_actor(),
        withdrawn_reason = 'The deliverable was hidden from the client.' where r.deliverable_id = d.id and r.status = 'open';
    end if;
    update leadflow_private.project_deliverables x set client_visible = visible, shared_at = case when visible then coalesce(x.shared_at, now()) else x.shared_at end,
      review_status = case when visible then x.review_status else 'not_shared' end, updated_at = now() where x.id = d.id;
    perform leadflow_private.refresh_review_status(d.id);
    perform leadflow_private.collab_event(p, case when visible then 'portal_deliverable_shared' else 'portal_deliverable_hidden' end,
      case when visible then 'Deliverable shared with the client: ' else 'Deliverable hidden from the client: ' end || d.title, '{}', 'deliverable', d.id::text);
    select * into d from leadflow_private.project_deliverables x where x.id = d.id;
    return jsonb_build_object('id', d.id, 'clientVisible', d.client_visible, 'reviewStatus', d.review_status);
  end if;
  raise exception 'Choose a milestone or a deliverable.' using errcode = '22023';
end $$;

-- ---------- Agency: versions and reviews ----------

create function leadflow_private.lock_deliverable(target_workspace uuid, target_deliverable uuid) returns leadflow_private.project_deliverables
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.project_deliverables;
begin
  select * into d from leadflow_private.project_deliverables x where x.id = target_deliverable and x.workspace_id = target_workspace;
  if not found then raise exception 'Deliverable not found.' using errcode = 'P0002'; end if;
  perform leadflow_private.lock_project(target_workspace, d.project_id, null);
  select * into d from leadflow_private.project_deliverables x where x.id = target_deliverable for update;
  return d;
end $$;

-- Any member. The deliverable's draft version (created when there is none); files are added to it through client-files.
create function public.create_deliverable_version(target_workspace uuid, target_deliverable uuid, notes text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.project_deliverables; v leadflow_private.deliverable_versions;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  d := leadflow_private.lock_deliverable(target_workspace, target_deliverable);
  select * into v from leadflow_private.deliverable_versions x where x.deliverable_id = d.id and x.published_at is null;
  if found then return leadflow_private.version_json(v, false); end if;
  if (select count(*) from leadflow_private.deliverable_versions x where x.deliverable_id = d.id) >= 500 then raise exception 'A deliverable can have at most 500 versions.' using errcode = '54000'; end if;
  insert into leadflow_private.deliverable_versions(workspace_id, project_id, deliverable_id, number, notes, created_by)
    values (target_workspace, d.project_id, d.id, coalesce((select max(x.number) from leadflow_private.deliverable_versions x where x.deliverable_id = d.id), 0) + 1,
      leadflow_private.onboarding_clean_text(notes, 'Notes', 4000, false, false), leadflow_private.valid_actor())
    returning * into v;
  return leadflow_private.version_json(v, false);
end $$;

-- Any member. A draft's notes ("what changed"); published versions never change.
create function public.update_deliverable_version(target_workspace uuid, target_version uuid, notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v leadflow_private.deliverable_versions;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  select * into v from leadflow_private.deliverable_versions x where x.id = target_version and x.workspace_id = target_workspace;
  if not found then raise exception 'Version not found.' using errcode = 'P0002'; end if;
  perform leadflow_private.lock_deliverable(target_workspace, v.deliverable_id);
  update leadflow_private.deliverable_versions x set notes = leadflow_private.onboarding_clean_text(update_deliverable_version.notes, 'Notes', 4000, false, false)
    where x.id = v.id and x.published_at is null returning * into v;
  if v.id is null then raise exception 'This version was already shared and can''t change. Start a new version instead.' using errcode = '55000'; end if;
  return leadflow_private.version_json(v, false);
end $$;

-- Any member. Discards an empty draft.
create function public.discard_deliverable_version(target_workspace uuid, target_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v leadflow_private.deliverable_versions;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  select * into v from leadflow_private.deliverable_versions x where x.id = target_version and x.workspace_id = target_workspace;
  if not found or v.published_at is not null then raise exception 'Draft version not found.' using errcode = 'P0002'; end if;
  perform leadflow_private.lock_deliverable(target_workspace, v.deliverable_id);
  if exists (select 1 from leadflow_private.client_documents d where d.version_id = v.id and d.status in ('pending','available')) then
    raise exception 'Remove this draft''s files first.' using errcode = '55000';
  end if;
  delete from leadflow_private.deliverable_versions x where x.id = v.id;
end $$;

create function leadflow_private.publish_version(v leadflow_private.deliverable_versions) returns leadflow_private.deliverable_versions
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from leadflow_private.client_documents d where d.version_id = v.id and d.status = 'pending' and d.created_at > now() - interval '1 day') then
    raise exception 'Wait for this version''s uploads to finish.' using errcode = '55000';
  end if;
  if not exists (select 1 from leadflow_private.client_documents d where d.version_id = v.id and d.status = 'available') and btrim(v.notes) = '' then
    raise exception 'Add a file or a note about this version first.' using errcode = '22023';
  end if;
  if v.published_at is null then
    update leadflow_private.deliverable_versions x set published_at = now(), published_by = leadflow_private.valid_actor() where x.id = v.id returning * into v;
    update leadflow_private.client_documents d set visibility = 'shared' where d.version_id = v.id and d.status = 'available';
  end if;
  return v;
end $$;

-- Any member. Asks the client to review one version. The project must be shared; the deliverable is shared with it. A
-- draft is published (it never changes after this). One open review per deliverable.
create function public.request_deliverable_review(target_workspace uuid, target_deliverable uuid, details jsonb, request_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.project_deliverables; p leadflow_private.projects; v leadflow_private.deliverable_versions; r leadflow_private.deliverable_reviews;
  reviewers jsonb; due date; again boolean;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the review request as an object.' using errcode = '22023'; end if;
  if request_id is not null then
    select * into r from leadflow_private.deliverable_reviews x where x.workspace_id = target_workspace and x.request_id = request_deliverable_review.request_id;
    if found then return public.deliverable_collab_for(target_workspace, r.deliverable_id); end if;
  end if;
  d := leadflow_private.lock_deliverable(target_workspace, target_deliverable);
  select * into p from leadflow_private.projects x where x.id = d.project_id;
  if not p.portal_shared then raise exception 'Share the project on the client portal first.' using errcode = '55000'; end if;
  select * into v from leadflow_private.deliverable_versions x where x.deliverable_id = d.id and x.id::text = details->>'versionId';
  if not found then raise exception 'Choose a version of this deliverable.' using errcode = '22023'; end if;
  if exists (select 1 from leadflow_private.deliverable_versions x where x.deliverable_id = d.id and x.published_at is not null and x.number > v.number) then
    raise exception 'A newer version was already shared. Ask for a review of the latest version.' using errcode = '55000';
  end if;
  if exists (select 1 from leadflow_private.deliverable_reviews x where x.deliverable_id = d.id and x.status = 'open') then
    raise exception 'This deliverable already has an open review. Withdraw it first.' using errcode = '55000';
  end if;
  if exists (select 1 from leadflow_private.deliverable_decisions x where x.version_id = v.id and x.decision = 'approved') then
    raise exception 'The client already approved this version.' using errcode = '55000';
  end if;
  due := nullif(details->>'dueDate', '')::date;
  if due is not null and due < leadflow_private.project_today(target_workspace) then raise exception 'Choose a review date from today on.' using errcode = '22023'; end if;
  if details ? 'reviewerIds' and details->'reviewerIds' <> 'null'::jsonb then
    if jsonb_typeof(details->'reviewerIds') <> 'array' or jsonb_array_length(details->'reviewerIds') > 20 then raise exception 'Choose up to 20 reviewers.' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(distinct cu.id), '[]'::jsonb) into reviewers from jsonb_array_elements_text(details->'reviewerIds') x
      join leadflow_private.client_users cu on cu.id::text = x and cu.client_id = p.client_id and cu.status = 'active' and cu.role in ('admin','reviewer')
      where leadflow_private.hub_can_see_project(p, cu);
    if jsonb_array_length(reviewers) <> (select count(distinct x) from jsonb_array_elements_text(details->'reviewerIds') x) then
      raise exception 'Reviewers must be client admins or reviewers who can open this project.' using errcode = '22023';
    end if;
  end if;
  v := leadflow_private.publish_version(v);
  again := exists (select 1 from leadflow_private.deliverable_reviews x where x.deliverable_id = d.id and x.status in ('changes_requested','rejected'));
  update leadflow_private.project_deliverables x set client_visible = true, shared_at = coalesce(x.shared_at, now()) where x.id = d.id;
  insert into leadflow_private.deliverable_reviews(workspace_id, project_id, deliverable_id, version_id, message, due_date, reviewer_ids, created_by, request_id)
    values (target_workspace, p.id, d.id, v.id, leadflow_private.onboarding_clean_text(details->>'message', 'Message', 4000, false, false), due, coalesce(reviewers, '[]'::jsonb),
      leadflow_private.valid_actor(), request_id)
    returning * into r;
  perform leadflow_private.refresh_review_status(d.id);
  perform leadflow_private.collab_event(p, case when again then 'review_resubmitted' else 'review_requested' end,
    case when again then 'Revised version sent for review: ' else 'Review requested: ' end || d.title || ' (version ' || v.number || ')',
    jsonb_build_object('versionNumber', v.number, 'dueDate', due), 'deliverable', d.id::text);
  perform leadflow_private.notify_clients(p, case when again then 'review_resubmitted' else 'review_requested' end,
    case when again then 'Revised for your review: ' else 'Ready for your review: ' end || d.title, p.name || ' · version ' || v.number,
    '/portal/projects/' || p.id || '/deliverables/' || d.id, 'review:' || r.id, d.id);
  return public.deliverable_collab_for(target_workspace, d.id);
end $$;

-- Any member. Shares a version without asking for a decision (for information).
create function public.publish_deliverable_version(target_workspace uuid, target_version uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v leadflow_private.deliverable_versions; d leadflow_private.project_deliverables; p leadflow_private.projects;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  select * into v from leadflow_private.deliverable_versions x where x.id = target_version and x.workspace_id = target_workspace;
  if not found then raise exception 'Version not found.' using errcode = 'P0002'; end if;
  d := leadflow_private.lock_deliverable(target_workspace, v.deliverable_id);
  select * into p from leadflow_private.projects x where x.id = d.project_id;
  if not p.portal_shared then raise exception 'Share the project on the client portal first.' using errcode = '55000'; end if;
  if v.published_at is not null then return public.deliverable_collab_for(target_workspace, d.id); end if;
  v := leadflow_private.publish_version(v);
  update leadflow_private.project_deliverables x set client_visible = true, shared_at = coalesce(x.shared_at, now()) where x.id = d.id;
  perform leadflow_private.refresh_review_status(d.id);
  perform leadflow_private.collab_event(p, 'version_shared', 'Version ' || v.number || ' shared with the client: ' || d.title, jsonb_build_object('versionNumber', v.number), 'deliverable', d.id::text);
  perform leadflow_private.notify_clients(p, 'file_shared', 'New files: ' || d.title, p.name || ' · version ' || v.number,
    '/portal/projects/' || p.id || '/deliverables/' || d.id, 'version:' || v.id, d.id);
  return public.deliverable_collab_for(target_workspace, d.id);
end $$;

create function public.withdraw_deliverable_review(target_workspace uuid, target_review uuid, reason text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r leadflow_private.deliverable_reviews; d leadflow_private.project_deliverables; p leadflow_private.projects;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  select * into r from leadflow_private.deliverable_reviews x where x.id = target_review and x.workspace_id = target_workspace;
  if not found then raise exception 'Review not found.' using errcode = 'P0002'; end if;
  d := leadflow_private.lock_deliverable(target_workspace, r.deliverable_id);
  update leadflow_private.deliverable_reviews x set status = 'withdrawn', closed_at = now(), withdrawn_by = leadflow_private.valid_actor(),
    withdrawn_reason = leadflow_private.onboarding_clean_text(reason, 'Reason', 1000, false, false) where x.id = r.id and x.status = 'open' returning * into r;
  if r.id is null then raise exception 'This review is no longer open.' using errcode = '55000'; end if;
  perform leadflow_private.refresh_review_status(d.id);
  select * into p from leadflow_private.projects x where x.id = d.project_id;
  perform leadflow_private.collab_event(p, 'review_withdrawn', 'Review withdrawn: ' || d.title, jsonb_build_object('reason', r.withdrawn_reason), 'deliverable', d.id::text);
  return public.deliverable_collab_for(target_workspace, d.id);
end $$;

-- Any member. Moves a feedback item through its statuses (the client sees the status and note).
create function public.set_feedback_status(target_workspace uuid, target_feedback uuid, details jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f leadflow_private.deliverable_feedback; d leadflow_private.project_deliverables; p leadflow_private.projects; status_value text; addressed uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the change as an object.' using errcode = '22023'; end if;
  select * into f from leadflow_private.deliverable_feedback x where x.id = target_feedback and x.workspace_id = target_workspace;
  if not found then raise exception 'Feedback not found.' using errcode = 'P0002'; end if;
  d := leadflow_private.lock_deliverable(target_workspace, f.deliverable_id);
  status_value := coalesce(nullif(details->>'status', ''), f.status);
  if status_value not in ('open','acknowledged','clarification_requested','addressed','declined') then raise exception 'Choose a feedback status.' using errcode = '22023'; end if;
  if nullif(details->>'addressedInVersion', '') is not null then
    select x.id into addressed from leadflow_private.deliverable_versions x where x.deliverable_id = d.id and x.id::text = details->>'addressedInVersion';
    if addressed is null then raise exception 'Choose a version of this deliverable.' using errcode = '22023'; end if;
  end if;
  update leadflow_private.deliverable_feedback x set status = status_value,
    status_note = case when details ? 'note' then leadflow_private.onboarding_clean_text(details->>'note', 'Note', 1000, false, false) else x.status_note end,
    addressed_in_version = coalesce(addressed, case when status_value = 'addressed' then x.addressed_in_version end), updated_by = leadflow_private.valid_actor(), updated_at = now()
    where x.id = f.id returning * into f;
  select * into p from leadflow_private.projects x where x.id = d.project_id;
  perform leadflow_private.collab_event(p, 'feedback_status', 'Feedback "' || f.title || '" marked ' || replace(status_value, '_', ' '),
    jsonb_build_object('status', status_value), 'feedback', f.id::text);
  if status_value in ('clarification_requested','addressed','declined') and f.client_user_id is not null then
    perform leadflow_private.notify_clients(p, 'feedback_reply',
      case status_value when 'clarification_requested' then 'Question about your feedback: ' when 'addressed' then 'Feedback addressed: ' else 'Reply to your feedback: ' end || f.title,
      d.title, '/portal/projects/' || p.id || '/deliverables/' || d.id, 'feedback_status:' || f.id || ':' || status_value || ':' || extract(epoch from f.updated_at)::bigint,
      d.id, null, array[f.client_user_id]);
  end if;
  return leadflow_private.feedback_json(f, false);
end $$;

-- ---------- Agency: views ----------

-- Any member. Everything about one deliverable's client collaboration, including internal comments.
create function public.deliverable_collab_for(target_workspace uuid, target_deliverable uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.project_deliverables;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into d from leadflow_private.project_deliverables x where x.id = target_deliverable and x.workspace_id = target_workspace;
  if not found then raise exception 'Deliverable not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', d.id, 'projectId', d.project_id, 'title', d.title, 'description', d.description, 'status', d.status, 'clientVisible', d.client_visible,
    'reviewStatus', d.review_status, 'sharedAt', d.shared_at, 'dueDate', d.due_date,
    'versions', coalesce((select jsonb_agg(leadflow_private.version_json(v, false) order by v.number desc) from leadflow_private.deliverable_versions v where v.deliverable_id = d.id), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(leadflow_private.review_json(r, false) order by r.created_at desc) from leadflow_private.deliverable_reviews r where r.deliverable_id = d.id), '[]'::jsonb),
    'feedback', coalesce((select jsonb_agg(leadflow_private.feedback_json(f, false) order by f.created_at desc) from leadflow_private.deliverable_feedback f where f.deliverable_id = d.id), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(leadflow_private.comment_json(c, false) order by c.created_at) from leadflow_private.project_comments c where c.deliverable_id = d.id), '[]'::jsonb),
    'preview', leadflow_private.hub_deliverable_card(d));
end $$;

-- Any member. The project's collaboration overview for the agency.
create function public.project_collab_for(target_workspace uuid, target_project uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p leadflow_private.projects; actor uuid := leadflow_private.valid_actor(); last_read timestamptz;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into p from leadflow_private.projects x where x.id = target_project and x.workspace_id = target_workspace;
  if not found then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  select r.read_at into last_read from leadflow_private.project_comment_reads r where r.project_id = p.id and r.user_id = actor;
  return jsonb_build_object(
    'portal', jsonb_build_object('shared', p.portal_shared, 'sharedAt', p.portal_shared_at, 'summary', p.portal_summary, 'objectives', p.portal_objectives,
      'contactName', p.portal_contact_name, 'contactEmail', p.portal_contact_email, 'version', p.version, 'clientId', p.client_id,
      'clientArchived', exists (select 1 from leadflow_private.clients c where c.id = p.client_id and c.status = 'archived')),
    'people', coalesce((select jsonb_agg(leadflow_private.client_user_json(cu) || jsonb_build_object('canOpen', cu.status = 'active' and (cu.project_access = 'all'
        or exists (select 1 from leadflow_private.client_user_projects a where a.client_user_id = cu.id and a.project_id = p.id)))
        order by cu.status, lower(cu.email)) from leadflow_private.client_users cu where cu.client_id = p.client_id), '[]'::jsonb),
    'pendingInvitations', (select count(*) from leadflow_private.client_invitations i where i.client_id = p.client_id and i.status = 'pending' and i.expires_at > now()),
    'milestones', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'status', m.status, 'dueDate', m.due_date, 'clientVisible', m.client_visible) order by m.position)
      from leadflow_private.project_milestones m where m.project_id = p.id), '[]'::jsonb),
    'deliverables', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'status', d.status, 'dueDate', d.due_date, 'clientVisible', d.client_visible,
        'reviewStatus', d.review_status, 'milestoneId', d.milestone_id,
        'latestVersion', (select jsonb_build_object('id', v.id, 'number', v.number, 'published', v.published_at is not null) from leadflow_private.deliverable_versions v
          where v.deliverable_id = d.id order by v.number desc limit 1),
        'openReview', (select leadflow_private.review_json(r, false) from leadflow_private.deliverable_reviews r where r.deliverable_id = d.id and r.status = 'open'),
        'lastDecision', (select leadflow_private.decision_json(x) from leadflow_private.deliverable_decisions x where x.deliverable_id = d.id order by x.created_at desc limit 1),
        'openFeedback', (select count(*) from leadflow_private.deliverable_feedback f where f.deliverable_id = d.id and f.status in ('open','acknowledged','clarification_requested')))
      order by d.position, d.created_at) from leadflow_private.project_deliverables d where d.project_id = p.id), '[]'::jsonb),
    'updates', coalesce((select jsonb_agg(leadflow_private.update_json(u, false) order by u.status, coalesce(u.published_at, u.updated_at) desc)
      from leadflow_private.project_updates u where u.project_id = p.id), '[]'::jsonb),
    'clientFiles', coalesce((select jsonb_agg(leadflow_private.document_json(d) order by d.created_at desc) from leadflow_private.client_documents d
      where d.project_id = p.id and d.uploaded_client_user is not null and d.status = 'available'), '[]'::jsonb),
    'unreadClientComments', (select count(*) from leadflow_private.project_comments c where c.project_id = p.id and c.author_type = 'client' and c.deleted_at is null
      and c.created_at > coalesce(last_read, '-infinity')),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'summary', a.summary, 'at', a.at, 'actorType', a.actor_type,
        'actor', case when a.actor_type = 'client' then coalesce((select leadflow_private.client_user_label(cu) from leadflow_private.client_users cu where cu.id = a.client_user_id), 'Client')
          when a.actor_type = 'member' then leadflow_private.member_label(a.actor_id) else 'LeadFlow' end) order by a.at desc, a.id desc)
      from (select * from leadflow_private.client_activities a where a.project_id = p.id and (a.kind like 'portal\_%' or a.kind in ('review_requested','review_resubmitted','review_withdrawn',
        'review_viewed','version_shared','feedback_submitted','feedback_status','deliverable_approved','changes_requested','deliverable_rejected','client_commented','comment_shared',
        'update_published','update_corrected','client_file_uploaded')) order by a.at desc, a.id desc limit 100) a), '[]'::jsonb));
end $$;

-- Any member. Exactly the project page the client would see, whether or not it's shared yet.
create function public.project_portal_preview(target_workspace uuid, target_project uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p leadflow_private.projects;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into p from leadflow_private.projects x where x.id = target_project and x.workspace_id = target_workspace;
  if not found then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  return leadflow_private.hub_project_json(p, leadflow_private.project_today(target_workspace), true)
    || jsonb_build_object('clientName', (select c.name from leadflow_private.clients c where c.id = p.client_id), 'agencyName', (select w.name from public.workspaces w where w.id = p.workspace_id));
end $$;

-- Any member. Deliverables in client review across the workspace, and projects with unread client messages.
create function public.collab_queue_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := leadflow_private.valid_actor();
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return jsonb_build_object(
    'deliverables', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'projectId', p.id, 'projectName', p.name, 'clientId', p.client_id,
        'clientName', c.name, 'reviewStatus', d.review_status, 'status', d.status, 'ownerId', p.owner_id,
        'openReview', (select jsonb_build_object('id', r.id, 'dueDate', r.due_date, 'createdAt', r.created_at, 'firstViewedAt', r.first_viewed_at,
            'versionNumber', (select v.number from leadflow_private.deliverable_versions v where v.id = r.version_id))
          from leadflow_private.deliverable_reviews r where r.deliverable_id = d.id and r.status = 'open'),
        'lastDecision', (select leadflow_private.decision_json(x) from leadflow_private.deliverable_decisions x where x.deliverable_id = d.id order by x.created_at desc limit 1),
        'openFeedback', (select count(*) from leadflow_private.deliverable_feedback f where f.deliverable_id = d.id and f.status in ('open','acknowledged','clarification_requested')),
        'updatedAt', greatest(d.updated_at, (select max(r.created_at) from leadflow_private.deliverable_reviews r where r.deliverable_id = d.id),
          (select max(x.created_at) from leadflow_private.deliverable_decisions x where x.deliverable_id = d.id)))
      order by d.updated_at desc)
      from leadflow_private.project_deliverables d join leadflow_private.projects p on p.id = d.project_id join leadflow_private.clients c on c.id = p.client_id
      where d.workspace_id = target_workspace and d.review_status in ('awaiting_review','resubmitted','changes_requested','approved','rejected')), '[]'::jsonb),
    'conversations', coalesce((select jsonb_agg(jsonb_build_object('projectId', p.id, 'projectName', p.name, 'clientName', c.name, 'unread', u.unread, 'lastAt', u.last_at) order by u.last_at desc)
      from (select x.project_id, count(*) as unread, max(x.created_at) as last_at from leadflow_private.project_comments x
        where x.workspace_id = target_workspace and x.author_type = 'client' and x.deleted_at is null
          and x.created_at > coalesce((select r.read_at from leadflow_private.project_comment_reads r where r.project_id = x.project_id and r.user_id = actor), '-infinity')
        group by x.project_id) u join leadflow_private.projects p on p.id = u.project_id join leadflow_private.clients c on c.id = p.client_id), '[]'::jsonb));
end $$;

-- ---------- Agency: comments ----------

-- Any member. A project's comments, internal ones included. scope: {"deliverableId"} or {"feedbackId"}; none = the project thread.
create function public.project_comments_for(target_workspace uuid, target_project uuid, scope jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.projects p where p.id = target_project and p.workspace_id = target_workspace) then
    raise exception 'Project not found in this workspace.' using errcode = 'P0002';
  end if;
  return coalesce((select jsonb_agg(leadflow_private.comment_json(c, false) order by c.created_at) from leadflow_private.project_comments c
    where c.project_id = target_project
      and case when nullif(scope->>'feedbackId', '') is not null then c.feedback_id::text = scope->>'feedbackId'
        when nullif(scope->>'deliverableId', '') is not null then c.deliverable_id::text = scope->>'deliverableId' and c.feedback_id is null
        else c.deliverable_id is null and c.feedback_id is null end), '[]'::jsonb);
end $$;

-- The thread a new comment joins, checked against the project; returns (deliverable, feedback, version).
create function leadflow_private.comment_thread(p leadflow_private.projects, details jsonb, out deliverable_ref uuid, out feedback_ref uuid, out version_ref uuid, out parent_ref uuid,
  out parent_visibility text) language plpgsql stable security definer set search_path = '' as $$
begin
  if nullif(details->>'feedbackId', '') is not null then
    select f.id, f.deliverable_id, f.version_id into feedback_ref, deliverable_ref, version_ref from leadflow_private.deliverable_feedback f
      where f.project_id = p.id and f.id::text = details->>'feedbackId';
    if feedback_ref is null then raise exception 'Feedback not found in this project.' using errcode = 'P0002'; end if;
  elsif nullif(details->>'deliverableId', '') is not null then
    select d.id into deliverable_ref from leadflow_private.project_deliverables d where d.project_id = p.id and d.id::text = details->>'deliverableId';
    if deliverable_ref is null then raise exception 'Deliverable not found in this project.' using errcode = 'P0002'; end if;
    if nullif(details->>'versionId', '') is not null then
      select v.id into version_ref from leadflow_private.deliverable_versions v where v.deliverable_id = deliverable_ref and v.id::text = details->>'versionId';
      if version_ref is null then raise exception 'Version not found.' using errcode = 'P0002'; end if;
    end if;
  end if;
  if nullif(details->>'parentId', '') is not null then
    select c.id, c.visibility into parent_ref, parent_visibility from leadflow_private.project_comments c where c.project_id = p.id and c.id::text = details->>'parentId'
      and c.parent_id is null and c.deliverable_id is not distinct from deliverable_ref and c.feedback_id is not distinct from feedback_ref;
    if parent_ref is null then raise exception 'Reply to a comment in the same thread.' using errcode = '22023'; end if;
  end if;
end $$;

-- Any member. Internal by default; a client-visible comment notifies the client people who can open the project.
create function public.add_project_comment(target_workspace uuid, target_project uuid, details jsonb, request_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p leadflow_private.projects; t record; visibility_value text; created leadflow_private.project_comments; d leadflow_private.project_deliverables; f leadflow_private.deliverable_feedback;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the comment as an object.' using errcode = '22023'; end if;
  if request_id is not null then
    select * into created from leadflow_private.project_comments c where c.workspace_id = target_workspace and c.request_id = add_project_comment.request_id;
    if found then return leadflow_private.comment_json(created, false); end if;
  end if;
  p := leadflow_private.lock_project(target_workspace, target_project, null);
  select * into t from leadflow_private.comment_thread(p, details);
  visibility_value := coalesce(nullif(details->>'visibility', ''), 'internal');
  if visibility_value not in ('internal','client') then raise exception 'Choose internal or visible to the client.' using errcode = '22023'; end if;
  if visibility_value = 'client' and t.parent_visibility = 'internal' then raise exception 'Replies to an internal note stay internal.' using errcode = '22023'; end if;
  if visibility_value = 'client' and t.deliverable_ref is not null and not exists (select 1 from leadflow_private.project_deliverables x where x.id = t.deliverable_ref and x.client_visible) then
    raise exception 'Share the deliverable with the client first.' using errcode = '55000';
  end if;
  if (select count(*) from leadflow_private.project_comments c where c.project_id = p.id) >= 5000 then raise exception 'A project can have at most 5,000 comments.' using errcode = '54000'; end if;
  insert into leadflow_private.project_comments(workspace_id, project_id, deliverable_id, feedback_id, version_id, parent_id, author_type, member_id, visibility, body, request_id)
    values (target_workspace, p.id, t.deliverable_ref, t.feedback_ref, t.version_ref, t.parent_ref, 'member', leadflow_private.valid_actor(), visibility_value,
      leadflow_private.onboarding_clean_text(details->>'body', 'Comment', 5000, true, false), request_id)
    returning * into created;
  if visibility_value = 'client' then
    select * into d from leadflow_private.project_deliverables x where x.id = t.deliverable_ref;
    select * into f from leadflow_private.deliverable_feedback x where x.id = t.feedback_ref;
    perform leadflow_private.collab_event(p, 'comment_shared', 'Reply to the client' || case when d.id is not null then ' on ' || d.title else '' end, '{}', 'comment', created.id::text);
    perform leadflow_private.notify_clients(p, case when f.id is not null then 'feedback_reply' else 'comment_added' end,
      case when f.id is not null then 'Reply to your feedback: ' || f.title when d.id is not null then 'New message about ' || d.title else 'New message: ' || p.name end,
      left(created.body, 200), '/portal/projects/' || p.id || case when d.id is not null then '/deliverables/' || d.id else '/messages' end, 'comment:' || created.id, d.id);
  end if;
  return leadflow_private.comment_json(created, false);
end $$;

-- Members edit their own comments; the earlier text is kept for the agency.
create function public.edit_project_comment(target_workspace uuid, target_comment uuid, body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c leadflow_private.project_comments;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  select * into c from leadflow_private.project_comments x where x.id = target_comment and x.workspace_id = target_workspace and x.deleted_at is null for update;
  if not found then raise exception 'Comment not found.' using errcode = 'P0002'; end if;
  if c.author_type <> 'member' or c.member_id is distinct from leadflow_private.valid_actor() then raise exception 'You can only edit your own comments.' using errcode = '42501'; end if;
  perform leadflow_private.lock_project(target_workspace, c.project_id, null);
  insert into leadflow_private.project_comment_revisions(comment_id, body, action, actor_type, actor_id) values (c.id, c.body, 'edited', 'member', leadflow_private.valid_actor());
  update leadflow_private.project_comments x set body = leadflow_private.onboarding_clean_text(edit_project_comment.body, 'Comment', 5000, true, false), edited_at = now()
    where x.id = c.id returning * into c;
  return leadflow_private.comment_json(c, false);
end $$;

-- Authors delete their own comments; owners and admins can remove any. The text stays in the agency's audit.
create function public.delete_project_comment(target_workspace uuid, target_comment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c leadflow_private.project_comments; actor_role text;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  select * into c from leadflow_private.project_comments x where x.id = target_comment and x.workspace_id = target_workspace and x.deleted_at is null for update;
  if not found then raise exception 'Comment not found.' using errcode = 'P0002'; end if;
  if actor_role = 'member' and (c.author_type <> 'member' or c.member_id is distinct from leadflow_private.valid_actor()) then
    raise exception 'Only owners, admins or the author can delete a comment.' using errcode = '42501';
  end if;
  insert into leadflow_private.project_comment_revisions(comment_id, body, action, actor_type, actor_id) values (c.id, c.body, 'deleted', 'member', leadflow_private.valid_actor());
  update leadflow_private.project_comments x set deleted_at = now(), deleted_by_type = 'member' where x.id = c.id returning * into c;
  return leadflow_private.comment_json(c, false);
end $$;

-- Any member. Earlier text of an edited or deleted comment.
create function public.project_comment_history(target_workspace uuid, target_comment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.project_comments c where c.id = target_comment and c.workspace_id = target_workspace) then raise exception 'Comment not found.' using errcode = 'P0002'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('body', r.body, 'action', r.action, 'at', r.at, 'by', case when r.actor_type = 'member' then leadflow_private.member_label(r.actor_id)
    else coalesce((select leadflow_private.client_user_label(cu) from leadflow_private.client_users cu where cu.id = r.actor_id), 'Client') end) order by r.at desc)
    from leadflow_private.project_comment_revisions r where r.comment_id = target_comment), '[]'::jsonb);
end $$;

create function public.mark_project_discussion_read(target_workspace uuid, target_project uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if not exists (select 1 from leadflow_private.projects p where p.id = target_project and p.workspace_id = target_workspace) then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  insert into leadflow_private.project_comment_reads(project_id, user_id, read_at) values (target_project, leadflow_private.valid_actor(), now())
    on conflict (project_id, user_id) do update set read_at = now();
end $$;

-- ---------- Agency: published updates ----------

-- Any member. Creates or edits an update. Editing a published update keeps its earlier text and marks it corrected.
create function public.save_project_update(target_workspace uuid, target_project uuid, target_update uuid, details jsonb, expected_version integer default null, request_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p leadflow_private.projects; u leadflow_private.project_updates; clean_title text; clean_body text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the update as an object.' using errcode = '22023'; end if;
  p := leadflow_private.lock_project(target_workspace, target_project, null);
  clean_title := leadflow_private.onboarding_clean_text(details->>'title', 'Title', 150, true, true);
  clean_body := leadflow_private.onboarding_clean_text(details->>'body', 'Update', 8000, false, false);
  if target_update is null then
    if request_id is not null then
      select * into u from leadflow_private.project_updates x where x.workspace_id = target_workspace and x.request_id = save_project_update.request_id;
      if found then return leadflow_private.update_json(u, false); end if;
    end if;
    if (select count(*) from leadflow_private.project_updates x where x.project_id = p.id) >= 500 then raise exception 'A project can have at most 500 updates.' using errcode = '54000'; end if;
    insert into leadflow_private.project_updates(workspace_id, project_id, title, body, author_id, request_id) values (target_workspace, p.id, clean_title, clean_body, leadflow_private.valid_actor(), request_id)
      returning * into u;
    return leadflow_private.update_json(u, false);
  end if;
  select * into u from leadflow_private.project_updates x where x.id = target_update and x.project_id = p.id for update;
  if not found then raise exception 'Update not found.' using errcode = 'P0002'; end if;
  if expected_version is not null and u.version <> expected_version then raise exception 'This update was changed in another window. Reload and try again.' using errcode = '40001'; end if;
  if u.status = 'published' and (u.title <> clean_title or u.body <> clean_body) then
    insert into leadflow_private.project_update_revisions(update_id, title, body, edited_by) values (u.id, u.title, u.body, leadflow_private.valid_actor());
    perform leadflow_private.collab_event(p, 'update_corrected', 'Published update corrected: ' || clean_title, '{}', 'update', u.id::text);
  end if;
  update leadflow_private.project_updates x set title = clean_title, body = clean_body, version = x.version + 1, updated_at = now(),
    corrected_at = case when x.status = 'published' and (x.title <> clean_title or x.body <> clean_body) then now() else x.corrected_at end
    where x.id = u.id returning * into u;
  return leadflow_private.update_json(u, false);
end $$;

-- Any member. Publishes a draft to the client.
create function public.publish_project_update(target_workspace uuid, target_update uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u leadflow_private.project_updates; p leadflow_private.projects;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  select * into u from leadflow_private.project_updates x where x.id = target_update and x.workspace_id = target_workspace;
  if not found then raise exception 'Update not found.' using errcode = 'P0002'; end if;
  p := leadflow_private.lock_project(target_workspace, u.project_id, null);
  if not p.portal_shared then raise exception 'Share the project on the client portal first.' using errcode = '55000'; end if;
  if exists (select 1 from leadflow_private.client_documents d where d.update_id = u.id and d.status = 'pending' and d.created_at > now() - interval '1 day') then
    raise exception 'Wait for this update''s uploads to finish.' using errcode = '55000';
  end if;
  update leadflow_private.project_updates x set status = 'published', published_at = now(), published_by = leadflow_private.valid_actor(), version = x.version + 1, updated_at = now()
    where x.id = u.id and x.status = 'draft' returning * into u;
  if u.id is null then raise exception 'This update is already published.' using errcode = '55000'; end if;
  update leadflow_private.client_documents d set visibility = 'shared' where d.update_id = u.id and d.status = 'available';
  perform leadflow_private.collab_event(p, 'update_published', 'Update published: ' || u.title, '{}', 'update', u.id::text);
  perform leadflow_private.notify_clients(p, 'update_published', u.title, p.name, '/portal/projects/' || p.id, 'update:' || u.id);
  return leadflow_private.update_json(u, false);
end $$;

create function public.delete_project_update(target_workspace uuid, target_update uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare u leadflow_private.project_updates;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  select * into u from leadflow_private.project_updates x where x.id = target_update and x.workspace_id = target_workspace;
  if not found then raise exception 'Update not found.' using errcode = 'P0002'; end if;
  perform leadflow_private.lock_project(target_workspace, u.project_id, null);
  if u.status <> 'draft' then raise exception 'Published updates can be corrected but not deleted.' using errcode = '55000'; end if;
  if exists (select 1 from leadflow_private.client_documents d where d.update_id = u.id and d.status in ('pending','available')) then raise exception 'Remove this draft''s files first.' using errcode = '55000'; end if;
  delete from leadflow_private.project_updates x where x.id = u.id;
end $$;

-- ---------- Agency: notifications ----------

create function public.member_notifications_for(target_workspace uuid, only_unread boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := leadflow_private.valid_actor();
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'event', n.event, 'title', n.title, 'body', n.body, 'projectId', n.project_id, 'deliverableId', n.deliverable_id,
        'createdAt', n.created_at, 'readAt', n.read_at) order by n.created_at desc, n.id desc)
      from (select * from leadflow_private.portal_notifications n where n.workspace_id = target_workspace and n.recipient_type = 'member' and n.user_id = actor
        and (not only_unread or n.read_at is null) order by n.created_at desc, n.id desc limit 50) n), '[]'::jsonb),
    'unread', (select count(*) from leadflow_private.portal_notifications n where n.workspace_id = target_workspace and n.recipient_type = 'member' and n.user_id = actor and n.read_at is null));
end $$;

-- ids: an array of notification IDs, or null for all.
create function public.mark_member_notifications(target_workspace uuid, ids jsonb default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  update leadflow_private.portal_notifications n set read_at = now() where n.workspace_id = target_workspace and n.recipient_type = 'member'
    and n.user_id = leadflow_private.valid_actor() and n.read_at is null and (ids is null or ids = 'null'::jsonb or n.id::text in (select jsonb_array_elements_text(case when jsonb_typeof(ids) = 'array' then ids else '[]'::jsonb end)));
  get diagnostics changed = row_count;
  return changed;
end $$;

create function leadflow_private.member_events() returns jsonb language sql immutable set search_path = '' as $$
  select '["client_activated","feedback_submitted","changes_requested","deliverable_approved","deliverable_rejected","client_commented","client_file_uploaded"]'::jsonb
$$;

create function public.member_notification_settings(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return jsonb_build_object('emailEvents', coalesce((select q.email_events from leadflow_private.portal_member_preferences q where q.workspace_id = target_workspace
      and q.user_id = leadflow_private.valid_actor()), leadflow_private.member_email_defaults()),
    'events', leadflow_private.member_events());
end $$;

create function public.save_member_notification_settings(target_workspace uuid, email_events jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cleaned jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if email_events is null or jsonb_typeof(email_events) <> 'array' then raise exception 'Send the events as a list.' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into cleaned from jsonb_array_elements_text(email_events) x where leadflow_private.member_events() ? x;
  insert into leadflow_private.portal_member_preferences(workspace_id, user_id, email_events) values (target_workspace, leadflow_private.valid_actor(), cleaned)
    on conflict (workspace_id, user_id) do update set email_events = excluded.email_events, updated_at = now();
  return public.member_notification_settings(target_workspace);
end $$;

-- ---------- Agency: AI context ----------

-- Any member, called by project-assistant with the member's own token. Feedback, comments and versions of a project (or
-- one deliverable), for suggestions a person reviews. Client-written text is data, never instructions.
create function public.project_collab_ai_context(target_workspace uuid, target_project uuid, target_deliverable uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p leadflow_private.projects;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into p from leadflow_private.projects x where x.id = target_project and x.workspace_id = target_workspace;
  if not found then raise exception 'Project not found in this workspace.' using errcode = 'P0002'; end if;
  if target_deliverable is not null and not exists (select 1 from leadflow_private.project_deliverables d where d.id = target_deliverable and d.project_id = p.id) then
    raise exception 'Deliverable not found in this project.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('project', jsonb_build_object('name', p.name),
    'deliverables', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'reviewStatus', d.review_status,
        'versions', coalesce((select jsonb_agg(jsonb_build_object('number', v.number, 'notes', v.notes, 'published', v.published_at is not null,
            'files', (select coalesce(jsonb_agg(x.file_name), '[]'::jsonb) from leadflow_private.client_documents x where x.version_id = v.id and x.status = 'available')) order by v.number)
          from leadflow_private.deliverable_versions v where v.deliverable_id = d.id), '[]'::jsonb),
        'feedback', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'title', f.title, 'body', f.body, 'category', f.category, 'status', f.status,
            'version', (select v.number from leadflow_private.deliverable_versions v where v.id = f.version_id),
            'addressedIn', (select v.number from leadflow_private.deliverable_versions v where v.id = f.addressed_in_version)) order by f.created_at)
          from leadflow_private.deliverable_feedback f where f.deliverable_id = d.id), '[]'::jsonb),
        'decisions', coalesce((select jsonb_agg(jsonb_build_object('decision', x.decision, 'version', (select v.number from leadflow_private.deliverable_versions v where v.id = x.version_id),
            'comment', x.comment) order by x.created_at) from leadflow_private.deliverable_decisions x where x.deliverable_id = d.id), '[]'::jsonb)) order by d.position)
      from leadflow_private.project_deliverables d where d.project_id = p.id and (target_deliverable is null or d.id = target_deliverable) and d.client_visible), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('author', case when c.author_type = 'client' then 'client' else 'agency' end, 'visibility', c.visibility,
        'deliverable', (select d.title from leadflow_private.project_deliverables d where d.id = c.deliverable_id), 'body', c.body, 'at', c.created_at) order by c.created_at)
      from (select * from leadflow_private.project_comments c where c.project_id = p.id and c.deleted_at is null
        and (target_deliverable is null or c.deliverable_id = target_deliverable) order by c.created_at desc limit 80) c), '[]'::jsonb));
end $$;

-- ---------- Client portal (hub_) ----------
-- Signed-in client people. Each function finds the caller's active access first; anything outside it is "not found".

-- Per-person limits on writes (comments, feedback, decisions, invitation acceptance). A refused attempt rolls back its own
-- count, so the limit holds for the rest of the minute.
create function leadflow_private.hub_rate_limit(bucket_key text, max_per_minute integer) returns void
language plpgsql security definer set search_path = '' as $$
declare hit_count integer;
begin
  insert into leadflow_private.request_limits values (bucket_key, date_trunc('minute', now()), 1)
    on conflict (bucket, minute) do update set hits = leadflow_private.request_limits.hits + 1 returning hits into hit_count;
  if hit_count > max_per_minute then raise exception 'Too many requests. Please wait a minute and try again.' using errcode = '54000'; end if;
end $$;

-- The client spaces the caller can open (one per client that invited them).
create function public.hub_accounts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := leadflow_private.valid_actor();
begin
  if actor is null then raise exception 'Sign in to your client portal.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('accessId', cu.id, 'clientId', c.id, 'clientName', c.name, 'agencyName', w.name, 'role', cu.role, 'name', cu.name, 'email', cu.email)
      order by w.name, c.name)
    from leadflow_private.client_users cu join leadflow_private.clients c on c.id = cu.client_id join public.workspaces w on w.id = cu.workspace_id
    where cu.user_id = actor and cu.status = 'active' and c.status <> 'archived'), '[]'::jsonb);
end $$;

-- The dashboard: projects, items awaiting the caller, upcoming dates, recent updates, messages and files.
create function public.hub_home(target_access uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cu leadflow_private.client_users; today date;
begin
  cu := leadflow_private.hub_access_by_id(target_access);
  today := leadflow_private.project_today(cu.workspace_id);
  update leadflow_private.client_users x set last_seen_at = now() where x.id = cu.id and (x.last_seen_at is null or x.last_seen_at < now() - interval '5 minutes');
  return jsonb_build_object(
    'access', jsonb_build_object('id', cu.id, 'name', cu.name, 'email', cu.email, 'role', cu.role),
    'client', (select jsonb_build_object('id', c.id, 'name', c.name) from leadflow_private.clients c where c.id = cu.client_id),
    'agencyName', (select w.name from public.workspaces w where w.id = cu.workspace_id),
    'projects', coalesce((select jsonb_agg(leadflow_private.hub_project_json(p, today, false) order by (p.status in ('completed','cancelled')), p.target_date nulls last, p.created_at desc)
      from leadflow_private.projects p where p.client_id = cu.client_id and leadflow_private.hub_can_see_project(p, cu)), '[]'::jsonb),
    'awaiting', coalesce((select jsonb_agg(jsonb_build_object('reviewId', r.id, 'deliverableId', d.id, 'title', d.title, 'projectId', p.id, 'projectName', p.name,
        'versionNumber', (select v.number from leadflow_private.deliverable_versions v where v.id = r.version_id), 'dueDate', r.due_date, 'requestedAt', r.created_at,
        'canDecide', cu.role in ('admin','reviewer') and (jsonb_array_length(r.reviewer_ids) = 0 or r.reviewer_ids ? cu.id::text or cu.role = 'admin'))
        order by r.due_date nulls last, r.created_at)
      from leadflow_private.deliverable_reviews r join leadflow_private.project_deliverables d on d.id = r.deliverable_id and d.client_visible
        join leadflow_private.projects p on p.id = r.project_id
      where r.status = 'open' and p.client_id = cu.client_id and leadflow_private.hub_can_see_project(p, cu)), '[]'::jsonb),
    'upcoming', coalesce((select jsonb_agg(y.x order by y.x->>'dueDate') from (select u.x from (
        select jsonb_build_object('kind', 'milestone', 'id', m.id, 'title', m.name, 'projectId', p.id, 'projectName', p.name, 'dueDate', m.due_date) as x
          from leadflow_private.project_milestones m join leadflow_private.projects p on p.id = m.project_id
          where m.client_visible and m.status not in ('completed','cancelled') and m.due_date >= today and p.client_id = cu.client_id and leadflow_private.hub_can_see_project(p, cu)
        union all
        select jsonb_build_object('kind', 'deliverable', 'id', d.id, 'title', d.title, 'projectId', p.id, 'projectName', p.name, 'dueDate', d.due_date)
          from leadflow_private.project_deliverables d join leadflow_private.projects p on p.id = d.project_id
          where d.client_visible and d.status <> 'completed' and d.due_date >= today and p.client_id = cu.client_id and leadflow_private.hub_can_see_project(p, cu)
        ) u order by u.x->>'dueDate' limit 8) y), '[]'::jsonb),
    'updates', coalesce((select jsonb_agg(leadflow_private.update_json(u, true) || jsonb_build_object('projectName', p.name) order by u.published_at desc)
      from (select u.* from leadflow_private.project_updates u join leadflow_private.projects p on p.id = u.project_id
        where u.status = 'published' and p.client_id = cu.client_id and leadflow_private.hub_can_see_project(p, cu) order by u.published_at desc limit 5) u
      join leadflow_private.projects p on p.id = u.project_id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(leadflow_private.comment_json(c, true) || jsonb_build_object('projectName', p.name) order by c.created_at desc)
      from (select c.* from leadflow_private.project_comments c join leadflow_private.projects p on p.id = c.project_id
        where c.visibility = 'client' and c.deleted_at is null and p.client_id = cu.client_id and leadflow_private.hub_can_see_project(p, cu)
          and (c.deliverable_id is null or exists (select 1 from leadflow_private.project_deliverables d where d.id = c.deliverable_id and d.client_visible))
        order by c.created_at desc limit 5) c join leadflow_private.projects p on p.id = c.project_id), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(leadflow_private.hub_document_json(d) order by d.created_at desc)
      from (select d.* from leadflow_private.client_documents d where d.client_id = cu.client_id and d.status = 'available' and leadflow_private.hub_can_see_document(d, cu)
        order by d.created_at desc limit 6) d), '[]'::jsonb),
    'unread', (select count(*) from leadflow_private.portal_notifications n where n.client_user_id = cu.id and n.read_at is null));
end $$;

create function public.hub_project(target_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cu leadflow_private.client_users; p leadflow_private.projects;
begin
  cu := leadflow_private.hub_open_project(target_project);
  select * into p from leadflow_private.projects x where x.id = target_project;
  return leadflow_private.hub_project_json(p, leadflow_private.project_today(p.workspace_id), true)
    || jsonb_build_object('accessId', cu.id, 'role', cu.role, 'canUpload', cu.role in ('admin','member'),
      'agencyName', (select w.name from public.workspaces w where w.id = p.workspace_id));
end $$;

-- One shared deliverable: its shared versions, reviews, decisions and feedback. Opening it records the first view of an
-- open review (the only "viewed" signal LeadFlow reports).
create function public.hub_deliverable(target_deliverable uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.project_deliverables; cu leadflow_private.client_users; p leadflow_private.projects; r leadflow_private.deliverable_reviews;
begin
  d := leadflow_private.hub_open_deliverable(target_deliverable);
  cu := leadflow_private.hub_open_project(d.project_id);
  select * into p from leadflow_private.projects x where x.id = d.project_id;
  update leadflow_private.deliverable_reviews x set first_viewed_at = now(), first_viewed_by = cu.id where x.deliverable_id = d.id and x.status = 'open' and x.first_viewed_at is null
    returning * into r;
  if r.id is not null then
    perform leadflow_private.collab_event(p, 'review_viewed', leadflow_private.client_user_label(cu) || ' opened the review of ' || d.title, '{}', 'deliverable', d.id::text, cu);
  end if;
  select * into r from leadflow_private.deliverable_reviews x where x.deliverable_id = d.id and x.status = 'open';
  return leadflow_private.hub_deliverable_card(d) || jsonb_build_object('projectId', p.id, 'projectName', p.name, 'role', cu.role, 'accessId', cu.id,
    'versions', coalesce((select jsonb_agg(leadflow_private.version_json(v, true) order by v.number desc) from leadflow_private.deliverable_versions v
      where v.deliverable_id = d.id and v.published_at is not null), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(leadflow_private.review_json(x, true) order by x.created_at desc) from leadflow_private.deliverable_reviews x
      where x.deliverable_id = d.id and x.status <> 'withdrawn'), '[]'::jsonb),
    'feedback', coalesce((select jsonb_agg(leadflow_private.feedback_json(f, true) order by f.created_at desc) from leadflow_private.deliverable_feedback f where f.deliverable_id = d.id), '[]'::jsonb),
    'canDecide', r.id is not null and cu.role in ('admin','reviewer') and (jsonb_array_length(r.reviewer_ids) = 0 or r.reviewer_ids ? cu.id::text or cu.role = 'admin'),
    'canGiveFeedback', exists (select 1 from leadflow_private.deliverable_versions v where v.deliverable_id = d.id and v.published_at is not null));
end $$;

create function leadflow_private.hub_clean_feedback(item jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
begin
  if item is null or jsonb_typeof(item) <> 'object' then raise exception 'Send each feedback item as an object.' using errcode = '22023'; end if;
  if coalesce(nullif(item->>'category', ''), 'general') not in ('design','content','functional','technical','general') then raise exception 'Choose a feedback category.' using errcode = '22023'; end if;
  return jsonb_build_object('title', leadflow_private.onboarding_clean_text(item->>'title', 'Feedback title', 150, true, true),
    'body', leadflow_private.onboarding_clean_text(item->>'body', 'Feedback', 4000, false, false), 'category', coalesce(nullif(item->>'category', ''), 'general'));
end $$;

-- Client admins and reviewers decide on an open review, for its version only. Changes requested needs at least one
-- feedback item or a comment; a rejection needs a comment. Recorded once, never changed.
create function public.hub_decide(target_review uuid, details jsonb, request_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r leadflow_private.deliverable_reviews; d leadflow_private.project_deliverables; cu leadflow_private.client_users; p leadflow_private.projects;
  decision_value text; comment_value text; items jsonb := '[]'; item jsonb; prior leadflow_private.deliverable_decisions; actor_email text; event_name text;
begin
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the decision as an object.' using errcode = '22023'; end if;
  select * into r from leadflow_private.deliverable_reviews x where x.id = target_review;
  if not found then raise exception 'Not found.' using errcode = 'P0002'; end if;
  d := leadflow_private.hub_open_deliverable(r.deliverable_id);
  cu := leadflow_private.hub_open_project(d.project_id);
  if request_id is not null then
    select * into prior from leadflow_private.deliverable_decisions x where x.workspace_id = cu.workspace_id and x.request_id = hub_decide.request_id;
    if found then
      if prior.client_user_id is distinct from cu.id then raise exception 'Not found.' using errcode = 'P0002'; end if;
      return public.hub_deliverable(d.id);
    end if;
  end if;
  if cu.role not in ('admin','reviewer') then raise exception 'Your portal role can''t approve or reject. Add feedback instead.' using errcode = '42501'; end if;
  perform leadflow_private.hub_rate_limit('hub-decide-' || cu.id, 10);
  if jsonb_array_length(r.reviewer_ids) > 0 and not r.reviewer_ids ? cu.id::text and cu.role <> 'admin' then
    raise exception 'This review was assigned to someone else.' using errcode = '42501';
  end if;
  select * into p from leadflow_private.projects x where x.id = d.project_id for update;
  select * into r from leadflow_private.deliverable_reviews x where x.id = r.id for update;
  if r.status <> 'open' then raise exception 'This review is closed. Reload to see the latest version.' using errcode = '55000'; end if;
  decision_value := details->>'decision';
  if decision_value not in ('approved','changes_requested','rejected') then raise exception 'Choose approve, request changes or reject.' using errcode = '22023'; end if;
  comment_value := leadflow_private.onboarding_clean_text(details->>'comment', 'Comment', 4000, decision_value = 'rejected', false);
  if details ? 'feedback' and details->'feedback' <> 'null'::jsonb then
    if jsonb_typeof(details->'feedback') <> 'array' or jsonb_array_length(details->'feedback') > 20 then raise exception 'Add up to 20 feedback items at once.' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(leadflow_private.hub_clean_feedback(x)), '[]'::jsonb) into items from jsonb_array_elements(details->'feedback') x;
  end if;
  if decision_value = 'changes_requested' and jsonb_array_length(items) = 0 and comment_value = '' then
    raise exception 'Describe the changes you need.' using errcode = '22023';
  end if;
  select u.email into actor_email from auth.users u where u.id = cu.user_id;
  insert into leadflow_private.deliverable_decisions(workspace_id, project_id, deliverable_id, version_id, review_id, client_user_id, user_id, reviewer_name, reviewer_email, decision, comment, request_id)
    values (cu.workspace_id, p.id, d.id, r.version_id, r.id, cu.id, cu.user_id, leadflow_private.client_user_label(cu), coalesce(actor_email, cu.email), decision_value, comment_value, request_id);
  for item in select x from jsonb_array_elements(items) x loop
    insert into leadflow_private.deliverable_feedback(workspace_id, project_id, deliverable_id, version_id, review_id, client_user_id, author_name, title, body, category)
      values (cu.workspace_id, p.id, d.id, r.version_id, r.id, cu.id, leadflow_private.client_user_label(cu), item->>'title', item->>'body', item->>'category');
  end loop;
  update leadflow_private.deliverable_reviews x set status = decision_value, closed_at = now() where x.id = r.id;
  perform leadflow_private.refresh_review_status(d.id);
  event_name := case decision_value when 'approved' then 'deliverable_approved' when 'rejected' then 'deliverable_rejected' else 'changes_requested' end;
  perform leadflow_private.collab_event(p, event_name, leadflow_private.client_user_label(cu) || case decision_value when 'approved' then ' approved ' when 'rejected' then ' rejected '
      else ' requested changes to ' end || d.title || ' (version ' || (select v.number from leadflow_private.deliverable_versions v where v.id = r.version_id) || ')',
    jsonb_build_object('feedbackItems', jsonb_array_length(items)), 'deliverable', d.id::text, cu);
  perform leadflow_private.notify_members(p, event_name, case decision_value when 'approved' then 'Approved: ' when 'rejected' then 'Rejected: ' else 'Changes requested: ' end || d.title,
    leadflow_private.client_user_label(cu) || ' · ' || p.name, 'decision:' || r.id, d.id, array_remove(array[r.created_by], null));
  return public.hub_deliverable(d.id);
end $$;

-- Any client role adds feedback on the latest shared version (or a chosen shared version); it doesn't decide the review.
create function public.hub_add_feedback(target_deliverable uuid, details jsonb, request_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.project_deliverables; cu leadflow_private.client_users; p leadflow_private.projects; v leadflow_private.deliverable_versions; item jsonb;
  created leadflow_private.deliverable_feedback;
begin
  d := leadflow_private.hub_open_deliverable(target_deliverable);
  cu := leadflow_private.hub_open_project(d.project_id);
  if request_id is not null then
    select * into created from leadflow_private.deliverable_feedback f where f.workspace_id = cu.workspace_id and f.request_id = hub_add_feedback.request_id;
    if found then
      if created.client_user_id is distinct from cu.id then raise exception 'Not found.' using errcode = 'P0002'; end if;
      return leadflow_private.feedback_json(created, true);
    end if;
  end if;
  perform leadflow_private.hub_rate_limit('hub-feedback-' || cu.id, 30);
  item := leadflow_private.hub_clean_feedback(details);
  select * into v from leadflow_private.deliverable_versions x where x.deliverable_id = d.id and x.published_at is not null
    and (nullif(details->>'versionId', '') is null or x.id::text = details->>'versionId') order by x.number desc limit 1;
  if not found then raise exception 'There is no shared version to give feedback on yet.' using errcode = '55000'; end if;
  if (select count(*) from leadflow_private.deliverable_feedback f where f.deliverable_id = d.id) >= 1000 then raise exception 'This deliverable has too much feedback to add more.' using errcode = '54000'; end if;
  select * into p from leadflow_private.projects x where x.id = d.project_id;
  insert into leadflow_private.deliverable_feedback(workspace_id, project_id, deliverable_id, version_id, review_id, client_user_id, author_name, title, body, category, request_id)
    values (cu.workspace_id, p.id, d.id, v.id, (select r.id from leadflow_private.deliverable_reviews r where r.deliverable_id = d.id and r.status = 'open' and r.version_id = v.id),
      cu.id, leadflow_private.client_user_label(cu), item->>'title', item->>'body', item->>'category', request_id)
    returning * into created;
  perform leadflow_private.collab_event(p, 'feedback_submitted', leadflow_private.client_user_label(cu) || ' gave feedback on ' || d.title || ': ' || created.title,
    jsonb_build_object('category', created.category, 'versionNumber', v.number), 'feedback', created.id::text, cu);
  perform leadflow_private.notify_members(p, 'feedback_submitted', 'Feedback on ' || d.title || ': ' || created.title, leadflow_private.client_user_label(cu) || ' · ' || p.name,
    'feedback:' || created.id, d.id);
  return leadflow_private.feedback_json(created, true);
end $$;

-- Client-visible comments of a project thread, a deliverable or a feedback item.
create function public.hub_comments(target_project uuid, scope jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cu leadflow_private.client_users;
begin
  cu := leadflow_private.hub_open_project(target_project);
  if nullif(scope->>'deliverableId', '') is not null then perform leadflow_private.hub_open_deliverable((scope->>'deliverableId')::uuid); end if;
  return coalesce((select jsonb_agg(leadflow_private.comment_json(c, true) order by c.created_at) from leadflow_private.project_comments c
    where c.project_id = target_project and c.visibility = 'client'
      and (c.deliverable_id is null or exists (select 1 from leadflow_private.project_deliverables d where d.id = c.deliverable_id and d.client_visible))
      and case when nullif(scope->>'feedbackId', '') is not null then c.feedback_id::text = scope->>'feedbackId'
        when nullif(scope->>'deliverableId', '') is not null then c.deliverable_id::text = scope->>'deliverableId' and c.feedback_id is null
        else c.deliverable_id is null and c.feedback_id is null end), '[]'::jsonb);
end $$;

create function public.hub_add_comment(target_project uuid, details jsonb, request_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cu leadflow_private.client_users; p leadflow_private.projects; t record; created leadflow_private.project_comments; d leadflow_private.project_deliverables;
begin
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the comment as an object.' using errcode = '22023'; end if;
  cu := leadflow_private.hub_open_project(target_project);
  if request_id is not null then
    select * into created from leadflow_private.project_comments c where c.workspace_id = cu.workspace_id and c.request_id = hub_add_comment.request_id;
    if found then
      if created.client_user_id is distinct from cu.id then raise exception 'Not found.' using errcode = 'P0002'; end if;
      return leadflow_private.comment_json(created, true);
    end if;
  end if;
  perform leadflow_private.hub_rate_limit('hub-comment-' || cu.id, 20);
  select * into p from leadflow_private.projects x where x.id = target_project;
  select * into t from leadflow_private.comment_thread(p, details);
  if t.deliverable_ref is not null then perform leadflow_private.hub_open_deliverable(t.deliverable_ref); end if;
  -- An internal agency note is never a thread the client can see or answer.
  if t.parent_ref is not null and t.parent_visibility <> 'client' then raise exception 'Not found.' using errcode = 'P0002'; end if;
  if (select count(*) from leadflow_private.project_comments c where c.project_id = p.id) >= 5000 then raise exception 'This project has too many comments to add more.' using errcode = '54000'; end if;
  insert into leadflow_private.project_comments(workspace_id, project_id, deliverable_id, feedback_id, version_id, parent_id, author_type, client_user_id, author_name, visibility, body, request_id)
    values (cu.workspace_id, p.id, t.deliverable_ref, t.feedback_ref, t.version_ref, t.parent_ref, 'client', cu.id, leadflow_private.client_user_label(cu), 'client',
      leadflow_private.onboarding_clean_text(details->>'body', 'Comment', 5000, true, false), request_id)
    returning * into created;
  select * into d from leadflow_private.project_deliverables x where x.id = t.deliverable_ref;
  perform leadflow_private.collab_event(p, 'client_commented', leadflow_private.client_user_label(cu) || ' commented' || case when d.id is not null then ' on ' || d.title else '' end,
    '{}', 'comment', created.id::text, cu);
  perform leadflow_private.notify_members(p, 'client_commented', 'New client message' || case when d.id is not null then ' about ' || d.title else ': ' || p.name end,
    leadflow_private.client_user_label(cu) || ': ' || left(created.body, 160), 'comment:' || created.id, d.id);
  perform leadflow_private.notify_clients(p, 'comment_added', 'New message' || case when d.id is not null then ' about ' || d.title else ': ' || p.name end,
    left(created.body, 200), '/portal/projects/' || p.id || case when d.id is not null then '/deliverables/' || d.id else '/messages' end, 'comment:' || created.id, d.id, cu.id);
  return leadflow_private.comment_json(created, true);
end $$;

-- Client people edit or delete only their own comments; the agency keeps the earlier text.
create function public.hub_edit_comment(target_comment uuid, body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c leadflow_private.project_comments; cu leadflow_private.client_users;
begin
  select * into c from leadflow_private.project_comments x where x.id = target_comment and x.deleted_at is null and x.author_type = 'client';
  if not found then raise exception 'Not found.' using errcode = 'P0002'; end if;
  cu := leadflow_private.hub_open_project(c.project_id);
  if c.client_user_id is distinct from cu.id then raise exception 'Not found.' using errcode = 'P0002'; end if;
  select * into c from leadflow_private.project_comments x where x.id = c.id for update;
  insert into leadflow_private.project_comment_revisions(comment_id, body, action, actor_type, actor_id) values (c.id, c.body, 'edited', 'client', cu.id);
  update leadflow_private.project_comments x set body = leadflow_private.onboarding_clean_text(hub_edit_comment.body, 'Comment', 5000, true, false), edited_at = now()
    where x.id = c.id returning * into c;
  return leadflow_private.comment_json(c, true);
end $$;

create function public.hub_delete_comment(target_comment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c leadflow_private.project_comments; cu leadflow_private.client_users;
begin
  select * into c from leadflow_private.project_comments x where x.id = target_comment and x.deleted_at is null and x.author_type = 'client';
  if not found then raise exception 'Not found.' using errcode = 'P0002'; end if;
  cu := leadflow_private.hub_open_project(c.project_id);
  if c.client_user_id is distinct from cu.id then raise exception 'Not found.' using errcode = 'P0002'; end if;
  select * into c from leadflow_private.project_comments x where x.id = c.id for update;
  insert into leadflow_private.project_comment_revisions(comment_id, body, action, actor_type, actor_id) values (c.id, c.body, 'deleted', 'client', cu.id);
  update leadflow_private.project_comments x set deleted_at = now(), deleted_by_type = 'client' where x.id = c.id returning * into c;
  return leadflow_private.comment_json(c, true);
end $$;

-- Files the caller may open: one project's, or every project's and the client's shared files.
create function public.hub_files(target_access uuid, target_project uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cu leadflow_private.client_users;
begin
  if target_project is not null then cu := leadflow_private.hub_open_project(target_project); else cu := leadflow_private.hub_access_by_id(target_access); end if;
  return coalesce((select jsonb_agg(leadflow_private.hub_document_json(d) || jsonb_build_object('projectName', (select p.name from leadflow_private.projects p where p.id = d.project_id),
      'deliverableTitle', (select x.title from leadflow_private.project_deliverables x where x.id = coalesce(d.deliverable_id,
        (select v.deliverable_id from leadflow_private.deliverable_versions v where v.id = d.version_id),
        (select f.deliverable_id from leadflow_private.deliverable_feedback f where f.id = d.feedback_id))),
      'versionNumber', (select v.number from leadflow_private.deliverable_versions v where v.id = d.version_id)) order by d.created_at desc)
    from leadflow_private.client_documents d where d.client_id = cu.client_id and (target_project is null or d.project_id = target_project)
      and leadflow_private.hub_can_see_document(d, cu)), '[]'::jsonb);
end $$;

-- Called by the client-hub Edge Function with the client's own token. Client admins and members upload project files;
-- any role attaches files to their own feedback or comment. The database chooses the storage path.
create function public.hub_begin_document(target_project uuid, details jsonb, max_bytes bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cu leadflow_private.client_users; p leadflow_private.projects; feedback_ref uuid; comment_ref uuid; created jsonb;
begin
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the file details as an object.' using errcode = '22023'; end if;
  cu := leadflow_private.hub_open_project(target_project);
  select * into p from leadflow_private.projects x where x.id = target_project;
  if nullif(details->>'feedbackId', '') is not null then
    select f.id into feedback_ref from leadflow_private.deliverable_feedback f where f.project_id = p.id and f.id::text = details->>'feedbackId' and f.client_user_id = cu.id;
    if feedback_ref is null then raise exception 'Not found.' using errcode = 'P0002'; end if;
  elsif nullif(details->>'commentId', '') is not null then
    select c.id into comment_ref from leadflow_private.project_comments c where c.project_id = p.id and c.id::text = details->>'commentId' and c.client_user_id = cu.id and c.deleted_at is null;
    if comment_ref is null then raise exception 'Not found.' using errcode = 'P0002'; end if;
  elsif cu.role not in ('admin','member') then
    raise exception 'Your portal role can attach files to feedback and comments only.' using errcode = '42501';
  end if;
  if (select count(*) from leadflow_private.client_documents d where d.uploaded_client_user = cu.id and d.created_at > now() - interval '1 day') >= 200 then
    raise exception 'You''ve uploaded the most files allowed today. Try again tomorrow.' using errcode = '54000';
  end if;
  created := leadflow_private.begin_document(cu.workspace_id, cu.client_id, null, null, (details - 'feedbackId' - 'commentId' - 'visibility' - 'stageId') || '{"visibility":"shared"}'::jsonb,
    'client', null, null, max_bytes);
  update leadflow_private.client_documents d set project_id = p.id, feedback_id = feedback_ref, comment_id = comment_ref, uploaded_client_user = cu.id,
    deliverable_id = (select f.deliverable_id from leadflow_private.deliverable_feedback f where f.id = feedback_ref)
    where d.id = (created->>'id')::uuid;
  return created;
end $$;

-- purpose 'download': a file the caller may see. purpose 'finish' or 'remove': the caller's own upload.
create function public.hub_document_access(target_document uuid, purpose text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.client_documents; cu leadflow_private.client_users;
begin
  select * into d from leadflow_private.client_documents x where x.id = target_document and x.status in ('pending','available');
  if not found or d.client_id is null then raise exception 'Not found.' using errcode = 'P0002'; end if;
  cu := leadflow_private.hub_access(d.client_id);
  if purpose = 'download' then
    if not leadflow_private.hub_can_see_document(d, cu) then raise exception 'Not found.' using errcode = 'P0002'; end if;
  elsif purpose in ('finish','remove') then
    if d.uploaded_client_user is distinct from cu.id or (d.project_id is not null and not exists (select 1 from leadflow_private.projects p where p.id = d.project_id and leadflow_private.hub_can_see_project(p, cu)))
      or (purpose = 'finish' and d.status <> 'pending') then
      raise exception 'Not found.' using errcode = 'P0002';
    end if;
    if purpose = 'remove' and d.feedback_id is not null then raise exception 'Files attached to feedback stay with it.' using errcode = '55000'; end if;
  else raise exception 'Choose download, finish or remove.' using errcode = '22023';
  end if;
  return jsonb_build_object('id', d.id, 'path', d.storage_path, 'fileName', d.file_name, 'extension', d.extension, 'mimeType', d.mime_type, 'size', d.size_bytes, 'status', d.status);
end $$;

-- Removes the caller's own upload (checked by hub_document_access first). Returns the storage path to delete.
create function public.hub_remove_document(target_document uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_access jsonb; d leadflow_private.client_documents; p leadflow_private.projects; cu leadflow_private.client_users;
begin
  found_access := public.hub_document_access(target_document, 'remove');
  update leadflow_private.client_documents x set status = 'deleted', deleted_at = now() where x.id = target_document returning * into d;
  cu := leadflow_private.hub_access(d.client_id);
  select * into p from leadflow_private.projects x where x.id = d.project_id;
  if p.id is not null then
    perform leadflow_private.collab_event(p, 'portal_client_file_removed', leadflow_private.client_user_label(cu) || ' removed a file: ' || d.file_name, '{}', 'document', d.id::text, cu);
  end if;
  return jsonb_build_object('path', found_access->>'path');
end $$;

create function public.hub_notifications(target_access uuid, only_unread boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cu leadflow_private.client_users;
begin
  cu := leadflow_private.hub_access_by_id(target_access);
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'event', n.event, 'title', n.title, 'body', n.body, 'link', n.link, 'projectId', n.project_id,
        'deliverableId', n.deliverable_id, 'createdAt', n.created_at, 'readAt', n.read_at) order by n.created_at desc, n.id desc)
      from (select * from leadflow_private.portal_notifications n where n.client_user_id = cu.id and (not only_unread or n.read_at is null)
        order by n.created_at desc, n.id desc limit 100) n), '[]'::jsonb),
    'unread', (select count(*) from leadflow_private.portal_notifications n where n.client_user_id = cu.id and n.read_at is null));
end $$;

create function public.hub_mark_notifications(target_access uuid, ids jsonb default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare cu leadflow_private.client_users; changed integer;
begin
  cu := leadflow_private.hub_access_by_id(target_access);
  update leadflow_private.portal_notifications n set read_at = now() where n.client_user_id = cu.id and n.read_at is null
    and (ids is null or ids = 'null'::jsonb or n.id::text in (select jsonb_array_elements_text(case when jsonb_typeof(ids) = 'array' then ids else '[]'::jsonb end)));
  get diagnostics changed = row_count;
  return changed;
end $$;

create function leadflow_private.client_events() returns jsonb language sql immutable set search_path = '' as $$
  select '["project_shared","milestone_shared","review_requested","review_resubmitted","feedback_reply","comment_added","update_published","file_shared"]'::jsonb
$$;

-- The caller's own settings. Organization details are managed by the agency and shown read-only.
create function public.hub_settings(target_access uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cu leadflow_private.client_users;
begin
  cu := leadflow_private.hub_access_by_id(target_access);
  return jsonb_build_object('accessId', cu.id, 'name', cu.name, 'email', (select u.email from auth.users u where u.id = cu.user_id), 'role', cu.role,
    'projectAccess', cu.project_access, 'emailEvents', cu.email_events, 'events', leadflow_private.client_events(),
    'client', (select jsonb_build_object('name', c.name, 'website', c.website) from leadflow_private.clients c where c.id = cu.client_id),
    'agencyName', (select w.name from public.workspaces w where w.id = cu.workspace_id));
end $$;

create function public.hub_save_settings(target_access uuid, details jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cu leadflow_private.client_users; events jsonb;
begin
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the settings as an object.' using errcode = '22023'; end if;
  cu := leadflow_private.hub_access_by_id(target_access);
  if details ? 'emailEvents' then
    if jsonb_typeof(details->'emailEvents') <> 'array' then raise exception 'Send the email events as a list.' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into events from jsonb_array_elements_text(details->'emailEvents') x where leadflow_private.client_events() ? x;
  end if;
  update leadflow_private.client_users x set name = case when details ? 'name' then leadflow_private.onboarding_clean_text(details->>'name', 'Name', 150, false, true) else x.name end,
    email_events = coalesce(events, x.email_events), updated_at = now() where x.id = cu.id;
  return public.hub_settings(target_access);
end $$;

-- ---------- Invitations ----------

-- Accepts an invitation for a user. The account's email must be the invited address.
create function leadflow_private.accept_invitation(key_hash text, target_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i leadflow_private.client_invitations; address text; cu leadflow_private.client_users;
begin
  select * into i from leadflow_private.client_invitations x where x.token_hash = key_hash for update;
  if not found then raise exception 'This invitation link isn''t valid.' using errcode = 'P0002'; end if;
  select lower(u.email) into address from auth.users u where u.id = target_user;
  if i.status = 'accepted' then
    if i.accepted_user = target_user then
      select * into cu from leadflow_private.client_users x where x.id = i.client_user_id;
      return jsonb_build_object('accessId', cu.id, 'clientId', cu.client_id, 'alreadyAccepted', true);
    end if;
    raise exception 'This invitation was already used. Ask your agency for a new one.' using errcode = '55000';
  end if;
  if i.status = 'revoked' then raise exception 'This invitation was withdrawn. Ask your agency for a new one.' using errcode = '55000'; end if;
  if i.expires_at <= now() then raise exception 'This invitation has expired. Ask your agency to renew it.' using errcode = '55000'; end if;
  if exists (select 1 from leadflow_private.clients c where c.id = i.client_id and c.status = 'archived') then raise exception 'This invitation isn''t available any more.' using errcode = '55000'; end if;
  if address is null or address <> i.email then raise exception 'Sign in with the address this invitation was sent to (%).', i.email using errcode = '42501'; end if;
  if exists (select 1 from public.workspace_memberships m where m.workspace_id = i.workspace_id and m.user_id = target_user) then
    raise exception 'This account is a member of the agency''s workspace. Use a separate address for the client portal.' using errcode = '55000';
  end if;
  select * into cu from leadflow_private.client_users x where x.client_id = i.client_id and x.user_id = target_user;
  if found then
    update leadflow_private.client_users x set status = 'active', revoked_at = null, revoked_by = null, role = i.role, project_access = i.project_access,
      name = coalesce(nullif(i.name, ''), x.name), invitation_id = i.id, version = x.version + 1, updated_at = now() where x.id = cu.id returning * into cu;
  else
    insert into leadflow_private.client_users(workspace_id, client_id, user_id, email, name, role, project_access, invitation_id)
      values (i.workspace_id, i.client_id, target_user, i.email, i.name, i.role, i.project_access, i.id) returning * into cu;
  end if;
  delete from leadflow_private.client_user_projects a where a.client_user_id = cu.id;
  if i.project_access = 'selected' then
    insert into leadflow_private.client_user_projects(client_user_id, project_id)
      select cu.id, p2.id from jsonb_array_elements_text(i.project_ids) x join leadflow_private.projects p2 on p2.id::text = x and p2.client_id = i.client_id;
  end if;
  update leadflow_private.client_invitations x set status = 'accepted', accepted_at = now(), accepted_user = target_user, client_user_id = cu.id where x.id = i.id;
  update leadflow_private.portal_email_outbox o set status = 'cancelled', payload = '{}', email = null, updated_at = now()
    where o.invitation_id = i.id and o.status in ('pending','sending','uncertain');
  insert into leadflow_private.client_activities(workspace_id, client_id, kind, summary, detail, actor_type, client_user_id, entity_type, entity_id)
    values (i.workspace_id, i.client_id, 'portal_activated', leadflow_private.client_user_label(cu) || ' activated their portal access', jsonb_build_object('role', cu.role), 'client', cu.id,
      'client_user', cu.id::text);
  -- Owners and admins hear about it once per invitation.
  perform leadflow_private.notify_workspace_admins(i.workspace_id, 'client_activated', leadflow_private.client_user_label(cu) || ' joined the client portal',
    (select c.name from leadflow_private.clients c where c.id = i.client_id), 'activated:' || cu.id || ':' || i.id);
  return jsonb_build_object('accessId', cu.id, 'clientId', cu.client_id, 'alreadyAccepted', false);
end $$;

-- A signed-in person (an existing account) accepts an invitation with its token's hash.
create function public.hub_accept_invitation(key_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := leadflow_private.valid_actor();
begin
  if actor is null then raise exception 'Sign in to accept the invitation.' using errcode = '42501'; end if;
  if key_hash is null or key_hash !~ '^[0-9a-f]{64}$' then raise exception 'This invitation link isn''t valid.' using errcode = '22023'; end if;
  perform leadflow_private.hub_rate_limit('hub-accept-' || actor, 10);
  return leadflow_private.accept_invitation(key_hash, actor);
end $$;

-- ---------- Service role: invitations (client-hub Edge Function) ----------

-- What the invitation page shows before sign-in. Unknown tokens and other workspaces' details are never revealed.
create function public.hub_invitation_status(key_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i leadflow_private.client_invitations;
begin
  if key_hash is null or key_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('status', 'invalid'); end if;
  select * into i from leadflow_private.client_invitations x where x.token_hash = key_hash;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if i.status <> 'pending' then return jsonb_build_object('status', i.status); end if;
  if i.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  if exists (select 1 from leadflow_private.clients c where c.id = i.client_id and c.status = 'archived') then return jsonb_build_object('status', 'revoked'); end if;
  return jsonb_build_object('status', 'valid', 'email', i.email, 'name', i.name, 'role', i.role, 'expiresAt', i.expires_at,
    'clientName', (select c.name from leadflow_private.clients c where c.id = i.client_id),
    'agencyName', (select w.name from public.workspaces w where w.id = i.workspace_id),
    'accountExists', exists (select 1 from auth.users u where lower(u.email) = i.email));
end $$;

-- After client-hub created the account for the invited address, links it to the client.
create function public.hub_activate_invitation(key_hash text, target_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if key_hash is null or key_hash !~ '^[0-9a-f]{64}$' or target_user is null then raise exception 'This invitation link isn''t valid.' using errcode = '22023'; end if;
  return leadflow_private.accept_invitation(key_hash, target_user);
end $$;

-- Owners and admins of the workspace, for client-level events.
create function leadflow_private.notify_workspace_admins(target_workspace uuid, event_name text, heading text, detail text, dedupe text) returns void
language plpgsql security definer set search_path = '' as $$
declare member uuid; wanted jsonb; address text;
begin
  for member in select m.user_id from public.workspace_memberships m where m.workspace_id = target_workspace and m.role in ('owner','admin') loop
    select coalesce((select q.email_events from leadflow_private.portal_member_preferences q where q.workspace_id = target_workspace and q.user_id = member), leadflow_private.member_email_defaults())
      into wanted;
    select u.email into address from auth.users u where u.id = member;
    perform leadflow_private.queue_notification(target_workspace, 'member', member, null, event_name, null, null, heading, detail, '', dedupe, case when wanted ? event_name then address end);
  end loop;
end $$;

-- ---------- Service role: email outbox (portal-notifications worker) ----------

create function leadflow_private.html_escape(raw text) returns text language sql immutable set search_path = '' as $$
  select replace(replace(replace(replace(replace(coalesce(raw, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;

create function leadflow_private.compose_portal_email(o leadflow_private.portal_email_outbox, app_url text, sender text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n leadflow_private.portal_notifications; i leadflow_private.client_invitations; agency text; client_name text; subject text; lines text[]; link text; footer text;
begin
  if o.kind = 'invitation' then
    select * into i from leadflow_private.client_invitations x where x.id = o.invitation_id;
    select w.name into agency from public.workspaces w where w.id = i.workspace_id;
    select c.name into client_name from leadflow_private.clients c where c.id = i.client_id;
    link := app_url || '/portal/invite#' || (o.payload->>'token');
    subject := agency || ' invited you to the ' || client_name || ' client portal';
    lines := array[subject || '.', 'Open this link to set your password and see your projects, reviews and files:', link,
      'The link works once and expires on ' || to_char(i.expires_at at time zone 'UTC', 'DD Mon YYYY') || ' (UTC).',
      'If you weren''t expecting this, you can ignore this email.'];
    footer := '';
  else
    select * into n from leadflow_private.portal_notifications x where x.id = o.notification_id;
    select w.name into agency from public.workspaces w where w.id = n.workspace_id;
    link := app_url || case when n.recipient_type = 'client' then coalesce(nullif(n.link, ''), '/portal') else '/app' end;
    subject := n.title;
    lines := array_remove(array[n.title, nullif(n.body, ''), case when n.recipient_type = 'client' then 'Open your client portal: ' else 'Open LeadFlow: ' end || link], null);
    footer := case when n.recipient_type = 'client' then 'Choose which emails you get in your portal settings: ' || app_url || '/portal/settings'
      else 'Choose which client-activity emails you get in LeadFlow under Settings.' end;
  end if;
  return jsonb_build_object('from', sender, 'to', jsonb_build_array(o.recipient), 'subject', left(subject, 200),
    'text', array_to_string(lines, E'\n\n') || case when footer <> '' then E'\n\n—\n' || footer else '' end || E'\n\nSent by LeadFlow for ' || coalesce(agency, 'your agency') || '.',
    'html', '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#10241c">'
      || (select string_agg('<p>' || case when l = link then '<a href="' || leadflow_private.html_escape(link) || '">' || leadflow_private.html_escape(link) || '</a>' else leadflow_private.html_escape(l) end || '</p>', '')
        from unnest(lines) l)
      || case when footer <> '' then '<p style="color:#5b6b64;font-size:13px">' || leadflow_private.html_escape(footer) || '</p>' else '' end
      || '<p style="color:#5b6b64;font-size:13px">Sent by LeadFlow for ' || leadflow_private.html_escape(coalesce(agency, 'your agency')) || '.</p></div>');
end $$;

-- Claims one due email. The email is composed once (first claim) and resent identically on retries. Emails to people
-- who lost access, or for invitations no longer pending, are cancelled instead.
create function public.claim_portal_email(app_url text, sender text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o leadflow_private.portal_email_outbox; lease uuid := gen_random_uuid(); n leadflow_private.portal_notifications; still_valid boolean;
begin
  if app_url is null or app_url !~ '^https?://[^\s#?]+$' or sender is null or sender !~ '@' or sender ~ '[\r\n]' then raise exception 'Email delivery is not configured.' using errcode = '22023'; end if;
  -- Leases older than 10 minutes are treated as unknown outcomes and retried with the same key.
  update leadflow_private.portal_email_outbox x set status = 'uncertain', lease_id = null, updated_at = now() where x.status = 'sending' and x.updated_at < now() - interval '10 minutes';
  select * into o from leadflow_private.portal_email_outbox x where x.status in ('pending','uncertain') and x.next_attempt_at <= now()
    order by x.next_attempt_at, x.created_at for update skip locked limit 1;
  if not found then return null; end if;
  if o.kind = 'invitation' then
    still_valid := exists (select 1 from leadflow_private.client_invitations i where i.id = o.invitation_id and i.status = 'pending' and i.expires_at > now()) and o.payload ? 'token';
  else
    select * into n from leadflow_private.portal_notifications x where x.id = o.notification_id;
    still_valid := case when n.recipient_type = 'client' then exists (select 1 from leadflow_private.client_users cu where cu.id = n.client_user_id and cu.status = 'active')
      else exists (select 1 from public.workspace_memberships m where m.workspace_id = n.workspace_id and m.user_id = n.user_id) end;
  end if;
  if not still_valid then
    update leadflow_private.portal_email_outbox x set status = 'cancelled', payload = '{}', email = null, updated_at = now() where x.id = o.id;
    return jsonb_build_object('id', o.id, 'skipped', true);
  end if;
  update leadflow_private.portal_email_outbox x set status = 'sending', lease_id = lease, attempts = x.attempts + 1, first_attempt_at = coalesce(x.first_attempt_at, now()),
    email = coalesce(x.email, leadflow_private.compose_portal_email(x, rtrim(app_url, '/'), sender)), updated_at = now()
    where x.id = o.id returning * into o;
  return jsonb_build_object('id', o.id, 'lease_id', lease, 'email', o.email);
end $$;

-- Records the provider's answer. Accepted and failed are final (the payload and email are cleared); otherwise it is
-- retried later with the same idempotency key, up to 8 attempts, then left uncertain.
create function public.finish_portal_email(job_id uuid, lease uuid, outcome text, provider_reference text, failure_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare o leadflow_private.portal_email_outbox;
begin
  select * into o from leadflow_private.portal_email_outbox x where x.id = job_id and x.lease_id = lease for update;
  if not found then return; end if;
  if outcome = 'accepted' then
    update leadflow_private.portal_email_outbox x set status = 'accepted', provider_id = left(provider_reference, 100), lease_id = null, payload = '{}', email = null, last_error = null, updated_at = now()
      where x.id = o.id;
  elsif outcome = 'failed' then
    update leadflow_private.portal_email_outbox x set status = 'failed', lease_id = null, payload = '{}', email = null, last_error = left(failure_code, 200), updated_at = now() where x.id = o.id;
  else
    update leadflow_private.portal_email_outbox x set status = case when x.attempts >= 8 then 'failed' else 'uncertain' end, lease_id = null, last_error = left(failure_code, 200),
      next_attempt_at = now() + make_interval(mins => least(240, 5 * power(2, greatest(x.attempts - 1, 0))::integer)),
      payload = case when x.attempts >= 8 then '{}'::jsonb else x.payload end, email = case when x.attempts >= 8 then null else x.email end, updated_at = now()
      where x.id = o.id;
  end if;
end $$;

-- ---------- Files (M10/M11 functions extended) ----------

create or replace function leadflow_private.document_json(d leadflow_private.client_documents) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'clientId', d.client_id, 'requestId', d.request_id, 'itemId', d.item_id, 'fileName', d.file_name, 'extension', d.extension, 'mimeType', d.mime_type,
    'size', d.size_bytes, 'category', d.category, 'description', d.description, 'visibility', d.visibility, 'status', d.status, 'rejectedReason', d.rejected_reason, 'uploaderType', d.uploader_type,
    'uploadedBy', case when d.uploader_type = 'client' then coalesce((select coalesce(nullif(cu.name, ''), cu.email) from leadflow_private.client_users cu where cu.id = d.uploaded_client_user), 'Client')
      else (select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = d.uploaded_by) end,
    'stageId', d.stage_id, 'createdAt', d.created_at, 'verifiedAt', d.verified_at,
    'itemTitle', (select i.title from leadflow_private.onboarding_items i where i.request_id = d.request_id and i.id = d.item_id),
    'projectId', d.project_id, 'projectName', (select p.name from leadflow_private.projects p where p.id = d.project_id), 'milestoneId', d.milestone_id, 'deliverableId', d.deliverable_id, 'taskId', d.task_id,
    'versionId', d.version_id, 'commentId', d.comment_id, 'feedbackId', d.feedback_id, 'updateId', d.update_id, 'fromPortal', d.uploaded_client_user is not null)
$$;

-- As M11 defined it, plus M12 attachments: a draft version's files, a member's own comment, or an update. Project files may
-- be shared (the portal still checks project access); attachments follow what they belong to.
create or replace function public.begin_client_document(target_workspace uuid, target_client uuid, details jsonb, max_bytes bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; request_ref uuid; project_ref uuid; milestone_ref uuid; deliverable_ref uuid; task_ref text; version_ref uuid; comment_ref uuid; update_ref uuid;
  created jsonb; attachment boolean;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into found_client from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace;
  if not found then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  if found_client.status = 'archived' then raise exception 'Unarchive this client before adding files.' using errcode = '55000'; end if;
  if nullif(details->>'requestId', '') is not null then
    select r.id into request_ref from leadflow_private.onboarding_requests r where r.client_id = target_client and r.id::text = details->>'requestId';
    if request_ref is null then raise exception 'That onboarding request isn''t this client''s.' using errcode = '22023'; end if;
  end if;
  if nullif(details->>'projectId', '') is not null then
    select p.id into project_ref from leadflow_private.projects p where p.client_id = target_client and p.id::text = details->>'projectId';
    if project_ref is null then raise exception 'That project isn''t this client''s.' using errcode = '22023'; end if;
    if nullif(details->>'milestoneId', '') is not null then
      select m.id into milestone_ref from leadflow_private.project_milestones m where m.project_id = project_ref and m.id::text = details->>'milestoneId';
      if milestone_ref is null then raise exception 'Choose a milestone of this project.' using errcode = '22023'; end if;
    end if;
    if nullif(details->>'deliverableId', '') is not null then
      select d.id into deliverable_ref from leadflow_private.project_deliverables d where d.project_id = project_ref and d.id::text = details->>'deliverableId';
      if deliverable_ref is null then raise exception 'Choose a deliverable of this project.' using errcode = '22023'; end if;
    end if;
    if nullif(details->>'taskId', '') is not null then
      select t.id into task_ref from public.follow_up_tasks t where t.workspace_id = target_workspace and t."projectId" = project_ref and t.id = details->>'taskId';
      if task_ref is null then raise exception 'Choose a task of this project.' using errcode = '22023'; end if;
    end if;
    if nullif(details->>'versionId', '') is not null then
      select v.id, v.deliverable_id into version_ref, deliverable_ref from leadflow_private.deliverable_versions v where v.project_id = project_ref and v.id::text = details->>'versionId';
      if version_ref is null then raise exception 'Choose a version of this project''s deliverables.' using errcode = '22023'; end if;
      if exists (select 1 from leadflow_private.deliverable_versions v where v.id = version_ref and v.published_at is not null) then
        raise exception 'This version was already shared and can''t change. Start a new version instead.' using errcode = '55000';
      end if;
    elsif nullif(details->>'commentId', '') is not null then
      select c.id into comment_ref from leadflow_private.project_comments c where c.project_id = project_ref and c.id::text = details->>'commentId' and c.author_type = 'member'
        and c.member_id = leadflow_private.valid_actor() and c.deleted_at is null;
      if comment_ref is null then raise exception 'Attach files to one of your own comments.' using errcode = '22023'; end if;
    elsif nullif(details->>'updateId', '') is not null then
      select u.id into update_ref from leadflow_private.project_updates u where u.project_id = project_ref and u.id::text = details->>'updateId' and u.status = 'draft';
      if update_ref is null then raise exception 'Attach files to a draft update.' using errcode = '22023'; end if;
    end if;
  elsif coalesce(details->>'milestoneId', details->>'deliverableId', details->>'taskId', details->>'versionId', details->>'commentId', details->>'updateId', '') <> '' then
    raise exception 'Choose the project the file belongs to.' using errcode = '22023';
  end if;
  attachment := version_ref is not null or comment_ref is not null or update_ref is not null;
  created := leadflow_private.begin_document(target_workspace, target_client, request_ref, null,
    (details - 'requestId' - 'projectId' - 'milestoneId' - 'deliverableId' - 'taskId' - 'versionId' - 'commentId' - 'updateId')
      || case when attachment then jsonb_build_object('visibility', case when comment_ref is not null and exists (select 1 from leadflow_private.project_comments c where c.id = comment_ref and c.visibility = 'client') then 'shared' else 'internal' end)
        else '{}'::jsonb end,
    'member', leadflow_private.valid_actor(), null, max_bytes);
  if project_ref is not null then
    update leadflow_private.client_documents d set project_id = project_ref, milestone_id = milestone_ref, deliverable_id = deliverable_ref, task_id = task_ref,
      version_id = version_ref, comment_id = comment_ref, update_id = update_ref where d.id = (created->>'id')::uuid;
  end if;
  return created;
end $$;

-- As M11 defined it, except project files can now be shared with the client; attachments follow what they belong to.
create or replace function public.update_client_document(target_workspace uuid, target_document uuid, changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.client_documents; p leadflow_private.projects; was_shared boolean;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if changes is null or jsonb_typeof(changes) <> 'object' then raise exception 'Send the changes as an object.' using errcode = '22023'; end if;
  if changes ? 'category' and changes->>'category' not in ('brand','logo','image','video','content','requirements','design_reference','technical','access_instructions','other') then raise exception 'Choose a document category.' using errcode = '22023'; end if;
  if changes ? 'visibility' and changes->>'visibility' not in ('internal','shared') then raise exception 'Choose who can see the file.' using errcode = '22023'; end if;
  select * into d from leadflow_private.client_documents x where x.id = target_document and x.workspace_id = target_workspace and x.status = 'available' for update;
  if not found then raise exception 'File not found.' using errcode = 'P0002'; end if;
  if changes ? 'visibility' and changes->>'visibility' <> d.visibility and num_nonnulls(d.version_id, d.comment_id, d.feedback_id, d.update_id) > 0 then
    raise exception 'This file is attached to a version, comment, feedback or update, and is shared with it.' using errcode = '55000';
  end if;
  was_shared := d.visibility = 'shared';
  update leadflow_private.client_documents x set category = coalesce(changes->>'category', x.category), visibility = coalesce(changes->>'visibility', x.visibility),
    description = case when changes ? 'description' then leadflow_private.onboarding_clean_text(changes->>'description', 'Description', 1000, false, false) else x.description end
    where x.id = d.id returning * into d;
  if d.client_id is not null and changes ? 'visibility' then
    perform leadflow_private.client_event(d.client_id, 'document_updated', case d.visibility when 'shared' then 'File shared with the client: ' else 'File made internal: ' end || d.file_name,
      jsonb_build_object('visibility', d.visibility), 'member', 'document', d.id::text);
  end if;
  if d.project_id is not null and d.visibility = 'shared' and not was_shared then
    select * into p from leadflow_private.projects x where x.id = d.project_id;
    perform leadflow_private.notify_clients(p, 'file_shared', 'New file: ' || d.file_name, p.name, '/portal/projects/' || p.id || '/files', 'file:' || d.id);
  end if;
  return leadflow_private.document_json(d);
end $$;

-- As M10 defined it; files of a shared version or of feedback are part of the review record and stay.
create or replace function public.delete_client_document(target_workspace uuid, target_document uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor_role text; d leadflow_private.client_documents;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  select * into d from leadflow_private.client_documents x where x.id = target_document and x.workspace_id = target_workspace and x.status <> 'deleted' for update;
  if not found then raise exception 'File not found.' using errcode = 'P0002'; end if;
  if actor_role = 'member' and (d.uploader_type <> 'member' or d.uploaded_by is distinct from leadflow_private.valid_actor()) then
    raise exception 'Only owners, admins or the person who uploaded a file can delete it.' using errcode = '42501';
  end if;
  if d.item_id is not null and exists (select 1 from leadflow_private.onboarding_items i where i.request_id = d.request_id and i.id = d.item_id and i.response->'files' ? d.id::text and i.state = 'accepted') then
    raise exception 'This file is part of an accepted answer. Request changes on the answer first.' using errcode = '55000';
  end if;
  if d.feedback_id is not null or exists (select 1 from leadflow_private.deliverable_versions v where v.id = d.version_id and v.published_at is not null) then
    raise exception 'This file is part of a shared version or of client feedback and stays in the review history.' using errcode = '55000';
  end if;
  update leadflow_private.client_documents x set status = 'deleted', deleted_at = now(), deleted_by = leadflow_private.valid_actor() where x.id = d.id;
  if d.client_id is not null then
    perform leadflow_private.client_event(d.client_id, 'document_removed', 'File removed: ' || d.file_name, jsonb_build_object('category', d.category), 'member', 'document', d.id::text);
  end if;
  return jsonb_build_object('path', d.storage_path);
end $$;

-- As M10 defined it; a portal upload tells the project's team.
create or replace function public.finish_client_document(target_document uuid, ok boolean, actual_size bigint, reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.client_documents; p leadflow_private.projects; cu leadflow_private.client_users;
begin
  select * into d from leadflow_private.client_documents x where x.id = target_document for update;
  if not found then raise exception 'File not found.' using errcode = 'P0002'; end if;
  if d.status <> 'pending' then return leadflow_private.document_json(d); end if;
  if ok then
    update leadflow_private.client_documents x set status = 'available', verified_at = now(), size_bytes = coalesce(actual_size, x.size_bytes) where x.id = d.id returning * into d;
    if d.client_id is not null then
      perform leadflow_private.client_event(d.client_id, 'document_uploaded', 'File uploaded' || case when d.uploader_type = 'client' then ' by the client' else '' end || ': ' || d.file_name,
        jsonb_build_object('category', d.category, 'size', d.size_bytes, 'visibility', d.visibility, 'itemId', d.item_id), case when d.uploader_type = 'client' then 'client' else 'system' end,
        'document', d.id::text);
    end if;
    if d.uploaded_client_user is not null and d.project_id is not null then
      select * into p from leadflow_private.projects x where x.id = d.project_id;
      select * into cu from leadflow_private.client_users x where x.id = d.uploaded_client_user;
      perform leadflow_private.collab_event(p, 'client_file_uploaded', leadflow_private.client_user_label(cu) || ' uploaded ' || d.file_name,
        jsonb_build_object('size', d.size_bytes), 'document', d.id::text, cu);
      perform leadflow_private.notify_members(p, 'client_file_uploaded', 'Client uploaded ' || d.file_name, leadflow_private.client_user_label(cu) || ' · ' || p.name, 'file:' || d.id, d.deliverable_id);
    end if;
  else
    update leadflow_private.client_documents x set status = 'rejected', rejected_reason = left(coalesce(reason, 'The file failed the upload checks.'), 200) where x.id = d.id returning * into d;
  end if;
  return leadflow_private.document_json(d);
end $$;

-- As M11 defined it; the collaboration assistance operations count against the same monthly limit.
create or replace function public.project_ai_reserve(target_workspace uuid, actor uuid, operation text, monthly_limit integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare used integer;
begin
  if operation not in ('project_plan','project_breakdown','project_summary','project_risks','project_feedback_summary','project_response_draft','project_review_prep','project_discussion_summary') then
    raise exception 'Unknown AI operation.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.workspace_memberships m where m.workspace_id = target_workspace and m.user_id = actor) then raise exception 'You don''t have access to this workspace.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('project_ai:' || target_workspace::text));
  select count(*) into used from leadflow_private.outreach_usage u where u.workspace_id = target_workspace and u.operation like 'project\_%' and u.unit = 'requests'
    and u.at >= date_trunc('month', now());
  if used >= greatest(coalesce(monthly_limit, 0), 0) then
    raise exception 'This workspace has used its % AI project requests for this month.', monthly_limit using errcode = 'P0429';
  end if;
  insert into leadflow_private.outreach_usage(workspace_id, provider, operation, quantity, unit, status, actor) values (target_workspace, 'gemini', operation, 1, 'requests', 'ok', actor);
  return greatest(coalesce(monthly_limit, 0), 0) - used - 1;
end $$;

-- ---------- M10 onboarding links never show project files ----------

-- As M10 defined it; shared files exclude project files, which belong to the account-based portal.
create or replace function leadflow_private.portal_view(target_request uuid, link leadflow_private.onboarding_links) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('agencyName', w.name, 'title', r.title, 'clientName', r.client_name, 'status', r.status,
    'linkExpiresAt', link.expires_at,
    'instructions', case when r.status in ('active','paused','completed') then r.client_instructions else '' end,
    'dueDate', case when r.status in ('active','paused') then r.due_date end,
    'allAccepted', (leadflow_private.onboarding_readiness(r.id)->>'clientItemsMet')::boolean and r.status in ('active','completed'),
    'confirmedAt', r.completed_at,
    'items', case when r.status in ('active','paused','completed') then coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'section', i.section, 'title', i.title,
        'guidance', i.guidance, 'kind', i.kind, 'options', i.options, 'required', i.required, 'dueDate', coalesce(i.due_date, r.due_date), 'state', i.state,
        'value', coalesce(i.draft, i.response), 'hasDraft', i.draft is not null, 'submittedAt', i.submitted_at, 'revision', i.revision,
        'config', i.config - 'category', 'stage', (select s.name from leadflow_private.onboarding_stages s where s.id = i.stage_id),
        'files', case when i.kind = 'file' then coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.file_name, 'size', d.size_bytes, 'status', d.status) order by d.created_at)
          from leadflow_private.client_documents d where d.request_id = r.id and d.item_id = i.id and d.status in ('available','pending') and d.uploader_type = 'client'), '[]'::jsonb) end,
        'feedback', case when i.state in ('changes_requested','accepted') then nullif(i.client_feedback, '') end) order by i.position)
      from leadflow_private.onboarding_items i where i.request_id = r.id), '[]') else '[]'::jsonb end,
    'sharedFiles', case when r.status in ('active','paused','completed') and r.client_id is not null then coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.file_name,
        'size', d.size_bytes, 'category', d.category, 'description', d.description) order by d.created_at desc)
      from leadflow_private.client_documents d where d.client_id = r.client_id and d.visibility = 'shared' and d.status = 'available' and d.uploader_type = 'member'
        and d.project_id is null), '[]'::jsonb) else '[]'::jsonb end,
    'scope', (select jsonb_build_object('id', s.id, 'version', s.sequence, 'confirmedAt', s.confirmed_at, 'acknowledgedAt', s.client_acknowledged_at,
        'services', coalesce((select jsonb_agg(jsonb_build_object('name', x->>'name', 'agreedScope', x->>'agreedScope', 'deliverables', x->>'deliverables', 'exclusions', x->>'exclusions'))
          from jsonb_array_elements(s.snapshot->'services') x), '[]'::jsonb),
        'requirements', coalesce((select jsonb_agg(jsonb_build_object('title', x->>'title', 'description', x->>'description', 'category', x->>'category'))
          from jsonb_array_elements(s.snapshot->'requirements') x), '[]'::jsonb),
        'outstandingQuestions', s.outstanding_questions)
      from leadflow_private.client_scope_confirmations s where r.client_id is not null and s.client_id = r.client_id and s.superseded_at is null and s.shared_with_client
        and r.status in ('active','paused','completed')))
  from leadflow_private.onboarding_requests r join public.workspaces w on w.id = r.workspace_id where r.id = target_request
$$;

-- As M10 defined it; project files can't be downloaded through an onboarding link.
create or replace function public.portal_document_access(key_hash text, target_document uuid, purpose text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare link leadflow_private.onboarding_links; request leadflow_private.onboarding_requests; d leadflow_private.client_documents;
begin
  link := leadflow_private.portal_link(key_hash);
  select * into request from leadflow_private.onboarding_requests r where r.id = link.request_id;
  select * into d from leadflow_private.client_documents x where x.id = target_document
    and ((x.request_id = request.id and x.uploader_type = 'client' and x.status in ('pending','available'))
      or (purpose = 'download' and request.client_id is not null and x.client_id = request.client_id and x.visibility = 'shared' and x.uploader_type = 'member' and x.status = 'available' and x.project_id is null));
  if not found or (purpose = 'finish' and d.status <> 'pending') or (purpose = 'download' and d.status <> 'available') then raise exception 'File not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', d.id, 'path', d.storage_path, 'fileName', d.file_name, 'mimeType', d.mime_type, 'size', d.size_bytes, 'status', d.status);
end $$;

-- ---------- Grants ----------
-- Supabase grants new public functions to anon and authenticated by default; restate every grant. Redefined functions
-- (current_profile, document_json, begin/update/delete/finish_client_document, portal_view, portal_document_access) keep theirs.
revoke all on function leadflow_private.refuse_change(),
  leadflow_private.is_client_account(),
  leadflow_private.clean_email(text),
  leadflow_private.client_user_label(leadflow_private.client_users),
  leadflow_private.member_public_name(uuid),
  leadflow_private.member_label(uuid),
  leadflow_private.client_project_status(text),
  leadflow_private.client_milestone_status(text),
  leadflow_private.hub_access(uuid),
  leadflow_private.hub_access_by_id(uuid),
  leadflow_private.hub_can_see_project(leadflow_private.projects, leadflow_private.client_users),
  leadflow_private.hub_open_project(uuid),
  leadflow_private.hub_open_deliverable(uuid),
  leadflow_private.hub_can_see_document(leadflow_private.client_documents, leadflow_private.client_users),
  leadflow_private.collab_event(leadflow_private.projects, text, text, jsonb, text, text, leadflow_private.client_users),
  leadflow_private.member_email_defaults(),
  leadflow_private.queue_notification(uuid, text, uuid, uuid, text, uuid, uuid, text, text, text, text, text),
  leadflow_private.notify_clients(leadflow_private.projects, text, text, text, text, text, uuid, uuid, uuid[]),
  leadflow_private.notify_members(leadflow_private.projects, text, text, text, text, uuid, uuid[]),
  leadflow_private.refresh_review_status(uuid),
  leadflow_private.client_user_json(leadflow_private.client_users),
  leadflow_private.invitation_json(leadflow_private.client_invitations),
  leadflow_private.hub_document_json(leadflow_private.client_documents),
  leadflow_private.version_files(leadflow_private.deliverable_versions, boolean),
  leadflow_private.version_json(leadflow_private.deliverable_versions, boolean),
  leadflow_private.decision_json(leadflow_private.deliverable_decisions),
  leadflow_private.review_json(leadflow_private.deliverable_reviews, boolean),
  leadflow_private.feedback_json(leadflow_private.deliverable_feedback, boolean),
  leadflow_private.comment_json(leadflow_private.project_comments, boolean),
  leadflow_private.update_json(leadflow_private.project_updates, boolean),
  leadflow_private.hub_deliverable_card(leadflow_private.project_deliverables),
  leadflow_private.hub_project_json(leadflow_private.projects, date, boolean),
  leadflow_private.clean_project_ids(uuid, jsonb),
  leadflow_private.queue_invitation_email(leadflow_private.client_invitations, text),
  leadflow_private.lock_deliverable(uuid, uuid),
  leadflow_private.publish_version(leadflow_private.deliverable_versions),
  leadflow_private.comment_thread(leadflow_private.projects, jsonb),
  leadflow_private.member_events(),
  leadflow_private.hub_rate_limit(text, integer),
  leadflow_private.hub_clean_feedback(jsonb),
  leadflow_private.client_events(),
  leadflow_private.accept_invitation(text, uuid),
  leadflow_private.notify_workspace_admins(uuid, text, text, text, text),
  leadflow_private.html_escape(text),
  leadflow_private.compose_portal_email(leadflow_private.portal_email_outbox, text, text)
  from public, anon, authenticated;
revoke all on function public.client_portal_access_for(uuid, uuid),
  public.invite_client_user(uuid, uuid, jsonb, uuid),
  public.renew_client_invitation(uuid, uuid, boolean),
  public.revoke_client_invitation(uuid, uuid),
  public.update_client_user(uuid, uuid, jsonb, integer),
  public.set_client_user_active(uuid, uuid, boolean),
  public.set_project_portal(uuid, uuid, jsonb, integer),
  public.set_client_visibility(uuid, text, uuid, boolean),
  public.create_deliverable_version(uuid, uuid, text),
  public.update_deliverable_version(uuid, uuid, text),
  public.discard_deliverable_version(uuid, uuid),
  public.request_deliverable_review(uuid, uuid, jsonb, uuid),
  public.publish_deliverable_version(uuid, uuid),
  public.withdraw_deliverable_review(uuid, uuid, text),
  public.set_feedback_status(uuid, uuid, jsonb),
  public.deliverable_collab_for(uuid, uuid),
  public.project_collab_for(uuid, uuid),
  public.project_portal_preview(uuid, uuid),
  public.collab_queue_for(uuid),
  public.project_comments_for(uuid, uuid, jsonb),
  public.add_project_comment(uuid, uuid, jsonb, uuid),
  public.edit_project_comment(uuid, uuid, text),
  public.delete_project_comment(uuid, uuid),
  public.project_comment_history(uuid, uuid),
  public.mark_project_discussion_read(uuid, uuid),
  public.save_project_update(uuid, uuid, uuid, jsonb, integer, uuid),
  public.publish_project_update(uuid, uuid),
  public.delete_project_update(uuid, uuid),
  public.member_notifications_for(uuid, boolean),
  public.mark_member_notifications(uuid, jsonb),
  public.member_notification_settings(uuid),
  public.save_member_notification_settings(uuid, jsonb),
  public.project_collab_ai_context(uuid, uuid, uuid),
  public.hub_accounts(),
  public.hub_home(uuid),
  public.hub_project(uuid),
  public.hub_deliverable(uuid),
  public.hub_decide(uuid, jsonb, uuid),
  public.hub_add_feedback(uuid, jsonb, uuid),
  public.hub_comments(uuid, jsonb),
  public.hub_add_comment(uuid, jsonb, uuid),
  public.hub_edit_comment(uuid, text),
  public.hub_delete_comment(uuid),
  public.hub_files(uuid, uuid),
  public.hub_begin_document(uuid, jsonb, bigint),
  public.hub_document_access(uuid, text),
  public.hub_remove_document(uuid),
  public.hub_notifications(uuid, boolean),
  public.hub_mark_notifications(uuid, jsonb),
  public.hub_settings(uuid),
  public.hub_save_settings(uuid, jsonb),
  public.hub_accept_invitation(text),
  public.hub_invitation_status(text),
  public.hub_activate_invitation(text, uuid),
  public.claim_portal_email(text, text),
  public.finish_portal_email(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.client_portal_access_for(uuid, uuid),
  public.invite_client_user(uuid, uuid, jsonb, uuid),
  public.renew_client_invitation(uuid, uuid, boolean),
  public.revoke_client_invitation(uuid, uuid),
  public.update_client_user(uuid, uuid, jsonb, integer),
  public.set_client_user_active(uuid, uuid, boolean),
  public.set_project_portal(uuid, uuid, jsonb, integer),
  public.set_client_visibility(uuid, text, uuid, boolean),
  public.create_deliverable_version(uuid, uuid, text),
  public.update_deliverable_version(uuid, uuid, text),
  public.discard_deliverable_version(uuid, uuid),
  public.request_deliverable_review(uuid, uuid, jsonb, uuid),
  public.publish_deliverable_version(uuid, uuid),
  public.withdraw_deliverable_review(uuid, uuid, text),
  public.set_feedback_status(uuid, uuid, jsonb),
  public.deliverable_collab_for(uuid, uuid),
  public.project_collab_for(uuid, uuid),
  public.project_portal_preview(uuid, uuid),
  public.collab_queue_for(uuid),
  public.project_comments_for(uuid, uuid, jsonb),
  public.add_project_comment(uuid, uuid, jsonb, uuid),
  public.edit_project_comment(uuid, uuid, text),
  public.delete_project_comment(uuid, uuid),
  public.project_comment_history(uuid, uuid),
  public.mark_project_discussion_read(uuid, uuid),
  public.save_project_update(uuid, uuid, uuid, jsonb, integer, uuid),
  public.publish_project_update(uuid, uuid),
  public.delete_project_update(uuid, uuid),
  public.member_notifications_for(uuid, boolean),
  public.mark_member_notifications(uuid, jsonb),
  public.member_notification_settings(uuid),
  public.save_member_notification_settings(uuid, jsonb),
  public.project_collab_ai_context(uuid, uuid, uuid),
  public.hub_accounts(),
  public.hub_home(uuid),
  public.hub_project(uuid),
  public.hub_deliverable(uuid),
  public.hub_decide(uuid, jsonb, uuid),
  public.hub_add_feedback(uuid, jsonb, uuid),
  public.hub_comments(uuid, jsonb),
  public.hub_add_comment(uuid, jsonb, uuid),
  public.hub_edit_comment(uuid, text),
  public.hub_delete_comment(uuid),
  public.hub_files(uuid, uuid),
  public.hub_begin_document(uuid, jsonb, bigint),
  public.hub_document_access(uuid, text),
  public.hub_remove_document(uuid),
  public.hub_notifications(uuid, boolean),
  public.hub_mark_notifications(uuid, jsonb),
  public.hub_settings(uuid),
  public.hub_save_settings(uuid, jsonb),
  public.hub_accept_invitation(text)
  to authenticated;
grant execute on function public.hub_invitation_status(text),
  public.hub_activate_invitation(text, uuid),
  public.claim_portal_email(text, text),
  public.finish_portal_email(uuid, uuid, text, text, text)
  to service_role;
