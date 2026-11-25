import { isCalendarDate, localDate } from './dates'
export const services = ['Website design', 'Web development', 'Brand identity', 'Consulting', 'Other', 'Not specified'] as const
export const sources = ['Website', 'Referral', 'LinkedIn', 'Email', 'Other', 'Lead discovery', 'CSV import'] as const
export const statuses = ['New', 'Contacted', 'Qualified', 'Converted', 'Lost'] as const
export type Status = typeof statuses[number]
/** Countries discovery searches; leads may hold any two-letter code, e.g. from a CSV file. */
export const countries = [['US', 'United States'], ['GB', 'United Kingdom'], ['AU', 'Australia']] as const
/** Optional business details. Leads from the database always have them; leads saved by M1 in a browser may not. */
export const businessFields = ['website', 'industry', 'address', 'city', 'region', 'postcode', 'country'] as const
export type BusinessDetails = Record<typeof businessFields[number], string>
export interface Lead extends Partial<BusinessDetails> { id: string; name: string; email: string; phone: string; company: string; service: string; source: string; message: string; status: Status; createdAt: string }
export type LeadInput = Omit<Lead, 'id' | 'status' | 'createdAt'>
/** Kinds of follow-up (M9), of client onboarding task (M10) and project delivery task (M11). Tasks are reminders: none of them sends anything. */
export const leadTaskTypes = ['follow_up', 'call', 'email', 'whatsapp', 'meeting', 'proposal', 'proposal_review', 'internal', 'custom'] as const
export const clientTaskTypes = ['welcome', 'request_info', 'review_form', 'collect_assets', 'review_requirements', 'confirm_scope', 'verify_integrations', 'prepare_handoff', 'call', 'meeting', 'internal', 'custom'] as const
export const taskTypes = [...leadTaskTypes, 'welcome', 'request_info', 'review_form', 'collect_assets', 'review_requirements', 'confirm_scope', 'verify_integrations', 'prepare_handoff', 'delivery'] as const
export type TaskType = typeof taskTypes[number]
export const priorities = ['low', 'medium', 'high'] as const
export type Priority = typeof priorities[number]
/** The work status of an open project task (M11). Completed and cancelled tasks keep using completed/cancelled. */
export const workStatuses = ['todo', 'in_progress', 'in_review', 'blocked'] as const
export type WorkStatus = typeof workStatuses[number]
/**
 * A follow-up. Since M9 it can belong to a deal and a contact of its lead, have a type, priority, description and assignee,
 * and be cancelled. Since M10 it can instead belong to a client (leadId null), optionally to one of the client's onboarding
 * requests and items. Those fields are optional so follow-ups saved before (and M1 browser data) keep their shape.
 */
