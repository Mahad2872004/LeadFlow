import { supabase } from './supabase'
import { failure, RequestError } from './backend'
import type { FilterValues, SearchKind } from '../../supabase/functions/_shared/apollo/filters.ts'
import type { ImportRow, ImportResult } from './discovery'
export { filtersFor, filterGroups, unsupportedFilters } from '../../supabase/functions/_shared/apollo/filters.ts'
export type { FilterDefinition, FilterValue, FilterValues, SearchKind } from '../../supabase/functions/_shared/apollo/filters.ts'
export type { OrganizationResult, PersonResult, Phone, RevealedContact } from '../../supabase/functions/_shared/apollo/client.ts'
import type { OrganizationResult, PersonResult, Phone } from '../../supabase/functions/_shared/apollo/client.ts'

export interface CreditStat { limit: number | null; consumed: number | null; leftOver: number | null }
export interface ApolloAccount {
  id: string; nickname: string; active: boolean; configured: boolean; monthlyAllowance: number; resetDay: number; notes: string; createdAt: string
  lastConnectedAt: string | null; lastConnectionError: string | null; lastSyncedAt: string | null; synced: Record<string, CreditStat> | null
  cycleStart: string; cycleEnd: string; cycleSource: 'apollo' | 'reset_day'; used: number; usedEmail: number; usedPhone: number; usedSearch: number; pending: number
}
export interface ApolloStatus { enabled: boolean; reason: 'no_accounts' | 'workspace_not_enabled' | null; role: string; phoneReveal: boolean; accounts: ApolloAccount[] }
export interface ResultPage<T> { kind: SearchKind; accountId: string; searchId: string | null; fetchedAt: string; filters: FilterValues; items: T[]; page: number; perPage: number; total: number; totalPages: number }
export interface Contact {
  id: string; name: string; title: string; email: string; emailStatus: string; phones: Phone[]; linkedinUrl: string; organizationName: string; organizationDomain: string
  city: string; state: string; country: string; accountId?: string | null; emailRevealedAt?: string | null; phoneRequestedAt?: string | null; phoneRevealedAt?: string | null
}
export interface RevealOutcome { contacts: Contact[]; unmatched?: string[]; credits?: number; creditBasis?: 'reported' | 'documented'; phonePending?: boolean; replayed?: boolean; status?: string }
export interface LedgerEntry {
  id: string; accountId: string; operation: 'email_reveal' | 'phone_reveal' | 'organization_search'; status: 'pending' | 'succeeded' | 'no_match' | 'failed' | 'unknown'
  estimatedCredits: number; credits: number | null; creditBasis: 'reported' | 'documented' | 'estimated'; reference: string | null; error: string | null
  createdAt: string; completedAt: string | null; thisWorkspace: boolean; subjects: { id?: string; name: string }[]
}
export interface SavedSearch { id: string; name: string; provider: string; criteria: { kind: SearchKind; filters: FilterValues; accountId?: string }; mine: boolean; createdAt: string; updatedAt: string }
export interface LeadList { id: string; name: string; createdAt: string; leadIds: string[] }
export type { PersonResult as Person, OrganizationResult as Organization }

/** A failed request, with the HTTP status and the server's code (e.g. confirm_credits, credits, apollo_plan). */
export class ApolloRequestError extends Error {
  status: number; code: string; retryAfter: number | null
  constructor(message: string, status: number, code = '', retryAfter: number | null = null) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter }
}
const endpoint = () => { const url = import.meta.env.VITE_SUPABASE_URL; return url ? `${new URL(url).origin}/functions/v1/apollo` : '' }
// The browser sends its session token; the apollo function checks membership with it. Apollo keys never reach the browser.
async function invoke<T>(workspaceId: string, body: Record<string, unknown>, timeoutMs = 60000): Promise<T> {
  const { data } = await supabase!.auth.getSession()
  const token = data.session?.access_token, url = endpoint()
  if (!token || !url) throw new ApolloRequestError('Your session has expired. Sign in again.', 401)
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '' },
      body: JSON.stringify({ workspaceId, ...body }), signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) {
    throw new ApolloRequestError((cause as Error).name === 'TimeoutError' ? 'Apollo is taking too long to answer. If this was a reveal, retrying is safe: you won’t be charged twice.' : 'We couldn’t reach LeadFlow. Check your connection and try again.', 0)
  }
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok && !(response.status === 409 && result.replayed)) throw new ApolloRequestError(typeof result.error === 'string' ? result.error : 'Apollo isn’t available right now.', response.status,
    typeof result.code === 'string' ? result.code : '', typeof result.retryAfter === 'number' ? result.retryAfter : null)
  return result as T
}
export const apolloStatus = (workspaceId: string) => invoke<ApolloStatus>(workspaceId, { action: 'status' }, 20000)
export function apolloSearch<K extends SearchKind>(workspaceId: string, request: { kind: K; accountId: string; filters: FilterValues; page: number; perPage: number; searchId?: string; operationId?: string; confirmCredits?: boolean }) {
  return invoke<ResultPage<K extends 'people' ? PersonResult : OrganizationResult>>(workspaceId, { action: 'search', ...request }, 60000)
}
/** Up to 10 people. Reusing the operation ID after a failure returns the stored outcome without charging again. */
export const apolloReveal = (workspaceId: string, request: { accountId: string; operationId: string; people: { id: string; name: string }[]; phone: boolean }) =>
  invoke<RevealOutcome>(workspaceId, { action: 'reveal', ...request }, 90000)
export const apolloSave = (workspaceId: string, request: { accountId: string; kind: SearchKind; requestId: string; searchId?: string | null; listId?: string | null; rows: ImportRow[] }) =>
  invoke<ImportResult & { listed: number }>(workspaceId, { action: 'save', ...request }, 60000)
