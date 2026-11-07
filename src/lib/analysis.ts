import { supabase } from './supabase'
import { failure, RequestError } from './backend'
import { categories, opportunityTypes, type Category, type OpportunityType } from '../../supabase/functions/_shared/analysis/intelligence.ts'
export { categories, opportunityTypes }
export type { Category, OpportunityType }

export type AnalysisStatus = 'queued' | 'validating' | 'crawling' | 'measuring' | 'analyzing' | 'matching' | 'completed' | 'partial' | 'failed' | 'cancelled'
export type Level = 'high' | 'medium' | 'low'
export interface ProviderState { status: string; detail?: string; [key: string]: unknown }
export interface AnalysisSummary {
  id: string; leadId: string; website: string; status: AnalysisStatus; step: string | null; providers: Record<string, ProviderState>; pagesAnalyzed: number; failure: string | null
  createdAt: string; startedAt: string | null; completedAt: string | null; findingCount: number; opportunityCount: number
}
export interface Evidence { id: string; ref: string; category: string; kind: string; sourceUrl: string | null; provider: string; value: Record<string, any>; observedAt: string }
export interface Finding {
  id: string; key: string; category: Category; title: string; description: string; findingType: 'observed' | 'measured' | 'ai_interpretation' | 'hypothesis'
  severity: Level | 'info'; confidence: Level; evidenceIds: string[]; source: string; opportunityType: OpportunityType | null; recommendedAction: string; businessRelevance: string
  verificationStatus: 'unverified' | 'verified' | 'disputed'; observedAt: string
}
export type OpportunityStatus = 'suggested' | 'accepted' | 'dismissed' | 'needs_verification'
export interface Opportunity {
  id: string; opportunityType: OpportunityType; title: string; findingIds: string[]; serviceId: string | null; serviceName: string; why: string; benefit: string
  priority: Level; confidence: Level; nextAction: string; status: OpportunityStatus; notes: string; updatedAt: string
}
export interface Cited { text: string; evidenceIds: string[] }
export interface Overview {
  facts?: { name: { value: string; source: string; evidenceIds: string[] }; category: { value: string; source: string }; website: string; pages: { kind: string; url: string; title: string; evidenceId: string }[]; contact: { phones: string[]; emails: string[]; evidenceIds: string[] } }
  ai?: { summary: Cited | null; mainServices: Cited[]; audienceIndicators: Cited[]; positioning: Cited | null } | null
}
export interface Report extends AnalysisSummary {
  overview: Overview; evidence: Evidence[]; findings: Finding[]; opportunities: Opportunity[]; usage: { provider: string; quantity: number; unit: string; costUsd: number | null; at: string }[]; previousId: string | null
}
export interface AgencyService {
  id: string; name: string; description: string; category: string; targetCategories: string[]; opportunityTypes: OpportunityType[]; pricing: string; active: boolean; notes: string; starterKey: string | null; updatedAt: string
}
export interface AnalysisConfig {
  providers: { crawler: { configured: boolean; provider: 'apify' | 'native'; maxPages: number; crawlerType?: string }; apify: { configured: boolean }; pagespeed: { configured: boolean }; ai: { configured: boolean; provider?: 'gemini' | null }; technology: { configured: boolean; provider: string } }
  limits: { monthlyAnalyses: number; maxConcurrent: number; monthlyPages: number }
}
export interface UsageSummary { since: string; analyses: number; usage: { provider: string; unit: string; quantity: number; costUsd: number | null }[] }

/** A failed request with the HTTP status and the server's code ('recent' when a report is less than a day old, 'limit' for workspace limits). */
export class AnalysisRequestError extends Error {
  status: number; code: string
  constructor(message: string, status: number, code = '') { super(message); this.status = status; this.code = code }
}
const endpoint = () => { const url = import.meta.env.VITE_SUPABASE_URL; return url ? `${new URL(url).origin}/functions/v1/business-analysis` : '' }
// The browser sends its session token; the function checks membership with it. Provider keys never reach the browser.
async function invoke<T>(workspaceId: string, body: Record<string, unknown>, timeoutMs = 120000): Promise<T> {
  const { data } = await supabase!.auth.getSession()
  const token = data.session?.access_token, url = endpoint()
  if (!token || !url) throw new AnalysisRequestError('Your session has expired. Sign in again.', 401)
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '' },
      body: JSON.stringify({ workspaceId, ...body }), signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) {
    throw new AnalysisRequestError((cause as Error).name === 'TimeoutError' ? 'The analysis step is taking longer than expected. It continues in the background.' : 'We couldn’t reach LeadFlow. Check your connection and try again.', 0)
  }
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new AnalysisRequestError(typeof result.error === 'string' ? result.error : 'Business analysis isn’t available right now.', response.status, typeof result.code === 'string' ? result.code : '')
  return result as T
}
export const analysisConfig = (workspaceId: string) => invoke<AnalysisConfig>(workspaceId, { action: 'config' }, 20000)
/** Starts an analysis. A repeated request ID returns the same analysis; a running analysis for the lead is returned with existing: true. */
export const startAnalysis = (workspaceId: string, request: { leadId: string; requestId: string; force?: boolean }) =>
  invoke<{ id: string; existing: boolean }>(workspaceId, { action: 'start', ...request })
