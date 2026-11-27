import { supabase } from './supabase'
import { failure, RequestError } from './backend'

// M13: automations. Workflows are data (a trigger, conditions over registered fields, registered actions) saved and
// published through role-checked database functions; the database validates them and runs them on the server. The
// browser only edits drafts, previews dry runs and shows history. AI drafting and webhook keys go through the
// automation Edge Function.

export type FieldType = 'text' | 'number' | 'date' | 'datetime' | 'boolean' | 'list' | 'enum' | 'ref'
export interface Field { path: string; label: string; type: FieldType; options?: string[]; entity?: string }
export interface TriggerConfigField { key: string; label: string; type: 'number'; min: number; max: number; default: number }
export interface TriggerDef { type: string; group: string; label: string; description: string; subject: string | null; scan?: boolean; config?: TriggerConfigField[]; fields: Field[] }
export type InputKind = 'subject' | 'template' | 'enum' | 'boolean' | 'confirm' | 'number' | 'assignee' | 'recipients' | 'due' | 'stage' | 'onboarding_template' | 'project_template'
export interface ActionInput { key: string; label: string; kind: InputKind; options?: string[]; entities?: string[]; required?: boolean; max?: number; min?: number; default?: unknown; help?: string; multiline?: boolean }
export interface ActionDef { type: string; group: string; label: string; description: string; side: 'internal' | 'consequential'; ai?: boolean; client?: boolean; roles: string[]; retries: number
  inputs: ActionInput[]; outputs: Field[] }
export interface WaitDef { event: string; label: string; entity: string; outputs: Field[] }
export interface Catalog { triggers: TriggerDef[]; actions: ActionDef[]; waits: WaitDef[]; operators: Record<FieldType, string[]>; limits: Record<string, number>; commonFields: Field[] }
export interface Template { key: string; name: string; category: string; description: string; trigger: string; definition: Definition }
export interface Member { id: string; name: string; role: string }
export interface Lookups { members: Member[]; stages: { id: string; name: string; category: string }[]; onboardingTemplates: { id: string; name: string }[]; projectTemplates: { id: string; name: string }[] }
export interface CenterData { role: 'owner' | 'admin' | 'member'; catalog: Catalog; templates: Template[]; settings: { paused: boolean; reason: string }; timezone: string; lookups: Lookups }

