import { supabase } from './supabase'
import { failure, RequestError } from './backend'
import { AssistantError, type ProjectDocument } from './projects'

// M12: client collaboration and approvals, agency side. Every call goes through a role-checked database function; the
// workspace ID only selects the workspace. Client people use the portal API in ./hub.ts, never these functions.

export const clientRoles = ['admin', 'member', 'reviewer'] as const
export type ClientRole = typeof clientRoles[number]
export const clientRoleLabels: Record<ClientRole, string> = { admin: 'Client admin', member: 'Client member', reviewer: 'Client reviewer' }
export const clientRoleHelp: Record<ClientRole, string> = {
  admin: 'Every shared project. Gives feedback, approves or rejects, comments and uploads files.',
  member: 'Chosen or all shared projects. Comments, gives feedback and uploads files; can’t approve.',
  reviewer: 'Chosen or all shared projects. Gives feedback and approves or rejects; attaches files to feedback only.',
}
export const reviewStatuses = ['not_shared', 'shared', 'awaiting_review', 'changes_requested', 'resubmitted', 'approved', 'rejected', 'withdrawn'] as const
export type ReviewStatus = typeof reviewStatuses[number]
export const reviewStatusLabels: Record<ReviewStatus, string> = { not_shared: 'Not shared', shared: 'Shared', awaiting_review: 'Awaiting client review',
  changes_requested: 'Changes requested', resubmitted: 'Resubmitted', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' }
export const feedbackCategories = ['design', 'content', 'functional', 'technical', 'general'] as const
export type FeedbackCategory = typeof feedbackCategories[number]
export const feedbackCategoryLabels: Record<FeedbackCategory, string> = { design: 'Design change', content: 'Content change', functional: 'Functional issue', technical: 'Technical issue', general: 'General feedback' }
export const feedbackStatuses = ['open', 'acknowledged', 'clarification_requested', 'addressed', 'declined'] as const
export type FeedbackStatus = typeof feedbackStatuses[number]
export const feedbackStatusLabels: Record<FeedbackStatus, string> = { open: 'Open', acknowledged: 'Acknowledged', clarification_requested: 'Question for the client', addressed: 'Addressed', declined: 'Won’t change' }
export type Decision = 'approved' | 'changes_requested' | 'rejected'
export const decisionLabels: Record<Decision, string> = { approved: 'Approved', changes_requested: 'Changes requested', rejected: 'Rejected' }
export type CommentVisibility = 'internal' | 'client'

/** Client notification events (email can be turned off per event in the portal settings). */
export const clientEventLabels: Record<string, string> = { project_shared: 'A project is shared with me', milestone_shared: 'A milestone is added', review_requested: 'Something is ready for my review',
  review_resubmitted: 'A revised version is ready', feedback_reply: 'The agency replies to my feedback', comment_added: 'New messages', update_published: 'Project updates', file_shared: 'New shared files' }
/** Agency notification events (email can be turned off per event under Settings). */
export const memberEventLabels: Record<string, string> = { client_activated: 'A client person activates their portal access', feedback_submitted: 'A client gives feedback',
  changes_requested: 'A client requests changes', deliverable_approved: 'A client approves a deliverable', deliverable_rejected: 'A client rejects a deliverable',
  client_commented: 'A client sends a message', client_file_uploaded: 'A client uploads a file' }

/** A file as the client sees it (no storage path, no agency emails). */
export interface SharedFile {
  id: string; fileName: string; extension: string; mimeType: string; size: number; category: string; description: string; createdAt: string
  projectId: string | null; deliverableId: string | null; versionId: string | null; commentId: string | null; feedbackId: string | null; updateId: string | null
  uploadedBy: string; fromClient: boolean; projectName?: string | null; deliverableTitle?: string | null; versionNumber?: number | null
  /** The client person who uploaded it in the portal (their access ID), so the portal can offer removal of their own uploads. */
  uploaderAccessId?: string | null
}
export interface Version<F = SharedFile> { id: string; deliverableId: string; number: number; notes: string; createdAt: string; publishedAt: string | null; createdBy: string; files: F[] }
export interface DecisionRecord { id: string; reviewId: string; versionId: string; versionNumber: number; decision: Decision; comment: string; reviewer: string; createdAt: string }
export interface Review {
  id: string; deliverableId: string; versionId: string; versionNumber: number; message: string; dueDate: string | null
  status: 'open' | 'changes_requested' | 'approved' | 'rejected' | 'withdrawn'; createdAt: string; closedAt: string | null; reviewerIds: string[]; reviewers: string[]; requestedBy: string
  decision: DecisionRecord | null
  /** Agency only. */
  firstViewedAt?: string | null; firstViewedBy?: string | null; withdrawnReason?: string
}
export interface Feedback<F = SharedFile> {
  id: string; deliverableId: string; versionId: string; versionNumber: number; reviewId: string | null; title: string; body: string; category: FeedbackCategory
  status: FeedbackStatus; statusNote: string; addressedInVersion: number | null; author: string; authorAccessId: string | null; createdAt: string; updatedAt: string; files: F[]
}
export interface Comment<F = SharedFile> {
  id: string; projectId: string; deliverableId: string | null; feedbackId: string | null; versionId: string | null; parentId: string | null
  authorType: 'member' | 'client'; visibility: CommentVisibility; author: string; memberId: string | null; authorAccessId: string | null
  body: string; deleted: boolean; createdAt: string; editedAt: string | null; deletedAt: string | null; files: F[]
  /** Agency only: how many earlier texts are kept. */
  revisions?: number; projectName?: string
}
export interface ProjectUpdate<F = SharedFile> {
  id: string; projectId: string; title: string; body: string; status: 'draft' | 'published'; publishedAt: string | null; correctedAt: string | null; author: string; files: F[]
  /** Agency only. */
  version?: number; createdAt?: string; updatedAt?: string; revisions?: number; projectName?: string
}
/** A deliverable as the client sees it (the agency's preview uses the same shape). */
export interface DeliverableCard {
  id: string; title: string; description: string; dueDate: string | null; reviewStatus: ReviewStatus; milestoneId: string | null; completed: boolean; sharedAt: string | null
  latestVersion: number | null; openReview: { id: string; dueDate: string | null; versionNumber: number } | null
}

// ---------- Agency types ----------
export interface PortalPerson {
  id: string; clientId: string; email: string; name: string; role: ClientRole; projectAccess: 'all' | 'selected'; projectIds: string[]
  status: 'active' | 'revoked'; activatedAt: string; revokedAt: string | null; lastSeenAt: string | null; version: number; canOpen?: boolean
}
export interface Invitation {
  id: string; clientId: string; email: string; name: string; role: ClientRole; projectAccess: 'all' | 'selected'; projectIds: string[]
  status: 'pending' | 'expired' | 'accepted' | 'revoked'; expiresAt: string; createdAt: string; rotatedAt: string | null; acceptedAt: string | null; revokedAt: string | null
  invitedBy: string; emailStatus: null | 'pending' | 'sending' | 'accepted' | 'failed' | 'uncertain' | 'cancelled'
}
export interface PortalAccess { people: PortalPerson[]; invitations: Invitation[]; projects: { id: string; name: string; shared: boolean; status: string }[] }
export interface InviteInput { email: string; name: string; role: ClientRole; projectAccess: 'all' | 'selected'; projectIds: string[]; sendEmail: boolean }
export interface CollabDeliverableRow {
  id: string; title: string; status: string; dueDate: string | null; clientVisible: boolean; reviewStatus: ReviewStatus; milestoneId: string | null
  latestVersion: { id: string; number: number; published: boolean } | null; openReview: Review | null; lastDecision: DecisionRecord | null; openFeedback: number
}
export interface ProjectCollab {
  portal: { shared: boolean; sharedAt: string | null; summary: string; objectives: string[]; contactName: string; contactEmail: string; version: number; clientId: string; clientArchived: boolean }
  people: PortalPerson[]; pendingInvitations: number
  milestones: { id: string; name: string; status: string; dueDate: string | null; clientVisible: boolean }[]
  deliverables: CollabDeliverableRow[]
  updates: ProjectUpdate<ProjectDocument>[]; clientFiles: ProjectDocument[]; unreadClientComments: number
  history: { id: number; kind: string; summary: string; at: string; actorType: 'member' | 'client' | 'system'; actor: string }[]
}
export interface DeliverableCollab {
  id: string; projectId: string; title: string; description: string; status: string; clientVisible: boolean; reviewStatus: ReviewStatus; sharedAt: string | null; dueDate: string | null
  versions: Version<ProjectDocument>[]; reviews: Review[]; feedback: Feedback<ProjectDocument>[]; comments: Comment<ProjectDocument>[]; preview: DeliverableCard
}
export interface PortalPreview {
  id: string; name: string; category: string; status: string; progress: number; startDate: string | null; targetDate: string | null; completedOn: string | null
  sharedAt: string | null; nextMilestone: { id: string; name: string; dueDate: string | null } | null; awaitingReview: number
  summary: string; objectives: string[]; contact: { name: string; email: string } | null; services: string[]
  milestones: { id: string; name: string; description: string; startDate: string | null; dueDate: string | null; status: string; completedAt: string | null }[]
  deliverables: DeliverableCard[]; updates: ProjectUpdate[]; clientName: string; agencyName: string
}
export interface QueueItem {
  id: string; title: string; projectId: string; projectName: string; clientId: string; clientName: string; reviewStatus: ReviewStatus; status: string; ownerId: string | null
  openReview: { id: string; dueDate: string | null; createdAt: string; firstViewedAt: string | null; versionNumber: number } | null
  lastDecision: DecisionRecord | null; openFeedback: number; updatedAt: string
}
export interface CollabQueue { deliverables: QueueItem[]; conversations: { projectId: string; projectName: string; clientName: string; unread: number; lastAt: string }[] }
export interface MemberNotification { id: number; event: string; title: string; body: string; projectId: string | null; deliverableId: string | null; createdAt: string; readAt: string | null }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
async function call<T>(name: string, args: Record<string, unknown>, valid: (value: unknown) => boolean = () => true): Promise<T> {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) throw failure(error)
  if (!valid(data)) throw new Error('Unexpected response from LeadFlow. Reload the page and try again.')
  return data as T
}
export const conflict = (cause: unknown) => cause instanceof RequestError && cause.code === '40001'
const ws = (workspace: string) => ({ target_workspace: workspace })

