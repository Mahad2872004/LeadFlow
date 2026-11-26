import { useCallback, useEffect, useState } from 'react'
import './Sales.css'
import './Automation.css'
import { Icon } from './Icon'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import { AutomationBuilder } from './AutomationBuilder'
import { RunDrawer } from './AutomationRun'
import {
  automationConfig, deleteWorkflow, draftWithAi, duplicateWorkflow, duration, errorText, fromTemplate, listRuns, listWorkflows, loadCenter, loadOverview, outcomeLabels, retryRun, runStatusLabels,
  saveSettings, setWorkflowStatus, statusLabels, when,
  type AiDraft, type AutomationConfig, type CenterData, type Definition, type Overview, type RunStatus, type RunSummary, type Step, type WorkflowStatus, type WorkflowSummary,
} from '../lib/automation'

type Tab = 'overview' | 'workflows' | 'templates' | 'history' | 'failed' | 'settings'
const tabs: [Tab, string][] = [['overview', 'Overview'], ['workflows', 'My workflows'], ['templates', 'Templates'], ['history', 'Execution history'], ['failed', 'Failed executions'], ['settings', 'Settings']]
interface Editing { id: string | null; initial?: { name: string; description: string; definition: Definition } }

/**
 * The Automation Center (M13): workflows that connect LeadFlow's modules. Everything shown is the workspace's own data;
 * runs happen on the server, never in this page. Owners and admins create, publish and manage; members can look,
 * dry-run and follow runs.
 */
