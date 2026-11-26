import type { PGlite } from '@electric-sql/pglite'
import type { Page } from '@playwright/test'
import { createClientsHarness } from './clients.ts'
// Type-only: supabase.ts uses syntax Node's type stripping can't load, and the database suites import this file.
import type { SupabaseMock } from './supabase.ts'
const apiOrigin = 'http://127.0.0.1:54329'
import { createClientHubHandler } from '../../supabase/functions/client-hub/handler.ts'
import { createPortalNotificationsHandler } from '../../supabase/functions/portal-notifications/handler.ts'
import type { Runtime } from '../../supabase/functions/_shared/runtime.ts'

export interface CreatedAccount { id: string; email: string; password: string; appMetadata: Record<string, unknown>; name: string }
/**
 * The client-hub and portal-notifications Edge handlers (plus client-files and client-portal from the clients harness)
 * wired to embedded PostgreSQL, with stand-ins for the Supabase Auth admin API and the Resend email API. Nothing leaves
 * the process; tests read the accounts created and the emails "sent".
 */
export function createCollabHarness(db: PGlite, overrides: Record<string, string> = {}) {
  const base = createClientsHarness(db, { NOTIFICATION_WORKER_SECRET: 'w'.repeat(40), RESEND_API_KEY: 're_test_key', NOTIFICATION_FROM: 'LeadFlow <hello@app.example>',
    APP_URL: 'http://127.0.0.1:5175', ...overrides })
  const accounts = new Map<string, CreatedAccount>()
  const email = { sent: [] as { key: string; body: Record<string, unknown> }[], failWith: null as number | null }
  const hooks = { onAccount: (_account: CreatedAccount) => {} }
  const asOperator = <T>(sql: string, params: unknown[]) => db.transaction(async tx => { await tx.exec('set local role postgres'); return (await tx.query<T>(sql, params)).rows })
  const runtime: Runtime = { env: base.runtime.env, fetch: async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'
    if (url.origin === base.config.SUPABASE_URL && url.pathname === '/auth/v1/admin/users' && method === 'POST') {
      if (new Headers(init?.headers).get('Authorization') !== `Bearer ${base.config.SUPABASE_SERVICE_ROLE_KEY}`) return Response.json({ msg: 'This endpoint requires a valid service key' }, { status: 401 })
      const body = JSON.parse(String(init?.body)) as { email: string; password: string; email_confirm: boolean; app_metadata: Record<string, unknown>; user_metadata?: { name?: string } }
      const address = String(body.email).toLowerCase()
      if ((await asOperator('select 1 from auth.users where lower(email) = $1', [address])).length) return Response.json({ code: 'email_exists', msg: 'A user with this email address has already been registered' }, { status: 422 })
      if (String(body.password).length < 6) return Response.json({ code: 'weak_password', msg: 'Password should be at least 6 characters.' }, { status: 422 })
      const account: CreatedAccount = { id: crypto.randomUUID(), email: address, password: body.password, appMetadata: body.app_metadata ?? {}, name: body.user_metadata?.name ?? '' }
      await asOperator('insert into auth.users(id, email) values ($1, $2)', [account.id, address])
      accounts.set(address, account)
      hooks.onAccount(account)
      return Response.json({ id: account.id, email: address, app_metadata: account.appMetadata, email_confirmed_at: body.email_confirm ? new Date().toISOString() : null })
    }
    if (url.href === 'https://api.resend.com/emails' && method === 'POST') {
      const key = new Headers(init?.headers).get('Idempotency-Key') ?? ''
      if (email.failWith) return Response.json({ message: 'failed' }, { status: email.failWith })
      // Resend answers a repeated idempotency key with the same result instead of sending again.
      if (!email.sent.some(item => item.key === key)) email.sent.push({ key, body: JSON.parse(String(init?.body)) })
      return Response.json({ id: `re_${email.sent.findIndex(item => item.key === key) + 1}` })
    }
    return base.runtime.fetch(input, init)
  } }
  return { ...base, runtime, accounts, email, hooks, hub: createClientHubHandler(runtime), worker: createPortalNotificationsHandler(runtime) }
}
export type CollabHarness = ReturnType<typeof createCollabHarness>
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
/** A client portal account's token: app_metadata.account_type = 'client', as client-hub creates it. */
export const clientToken = (id: string) => [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub: id, role: 'authenticated', app_metadata: { account_type: 'client' }, exp: Math.floor(Date.now() / 1000) + 3600 }), 'test-signature'].join('.')
export const hubRequest = (body: Record<string, unknown>, token: string | null, origin = 'http://127.0.0.1:5175') =>
  new Request('https://functions.test/client-hub', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
export const workerRequest = (secret: string) => new Request('https://functions.test/portal-notifications', { method: 'POST', headers: { 'x-worker-secret': secret } })

/** Browser tests: Edge Functions and signed Storage requests reach the harness; accounts it creates can sign in. */
export async function routeCollabFunctions(page: Page, harness: CollabHarness, supabase: SupabaseMock, extra: Record<string, (request: Request) => Promise<Response>> = {}) {
  harness.hooks.onAccount = account => { supabase.users.set(account.email, { id: account.id, email: account.email, password: account.password, confirmed: true, appMetadata: account.appMetadata }) }
  const handlers: Record<string, (request: Request) => Promise<Response>> = { 'client-files': harness.files, 'client-portal': harness.portal, 'client-hub': harness.hub, ...extra }
  for (const [name, handler] of Object.entries(handlers)) await page.route(`${apiOrigin}/functions/v1/${name}`, async route => {
    const request = route.request()
    const response = await handler(new Request(request.url(), { method: request.method(), headers: request.headers(), body: request.method() === 'POST' ? request.postData() : undefined }))
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
  })
  await page.route(`${apiOrigin}/storage/v1/**`, async route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, PUT, POST, OPTIONS', 'access-control-allow-headers': '*' } })
    const response = await harness.runtime.fetch(`${harness.config.SUPABASE_URL}${url.pathname}${url.search}`, { method: request.method(), headers: request.headers(), body: request.postDataBuffer() ?? undefined })
    return route.fulfill({ status: response.status, headers: { 'access-control-allow-origin': '*', ...Object.fromEntries(response.headers) }, body: Buffer.from(await response.arrayBuffer()) })
  })
}
