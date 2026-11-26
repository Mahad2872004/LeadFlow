-- Reverses 202611270001_client_collaboration.sql. Run it as one batch, then:
--   npx supabase migration repair --status reverted 202611270001
-- Deletes every client portal account link, invitation, version, review, decision, feedback item, comment, published
-- update and portal notification, and the portal email outbox. Projects, milestones, deliverables and their internal
-- statuses stay; their client-sharing settings go. Files stay as internal project files of the client (version, comment,
-- feedback and update attachments included); stored objects are not touched. Collaboration events stay in the client's
-- history. Client people's Supabase Auth accounts stay (delete them in the dashboard if they should go); without
-- client_users rows they can reach nothing.

-- 1. Data the restored constraints would reject: project files become internal again.
update leadflow_private.client_documents set visibility = 'internal' where project_id is not null and visibility <> 'internal';

-- 2. The earlier definitions of the functions M12 redefined.
-- As in M2 (202610200001_multi_tenant_foundation.sql).
create or replace function leadflow_private.current_profile() returns uuid language plpgsql set search_path = '' as $$
declare actor uuid := leadflow_private.valid_actor();
begin
  if actor is null or not exists (select 1 from auth.users where id = actor) then
    raise exception 'Sign in with an internal account.' using errcode = '42501';
  end if;
  insert into public.profiles(id) values (actor) on conflict do nothing;
  return actor;
end $$;

-- As in M11 (202611260001_project_delivery.sql).
create or replace function leadflow_private.document_json(d leadflow_private.client_documents) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'clientId', d.client_id, 'requestId', d.request_id, 'itemId', d.item_id, 'fileName', d.file_name, 'extension', d.extension, 'mimeType', d.mime_type,
    'size', d.size_bytes, 'category', d.category, 'description', d.description, 'visibility', d.visibility, 'status', d.status, 'rejectedReason', d.rejected_reason, 'uploaderType', d.uploader_type,
    'uploadedBy', case when d.uploader_type = 'client' then 'Client' else (select coalesce(nullif(p.display_name, ''), u.email::text) from public.profiles p left join auth.users u on u.id = p.id where p.id = d.uploaded_by) end,
    'stageId', d.stage_id, 'createdAt', d.created_at, 'verifiedAt', d.verified_at,
    'itemTitle', (select i.title from leadflow_private.onboarding_items i where i.request_id = d.request_id and i.id = d.item_id),
    'projectId', d.project_id, 'projectName', (select p.name from leadflow_private.projects p where p.id = d.project_id), 'milestoneId', d.milestone_id, 'deliverableId', d.deliverable_id, 'taskId', d.task_id)
$$;

