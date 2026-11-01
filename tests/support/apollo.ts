import type { PGlite } from '@electric-sql/pglite'
import { createApolloHandler } from '../../supabase/functions/apollo/handler.ts'
import { createApolloWebhookHandler } from '../../supabase/functions/apollo-webhook/handler.ts'
import type { Runtime } from '../../supabase/functions/_shared/runtime.ts'
/**
 * The apollo and apollo-webhook Edge handlers wired to embedded PostgreSQL. RPCs with the service key run as service_role,
 * RPCs with a user's token run as that user. Apollo's API is simulated from the documented request and response shapes:
 * no request leaves the machine and no credits are used.
 */
export const apolloKeys = { primary: 'key-primary-0123456789', second: 'key-second-0123456789' }
export interface ApolloCall { path: string; query: URLSearchParams; body: unknown; key: string }
export interface SimPerson { id: string; first_name: string; last_name: string; title: string; email: string; organization: string; domain: string; mobile?: string; has_direct_phone?: string }
export interface ApolloState {
  people: SimPerson[]
  organizations: { id: string; name: string; primary_domain: string; website_url: string; linkedin_url: string; primary_phone?: { sanitized_number: string } }[]
  calls: ApolloCall[]
  /** Answers for the next Apollo calls, in order, before answering normally: an HTTP status, or 'timeout'. */
  failures: (number | 'timeout' | { status: number; body: unknown })[]
  creditStats: Record<string, unknown>
  /** Holds bulk_match until released, to test concurrent operations. */
  hold: Promise<void> | null
}
export function createApolloHarness(db: PGlite, overrides: Record<string, string | undefined> = {}) {
  const config: Record<string, string | undefined> = { SUPABASE_URL: 'https://project.test', SUPABASE_SERVICE_ROLE_KEY: 'test-server-key', SUPABASE_ANON_KEY: 'test-public-key',
    DISCOVERY_ALLOWED_ORIGINS: 'http://127.0.0.1:5175,http://127.0.0.1:4175', APOLLO_API_KEYS: `primary:${apolloKeys.primary},second:${apolloKeys.second}`, ...overrides }
  const state: ApolloState = { people: [], organizations: [], calls: [], failures: [], hold: null,
    creditStats: { credit_usage_stats: { lead_credit: { limit: 70, consumed: 3, left_over: 67 }, direct_dial_credit: { limit: 5, consumed: 0, left_over: 5 } },
      current_credit_cycle: { start_date: '2026-10-20T00:00:00Z', end_date: '2026-11-20T00:00:00Z' } } }
  const apollo = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    const headers = new Headers(init?.headers), key = headers.get('x-api-key') ?? '', path = url.pathname.replace('/api/v1', '')
    const body = init?.body ? JSON.parse(String(init.body)) : null
    state.calls.push({ path, query: url.searchParams, body, key })
    if (!Object.values(apolloKeys).includes(key)) return new Response('Invalid access credentials.', { status: 401 })
    const failure = state.failures.shift()
    if (failure === 'timeout') { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error }
    if (typeof failure === 'number') return Response.json({ error: 'Simulated failure', error_code: failure === 429 ? 'USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED' : 'SIMULATED' }, { status: failure, headers: failure === 429 ? { 'retry-after': '30' } : {} })
    if (failure) return Response.json(failure.body, { status: failure.status })
    if (path === '/mixed_people/api_search') {
      const perPage = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'))
      const people = state.people.slice((page - 1) * perPage, page * perPage).map(person => ({ id: person.id, first_name: person.first_name,
        last_name_obfuscated: `${person.last_name.slice(0, 2)}***${person.last_name.slice(-1)}`, title: person.title, last_refreshed_at: '2026-10-01T00:00:00.000+00:00',
        has_email: !!person.email, has_city: true, has_state: true, has_country: true, has_direct_phone: person.has_direct_phone ?? (person.mobile ? 'Yes' : 'Maybe: please request direct dial via people/bulk_match'),
        organization: { name: person.organization, has_industry: true, has_phone: true, has_city: true, has_state: false, has_country: true, has_zip_code: false, has_revenue: true, has_employee_count: true } }))
      return Response.json({ total_entries: state.people.length, people })
    }
    if (path === '/mixed_companies/search') {
      return Response.json({ breadcrumbs: [], partial_results_only: false, pagination: { page: Number(url.searchParams.get('page')), per_page: Number(url.searchParams.get('per_page')), total_entries: state.organizations.length, total_pages: 1 },
        accounts: [], organizations: state.organizations.map(org => ({ ...org, twitter_url: null, founded_year: 2012, languages: ['English'], naics_codes: ['54181'], sic_codes: ['7311'] })) })
    }
    if (path === '/people/bulk_match') {
      if (state.hold) await state.hold
      if (url.searchParams.get('reveal_phone_number') === 'true' && !/^https:\/\//.test(url.searchParams.get('webhook_url') ?? '')) return Response.json({ error: "Please add a valid 'webhook_url' parameter when using 'reveal_phone_number'" }, { status: 400 })
      const matches = (body.details as { id: string }[]).map(detail => {
        const person = state.people.find(item => item.id === detail.id)
        return person ? { id: person.id, first_name: person.first_name, last_name: person.last_name, name: `${person.first_name} ${person.last_name}`, title: person.title, email: person.email, email_status: 'verified',
          linkedin_url: `http://www.linkedin.com/in/${person.id}`, city: 'Austin', state: 'Texas', country: 'United States', organization: { name: person.organization, primary_domain: person.domain }, contact: { phone_numbers: [] } } : null
      })
      const matched = matches.filter(Boolean).length
      return Response.json({ status: 'success', error_code: null, error_message: null, total_requested_enrichments: matches.length, unique_enriched_records: matched, missing_records: matches.length - matched,
        credits_consumed: matched, matches, request_id: 12345 })
    }
    if (path === '/usage_stats/api_usage_stats') return Response.json({ 'api/v1/mixed_people/api_search': { day: { limit: 600, consumed: 1, left_over: 599 } } })
    if (path === '/usage_stats/credit_usage_stats') return Response.json(state.creditStats)
    return new Response('Not found', { status: 404 })
  }
  const runtime: Runtime = { env: name => config[name], fetch: async (input, init) => {
    const url = new URL(String(input))
    if (url.origin === 'https://api.apollo.io') return apollo(url, init)
    const name = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1]
    if (!name || url.origin !== config.SUPABASE_URL) throw new Error(`Unexpected test URL ${url.href}`)
    const token = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '') ?? ''
    let role = 'service_role', sub = ''
    if (token !== config.SUPABASE_SERVICE_ROLE_KEY) {
      try { sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; role = 'authenticated' } catch { return Response.json({ code: 'PGRST301', message: 'Invalid JWT' }, { status: 401 }) }
    }
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>, keys = Object.keys(args)
    // jsonb arguments travel as JSON text; apollo_accounts_status takes a text[] (PostgREST converts JSON arrays to it).
    const values = keys.map(key => name === 'apollo_accounts_status' ? args[key] : typeof args[key] === 'object' && args[key] !== null ? JSON.stringify(args[key]) : args[key])
    try {
      const result = await db.transaction(async tx => {
        await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)", [sub, JSON.stringify(sub ? { sub, role } : { role })])
        await tx.exec(`set local role ${role}`)
        return (await tx.query<{ result: unknown }>(`select public.${name}(${keys.map((key, index) => `"${key}" => $${index + 1}`).join(', ')}) as result`, values)).rows[0]?.result
      })
      return result === undefined || result === null ? new Response(null, { status: 204 }) : Response.json(result)
    } catch (error) {
      const { code, message } = error as { code?: string; message: string }
      return Response.json({ code, message }, { status: code === '42501' ? 403 : 400 })
    }
  } }
  return { config, state, runtime, handler: createApolloHandler(runtime), webhook: createApolloWebhookHandler(runtime) }
}
export const apolloRequest = (body: Record<string, unknown>, token: string | null, origin = 'http://127.0.0.1:5175') =>
  new Request('https://functions.test/apollo', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
export const demoPeople = (): SimPerson[] => [
  { id: '5f1a2b3c4d5e6f7a8b9c0d1e', first_name: 'Avery', last_name: 'Stone', title: 'Marketing Manager', email: 'avery@harbor-dental.example', organization: 'Harbor Dental', domain: 'harbor-dental.example', mobile: '+15125550101' },
  { id: '5f1a2b3c4d5e6f7a8b9c0d2f', first_name: 'Jordan', last_name: 'Lee', title: 'Owner', email: 'jordan@pine-law.example', organization: 'Pine Law', domain: 'pine-law.example' },
  { id: '5f1a2b3c4d5e6f7a8b9c0d3a', first_name: 'Sam', last_name: 'Rivera', title: 'Office Manager', email: '', organization: 'Quiet Studio', domain: 'quiet.example' },
]
