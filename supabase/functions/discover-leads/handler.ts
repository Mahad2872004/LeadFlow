import { boundedJson } from '../_shared/request.ts'
import { rpc, rpcAs, RpcError, type Runtime } from '../_shared/runtime.ts'
import { discoveryProviders } from '../_shared/discovery/registry.ts'
import { CriteriaError, parseCriteria, ProviderError, type DiscoveryProvider, type ProviderContext } from '../_shared/discovery/types.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/**
 * Lead discovery for signed-in workspace members. The browser's access token is passed to the database, which
 * checks membership and quotas and records the search; this function then queries the provider server-side,
 * so provider settings never reach the browser. Results are returned, not stored: a user imports the ones
 * they want through import_leads.
 */
export function createDiscoveryHandler(runtime: Runtime, providers: DiscoveryProvider[] = discoveryProviders, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin') ?? ''
    const allowed = (runtime.env('DISCOVERY_ALLOWED_ORIGINS') || runtime.env('PORTAL_ALLOWED_ORIGINS') || runtime.env('INQUIRY_ALLOWED_ORIGINS') || '').split(',').map(x => x.trim()).filter(Boolean)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
    const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
    if (!origin || !allowed.includes(origin)) return respond(403, { error: 'This website cannot use lead discovery.' })
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return respond(405, { error: 'Use POST.' })
    if (!runtime.env('SUPABASE_URL') || !runtime.env('SUPABASE_SERVICE_ROLE_KEY') || !(runtime.env('SUPABASE_ANON_KEY') || runtime.env('SUPABASE_PUBLISHABLE_KEY')))
      return respond(503, { error: 'Lead discovery is not available right now. Please try again later.' })
    const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]{20,4096})$/)?.[1]
    if (!token) return respond(401, { error: 'Sign in to search for businesses.' })
    let body: Record<string, unknown>
    try { body = await boundedJson(request) } catch { return respond(400, { error: 'Send a search of less than 16 KB.' }) }

    const context: ProviderContext = {
      env: runtime.env, fetch: runtime.fetch, sleep,
      rpc: (name, args) => rpc(runtime, name, args),
      rateSlot: bucket => rpc<boolean>(runtime, 'inquiry_rate_limit', { bucket_key: bucket }),
      cachedPlace: key => rpc<Record<string, unknown> | null>(runtime, 'discovery_place', { query_key: key }),
      rememberPlace: async (key, place) => { await rpc(runtime, 'remember_discovery_place', { query_key: key, place }) },
    }
    // Names of missing settings or data, never values. A failed readiness check counts as not ready.
    const missingFor = async (provider: DiscoveryProvider) => {
      const missing = provider.missingConfiguration(runtime.env)
      if (missing.length || !provider.checkReady) return missing
      try { return await provider.checkReady(context) } catch { return ['a reachable directory'] }
    }
    // Which providers exist, whether each is ready, and what each can do.
    if (body.action === 'status') {
      return respond(200, { providers: await Promise.all(providers.map(async provider => {
        const missing = await missingFor(provider)
        return { id: provider.id, label: provider.label, configured: missing.length === 0, missing, capabilities: provider.capabilities }
      })) })
    }
    if (body.action !== 'search') return respond(400, { error: 'Unknown action.' })
    if (typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId) || typeof body.searchId !== 'string' || !uuid.test(body.searchId))
      return respond(400, { error: 'Reload the page and try again.' })
    const provider = providers.find(item => item.id === body.provider)
    if (!provider) return respond(422, { error: 'Choose a discovery source.' })
    let criteria
    try { criteria = parseCriteria(body.criteria, provider.capabilities) } catch (error) {
      if (error instanceof CriteriaError) return respond(422, { error: error.message })
      throw error
    }
    if ((await missingFor(provider)).length) return respond(503, { error: `${provider.label} discovery has not been set up for this LeadFlow deployment yet. Ask your administrator to configure it.`, code: 'not_configured' })
    if (body.cursor !== undefined && body.cursor !== null && (typeof body.cursor !== 'string' || body.cursor.length > 500 || provider.capabilities.pagination === 'none'))
      return respond(400, { error: 'This source has no further pages.' })
    const searchId = body.searchId.toLowerCase()

    try {
      await rpcAs(runtime, token, 'start_discovery_search', { target_workspace: body.workspaceId, search_id: searchId, provider: provider.id, criteria })
    } catch (error) {
      if (error instanceof RpcError) {
        if (error.code === '401') return respond(401, { error: 'Your session has expired. Sign in again to search.' })
        if (error.code === '42501') return respond(403, { error: 'You don’t have access to this workspace.' })
        if (error.code === 'P0429') return respond(429, { error: error.detail || 'Search limit reached. Wait a few minutes before searching again.', retryAfter: 60 })
        if (error.code === '23505') return respond(409, { error: 'This search was already started. Start a new search.' })
      }
      return respond(503, { error: 'We couldn’t start the search. Check your connection and try again.' })
    }

    const finish = (outcome: 'completed' | 'failed', count: number | null, truncated: boolean, failure: string | null) =>
      rpc(runtime, 'finish_discovery_search', { search_id: searchId, outcome, result_count: count, truncated, failure }).catch(() => { /* History shows it as interrupted. */ })
    try {
      const outcome = await provider.search(context, criteria, typeof body.cursor === 'string' ? body.cursor : null)
      await finish('completed', outcome.results.length, outcome.truncated, null)
      return respond(200, { searchId, provider: provider.id, fetchedAt: new Date().toISOString(), criteria, ...outcome, attribution: provider.capabilities.attribution })
    } catch (error) {
      const failure = error instanceof ProviderError ? error.kind : 'internal'
      await finish('failed', null, false, failure)
      // Logs carry the search ID, failure type and the provider message (service and HTTP status): no criteria, results, tokens or settings.
      console.error(`discover-leads ${searchId} failed: ${failure}${error instanceof ProviderError ? ` (${error.message})` : ""}`)
      if (error instanceof ProviderError) {
        if (error.kind === 'location_not_found') return respond(422, { error: error.message, searchId })
        if (error.kind === 'rate_limited') return respond(429, { error: error.message, retryAfter: error.retryAfter ?? 60, searchId })
        if (error.kind === 'bad_response') return respond(502, { error: error.message, searchId })
        return respond(503, { error: error.message, searchId })
      }
      return respond(503, { error: 'The search could not be completed. Please try again.', searchId })
    }
  }
}