export interface Task {
  id: string; leadId: string | null; due: string; notes: string; completed: boolean
  dealId?: string | null; contactId?: string | null; taskType?: TaskType; priority?: Priority; cancelled?: boolean; description?: string
  assigneeId?: string | null; createdAt?: string | null; completedAt?: string | null
  clientId?: string | null; onboardingRequestId?: string | null; onboardingItemId?: string | null
  /** M11 project tasks: the project (and its client in clientId), milestone and deliverable, work status, start date, effort in hours, labels and the tasks it waits for. */
  projectId?: string | null; milestoneId?: string | null; deliverableId?: string | null; status?: WorkStatus; startDate?: string | null
  estimateHours?: number | null; actualHours?: number | null; labels?: string[]; dependsOn?: string[]
}
export type TaskOptions = Partial<Pick<Task, 'dealId' | 'contactId' | 'taskType' | 'priority' | 'description' | 'assigneeId'>>
export type ClientTaskOptions = Partial<Pick<Task, 'taskType' | 'priority' | 'description' | 'assigneeId' | 'onboardingRequestId' | 'onboardingItemId'>>
export interface Activity { id: string; leadId: string; text: string; at: string }
export interface Data { version: 1; leads: Lead[]; tasks: Task[]; activities: Activity[] }
export const today = localDate
export const uid = () => crypto.randomUUID()
export const activity = (leadId: string, text: string): Activity => ({ id: uid(), leadId, text, at: new Date().toISOString() })
export function validateLead(input: LeadInput): string | null {
  if (!input.name.trim()) return 'Please enter a name.'
  // Optional since M6: most businesses found through discovery publish no email address.
  if (input.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) return 'Please enter a valid email address.'
  if (input.phone.trim() && (!/^[+\d\s().-]{7,25}$/.test(input.phone.trim()) || input.phone.replace(/\D/g,'').length < 7)) return 'Please enter a valid phone number.'
  if (!services.some(value=>value===input.service) || !sources.some(value=>value===input.source)) return 'Choose a service and source.'
  if ([input.name,input.email,input.company].some(value=>value.trim().length>150) || input.message.length>2000) return 'Contact fields must be at most 150 characters and the message at most 2000 characters.'
  if (input.website?.trim() && !normalizeWebsite(input.website)) return 'Enter a website such as https://example.com.'
  if ((input.industry??'').trim().length>100 || (input.address??'').trim().length>300 || (input.city??'').trim().length>100 || (input.region??'').trim().length>100 || (input.postcode??'').trim().length>20) return 'Business details are too long: industry, city and region up to 100 characters, address up to 300, postcode up to 20.'
  if (input.country?.trim() && !/^[A-Za-z]{2}$/.test(input.country.trim())) return 'Choose a country.'
  return null
}
/** An http(s) URL without credentials, at most 300 characters; a bare domain is read as https. Empty when unusable. */
export function normalizeWebsite(value: string): string {
  let candidate = value.trim()
  if (!candidate) return ''
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(candidate)) return ''
    candidate = `https://${candidate}`
  }
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return ''
    return url.href.length <= 300 ? url.href : ''
  } catch { return '' }
}
export function normalizeLead(input: LeadInput): LeadInput {
  const lead: LeadInput = {name:input.name.trim(),email:input.email.trim(),phone:input.phone.trim(),company:input.company.trim(),service:input.service,source:input.source,message:input.message.trim()}
  // Business fields are written only when the form had them, so M1 browser data keeps its original shape.
  for (const key of businessFields) if (input[key] !== undefined) lead[key] = key === 'website' ? normalizeWebsite(input[key]) : key === 'country' ? input[key].trim().toUpperCase() : input[key].trim()
  return lead
}
export function updateLead(data: Data, id: string, input: LeadInput, status: Status): Data {
  const existing=data.leads.find(lead=>lead.id===id)
  if(!existing) throw new Error('This lead could not be found. Close this form and try again.')
  const error=validateLead(input)
  if(error) throw new Error(error)
  if(!statuses.includes(status)) throw new Error('Choose a valid status.')
  const normalized=normalizeLead(input)
  // A business field missing from an older lead counts as empty, so saving it unchanged records no edit.
  const changed=(Object.keys(normalized) as (keyof LeadInput)[]).filter(key=>(normalized[key]??'')!==(existing[key]??''))
  let next=data
  if(changed.length) next={...data,leads:data.leads.map(lead=>lead.id===id?{...lead,...normalized}:lead),activities:[activity(id,`Lead details updated: ${changed.join(', ')}`),...data.activities]}
  return changeStatus(next,id,status)
}
export function createLead(data: Data, input: LeadInput): Data {
  const error = validateLead(input); if (error) throw new Error(error)
  const normalized = normalizeLead(input)
  const lead: Lead = { ...normalized, id: uid(), status: 'New', createdAt: new Date().toISOString() }
  return { ...data, leads: [lead,...data.leads], activities: [activity(lead.id,'Lead captured'),...data.activities] }
}
export function changeStatus(data: Data, id: string, status: Status): Data {
  if(!statuses.includes(status)) throw new Error('Choose a valid status.')
  const lead = data.leads.find(l=>l.id===id); if (!lead || lead.status===status) return data
  return {...data, leads:data.leads.map(l=>l.id===id?{...l,status}:l),activities:[activity(id,`Status changed from ${lead.status} to ${status}`),...data.activities]}
}
export function createTask(data: Data, leadId: string, due: string, notes: string, options: TaskOptions = {}): Data {
  if (!data.leads.some(l=>l.id===leadId) || !isCalendarDate(due) || !notes.trim() || notes.trim().length>2000) throw new Error('Choose a lead, a valid due date, and add follow-up notes.')
  if ((options.description ?? '').length > 2000) throw new Error('Keep the description under 2,000 characters.')
  if (options.taskType && !taskTypes.includes(options.taskType)) throw new Error('Choose a follow-up type.')
  if (options.priority && !priorities.includes(options.priority)) throw new Error('Choose a priority.')
  // The database checks that the deal and contact belong to this lead and that the assignee is a member.
  const extra: TaskOptions = Object.fromEntries(Object.entries({ ...options, description: options.description?.trim() || undefined }).filter(([, value]) => value !== undefined && value !== null && value !== ''))
  const task: Task = { id: uid(), leadId, due, notes: notes.trim(), completed: false, ...extra, createdAt: new Date().toISOString() }
  return {...data,tasks:[task,...data.tasks],activities:[activity(leadId,`Follow-up scheduled for ${due}: ${notes.trim()}`),...data.activities]}
}
/**
 * A task for a client (M10). It has no lead, so it adds nothing to the lead activity history; the client's timeline shows
 * it. The database checks that the client and request belong to this workspace and that the assignee is a member.
 */
