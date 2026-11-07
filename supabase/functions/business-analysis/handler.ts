import { boundedJson } from '../_shared/request.ts'
import { rpc, rpcAs, RpcError, type Runtime } from '../_shared/runtime.ts'
import { advanceAnalysis, type PipelineDeps } from '../_shared/analysis/pipeline.ts'
import { apifyConfig } from '../_shared/analysis/providers.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const subjectOf = (token: string) => { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string } catch { return null } }
const positive = (value: string | undefined, fallback: number) => { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback }

/**
 * Business analysis for signed-in workspace members. Every action first checks membership with the caller's own token;
 * provider keys stay in this function. Analyses run as a sequence of short steps: "start" runs the first one, and while
 * the report is open the browser calls "advance" to run the next due step. The analysis-worker function continues
 * analyses nobody is watching. Logs carry analysis IDs, steps and outcomes only.
 */
export function createAnalysisHandler(runtime: Runtime, deps: PipelineDeps) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin') ?? ''
    const allowed = (runtime.env('DISCOVERY_ALLOWED_ORIGINS') || runtime.env('PORTAL_ALLOWED_ORIGINS') || runtime.env('INQUIRY_ALLOWED_ORIGINS') || '').split(',').map(x => x.trim()).filter(Boolean)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
    const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
    if (!origin || !allowed.includes(origin)) return respond(403, { error: 'This website cannot use business analysis.' })
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return respond(405, { error: 'Use POST.' })
    if (!runtime.env('SUPABASE_URL') || !runtime.env('SUPABASE_SERVICE_ROLE_KEY') || !(runtime.env('SUPABASE_ANON_KEY') || runtime.env('SUPABASE_PUBLISHABLE_KEY')))
      return respond(503, { error: 'Business analysis isn’t available right now.' })
    const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]{20,4096})$/)?.[1]
    if (!token) return respond(401, { error: 'Sign in to analyze businesses.' })
    let body: Record<string, unknown>
    try { body = await boundedJson(request) } catch { return respond(400, { error: 'Send a request of less than 16 KB.' }) }
    if (typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)) return respond(400, { error: 'Reload the page and try again.' })
    const workspaceId = body.workspaceId.toLowerCase()
    const asUser = async <T>(name: string, args: Record<string, unknown>): Promise<T | Response> => {
      try { return await rpcAs<T>(runtime, token, name, args) } catch (error) {
        if (error instanceof RpcError && error.code === '401') return respond(401, { error: 'Your session has expired. Sign in again.' })
        if (error instanceof RpcError && error.code === '42501') return respond(403, { error: 'You don’t have access to this workspace.' })
        if (error instanceof RpcError && error.code === 'P0002') return respond(404, { error: error.detail || 'Not found.' })
        return respond(503, { error: 'We couldn’t reach LeadFlow. Try again in a minute.' })
      }
    }
    const role = await asUser<string>('analysis_member_role', { target_workspace: workspaceId })
    if (role instanceof Response) return role

    if (body.action === 'config') {
      // Which capabilities are available, so the report can say what's missing instead of showing empty sections.
      const apify = apifyConfig(runtime.env)
      return respond(200, { providers: {
        crawler: apify ? { configured: true, provider: 'apify', maxPages: apify.maxPages, crawlerType: apify.crawlerType } : { configured: true, provider: 'native', maxPages: positive(runtime.env('ANALYSIS_MAX_PAGES'), 10) },
        apify: { configured: !!apify }, pagespeed: { configured: !!(runtime.env('GOOGLE_PAGESPEED_API_KEY') ?? '').trim() }, ai: { configured: !!deps.ai, provider: deps.ai ? 'gemini' : null },
        technology: { configured: true, provider: 'native signatures' },
      }, limits: { monthlyAnalyses: positive(runtime.env('ANALYSIS_MONTHLY_LIMIT'), 30), maxConcurrent: positive(runtime.env('ANALYSIS_MAX_CONCURRENT'), 2), monthlyPages: positive(runtime.env('ANALYSIS_MONTHLY_PAGE_LIMIT'), 500) } })
    }

    if (body.action === 'start') {
      if (typeof body.leadId !== 'string' || !body.leadId || body.leadId.length > 200 || typeof body.requestId !== 'string' || !uuid.test(body.requestId)) return respond(400, { error: 'Reload the page and try again.' })
      const website = typeof body.website === 'string' ? body.website.trim().slice(0, 300) : ''
      let started: { id: string; existing: boolean }
      try {
        started = await rpc(runtime, 'start_business_analysis', { target_workspace: workspaceId, actor: subjectOf(token), target_lead: body.leadId, request_id: body.requestId, website_override: website || null,
          force: body.force === true, limits: { monthlyAnalyses: positive(runtime.env('ANALYSIS_MONTHLY_LIMIT'), 30), maxConcurrent: positive(runtime.env('ANALYSIS_MAX_CONCURRENT'), 2), recentHours: positive(runtime.env('ANALYSIS_RECENT_HOURS'), 24) } })
      } catch (error) {
        if (error instanceof RpcError && ['22023', 'P0002'].includes(error.code)) return respond(422, { error: error.detail })
        if (error instanceof RpcError && error.code === 'P0409') return respond(409, { error: error.detail, code: 'recent' })
        if (error instanceof RpcError && error.code === 'P0429') return respond(429, { error: error.detail, code: 'limit' })
        return respond(503, { error: 'The analysis couldn’t be started. Try again.' })
      }
      if (!started.existing) await advanceAnalysis(runtime, deps, started.id).catch(() => null)
      return respond(200, started)
    }

    if (body.action === 'advance') {
      if (typeof body.analysisId !== 'string' || !uuid.test(body.analysisId)) return respond(400, { error: 'Reload the page and try again.' })
      // The report check proves the analysis belongs to this workspace before any step runs.
      const report = await asUser<{ step: string | null }>('business_analysis_report', { target_workspace: workspaceId, analysis_id: body.analysisId })
      if (report instanceof Response) return report
      if (report.step) {
        const allowedNow = await rpc<boolean>(runtime, 'inquiry_rate_limit', { bucket_key: `analysis-${workspaceId}` }).catch(() => false)
        if (allowedNow) await advanceAnalysis(runtime, deps, body.analysisId).catch(() => null)
        const fresh = await asUser<Record<string, unknown>>('business_analysis_report', { target_workspace: workspaceId, analysis_id: body.analysisId })
        return fresh instanceof Response ? fresh : respond(200, { report: fresh })
      }
      return respond(200, { report })
    }
    return respond(400, { error: 'Unknown action.' })
  }
}
