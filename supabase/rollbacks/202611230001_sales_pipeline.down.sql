-- Reverses 202611230001_sales_pipeline.sql. Run it as one batch, then:
--   npx supabase migration repair --status reverted 202611230001
-- Deletes every pipeline stage, deal, stage history entry, deal activity, meeting and client handoff, and the sales settings.
-- Follow-up tasks stay, without their deal, contact, type, priority, cancellation, assignee, description and timestamps.
-- Leads, activity history, business reports, contacts and outreach drafts are not touched.
drop function public.sales_pipeline_for(uuid), public.save_sales_stage(uuid, jsonb), public.reorder_sales_stages(uuid, jsonb), public.archive_sales_stage(uuid, uuid, uuid),
  public.restore_sales_stage(uuid, uuid), public.save_sales_settings(uuid, jsonb), public.create_deal(uuid, jsonb, uuid, boolean), public.update_deal(uuid, uuid, integer, jsonb),
  public.move_deal(uuid, uuid, uuid, integer, uuid), public.close_deal(uuid, uuid, text, jsonb, integer, uuid), public.reopen_deal(uuid, uuid, uuid, integer, uuid),
  public.set_deal_archived(uuid, uuid, boolean), public.deals_for(uuid, jsonb), public.pipeline_board_for(uuid, jsonb), public.deal_detail(uuid, uuid),
  public.deal_timeline(uuid, uuid, jsonb, timestamptz, integer), public.record_deal_activity(uuid, uuid, jsonb, uuid), public.save_deal_meeting(uuid, uuid, jsonb, uuid),
  public.confirm_client_handoff(uuid, uuid, text), public.sales_analytics(uuid, date, date, date), public.sales_reminders_for(uuid, date),
  leadflow_private.apply_stage(leadflow_private.deals, leadflow_private.sales_stages, uuid, text), leadflow_private.lock_deal(uuid, uuid, integer),
  leadflow_private.add_deal_activity(leadflow_private.deals, text, text, text, jsonb, uuid, timestamptz, uuid), leadflow_private.deal_json(leadflow_private.deals),
  leadflow_private.stage_json(leadflow_private.sales_stages), leadflow_private.ensure_sales_setup(uuid);
drop trigger follow_up_task_check on public.follow_up_tasks;
drop function leadflow_private.check_follow_up_task();
drop index public.follow_up_tasks_deal;
alter table public.follow_up_tasks drop constraint follow_up_tasks_deal, drop constraint follow_up_tasks_contact, drop constraint follow_up_tasks_state,
  drop column "dealId", drop column "contactId", drop column "taskType", drop column priority, drop column cancelled, drop column description,
  drop column "assigneeId", drop column "createdAt", drop column "completedAt";
alter table leadflow_private.lead_contacts drop constraint lead_contacts_workspace_id;
drop table leadflow_private.client_handoffs, leadflow_private.deal_meetings, leadflow_private.deal_activities, leadflow_private.deal_stage_history,
  leadflow_private.deals, leadflow_private.sales_settings, leadflow_private.sales_stages;

-- The snapshot save as 202610310001_lead_discovery.sql defined it.
create or replace function public.save_workspace_for(target_workspace uuid, payload jsonb, expected_revision bigint, request_id uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare actor_role text; current_revision bigint; receipt public.workspace_requests; fingerprint text;
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
  delete from public.leads where workspace_id = target_workspace;
  insert into public.leads(workspace_id, id, name, email, phone, company, service, source, message, status, "createdAt",
      website, industry, address, city, region, postcode, country)
    select target_workspace, x.id, x.name, x.email, x.phone, x.company, x.service, x.source, x.message, x.status, x."createdAt",
      coalesce(x.website, ''), coalesce(x.industry, ''), coalesce(x.address, ''), coalesce(x.city, ''), coalesce(x.region, ''), coalesce(x.postcode, ''), coalesce(x.country, '')
    from jsonb_to_recordset(payload->'leads') as x(id text, name text, email text, phone text, company text, service text, source text, message text, status text, "createdAt" timestamptz,
      website text, industry text, address text, city text, region text, postcode text, country text);
  insert into public.follow_up_tasks(workspace_id, id, "leadId", due, notes, completed)
    select target_workspace, x.id, x."leadId", x.due, x.notes, x.completed
    from jsonb_to_recordset(payload->'tasks') as x(id text, "leadId" text, due date, notes text, completed boolean);
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
