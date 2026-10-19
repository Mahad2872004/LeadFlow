import type { Page, Route, Request } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
/**
 * Browser-test stand-in for Supabase's HTTP services. Auth is simulated in memory. Every RPC runs the
 * real function from the migrations in embedded PostgreSQL, as the role and user in the request's
 * bearer token, so database authorization is exercised exactly as written.
 */
export const apiOrigin = 'http://127.0.0.1:54329'
export interface TestUser { id: string; email: string; password: string; confirmed?: boolean }
/** Status 0 drops the connection, as a network failure would. */
export interface Reply { status: number; body?: unknown }
export interface SupabaseMockOptions {
  users?: TestUser[]
  signupEnabled?: boolean
  confirmEmail?: boolean
  /** Return a reply to answer an RPC without running it, or a promise to hold the request until it settles. */
  beforeRpc?: (name: string, args: Record<string, unknown>) => Reply | void | Promise<Reply | void>
  /** Return a reply to replace the response of an RPC that already ran (and committed). */
  afterRpc?: (name: string, reply: Reply) => Reply | void
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
export const tokenFor = (user: { id: string; email: string }) => [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }), 'test-signature'].join('.')
const json = (request: Request): Record<string, unknown> => { try { return request.postDataJSON() ?? {} } catch { return {} } }
export class SupabaseMock {
  readonly users = new Map<string, TestUser>()
  readonly rpcCalls: string[] = []
  /** Every RPC with its arguments, for checking which workspace a request targeted. */
  readonly rpcLog: { name: string; args: Record<string, unknown>; user: string }[] = []
  readonly resent: string[] = []
  readonly signupRedirects: (string | null)[] = []
  constructor(readonly db: PGlite, public options: SupabaseMockOptions = {}) {
    for (const user of options.users ?? []) this.users.set(user.email.toLowerCase(), { confirmed: true, ...user })
  }
  /** Run SQL as a signed-in user, the way PostgREST would. */
  queryAs<T>(userId: string | null, sql: string, params: unknown[] = []) {
    return this.db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)", [userId ?? '', JSON.stringify(userId ? { sub: userId, role: 'authenticated' } : { role: 'anon' })])
      await tx.exec(`set local role ${userId ? 'authenticated' : 'anon'}`)
      return (await tx.query<T>(sql, params)).rows
    })
  }
  /** Run SQL as the database operator (Supabase's SQL editor). */
  admin<T>(sql: string, params: unknown[] = []) {
    return this.db.transaction(async tx => { await tx.exec('set local role postgres'); return (await tx.query<T>(sql, params)).rows })
  }
  /** Equivalent to the user opening their confirmation email link. */
  confirm(email: string) { const user = this.users.get(email.toLowerCase()); if (user) user.confirmed = true }
  async addUser(user: TestUser) { await this.admin('insert into auth.users(id,email) values($1,$2)', [user.id, user.email]); this.users.set(user.email.toLowerCase(), { confirmed: true, ...user }) }
  private userJson(user: TestUser) {
    return { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, email_confirmed_at: user.confirmed ? '2026-10-20T00:00:00Z' : null, phone: '', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z' }
  }
  private session(user: TestUser) {
    return { access_token: tokenFor(user), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `refresh-${user.id}`, user: this.userJson(user) }
  }
  private caller(request: Request) {
    const token = request.headers()['authorization']?.replace(/^Bearer /, '') ?? ''
    try { const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); if (typeof claims.sub === 'string') return { role: 'authenticated', sub: claims.sub as string, claims } } catch { /* the public key is not a JWT */ }
    return { role: 'anon', sub: '', claims: { role: 'anon' } }
  }
  async handle(route: Route) {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname.startsWith('/auth/v1/')) return this.auth(route, url)
    if (url.pathname.startsWith('/rest/v1/rpc/')) return this.rpc(route, decodeURIComponent(url.pathname.slice('/rest/v1/rpc/'.length)))
    return route.fulfill({ status: 404, json: { message: `Unexpected endpoint ${url.pathname}` } })
  }
  private async auth(route: Route, url: URL) {
    const request = route.request(), body = json(request), endpoint = url.pathname.slice('/auth/v1/'.length)
    const failure = (status: number, code: string, msg: string) => route.fulfill({ status, json: { error_code: code, msg } })
    const signupEnabled = this.options.signupEnabled ?? true, confirmEmail = this.options.confirmEmail ?? false
    if (endpoint === 'settings') return route.fulfill({ json: { disable_signup: !signupEnabled, mailer_autoconfirm: !confirmEmail, external: { email: true } } })
    if (endpoint === 'logout') return route.fulfill({ status: 204 })
    if (endpoint === 'resend') { this.resent.push(String(body.email)); return route.fulfill({ json: {} }) }
    if (endpoint === 'user') {
      const caller = this.caller(request), user = [...this.users.values()].find(candidate => candidate.id === caller.sub)
      return user ? route.fulfill({ json: this.userJson(user) }) : failure(401, 'bad_jwt', 'Invalid JWT')
    }
    if (endpoint === 'signup') {
      if (!signupEnabled) return failure(422, 'signup_disabled', 'Signups not allowed for this instance')
      const email = String(body.email ?? '').trim().toLowerCase(), password = String(body.password ?? '')
      if (password.length < 6) return failure(422, 'weak_password', 'Password should be at least 6 characters.')
      this.signupRedirects.push(url.searchParams.get('redirect_to'))
      const existing = this.users.get(email)
      // With confirmation on, Supabase answers an existing address like a new one, so accounts cannot be probed.
      if (existing) return confirmEmail ? route.fulfill({ json: this.userJson(existing) }) : failure(422, 'user_already_exists', 'User already registered')
      const user: TestUser = { id: crypto.randomUUID(), email, password, confirmed: !confirmEmail }
      await this.admin('insert into auth.users(id,email) values($1,$2)', [user.id, email])
      this.users.set(email, user)
      return route.fulfill({ json: confirmEmail ? this.userJson(user) : this.session(user) })
    }
    if (endpoint === 'token') {
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const user = [...this.users.values()].find(candidate => `refresh-${candidate.id}` === body.refresh_token)
        return user ? route.fulfill({ json: this.session(user) }) : failure(400, 'refresh_token_not_found', 'Invalid Refresh Token')
      }
      const user = this.users.get(String(body.email ?? '').toLowerCase())
      if (!user || user.password !== body.password) return failure(400, 'invalid_credentials', 'Invalid login credentials')
      if (!user.confirmed) return failure(400, 'email_not_confirmed', 'Email not confirmed')
      return route.fulfill({ json: this.session(user) })
    }
    return failure(404, 'not_found', `Unexpected auth endpoint ${endpoint}`)
  }
  private async rpc(route: Route, name: string) {
    const request = route.request(), args = json(request), caller = this.caller(request)
    this.rpcCalls.push(name)
    this.rpcLog.push({ name, args, user: caller.sub })
    const early = await this.options.beforeRpc?.(name, args)
    if (early) return this.reply(route, early)
    let reply: Reply
    try {
      const [fn] = await this.admin<{ retset: boolean; rettype: string; inputs: string[] }>(`select p.proretset as retset, p.prorettype::regtype::text as rettype,
        array(select n from unnest(coalesce(p.proargnames, '{}'), coalesce(p.proargmodes, array_fill('i'::"char", array[coalesce(cardinality(p.proargnames), 0)]))) as a(n, m) where m in ('i','b','v')) as inputs
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [name])
      const keys = Object.keys(args)
      if (!fn || keys.some(key => !fn.inputs.includes(key))) return this.reply(route, { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${name}` } })
      const call = `public.${name}(${keys.map((key, index) => `"${key}" => $${index + 1}`).join(', ')})`
      const values = keys.map(key => typeof args[key] === 'object' && args[key] !== null ? JSON.stringify(args[key]) : args[key])
      const result = await this.db.transaction(async tx => {
        await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)", [caller.sub, JSON.stringify(caller.claims)])
        await tx.exec(`set local role ${caller.role}`)
        return fn.retset ? (await tx.query(`select * from ${call}`, values)).rows : (await tx.query<{ result: unknown }>(`select ${call} as result`, values)).rows[0]?.result
      })
      reply = fn.rettype === 'void' ? { status: 204 } : { status: 200, body: result ?? null }
    } catch (error) {
      const { code, message } = error as { code?: string; message: string }
      reply = { status: code === '42501' ? (caller.role === 'anon' ? 401 : 403) : 400, body: { code, message, details: null, hint: null } }
    }
    return this.reply(route, this.options.afterRpc?.(name, reply) ?? reply)
  }
  private reply(route: Route, reply: Reply) {
    if (reply.status === 0) return route.abort('failed')
    return reply.status === 204 ? route.fulfill({ status: 204 }) : route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body ?? null) })
  }
}
/** Serve Supabase for this page. Register more specific routes (such as Edge Functions) afterwards. */
export async function mockSupabase(page: Page, db: PGlite, options: SupabaseMockOptions = {}) {
  const mock = new SupabaseMock(db, options)
  await page.route(`${apiOrigin}/**`, route => mock.handle(route))
  return mock
}
/** Fill and submit the sign-in form. */
export async function signIn(page: Page, email: string, password = 'test-password') {
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
