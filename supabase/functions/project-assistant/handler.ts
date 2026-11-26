import { boundedJson } from '../_shared/request.ts'
import { rpc, rpcAs, RpcError, type Runtime } from '../_shared/runtime.ts'
import { ProviderError, type AiClient, type AiRequest } from '../_shared/analysis/providers.ts'
import { AnswerRejected, buildRequest, contextFacts, validateAnswer, type AssistantOperation, type ProjectContext } from '../_shared/projects/assistant.ts'
import { buildCollabRequest, collabFacts, collabOperations, validateCollabAnswer, type CollabContext } from '../_shared/projects/collaboration.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const subjectOf = (token: string) => { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string } catch { return null } }
const positive = (value: string | undefined, fallback: number) => { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback }
const operations: AssistantOperation[] = ['plan', 'breakdown', 'summary', 'risks']
export interface AssistantDeps { ai: AiClient | null; model: string | null }

/**
 * The project assistant for signed-in workspace members (M11). It reads the project as the member (their own token, so
 * the database checks access), asks the AI for a summary, risks, a plan or a task breakdown, validates the answer and
 * returns it as a suggestion. It never writes project records: plans are applied by the app after the member approves
 * them. M12 adds client-collaboration help (feedback summaries, reply drafts, review preparation, discussion summaries):
 * also suggestions only, never sent to the client. Each request counts against PROJECT_AI_MONTHLY_LIMIT in the AI usage
 * ledger. Logs carry IDs and outcomes only.
 */
