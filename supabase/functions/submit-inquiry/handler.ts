import { boundedJson } from '../_shared/request.ts'
import { normalizeInquiry } from '../_shared/inquiry.ts'
import { deliverOne, rpc, RpcError, type Runtime } from '../_shared/runtime.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function createInquiryHandler(runtime: Runtime) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin') ?? ''
    const allowed = (runtime.env('INQUIRY_ALLOWED_ORIGINS') ?? '').split(',').map(x => x.trim()).filter(Boolean)
    const headers: Record<string,string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
    const respond = (status: number, body: Record<string,unknown>) => new Response(JSON.stringify(body), {status,headers})
    if (!origin || !allowed.includes(origin)) return respond(403,{error:'This website is not permitted to submit inquiries.'})
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'content-type'
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers})
    if (request.method !== 'POST') return respond(405,{error:'Use POST to submit an inquiry.'})
    const owner = runtime.env('WEBSITE_OWNER_ID') ?? '', website = runtime.env('WEBSITE_ID') ?? ''
    const secret = runtime.env('TURNSTILE_SECRET_KEY'), hashSecret = runtime.env('EMAIL_HASH_SECRET') ?? ''
    const to = runtime.env('NOTIFICATION_TO') ?? '', from = runtime.env('NOTIFICATION_FROM') ?? ''
    const hosts = (runtime.env('TURNSTILE_HOSTNAMES') ?? '').split(',').map(x=>x.trim()).filter(Boolean)
    if (!uuid.test(owner) || !/^[a-z0-9-]{1,64}$/.test(website) || !secret || hashSecret.length < 32 || !hosts.length ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !from.includes('@') || /[\r\n]/.test(from) || !runtime.env('SUPABASE_URL') || !runtime.env('SUPABASE_SERVICE_ROLE_KEY'))
      return respond(503,{error:'The inquiry service is not configured yet. Please try again later.'})
    let body: Record<string,unknown>
    try { body = await boundedJson(request) } catch { return respond(400,{error:'Send a valid inquiry of less than 16 KB.'}) }
    if (typeof body.requestId !== 'string' || !uuid.test(body.requestId) || typeof body.token !== 'string' || !body.token || body.token.length>2048 || (body.website !== undefined && body.website !== ''))
      return respond(400,{error:'Please complete the verification and try again.'})
    let inquiry
    try { inquiry = normalizeInquiry(body.inquiry) } catch (error) { return respond(422,{error:(error as Error).message}) }
    try {
      if (!await rpc<boolean>(runtime,'inquiry_rate_limit',{bucket_key:website})) return respond(429,{error:'Too many requests. Please try again in a minute.'})
      const verification = await runtime.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret,response:body.token}),signal:AbortSignal.timeout(10000),
      })
      if(!verification.ok) return respond(503,{error:'Verification is temporarily unavailable. Please try again.'})
      const result = await verification.json()
      if (result.success !== true || result.action !== 'inquiry' || !hosts.includes(result.hostname)) return respond(400,{error:'Verification expired or failed. Please verify again.'})
      const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(hashSecret),{name:'HMAC',hash:'SHA-256'},false,['sign'])
      const digest = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(inquiry.email))
      const emailHash = Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')
      const notification = { from, to:[to], subject:`New website inquiry · ${inquiry.service}`, text:`A new inquiry was saved in LeadFlow.\n\nName: ${inquiry.name}\nEmail: ${inquiry.email}\nCompany: ${inquiry.company || 'Not provided'}\nService: ${inquiry.service}\nWebsite: ${website}\nReference: ${body.requestId}\n\nSign in to LeadFlow for the message, phone number, and follow-up actions.` }
      await rpc(runtime,'receive_inquiry',{target_owner:owner,website_id:website,submission_id:body.requestId,inquiry,email_hash:emailHash,notification})
      // Storage is committed first. Email outages never turn a saved lead into a failed inquiry.
      try { await deliverOne(runtime,body.requestId) } catch { /* Durable queue/lease allows a worker to recover. */ }
      return respond(200,{ok:true,reference:body.requestId,message:'Your inquiry has been received. Thank you for getting in touch.'})
    } catch(error) {
      if(error instanceof RpcError && error.code === '23505') return respond(409,{error:'This submission reference was already used. Restore the original details to retry, or start a new inquiry.'})
      if(error instanceof RpcError && error.code === 'P0429') return respond(429,{error:'The inquiry limit has been reached. Please try again later.'})
      if(error instanceof RpcError && ['22023','23514','23502','22001'].includes(error.code)) return respond(422,{error:'Please check your inquiry details.'})
      return respond(503,{error:'We could not confirm your inquiry. Please retry with the same details.'})
    }
  }
}