export interface Condition { path: string; op: string; value?: string | string[]; value2?: string }
export interface Group { match: 'all' | 'any'; conditions: (Condition | Group)[] }
export const isGroup = (item: Condition | Group): item is Group => 'conditions' in item
export interface Due { mode: 'days' | 'relative'; days?: number; path?: string; offset?: number }
export interface ConditionStep { id: string; type: 'condition'; label?: string; when: Group }
export interface ActionStep { id: string; type: 'action'; label?: string; action: string; inputs: Record<string, unknown> }
export interface DelayStep { id: string; type: 'delay'; label?: string; mode: 'duration' | 'until'; amount?: number; unit?: 'minutes' | 'hours' | 'days'; until?: string }
export interface WaitStep { id: string; type: 'wait'; label?: string; event: string; subject: string; timeout: { amount: number; unit: 'hours' | 'days' }; onTimeout: 'continue' | 'stop' }
export interface BranchCase { id: string; label: string; when: Group; steps: Step[] }
export interface BranchStep { id: string; type: 'branch'; label?: string; cases: BranchCase[]; otherwise: { steps: Step[] } }
export type Step = ConditionStep | ActionStep | DelayStep | WaitStep | BranchStep
export type StepType = Step['type']
export interface WebhookField { key: string; label?: string; type: 'text' | 'number' | 'boolean' | 'date'; required?: boolean }
export interface Definition { trigger: { type: string; config: Record<string, unknown>; filter: Group | null }; steps: Step[] }
export interface Issue { node: string | null; field: string; message: string }
export interface Validation { valid: boolean; issues: Issue[]; nodes?: number; actions?: number; consequential?: boolean }

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived'
export interface WorkflowSummary {
  id: string; name: string; description: string; status: WorkflowStatus; version: number; draftChanged: boolean; triggerType: string | null; draftTriggerType: string | null
  publishedVersion: number | null; attention: { code: string; message: string; at: string } | null; nextFireAt: string | null; templateKey: string | null; createdAt: string; updatedAt: string
  activatedAt: string | null; stepCount: number; lastRun: { id: string; status: RunStatus; outcome: string | null; at: string } | null
  stats: { runs: number; succeeded: number; failed: number; finished: number; actions: number; throttled: number; blocked: number }
}
export interface VersionEntry { number: number; publishedAt: string; publishedBy: string; note: string; current: boolean; triggerType: string }
export interface WebhookInfo { id: string; status: 'active' | 'revoked'; version: number; createdAt: string; rotatedAt: string | null; lastReceivedAt: string | null; received: number; rejected: number }
export interface WorkflowDetail extends WorkflowSummary {
  definition: Definition; validation: Validation; published: { number: number; definition: Definition; publishedAt: string; publishedBy: string; note: string } | null
  versions: VersionEntry[]; webhook: WebhookInfo | null; openRuns: number
}
export type RunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'attention'
export interface RunSummary {
  id: string; workflowId: string; workflowName: string; version: number | null; mode: 'live' | 'test'; status: RunStatus; outcome: string | null; triggerType: string
  entityType: string | null; entityId: string | null; currentNode: string | null; failedNode: string | null; failedStep: string | null; errorCode: string | null; error: string | null
  retryCount: number; attempts: number; createdAt: string; startedAt: string | null; completedAt: string | null; nextRunAt: string | null; durationMs: number | null; subject: string
}
export interface RunStepRecord {
  id: number; sequence: number; node: string; type: StepType; action: string | null; label: string; status: 'completed' | 'failed' | 'skipped' | 'waiting' | 'retrying' | 'cancelled'
  attempt: number; result: Record<string, unknown> | null; input: Record<string, unknown> | null; output: Record<string, unknown> | null; errorCode: string | null; error: string | null
  startedAt: string; completedAt: string | null
}
export interface RunDetail extends RunSummary {
  trigger: Record<string, unknown>; event: Record<string, unknown> | null; wait: Record<string, unknown> | null; versionKind: 'published' | 'test'; definition: Definition; publishedBy: string
  steps: RunStepRecord[]; canRetry: boolean; canCancel: boolean
}
export interface Overview {
  today: string; workflows: { total: number; active: number; paused: number; draft: number; archived: number }; today_runs: { runs: number; succeeded: number; failed: number }
  period: { days: number; runs: number; succeeded: number; failed: number; cancelled: number; finished: number; actions: number; aiActions: number; emailActions: number; throttled: number
    blocked: number; testRuns: number; averageMs: number | null }
  open: { queued: number; running: number; waiting: number; attention: number }; failedRecent: number
  attention: { workflowId: string; name: string; status: WorkflowStatus; reason: string; code: string; at: string }[]; recent: RunSummary[]
}
export interface DryRunStep { node: string; type: StepType; label?: string; action?: string; side?: string; ai?: boolean; client?: boolean; input?: Record<string, unknown>; result: Record<string, unknown> }
export interface DryRun { valid: boolean; issues: Issue[]; filterMatched: boolean; outcome: string; steps: DryRunStep[]; note: string }
export interface Sample { data: Record<string, unknown>; entity: { type: string; id: string; label: string } | null; options: { id: string; label: string }[]; empty: boolean }
export interface AiDraft { name: string; summary: string; definition: Definition; sideEffects: string[]; unsupported: string[]; validation: Validation; note: string }
export interface AutomationConfig { ai: boolean; model: string | null; monthlyLimit: number; webhooks: boolean; webhookUrl: string }
export interface IssuedWebhook { id: string; version: number; secret: string; url: string; note: string }

