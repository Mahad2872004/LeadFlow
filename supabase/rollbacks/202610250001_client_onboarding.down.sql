-- Reverses 202610250001_client_onboarding.sql. Run it before the earlier rollbacks, as one batch, then:
--   npx supabase migration repair --status reverted 202610250001
-- This permanently deletes every onboarding template, request, client response, link, reminder record,
-- activity event and handoff. Export them first if they matter. Leads and everything else are kept.
drop function public.onboarding_overview_for(uuid), public.onboarding_request_for(uuid, uuid), public.onboarding_template_for(uuid, uuid),
  public.install_starter_templates(uuid), public.save_onboarding_template(uuid, jsonb, integer, uuid), public.set_onboarding_template_archived(uuid, uuid, boolean),
  public.create_onboarding_request(uuid, jsonb, uuid), public.update_onboarding_request(uuid, uuid, jsonb, integer),
  public.save_onboarding_item(uuid, uuid, jsonb, integer), public.remove_onboarding_item(uuid, uuid, uuid, integer),
  public.set_onboarding_status(uuid, uuid, text, integer, text), public.review_onboarding_item(uuid, uuid, uuid, text, text, integer),
  public.issue_onboarding_link(uuid, uuid, integer, boolean), public.revoke_onboarding_links(uuid, uuid, uuid), public.hand_off_onboarding(uuid, uuid, text),
  public.portal_open(text), public.portal_save_item(text, uuid, jsonb, boolean, integer),
  public.claim_onboarding_reminder(text, text), public.finish_onboarding_reminder(uuid, uuid, text, text, text);
drop function leadflow_private.portal_view(uuid, leadflow_private.onboarding_links), leadflow_private.portal_link(text),
  leadflow_private.onboarding_starter_items(text), leadflow_private.write_onboarding_details(uuid, jsonb),
  leadflow_private.require_open_onboarding(leadflow_private.onboarding_requests), leadflow_private.lock_onboarding_request(uuid, uuid, integer),
  leadflow_private.cancel_onboarding_reminders(uuid, text), leadflow_private.refresh_onboarding(uuid),
  leadflow_private.onboarding_event(uuid, uuid, text, uuid, text, jsonb), leadflow_private.onboarding_readiness(uuid),
  leadflow_private.onboarding_clean_response(text, jsonb, jsonb, boolean), leadflow_private.onboarding_clean_item(jsonb),
  leadflow_private.onboarding_clean_date(text, text), leadflow_private.onboarding_clean_text(text, text, integer, boolean, boolean);
drop table leadflow_private.onboarding_handoffs, leadflow_private.onboarding_events, leadflow_private.onboarding_reminders,
  leadflow_private.onboarding_links, leadflow_private.onboarding_items, leadflow_private.onboarding_requests,
  leadflow_private.onboarding_template_items, leadflow_private.onboarding_templates;
drop function leadflow_private.is_onboarding_service(text);
