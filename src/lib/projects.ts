import { supabase } from './supabase'
import { failure, RequestError } from './backend'
import { putSignedFile, openDownload, storageUrl } from './portal'
import type { DocumentCategory } from './onboardingOptions'
import type { ClientDocument } from './clients'
import type { WorkStatus } from './model'
export { workStatuses, type WorkStatus } from './model'

// M11: projects and delivery. Every call goes through a role-checked database function; a workspace ID only selects the
// workspace, and the database checks the caller's membership on every call. Project tasks are the workspace's follow-up
// tasks (src/lib/model.ts), saved with the workspace snapshot.
export const projectStatuses = ['planning', 'not_started', 'in_progress', 'on_hold', 'at_risk', 'completed', 'cancelled'] as const
export type ProjectStatus = typeof projectStatuses[number]
export const projectStatusLabels: Record<ProjectStatus, string> = { planning: 'Planning', not_started: 'Not started', in_progress: 'In progress', on_hold: 'On hold', at_risk: 'At risk', completed: 'Completed', cancelled: 'Cancelled' }
export const healthStates = ['on_track', 'at_risk', 'delayed', 'on_hold', 'completed', 'cancelled'] as const
export type HealthState = typeof healthStates[number]
export const healthLabels: Record<HealthState, string> = { on_track: 'On track', at_risk: 'At risk', delayed: 'Delayed', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' }
export const projectTypes = ['website', 'marketing', 'seo', 'social', 'paid_ads', 'email', 'automation', 'software', 'chatbot', 'crm', 'other'] as const
export type ProjectType = typeof projectTypes[number]
export const projectTypeLabels: Record<ProjectType, string> = { website: 'Website', marketing: 'Digital marketing', seo: 'SEO', social: 'Social media', paid_ads: 'Paid advertising', email: 'Email marketing', automation: 'Automation', software: 'Custom software', chatbot: 'AI chatbot', crm: 'CRM', other: 'Other' }
export const projectPriorities = ['low', 'medium', 'high', 'critical'] as const
export type ProjectPriority = typeof projectPriorities[number]
export const projectPriorityLabels: Record<ProjectPriority, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' }
export const milestoneStatuses = ['upcoming', 'in_progress', 'completed', 'delayed', 'cancelled'] as const
export type MilestoneStatus = typeof milestoneStatuses[number]
export const milestoneStatusLabels: Record<MilestoneStatus, string> = { upcoming: 'Upcoming', in_progress: 'In progress', completed: 'Completed', delayed: 'Delayed', cancelled: 'Cancelled' }
export const deliverableStatuses = ['not_started', 'in_progress', 'internal_review', 'ready_for_review', 'completed', 'blocked'] as const
export type DeliverableStatus = typeof deliverableStatuses[number]
export const deliverableStatusLabels: Record<DeliverableStatus, string> = { not_started: 'Not started', in_progress: 'In progress', internal_review: 'Internal review', ready_for_review: 'Ready for client review', completed: 'Completed', blocked: 'Blocked' }
export const workStatusLabels: Record<WorkStatus | 'completed', string> = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', completed: 'Completed' }
export const briefFields = ['objectives', 'scopeSummary', 'successCriteria', 'expectations', 'dependencies', 'constraints', 'assumptions', 'exclusions', 'notes'] as const
export type BriefField = typeof briefFields[number]
export const briefLabels: Record<BriefField, string> = { objectives: 'Objectives', scopeSummary: 'Scope summary', successCriteria: 'Success criteria', expectations: 'Client expectations', dependencies: 'Dependencies', constraints: 'Constraints', assumptions: 'Assumptions', exclusions: 'Exclusions', notes: 'Notes and open questions' }
export type Brief = Partial<Record<BriefField, string>>
export const timelineGroups = ['project', 'planning', 'tasks', 'files', 'notes'] as const
export type ProjectTimelineGroup = typeof timelineGroups[number]
export const timelineGroupLabels: Record<ProjectTimelineGroup, string> = { project: 'Project', planning: 'Milestones & deliverables', tasks: 'Tasks', files: 'Files', notes: 'Notes' }

/** From recorded completion only: deliverables when the project has any, otherwise tasks (see docs/PROJECTS.md). */
export interface Progress {
  basis: 'deliverables' | 'tasks' | 'none'; percent: number
  tasks: { total: number; completed: number; overdue: number; blocked: number }
  deliverables: { total: number; completed: number; overdue: number; blocked: number }
  milestones: { total: number; completed: number; overdue: number }
}
export interface HealthReason { level: 'delayed' | 'at_risk'; code: string; count: number; text: string }
/** Computed from documented rules; never an AI judgment. */
export interface Health { state: HealthState; reasons: HealthReason[] }
export interface ProjectSummary {
  id: string; name: string; clientId: string; clientName: string; clientStatus: string; projectType: ProjectType; status: ProjectStatus; priority: ProjectPriority
  ownerId: string | null; ownerName: string | null; startDate: string | null; targetDate: string | null; completedOn: string | null; tags: string[]; source: 'onboarding' | 'client' | 'manual'
  agreedValue: number | null; currency: string; version: number; createdAt: string; updatedAt: string; overdue: boolean; progress: Progress; health: Health
  nextDeadline: { kind: 'project' | 'milestone' | 'deliverable'; title: string; date: string } | null
}
export interface ProjectPage { items: ProjectSummary[]; total: number; limit: number; offset: number; today: string }
export interface ProjectFilters { search?: string; status?: ProjectStatus | 'open' | 'all'; health?: HealthState | ''; clientId?: string; ownerId?: string; priority?: ProjectPriority | ''; projectType?: ProjectType | ''; sort?: 'updated' | 'name' | 'target' | 'created'; direction?: 'asc' | 'desc'; limit?: number; offset?: number }
export interface ProjectIndexEntry { id: string; name: string; clientId: string; status: ProjectStatus }
export interface Milestone {
  id: string; position: number; name: string; description: string; startDate: string | null; dueDate: string | null; status: MilestoneStatus; completedAt: string | null; notes: string
  dependsOn: string[]; version: number; createdAt: string; updatedAt: string; overdue: boolean; tasks: { total: number; completed: number }; deliverables: { total: number; completed: number }
}
export interface Deliverable {
  id: string; position: number; milestoneId: string | null; title: string; description: string; ownerId: string | null; ownerName: string | null; dueDate: string | null; priority: ProjectPriority
  status: DeliverableStatus; notes: string; clientServiceId: string | null; serviceName: string | null; completedAt: string | null; version: number; createdAt: string; updatedAt: string; overdue: boolean
  tasks: { total: number; completed: number }; files: number
}
export interface ProjectDetail extends ProjectSummary {
  today: string; canManageTemplates: boolean; description: string; brief: Brief; briefSources: Record<string, unknown>; internalNotes: string; estimatedCost: number | null; actualCost: number | null
  statusReason: string; statusChangedAt: string; template: { id: string | null; name: string } | null; completion: { id: string; completedAt: string } | null
  deal: { id: string; title: string; value: number | null; wonValue: number | null; currency: string; outcome: string } | null
  contacts: { id: string; fullName: string; role: string; email: string; phone: string; isPrimary: boolean; linked: boolean }[]
  services: { id: string; name: string; status: string; agreedScope: string; deliverables: string; linked: boolean }[]
  milestones: Milestone[]; deliverables: Deliverable[]; documentCount: number; members: { id: string; name: string }[]
}
export interface Deadline { kind: 'project' | 'milestone' | 'deliverable'; id: string; title: string; date: string; projectId: string; projectName: string }
export interface ProjectsDashboard {
  today: string; total: number; byStatus: Partial<Record<ProjectStatus, number>>; active: number; planning: number; onHold: number; completed: number; atRisk: number; delayed: number; onTrack: number
  overdue: number; overdueTasks: number; upcoming: Deadline[]; attention: { projectId: string; name: string; health: HealthState; reasons: HealthReason[] }[]
  recent: { id: number; kind: string; summary: string; at: string; projectId: string; projectName: string; actorName: string | null }[]
}
export interface CalendarItem {
  kind: 'project' | 'milestone' | 'deliverable' | 'task'; id: string; title: string; date: string; projectId: string; projectName: string; clientId: string; clientName: string
  status: string; priority: string | null; done: boolean; assigneeId: string | null; overdue: boolean
}
export interface ProjectEvent { id: string; group: ProjectTimelineGroup; kind: string; summary: string; detail: Record<string, unknown>; at: string; actorType: 'member' | 'client' | 'system'; actorName: string | null; entityType: string | null; entityId: string | null }
export interface TemplateSummary { id: string; name: string; description: string; projectType: ProjectType; starterKey: string | null; archived: boolean; version: number; updatedAt: string; milestoneCount: number; deliverableCount: number; taskCount: number; durationDays: number; projects: number }
export interface TemplateMilestone { id?: string; name: string; description: string; startOffsetDays: number; durationDays: number; deliverables: { title: string; description: string }[]; tasks: { title: string; durationDays: number; priority: 'low' | 'medium' | 'high' }[] }
export interface ProjectTemplate { id: string; name: string; description: string; projectType: ProjectType; starterKey: string | null; archived: boolean; version: number; milestones: TemplateMilestone[] }
/**
 * A plan to review before it becomes project records: milestones, deliverables and tasks linked by their own "ref"
 * (or by the ID of an existing milestone or deliverable). Templates and approved AI suggestions both produce one.
 */
export interface PlanMilestone { ref: string; name: string; description?: string; startDate?: string | null; dueDate?: string | null; dependsOn?: string[] }
export interface PlanDeliverable { ref?: string; milestoneRef?: string; milestoneId?: string; title: string; description?: string; dueDate?: string | null; priority?: ProjectPriority; clientServiceId?: string | null }
export interface PlanTask { ref?: string; milestoneRef?: string; milestoneId?: string; deliverableRef?: string; deliverableId?: string; title: string; description?: string; startDate?: string | null; dueDate?: string | null; priority?: ProjectPriority; estimateHours?: number | null; labels?: string[]; dependsOn?: string[] }
export interface Plan { milestones: PlanMilestone[]; deliverables: PlanDeliverable[]; tasks: PlanTask[] }
export interface ProjectSetup {
  today: string; client: { id: string; name: string; status: string; website: string; industry: string; ownerId: string | null }; source: 'onboarding' | 'client'
  completion: { id: string; completedAt: string; note: string; overrideReason: string | null } | null
  deal: { id: string; title: string; value: number | null; wonValue: number | null; currency: string } | null
  contacts: { id: string; fullName: string; role: string; email: string; isPrimary: boolean }[]
  services: { id: string; name: string; description: string; agreedScope: string; deliverables: string; exclusions: string; notes: string; current: boolean }[]
  requirements: { id: string; title: string; description: string; category: string; priority: string; service: string | null }[]
  outstandingQuestions: string; documents: { id: string; fileName: string; category: DocumentCategory; size: number; uploaderType: 'member' | 'client' }[]
  dates: { label: string; date: string }[]; brief: Brief; existingProjects: { id: string; name: string; status: ProjectStatus }[]; members: { id: string; name: string }[]
}
export interface ProjectInput {
  name: string; description?: string; projectType?: ProjectType; priority?: ProjectPriority; ownerId?: string | null; startDate?: string | null; targetDate?: string | null
  agreedValue?: number | string | null; estimatedCost?: number | string | null; actualCost?: number | string | null; currency?: string; tags?: string[]; brief?: Brief; internalNotes?: string
  serviceIds?: string[]; contactIds?: string[]
}
export interface MilestoneInput { id?: string; name: string; description: string; startDate: string | null; dueDate: string | null; status: MilestoneStatus; notes: string; dependsOn: string[] }
export interface DeliverableInput { id?: string; title: string; description: string; milestoneId: string | null; ownerId: string | null; dueDate: string | null; priority: ProjectPriority; status: DeliverableStatus; notes: string; clientServiceId: string | null }
export type ProjectDocument = ClientDocument & { projectId: string | null; projectName: string | null; milestoneId: string | null; deliverableId: string | null; taskId: string | null }
export type AiOperation = 'plan' | 'breakdown' | 'summary' | 'risks'
/** M12 client-collaboration assistance: suggestions for the agency only, never sent or applied automatically. */
export type CollabAiOperation = 'feedback_summary' | 'response_draft' | 'review_prep' | 'discussion_summary'
/** A suggested point and the recorded facts (F1, F2…) it is based on. */
export interface AiPoint { text: string; basedOn: string[] }
/** A suggestion, with the recorded project data it is based on. Nothing becomes a record until a person approves it. */
export interface AiResult {
  operation: AiOperation | CollabAiOperation; generatedAt: string; model: string | null
  /** The recorded data the answer is based on; risks cite these by id. */
  facts: { id: string; label: string; value: string }[]
  summary?: { overview: string; completed: string[]; outstanding: string[]; blockers: string[]; upcoming: string[] }
  risks?: { title: string; detail: string; basedOn: string[]; suggestion: string; severity: 'low' | 'medium' | 'high' }[]
  plan?: Plan & { notes: string[] }
  /** M12: client feedback grouped into actionable points. */
  feedbackSummary?: { overview: string; groups: { category: 'content' | 'design' | 'functional' | 'technical' | 'clarification'; points: AiPoint[] }[] }
  /** M12: a suggested reply to one feedback item; a person edits and sends it. */
  responseDraft?: { body: string; basedOn: string[] }
  /** M12: what changed in the latest version, and which feedback it addresses. */
  reviewPrep?: { changed: AiPoint[]; addressed: AiPoint[]; unresolved: AiPoint[] }
  /** M12: a long discussion in short, with its open questions. */
  discussionSummary?: { overview: string; decisions: AiPoint[]; openQuestions: AiPoint[] }
  warnings: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
async function call<T>(name: string, args: Record<string, unknown>, valid: (value: unknown) => boolean = () => true): Promise<T> {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) throw failure(error)
  if (!valid(data)) throw new Error('Unexpected response from LeadFlow. Reload the page and try again.')
  return data as T
}
export const conflict = (cause: unknown) => cause instanceof RequestError && cause.code === '40001'
const ws = (workspace: string) => ({ target_workspace: workspace })

export const projectSetup = (workspace: string, client: string) => call<ProjectSetup>('project_setup_for', { ...ws(workspace), target_client: client }, value => isObject(value) && isObject(value.client))
/**
 * Creates the project, its links and (optionally) a reviewed plan in one transaction. Retrying with the same request ID
 * returns the same project. When tasks were added, workspaceChanged is true: reload the workspace snapshot.
 */
export const createProject = (workspace: string, details: ProjectInput & { clientId: string; source: 'onboarding' | 'client' | 'manual'; completionId?: string | null; templateId?: string | null; briefSources?: Record<string, unknown>; plan?: Plan }, requestId: string) =>
  call<{ id: string; existing: boolean; tasks: number; workspaceChanged: boolean }>('create_project', { ...ws(workspace), details, request_id: requestId }, isObject)
/** Adds an approved plan (template, AI suggestions or a task breakdown) to a project. Idempotent per request ID. */
export const applyPlan = (workspace: string, project: string, plan: Plan, origin: 'template' | 'assistant' | 'breakdown', requestId: string) =>
  call<{ milestones: number; deliverables: number; tasks: number; workspaceChanged: boolean; repeated: boolean }>('apply_project_plan', { ...ws(workspace), target_project: project, plan, origin, request_id: requestId }, isObject)
export const updateProject = (workspace: string, project: string, version: number, changes: Partial<ProjectInput>) => call<ProjectSummary>('update_project', { ...ws(workspace), target_project: project, expected_version: version, changes }, isObject)
/** Completing with open work and cancelling need a reason; nothing completes on its own. */
export const setProjectStatus = (workspace: string, project: string, status: ProjectStatus, version: number, reason: string) =>
  call<ProjectSummary>('set_project_status', { ...ws(workspace), target_project: project, next_status: status, expected_version: version, reason }, isObject)
export const addProjectNote = (workspace: string, project: string, note: string, requestId: string) => call<{ id: number; repeated: boolean }>('add_project_note', { ...ws(workspace), target_project: project, note, request_id: requestId })
export const projectIndex = (workspace: string) => call<ProjectIndexEntry[]>('project_index_for', ws(workspace), Array.isArray)
export const listProjects = (workspace: string, filters: ProjectFilters) => call<ProjectPage>('projects_for', { ...ws(workspace), filters }, value => isObject(value) && Array.isArray(value.items))
export const loadProject = (workspace: string, project: string) => call<ProjectDetail>('project_detail', { ...ws(workspace), target_project: project }, value => isObject(value) && Array.isArray(value.milestones))
export const projectsDashboard = (workspace: string) => call<ProjectsDashboard>('projects_dashboard_for', ws(workspace), isObject)
/** before is the last event already shown; the next page starts right after it. */
export const projectTimeline = (workspace: string, project: string, groups: ProjectTimelineGroup[], before: Pick<ProjectEvent, 'at' | 'id'> | null, pageSize = 50) =>
  call<{ items: ProjectEvent[]; hasMore: boolean }>('project_timeline', { ...ws(workspace), target_project: project, groups, before_at: before?.at ?? null, before_id: before?.id ?? null, page_size: pageSize }, value => isObject(value) && Array.isArray(value.items))
export const entityHistory = (workspace: string, project: string, kind: 'milestone' | 'deliverable', entity: string) =>
  call<{ id: number; kind: string; summary: string; detail: Record<string, unknown>; at: string; actorName: string | null }[]>('project_entity_history', { ...ws(workspace), target_project: project, entity_kind: kind, target_entity: entity }, Array.isArray)
/** Deadlines between two dates (at most 400 days apart). */
export const projectCalendar = (workspace: string, from: string, to: string, filters: { clientId?: string; projectId?: string; state?: 'open' | 'done' | 'all'; kinds?: CalendarItem['kind'][] } = {}) =>
  call<{ today: string; items: CalendarItem[] }>('project_calendar_for', { ...ws(workspace), from_date: from, to_date: to, filters }, value => isObject(value) && Array.isArray(value.items))
export const saveMilestone = (workspace: string, project: string, milestone: MilestoneInput, expectedVersion: number | null) =>
  call<{ id: string; version: number }>('save_project_milestone', { ...ws(workspace), target_project: project, milestone, expected_version: expectedVersion }, isObject)
export const reorderMilestones = (workspace: string, project: string, ids: string[]) => call<void>('reorder_project_milestones', { ...ws(workspace), target_project: project, milestone_ids: ids })
/** Its deliverables and tasks stay, without a milestone. workspaceChanged: reload the workspace snapshot. */
export const removeMilestone = (workspace: string, project: string, milestone: string) => call<{ workspaceChanged: boolean }>('remove_project_milestone', { ...ws(workspace), target_project: project, target_milestone: milestone }, isObject)
export const saveDeliverable = (workspace: string, project: string, deliverable: DeliverableInput, expectedVersion: number | null, requestId: string | null) =>
  call<{ id: string; version: number; repeated: boolean }>('save_project_deliverable', { ...ws(workspace), target_project: project, deliverable, expected_version: expectedVersion, request_id: requestId }, isObject)
export const removeDeliverable = (workspace: string, project: string, deliverable: string) => call<{ workspaceChanged: boolean }>('remove_project_deliverable', { ...ws(workspace), target_project: project, target_deliverable: deliverable }, isObject)
export const loadTemplates = (workspace: string) => call<{ canEdit: boolean; templates: TemplateSummary[] }>('project_templates_for', ws(workspace), value => isObject(value) && Array.isArray(value.templates))
export const loadTemplate = (workspace: string, template: string) => call<ProjectTemplate>('project_template_for', { ...ws(workspace), target_template: template }, value => isObject(value) && Array.isArray(value.milestones))
/** Owners and admins. Without an ID, creates a template; retrying with the same request ID returns the same one. */
export const saveTemplate = (workspace: string, definition: { id?: string; name: string; description: string; projectType: ProjectType; milestones: TemplateMilestone[] }, expectedVersion: number | null, requestId: string | null) =>
  call<{ id: string; version: number }>('save_project_template', { ...ws(workspace), definition, expected_version: expectedVersion, request_id: requestId }, isObject)
export const setTemplateArchived = (workspace: string, template: string, archive: boolean) => call<void>('set_project_template_archived', { ...ws(workspace), target_template: template, archive })
export const saveProjectAsTemplate = (workspace: string, project: string, name: string, requestId: string) => call<{ id: string; version: number }>('save_project_as_template', { ...ws(workspace), target_project: project, template_name: name, request_id: requestId }, isObject)
/** A template turned into a dated plan from the start date, to review before it is applied. */
export const templatePlan = (workspace: string, template: string, startDate: string | null) =>
  call<Plan & { startDate: string; targetDate: string | null }>('project_template_plan', { ...ws(workspace), target_template: template, start_date: startDate }, value => isObject(value) && Array.isArray(value.milestones))
export const projectDocuments = (workspace: string, project: string) => call<{ project: ProjectDocument[]; client: ProjectDocument[] }>('project_documents_for', { ...ws(workspace), target_project: project }, value => isObject(value) && Array.isArray(value.project))

// Project files use M10's client-files Edge Function and private storage. The database checks that the project (and its
// milestone, deliverable or task) belongs to the client; project files are always internal.
class FunctionError extends Error { status: number; code: string; constructor(message: string, status: number, code = '') { super(message); this.status = status; this.code = code } }
export { FunctionError as AssistantError }
const functionUrl = (name: string) => { const url = import.meta.env.VITE_SUPABASE_URL; return url ? `${new URL(url).origin}/functions/v1/${name}` : '' }
async function invoke<T>(name: string, workspaceId: string, body: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
  const { data } = await supabase!.auth.getSession()
  const token = data.session?.access_token, url = functionUrl(name)
  if (!token || !url) throw new FunctionError('Your session has expired. Sign in again.', 401)
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '' },
      body: JSON.stringify({ workspaceId, ...body }), signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) { throw new FunctionError((cause as Error).name === 'TimeoutError' ? 'This is taking longer than expected. Try again.' : 'We couldn’t reach LeadFlow. Check your connection and try again.', 0) }
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new FunctionError(typeof result.error === 'string' ? result.error : 'This isn’t available right now.', response.status, typeof result.code === 'string' ? result.code : '')
  return result as T
}
export interface ProjectFileTarget { clientId: string; projectId: string; milestoneId?: string | null; deliverableId?: string | null; taskId?: string | null
  /** M12 attachments: a draft version's files, one of your own comments, or a draft update. */
  versionId?: string | null; commentId?: string | null; updateId?: string | null }
