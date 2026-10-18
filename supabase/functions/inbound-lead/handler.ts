import { normalizeInquiry } from '../_shared/inquiry.ts'
import { boundedJson } from '../_shared/request.ts'
import { deliverOne, rpc, RpcError, type Runtime } from '../_shared/runtime.ts'
export function createWebhookHandler(runtime:Runtime){
 return async(request:Request):Promise<Response>=>{
   const respond=(status:number,body:unknown)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}})
   if(request.method!=='POST')return respond(405,{error:'Use POST.'})
   // Server-to-server only. Public browsers must keep using the CAPTCHA endpoint.
   if(request.headers.has('Origin'))return respond(403,{error:'Use the hosted inquiry form for browser submissions.'})
   const token=request.headers.get('Authorization')?.match(/^Bearer (lf_[a-f0-9]{64})$/)?.[1]
   if(!token)return respond(401,{error:'A valid workspace integration credential is required.'})
   const salt=runtime.env('EMAIL_HASH_SECRET')??''
   if(salt.length<32)return respond(503,{error:'Integration service is not configured.'})
   try{
     const keyHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),x=>x.toString(16).padStart(2,'0')).join('')
     if(!await rpc<boolean>(runtime,'authorize_integration',{key_hash:keyHash}))return respond(401,{error:'Invalid or revoked integration credential.'})
     if(!await rpc<boolean>(runtime,'inquiry_rate_limit',{bucket_key:'api-'+keyHash}))return respond(429,{error:'Rate limit reached. Retry later with the same request ID.'})
     let body:Record<string,unknown>
     try{body=await boundedJson(request)}catch{return respond(400,{error:'Send a JSON object smaller than 16 KB.'})}
     if(typeof body.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))return respond(422,{error:'requestId must be a UUID, reused on retries.'})
     let inquiry
     try{inquiry=normalizeInquiry(body.inquiry)}catch(error){return respond(422,{error:(error as Error).message})}
     const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(salt),{name:'HMAC',hash:'SHA-256'},false,['sign'])
     const hash=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(inquiry.email))),x=>x.toString(16).padStart(2,'0')).join('')
     await rpc(runtime,'receive_webhook',{key_hash:keyHash,submission_id:body.requestId,inquiry,email_hash:hash})
     try{await deliverOne(runtime,body.requestId)}catch{/* The durable M3 queue handles recovery. */}
     return respond(200,{ok:true,reference:body.requestId,message:'Inquiry received.'})
   }catch(error){
     if(error instanceof RpcError){
       if(error.code==='28000')return respond(401,{error:'Invalid or revoked integration credential.'})
       if(error.code==='23505')return respond(409,{error:'Request ID already used for different details.'})
       if(error.code==='P0429')return respond(429,{error:'Inquiry quota reached. Retry later with the same request ID.'})
       if(['22023','23514','23502'].includes(error.code))return respond(422,{error:'Invalid inquiry details.'})
     }
     return respond(503,{error:'Unable to confirm storage. Retry with the same request ID and details.'})
   }
 }
}
