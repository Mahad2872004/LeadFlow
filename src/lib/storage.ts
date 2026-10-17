import { isCalendarDate } from './dates'
import { statuses, validateLead, type Data, type LeadInput } from './model'
import { sampleData } from './seed'
export const STORAGE_KEY = 'leadflow.demo.v1'
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function strings<K extends string>(value: Record<string, unknown>, keys: readonly K[]): value is Record<K, string> & Record<string, unknown> {
  return keys.every(key => typeof value[key] === 'string')
}
function timestamp(value: string): boolean {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}
function uniqueIds(values: unknown[]): boolean {
  const ids = new Set<string>()
  return values.every(value => {
    if (!record(value) || typeof value.id !== 'string' || !value.id.trim() || ids.has(value.id)) return false
    ids.add(value.id)
    return true
  })
}
/** Reject invalid relationships and duplicate identities before they reach React or domain operations. */
export function isData(value: unknown): value is Data {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.leads) || !Array.isArray(value.tasks) || !Array.isArray(value.activities)) return false
  const { leads, tasks, activities } = value
  if (![leads, tasks, activities].every(uniqueIds)) return false
  const fields = ['name', 'email', 'phone', 'company', 'service', 'source', 'message'] as const satisfies readonly (keyof LeadInput)[]
  if (!leads.every(lead => record(lead) && strings(lead, [...fields, 'id', 'createdAt']) && validateLead(lead) === null && statuses.some(status => status === lead.status) && timestamp(lead.createdAt))) return false
  const leadIds = new Set(leads.map(lead => lead.id))
  return tasks.every(task => record(task) && strings(task, ['id', 'leadId', 'due', 'notes']) && isCalendarDate(task.due) && task.notes.trim().length > 0 && task.notes.length <= 2000 && typeof task.completed === 'boolean' && leadIds.has(task.leadId))
    && activities.every(event => record(event) && strings(event, ['id', 'leadId', 'text', 'at']) && event.text.trim().length > 0 && timestamp(event.at) && leadIds.has(event.leadId))
}
export function loadData(storage?: StoragePort): {data: Data; error: string | null} {
  try {
    const raw = (storage ?? window.localStorage).getItem(STORAGE_KEY)
    if (raw === null) return {data: sampleData(), error: null}
    const parsed: unknown = JSON.parse(raw)
    if (!isData(parsed)) throw new Error('Invalid data')
    return {data: parsed, error: null}
  } catch {
    return {data: {version: 1, leads: [], tasks: [], activities: []}, error: 'Saved data could not be read. It has not been overwritten. Reset the demo to recover, or reload to retry.'}
  }
}
export function saveData(data: Data, storage?: StoragePort): string | null {
  try {
    (storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify(data))
    return null
  } catch {
    return 'Changes are only in memory. Browser storage is unavailable or full; they may be lost on refresh.'
  }
}

