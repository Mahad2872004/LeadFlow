-- M13: automation and workflow engine, part 2. Execution (actions, the run loop, waits, retries), scheduled checks,
-- signed webhooks, the member functions behind the Automation Center, starter templates and grants. See docs/AUTOMATION.md.

-- ---------- Execution helpers ----------

-- A stable UUID per run and step: the request ID every side effect is made with, so a repeated attempt finds the record the
-- first attempt created instead of making another.
create function leadflow_private.automation_key(run_id uuid, node_id text) returns uuid language sql immutable set search_path = '' as $$
  select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
  from (select md5(run_id::text || ':' || node_id) as h) x
$$;

-- What kind of record a registered reference path names: trigger.lead.id → lead, steps.n2.dealId → deal, *.ownerId → member.
create function leadflow_private.automation_ref_entity(path text) returns text language sql immutable set search_path = '' as $$
  select case when last in ('ownerId','assigneeId') then 'member' when last = 'id' then parts[cardinality(parts) - 1] when last like '%Id' then left(last, length(last) - 2) end
  from (select string_to_array(coalesce(path, ''), '.') as parts, (string_to_array(coalesce(path, ''), '.'))[cardinality(string_to_array(coalesce(path, ''), '.'))] as last) x
$$;

-- Actions act as the member who published the workflow version: every existing function then checks that member's
-- membership and role exactly as for a request they made themselves. Transaction-local, and reverted with a failed step.
create function leadflow_private.automation_impersonate(actor uuid) returns void language plpgsql set search_path = '' as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(actor::text, ''), true);
  perform set_config('request.jwt.claims', case when actor is null then '' else jsonb_build_object('sub', actor, 'role', 'authenticated')::text end, true);
end $$;

-- transient: worth retrying (conflicts, locks, limits that reset); authorization: the publisher lost access; invalid: the
-- record or the configuration doesn't allow it, and retrying won't help.
create function leadflow_private.automation_classify(state text) returns text language sql immutable set search_path = '' as $$
  select case when state = '42501' then 'authorization'
    when state in ('40001','40P01','55P03','57014','P0429','53000','53100','53200','53300','08000','08003','08006','25P02') then 'transient'
    else 'invalid' end
$$;

-- The owner of a record, for "record owner" recipients and assignees. Leads have no owner.
create function leadflow_private.automation_record_owner(target_workspace uuid, entity text, entity_id text) returns uuid language plpgsql stable security definer set search_path = '' as $$
declare owner_ref uuid;
begin
  if entity_id is null then return null; end if;
  case entity
    when 'deal' then select d.owner_id into owner_ref from leadflow_private.deals d where d.workspace_id = target_workspace and d.id::text = entity_id;
    when 'client' then select c.owner_id into owner_ref from leadflow_private.clients c where c.workspace_id = target_workspace and c.id::text = entity_id;
    when 'project' then select p.owner_id into owner_ref from leadflow_private.projects p where p.workspace_id = target_workspace and p.id::text = entity_id;
    when 'milestone' then select p.owner_id into owner_ref from leadflow_private.project_milestones m join leadflow_private.projects p on p.id = m.project_id
      where m.workspace_id = target_workspace and m.id::text = entity_id;
    when 'deliverable' then select coalesce(d.owner_id, p.owner_id) into owner_ref from leadflow_private.project_deliverables d join leadflow_private.projects p on p.id = d.project_id
      where d.workspace_id = target_workspace and d.id::text = entity_id;
    when 'task' then select t."assigneeId" into owner_ref from public.follow_up_tasks t where t.workspace_id = target_workspace and t.id = entity_id;
    when 'onboarding' then select r.owner_id into owner_ref from leadflow_private.onboarding_requests r where r.workspace_id = target_workspace and r.id::text = entity_id;
    else owner_ref := null;
  end case;
  -- Only current members count.
  if owner_ref is not null and not exists (select 1 from public.workspace_memberships m where m.workspace_id = target_workspace and m.user_id = owner_ref) then owner_ref := null; end if;
  return owner_ref;
end $$;

