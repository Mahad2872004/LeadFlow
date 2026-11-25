import { supabase } from './supabase'
import { failure, RequestError } from './backend'
import { putSignedFile, openDownload } from './portal'
import type { DocumentCategory, ServiceType } from './onboardingOptions'
import type { Readiness, StageProgress } from './onboarding'
export { documentCategories, documentCategoryLabels, formatBytes, type DocumentCategory } from './onboardingOptions'

// M10: clients, the records a won deal becomes. Every call goes through a role-checked database function; a workspace ID
// only selects the workspace, and the database checks the caller's membership on every call.
export const clientStatuses = ['onboarding', 'active', 'paused', 'completed', 'archived'] as const
export type ClientStatus = typeof clientStatuses[number]
export const clientStatusLabels: Record<ClientStatus, string> = { onboarding: 'Onboarding', active: 'Active', paused: 'Paused', completed: 'Completed', archived: 'Archived' }
export const onboardingStates = ['not_started', 'in_progress', 'ready', 'paused', 'completed'] as const
export type OnboardingState = typeof onboardingStates[number]
export const onboardingStateLabels: Record<OnboardingState, string> = { not_started: 'Not started', in_progress: 'In progress', ready: 'Ready to complete', paused: 'Paused', completed: 'Onboarded' }
export const contactRoles = ['decision_maker', 'project', 'billing', 'technical', 'marketing', 'operations', 'other'] as const
export type ClientContactRole = typeof contactRoles[number]
export const contactRoleLabels: Record<ClientContactRole, string> = { decision_maker: 'Decision-maker', project: 'Project contact', billing: 'Billing contact', technical: 'Technical contact', marketing: 'Marketing contact', operations: 'Operations contact', other: 'Other' }
export const preferredChannels = ['email', 'phone', 'whatsapp', 'video', 'any'] as const
export type PreferredChannel = typeof preferredChannels[number]
export const channelLabels: Record<PreferredChannel, string> = { email: 'Email', phone: 'Phone', whatsapp: 'WhatsApp', video: 'Video call', any: 'No preference' }
export const serviceStatusLabels = { proposed: 'Proposed', confirmed: 'Confirmed', removed: 'Removed' } as const
export type ServiceStatus = keyof typeof serviceStatusLabels
export const requirementCategories = ['objective', 'goal', 'functional', 'technical', 'design', 'integration', 'constraint', 'dependency', 'assumption', 'expectation', 'success_criteria'] as const
export type RequirementCategory = typeof requirementCategories[number]
export const requirementCategoryLabels: Record<RequirementCategory, string> = { objective: 'Business objective', goal: 'Project goal', functional: 'Functional requirement', technical: 'Technical requirement', design: 'Design requirement', integration: 'Integration', constraint: 'Constraint', dependency: 'Dependency', assumption: 'Assumption', expectation: 'Client expectation', success_criteria: 'Success criteria' }
export const requirementStatuses = ['draft', 'under_review', 'confirmed', 'deferred', 'rejected'] as const
export type RequirementStatus = typeof requirementStatuses[number]
export const requirementStatusLabels: Record<RequirementStatus, string> = { draft: 'Draft', under_review: 'Under review', confirmed: 'Confirmed', deferred: 'Deferred', rejected: 'Rejected' }
export const requirementPriorities = ['low', 'medium', 'high', 'critical'] as const
export type RequirementPriority = typeof requirementPriorities[number]
export const requirementSources = ['client_form', 'client_meeting', 'deal', 'internal', 'other'] as const
export type RequirementSource = typeof requirementSources[number]
export const requirementSourceLabels: Record<RequirementSource, string> = { client_form: 'Client form', client_meeting: 'Client meeting', deal: 'Sales deal', internal: 'Internal', other: 'Other' }
export const welcomeChannels = ['email', 'whatsapp', 'phone', 'meeting', 'other'] as const
export type WelcomeChannel = typeof welcomeChannels[number]
export const welcomeChannelLabels: Record<WelcomeChannel, string> = { email: 'Email', whatsapp: 'WhatsApp', phone: 'Phone call', meeting: 'Meeting', other: 'Other' }
export const timelineGroups = ['client', 'onboarding', 'scope', 'documents', 'tasks', 'notes'] as const
export type ClientTimelineGroup = typeof timelineGroups[number]
export const timelineGroupLabels: Record<ClientTimelineGroup, string> = { client: 'Client', onboarding: 'Onboarding', scope: 'Services & scope', documents: 'Documents', tasks: 'Tasks', notes: 'Notes' }

