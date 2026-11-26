import { boundedJson } from '../_shared/request.ts'
import { rpc, rpcAs, RpcError, type Runtime } from '../_shared/runtime.ts'
import { ProviderError, type AiClient } from '../_shared/analysis/providers.ts'
import { configuredAccounts } from '../_shared/apollo/client.ts'
import { advanceContactJob } from '../_shared/outreach/discovery.ts'
import { buildOutreachPrompt, channelLimits, draftRecord, DraftRejected, outreachAngles, outreachChannels, outreachSchema, outreachSystemPrompt, validateDraft,
  type GenerateOptions, type OutreachAngle, type OutreachChannel, type OutreachContext } from '../_shared/outreach/compose.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const subjectOf = (token: string) => { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string } catch { return null } }
const positive = (value: string | undefined, fallback: number) => { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback }
export interface OutreachDeps { ai: AiClient | null; model?: string | null }

/**
 * Contact discovery and outreach drafts for signed-in workspace members. Every action first checks membership with the
 * caller's own token; provider keys stay in this function. Contact discovery runs as a short job advanced by "discover"/
 * "advance" while the lead is open, and by the analysis-worker otherwise. Drafts are generated from the lead's business
 * intelligence, checked, and saved for a person to review: nothing here sends a message. Logs carry IDs and outcomes only.
 */
