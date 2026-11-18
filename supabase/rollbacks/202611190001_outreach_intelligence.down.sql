-- Reverses 202611190001_outreach_intelligence.sql. Run it as one batch, then:
--   npx supabase migration repair --status reverted 202611190001
-- Deletes every contact, contact source, channel, deletion record, contact search, outreach draft and version, the outreach
-- settings and the usage records. Leads, business reports and Apollo data are not touched.
drop function public.lead_contacts_for(uuid, text), public.save_lead_contact(uuid, text, jsonb), public.set_lead_contact_flags(uuid, uuid, jsonb),
  public.resolve_contact_suggestion(uuid, uuid, text, text, boolean), public.delete_lead_contact(uuid, uuid), public.delete_lead_contact_data(uuid, text),
  public.add_apollo_people_as_contacts(uuid, text, jsonb), public.cancel_contact_discovery(uuid, uuid), public.outreach_preferences_for(uuid), public.save_outreach_preferences(uuid, text, jsonb),
  public.outreach_drafts_for(uuid, text), public.outreach_draft_versions(uuid, uuid), public.save_outreach_draft(uuid, uuid, integer, text, text, text),
  public.restore_outreach_draft_version(uuid, uuid, integer, integer), public.set_outreach_draft_status(uuid, uuid, text), public.duplicate_outreach_draft(uuid, uuid, uuid),
  public.delete_outreach_draft(uuid, uuid), public.outreach_usage_for(uuid),
  public.start_contact_discovery(uuid, uuid, text, uuid, text, jsonb, boolean, jsonb), public.claim_contact_discovery(uuid, integer),
  public.save_contact_discovery_step(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb), public.outreach_context(uuid, uuid, text, jsonb, jsonb),
  public.save_generated_draft(uuid, uuid, text, uuid, uuid, integer, boolean, jsonb, jsonb), public.record_outreach_usage(uuid, uuid, jsonb),
  leadflow_private.merge_contact(uuid, text, jsonb, uuid), leadflow_private.merge_decision(text, text, text, boolean, text[]),
  leadflow_private.contact_json(leadflow_private.lead_contacts), leadflow_private.contact_job_json(leadflow_private.contact_discovery_jobs),
  leadflow_private.draft_json(leadflow_private.outreach_drafts), leadflow_private.outreach_preferences_json(uuid, uuid), leadflow_private.preference_row_json(leadflow_private.outreach_preferences);
drop table leadflow_private.outreach_usage, leadflow_private.outreach_draft_versions, leadflow_private.outreach_drafts, leadflow_private.outreach_preferences,
  leadflow_private.contact_discovery_jobs, leadflow_private.contact_suppressions, leadflow_private.lead_channels, leadflow_private.lead_contact_sources, leadflow_private.lead_contacts;
drop function leadflow_private.contact_key_hashes(text, text, text, text, text, text), leadflow_private.contact_hash(text), leadflow_private.name_key(text),
  leadflow_private.role_for_title(text), leadflow_private.is_contact_role(text);