export function createClientTask(data: Data, clientId: string, due: string, notes: string, options: ClientTaskOptions = {}): Data {
  if (!clientId || !isCalendarDate(due) || !notes.trim() || notes.trim().length>2000) throw new Error('Choose a valid due date and describe the task.')
  if ((options.description ?? '').length > 2000) throw new Error('Keep the description under 2,000 characters.')
  if (options.taskType && !taskTypes.includes(options.taskType)) throw new Error('Choose a task type.')
  if (options.priority && !priorities.includes(options.priority)) throw new Error('Choose a priority.')
  const extra: ClientTaskOptions = Object.fromEntries(Object.entries({ ...options, description: options.description?.trim() || undefined }).filter(([, value]) => value !== undefined && value !== null && value !== ''))
  const task: Task = { id: uid(), leadId: null, clientId, due, notes: notes.trim(), completed: false, cancelled: false, taskType: 'custom', priority: 'medium', ...extra, createdAt: new Date().toISOString(), completedAt: null }
  return {...data,tasks:[task,...data.tasks]}
}
export interface ProjectTaskInput {
  title: string; description?: string; due: string; startDate?: string | null; priority?: Priority; status?: WorkStatus; assigneeId?: string | null
  milestoneId?: string | null; deliverableId?: string | null; estimateHours?: number | null; actualHours?: number | null; labels?: string[]; dependsOn?: string[]
}
const cleanLabels = (labels: string[] | undefined) => [...new Set((labels ?? []).map(label => label.trim()).filter(Boolean))]
function checkProjectTask(input: ProjectTaskInput) {
  if (!input.title.trim() || input.title.trim().length > 2000) throw new Error('Give the task a title.')
  if (!isCalendarDate(input.due)) throw new Error('Choose a valid due date.')
  if (input.startDate && (!isCalendarDate(input.startDate) || input.startDate > input.due)) throw new Error('The start date must be on or before the due date.')
  if ((input.description ?? '').length > 2000) throw new Error('Keep the description under 2,000 characters.')
  for (const hours of [input.estimateHours, input.actualHours]) if (hours !== undefined && hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 10000)) throw new Error('Effort is a number of hours from 0 to 10,000.')
  const labels = cleanLabels(input.labels)
  if (labels.length > 10 || labels.some(label => label.length > 30)) throw new Error('Use up to 10 labels of at most 30 characters.')
  if ((input.dependsOn ?? []).length > 20) throw new Error('A task can wait for up to 20 others.')
}
/** The tasks a project task would end up waiting for through its dependencies; true when that includes itself. */
export function createsDependencyCycle(tasks: Task[], taskId: string, dependsOn: string[]): boolean {
  const byId = new Map(tasks.map(task => [task.id, task])), seen = new Set<string>(), queue = [...dependsOn]
  while (queue.length) {
    const next = queue.pop()!
    if (next === taskId) return true
    if (seen.has(next)) continue
    seen.add(next); queue.push(...(byId.get(next)?.dependsOn ?? []))
  }
  return false
}
/** The open tasks this task is waiting for. */
export const waitingFor = (task: Task, tasks: Task[]) => (task.dependsOn ?? []).map(id => tasks.find(other => other.id === id)).filter((other): other is Task => !!other && !other.completed && !other.cancelled)
/**
 * A project task (M11): the same follow-up task, belonging to the project and its client (no lead). The database checks
 * that the project, milestone, deliverable and dependencies belong together and that dependencies never go in a circle.
 */