/** Prepare (the database checks access, type and size), send straight to Storage, then the upload check. */
export async function uploadProjectFile(workspace: string, target: ProjectFileTarget, file: File, details: { category: DocumentCategory; description: string; visibility?: 'internal' | 'shared' }, onProgress?: (fraction: number) => void): Promise<ProjectDocument> {
  const prepared = await invoke<{ document: { id: string; mimeType: string }; uploadUrl: string }>('client-files', workspace, { action: 'upload', clientId: target.clientId, projectId: target.projectId,
    milestoneId: target.milestoneId ?? null, deliverableId: target.deliverableId ?? null, taskId: target.taskId ?? null, versionId: target.versionId ?? null, commentId: target.commentId ?? null,
    updateId: target.updateId ?? null, fileName: file.name, size: file.size, visibility: 'internal', ...details })
  try { await putSignedFile(prepared.uploadUrl, file, prepared.document.mimeType, onProgress) }
  catch (cause) { throw new FunctionError(cause instanceof Error ? cause.message : 'The upload didn’t finish. Try again.', 0) }
  return (await invoke<{ document: ProjectDocument }>('client-files', workspace, { action: 'finish', documentId: prepared.document.id })).document
}
/** Images and PDFs open in a new tab from a link that expires after a minute; other files download. */
export const previewable = (document: Pick<ClientDocument, 'mimeType'>) => /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(document.mimeType)
export async function previewProjectFile(workspace: string, document: string) {
  const result = await invoke<{ url: string }>('client-files', workspace, { action: 'preview', documentId: document })
  window.open(storageUrl(result.url), '_blank', 'noopener,noreferrer')
}
export const downloadProjectFile = (workspace: string, document: string) => invoke<{ url: string }>('client-files', workspace, { action: 'download', documentId: document }).then(result => openDownload(result.url))
export const deleteProjectFile = (workspace: string, document: string) => invoke<{ ok: true }>('client-files', workspace, { action: 'delete', documentId: document })

