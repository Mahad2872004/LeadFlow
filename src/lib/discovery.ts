import { supabase } from './supabase'
import { failure, RequestError } from './backend'
import { countries, type Lead } from './model'
import { domainOf, phoneKey, placeKeys } from './leadKeys'
export { domainOf } from './leadKeys'

/** Business search is shown as "coming soon" unless the build sets VITE_DISCOVERY_SEARCH=on. CSV import and manual entry are always on. */
export const searchEnabled = import.meta.env.VITE_DISCOVERY_SEARCH === 'on'
export type ContactFilter = 'website' | 'phone' | 'email'
export interface Capabilities {
  countries: string[]; categories: { id: string; label: string }[]; customKeyword: boolean; filters: ContactFilter[]
  maxLocations: number; maxResultsPerLocation: number; pagination: 'none' | 'cursor'; fields: string[]
  attribution: { text: string; url: string }; notes: string[]
}
export interface ProviderStatus { id: string; label: string; configured: boolean; missing: string[]; capabilities: Capabilities }
export interface SearchLocation { country: string; region: string; city: string; postcode: string }
export interface SearchCriteria { category: string; keyword: string; locations: SearchLocation[]; radiusKm: number; require: ContactFilter[]; limit: number }
/** A business exactly as the provider returned it; empty fields were not supplied. */
export interface DiscoveredBusiness {
  id: string; provider: string; providerRef: string; name: string; category: string; website: string; phone: string; email: string
  address: string; city: string; region: string; postcode: string; country: string; sourceUrl: string; sourceUpdatedAt: string | null; matchedLocation: string
}
export interface SearchResult {
  searchId: string; provider: string; fetchedAt: string; criteria: SearchCriteria; results: DiscoveredBusiness[]
  truncated: boolean; nextCursor: string | null; warnings: string[]; attribution: { text: string; url: string }
}
export interface HistoryItem {
  id: string; provider: string; criteria: SearchCriteria; status: 'running' | 'completed' | 'failed' | 'interrupted'
  resultCount: number | null; truncated: boolean; failure: string | null; createdAt: string; finishedAt: string | null; mine: boolean
}
export interface LeadOrigin {
  leadId: string; method: 'discovery' | 'csv'; provider: string | null; providerRef: string | null; searchId: string | null
  sourceUrl: string | null; sourceUpdatedAt: string | null; discoveredAt: string | null; importedAt: string
}
/** One lead to import. The database validates every field again and decides duplicates. */
export interface ImportRow {
  key: string; businessName: string; contactName: string; email: string; phone: string; website: string; industry: string
  address: string; city: string; region: string; postcode: string; country: string; notes: string; source?: string
  /** Set only after the user reviewed a possible duplicate. Same email or same provider record is never imported. */
  allowDuplicate?: boolean
  providerRef?: string; sourceUrl?: string; sourceUpdatedAt?: string | null; discoveredAt?: string
}
export type DuplicateReason = 'same_record' | 'same_email' | 'same_website' | 'same_phone' | 'same_name_and_location'
export interface ImportResult { revision: number; imported: { key: string; leadId: string }[]; skipped: { key: string; reason: DuplicateReason; leadId: string | null; blocking: boolean }[] }
export const reasonLabels: Record<DuplicateReason, string> = {
  same_record: 'Already imported from this source', same_email: 'Same email as an existing lead', same_website: 'Same website as an existing lead',
  same_phone: 'Same phone number as an existing lead', same_name_and_location: 'Same name and location as an existing lead',
}
export const filterLabels: Record<ContactFilter, string> = { website: 'Has a website', phone: 'Has a phone number', email: 'Has a public email' }
export const failureLabels: Record<string, string> = {
  rate_limited: 'Rate limited', unavailable: 'Source unavailable', timeout: 'Took too long', location_not_found: 'Location not found', bad_response: 'Unexpected answer', internal: 'Could not complete',
}

/** A failed discovery request, with the HTTP status and any wait the server asked for. */
export class DiscoveryError extends Error {
  status: number; code: string; retryAfter: number | null
  constructor(message: string, status: number, code = '', retryAfter: number | null = null) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter }
}
const endpoint = () => { const url = import.meta.env.VITE_SUPABASE_URL; return url ? `${new URL(url).origin}/functions/v1/discover-leads` : '' }
// The browser sends its own session token; the function passes it to the database, which checks membership.
async function invoke<T>(body: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const { data } = await supabase!.auth.getSession()
  const token = data.session?.access_token, url = endpoint()
  if (!token || !url) throw new DiscoveryError('Your session has expired. Sign in again to search.', 401)
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) {
    throw new DiscoveryError((cause as Error).name === 'TimeoutError' ? 'The search is taking too long. Try a smaller area or fewer locations.' : 'We couldn’t reach LeadFlow. Check your connection and try again.', 0)
  }
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new DiscoveryError(typeof result.error === 'string' ? result.error : 'Lead discovery is not available right now.', response.status, typeof result.code === 'string' ? result.code : '', typeof result.retryAfter === 'number' ? result.retryAfter : null)
  return result as T
}
export async function discoveryStatus(): Promise<ProviderStatus[]> { return (await invoke<{ providers: ProviderStatus[] }>({ action: 'status' }, 20000)).providers }
export function runSearch(workspaceId: string, provider: string, criteria: SearchCriteria, searchId = crypto.randomUUID()) {
  return invoke<SearchResult>({ action: 'search', workspaceId, searchId, provider, criteria }, 150000)
}
async function call<T>(name: string, args: Record<string, unknown>, check: (value: unknown) => boolean): Promise<T> {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) throw failure(error)
  if (!check(data)) throw new RequestError('Unexpected response. Please contact your administrator.')
  return data as T
}
export const discoveryHistory = (workspaceId: string) => call<HistoryItem[]>('discovery_history_for', { target_workspace: workspaceId }, Array.isArray)
export const leadOrigins = (workspaceId: string) => call<LeadOrigin[]>('lead_origins_for', { target_workspace: workspaceId }, Array.isArray)
/** Retrying with the same request ID returns the first result and imports nothing twice. */
export const importLeads = (workspaceId: string, requestId: string, payload: { method: 'discovery' | 'csv'; provider?: string; searchId?: string; rows: ImportRow[] }) =>
  call<ImportResult>('import_leads', { target_workspace: workspaceId, request_id: requestId, payload }, value => !!value && typeof value === 'object' && Array.isArray((value as ImportResult).imported))

