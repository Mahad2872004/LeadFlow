import { boundedJson } from '../_shared/request.ts'
import { rpc, RpcError, type Runtime } from '../_shared/runtime.ts'
const tokenFormat = /^lf_[0-9a-f]{64}$/
/**
 * Receives Apollo's asynchronous phone-number results. Each reveal gets its own random token in the webhook URL; only
 * its SHA-256 hash is stored, and it selects exactly one ledger entry. Apollo may retry deliveries, and the database
 * records the first one only. Nothing from the payload is logged.
 */
export function createApolloWebhookHandler(runtime: Runtime) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
    if (request.method !== 'POST') return respond(405, { error: 'Use POST.' })
    const token = new URL(request.url).searchParams.get('token') ?? ''
    if (!tokenFormat.test(token)) return respond(404, { error: 'Unknown delivery.' })
    let payload: Record<string, unknown>
    try { payload = await boundedJson(request, 200000) } catch { return respond(400, { error: 'Send JSON smaller than 200 KB.' }) }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), x => x.toString(16).padStart(2, '0')).join('')
    try {
      const outcome = await rpc<string>(runtime, 'apollo_phone_result', { token_hash: hash, payload })
      console.log(`apollo-webhook ${outcome}`)
      return respond(200, { ok: true })
    } catch (error) {
      if (error instanceof RpcError && error.code === 'P0002') return respond(404, { error: 'Unknown delivery.' })
      if (error instanceof RpcError && error.code === '22023') return respond(400, { error: 'Invalid payload.' })
      // Apollo retries failed deliveries.
      return respond(503, { error: 'Try again later.' })
    }
  }
}
