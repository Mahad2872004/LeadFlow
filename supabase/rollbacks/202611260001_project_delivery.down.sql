-- Reverses 202611260001_project_delivery.sql. Run it as one batch, then:
--   npx supabase migration repair --status reverted 202611260001
-- Deletes every project, milestone, deliverable and project template, and the project links of tasks, files and history.
-- Project tasks stay as tasks of the project's client (their project, milestone, deliverable, work status, start date,
-- effort, labels and dependencies are dropped; "delivery" tasks become "custom"). Project files stay as internal files of
-- the client, and project events and notes stay in the client's history. Stored files are not touched. AI usage rows
-- stay in the usage ledger. Clients, onboarding, deals and leads are not touched.

-- 1. Data the restored constraints would reject.
update public.follow_up_tasks set "taskType" = 'custom' where "taskType" = 'delivery';

-- 2. The M10 definitions as they were (202611250001_client_management.sql).
create or replace function public.save_workspace_for(target_workspace uuid, payload jsonb, expected_revision bigint, request_id uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare actor_role text; current_revision bigint; receipt public.workspace_requests; fingerprint text; kept jsonb;
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
  -- Assignees already on a task stay even if they left the workspace; any new assignment is checked by the trigger.
  select coalesce(jsonb_object_agg(t.id, t."assigneeId"), '{}') into kept from public.follow_up_tasks t where t.workspace_id = target_workspace and t."assigneeId" is not null;
  delete from public.leads where workspace_id = target_workspace;
  insert into public.leads(workspace_id, id, name, email, phone, company, service, source, message, status, "createdAt",
      website, industry, address, city, region, postcode, country)
    select target_workspace, x.id, x.name, x.email, x.phone, x.company, x.service, x.source, x.message, x.status, x."createdAt",
      coalesce(x.website, ''), coalesce(x.industry, ''), coalesce(x.address, ''), coalesce(x.city, ''), coalesce(x.region, ''), coalesce(x.postcode, ''), coalesce(x.country, '')
    from jsonb_to_recordset(payload->'leads') as x(id text, name text, email text, phone text, company text, service text, source text, message text, status text, "createdAt" timestamptz,
      website text, industry text, address text, city text, region text, postcode text, country text);
  perform set_config('leadflow.kept_assignees', kept::text, true);
  -- Client tasks have no lead, so the lead cascade above doesn't remove them: every task is replaced explicitly.
  delete from public.follow_up_tasks where workspace_id = target_workspace;
  insert into public.follow_up_tasks(workspace_id, id, "leadId", due, notes, completed, "dealId", "contactId", "taskType", priority, cancelled, description, "assigneeId", "createdAt", "completedAt",
      "clientId", "onboardingRequestId", "onboardingItemId")
    select target_workspace, x.id, x."leadId", x.due, x.notes, x.completed, x."dealId", x."contactId", coalesce(x."taskType", 'follow_up'), coalesce(x.priority, 'medium'),
      coalesce(x.cancelled, false), coalesce(x.description, ''), x."assigneeId", x."createdAt", x."completedAt", x."clientId", x."onboardingRequestId", x."onboardingItemId"
    from jsonb_to_recordset(payload->'tasks') as x(id text, "leadId" text, due date, notes text, completed boolean, "dealId" uuid, "contactId" uuid, "taskType" text, priority text,
      cancelled boolean, description text, "assigneeId" uuid, "createdAt" timestamptz, "completedAt" timestamptz, "clientId" uuid, "onboardingRequestId" uuid, "onboardingItemId" uuid);
  perform set_config('leadflow.kept_assignees', '', true);
  insert into public.activity_history(workspace_id, id, "leadId", text, at)
    select target_workspace, x.id, x."leadId", x.text, x.at
    from jsonb_to_recordset(payload->'activities') as x(id text, "leadId" text, text text, at timestamptz);
  delete from leadflow_private.lead_origins o where o.workspace_id = target_workspace
    and not exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = o.lead_id);
  update public.workspaces set revision = revision + 1 where id = target_workspace returning revision into current_revision;
  insert into public.workspace_requests(workspace_id, request_id, payload_hash, revision, actor_id)
    values (target_workspace, request_id, fingerprint, current_revision, leadflow_private.valid_actor());
  return current_revision;
end $$;

