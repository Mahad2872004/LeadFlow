import { deliverOne, type Runtime } from '../_shared/runtime.ts'
import { refuseWorker } from '../_shared/worker.ts'
export function createRetryHandler(runtime: Runtime) {
  return async (request: Request): Promise<Response> => {
    const refusal=await refuseWorker(runtime,request)
    if(refusal) return refusal
    try {
      const outcomes:string[]=[]
      for(let i=0;i<5;i++){const outcome=await deliverOne(runtime);if(outcome==='no_job')break;outcomes.push(outcome);if(outcome==='configuration_missing')break}
      return Response.json({outcomes})
    } catch {return Response.json({error:'Queue processing failed. Jobs remain available for recovery.'},{status:503})}
  }
}