-- A member chosen in an "assign to" setting: none, publisher, record_owner or a member's ID (who must still be a member).
create function leadflow_private.automation_member(target_workspace uuid, selector text, publisher uuid, entity text, entity_id text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if selector is null or selector = 'none' then return null; end if;
  if selector = 'publisher' then return publisher; end if;
  if selector = 'record_owner' then return leadflow_private.automation_record_owner(target_workspace, entity, entity_id); end if;
  if not exists (select 1 from public.workspace_memberships m where m.workspace_id = target_workspace and m.user_id::text = selector) then
    raise exception 'The member chosen in this step is no longer in the workspace.' using errcode = '22023';
  end if;
  return selector::uuid;
end $$;

-- A due date from { mode: days, days } or { mode: relative, path, offset }, in the workspace's time zone.
create function leadflow_private.automation_due(due jsonb, ctx jsonb, today date) returns date language plpgsql immutable set search_path = '' as $$
declare base date;
begin
  if due->>'mode' = 'relative' then
    begin base := left(leadflow_private.automation_value(ctx, due->>'path') #>> '{}', 10)::date; exception when others then base := null; end;
    if base is null then return today; end if;
    return greatest(base + coalesce((due->>'offset')::integer, 0), today);
  end if;
  return today + least(greatest(coalesce((due->>'days')::integer, 0), 0), 365);
end $$;

-- What the step log keeps about an action's inputs: rendered text and resolved references, sanitized.
create function leadflow_private.automation_input_summary(def jsonb, inputs jsonb, ctx jsonb, today date) returns jsonb language plpgsql immutable set search_path = '' as $$
declare result jsonb := '{}'; input jsonb; v jsonb;
begin
  for input in select value from jsonb_array_elements(def->'inputs') loop
    v := inputs->(input->>'key');
    if v is null or v = 'null'::jsonb then continue; end if;
    result := result || jsonb_build_object(input->>'key', case input->>'kind'
      when 'template' then to_jsonb(leadflow_private.automation_render(v #>> '{}', ctx, 300))
      when 'subject' then jsonb_build_object('path', v, 'id', leadflow_private.automation_value(ctx, v #>> '{}'))
      when 'due' then to_jsonb(leadflow_private.automation_due(v, ctx, today))
      else v end);
  end loop;
  return leadflow_private.automation_sanitize(result);
end $$;

-- ---------- Actions ----------

-- Runs one action and returns its outputs. "_status": "skipped" (with "reason") marks a step that had nothing to do.
-- Called inside a subtransaction: if it fails, its writes are undone and the run decides whether to retry.
create function leadflow_private.automation_execute(r leadflow_private.automation_runs, v leadflow_private.automation_versions, wf_name text, node jsonb, node_id text, today date, limits jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare ws uuid := r.workspace_id; ctx jsonb := r.context; inputs jsonb := coalesce(node->'inputs', '{}'); def jsonb := leadflow_private.automation_action_def(node->>'action');
  key uuid := leadflow_private.automation_key(r.id, node_id); actor uuid := v.published_by; subject_path text := inputs->>'subject'; entity text; sid text;
  lead_ref text; deal_ref uuid; client_ref uuid; project_ref uuid; milestone_ref uuid; deliverable_ref uuid; title_value text; text_value text; due_value date; result jsonb;
  task_id text; assignee uuid; task_type text; inserted integer; d leadflow_private.deals; l public.leads; dl leadflow_private.project_deliverables; p leadflow_private.projects;
  completion leadflow_private.client_onboarding_completions; existing uuid; setup jsonb; plan jsonb; details jsonb; recipients uuid[] := '{}'; selector text; member uuid; wanted jsonb;
  address text; emailed integer := 0; about_entity text; about_id text; project_link uuid; deliverable_link uuid; previous text; stage_row leadflow_private.sales_stages; version_row leadflow_private.deliverable_versions;
  err_detail text; prefix text := 'Automation “' || left(wf_name, 80) || '”: ';
begin
  if actor is null then raise exception 'The member who published this workflow no longer has an account.' using errcode = '42501'; end if;
  perform leadflow_private.automation_impersonate(actor);
  -- The publisher's access, checked now rather than when the workflow was published.
  perform leadflow_private.require_role(ws, array(select jsonb_array_elements_text(def->'roles')), false);
  if def->>'side' = 'consequential' and inputs->'confirm' is distinct from 'true'::jsonb then
    raise exception 'This consequential action isn''t confirmed in the published version.' using errcode = '22023';
  end if;
  if subject_path is not null then
    entity := leadflow_private.automation_ref_entity(subject_path);
    sid := leadflow_private.automation_value(ctx, subject_path) #>> '{}';
    if sid is null or sid = '' then raise exception 'The trigger or earlier step didn''t provide the % this action needs.', entity using errcode = '22023'; end if;
  end if;

  case node->>'action'
  when 'task.create' then
    case entity
      when 'lead' then
        if not exists (select 1 from public.leads x where x.workspace_id = ws and x.id = sid) then raise exception 'The lead no longer exists.' using errcode = 'P0002'; end if;
        lead_ref := sid;
      when 'deal' then
        select * into d from leadflow_private.deals x where x.workspace_id = ws and x.id::text = sid;
        if d.id is null then raise exception 'The deal no longer exists.' using errcode = 'P0002'; end if;
        lead_ref := d.lead_id; deal_ref := d.id;
      when 'client' then
        select c.id into client_ref from leadflow_private.clients c where c.workspace_id = ws and c.id::text = sid;
        if client_ref is null then raise exception 'The client no longer exists.' using errcode = 'P0002'; end if;
      when 'project' then
        select * into p from leadflow_private.projects x where x.workspace_id = ws and x.id::text = sid;
        if p.id is null then raise exception 'The project no longer exists.' using errcode = 'P0002'; end if;
        project_ref := p.id; client_ref := p.client_id;
      when 'milestone' then
        select m.id, m.project_id, x.client_id into milestone_ref, project_ref, client_ref from leadflow_private.project_milestones m join leadflow_private.projects x on x.id = m.project_id
          where m.workspace_id = ws and m.id::text = sid;
        if milestone_ref is null then raise exception 'The milestone no longer exists.' using errcode = 'P0002'; end if;
      when 'deliverable' then
        select * into dl from leadflow_private.project_deliverables x where x.workspace_id = ws and x.id::text = sid;
        if dl.id is null then raise exception 'The deliverable no longer exists.' using errcode = 'P0002'; end if;
        deliverable_ref := dl.id; milestone_ref := dl.milestone_id; project_ref := dl.project_id;
        select x.client_id into client_ref from leadflow_private.projects x where x.id = dl.project_id;
      else raise exception 'Tasks can''t be attached to this record.' using errcode = '22023';
    end case;
    title_value := leadflow_private.automation_render(inputs->>'title', ctx, 200);
    if title_value = '' then raise exception 'The task title is empty after filling in its variables.' using errcode = '22023'; end if;
    due_value := leadflow_private.automation_due(inputs->'due', ctx, today);
    assignee := leadflow_private.automation_member(ws, coalesce(inputs->>'assignee', 'none'), actor, entity, sid);
    task_type := coalesce(inputs->>'taskType', case when project_ref is not null then 'delivery' when client_ref is not null then 'internal' else 'follow_up' end);
    task_id := 'auto-' || key::text;
    insert into public.follow_up_tasks(workspace_id, id, "leadId", due, notes, completed, "dealId", "taskType", priority, cancelled, description, "assigneeId", "createdAt",
        "clientId", "projectId", "milestoneId", "deliverableId", status)
      values (ws, task_id, lead_ref, due_value, title_value, false, deal_ref, task_type, coalesce(inputs->>'priority', 'medium'), false,
        leadflow_private.automation_render(inputs->>'description', ctx, 2000), assignee, now(), client_ref, project_ref, milestone_ref, deliverable_ref, 'todo')
      on conflict (workspace_id, id) do nothing;
    get diagnostics inserted = row_count;
    if inserted > 0 then perform leadflow_private.bump_workspace_revision(ws); end if;
    return jsonb_build_object('taskId', task_id, 'title', title_value, 'dueDate', due_value, 'assigneeId', assignee,
      '_input', jsonb_build_object('subject', jsonb_build_object('entity', entity, 'id', sid), 'title', title_value, 'dueDate', due_value, 'priority', coalesce(inputs->>'priority', 'medium'),
        'taskType', task_type, 'assigned', assignee is not null));

  when 'note.add' then
    text_value := leadflow_private.automation_render(inputs->>'text', ctx, 2000);
    if text_value = '' then raise exception 'The note is empty after filling in its variables.' using errcode = '22023'; end if;
    case entity
      when 'lead' then
        if not exists (select 1 from public.leads x where x.workspace_id = ws and x.id = sid) then raise exception 'The lead no longer exists.' using errcode = 'P0002'; end if;
        insert into public.activity_history(workspace_id, id, "leadId", text, at) values (ws, 'auto-' || key::text, sid, left(prefix || text_value, 4000), now()) on conflict do nothing;
        get diagnostics inserted = row_count;
        if inserted > 0 then perform leadflow_private.bump_workspace_revision(ws); end if;
      when 'deal' then perform public.record_deal_activity(ws, sid::uuid, jsonb_build_object('kind', 'note', 'summary', 'Automation note', 'details', prefix || text_value), key);
      when 'client' then perform public.add_client_note(ws, sid::uuid, prefix || text_value, key);
      when 'project' then perform public.add_project_note(ws, sid::uuid, prefix || text_value, key);
      else raise exception 'Notes can''t be added to this record.' using errcode = '22023';
    end case;
    return jsonb_build_object('added', true, '_input', jsonb_build_object('subject', jsonb_build_object('entity', entity, 'id', sid), 'text', left(text_value, 300)));

  when 'deal.add_activity' then
    text_value := leadflow_private.automation_render(inputs->>'text', ctx, 2000);
    if text_value = '' then raise exception 'The note is empty after filling in its variables.' using errcode = '22023'; end if;
    perform public.record_deal_activity(ws, sid::uuid, jsonb_build_object('kind', 'note', 'summary', 'Automation note', 'details', prefix || text_value), key);
    return jsonb_build_object('added', true, '_input', jsonb_build_object('deal', sid, 'text', left(text_value, 300)));

  when 'notify.members' then
    if inputs->>'about' is not null then
      about_entity := leadflow_private.automation_ref_entity(inputs->>'about');
      about_id := leadflow_private.automation_value(ctx, inputs->>'about') #>> '{}';
      case about_entity
        when 'project' then project_link := about_id::uuid;
        when 'milestone' then select m.project_id into project_link from leadflow_private.project_milestones m where m.workspace_id = ws and m.id::text = about_id;
        when 'deliverable' then select x.project_id, x.id into project_link, deliverable_link from leadflow_private.project_deliverables x where x.workspace_id = ws and x.id::text = about_id;
        when 'task' then select t."projectId", t."deliverableId" into project_link, deliverable_link from public.follow_up_tasks t where t.workspace_id = ws and t.id = about_id;
        else null;
      end case;
      if project_link is not null and not exists (select 1 from leadflow_private.projects x where x.id = project_link and x.workspace_id = ws) then project_link := null; deliverable_link := null; end if;
    end if;
    for selector in select x from jsonb_array_elements_text(coalesce(inputs->'recipients', '[]')) x loop
      if selector = 'publisher' then recipients := recipients || actor;
      elsif selector = 'admins' then recipients := recipients || array(select m.user_id from public.workspace_memberships m where m.workspace_id = ws and m.role in ('owner','admin'));
      elsif selector = 'record_owner' then
        member := leadflow_private.automation_record_owner(ws, about_entity, about_id);
        -- A record without an owner notifies the workspace's owners and admins instead.
        recipients := recipients || case when member is not null then array[member] else array(select m.user_id from public.workspace_memberships m where m.workspace_id = ws and m.role in ('owner','admin')) end;
      elsif exists (select 1 from public.workspace_memberships m where m.workspace_id = ws and m.user_id::text = selector) then recipients := recipients || selector::uuid;
      end if;
    end loop;
    recipients := array(select distinct x from unnest(recipients) x where x is not null);
    title_value := leadflow_private.automation_render(inputs->>'title', ctx, 150);
    if title_value = '' then title_value := 'Automation: ' || left(wf_name, 120); end if;
    text_value := leadflow_private.automation_render(inputs->>'body', ctx, 500);
    if cardinality(recipients) = 0 then
      return jsonb_build_object('_status', 'skipped', 'reason', 'No current member matched the recipients.', 'recipients', 0, 'emailed', 0);
    end if;
    foreach member in array recipients loop
      address := null;
      if inputs->'email' = 'true'::jsonb then
        select coalesce((select q.email_events from leadflow_private.portal_member_preferences q where q.workspace_id = ws and q.user_id = member), leadflow_private.member_email_defaults()) into wanted;
        if wanted ? 'automation_alert' then select u.email into address from auth.users u where u.id = member; end if;
      end if;
      if address is not null and not exists (select 1 from leadflow_private.portal_notifications n where n.user_id = member and n.dedupe_key = 'automation:' || key || ':' || member) then
        emailed := emailed + 1;
      end if;
      perform leadflow_private.queue_notification(ws, 'member', member, null, 'automation_alert', project_link, deliverable_link, title_value, text_value, '',
        'automation:' || key || ':' || member, address);
    end loop;
    return jsonb_build_object('recipients', cardinality(recipients), 'emailed', emailed,
      '_input', jsonb_build_object('title', title_value, 'body', left(text_value, 300), 'recipients', cardinality(recipients), 'email', inputs->'email' = 'true'::jsonb));

  when 'lead.set_status' then
    select * into l from public.leads x where x.workspace_id = ws and x.id = sid for update;
    if l.id is null then raise exception 'The lead no longer exists.' using errcode = 'P0002'; end if;
    if inputs->>'status' not in ('New','Contacted','Qualified') then raise exception 'Automations can set a lead to New, Contacted or Qualified only.' using errcode = '22023'; end if;
    if l.status = inputs->>'status' then return jsonb_build_object('status', l.status, 'changed', false, '_status', 'skipped', 'reason', 'The lead already had this status.'); end if;
    update public.leads x set status = inputs->>'status' where x.workspace_id = ws and x.id = sid;
    insert into public.activity_history(workspace_id, id, "leadId", text, at)
      values (ws, 'auto-' || key::text, sid, left(prefix || 'status changed from ' || l.status || ' to ' || (inputs->>'status') || '.', 4000), now()) on conflict do nothing;
    perform leadflow_private.bump_workspace_revision(ws);
    return jsonb_build_object('status', inputs->>'status', 'changed', true, '_input', jsonb_build_object('lead', sid, 'from', l.status, 'to', inputs->>'status'));

  when 'analysis.start' then
    begin
      result := public.start_business_analysis(ws, actor, sid, key, null, false, coalesce(limits->'analysis', '{}'));
    exception when sqlstate 'P0409' then
      return jsonb_build_object('_status', 'skipped', 'reason', 'This website was analyzed recently; that report is used instead.', 'started', false);
    end;
    return jsonb_build_object('analysisId', result->>'id', 'started', not coalesce((result->>'existing')::boolean, false), '_input', jsonb_build_object('lead', sid));

  when 'contacts.discover' then
    begin
      result := public.start_contact_discovery(ws, actor, sid, key, 'full', '[]'::jsonb, false, coalesce(limits->'contacts', '{}'));
    exception when sqlstate 'P0409' then
      return jsonb_build_object('_status', 'skipped', 'reason', 'Contacts were searched recently.', 'started', false);
    end;
    return jsonb_build_object('started', true, '_input', jsonb_build_object('lead', sid));

  when 'deal.create' then
    if not exists (select 1 from public.leads x where x.workspace_id = ws and x.id = sid) then raise exception 'The lead no longer exists.' using errcode = 'P0002'; end if;
    title_value := leadflow_private.automation_render(inputs->>'title', ctx, 150);
    if title_value = '' then raise exception 'The deal title is empty after filling in its variables.' using errcode = '22023'; end if;
    assignee := leadflow_private.automation_member(ws, coalesce(inputs->>'owner', 'none'), actor, entity, sid);
    begin
      result := public.create_deal(ws, jsonb_strip_nulls(jsonb_build_object('leadId', sid, 'title', title_value, 'stageId', inputs->>'stageId', 'ownerId', assignee, 'source', 'lead')), key, false);
    exception when sqlstate 'P0409' then
      get stacked diagnostics err_detail = pg_exception_detail;
      return jsonb_build_object('_status', 'skipped', 'reason', 'The lead already has an open deal with this title.', 'dealId', nullif(err_detail, ''), 'title', title_value);
    end;
    return jsonb_build_object('dealId', result->>'id', 'title', title_value, '_input', jsonb_build_object('lead', sid, 'title', title_value, 'owner', assignee is not null));

  when 'deal.move_stage' then
    select * into d from leadflow_private.deals x where x.workspace_id = ws and x.id::text = sid;
    if d.id is null then raise exception 'The deal no longer exists.' using errcode = 'P0002'; end if;
    select * into stage_row from leadflow_private.sales_stages s where s.workspace_id = ws and s.id::text = inputs->>'stageId';
    if stage_row.id is null or stage_row.archived_at is not null then raise exception 'The stage chosen in this step no longer exists.' using errcode = '22023'; end if;
    if d.stage_id = stage_row.id then return jsonb_build_object('stage', stage_row.name, '_status', 'skipped', 'reason', 'The deal is already in this stage.'); end if;
    perform public.move_deal(ws, d.id, stage_row.id, null, key);
    return jsonb_build_object('stage', stage_row.name, '_input', jsonb_build_object('deal', sid, 'stage', stage_row.name));

  when 'onboarding.start' then
    if not exists (select 1 from leadflow_private.clients c where c.workspace_id = ws and c.id::text = sid) then raise exception 'The client no longer exists.' using errcode = 'P0002'; end if;
    select r2.id into existing from leadflow_private.onboarding_requests r2 where r2.workspace_id = ws and r2.client_id::text = sid and r2.status <> 'cancelled' order by r2.created_at limit 1;
    if existing is not null then
      return jsonb_build_object('_status', 'skipped', 'reason', 'The client already has an onboarding checklist.', 'onboardingId', existing, 'started', false);
    end if;
    existing := public.start_client_onboarding(ws, sid::uuid, jsonb_strip_nulls(jsonb_build_object('templateId', inputs->>'templateId')), key);
    return jsonb_build_object('onboardingId', existing, 'started', true, '_input', jsonb_build_object('client', sid, 'template', inputs->>'templateId'));

  when 'project.create_from_onboarding' then
    select * into completion from leadflow_private.client_onboarding_completions c where c.workspace_id = ws and c.client_id::text = sid;
    if completion.id is null then raise exception 'This client''s onboarding isn''t completed, so there is no handoff to build a project from.' using errcode = '55000'; end if;
    select x.id into existing from leadflow_private.projects x where x.workspace_id = ws and x.completion_id = completion.id order by x.created_at limit 1;
    if existing is not null then
      return jsonb_build_object('_status', 'skipped', 'reason', 'A project was already created from this onboarding handoff.', 'projectId', existing, 'created', false);
    end if;
    title_value := leadflow_private.automation_render(inputs->>'name', ctx, 150);
    if title_value = '' then raise exception 'The project name is empty after filling in its variables.' using errcode = '22023'; end if;
    setup := public.project_setup_for(ws, sid::uuid);
    assignee := leadflow_private.automation_member(ws, coalesce(inputs->>'owner', 'record_owner'), actor, 'client', sid);
    if inputs->>'templateId' is not null then plan := public.project_template_plan(ws, (inputs->>'templateId')::uuid, today); end if;
    details := jsonb_strip_nulls(jsonb_build_object('clientId', sid, 'source', 'onboarding', 'completionId', completion.id, 'name', title_value, 'ownerId', assignee, 'startDate', today,
      'brief', setup->'brief', 'templateId', inputs->>'templateId', 'plan', plan,
      'serviceIds', (select coalesce(jsonb_agg(s->'id'), '[]'::jsonb) from jsonb_array_elements(setup->'services') s where (s->>'current')::boolean)));
    result := public.create_project(ws, details, key);
    return jsonb_build_object('projectId', result->>'id', 'created', true, '_input', jsonb_build_object('client', sid, 'name', title_value, 'template', inputs->>'templateId'));

  when 'milestone.create' then
    select * into p from leadflow_private.projects x where x.workspace_id = ws and x.id::text = sid;
    if p.id is null then raise exception 'The project no longer exists.' using errcode = 'P0002'; end if;
    title_value := leadflow_private.automation_render(inputs->>'name', ctx, 150);
    if title_value = '' then raise exception 'The milestone name is empty after filling in its variables.' using errcode = '22023'; end if;
    due_value := leadflow_private.automation_due(inputs->'due', ctx, today);
    result := public.save_project_milestone(ws, p.id, jsonb_build_object('name', title_value, 'dueDate', due_value), null);
    return jsonb_build_object('milestoneId', result->>'id', '_input', jsonb_build_object('project', sid, 'name', title_value, 'dueDate', due_value));

  when 'deliverable.set_status' then
    select * into dl from leadflow_private.project_deliverables x where x.workspace_id = ws and x.id::text = sid;
    if dl.id is null then raise exception 'The deliverable no longer exists.' using errcode = 'P0002'; end if;
    if inputs->>'status' not in ('in_progress','internal_review','ready_for_review','completed') then raise exception 'Choose a listed delivery status.' using errcode = '22023'; end if;
    previous := dl.status;
    if previous = inputs->>'status' then return jsonb_build_object('status', previous, 'changed', false, '_status', 'skipped', 'reason', 'The deliverable already had this status.'); end if;
    perform public.save_project_deliverable(ws, dl.project_id, jsonb_build_object('id', dl.id, 'title', dl.title, 'description', dl.description, 'milestoneId', dl.milestone_id,
      'ownerId', dl.owner_id, 'dueDate', dl.due_date, 'priority', dl.priority, 'status', inputs->>'status', 'notes', dl.notes, 'clientServiceId', dl.client_service_id), dl.version, null);
    return jsonb_build_object('status', inputs->>'status', 'changed', true, '_input', jsonb_build_object('deliverable', sid, 'from', previous, 'to', inputs->>'status'));

  when 'project.set_status' then
    select * into p from leadflow_private.projects x where x.workspace_id = ws and x.id::text = sid;
    if p.id is null then raise exception 'The project no longer exists.' using errcode = 'P0002'; end if;
    if inputs->>'status' not in ('not_started','in_progress','on_hold') then raise exception 'Automations can''t complete or cancel a project.' using errcode = '22023'; end if;
    if p.status in ('completed','cancelled') then raise exception 'The project is % and is left as a person set it.', p.status using errcode = '55000'; end if;
    if p.status = inputs->>'status' then return jsonb_build_object('status', p.status, '_status', 'skipped', 'reason', 'The project already had this status.'); end if;
    perform public.set_project_status(ws, p.id, inputs->>'status', null, left(prefix || 'status changed.', 1000));
    return jsonb_build_object('status', inputs->>'status', '_input', jsonb_build_object('project', sid, 'from', p.status, 'to', inputs->>'status'));

  when 'review.request' then
    select * into dl from leadflow_private.project_deliverables x where x.workspace_id = ws and x.id::text = sid;
    if dl.id is null then raise exception 'The deliverable no longer exists.' using errcode = 'P0002'; end if;
    select * into version_row from leadflow_private.deliverable_versions x where x.deliverable_id = dl.id order by x.number desc limit 1;
    if version_row.id is null then raise exception 'The deliverable has no version to send. Add a version first.' using errcode = '55000'; end if;
    perform public.request_deliverable_review(ws, dl.id, jsonb_strip_nulls(jsonb_build_object('versionId', version_row.id,
      'message', leadflow_private.automation_render(inputs->>'message', ctx, 2000),
      'dueDate', case when coalesce((inputs->>'dueInDays')::integer, 0) > 0 then today + (inputs->>'dueInDays')::integer end)), key);
    return jsonb_build_object('versionNumber', version_row.number, '_input', jsonb_build_object('deliverable', sid, 'version', version_row.number));

  else raise exception 'This action isn''t available.' using errcode = '22023';
  end case;
end $$;

-- ---------- Run bookkeeping ----------

create function leadflow_private.automation_step(r leadflow_private.automation_runs, node_id text, node jsonb, step_status text, attempt integer, step_result jsonb,
  step_input jsonb, step_output jsonb, code text, message text, started timestamptz) returns void language sql security definer set search_path = '' as $$
  insert into leadflow_private.automation_run_steps(workspace_id, run_id, sequence, node_id, node_type, action_type, label, status, attempt, result, input, output, error_code, error_message,
      started_at, completed_at)
    values (r.workspace_id, r.id, coalesce((select max(s.sequence) from leadflow_private.automation_run_steps s where s.run_id = r.id), 0) + 1, node_id, node->>'type', node->>'action',
      left(coalesce(nullif(node->>'label', ''), (select a->>'label' from jsonb_array_elements(leadflow_private.automation_action_list()) a where a->>'type' = node->>'action'),
        initcap(node->>'type')), 120), step_status, attempt, leadflow_private.automation_sanitize(step_result), leadflow_private.automation_sanitize(step_input),
      leadflow_private.automation_sanitize(step_output), code, left(leadflow_private.automation_redact(message), 500), coalesce(started, now()),
      case when step_status in ('waiting','retrying') then null else now() end)
$$;

-- Ends a run. A lost permission pauses the workflow with the reason, so it doesn't keep failing.
create function leadflow_private.automation_finish(run_id uuid, final_status text, final_outcome text, code text default null, summary text default null, node text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r leadflow_private.automation_runs;
begin
  update leadflow_private.automation_runs x set status = final_status, outcome = final_outcome, error_code = code, error_summary = left(leadflow_private.automation_redact(summary), 500),
    failed_node = node, completed_at = case when final_status in ('completed','failed','cancelled') then now() end, lease_id = null, lease_until = null,
    wait = null, updated_at = now()
    where x.id = run_id returning * into r;
  if r.mode = 'live' and final_status in ('completed','failed','cancelled') then
    perform leadflow_private.automation_count(r.workspace_id, r.workflow_id, jsonb_build_object('finished', 1,
      case final_status when 'completed' then 'succeeded' when 'failed' then 'failed' else 'cancelled' end, 1,
      'durationMs', greatest(0, floor(extract(epoch from (now() - coalesce(r.started_at, r.created_at))) * 1000))::bigint));
  elsif r.mode = 'live' and final_status = 'attention' then
    perform leadflow_private.automation_count(r.workspace_id, r.workflow_id, jsonb_build_object('failed', 1));
  end if;
  if code = 'authorization' and r.mode = 'live' then
    update leadflow_private.automation_workflows w set status = 'paused', attention_code = 'publisher_access', attention_at = now(),
      attention = 'Paused for safety: the member who published it no longer has the access its actions need. Republish it as an owner or admin.'
      where w.id = r.workflow_id and w.status = 'active';
  end if;
end $$;

-- Retry delays: 1, 5, then 25 minutes.
create function leadflow_private.automation_backoff(attempt integer) returns interval language sql immutable set search_path = '' as $$
  select make_interval(mins => (power(5, greatest(attempt - 1, 0)))::integer)
$$;

-- ---------- The run loop ----------

-- Claims one due run (or the given one) and executes its steps until it finishes, waits, or has run 10 steps in this call.
-- Workspaces are served in turn and run at most 3 at a time, so one workspace can't hold up the others. Each action runs in
-- its own subtransaction: its side effects and its step record commit together, or neither does. Returns what happened,
-- or { external } when the next step (an AI draft) runs in the Edge worker. limits: provider limits from the worker.
create function public.automation_advance(target_run uuid default null, limits jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r leadflow_private.automation_runs; v leadflow_private.automation_versions; wf leadflow_private.automation_workflows; ws uuid; lim jsonb := leadflow_private.automation_limits();
  today date; node jsonb; node_id text; steps integer := 0; matched boolean; chosen jsonb; c jsonb; resume timestamptz; def jsonb; output jsonb; err_state text; err_message text;
  class text; started timestamptz; prev_sub text := current_setting('request.jwt.claim.sub', true); prev_claims text := current_setting('request.jwt.claims', true); attempt integer;
  subject_id text; wait_def jsonb; lease uuid; outcome text := 'progressed'; summary jsonb;
begin
  if target_run is not null then
    select x.* into r from leadflow_private.automation_runs x join leadflow_private.automation_workflows w on w.id = x.workflow_id
      where x.id = target_run and x.status in ('queued','waiting') and x.next_run_at <= now() and (x.mode = 'test' or w.status = 'active') for update of x skip locked;
  else
    for ws in select x.workspace_id from leadflow_private.automation_runs x left join leadflow_private.automation_settings s on s.workspace_id = x.workspace_id
        where x.status in ('queued','waiting') and x.next_run_at <= now() and not coalesce(s.paused, false)
        group by x.workspace_id, s.served_at order by s.served_at nulls first limit 10 loop
      continue when (select count(*) from leadflow_private.automation_runs y where y.workspace_id = ws and y.status = 'running') >= (lim->>'concurrentRunsPerWorkspace')::integer;
      select x.* into r from leadflow_private.automation_runs x join leadflow_private.automation_workflows w on w.id = x.workflow_id
        where x.workspace_id = ws and x.status in ('queued','waiting') and x.next_run_at <= now() and (x.mode = 'test' or w.status = 'active')
        order by x.next_run_at, x.created_at limit 1 for update of x skip locked;
      exit when r.id is not null;
    end loop;
  end if;
  if r.id is null then return null; end if;
  insert into leadflow_private.automation_settings(workspace_id, served_at) values (r.workspace_id, now())
    on conflict (workspace_id) do update set served_at = excluded.served_at;
  begin
  select * into v from leadflow_private.automation_versions x where x.id = r.version_id;
  select * into wf from leadflow_private.automation_workflows x where x.id = r.workflow_id;
  today := leadflow_private.project_today(r.workspace_id);
  -- Events this run's actions cause carry the chain, so they can't start this workflow again (read by automation_emit,
  -- also by capture triggers that fire at commit).
  perform set_config('leadflow.automation_chain', (r.chain || r.workflow_id)::text, true);
  r.context := jsonb_set(r.context, '{run}', coalesce(r.context->'run', '{}') || jsonb_build_object('date', today));

  if r.created_at < now() - make_interval(days => (lim->>'maxRunDays')::integer) then
    perform leadflow_private.automation_finish(r.id, 'failed', 'timed_out', 'timed_out', format('Stopped: runs may take at most %s days, including waits.', lim->>'maxRunDays'), r.current_node);
    return jsonb_build_object('runId', r.id, 'outcome', 'timed_out');
  end if;
  update leadflow_private.automation_runs x set status = 'running', started_at = coalesce(x.started_at, now()), updated_at = now() where x.id = r.id;

  -- A delay that ended, or an event wait that was answered or timed out.
  if r.wait is not null then
    node_id := r.wait->>'node'; node := v.compiled->'nodes'->node_id;
    if r.wait->>'kind' = 'delay' then
      update leadflow_private.automation_run_steps s set status = 'completed', completed_at = now() where s.run_id = r.id and s.node_id = (r.wait->>'node') and s.status = 'waiting';
    elsif r.wait ? 'arrived' then
      update leadflow_private.automation_run_steps s set status = 'completed', completed_at = now(), result = coalesce(s.result, '{}') || jsonb_build_object('received', true, 'eventId', r.wait->>'arrived')
        where s.run_id = r.id and s.node_id = (r.wait->>'node') and s.status = 'waiting';
      r.current_node := node->>'next';
    else
      update leadflow_private.automation_run_steps s set status = 'completed', completed_at = now(), result = coalesce(s.result, '{}') || jsonb_build_object('received', false, 'timedOut', true)
        where s.run_id = r.id and s.node_id = (r.wait->>'node') and s.status = 'waiting';
      if node->>'onTimeout' = 'continue' then
        r.context := jsonb_set(r.context, array['steps', node_id], jsonb_build_object('received', false));
        r.current_node := node->>'next';
      else
        update leadflow_private.automation_runs x set context = r.context, wait = null where x.id = r.id;
        perform leadflow_private.automation_finish(r.id, 'completed', 'wait_timed_out');
        return jsonb_build_object('runId', r.id, 'outcome', 'wait_timed_out');
      end if;
    end if;
    r.wait := null;
  end if;

  loop
    update leadflow_private.automation_runs x set context = r.context, current_node = r.current_node, attempts = r.attempts, steps_executed = r.steps_executed, wait = null, updated_at = now()
      where x.id = r.id;
    if r.current_node is null then perform leadflow_private.automation_finish(r.id, 'completed', 'completed'); outcome := 'completed'; exit; end if;
    if steps >= (lim->>'stepsPerAdvance')::integer then
      update leadflow_private.automation_runs x set status = 'queued', next_run_at = now() where x.id = r.id; outcome := 'yielded'; exit;
    end if;
    if r.steps_executed >= (lim->>'maxStepsPerRun')::integer then
      perform leadflow_private.automation_finish(r.id, 'failed', 'step_limit', 'step_limit', 'Stopped: a run may execute at most 100 steps.', r.current_node); outcome := 'failed'; exit;
    end if;
    node_id := r.current_node; node := v.compiled->'nodes'->node_id;
    if node is null then
      perform leadflow_private.automation_finish(r.id, 'attention', 'invalid_definition', 'invalid_definition', 'The published version refers to a step that doesn''t exist. Republish the workflow.', node_id);
      outcome := 'attention'; exit;
    end if;
    steps := steps + 1; r.steps_executed := r.steps_executed + 1; started := clock_timestamp();

    case node->>'type'
    when 'condition' then
      begin matched := leadflow_private.automation_eval_group(node->'when', r.context, today);
      exception when others then matched := null; end;
      if matched is null then
        perform leadflow_private.automation_step(r, node_id, node, 'failed', 1, null, null, null, 'condition_error', 'The conditions couldn''t be evaluated.', started);
        perform leadflow_private.automation_finish(r.id, 'attention', 'condition_error', 'condition_error', 'The conditions couldn''t be evaluated. Check and republish the workflow.', node_id);
        outcome := 'attention'; exit;
      end if;
      perform leadflow_private.automation_step(r, node_id, node, 'completed', 1, jsonb_build_object('matched', matched), null, null, null, null, started);
      if not matched then
        update leadflow_private.automation_runs x set steps_executed = r.steps_executed where x.id = r.id;
        perform leadflow_private.automation_finish(r.id, 'completed', 'condition_not_met'); outcome := 'completed'; exit;
      end if;
      r.current_node := node->>'next';

    when 'branch' then
      chosen := null;
      begin
        for c in select value from jsonb_array_elements(node->'cases') loop
          if leadflow_private.automation_eval_group(c->'when', r.context, today) then chosen := c; exit; end if;
        end loop;
      exception when others then
        perform leadflow_private.automation_step(r, node_id, node, 'failed', 1, null, null, null, 'condition_error', 'The branch conditions couldn''t be evaluated.', started);
        perform leadflow_private.automation_finish(r.id, 'attention', 'condition_error', 'condition_error', 'The branch conditions couldn''t be evaluated. Check and republish the workflow.', node_id);
        outcome := 'attention'; exit;
      end;
      perform leadflow_private.automation_step(r, node_id, node, 'completed', 1,
        jsonb_build_object('path', coalesce(chosen->>'id', 'otherwise'), 'label', coalesce(chosen->>'label', 'Otherwise')), null, null, null, null, started);
      r.current_node := case when chosen is not null then chosen->>'next' else node->>'otherwise' end;

    when 'delay' then
      resume := case when node->>'mode' = 'until' then (node->>'until')::timestamptz
        else now() + (node->>'amount')::integer * case node->>'unit' when 'minutes' then interval '1 minute' when 'hours' then interval '1 hour' else interval '1 day' end end;
      resume := greatest(resume, now());
      perform leadflow_private.automation_step(r, node_id, node, 'waiting', 1, jsonb_build_object('resumeAt', resume), null, null, null, null, started);
      update leadflow_private.automation_runs x set status = 'waiting', next_run_at = resume, current_node = node->>'next', steps_executed = r.steps_executed, context = r.context,
        wait = jsonb_build_object('kind', 'delay', 'node', node_id, 'until', resume), updated_at = now() where x.id = r.id;
      outcome := 'waiting'; exit;

    when 'wait' then
      wait_def := leadflow_private.automation_wait_def(node->>'event');
      subject_id := leadflow_private.automation_value(r.context, node->>'subject') #>> '{}';
      if wait_def is null or subject_id is null or subject_id = '' then
        perform leadflow_private.automation_step(r, node_id, node, 'failed', 1, null, null, null, 'missing_subject', 'The record to wait for isn''t available in this run.', started);
        perform leadflow_private.automation_finish(r.id, 'failed', 'missing_subject', 'missing_subject', 'The record to wait for isn''t available in this run.', node_id);
        outcome := 'failed'; exit;
      end if;
      resume := now() + (node->'timeout'->>'amount')::integer * case node->'timeout'->>'unit' when 'hours' then interval '1 hour' else interval '1 day' end;
      if node->>'event' like 'task.%' then perform leadflow_private.automation_track(r.workspace_id, 'task'); end if;
      perform leadflow_private.automation_step(r, node_id, node, 'waiting', 1, jsonb_build_object('event', node->>'event', 'until', resume), null, null, null, null, started);
      update leadflow_private.automation_runs x set status = 'waiting', next_run_at = resume, steps_executed = r.steps_executed, context = r.context,
        wait = jsonb_build_object('kind', 'event', 'node', node_id, 'event', node->>'event', 'key', (wait_def->>'entity') || ':' || subject_id, 'until', resume, 'onTimeout', node->>'onTimeout'),
        updated_at = now() where x.id = r.id;
      outcome := 'waiting'; exit;

    when 'action' then
      def := leadflow_private.automation_action_def(node->>'action');
      attempt := r.attempts + 1;
      if coalesce((def->>'ai')::boolean, false) then
        -- AI steps leave the transaction: check access now, lease the run, and let the Edge worker call the model.
        begin
          perform leadflow_private.automation_impersonate(v.published_by);
          if v.published_by is null then raise exception 'No publisher.' using errcode = '42501'; end if;
          perform leadflow_private.require_role(r.workspace_id, array(select jsonb_array_elements_text(def->'roles')), false);
          perform set_config('request.jwt.claim.sub', coalesce(prev_sub, ''), true); perform set_config('request.jwt.claims', coalesce(prev_claims, ''), true);
        exception when others then
          get stacked diagnostics err_state = returned_sqlstate, err_message = message_text;
          perform leadflow_private.automation_step(r, node_id, node, 'failed', attempt, null, null, null, 'authorization', err_message, started);
          perform leadflow_private.automation_finish(r.id, 'attention', 'authorization', 'authorization', err_message, node_id);
          outcome := 'attention'; exit;
        end;
        lease := gen_random_uuid();
        update leadflow_private.automation_runs x set status = 'running', lease_id = lease, lease_until = now() + interval '5 minutes', attempts = attempt, current_node = node_id,
          steps_executed = r.steps_executed, context = r.context, updated_at = now() where x.id = r.id;
        return jsonb_build_object('runId', r.id, 'outcome', 'external', 'external', jsonb_build_object('runId', r.id, 'lease', lease, 'node', node_id, 'action', node->>'action',
          'workspaceId', r.workspace_id, 'actor', v.published_by, 'requestId', leadflow_private.automation_key(r.id, node_id),
          'leadId', leadflow_private.automation_value(r.context, node->'inputs'->>'subject') #>> '{}', 'inputs', (node->'inputs') - 'subject'));
      end if;
      begin
        output := leadflow_private.automation_execute(r, v, wf.name, node, node_id, today, limits);
        perform set_config('request.jwt.claim.sub', coalesce(prev_sub, ''), true); perform set_config('request.jwt.claims', coalesce(prev_claims, ''), true);
      exception when others then
        get stacked diagnostics err_state = returned_sqlstate, err_message = message_text;
        class := leadflow_private.automation_classify(err_state);
        summary := leadflow_private.automation_input_summary(def, node->'inputs', r.context, today);
        if class = 'transient' and attempt <= coalesce((def->>'retries')::integer, 3) then
          perform leadflow_private.automation_step(r, node_id, node, 'retrying', attempt, null, summary, null, 'transient', err_message, started);
          update leadflow_private.automation_runs x set status = 'queued', attempts = attempt, next_run_at = now() + leadflow_private.automation_backoff(attempt),
            steps_executed = r.steps_executed, error_summary = left(leadflow_private.automation_redact(err_message), 500), updated_at = now() where x.id = r.id;
          outcome := 'retrying'; exit;
        end if;
        perform leadflow_private.automation_step(r, node_id, node, 'failed', attempt, null, summary, null, class, err_message, started);
        update leadflow_private.automation_runs x set steps_executed = r.steps_executed, attempts = attempt where x.id = r.id;
        perform leadflow_private.automation_finish(r.id, case when class = 'invalid' and err_state not in ('P0002','55000','22023') then 'attention' when class = 'authorization' then 'attention' else 'failed' end,
          case when class = 'transient' then 'retries_exhausted' else class end, class, err_message, node_id);
        outcome := 'failed'; exit;
      end;
      perform leadflow_private.automation_step(r, node_id, node, coalesce(output->>'_status', 'completed'), attempt, case when output ? 'reason' then jsonb_build_object('reason', output->>'reason') end,
        output->'_input', output - '_status' - '_input' - 'reason', null, null, started);
      r.context := jsonb_set(r.context, array['steps', node_id], output - '_status' - '_input' - 'reason');
      r.attempts := 0;
      r.current_node := node->>'next';
      if r.mode = 'live' then
        perform leadflow_private.automation_count(r.workspace_id, r.workflow_id, jsonb_build_object('actions', 1, 'emailActions', case when coalesce((output->>'emailed')::integer, 0) > 0 then 1 else 0 end));
      end if;
    else
      perform leadflow_private.automation_finish(r.id, 'attention', 'invalid_definition', 'invalid_definition', 'Unknown step type. Republish the workflow.', node_id);
      outcome := 'attention'; exit;
    end case;
  end loop;
  return jsonb_build_object('runId', r.id, 'outcome', outcome, 'steps', steps);
  exception when others then
    -- An unexpected engine error: everything this call did is undone and the run waits for a person instead of looping.
    get stacked diagnostics err_state = returned_sqlstate, err_message = message_text;
    perform set_config('request.jwt.claim.sub', coalesce(prev_sub, ''), true); perform set_config('request.jwt.claims', coalesce(prev_claims, ''), true);
    perform leadflow_private.automation_finish(r.id, 'attention', 'engine_error', 'engine_error', 'Unexpected error (' || err_state || '): ' || err_message, r.current_node);
    return jsonb_build_object('runId', r.id, 'outcome', 'attention', 'error', err_state);
  end;
end $$;

-- Finishes an AI step the Edge worker ran. outcome: { ok: true, existingDraftId } or { ok: true, draft, usage } (saved here, as
-- the publisher, with the step's request ID) or { ok: false, transient, code, message }. A stale lease changes nothing.
create function public.automation_complete_external(run_id uuid, lease uuid, outcome jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r leadflow_private.automation_runs; v leadflow_private.automation_versions; node jsonb; node_id text; def jsonb; saved jsonb; output jsonb; err_state text; err_message text;
  attempt integer; lead_id text; started timestamptz := now();
begin
  select * into r from leadflow_private.automation_runs x where x.id = run_id for update;
  if r.id is null or r.status <> 'running' or r.lease_id is distinct from lease then return jsonb_build_object('stale', true); end if;
  select * into v from leadflow_private.automation_versions x where x.id = r.version_id;
  node_id := r.current_node; node := v.compiled->'nodes'->node_id; def := leadflow_private.automation_action_def(node->>'action'); attempt := r.attempts;
  perform set_config('leadflow.automation_chain', (r.chain || r.workflow_id)::text, true);
  lead_id := leadflow_private.automation_value(r.context, node->'inputs'->>'subject') #>> '{}';
  if coalesce((outcome->>'ok')::boolean, false) then
    begin
      if outcome ? 'existingDraftId' then
        output := jsonb_build_object('draftId', outcome->>'existingDraftId');
      else
        saved := public.save_generated_draft(r.workspace_id, v.published_by, lead_id, leadflow_private.automation_key(r.id, node_id), null, null, false, outcome->'draft', coalesce(outcome->'usage', '[]'));
        output := jsonb_build_object('draftId', saved->>'id');
      end if;
    exception when others then
      get stacked diagnostics err_state = returned_sqlstate, err_message = message_text;
      outcome := jsonb_build_object('ok', false, 'transient', leadflow_private.automation_classify(err_state) = 'transient', 'code', 'save_failed', 'message', err_message);
    end;
  end if;
  if output is not null then
    perform leadflow_private.automation_step(r, node_id, node, 'completed', attempt, null, jsonb_build_object('lead', lead_id, 'channel', node->'inputs'->>'channel', 'angle', node->'inputs'->>'angle'),
      output, null, null, started);
    update leadflow_private.automation_runs x set status = 'queued', next_run_at = now(), lease_id = null, lease_until = null, attempts = 0, current_node = node->>'next',
      context = jsonb_set(x.context, array['steps', node_id], output), updated_at = now() where x.id = r.id;
    if r.mode = 'live' then perform leadflow_private.automation_count(r.workspace_id, r.workflow_id, jsonb_build_object('actions', 1, 'aiActions', 1)); end if;
    return jsonb_build_object('runId', r.id, 'outcome', 'completed', 'output', output);
  end if;
  if coalesce((outcome->>'transient')::boolean, false) and attempt <= coalesce((def->>'retries')::integer, 2) then
    perform leadflow_private.automation_step(r, node_id, node, 'retrying', attempt, null, null, null, 'transient', coalesce(outcome->>'message', 'The AI service failed.'), started);
    update leadflow_private.automation_runs x set status = 'queued', next_run_at = now() + leadflow_private.automation_backoff(attempt), lease_id = null, lease_until = null, updated_at = now() where x.id = r.id;
    return jsonb_build_object('runId', r.id, 'outcome', 'retrying');
  end if;
  perform leadflow_private.automation_step(r, node_id, node, 'failed', attempt, null, null, null, left(coalesce(outcome->>'code', 'failed'), 40), coalesce(outcome->>'message', 'The AI step failed.'), started);
  perform leadflow_private.automation_finish(r.id, case when outcome->>'code' in ('not_configured','limit') then 'attention' else 'failed' end, 'ai_failed',
    case when outcome->>'code' ~ '^[a-z_]{1,40}$' then outcome->>'code' else 'ai_failed' end, coalesce(outcome->>'message', 'The AI step failed.'), node_id);
  return jsonb_build_object('runId', r.id, 'outcome', 'failed');
end $$;

-- ---------- Scheduled work ----------

-- Called by the worker before advancing runs: re-queues runs whose lease expired (their worker stopped), fires due
-- schedules and scheduled checks (each check fires once per record and window), and trims old events and runs.
create function public.automation_tick() returns jsonb language plpgsql security definer set search_path = '' as $$
declare w leadflow_private.automation_workflows; v leadflow_private.automation_versions; zone text; today date; fired integer := 0; scanned integer := 0; released integer; days integer;
  t public.follow_up_tasks; p leadflow_private.projects; m leadflow_private.project_milestones; d leadflow_private.deals; next_time timestamptz; lim jsonb := leadflow_private.automation_limits();
begin
  update leadflow_private.automation_runs x set status = 'queued', lease_id = null, lease_until = null, next_run_at = now(), updated_at = now()
    where x.status = 'running' and x.lease_until is not null and x.lease_until < now();
  get diagnostics released = row_count;

  for w in select x.* from leadflow_private.automation_workflows x where x.status = 'active' and x.next_fire_at is not null and x.next_fire_at <= now()
      and not exists (select 1 from leadflow_private.automation_settings s where s.workspace_id = x.workspace_id and s.paused)
      order by x.next_fire_at limit 50 for update skip locked loop
    select * into v from leadflow_private.automation_versions x where x.id = w.published_version_id;
    select coalesce((select s.timezone from public.workspace_settings s where s.workspace_id = w.workspace_id), 'UTC') into zone;
    today := leadflow_private.project_today(w.workspace_id);
    days := coalesce((v.definition->'trigger'->'config'->>'days')::integer, 3);
    next_time := now() + interval '1 hour';
    case w.trigger_type
      when 'schedule.time' then
        perform leadflow_private.automation_emit(w.workspace_id, 'schedule.time', 'workflow', w.id::text, jsonb_build_object('schedule', jsonb_build_object('firedAt', w.next_fire_at,
          'date', (w.next_fire_at at time zone zone)::date, 'weekday', trim(to_char(w.next_fire_at at time zone zone, 'Day')))), '{}', 'schedule:' || w.id || ':' || w.next_fire_at, 'schedule', w.id);
        fired := fired + 1;
        next_time := leadflow_private.automation_next_fire(v.definition->'trigger'->'config', zone, greatest(now(), w.next_fire_at));
      when 'task.overdue' then
        for t in select x.* from public.follow_up_tasks x where x.workspace_id = w.workspace_id and not x.completed and not x.cancelled and x.due < today order by x.due limit 200 loop
          perform leadflow_private.automation_emit(w.workspace_id, 'task.overdue', 'task', t.id, jsonb_build_object('task', leadflow_private.automation_task_data(t), 'daysOverdue', today - t.due),
            leadflow_private.automation_task_keys(t), 'task.overdue:' || w.id || ':' || t.id || ':' || t.due, 'schedule', w.id);
          scanned := scanned + 1;
        end loop;
      when 'project.overdue' then
        for p in select x.* from leadflow_private.projects x where x.workspace_id = w.workspace_id and x.target_date < today and x.status not in ('completed','cancelled') order by x.target_date limit 200 loop
          perform leadflow_private.automation_emit(w.workspace_id, 'project.overdue', 'project', p.id::text, jsonb_build_object('project', leadflow_private.automation_project_data(p),
            'daysOverdue', today - p.target_date), array['project:' || p.id, 'client:' || p.client_id], 'project.overdue:' || w.id || ':' || p.id || ':' || p.target_date, 'schedule', w.id);
          scanned := scanned + 1;
        end loop;
      when 'milestone.due_soon' then
        for m in select x.* from leadflow_private.project_milestones x join leadflow_private.projects y on y.id = x.project_id where x.workspace_id = w.workspace_id
            and x.due_date between today and today + days and x.status not in ('completed','cancelled') and y.status not in ('completed','cancelled') order by x.due_date limit 200 loop
          perform leadflow_private.automation_emit(w.workspace_id, 'milestone.due_soon', 'milestone', m.id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(m.project_id),
            'milestone', leadflow_private.automation_milestone_data(m), 'daysUntilDue', m.due_date - today), array['milestone:' || m.id, 'project:' || m.project_id],
            'milestone.due_soon:' || w.id || ':' || m.id || ':' || m.due_date || ':' || days, 'schedule', w.id);
          scanned := scanned + 1;
        end loop;
      when 'milestone.overdue' then
        for m in select x.* from leadflow_private.project_milestones x join leadflow_private.projects y on y.id = x.project_id where x.workspace_id = w.workspace_id
            and x.due_date < today and x.status not in ('completed','cancelled') and y.status not in ('completed','cancelled') order by x.due_date limit 200 loop
          perform leadflow_private.automation_emit(w.workspace_id, 'milestone.overdue', 'milestone', m.id::text, jsonb_build_object('project', leadflow_private.automation_project_ref(m.project_id),
            'milestone', leadflow_private.automation_milestone_data(m), 'daysOverdue', today - m.due_date), array['milestone:' || m.id, 'project:' || m.project_id],
            'milestone.overdue:' || w.id || ':' || m.id || ':' || m.due_date, 'schedule', w.id);
          scanned := scanned + 1;
        end loop;
      when 'deal.close_approaching' then
        for d in select x.* from leadflow_private.deals x where x.workspace_id = w.workspace_id and x.outcome = 'open' and x.archived_at is null
            and x.expected_close_date between today and today + days order by x.expected_close_date limit 200 loop
          perform leadflow_private.automation_emit(w.workspace_id, 'deal.close_approaching', 'deal', d.id::text, jsonb_build_object('deal', leadflow_private.automation_deal_data(d),
            'daysUntilClose', d.expected_close_date - today), array['deal:' || d.id, 'lead:' || d.lead_id],
            'deal.close:' || w.id || ':' || d.id || ':' || d.expected_close_date || ':' || days, 'schedule', w.id);
          scanned := scanned + 1;
        end loop;
      else next_time := null;
    end case;
    update leadflow_private.automation_workflows x set next_fire_at = next_time where x.id = w.id;
  end loop;

  delete from leadflow_private.automation_events e where e.id in (select x.id from leadflow_private.automation_events x
    where x.occurred_at < now() - make_interval(days => (lim->>'eventRetentionDays')::integer) limit 1000);
  delete from leadflow_private.automation_runs r where r.id in (select x.id from leadflow_private.automation_runs x where x.status in ('completed','failed','cancelled')
    and x.created_at < now() - make_interval(days => (lim->>'runRetentionDays')::integer) limit 500);
  return jsonb_build_object('released', released, 'scheduled', fired, 'checked', scanned);
end $$;

-- ---------- Webhooks ----------

-- For the automation-webhook function: what it needs to verify a signature. Unknown and revoked endpoints look the same.
create function public.automation_webhook_lookup(webhook_id uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', h.id, 'version', h.secret_version, 'workspaceId', h.workspace_id) from leadflow_private.automation_webhooks h
  where h.id = webhook_id and h.status = 'active'
$$;
create function public.automation_webhook_rejected(webhook_id uuid) returns void language sql security definer set search_path = '' as $$
  update leadflow_private.automation_webhooks h set rejected_count = h.rejected_count + 1 where h.id = webhook_id
$$;

-- A verified webhook delivery. Only fields the workflow declares are kept, each checked against its type; the sender's
-- event ID makes a repeated delivery a duplicate instead of a second run.
create function public.automation_receive_webhook(webhook_id uuid, secret_version integer, event_id text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare h leadflow_private.automation_webhooks; w leadflow_private.automation_workflows; v leadflow_private.automation_versions; f jsonb; clean jsonb := '{}'; field_value jsonb; created uuid;
begin
  select * into h from leadflow_private.automation_webhooks x where x.id = webhook_id and x.status = 'active' for update;
  if h.id is null or h.secret_version <> automation_receive_webhook.secret_version then raise exception 'Unknown or revoked webhook.' using errcode = '28000'; end if;
  if coalesce(event_id, '') !~ '^[A-Za-z0-9._:-]{1,100}$' then raise exception 'eventId must be 1–100 letters, digits, dots, colons, dashes or underscores, unique per event.' using errcode = '22023'; end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then raise exception 'data must be a JSON object.' using errcode = '22023'; end if;
  select * into w from leadflow_private.automation_workflows x where x.id = h.workflow_id;
  if w.status <> 'active' or w.trigger_type <> 'webhook.received' then
    return jsonb_build_object('accepted', false, 'reason', 'The workflow isn''t active.');
  end if;
  select * into v from leadflow_private.automation_versions x where x.id = w.published_version_id;
  for f in select value from jsonb_array_elements(coalesce(v.definition->'trigger'->'config'->'fields', '[]')) loop
    field_value := payload->(f->>'key');
    if field_value is null or field_value = 'null'::jsonb then
      if coalesce((f->>'required')::boolean, false) then raise exception 'The field "%" is required.', f->>'key' using errcode = '22023'; end if;
      continue;
    end if;
    if (f->>'type' = 'text' and jsonb_typeof(field_value) <> 'string') or (f->>'type' = 'number' and jsonb_typeof(field_value) <> 'number')
        or (f->>'type' = 'boolean' and jsonb_typeof(field_value) <> 'boolean') or (f->>'type' = 'date' and (jsonb_typeof(field_value) <> 'string' or field_value #>> '{}' !~ '^\d{4}-\d{2}-\d{2}$')) then
      raise exception 'The field "%" must be %.', f->>'key', case f->>'type' when 'boolean' then 'true or false' when 'date' then 'a date (YYYY-MM-DD)' else 'a ' || (f->>'type') end using errcode = '22023';
    end if;
    clean := clean || jsonb_build_object(f->>'key', case when f->>'type' = 'text' then to_jsonb(left(field_value #>> '{}', 500)) else field_value end);
  end loop;
  update leadflow_private.automation_webhooks x set last_received_at = now(), received_count = x.received_count + 1 where x.id = h.id;
  created := leadflow_private.automation_emit(h.workspace_id, 'webhook.received', 'webhook', h.id::text, jsonb_build_object('webhook', jsonb_build_object('eventId', event_id), 'data', clean),
    array['webhook:' || h.id], 'webhook:' || h.id || ':' || event_id, 'webhook', w.id);
  return jsonb_build_object('accepted', true, 'duplicate', created is null, 'eventId', created);
end $$;

-- ---------- AI usage ----------

-- One AI workflow draft, counted in the existing AI usage ledger with its own monthly allowance.
create function public.automation_ai_reserve(target_workspace uuid, actor uuid, monthly_limit integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare used integer;
begin
  if not exists (select 1 from public.workspace_memberships m where m.workspace_id = target_workspace and m.user_id = actor and m.role in ('owner','admin')) then
    raise exception 'Only workspace owners and admins can draft workflows.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('automation_ai:' || target_workspace::text));
  select count(*) into used from leadflow_private.outreach_usage u where u.workspace_id = target_workspace and u.operation = 'automation_build' and u.unit = 'requests' and u.at >= date_trunc('month', now());
  if used >= greatest(coalesce(monthly_limit, 0), 0) then raise exception 'This workspace has used its % AI workflow drafts for this month.', monthly_limit using errcode = 'P0429'; end if;
  insert into leadflow_private.outreach_usage(workspace_id, provider, operation, quantity, unit, status, actor) values (target_workspace, 'gemini', 'automation_build', 1, 'requests', 'ok', actor);
  return greatest(coalesce(monthly_limit, 0), 0) - used - 1;
end $$;

-- ---------- Templates ----------

-- Starter workflows, built only from registered triggers and actions. Each is created as a draft for a person to review,
-- adjust and publish. Consequential steps arrive unconfirmed.
create function leadflow_private.automation_templates() returns jsonb language sql immutable set search_path = '' as $$
  select $json$[
  {"key":"lead_qualification","name":"Lead qualification","category":"Leads","description":"When a lead with a website is added, start its business report and tell owners and admins what it found.",
   "definition":{"trigger":{"type":"lead.created","config":{},"filter":null},"steps":[
     {"id":"n1","type":"condition","label":"Has a website","when":{"match":"all","conditions":[{"path":"trigger.lead.hasWebsite","op":"is_true"}]}},
     {"id":"n2","type":"action","action":"analysis.start","label":"Start business report","inputs":{"subject":"trigger.lead.id"}},
     {"id":"n3","type":"wait","label":"Wait for the report","event":"analysis.completed","subject":"trigger.lead.id","timeout":{"amount":1,"unit":"days"},"onTimeout":"stop"},
     {"id":"n4","type":"action","action":"notify.members","label":"Notify owners and admins","inputs":{"recipients":["admins"],"about":"trigger.lead.id",
       "title":"Business report ready: {{trigger.lead.name}}","body":"{{steps.n3.opportunityCount}} opportunities found. Top: {{steps.n3.topOpportunity}}","email":false}}]}},
  {"key":"qualified_follow_up","name":"Qualified lead follow-up","category":"Leads","description":"When a lead becomes Qualified, create a follow-up task due tomorrow and notify you.",
   "definition":{"trigger":{"type":"lead.status_changed","config":{},"filter":{"match":"all","conditions":[{"path":"trigger.lead.status","op":"equals","value":"Qualified"}]}},"steps":[
     {"id":"n1","type":"action","action":"task.create","label":"Create follow-up","inputs":{"subject":"trigger.lead.id","title":"Follow up with {{trigger.lead.name}}",
       "description":"{{trigger.lead.name}} was marked Qualified. Agree the next step.","due":{"mode":"days","days":1},"priority":"high","taskType":"follow_up","assignee":"publisher"}},
     {"id":"n2","type":"action","action":"notify.members","label":"Notify me","inputs":{"recipients":["publisher"],"about":"trigger.lead.id","title":"{{trigger.lead.name}} is qualified",
       "body":"A follow-up task is due {{steps.n1.dueDate}}.","email":false}}]}},
  {"key":"high_opportunity","name":"High-opportunity lead","category":"Contacts & outreach","description":"When a business report finds a high-priority opportunity, draft outreach with AI and create a task to review it. Nothing is sent.",
   "definition":{"trigger":{"type":"analysis.completed","config":{},"filter":{"match":"all","conditions":[{"path":"trigger.analysis.highPriorityOpportunities","op":"gte","value":"1"}]}},"steps":[
     {"id":"n1","type":"action","action":"outreach.generate_draft","label":"Draft outreach","inputs":{"subject":"trigger.lead.id","channel":"email","angle":"recommended"}},
     {"id":"n2","type":"action","action":"task.create","label":"Review the draft","inputs":{"subject":"trigger.lead.id","title":"Review the outreach draft for {{trigger.lead.name}}",
       "description":"Top opportunity: {{trigger.analysis.topOpportunity}}. Check every claim, then send it yourself and mark it as sent.","due":{"mode":"days","days":1},"priority":"medium","taskType":"email","assignee":"publisher"}}]}},
  {"key":"deal_won_onboarding","name":"Deal won → client onboarding","category":"Sales","description":"When a deal is won, give its owner a task to convert it to a client (Convert to client keeps its review of contacts and services) and tell owners and admins.",
   "definition":{"trigger":{"type":"deal.won","config":{},"filter":null},"steps":[
     {"id":"n1","type":"action","action":"task.create","label":"Conversion task","inputs":{"subject":"trigger.deal.id","title":"Convert {{trigger.deal.title}} to a client and start onboarding",
       "description":"Open the deal and choose Convert to client to review its contacts and services, then start onboarding.","due":{"mode":"days","days":0},"priority":"high","taskType":"internal","assignee":"record_owner"}},
     {"id":"n2","type":"action","action":"notify.members","label":"Notify the team","inputs":{"recipients":["admins","record_owner"],"about":"trigger.deal.id","title":"Won: {{trigger.deal.title}}",
       "body":"Convert it to a client to start onboarding.","email":false}}]}},
  {"key":"client_onboarding","name":"New client → start onboarding","category":"Clients & onboarding","description":"When a client is created without an onboarding checklist, start one and tell its owner. Skipped when the conversion already started onboarding.",
   "definition":{"trigger":{"type":"client.created","config":{},"filter":{"match":"all","conditions":[{"path":"trigger.client.hasOnboarding","op":"is_false"}]}},"steps":[
     {"id":"n1","type":"action","action":"onboarding.start","label":"Start onboarding","inputs":{"subject":"trigger.client.id"}},
     {"id":"n2","type":"action","action":"notify.members","label":"Notify the owner","inputs":{"recipients":["record_owner"],"about":"trigger.client.id","title":"Onboarding started for {{trigger.client.name}}",
       "body":"Review the checklist, then share the client link yourself.","email":false}}]}},
  {"key":"onboarding_project","name":"Onboarding completed → project setup","category":"Clients & onboarding","description":"When onboarding is completed with confirmed services, create the project from the handoff (once) and tell its owner.",
   "definition":{"trigger":{"type":"onboarding.completed","config":{},"filter":{"match":"all","conditions":[{"path":"trigger.completion.confirmedServices","op":"gte","value":"1"},{"path":"trigger.hasProject","op":"is_false"}]}},"steps":[
     {"id":"n1","type":"action","action":"project.create_from_onboarding","label":"Create the project","inputs":{"subject":"trigger.client.id","name":"{{trigger.client.name}} delivery","owner":"record_owner"}},
     {"id":"n2","type":"action","action":"notify.members","label":"Notify the project owner","inputs":{"recipients":["record_owner"],"about":"steps.n1.projectId","title":"Project created for {{trigger.client.name}}",
       "body":"Review the brief and plan before work starts.","email":false}}]}},
  {"key":"deadline_reminder","name":"Project deadline reminder","category":"Projects","description":"Checked every hour: when a milestone is due within 3 days, remind the project owner once per milestone and due date.",
   "definition":{"trigger":{"type":"milestone.due_soon","config":{"days":3},"filter":null},"steps":[
     {"id":"n1","type":"action","action":"notify.members","label":"Remind the project owner","inputs":{"recipients":["record_owner"],"about":"trigger.project.id",
       "title":"Due in {{trigger.daysUntilDue}} days: {{trigger.milestone.name}}","body":"{{trigger.project.name}} · milestone due {{trigger.milestone.dueDate}}","email":true}}]}},
  {"key":"deliverable_review","name":"Deliverable review","category":"Client collaboration","description":"When a deliverable is marked Ready for client review on a shared project, send its latest version to the client (who is notified on the portal). Needs your confirmation before publishing.",
   "definition":{"trigger":{"type":"deliverable.status_changed","config":{},"filter":{"match":"all","conditions":[{"path":"trigger.deliverable.status","op":"equals","value":"ready_for_review"},{"path":"trigger.project.portalShared","op":"is_true"}]}},"steps":[
     {"id":"n1","type":"action","action":"review.request","label":"Request client review","inputs":{"subject":"trigger.deliverable.id","message":"{{trigger.deliverable.title}} is ready for your review.","dueInDays":5,"confirm":false}},
     {"id":"n2","type":"action","action":"notify.members","label":"Notify the owner","inputs":{"recipients":["record_owner"],"about":"trigger.deliverable.id","title":"Sent for client review: {{trigger.deliverable.title}}",
       "body":"Version {{steps.n1.versionNumber}} · the client was notified on the portal.","email":false}}]}},
  {"key":"revision_request","name":"Client revision request","category":"Client collaboration","description":"When a client asks for changes, create a revision task for the deliverable's owner and notify them.",
   "definition":{"trigger":{"type":"deliverable.changes_requested","config":{},"filter":null},"steps":[
     {"id":"n1","type":"action","action":"task.create","label":"Revision task","inputs":{"subject":"trigger.deliverable.id","title":"Revise {{trigger.deliverable.title}}",
       "description":"The client requested changes to version {{trigger.decision.versionNumber}} ({{trigger.decision.feedbackItems}} feedback items). Open the review to see them.","due":{"mode":"days","days":2},"priority":"high","taskType":"delivery","assignee":"record_owner"}},
     {"id":"n2","type":"action","action":"notify.members","label":"Notify the owner","inputs":{"recipients":["record_owner"],"about":"trigger.deliverable.id","title":"Changes requested: {{trigger.deliverable.title}}",
       "body":"{{trigger.project.name}} · a revision task is due {{steps.n1.dueDate}}.","email":true}}]}},
  {"key":"deliverable_approved","name":"Deliverable approved","category":"Client collaboration","description":"When a client approves a deliverable, notify the project owner and mark the deliverable complete internally. The project itself is never completed automatically.",
   "definition":{"trigger":{"type":"deliverable.approved","config":{},"filter":null},"steps":[
     {"id":"n1","type":"action","action":"notify.members","label":"Notify the project owner","inputs":{"recipients":["record_owner"],"about":"trigger.project.id","title":"Approved: {{trigger.deliverable.title}}",
       "body":"{{trigger.project.name}} · version {{trigger.decision.versionNumber}}","email":false}},
     {"id":"n2","type":"condition","label":"Not complete yet","when":{"match":"all","conditions":[{"path":"trigger.deliverable.status","op":"not_equals","value":"completed"}]}},
     {"id":"n3","type":"action","action":"deliverable.set_status","label":"Mark the deliverable complete","inputs":{"subject":"trigger.deliverable.id","status":"completed"}}]}},
  {"key":"project_overdue","name":"Project overdue","category":"Projects","description":"Checked every hour: when a project passes its target date without being completed, notify its owner and create a review task (once per target date).",
   "definition":{"trigger":{"type":"project.overdue","config":{},"filter":null},"steps":[
     {"id":"n1","type":"action","action":"notify.members","label":"Notify the project owner","inputs":{"recipients":["record_owner"],"about":"trigger.project.id","title":"Overdue: {{trigger.project.name}}",
       "body":"The target date {{trigger.project.targetDate}} passed {{trigger.daysOverdue}} days ago.","email":true}},
     {"id":"n2","type":"action","action":"task.create","label":"Schedule review task","inputs":{"subject":"trigger.project.id","title":"Review the schedule of {{trigger.project.name}}",
       "description":"The project passed its target date. Agree a new date or scope with the client.","due":{"mode":"days","days":1},"priority":"high","taskType":"internal","assignee":"record_owner"}}]}},
  {"key":"feedback_triage","name":"Client feedback triage","category":"Client collaboration","description":"Route client feedback by category: design changes, technical issues, and everything else each get their own task.",
   "definition":{"trigger":{"type":"feedback.submitted","config":{},"filter":null},"steps":[
     {"id":"n1","type":"branch","label":"Feedback category","cases":[
        {"id":"b1","label":"Design change","when":{"match":"all","conditions":[{"path":"trigger.feedback.category","op":"equals","value":"design"}]},"steps":[
          {"id":"n2","type":"action","action":"task.create","label":"Design revision task","inputs":{"subject":"trigger.deliverable.id","title":"Design revision: {{trigger.feedback.title}}",
            "description":"Client design feedback on {{trigger.deliverable.title}}.","due":{"mode":"days","days":2},"priority":"medium","taskType":"delivery","assignee":"record_owner"}}]},
        {"id":"b2","label":"Technical issue","when":{"match":"all","conditions":[{"path":"trigger.feedback.category","op":"in","value":["technical","functional"]}]},"steps":[
          {"id":"n3","type":"action","action":"task.create","label":"Technical investigation task","inputs":{"subject":"trigger.deliverable.id","title":"Investigate: {{trigger.feedback.title}}",
            "description":"Client reported a technical issue on {{trigger.deliverable.title}}.","due":{"mode":"days","days":1},"priority":"high","taskType":"delivery","assignee":"record_owner"}}]}],
      "otherwise":{"steps":[
          {"id":"n4","type":"action","action":"task.create","label":"General review task","inputs":{"subject":"trigger.deliverable.id","title":"Review feedback: {{trigger.feedback.title}}",
            "description":"Client feedback on {{trigger.deliverable.title}}.","due":{"mode":"days","days":2},"priority":"medium","taskType":"delivery","assignee":"record_owner"}}]}},
     {"id":"n5","type":"action","action":"notify.members","label":"Notify the owner","inputs":{"recipients":["record_owner"],"about":"trigger.deliverable.id","title":"Feedback on {{trigger.deliverable.title}}",
       "body":"{{trigger.feedback.title}} ({{trigger.feedback.category}})","email":false}}]}}
  ]$json$::jsonb
$$;

-- ---------- Member functions ----------

create function leadflow_private.automation_workflow_json(w leadflow_private.automation_workflows) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', w.id, 'name', w.name, 'description', w.description, 'status', w.status, 'version', w.version, 'draftChanged', w.draft_changed,
    'triggerType', coalesce(w.trigger_type, w.definition->'trigger'->>'type'), 'draftTriggerType', w.definition->'trigger'->>'type',
    'publishedVersion', (select x.number from leadflow_private.automation_versions x where x.id = w.published_version_id),
    'attention', case when w.attention_code is null then null else jsonb_build_object('code', w.attention_code, 'message', w.attention, 'at', w.attention_at) end,
    'nextFireAt', w.next_fire_at, 'templateKey', w.template_key, 'createdAt', w.created_at, 'updatedAt', w.updated_at, 'activatedAt', w.activated_at,
    'stepCount', (select count(*) from jsonb_path_query(w.definition, 'strict $.**.type') t where t #>> '{}' in ('condition','branch','action','delay','wait')),
    'lastRun', (select jsonb_build_object('id', r.id, 'status', r.status, 'outcome', r.outcome, 'at', r.created_at) from leadflow_private.automation_runs r
      where r.workflow_id = w.id and r.mode = 'live' order by r.created_at desc limit 1),
    'stats', (select jsonb_build_object('runs', coalesce(sum(u.runs), 0), 'succeeded', coalesce(sum(u.succeeded), 0), 'failed', coalesce(sum(u.failed), 0), 'finished', coalesce(sum(u.finished), 0),
        'actions', coalesce(sum(u.actions), 0), 'throttled', coalesce(sum(u.throttled), 0), 'blocked', coalesce(sum(u.blocked), 0))
      from leadflow_private.automation_usage_daily u where u.workflow_id = w.id and u.day >= leadflow_private.project_today(w.workspace_id) - 29))
$$;

create function leadflow_private.automation_lock(target_workspace uuid, target_workflow uuid, expected_version integer) returns leadflow_private.automation_workflows
language plpgsql security definer set search_path = '' as $$
declare w leadflow_private.automation_workflows;
begin
  select * into w from leadflow_private.automation_workflows x where x.id = target_workflow and x.workspace_id = target_workspace for update;
  if w.id is null then raise exception 'Workflow not found in this workspace.' using errcode = 'P0002'; end if;
  if expected_version is not null and w.version <> expected_version then
    raise exception 'This workflow was changed in another window. Reload it and try again.' using errcode = '40001';
  end if;
  return w;
end $$;

-- Everything the Automation Center needs to start: the registry, templates, the caller's role and choices for settings.
create function public.automation_center_for(target_workspace uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare role text := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
begin
  if not exists (select 1 from leadflow_private.sales_stages s where s.workspace_id = target_workspace) and role in ('owner','admin') then
    perform leadflow_private.ensure_sales_setup(target_workspace);
  end if;
  return jsonb_build_object('role', role, 'catalog', leadflow_private.automation_catalog(),
    'templates', (select jsonb_agg(t - 'definition' || jsonb_build_object('trigger', t->'definition'->'trigger'->>'type', 'definition', t->'definition')) from jsonb_array_elements(leadflow_private.automation_templates()) t),
    'settings', coalesce((select jsonb_build_object('paused', s.paused, 'reason', s.paused_reason, 'updatedAt', s.updated_at) from leadflow_private.automation_settings s where s.workspace_id = target_workspace),
      jsonb_build_object('paused', false, 'reason', '')),
    'timezone', coalesce((select s.timezone from public.workspace_settings s where s.workspace_id = target_workspace), 'UTC'),
    'lookups', jsonb_build_object(
      'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', leadflow_private.member_label(m.user_id), 'role', m.role) order by m.role, m.user_id)
        from public.workspace_memberships m where m.workspace_id = target_workspace), '[]'),
      'stages', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'category', s.category) order by s.position) from leadflow_private.sales_stages s
        where s.workspace_id = target_workspace and s.archived_at is null), '[]'),
      'onboardingTemplates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name) from leadflow_private.onboarding_templates t
        where t.workspace_id = target_workspace and not t.archived), '[]'),
      'projectTemplates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name) from leadflow_private.project_templates t
        where t.workspace_id = target_workspace and not t.archived), '[]')));
end $$;

-- Real numbers only: live runs (live tests are counted apart), from the daily counters and the run table.
create function public.automation_overview_for(target_workspace uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare today date := leadflow_private.project_today(target_workspace);
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return jsonb_build_object('today', today,
    'workflows', (select jsonb_build_object('total', count(*) filter (where w.status <> 'archived'), 'active', count(*) filter (where w.status = 'active'),
      'paused', count(*) filter (where w.status = 'paused'), 'draft', count(*) filter (where w.status = 'draft'), 'archived', count(*) filter (where w.status = 'archived'))
      from leadflow_private.automation_workflows w where w.workspace_id = target_workspace),
    'today_runs', (select jsonb_build_object('runs', coalesce(sum(u.runs), 0), 'succeeded', coalesce(sum(u.succeeded), 0), 'failed', coalesce(sum(u.failed), 0))
      from leadflow_private.automation_usage_daily u where u.workspace_id = target_workspace and u.day = today),
    'period', (select jsonb_build_object('days', 30, 'runs', coalesce(sum(u.runs), 0), 'succeeded', coalesce(sum(u.succeeded), 0), 'failed', coalesce(sum(u.failed), 0),
        'cancelled', coalesce(sum(u.cancelled), 0), 'finished', coalesce(sum(u.finished), 0), 'actions', coalesce(sum(u.actions), 0), 'aiActions', coalesce(sum(u.ai_actions), 0),
        'emailActions', coalesce(sum(u.email_actions), 0), 'throttled', coalesce(sum(u.throttled), 0), 'blocked', coalesce(sum(u.blocked), 0), 'testRuns', coalesce(sum(u.test_runs), 0),
        'averageMs', case when coalesce(sum(u.finished), 0) > 0 then round(sum(u.duration_ms)::numeric / sum(u.finished)) end)
      from leadflow_private.automation_usage_daily u where u.workspace_id = target_workspace and u.day >= today - 29),
    'open', (select jsonb_build_object('queued', count(*) filter (where r.status = 'queued'), 'running', count(*) filter (where r.status = 'running'),
        'waiting', count(*) filter (where r.status = 'waiting'), 'attention', count(*) filter (where r.status = 'attention'))
      from leadflow_private.automation_runs r where r.workspace_id = target_workspace and r.status in ('queued','running','waiting','attention')),
    'failedRecent', (select count(*) from leadflow_private.automation_runs r where r.workspace_id = target_workspace and r.status in ('failed','attention') and r.mode = 'live'
      and r.created_at > now() - interval '7 days'),
    'attention', coalesce((select jsonb_agg(x order by x->>'at' desc) from (
        select jsonb_build_object('workflowId', w.id, 'name', w.name, 'status', w.status, 'reason', w.attention, 'code', w.attention_code, 'at', w.attention_at) as x
        from leadflow_private.automation_workflows w where w.workspace_id = target_workspace and w.attention_code is not null and w.status <> 'archived'
        union all
        select jsonb_build_object('workflowId', w.id, 'name', w.name, 'status', w.status, 'reason', format('%s failed run%s in the last 7 days', count(*), case when count(*) = 1 then '' else 's' end),
          'code', 'failed_runs', 'at', max(r.created_at))
        from leadflow_private.automation_runs r join leadflow_private.automation_workflows w on w.id = r.workflow_id
        where r.workspace_id = target_workspace and r.status in ('failed','attention') and r.mode = 'live' and r.created_at > now() - interval '7 days' and w.attention_code is null
        group by w.id, w.name, w.status) a), '[]'),
    'recent', coalesce((select jsonb_agg(leadflow_private.automation_run_summary(r) order by r.created_at desc) from (select * from leadflow_private.automation_runs r
      where r.workspace_id = target_workspace order by r.created_at desc limit 8) r), '[]'));
end $$;

create function leadflow_private.automation_run_summary(r leadflow_private.automation_runs) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', r.id, 'workflowId', r.workflow_id, 'workflowName', w.name, 'version', v.number, 'mode', r.mode, 'status', r.status, 'outcome', r.outcome,
    'triggerType', r.trigger_type, 'entityType', r.entity_type, 'entityId', r.entity_id, 'currentNode', r.current_node, 'failedNode', r.failed_node,
    'failedStep', (select s.label from leadflow_private.automation_run_steps s where s.run_id = r.id and s.node_id = r.failed_node order by s.sequence desc limit 1),
    'errorCode', r.error_code, 'error', r.error_summary, 'retryCount', r.retry_count, 'attempts', r.attempts, 'createdAt', r.created_at, 'startedAt', r.started_at,
    'completedAt', r.completed_at, 'nextRunAt', case when r.status in ('queued','waiting') then r.next_run_at end,
    'durationMs', case when r.completed_at is not null then floor(extract(epoch from (r.completed_at - coalesce(r.started_at, r.created_at))) * 1000) end,
    'subject', left(coalesce(r.context->'trigger'->'lead'->>'name', r.context->'trigger'->'deal'->>'title', r.context->'trigger'->'deliverable'->>'title',
      r.context->'trigger'->'milestone'->>'name', r.context->'trigger'->'project'->>'name', r.context->'trigger'->'client'->>'name', r.context->'trigger'->'task'->>'title', ''), 120))
  from leadflow_private.automation_workflows w left join leadflow_private.automation_versions v on v.id = r.version_id where w.id = r.workflow_id
$$;

create function public.automation_workflows_for(target_workspace uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  return coalesce((select jsonb_agg(leadflow_private.automation_workflow_json(w) order by w.status = 'archived', w.updated_at desc)
    from leadflow_private.automation_workflows w where w.workspace_id = target_workspace), '[]');
end $$;

create function public.automation_workflow_detail(target_workspace uuid, target_workflow uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare w leadflow_private.automation_workflows; role text := leadflow_private.require_role(target_workspace, array['owner','admin','member']);
begin
  select * into w from leadflow_private.automation_workflows x where x.id = target_workflow and x.workspace_id = target_workspace;
  if w.id is null then raise exception 'Workflow not found in this workspace.' using errcode = 'P0002'; end if;
  return leadflow_private.automation_workflow_json(w) || jsonb_build_object('definition', w.definition,
    'validation', leadflow_private.automation_check(w.definition, role),
    'published', (select jsonb_build_object('number', v.number, 'definition', v.definition, 'publishedAt', v.published_at, 'publishedBy', leadflow_private.member_label(v.published_by),
      'note', v.note) from leadflow_private.automation_versions v where v.id = w.published_version_id),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('number', v.number, 'publishedAt', v.published_at, 'publishedBy', leadflow_private.member_label(v.published_by), 'note', v.note,
      'current', v.id = w.published_version_id, 'triggerType', v.trigger_type) order by v.number desc) from leadflow_private.automation_versions v where v.workflow_id = w.id and v.kind = 'published'), '[]'),
    'webhook', (select jsonb_build_object('id', h.id, 'status', h.status, 'version', h.secret_version, 'createdAt', h.created_at, 'rotatedAt', h.rotated_at, 'lastReceivedAt', h.last_received_at,
      'received', h.received_count, 'rejected', h.rejected_count) from leadflow_private.automation_webhooks h where h.workflow_id = w.id),
    'openRuns', (select count(*) from leadflow_private.automation_runs r where r.workflow_id = w.id and r.status in ('queued','running','waiting')));
end $$;

-- Owners and admins. Saves the draft (creating the workflow when target_workflow is null). A draft may be incomplete;
-- publishing checks it. Saving never changes the published version or runs in progress.
create function public.automation_save_workflow(target_workspace uuid, target_workflow uuid, workflow_name text, workflow_description text, definition jsonb,
  expected_version integer, request_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare w leadflow_private.automation_workflows; clean_name text := btrim(coalesce(workflow_name, ''));
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if length(clean_name) not between 1 and 120 then raise exception 'Name the workflow (up to 120 characters).' using errcode = '22023'; end if;
  if length(coalesce(workflow_description, '')) > 1000 then raise exception 'The description can be up to 1,000 characters.' using errcode = '22023'; end if;
  if definition is null or jsonb_typeof(definition) <> 'object' or octet_length(definition::text) > 60000 then raise exception 'The workflow definition is too large or malformed.' using errcode = '22023'; end if;
  if target_workflow is null then
    if request_id is null then raise exception 'Missing request ID.' using errcode = '22023'; end if;
    select * into w from leadflow_private.automation_workflows x where x.workspace_id = target_workspace and x.request_id = automation_save_workflow.request_id;
    if w.id is not null then return leadflow_private.automation_workflow_json(w) || jsonb_build_object('repeated', true); end if;
    if (select count(*) from leadflow_private.automation_workflows x where x.workspace_id = target_workspace and x.status <> 'archived') >= (leadflow_private.automation_limits()->>'workflowsPerWorkspace')::integer then
      raise exception 'A workspace can have at most 100 workflows. Archive or delete some first.' using errcode = '54000';
    end if;
    insert into leadflow_private.automation_workflows(workspace_id, request_id, name, description, definition, created_by, updated_by, template_key)
      values (target_workspace, request_id, clean_name, coalesce(workflow_description, ''), definition - 'templateKey', leadflow_private.valid_actor(), leadflow_private.valid_actor(),
        case when definition->>'templateKey' ~ '^[a-z_]{1,40}$' then definition->>'templateKey' end)
      returning * into w;
  else
    w := leadflow_private.automation_lock(target_workspace, target_workflow, expected_version);
    if w.status = 'archived' then raise exception 'Restore this workflow before editing it.' using errcode = '55000'; end if;
    update leadflow_private.automation_workflows x set name = clean_name, description = coalesce(workflow_description, ''), definition = automation_save_workflow.definition,
      version = x.version + 1, draft_changed = x.published_version_id is null or (select v.definition from leadflow_private.automation_versions v where v.id = x.published_version_id) <> automation_save_workflow.definition,
      updated_by = leadflow_private.valid_actor(), updated_at = now()
      where x.id = w.id returning * into w;
  end if;
  return leadflow_private.automation_workflow_json(w) || jsonb_build_object('validation', leadflow_private.automation_check(w.definition,
    leadflow_private.require_role(target_workspace, array['owner','admin'])));
end $$;

create function public.automation_validate(target_workspace uuid, definition jsonb) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  return leadflow_private.automation_check(definition, leadflow_private.require_role(target_workspace, array['owner','admin','member']));
end $$;

-- Owners and admins. Publishes the draft as a new immutable version after checking it completely, and activates it. Runs in
-- progress keep the version they started with. Change detection for leads or tasks starts now if the trigger needs it.
create function public.automation_publish(target_workspace uuid, target_workflow uuid, expected_version integer, note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w leadflow_private.automation_workflows; role text := leadflow_private.require_role(target_workspace, array['owner','admin'], true); checked jsonb; created leadflow_private.automation_versions;
  zone text; next_time timestamptz;
begin
  w := leadflow_private.automation_lock(target_workspace, target_workflow, expected_version);
  if w.status = 'archived' then raise exception 'Restore this workflow before publishing it.' using errcode = '55000'; end if;
  checked := leadflow_private.automation_check(w.definition, role);
  if not (checked->>'valid')::boolean then
    raise exception 'Fix % issue% before publishing: %', jsonb_array_length(checked->'issues'), case when jsonb_array_length(checked->'issues') = 1 then '' else 's' end,
      (select string_agg(i->>'message', ' ') from (select value as i from jsonb_array_elements(checked->'issues') limit 3) x) using errcode = '22023';
  end if;
  if length(coalesce(note, '')) > 300 then raise exception 'The version note can be up to 300 characters.' using errcode = '22023'; end if;
  insert into leadflow_private.automation_versions(workspace_id, workflow_id, kind, number, name, definition, compiled, trigger_type, published_by, publisher_role, note)
    values (target_workspace, w.id, 'published', coalesce((select max(v.number) from leadflow_private.automation_versions v where v.workflow_id = w.id), 0) + 1, w.name, w.definition,
      leadflow_private.automation_compile(w.definition), w.definition->'trigger'->>'type', leadflow_private.valid_actor(), role, coalesce(note, ''))
    returning * into created;
  select coalesce((select s.timezone from public.workspace_settings s where s.workspace_id = target_workspace), 'UTC') into zone;
  next_time := case when created.trigger_type = 'schedule.time' then leadflow_private.automation_next_fire(w.definition->'trigger'->'config', zone, now())
    when coalesce((leadflow_private.automation_trigger_def(created.trigger_type)->>'scan')::boolean, false) then now() end;
  update leadflow_private.automation_workflows x set published_version_id = created.id, trigger_type = created.trigger_type, status = 'active', draft_changed = false,
    next_fire_at = next_time, activated_at = now(), attention_code = null, attention = null, attention_at = null, version = x.version + 1, updated_by = leadflow_private.valid_actor(), updated_at = now()
    where x.id = w.id returning * into w;
  if created.trigger_type in ('lead.created','lead.status_changed') then perform leadflow_private.automation_track(target_workspace, 'lead'); end if;
  if created.trigger_type in ('task.created','task.completed') then perform leadflow_private.automation_track(target_workspace, 'task'); end if;
  return leadflow_private.automation_workflow_json(w);
end $$;

-- Owners and admins: active (the published version), paused (queued runs wait), archived (open runs are cancelled), restored (from archive, paused).
create function public.automation_set_status(target_workspace uuid, target_workflow uuid, next_status text, expected_version integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w leadflow_private.automation_workflows; r uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  w := leadflow_private.automation_lock(target_workspace, target_workflow, expected_version);
  case next_status
    when 'active' then
      if w.published_version_id is null then raise exception 'Publish the workflow before activating it.' using errcode = '55000'; end if;
      if w.status = 'archived' then raise exception 'Restore this workflow first.' using errcode = '55000'; end if;
      -- The publisher's authority is checked again on every action; activating doesn't change whose it is.
      update leadflow_private.automation_workflows x set status = 'active', activated_at = now(), attention_code = null, attention = null, attention_at = null,
        next_fire_at = case when x.trigger_type = 'schedule.time' then leadflow_private.automation_next_fire((select v.definition->'trigger'->'config' from leadflow_private.automation_versions v where v.id = x.published_version_id),
            coalesce((select s.timezone from public.workspace_settings s where s.workspace_id = x.workspace_id), 'UTC'), now())
          when coalesce((leadflow_private.automation_trigger_def(x.trigger_type)->>'scan')::boolean, false) then now() end,
        version = x.version + 1, updated_at = now() where x.id = w.id returning * into w;
      if w.trigger_type in ('lead.created','lead.status_changed') then perform leadflow_private.automation_track(target_workspace, 'lead'); end if;
      if w.trigger_type in ('task.created','task.completed') then perform leadflow_private.automation_track(target_workspace, 'task'); end if;
    when 'paused' then
      if w.status not in ('active','paused','archived') then raise exception 'Only a published workflow can be paused.' using errcode = '55000'; end if;
      update leadflow_private.automation_workflows x set status = 'paused', archived_at = null, version = x.version + 1, updated_at = now() where x.id = w.id returning * into w;
    when 'archived' then
      update leadflow_private.automation_workflows x set status = 'archived', archived_at = now(), next_fire_at = null, version = x.version + 1, updated_at = now() where x.id = w.id returning * into w;
      for r in select x.id from leadflow_private.automation_runs x where x.workflow_id = w.id and x.status in ('queued','waiting','running','attention') loop
        perform leadflow_private.automation_finish(r, 'cancelled', 'cancelled', null, 'Cancelled because the workflow was archived.');
      end loop;
      update leadflow_private.automation_webhooks h set status = 'revoked', revoked_at = now() where h.workflow_id = w.id and h.status = 'active';
    when 'draft' then
      raise exception 'A published workflow can''t go back to draft. Pause or archive it.' using errcode = '22023';
    else raise exception 'Choose active, paused or archived.' using errcode = '22023';
  end case;
  return leadflow_private.automation_workflow_json(w);
end $$;

-- Owners and admins. Puts an earlier version's definition into the draft; publishing it is a separate, explicit step.
create function public.automation_restore_version(target_workspace uuid, target_workflow uuid, version_number integer, expected_version integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w leadflow_private.automation_workflows; v leadflow_private.automation_versions;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  w := leadflow_private.automation_lock(target_workspace, target_workflow, expected_version);
  select * into v from leadflow_private.automation_versions x where x.workflow_id = w.id and x.kind = 'published' and x.number = version_number;
  if v.id is null then raise exception 'Version not found.' using errcode = 'P0002'; end if;
  update leadflow_private.automation_workflows x set definition = v.definition, version = x.version + 1, draft_changed = x.published_version_id is distinct from v.id,
    updated_by = leadflow_private.valid_actor(), updated_at = now() where x.id = w.id returning * into w;
  return leadflow_private.automation_workflow_json(w) || jsonb_build_object('definition', w.definition, 'validation', leadflow_private.automation_check(w.definition, 'admin'));
end $$;

create function public.automation_duplicate(target_workspace uuid, target_workflow uuid, request_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare w leadflow_private.automation_workflows;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  select * into w from leadflow_private.automation_workflows x where x.id = target_workflow and x.workspace_id = target_workspace;
  if w.id is null then raise exception 'Workflow not found in this workspace.' using errcode = 'P0002'; end if;
  return public.automation_save_workflow(target_workspace, null, left('Copy of ' || w.name, 120), w.description, w.definition, null, request_id);
end $$;

-- Owners and admins. Only drafts that were never published, or archived workflows without open runs; history goes with it.
create function public.automation_delete(target_workspace uuid, target_workflow uuid, confirm_name text) returns void language plpgsql security definer set search_path = '' as $$
declare w leadflow_private.automation_workflows;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  w := leadflow_private.automation_lock(target_workspace, target_workflow, null);
  if not (w.status = 'archived' or (w.status = 'draft' and w.published_version_id is null)) then
    raise exception 'Archive the workflow before deleting it.' using errcode = '55000';
  end if;
  if btrim(coalesce(confirm_name, '')) <> w.name then raise exception 'Type the workflow''s name to confirm.' using errcode = '22023'; end if;
  if exists (select 1 from leadflow_private.automation_runs r where r.workflow_id = w.id and r.status in ('queued','running','waiting')) then
    raise exception 'This workflow still has runs in progress.' using errcode = '55000';
  end if;
  delete from leadflow_private.automation_workflows x where x.id = w.id;
end $$;

create function public.automation_from_template(target_workspace uuid, template_key text, request_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare t jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin']);
  select x into t from jsonb_array_elements(leadflow_private.automation_templates()) x where x->>'key' = template_key;
  if t is null then raise exception 'Template not found.' using errcode = 'P0002'; end if;
  return public.automation_save_workflow(target_workspace, null, t->>'name', t->>'description', (t->'definition') || jsonb_build_object('templateKey', t->>'key'), null, request_id);
end $$;

-- Owners and admins: pause every automation in the workspace (no new runs; queued runs wait) or resume.
create function public.automation_save_settings(target_workspace uuid, paused boolean, reason text default '') returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if length(coalesce(reason, '')) > 300 then raise exception 'The reason can be up to 300 characters.' using errcode = '22023'; end if;
  insert into leadflow_private.automation_settings(workspace_id, paused, paused_reason, updated_by, updated_at)
    values (target_workspace, coalesce(automation_save_settings.paused, false), coalesce(reason, ''), leadflow_private.valid_actor(), now())
    on conflict (workspace_id) do update set paused = excluded.paused, paused_reason = excluded.paused_reason, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('paused', coalesce(automation_save_settings.paused, false), 'reason', coalesce(reason, ''));
end $$;

-- ---------- Testing ----------

-- A realistic trigger payload built from one of the workspace's own records (read only), with recent records to choose from.
create function public.automation_sample_for(target_workspace uuid, trigger_type text, entity_id text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare tdef jsonb := leadflow_private.automation_trigger_def(trigger_type); subject text := tdef->>'subject'; data jsonb := '{}'; options jsonb := '[]'; label text; pick text;
  l public.leads; t public.follow_up_tasks; d leadflow_private.deals; c leadflow_private.clients; p leadflow_private.projects; m leadflow_private.project_milestones;
  dl leadflow_private.project_deliverables; ob leadflow_private.onboarding_requests; today date := leadflow_private.project_today(target_workspace); f jsonb; cfg jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  if tdef is null then raise exception 'Choose a trigger.' using errcode = '22023'; end if;
  if trigger_type like 'lead.%' or trigger_type like 'analysis.%' or trigger_type like 'contact.%' or trigger_type like 'outreach.%' then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'label', x.name) order by x."createdAt" desc), '[]') into options from (select * from public.leads x where x.workspace_id = target_workspace order by x."createdAt" desc limit 20) x;
    select * into l from public.leads x where x.workspace_id = target_workspace and (entity_id is null or x.id = entity_id) order by x."createdAt" desc limit 1;
    if l.id is not null then
      pick := l.id; label := l.name;
      data := jsonb_build_object('lead', leadflow_private.automation_lead_data(l), 'previousStatus', 'New',
        'analysis', (select jsonb_build_object('id', a.id, 'status', case when a.status in ('completed','partial','failed') then a.status else 'completed' end, 'pagesAnalyzed', a.pages_analyzed,
          'opportunityCount', (select count(*) from leadflow_private.business_opportunities o where o.analysis_id = a.id and o.status <> 'dismissed'),
          'highPriorityOpportunities', (select count(*) from leadflow_private.business_opportunities o where o.analysis_id = a.id and o.status <> 'dismissed' and o.priority = 'high'),
          'topOpportunity', coalesce((select o.title from leadflow_private.business_opportunities o where o.analysis_id = a.id order by case o.priority when 'high' then 0 when 'medium' then 1 else 2 end limit 1), ''),
          'topOpportunityService', '', 'matchedServices', '[]'::jsonb, 'failure', '')
          from leadflow_private.business_analyses a where a.workspace_id = target_workspace and a.lead_id = l.id order by a.created_at desc limit 1),
        'contact', (select jsonb_build_object('id', x.id, 'name', coalesce(nullif(x.full_name, ''), x.label), 'role', x.role, 'jobTitle', x.job_title, 'hasEmail', x.email <> '', 'hasPhone', x.phone <> '')
          from leadflow_private.lead_contacts x where x.workspace_id = target_workspace and x.lead_id = l.id order by x.created_at desc limit 1),
        'draft', (select jsonb_build_object('id', x.id, 'channel', x.channel, 'status', x.status, 'sequenceStep', x.sequence_step)
          from leadflow_private.outreach_drafts x where x.workspace_id = target_workspace and x.lead_id = l.id order by x.created_at desc limit 1));
      if trigger_type not like 'lead.%' then data := data || jsonb_build_object('lead', jsonb_build_object('id', l.id, 'name', l.name, 'company', l.company)); end if;
    end if;
  elsif trigger_type like 'task.%' then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'label', left(x.notes, 80))), '[]') into options from (select * from public.follow_up_tasks x where x.workspace_id = target_workspace order by x.due desc limit 20) x;
    select * into t from public.follow_up_tasks x where x.workspace_id = target_workspace and (entity_id is null or x.id = entity_id) order by x.due desc limit 1;
    if t.id is not null then pick := t.id; label := left(t.notes, 80); data := jsonb_build_object('task', leadflow_private.automation_task_data(t), 'daysOverdue', greatest(today - t.due, 0)); end if;
  elsif trigger_type like 'deal.%' then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'label', x.title)), '[]') into options from (select * from leadflow_private.deals x where x.workspace_id = target_workspace order by x.created_at desc limit 20) x;
    select * into d from leadflow_private.deals x where x.workspace_id = target_workspace and (entity_id is null or x.id::text = entity_id) order by x.created_at desc limit 1;
    if d.id is not null then
      pick := d.id::text; label := d.title;
      data := jsonb_build_object('deal', leadflow_private.automation_deal_data(d), 'previousStage', '', 'wonValue', coalesce(d.won_value, d.value), 'lostReason', coalesce(d.lost_reason, ''),
        'daysUntilClose', greatest(coalesce(d.expected_close_date - today, 0), 0), 'meeting', jsonb_build_object('id', gen_random_uuid(), 'title', 'Sample meeting', 'startsAt', now() + interval '1 day', 'status', 'scheduled'));
    end if;
  elsif subject in ('client','onboarding') then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'label', x.name)), '[]') into options from (select * from leadflow_private.clients x where x.workspace_id = target_workspace order by x.created_at desc limit 20) x;
    select * into c from leadflow_private.clients x where x.workspace_id = target_workspace and (entity_id is null or x.id::text = entity_id) order by x.created_at desc limit 1;
    if c.id is not null then
      pick := c.id::text; label := c.name;
      select * into ob from leadflow_private.onboarding_requests x where x.workspace_id = target_workspace and x.client_id = c.id order by x.created_at desc limit 1;
      data := jsonb_build_object('client', leadflow_private.automation_client_data(c),
        'onboarding', case when ob.id is null then null else jsonb_build_object('id', ob.id, 'title', ob.title, 'status', ob.status, 'templateName', coalesce(ob.template_name, ''), 'dueDate', ob.due_date) end,
        'item', jsonb_build_object('title', 'Sample item', 'section', 'General', 'required', true), 'invitation', jsonb_build_object('role', 'reviewer'), 'access', jsonb_build_object('role', 'reviewer'),
        'scope', jsonb_build_object('sequence', 1, 'servicesConfirmed', (select count(*) from leadflow_private.client_services s where s.client_id = c.id and s.status = 'confirmed'),
          'requirementsConfirmed', (select count(*) from leadflow_private.client_requirements r where r.client_id = c.id and r.status = 'confirmed'), 'sharedWithClient', true),
        'completion', (select jsonb_build_object('id', x.id, 'override', x.override_reason is not null, 'outstandingItems', jsonb_array_length(x.outstanding),
          'confirmedServices', jsonb_array_length(coalesce(x.snapshot->'services', '[]')), 'confirmedRequirements', jsonb_array_length(coalesce(x.snapshot->'requirements', '[]')))
          from leadflow_private.client_onboarding_completions x where x.client_id = c.id),
        'hasProject', exists (select 1 from leadflow_private.projects x where x.client_id = c.id and x.completion_id is not null),
        'file', jsonb_build_object('id', gen_random_uuid(), 'name', 'brief.pdf', 'category', 'requirements'));
    end if;
  elsif subject in ('project','milestone','deliverable') then
    if subject = 'project' then
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'label', x.name)), '[]') into options from (select * from leadflow_private.projects x where x.workspace_id = target_workspace order by x.created_at desc limit 20) x;
      select * into p from leadflow_private.projects x where x.workspace_id = target_workspace and (entity_id is null or x.id::text = entity_id) order by x.created_at desc limit 1;
    elsif subject = 'milestone' then
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'label', x.name)), '[]') into options from (select * from leadflow_private.project_milestones x where x.workspace_id = target_workspace order by x.created_at desc limit 20) x;
      select * into m from leadflow_private.project_milestones x where x.workspace_id = target_workspace and (entity_id is null or x.id::text = entity_id) order by x.created_at desc limit 1;
      select * into p from leadflow_private.projects x where x.id = m.project_id;
    else
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'label', x.title)), '[]') into options from (select * from leadflow_private.project_deliverables x where x.workspace_id = target_workspace order by x.created_at desc limit 20) x;
      select * into dl from leadflow_private.project_deliverables x where x.workspace_id = target_workspace and (entity_id is null or x.id::text = entity_id) order by x.created_at desc limit 1;
      select * into p from leadflow_private.projects x where x.id = dl.project_id;
    end if;
    if p.id is not null then
      pick := coalesce(m.id::text, dl.id::text, p.id::text); label := coalesce(m.name, dl.title, p.name);
      data := jsonb_build_object('project', leadflow_private.automation_project_data(p), 'previousStatus', 'not_started', 'daysOverdue', greatest(coalesce(today - p.target_date, 0), 0),
        'milestone', case when m.id is not null then leadflow_private.automation_milestone_data(m) end, 'daysUntilDue', case when m.id is not null then greatest(coalesce(m.due_date - today, 0), 0) end,
        'deliverable', case when dl.id is not null then leadflow_private.automation_deliverable_data(dl) end,
        'review', jsonb_build_object('id', gen_random_uuid(), 'versionNumber', 1, 'dueDate', today + 5, 'resubmission', false),
        'decision', jsonb_build_object('versionNumber', 1, 'feedbackItems', 2), 'feedback', jsonb_build_object('id', gen_random_uuid(), 'title', 'Sample feedback', 'category', 'design'),
        'comment', jsonb_build_object('id', gen_random_uuid(), 'onDeliverable', dl.id is not null), 'update', jsonb_build_object('id', gen_random_uuid(), 'title', 'Sample update'));
      if subject = 'deliverable' then data := data || jsonb_build_object('previousStatus', 'in_progress'); end if;
    end if;
  elsif trigger_type = 'schedule.time' then
    data := jsonb_build_object('schedule', jsonb_build_object('firedAt', now(), 'date', today, 'weekday', trim(to_char(today, 'Day'))));
  elsif trigger_type = 'webhook.received' then
    select w.definition->'trigger'->'config' into cfg from leadflow_private.automation_workflows w where w.workspace_id = target_workspace and w.id::text = entity_id;
    data := jsonb_build_object('webhook', jsonb_build_object('eventId', 'test-event-1'), 'data', '{}'::jsonb);
    for f in select value from jsonb_array_elements(coalesce(cfg->'fields', '[]')) loop
      data := jsonb_set(data, array['data', f->>'key'], case f->>'type' when 'number' then '1'::jsonb when 'boolean' then 'true'::jsonb when 'date' then to_jsonb(today::text) else '"sample"'::jsonb end);
    end loop;
  end if;
  return jsonb_build_object('data', jsonb_strip_nulls(data), 'entity', case when pick is null then null else jsonb_build_object('type', subject, 'id', pick, 'label', label) end, 'options', options,
    'empty', pick is null and trigger_type not in ('schedule.time','webhook.received'));
