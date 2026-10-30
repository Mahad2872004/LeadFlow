import { cleanEmail, cleanPhone, cleanText, cleanWebsite } from './normalize.ts'
import { locationLabel, ProviderError, type DiscoveredBusiness, type DiscoveryProvider, type DiscoveryLocation } from './types.ts'
/**
 * Overture Maps places, loaded into leadflow_private.directory_places by scripts/load-overture.mjs. Searches run in
 * Postgres, so no outside service is called and no request limit applies. The data is open (CDLA Permissive 2.0, and
 * Apache 2.0 for Foursquare-sourced records) and may be stored. It is as fresh as the last load.
 */
// LeadFlow category → the Overture taxonomy IDs the loader maps to it (any level of a place's taxonomy.hierarchy).
// Shared with scripts/load-overture.mjs, which imports this list.
export const overtureCategories: { id: string; label: string; taxonomy: string[] }[] = [
  { id: 'dental', label: 'Dental clinics', taxonomy: ['dental_clinic', 'general_dentistry', 'cosmetic_dentistry', 'pediatric_dentistry', 'orthodontist', 'oral_surgeon', 'endodontist', 'periodontist'] },
  { id: 'legal', label: 'Law firms', taxonomy: ['attorney_or_law_firm'] },
  { id: 'real_estate', label: 'Real estate agencies', taxonomy: ['real_estate_agent', 'real_estate_service', 'commercial_real_estate'] },
  { id: 'restaurants', label: 'Restaurants', taxonomy: ['restaurant'] },
  { id: 'marketing', label: 'Marketing and advertising agencies', taxonomy: ['marketing_agency', 'advertising_agency', 'internet_marketing_service', 'b2b_advertising_and_marketing_service'] },
  { id: 'construction', label: 'Construction companies', taxonomy: ['contractor', 'building_contractor', 'building_or_construction_service', 'builder'] },
  { id: 'fitness', label: 'Fitness studios and gyms', taxonomy: ['gym', 'sport_or_fitness_facility', 'fitness_trainer'] },
  { id: 'healthcare', label: 'Healthcare clinics', taxonomy: ['doctors_office', 'pediatric_clinic', 'public_health_clinic', 'behavioral_or_mental_health_clinic'] },
  { id: 'accounting', label: 'Accountants', taxonomy: ['accountant'] },
  { id: 'beauty', label: 'Salons and beauty', taxonomy: ['beauty_salon', 'hair_salon', 'nail_salon'] },
]
// Overture stores US and Australian regions as postal codes ("TX", "NSW"); people often type the full name.
const regionCodes: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'new south wales': 'NSW', victoria: 'VIC', queensland: 'QLD', 'western australia': 'WA', 'south australia': 'SA', tasmania: 'TAS', 'australian capital territory': 'ACT', 'northern territory': 'NT',
}
export const regionFilter = (location: DiscoveryLocation) => {
  const region = location.region.trim()
  // UK addresses rarely carry a region in this data, so a UK search matches by city or postcode alone.
  if (!region || location.country === 'GB') return ''
  return regionCodes[region.toLowerCase()] ?? region.toUpperCase().replace(/^(US|AU)-/, '')
}
interface Row { id: string; category: string; name: string; website: string; phone: string; email: string; address: string; city: string; region: string; postcode: string; country: string; source_updated_at: string | null }
interface Answer { located: boolean; total: number; results: Row[] }
const labels = new Map(overtureCategories.map(item => [item.id, item.label]))
function toBusiness(row: Row, location: DiscoveryLocation): DiscoveredBusiness | null {
  const name = cleanText(row.name, 150)
  if (!name) return null
  const updated = row.source_updated_at && Number.isFinite(Date.parse(row.source_updated_at)) ? new Date(row.source_updated_at).toISOString() : null
  return {
    id: `overture:${row.id}`, provider: 'overture', providerRef: row.id, name, category: labels.get(row.category) ?? row.category,
    website: cleanWebsite(row.website), phone: cleanPhone(row.phone), email: cleanEmail(row.email),
    address: cleanText(row.address, 300), city: cleanText(row.city, 100), region: cleanText(row.region, 100), postcode: cleanText(row.postcode, 20),
    country: /^[A-Z]{2}$/.test(row.country) ? row.country : location.country,
    // Overture has no public page per record; provenance keeps its ID and source date instead.
    sourceUrl: '', sourceUpdatedAt: updated, matchedLocation: locationLabel(location),
  }
}
export const overture: DiscoveryProvider = {
  id: 'overture',
  label: 'Overture Maps',
  capabilities: {
    countries: ['US', 'GB', 'AU'],
    categories: overtureCategories.map(({ id, label }) => ({ id, label })),
    customKeyword: true,
    filters: ['website', 'phone', 'email'],
    maxLocations: 3,
    maxResultsPerLocation: 100,
    pagination: 'none',
    fields: ['name', 'category', 'website', 'phone', 'email', 'address', 'city', 'region', 'postcode', 'country', 'sourceUpdatedAt'],
    attribution: { text: 'Data from Overture Maps Foundation (overturemaps.org), CDLA Permissive 2.0 and Apache 2.0 by source', url: 'https://docs.overturemaps.org/attribution/' },
    notes: [
      'A city search matches the business’s address town; nearby suburbs are separate cities. A postcode searches the chosen radius around it.',
      'Only the countries and business types an administrator has loaded are searchable. A custom niche matches business names among them.',
      'Ratings, review counts and company size are not available from this source.',
    ],
  },
  missingConfiguration: () => [],
  async checkReady(context) {
    const status = await context.rpc<{ rows: number }>('directory_status', {})
    return status && status.rows > 0 ? [] : ['directory data (run npm run directory:load)']
  },
  async search(context, criteria) {
    const found = new Map<string, DiscoveredBusiness>(), warnings: string[] = []
    let truncated = false, located = 0
    const categories = criteria.category === 'custom' ? [] : [criteria.category]
    for (const location of criteria.locations) {
      let answer: Answer
      try {
        answer = await context.rpc<Answer>('directory_search', {
          country_code: location.country, region_name: regionFilter(location), city_name: location.postcode ? '' : location.city, postcode_value: location.postcode,
          radius_km: criteria.radiusKm, categories, keyword: criteria.keyword, require: criteria.require, max_rows: criteria.limit,
        })
      } catch { throw new ProviderError('unavailable', 'The business directory could not be searched. Try again in a minute.') }
      if (!answer?.located) { warnings.push(`We couldn’t find ${locationLabel(location)} in the loaded directory. Check the spelling, try a postcode, or ask your administrator whether that country is loaded.`); continue }
      located++
      if (answer.total > criteria.limit) { truncated = true; warnings.push(`${locationLabel(location)} has ${answer.total} matches. Showing the first ${criteria.limit}; add filters or use a postcode to narrow it.`) }
      for (const row of answer.results) { const business = toBusiness(row, location); if (business && !found.has(business.id)) found.set(business.id, business) }
    }
    if (!located) throw new ProviderError('location_not_found', warnings.join(' '))
    return { results: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), truncated, nextCursor: null, warnings }
  },
}
