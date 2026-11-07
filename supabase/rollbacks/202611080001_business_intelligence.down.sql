-- Reverses 202611080001_business_intelligence.sql. Run it as one batch, then:
--   npx supabase migration repair --status reverted 202611080001
-- Deletes every analysis report, its evidence, findings and opportunities, the service catalog and the usage records.
-- Leads are not touched.
drop function public.analysis_member_role(uuid), public.agency_services_for(uuid), public.save_agency_service(uuid, jsonb), public.delete_agency_service(uuid, uuid),
  public.install_starter_services(uuid), public.business_analyses_for(uuid, text), public.business_analysis_report(uuid, uuid), public.cancel_business_analysis(uuid, uuid),
  public.set_opportunity_status(uuid, uuid, text, text), public.set_finding_verification(uuid, uuid, text), public.analysis_usage_for(uuid),
  public.start_business_analysis(uuid, uuid, text, uuid, text, boolean, jsonb), public.claim_business_analysis(uuid, integer),
  public.save_business_analysis_step(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb),
  leadflow_private.service_json(leadflow_private.agency_services), leadflow_private.analysis_summary_json(leadflow_private.business_analyses);
drop table leadflow_private.analysis_usage, leadflow_private.business_opportunities, leadflow_private.analysis_findings, leadflow_private.analysis_evidence,
  leadflow_private.business_analyses, leadflow_private.agency_services;
drop function leadflow_private.is_opportunity_type(text);