end $$;

-- A dry run: evaluates the trigger filter, conditions and branches against sample data and shows which actions would run
-- with which inputs. It writes nothing: no tasks, notifications, emails, records or runs.
create function public.automation_dry_run(target_workspace uuid, definition jsonb, sample jsonb) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare role text := leadflow_private.require_role(target_workspace, array['owner','admin','member']); checked jsonb := leadflow_private.automation_check(definition, role);
  compiled jsonb; ctx jsonb; today date := leadflow_private.project_today(target_workspace); trace jsonb := '[]'; node_id text; node jsonb; matched boolean; chosen jsonb; c jsonb; def jsonb;
  outputs jsonb; f jsonb; guard integer := 0; filter_matched boolean; outcome text := 'completed'; wait_def jsonb;
begin
  if definition is null or jsonb_typeof(definition) <> 'object' then raise exception 'Nothing to test.' using errcode = '22023'; end if;
  compiled := leadflow_private.automation_compile(definition);
  ctx := jsonb_build_object('trigger', coalesce(sample, '{}'), 'workspace', jsonb_build_object('name', (select w.name from public.workspaces w where w.id = target_workspace)),
    'run', jsonb_build_object('date', today, 'startedAt', now()), 'steps', '{}'::jsonb);
  begin filter_matched := leadflow_private.automation_eval_group(definition->'trigger'->'filter', ctx, today);
  exception when others then filter_matched := false; end;
  if not filter_matched then
    return jsonb_build_object('valid', checked->'valid', 'issues', checked->'issues', 'filterMatched', false, 'outcome', 'filtered', 'steps', '[]'::jsonb,
      'note', 'The trigger filter doesn''t match this data, so no run would start.');
  end if;
  node_id := compiled->>'entry';
  while node_id is not null and guard < 100 loop
    guard := guard + 1;
    node := compiled->'nodes'->node_id;
    exit when node is null;
    case node->>'type'
      when 'condition' then
        begin matched := leadflow_private.automation_eval_group(node->'when', ctx, today); exception when others then matched := false; end;
        trace := trace || jsonb_build_object('node', node_id, 'type', 'condition', 'label', node->>'label', 'result', jsonb_build_object('matched', matched));
        if not matched then outcome := 'condition_not_met'; exit; end if;
        node_id := node->>'next';
      when 'branch' then
        chosen := null;
        for c in select value from jsonb_array_elements(node->'cases') loop
          begin if leadflow_private.automation_eval_group(c->'when', ctx, today) then chosen := c; exit; end if; exception when others then null; end;
        end loop;
        trace := trace || jsonb_build_object('node', node_id, 'type', 'branch', 'label', node->>'label', 'result', jsonb_build_object('path', coalesce(chosen->>'id', 'otherwise'),
          'label', coalesce(chosen->>'label', 'Otherwise')));
        node_id := case when chosen is not null then chosen->>'next' else node->>'otherwise' end;
      when 'delay' then
        trace := trace || jsonb_build_object('node', node_id, 'type', 'delay', 'label', node->>'label', 'result', jsonb_build_object('wouldWait',
          case when node->>'mode' = 'until' then 'until ' || (node->>'until') else (node->>'amount') || ' ' || (node->>'unit') end));
        node_id := node->>'next';
      when 'wait' then
        wait_def := leadflow_private.automation_wait_def(node->>'event');
        trace := trace || jsonb_build_object('node', node_id, 'type', 'wait', 'label', node->>'label', 'result', jsonb_build_object('wouldWaitFor', wait_def->>'label',
          'for', (node->'timeout'->>'amount') || ' ' || (node->'timeout'->>'unit'), 'assumed', 'The event arrives in time.',
          'record', leadflow_private.automation_value(ctx, node->>'subject')));
        outputs := jsonb_build_object('received', true);
        for f in select value from jsonb_array_elements(coalesce(wait_def->'outputs', '[]')) loop
          if f->>'path' <> 'received' then outputs := outputs || jsonb_build_object(f->>'path', '(' || lower(f->>'label') || ')'); end if;
        end loop;
        ctx := jsonb_set(ctx, array['steps', node_id], outputs);
        node_id := node->>'next';
      when 'action' then
        def := leadflow_private.automation_action_def(node->>'action');
        trace := trace || jsonb_build_object('node', node_id, 'type', 'action', 'label', coalesce(nullif(node->>'label', ''), def->>'label'), 'action', node->>'action',
          'side', def->>'side', 'ai', coalesce((def->>'ai')::boolean, false), 'client', coalesce((def->>'client')::boolean, false),
          'input', leadflow_private.automation_input_summary(def, node->'inputs', ctx, today), 'result', jsonb_build_object('wouldRun', true));
        outputs := '{}';
        for f in select value from jsonb_array_elements(coalesce(def->'outputs', '[]')) loop
          outputs := outputs || jsonb_build_object(f->>'path', case f->>'type' when 'ref' then to_jsonb('(new ' || (f->>'entity') || ')') when 'boolean' then 'true'::jsonb
            when 'number' then '1'::jsonb when 'date' then to_jsonb(today::text) else to_jsonb('(' || lower(f->>'label') || ')') end);
        end loop;
        ctx := jsonb_set(ctx, array['steps', node_id], outputs);
        node_id := node->>'next';
      else exit;
    end case;
  end loop;
  return jsonb_build_object('valid', checked->'valid', 'issues', checked->'issues', 'filterMatched', true, 'outcome', outcome, 'steps', trace,
    'note', 'Dry run: nothing was created, changed, sent or notified.');