export function createProjectTask(data: Data, project: { id: string; clientId: string }, input: ProjectTaskInput): Data {
  checkProjectTask(input)
  const id = uid()
  if (createsDependencyCycle(data.tasks, id, input.dependsOn ?? [])) throw new Error('Task dependencies can’t go in a circle.')
  const task: Task = { id, leadId: null, clientId: project.clientId, projectId: project.id, due: input.due, notes: input.title.trim(), completed: false, cancelled: false, taskType: 'delivery',
    priority: input.priority ?? 'medium', description: input.description?.trim() ?? '', assigneeId: input.assigneeId ?? null, createdAt: new Date().toISOString(), completedAt: null,
    milestoneId: input.milestoneId ?? null, deliverableId: input.deliverableId ?? null, status: input.status ?? 'todo', startDate: input.startDate || null,
    estimateHours: input.estimateHours ?? null, actualHours: input.actualHours ?? null, labels: cleanLabels(input.labels), dependsOn: [...new Set(input.dependsOn ?? [])] }
  return {...data,tasks:[task,...data.tasks]}
}
/** Edits a project task's details. Completion stays with toggleTask, cancellation with cancelTask. */
export function updateProjectTask(data: Data, id: string, input: ProjectTaskInput): Data {
  const task = data.tasks.find(item => item.id === id); if (!task) return data
  checkProjectTask(input)
  if ((input.dependsOn ?? []).includes(id) || createsDependencyCycle(data.tasks, id, input.dependsOn ?? [])) throw new Error('Task dependencies can’t go in a circle.')
  return {...data,tasks:data.tasks.map(item=>item.id===id?{...item, notes: input.title.trim(), description: input.description?.trim() ?? '', due: input.due, startDate: input.startDate || null,
    priority: input.priority ?? item.priority, status: input.status ?? item.status ?? 'todo', assigneeId: input.assigneeId ?? null, milestoneId: input.milestoneId ?? null,
    deliverableId: input.deliverableId ?? null, estimateHours: input.estimateHours ?? null, actualHours: input.actualHours ?? null, labels: cleanLabels(input.labels),
    dependsOn: [...new Set(input.dependsOn ?? [])]}:item)}
}
/** Moves a project task on the board: an open work status, or completed (which records the completion time). */
export function setTaskWorkStatus(data: Data, id: string, next: WorkStatus | 'completed'): Data {
  const task = data.tasks.find(item => item.id === id); if (!task || task.cancelled) return data
  if (next === 'completed') return task.completed ? data : {...data,tasks:data.tasks.map(item=>item.id===id?{...item, completed: true, completedAt: new Date().toISOString()}:item)}
  return {...data,tasks:data.tasks.map(item=>item.id===id?{...item, status: next, completed: false, completedAt: item.completed ? null : item.completedAt ?? null}:item)}
}
/** Lead history entries for a task change; client tasks (no lead) are recorded in the client's timeline instead. */
const taskActivity = (task: Task, text: string): Activity[] => task.leadId ? [activity(task.leadId, text)] : []
export function toggleTask(data: Data, id: string): Data {
  const task=data.tasks.find(t=>t.id===id); if(!task) return data
  const completing = !task.completed
  // Completion time is recorded for follow-ups that track it (M9); older ones keep their shape.
  const stamp = task.createdAt !== undefined || task.cancelled !== undefined ? { cancelled: false, completedAt: completing ? new Date().toISOString() : null } : {}
  return {...data,tasks:data.tasks.map(t=>t.id===id?{...t,...stamp,completed:completing}:t),activities:[...taskActivity(task,`Follow-up ${completing?'completed':'reopened'}: ${task.notes}`),...data.activities]}
}
/** Cancels an open follow-up, or reopens a cancelled one. Cancelled follow-ups stay in the history. */
export function cancelTask(data: Data, id: string): Data {
  const task=data.tasks.find(t=>t.id===id); if(!task || task.completed) return data
  const cancelling = !task.cancelled
  return {...data,tasks:data.tasks.map(t=>t.id===id?{...t,cancelled:cancelling,completedAt:cancelling?new Date().toISOString():null}:t),activities:[...taskActivity(task,`Follow-up ${cancelling?'cancelled':'reopened'}: ${task.notes}`),...data.activities]}
}
