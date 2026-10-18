export interface Runtime { env: (name: string) => string | undefined; fetch: typeof fetch }
export class RpcError extends Error {
  code: string
  constructor(code: string) { super('Database operation failed'); this.code = code }
}
export async function rpc<T>(runtime: Runtime, name: string, body: Record<string, unknown>): Promise<T> {
  const url = runtime.env('SUPABASE_URL'), key = runtime.env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('Database configuration missing')
  const response = await runtime.fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new RpcError(error.code ?? 'unknown') }
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}
interface Job { request_id: string; lease_id: string; email: Record<string, unknown> }
// A provider acceptance is not an inbox-delivery confirmation. No delivery claim is made.
export async function deliverOne(runtime: Runtime, submissionId: string | null = null): Promise<string> {
  if (!runtime.env('RESEND_API_KEY')) return 'configuration_missing'
  const job = await rpc<Job | null>(runtime, 'claim_notification', { submission_id: submissionId })
  if (!job) return 'no_job'
  let outcome = 'pending', reference: string | null = null, failure: string | null = 'provider_unreachable'
  try {
    const response = await runtime.fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${runtime.env('RESEND_API_KEY')}`, 'Content-Type': 'application/json', 'Idempotency-Key': `leadflow/${job.request_id}` },
      body: JSON.stringify(job.email), signal: AbortSignal.timeout(10000),
    })
    const body = await response.json().catch(() => ({}))
    if (response.ok && typeof body.id === 'string') { outcome = 'accepted'; reference = body.id; failure = null }
    else { outcome = response.status >= 400 && response.status < 500 && ![408,429].includes(response.status) ? 'failed' : 'pending'; failure = `provider_http_${response.status}` }
  } catch { /* Unknown outcome: retry with the identical body and idempotency key. */ }
  await rpc(runtime, 'finish_notification', { submission_id: job.request_id, lease: job.lease_id, outcome, provider_reference: reference, failure_code: failure })
  return outcome
}
