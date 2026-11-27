-- Schedules LeadFlow's background workers (email, business analysis, contact searches and automations) with Supabase Cron. Hosted operations only: this is not a migration,
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

-- Business analyses and contact searches nobody is watching (an open report or contacts tab advances its own). Every 2 minutes;
-- each call runs due steps for about 100 seconds, analyses first.
select cron.schedule('leadflow-analysis-worker', '*/2 * * * *', $job$
  select net.http_post(
    url := 'https://fzgxpwmqzmvgmijviaar.supabase.co/functions/v1/analysis-worker',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'leadflow_worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000)
$job$);

-- Client portal and automation emails (M12, M13): every 5 minutes, offset by 2. Each call sends up to 20 queued emails.
-- Needs RESEND_API_KEY, NOTIFICATION_FROM and APP_URL; without them it claims nothing.
select cron.schedule('leadflow-portal-notifications', '2-59/5 * * * *', $job$
  select net.http_post(
    url := 'https://fzgxpwmqzmvgmijviaar.supabase.co/functions/v1/portal-notifications',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'leadflow_worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$job$);

-- Automations (M13): every minute. Each call releases expired leases, fires due schedules and scheduled checks, then
-- advances due workflow runs for about 50 seconds. Delays and waits are stored rows, so nothing sleeps between calls.
select cron.schedule('leadflow-automation-worker', '* * * * *', $job$
  select net.http_post(
    url := 'https://fzgxpwmqzmvgmijviaar.supabase.co/functions/v1/automation-worker',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'leadflow_worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$job$);

-- Inspect recent runs:
--   select jobid, status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
--   select id, status_code, left(content, 200), error_msg, created from net._http_response order by created desc limit 10;
-- Stop: select cron.unschedule('leadflow-onboarding-reminders'); select cron.unschedule('leadflow-retry-notifications'); select cron.unschedule('leadflow-analysis-worker');
--   select cron.unschedule('leadflow-automation-worker'); select cron.unschedule('leadflow-portal-notifications');
