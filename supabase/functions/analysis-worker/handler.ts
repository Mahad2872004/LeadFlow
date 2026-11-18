import type { Runtime } from '../_shared/runtime.ts'
import { refuseWorker } from '../_shared/worker.ts'
import { advanceAnalysis, type PipelineDeps } from '../_shared/analysis/pipeline.ts'
import { advanceContactJob } from '../_shared/outreach/discovery.ts'
/**
 * Continues business analyses and contact searches nobody is watching (an open report or contacts tab advances its own).
 * A scheduler POSTs here with the worker secret; each call runs due steps for up to about 100 seconds, analyses first.
 * Concurrency is bounded by the leases: a step already claimed elsewhere isn't claimed again.
 */
export function createAnalysisWorkerHandler(runtime: Runtime, deps: PipelineDeps, budgetMs = 100_000) {
  return async (request: Request): Promise<Response> => {
    const refusal = await refuseWorker(runtime, request)
    if (refusal) return refusal
    const started = Date.now(), steps: string[] = []
    try {
      while (Date.now() - started < budgetMs && steps.length < 40) {
        const advanced = await advanceAnalysis(runtime, deps, null)
        if (!advanced) break
        steps.push(`${advanced.step}:${advanced.outcome}`)
      }
      while (Date.now() - started < budgetMs && steps.length < 60) {
        const advanced = await advanceContactJob(runtime, null)
        if (!advanced) break
        steps.push(`contacts.${advanced.step}:${advanced.outcome}`)
      }
      return Response.json({ steps })
    } catch { return Response.json({ steps, error: 'Analysis processing failed. Claimed steps are retried after their lease expires.' }, { status: 503 }) }
  }
}
