// CSV export of everything Apollo found, and reading such a file back. No network or browser APIs, so it is shared with tests.
import type { OrganizationResult, PersonResult } from '../../supabase/functions/_shared/apollo/client.ts'
import type { SearchKind } from '../../supabase/functions/_shared/apollo/filters.ts'
import type { Contact } from './apollo'
export const exportIdColumn: Record<SearchKind, string> = { people: 'Apollo person ID', organizations: 'Apollo organization ID' }
const yes = (value: boolean) => value ? 'Yes' : 'No'
/**
 * Rows for a people export: everyone found, with revealed details where known. People revealed but no longer in saved
 * results are included from their contact record. The Apollo person ID column lets the file be opened again to reveal the rest.
 */
export function peopleExport(items: PersonResult[], contacts: Contact[], inLeadFlow: (id: string) => boolean): string[][] {
  const byId = new Map(contacts.map(contact => [contact.id, contact]))
  const seen = new Set<string>()
  const rows = items.map(person => { seen.add(person.id); return personExportRow(person.id, person, byId.get(person.id), inLeadFlow(person.id)) })
  for (const contact of contacts) if (!seen.has(contact.id)) rows.push(personExportRow(contact.id, null, contact, inLeadFlow(contact.id)))
  return [[exportIdColumn.people, 'Name', 'Title', 'Company', 'Company domain', 'Email', 'Email status', 'Phone', 'Phone type', 'LinkedIn', 'City', 'State', 'Country',
    'Email revealed', 'Phone revealed', 'Has email in Apollo', 'Direct phone in Apollo', 'In LeadFlow', 'Apollo updated'], ...rows]
}
function personExportRow(id: string, person: PersonResult | null, contact: Contact | undefined, saved: boolean) {
  const phone = contact?.phones[0]
  return [id, contact?.name || person?.name || '', person?.title || contact?.title || '', contact?.organizationName || person?.organizationName || '', contact?.organizationDomain ?? '',
    contact?.email ?? '', contact?.emailStatus ?? '', phone?.number ?? '', phone?.type ?? '', contact?.linkedinUrl ?? '', contact?.city ?? '', contact?.state ?? '', contact?.country ?? '',
    contact?.emailRevealedAt ? contact.emailRevealedAt.slice(0, 10) : '', contact?.phoneRevealedAt ? contact.phoneRevealedAt.slice(0, 10) : contact?.phoneRequestedAt ? 'Requested' : '',
    person ? yes(person.hasEmail) : '', person ? (person.directPhone === 'yes' ? 'Yes' : person.directPhone === 'maybe' ? 'Maybe' : 'No') : '', yes(saved), person?.lastRefreshedAt?.slice(0, 10) ?? '']
}
export function organizationsExport(items: OrganizationResult[], inLeadFlow: (org: OrganizationResult) => boolean): string[][] {
  return [[exportIdColumn.organizations, 'Company', 'Domain', 'Website', 'Phone', 'LinkedIn', 'Founded', 'NAICS codes', 'SIC codes', 'Languages', 'In LeadFlow'],
    ...items.map(org => [org.id, org.name, org.primaryDomain, org.websiteUrl, org.phone, org.linkedinUrl, org.foundedYear ? String(org.foundedYear) : '', org.naicsCodes.join(' '),
      org.sicCodes.join(' '), org.languages.join(' '), yes(inLeadFlow(org))])]
}
/**
 * People from a LeadFlow export (or any CSV with an "Apollo person ID" column), ready to show and reveal without searching.
 * Only the ID matters to Apollo; names, titles and companies are shown until revealed details load.
 */
export function peopleFromExport(records: string[][]): PersonResult[] {
  const [header = [], ...rows] = records
  const column = (name: string) => header.findIndex(cell => cell.trim().toLowerCase() === name.toLowerCase())
  const id = column(exportIdColumn.people), name = column('Name'), title = column('Title'), company = column('Company'), email = column('Has email in Apollo'), phone = column('Direct phone in Apollo')
  if (id < 0) throw new Error('This file has no “Apollo person ID” column. Use a file exported from LeadFlow’s Apollo search.')
  const seen = new Set<string>(), people: PersonResult[] = []
  for (const row of rows) {
    const personId = (row[id] ?? '').trim()
    if (!/^[A-Za-z0-9]{1,40}$/.test(personId) || seen.has(personId)) continue
    seen.add(personId)
    const cell = (index: number) => index >= 0 ? (row[index] ?? '').trim().slice(0, 200) : ''
    people.push({ id: personId, firstName: '', lastNameObfuscated: '', name: cell(name) || 'Unnamed person', title: cell(title), organizationName: cell(company),
      hasEmail: cell(email) !== 'No', directPhone: cell(phone) === 'Yes' ? 'yes' : cell(phone) === 'No' ? 'no' : 'maybe', hasCity: false, hasState: false, hasCountry: false, lastRefreshedAt: null,
      organization: { hasIndustry: false, hasPhone: false, hasEmployeeCount: false, hasRevenue: false } })
  }
  return people
}
