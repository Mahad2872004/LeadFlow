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
/** Kinds of follow-up (M9). Tasks are reminders: none of them sends anything. */
export const taskTypes = ['follow_up', 'call', 'email', 'whatsapp', 'meeting', 'proposal', 'proposal_review', 'internal', 'custom'] as const
export type TaskType = typeof taskTypes[number]
export const priorities = ['low', 'medium', 'high'] as const
export type Priority = typeof priorities[number]
/**
 * A follow-up. Since M9 it can belong to a deal and a contact of its lead, have a type, priority, description and assignee,
 * and be cancelled. Those fields are optional so follow-ups saved before M9 (and M1 browser data) keep their shape.
 */
export interface Task {
  id: string; leadId: string; due: string; notes: string; completed: boolean
  dealId?: string | null; contactId?: string | null; taskType?: TaskType; priority?: Priority; cancelled?: boolean; description?: string
  assigneeId?: string | null; createdAt?: string | null; completedAt?: string | null
}
export type TaskOptions = Partial<Pick<Task, 'dealId' | 'contactId' | 'taskType' | 'priority' | 'description' | 'assigneeId'>>
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
export function toggleTask(data: Data, id: string): Data {
  const task=data.tasks.find(t=>t.id===id); if(!task) return data
  const completing = !task.completed
  // Completion time is recorded for follow-ups that track it (M9); older ones keep their shape.
  const stamp = task.createdAt !== undefined || task.cancelled !== undefined ? { cancelled: false, completedAt: completing ? new Date().toISOString() : null } : {}
  return {...data,tasks:data.tasks.map(t=>t.id===id?{...t,...stamp,completed:completing}:t),activities:[activity(task.leadId,`Follow-up ${completing?'completed':'reopened'}: ${task.notes}`),...data.activities]}
}
/** Cancels an open follow-up, or reopens a cancelled one. Cancelled follow-ups stay in the history. */
export function cancelTask(data: Data, id: string): Data {
  const task=data.tasks.find(t=>t.id===id); if(!task || task.completed) return data
  const cancelling = !task.cancelled
  return {...data,tasks:data.tasks.map(t=>t.id===id?{...t,cancelled:cancelling,completedAt:cancelling?new Date().toISOString():null}:t),activities:[activity(task.leadId,`Follow-up ${cancelling?'cancelled':'reopened'}: ${task.notes}`),...data.activities]}
}
