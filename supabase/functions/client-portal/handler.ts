import { boundedJson } from '../_shared/request.ts'
import { rpc, RpcError, type Runtime } from '../_shared/runtime.ts'
import { documentType, ensureBucket, inspectUpload, maxDocumentBytes, removeObject, signedDownloadUrl, signedUploadUrl, StorageError } from '../_shared/files.ts'
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
      // Files: the database decides what this link may upload, check, download or remove; this function only signs
      // one URL for the path it returns. Uploads are checked (size and content signature) before they count.
      if (body.action === 'upload') {
        if (typeof body.itemId !== 'string' || !uuid.test(body.itemId) || typeof body.fileName !== 'string' || typeof body.size !== 'number') return respond(400,{error:'Reload the page and try again.'})
        const type = documentType(body.fileName)
        if (!type) return respond(422,{error:'This type of file can’t be uploaded. Use PDF, images, Office documents, text, CSV, ZIP, MP4, MOV, WebM, MP3 or PSD.'})
        const document = await rpc<{id:string;path:string}>(runtime,'portal_begin_upload',{key_hash:keyHash,target_item:body.itemId,details:{fileName:body.fileName,mimeType:type.mime,size:body.size},max_bytes:maxDocumentBytes(runtime)})
        await ensureBucket(runtime)
        return respond(200,{ok:true,file:{id:document.id,mimeType:type.mime},uploadUrl:await signedUploadUrl(runtime,document.path)})
      }
      if (body.action === 'finish' || body.action === 'download') {
        if (typeof body.fileId !== 'string' || !uuid.test(body.fileId)) return respond(400,{error:'Reload the page and try again.'})
        const document = await rpc<{id:string;path:string;fileName:string;status:string}>(runtime,'portal_document_access',{key_hash:keyHash,target_document:body.fileId,purpose:body.action})
        if (body.action === 'download') return respond(200,{ok:true,url:await signedDownloadUrl(runtime,document.path,document.fileName)})
        const type = documentType(document.fileName)
        const checked = type ? await inspectUpload(runtime,document.path,type.extension) : {ok:false as const,reason:'This type of file isn’t allowed.'}
        await rpc(runtime,'finish_client_document',{target_document:document.id,ok:checked.ok,actual_size:checked.ok?checked.size:null,reason:checked.ok?null:checked.reason})
        return checked.ok ? respond(200,{ok:true,file:{id:document.id,name:document.fileName,size:checked.size,status:'available'}}) : respond(422,{error:checked.reason})
      }
      if (body.action === 'remove') {
        if (typeof body.fileId !== 'string' || !uuid.test(body.fileId)) return respond(400,{error:'Reload the page and try again.'})
        const removed = await rpc<{path:string}>(runtime,'portal_remove_upload',{key_hash:keyHash,target_document:body.fileId})
        await removeObject(runtime,removed.path).catch(()=>false)
        return respond(200,{ok:true})
      }
      if (body.action === 'acknowledge') {
        if (typeof body.scopeId !== 'string' || !uuid.test(body.scopeId)) return respond(400,{error:'Reload the page and try again.'})
        return respond(200,{ok:true,scope:await rpc(runtime,'portal_acknowledge_scope',{key_hash:keyHash,target_confirmation:body.scopeId})})
      }
      return respond(400,{error:'Unknown action.'})
    } catch (error) {
      if (error instanceof StorageError) return respond(503,{error:'We couldn’t reach the file store. Try again in a minute; nothing you saved has been lost.'})
      if (error instanceof RpcError && error.code === 'P0002' && ['finish','download','remove'].includes(String(body.action))) return respond(404,{error:'That file isn’t available. Reload the page.'})
      if (error instanceof RpcError && error.code === 'P0002') return respond(404,{error:invalidLink})
      // These messages are written in the database for the client, e.g. "This item has already been accepted".
      if (error instanceof RpcError && ['22023','55000','40001','54000'].includes(error.code)) return respond(error.code === '22023' || error.code === '54000' ? 422 : 409,{error:error.detail || 'Reload the page and try again.',code:error.code})
      return respond(503,{error:'We couldn’t reach your onboarding checklist. Check your connection and try again; nothing you saved has been lost.'})
    }
  }
}
