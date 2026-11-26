import { boundedJson } from '../_shared/request.ts'
import { rpc, rpcAs, RpcError, type Runtime } from '../_shared/runtime.ts'
import { documentType, documentTypes, ensureBucket, inspectUpload, maxDocumentBytes, previewExtensions, removeObject, signedDownloadUrl, signedPreviewUrl, signedUploadUrl, StorageError } from '../_shared/files.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Issued by invite_client_user and renew_client_invitation: "lfi_" and 64 hex characters.
const tokenFormat = /^lfi_[0-9a-f]{64}$/
const invalidInvitation = 'This invitation link isn’t valid. Ask your agency for a new invitation.'
export async function sha256Hex(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('')
}
const statusMessages: Record<string, string> = {
  invalid: invalidInvitation, expired: 'This invitation has expired. Ask your agency to send a new one.', revoked: 'This invitation was withdrawn. Ask your agency for a new one.',
  accepted: 'This invitation was already used. Sign in to your client portal instead.',
}

/**
 * The M12 client portal's server side. Invitation actions take only the invitation token: it is hashed here and the
 * database finds the one pending invitation it belongs to. Activation creates the Auth account for the invited address
 * with the Auth admin API, marked app_metadata.account_type = 'client' (which only the server can set), then links it.
 * File actions pass the client's own token to the database first (hub_ functions check access, role and sharing); only
 * then does this function sign one Storage URL for the path the database chose. Tokens and passwords are never logged.
 */
