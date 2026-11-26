import { supabase } from './supabase'
import { failure } from './backend'
import { openDownload, putSignedFile, storageUrl } from './portal'
import type { ClientRole, Comment, DeliverableCard, Decision, Feedback, FeedbackCategory, ProjectUpdate, Review, ReviewStatus, SharedFile, Version } from './collaboration'
export type { ClientRole, Comment, DeliverableCard, Decision, Feedback, FeedbackCategory, ProjectUpdate, Review, ReviewStatus, SharedFile, Version } from './collaboration'

// M12 client portal API. Client people sign in with their own Supabase Auth account; every hub_ function checks their
// active access, project access, role and what the agency shared. Nothing here trusts an ID the browser sends.

export interface HubAccount { accessId: string; clientId: string; clientName: string; agencyName: string; role: ClientRole; name: string; email: string }
export interface HubProjectCard {
  id: string; name: string; category: string; status: 'planning' | 'not_started' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled'; progress: number
  startDate: string | null; targetDate: string | null; completedOn: string | null; sharedAt: string | null
  nextMilestone: { id: string; name: string; dueDate: string | null } | null; awaitingReview: number
}
export interface HubMilestone { id: string; name: string; description: string; startDate: string | null; dueDate: string | null; status: 'upcoming' | 'in_progress' | 'completed'; completedAt: string | null }
export interface HubProject extends HubProjectCard {
  summary: string; objectives: string[]; contact: { name: string; email: string } | null; services: string[]
  milestones: HubMilestone[]; deliverables: DeliverableCard[]; updates: ProjectUpdate[]
  accessId: string; role: ClientRole; canUpload: boolean; agencyName: string
}
export interface HubDeliverable extends DeliverableCard {
  projectId: string; projectName: string; role: ClientRole; accessId: string
  versions: Version[]; reviews: Review[]; feedback: Feedback[]; canDecide: boolean; canGiveFeedback: boolean
}
export interface AwaitingItem { reviewId: string; deliverableId: string; title: string; projectId: string; projectName: string; versionNumber: number; dueDate: string | null; requestedAt: string; canDecide: boolean }
export interface UpcomingItem { kind: 'milestone' | 'deliverable'; id: string; title: string; projectId: string; projectName: string; dueDate: string }
export interface HubHome {
  access: { id: string; name: string; email: string; role: ClientRole }; client: { id: string; name: string }; agencyName: string
  projects: HubProjectCard[]; awaiting: AwaitingItem[]; upcoming: UpcomingItem[]; updates: ProjectUpdate[]; messages: Comment[]; files: SharedFile[]; unread: number
}
export interface HubNotification { id: number; event: string; title: string; body: string; link: string; projectId: string | null; deliverableId: string | null; createdAt: string; readAt: string | null }
export interface HubSettings {
  accessId: string; name: string; email: string; role: ClientRole; projectAccess: 'all' | 'selected'; emailEvents: string[]; events: string[]
  client: { name: string; website: string }; agencyName: string
}
export interface InvitationStatus {
  status: 'valid' | 'invalid' | 'expired' | 'revoked' | 'accepted'
  email?: string; name?: string; role?: ClientRole; expiresAt?: string; clientName?: string; agencyName?: string; accountExists?: boolean
}
export const hubProjectStatusLabels: Record<HubProjectCard['status'], string> = { planning: 'Planning', not_started: 'Not started', in_progress: 'In progress', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' }
export const hubMilestoneStatusLabels: Record<HubMilestone['status'], string> = { upcoming: 'Upcoming', in_progress: 'In progress', completed: 'Completed' }
/** Review states as the client reads them. */
export const hubReviewLabels: Record<ReviewStatus, string> = { not_shared: 'Not shared', shared: 'Shared with you', awaiting_review: 'Awaiting your review', changes_requested: 'Changes requested',
  resubmitted: 'Revised: awaiting your review', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Review withdrawn' }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
async function call<T>(name: string, args: Record<string, unknown>, valid: (value: unknown) => boolean = () => true): Promise<T> {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) throw failure(error)
  if (!valid(data)) throw new Error('Unexpected response. Reload the page and try again.')
  return data as T
}

export const hubAccounts = () => call<HubAccount[]>('hub_accounts', {}, Array.isArray)
export const hubHome = (access: string) => call<HubHome>('hub_home', { target_access: access }, value => isObject(value) && Array.isArray(value.projects))
export const hubProject = (project: string) => call<HubProject>('hub_project', { target_project: project }, value => isObject(value) && Array.isArray(value.milestones))
/** Opening a deliverable with an open review records the first view (the agency sees it). */
export const hubDeliverable = (deliverable: string) => call<HubDeliverable>('hub_deliverable', { target_deliverable: deliverable }, value => isObject(value) && Array.isArray(value.versions))
export const hubDecide = (review: string, details: { decision: Decision; comment: string; feedback: { title: string; body: string; category: FeedbackCategory }[] }, requestId: string) =>
  call<HubDeliverable>('hub_decide', { target_review: review, details, request_id: requestId }, isObject)
export const hubAddFeedback = (deliverable: string, details: { title: string; body: string; category: FeedbackCategory; versionId?: string }, requestId: string) =>
  call<Feedback>('hub_add_feedback', { target_deliverable: deliverable, details, request_id: requestId }, isObject)
export const hubComments = (project: string, scope: { deliverableId?: string; feedbackId?: string } = {}) => call<Comment[]>('hub_comments', { target_project: project, scope }, Array.isArray)
export const hubAddComment = (project: string, details: { body: string; deliverableId?: string | null; feedbackId?: string | null; parentId?: string | null }, requestId: string) =>
  call<Comment>('hub_add_comment', { target_project: project, details, request_id: requestId }, isObject)
export const hubEditComment = (comment: string, body: string) => call<Comment>('hub_edit_comment', { target_comment: comment, body }, isObject)
export const hubDeleteComment = (comment: string) => call<Comment>('hub_delete_comment', { target_comment: comment }, isObject)
export const hubFiles = (access: string, project: string | null = null) => call<SharedFile[]>('hub_files', { target_access: access, target_project: project }, Array.isArray)
export const hubNotifications = (access: string, onlyUnread = false) =>
  call<{ items: HubNotification[]; unread: number }>('hub_notifications', { target_access: access, only_unread: onlyUnread }, value => isObject(value) && Array.isArray(value.items))
export const hubMarkNotifications = (access: string, ids: number[] | null) => call<number>('hub_mark_notifications', { target_access: access, ids })
export const hubSettings = (access: string) => call<HubSettings>('hub_settings', { target_access: access }, isObject)
export const hubSaveSettings = (access: string, details: { name?: string; emailEvents?: string[] }) => call<HubSettings>('hub_save_settings', { target_access: access, details }, isObject)

// ---------- Invitations and files (client-hub Edge Function) ----------

export class HubError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status } }
const hubUrl = () => { const url = import.meta.env.VITE_SUPABASE_URL; return url ? `${new URL(url).origin}/functions/v1/client-hub` : '' }
async function hub<T>(body: Record<string, unknown>, signedIn: boolean, timeoutMs = 30000): Promise<T> {
  const url = hubUrl()
  if (!url) throw new HubError('The client portal isn’t connected yet.', 503)
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '' }
  if (signedIn) {
    const { data } = await supabase!.auth.getSession()
    if (!data.session) throw new HubError('Your session has expired. Sign in again.', 401)
    headers.Authorization = `Bearer ${data.session.access_token}`
  }
  let response: Response
  try { response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(timeoutMs) }) }
  catch (cause) { throw new HubError((cause as Error).name === 'TimeoutError' ? 'This is taking longer than expected. Try again.' : 'We couldn’t connect. Check your connection and try again.', 0) }
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new HubError(typeof result.error === 'string' ? result.error : 'This isn’t available right now.', response.status)
  return result as T
}

