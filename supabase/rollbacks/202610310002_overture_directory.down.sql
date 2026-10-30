-- Reverses 202610310002_overture_directory.sql. Run it as one batch, then:
--   npx supabase migration repair --status reverted 202610310002
-- The loaded directory is deleted; it can be loaded again with scripts/load-overture.mjs. Leads already imported from it are kept.
drop function public.directory_load(text, jsonb), public.directory_finish_load(text, text[]), public.directory_status(),
  public.directory_search(text, text, text, text, integer, jsonb, text, jsonb, integer);
drop table leadflow_private.directory_places;