/** Computed by the database from the client's onboarding requests and completion. Separate from the client's status. */
export interface ClientOnboarding { state: OnboardingState; requests: number; requiredTotal: number; resolved: number; percent: number; waitingOnClient: number; awaitingReview: number; agencySteps: number }
export interface ClientSummary {
  id: string; name: string; logoUrl: string; website: string; industry: string; city: string; country: string; status: ClientStatus; ownerId: string | null; ownerName: string | null
  leadId: string | null; dealId: string | null; version: number; createdAt: string; updatedAt: string; convertedAt: string | null
  primaryContact: { id: string; name: string; email: string; phone: string } | null; contactCount: number; services: string[]; onboarding: ClientOnboarding
  scopeConfirmedAt: string | null; completedAt: string | null; openTasks: number
}
export interface ClientPage { items: ClientSummary[]; total: number; limit: number; offset: number; industries: string[] }
export interface ClientFilters { search?: string; status?: ClientStatus | 'current' | 'all'; onboarding?: OnboardingState | ''; industry?: string; ownerId?: string; templateId?: string; createdFrom?: string; createdTo?: string; sort?: 'name' | 'created' | 'updated'; direction?: 'asc' | 'desc'; limit?: number; offset?: number }
export interface ClientIndexEntry { id: string; name: string; status: ClientStatus; leadId: string | null; dealId: string | null }
export interface ClientContact { id: string; fullName: string; jobTitle: string; role: ClientContactRole; email: string; phone: string; preferredChannel: PreferredChannel; notes: string; isPrimary: boolean; sourceContactId: string | null; updatedAt: string }
export interface ClientService { id: string; serviceId: string | null; name: string; description: string; agreedScope: string; deliverables: string; exclusions: string; notes: string; status: ServiceStatus; source: 'deal' | 'manual' | 'onboarding'; version: number; confirmedAt: string | null; updatedAt: string }
export interface Requirement {
  id: string; title: string; description: string; category: RequirementCategory; priority: RequirementPriority; status: RequirementStatus; source: RequirementSource
  sourceRequestId: string | null; sourceItemId: string | null; clientServiceId: string | null; notes: string; version: number; confirmedAt: string | null; createdAt: string; updatedAt: string
}
export interface ScopeSnapshot {
  services: { id: string; name: string; description: string; agreedScope: string; deliverables: string; exclusions: string }[]
  requirements: { id: string; title: string; description: string; category: RequirementCategory; priority: RequirementPriority; service: string | null }[]
  dependencies: { title: string; description: string; category: string }[]; expectations: { title: string; description: string; category: string }[]
  exclusions: { service: string; text: string }[]; undecided: number
}
export interface ScopeConfirmation { id: string; sequence: number; snapshot: ScopeSnapshot; outstandingQuestions: string; notes: string; sharedWithClient?: boolean; confirmedAt: string; confirmedBy: string | null; clientAcknowledgedAt: string | null; changedSince?: boolean; supersededAt?: string | null }
export interface ClientRequest { id: string; title: string; status: 'draft' | 'active' | 'paused' | 'completed' | 'cancelled'; serviceType: ServiceType; templateName: string | null; version: number; dueDate: string | null; targetKickoffDate: string | null; createdAt: string; readiness: Readiness; stages: StageProgress[]; hasActiveLink: boolean }
export interface Completion { id: string; completedAt: string; note: string; overrideReason: string | null; outstanding: CompletionItem[]; completedBy: string | null }
export interface ClientDetail extends ClientSummary {
  description: string; address: string; region: string; postcode: string; timezone: string; internalNotes: string; importantDates: { label: string; date: string }[]
  previousStatus: ClientStatus | null; statusChangedAt: string | null; conversion: Record<string, unknown> | null; convertedBy: string | null
  welcome: { subject: string; body: string; updatedAt: string | null; sentAt: string | null; channel: WelcomeChannel | null; sentBy: string | null }
  lead: { id: string; name: string; company: string; status: string } | null
  deal: { id: string; title: string; outcome: string; value: number | null; wonValue: number | null; currency: string; actualCloseDate: string | null; opportunityTitle: string; serviceName: string; notes: string } | null
  contacts: ClientContact[]; serviceRecords: ClientService[]; requirements: Requirement[]; scope: ScopeConfirmation | null; scopeHistory: number; requests: ClientRequest[]
  documentCount: number; completion: Completion | null; members: { id: string; name: string }[]
}
export interface ClientDocument {
  id: string; clientId: string | null; requestId: string | null; itemId: string | null; fileName: string; extension: string; mimeType: string; size: number; category: DocumentCategory
  description: string; visibility: 'internal' | 'shared'; status: 'pending' | 'available' | 'rejected' | 'deleted'; rejectedReason: string | null; uploaderType: 'member' | 'client'
  uploadedBy: string | null; stageId: string | null; createdAt: string; verifiedAt: string | null; itemTitle: string | null
}
export interface TimelineEvent { id: string; group: ClientTimelineGroup; source: 'client' | 'onboarding' | 'task'; kind: string; summary: string | null; detail: Record<string, unknown>; at: string; actorType: 'member' | 'client' | 'system'; actorName: string | null; requestTitle: string | null; itemTitle: string | null }
export interface CompletionItem { key: 'contact' | 'services' | 'requirements' | 'scope' | 'onboarding'; label: string; met: boolean; detail: string }
export interface Dashboard {
  totalClients: number; byStatus: Partial<Record<ClientStatus, number>>; byOnboarding: Partial<Record<OnboardingState, number>>; onboarding: number; completedOnboarding: number
  pendingSubmissions: number; waitingOnClient: number; overdueTasks: number; dueTodayTasks: number; awaitingScope: number
  recentlyOnboarded: { clientId: string; name: string; completedAt: string; override: boolean }[]
  attention: { clientId: string; name: string; onboarding: ClientOnboarding; status: ClientStatus }[]
}
export interface Handoff { id: string; clientId: string; completedAt: string; note: string; overrideReason: string | null; outstanding: CompletionItem[]; snapshot: Record<string, unknown> }
export interface ContactInput { id?: string; fullName: string; jobTitle: string; role: ClientContactRole; email: string; phone: string; preferredChannel: PreferredChannel; notes: string; isPrimary: boolean; sourceContactId?: string | null }
export interface ServiceInput { id?: string; serviceId?: string | null; name: string; description: string; agreedScope: string; deliverables: string; exclusions: string; notes: string; status?: ServiceStatus; expectedVersion?: number }
export interface RequirementInput { id?: string; title: string; description: string; category: RequirementCategory; priority: RequirementPriority; status: RequirementStatus; source: RequirementSource; sourceRequestId?: string | null; sourceItemId?: string | null; clientServiceId?: string | null; notes: string }
export type ProfileFields = Partial<{ name: string; logoUrl: string; website: string; industry: string; description: string; address: string; city: string; region: string; postcode: string; country: string; timezone: string; ownerId: string | null; internalNotes: string; importantDates: { label: string; date: string }[] }>

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
async function call<T>(name: string, args: Record<string, unknown>, valid: (value: unknown) => boolean = () => true): Promise<T> {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) throw failure(error)
  if (!valid(data)) throw new Error('Unexpected response from LeadFlow. Reload the page and try again.')
  return data as T
}
export const conflict = (cause: unknown) => cause instanceof RequestError && cause.code === '40001'
const ws = (workspace: string) => ({ target_workspace: workspace })

