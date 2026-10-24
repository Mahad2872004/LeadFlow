import type { PGlite } from '@electric-sql/pglite'
import { createPortalHandler } from '../../supabase/functions/client-portal/handler.ts'
import { createReminderHandler } from '../../supabase/functions/onboarding-reminders/handler.ts'
import type { Runtime } from '../../supabase/functions/_shared/runtime.ts'
/**
 * The client-portal and onboarding-reminders Edge handlers, wired to embedded PostgreSQL. Their service-role
 * RPCs run as the service_role database role with no user claims, as PostgREST would run them. Only the email
 * provider is simulated; no email is sent.
 */
export function createOnboardingHarness(db: PGlite, overrides: Record<string, string> = {}) {
  const config: Record<string, string> = { SUPABASE_URL: 'http://127.0.0.1:54329', SUPABASE_SERVICE_ROLE_KEY: 'test-server-key',
    PORTAL_ALLOWED_ORIGINS: 'http://127.0.0.1:5175,http://127.0.0.1:4175', PORTAL_URL: 'http://127.0.0.1:5175/client-portal',
    RESEND_API_KEY: 'test-resend-secret', NOTIFICATION_FROM: 'LeadFlow <onboarding@example.com>', NOTIFICATION_WORKER_SECRET: 'test-worker-secret-at-least-32-characters', ...overrides }
  const state = { providerStatus: 200, providerTimeout: false, providerCalls: [] as { key: string; body: string }[], accepted: new Map<string, string>(), rpcCalls: [] as string[] }
  const runtime: Runtime = { env: name => config[name], fetch: async (input, init) => {
    const url = String(input)
    if (url === 'https://api.resend.com/emails') {
      const key = new Headers(init?.headers).get('Idempotency-Key')!, body = String(init?.body)
      state.providerCalls.push({ key, body })
      if (state.providerStatus !== 200) return Response.json({ message: 'Simulated failure' }, { status: state.providerStatus })
      if (state.accepted.has(key) && state.accepted.get(key) !== body) return Response.json({ error: 'Different payload for idempotency key' }, { status: 409 })
      state.accepted.set(key, body)
      if (state.providerTimeout) throw new Error('Simulated ambiguous network failure')
      return Response.json({ id: `provider-${key}` })
    }
    const name = url.match(/\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1]
    if (!name) throw new Error(`Unexpected test URL ${url}`)
    state.rpcCalls.push(name)
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>, keys = Object.keys(args)
    const values = keys.map(key => typeof args[key] === 'object' && args[key] !== null ? JSON.stringify(args[key]) : args[key])
    try {
      const result = await db.transaction(async tx => {
        await tx.query("select set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")
        await tx.exec('set local role service_role')
        return (await tx.query<{ result: unknown }>(`select public.${name}(${keys.map((key, index) => `"${key}" => $${index + 1}`).join(', ')}) as result`, values)).rows[0]?.result
      })
      return name === 'finish_onboarding_reminder' ? new Response(null, { status: 204 }) : Response.json(result ?? null)
    } catch (error) {
      const { code, message } = error as { code?: string; message: string }
      return Response.json({ code, message }, { status: 400 })
    }
  } }
  return { config, state, runtime, portal: createPortalHandler(runtime), reminders: createReminderHandler(runtime) }
}
export const portalRequest = (body: Record<string, unknown>, origin = 'http://127.0.0.1:5175') =>
  new Request('https://functions.test/client-portal', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
