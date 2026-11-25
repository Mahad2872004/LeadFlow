import { isCalendarDate } from './dates'
import { businessFields, priorities, statuses, taskTypes, validateLead, workStatuses, type Data, type LeadInput } from './model'
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
  if (!leads.every(lead => record(lead) && strings(lead, [...fields, 'id', 'createdAt']) && businessFields.every(key => lead[key] === undefined || typeof lead[key] === 'string') && validateLead(lead) === null && statuses.some(status => status === lead.status) && timestamp(lead.createdAt))) return false
  const leadIds = new Set(leads.map(lead => lead.id))
  const optionalText = (value: unknown) => value === undefined || value === null || typeof value === 'string'
  const optionalTime = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && Number.isFinite(new Date(value).getTime()))
  // A task belongs to a lead of this workspace, or (M10) to a client: then it has no lead. The database checks the client.
  const owner = (task: Record<string, unknown>) => typeof task.leadId === 'string' ? leadIds.has(task.leadId) : (task.leadId === null || task.leadId === undefined) && typeof task.clientId === 'string' && task.clientId.length > 0
  return tasks.every(task => record(task) && strings(task, ['id', 'due', 'notes']) && isCalendarDate(task.due) && task.notes.trim().length > 0 && task.notes.length <= 2000 && typeof task.completed === 'boolean' && owner(task)
    // M9 and M10 fields are optional; the database checks that deals, contacts, clients and assignees belong to the workspace.
    && optionalText(task.dealId) && optionalText(task.contactId) && optionalText(task.assigneeId) && optionalTime(task.createdAt) && optionalTime(task.completedAt)
    && optionalText(task.clientId) && optionalText(task.onboardingRequestId) && optionalText(task.onboardingItemId)
    // M11 project task fields are optional too; the database checks the project, milestone, deliverable and dependencies.
    && optionalText(task.projectId) && optionalText(task.milestoneId) && optionalText(task.deliverableId) && optionalText(task.startDate)
    && (task.status === undefined || workStatuses.some(status => status === task.status))
    && [task.estimateHours, task.actualHours].every(hours => hours === undefined || hours === null || typeof hours === 'number' || (typeof hours === 'string' && Number.isFinite(Number(hours))))
    && [task.labels, task.dependsOn].every(list => list === undefined || (Array.isArray(list) && list.every(item => typeof item === 'string')))
    && (task.taskType === undefined || taskTypes.some(type => type === task.taskType)) && (task.priority === undefined || priorities.some(priority => priority === task.priority))
    && (task.cancelled === undefined || (typeof task.cancelled === 'boolean' && !(task.cancelled && task.completed))) && (task.description === undefined || (typeof task.description === 'string' && task.description.length <= 2000)))
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