// The AI assistant (project-assistant Edge Function): suggestions only, based on the project's recorded data. A plan or
// breakdown becomes records only through applyPlan, after a person reviews and edits it.
export const assistantConfig = (workspace: string) => invoke<{ configured: boolean; model: string | null; monthlyLimit: number }>('project-assistant', workspace, { action: 'config' }, 15000)
export const askAssistant = (workspace: string, project: string, operation: AiOperation | CollabAiOperation, options: { deliverableId?: string; feedbackId?: string; templateId?: string | null; instructions?: string } = {}) =>
  invoke<AiResult>('project-assistant', workspace, { action: operation, projectId: project, ...options }, 120000)

/** One line per project event, for timelines. */
export const projectEventText = (event: Pick<ProjectEvent, 'summary'>) => event.summary
/** The progress basis in words, e.g. "3 of 5 deliverables completed". */
export function progressText(progress: Progress): string {
  if (progress.basis === 'deliverables') return `${progress.deliverables.completed} of ${progress.deliverables.total} deliverable${progress.deliverables.total === 1 ? '' : 's'} completed`
  if (progress.basis === 'tasks') return `${progress.tasks.completed} of ${progress.tasks.total} task${progress.tasks.total === 1 ? '' : 's'} completed`
  return 'No deliverables or tasks yet'
}