export function createOutreachHandler(runtime: Runtime, deps: OutreachDeps) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin') ?? ''
    const allowed = (runtime.env('DISCOVERY_ALLOWED_ORIGINS') || runtime.env('PORTAL_ALLOWED_ORIGINS') || runtime.env('INQUIRY_ALLOWED_ORIGINS') || '').split(',').map(x => x.trim()).filter(Boolean)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
    const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
    if (!origin || !allowed.includes(origin)) return respond(403, { error: 'This website cannot use outreach.' })
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return respond(405, { error: 'Use POST.' })
    if (!runtime.env('SUPABASE_URL') || !runtime.env('SUPABASE_SERVICE_ROLE_KEY') || !(runtime.env('SUPABASE_ANON_KEY') || runtime.env('SUPABASE_PUBLISHABLE_KEY')))
      return respond(503, { error: 'Outreach isn’t available right now.' })
    const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]{20,4096})$/)?.[1]
    if (!token) return respond(401, { error: 'Sign in to use outreach.' })
    let body: Record<string, unknown>
    try { body = await boundedJson(request, 32768) } catch { return respond(400, { error: 'Send a request of less than 32 KB.' }) }
    if (typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)) return respond(400, { error: 'Reload the page and try again.' })
    const workspaceId = body.workspaceId.toLowerCase(), action = String(body.action ?? ''), actor = subjectOf(token)
    const asUser = async <T>(name: string, args: Record<string, unknown>): Promise<T | Response> => {
      try { return await rpcAs<T>(runtime, token, name, args) } catch (error) {
        if (error instanceof RpcError && error.code === '401') return respond(401, { error: 'Your session has expired. Sign in again.' })
        if (error instanceof RpcError && error.code === '42501') return respond(403, { error: 'You don’t have access to this workspace.' })
        if (error instanceof RpcError && error.code === 'P0002') return respond(404, { error: error.detail || 'Not found.' })
        return respond(503, { error: 'We couldn’t reach LeadFlow. Try again in a minute.' })
      }
    }
    // The same membership check as business analysis.
    const role = await asUser<string>('analysis_member_role', { target_workspace: workspaceId })
    if (role instanceof Response) return role
    const leadId = typeof body.leadId === 'string' && body.leadId && body.leadId.length <= 200 ? body.leadId : null
    const limits = { monthlySearches: positive(runtime.env('CONTACT_MONTHLY_LIMIT'), 60), maxConcurrent: positive(runtime.env('CONTACT_MAX_CONCURRENT'), 3), recentHours: positive(runtime.env('CONTACT_RECENT_HOURS'), 6),
      monthlyGenerations: positive(runtime.env('OUTREACH_MONTHLY_LIMIT'), 300) }
    const contactsOf = (lead: string) => asUser<Record<string, unknown>>('lead_contacts_for', { target_workspace: workspaceId, target_lead: lead })

    if (action === 'config') {
      const apolloEnabled = (runtime.env('APOLLO_WORKSPACE_IDS') ?? '').split(',').map(x => x.trim().toLowerCase()).some(id => id === '*' || id === workspaceId) && configuredAccounts(runtime.env).length > 0
      return respond(200, { providers: { ai: { configured: !!deps.ai, provider: deps.ai ? 'gemini' : null, model: deps.ai ? deps.model ?? null : null }, website: { configured: true }, dns: { configured: true },
        apollo: { enabled: apolloEnabled } }, limits: { ...limits, maxPages: positive(runtime.env('CONTACT_MAX_PAGES'), 5) }, channelLimits })
    }

    if (action === 'discover' || action === 'verify') {
      if (!leadId || typeof body.requestId !== 'string' || !uuid.test(body.requestId)) return respond(400, { error: 'Reload the page and try again.' })
      const contactIds = Array.isArray(body.contactIds) ? body.contactIds.filter(id => typeof id === 'string' && uuid.test(id)).slice(0, 40) : []
      let started: { id: string; existing: boolean }
      try {
        started = await rpc(runtime, 'start_contact_discovery', { target_workspace: workspaceId, actor, target_lead: leadId, request_id: body.requestId, job_mode: action === 'discover' ? 'full' : 'verify',
          contact_ids: contactIds, force: body.force === true, limits })
      } catch (error) {
        if (error instanceof RpcError && ['22023', 'P0002'].includes(error.code)) return respond(422, { error: error.detail })
        if (error instanceof RpcError && error.code === 'P0409') return respond(409, { error: error.detail, code: 'recent' })
        if (error instanceof RpcError && error.code === 'P0429') return respond(429, { error: error.detail, code: 'limit' })
        return respond(503, { error: 'The contact search couldn’t be started. Try again.' })
      }
      if (!started.existing) await advanceContactJob(runtime, started.id).catch(() => null)
      const contacts = await contactsOf(leadId)
      return contacts instanceof Response ? contacts : respond(200, { ...started, ...contacts })
    }

    if (action === 'advance') {
      if (!leadId || typeof body.jobId !== 'string' || !uuid.test(body.jobId)) return respond(400, { error: 'Reload the page and try again.' })
      // Reading the lead's contacts as the caller proves the job belongs to a lead in this workspace before a step runs.
      const current = await contactsOf(leadId)
      if (current instanceof Response) return current
      const job = current.job as { id: string; step: string | null } | null
      if (!job || job.id !== body.jobId.toLowerCase()) return respond(404, { error: 'This contact search wasn’t found.' })
      if (!job.step) return respond(200, current)
      if (await rpc<boolean>(runtime, 'inquiry_rate_limit', { bucket_key: `contacts-${workspaceId}` }).catch(() => false)) await advanceContactJob(runtime, job.id).catch(() => null)
      const fresh = await contactsOf(leadId)
      return fresh instanceof Response ? fresh : respond(200, fresh)
    }

    if (action === 'generate') {
      if (!leadId || typeof body.requestId !== 'string' || !uuid.test(body.requestId)) return respond(400, { error: 'Reload the page and try again.' })
      const channel = outreachChannels.includes(body.channel as OutreachChannel) ? body.channel as OutreachChannel : null
      const angle = outreachAngles.includes(body.angle as OutreachAngle) ? body.angle as OutreachAngle : null
      const optionalId = (value: unknown) => typeof value === 'string' && uuid.test(value) ? value.toLowerCase() : null
      const sequenceStep = Number(body.sequenceStep ?? 0), parentId = optionalId(body.parentId), draftId = optionalId(body.draftId)
      if (!channel || !angle || !Number.isInteger(sequenceStep) || sequenceStep < 0 || sequenceStep > 3 || (sequenceStep > 0) !== !!parentId) return respond(422, { error: 'Choose a channel and an angle. Follow-ups need the first message.' })
      if (typeof body.instructions === 'string' && body.instructions.length > 500) return respond(422, { error: 'Extra instructions can be up to 500 characters.' })
      if (!deps.ai) return respond(503, { error: 'AI drafting isn’t set up. Add a Gemini API key (GEMINI_API_KEY) to the Edge Function secrets.', code: 'not_configured' })
      const options: GenerateOptions = { channel, angle, sequenceStep, opportunityId: optionalId(body.opportunityId), instructions: typeof body.instructions === 'string' ? body.instructions.trim() : '' }
      let context: OutreachContext & { existingDraft?: Record<string, unknown> }
      try {
        context = await rpc(runtime, 'outreach_context', { target_workspace: workspaceId, actor, target_lead: leadId, limits,
          request: { requestId: body.requestId, draftId, expectedVersion: body.expectedVersion ?? null, replaceEdited: body.replaceEdited === true, opportunityId: options.opportunityId,
            contactId: optionalId(body.contactId), parentId } })
      } catch (error) {
        if (error instanceof RpcError && error.code === 'P0002') return respond(404, { error: error.detail })
        if (error instanceof RpcError && error.code === '22023') return respond(422, { error: error.detail })
        if (error instanceof RpcError && error.code === 'P0409') return respond(409, { error: error.detail, code: 'edited' })
        if (error instanceof RpcError && error.code === '40001') return respond(409, { error: error.detail, code: 'stale' })
        if (error instanceof RpcError && error.code === 'P0429') return respond(429, { error: error.detail, code: 'limit' })
        return respond(503, { error: 'The lead’s details couldn’t be loaded. Try again.' })
      }
      if (context.existingDraft) return respond(200, { draft: context.existingDraft, existing: true })
      if (!await rpc<boolean>(runtime, 'inquiry_rate_limit', { bucket_key: `outreach-${workspaceId}` }).catch(() => false)) return respond(429, { error: 'Too many drafts this minute. Try again shortly.', code: 'rate_limited' })
      const { user, refs } = buildOutreachPrompt(context, options)
      const usage = (inputTokens: number, outputTokens: number, status: 'ok' | 'failed', detail = '') => [
        { provider: 'gemini', operation: 'draft_generation', quantity: inputTokens, unit: 'input_tokens', status, detail },
        { provider: 'gemini', operation: 'draft_generation', quantity: outputTokens, unit: 'output_tokens', status, detail }]
      // Drafts need little reasoning: a low thinking level keeps Gemini fast. One timeout or outage is retried, and both
      // attempts fit within the Edge Function's time limit.
      const thinking = (['minimal', 'low', 'medium', 'high'] as const).find(level => level === runtime.env('OUTREACH_AI_THINKING')) ?? 'low'
      const request = { system: outreachSystemPrompt, user, schema: outreachSchema, maxTokens: 8000, thinking, timeoutMs: 55_000 }
      const started = Date.now()
      let answer
      for (let attempt = 1; ; attempt++) {
        try { answer = await deps.ai(request); break } catch (error) {
          const failure = error instanceof ProviderError ? error : new ProviderError('failed', 'The AI service failed.')
          await rpc(runtime, 'record_outreach_usage', { target_workspace: workspaceId, actor, usage: [{ provider: 'gemini', operation: 'draft_generation', quantity: 0, unit: 'requests', status: 'failed', detail: failure.kind }] }).catch(() => {})
          console.log(`outreach generate attempt ${attempt} failed ${failure.kind}`)
          if (attempt === 1 && ['timeout', 'unavailable'].includes(failure.kind) && Date.now() - started < 60_000) continue
          const message = ['timeout', 'unavailable'].includes(failure.kind) ? `Gemini didn’t answer (${failure.kind === 'timeout' ? 'it took too long' : 'it was unavailable'}${attempt > 1 ? ', twice' : ''}). Nothing was saved. Try again in a minute.` : failure.message
          return respond(failure.kind === 'rate_limited' ? 429 : 502, { error: message, code: failure.kind })
        }
      }
      let checked
      try { checked = validateDraft(answer.output, context, options, refs) } catch (error) {
        const rejected = error instanceof DraftRejected ? error : new DraftRejected('malformed', 'The AI returned an unusable draft. Try again.')
        await rpc(runtime, 'record_outreach_usage', { target_workspace: workspaceId, actor, usage: usage(answer.inputTokens, answer.outputTokens, 'failed', rejected.code) }).catch(() => {})
        console.log(`outreach generate rejected ${rejected.code}`)
        return respond(422, { error: rejected.message, code: rejected.code })
      }
      try {
        const saved = await rpc<Record<string, unknown>>(runtime, 'save_generated_draft', { target_workspace: workspaceId, actor, target_lead: leadId, request_id: body.requestId, draft_id: draftId,
          expected_version: body.expectedVersion ?? null, replace_edited: body.replaceEdited === true, usage: usage(answer.inputTokens, answer.outputTokens, 'ok'),
          draft: draftRecord(context, options, checked, answer, parentId) })
        console.log(`outreach generate ${String(saved.id)} ${checked.grounding}`)
        return respond(200, { draft: saved, existing: saved.existing === true })
      } catch (error) {
        if (error instanceof RpcError && error.code === 'P0409') return respond(409, { error: error.detail, code: 'edited' })
        if (error instanceof RpcError && error.code === '40001') return respond(409, { error: error.detail, code: 'stale' })
        if (error instanceof RpcError && ['22023', 'P0002'].includes(error.code)) return respond(422, { error: error.detail })
        return respond(503, { error: 'The draft couldn’t be saved. Try again.' })
      }
    }
    return respond(400, { error: 'Unknown action.' })
  }
}