export function createClientHubHandler(runtime: Runtime) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin') ?? ''
    const allowed = (runtime.env('PORTAL_ALLOWED_ORIGINS') || runtime.env('DISCOVERY_ALLOWED_ORIGINS') || runtime.env('INQUIRY_ALLOWED_ORIGINS') || '').split(',').map(x => x.trim()).filter(Boolean)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' }
    const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
    if (!origin || !allowed.includes(origin)) return respond(403, { error: 'This website cannot open the client portal.' })
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return respond(405, { error: 'Use POST.' })
    if (!runtime.env('SUPABASE_URL') || !runtime.env('SUPABASE_SERVICE_ROLE_KEY')) return respond(503, { error: 'The client portal isn’t available right now. Please try again later.' })
    let body: Record<string, unknown>
    try { body = await boundedJson(request, 8192) } catch { return respond(400, { error: 'Send a request of less than 8 KB.' }) }
    const action = String(body.action ?? '')
    const limited = async (bucket: string) => !await rpc<boolean>(runtime, 'inquiry_rate_limit', { bucket_key: bucket }).catch(() => false)

    // ---------- Invitations (no session yet) ----------
    if (action === 'invitation' || action === 'activate') {
      if (typeof body.token !== 'string' || !tokenFormat.test(body.token)) return respond(404, { error: invalidInvitation, status: 'invalid' })
      const keyHash = await sha256Hex(body.token)
      try {
        if (await limited(`hub-invite-${keyHash.slice(0, 32)}`)) return respond(429, { error: 'Too many attempts. Please wait a minute and try again.' })
        const status = await rpc<{ status: string; email?: string; accountExists?: boolean }>(runtime, 'hub_invitation_status', { key_hash: keyHash })
        if (action === 'invitation') return respond(200, status)
        if (status.status !== 'valid' || !status.email) return respond(409, { error: statusMessages[status.status] ?? invalidInvitation, status: status.status })
        if (status.accountExists) return respond(409, { error: 'An account already exists for this address. Sign in to accept the invitation.', code: 'account_exists' })
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 150) : ''
        const password = typeof body.password === 'string' ? body.password : ''
        if (password.length < 8 || password.length > 128) return respond(422, { error: 'Choose a password of 8 to 128 characters.' })
        // The invited address is confirmed by holding the single-use link the agency sent to it.
        const created = await runtime.fetch(`${runtime.env('SUPABASE_URL')}/auth/v1/admin/users`, {
          method: 'POST', signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/json', apikey: runtime.env('SUPABASE_SERVICE_ROLE_KEY')!, Authorization: `Bearer ${runtime.env('SUPABASE_SERVICE_ROLE_KEY')}` },
          body: JSON.stringify({ email: status.email, password, email_confirm: true, user_metadata: { name }, app_metadata: { account_type: 'client' } }),
        })
        const account = await created.json().catch(() => ({})) as { id?: string; code?: string; error_code?: string; msg?: string; message?: string }
        if (!created.ok || typeof account.id !== 'string') {
          const reason = `${account.code ?? account.error_code ?? ''} ${account.msg ?? account.message ?? ''}`
          if (created.status === 422 && /exist|registered/i.test(reason)) return respond(409, { error: 'An account already exists for this address. Sign in to accept the invitation.', code: 'account_exists' })
          if (created.status === 422 && /password/i.test(reason)) return respond(422, { error: 'Choose a stronger password.' })
          console.log(`client-hub activate account_failed ${created.status}`)
          return respond(503, { error: 'We couldn’t create your account. Please try again in a minute.' })
        }
        await rpc(runtime, 'hub_activate_invitation', { key_hash: keyHash, target_user: account.id })
        console.log(`client-hub activate ${account.id} activated`)
        return respond(200, { email: status.email })
      } catch (error) {
        if (error instanceof RpcError && ['55000', '42501', 'P0002', '22023'].includes(error.code)) return respond(409, { error: error.detail || invalidInvitation })
        return respond(503, { error: 'We couldn’t reach the client portal. Please try again in a minute.' })
      }
    }

    // ---------- Files (signed-in client people) ----------
    const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]{20,4096})$/)?.[1]
    if (!token) return respond(401, { error: 'Sign in to your client portal.' })
    if (!(runtime.env('SUPABASE_ANON_KEY') || runtime.env('SUPABASE_PUBLISHABLE_KEY'))) return respond(503, { error: 'The client portal isn’t available right now.' })
    const asClient = async <T>(name: string, args: Record<string, unknown>): Promise<T | Response> => {
      try { return await rpcAs<T>(runtime, token, name, args) } catch (error) {
        if (error instanceof RpcError && error.code === '401') return respond(401, { error: 'Your session has expired. Sign in again.' })
        if (error instanceof RpcError && error.code === '42501') return respond(403, { error: error.detail || 'Your portal role doesn’t allow this.' })
        if (error instanceof RpcError && error.code === 'P0002') return respond(404, { error: 'Not found.' })
        if (error instanceof RpcError && ['22023', '55000', '54000'].includes(error.code)) return respond(422, { error: error.detail })
        return respond(503, { error: 'We couldn’t reach the client portal. Try again in a minute.' })
      }
    }
    const log = (outcome: string, id: string) => console.log(`client-hub ${action} ${id} ${outcome}`)
    try {
      if (action === 'config') return respond(200, { maxBytes: maxDocumentBytes(runtime), extensions: Object.keys(documentTypes) })

      if (action === 'upload') {
        if (typeof body.projectId !== 'string' || !uuid.test(body.projectId) || typeof body.fileName !== 'string' || typeof body.size !== 'number') return respond(400, { error: 'Reload the page and try again.' })
        const type = documentType(body.fileName)
        if (!type) return respond(422, { error: 'This type of file can’t be uploaded. Use PDF, images, Office documents, text, CSV, ZIP, MP4, MOV, WebM, MP3 or PSD.' })
        if (await limited(`hub-files-${body.projectId}`)) return respond(429, { error: 'Too many uploads this minute. Try again shortly.' })
        const document = await asClient<{ id: string; path: string }>('hub_begin_document', { target_project: body.projectId,
          details: { fileName: body.fileName, mimeType: type.mime, size: body.size, category: body.category, description: body.description, feedbackId: body.feedbackId, commentId: body.commentId },
          max_bytes: maxDocumentBytes(runtime) })
        if (document instanceof Response) return document
        await ensureBucket(runtime)
        const uploadUrl = await signedUploadUrl(runtime, document.path)
        log('prepared', document.id)
        return respond(200, { document: { id: document.id, mimeType: type.mime }, uploadUrl })
      }

      if (action === 'finish' || action === 'download' || action === 'preview' || action === 'remove') {
        if (typeof body.documentId !== 'string' || !uuid.test(body.documentId)) return respond(400, { error: 'Reload the page and try again.' })
        if (action === 'remove') {
          const removed = await asClient<{ path: string }>('hub_remove_document', { target_document: body.documentId })
          if (removed instanceof Response) return removed
          const gone = await removeObject(runtime, removed.path).catch(() => false)
          log(gone ? 'deleted' : 'record_deleted_object_kept', body.documentId)
          return respond(200, { ok: true })
        }
        const document = await asClient<{ id: string; path: string; fileName: string; extension: string; status: string }>('hub_document_access',
          { target_document: body.documentId, purpose: action === 'finish' ? 'finish' : 'download' })
        if (document instanceof Response) return document
        if (action === 'download') return respond(200, { url: await signedDownloadUrl(runtime, document.path, document.fileName) })
        if (action === 'preview') {
          if (!previewExtensions.includes(document.extension)) return respond(422, { error: 'This type of file can’t be previewed. Download it instead.' })
          return respond(200, { url: await signedPreviewUrl(runtime, document.path) })
        }
        const checked = await inspectUpload(runtime, document.path, document.extension)
        const finished = await rpc<Record<string, unknown>>(runtime, 'finish_client_document', { target_document: document.id, ok: checked.ok, actual_size: checked.ok ? checked.size : null,
          reason: checked.ok ? null : checked.reason })
        log(checked.ok ? 'available' : 'rejected', document.id)
        return checked.ok ? respond(200, { document: { id: document.id, status: finished.status } }) : respond(422, { error: checked.reason })
      }
      return respond(400, { error: 'Unknown action.' })
    } catch (error) {
      if (error instanceof StorageError) return respond(503, { error: error.message })
      if (error instanceof RpcError && ['22023', '55000'].includes(error.code)) return respond(422, { error: error.detail })
      return respond(503, { error: 'We couldn’t reach the file store. Try again in a minute.' })
    }
  }
}