// Access (owners and admins change it; every member can see it).
export const portalAccess = (workspace: string, client: string) => call<PortalAccess>('client_portal_access_for', { ...ws(workspace), target_client: client }, value => isObject(value) && Array.isArray(value.people))
/** The token is returned once: show the link now (or let the queued email carry it). A repeated request returns token null. */
export const inviteClientUser = (workspace: string, client: string, details: InviteInput, requestId: string) =>
  call<{ invitation: Invitation; token: string | null; replayed?: boolean }>('invite_client_user', { ...ws(workspace), target_client: client, details, request_id: requestId }, isObject)
export const renewInvitation = (workspace: string, invitation: string, sendEmail: boolean) =>
  call<{ invitation: Invitation; token: string }>('renew_client_invitation', { ...ws(workspace), target_invitation: invitation, send_email: sendEmail }, isObject)
export const revokeInvitation = (workspace: string, invitation: string) => call<Invitation>('revoke_client_invitation', { ...ws(workspace), target_invitation: invitation }, isObject)
export const updatePortalPerson = (workspace: string, person: string, changes: Partial<Pick<PortalPerson, 'role' | 'projectAccess' | 'projectIds' | 'name'>>, expectedVersion: number | null) =>
  call<PortalPerson>('update_client_user', { ...ws(workspace), target_access: person, changes, expected_version: expectedVersion }, isObject)
