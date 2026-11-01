-- Reverses 202611010003_apollo_saved_results.sql, then:
--   npx supabase migration repair --status reverted 202611010003
-- Saved result pages are deleted; searches go back to Apollo every time.
drop function public.apollo_saved_result(uuid, text), public.apollo_save_result(uuid, text, text, jsonb, integer, integer, text, jsonb);
drop table leadflow_private.apollo_saved_results;
