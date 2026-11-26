import type { PGlite } from '@electric-sql/pglite'
import { createClientsHarness } from './clients.ts'
import { createAutomationHandler } from '../../supabase/functions/automation/handler.ts'
import { createAutomationWorkerHandler } from '../../supabase/functions/automation-worker/handler.ts'
import { createAutomationWebhookHandler } from '../../supabase/functions/automation-webhook/handler.ts'
import { signWebhook } from '../../supabase/functions/_shared/automation/webhook.ts'
import type { AiClient } from '../../supabase/functions/_shared/analysis/providers.ts'
type AiRequest = Parameters<AiClient>[0]

/**
 * The automation, automation-worker and automation-webhook Edge handlers wired to embedded PostgreSQL (through the
 * clients harness), with a simulated AI model and a settable clock for webhook timestamps. Nothing leaves the process.
 */
export function createAutomationHarness(db: PGlite, overrides: Record<string, string> = {}) {
  const base = createClientsHarness(db, { EMAIL_HASH_SECRET: 'h'.repeat(40), NOTIFICATION_WORKER_SECRET: 'w'.repeat(40), ...overrides })
  const ai = { calls: [] as AiRequest[], answer: (_request: AiRequest): unknown => ({}), failure: null as Error | null }
  const model: AiClient = async request => {
    ai.calls.push(request)
    if (ai.failure) throw ai.failure
    return { output: ai.answer(request), provider: 'gemini', inputTokens: 900, outputTokens: 200, model: 'gemini-test' }
  }
  const clock = { now: Date.now() }
  return { ...base, ai, clock,
    automation: createAutomationHandler(base.runtime, { ai: model, model: 'gemini-test' }),
    unconfigured: createAutomationHandler(base.runtime, { ai: null, model: null }),
    worker: createAutomationWorkerHandler(base.runtime, { ai: model }, 8000),
    webhook: createAutomationWebhookHandler(base.runtime, () => clock.now) }
}
export type AutomationHarness = ReturnType<typeof createAutomationHarness>

export const automationRequest = (body: Record<string, unknown>, token: string | null, origin = 'http://127.0.0.1:5175') =>
  new Request('https://functions.test/automation', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
export const workerCall = (secret: string) => new Request('https://functions.test/automation-worker', { method: 'POST', headers: { 'x-worker-secret': secret } })

/** A webhook delivery signed the way the documentation tells senders to sign it. */
export async function webhookCall(secret: string, webhookId: string, body: unknown, timestampSeconds: number, options: { signature?: string; origin?: string } = {}) {
  const raw = JSON.stringify(body), timestamp = String(Math.floor(timestampSeconds))
  const signature = options.signature ?? `v1=${await signWebhook(secret, timestamp, raw)}`
  return new Request('https://functions.test/automation-webhook', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-LeadFlow-Webhook': webhookId,
    'X-LeadFlow-Timestamp': timestamp, 'X-LeadFlow-Signature': signature, ...(options.origin ? { Origin: options.origin } : {}) } })
}