end $$;

-- Owners and admins: a live test of the current draft against the given data, after an explicit confirmation. It runs
-- real actions (labelled "Live test" and kept out of production metrics) with the caller's authority.
create function public.automation_start_test(target_workspace uuid, target_workflow uuid, sample jsonb, confirmed boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare role text := leadflow_private.require_role(target_workspace, array['owner','admin'], true); w leadflow_private.automation_workflows; checked jsonb; v leadflow_private.automation_versions;
  created leadflow_private.automation_runs; today date := leadflow_private.project_today(target_workspace);
begin
  if not coalesce(confirmed, false) then raise exception 'Confirm that the live test will run real actions.' using errcode = '22023'; end if;
  w := leadflow_private.automation_lock(target_workspace, target_workflow, null);
  checked := leadflow_private.automation_check(w.definition, role);
  if not (checked->>'valid')::boolean then raise exception 'Fix the workflow''s issues before a live test.' using errcode = '22023'; end if;
  if sample is null or jsonb_typeof(sample) <> 'object' or octet_length(sample::text) > 16000 then raise exception 'Choose test data.' using errcode = '22023'; end if;
  if (select count(*) from leadflow_private.automation_runs x where x.workspace_id = target_workspace and x.mode = 'test' and x.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'At most 30 live tests an hour per workspace.' using errcode = 'P0429';
  end if;
  insert into leadflow_private.automation_versions(workspace_id, workflow_id, kind, name, definition, compiled, trigger_type, published_by, publisher_role, note)
    values (target_workspace, w.id, 'test', w.name, w.definition, leadflow_private.automation_compile(w.definition), w.definition->'trigger'->>'type', leadflow_private.valid_actor(), role, 'Live test')
    returning * into v;
  insert into leadflow_private.automation_runs(workspace_id, workflow_id, version_id, mode, trigger_type, entity_type, context, current_node, started_by)
    values (target_workspace, w.id, v.id, 'test', v.trigger_type, leadflow_private.automation_trigger_def(v.trigger_type)->>'subject',
      jsonb_build_object('trigger', leadflow_private.automation_sanitize_payload(sample), 'event', jsonb_build_object('type', v.trigger_type, 'source', 'test'),
        'workspace', jsonb_build_object('name', (select x.name from public.workspaces x where x.id = target_workspace)), 'run', jsonb_build_object('date', today, 'startedAt', now()), 'steps', '{}'::jsonb),
      v.compiled->>'entry', leadflow_private.valid_actor())
    returning * into created;
  perform leadflow_private.automation_count(target_workspace, w.id, jsonb_build_object('testRuns', 1));
  return leadflow_private.automation_run_summary(created);
end $$;

-- ---------- History and recovery ----------

-- Runs, newest first, 25 to a page. filters: { workflowId, status, mode, failed (failed or needing attention) }. Pass the last
-- run's createdAt and id to get the next page.
create function public.automation_runs_for(target_workspace uuid, filters jsonb default '{}', before_at timestamptz default null, before_id uuid default null, page_size integer default 25)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare size integer := least(greatest(coalesce(page_size, 25), 1), 100); items jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select coalesce(jsonb_agg(leadflow_private.automation_run_summary(r) order by r.created_at desc, r.id desc), '[]') into items from (
    select * from leadflow_private.automation_runs r where r.workspace_id = target_workspace
      and (filters->>'workflowId' is null or r.workflow_id::text = filters->>'workflowId')
      and (filters->>'status' is null or r.status = filters->>'status')
      and (filters->>'mode' is null or r.mode = filters->>'mode')
      and (coalesce((filters->>'failed')::boolean, false) = false or r.status in ('failed','attention'))
      and (before_at is null or (r.created_at, r.id) < (before_at, before_id))
      order by r.created_at desc, r.id desc limit size + 1) r;
  return jsonb_build_object('items', (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(items) with ordinality e(x, n) where n <= size) y),
    'more', jsonb_array_length(items) > size);
end $$;

create function public.automation_run_detail(target_workspace uuid, target_run uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r leadflow_private.automation_runs; v leadflow_private.automation_versions;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into r from leadflow_private.automation_runs x where x.id = target_run and x.workspace_id = target_workspace;
  if r.id is null then raise exception 'Run not found in this workspace.' using errcode = 'P0002'; end if;
  select * into v from leadflow_private.automation_versions x where x.id = r.version_id;
  return leadflow_private.automation_run_summary(r) || jsonb_build_object(
    'trigger', leadflow_private.automation_sanitize(r.context->'trigger'), 'event', r.context->'event', 'wait', r.wait,
    'versionKind', v.kind, 'definition', v.definition, 'publishedBy', leadflow_private.member_label(v.published_by),
    'steps', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'sequence', s.sequence, 'node', s.node_id, 'type', s.node_type, 'action', s.action_type, 'label', s.label,
      'status', s.status, 'attempt', s.attempt, 'result', s.result, 'input', s.input, 'output', s.output, 'errorCode', s.error_code, 'error', s.error_message,
      'startedAt', s.started_at, 'completedAt', s.completed_at) order by s.sequence) from leadflow_private.automation_run_steps s where s.run_id = r.id), '[]'),
    -- A failed step can be retried in place: every action uses a request ID made from the run and step, so steps that
    -- already completed are never repeated and a step that half-ran finds what it created.
    'canRetry', r.status in ('failed','attention'), 'canCancel', r.status in ('queued','waiting','attention','running'));
