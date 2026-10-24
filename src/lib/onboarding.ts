import { supabase } from './supabase'
import { failure, RequestError } from './backend'
import type { ItemDefinition, ItemKind, ItemState, ReadinessState, RequestStatus, ResponseValue, ServiceType } from './onboardingOptions'
export * from './onboardingOptions'

export interface Blocker { itemId: string; title: string; state: ItemState; kind: ItemKind; waitingOn: 'client' | 'agency'; reason: string }
/** Computed by the database from item states; nothing here is a score or an estimate. */
export interface Readiness { state: ReadinessState; requirementsMet: boolean; requiredTotal: number; requiredAccepted: number; requiredWaived: number; optionalTotal: number; optionalOutstanding: number; percent: number; blockers: Blocker[] }
export interface RequestSummary {
  id: string; title: string; clientName: string; serviceType: ServiceType; ownerId: string | null; status: RequestStatus; version: number
  startDate: string | null; targetKickoffDate: string | null; dueDate: string | null; createdAt: string; updatedAt: string; readySince: string | null; nextReminderAt: string | null
  hasActiveLink: boolean; counts: { total: number; requiredOutstanding: number; awaitingReview: number; changesRequested: number; overdue: number }; readiness: Readiness
}
export interface TemplateSummary { id: string; name: string; serviceType: ServiceType; description: string; starterKey: ServiceType | null; archived: boolean; version: number; updatedAt: string; itemCount: number; requiredCount: number }
export interface Member { id: string; name: string }
export interface Overview { today: string; members: Member[]; templates: TemplateSummary[]; requests: RequestSummary[] }
export interface Template { id: string; name: string; serviceType: ServiceType; description: string; starterKey: ServiceType | null; archived: boolean; version: number; items: ItemDefinition[] }
export interface RequestItem extends ItemDefinition {
  id: string; position: number; dueDate: string | null; state: ItemState; response: ResponseValue | null; hasDraft: boolean; revision: number
  submittedAt: string | null; reviewedAt: string | null; clientFeedback: string; waiveReason: string; internalNote: string; overdue: boolean
}
export interface LinkInfo { id: string; purpose: 'shared' | 'reminder'; createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null; active: boolean }
export type ReminderBlock = 'not_active' | 'disabled' | 'no_email' | 'max_reached' | 'nothing_outstanding' | 'no_link' | null
export interface ReminderRecord { id: string; sequence: number; status: 'pending' | 'sending' | 'accepted' | 'failed' | 'uncertain' | 'cancelled'; recipient: string; itemCount: number; attempts: number; createdAt: string; updatedAt: string; lastError: string | null }
export interface EventRecord { id: number; kind: string; actorType: 'member' | 'client' | 'system'; actorName: string; itemId: string | null; itemTitle: string | null; detail: Record<string, unknown>; at: string }
export interface RequestDetail extends Omit<RequestSummary, 'counts' | 'hasActiveLink'> {
  contactName: string; contactEmail: string | null; today: string; templateId: string | null; templateName: string | null; leadId: string | null; leadExists: boolean
  clientInstructions: string; internalNote: string; cancelReason: string | null; activatedAt: string | null; completedAt: string | null; cancelledAt: string | null
  reminders: { intervalDays: number | null; max: number; scheduled: number; nextAt: string | null; blockedBy: ReminderBlock; history: ReminderRecord[] }
  items: RequestItem[]; links: LinkInfo[]; events: EventRecord[]; handoff: { id: string; handedOffAt: string; note: string; requestVersion: number; handedOffBy: string } | null
}
export type RequestChanges = Partial<{ title: string; clientName: string; contactName: string; contactEmail: string; serviceType: ServiceType; ownerId: string | null; startDate: string | null; targetKickoffDate: string | null; dueDate: string | null; leadId: string | null; clientInstructions: string; internalNote: string; reminderIntervalDays: number | null; reminderMax: number }>

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
async function call<T>(name: string, args: Record<string, unknown>, valid: (value: unknown) => boolean = () => true): Promise<T> {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) throw failure(error)
  if (!valid(data)) throw new Error('Unexpected response from LeadFlow. Reload the page and try again.')
  return data as T
}
export const conflict = (cause: unknown) => cause instanceof RequestError && cause.code === '40001'
// A workspace ID only selects a workspace: the database checks the caller's membership and role on every call.
export const loadOverview = (workspace: string) => call<Overview>('onboarding_overview_for', { target_workspace: workspace }, value => isObject(value) && Array.isArray(value.requests) && Array.isArray(value.templates) && Array.isArray(value.members))
export const loadRequest = (workspace: string, request: string) => call<RequestDetail>('onboarding_request_for', { target_workspace: workspace, target_request: request }, value => isObject(value) && Array.isArray(value.items) && Array.isArray(value.events) && isObject(value.readiness))
export const loadTemplate = (workspace: string, template: string) => call<Template>('onboarding_template_for', { target_workspace: workspace, target_template: template }, value => isObject(value) && Array.isArray(value.items))
export const installStarterTemplates = (workspace: string) => call<number>('install_starter_templates', { target_workspace: workspace })
/** Without an ID, creates a template; retrying with the same request ID returns the same one. */
export const saveTemplate = (workspace: string, definition: Omit<Template, 'id' | 'version' | 'archived' | 'starterKey'> & { id?: string }, expectedVersion: number | null, requestId: string | null) =>
  call<{ id: string; version: number }>('save_onboarding_template', { target_workspace: workspace, definition, expected_version: expectedVersion, request_id: requestId })
