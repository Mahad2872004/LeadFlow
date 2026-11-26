// M13: the Edge side of the automation engine. The database runs workflows (public.automation_advance); this module drives
// it and runs the one kind of step that can't happen inside a database transaction: an AI outreach draft. It reuses the
// outreach composer, its prompt-injection fencing and its validation, and saves through automation_complete_external,
// which stores the draft with the step's request ID as the member who published the workflow. Nothing is sent.
import { rpc, RpcError, type Runtime } from '../runtime.ts'
import { ProviderError, type AiClient } from '../analysis/providers.ts'
import { buildOutreachPrompt, draftRecord, DraftRejected, outreachAngles, outreachChannels, outreachSchema, outreachSystemPrompt, recommendOutreach, validateDraft,
  type GenerateOptions, type OutreachAngle, type OutreachChannel, type OutreachContext } from '../outreach/compose.ts'

const positive = (value: string | undefined, fallback: number) => { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback }

/** Provider limits, from the same secrets the business analysis and outreach functions read. */
export function workerLimits(env: Runtime['env']) {
  return {
    analysis: { monthlyAnalyses: positive(env('ANALYSIS_MONTHLY_LIMIT'), 30), maxConcurrent: positive(env('ANALYSIS_MAX_CONCURRENT'), 2), recentHours: positive(env('ANALYSIS_RECENT_HOURS'), 24) },
    contacts: { monthlySearches: positive(env('CONTACT_MONTHLY_LIMIT'), 60), maxConcurrent: positive(env('CONTACT_MAX_CONCURRENT'), 3), recentHours: positive(env('CONTACT_RECENT_HOURS'), 6),
      monthlyGenerations: positive(env('OUTREACH_MONTHLY_LIMIT'), 300) },
  }
}

export interface ExternalJob { runId: string; lease: string; node: string; action: string; workspaceId: string; actor: string | null; requestId: string; leadId: string | null; inputs: Record<string, unknown> }
export interface Advanced { runId: string; outcome: string; steps?: number; external?: ExternalJob }
interface Outcome { ok: boolean; transient?: boolean; code?: string; message?: string; existingDraftId?: string; draft?: unknown; usage?: unknown[] }

const usageRows = (inputTokens: number, outputTokens: number, status: 'ok' | 'failed', detail = '') => [
  { provider: 'gemini', operation: 'draft_generation', quantity: inputTokens, unit: 'input_tokens', status, detail },
  { provider: 'gemini', operation: 'draft_generation', quantity: outputTokens, unit: 'output_tokens', status, detail }]

