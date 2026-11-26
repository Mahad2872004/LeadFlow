import { rpc, RpcError, type Runtime } from '../_shared/runtime.ts'
import { boundedText, sameDigest, signWebhook, webhookSecret } from '../_shared/automation/webhook.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const toleranceSeconds = 300

/**
 * Signed webhooks that start one workflow (M13). Server to server only, like inbound-lead: browser origins are refused.
 * Every request needs the endpoint ID, a timestamp within five minutes and an HMAC-SHA256 signature of
 * `${timestamp}.${body}` with the endpoint's key. The body is { eventId, data }: the sender's unique event ID (a repeat is a
 * duplicate, not a second run) and the fields the workflow declares. Only those fields are kept, each checked against
 * its type; the request can't choose any other operation. Responses never reveal whether an endpoint exists.
 */
export function createAutomationWebhookHandler(runtime: Runtime, now: () => number = () => Date.now()) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
    if (request.method !== 'POST') return respond(405, { error: 'Use POST.' })
    if (request.headers.has('Origin')) return respond(403, { error: 'Webhooks are for server-to-server requests.' })
    const serverSecret = runtime.env('EMAIL_HASH_SECRET') ?? ''
    if (serverSecret.length < 32) return respond(503, { error: 'Webhooks are not configured.' })
    const webhookId = request.headers.get('X-LeadFlow-Webhook') ?? ''
    const timestamp = request.headers.get('X-LeadFlow-Timestamp') ?? ''
    const signature = (request.headers.get('X-LeadFlow-Signature') ?? '').match(/^v1=([a-f0-9]{64})$/)?.[1]
    if (!uuid.test(webhookId) || !signature) return respond(401, { error: 'Send X-LeadFlow-Webhook, X-LeadFlow-Timestamp and X-LeadFlow-Signature (v1=<hex>).' })
    if (!/^\d{9,11}$/.test(timestamp) || Math.abs(now() / 1000 - Number(timestamp)) > toleranceSeconds) {
      return respond(401, { error: 'The timestamp is missing or more than five minutes away from the server time.' })
    }
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return respond(415, { error: 'Send JSON (Content-Type: application/json).' })
    let raw: string
    try { raw = await boundedText(request) } catch { return respond(413, { error: 'Send a JSON body smaller than 16 KB.' }) }
    try {
      if (!await rpc<boolean>(runtime, 'inquiry_rate_limit', { bucket_key: `automation-webhook-${webhookId.toLowerCase()}` })) {
        return respond(429, { error: 'Rate limit reached (60 requests a minute). Retry later with the same event ID.' })
      }
      const endpoint = await rpc<{ id: string; version: number } | null>(runtime, 'automation_webhook_lookup', { webhook_id: webhookId })
      const expected = endpoint ? await signWebhook(await webhookSecret(serverSecret, endpoint.id, endpoint.version), timestamp, raw) : null
      if (!endpoint || !expected || !sameDigest(expected, signature)) {
        if (endpoint) await rpc(runtime, 'automation_webhook_rejected', { webhook_id: endpoint.id }).catch(() => {})
        return respond(401, { error: 'Invalid signature, or the endpoint is unknown or revoked.' })
      }
      let body: Record<string, unknown>
      try { const parsed = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); body = parsed } catch { return respond(400, { error: 'Send a JSON object.' }) }
      const data = body.data ?? {}
      if (typeof body.eventId !== 'string' || !data || typeof data !== 'object' || Array.isArray(data)) return respond(422, { error: 'Send { "eventId": "<unique id>", "data": { … } }.' })
      const result = await rpc<{ accepted: boolean; duplicate?: boolean; reason?: string }>(runtime, 'automation_receive_webhook',
        { webhook_id: endpoint.id, secret_version: endpoint.version, event_id: body.eventId, payload: data })
      if (!result.accepted) return respond(409, { error: result.reason ?? 'The workflow isn’t active.' })
      console.log(`automation-webhook ${endpoint.id} ${result.duplicate ? 'duplicate' : 'accepted'}`)
      return respond(202, { received: true, duplicate: result.duplicate === true })
    } catch (error) {
      if (error instanceof RpcError && error.code === '28000') return respond(401, { error: 'Invalid signature, or the endpoint is unknown or revoked.' })
      if (error instanceof RpcError && error.code === '22023') return respond(422, { error: error.detail || 'Invalid data.' })
      return respond(503, { error: 'Couldn’t record the event. Retry with the same event ID.' })
    }
  }
}