export const setTemplateArchived = (workspace: string, template: string, archive: boolean) => call<void>('set_onboarding_template_archived', { target_workspace: workspace, target_template: template, archive })
/** Retrying with the same request ID returns the request the first attempt created. */
export const createRequest = (workspace: string, details: RequestChanges & { title: string; clientName: string; templateId?: string | null }, requestId: string) =>
  call<string>('create_onboarding_request', { target_workspace: workspace, details, request_id: requestId }, value => typeof value === 'string')
export const updateRequest = (workspace: string, request: string, changes: RequestChanges, version: number) => call<number>('update_onboarding_request', { target_workspace: workspace, target_request: request, changes, expected_version: version })
export const saveItem = (workspace: string, request: string, item: ItemDefinition, version: number) => call<string>('save_onboarding_item', { target_workspace: workspace, target_request: request, item, expected_version: version })
export const removeItem = (workspace: string, request: string, item: string, version: number) => call<void>('remove_onboarding_item', { target_workspace: workspace, target_request: request, target_item: item, expected_version: version })
export const setStatus = (workspace: string, request: string, transition: 'activate' | 'pause' | 'resume' | 'cancel', version: number, reason?: string) =>
  call<{ status: RequestStatus; version: number }>('set_onboarding_status', { target_workspace: workspace, target_request: request, transition, expected_version: version, reason: reason ?? null })
export type Decision = 'accept' | 'request_changes' | 'not_required' | 'restore'
export const reviewItem = (workspace: string, request: string, item: string, decision: Decision, note: string, revision: number) =>
  call<{ state: ItemState; revision: number }>('review_onboarding_item', { target_workspace: workspace, target_request: request, target_item: item, decision, review_note: note, expected_revision: revision })
/** The token is returned once. LeadFlow stores only its SHA-256 hash, so it cannot be shown again. */
export const issueLink = (workspace: string, request: string, days: number, replaceExisting: boolean) =>
  call<{ linkId: string; token: string; expiresAt: string }>('issue_onboarding_link', { target_workspace: workspace, target_request: request, expires_in_days: days, replace_existing: replaceExisting }, value => isObject(value) && typeof value.token === 'string')
export const revokeLinks = (workspace: string, request: string, link: string | null = null) => call<number>('revoke_onboarding_links', { target_workspace: workspace, target_request: request, target_link: link })
export const handOff = (workspace: string, request: string, note: string) => call<{ id: string; handedOffAt: string; repeated: boolean }>('hand_off_onboarding', { target_workspace: workspace, target_request: request, note })
/** The token travels in the URL fragment, which browsers never send to servers or in Referer headers. */
export const portalLink = (token: string) => `${window.location.origin}/client-portal#${token}`