export interface Candidate { provider?: string; providerRef?: string; businessName: string; contactName: string; email: string; phone: string; website: string; city: string; postcode: string }
export interface DuplicateMatch { reason: DuplicateReason; lead: Lead | null; blocking: boolean; inBatch: boolean }
type Index = Map<string, Lead | null>
/** Keys of the workspace's leads, plus anything added later with `remember` (rows earlier in the same import). */
export function duplicateIndex(leads: Lead[], origins: LeadOrigin[]) {
  const index: Index = new Map(), byId = new Map(leads.map(lead => [lead.id, lead]))
  const add = (key: string, lead: Lead | null) => { if (key && !index.has(key)) index.set(key, lead) }
  for (const origin of origins) if (origin.provider && origin.providerRef && byId.has(origin.leadId)) add(`ref:${origin.provider}:${origin.providerRef}`, byId.get(origin.leadId)!)
  for (const lead of leads) {
    if (lead.email) add(`email:${lead.email.toLowerCase()}`, lead)
    add(domainOf(lead.website ?? '') && `web:${domainOf(lead.website ?? '')}`, lead)
    add(phoneKey(lead.phone) && `phone:${phoneKey(lead.phone)}`, lead)
    for (const key of placeKeys(lead.company || lead.name, lead.city ?? '', lead.postcode ?? '')) add(`place:${key}`, lead)
  }
  const batch = new Set<string>()
  const keysOf = (candidate: Candidate): [DuplicateReason, string][] => [
    ['same_record', candidate.provider && candidate.providerRef ? `ref:${candidate.provider}:${candidate.providerRef}` : ''],
    ['same_email', candidate.email ? `email:${candidate.email.trim().toLowerCase()}` : ''],
    ['same_website', domainOf(candidate.website) && `web:${domainOf(candidate.website)}`],
    ['same_phone', phoneKey(candidate.phone) && `phone:${phoneKey(candidate.phone)}`],
    ...placeKeys(candidate.businessName || candidate.contactName, candidate.city, candidate.postcode).map(key => ['same_name_and_location', `place:${key}`] as [DuplicateReason, string]),
  ]
  return {
    /** The first match in the database's order: same record, email, website, phone, then name and location. */
    find(candidate: Candidate): DuplicateMatch | null {
      for (const [reason, key] of keysOf(candidate)) if (key && index.has(key)) return { reason, lead: index.get(key)!, blocking: reason === 'same_record' || reason === 'same_email', inBatch: batch.has(key) }
      return null
    },
    remember(candidate: Candidate) { for (const [, key] of keysOf(candidate)) if (key && !index.has(key)) { index.set(key, null); batch.add(key) } },
  }
}
export function businessToRow(business: DiscoveredBusiness, fetchedAt: string, allowDuplicate = false): ImportRow {
  return { key: business.id, businessName: business.name, contactName: '', email: business.email, phone: business.phone, website: business.website, industry: business.category,
    address: business.address, city: business.city, region: business.region, postcode: business.postcode, country: business.country, notes: '',
    providerRef: business.providerRef, sourceUrl: business.sourceUrl, sourceUpdatedAt: business.sourceUpdatedAt, discoveredAt: fetchedAt, allowDuplicate }
}
export const asCandidate = (business: DiscoveredBusiness): Candidate => ({ provider: business.provider, providerRef: business.providerRef, businessName: business.name, contactName: '', email: business.email, phone: business.phone, website: business.website, city: business.city, postcode: business.postcode })
// Lead details read provenance once per workspace; an import calls forgetOrigins so the next read is fresh.
const originCache = new Map<string, Promise<LeadOrigin[]>>()
export function cachedOrigins(workspaceId: string) {
  let origins = originCache.get(workspaceId)
  if (!origins) { origins = leadOrigins(workspaceId).catch(() => { originCache.delete(workspaceId); return [] }); originCache.set(workspaceId, origins) }
  return origins
}
export const forgetOrigins = (workspaceId: string) => { originCache.delete(workspaceId) }

export const emptyLocation: SearchLocation = { country: 'US', region: '', city: '', postcode: '' }
export const defaultCriteria = (capabilities: Capabilities): SearchCriteria =>
  ({ category: capabilities.categories[0]?.id ?? 'custom', keyword: '', locations: [{ ...emptyLocation, country: capabilities.countries[0] ?? 'US' }], radiusKm: 5, require: [], limit: 50 })
export const countryName = (code: string) => countries.find(([value]) => value === code)?.[1] ?? code
export const locationText = (location: SearchLocation) => [location.city, location.region, location.postcode, countryName(location.country)].filter(Boolean).join(', ')
/** e.g. "Dental clinics in Austin, TX, United States". */
export function criteriaSummary(criteria: SearchCriteria, provider?: ProviderStatus) {
  const kind = criteria.category === 'custom' ? `“${criteria.keyword}”` : provider?.capabilities.categories.find(item => item.id === criteria.category)?.label ?? criteria.category
  return `${kind} in ${criteria.locations.map(locationText).join('; ')}`
}
