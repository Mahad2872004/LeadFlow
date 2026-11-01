// Apollo search filters: every filter LeadFlow offers, the exact Apollo parameter it maps to, and how values are
// validated and sent. Checked against docs.apollo.io (People API Search and Organization Search) on 1 November 2026.
// The browser imports this file for labels and the form; the apollo Edge Function imports it to validate and build
// requests, so the two can never disagree about what a filter means.
export type SearchKind = 'people' | 'organizations'
export type FilterType = 'list' | 'options' | 'text' | 'boolean' | 'range' | 'dateRange' | 'select'
export interface FilterDefinition {
  key: string
  /** The Apollo parameter. Lists are sent as `param[]`, ranges as `param[min]` and `param[max]`. */
  param: string
  label: string
  help: string
  group: string
  type: FilterType
  /** Fixed choices (options and select). Values are what Apollo expects. */
  options?: { value: string; label: string }[]
  /** Suggestions for free-text lists. Users may type other values. */
  suggestions?: string[]
  /** Most values accepted in a list. */
  max?: number
  /** Technology IDs: Apollo replaces spaces and periods with underscores. */
  technology?: boolean
  /** Shown beside the range inputs, e.g. "USD". */
  unit?: string
}
const seniorities = [['owner', 'Owner'], ['founder', 'Founder'], ['c_suite', 'C-suite'], ['partner', 'Partner'], ['vp', 'VP'], ['head', 'Head'], ['director', 'Director'],
  ['manager', 'Manager'], ['senior', 'Senior'], ['entry', 'Entry level'], ['intern', 'Intern']].map(([value, label]) => ({ value, label }))
const emailStatuses = [['verified', 'Verified'], ['unverified', 'Unverified'], ['likely to engage', 'Likely to engage'], ['unavailable', 'Unavailable']].map(([value, label]) => ({ value, label }))
const employeeRanges = ['1,10', '11,20', '21,50', '51,100', '101,200', '201,500', '501,1000', '1001,2000', '2001,5000', '5001,10000', '10001,1000000']
  .map(value => { const [min, max] = value.split(','); return { value, label: max === '1000000' ? `${Number(min).toLocaleString('en')}+` : `${Number(min).toLocaleString('en')}–${Number(max).toLocaleString('en')}` } })
const growthMonths = [['6', '6 months'], ['12', '12 months'], ['24', '24 months']].map(([value, label]) => ({ value, label }))
// Apollo industry names are lowercase and must match exactly. These are common ones; any exact name works.
const industries = ['accounting', 'architecture & planning', 'automotive', 'computer software', 'construction', 'consumer services', 'dental', 'education management',
  'financial services', 'health, wellness & fitness', 'hospital & health care', 'hospitality', 'information technology & services', 'insurance', 'internet', 'law practice',
  'legal services', 'management consulting', 'marketing & advertising', 'medical practice', 'real estate', 'restaurants', 'retail', 'staffing & recruiting', 'e-learning']
const technologies = ['salesforce', 'hubspot', 'wordpress_org', 'shopify', 'google_analytics', 'google_tag_manager', 'mailchimp', 'stripe', 'zendesk', 'intercom', 'wix', 'squarespace']
const locations = ['United States', 'United Kingdom', 'Australia', 'California, US', 'Texas, US', 'New York, US', 'London, United Kingdom', 'Sydney, Australia']