export function AutomationCenter({ workspace, onNotice }: { workspace: WorkspaceSummary; onNotice: (message: string) => void }) {
  const [center, setCenter] = useState<CenterData | null>(null), [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('overview'), [editing, setEditing] = useState<Editing | null>(null), [openRun, setOpenRun] = useState<string | null>(null)
  const [version, setVersion] = useState(0), [assistant, setAssistant] = useState(false)
  useEffect(() => {
    let active = true
    loadCenter(workspace.id).then(result => { if (active) setCenter(result) }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, version])
  const refresh = useCallback(() => setVersion(value => value + 1), [])
  if (!center) return <section className="panel au-panel"><p className={error ? 'au-error' : 'au-muted'} role={error ? 'alert' : 'status'}>{error || 'Loading automations…'}</p></section>
  if (editing) return <AutomationBuilder key={editing.id ?? 'new'} workspace={workspace} center={center} workflowId={editing.id} initial={editing.initial}
    onClose={changed => { setEditing(null); if (changed) refresh() }} onNotice={onNotice} onOpenRun={run => { setEditing(null); setOpenRun(run); refresh() }} />
  const manager = center.role !== 'member'
  return <div className="au-page">
    <div className="au-toolbar">
      <div className="sp-tabs" role="tablist" aria-label="Automation sections">{tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
      {manager && <div className="au-toolbar-actions">
        <button className="secondary" onClick={() => setAssistant(true)}><Icon name="spark" size={16} /> Describe with AI</button>
        <button className="primary" onClick={() => setEditing({ id: null })}><Icon name="plus" size={17} /> New workflow</button>
      </div>}
    </div>
    {center.settings.paused && <p className="au-warning au-banner" role="status"><strong>Automations are paused in this workspace.</strong> No new runs start and queued runs wait.{center.settings.reason ? ` Reason: ${center.settings.reason}` : ''}</p>}
    <div key={tab} role="tabpanel" aria-label={tabs.find(([key]) => key === tab)![1]}>
      {tab === 'overview' && <OverviewTab workspace={workspace} center={center} version={version} onOpenRun={setOpenRun} onOpenWorkflow={id => setEditing({ id })} onTab={setTab} />}
      {tab === 'workflows' && <WorkflowsTab workspace={workspace} center={center} version={version} onOpen={id => setEditing({ id })} onChanged={message => { refresh(); onNotice(message) }} onTemplates={() => setTab('templates')} />}
      {tab === 'templates' && <TemplatesTab workspace={workspace} center={center} onUse={id => { refresh(); setEditing({ id }) }} />}
      {tab === 'history' && <HistoryTab workspace={workspace} center={center} version={version} failed={false} onOpenRun={setOpenRun} onChanged={refresh} />}
      {tab === 'failed' && <HistoryTab workspace={workspace} center={center} version={version} failed onOpenRun={setOpenRun} onChanged={refresh} />}
      {tab === 'settings' && <SettingsTab workspace={workspace} center={center} onChanged={message => { refresh(); onNotice(message) }} />}
    </div>
    {openRun && <RunDrawer workspace={workspace} center={center} runId={openRun} onClose={() => setOpenRun(null)} onChanged={refresh} onOpenWorkflow={id => { setOpenRun(null); setEditing({ id }) }} />}
    {assistant && <AssistantDialog workspace={workspace} center={center} onClose={() => setAssistant(false)}
      onUse={draft => { setAssistant(false); setEditing({ id: null, initial: { name: draft.name, description: draft.summary, definition: draft.definition } }) }} />}
  </div>
}

export function StatusPill({ status }: { status: WorkflowStatus }) { return <span className={`au-status au-status-${status}`}>{statusLabels[status]}</span> }
export function RunPill({ status }: { status: RunStatus }) { return <span className={`au-run-status au-run-${status}`}>{runStatusLabels[status]}</span> }
const triggerLabel = (center: CenterData, type: string | null) => center.catalog.triggers.find(t => t.type === type)?.label ?? 'No trigger yet'
const rate = (succeeded: number, finished: number) => finished ? `${Math.round((succeeded / finished) * 100)}%` : '—'

// ---------- Overview ----------

function OverviewTab({ workspace, center, version, onOpenRun, onOpenWorkflow, onTab }: { workspace: WorkspaceSummary; center: CenterData; version: number
  onOpenRun: (id: string) => void; onOpenWorkflow: (id: string) => void; onTab: (tab: Tab) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    loadOverview(workspace.id).then(result => { if (active) setOverview(result) }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, version])
  if (!overview) return <section className="panel au-panel"><p className={error ? 'au-error' : 'au-muted'}>{error || 'Loading…'}</p></section>
  const { workflows, period } = overview
  if (!workflows.total && !overview.recent.length) return <section className="panel au-panel au-empty">
    <div className="empty"><h3>Automate the repetitive work</h3>
      <p>Workflows react to what happens in LeadFlow (a new lead, a won deal, a client’s feedback) and create tasks, notes and notifications, start reports or prepare drafts. Important decisions stay with your team: nothing sends outreach, closes deals or approves on anyone’s behalf.</p>
      <div className="au-empty-actions"><button className="primary" onClick={() => onTab('templates')}>Browse templates</button>{center.role !== 'member' && <button className="secondary" onClick={() => onTab('workflows')}>My workflows</button>}</div></div>
  </section>
  return <>
    <section className="sp-summary au-metrics" aria-label="Automation figures">
      <div><span>Workflows</span><strong>{workflows.total}</strong><small>{workflows.active} active · {workflows.paused} paused · {workflows.draft} draft</small></div>
      <div><span>Runs today</span><strong>{overview.today_runs.runs}</strong><small>{overview.today_runs.succeeded} succeeded · {overview.today_runs.failed} failed</small></div>
      <div><span>Success rate (30 days)</span><strong>{rate(period.succeeded, period.finished)}</strong><small>{period.succeeded} of {period.finished} finished runs{period.testRuns ? ` · ${period.testRuns} live tests not counted` : ''}</small></div>
      <div><span>Failed (30 days)</span><strong>{period.failed}</strong><small>{overview.failedRecent} in the last 7 days{overview.open.attention ? ` · ${overview.open.attention} need attention` : ''}</small></div>
    </section>
    <div className="au-overview">
      <section className="panel au-panel">
        <div className="section-heading"><div><h2>Needs attention</h2><p>Workflows paused for safety, throttled, or with recent failures.</p></div></div>
        {overview.attention.length ? <ul className="au-attention">{overview.attention.map(item => <li key={`${item.workflowId}:${item.code}`}>
          <div><strong>{item.name}</strong><small>{item.reason}</small></div>
          <div className="au-inline-actions"><button className="text-button" onClick={() => onOpenWorkflow(item.workflowId)}>Open</button>{item.code === 'failed_runs' && <button className="text-button" onClick={() => onTab('failed')}>View failures</button>}</div>
        </li>)}</ul> : <p className="au-muted">Nothing needs attention.</p>}
      </section>
      <section className="panel au-panel">
        <div className="section-heading"><div><h2>Last 30 days</h2><p>Live runs only.</p></div></div>
        <dl className="au-kv au-usage">
          <dt>Runs</dt><dd>{period.runs}</dd><dt>Actions run</dt><dd>{period.actions}</dd><dt>AI actions</dt><dd>{period.aiActions}</dd><dt>Steps that emailed members</dt><dd>{period.emailActions}</dd>
          <dt>Average duration</dt><dd>{duration(period.averageMs)}</dd><dt>Skipped by rate limits</dt><dd>{period.throttled}</dd><dt>Stopped by loop protection</dt><dd>{period.blocked}</dd>
          <dt>Now</dt><dd>{overview.open.queued} queued · {overview.open.waiting} waiting · {overview.open.running} running</dd>
        </dl>
      </section>
    </div>
    <section className="panel au-panel">
      <div className="section-heading"><div><h2>Recent runs</h2><p>Newest first, including live tests.</p></div><button className="text-button" onClick={() => onTab('history')}>All runs</button></div>
      {overview.recent.length ? <RunTable runs={overview.recent} center={center} onOpen={onOpenRun} /> : <p className="au-muted">No runs yet.</p>}
    </section>
  </>
}

// ---------- Workflows ----------

function WorkflowsTab({ workspace, center, version, onOpen, onChanged, onTemplates }: { workspace: WorkspaceSummary; center: CenterData; version: number
  onOpen: (id: string) => void; onChanged: (message: string) => void; onTemplates: () => void }) {
  const [items, setItems] = useState<WorkflowSummary[] | null>(null), [error, setError] = useState(''), [filter, setFilter] = useState<WorkflowStatus | 'all'>('all')
  const [deleting, setDeleting] = useState<WorkflowSummary | null>(null), [busy, setBusy] = useState(false)
  const manager = center.role !== 'member'
  useEffect(() => {
    let active = true
    listWorkflows(workspace.id).then(result => { if (active) setItems(result) }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, version])
  const act = async (work: () => Promise<unknown>, message: string) => { setBusy(true); setError(''); try { await work(); onChanged(message) } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) } }
  if (!items) return <section className="panel au-panel"><p className={error ? 'au-error' : 'au-muted'}>{error || 'Loading workflows…'}</p></section>
  const shown = items.filter(item => filter === 'all' ? item.status !== 'archived' : item.status === filter)
  return <section className="panel au-panel">
    <div className="section-heading"><div><h2>Workflows <span className="number-tag">{items.filter(item => item.status !== 'archived').length}</span></h2><p>Each runs its published version. Editing changes only the draft until you publish.</p></div>
      <select aria-label="Show" value={filter} onChange={event => setFilter(event.target.value as WorkflowStatus | 'all')}>
        <option value="all">All but archived</option><option value="active">Active</option><option value="paused">Paused</option><option value="draft">Drafts</option><option value="archived">Archived</option></select></div>
    {error && <p className="au-error" role="alert">{error}</p>}
    {!shown.length ? <div className="empty"><h3>{filter === 'all' ? 'No workflows yet' : `No ${statusLabels[filter as WorkflowStatus].toLowerCase()} workflows`}</h3><p>Start from a template, describe one with AI, or build one step by step.</p>
      <button className="primary" onClick={onTemplates}>Browse templates</button></div>
      : <ul className="au-cards">{shown.map(item => <li key={item.id} className="au-card">
        <div className="au-card-head"><StatusPill status={item.status} />{item.attention && <span className="au-pill au-pill-warning" title={item.attention.message}>Needs attention</span>}
          {item.draftChanged && item.publishedVersion && <span className="au-pill">Unpublished changes</span>}</div>
        <button className="au-card-title" onClick={() => onOpen(item.id)}><strong>{item.name}</strong><small>{triggerLabel(center, item.triggerType ?? item.draftTriggerType)}</small></button>
        {item.description && <p className="au-card-text">{item.description}</p>}
        <dl className="au-card-facts"><dt>Steps</dt><dd>{item.stepCount}</dd><dt>Version</dt><dd>{item.publishedVersion ?? '—'}</dd>
          <dt>Last run</dt><dd>{item.lastRun ? <>{when(item.lastRun.at)} · <span className={`au-run-text au-run-${item.lastRun.status}`}>{runStatusLabels[item.lastRun.status]}</span></> : 'Never'}</dd>
          <dt>Success (30 days)</dt><dd>{rate(item.stats.succeeded, item.stats.finished)} of {item.stats.finished}</dd></dl>
        {item.attention && <p className="au-card-attention">{item.attention.message}</p>}
        <div className="au-card-actions">
          <button className="secondary" onClick={() => onOpen(item.id)}>{manager ? 'Edit' : 'View'}</button>
          {manager && item.status === 'active' && <button className="text-button" disabled={busy} onClick={() => void act(() => setWorkflowStatus(workspace.id, item.id, 'paused'), `“${item.name}” paused.`)}>Pause</button>}
          {manager && item.status === 'paused' && item.publishedVersion && <button className="text-button" disabled={busy} onClick={() => void act(() => setWorkflowStatus(workspace.id, item.id, 'active'), `“${item.name}” activated.`)}>Activate</button>}
          {manager && <button className="text-button" disabled={busy} onClick={() => void act(() => duplicateWorkflow(workspace.id, item.id), `Copied “${item.name}” as a draft.`)}>Duplicate</button>}
          {manager && item.status !== 'archived' && item.publishedVersion && <button className="text-button" disabled={busy} onClick={() => void act(() => setWorkflowStatus(workspace.id, item.id, 'archived'), `“${item.name}” archived; its open runs were cancelled.`)}>Archive</button>}
          {manager && item.status === 'archived' && <button className="text-button" disabled={busy} onClick={() => void act(() => setWorkflowStatus(workspace.id, item.id, 'paused'), `“${item.name}” restored as paused.`)}>Restore</button>}
          {manager && (item.status === 'archived' || (item.status === 'draft' && !item.publishedVersion)) && <button className="text-button danger" onClick={() => setDeleting(item)}>Delete</button>}
        </div>
      </li>)}</ul>}
    {deleting && <DeleteDialog workflow={deleting} busy={busy} onClose={() => setDeleting(null)} onDelete={name => void act(() => deleteWorkflow(workspace.id, deleting.id, name), `“${deleting.name}” deleted.`).then(() => setDeleting(null))} />}
  </section>
}

function DeleteDialog({ workflow, busy, onClose, onDelete }: { workflow: WorkflowSummary; busy: boolean; onClose: () => void; onDelete: (name: string) => void }) {
  const [name, setName] = useState('')
  return <Modal title="Delete workflow?" onClose={onClose}>
    <p>This deletes “{workflow.name}”, its versions and its execution history. Records it created (tasks, notes, notifications) stay. This can’t be undone.</p>
    <label>Type the workflow’s name to confirm<input value={name} onChange={event => setName(event.target.value)} /></label>
    <div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary danger" disabled={busy || name.trim() !== workflow.name} onClick={() => onDelete(name.trim())}>Delete</button></div>
  </Modal>
}

// ---------- Templates ----------

function TemplatesTab({ workspace, center, onUse }: { workspace: WorkspaceSummary; center: CenterData; onUse: (id: string) => void }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const manager = center.role !== 'member'
  const categories = [...new Set(center.templates.map(t => t.category))]
  const stepNames = (steps: Step[]): string[] => steps.flatMap(step => step.type === 'branch' ? [`Branch: ${step.cases.map(c => c.label).join(' / ')} / Otherwise`]
    : [step.label || center.catalog.actions.find(a => a.type === (step as { action?: string }).action)?.label || step.type])
  return <section className="panel au-panel">
    <div className="section-heading"><div><h2>Starter templates</h2><p>Built only from available triggers and actions. Using one creates a draft you can change before publishing.</p></div></div>
    {error && <p className="au-error" role="alert">{error}</p>}
    {categories.map(category => <div key={category} className="au-template-group"><h3>{category}</h3>
      <ul className="au-cards">{center.templates.filter(t => t.category === category).map(template => {
        const consequential = JSON.stringify(template.definition).includes('"confirm":false')
        const ai = center.catalog.actions.some(a => a.ai && JSON.stringify(template.definition).includes(`"action":"${a.type}"`))
        return <li key={template.key} className="au-card">
          <div className="au-card-head"><span className="au-pill">{triggerLabel(center, template.trigger)}</span>{consequential && <span className="au-pill au-pill-warning">Needs your confirmation</span>}{ai && <span className="au-pill au-pill-ai">AI</span>}</div>
          <strong className="au-card-name">{template.name}</strong>
          <p className="au-card-text">{template.description}</p>
          <ol className="au-template-steps">{stepNames(template.definition.steps).map((name, index) => <li key={index}>{name}</li>)}</ol>
          {manager && <div className="au-card-actions"><button className="secondary" disabled={!!busy} onClick={async () => {
            setBusy(template.key); setError('')
            try { const created = await fromTemplate(workspace.id, template.key); onUse(created.id) } catch (cause) { setError(errorText(cause)) } finally { setBusy('') }
          }}>{busy === template.key ? 'Creating…' : 'Use template'}</button></div>}
        </li>
      })}</ul>
    </div>)}
  </section>
}

// ---------- History ----------

function RunTable({ runs, center, onOpen, onRetry, busy }: { runs: RunSummary[]; center: CenterData; onOpen: (id: string) => void; onRetry?: (run: RunSummary) => void; busy?: boolean }) {
  return <div className="au-table-wrap"><table className="au-table">
    <thead><tr><th scope="col">Workflow</th><th scope="col">Trigger</th><th scope="col">Started</th><th scope="col">Duration</th><th scope="col">Status</th><th scope="col">Failed step</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
    <tbody>{runs.map(run => <tr key={run.id}>
      <td><button className="text-button au-run-link" onClick={() => onOpen(run.id)}>{run.workflowName}</button>{run.mode === 'test' && <span className="au-pill au-pill-info">Live test</span>}</td>
      <td><span>{triggerLabel(center, run.triggerType)}</span>{run.subject && <small>{run.subject}</small>}</td>
      <td>{when(run.startedAt ?? run.createdAt)}</td>
      <td>{run.completedAt ? duration(run.durationMs) : run.nextRunAt ? `next ${when(run.nextRunAt)}` : '—'}</td>
      <td><RunPill status={run.status} />{run.outcome && !['completed', 'failed'].includes(run.outcome) && <small>{outcomeLabels[run.outcome] ?? run.outcome}</small>}</td>
      <td>{run.failedStep ? <><span>{run.failedStep}</span>{run.error && <small className="au-error-text">{run.error}</small>}</> : '—'}</td>
      <td className="au-row-actions"><button className="text-button" onClick={() => onOpen(run.id)}>View</button>
        {onRetry && ['failed', 'attention'].includes(run.status) && <button className="text-button" disabled={busy} onClick={() => onRetry(run)}>Retry</button>}</td>
    </tr>)}</tbody>
  </table></div>
}

function HistoryTab({ workspace, center, version, failed, onOpenRun, onChanged }: { workspace: WorkspaceSummary; center: CenterData; version: number; failed: boolean
  onOpenRun: (id: string) => void; onChanged: () => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null), [more, setMore] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]), [workflowId, setWorkflowId] = useState(''), [status, setStatus] = useState<RunStatus | ''>(''), [mode, setMode] = useState<'' | 'live' | 'test'>('')
  const manager = center.role !== 'member'
  const filters = { ...(workflowId ? { workflowId } : {}), ...(status && !failed ? { status } : {}), ...(mode ? { mode } : {}), ...(failed ? { failed: true } : {}) }
  const key = JSON.stringify(filters)
  useEffect(() => {
    let active = true
    listRuns(workspace.id, JSON.parse(key)).then(result => { if (active) { setRuns(result.items); setMore(result.more) } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, key, version])
  useEffect(() => { listWorkflows(workspace.id).then(setWorkflows).catch(() => {}) }, [workspace.id, version])
  const loadMore = async () => { if (!runs?.length) return; setBusy(true); try { const next = await listRuns(workspace.id, filters, runs[runs.length - 1]); setRuns([...runs, ...next.items]); setMore(next.more) } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) } }
  const retry = async (run: RunSummary) => { setBusy(true); setError(''); try { await retryRun(workspace.id, run.id); onChanged() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) } }
  return <section className="panel au-panel">
    <div className="section-heading"><div><h2>{failed ? 'Failed executions' : 'Execution history'}</h2>
      <p>{failed ? 'Runs that failed or need attention. Retry continues from the failed step; completed steps aren’t repeated.' : 'Every run, newest first. Live tests are labelled.'}</p></div>
      <div className="au-filters">
        <select aria-label="Workflow" value={workflowId} onChange={event => setWorkflowId(event.target.value)}><option value="">All workflows</option>{workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        {!failed && <select aria-label="Status" value={status} onChange={event => setStatus(event.target.value as RunStatus | '')}><option value="">Any status</option>{(Object.keys(runStatusLabels) as RunStatus[]).map(s => <option key={s} value={s}>{runStatusLabels[s]}</option>)}</select>}
        <select aria-label="Kind" value={mode} onChange={event => setMode(event.target.value as '' | 'live' | 'test')}><option value="">Live runs and tests</option><option value="live">Live runs</option><option value="test">Live tests</option></select>
      </div></div>
    {error && <p className="au-error" role="alert">{error}</p>}
    {!runs ? <p className="au-muted">Loading runs…</p> : !runs.length ? <div className="empty"><h3>{failed ? 'No failed runs' : 'No runs yet'}</h3><p>{failed ? 'Failures and runs that need attention appear here.' : 'Runs appear here when an active workflow’s trigger happens.'}</p></div>
      : <><RunTable runs={runs} center={center} onOpen={onOpenRun} onRetry={manager ? run => void retry(run) : undefined} busy={busy} />
        {more && <button className="secondary au-more" disabled={busy} onClick={() => void loadMore()}>Load more</button>}</>}
  </section>
}

