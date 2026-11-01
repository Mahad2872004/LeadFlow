// The Apollo.io REST API, server-side only. Keys come from the APOLLO_API_KEYS secret and are sent in the x-api-key
// header; they never leave this module, appear in errors or reach the browser. Endpoints, parameters and response
// fields follow docs.apollo.io as checked on 1 November 2026.
import { buildQuery, type FilterValues, type SearchKind } from './filters.ts'
export const apolloBase = 'https://api.apollo.io/api/v1'
export interface ApolloAccountKey { id: string; key: string }
/**
 * Accounts configured for this deployment: APOLLO_API_KEYS="primary:KEY,client-b:KEY2", or APOLLO_API_KEY=KEY for one
 * account called "default". Labels are lowercase letters, numbers, - and _.
 */
export function configuredAccounts(env: (name: string) => string | undefined): ApolloAccountKey[] {
  const accounts: ApolloAccountKey[] = []
  for (const entry of (env('APOLLO_API_KEYS') ?? '').split(',').map(item => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':')
    const id = entry.slice(0, separator).trim().toLowerCase(), key = entry.slice(separator + 1).trim()
    if (separator > 0 && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) && /^[A-Za-z0-9_-]{8,200}$/.test(key) && !accounts.some(account => account.id === id)) accounts.push({ id, key })
  }
  const single = (env('APOLLO_API_KEY') ?? '').trim()
  if (single && /^[A-Za-z0-9_-]{8,200}$/.test(single) && !accounts.some(account => account.id === 'default')) accounts.push({ id: 'default', key: single })
  return accounts
}

export type ApolloFailure = 'unauthorized' | 'forbidden' | 'plan' | 'rate_limited' | 'invalid' | 'unavailable' | 'timeout' | 'ambiguous'
/** A failed Apollo call. `charged` is true when Apollo may have performed the work (a timeout after sending). */
export class ApolloError extends Error {
  kind: ApolloFailure; status: number; retryAfter: number | null; charged: boolean
  constructor(kind: ApolloFailure, message: string, status = 0, retryAfter: number | null = null, charged = false) { super(message); this.kind = kind; this.status = status; this.retryAfter = retryAfter; this.charged = charged }
}
type Fetch = typeof fetch
interface CallOptions { method: 'GET' | 'POST'; path: string; query?: URLSearchParams; body?: unknown; timeoutMs?: number; retrySafe?: boolean }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/** One Apollo request. Only free, read-only calls (retrySafe) are retried, once, after a network error or 5xx. */
export async function apolloCall<T>(fetcher: Fetch, account: ApolloAccountKey, options: CallOptions, wait = sleep): Promise<T> {
  const url = `${apolloBase}${options.path}${options.query && [...options.query].length ? `?${options.query}` : ''}`
  for (let attempt = 1; ; attempt++) {
    let response: Response
    try {
      response = await fetcher(url, { method: options.method, headers: { 'x-api-key': account.key, 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-cache' },
        body: options.body === undefined ? (options.method === 'POST' ? '{}' : undefined) : JSON.stringify(options.body), signal: AbortSignal.timeout(options.timeoutMs ?? 30000) })
    } catch (error) {
      if (options.retrySafe && attempt < 2) { await wait(1000); continue }
      const timeout = (error as Error).name === 'TimeoutError'
      // Once a request was sent, Apollo may have done the work even though no answer arrived.
      throw new ApolloError(timeout ? 'timeout' : 'unavailable', timeout ? 'Apollo took too long to answer.' : 'Apollo could not be reached.', 0, null, !options.retrySafe)
    }
    if (response.ok) {
      const body = await response.json().catch(() => null)
      if (body === null) throw new ApolloError('ambiguous', 'Apollo returned an unreadable answer.', response.status, null, !options.retrySafe)
      return body as T
    }
    const text = await response.text().catch(() => '')
    let detail: { error?: string; message?: string; error_code?: string; error_details?: { code?: string }; retry_after_seconds?: number } = {}
    try { detail = JSON.parse(text) } catch { /* Apollo answers 401 in plain text. */ }
    const code = detail.error_details?.code ?? detail.error_code ?? '', message = String(detail.message ?? detail.error ?? '').slice(0, 200)
    if (response.status >= 500 && options.retrySafe && attempt < 2) { await wait(1000); continue }
    if (response.status === 401) throw new ApolloError('unauthorized', 'Apollo rejected the API key. Check the key for this account.', 401)
    if (response.status === 403) {
      if (/paid plan|upgrade|plan/i.test(message)) throw new ApolloError('plan', 'Apollo says this needs a paid Apollo plan.', 403)
      throw new ApolloError('forbidden', code === 'AUTH.AUTHORIZATION.ENDPOINT_ACCESS_DENIED'
        ? 'This API key isn’t allowed to use this Apollo endpoint. In Apollo, edit the key and tick the endpoint, or use a master key.'
        : 'Apollo refused this request for this account.', 403)
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? detail.retry_after_seconds ?? 60)
      throw new ApolloError('rate_limited', 'Apollo’s rate limit was reached for this account.', 429, Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 3600) : 60)
    }
    if (response.status === 400 || response.status === 422) throw new ApolloError('invalid', message ? `Apollo didn’t accept the request: ${message}` : 'Apollo didn’t accept the request.', response.status)
    throw new ApolloError('unavailable', `Apollo had a problem (HTTP ${response.status}). Try again in a minute.`, response.status, null, !options.retrySafe && response.status >= 500)
  }
}

