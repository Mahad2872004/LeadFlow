import { rpc, sendEmail, type Runtime } from '../_shared/runtime.ts'
import { refuseWorker } from '../_shared/worker.ts'
interface PortalEmailJob { id?: string; lease_id?: string; email?: Record<string, unknown>; skipped?: boolean }
/**
 * Sends queued M12 emails: client-portal invitations and notification emails people asked for. Nothing runs this
 * automatically: a scheduler must POST here with the worker secret (docs/CLIENT-COLLABORATION.md#email). The database
 * composes each email once, cancels emails to people who lost access, and records the provider's answer; retries reuse
 * the same idempotency key and body. A provider acceptance is not a delivery confirmation.
 */
export function createPortalNotificationsHandler(runtime: Runtime) {
  return async (request: Request): Promise<Response> => {
    const refusal = await refuseWorker(runtime, request)
    if (refusal) return refusal
    const from = runtime.env('NOTIFICATION_FROM') ?? '', app = runtime.env('APP_URL') ?? ''
    // Without a sender, provider key or app address nothing is claimed, so nothing is used up.
    if (!runtime.env('RESEND_API_KEY') || !from.includes('@') || /[\r\n]/.test(from) || !/^https?:\/\/[^\s#?]+$/.test(app))
      return Response.json({ error: 'Portal email delivery is not configured.' }, { status: 503 })
    try {
      const outcomes: string[] = []
      for (let i = 0; i < 20; i++) {
        const job = await rpc<PortalEmailJob | null>(runtime, 'claim_portal_email', { app_url: app, sender: from })
        if (!job) break
        if (job.skipped || !job.id || !job.lease_id) { outcomes.push('skipped'); continue }
        const result = await sendEmail(runtime, `leadflow-portal/${job.id}`, job.email)
        await rpc(runtime, 'finish_portal_email', { job_id: job.id, lease: job.lease_id, outcome: result.outcome, provider_reference: result.reference, failure_code: result.failure })
        outcomes.push(result.outcome)
      }
      return Response.json({ outcomes })
    } catch { return Response.json({ error: 'Portal email processing failed. Claimed emails stay leased and are retried on a later run.' }, { status: 503 }) }
  }
}