// ---------- Settings ----------

function SettingsTab({ workspace, center, onChanged }: { workspace: WorkspaceSummary; center: CenterData; onChanged: (message: string) => void }) {
  const [paused, setPaused] = useState(center.settings.paused), [reason, setReason] = useState(center.settings.reason), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [config, setConfig] = useState<AutomationConfig | null>(null), [configError, setConfigError] = useState('')
  const manager = center.role !== 'member'
  useEffect(() => { automationConfig(workspace.id).then(setConfig).catch(cause => setConfigError(errorText(cause))) }, [workspace.id])
  const limits = center.catalog.limits
  return <div className="au-settings">
    <section className="panel au-panel">
      <div className="section-heading"><div><h2>Pause all automations</h2><p>While paused, events start no runs and queued runs wait. Resume to continue them.</p></div></div>
      <label className="au-check"><input type="checkbox" checked={paused} disabled={!manager} onChange={event => setPaused(event.target.checked)} />Automations are paused in this workspace</label>
      <label>Reason (shown to the team)<input maxLength={300} value={reason} disabled={!manager} onChange={event => setReason(event.target.value)} /></label>
      {error && <p className="au-error" role="alert">{error}</p>}
      {manager && <button className="primary" disabled={busy || (paused === center.settings.paused && reason === center.settings.reason)} onClick={async () => {
        setBusy(true); setError('')
        try { await saveSettings(workspace.id, paused, reason); onChanged(paused ? 'Automations paused.' : 'Automations resumed.') } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
      }}>Save</button>}
    </section>
    <section className="panel au-panel">
      <div className="section-heading"><div><h2>How automations run</h2><p>On the server, never in a browser.</p></div></div>
      <ul className="au-facts">
        <li>The automation worker runs every minute. Delays and waits are stored with their due time, so nothing is lost when services restart.</li>
        <li>Actions run with the authority of the member who published the workflow version, checked again on every action. If that member loses access, the workflow pauses with a note.</li>
        <li>Schedules and date conditions use the workspace’s time zone: <strong>{center.timezone}</strong>.</li>
        <li>Automation alerts appear in the notification center. Each member chooses whether they also arrive by email (notification settings, “automation alert”).</li>
        <li>No workflow sends outreach, marks a deal won or lost, confirms scope or approves anything on a client’s behalf.</li>
      </ul>
    </section>
    <section className="panel au-panel">
      <div className="section-heading"><div><h2>Safeguards</h2><p>Limits that keep automations predictable.</p></div></div>
      <dl className="au-kv au-usage">
        <dt>Steps per workflow</dt><dd>{limits.nodesPerWorkflow}</dd><dt>Nested branches / condition groups</dt><dd>{limits.branchDepth} / {limits.conditionDepth} levels</dd>
        <dt>Runs per workflow per hour</dt><dd>{limits.runsPerWorkflowHour}</dd><dt>Runs per workspace per hour</dt><dd>{limits.runsPerWorkspaceHour}</dd>
        <dt>Runs at once per workspace</dt><dd>{limits.concurrentRunsPerWorkspace}</dd><dt>Retries of a failing step</dt><dd>up to {limits.maxRetries}, with backoff</dd>
        <dt>Workflows triggering each other</dt><dd>stopped after {limits.chainDepth}; never itself</dd><dt>Longest run, including waits</dt><dd>{limits.maxRunDays} days</dd>
        <dt>History kept</dt><dd>{limits.runRetentionDays} days</dd>
      </dl>
    </section>
    <section className="panel au-panel">
      <div className="section-heading"><div><h2>AI assistant and webhooks</h2><p>Server configuration.</p></div></div>
      {configError ? <p className="au-muted">{configError}</p> : !config ? <p className="au-muted">Checking…</p> : <ul className="au-facts">
        <li>AI workflow drafting: <strong>{config.ai ? `available${config.model ? ` (${config.model})` : ''}` : 'needs setup (GEMINI_API_KEY)'}</strong>. Up to {config.monthlyLimit} drafts a month; drafts are never saved or published by themselves.</li>
        <li>Signed webhooks: <strong>{config.webhooks ? 'available' : 'needs setup (EMAIL_HASH_SECRET)'}</strong>. Endpoint: <code>{config.webhookUrl}</code>. Each workflow with a webhook trigger gets its own ID and signing key.</li>
      </ul>}
    </section>
  </div>
}