/** What an invitation link is for, before signing in. */
export const invitationStatus = (token: string) => hub<InvitationStatus>({ action: 'invitation', token }, false)
/** Creates the account for the invited address and activates access; then sign in with the same email and password. */
export const activateInvitation = (token: string, details: { name: string; password: string }) => hub<{ email: string }>({ action: 'activate', token, ...details }, false)
/** An existing account (signed in) accepts with the token's hash; the token itself never leaves the browser. */
export async function acceptInvitation(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const keyHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return call<{ accessId: string; clientId: string; alreadyAccepted: boolean }>('hub_accept_invitation', { key_hash: keyHash }, isObject)
}
export const hubFileConfig = () => hub<{ maxBytes: number; extensions: string[] }>({ action: 'config' }, true)
/** Uploads a project file, or an attachment to the caller's own feedback or comment. */
export async function hubUpload(projectId: string, file: File, details: { category?: string; description?: string; feedbackId?: string; commentId?: string } = {}, onProgress?: (fraction: number) => void) {
  const prepared = await hub<{ document: { id: string; mimeType: string }; uploadUrl: string }>({ action: 'upload', projectId, fileName: file.name, size: file.size, ...details }, true)
  try { await putSignedFile(prepared.uploadUrl, file, prepared.document.mimeType, onProgress) }
  catch (cause) { throw new HubError(cause instanceof Error ? cause.message : 'The upload didn’t finish. Try again.', 0) }
  return (await hub<{ document: { id: string; status: string } }>({ action: 'finish', documentId: prepared.document.id }, true)).document
}
export const hubDownload = (documentId: string) => hub<{ url: string }>({ action: 'download', documentId }, true).then(result => openDownload(result.url))
/** Images and PDFs open in a new tab from a link that expires after a minute. */
export async function hubPreview(documentId: string) {
  const result = await hub<{ url: string }>({ action: 'preview', documentId }, true)
  window.open(storageUrl(result.url), '_blank', 'noopener,noreferrer')
}
export const hubRemoveFile = (documentId: string) => hub<{ ok: true }>({ action: 'remove', documentId }, true)
export const previewableFile = (file: Pick<SharedFile, 'mimeType'>) => /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(file.mimeType)
