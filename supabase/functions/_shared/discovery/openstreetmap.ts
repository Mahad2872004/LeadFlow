import { cleanEmail, cleanPhone, cleanText, cleanWebsite } from './normalize.ts'
import { locationLabel, ProviderError, type DiscoveredBusiness, type DiscoveryCriteria, type DiscoveryLocation, type DiscoveryProvider, type ProviderContext } from './types.ts'
/**
 * OpenStreetMap: Nominatim finds the searched place, Overpass finds tagged businesses inside it.
 * Data is © OpenStreetMap contributors under the ODbL, which permits storing it with attribution.
 * The public servers' policies rule out a commercial backend on the Overpass server and need an identifying
 * User-Agent, caching and a switchable server for Nominatim, so both endpoints are deployment settings with
 * no defaults: discovery stays off until an operator chooses servers whose terms fit their use.
 */
type Tag = readonly [string, string]
const categories: { id: string; label: string; tags: Tag[] }[] = [
  { id: 'dental', label: 'Dental clinics', tags: [['amenity', 'dentist'], ['healthcare', 'dentist']] },
  { id: 'legal', label: 'Law firms', tags: [['office', 'lawyer']] },
  { id: 'real_estate', label: 'Real estate agencies', tags: [['office', 'estate_agent']] },
  { id: 'restaurants', label: 'Restaurants', tags: [['amenity', 'restaurant']] },
  { id: 'marketing', label: 'Marketing and advertising agencies', tags: [['office', 'advertising_agency']] },
  { id: 'construction', label: 'Construction companies', tags: [['craft', 'builder'], ['office', 'construction_company']] },
  { id: 'fitness', label: 'Fitness studios and gyms', tags: [['leisure', 'fitness_centre']] },
  { id: 'healthcare', label: 'Healthcare clinics', tags: [['amenity', 'clinic'], ['amenity', 'doctors'], ['healthcare', 'clinic'], ['healthcare', 'doctor']] },
  { id: 'accounting', label: 'Accountants', tags: [['office', 'accountant']] },
  { id: 'beauty', label: 'Salons and beauty', tags: [['shop', 'hairdresser'], ['shop', 'beauty']] },
]
// Keys that mark a place as a business, for custom niches matched by name.
const businessKeys = 'shop|office|amenity|craft|healthcare|leisure'
const contactKeys = { website: 'website|contact:website', phone: 'phone|contact:phone', email: 'email|contact:email' } as const
/** A boundary to search inside, or a point to search around. A city mapped only as a point gets at least 10 km. */
type Place = { kind: 'area'; areaId: number } | { kind: 'point'; lat: number; lon: number; city: boolean }
interface OsmElement { type: string; id: number; timestamp?: string; tags?: Record<string, string> }

function endpoint(env: ProviderContext['env'], name: string) {
  try {
    const url = new URL(env(name) ?? '')
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) ? url : null
  } catch { return null }
}
const userAgent = (env: ProviderContext['env']) => (env('OSM_USER_AGENT') ?? '').trim()