const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) throw failure(error)
  return data as T
}
export const loadCenter = (workspace: string) => call<CenterData>('automation_center_for', { target_workspace: workspace })
export const loadOverview = (workspace: string) => call<Overview>('automation_overview_for', { target_workspace: workspace })
export const listWorkflows = (workspace: string) => call<WorkflowSummary[]>('automation_workflows_for', { target_workspace: workspace })
export const workflowDetail = (workspace: string, workflow: string) => call<WorkflowDetail>('automation_workflow_detail', { target_workspace: workspace, target_workflow: workflow })
export const saveWorkflow = (workspace: string, workflow: string | null, name: string, description: string, definition: Definition, expectedVersion: number | null) =>
  call<WorkflowSummary & { validation: Validation; repeated?: boolean }>('automation_save_workflow', { target_workspace: workspace, target_workflow: workflow, workflow_name: name,
    workflow_description: description, definition, expected_version: expectedVersion, request_id: crypto.randomUUID() })
export const validateDefinition = (workspace: string, definition: Definition) => call<Validation>('automation_validate', { target_workspace: workspace, definition })
export const publishWorkflow = (workspace: string, workflow: string, expectedVersion: number, note: string) =>
  call<WorkflowSummary>('automation_publish', { target_workspace: workspace, target_workflow: workflow, expected_version: expectedVersion, note })
export const setWorkflowStatus = (workspace: string, workflow: string, status: 'active' | 'paused' | 'archived') =>
  call<WorkflowSummary>('automation_set_status', { target_workspace: workspace, target_workflow: workflow, next_status: status, expected_version: null })
export const restoreVersion = (workspace: string, workflow: string, number: number) =>
  call<WorkflowSummary & { definition: Definition; validation: Validation }>('automation_restore_version', { target_workspace: workspace, target_workflow: workflow, version_number: number, expected_version: null })
export const duplicateWorkflow = (workspace: string, workflow: string) => call<WorkflowSummary>('automation_duplicate', { target_workspace: workspace, target_workflow: workflow, request_id: crypto.randomUUID() })
export const deleteWorkflow = (workspace: string, workflow: string, confirmName: string) => call<null>('automation_delete', { target_workspace: workspace, target_workflow: workflow, confirm_name: confirmName })
export const fromTemplate = (workspace: string, key: string) => call<WorkflowSummary>('automation_from_template', { target_workspace: workspace, template_key: key, request_id: crypto.randomUUID() })
export const saveSettings = (workspace: string, paused: boolean, reason: string) => call<{ paused: boolean; reason: string }>('automation_save_settings', { target_workspace: workspace, paused, reason })
export const sampleFor = (workspace: string, triggerType: string, entityId: string | null) => call<Sample>('automation_sample_for', { target_workspace: workspace, trigger_type: triggerType, entity_id: entityId })
export const dryRun = (workspace: string, definition: Definition, sample: Record<string, unknown>) => call<DryRun>('automation_dry_run', { target_workspace: workspace, definition, sample })
export const startLiveTest = (workspace: string, workflow: string, sample: Record<string, unknown>) =>
  call<RunSummary>('automation_start_test', { target_workspace: workspace, target_workflow: workflow, sample, confirmed: true })
export const listRuns = (workspace: string, filters: { workflowId?: string; status?: RunStatus; mode?: 'live' | 'test'; failed?: boolean }, before: RunSummary | null = null, pageSize = 25) =>
  call<{ items: RunSummary[]; more: boolean }>('automation_runs_for', { target_workspace: workspace, filters, before_at: before?.createdAt ?? null, before_id: before?.id ?? null, page_size: pageSize })
export const runDetail = (workspace: string, run: string) => call<RunDetail>('automation_run_detail', { target_workspace: workspace, target_run: run })
export const retryRun = (workspace: string, run: string) => call<RunSummary>('automation_retry_run', { target_workspace: workspace, target_run: run })
export const rerunRun = (workspace: string, run: string) => call<RunSummary>('automation_rerun', { target_workspace: workspace, target_run: run, confirmed: true })
export const cancelRun = (workspace: string, run: string) => call<RunSummary>('automation_cancel_run', { target_workspace: workspace, target_run: run })
export const revokeWebhook = (workspace: string, workflow: string) => call<{ id: string; status: string }>('automation_webhook_revoke', { target_workspace: workspace, target_workflow: workflow })