export const setPortalPersonActive = (workspace: string, person: string, active: boolean) => call<PortalPerson>('set_client_user_active', { ...ws(workspace), target_access: person, active }, isObject)
/** The address a client person opens to accept an invitation. The token stays in the fragment, so it never reaches a server log. */
export const invitationLink = (token: string) => `${window.location.origin}/portal/invite#${token}`

// What the client sees.
export const projectCollab = (workspace: string, project: string) => call<ProjectCollab>('project_collab_for', { ...ws(workspace), target_project: project }, value => isObject(value) && isObject(value.portal))
export const setProjectPortal = (workspace: string, project: string, settings: Partial<{ shared: boolean; summary: string; objectives: string[]; contactName: string; contactEmail: string }>, expectedVersion: number | null) =>
  call<{ version: number; shared: boolean; sharedAt: string | null }>('set_project_portal', { ...ws(workspace), target_project: project, settings, expected_version: expectedVersion }, isObject)
export const setClientVisibility = (workspace: string, kind: 'milestone' | 'deliverable', id: string, visible: boolean) =>
  call<{ id: string; clientVisible: boolean; reviewStatus?: ReviewStatus }>('set_client_visibility', { ...ws(workspace), target_kind: kind, target_id: id, visible }, isObject)
export const portalPreview = (workspace: string, project: string) => call<PortalPreview>('project_portal_preview', { ...ws(workspace), target_project: project }, value => isObject(value) && Array.isArray(value.deliverables))

// Versions and reviews.
export const deliverableCollab = (workspace: string, deliverable: string) =>
  call<DeliverableCollab>('deliverable_collab_for', { ...ws(workspace), target_deliverable: deliverable }, value => isObject(value) && Array.isArray(value.versions))
/** The deliverable's draft version (created if there is none). Add files to it with uploadCollabFile({ versionId }). */
export const createVersion = (workspace: string, deliverable: string, notes = '') => call<Version<ProjectDocument>>('create_deliverable_version', { ...ws(workspace), target_deliverable: deliverable, notes }, isObject)
export const updateVersionNotes = (workspace: string, version: string, notes: string) => call<Version<ProjectDocument>>('update_deliverable_version', { ...ws(workspace), target_version: version, notes }, isObject)
export const discardVersion = (workspace: string, version: string) => call<void>('discard_deliverable_version', { ...ws(workspace), target_version: version })
export const requestReview = (workspace: string, deliverable: string, details: { versionId: string; message: string; dueDate: string | null; reviewerIds: string[] }, requestId: string) =>
  call<DeliverableCollab>('request_deliverable_review', { ...ws(workspace), target_deliverable: deliverable, details, request_id: requestId }, isObject)