end $$;

-- Owners and admins. Resumes a failed run from the step that failed, with the version it started with.
create function public.automation_retry_run(target_workspace uuid, target_run uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r leadflow_private.automation_runs; w leadflow_private.automation_workflows;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  select * into r from leadflow_private.automation_runs x where x.id = target_run and x.workspace_id = target_workspace for update;
  if r.id is null then raise exception 'Run not found in this workspace.' using errcode = 'P0002'; end if;
  if r.status not in ('failed','attention') then raise exception 'Only failed runs, or runs that need attention, can be retried.' using errcode = '55000'; end if;
  select * into w from leadflow_private.automation_workflows x where x.id = r.workflow_id;
  if r.mode = 'live' and w.status <> 'active' then raise exception 'Activate the workflow first; retried runs only continue while it is active.' using errcode = '55000'; end if;
  update leadflow_private.automation_runs x set status = 'queued', next_run_at = now(), current_node = coalesce(x.failed_node, x.current_node), attempts = 0, retry_count = x.retry_count + 1,
    outcome = null, error_code = null, error_summary = null, completed_at = null, updated_at = now() where x.id = r.id returning * into r;
  return leadflow_private.automation_run_summary(r);
end $$;

-- Owners and admins. A full rerun: a new run of the current published version for the same event. Steps that already
-- created records run again with new request IDs, so the caller must confirm it.
create function public.automation_rerun(target_workspace uuid, target_run uuid, confirmed boolean) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r leadflow_private.automation_runs; w leadflow_private.automation_workflows; v leadflow_private.automation_versions; created leadflow_private.automation_runs;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if not coalesce(confirmed, false) then raise exception 'Confirm the full rerun: completed steps will run again and may create duplicates.' using errcode = '22023'; end if;
  select * into r from leadflow_private.automation_runs x where x.id = target_run and x.workspace_id = target_workspace;
  if r.id is null then raise exception 'Run not found in this workspace.' using errcode = 'P0002'; end if;
  if r.status not in ('completed','failed','cancelled','attention') then raise exception 'Wait until this run finishes, or cancel it.' using errcode = '55000'; end if;
  select * into w from leadflow_private.automation_workflows x where x.id = r.workflow_id;
  if w.status <> 'active' or w.published_version_id is null then raise exception 'Activate the workflow first.' using errcode = '55000'; end if;
  select * into v from leadflow_private.automation_versions x where x.id = w.published_version_id;
  insert into leadflow_private.automation_runs(workspace_id, workflow_id, version_id, event_id, mode, trigger_type, entity_type, entity_id, context, current_node, chain, started_by)
    values (r.workspace_id, w.id, v.id, null, 'live', r.trigger_type, r.entity_type, r.entity_id, jsonb_set(r.context, '{steps}', '{}'::jsonb), v.compiled->>'entry', r.chain, leadflow_private.valid_actor())
    returning * into created;
  perform leadflow_private.automation_count(r.workspace_id, w.id, jsonb_build_object('runs', 1));
  return leadflow_private.automation_run_summary(created);
end $$;

create function public.automation_cancel_run(target_workspace uuid, target_run uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r leadflow_private.automation_runs;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  select * into r from leadflow_private.automation_runs x where x.id = target_run and x.workspace_id = target_workspace for update;
  if r.id is null then raise exception 'Run not found in this workspace.' using errcode = 'P0002'; end if;
  if r.status not in ('queued','waiting','attention','running') then raise exception 'This run has already finished.' using errcode = '55000'; end if;
  -- A running AI step loses its lease: its result is discarded when it arrives.
  perform leadflow_private.automation_finish(r.id, 'cancelled', 'cancelled', null, 'Cancelled by ' || leadflow_private.member_label(leadflow_private.valid_actor()) || '.', null);
  select * into r from leadflow_private.automation_runs x where x.id = target_run;
  return leadflow_private.automation_run_summary(r);
end $$;

-- ---------- Webhook endpoints (members) ----------

-- Owners and admins. Creates the workflow's endpoint, or rotates its secret (the old one stops working at once). The secret
-- itself is derived and shown once by the automation Edge Function; the database never holds it.
create function public.automation_webhook_issue(target_workspace uuid, target_workflow uuid, rotate boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w leadflow_private.automation_workflows; h leadflow_private.automation_webhooks;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  w := leadflow_private.automation_lock(target_workspace, target_workflow, null);
  if coalesce(w.trigger_type, w.definition->'trigger'->>'type') <> 'webhook.received' and w.definition->'trigger'->>'type' <> 'webhook.received' then
    raise exception 'Choose the webhook trigger for this workflow first.' using errcode = '55000';
  end if;
  select * into h from leadflow_private.automation_webhooks x where x.workflow_id = w.id for update;
  if h.id is null then
    insert into leadflow_private.automation_webhooks(workspace_id, workflow_id, created_by) values (target_workspace, w.id, leadflow_private.valid_actor()) returning * into h;
  elsif coalesce(rotate, false) or h.status = 'revoked' then
    update leadflow_private.automation_webhooks x set secret_version = x.secret_version + 1, status = 'active', revoked_at = null, rotated_at = now() where x.id = h.id returning * into h;
  else
    raise exception 'This workflow already has an endpoint. Rotate its secret to get a new one.' using errcode = 'P0409';
  end if;
  return jsonb_build_object('id', h.id, 'version', h.secret_version, 'status', h.status);
end $$;

create function public.automation_webhook_revoke(target_workspace uuid, target_workflow uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare h leadflow_private.automation_webhooks;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  update leadflow_private.automation_webhooks x set status = 'revoked', revoked_at = now() where x.workflow_id = target_workflow and x.workspace_id = target_workspace and x.status = 'active'
    returning * into h;
  if h.id is null then raise exception 'No active endpoint for this workflow.' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', h.id, 'status', h.status);
end $$;

-- ---------- Grants ----------
-- Supabase grants new public functions to anon and authenticated by default; restate every grant.
revoke all on function leadflow_private.automation_refuse_change(), leadflow_private.automation_limits(), leadflow_private.automation_entity_fields(text),
  leadflow_private.automation_trigger_list(), leadflow_private.automation_waitable(), leadflow_private.automation_action_list(), leadflow_private.automation_operators(),
  leadflow_private.automation_common_fields(), leadflow_private.automation_trigger_fields(jsonb, jsonb), leadflow_private.automation_catalog(), leadflow_private.automation_trigger_def(text),
  leadflow_private.automation_action_def(text), leadflow_private.automation_wait_def(text), leadflow_private.automation_value(jsonb, text), leadflow_private.automation_text(jsonb),
  leadflow_private.automation_render(text, jsonb, integer), leadflow_private.automation_redact(text), leadflow_private.automation_sanitize(jsonb, integer),
  leadflow_private.automation_eval_condition(jsonb, jsonb, date), leadflow_private.automation_eval_group(jsonb, jsonb, date, integer), leadflow_private.automation_issue(text, text, text),
  leadflow_private.automation_field_at(jsonb, text), leadflow_private.automation_check_group(jsonb, jsonb, text, integer, jsonb, integer),
  leadflow_private.automation_check_template(text, jsonb, text, text), leadflow_private.automation_check_inputs(jsonb, jsonb, jsonb, text),
  leadflow_private.automation_check_steps(jsonb, jsonb, integer, text, jsonb, integer, integer, integer, text[], boolean), leadflow_private.automation_check_schedule(jsonb),
  leadflow_private.automation_check(jsonb, text), leadflow_private.automation_compile_steps(jsonb, text, jsonb), leadflow_private.automation_compile(jsonb),
  leadflow_private.automation_next_fire(jsonb, text, timestamptz), leadflow_private.automation_listens(uuid, text[]), leadflow_private.automation_kind_events(text),
  leadflow_private.automation_track(uuid, text), leadflow_private.automation_lead_data(public.leads), leadflow_private.automation_lead_ref(uuid, text),
  leadflow_private.automation_task_data(public.follow_up_tasks), leadflow_private.automation_task_keys(public.follow_up_tasks), leadflow_private.automation_deal_data(leadflow_private.deals),
  leadflow_private.automation_client_data(leadflow_private.clients), leadflow_private.automation_client_ref(uuid), leadflow_private.automation_project_data(leadflow_private.projects),
  leadflow_private.automation_project_ref(uuid), leadflow_private.automation_milestone_data(leadflow_private.project_milestones),
  leadflow_private.automation_deliverable_data(leadflow_private.project_deliverables), leadflow_private.automation_wait_output(text, jsonb),
  leadflow_private.automation_emit(uuid, text, text, text, jsonb, text[], text, text, uuid), leadflow_private.automation_sanitize_payload(jsonb), leadflow_private.automation_redact_secrets(text),
  leadflow_private.automation_count(uuid, uuid, jsonb), leadflow_private.automation_capture_leads(), leadflow_private.automation_capture_tasks(), leadflow_private.automation_capture(),
  leadflow_private.automation_key(uuid, text), leadflow_private.automation_ref_entity(text), leadflow_private.automation_impersonate(uuid), leadflow_private.automation_classify(text),
  leadflow_private.automation_record_owner(uuid, text, text), leadflow_private.automation_member(uuid, text, uuid, text, text), leadflow_private.automation_due(jsonb, jsonb, date),
  leadflow_private.automation_input_summary(jsonb, jsonb, jsonb, date),
  leadflow_private.automation_execute(leadflow_private.automation_runs, leadflow_private.automation_versions, text, jsonb, text, date, jsonb),
  leadflow_private.automation_step(leadflow_private.automation_runs, text, jsonb, text, integer, jsonb, jsonb, jsonb, text, text, timestamptz),
  leadflow_private.automation_finish(uuid, text, text, text, text, text), leadflow_private.automation_backoff(integer), leadflow_private.automation_templates(),
  leadflow_private.automation_workflow_json(leadflow_private.automation_workflows), leadflow_private.automation_lock(uuid, uuid, integer),
  leadflow_private.automation_run_summary(leadflow_private.automation_runs)
  from public, anon, authenticated;
revoke all on function public.automation_advance(uuid, jsonb), public.automation_complete_external(uuid, uuid, jsonb), public.automation_tick(),
  public.automation_webhook_lookup(uuid), public.automation_webhook_rejected(uuid), public.automation_receive_webhook(uuid, integer, text, jsonb), public.automation_ai_reserve(uuid, uuid, integer),
  public.automation_center_for(uuid), public.automation_overview_for(uuid), public.automation_workflows_for(uuid), public.automation_workflow_detail(uuid, uuid),
  public.automation_save_workflow(uuid, uuid, text, text, jsonb, integer, uuid), public.automation_validate(uuid, jsonb), public.automation_publish(uuid, uuid, integer, text),
  public.automation_set_status(uuid, uuid, text, integer), public.automation_restore_version(uuid, uuid, integer, integer), public.automation_duplicate(uuid, uuid, uuid),
  public.automation_delete(uuid, uuid, text), public.automation_from_template(uuid, text, uuid), public.automation_save_settings(uuid, boolean, text),
  public.automation_sample_for(uuid, text, text), public.automation_dry_run(uuid, jsonb, jsonb), public.automation_start_test(uuid, uuid, jsonb, boolean),
  public.automation_runs_for(uuid, jsonb, timestamptz, uuid, integer), public.automation_run_detail(uuid, uuid), public.automation_retry_run(uuid, uuid), public.automation_rerun(uuid, uuid, boolean),
  public.automation_cancel_run(uuid, uuid), public.automation_webhook_issue(uuid, uuid, boolean), public.automation_webhook_revoke(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.automation_center_for(uuid), public.automation_overview_for(uuid), public.automation_workflows_for(uuid), public.automation_workflow_detail(uuid, uuid),
  public.automation_save_workflow(uuid, uuid, text, text, jsonb, integer, uuid), public.automation_validate(uuid, jsonb), public.automation_publish(uuid, uuid, integer, text),
  public.automation_set_status(uuid, uuid, text, integer), public.automation_restore_version(uuid, uuid, integer, integer), public.automation_duplicate(uuid, uuid, uuid),
  public.automation_delete(uuid, uuid, text), public.automation_from_template(uuid, text, uuid), public.automation_save_settings(uuid, boolean, text),
  public.automation_sample_for(uuid, text, text), public.automation_dry_run(uuid, jsonb, jsonb), public.automation_start_test(uuid, uuid, jsonb, boolean),
  public.automation_runs_for(uuid, jsonb, timestamptz, uuid, integer), public.automation_run_detail(uuid, uuid), public.automation_retry_run(uuid, uuid), public.automation_rerun(uuid, uuid, boolean),
  public.automation_cancel_run(uuid, uuid), public.automation_webhook_issue(uuid, uuid, boolean), public.automation_webhook_revoke(uuid, uuid)
  to authenticated;
grant execute on function public.automation_advance(uuid, jsonb), public.automation_complete_external(uuid, uuid, jsonb), public.automation_tick(),
  public.automation_webhook_lookup(uuid), public.automation_webhook_rejected(uuid), public.automation_receive_webhook(uuid, integer, text, jsonb), public.automation_ai_reserve(uuid, uuid, integer)
  to service_role;
