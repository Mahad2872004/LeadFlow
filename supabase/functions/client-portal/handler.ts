import { boundedJson } from '../_shared/request.ts'
import { rpc, RpcError, type Runtime } from '../_shared/runtime.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Tokens are issued by issue_onboarding_link and claim_onboarding_reminder: "lf_" and 64 hex characters.
const tokenFormat = /^lf_[0-9a-f]{64}$/
const invalidLink = 'This link isn’t valid. It may have expired or been replaced. Ask your agency for a new link.'
export async function sha256Hex(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('')
}
/**
 * Client onboarding portal. The token is the only credential: it is hashed here and the database finds the one
 * request it belongs to, checking expiry and revocation on every call. The browser never chooses a workspace or
 * request, and the token is never logged or stored in plain text.
 */
export function createPortalHandler(runtime: Runtime) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin') ?? ''
    const allowed = (runtime.env('PORTAL_ALLOWED_ORIGINS') || runtime.env('INQUIRY_ALLOWED_ORIGINS') || '').split(',').map(x => x.trim()).filter(Boolean)
    const headers: Record<string,string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' }
    const respond = (status: number, body: Record<string,unknown>) => new Response(JSON.stringify(body), {status,headers})
    // Origin checks keep other websites' scripts out; they are not the authorization. The token is.
    if (!origin || !allowed.includes(origin)) return respond(403,{error:'This website cannot open onboarding links.'})
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'content-type'
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers})
    if (request.method !== 'POST') return respond(405,{error:'Use POST.'})
    if (!runtime.env('SUPABASE_URL') || !runtime.env('SUPABASE_SERVICE_ROLE_KEY')) return respond(503,{error:'Onboarding is not available right now. Please try again later.'})
    let body: Record<string,unknown>
    try { body = await boundedJson(request) } catch { return respond(400,{error:'Send a response of less than 16 KB.'}) }
    if (typeof body.token !== 'string' || !tokenFormat.test(body.token)) return respond(404,{error:invalidLink})
    const keyHash = await sha256Hex(body.token)
    try {
      if (!await rpc<boolean>(runtime,'inquiry_rate_limit',{bucket_key:`portal-${keyHash.slice(0,32)}`})) return respond(429,{error:'Too many requests. Please wait a minute and try again.'})
      if (body.action === 'open') return respond(200,{ok:true,onboarding:await rpc(runtime,'portal_open',{key_hash:keyHash})})
      if (body.action === 'save') {
        if (typeof body.itemId !== 'string' || !uuid.test(body.itemId) || !body.value || typeof body.value !== 'object' || Array.isArray(body.value)
          || typeof body.submit !== 'boolean' || !Number.isSafeInteger(body.revision)) return respond(400,{error:'Reload the page and try again.'})
        const result = await rpc(runtime,'portal_save_item',{key_hash:keyHash,target_item:body.itemId,response_value:body.value,submit:body.submit,expected_revision:body.revision})
        return respond(200,{ok:true,item:result})
      }
      return respond(400,{error:'Unknown action.'})
    } catch (error) {
      if (error instanceof RpcError && error.code === 'P0002') return respond(404,{error:invalidLink})
      // These messages are written in the database for the client, e.g. "This item has already been accepted".
      if (error instanceof RpcError && ['22023','55000','40001'].includes(error.code)) return respond(error.code === '22023' ? 422 : 409,{error:error.detail || 'Reload the page and try again.',code:error.code})
      return respond(503,{error:'We couldn’t reach your onboarding checklist. Check your connection and try again; nothing you saved has been lost.'})
    }
  }
}