export const apolloLedger = (workspaceId: string, filters: Record<string, string>) => invoke<{ entries: LedgerEntry[] }>(workspaceId, { action: 'ledger', filters }).then(result => result.entries)
export const apolloUpdateAccount = (workspaceId: string, accountId: string, changes: Partial<Pick<ApolloAccount, 'nickname' | 'active' | 'monthlyAllowance' | 'resetDay' | 'notes'>>) =>
  invoke<{ account: ApolloAccount }>(workspaceId, { action: 'update_account', accountId, changes }).then(result => result.account)
export const apolloTest = (workspaceId: string, accountId: string) => invoke<{ ok: true }>(workspaceId, { action: 'test_connection', accountId }, 30000)
export const apolloSync = (workspaceId: string, accountId: string) => invoke<{ account: ApolloAccount }>(workspaceId, { action: 'sync_credits', accountId }, 30000).then(result => result.account)

async function call<T>(name: string, args: Record<string, unknown>, check: (value: unknown) => boolean = () => true): Promise<T> {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) throw failure(error)
  if (!check(data)) throw new RequestError('Unexpected response. Please contact your administrator.')
  return data as T
}
export const contactsFor = (workspaceId: string, personIds: string[]) => personIds.length ? call<Contact[]>('apollo_contacts_for', { target_workspace: workspaceId, person_ids: personIds }, Array.isArray) : Promise.resolve([])
export const savedSearches = (workspaceId: string) => call<SavedSearch[]>('discovery_saved_searches_for', { target_workspace: workspaceId }, Array.isArray)
export const saveSearch = (workspaceId: string, id: string, name: string, kind: SearchKind, criteria: SavedSearch['criteria']) =>
  call<string>('save_discovery_search', { target_workspace: workspaceId, search_id: id, search_name: name, provider: kind === 'people' ? 'apollo_people' : 'apollo_organizations', criteria })
export const deleteSearch = (workspaceId: string, id: string) => call<void>('delete_discovery_search', { target_workspace: workspaceId, search_id: id })
export const leadLists = (workspaceId: string) => call<LeadList[]>('lead_lists_for', { target_workspace: workspaceId }, Array.isArray)
export const createLeadList = (workspaceId: string, name: string) => call<string>('create_lead_list', { target_workspace: workspaceId, list_name: name })
export const addToLeadList = (workspaceId: string, listId: string, leadIds: string[]) => call<number>('add_leads_to_list', { target_workspace: workspaceId, list_id: listId, lead_ids: leadIds })

export const operationLabels: Record<LedgerEntry['operation'], string> = { email_reveal: 'Email reveal', phone_reveal: 'Phone reveal', organization_search: 'Company search page' }
export const statusLabels: Record<LedgerEntry['status'], string> = { pending: 'Waiting for Apollo', succeeded: 'Done', no_match: 'No match', failed: 'Failed', unknown: 'Outcome unknown' }
export const accountLabel = (account: Pick<ApolloAccount, 'id' | 'nickname'>) => account.nickname && account.nickname !== account.id ? `${account.nickname} (${account.id})` : account.id
export const remainingOf = (account: ApolloAccount) => Math.max(0, account.monthlyAllowance - account.used)
/** Apollo's own balance for a credit type, when synced. */
export const apolloLeft = (account: ApolloAccount, type: 'lead_credit' | 'direct_dial_credit') => account.synced?.[type]?.leftOver ?? null
const countryCodes: Record<string, string> = { 'united states': 'US', usa: 'US', 'united kingdom': 'GB', uk: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', australia: 'AU', canada: 'CA', ireland: 'IE', 'new zealand': 'NZ', germany: 'DE', france: 'FR', india: 'IN' }
const clip = (value: string, max: number) => value.trim().slice(0, max)
/** A lead row for import_leads. Only details Apollo returned or the user revealed are included. */
export function personRow(person: PersonResult, contact: Contact | undefined, discoveredAt: string): ImportRow & { providerRef: string } {
  const domain = contact?.organizationDomain || ''
  const notes = [person.title && `Title: ${person.title}`, contact?.linkedinUrl && `LinkedIn: ${contact.linkedinUrl}`, `Apollo person ID: ${person.id}`].filter(Boolean).join('\n')
  return { key: `person:${person.id}`, providerRef: `person:${person.id}`, businessName: clip(contact?.organizationName || person.organizationName, 150), contactName: clip(contact?.name || person.name, 150),
    email: contact?.email ?? '', phone: contact?.phones.find(phone => /^[+\d\s().-]{7,25}$/.test(phone.number))?.number ?? '', website: domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? `https://${domain}` : '',
    industry: '', address: '', city: clip(contact?.city ?? '', 100), region: clip(contact?.state ?? '', 100), postcode: '', country: countryCodes[(contact?.country ?? '').toLowerCase()] ?? '', notes, discoveredAt }
}
export function organizationRow(org: OrganizationResult, discoveredAt: string): ImportRow & { providerRef: string } {
  const website = /^https?:\/\//.test(org.websiteUrl) ? org.websiteUrl : org.primaryDomain ? `https://${org.primaryDomain}` : ''
  const notes = [org.linkedinUrl && `LinkedIn: ${org.linkedinUrl}`, org.foundedYear && `Founded: ${org.foundedYear}`, `Apollo organization ID: ${org.id}`].filter(Boolean).join('\n')
  return { key: `org:${org.id}`, providerRef: `org:${org.id}`, businessName: clip(org.name, 150), contactName: '', email: '', phone: /^[+\d\s().-]{7,25}$/.test(org.phone) ? org.phone : '',
    website: website.length <= 300 ? website : '', industry: '', address: '', city: '', region: '', postcode: '', country: '', notes, discoveredAt }
}
