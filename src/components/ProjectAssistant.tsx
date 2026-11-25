import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import { errorText, shortDate } from '../lib/sales'
import {
  AssistantError, applyPlan, askAssistant, assistantConfig, loadTemplates,
  type AiOperation, type AiResult, type Deliverable, type Plan, type PlanDeliverable, type PlanMilestone, type PlanTask, type ProjectDetail, type TemplateSummary,
} from '../lib/projects'

export interface AssistantRequest { operation: AiOperation; deliverable?: Deliverable }
type EditMilestone = PlanMilestone & { include: boolean }
type EditDeliverable = PlanDeliverable & { key: string; include: boolean }
type EditTask = PlanTask & { key: string; include: boolean }
interface Draft { milestones: EditMilestone[]; deliverables: EditDeliverable[]; tasks: EditTask[]; notes: string[] }
const titles: Record<AiOperation, string> = { summary: 'Project summary', risks: 'Possible risks', plan: 'Suggested plan', breakdown: 'Task breakdown' }

/**
 * The AI assistant. Every answer is a suggestion based on the project's recorded data, shown next to that data. Plans and
 * breakdowns are edited and ticked by a person; only "Add selected to the project" creates records. It never changes
 * statuses, deadlines or assignments.
 */
export function ProjectAssistant({ workspace, detail, request, onClose, onApplied }: {
  workspace: WorkspaceSummary; detail: ProjectDetail; request: AssistantRequest; onClose: () => void; onApplied: (result: { message: string; workspaceChanged: boolean }) => Promise<void>
}) {
  const { operation, deliverable } = request
  const [config, setConfig] = useState<{ configured: boolean; monthlyLimit: number } | null>(null), [configError, setConfigError] = useState('')
  const [instructions, setInstructions] = useState(''), [templates, setTemplates] = useState<TemplateSummary[]>([]), [templateId, setTemplateId] = useState('')
  const [result, setResult] = useState<AiResult | null>(null), [draft, setDraft] = useState<Draft | null>(null), [running, setRunning] = useState(false), [error, setError] = useState(''), [applying, setApplying] = useState(false)
  const requestId = useRef(crypto.randomUUID()), started = useRef(false)
  const planning = operation === 'plan' || operation === 'breakdown'
  async function run() {
    setRunning(true); setError(''); setResult(null); setDraft(null)
    try {
      const answer = await askAssistant(workspace.id, detail.id, operation, { deliverableId: deliverable?.id, templateId: templateId || null, instructions: instructions.trim() || undefined })
      setResult(answer); requestId.current = crypto.randomUUID()
      if (answer.plan) setDraft(toDraft(answer.plan, deliverable))
    } catch (cause) {
      setError(cause instanceof AssistantError && cause.code === 'not_configured' ? 'The AI assistant isn’t set up for this workspace. An administrator adds a Gemini API key to the Edge Function secrets.'
        : cause instanceof AssistantError && cause.status === 429 ? errorText(cause) : `${errorText(cause)} Nothing was saved.`)
    } finally { setRunning(false) }
  }
  // The latest run(), so the first automatic run reads current inputs without re-running the effect.
  const runRef = useRef(run)
  useEffect(() => { runRef.current = run })
  useEffect(() => {
    let active = true
    assistantConfig(workspace.id).then(value => {
      if (!active) return
      setConfig(value)
      // A summary or risk check runs straight away, once; a plan waits for optional instructions.
      if (value.configured && !planning && !started.current) { started.current = true; void runRef.current() }
    }).catch(cause => { if (active) setConfigError(errorText(cause)) })
    if (operation === 'plan') loadTemplates(workspace.id).then(value => { if (active) setTemplates(value.templates.filter(item => !item.archived)) }).catch(() => undefined)
    return () => { active = false }
  }, [workspace.id, operation, planning])
  async function apply() {
    if (!draft) return
    const plan = toPlan(draft)
    if (!plan.milestones.length && !plan.deliverables.length && !plan.tasks.length) { setError('Tick at least one item to add.'); return }
    const badDates = [...plan.milestones, ...plan.tasks].find(item => item.startDate && item.dueDate && item.startDate > item.dueDate)
    if (badDates) { setError(`“${'name' in badDates ? badDates.name : badDates.title}” ends before it starts.`); return }
    setApplying(true); setError('')
    try {
      const applied = await applyPlan(workspace.id, detail.id, plan, operation === 'breakdown' ? 'breakdown' : 'assistant', requestId.current)
      await onApplied({ message: applied.repeated ? 'These suggestions were already added.' : `Added ${applied.milestones} milestone(s), ${applied.deliverables} deliverable(s) and ${applied.tasks} task(s) you approved.`, workspaceChanged: applied.workspaceChanged })
    } catch (cause) { setError(errorText(cause)) } finally { setApplying(false) }
  }
  const title = operation === 'breakdown' && deliverable ? `Break “${deliverable.title}” into tasks` : titles[operation]
  return <Modal id="pw-assistant" title={`${title} (AI)`} onClose={onClose}>
    <div className="pw-assistant">
      <p className="pw-ai-banner"><Icon name="spark" size={15} /> AI suggestion — review before saving. It is based on this project’s recorded data{planning ? '; nothing is added until you approve it' : ' and changes nothing'}.</p>
      {configError ? <p className="sp-error" role="alert">The AI assistant isn’t available: {configError}</p>
        : !config ? <p className="sp-muted" role="status">Checking the AI assistant…</p>
        : !config.configured ? <p className="sp-caution">The AI assistant isn’t set up for this workspace. An administrator adds a Gemini API key to the Edge Function secrets. Everything else in projects works without it.</p>
        : <>
          {planning && !result && <form className="sp-form" onSubmit={event => { event.preventDefault(); void run() }}>
            <p className="sp-intro">{operation === 'plan' ? 'Suggests milestones, deliverables and tasks from the project’s brief, linked services, dates and existing work.' : 'Suggests tasks for this deliverable from its description and the project’s brief.'} You can edit and untick anything before adding it.</p>
            {operation === 'plan' && templates.length > 0 && <label>Start from a template (optional)<select value={templateId} onChange={event => setTemplateId(event.target.value)}><option value="">No template</option>{templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
            <label>Anything to take into account? (optional)<textarea rows={2} maxLength={500} value={instructions} placeholder="e.g. two design rounds, launch before 15 March" onChange={event => setInstructions(event.target.value)} /></label>
            <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={running}>{running ? 'Thinking…' : 'Suggest'}</button></div>
          </form>}
          {running && <p className="sp-loading" role="status">The assistant is reading the project’s data…</p>}
          {!planning && !running && !result && !error && <p className="sp-muted">Ready.</p>}
        </>}
      {error && <p className="sp-error" role="alert">{error}</p>}
      {result && <>
        {result.warnings.length > 0 && <ul className="pw-warnings">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        {result.summary && <SummaryView summary={result.summary} />}
        {result.risks && <RisksView risks={result.risks} facts={result.facts} />}
        {draft && <PlanEditor draft={draft} detail={detail} onChange={setDraft} />}
        <details className="pw-facts-used"><summary>What this is based on ({result.facts.length} recorded facts)</summary>
          <dl>{result.facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
          <p className="sp-muted">Generated {new Date(result.generatedAt).toLocaleString()}{result.model ? ` by ${result.model}` : ''}. Facts come from LeadFlow; everything else is the assistant’s suggestion.</p>
        </details>
        <div className="modal-actions">
          <button className="secondary" disabled={running || applying} onClick={() => void run()}>Ask again</button>
          {draft ? <button className="primary" disabled={applying} onClick={() => void apply()}>{applying ? 'Adding…' : 'Add selected to the project'}</button> : <button className="primary" onClick={onClose}>Done</button>}
        </div>
      </>}
    </div>
  </Modal>
}

function SummaryView({ summary }: { summary: NonNullable<AiResult['summary']> }) {
  const list = (title: string, items: string[]) => items.length > 0 && <section><h4>{title}</h4><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></section>
  return <div className="pw-ai-summary">
    <p>{summary.overview}</p>
    <div className="pw-ai-columns">{list('Completed', summary.completed)}{list('Outstanding', summary.outstanding)}{list('Blockers', summary.blockers)}{list('Coming up', summary.upcoming)}</div>
  </div>
}

function RisksView({ risks, facts }: { risks: NonNullable<AiResult['risks']>; facts: AiResult['facts'] }) {
  if (!risks.length) return <p className="sp-muted">The assistant found no risks in the recorded data.</p>
  return <ol className="pw-ai-risks">{risks.map((risk, index) => <li key={index} className={`is-${risk.severity}`}>
    <div className="pw-row-head"><strong>{risk.title}</strong><span className={`pw-pill is-sev-${risk.severity}`}>{risk.severity} severity</span></div>
    <p>{risk.detail}</p>
    {risk.basedOn.length > 0 && <p className="sp-muted">Based on: {risk.basedOn.map(ref => facts.find(fact => fact.id === ref)?.label ?? ref).join('; ')}</p>}
    {risk.suggestion && <p className="pw-suggestion">Suggestion: {risk.suggestion}</p>}
  </li>)}</ol>
}

/** The suggested plan as an editable checklist. Unticking a milestone keeps its children, without that milestone. */
function PlanEditor({ draft, detail, onChange }: { draft: Draft; detail: ProjectDetail; onChange: (draft: Draft) => void }) {
  const setMilestone = (ref: string, patch: Partial<EditMilestone>) => onChange({ ...draft, milestones: draft.milestones.map(item => item.ref === ref ? { ...item, ...patch } : item) })
  const setDeliverable = (key: string, patch: Partial<EditDeliverable>) => onChange({ ...draft, deliverables: draft.deliverables.map(item => item.key === key ? { ...item, ...patch } : item) })
  const setTask = (key: string, patch: Partial<EditTask>) => onChange({ ...draft, tasks: draft.tasks.map(item => item.key === key ? { ...item, ...patch } : item) })
  const existing = new Map(detail.milestones.map(m => [m.id, m.name]))
  const children = (ref: string | null) => <>
    {draft.deliverables.filter(d => (d.milestoneRef ?? null) === ref).map(d => <li key={d.key} className="pw-plan-child">
      <input type="checkbox" checked={d.include} aria-label={`Include deliverable ${d.title}`} onChange={event => setDeliverable(d.key, { include: event.target.checked })} />
      <span className="sp-chip">Deliverable</span><input className="pw-plan-title" aria-label="Deliverable title" maxLength={200} value={d.title} onChange={event => setDeliverable(d.key, { title: event.target.value })} />
      <input type="date" aria-label={`Due date of ${d.title}`} value={d.dueDate ?? ''} onChange={event => setDeliverable(d.key, { dueDate: event.target.value || null })} />
    </li>)}
    {draft.tasks.filter(t => (t.milestoneRef ?? null) === ref).map(t => <li key={t.key} className="pw-plan-child">
      <input type="checkbox" checked={t.include} aria-label={`Include task ${t.title}`} onChange={event => setTask(t.key, { include: event.target.checked })} />
      <span className="sp-chip">Task</span><input className="pw-plan-title" aria-label="Task title" maxLength={300} value={t.title} onChange={event => setTask(t.key, { title: event.target.value })} />
      <input type="date" aria-label={`Due date of ${t.title}`} value={t.dueDate ?? ''} onChange={event => setTask(t.key, { dueDate: event.target.value || null })} />
      {t.dependsOn && t.dependsOn.length > 0 && <small className="sp-muted">after {t.dependsOn.map(ref => draft.tasks.find(other => other.ref === ref)?.title ?? '…').join(', ')}</small>}
    </li>)}
  </>
  const looseCount = draft.deliverables.filter(d => !d.milestoneRef).length + draft.tasks.filter(t => !t.milestoneRef).length
  const chosen = draft.milestones.filter(m => m.include).length + draft.deliverables.filter(d => d.include).length + draft.tasks.filter(t => t.include).length
  return <div className="pw-plan-editor">
    {draft.notes.length > 0 && <ul className="pw-ai-notes">{draft.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    <p className="sp-muted">{chosen} item(s) selected. Edit names and dates, untick what you don’t want, then add the rest. Nothing is assigned to anyone.</p>
    <ol className="pw-plan">
      {draft.milestones.map(m => <li key={m.ref} className={m.include ? '' : 'is-off'}>
        <div className="pw-plan-milestone">
          <input type="checkbox" checked={m.include} aria-label={`Include milestone ${m.name}`} onChange={event => setMilestone(m.ref, { include: event.target.checked })} />
          <input className="pw-plan-title" aria-label="Milestone name" maxLength={150} value={m.name} onChange={event => setMilestone(m.ref, { name: event.target.value })} />
          <input type="date" aria-label={`Start of ${m.name}`} value={m.startDate ?? ''} onChange={event => setMilestone(m.ref, { startDate: event.target.value || null })} />
          <input type="date" aria-label={`Due date of ${m.name}`} value={m.dueDate ?? ''} onChange={event => setMilestone(m.ref, { dueDate: event.target.value || null })} />
        </div>
        <ul>{children(m.ref)}</ul>
      </li>)}
      {looseCount > 0 && <li><div className="pw-plan-milestone"><strong>{draft.milestones.length ? 'Without a new milestone' : 'Items'}</strong>
        {draft.tasks.some(t => !t.milestoneRef && t.milestoneId) && <small className="sp-muted">in {[...new Set(draft.tasks.filter(t => !t.milestoneRef && t.milestoneId).map(t => existing.get(t.milestoneId!) ?? 'an existing milestone'))].join(', ')}</small>}</div>
        <ul>{children(null)}</ul></li>}
    </ol>
    <p className="sp-muted">Dates are suggestions{draft.milestones.some(m => m.dueDate) ? `, from ${shortDate(draft.milestones.find(m => m.startDate)?.startDate ?? null)}` : ''}. Check them against the client’s deadlines.</p>
  </div>
}

function toDraft(plan: Plan & { notes?: string[] }, deliverable?: Deliverable): Draft {
  return {
    milestones: plan.milestones.map(m => ({ ...m, include: true })),
    deliverables: plan.deliverables.map((d, index) => ({ ...d, key: d.ref ?? `d${index}`, include: true })),
    // A breakdown's tasks belong to the deliverable (and its milestone).
    tasks: plan.tasks.map((t, index) => ({ ...t, key: t.ref ?? `t${index}`, include: true,
      ...(deliverable ? { deliverableId: t.deliverableId ?? deliverable.id, milestoneId: t.milestoneRef ? t.milestoneId : t.milestoneId ?? deliverable.milestoneId ?? undefined } : {}) })),
    notes: plan.notes ?? [],
  }
}

function toPlan(draft: Draft): Plan {
  const milestones = new Set(draft.milestones.filter(m => m.include).map(m => m.ref))
  const deliverables = new Set(draft.deliverables.filter(d => d.include && d.ref).map(d => d.ref!))
  const tasks = new Set(draft.tasks.filter(t => t.include && t.ref).map(t => t.ref!))
  return {
    milestones: draft.milestones.filter(m => m.include).map(({ include: _include, ...m }) => ({ ...m, name: m.name.trim(), dependsOn: (m.dependsOn ?? []).filter(ref => milestones.has(ref)) })),
    deliverables: draft.deliverables.filter(d => d.include).map(({ include: _include, key: _key, ...d }) => ({ ...d, title: d.title.trim(), milestoneRef: d.milestoneRef && milestones.has(d.milestoneRef) ? d.milestoneRef : undefined })),
    tasks: draft.tasks.filter(t => t.include).map(({ include: _include, key: _key, ...t }) => ({ ...t, title: t.title.trim(), milestoneRef: t.milestoneRef && milestones.has(t.milestoneRef) ? t.milestoneRef : undefined,
      deliverableRef: t.deliverableRef && deliverables.has(t.deliverableRef) ? t.deliverableRef : undefined, dependsOn: (t.dependsOn ?? []).filter(ref => tasks.has(ref)) })),
  }
}