export const listClients = (workspace: string, filters: ClientFilters) => call<ClientPage>('clients_for', { ...ws(workspace), filters }, value => isObject(value) && Array.isArray(value.items))
export const clientIndex = (workspace: string) => call<ClientIndexEntry[]>('client_index_for', ws(workspace), Array.isArray)
export const clientDashboard = (workspace: string, filters: ClientFilters, today: string) => call<Dashboard>('client_dashboard_for', { ...ws(workspace), filters, today }, isObject)
export const loadClient = (workspace: string, client: string) => call<ClientDetail>('client_detail', { ...ws(workspace), target_client: client }, value => isObject(value) && Array.isArray(value.contacts))
/** Retrying with the same request ID returns the client the first attempt created. */
export const createClient = (workspace: string, details: ProfileFields & { name: string; leadId?: string | null; contacts?: ContactInput[]; services?: ServiceInput[] }, requestId: string) =>
  call<{ id: string; existing: boolean }>('create_client', { ...ws(workspace), details, request_id: requestId }, isObject)
/**
 * Converts a deal into a client in one transaction: the client, its contacts and services, the deal's handoff record and
 * (optionally) its onboarding checklist. Converting the same deal again returns the existing client (existing: true).
 */
export const convertDeal = (workspace: string, deal: string, details: ProfileFields & { name: string; contacts: ContactInput[]; services: ServiceInput[]; overrideReason?: string; onboarding?: { templateId: string | null; title?: string } }, requestId: string) =>
  call<{ id: string; existing: boolean; onboardingRequestId?: string | null }>('convert_deal_to_client', { ...ws(workspace), target_deal: deal, details, request_id: requestId }, isObject)
