import { supabase } from './supabase'
import { failure, RequestError } from './backend'
import { localDate } from './dates'
import { taskTypes, type Priority, type TaskType } from './model'
export { taskTypes, type Priority, type TaskType }

// M9 sales pipeline. Every function here calls a role-checked database function; the workspace ID only selects a
// workspace, and the database checks the caller's membership and role on every call.

export type StageCategory = 'open' | 'won' | 'lost'
export type StageKey = 'new' | 'qualified' | 'contacted' | 'replied' | 'interested' | 'meeting' | 'proposal' | 'negotiation' | 'won' | 'lost'
export type DealSource = 'manual' | 'lead' | 'opportunity' | 'outreach' | 'pipeline'
export interface Stage { id: string; name: string; color: string; position: number; category: StageCategory; probability: number | null; key: StageKey | null; archived: boolean; archivedAt: string | null; dealCount?: number }
export interface SalesSettings { defaultCurrency: string; currencies: string[]; lostReasons: string[]; defaultStageId: string | null; updatedAt: string }
export interface SalesMember { id: string; name: string; role: 'owner' | 'admin' | 'member' }
export interface Pipeline { stages: Stage[]; settings: SalesSettings; members: SalesMember[]; canConfigure: boolean }
export interface Deal {
  id: string; leadId: string; title: string; description: string; stageId: string; outcome: StageCategory; contactId: string | null; opportunityId: string | null
  opportunityTitle: string; opportunityType: string | null; serviceId: string | null; serviceName: string; source: DealSource; sourceDraftId: string | null
  value: number | null; currency: string; probability: number | null; effectiveProbability: number | null; expectedCloseDate: string | null; actualCloseDate: string | null
  wonValue: number | null; wonNotes: string; lostReason: string | null; lostNotes: string; priority: Priority; ownerId: string | null; ownerName: string | null; notes: string
  version: number; stageEnteredAt: string; lastActivityAt: string; closedAt: string | null; archived: boolean; createdBy: string | null; createdAt: string; updatedAt: string
  stage: { name: string; color: string; category: StageCategory; archived: boolean }
  lead: { name: string; company: string; status: string; website: string; industry: string; source: string } | null
  contact: { name: string; jobTitle: string; email: string; phone: string; whatsapp: string } | null
  nextTask: { id: string; due: string; notes: string; taskType: TaskType } | null
  nextMeeting: { id: string; startsAt: string; title: string } | null
  hasHandoff: boolean
}
export interface Meeting { id: string; title: string; startsAt: string; durationMinutes: number; timezone: string; location: string; meetingUrl: string; agenda: string; notes: string; status: MeetingStatus; contactId: string | null; version: number }
export type MeetingStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show'
export interface DealDetail extends Deal {
  leadExists: boolean
  opportunity: { id: string; title: string; opportunityType: string; why: string; benefit: string; priority: string; confidence: string; status: string; analysisId: string; findingCount: number; findings: { id: string; title: string; findingType: string; confidence: string }[] } | null
  contacts: { id: string; kind: 'person' | 'business'; name: string; jobTitle: string; email: string; emailStatus: string; phone: string; whatsapp: string; isPreferred: boolean }[]
  stageHistory: { from: string | null; to: string; toCategory: StageCategory; movedAt: string; movedBy: string | null }[]
  meetings: Meeting[]
  drafts: { id: string; channel: string; subject: string; status: string; contactId: string | null; contactName: string; sentAt: string | null; repliedAt: string | null; sequenceStep: number; updatedAt: string }[]
  handoff: { id: string; createdAt: string; note: string } | null
  otherDeals: { id: string; title: string; outcome: StageCategory }[]
}
export type TimelineGroup = 'activity' | 'stage' | 'task' | 'meeting' | 'outreach' | 'lead'
export interface TimelineItem { id: string; group: TimelineGroup; kind: string; summary: string; details: string; metadata: Record<string, unknown>; at: string; actorName: string | null; contactName: string | null }
export interface CurrencyTotal { currency: string; value: number; weighted: number; count: number }
export interface BoardColumn extends Stage { count: number; totals: CurrencyTotal[]; deals: Deal[] }
export interface DealFilters { outcome?: 'all' | StageCategory; stageId?: string; ownerId?: string; leadId?: string; priority?: Priority | ''; search?: string; closingBefore?: string; includeArchived?: boolean; sort?: 'updated' | 'value' | 'close' | 'created' | 'activity'; direction?: 'asc' | 'desc'; limit?: number; offset?: number }
export interface DealPage { items: Deal[]; total: number; limit: number; offset: number }
export interface Analytics {
  from: string; to: string
  open: { count: number; withoutValue: number; byCurrency: { currency: string; count: number; value: number; weighted: number; weightedCount: number }[] }
  won: { count: number; byCurrency: { currency: string; count: number; value: number; average: number }[]; averageCycleDays: number | null }
  lost: { count: number; byCurrency: { currency: string; count: number; value: number }[]; reasons: { reason: string; count: number }[] }
  winRate: number | null; closedCount: number; createdCount: number; totalDeals: number
  stages: { stageId: string; name: string; color: string; count: number; byCurrency: { currency: string; value: number }[] }[]
  bySource: { source: DealSource; count: number }[]; byService: { service: string; count: number; won: number }[]
  overdueTasks: number; upcomingMeetings: number
  upcomingCloses: { id: string; title: string; expectedCloseDate: string; value: number | null; currency: string; overdue: boolean }[]
}
export interface SalesReminders {
  meetings: { id: string; dealId: string; dealTitle: string; title: string; startsAt: string; timezone: string }[]
  closing: { dealId: string; title: string; expectedCloseDate: string; overdue: boolean; ownerId: string | null }[]
}
export interface DealInput { leadId: string; title?: string; description?: string; stageId?: string; contactId?: string; opportunityId?: string; sourceDraftId?: string; source?: DealSource; value?: string; currency?: string; probability?: string; expectedCloseDate?: string; priority?: Priority; ownerId?: string; notes?: string }
export type DealChanges = Partial<Pick<DealInput, 'title' | 'description' | 'contactId' | 'opportunityId' | 'value' | 'currency' | 'probability' | 'expectedCloseDate' | 'priority' | 'ownerId' | 'notes'>>
export type ActivityInput =
  | { kind: 'note'; summary?: string; details: string; contactId?: string; occurredAt?: string }
  | { kind: 'reply'; sentiment: 'positive' | 'neutral' | 'negative'; channel?: string; details?: string; contactId?: string; occurredAt?: string }
  | { kind: 'call'; outcome: CallOutcome; nextAction?: string; details?: string; contactId?: string; occurredAt?: string }
  | { kind: 'proposal_sent'; summary?: string; details?: string; contactId?: string; occurredAt?: string }
