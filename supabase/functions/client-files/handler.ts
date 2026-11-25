import { boundedJson } from '../_shared/request.ts'
import { rpc, rpcAs, RpcError, type Runtime } from '../_shared/runtime.ts'
import { documentType, documentTypes, ensureBucket, inspectUpload, maxDocumentBytes, removeObject, signedDownloadUrl, signedUploadUrl, StorageError } from '../_shared/files.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Client documents for signed-in workspace members. Every action first asks the database, with the member's own token,
 * whether they may act on that client or file; only then does this function use its service role to sign one upload or
 * download URL for the path the database chose. Files go straight between the browser and Storage. An upload becomes
 * downloadable only after "finish" has checked its size and content signature. Logs carry IDs and outcomes only.
 */
export function createClientFilesHandler(runtime: Runtime) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin') ?? ''
    const allowed = (runtime.env('DISCOVERY_ALLOWED_ORIGINS') || runtime.env('PORTAL_ALLOWED_ORIGINS') || runtime.env('INQUIRY_ALLOWED_ORIGINS') || '').split(',').map(x => x.trim()).filter(Boolean)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
    const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
    if (!origin || !allowed.includes(origin)) return respond(403, { error: 'This website cannot manage client files.' })
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return respond(405, { error: 'Use POST.' })
    if (!runtime.env('SUPABASE_URL') || !runtime.env('SUPABASE_SERVICE_ROLE_KEY') || !(runtime.env('SUPABASE_ANON_KEY') || runtime.env('SUPABASE_PUBLISHABLE_KEY')))
      return respond(503, { error: 'Client files aren’t available right now.' })
    const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]{20,4096})$/)?.[1]
    if (!token) return respond(401, { error: 'Sign in to manage client files.' })
    let body: Record<string, unknown>
    try { body = await boundedJson(request, 8192) } catch { return respond(400, { error: 'Send a request of less than 8 KB.' }) }
    if (typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)) return respond(400, { error: 'Reload the page and try again.' })
    const workspaceId = body.workspaceId.toLowerCase(), action = String(body.action ?? '')
    const asUser = async <T>(name: string, args: Record<string, unknown>): Promise<T | Response> => {
      try { return await rpcAs<T>(runtime, token, name, args) } catch (error) {
        if (error instanceof RpcError && error.code === '401') return respond(401, { error: 'Your session has expired. Sign in again.' })
        if (error instanceof RpcError && error.code === '42501') return respond(403, { error: error.detail || 'You don’t have access to this workspace.' })
        if (error instanceof RpcError && error.code === 'P0002') return respond(404, { error: error.detail || 'Not found.' })
        if (error instanceof RpcError && ['22023', '55000', '54000'].includes(error.code)) return respond(422, { error: error.detail })
        return respond(503, { error: 'We couldn’t reach LeadFlow. Try again in a minute.' })
      }
    }
    const role = await asUser<string>('analysis_member_role', { target_workspace: workspaceId })
    if (role instanceof Response) return role
    const limited = async () => !await rpc<boolean>(runtime, 'inquiry_rate_limit', { bucket_key: `files-${workspaceId}` }).catch(() => false)
    const log = (outcome: string, id: string) => console.log(`client-files ${action} ${id} ${outcome}`)
    try {
      if (action === 'config') return respond(200, { maxBytes: maxDocumentBytes(runtime), extensions: Object.keys(documentTypes) })

      if (action === 'upload') {
        if (typeof body.clientId !== 'string' || !uuid.test(body.clientId) || typeof body.fileName !== 'string' || typeof body.size !== 'number') return respond(400, { error: 'Reload the page and try again.' })
        const type = documentType(body.fileName)
        if (!type) return respond(422, { error: 'This type of file can’t be uploaded. Use PDF, images, Office documents, text, CSV, ZIP, MP4, MOV, WebM, MP3 or PSD.' })
        if (await limited()) return respond(429, { error: 'Too many uploads this minute. Try again shortly.' })
        const document = await asUser<{ id: string; path: string }>('begin_client_document', { target_workspace: workspaceId, target_client: body.clientId,
          details: { fileName: body.fileName, mimeType: type.mime, size: body.size, category: body.category, description: body.description, visibility: body.visibility,
            requestId: body.requestId, stageId: body.stageId }, max_bytes: maxDocumentBytes(runtime) })
        if (document instanceof Response) return document
        await ensureBucket(runtime)
        const uploadUrl = await signedUploadUrl(runtime, document.path)
        log('prepared', document.id)
        return respond(200, { document: { id: document.id, mimeType: type.mime }, uploadUrl })
      }

      if (action === 'finish' || action === 'download') {
        if (typeof body.documentId !== 'string' || !uuid.test(body.documentId)) return respond(400, { error: 'Reload the page and try again.' })
        const document = await asUser<{ id: string; path: string; fileName: string; extension: string; status: string }>('client_document_access', { target_workspace: workspaceId, target_document: body.documentId })
        if (document instanceof Response) return document
        if (action === 'download') {
          if (document.status !== 'available') return respond(409, { error: 'This file is still being checked. Try again in a moment.' })
          return respond(200, { url: await signedDownloadUrl(runtime, document.path, document.fileName) })
        }
        if (document.status !== 'pending') return respond(200, { document: await rpc(runtime, 'finish_client_document', { target_document: document.id, ok: true, actual_size: null, reason: null }) })
        const checked = await inspectUpload(runtime, document.path, document.extension)
        const finished = await rpc<Record<string, unknown>>(runtime, 'finish_client_document', { target_document: document.id, ok: checked.ok, actual_size: checked.ok ? checked.size : null,
          reason: checked.ok ? null : checked.reason })
        log(checked.ok ? 'available' : 'rejected', document.id)
        return checked.ok ? respond(200, { document: finished }) : respond(422, { error: checked.reason, document: finished })
      }

      if (action === 'delete') {
        if (typeof body.documentId !== 'string' || !uuid.test(body.documentId)) return respond(400, { error: 'Reload the page and try again.' })
        const removed = await asUser<{ path: string }>('delete_client_document', { target_workspace: workspaceId, target_document: body.documentId })
        if (removed instanceof Response) return removed
        // The record is already deleted; if Storage is unreachable the object is left behind, never served again.
        const gone = await removeObject(runtime, removed.path).catch(() => false)
        log(gone ? 'deleted' : 'record_deleted_object_kept', body.documentId)
        return respond(200, { ok: true })
      }
      return respond(400, { error: 'Unknown action.' })
    } catch (error) {
      if (error instanceof StorageError) return respond(503, { error: error.message })
      if (error instanceof RpcError && ['22023', '55000'].includes(error.code)) return respond(422, { error: error.detail })
      return respond(503, { error: 'We couldn’t reach the document store. Try again in a minute.' })
    }
  }
}