export const publishVersion = (workspace: string, version: string) => call<DeliverableCollab>('publish_deliverable_version', { ...ws(workspace), target_version: version }, isObject)
export const withdrawReview = (workspace: string, review: string, reason: string) => call<DeliverableCollab>('withdraw_deliverable_review', { ...ws(workspace), target_review: review, reason }, isObject)
export const setFeedbackStatus = (workspace: string, feedback: string, details: { status: FeedbackStatus; note?: string; addressedInVersion?: string | null }) =>
  call<Feedback<ProjectDocument>>('set_feedback_status', { ...ws(workspace), target_feedback: feedback, details }, isObject)
export const collabQueue = (workspace: string) => call<CollabQueue>('collab_queue_for', ws(workspace), value => isObject(value) && Array.isArray(value.deliverables))

// Comments: internal unless marked visible to the client.
export const projectComments = (workspace: string, project: string, scope: { deliverableId?: string; feedbackId?: string } = {}) =>
  call<Comment<ProjectDocument>[]>('project_comments_for', { ...ws(workspace), target_project: project, scope }, Array.isArray)
export const addComment = (workspace: string, project: string, details: { body: string; visibility: CommentVisibility; deliverableId?: string | null; feedbackId?: string | null; versionId?: string | null; parentId?: string | null }, requestId: string) =>
  call<Comment<ProjectDocument>>('add_project_comment', { ...ws(workspace), target_project: project, details, request_id: requestId }, isObject)
export const editComment = (workspace: string, comment: string, body: string) => call<Comment<ProjectDocument>>('edit_project_comment', { ...ws(workspace), target_comment: comment, body }, isObject)
export const deleteComment = (workspace: string, comment: string) => call<Comment<ProjectDocument>>('delete_project_comment', { ...ws(workspace), target_comment: comment }, isObject)
export const commentHistory = (workspace: string, comment: string) =>
  call<{ body: string; action: 'edited' | 'deleted'; at: string; by: string }[]>('project_comment_history', { ...ws(workspace), target_comment: comment }, Array.isArray)
export const markDiscussionRead = (workspace: string, project: string) => call<void>('mark_project_discussion_read', { ...ws(workspace), target_project: project })

// Published updates.
export const saveUpdate = (workspace: string, project: string, update: string | null, details: { title: string; body: string }, expectedVersion: number | null, requestId: string | null) =>
  call<ProjectUpdate<ProjectDocument>>('save_project_update', { ...ws(workspace), target_project: project, target_update: update, details, expected_version: expectedVersion, request_id: requestId }, isObject)
export const publishUpdate = (workspace: string, update: string) => call<ProjectUpdate<ProjectDocument>>('publish_project_update', { ...ws(workspace), target_update: update }, isObject)
export const deleteUpdate = (workspace: string, update: string) => call<void>('delete_project_update', { ...ws(workspace), target_update: update })

// Notifications about client activity.
export const memberNotifications = (workspace: string, onlyUnread = false) =>
  call<{ items: MemberNotification[]; unread: number }>('member_notifications_for', { ...ws(workspace), only_unread: onlyUnread }, value => isObject(value) && Array.isArray(value.items))
export const markMemberNotifications = (workspace: string, ids: number[] | null) => call<number>('mark_member_notifications', { ...ws(workspace), ids })
export const memberNotificationSettings = (workspace: string) => call<{ emailEvents: string[]; events: string[] }>('member_notification_settings', ws(workspace), isObject)
export const saveMemberNotificationSettings = (workspace: string, events: string[]) =>
  call<{ emailEvents: string[]; events: string[] }>('save_member_notification_settings', { ...ws(workspace), email_events: events }, isObject)

/** Attachments for a draft version, one of your own comments, or a draft update (client-files checks them). */
export interface CollabFileTarget { clientId: string; projectId: string; versionId?: string; commentId?: string; updateId?: string; deliverableId?: string }
/** A project document as the agency sees it, with the M12 attachment links. */
export type CollabDocument = ProjectDocument & { versionId?: string | null; commentId?: string | null; feedbackId?: string | null; updateId?: string | null; fromPortal?: boolean }
/** "Mar 2, 2026, 2:05 PM" in the viewer's own time zone. */
export const collabTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
/** A failed AI request in words; nothing was changed by it. */
export const assistantMessage = (cause: unknown) => cause instanceof AssistantError && cause.code === 'not_configured'
  ? 'AI assistance isn’t set up for this workspace. An administrator adds a Gemini API key to the Edge Function secrets.'
  : `${cause instanceof Error ? cause.message : 'Something went wrong.'} Nothing was changed.`