/** Runs the next due step (if any) and returns the updated report. */
// The overview is empty until the interpretation step has run.
const normalized = (report: Report): Report => ({ ...report, overview: report.overview ?? {}, providers: report.providers ?? {} })
export const advanceAnalysis = (workspaceId: string, analysisId: string) => invoke<{ report: Report }>(workspaceId, { action: 'advance', analysisId }).then(result => normalized(result.report))

async function call<T>(name: string, args: Record<string, unknown>, check: (value: unknown) => boolean = () => true): Promise<T> {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) throw failure(error)
  if (!check(data)) throw new RequestError('Unexpected response. Please contact your administrator.')
  return data as T
}
const isObject = (value: unknown) => typeof value === 'object' && value !== null
export const analysesFor = (workspaceId: string, leadId: string) => call<AnalysisSummary[]>('business_analyses_for', { target_workspace: workspaceId, target_lead: leadId }, Array.isArray)
export const analysisReport = (workspaceId: string, analysisId: string) => call<Report>('business_analysis_report', { target_workspace: workspaceId, analysis_id: analysisId }, isObject).then(normalized)
export const cancelAnalysis = (workspaceId: string, analysisId: string) => call<void>('cancel_business_analysis', { target_workspace: workspaceId, analysis_id: analysisId })
export const setOpportunityStatus = (workspaceId: string, opportunityId: string, status: OpportunityStatus | null, notes: string | null) =>
  call<void>('set_opportunity_status', { target_workspace: workspaceId, opportunity_id: opportunityId, new_status: status, new_notes: notes })
export const setFindingVerification = (workspaceId: string, findingId: string, status: Finding['verificationStatus']) =>
  call<void>('set_finding_verification', { target_workspace: workspaceId, finding_id: findingId, new_status: status })
export const analysisUsage = (workspaceId: string) => call<UsageSummary>('analysis_usage_for', { target_workspace: workspaceId }, isObject)
export const agencyServices = (workspaceId: string) => call<AgencyService[]>('agency_services_for', { target_workspace: workspaceId }, Array.isArray)
export const saveAgencyService = (workspaceId: string, service: Partial<AgencyService>) => call<AgencyService>('save_agency_service', { target_workspace: workspaceId, service }, isObject)
export const deleteAgencyService = (workspaceId: string, serviceId: string) => call<void>('delete_agency_service', { target_workspace: workspaceId, service_id: serviceId })
export const installStarterServices = (workspaceId: string) => call<number>('install_starter_services', { target_workspace: workspaceId })

export const activeStatuses: AnalysisStatus[] = ['queued', 'validating', 'crawling', 'measuring', 'analyzing', 'matching']
export const isActive = (analysis: Pick<AnalysisSummary, 'step' | 'status'>) => analysis.step !== null && activeStatuses.includes(analysis.status)
export const statusLabels: Record<AnalysisStatus, string> = {
  queued: 'Queued', validating: 'Checking the website', crawling: 'Reading pages', measuring: 'Measuring', analyzing: 'Interpreting', matching: 'Matching services',
  completed: 'Completed', partial: 'Partly completed', failed: 'Failed', cancelled: 'Cancelled',
}
export const categoryLabels: Record<Category, string> = {
  overview: 'Overview', availability: 'Availability', structure: 'Website structure', performance: 'Performance', seo: 'SEO', mobile: 'Mobile', ux: 'User experience',
  conversion: 'Contact & conversion', communication: 'Communication', technology: 'Technology', social: 'Social presence', automation: 'Automation',
}
export const opportunityLabels: Record<OpportunityType, string> = {
  website_redesign: 'Website redesign', website_development: 'Website development', seo: 'SEO', performance: 'Performance', mobile_experience: 'Mobile experience',
  conversion_optimization: 'Conversion optimization', booking_integration: 'Booking integration', ai_chatbot: 'AI chatbot', whatsapp_automation: 'WhatsApp automation',
  crm_integration: 'CRM integration', workflow_automation: 'Workflow automation', ecommerce: 'E-commerce', custom_software: 'Custom software', social_media: 'Social media',
}
export const findingTypeLabels: Record<Finding['findingType'], string> = { observed: 'Observed', measured: 'Measured', ai_interpretation: 'AI interpretation', hypothesis: 'Hypothesis' }
export const findingTypeHelp: Record<Finding['findingType'], string> = {
  observed: 'Read directly from the website’s pages or files.', measured: 'Measured by a tool such as PageSpeed Insights.',
  ai_interpretation: 'The AI’s reading of the collected evidence. Check before relying on it.', hypothesis: 'A possibility worth asking about, not a fact.',
}
export const opportunityStatusLabels: Record<OpportunityStatus, string> = { suggested: 'Suggested', accepted: 'Accepted', dismissed: 'Dismissed', needs_verification: 'Needs verification' }
const stepOrder = ['validate', 'crawl', 'crawl_wait', 'crawl_fallback', 'site_checks', 'pagespeed_mobile', 'pagespeed_desktop', 'interpret', 'match']
/** Rough progress for the status bar: the share of pipeline steps already behind the current one. */
export const progressOf = (analysis: Pick<AnalysisSummary, 'step' | 'status'>) =>
  !isActive(analysis) ? 1 : Math.max(0.04, (stepOrder.indexOf(analysis.step ?? '') + 0.5) / stepOrder.length)