export type CallOutcome = 'connected' | 'no_answer' | 'voicemail' | 'interested' | 'not_interested' | 'callback_requested'

/** The database's error code: 40001 stale version, P0409 duplicate deal (detail = the existing deal's ID), 42501 not allowed. */
export const isConflict = (cause: unknown) => cause instanceof RequestError && cause.code === '40001'
export const isDuplicate = (cause: unknown): cause is RequestError & { detail: string } => cause instanceof RequestError && cause.code === 'P0409'

async function call<T>(name: string, args: Record<string, unknown>, check: (value: unknown) => boolean = () => true): Promise<T> {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) {
    const result = failure(error) as RequestError & { detail?: string }
    result.detail = (error as { details?: string }).details ?? ''
    throw result
  }
  if (!check(data)) throw new RequestError('Unexpected response. Please contact your administrator.')
  return data as T
}
const isObject = (value: unknown) => typeof value === 'object' && value !== null
const ws = (workspaceId: string) => ({ target_workspace: workspaceId })

export const salesPipeline = (workspaceId: string) => call<Pipeline>('sales_pipeline_for', ws(workspaceId), isObject)
export const saveStage = (workspaceId: string, stage: Partial<Pick<Stage, 'id' | 'name' | 'color' | 'category' | 'probability'>>) => call<Stage>('save_sales_stage', { ...ws(workspaceId), stage }, isObject)
export const reorderStages = (workspaceId: string, stageIds: string[]) => call<void>('reorder_sales_stages', { ...ws(workspaceId), stage_ids: stageIds })
export const archiveStage = (workspaceId: string, stageId: string, reassignTo: string | null) => call<{ moved: number }>('archive_sales_stage', { ...ws(workspaceId), stage_id: stageId, reassign_to: reassignTo }, isObject)
export const restoreStage = (workspaceId: string, stageId: string) => call<Stage>('restore_sales_stage', { ...ws(workspaceId), stage_id: stageId }, isObject)
export const saveSalesSettings = (workspaceId: string, settings: Partial<Pick<SalesSettings, 'defaultCurrency' | 'currencies' | 'lostReasons' | 'defaultStageId'>>) => call<Pipeline>('save_sales_settings', { ...ws(workspaceId), settings }, isObject)
/** Retrying with the same request ID returns the deal the first attempt created (existing: true). */
export const createDeal = (workspaceId: string, deal: DealInput, requestId: string, allowDuplicate = false) => call<Deal & { existing: boolean }>('create_deal', { ...ws(workspaceId), deal, request_id: requestId, allow_duplicate: allowDuplicate }, isObject)
export const updateDeal = (workspaceId: string, dealId: string, expectedVersion: number, changes: DealChanges) => call<Deal>('update_deal', { ...ws(workspaceId), deal_id: dealId, expected_version: expectedVersion, changes }, isObject)
export const moveDeal = (workspaceId: string, dealId: string, stageId: string, expectedVersion: number, requestId: string) => call<Deal & { repeated: boolean }>('move_deal', { ...ws(workspaceId), deal_id: dealId, stage_id: stageId, expected_version: expectedVersion, request_id: requestId }, isObject)
export const closeDeal = (workspaceId: string, dealId: string, outcome: 'won' | 'lost', details: { stageId?: string; wonValue?: string; closeDate?: string; notes?: string; reason?: string }, expectedVersion: number, requestId: string) =>
  call<Deal & { repeated: boolean }>('close_deal', { ...ws(workspaceId), deal_id: dealId, outcome, details, expected_version: expectedVersion, request_id: requestId }, isObject)