const shared = {
  domains: { key: 'domains', param: 'q_organization_domains_list', label: 'Company domains', help: 'Company website domains without www, such as apollo.io.', group: 'Company', type: 'list', max: 100 },
  industries: { key: 'industries', param: 'organization_industries', label: 'Industries', help: 'Apollo’s lowercase industry name, matched exactly (for example “marketing & advertising”).', group: 'Company', type: 'list', suggestions: industries, max: 25 },
  employees: { key: 'employees', param: 'organization_num_employees_ranges', label: 'Company size', help: 'Number of employees.', group: 'Company', type: 'options', options: employeeRanges },
  revenue: { key: 'revenue', param: 'revenue_range', label: 'Annual revenue', help: 'Whole numbers, no currency symbols or commas.', group: 'Company', type: 'range', unit: 'USD' },
  orgLocations: { key: 'orgLocations', param: 'organization_locations', label: 'Company HQ location', help: 'City, state or country of the company’s headquarters.', group: 'Location', type: 'list', suggestions: locations, max: 25 },
  orgNotLocations: { key: 'orgNotLocations', param: 'organization_not_locations', label: 'Exclude company HQ location', help: 'Leave out companies headquartered here.', group: 'Location', type: 'list', suggestions: locations, max: 25 },
  naics: { key: 'naics', param: 'organization_naics_codes', label: 'NAICS codes', help: 'Industry classification codes, such as 541810.', group: 'Company', type: 'list', max: 25 },
  sic: { key: 'sic', param: 'organization_sic_codes', label: 'SIC codes', help: 'Industry classification codes, such as 7311.', group: 'Company', type: 'list', max: 25 },
  techAny: { key: 'techAny', param: 'currently_using_any_of_technology_uids', label: 'Uses any of these technologies', help: 'Apollo technology IDs: lowercase, with spaces and dots as underscores (wordpress_org).', group: 'Technology', type: 'list', suggestions: technologies, technology: true, max: 25 },
  jobTitles: { key: 'jobTitles', param: 'q_organization_job_titles', label: 'Hiring for job titles', help: 'Companies with open jobs matching these titles.', group: 'Hiring & growth', type: 'list', max: 25 },
  jobLocations: { key: 'jobLocations', param: 'organization_job_locations', label: 'Open job locations', help: 'Where those open jobs are.', group: 'Hiring & growth', type: 'list', suggestions: locations, max: 25 },
  jobCount: { key: 'jobCount', param: 'organization_num_jobs_range', label: 'Number of open jobs', help: 'Active job postings.', group: 'Hiring & growth', type: 'range' },
  jobPosted: { key: 'jobPosted', param: 'organization_job_posted_at_range', label: 'Jobs posted between', help: 'When the job postings were published.', group: 'Hiring & growth', type: 'dateRange' },
  growth: { key: 'growth', param: 'organization_headcount_growth_range', label: 'Headcount growth (%)', help: 'Change in employee count over the chosen period. Negative numbers mean shrinking.', group: 'Hiring & growth', type: 'range', unit: '%' },
  growthPeriod: { key: 'growthPeriod', param: 'organization_headcount_growth_past_n_months', label: 'Growth period', help: 'The period headcount growth is measured over.', group: 'Hiring & growth', type: 'select', options: growthMonths },
} satisfies Record<string, FilterDefinition>