// ---------- Edge Function ----------
export class AutomationError extends Error { status: number; code: string; constructor(message: string, status: number, code = '') { super(message); this.status = status; this.code = code } }
const functionUrl = () => { const url = import.meta.env.VITE_SUPABASE_URL; return url ? `${new URL(url).origin}/functions/v1/automation` : '' }
async function invoke<T>(workspaceId: string, body: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
  const { data } = await supabase!.auth.getSession()
  const token = data.session?.access_token, url = functionUrl()
  if (!token || !url) throw new AutomationError('Your session has expired. Sign in again.', 401)
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '' },
      body: JSON.stringify({ workspaceId, ...body }), signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) {
    throw new AutomationError((cause as Error).name === 'TimeoutError' ? 'This is taking longer than expected. Try again.' : 'We couldn’t reach LeadFlow. Check your connection and try again.', 0)
  }
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new AutomationError(typeof result.error === 'string' ? result.error : 'This isn’t available right now.', response.status, typeof result.code === 'string' ? result.code : '')
  return result as T
}
export const automationConfig = (workspace: string) => invoke<AutomationConfig>(workspace, { action: 'config' }, 15000)
export const draftWithAi = (workspace: string, description: string) => invoke<AiDraft>(workspace, { action: 'draft', description }, 120000)
export const issueWebhookSecret = (workspace: string, workflow: string, rotate: boolean) => invoke<IssuedWebhook>(workspace, { action: 'webhook_secret', workflowId: workflow, rotate })
/** Starts a live test or a retried run now; the worker would otherwise pick it up within a minute. */
export const advanceNow = (workspace: string, run: string) => invoke<RunDetail>(workspace, { action: 'advance', runId: run }, 60000)

export const errorText = (cause: unknown) => cause instanceof RequestError || cause instanceof AutomationError || cause instanceof Error ? cause.message : 'Something went wrong. Try again.'