export const reopenDeal = (workspaceId: string, dealId: string, stageId: string, expectedVersion: number, requestId: string) => call<Deal & { repeated: boolean }>('reopen_deal', { ...ws(workspaceId), deal_id: dealId, stage_id: stageId, expected_version: expectedVersion, request_id: requestId }, isObject)
export const setDealArchived = (workspaceId: string, dealId: string, archive: boolean) => call<Deal>('set_deal_archived', { ...ws(workspaceId), deal_id: dealId, archive }, isObject)
export const dealsFor = (workspaceId: string, filters: DealFilters) => call<DealPage>('deals_for', { ...ws(workspaceId), filters }, isObject)
export const pipelineBoard = (workspaceId: string, filters: { ownerId?: string; priority?: string; search?: string; perStage?: number; closedDays?: number }) => call<BoardColumn[]>('pipeline_board_for', { ...ws(workspaceId), filters }, Array.isArray)
export const dealDetail = (workspaceId: string, dealId: string) => call<DealDetail>('deal_detail', { ...ws(workspaceId), deal_id: dealId }, isObject)
export const dealTimeline = (workspaceId: string, dealId: string, groups: TimelineGroup[], before: string | null, pageSize = 50) =>
  call<{ items: TimelineItem[]; hasMore: boolean }>('deal_timeline', { ...ws(workspaceId), deal_id: dealId, kinds: groups, before_at: before, page_size: pageSize }, isObject)
export const recordDealActivity = (workspaceId: string, dealId: string, activity: ActivityInput, requestId: string) => call<{ id: string; repeated: boolean }>('record_deal_activity', { ...ws(workspaceId), deal_id: dealId, activity, request_id: requestId }, isObject)
export const saveMeeting = (workspaceId: string, dealId: string, meeting: Partial<Meeting>, requestId: string) => call<Record<string, unknown>>('save_deal_meeting', { ...ws(workspaceId), deal_id: dealId, meeting, request_id: requestId }, isObject)
export const confirmHandoff = (workspaceId: string, dealId: string, note: string) => call<{ id: string; createdAt: string; repeated: boolean }>('confirm_client_handoff', { ...ws(workspaceId), deal_id: dealId, note }, isObject)
export const salesAnalytics = (workspaceId: string, from: string, to: string) => call<Analytics>('sales_analytics', { ...ws(workspaceId), period_from: from, period_to: to, today: localDate() }, isObject)
export const salesReminders = (workspaceId: string) => call<SalesReminders>('sales_reminders_for', { ...ws(workspaceId), today: localDate() }, isObject)

// ---------- Money ----------
const formatters = new Map<string, Intl.NumberFormat>()
/** An amount in its own currency. Amounts in different currencies are never added together. */
export function money(value: number | string | null | undefined, currency: string, compact = false) {
  if (value === null || value === undefined || value === '') return '—'
  const key = `${currency}:${compact}`
  let format = formatters.get(key)
  if (!format) {
    try { format = new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: compact ? 1 : 2, minimumFractionDigits: 0, ...(compact ? { notation: 'compact' } : {}) }) }
    catch { format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }) }
    formatters.set(key, format)
  }
  return format.format(Number(value))
}
/** "$6,000 · €2,000": one amount per currency. */
export const perCurrency = (totals: { currency: string; value: number | null }[], compact = false) => totals.length ? totals.map(total => money(total.value, total.currency, compact)).join(' · ') : '—'
/** Weighted value: value × probability. Uses the deal's own probability, else its stage's default. */
export const weighted = (deal: Pick<Deal, 'value' | 'effectiveProbability'>) => deal.value === null || deal.effectiveProbability === null ? null : Number(deal.value) * deal.effectiveProbability / 100