-- As in M11.
create or replace function public.begin_client_document(target_workspace uuid, target_client uuid, details jsonb, max_bytes bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_client leadflow_private.clients; request_ref uuid; project_ref uuid; milestone_ref uuid; deliverable_ref uuid; task_ref text; created jsonb;
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
  elsif coalesce(details->>'milestoneId', details->>'deliverableId', details->>'taskId', '') <> '' then
    raise exception 'Choose the project the file belongs to.' using errcode = '22023';
  end if;
  created := leadflow_private.begin_document(target_workspace, target_client, request_ref, null,
    (details - 'requestId' - 'projectId' - 'milestoneId' - 'deliverableId' - 'taskId') || case when project_ref is not null then '{"visibility":"internal"}'::jsonb else '{}'::jsonb end,
    'member', leadflow_private.valid_actor(), null, max_bytes);
  if project_ref is not null then
    update leadflow_private.client_documents d set project_id = project_ref, milestone_id = milestone_ref, deliverable_id = deliverable_ref, task_id = task_ref where d.id = (created->>'id')::uuid;
  end if;
  return created;
end $$;

-- As in M11.
create or replace function public.update_client_document(target_workspace uuid, target_document uuid, changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.client_documents;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if changes is null or jsonb_typeof(changes) <> 'object' then raise exception 'Send the changes as an object.' using errcode = '22023'; end if;
  if changes ? 'category' and changes->>'category' not in ('brand','logo','image','video','content','requirements','design_reference','technical','access_instructions','other') then raise exception 'Choose a document category.' using errcode = '22023'; end if;
  if changes ? 'visibility' and changes->>'visibility' not in ('internal','shared') then raise exception 'Choose who can see the file.' using errcode = '22023'; end if;
  if changes->>'visibility' = 'shared' and exists (select 1 from leadflow_private.client_documents x where x.id = target_document and x.workspace_id = target_workspace and x.project_id is not null) then
    raise exception 'Project files stay internal. Client sharing of project files isn''t available yet.' using errcode = '22023';
  end if;
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

-- As in M11.
create or replace function public.project_ai_reserve(target_workspace uuid, actor uuid, operation text, monthly_limit integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare used integer;
begin
  if operation not in ('project_plan','project_breakdown','project_summary','project_risks') then raise exception 'Unknown AI operation.' using errcode = '22023'; end if;
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

-- As in M10 (202611250001_client_management.sql).
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
  update leadflow_private.client_documents x set status = 'deleted', deleted_at = now(), deleted_by = leadflow_private.valid_actor() where x.id = d.id;
  if d.client_id is not null then
    perform leadflow_private.client_event(d.client_id, 'document_removed', 'File removed: ' || d.file_name, jsonb_build_object('category', d.category), 'member', 'document', d.id::text);
  end if;
  return jsonb_build_object('path', d.storage_path);
end $$;

-- As in M10.
create or replace function public.finish_client_document(target_document uuid, ok boolean, actual_size bigint, reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d leadflow_private.client_documents;
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
  else
    update leadflow_private.client_documents x set status = 'rejected', rejected_reason = left(coalesce(reason, 'The file failed the upload checks.'), 200) where x.id = d.id returning * into d;
  end if;
  return leadflow_private.document_json(d);
end $$;

-- As in M10.
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
      from leadflow_private.client_documents d where d.client_id = r.client_id and d.visibility = 'shared' and d.status = 'available' and d.uploader_type = 'member'), '[]'::jsonb) else '[]'::jsonb end,
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

-- As in M10.
create or replace function public.portal_document_access(key_hash text, target_document uuid, purpose text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare link leadflow_private.onboarding_links; request leadflow_private.onboarding_requests; d leadflow_private.client_documents;
begin
  link := leadflow_private.portal_link(key_hash);
  select * into request from leadflow_private.onboarding_requests r where r.id = link.request_id;
  select * into d from leadflow_private.client_documents x where x.id = target_document
    and ((x.request_id = request.id and x.uploader_type = 'client' and x.status in ('pending','available'))
      or (purpose = 'download' and request.client_id is not null and x.client_id = request.client_id and x.visibility = 'shared' and x.uploader_type = 'member' and x.status = 'available'));
  if not found or (purpose = 'finish' and d.status <> 'pending') or (purpose = 'download' and d.status <> 'available') then raise exception 'File not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', d.id, 'path', d.storage_path, 'fileName', d.file_name, 'mimeType', d.mime_type, 'size', d.size_bytes, 'status', d.status);
end $$;

-- 3. M12 functions, columns and tables.
drop function leadflow_private.is_client_account(),
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
  public.client_portal_access_for(uuid, uuid),
  leadflow_private.clean_project_ids(uuid, jsonb),
  leadflow_private.queue_invitation_email(leadflow_private.client_invitations, text),
  public.invite_client_user(uuid, uuid, jsonb, uuid),
  public.renew_client_invitation(uuid, uuid, boolean),
  public.revoke_client_invitation(uuid, uuid),
  public.update_client_user(uuid, uuid, jsonb, integer),
  public.set_client_user_active(uuid, uuid, boolean),
  public.set_project_portal(uuid, uuid, jsonb, integer),
  public.set_client_visibility(uuid, text, uuid, boolean),
  leadflow_private.lock_deliverable(uuid, uuid),
  public.create_deliverable_version(uuid, uuid, text),
  public.update_deliverable_version(uuid, uuid, text),
  public.discard_deliverable_version(uuid, uuid),
  leadflow_private.publish_version(leadflow_private.deliverable_versions),
  public.request_deliverable_review(uuid, uuid, jsonb, uuid),
  public.publish_deliverable_version(uuid, uuid),
  public.withdraw_deliverable_review(uuid, uuid, text),
  public.set_feedback_status(uuid, uuid, jsonb),
  public.deliverable_collab_for(uuid, uuid),
  public.project_collab_for(uuid, uuid),
  public.project_portal_preview(uuid, uuid),
  public.collab_queue_for(uuid),
  public.project_comments_for(uuid, uuid, jsonb),
  leadflow_private.comment_thread(leadflow_private.projects, jsonb),
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
  leadflow_private.member_events(),
  public.member_notification_settings(uuid),
  public.save_member_notification_settings(uuid, jsonb),
  public.project_collab_ai_context(uuid, uuid, uuid),
  leadflow_private.hub_rate_limit(text, integer),
  public.hub_accounts(),
  public.hub_home(uuid),
  public.hub_project(uuid),
  public.hub_deliverable(uuid),
  leadflow_private.hub_clean_feedback(jsonb),
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
  leadflow_private.client_events(),
  public.hub_settings(uuid),
  public.hub_save_settings(uuid, jsonb),
  leadflow_private.accept_invitation(text, uuid),
  public.hub_accept_invitation(text),
  public.hub_invitation_status(text),
  public.hub_activate_invitation(text, uuid),
  leadflow_private.notify_workspace_admins(uuid, text, text, text, text),
  leadflow_private.html_escape(text),
  leadflow_private.compose_portal_email(leadflow_private.portal_email_outbox, text, text),
  public.claim_portal_email(text, text),
  public.finish_portal_email(uuid, uuid, text, text, text);
alter table leadflow_private.client_documents drop constraint client_documents_version, drop constraint client_documents_comment, drop constraint client_documents_feedback,
  drop constraint client_documents_update, drop constraint client_documents_attachment_project, drop constraint client_documents_one_attachment,
  drop column version_id, drop column comment_id, drop column feedback_id, drop column update_id, drop column uploaded_client_user,
  add constraint client_documents_project_internal check (project_id is null or visibility = 'internal');
alter table leadflow_private.client_activities drop column client_user_id;
alter table leadflow_private.project_deliverables drop constraint project_deliverables_review_visible, drop column client_visible, drop column shared_at, drop column review_status;
alter table leadflow_private.project_milestones drop column client_visible;
alter table leadflow_private.projects drop column portal_shared, drop column portal_shared_at, drop column portal_summary, drop column portal_objectives,
  drop column portal_contact_name, drop column portal_contact_email;
drop table leadflow_private.portal_email_outbox, leadflow_private.portal_member_preferences, leadflow_private.portal_notifications, leadflow_private.project_update_revisions,
  leadflow_private.project_updates, leadflow_private.project_comment_reads, leadflow_private.project_comment_revisions, leadflow_private.project_comments,
  leadflow_private.deliverable_decisions, leadflow_private.deliverable_feedback, leadflow_private.deliverable_reviews, leadflow_private.deliverable_versions,
  leadflow_private.client_user_projects, leadflow_private.client_invitations, leadflow_private.client_users;
drop function leadflow_private.refuse_change();
