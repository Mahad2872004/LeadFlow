export interface Runtime { env: (name: string) => string | undefined; fetch: typeof fetch }
export class RpcError extends Error {
  code: string
  /** The database's message. Only messages the database writes for people (22023) are shown to callers. */
  detail: string
  constructor(code: string, detail = '') { super('Database operation failed'); this.code = code; this.detail = detail }
}
export async function rpc<T>(runtime: Runtime, name: string, body: Record<string, unknown>): Promise<T> {
  const url = runtime.env('SUPABASE_URL'), key = runtime.env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('Database configuration missing')
  const response = await runtime.fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new RpcError(error.code ?? 'unknown', typeof error.message === 'string' ? error.message : '') }
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}
/**
 * An RPC as the signed-in user whose access token the browser sent, so the database checks that user's
 * workspace membership exactly as for direct calls. An invalid or expired token fails with code "401".
 */
export async function rpcAs<T>(runtime: Runtime, accessToken: string, name: string, body: Record<string, unknown>): Promise<T> {
  const url = runtime.env('SUPABASE_URL'), key = runtime.env('SUPABASE_ANON_KEY') || runtime.env('SUPABASE_PUBLISHABLE_KEY')
  if (!url || !key) throw new Error('Database configuration missing')
  const response = await runtime.fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new RpcError(response.status === 401 ? '401' : error.code ?? 'unknown', typeof error.message === 'string' ? error.message : '') }
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}
export interface SendResult { outcome: 'accepted' | 'pending' | 'failed'; reference: string | null; failure: string | null }
/** One Resend call. Retries must reuse the same key and body so the provider can suppress duplicates. */
export async function sendEmail(runtime: Runtime, idempotencyKey: string, email: unknown): Promise<SendResult> {
  try {
    const response = await runtime.fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${runtime.env('RESEND_API_KEY')}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(email), signal: AbortSignal.timeout(10000),
    })
    const body = await response.json().catch(() => ({}))
    if (response.ok && typeof body.id === 'string') return { outcome: 'accepted', reference: body.id, failure: null }
    return { outcome: response.status >= 400 && response.status < 500 && ![408,429].includes(response.status) ? 'failed' : 'pending', reference: null, failure: `provider_http_${response.status}` }
  } catch { /* Unknown outcome: retry with the identical body and idempotency key. */ }
  return { outcome: 'pending', reference: null, failure: 'provider_unreachable' }
}
interface Job { request_id: string; lease_id: string; email: Record<string, unknown> }
// A provider acceptance is not an inbox-delivery confirmation. No delivery claim is made.
export async function deliverOne(runtime: Runtime, submissionId: string | null = null): Promise<string> {
  if (!runtime.env('RESEND_API_KEY')) return 'configuration_missing'
  const job = await rpc<Job | null>(runtime, 'claim_notification', { submission_id: submissionId })
  if (!job) return 'no_job'
  const { outcome, reference, failure } = await sendEmail(runtime, `leadflow/${job.request_id}`, job.email)
  await rpc(runtime, 'finish_notification', { submission_id: job.request_id, lease: job.lease_id, outcome, provider_reference: reference, failure_code: failure })
  return outcome
}