// ---------- AI assistant ----------

const examples = ['When a new lead is created, analyze its website. If it has relevant opportunities, generate an outreach draft and create a follow-up task for me.',
  'When a client requests changes to a deliverable, create a revision task for the deliverable’s owner and notify them by email.',
  'Every Monday at 9:00, notify owners and admins.']

function AssistantDialog({ workspace, center, onClose, onUse }: { workspace: WorkspaceSummary; center: CenterData; onClose: () => void; onUse: (draft: AiDraft) => void }) {
  const [text, setText] = useState(''), [draft, setDraft] = useState<AiDraft | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const count = (steps: Step[]): number => steps.reduce((total, step) => total + 1 + (step.type === 'branch' ? step.cases.reduce((n, c) => n + count(c.steps), 0) + count(step.otherwise.steps) : 0), 0)
  return <Modal title="Describe an automation" onClose={onClose}>
    <div className="au-assistant">
      <p>Describe what should happen in plain words. The assistant proposes a workflow using only LeadFlow’s triggers and actions; you review and edit it in the builder. Nothing is saved, published or sent until you do it.</p>
      <label htmlFor="au-describe">What should happen?</label>
      <textarea id="au-describe" rows={4} maxLength={1000} value={text} onChange={event => setText(event.target.value)} placeholder={examples[0]} />
      <div className="au-examples">{examples.map(example => <button key={example} className="au-chip" onClick={() => setText(example)}>{example.length > 60 ? `${example.slice(0, 60)}…` : example}</button>)}</div>
      {error && <p className="au-error" role="alert">{error}</p>}
      <div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || text.trim().length < 10} onClick={async () => {
          setBusy(true); setError(''); setDraft(null)
          try { setDraft(await draftWithAi(workspace.id, text.trim())) } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
        }}>{busy ? 'Drafting…' : draft ? 'Draft again' : 'Draft workflow'}</button></div>
      {draft && <div className="au-draft" aria-live="polite">
        <h3>{draft.name}</h3>
        <p>{draft.summary}</p>
        <p className="au-muted">Trigger: {triggerLabel(center, draft.definition.trigger.type || null)} · {count(draft.definition.steps)} step{count(draft.definition.steps) === 1 ? '' : 's'}</p>
        {draft.sideEffects.length > 0 && <div className="au-effects"><h4>Side effects</h4><ul>{draft.sideEffects.map((effect, index) => <li key={index}>{effect}</li>)}</ul></div>}
        {draft.unsupported.length > 0 && <div className="au-warning"><h4>Not possible in LeadFlow (left out)</h4><ul>{draft.unsupported.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
        {!draft.validation.valid && <div className="au-issues"><h4>To fix in the builder</h4><ul>{draft.validation.issues.slice(0, 8).map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></div>}
        <p className="au-help">{draft.note}</p>
        <div className="modal-actions"><button className="primary" onClick={() => onUse(draft)}>Review in builder</button></div>
      </div>}
    </div>
  </Modal>
}
