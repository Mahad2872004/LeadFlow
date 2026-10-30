// The provider-independent shape of lead discovery. Business logic (authorization, history, imports and
// duplicate checks) depends only on these types; each provider maps its own API onto them.
export const discoveryCountries = ['US', 'GB', 'AU'] as const
export type DiscoveryCountry = typeof discoveryCountries[number]
export const contactFilters = ['website', 'phone', 'email'] as const
export type ContactFilter = typeof contactFilters[number]
export interface DiscoveryLocation { country: DiscoveryCountry; region: string; city: string; postcode: string }
export interface DiscoveryCriteria {
  /** A provider category ID, or "custom" with a keyword. */
  category: string
  keyword: string
  locations: DiscoveryLocation[]
  /** Search radius around a postcode or a city that has no boundary. */
  radiusKm: number
  /** Only businesses that publish each of these. */
  require: ContactFilter[]
  /** Maximum results per location. */
  limit: number
}
/** A business as a provider returned it, normalized. Fields the provider did not supply are empty, never guessed. */
export interface DiscoveredBusiness {
  id: string
  provider: string
  providerRef: string
  name: string
  category: string
  website: string
  phone: string
  email: string
  address: string
  city: string
  region: string
  postcode: string
  country: string
  /** A public page for the provider's record, when the provider has one. */
  sourceUrl: string
  /** When the provider's record last changed, if known. This is the freshness shown to users. */
  sourceUpdatedAt: string | null
  /** The searched location this result came from, e.g. "Austin, TX, US". */
  matchedLocation: string
}
export interface ProviderCapabilities {
  countries: DiscoveryCountry[]
  categories: { id: string; label: string }[]
  customKeyword: boolean
  /** Only filters the provider can actually apply. Ratings, review counts and company size appear here only if supported. */
  filters: ContactFilter[]
  maxLocations: number
  maxResultsPerLocation: number
  pagination: 'none' | 'cursor'
  /** Fields this provider can return, so the interface never shows empty columns it cannot fill. */
  fields: (keyof DiscoveredBusiness)[]
  attribution: { text: string; url: string }
  /** Plain-language limits shown beside the search, e.g. kinds of business the source cannot find. */
  notes: string[]
}
export type ProviderFailure = 'rate_limited' | 'unavailable' | 'timeout' | 'location_not_found' | 'bad_response'
export class ProviderError extends Error {
  kind: ProviderFailure
  retryAfter: number | null
  constructor(kind: ProviderFailure, message: string, retryAfter: number | null = null) { super(message); this.kind = kind; this.retryAfter = retryAfter }
}
export interface ProviderContext {
  env: (name: string) => string | undefined
  fetch: typeof fetch
  /** A shared per-minute budget for an upstream service; false when it is used up. */
  rateSlot: (bucket: string) => Promise<boolean>
  cachedPlace: (key: string) => Promise<Record<string, unknown> | null>
  rememberPlace: (key: string, place: Record<string, unknown>) => Promise<void>
  sleep: (ms: number) => Promise<void>
}
export interface SearchOutcome { results: DiscoveredBusiness[]; truncated: boolean; nextCursor: string | null; warnings: string[] }
export interface DiscoveryProvider {
  id: string
  label: string
  capabilities: ProviderCapabilities
  /** Names of required settings that are missing. Empty when the provider can be used. Never values. */
  missingConfiguration: (env: (name: string) => string | undefined) => string[]
  search: (context: ProviderContext, criteria: DiscoveryCriteria, cursor: string | null) => Promise<SearchOutcome>
}

export class CriteriaError extends Error {}
const hasControl = (value: string) => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
function text(value: unknown, label: string, max: number, pattern?: RegExp): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new CriteriaError(`Enter a valid ${label}.`)
  const result = value.trim().replace(/\s+/g, ' ')
  if (result.length > max || hasControl(result) || (result && pattern && !pattern.test(result))) throw new CriteriaError(`Enter a valid ${label} (up to ${max} characters).`)
  return result
}
const integer = (value: unknown, fallback: number, min: number, max: number) => value === undefined || value === null ? fallback
  : Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : null
/** Validates criteria against what the chosen provider supports. The result is also what history stores. */
export function parseCriteria(value: unknown, capabilities: ProviderCapabilities): DiscoveryCriteria {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CriteriaError('Choose what to search for and where.')
  const input = value as Record<string, unknown>
  const category = text(input.category, 'business type', 40)
  if (!category || (category !== 'custom' && !capabilities.categories.some(item => item.id === category))) throw new CriteriaError('Choose a business type.')
  if (category === 'custom' && !capabilities.customKeyword) throw new CriteriaError('This source does not support custom niches.')
  const keyword = category === 'custom' ? text(input.keyword, 'niche', 60, /^[\p{L}\p{N} &'-]+$/u) : ''
  if (category === 'custom' && keyword.length < 2) throw new CriteriaError('Describe the niche in at least 2 characters, using letters, numbers, spaces, &, \' or -.')
  if (!Array.isArray(input.locations) || input.locations.length < 1 || input.locations.length > capabilities.maxLocations) throw new CriteriaError(`Add between 1 and ${capabilities.maxLocations} locations.`)
  const locations = input.locations.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new CriteriaError(`Location ${index + 1} is incomplete.`)
    const location = raw as Record<string, unknown>
    const country = capabilities.countries.find(code => code === location.country)
    if (!country) throw new CriteriaError(`Choose a supported country for location ${index + 1}.`)
    const result = { country, region: text(location.region, 'state or region', 80, /^[\p{L}\p{N} .,'&()-]+$/u), city: text(location.city, 'city', 80, /^[\p{L}\p{N} .,'&()-]+$/u), postcode: text(location.postcode, 'postcode', 12, /^[A-Za-z0-9 -]+$/).toUpperCase() }
    if (!result.city && !result.postcode) throw new CriteriaError(`Enter a city or postcode for location ${index + 1}.`)
    return result
  })
  const keys = new Set(locations.map(location => JSON.stringify(location).toLowerCase()))
  if (keys.size !== locations.length) throw new CriteriaError('Each location must be different.')
  if (input.require !== undefined && !Array.isArray(input.require)) throw new CriteriaError('Choose valid filters.')
  const require = [...new Set((input.require as unknown[] | undefined) ?? [])]
  if (!require.every(filter => capabilities.filters.some(supported => supported === filter))) throw new CriteriaError('This source does not support one of the chosen filters.')
  const radiusKm = integer(input.radiusKm, 5, 1, 50), limit = integer(input.limit, 50, 10, capabilities.maxResultsPerLocation)
  if (radiusKm === null) throw new CriteriaError('Choose a radius between 1 and 50 km.')
  if (limit === null) throw new CriteriaError(`Choose between 10 and ${capabilities.maxResultsPerLocation} results per location.`)
  return { category, keyword, locations, radiusKm, require: require as ContactFilter[], limit }
}
export const locationLabel = (location: DiscoveryLocation) => [location.city, location.region, location.postcode, location.country].filter(Boolean).join(', ')