export function createProjectAssistantHandler(runtime: Runtime, deps: AssistantDeps) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin') ?? ''
    const allowed = (runtime.env('DISCOVERY_ALLOWED_ORIGINS') || runtime.env('PORTAL_ALLOWED_ORIGINS') || runtime.env('INQUIRY_ALLOWED_ORIGINS') || '').split(',').map(x => x.trim()).filter(Boolean)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
    const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
    if (!origin || !allowed.includes(origin)) return respond(403, { error: 'This website cannot use the project assistant.' })
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return respond(405, { error: 'Use POST.' })
    if (!runtime.env('SUPABASE_URL') || !runtime.env('SUPABASE_SERVICE_ROLE_KEY') || !(runtime.env('SUPABASE_ANON_KEY') || runtime.env('SUPABASE_PUBLISHABLE_KEY')))
      return respond(503, { error: 'The project assistant isn’t available right now.' })
    const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]{20,4096})$/)?.[1]
    if (!token) return respond(401, { error: 'Sign in to use the project assistant.' })
    let body: Record<string, unknown>
    try { body = await boundedJson(request, 8192) } catch { return respond(400, { error: 'Send a request of less than 8 KB.' }) }
    if (typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)) return respond(400, { error: 'Reload the page and try again.' })
    const workspaceId = body.workspaceId.toLowerCase(), action = String(body.action ?? ''), actor = subjectOf(token)
    const asUser = async <T>(name: string, args: Record<string, unknown>): Promise<T | Response> => {
      try { return await rpcAs<T>(runtime, token, name, args) } catch (error) {
        if (error instanceof RpcError && error.code === '401') return respond(401, { error: 'Your session has expired. Sign in again.' })
        if (error instanceof RpcError && error.code === '42501') return respond(403, { error: 'You don’t have access to this workspace.' })
        if (error instanceof RpcError && error.code === 'P0002') return respond(404, { error: error.detail || 'Not found.' })
        if (error instanceof RpcError && error.code === '22023') return respond(422, { error: error.detail })
        return respond(503, { error: 'We couldn’t reach LeadFlow. Try again in a minute.' })
      }
    }
    const role = await asUser<string>('analysis_member_role', { target_workspace: workspaceId })
    if (role instanceof Response) return role
    const monthlyLimit = positive(runtime.env('PROJECT_AI_MONTHLY_LIMIT'), 200)
    if (action === 'config') return respond(200, { configured: !!deps.ai, model: deps.ai ? deps.model : null, monthlyLimit })

    const operation = operations.find(item => item === action), collab = collabOperations.find(item => item === action)
    if (!operation && !collab) return respond(400, { error: 'Unknown action.' })
    if (typeof body.projectId !== 'string' || !uuid.test(body.projectId) || !actor) return respond(400, { error: 'Reload the page and try again.' })
    const deliverableId = typeof body.deliverableId === 'string' && uuid.test(body.deliverableId) ? body.deliverableId : null
    const feedbackId = typeof body.feedbackId === 'string' && uuid.test(body.feedbackId) ? body.feedbackId : null
    if (operation === 'breakdown' && !deliverableId) return respond(400, { error: 'Choose the deliverable to break into tasks.' })
    if (collab === 'review_prep' && !deliverableId) return respond(400, { error: 'Choose the deliverable to prepare the review for.' })
    if (collab === 'response_draft' && !feedbackId) return respond(400, { error: 'Choose the feedback item to reply to.' })
    if (!deps.ai) return respond(503, { error: 'The AI assistant isn’t set up. Add a Gemini API key (GEMINI_API_KEY) to the Edge Function secrets.', code: 'not_configured' })
    const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : ''
    const name = operation ?? collab!

    // Reads first (as the member), then the per-minute limit and the monthly reservation, then one AI call (retried once
    // on a timeout or outage). Every outcome is recorded in the usage ledger; nothing is written to the project.
    let prepared: { aiRequest: AiRequest; check: (output: unknown) => Record<string, unknown> }
    if (operation) {
      const context = await asUser<ProjectContext>('project_ai_context', { target_workspace: workspaceId, target_project: body.projectId, target_deliverable: deliverableId })
      if (context instanceof Response) return context
      let template: unknown
      if (operation === 'plan' && typeof body.templateId === 'string' && uuid.test(body.templateId)) {
        const loaded = await asUser<{ name: string; milestones: unknown[] }>('project_template_for', { target_workspace: workspaceId, target_template: body.templateId })
        if (loaded instanceof Response) return loaded
        template = { name: loaded.name, milestones: loaded.milestones }
      }
      const facts = contextFacts(context)
      prepared = { aiRequest: buildRequest(operation, context, facts, { template, instructions }), check: output => validateAnswer(operation, output, context, facts) }
    } else {
      // M12: the project's shared deliverables, feedback, decisions and comments (internal comments never reach a reply draft).
      const context = await asUser<CollabContext>('project_collab_ai_context', { target_workspace: workspaceId, target_project: body.projectId,
        target_deliverable: collab === 'response_draft' ? null : deliverableId })
      if (context instanceof Response) return context
      if (feedbackId && !context.deliverables.some(d => d.feedback.some(f => f.id === feedbackId))) return respond(404, { error: 'Feedback not found in this project.' })
      if (!context.deliverables.length && !context.comments.length) return respond(422, { error: 'There’s no shared deliverable, client feedback or discussion yet to work from.' })
      const facts = collabFacts(context, collab!)
      prepared = { aiRequest: buildCollabRequest(collab!, context, facts, { feedbackId, instructions }), check: output => {
        const { result, warnings } = validateCollabAnswer(collab!, output, facts)
        return { operation: collab, facts: facts.map(({ id, label, value }) => ({ id, label, value })), warnings, ...result }
      } }
    }
    if (!await rpc<boolean>(runtime, 'inquiry_rate_limit', { bucket_key: `project-ai-${workspaceId}` }).catch(() => false)) return respond(429, { error: 'Too many assistant requests this minute. Try again shortly.', code: 'rate_limited' })
    try { await rpc(runtime, 'project_ai_reserve', { target_workspace: workspaceId, actor, operation: `project_${name}`, monthly_limit: monthlyLimit }) } catch (error) {
      if (error instanceof RpcError && error.code === 'P0429') return respond(429, { error: error.detail, code: 'limit' })
      if (error instanceof RpcError && error.code === '42501') return respond(403, { error: 'You don’t have access to this workspace.' })
      return respond(503, { error: 'We couldn’t reach LeadFlow. Try again in a minute.' })
    }
    const usage = (inputTokens: number, outputTokens: number, status: 'ok' | 'failed', detail = '') => [
      { provider: 'gemini', operation: `project_${name}`, quantity: inputTokens, unit: 'input_tokens', status, detail },
      { provider: 'gemini', operation: `project_${name}`, quantity: outputTokens, unit: 'output_tokens', status, detail }]
    const started = Date.now()
    let answer
    for (let attempt = 1; ; attempt++) {
      try { answer = await deps.ai(prepared.aiRequest); break } catch (error) {
        const failure = error instanceof ProviderError ? error : new ProviderError('failed', 'The AI service failed.')
        await rpc(runtime, 'record_outreach_usage', { target_workspace: workspaceId, actor, usage: [{ provider: 'gemini', operation: `project_${name}`, quantity: 0, unit: 'failures', status: 'failed', detail: failure.kind }] }).catch(() => {})
        console.log(`project-assistant ${name} attempt ${attempt} failed ${failure.kind}`)
        if (attempt === 1 && ['timeout', 'unavailable'].includes(failure.kind) && Date.now() - started < 60_000) continue
        return respond(failure.kind === 'rate_limited' ? 429 : 502, { error: `${failure.message} Nothing was changed.`, code: failure.kind })
      }
    }
    try {
      const checked = prepared.check(answer.output)
      await rpc(runtime, 'record_outreach_usage', { target_workspace: workspaceId, actor, usage: usage(answer.inputTokens, answer.outputTokens, 'ok') }).catch(() => {})
      console.log(`project-assistant ${name} ${body.projectId} ok`)
      return respond(200, { ...checked, generatedAt: new Date().toISOString(), model: answer.model })
    } catch (error) {
      await rpc(runtime, 'record_outreach_usage', { target_workspace: workspaceId, actor, usage: usage(answer.inputTokens, answer.outputTokens, 'failed', 'rejected') }).catch(() => {})
      console.log(`project-assistant ${name} ${body.projectId} rejected`)
      return respond(422, { error: error instanceof AnswerRejected ? error.message : 'The AI returned an unusable answer. Try again.', code: 'rejected' })
    }
  }
}
