-- Reverses 202611270002_automation.sql, after 202611270003_automation_engine.down.sql. Run it as one batch, then:
--   npx supabase migration repair --status reverted 202611270002
-- Deletes every workflow, version, run, step record, event, webhook endpoint and usage counter. Records workflows created
-- (tasks, notes, notifications, deals, projects, drafts) stay. In-app automation notifications stay; members' email
-- settings may still list "automation_alert", which M12 then ignores. Unschedule the leadflow-automation-worker Cron job
-- and remove the automation, automation-worker and automation-webhook Edge Functions separately.

-- 1. Event capture on existing tables.
drop trigger if exists automation_leads_inserted on public.leads;
drop trigger if exists automation_leads_updated on public.leads;
drop trigger if exists automation_tasks_inserted on public.follow_up_tasks;
drop trigger if exists automation_tasks_updated on public.follow_up_tasks;
drop trigger if exists automation_capture on leadflow_private.business_analyses;
drop trigger if exists automation_capture on leadflow_private.lead_contacts;
drop trigger if exists automation_capture on leadflow_private.outreach_drafts;
drop trigger if exists automation_capture on leadflow_private.deal_stage_history;
drop trigger if exists automation_capture on leadflow_private.deal_meetings;
drop trigger if exists automation_capture on leadflow_private.clients;
drop trigger if exists automation_capture on leadflow_private.client_invitations;
drop trigger if exists automation_capture on leadflow_private.client_users;
drop trigger if exists automation_capture on leadflow_private.onboarding_requests;
drop trigger if exists automation_capture on leadflow_private.onboarding_items;
drop trigger if exists automation_capture on leadflow_private.client_scope_confirmations;
drop trigger if exists automation_capture on leadflow_private.client_onboarding_completions;
drop trigger if exists automation_capture on leadflow_private.projects;
drop trigger if exists automation_capture on leadflow_private.project_milestones;
drop trigger if exists automation_capture on leadflow_private.project_deliverables;
drop trigger if exists automation_capture on leadflow_private.deliverable_reviews;
drop trigger if exists automation_capture on leadflow_private.deliverable_decisions;
drop trigger if exists automation_capture on leadflow_private.deliverable_feedback;
drop trigger if exists automation_capture on leadflow_private.project_comments;
drop trigger if exists automation_capture on leadflow_private.client_documents;
drop trigger if exists automation_capture on leadflow_private.project_updates;

-- 2. As in M12 (202611270001_client_collaboration.sql).
create or replace function leadflow_private.member_events() returns jsonb language sql immutable set search_path = '' as $$
  select '["client_activated","feedback_submitted","changes_requested","deliverable_approved","deliverable_rejected","client_commented","client_file_uploaded"]'::jsonb
$$;
create or replace function leadflow_private.member_email_defaults() returns jsonb language sql immutable set search_path = '' as $$
  select '["client_activated","feedback_submitted","changes_requested","deliverable_approved","deliverable_rejected"]'::jsonb
$$;

-- 3. Functions, then tables.
drop function if exists leadflow_private.automation_capture(), leadflow_private.automation_capture_tasks(), leadflow_private.automation_capture_leads(),
  leadflow_private.automation_count(uuid, uuid, jsonb), leadflow_private.automation_redact_secrets(text), leadflow_private.automation_sanitize_payload(jsonb),
  leadflow_private.automation_emit(uuid, text, text, text, jsonb, text[], text, text, uuid), leadflow_private.automation_wait_output(text, jsonb),
  leadflow_private.automation_deliverable_data(leadflow_private.project_deliverables), leadflow_private.automation_milestone_data(leadflow_private.project_milestones),
  leadflow_private.automation_project_ref(uuid), leadflow_private.automation_project_data(leadflow_private.projects), leadflow_private.automation_client_ref(uuid),
  leadflow_private.automation_client_data(leadflow_private.clients), leadflow_private.automation_deal_data(leadflow_private.deals), leadflow_private.automation_task_keys(public.follow_up_tasks),
  leadflow_private.automation_task_data(public.follow_up_tasks), leadflow_private.automation_lead_ref(uuid, text), leadflow_private.automation_lead_data(public.leads),
  leadflow_private.automation_track(uuid, text), leadflow_private.automation_kind_events(text), leadflow_private.automation_listens(uuid, text[]),
  leadflow_private.automation_next_fire(jsonb, text, timestamptz), leadflow_private.automation_compile(jsonb), leadflow_private.automation_compile_steps(jsonb, text, jsonb),
  leadflow_private.automation_check(jsonb, text), leadflow_private.automation_check_schedule(jsonb),
  leadflow_private.automation_check_steps(jsonb, jsonb, integer, text, jsonb, integer, integer, integer, text[], boolean), leadflow_private.automation_check_inputs(jsonb, jsonb, jsonb, text),
  leadflow_private.automation_check_template(text, jsonb, text, text), leadflow_private.automation_check_group(jsonb, jsonb, text, integer, jsonb, integer),
  leadflow_private.automation_field_at(jsonb, text), leadflow_private.automation_issue(text, text, text), leadflow_private.automation_eval_group(jsonb, jsonb, date, integer),
  leadflow_private.automation_eval_condition(jsonb, jsonb, date), leadflow_private.automation_sanitize(jsonb, integer), leadflow_private.automation_redact(text),
  leadflow_private.automation_render(text, jsonb, integer), leadflow_private.automation_text(jsonb), leadflow_private.automation_value(jsonb, text),
  leadflow_private.automation_wait_def(text), leadflow_private.automation_action_def(text), leadflow_private.automation_trigger_def(text), leadflow_private.automation_catalog(),
  leadflow_private.automation_trigger_fields(jsonb, jsonb), leadflow_private.automation_common_fields(), leadflow_private.automation_operators(), leadflow_private.automation_action_list(),
  leadflow_private.automation_waitable(), leadflow_private.automation_trigger_list(), leadflow_private.automation_entity_fields(text), leadflow_private.automation_limits();

drop table if exists leadflow_private.automation_usage_daily, leadflow_private.automation_tracking, leadflow_private.automation_entity_state, leadflow_private.automation_webhooks,
  leadflow_private.automation_run_steps, leadflow_private.automation_runs, leadflow_private.automation_events;
alter table if exists leadflow_private.automation_workflows drop constraint if exists automation_workflows_published;
drop table if exists leadflow_private.automation_versions, leadflow_private.automation_workflows, leadflow_private.automation_settings;
drop function if exists leadflow_private.automation_refuse_change();
