-- Schedules LeadFlow's email workers with Supabase Cron. Hosted operations only: this is not a migration,
-- because local tests run without pg_cron. Safe to re-run: cron.schedule replaces a job with the same name.
-- Prerequisite: a Vault secret named leadflow_worker_secret holding the same value as the Edge Function
-- secret NOTIFICATION_WORKER_SECRET (docs/CLIENT-ONBOARDING.md#reminder-scheduler). No secret is stored here.
-- Applied to project fzgxpwmqzmvgmijviaar on 25 October 2026.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Every 15 minutes. Each worker handles a bounded batch per call; the database decides what is due.
select cron.schedule('leadflow-onboarding-reminders', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://fzgxpwmqzmvgmijviaar.supabase.co/functions/v1/onboarding-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'leadflow_worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$job$);
-- Offset by 7 minutes so the two workers don't start together.
select cron.schedule('leadflow-retry-notifications', '7,22,37,52 * * * *', $job$
  select net.http_post(
    url := 'https://fzgxpwmqzmvgmijviaar.supabase.co/functions/v1/retry-notifications',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'leadflow_worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$job$);

-- Inspect recent runs:
--   select jobid, status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
--   select id, status_code, left(content, 200), error_msg, created from net._http_response order by created desc limit 10;
-- Stop: select cron.unschedule('leadflow-onboarding-reminders'); select cron.unschedule('leadflow-retry-notifications');
