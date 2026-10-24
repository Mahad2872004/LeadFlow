import { rpc, sendEmail, type Runtime } from '../_shared/runtime.ts'
import { refuseWorker } from '../_shared/worker.ts'
interface ReminderJob { id?: string; lease_id?: string; email?: Record<string, unknown>; skipped?: boolean; busy?: boolean }
/**
 * Sends due onboarding reminders. Nothing runs this automatically: a scheduler must POST here with the worker
 * secret (docs/CLIENT-ONBOARDING.md#reminders). The database decides which reminders are due and rechecks every
 * stopping rule; this function only sends what it is handed and records the provider's answer.
 */
export function createReminderHandler(runtime: Runtime) {
  return async (request: Request): Promise<Response> => {
    const refusal=await refuseWorker(runtime,request)
    if(refusal) return refusal
    const from=runtime.env('NOTIFICATION_FROM') ?? '', portal=runtime.env('PORTAL_URL') ?? ''
    // Without a sender, provider key or portal address no reminder is claimed, so none is used up.
    if(!runtime.env('RESEND_API_KEY')||!from.includes('@')||/[\r\n]/.test(from)||!/^https?:\/\/[^\s#?]+$/.test(portal))
      return Response.json({error:'Reminder delivery is not configured.'},{status:503})
    try {
      const outcomes:string[]=[]
      for(let i=0;i<10;i++){
        const job=await rpc<ReminderJob|null>(runtime,'claim_onboarding_reminder',{portal_url:portal,sender:from})
        if(!job)break
        if(job.skipped){outcomes.push(job.busy?'busy':'skipped');if(job.busy)break;continue}
        const result=await sendEmail(runtime,`leadflow-onboarding/${job.id}`,job.email)
        await rpc(runtime,'finish_onboarding_reminder',{reminder_id:job.id,lease:job.lease_id,outcome:result.outcome,provider_reference:result.reference,failure_code:result.failure})
        outcomes.push(result.outcome)
      }
      return Response.json({outcomes})
    } catch {return Response.json({error:'Reminder processing failed. Claimed reminders stay leased and are retried on a later run.'},{status:503})}
  }
}