create or replace function leadflow_private.check_follow_up_task() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new."dealId" is not null and not exists (select 1 from leadflow_private.deals d where d.workspace_id = new.workspace_id and d.id = new."dealId" and d.lead_id = new."leadId") then
    raise exception 'A follow-up’s deal must belong to the same lead.' using errcode = '22023';
  end if;
  if new."contactId" is not null and not exists (select 1 from leadflow_private.lead_contacts c where c.workspace_id = new.workspace_id and c.id = new."contactId" and c.lead_id = new."leadId") then
    raise exception 'A follow-up’s contact must belong to the same lead.' using errcode = '22023';
  end if;
  -- A new assignment must be a member. The snapshot save re-inserts every task, so it lists the assignees tasks already
  -- had (leadflow.kept_assignees); those stay even if the person has since left the workspace.
  if new."assigneeId" is not null
      and (tg_op = 'INSERT' or new."assigneeId" is distinct from old."assigneeId")
      and not exists (select 1 from public.workspace_memberships m where m.workspace_id = new.workspace_id and m.user_id = new."assigneeId")
      and coalesce(nullif(current_setting('leadflow.kept_assignees', true), ''), '{}')::jsonb ->> new.id is distinct from new."assigneeId"::text then
    raise exception 'Assign follow-ups to members of this workspace.' using errcode = '22023';
  end if;
  -- Onboarding tasks belong to a client, and their request to that client.
  if new."onboardingRequestId" is not null and (new."clientId" is null or not exists (select 1 from leadflow_private.onboarding_requests r
      where r.workspace_id = new.workspace_id and r.id = new."onboardingRequestId" and r.client_id = new."clientId")) then
    raise exception 'An onboarding task''s request must belong to its client.' using errcode = '22023';
  end if;
  return new;
end $$;

create or replace function leadflow_private.document_json(d leadflow_private.client_documents) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'clientId', d.client_id, 'requestId', d.request_id, 'itemId', d.item_id, 'fileName', d.file_name, 'extension', d.extension, 'mimeType', d.mime_type,
    'size', d.size_bytes, 'category', d.category, 'description', d.description, 'visibility', d.visibility, 'status', d.status, 'rejectedReason', d.rejected_reason, 'uploaderType', d.uploader_type,
    'uploadedBy', case when d.uploader_type = 'client' then 'Client' else (select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = d.uploaded_by) end,
    'stageId', d.stage_id, 'createdAt', d.created_at, 'verifiedAt', d.verified_at,
    'itemTitle', (select i.title from leadflow_private.onboarding_items i where i.request_id = d.request_id and i.id = d.item_id))
$$;

