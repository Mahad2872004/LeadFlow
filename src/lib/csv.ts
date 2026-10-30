import { normalizeWebsite, sources } from './model'
import type { ImportRow } from './discovery'

export const maxCsvBytes = 2 * 1024 * 1024
export const maxCsvRows = 2000

/** RFC 4180 records. Detects comma, semicolon or tab from the header line; strips a byte-order mark; quoted fields may contain newlines. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, '')
  const header = source.slice(0, source.search(/\r?\n|$/))
  const delimiter = [',', ';', '\t'].map(candidate => [candidate, header.split(candidate).length] as const).sort((a, b) => b[1] - a[1])[0][0]
  const records: string[][] = []
  let record: string[] = [], field = '', quoted = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"' && field === '') quoted = true
    else if (char === delimiter) { record.push(field); field = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++
      record.push(field); records.push(record); record = []; field = ''
    } else field += char
  }
  if (quoted) throw new Error('The file has a quoted value that never closes. Check it in a spreadsheet and export it again.')
  if (field !== '' || record.length) { record.push(field); records.push(record) }
  return records.filter(row => row.some(value => value.trim() !== ''))
}
// Spreadsheet programs run cells that start with these characters as formulas; prefix them when exporting.
const formula = /^[=+\-@\t\r]/
export function toCsv(rows: string[][]): string {
  return rows.map(row => row.map(value => {
    const safe = formula.test(value) ? `'${value}` : value
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }).join(',')).join('\r\n') + '\r\n'
}

export type ImportField = 'businessName' | 'contactName' | 'email' | 'phone' | 'website' | 'industry' | 'address' | 'city' | 'region' | 'postcode' | 'country' | 'notes' | 'source'
export const importFields: { key: ImportField; label: string; aliases: string[] }[] = [
  { key: 'businessName', label: 'Business name', aliases: ['business', 'business name', 'company', 'company name', 'organisation', 'organization', 'account', 'account name'] },
  { key: 'contactName', label: 'Contact name', aliases: ['contact', 'contact name', 'name', 'full name', 'person', 'first and last name'] },
  { key: 'email', label: 'Email', aliases: ['email', 'e-mail', 'email address', 'business email', 'work email'] },
  { key: 'phone', label: 'Phone', aliases: ['phone', 'telephone', 'phone number', 'tel', 'mobile', 'business phone'] },
  { key: 'website', label: 'Website', aliases: ['website', 'web site', 'url', 'site', 'domain', 'homepage', 'web'] },
  { key: 'industry', label: 'Industry', aliases: ['industry', 'niche', 'category', 'sector', 'vertical', 'business type'] },
  { key: 'address', label: 'Address', aliases: ['address', 'street', 'street address', 'address line 1', 'address 1'] },
  { key: 'city', label: 'City', aliases: ['city', 'town', 'suburb', 'locality'] },
  { key: 'region', label: 'State or region', aliases: ['state', 'region', 'county', 'province', 'state/region'] },
  { key: 'postcode', label: 'Postcode', aliases: ['postcode', 'post code', 'zip', 'zip code', 'zipcode', 'postal code'] },
  { key: 'country', label: 'Country', aliases: ['country', 'country code'] },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'message', 'comments', 'description'] },
  { key: 'source', label: 'Source', aliases: ['source', 'lead source'] },
]
export type ColumnMapping = Record<ImportField, number>
const simplify = (value: string) => value.trim().toLowerCase().replace(/[_\s]+/g, ' ')
/** Each LeadFlow field mapped to the first matching column, or -1. A column is used once. */
export function guessMapping(headers: string[]): ColumnMapping {
  const used = new Set<number>(), mapping = {} as ColumnMapping
  for (const field of importFields) {
    const index = headers.findIndex((header, position) => !used.has(position) && field.aliases.includes(simplify(header)))
    mapping[field.key] = index
    if (index >= 0) used.add(index)
  }
  return mapping
}
const countryNames: Record<string, string> = { 'united states': 'US', usa: 'US', 'united states of america': 'US', us: 'US', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB', gb: 'GB', australia: 'AU', au: 'AU' }
export interface PreparedRow { line: number; values: string[]; row: ImportRow | null; errors: string[] }
/** Validates each record as the database will, so problems are shown before importing. Nothing is dropped silently. */
export function prepareRows(records: string[][], mapping: ColumnMapping): PreparedRow[] {
  return records.map((values, index) => {
    const line = index + 2, errors: string[] = []
    const get = (field: ImportField) => mapping[field] >= 0 ? (values[mapping[field]] ?? '').trim() : ''
    const single = (field: ImportField, label: string, max: number) => {
      const value = get(field).replace(/\s+/g, ' ')
      if (value.length > max) errors.push(`${label} is longer than ${max} characters.`)
      return value
    }
    const businessName = single('businessName', 'Business name', 150), contactName = single('contactName', 'Contact name', 150)
    if (!businessName && !contactName) errors.push('Add a business or contact name.')
    const email = get('email').toLowerCase()
    if (email && (email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) errors.push(`“${email}” is not a valid email address.`)
    const phone = single('phone', 'Phone', 25)
    if (phone && (!/^[+\d\s().-]{7,25}$/.test(phone) || phone.replace(/\D/g, '').length < 7)) errors.push(`“${phone}” is not a valid phone number.`)
    const rawWebsite = get('website'), website = normalizeWebsite(rawWebsite)
    if (rawWebsite && !website) errors.push(`“${rawWebsite}” is not a valid website.`)
    const rawCountry = get('country'), country = countryNames[rawCountry.toLowerCase()] ?? (/^[A-Za-z]{2}$/.test(rawCountry) ? rawCountry.toUpperCase() : '')
    if (rawCountry && !country) errors.push(`Use a two-letter code for the country “${rawCountry}”, such as US, GB or AU.`)
    const rawSource = get('source'), source = sources.find(value => value.toLowerCase() === rawSource.toLowerCase())
    if (rawSource && !source) errors.push(`Unknown source “${rawSource}”. Use one of: ${sources.join(', ')}.`)
    const notes = get('notes')
    if (notes.length > 2000) errors.push('Notes are longer than 2,000 characters.')
    if ([businessName, contactName, email, get('industry'), get('address'), get('city'), get('region'), get('postcode')].some(value => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) errors.push('The row contains hidden control characters.')
    const row: ImportRow = { key: `line-${line}`, businessName, contactName, email, phone, website, industry: single('industry', 'Industry', 100), address: single('address', 'Address', 300),
      city: single('city', 'City', 100), region: single('region', 'State or region', 100), postcode: single('postcode', 'Postcode', 20), country, notes, ...(source ? { source } : {}) }
    return { line, values, row: errors.length ? null : row, errors }
  })
}
