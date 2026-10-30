import { normalizeWebsite } from './model'
// Duplicate keys, computed exactly as leadflow_private.lead_* in 202610310001 so warnings here match what the database enforces.
export const domainOf = (website: string) => normalizeWebsite(website) ? new URL(normalizeWebsite(website)).hostname.toLowerCase().replace(/^www\./, '') : ''
export const nameKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')
export const phoneKey = (phone: string) => { const digits = phone.replace(/\D/g, ''); return digits.length < 7 ? '' : digits.slice(-9) }
export function placeKeys(business: string, city: string, postcode: string) {
  const name = nameKey(business)
  if (!name) return []
  return [nameKey(city) && `${name}|c|${nameKey(city)}`, nameKey(postcode) && `${name}|p|${nameKey(postcode)}`].filter(Boolean) as string[]
}