// Normalized results. Field names follow what Apollo returns; nothing is guessed.
export interface PersonResult {
  id: string; firstName: string; lastNameObfuscated: string; name: string; title: string; organizationName: string
  hasEmail: boolean; directPhone: 'yes' | 'maybe' | 'no'; hasCity: boolean; hasState: boolean; hasCountry: boolean; lastRefreshedAt: string | null
  organization: { hasIndustry: boolean; hasPhone: boolean; hasEmployeeCount: boolean; hasRevenue: boolean }
}
export interface OrganizationResult {
  id: string; name: string; websiteUrl: string; primaryDomain: string; linkedinUrl: string; twitterUrl: string; facebookUrl: string; phone: string
  foundedYear: number | null; publiclyTradedSymbol: string; languages: string[]; naicsCodes: string[]; sicCodes: string[]
}
export interface SearchPage<T> { items: T[]; page: number; perPage: number; total: number; totalPages: number }
const text = (value: unknown, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const strings = (value: unknown) => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 20) as string[] : []
const isTrue = (value: unknown) => value === true || value === 'true' || value === 'Yes'
// Apollo shows at most 500 pages of 100.
const pagesFor = (total: number, perPage: number) => Math.min(Math.ceil(total / perPage), Math.floor(50000 / perPage))
export async function searchPeople(fetcher: Fetch, account: ApolloAccountKey, filters: FilterValues, page: number, perPage: number): Promise<SearchPage<PersonResult>> {
  const body = await apolloCall<{ people?: unknown[]; total_entries?: number; pagination?: { total_entries?: number } }>(fetcher, account,
    { method: 'POST', path: '/mixed_people/api_search', query: buildQuery('people', filters, page, perPage), retrySafe: true })
  const items = (Array.isArray(body.people) ? body.people : []).flatMap(raw => {
    const person = raw as Record<string, unknown>, organization = (person.organization ?? {}) as Record<string, unknown>
    if (typeof person.id !== 'string' || !person.id) return []
    const firstName = text(person.first_name, 100), obfuscated = text(person.last_name_obfuscated, 100)
    const phone = text(person.has_direct_phone, 100)
    return [{ id: person.id.slice(0, 40), firstName, lastNameObfuscated: obfuscated, name: [firstName, obfuscated].filter(Boolean).join(' ') || 'Unnamed person',
      title: text(person.title, 200), organizationName: text(organization.name, 150), hasEmail: isTrue(person.has_email),
      directPhone: phone === 'Yes' || phone === 'true' ? 'yes' as const : /^maybe/i.test(phone) ? 'maybe' as const : 'no' as const,
      hasCity: isTrue(person.has_city), hasState: isTrue(person.has_state), hasCountry: isTrue(person.has_country),
      lastRefreshedAt: typeof person.last_refreshed_at === 'string' ? person.last_refreshed_at : null,
      organization: { hasIndustry: isTrue(organization.has_industry), hasPhone: isTrue(organization.has_phone), hasEmployeeCount: isTrue(organization.has_employee_count), hasRevenue: isTrue(organization.has_revenue) } }]
  })
  const total = Number(body.total_entries ?? body.pagination?.total_entries ?? items.length) || 0
  return { items, page, perPage, total, totalPages: pagesFor(total, perPage) }
}
/** Organization Search uses 1 credit per page; callers reserve that before calling. */
export async function searchOrganizations(fetcher: Fetch, account: ApolloAccountKey, filters: FilterValues, page: number, perPage: number): Promise<SearchPage<OrganizationResult>> {
  const body = await apolloCall<{ organizations?: unknown[]; accounts?: unknown[]; pagination?: { total_entries?: number } }>(fetcher, account,
    { method: 'POST', path: '/mixed_companies/search', query: buildQuery('organizations', filters, page, perPage) })
  const seen = new Set<string>()
  const items = [...(Array.isArray(body.organizations) ? body.organizations : []), ...(Array.isArray(body.accounts) ? body.accounts : [])].flatMap(raw => {
    const org = raw as Record<string, unknown>, id = typeof org.organization_id === 'string' && org.organization_id ? org.organization_id : org.id
    if (typeof id !== 'string' || !id || seen.has(id)) return []
    seen.add(id)
    const phone = (org.primary_phone ?? {}) as Record<string, unknown>
    return [{ id: id.slice(0, 40), name: text(org.name, 150) || 'Unnamed company', websiteUrl: text(org.website_url), primaryDomain: text(org.primary_domain, 150), linkedinUrl: text(org.linkedin_url),
      twitterUrl: text(org.twitter_url), facebookUrl: text(org.facebook_url), phone: text(phone.sanitized_number, 30) || text(org.sanitized_phone, 30) || text(org.phone, 30),
      foundedYear: Number.isInteger(org.founded_year) ? org.founded_year as number : null, publiclyTradedSymbol: text(org.publicly_traded_symbol, 20),
      languages: strings(org.languages), naicsCodes: strings(org.naics_codes), sicCodes: strings(org.sic_codes) }]
  })
  const total = Number(body.pagination?.total_entries ?? items.length) || 0
  return { items, page, perPage, total, totalPages: pagesFor(total, perPage) }
}

