import type { Runtime } from '../_shared/runtime.ts'
import { rpc } from '../_shared/runtime.ts'
import { refuseWorker } from '../_shared/worker.ts'
import type { AiClient } from '../_shared/analysis/providers.ts'
import { advanceRuns } from '../_shared/automation/engine.ts'

/**
 * Runs automations (M13). Supabase Cron POSTs here every minute with the worker secret. Each call releases expired leases,
 * fires due schedules and scheduled checks, then advances due runs for up to about 50 seconds. Nothing sleeps: delays and
 * waits are rows with a due time, so a restart loses nothing. Concurrency is bounded by row locks and per-workspace limits
 * in the database. Logs carry outcomes only.
 */
export function createAutomationWorkerHandler(runtime: Runtime, deps: { ai: AiClient | null }, budgetMs = 50_000) {
  return async (request: Request): Promise<Response> => {
    const refusal = await refuseWorker(runtime, request)
    if (refusal) return refusal
    try {
      const tick = await rpc<Record<string, number>>(runtime, 'automation_tick', {})
      const outcomes = await advanceRuns(runtime, deps.ai, budgetMs)
      return Response.json({ tick, outcomes })
    } catch {
      return Response.json({ error: 'Automation processing failed. Runs are retried on the next call.' }, { status: 503 })
    }
  }
}
