import { deliverOne, type Runtime } from '../_shared/runtime.ts'
export function createRetryHandler(runtime: Runtime) {
  return async (request: Request): Promise<Response> => {
    const secret=runtime.env('NOTIFICATION_WORKER_SECRET') ?? ''
    if(secret.length<32) return Response.json({error:'Worker is not configured.'},{status:503})
    const received=request.headers.get('x-worker-secret') ?? ''
    // Compare fixed-size digests without a prefix-dependent early return.
    const a=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret)))
    const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(received)))
    let difference=0;for(let i=0;i<a.length;i++)difference|=a[i]^b[i]
    if(difference) return Response.json({error:'Unauthorized'},{status:401})
    if(request.method!=='POST')return Response.json({error:'Use POST'},{status:405})
    try {
      const outcomes:string[]=[]
      for(let i=0;i<5;i++){const outcome=await deliverOne(runtime);if(outcome==='no_job')break;outcomes.push(outcome);if(outcome==='configuration_missing')break}
      return Response.json({outcomes})
    } catch {return Response.json({error:'Queue processing failed. Jobs remain available for recovery.'},{status:503})}
  }
}
