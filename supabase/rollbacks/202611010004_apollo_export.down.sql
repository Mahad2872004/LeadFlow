-- Reverses 202611010004_apollo_export.sql, then:
--   npx supabase migration repair --status reverted 202611010004
drop function public.apollo_export(uuid, text, integer);