export const peopleFilters: FilterDefinition[] = [
  { key: 'titles', param: 'person_titles', label: 'Job titles', help: 'Current job titles, such as “marketing manager”.', group: 'Person', type: 'list', max: 50, suggestions: ['owner', 'founder', 'ceo', 'marketing manager', 'head of marketing', 'office manager'] },
  { key: 'similarTitles', param: 'include_similar_titles', label: 'Include similar titles', help: 'Also match titles Apollo considers similar.', group: 'Person', type: 'boolean' },
  { key: 'notTitles', param: 'person_not_titles', label: 'Exclude job titles', help: 'Leave out people with these current titles.', group: 'Person', type: 'list', max: 50 },
  { key: 'seniorities', param: 'person_seniorities', label: 'Seniority', help: 'The person’s level in their company.', group: 'Person', type: 'options', options: seniorities },
  { key: 'keywords', param: 'q_keywords', label: 'Keywords', help: 'Words to match anywhere in the person’s profile.', group: 'Person', type: 'text' },
  { key: 'personName', param: 'q_person_name', label: 'Person name', help: 'A full or partial name.', group: 'Person', type: 'text' },
  { key: 'emailStatus', param: 'contact_email_status', label: 'Email status', help: 'Apollo’s confidence in the work email. Revealing still uses a credit.', group: 'Person', type: 'options', options: emailStatuses },
  { key: 'personLocations', param: 'person_locations', label: 'Person location', help: 'Where the person lives: city, state or country.', group: 'Location', type: 'list', suggestions: locations, max: 25 },
  { key: 'personNotLocations', param: 'person_not_locations', label: 'Exclude person location', help: 'Leave out people located here.', group: 'Location', type: 'list', suggestions: locations, max: 25 },
  shared.orgLocations, shared.orgNotLocations, shared.domains, shared.industries, shared.employees, shared.revenue, shared.naics, shared.sic, shared.techAny,
  { key: 'techAll', param: 'currently_using_all_of_technology_uids', label: 'Uses all of these technologies', help: 'Every listed technology must be in use.', group: 'Technology', type: 'list', suggestions: technologies, technology: true, max: 25 },
  { key: 'techNot', param: 'currently_not_using_any_of_technology_uids', label: 'Uses none of these technologies', help: 'Leave out companies using any of these.', group: 'Technology', type: 'list', suggestions: technologies, technology: true, max: 25 },
  shared.jobTitles, shared.jobLocations, shared.jobCount, shared.jobPosted, shared.growth, shared.growthPeriod,
]
export const organizationFilters: FilterDefinition[] = [
  { key: 'orgName', param: 'q_organization_name', label: 'Company name', help: 'A full or partial company name.', group: 'Company', type: 'text' },
  shared.domains, shared.industries,
  { key: 'keywordTags', param: 'q_organization_keyword_tags', label: 'Company keywords', help: 'Keywords describing what the company does, such as “seo”.', group: 'Company', type: 'list', max: 25 },
  { key: 'notKeywordTags', param: 'q_not_organization_keyword_tags', label: 'Exclude company keywords', help: 'Leave out companies with these keywords.', group: 'Company', type: 'list', max: 25 },
  shared.employees, shared.revenue, shared.naics, shared.sic, shared.orgLocations, shared.orgNotLocations, shared.techAny,
  { key: 'latestFunding', param: 'latest_funding_amount_range', label: 'Latest funding round', help: 'Amount of the most recent round.', group: 'Funding', type: 'range', unit: 'USD' },
  { key: 'totalFunding', param: 'total_funding_range', label: 'Total funding', help: 'All rounds combined.', group: 'Funding', type: 'range', unit: 'USD' },
  { key: 'fundingDate', param: 'latest_funding_date_range', label: 'Latest round date', help: 'When the most recent round closed.', group: 'Funding', type: 'dateRange' },
  shared.jobTitles, shared.jobLocations, shared.jobCount, shared.jobPosted, shared.growth, shared.growthPeriod,
]
export const filterGroups = ['Person', 'Company', 'Location', 'Technology', 'Funding', 'Hiring & growth']
/** Requested filters Apollo's API doesn't offer for that search, so LeadFlow doesn't either. */
export const unsupportedFilters: Record<SearchKind, { label: string; reason: string }[]> = {
  people: [
    { label: 'Department', reason: 'People API Search has no department filter.' },
    { label: 'Management level', reason: 'Not a separate filter; use Seniority.' },
    { label: 'Company funding', reason: 'Funding filters exist only in company search.' },
    { label: 'Phone availability', reason: 'Not a filter; results show whether a direct phone may be available.' },
  ],
  organizations: [
    { label: 'Funding stage', reason: 'Not a parameter of Organization Search; use funding amount and date.' },
    { label: 'Uses all / none of technologies', reason: 'Organization Search accepts “any of” only.' },
  ],
}
export const filtersFor = (kind: SearchKind) => kind === 'people' ? peopleFilters : organizationFilters