/** Runs an AI step and reports its outcome to the database. Returns the outcome name for the worker's log (IDs and codes only). */
export async function runExternal(runtime: Runtime, ai: AiClient | null, job: ExternalJob): Promise<string> {
  const complete = async (outcome: Outcome) => {
    const result = await rpc<{ outcome?: string; stale?: boolean }>(runtime, 'automation_complete_external', { run_id: job.runId, lease: job.lease, outcome })
    return result?.stale ? 'stale' : result?.outcome ?? 'unknown'
  }
  if (job.action !== 'outreach.generate_draft' || !job.leadId || !job.actor) return complete({ ok: false, transient: false, code: 'invalid_step', message: 'This step can’t run here.' })
  const limits = workerLimits(runtime.env).contacts
  let context: OutreachContext & { existingDraft?: { id: string } }
  try {
    context = await rpc(runtime, 'outreach_context', { target_workspace: job.workspaceId, actor: job.actor, target_lead: job.leadId, limits,
      request: { requestId: job.requestId, draftId: null, expectedVersion: null, replaceEdited: false, opportunityId: null, contactId: null, parentId: null } })
  } catch (error) {
    const code = error instanceof RpcError ? error.code : 'unknown'
    return complete({ ok: false, transient: !['P0002', '22023', 'P0409', '42501', 'P0429'].includes(code), code: code === 'P0429' ? 'limit' : code === '42501' ? 'authorization' : 'context',
      message: error instanceof RpcError && error.detail ? error.detail : 'The lead’s details couldn’t be loaded.' })
  }
  // The same request ID was used before: that draft is the step's result.
  if (context.existingDraft) return complete({ ok: true, existingDraftId: context.existingDraft.id })
  if (!ai) return complete({ ok: false, transient: false, code: 'not_configured', message: 'AI drafting isn’t set up. Add a Gemini API key (GEMINI_API_KEY) to the Edge Function secrets.' })
  const channel: OutreachChannel = outreachChannels.includes(job.inputs.channel as OutreachChannel) ? job.inputs.channel as OutreachChannel : 'email'
  const recommendation = recommendOutreach(context)
  const angle: OutreachAngle = outreachAngles.includes(job.inputs.angle as OutreachAngle) ? job.inputs.angle as OutreachAngle : recommendation.angle
  const options: GenerateOptions = { channel, angle, sequenceStep: 0, opportunityId: recommendation.opportunityId, instructions: '' }
  if (!await rpc<boolean>(runtime, 'inquiry_rate_limit', { bucket_key: `outreach-${job.workspaceId}` }).catch(() => false)) {
    return complete({ ok: false, transient: true, code: 'rate_limited', message: 'Too many drafts this minute.' })
  }
  const { user, refs } = buildOutreachPrompt(context, options)
  const thinking = (['minimal', 'low', 'medium', 'high'] as const).find(level => level === runtime.env('OUTREACH_AI_THINKING')) ?? 'low'
  let answer
  try { answer = await ai({ system: outreachSystemPrompt, user, schema: outreachSchema, maxTokens: 8000, thinking, timeoutMs: 55_000 }) } catch (error) {
    const failure = error instanceof ProviderError ? error : new ProviderError('failed', 'The AI service failed.')
    await rpc(runtime, 'record_outreach_usage', { target_workspace: job.workspaceId, actor: job.actor, usage: [{ provider: 'gemini', operation: 'draft_generation', quantity: 0, unit: 'requests', status: 'failed', detail: failure.kind }] }).catch(() => {})
    return complete({ ok: false, transient: ['timeout', 'unavailable', 'rate_limited'].includes(failure.kind), code: failure.kind === 'auth' ? 'not_configured' : failure.kind, message: failure.message })
  }
  let checked
  try { checked = validateDraft(answer.output, context, options, refs) } catch (error) {
    const rejected = error instanceof DraftRejected ? error : new DraftRejected('malformed', 'The AI returned an unusable draft.')
    await rpc(runtime, 'record_outreach_usage', { target_workspace: job.workspaceId, actor: job.actor, usage: usageRows(answer.inputTokens, answer.outputTokens, 'failed', rejected.code) }).catch(() => {})
    // A rejected draft may pass on a second attempt (the model varies); the retry limit stops it after that.
    return complete({ ok: false, transient: true, code: 'rejected', message: rejected.message })
  }
  return complete({ ok: true, draft: draftRecord(context, options, checked, answer), usage: usageRows(answer.inputTokens, answer.outputTokens, 'ok') })
}

/**
 * Advances runs until there's nothing due or the time budget is spent. With a run ID, only that run (a live test or a
 * retried run a member asked to start now). AI steps run here, then the run continues.
 */
export async function advanceRuns(runtime: Runtime, ai: AiClient | null, budgetMs: number, runId: string | null = null, maxCalls = 200): Promise<string[]> {
  const started = Date.now(), outcomes: string[] = [], limits = workerLimits(runtime.env)
  while (Date.now() - started < budgetMs && outcomes.length < maxCalls) {
    const advanced = await rpc<Advanced | null>(runtime, 'automation_advance', { target_run: runId, limits })
    if (!advanced) break
    if (advanced.external) {
      outcomes.push(`ai:${await runExternal(runtime, ai, advanced.external)}`)
      continue
    }
    outcomes.push(advanced.outcome)
    if (runId && advanced.outcome !== 'yielded') break
  }
  return outcomes
}