// ---------- Labels ----------
export const statusLabels: Record<WorkflowStatus, string> = { draft: 'Draft', active: 'Active', paused: 'Paused', archived: 'Archived' }
export const runStatusLabels: Record<RunStatus, string> = { queued: 'Queued', running: 'Running', waiting: 'Waiting', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', attention: 'Needs attention' }
export const outcomeLabels: Record<string, string> = { completed: 'Completed', condition_not_met: 'Stopped: condition not met', wait_timed_out: 'Stopped: nothing arrived in time',
  loop_blocked: 'Not started: loop protection', cancelled: 'Cancelled', retries_exhausted: 'Failed after retries', invalid: 'Failed', authorization: 'Permission needed',
  timed_out: 'Took too long', step_limit: 'Step limit reached', ai_failed: 'AI step failed', engine_error: 'Unexpected error', condition_error: 'Condition error', invalid_definition: 'Republish needed',
  missing_subject: 'Record missing' }
export const operatorLabels: Record<string, string> = { equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'doesn’t contain', starts_with: 'starts with',
  is_empty: 'is empty', is_not_empty: 'is not empty', in: 'is any of', not_in: 'is none of', gt: 'is more than', lt: 'is less than', gte: 'is at least', lte: 'is at most', between: 'is between',
  before: 'is before', after: 'is after', on: 'is on', within_next_days: 'is within the next', overdue: 'has passed', is_true: 'is yes', is_false: 'is no', contains_item: 'includes',
  not_contains_item: 'doesn’t include' }
export const valueless = (op: string) => ['is_empty', 'is_not_empty', 'is_true', 'is_false', 'overdue'].includes(op)
export const humanize = (value: string) => value.replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`).replace(/_/g, ' ').replace(/^\w/, char => char.toUpperCase())
export const recipientLabels: Record<string, string> = { publisher: 'Whoever publishes the workflow', admins: 'Workspace owners and admins', record_owner: 'The record’s owner' }
export const assigneeLabels: Record<string, string> = { none: 'Nobody', publisher: 'Whoever publishes the workflow', record_owner: 'The record’s owner' }

/** Example trigger data from a trigger's fields, for testing when the workspace has no matching record yet. */
export function exampleData(fields: Field[]): Record<string, unknown> {
  const data: Record<string, unknown> = {}, today = new Date().toISOString().slice(0, 10)
  for (const field of fields) {
    const parts = field.path.split('.')
    if (parts[0] !== 'trigger' || parts.length < 2) continue
    const value = field.type === 'number' ? 1 : field.type === 'boolean' ? true : field.type === 'date' ? today : field.type === 'datetime' ? new Date().toISOString()
      : field.type === 'enum' ? field.options?.[0] ?? '' : field.type === 'list' ? [] : field.type === 'ref' ? `example-${field.entity ?? 'id'}` : `Example ${field.label.toLowerCase()}`
    if (parts.length === 2) data[parts[1]] = value
    else data[parts[1]] = { ...(data[parts[1]] as Record<string, unknown> | undefined), [parts[2]]: value }
  }
  return data
}
/** Real test data over example values, one level deep, so every field the trigger defines has a value to test with. */
export function withExamples(example: Record<string, unknown>, real: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...example }
  for (const [key, value] of Object.entries(real)) {
    const base = merged[key]
    merged[key] = value && typeof value === 'object' && !Array.isArray(value) && base && typeof base === 'object' && !Array.isArray(base) ? { ...base, ...value } : value
  }
  return merged
}
/** A dry run's inputs as [label, text], with the action's own labels and names for members, stages and templates. */
export function formatInputs(action: ActionDef | null | undefined, input: Record<string, unknown>, center: CenterData): [string, string][] {
  const { lookups } = center
  const person = (id: unknown) => recipientLabels[String(id)] ?? assigneeLabels[String(id)] ?? lookups.members.find(m => m.id === id)?.name ?? String(id)
  return Object.entries(input).map(([key, value]): [string, string] => {
    const def = action?.inputs.find(i => i.key === key)
    const label = def?.label ?? humanize(key)
    if (!def) return [label, formatValue(value)]
    switch (def.kind) {
      case 'subject': { const v = value as { path?: string; id?: unknown } | null; const entity = String(v?.path ?? '').split('.').slice(-2, -1)[0] ?? ''; return [label, v?.id ? `${humanize(entity)} ${String(v.id)}`.trim() : 'Not in this data'] }
      case 'assignee': return [label, person(value)]
      case 'recipients': return [label, Array.isArray(value) ? value.map(person).join(', ') : formatValue(value)]
      case 'enum': return [label, humanize(String(value))]
      case 'stage': return [label, lookups.stages.find(s => s.id === value)?.name ?? formatValue(value)]
      case 'onboarding_template': return [label, lookups.onboardingTemplates.find(t => t.id === value)?.name ?? formatValue(value)]
      case 'project_template': return [label, lookups.projectTemplates.find(t => t.id === value)?.name ?? formatValue(value)]
      default: return [label, formatValue(value)]
    }
  })
}
/** A short, readable rendering of a logged value. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.map(formatValue).join(', ')
  if (typeof value === 'object' && value && 'entity' in value && 'id' in value) return `${humanize(String((value as { entity: unknown }).entity))} ${String((value as { id: unknown }).id)}`
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${humanize(k)}: ${formatValue(v)}`).join(' · ')
  return String(value)
}
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.max(ms, 0)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`
  return `${(ms / 86_400_000).toFixed(1)} days`
}
export function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso), now = Date.now(), diff = now - date.getTime()
  if (Math.abs(diff) < 60_000) return 'just now'
  if (diff > 0 && diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff > 0 && diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  if (diff < 0 && diff > -86_400_000) return `in ${Math.max(1, Math.round(-diff / 3_600_000))} h`
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ---------- Definition helpers ----------
export const emptyGroup = (): Group => ({ match: 'all', conditions: [] })
export const emptyDefinition = (): Definition => ({ trigger: { type: '', config: {}, filter: null }, steps: [] })

/** Every step, depth first, with the list it lives in. */
export function walk(steps: Step[], visit: (step: Step, list: Step[], index: number) => void) {
  steps.forEach((step, index) => {
    visit(step, steps, index)
    if (step.type === 'branch') { step.cases.forEach(c => walk(c.steps, visit)); walk(step.otherwise.steps, visit) }
  })
}
export function findStep(definition: Definition, id: string): Step | null {
  let found: Step | null = null
  walk(definition.steps, step => { if (step.id === id) found = step })
  return found
}
export function usedIds(definition: Definition): Set<string> {
  const ids = new Set<string>()
  walk(definition.steps, step => { ids.add(step.id); if (step.type === 'branch') step.cases.forEach(c => ids.add(c.id)) })
  return ids
}
export function nextId(definition: Definition, prefix = 'n'): string {
  const ids = usedIds(definition)
  let n = 1
  while (ids.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}
/** A copy of the definition with the step list identified by `parent` changed. parent: 'root', or `${branchId}:${caseId|otherwise}`. */
export function updateList(definition: Definition, parent: string, change: (steps: Step[]) => Step[]): Definition {
  const copy: Definition = structuredClone(definition)
  if (parent === 'root') { copy.steps = change(copy.steps); return copy }
  const [branchId, caseId] = parent.split(':')
  walk(copy.steps, step => {
    if (step.type !== 'branch' || step.id !== branchId) return
    if (caseId === 'otherwise') step.otherwise.steps = change(step.otherwise.steps)
    else step.cases = step.cases.map(c => c.id === caseId ? { ...c, steps: change(c.steps) } : c)
  })
  return copy
}
/** The list a step is in, as an updateList parent. */
export function parentOf(definition: Definition, id: string): string | null {
  const search = (steps: Step[], parent: string): string | null => {
    for (const step of steps) {
      if (step.id === id) return parent
      if (step.type === 'branch') {
        for (const c of step.cases) { const found = search(c.steps, `${step.id}:${c.id}`); if (found) return found }
        const found = search(step.otherwise.steps, `${step.id}:otherwise`); if (found) return found
      }
    }
    return null
  }
  return search(definition.steps, 'root')
}
export function replaceStep(definition: Definition, id: string, next: Step): Definition {
  const parent = parentOf(definition, id)
  return parent ? updateList(definition, parent, steps => steps.map(step => step.id === id ? next : step)) : definition
}
export function removeStep(definition: Definition, id: string): Definition {
  const parent = parentOf(definition, id)
  return parent ? updateList(definition, parent, steps => steps.filter(step => step.id !== id)) : definition
}
export function moveStep(definition: Definition, id: string, offset: -1 | 1): Definition {
  const parent = parentOf(definition, id)
  if (!parent) return definition
  return updateList(definition, parent, steps => {
    const index = steps.findIndex(step => step.id === id), target = index + offset
    if (target < 0 || target >= steps.length) return steps
    const next = [...steps]; [next[index], next[target]] = [next[target], next[index]]
    return next
  })
}
/** A copy of a step (and anything inside it) with fresh IDs, placed after the original. */
export function duplicateStep(definition: Definition, id: string): { definition: Definition; id: string | null } {
  const original = findStep(definition, id), parent = parentOf(definition, id)
  if (!original || !parent) return { definition, id: null }
  const taken = usedIds(definition)
  const fresh = (prefix: string) => { let n = 1; while (taken.has(`${prefix}${n}`)) n++; taken.add(`${prefix}${n}`); return `${prefix}${n}` }
  const clone = (step: Step): Step => {
    const copy = structuredClone(step); copy.id = fresh('n')
    if (copy.type === 'branch') { copy.cases = copy.cases.map(c => ({ ...c, id: fresh('b'), steps: c.steps.map(clone) })); copy.otherwise = { steps: copy.otherwise.steps.map(clone) } }
    return copy
  }
  const copy = clone(original)
  return { definition: updateList(definition, parent, steps => { const index = steps.findIndex(step => step.id === id); const next = [...steps]; next.splice(index + 1, 0, copy); return next }), id: copy.id }
}

/** Fields readable at a step: the trigger's, plus outputs of earlier steps on the same path (the database checks the same). */
export function fieldsAt(catalog: Catalog, definition: Definition, stepId: string | 'trigger' | null): Field[] {
  const trigger = catalog.triggers.find(t => t.type === definition.trigger.type)
  const base: Field[] = [...(trigger?.fields ?? catalog.commonFields)]
  if (definition.trigger.type === 'webhook.received') {
    for (const field of (definition.trigger.config.fields as WebhookField[] | undefined) ?? []) {
      if (field?.key && /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(field.key)) base.push({ path: `trigger.data.${field.key}`, label: field.label || field.key, type: field.type })
    }
  }
  if (stepId === 'trigger' || stepId === null) return stepId === null ? collectAll(catalog, definition, base) : base
  const outputsOf = (step: Step): Field[] => {
    if (step.type === 'action') { const def = catalog.actions.find(a => a.type === step.action); return (def?.outputs ?? []).map(o => ({ ...o, path: `steps.${step.id}.${o.path}`, label: `${o.label} (${step.label || def?.label})` })) }
    if (step.type === 'wait') { const def = catalog.waits.find(w => w.event === step.event); return (def?.outputs ?? []).map(o => ({ ...o, path: `steps.${step.id}.${o.path}`, label: `${o.label} (${step.label || 'wait'})` })) }
    return []
  }
  const search = (steps: Step[], visible: Field[]): Field[] | null => {
    let current = visible
    for (const step of steps) {
      if (step.id === stepId) return current
      if (step.type === 'branch') {
        for (const c of step.cases) { const found = search(c.steps, current); if (found) return found }
        const found = search(step.otherwise.steps, current); if (found) return found
      }
      current = [...current, ...outputsOf(step)]
    }
    return null
  }
  return search(definition.steps, base) ?? base
}
function collectAll(catalog: Catalog, definition: Definition, base: Field[]): Field[] {
  const all = [...base]
  walk(definition.steps, step => {
    if (step.type === 'action') { const def = catalog.actions.find(a => a.type === step.action); all.push(...(def?.outputs ?? []).map(o => ({ ...o, path: `steps.${step.id}.${o.path}` }))) }
  })
  return all
}

export function describeCondition(condition: Condition, fields: Field[]): string {
  const field = fields.find(f => f.path === condition.path)
  const label = field?.label ?? condition.path
  const op = operatorLabels[condition.op] ?? condition.op
  if (valueless(condition.op)) return `${label} ${op}`
  const value = Array.isArray(condition.value) ? condition.value.map(humanize).join(' or ') : field?.type === 'enum' ? humanize(String(condition.value ?? '')) : String(condition.value ?? '')
  if (condition.op === 'between') return `${label} is between ${value} and ${condition.value2 ?? ''}`
  if (condition.op === 'within_next_days') return `${label} is within the next ${value} days`
  return `${label} ${op} ${value}`
}
export function describeGroup(group: Group | null | undefined, fields: Field[]): string {
  if (!group || !group.conditions.length) return 'Always'
  const joiner = group.match === 'any' ? ' or ' : ' and '
  return group.conditions.map(item => isGroup(item) ? `(${describeGroup(item, fields)})` : describeCondition(item, fields)).join(joiner)
}
export function countConditions(group: Group | null | undefined): number {
  if (!group) return 0
  return group.conditions.reduce((total, item) => total + (isGroup(item) ? countConditions(item) : 1), 0)
}
/** A plain-language line for a step card. */
export function stepSummary(step: Step, catalog: Catalog, definition: Definition, lookups: Lookups): string {
  const fields = fieldsAt(catalog, definition, step.id)
  if (step.type === 'condition') return `Continue only if ${describeGroup(step.when, fields).replace(/^Always$/, '…')}`
  if (step.type === 'branch') return `${step.cases.length} path${step.cases.length === 1 ? '' : 's'} and Otherwise`
  if (step.type === 'delay') return step.mode === 'until' ? `Wait until ${step.until ? new Date(step.until).toLocaleString() : '…'}` : `Wait ${step.amount ?? '…'} ${step.unit ?? ''}`
  if (step.type === 'wait') {
    const def = catalog.waits.find(w => w.event === step.event)
    return `${def?.label ?? 'Wait for an event'} · up to ${step.timeout?.amount ?? '…'} ${step.timeout?.unit ?? ''}, then ${step.onTimeout === 'continue' ? 'continue' : 'stop'}`
  }
  const def = catalog.actions.find(a => a.type === step.action)
  if (!def) return 'Choose an action'
  const subject = typeof step.inputs.subject === 'string' ? fields.find(f => f.path === step.inputs.subject)?.label : null
  const title = typeof step.inputs.title === 'string' ? step.inputs.title : typeof step.inputs.name === 'string' ? step.inputs.name : typeof step.inputs.text === 'string' ? step.inputs.text : ''
  const extra = step.action === 'deal.move_stage' ? lookups.stages.find(s => s.id === step.inputs.stageId)?.name : typeof step.inputs.status === 'string' ? humanize(step.inputs.status) : ''
  return [subject && `On ${subject.toLowerCase()}`, title && `“${title.length > 70 ? `${title.slice(0, 70)}…` : title}”`, extra].filter(Boolean).join(' · ') || def.description
}
export function issuesFor(validation: Validation | null, node: string): Issue[] { return validation?.issues.filter(issue => issue.node === node) ?? [] }

/** A new step of a type, with sensible defaults for the current trigger. */
export function newStep(type: StepType, definition: Definition, catalog: Catalog): Step {
  const id = nextId(definition)
  const trigger = catalog.triggers.find(t => t.type === definition.trigger.type)
  if (type === 'condition') return { id, type, label: 'Condition', when: emptyGroup() }
  if (type === 'delay') return { id, type, label: 'Delay', mode: 'duration', amount: 1, unit: 'days' }
  if (type === 'wait') {
    const wait = catalog.waits.find(w => trigger?.fields.some(f => f.type === 'ref' && f.entity === w.entity)) ?? catalog.waits[0]
    const subject = trigger?.fields.find(f => f.type === 'ref' && f.entity === wait.entity)?.path ?? ''
    return { id, type, label: 'Wait for event', event: wait.event, subject, timeout: { amount: 1, unit: 'days' }, onTimeout: 'stop' }
  }
  if (type === 'branch') {
    const taken = usedIds(definition); let n = 1; while (taken.has(`b${n}`)) n++
    return { id, type, label: 'Branch', cases: [{ id: `b${n}`, label: 'Path 1', when: emptyGroup(), steps: [] }], otherwise: { steps: [] } }
  }
  return { id, type: 'action', label: '', action: '', inputs: {} }
}
/** Inputs for a newly chosen action: the defaults, plus the trigger's matching record as the subject. */
export function defaultInputs(action: ActionDef, fields: Field[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {}
  for (const input of action.inputs) {
    if (input.default !== undefined) inputs[input.key] = input.default
    if (input.kind === 'subject' && input.required) {
      const match = input.entities?.map(entity => fields.find(f => f.type === 'ref' && f.entity === entity && f.path.startsWith('trigger.') && f.path.endsWith('.id'))).find(Boolean)
        ?? input.entities?.map(entity => fields.find(f => f.type === 'ref' && f.entity === entity)).find(Boolean)
      if (match) inputs[input.key] = match.path
    }
    if (input.kind === 'due') inputs[input.key] = { mode: 'days', days: 1 }
    if (input.kind === 'recipients') inputs[input.key] = ['publisher']
    if (input.kind === 'confirm') inputs[input.key] = false
  }
  return inputs
}