export interface Phone { number: string; type: string; status: string }
export interface RevealedContact {
  id: string; name: string; title: string; email: string; emailStatus: string; phones: Phone[]; linkedinUrl: string
  organizationName: string; organizationDomain: string; city: string; state: string; country: string
}
export interface RevealResult { contacts: RevealedContact[]; unmatched: string[]; creditsConsumed: number | null; requestId: string | null }
const phonesOf = (value: unknown): Phone[] => (Array.isArray(value) ? value : []).flatMap(raw => {
  const phone = raw as Record<string, unknown>, number = text(phone.sanitized_number, 30) || text(phone.raw_number, 30)
  return number ? [{ number, type: text(phone.type_cd ?? phone.type, 40), status: text(phone.status_cd ?? phone.status, 40) }] : []
})
/**
 * Bulk People Enrichment for up to 10 Apollo people by ID: 1 credit per matched person (demographics and work email).
 * With a webhook URL, Apollo also looks up mobile numbers (up to 8 more credits each) and delivers them there later.
 */
export async function revealPeople(fetcher: Fetch, account: ApolloAccountKey, personIds: string[], webhookUrl: string | null): Promise<RevealResult> {
  const query = new URLSearchParams({ reveal_personal_emails: 'false' })
  if (webhookUrl) { query.set('reveal_phone_number', 'true'); query.set('webhook_url', webhookUrl) }
  const body = await apolloCall<{ matches?: unknown[]; credits_consumed?: unknown; request_id?: unknown }>(fetcher, account,
    { method: 'POST', path: '/people/bulk_match', query, body: { details: personIds.map(id => ({ id })) }, timeoutMs: 45000 })
  const matches = Array.isArray(body.matches) ? body.matches : []
  const contacts: RevealedContact[] = [], found = new Set<string>()
  matches.forEach(raw => {
    if (!raw || typeof raw !== 'object') return
    const person = raw as Record<string, unknown>, organization = (person.organization ?? {}) as Record<string, unknown>, contact = (person.contact ?? {}) as Record<string, unknown>
    if (typeof person.id !== 'string' || !personIds.includes(person.id)) return
    found.add(person.id)
    const email = text(person.email, 150).toLowerCase()
    contacts.push({ id: person.id, name: text(person.name, 150) || [text(person.first_name, 75), text(person.last_name, 75)].filter(Boolean).join(' '), title: text(person.title, 200),
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/^email_not_unlocked@/.test(email) ? email : '', emailStatus: text(person.email_status, 40),
      phones: phonesOf(contact.phone_numbers ?? person.phone_numbers), linkedinUrl: /^https?:\/\//.test(text(person.linkedin_url)) ? text(person.linkedin_url) : '',
      organizationName: text(organization.name, 150), organizationDomain: text(organization.primary_domain, 150), city: text(person.city, 100), state: text(person.state, 100), country: text(person.country, 100) })
  })
  const credits = typeof body.credits_consumed === 'number' ? body.credits_consumed : typeof body.credits_consumed === 'string' && Number.isFinite(Number(body.credits_consumed)) ? Number(body.credits_consumed) : null
  return { contacts, unmatched: personIds.filter(id => !found.has(id)), creditsConsumed: credits, requestId: body.request_id === undefined || body.request_id === null ? null : String(body.request_id).slice(0, 40) }
}
/** A free call, used to check that a key works. */
export const testConnection = (fetcher: Fetch, account: ApolloAccountKey) =>
  apolloCall<unknown>(fetcher, account, { method: 'POST', path: '/usage_stats/api_usage_stats', body: { endpoints: ['api/v1/mixed_people/api_search'] }, retrySafe: true })