/** One upstream call. Overloaded-server answers and network errors are retried once; rate limits are not. */
async function call(context: ProviderContext, bucket: string, url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    if (!await context.rateSlot(bucket)) throw new ProviderError('rate_limited', 'LeadFlow is pacing requests to the business directory. Try again in a minute.', 60)
    let response: Response
    try {
      response = await context.fetch(url, { ...init, headers: { 'User-Agent': userAgent(context.env), Accept: 'application/json', ...init.headers }, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      if ((error as Error).name === 'TimeoutError') throw new ProviderError('timeout', 'The business directory took too long to answer. Try a smaller area or fewer locations.')
      if (attempt < 2) { await context.sleep(1000); continue }
      throw new ProviderError('unavailable', 'The business directory could not be reached. Try again in a minute.')
    }
    if (response.status === 429) throw new ProviderError('rate_limited', 'The business directory is limiting requests right now. Try again in a minute.', 30)
    if ([502, 503, 504].includes(response.status)) {
      if (attempt < 2) { await context.sleep(1000); continue }
      throw new ProviderError('unavailable', 'The business directory is busy. Try again in a minute, or search a smaller area.')
    }
    if (!response.ok) throw new ProviderError('bad_response', 'The business directory rejected the search. Please try again later.')
    return response
  }
}

async function findPlace(context: ProviderContext, location: DiscoveryLocation): Promise<Place | null> {
  const key = `osm:${[location.country, location.region, location.city, location.postcode].join('|').toLowerCase()}`
  const cached = await context.cachedPlace(key)
  if (cached) return cached as unknown as Place
  const url = new URL('search', endpoint(context.env, 'OSM_NOMINATIM_URL')!.href.replace(/\/?$/, '/'))
  const params: Record<string, string> = { format: 'jsonv2', limit: '1', countrycodes: location.country.toLowerCase() }
  // Structured search: a postcode is the most specific, otherwise the city within its state or region.
  if (location.postcode) params.postalcode = location.postcode
  else { params.city = location.city; if (location.region) params.state = location.region }
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  const response = await call(context, 'discovery-geocoder', url, { method: 'GET', headers: { 'Accept-Language': 'en' } }, 8000)
  const body = await response.json().catch(() => null)
  if (!Array.isArray(body)) throw new ProviderError('bad_response', 'The location service returned an unexpected answer. Please try again later.')
  const match = body[0] as { osm_type?: string; osm_id?: number; lat?: string; lon?: string } | undefined
  if (!match) return null
  let place: Place
  // Overpass derives area IDs from boundary relations and closed ways.
  if (!location.postcode && match.osm_type === 'relation' && Number.isSafeInteger(match.osm_id)) place = { kind: 'area', areaId: 3600000000 + match.osm_id! }
  else if (!location.postcode && match.osm_type === 'way' && Number.isSafeInteger(match.osm_id)) place = { kind: 'area', areaId: 2400000000 + match.osm_id! }
  else {
    const lat = Number(match.lat), lon = Number(match.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new ProviderError('bad_response', 'The location service returned an unexpected answer. Please try again later.')
    place = { kind: 'point', lat, lon, city: !location.postcode }
  }
  await context.rememberPlace(key, place as unknown as Record<string, unknown>)
  return place
}

export function overpassQuery(criteria: DiscoveryCriteria, place: Place) {
  const scope = place.kind === 'area' ? '(area.searchArea)' : `(around:${(place.city ? Math.max(criteria.radiusKm, 10) : criteria.radiusKm) * 1000},${place.lat},${place.lon})`
  const required = criteria.require.map(filter => `[~"^(${contactKeys[filter]})$"~"."]`).join('')
  const selectors = criteria.category === 'custom'
    // Letters, numbers, spaces, &, ' and - only (checked by parseCriteria), so the keyword is safe in the expression.
    ? [`nwr["name"~"${criteria.keyword}",i][~"^(${businessKeys})$"~"."]${required}${scope};`]
    : categories.find(item => item.id === criteria.category)!.tags.map(([key, value]) => `nwr["${key}"="${value}"]["name"]${required}${scope};`)
  return `[out:json][timeout:20];${place.kind === 'area' ? `area(id:${place.areaId})->.searchArea;` : ''}(${selectors.join('')});out meta center qt ${criteria.limit + 1};`
}

function categoryOf(tags: Record<string, string>, criteria: DiscoveryCriteria) {
  for (const item of categories) if (item.tags.some(([key, value]) => tags[key] === value)) return item.label
  const value = tags.office ?? tags.shop ?? tags.amenity ?? tags.craft ?? tags.healthcare ?? tags.leisure ?? ''
  return value ? cleanText(value.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase()), 100) : criteria.keyword
}
export function toBusiness(element: OsmElement, location: DiscoveryLocation, criteria: DiscoveryCriteria): DiscoveredBusiness | null {
  const tags = element.tags ?? {}
  const name = cleanText(tags.name, 150)
  if (!name || !['node', 'way', 'relation'].includes(element.type) || !Number.isSafeInteger(element.id)) return null
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ')
  const country = (tags['addr:country'] ?? '').toUpperCase()
  const ref = `${element.type}/${element.id}`
  const updated = element.timestamp && Number.isFinite(Date.parse(element.timestamp)) ? new Date(element.timestamp).toISOString() : null
  return {
    id: `openstreetmap:${ref}`, provider: 'openstreetmap', providerRef: ref, name, category: categoryOf(tags, criteria),
    website: cleanWebsite(tags.website ?? tags['contact:website']), phone: cleanPhone(tags.phone ?? tags['contact:phone']), email: cleanEmail(tags.email ?? tags['contact:email']),
    address: cleanText(street || tags['addr:full'], 300), city: cleanText(tags['addr:city'], 100), region: cleanText(tags['addr:state'], 100),
    postcode: cleanText(tags['addr:postcode'], 20), country: /^[A-Z]{2}$/.test(country) ? country : location.country,
    sourceUrl: `https://www.openstreetmap.org/${ref}`, sourceUpdatedAt: updated, matchedLocation: locationLabel(location),
  }
}

export const openStreetMap: DiscoveryProvider = {
  id: 'openstreetmap',
  label: 'OpenStreetMap',
  capabilities: {
    countries: ['US', 'GB', 'AU'],
    categories: categories.map(({ id, label }) => ({ id, label })),
    customKeyword: true,
    filters: ['website', 'phone', 'email'],
    maxLocations: 3,
    maxResultsPerLocation: 100,
    pagination: 'none',
    fields: ['name', 'category', 'website', 'phone', 'email', 'address', 'city', 'region', 'postcode', 'country', 'sourceUrl', 'sourceUpdatedAt'],
    attribution: { text: '© OpenStreetMap contributors, available under the Open Database License', url: 'https://www.openstreetmap.org/copyright' },
    notes: [
      'Community-maintained map data: coverage varies by area, and some businesses are missing or out of date.',
      'Ratings, review counts and company size are not available from this source.',
      'Online-only businesses, such as most e-commerce stores, are not on the map. Use a custom niche or a CSV import.',
    ],
  },
  missingConfiguration(env) {
    const missing: string[] = []
    if (!endpoint(env, 'OSM_NOMINATIM_URL')) missing.push('OSM_NOMINATIM_URL')
    if (!endpoint(env, 'OSM_OVERPASS_URL')) missing.push('OSM_OVERPASS_URL')
    // The servers' policies require an application-specific User-Agent; stock library ones are refused.
    if (userAgent(env).length < 10 || /[\r\n]/.test(userAgent(env))) missing.push('OSM_USER_AGENT')
    return missing
  },
  async search(context, criteria) {
    const found = new Map<string, DiscoveredBusiness>(), warnings: string[] = []
    let truncated = false, located = 0
    // One location at a time, as the Nominatim and Overpass policies ask.
    for (const location of criteria.locations) {
      const place = await findPlace(context, location)
      if (!place) { warnings.push(`We couldn’t find ${locationLabel(location)}. Check the spelling, or try a postcode.`); continue }
      located++
      const response = await call(context, 'discovery-directory', endpoint(context.env, 'OSM_OVERPASS_URL')!, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: overpassQuery(criteria, place) }).toString(),
      }, 23000)
      const body = await response.json().catch(() => null) as { elements?: unknown; remark?: unknown } | null
      if (!body || !Array.isArray(body.elements)) throw new ProviderError('bad_response', 'The business directory returned an unexpected answer. Please try again later.')
      // Overpass reports a query stopped by its time or memory limit in "remark", with partial results.
      if (typeof body.remark === 'string' && /runtime error|timed out|out of memory/i.test(body.remark)) throw new ProviderError('timeout', 'This search covered too much data. Try a smaller area, a postcode, or fewer filters.')
      const elements = body.elements as OsmElement[]
      if (elements.length > criteria.limit) { truncated = true; warnings.push(`${locationLabel(location)} has more than ${criteria.limit} matches. Showing the first ${criteria.limit}; narrow the area or add filters to see others.`) }
      for (const element of elements.slice(0, criteria.limit)) {
        const business = toBusiness(element, location, criteria)
        if (business && !found.has(business.id)) found.set(business.id, business)
      }
    }
    if (!located) throw new ProviderError('location_not_found', warnings.join(' '))
    return { results: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), truncated, nextCursor: null, warnings }
  },
}