export const startOnboarding = (workspace: string, client: string, details: { templateId?: string | null; title?: string; ownerId?: string | null; dueDate?: string | null; targetKickoffDate?: string | null }, requestId: string) =>
  call<string>('start_client_onboarding', { ...ws(workspace), target_client: client, details, request_id: requestId }, value => typeof value === 'string')
export const updateClient = (workspace: string, client: string, version: number, changes: ProfileFields) => call<ClientSummary>('update_client', { ...ws(workspace), target_client: client, expected_version: version, changes }, isObject)
/** 'unarchive' restores the status the client had before it was archived. */
export const setClientStatus = (workspace: string, client: string, status: ClientStatus | 'unarchive', version: number, reason: string) =>
  call<ClientSummary>('set_client_status', { ...ws(workspace), target_client: client, next_status: status, expected_version: version, reason }, isObject)
export const saveClientContact = (workspace: string, client: string, contact: ContactInput) => call<{ id: string }>('save_client_contact', { ...ws(workspace), target_client: client, contact })
export const deleteClientContact = (workspace: string, client: string, contact: string) => call<void>('delete_client_contact', { ...ws(workspace), target_client: client, target_contact: contact })
export const saveClientService = (workspace: string, client: string, service: ServiceInput) => call<{ id: string; version: number; status: ServiceStatus }>('save_client_service', { ...ws(workspace), target_client: client, service })
export const saveRequirement = (workspace: string, client: string, requirement: RequirementInput, expectedVersion: number | null, requestId: string | null) =>
  call<{ id: string; version: number; repeated: boolean }>('save_client_requirement', { ...ws(workspace), target_client: client, requirement, expected_version: expectedVersion, request_id: requestId })
export const requirementHistory = (workspace: string, requirement: string) =>
  call<{ version: number; snapshot: Omit<RequirementInput, 'id'>; changedAt: string; changedBy: string | null }[]>('client_requirement_history', { ...ws(workspace), target_requirement: requirement }, Array.isArray)
/** Records what was agreed. An internal record the client may acknowledge; not a contract, signature or legal acceptance. */
export const confirmScope = (workspace: string, client: string, details: { outstandingQuestions: string; notes: string; sharedWithClient: boolean }) =>
  call<{ id: string; sequence: number; confirmedAt: string }>('confirm_client_scope', { ...ws(workspace), target_client: client, details })
export const scopeHistory = (workspace: string, client: string) => call<ScopeConfirmation[]>('client_scope_history', { ...ws(workspace), target_client: client }, Array.isArray)
export const saveWelcome = (workspace: string, client: string, subject: string, body: string) => call<{ updatedAt: string }>('save_client_welcome', { ...ws(workspace), target_client: client, subject, body })
/** Records that someone sent the welcome message outside LeadFlow. LeadFlow itself sends nothing. */
export const markWelcomeSent = (workspace: string, client: string, channel: WelcomeChannel) => call<{ sentAt: string; repeated: boolean }>('mark_client_welcome_sent', { ...ws(workspace), target_client: client, channel })
export const addClientNote = (workspace: string, client: string, note: string, requestId: string) => call<{ id: number; repeated: boolean }>('add_client_note', { ...ws(workspace), target_client: client, note, request_id: requestId })
/** before is the last event already shown; the next page starts right after it. */
export const clientTimeline = (workspace: string, client: string, groups: ClientTimelineGroup[], before: Pick<TimelineEvent, 'at' | 'id'> | null, pageSize = 50) =>
  call<{ items: TimelineEvent[]; hasMore: boolean }>('client_timeline', { ...ws(workspace), target_client: client, groups, before_at: before?.at ?? null, page_size: pageSize, before_id: before?.id ?? null }, value => isObject(value) && Array.isArray(value.items))
export const completionCheck = (workspace: string, client: string) => call<{ items: CompletionItem[]; ready: boolean; completed: boolean }>('client_completion_check', { ...ws(workspace), target_client: client }, isObject)
/** Completes onboarding once. With items outstanding, only owners and admins can, with a reason that is kept. */
export const completeOnboarding = (workspace: string, client: string, note: string, overrideReason: string | null) =>
  call<{ id: string; completedAt: string; repeated: boolean }>('complete_client_onboarding', { ...ws(workspace), target_client: client, note, override_reason: overrideReason })
