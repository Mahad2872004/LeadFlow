import { filtersFor, type FilterDefinition, type FilterValue, type FilterValues, type SearchKind } from './apollo'
type Range = { min?: number | string; max?: number | string }
export const isEmptyFilter = (value: FilterValue | undefined) => value === undefined || value === '' || value === false || (Array.isArray(value) && !value.length)
  || (typeof value === 'object' && !Array.isArray(value) && (value as Range).min === undefined && (value as Range).max === undefined)
/** Drops empty values, so saved searches and requests contain only what was chosen. */
export const compactFilters = (filters: FilterValues): FilterValues => Object.fromEntries(Object.entries(filters).filter(([, value]) => !isEmptyFilter(value)))
/** Readable text for one filter value, for chips and saved-search summaries. */
export function describeValue(definition: FilterDefinition, value: FilterValue): string {
  if (Array.isArray(value)) return value.map(item => definition.options?.find(option => option.value === item)?.label ?? item).join(', ')
  if (typeof value === 'boolean') return 'Yes'
  if (typeof value === 'object') { const range = value as Range; return range.min !== undefined && range.max !== undefined ? `${range.min}–${range.max}` : range.min !== undefined ? `${range.min} or more` : `up to ${range.max}` }
  return definition.options?.find(option => option.value === value)?.label ?? String(value)
}
/** "Job titles: owner · Seniority: Founder" */
export function summarize(kind: SearchKind, filters: FilterValues) {
  return filtersFor(kind).filter(definition => filters[definition.key] !== undefined).map(definition => `${definition.label}: ${describeValue(definition, filters[definition.key])}`).join(' · ') || 'No filters'
}