export type FilterValue = string[] | string | boolean | { min?: number | string; max?: number | string }
export type FilterValues = Record<string, FilterValue>
export class FilterError extends Error {}
const isControl = (value: string) => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
const cleanItem = (value: string, technology = false) => {
  const text = value.trim().replace(/\s+/g, ' ')
  return technology ? text.toLowerCase().replace(/[ .]/g, '_') : text
}
/** Validates submitted filter values. Empty values are dropped; anything unknown or malformed is refused with a reason. */
export function parseFilters(kind: SearchKind, input: unknown): FilterValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FilterError('Choose at least one filter.')
  const definitions = new Map(filtersFor(kind).map(definition => [definition.key, definition]))
  const result: FilterValues = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const definition = definitions.get(key)
    if (!definition) throw new FilterError(`“${key}” isn’t a filter for this search.`)
    const label = definition.label
    if (definition.type === 'list' || definition.type === 'options') {
      if (!Array.isArray(raw) || !raw.every(item => typeof item === 'string')) throw new FilterError(`${label}: enter a list of values.`)
      const values = [...new Set((raw as string[]).map(item => cleanItem(item, definition.technology)).filter(Boolean))]
      if (values.length > (definition.max ?? 25)) throw new FilterError(`${label}: use at most ${definition.max ?? 25} values.`)
      if (values.some(value => value.length > 100 || isControl(value))) throw new FilterError(`${label}: each value must be at most 100 characters.`)
      if (definition.options && values.some(value => !definition.options!.some(option => option.value === value))) throw new FilterError(`${label}: choose from the list.`)
      if (values.length) result[key] = values
    } else if (definition.type === 'text') {
      if (typeof raw !== 'string') throw new FilterError(`${label}: enter text.`)
      const value = raw.trim().replace(/\s+/g, ' ')
      if (value.length > 200 || isControl(value)) throw new FilterError(`${label}: use at most 200 characters.`)
      if (value) result[key] = value
    } else if (definition.type === 'boolean') {
      if (typeof raw !== 'boolean') throw new FilterError(`${label}: choose yes or no.`)
      if (raw) result[key] = true
    } else if (definition.type === 'select') {
      if (raw === '' || raw === null) continue
      if (typeof raw !== 'string' || !definition.options!.some(option => option.value === raw)) throw new FilterError(`${label}: choose from the list.`)
      result[key] = raw
    } else {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FilterError(`${label}: enter a range.`)
      const range = raw as { min?: unknown; max?: unknown }, out: { min?: number | string; max?: number | string } = {}
      for (const side of ['min', 'max'] as const) {
        const value = range[side]
        if (value === undefined || value === null || value === '') continue
        if (definition.type === 'dateRange') {
          if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) throw new FilterError(`${label}: use dates like 2026-01-31.`)
          out[side] = value
        } else {
          const number = typeof value === 'string' ? Number(value) : value
          const allowNegative = definition.key === 'growth'
          if (typeof number !== 'number' || !Number.isInteger(number) || number > 1e12 || (!allowNegative && number < 0) || number < -1000) throw new FilterError(`${label}: enter whole numbers${allowNegative ? '' : ' of 0 or more'}.`)
          out[side] = number
        }
      }
      if (out.min !== undefined && out.max !== undefined && out.min > out.max) throw new FilterError(`${label}: the minimum is above the maximum.`)
      if (out.min !== undefined || out.max !== undefined) result[key] = out
    }
  }
  if (result.growthPeriod && !result.growth) delete result.growthPeriod
  if (result.similarTitles && !result.titles) delete result.similarTitles
  if (!Object.keys(result).length) throw new FilterError('Choose at least one filter.')
  return result
}
/** Apollo's query string for validated filters. Search endpoints take their parameters in the query string. */
export function buildQuery(kind: SearchKind, filters: FilterValues, page: number, perPage: number): URLSearchParams {
  const query = new URLSearchParams()
  for (const definition of filtersFor(kind)) {
    const value = filters[definition.key]
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) query.append(`${definition.param}[]`, item)
    else if (typeof value === 'object') { if (value.min !== undefined) query.set(`${definition.param}[min]`, String(value.min)); if (value.max !== undefined) query.set(`${definition.param}[max]`, String(value.max)) }
    else query.set(definition.param, String(value))
  }
  query.set('page', String(page))
  query.set('per_page', String(perPage))
  return query
}