export const clientHandoff = (workspace: string, client: string) => call<Handoff | null>('client_handoff_for', { ...ws(workspace), target_client: client })
export const clientDocuments = (workspace: string, client: string) => call<ClientDocument[]>('client_documents_for', { ...ws(workspace), target_client: client }, Array.isArray)
export const updateDocument = (workspace: string, document: string, changes: Partial<Pick<ClientDocument, 'category' | 'description' | 'visibility'>>) =>
  call<ClientDocument>('update_client_document', { ...ws(workspace), target_document: document, changes }, isObject)

// Files go through the client-files Edge Function, which asks the database (as the signed-in member) before signing one
// Storage URL. The file itself travels straight between the browser and Storage.
export class FileRequestError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status } }
const filesEndpoint = () => { const url = import.meta.env.VITE_SUPABASE_URL; return url ? `${new URL(url).origin}/functions/v1/client-files` : '' }
async function files<T>(workspaceId: string, body: Record<string, unknown>): Promise<T> {
  const { data } = await supabase!.auth.getSession()
  const token = data.session?.access_token, url = filesEndpoint()
  if (!token || !url) throw new FileRequestError('Your session has expired. Sign in again.', 401)
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '' },
      body: JSON.stringify({ workspaceId, ...body }), signal: AbortSignal.timeout(30000) })
  } catch { throw new FileRequestError('We couldn’t reach LeadFlow. Check your connection and try again.', 0) }
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new FileRequestError(typeof result.error === 'string' ? result.error : 'Client files aren’t available right now.', response.status)
  return result as T
}
export const filesConfig = (workspace: string) => files<{ maxBytes: number; extensions: string[] }>(workspace, { action: 'config' })
/** Prepare (the database checks access, type and size), send to Storage, then the upload check. Only checked files can be downloaded. */
export async function uploadDocument(workspace: string, client: string, file: File, details: { category: DocumentCategory; description: string; visibility: 'internal' | 'shared'; requestId?: string | null }, onProgress?: (fraction: number) => void): Promise<ClientDocument> {
  const prepared = await files<{ document: { id: string; mimeType: string }; uploadUrl: string }>(workspace, { action: 'upload', clientId: client, fileName: file.name, size: file.size, ...details })
  try { await putSignedFile(prepared.uploadUrl, file, prepared.document.mimeType, onProgress) }
  catch (cause) { throw new FileRequestError(cause instanceof Error ? cause.message : 'The upload didn’t finish. Try again.', 0) }
  const finished = await files<{ document: ClientDocument }>(workspace, { action: 'finish', documentId: prepared.document.id })
  return finished.document
}
export const downloadDocument = (workspace: string, document: string) => files<{ url: string }>(workspace, { action: 'download', documentId: document }).then(result => openDownload(result.url))
/** Owners, admins, or the member who uploaded it. */
export const deleteDocument = (workspace: string, document: string) => files<{ ok: true }>(workspace, { action: 'delete', documentId: document })

/** One line per client timeline event that has no summary of its own (onboarding events). */
export function timelineText(event: TimelineEvent, describe: (kind: string, detail: Record<string, unknown>, itemTitle: string | null) => string): string {
  if (event.summary) return event.summary
  const prefix = event.requestTitle ? `${event.requestTitle}: ` : ''
  return prefix + describe(event.kind, event.detail, event.itemTitle)
}
/** A welcome message to start from; the agency edits it before sending it themselves. Nothing here is sent. */
export function welcomeDraft(client: Pick<ClientDetail, 'name' | 'contacts' | 'serviceRecords' | 'requests'>, agency: string, sender: string): { subject: string; body: string } {
  const contact = client.contacts.find(item => item.isPrimary) ?? client.contacts[0]
  const services = client.serviceRecords.filter(service => service.status === 'confirmed').map(service => service.name)
  const first = contact?.fullName.split(/\s+/)[0]
  return {
    subject: `Welcome to ${agency}, ${client.name}`,
    body: [`Hi ${first || 'there'},`, '',
      `Welcome aboard! We're excited to start working with ${client.name}${services.length ? ` on ${services.join(', ')}` : ''}.`, '',
      'Next, we will send you a short onboarding checklist: the information, assets and access we need to get started. You can save your answers and come back to it at any time.',
      'Please never send passwords by email or in the checklist; we will explain how to give us access through each platform\'s own sharing settings.', '',
      'If you have any questions, just reply to this message.', '', `Best regards,`, sender || agency].join('\n'),
  }
}