create or replace function public.begin_client_document(target_workspace uuid, target_client uuid, details jsonb, max_bytes bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; request_ref uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into found_client from leadflow_private.clients c where c.id = target_client and c.workspace_id = target_workspace;
  if not found then raise exception 'Client not found in this workspace.' using errcode = 'P0002'; end if;
  if found_client.status = 'archived' then raise exception 'Unarchive this client before adding files.' using errcode = '55000'; end if;
  if nullif(details->>'requestId', '') is not null then
    select r.id into request_ref from leadflow_private.onboarding_requests r where r.client_id = target_client and r.id::text = details->>'requestId';
    if request_ref is null then raise exception 'That onboarding request isn''t this client''s.' using errcode = '22023'; end if;
  end if;
  return leadflow_private.begin_document(target_workspace, target_client, request_ref, null, details - 'requestId', 'member', leadflow_private.valid_actor(), null, max_bytes);
end $$;

create or replace function public.update_client_document(target_workspace uuid, target_document uuid, changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.client_documents;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if changes is null or jsonb_typeof(changes) <> 'object' then raise exception 'Send the changes as an object.' using errcode = '22023'; end if;
  if changes ? 'category' and changes->>'category' not in ('brand','logo','image','video','content','requirements','design_reference','technical','access_instructions','other') then raise exception 'Choose a document category.' using errcode = '22023'; end if;
  if changes ? 'visibility' and changes->>'visibility' not in ('internal','shared') then raise exception 'Choose who can see the file.' using errcode = '22023'; end if;
  update leadflow_private.client_documents x set category = coalesce(changes->>'category', x.category), visibility = coalesce(changes->>'visibility', x.visibility),
    description = case when changes ? 'description' then leadflow_private.onboarding_clean_text(changes->>'description', 'Description', 1000, false, false) else x.description end
    where x.id = target_document and x.workspace_id = target_workspace and x.status = 'available' returning * into d;
  if d.id is null then raise exception 'File not found.' using errcode = 'P0002'; end if;
  if d.client_id is not null and changes ? 'visibility' then
    perform leadflow_private.client_event(d.client_id, 'document_updated', case d.visibility when 'shared' then 'File shared with the client: ' else 'File made internal: ' end || d.file_name,
      jsonb_build_object('visibility', d.visibility), 'member', 'document', d.id::text);
  end if;
  return leadflow_private.document_json(d);
end $$;

-- 3. M11 functions, columns and tables.
drop function public.project_setup_for(uuid, uuid), public.create_project(uuid, jsonb, uuid), public.apply_project_plan(uuid, uuid, jsonb, text, uuid), public.update_project(uuid, uuid, integer, jsonb), public.set_project_status(uuid, uuid, text, integer, text), public.add_project_note(uuid, uuid, text, uuid), public.project_index_for(uuid), public.projects_for(uuid, jsonb), public.project_detail(uuid, uuid), public.projects_dashboard_for(uuid), public.project_timeline(uuid, uuid, jsonb, timestamptz, text, integer), public.project_entity_history(uuid, uuid, text, uuid), public.project_calendar_for(uuid, date, date, jsonb), public.save_project_milestone(uuid, uuid, jsonb, integer), public.reorder_project_milestones(uuid, uuid, jsonb), public.remove_project_milestone(uuid, uuid, uuid), public.save_project_deliverable(uuid, uuid, jsonb, integer, uuid), public.remove_project_deliverable(uuid, uuid, uuid), public.project_templates_for(uuid), public.project_template_for(uuid, uuid), public.save_project_template(uuid, jsonb, integer, uuid), public.set_project_template_archived(uuid, uuid, boolean), public.save_project_as_template(uuid, uuid, text, uuid), public.project_template_plan(uuid, uuid, date), public.project_documents_for(uuid, uuid), public.project_ai_context(uuid, uuid, uuid), public.project_ai_reserve(uuid, uuid, text, integer);
drop function leadflow_private.project_today(uuid), leadflow_private.bump_workspace_revision(uuid), leadflow_private.project_event(leadflow_private.projects, text, text, jsonb, text, text, uuid), leadflow_private.lock_project(uuid, uuid, integer), leadflow_private.clean_money(jsonb, text), leadflow_private.clean_labels(jsonb, text, integer, integer), leadflow_private.clean_brief(jsonb), leadflow_private.clean_project_details(jsonb), leadflow_private.set_project_links(leadflow_private.projects, jsonb, jsonb), leadflow_private.project_progress(leadflow_private.projects, date), leadflow_private.project_health(leadflow_private.projects, date), leadflow_private.project_summary_json(leadflow_private.projects, date), leadflow_private.check_task_dependencies(uuid), leadflow_private.check_milestone_dependencies(uuid), leadflow_private.apply_plan(leadflow_private.projects, jsonb), leadflow_private.clean_template_milestone(jsonb), leadflow_private.project_starter_templates(), leadflow_private.ensure_project_templates(uuid), leadflow_private.milestone_json(leadflow_private.project_milestones, date), leadflow_private.deliverable_json(leadflow_private.project_deliverables, date), leadflow_private.compose_brief(jsonb, jsonb, text, text);
alter table public.follow_up_tasks drop constraint follow_up_tasks_project, drop constraint follow_up_tasks_milestone, drop constraint follow_up_tasks_deliverable, drop constraint follow_up_tasks_start,
  drop column "projectId", drop column "milestoneId", drop column "deliverableId", drop column status, drop column "startDate", drop column "estimateHours", drop column "actualHours",
  drop column labels, drop column "dependsOn";
alter table public.follow_up_tasks drop constraint "follow_up_tasks_taskType_check";
alter table public.follow_up_tasks add constraint "follow_up_tasks_taskType_check" check ("taskType" in ('follow_up','call','email','whatsapp','meeting','proposal','proposal_review','internal','custom',
  'welcome','request_info','review_form','collect_assets','review_requirements','confirm_scope','verify_integrations','prepare_handoff'));
alter table leadflow_private.client_documents drop constraint client_documents_project_links, drop constraint client_documents_project_internal, drop constraint client_documents_project,
  drop constraint client_documents_milestone, drop constraint client_documents_deliverable, drop column project_id, drop column milestone_id, drop column deliverable_id, drop column task_id;
alter table leadflow_private.client_activities drop constraint client_activities_project, drop column project_id;
drop table leadflow_private.project_deliverables, leadflow_private.project_milestones, leadflow_private.project_contacts, leadflow_private.project_services, leadflow_private.projects,
  leadflow_private.project_template_milestones, leadflow_private.project_templates;