export function nextAction(request: Pick<RequestSummary, 'status' | 'readiness' | 'hasActiveLink' | 'counts'>): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
  if (request.status === 'draft') return 'Review the checklist, then open it to the client'
  if (request.status === 'paused') return 'Resume when the client can continue'
  if (request.status === 'completed') return 'Handed off to delivery'
  if (request.status === 'cancelled') return 'No action: cancelled'
  if (request.readiness.requirementsMet) return 'Confirm readiness and hand off'
  if (!request.hasActiveLink) return 'Create a client link and share it'
  if (request.counts.awaitingReview) return `Review ${plural(request.counts.awaitingReview, 'submitted item')}`
  return `Waiting on client: ${plural(request.counts.requiredOutstanding, 'required item')}`
}
const fieldLabels: Record<string, string> = { title: 'project name', clientName: 'client', contactName: 'contact', contactEmail: 'contact email', serviceType: 'service', ownerId: 'owner', startDate: 'start date', targetKickoffDate: 'target kickoff', dueDate: 'inputs due date', leadId: 'linked lead', clientInstructions: 'client instructions', internalNote: 'internal note', reminderIntervalDays: 'reminder interval', reminderMax: 'reminder limit' }
/** One sentence per activity event, for the timeline. */
export function describeEvent(event: EventRecord): string {
  const d = event.detail, item = event.itemTitle ? `“${event.itemTitle}”` : 'an item', text = (key: string) => typeof d[key] === 'string' ? d[key] as string : ''
  switch (event.kind) {
    case 'created': return `Created${text('template') ? ` from “${text('template')}”` : ' from a blank checklist'}`
    case 'details_updated': return `Updated ${Array.isArray(d.fields) ? d.fields.map(field => fieldLabels[String(field)] ?? String(field)).join(', ') : 'details'}`
    case 'reminders_updated': return 'Changed the reminder settings'
    case 'item_added': return `Added ${text('title') ? `“${text('title')}”` : 'an item'}`
    case 'item_updated': return `Edited ${text('title') ? `“${text('title')}”` : 'an item'}${d.requiredChanged ? (d.required ? ' (now required)' : ' (now optional)') : ''}`
    case 'item_removed': return `Removed “${text('title')}”`
    case 'activated': return 'Opened the request to the client'
    case 'paused': return `Paused the request${text('reason') ? `: ${text('reason')}` : ''}`
    case 'resumed': return 'Resumed the request'
    case 'cancelled': return `Cancelled the request${text('reason') ? `: ${text('reason')}` : ''}`
    case 'link_issued': return `Created a client link${Number(d.replacedLinks) ? ` and revoked ${d.replacedLinks} earlier link${d.replacedLinks === 1 ? '' : 's'}` : ''}`
    case 'links_revoked': return `Revoked ${d.count} client link${d.count === 1 ? '' : 's'}`
    case 'submitted': return `Submitted ${item}`
    case 'resubmitted': return `Resubmitted ${item}`
    case 'accepted': return `Accepted ${item}${d.withoutSubmission ? ' without a client submission' : ''}${text('comment') ? `: ${text('comment')}` : ''}`
    case 'changes_requested': return `Requested changes to ${item}: ${text('comment')}`
    case 'marked_not_required': return `Marked ${item} not required: ${text('comment')}`
    case 'restored': return `Restored ${item}`
    case 'became_ready': return 'Every required item is resolved: ready for handoff'
    case 'readiness_lost': return 'No longer ready: a required item was reopened'
    case 'handed_off': return 'Confirmed readiness and handed off to delivery'
    case 'reminder_queued': return `Reminder ${d.sequence} queued for ${d.items} outstanding item${d.items === 1 ? '' : 's'}`
    case 'reminder_sent': return `Reminder ${d.sequence} accepted by the email provider (not a delivery confirmation)`
    case 'reminder_failed': return `Reminder ${d.sequence} was refused by the email provider${text('error') ? ` (${text('error')})` : ''}`
    case 'reminder_stopped': return `Reminder ${d.sequence} stopped before sending: ${text('reason').replace(/^Stopped: /, '')}`
    case 'reminder_skipped': return `Reminder not sent: ${text('reason')}`
    case 'reminder_uncertain': return `Reminder ${d.sequence}: outcome unknown after 23 hours. Check the email provider before resending.`
    default: return event.kind.replaceAll('_', ' ')
  }
}
export const reminderBlockText: Record<Exclude<ReminderBlock, null>, string> = {
  not_active: 'Reminders run only while the request is open.', disabled: 'Reminders are off.', no_email: 'Add a contact email to send reminders.',
  max_reached: 'The reminder limit has been reached.', nothing_outstanding: 'Nothing is waiting on the client.', no_link: 'Create a client link to send reminders; they include a private link.',
}