export interface CreditStats { stats: Record<string, { limit: number | null; consumed: number | null; leftOver: number | null }>; cycleStart: string | null; cycleEnd: string | null }
/** Apollo's own credit balances and billing cycle (free). */
export async function creditUsage(fetcher: Fetch, account: ApolloAccountKey): Promise<CreditStats> {
  const body = await apolloCall<{ credit_usage_stats?: Record<string, unknown>; current_credit_cycle?: { start_date?: unknown; end_date?: unknown } }>(fetcher, account,
    { method: 'POST', path: '/usage_stats/credit_usage_stats', retrySafe: true })
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
  const stats: CreditStats['stats'] = {}
  for (const [type, raw] of Object.entries(body.credit_usage_stats ?? {})) {
    if (!/^[a-z_]{1,40}$/.test(type) || !raw || typeof raw !== 'object') continue
    const value = raw as Record<string, unknown>
    stats[type] = { limit: number(value.limit), consumed: number(value.consumed), leftOver: number(value.left_over) }
  }
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
  return { stats, cycleStart: date(body.current_credit_cycle?.start_date), cycleEnd: date(body.current_credit_cycle?.end_date) }
}
export const searchKindProvider = (kind: SearchKind) => kind === 'people' ? 'apollo_people' : 'apollo_organizations'
