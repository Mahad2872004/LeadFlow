-- Reverses 202611270003_automation_engine.sql. Run it as one batch, then reverse 202611270002_automation.sql with its own
-- rollback, then:
--   npx supabase migration repair --status reverted 202611270003
-- Removes the engine, the member functions, scheduled checks, webhooks receipt and templates. Workflows, runs and history
-- stay in their tables until 202611270002 is reversed. Records the workflows created (tasks, notes, notifications,
-- deals, projects, drafts) are ordinary records and stay.

drop function if exists public.automation_advance(uuid, jsonb), public.automation_complete_external(uuid, uuid, jsonb), public.automation_tick(),
  public.automation_webhook_lookup(uuid), public.automation_webhook_rejected(uuid), public.automation_receive_webhook(uuid, integer, text, jsonb), public.automation_ai_reserve(uuid, uuid, integer),
  public.automation_center_for(uuid), public.automation_overview_for(uuid), public.automation_workflows_for(uuid), public.automation_workflow_detail(uuid, uuid),
  public.automation_save_workflow(uuid, uuid, text, text, jsonb, integer, uuid), public.automation_validate(uuid, jsonb), public.automation_publish(uuid, uuid, integer, text),
  public.automation_set_status(uuid, uuid, text, integer), public.automation_restore_version(uuid, uuid, integer, integer), public.automation_duplicate(uuid, uuid, uuid),
  public.automation_delete(uuid, uuid, text), public.automation_from_template(uuid, text, uuid), public.automation_save_settings(uuid, boolean, text),
  public.automation_sample_for(uuid, text, text), public.automation_dry_run(uuid, jsonb, jsonb), public.automation_start_test(uuid, uuid, jsonb, boolean),
  public.automation_runs_for(uuid, jsonb, timestamptz, uuid, integer), public.automation_run_detail(uuid, uuid), public.automation_retry_run(uuid, uuid), public.automation_rerun(uuid, uuid, boolean),
  public.automation_cancel_run(uuid, uuid), public.automation_webhook_issue(uuid, uuid, boolean), public.automation_webhook_revoke(uuid, uuid);

drop function if exists leadflow_private.automation_run_summary(leadflow_private.automation_runs), leadflow_private.automation_lock(uuid, uuid, integer),
  leadflow_private.automation_workflow_json(leadflow_private.automation_workflows), leadflow_private.automation_templates(), leadflow_private.automation_backoff(integer),
  leadflow_private.automation_finish(uuid, text, text, text, text, text),
  leadflow_private.automation_step(leadflow_private.automation_runs, text, jsonb, text, integer, jsonb, jsonb, jsonb, text, text, timestamptz),
  leadflow_private.automation_execute(leadflow_private.automation_runs, leadflow_private.automation_versions, text, jsonb, text, date, jsonb),
  leadflow_private.automation_input_summary(jsonb, jsonb, jsonb, date), leadflow_private.automation_due(jsonb, jsonb, date), leadflow_private.automation_member(uuid, text, uuid, text, text),
  leadflow_private.automation_record_owner(uuid, text, text), leadflow_private.automation_classify(text), leadflow_private.automation_impersonate(uuid),
  leadflow_private.automation_ref_entity(text), leadflow_private.automation_key(uuid, text);
