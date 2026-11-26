import { boundedJson } from '../_shared/request.ts'
import { rpc, rpcAs, RpcError, type Runtime } from '../_shared/runtime.ts'
import { ProviderError, type AiClient } from '../_shared/analysis/providers.ts'
import { buildDraftRequest, DraftRejectedError, normalizeDraft, type Catalog } from '../_shared/automation/draft.ts'
import { advanceRuns } from '../_shared/automation/engine.ts'
import { webhookSecret } from '../_shared/automation/webhook.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const subjectOf = (token: string) => { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string } catch { return null } }
const positive = (value: string | undefined, fallback: number) => { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback }
export interface AutomationDeps { ai: AiClient | null; model: string | null }

/**
 * The Automation Center's server actions for signed-in members (M13). Workflows themselves are saved and published through
 * role-checked database functions; this function adds what needs a server secret or a provider:
 * - draft: an AI-drafted workflow for owners and admins to review in the builder (never saved or published here);
 * - webhook_secret: creates or rotates a workflow's webhook endpoint and shows its signing key once;
 * - advance: starts a live test or a retried run now instead of on the worker's next minute.
 * Every database read uses the member's own token, so membership and role are checked as for direct calls.
 */
export function createAutomationHandler(runtime: Runtime, deps: AutomationDeps) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin') ?? ''
    const allowed = (runtime.env('DISCOVERY_ALLOWED_ORIGINS') || runtime.env('PORTAL_ALLOWED_ORIGINS') || runtime.env('INQUIRY_ALLOWED_ORIGINS') || '').split(',').map(x => x.trim()).filter(Boolean)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
    const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
    if (!origin || !allowed.includes(origin)) return respond(403, { error: 'This website cannot use automations.' })
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return respond(405, { error: 'Use POST.' })
    if (!runtime.env('SUPABASE_URL') || !runtime.env('SUPABASE_SERVICE_ROLE_KEY') || !(runtime.env('SUPABASE_ANON_KEY') || runtime.env('SUPABASE_PUBLISHABLE_KEY')))
      return respond(503, { error: 'Automations aren’t available right now.' })
    const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]{20,4096})$/)?.[1]
    if (!token) return respond(401, { error: 'Sign in to use automations.' })
    let body: Record<string, unknown>
    try { body = await boundedJson(request, 8192) } catch { return respond(400, { error: 'Send a request of less than 8 KB.' }) }
    if (typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)) return respond(400, { error: 'Reload the page and try again.' })
    const workspaceId = body.workspaceId.toLowerCase(), action = String(body.action ?? ''), actor = subjectOf(token)
    const asUser = async <T>(name: string, args: Record<string, unknown>): Promise<T | Response> => {
      try { return await rpcAs<T>(runtime, token, name, args) } catch (error) {
        if (error instanceof RpcError && error.code === '401') return respond(401, { error: 'Your session has expired. Sign in again.' })
        if (error instanceof RpcError && error.code === '42501') return respond(403, { error: error.detail || 'You don’t have access to this workspace.' })
        if (error instanceof RpcError && error.code === 'P0002') return respond(404, { error: error.detail || 'Not found.' })
        if (error instanceof RpcError && ['22023', '55000', 'P0409'].includes(error.code)) return respond(422, { error: error.detail })
        return respond(503, { error: 'We couldn’t reach LeadFlow. Try again in a minute.' })
      }
    }
    const center = await asUser<{ role: string; catalog: Catalog }>('automation_center_for', { target_workspace: workspaceId })
    if (center instanceof Response) return center
    const manager = center.role === 'owner' || center.role === 'admin'
    const monthlyLimit = positive(runtime.env('PROJECT_AI_MONTHLY_LIMIT'), 200)
    const supabaseUrl = runtime.env('SUPABASE_URL')!.replace(/\/+$/, '')

    if (action === 'config') return respond(200, { ai: !!deps.ai, model: deps.ai ? deps.model : null, monthlyLimit, webhooks: (runtime.env('EMAIL_HASH_SECRET') ?? '').length >= 32,
      webhookUrl: `${supabaseUrl}/functions/v1/automation-webhook` })

    if (!manager) return respond(403, { error: 'Only workspace owners and admins can do this.' })

    if (action === 'draft') {
      const description = typeof body.description === 'string' ? body.description.trim() : ''
      if (description.length < 10 || description.length > 1000) return respond(422, { error: 'Describe the automation in 10 to 1,000 characters.' })
      if (!deps.ai) return respond(503, { error: 'The AI workflow assistant isn’t set up. Add a Gemini API key (GEMINI_API_KEY) to the Edge Function secrets.', code: 'not_configured' })
      if (!actor) return respond(401, { error: 'Sign in again.' })
      if (!await rpc<boolean>(runtime, 'inquiry_rate_limit', { bucket_key: `automation-ai-${workspaceId}` }).catch(() => false)) return respond(429, { error: 'Too many requests this minute. Try again shortly.', code: 'rate_limited' })
      try { await rpc(runtime, 'automation_ai_reserve', { target_workspace: workspaceId, actor, monthly_limit: monthlyLimit }) } catch (error) {
        if (error instanceof RpcError && error.code === 'P0429') return respond(429, { error: error.detail, code: 'limit' })
        if (error instanceof RpcError && error.code === '42501') return respond(403, { error: error.detail })
        return respond(503, { error: 'We couldn’t reach LeadFlow. Try again in a minute.' })
      }
      const usage = (inputTokens: number, outputTokens: number, status: 'ok' | 'failed', detail = '') => [
        { provider: 'gemini', operation: 'automation_build', quantity: inputTokens, unit: 'input_tokens', status, detail },
        { provider: 'gemini', operation: 'automation_build', quantity: outputTokens, unit: 'output_tokens', status, detail }]
      const aiRequest = buildDraftRequest(center.catalog, description), started = Date.now()
      let answer
      for (let attempt = 1; ; attempt++) {
        try { answer = await deps.ai(aiRequest); break } catch (error) {
          const failure = error instanceof ProviderError ? error : new ProviderError('failed', 'The AI service failed.')
          await rpc(runtime, 'record_outreach_usage', { target_workspace: workspaceId, actor, usage: [{ provider: 'gemini', operation: 'automation_build', quantity: 0, unit: 'failures', status: 'failed', detail: failure.kind }] }).catch(() => {})
          if (attempt === 1 && ['timeout', 'unavailable'].includes(failure.kind) && Date.now() - started < 60_000) continue
          return respond(failure.kind === 'rate_limited' ? 429 : 502, { error: `${failure.message} Nothing was created.`, code: failure.kind })
        }
      }
      let proposal
      try { proposal = normalizeDraft(answer.output, center.catalog) } catch (error) {
        await rpc(runtime, 'record_outreach_usage', { target_workspace: workspaceId, actor, usage: usage(answer.inputTokens, answer.outputTokens, 'failed', 'rejected') }).catch(() => {})
        return respond(422, { error: error instanceof DraftRejectedError ? error.message : 'The AI returned an unusable answer. Try again.', code: 'rejected' })
      }
      const validation = await asUser<{ valid: boolean; issues: unknown[] }>('automation_validate', { target_workspace: workspaceId, definition: proposal.definition })
      if (validation instanceof Response) return validation
      await rpc(runtime, 'record_outreach_usage', { target_workspace: workspaceId, actor, usage: usage(answer.inputTokens, answer.outputTokens, 'ok') }).catch(() => {})
      console.log(`automation draft ${workspaceId} ${validation.valid ? 'valid' : 'issues'}`)
      return respond(200, { ...proposal, validation, model: answer.model, generatedAt: new Date().toISOString(),
        note: 'Review this draft. Nothing was saved, published or sent; consequential steps need your confirmation in the builder.' })
    }

    if (action === 'webhook_secret') {
      if (typeof body.workflowId !== 'string' || !uuid.test(body.workflowId)) return respond(400, { error: 'Reload the page and try again.' })
      const serverSecret = runtime.env('EMAIL_HASH_SECRET') ?? ''
      if (serverSecret.length < 32) return respond(503, { error: 'Webhooks need the EMAIL_HASH_SECRET Edge Function secret (32+ characters).', code: 'not_configured' })
      const issued = await asUser<{ id: string; version: number }>('automation_webhook_issue', { target_workspace: workspaceId, target_workflow: body.workflowId, rotate: body.rotate === true })
      if (issued instanceof Response) return issued
      return respond(200, { id: issued.id, version: issued.version, secret: await webhookSecret(serverSecret, issued.id, issued.version), url: `${supabaseUrl}/functions/v1/automation-webhook`,
        note: 'Copy the signing key now: it isn’t shown again. Rotating it makes this key stop working.' })
    }

    if (action === 'advance') {
      if (typeof body.runId !== 'string' || !uuid.test(body.runId)) return respond(400, { error: 'Reload the page and try again.' })
      // Reading the run as the member proves it belongs to this workspace.
      const before = await asUser<Record<string, unknown>>('automation_run_detail', { target_workspace: workspaceId, target_run: body.runId })
      if (before instanceof Response) return before
      try { await advanceRuns(runtime, deps.ai, 40_000, body.runId, 20) } catch { /* The worker continues it. */ }
      const after = await asUser<Record<string, unknown>>('automation_run_detail', { target_workspace: workspaceId, target_run: body.runId })
      return after instanceof Response ? after : respond(200, after)
    }
    return respond(400, { error: 'Unknown action.' })
  }
}