// ---------- Periods ----------
export type PeriodKey = '7d' | '30d' | '90d' | 'quarter' | 'year' | 'custom'
export const periodLabels: Record<PeriodKey, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', quarter: 'This quarter', year: 'This year', custom: 'Custom range' }
/** Inclusive local calendar dates for a preset; "Last 7 days" includes today. */
export function periodRange(key: Exclude<PeriodKey, 'custom'>, now = new Date()): { from: string; to: string } {
  const to = localDate(now)
  if (key === 'quarter') return { from: localDate(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)), to }
  if (key === 'year') return { from: localDate(new Date(now.getFullYear(), 0, 1)), to }
  const days = key === '7d' ? 7 : key === '30d' ? 30 : 90
  return { from: localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1)), to }
}

// ---------- Labels ----------
export const categoryLabels: Record<StageCategory, string> = { open: 'Open', won: 'Won', lost: 'Lost' }
export const priorityLabels: Record<Priority, string> = { low: 'Low', medium: 'Medium', high: 'High' }
export const sourceLabels: Record<DealSource, string> = { manual: 'Added by hand', lead: 'From a lead', opportunity: 'From a business report opportunity', outreach: 'From outreach', pipeline: 'From the pipeline' }
export const callOutcomeLabels: Record<CallOutcome, string> = { connected: 'Connected', no_answer: 'No answer', voicemail: 'Left a voicemail', interested: 'Interested', not_interested: 'Not interested', callback_requested: 'Callback requested' }
export const meetingStatusLabels: Record<MeetingStatus, string> = { scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' }
export const timelineGroupLabels: Record<TimelineGroup, string> = { activity: 'Notes & calls', stage: 'Stage changes', task: 'Follow-ups', meeting: 'Meetings', outreach: 'Outreach', lead: 'Lead history' }
export const taskTypeLabels: Record<TaskType, string> = { follow_up: 'Follow-up', call: 'Follow-up call', email: 'Follow-up email', whatsapp: 'WhatsApp follow-up', meeting: 'Schedule a meeting', proposal: 'Prepare a proposal', proposal_review: 'Review the proposal', internal: 'Internal reminder', custom: 'Custom',
  // M10: client onboarding tasks.
  welcome: 'Send the welcome message', request_info: 'Request information', review_form: 'Review a submission', collect_assets: 'Collect assets', review_requirements: 'Review requirements', confirm_scope: 'Confirm the scope', verify_integrations: 'Verify access & integrations', prepare_handoff: 'Prepare the project handoff' }
export const stageColors = ['#64748b', '#0ea5e9', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899', '#f59e0b', '#f97316', '#eab308', '#14b8a6', '#16a34a', '#dc2626']
export const colorNames: Record<string, string> = { '#64748b': 'Slate', '#0ea5e9': 'Sky', '#6366f1': 'Indigo', '#8b5cf6': 'Violet', '#a855f7': 'Purple', '#ec4899': 'Pink', '#f59e0b': 'Amber', '#f97316': 'Orange', '#eab308': 'Yellow', '#14b8a6': 'Teal', '#16a34a': 'Green', '#dc2626': 'Red' }
/** The stage an outreach event suggests, by the default stage it came from. Never applied without confirmation. */
export const suggestedStageKey: Record<'sent' | 'replied', StageKey> = { sent: 'contacted', replied: 'replied' }
export const fewClosed = 5

// ---------- Helpers ----------
export const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'Something went wrong. Try again.'
/** The stage an outreach or deal event suggests, if it's further along than the deal's current stage. */
export function suggestStage(stages: Stage[], deal: Pick<Deal, 'stageId' | 'outcome' | 'archived'>, key: Stage['key']) {
  if (deal.outcome !== 'open' || deal.archived) return null
  const target = stages.find(stage => stage.key === key && !stage.archived && stage.category === 'open')
  const current = stages.find(stage => stage.id === deal.stageId)
  return target && current && target.position > current.position ? target : null
}
export const shortDate = (value: string | null) => value ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
export const dateTime = (value: string, timeZone?: string) => {
  try { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone, timeZoneName: 'short' } : {}) }) }
  catch { return new Date(value).toLocaleString() }
}
export const relativeDays = (date: string, today: string) => {
  const days = Math.round((new Date(`${date}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86_400_000)
  return days === 0 ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday' : days > 0 ? `in ${days} days` : `${-days} days ago`
}
