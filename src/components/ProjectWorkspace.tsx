import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { HealthBadge, PriorityChip, ProgressBar, ProjectStatusChip } from './ProjectBits'
import { ProjectTimeline } from './ProjectTimeline'
import { Deliverables, Milestones } from './ProjectPlanning'
import { ProjectTasks } from './ProjectTasks'
import { ProjectFiles } from './ProjectFiles'
import { ProjectActivity } from './ProjectActivity'
import { ProjectAssistant, type AssistantRequest } from './ProjectAssistant'
import { ProjectCollaboration } from './ProjectCollaboration'
import type { WorkspaceSummary } from '../lib/backend'
import type { Data } from '../lib/model'
import { errorText, money, shortDate, type SalesMember } from '../lib/sales'
import {
  applyPlan, briefFields, briefLabels, conflict, loadProject, loadTemplates, milestoneStatusLabels, projectPriorities, projectPriorityLabels, projectStatuses, projectStatusLabels,
  projectTypeLabels, projectTypes, saveProjectAsTemplate, setProjectStatus, templatePlan, updateProject,
  type Brief, type Plan, type ProjectDetail, type ProjectPriority, type ProjectStatus, type ProjectType, type TemplateSummary,
} from '../lib/projects'
import './ProjectWorkspace.css'

export type ProjectTab = 'overview' | 'timeline' | 'milestones' | 'deliverables' | 'tasks' | 'files' | 'activity' | 'portal' | 'settings'
const tabs: [ProjectTab, string][] = [['overview', 'Overview'], ['timeline', 'Timeline'], ['milestones', 'Milestones'], ['deliverables', 'Deliverables'], ['tasks', 'Tasks'], ['files', 'Files'], ['activity', 'Activity'], ['portal', 'Client portal'], ['settings', 'Settings']]
type ActResult = string | void | { message?: string; workspaceChanged?: boolean }
/** Runs a change, reloads the project (and the task snapshot when the server changed tasks), and reports the outcome. */
export type ProjectAct = (action: () => Promise<ActResult>) => Promise<boolean>

/**
 * One project: what was agreed, the plan (milestones, deliverables, tasks), its timeline, files and history. Project
 * records change through role-checked database functions; project tasks are the workspace's follow-up tasks and change
 * through the workspace snapshot (onCommit). Archived clients' projects are read-only.
 */
export function ProjectWorkspace({ workspace, projectId, data, day, userId, members, initialTab = 'overview', initialDeliverable = null, onBack, onCommit, onOpenClient, onOpenDeal, onWorkspaceChanged, onChanged }: {
  workspace: WorkspaceSummary; projectId: string; data: Data; day: string; userId: string; members: SalesMember[]; initialTab?: ProjectTab
  /** M12: open this deliverable's client review on the Client portal tab. */
  initialDeliverable?: string | null; onBack: () => void
  onCommit: (next: Data, message: string) => Promise<boolean>; onOpenClient: (clientId: string) => void; onOpenDeal: (dealId: string) => void
  onWorkspaceChanged: () => Promise<void>; onChanged: (message?: string) => void
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null), [tab, setTab] = useState<ProjectTab>(initialTab), [loadError, setLoadError] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const [statusDialog, setStatusDialog] = useState<ProjectStatus | null>(null), [assistant, setAssistant] = useState<AssistantRequest | null>(null)
  const load = useCallback(async () => { const next = await loadProject(workspace.id, projectId); setDetail(next); setRevision(value => value + 1); return next }, [workspace.id, projectId])
  useEffect(() => {
    let active = true
    loadProject(workspace.id, projectId).then(next => { if (active) setDetail(next) }).catch(cause => { if (active) setLoadError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, projectId])
  const act: ProjectAct = async action => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await action()
      const message = typeof result === 'string' ? result : result?.message
      if (typeof result === 'object' && result?.workspaceChanged) await onWorkspaceChanged()
      await load()
      if (message) { setNotice(message); onChanged(message) } else onChanged()
      return true
    } catch (cause) {
      setError(conflict(cause) ? 'This project changed in another window. It has been reloaded; check it and try again.' : errorText(cause))
      if (conflict(cause)) await load().catch(() => undefined)
      return false
    } finally { setBusy(false) }
  }
  // Task changes save with the workspace snapshot; progress and health are computed by the database, so reload after.
  const commitTasks = async (next: Data, message: string) => { const saved = await onCommit(next, message); if (saved) void load().catch(() => undefined); return saved }

  if (!detail) return <section className="panel"><div className="sp-loading" role="status">{loadError ? <><p className="sp-error" role="alert">{loadError}</p><button className="secondary" onClick={onBack}>Back to projects</button></> : 'Loading project…'}</div></section>
  const locked = detail.clientStatus === 'archived', manager = workspace.role !== 'member'
  const tasks = data.tasks.filter(task => task.projectId === detail.id)
  const openTasks = tasks.filter(task => !task.completed && !task.cancelled).length
  const closed = detail.status === 'completed' || detail.status === 'cancelled'
  return <div className="pw-workspace">
    <button className="text-button cl-back" onClick={onBack}><span aria-hidden="true">←</span> All projects</button>
    <section className="panel pw-head">
      <div className="pw-head-main">
        <div className="pw-head-title">
          <p className="pw-kicker"><button className="sp-link" onClick={() => onOpenClient(detail.clientId)}>{detail.clientName}</button><span aria-hidden="true"> · </span>{projectTypeLabels[detail.projectType]}</p>
          <h2>{detail.name}</h2>
          <p className="pw-head-tags"><ProjectStatusChip status={detail.status} /><PriorityChip priority={detail.priority} /><HealthBadge health={detail.health} />
            {detail.tags.map(tag => <span key={tag} className="sp-chip">{tag}</span>)}</p>
        </div>
        <div className="pw-head-actions">
          {!locked && <label className="sp-inline">Status<select value={detail.status} disabled={busy} onChange={event => setStatusDialog(event.target.value as ProjectStatus)}>
            {projectStatuses.map(status => <option key={status} value={status}>{projectStatusLabels[status]}</option>)}</select></label>}
          <div className="pw-ai-menu" role="group" aria-label="AI assistant">
            <button className="secondary" onClick={() => setAssistant({ operation: 'summary' })}><Icon name="spark" size={15} /> Summary</button>
            <button className="secondary" onClick={() => setAssistant({ operation: 'risks' })}>Risks</button>
            {!locked && !closed && <button className="secondary" onClick={() => setAssistant({ operation: 'plan' })}>Suggest a plan</button>}
          </div>
        </div>
      </div>
      <dl className="sp-facts pw-facts">
        <div className="pw-fact-wide"><dt>Progress</dt><dd><ProgressBar progress={detail.progress} /></dd></div>
        <div><dt>Owner</dt><dd>{detail.ownerName ?? 'Unassigned'}</dd></div>
        <div><dt>Start</dt><dd>{shortDate(detail.startDate)}</dd></div>
        <div><dt>{detail.completedOn ? 'Completed' : 'Target'}</dt><dd className={detail.overdue ? 'pw-late' : ''}>{shortDate(detail.completedOn ?? detail.targetDate)}{detail.overdue && <small> · overdue</small>}</dd></div>
        <div><dt>Next deadline</dt><dd>{detail.nextDeadline ? <>{shortDate(detail.nextDeadline.date)}<small>{detail.nextDeadline.title}</small></> : '—'}</dd></div>
      </dl>
      {detail.health.reasons.length > 0 && <ul className="pw-health-reasons" aria-label="Why the project has this health">{detail.health.reasons.map(reason => <li key={reason.code} className={`is-${reason.level}`}>{reason.text}</li>)}</ul>}
    </section>
    {locked && <p className="sp-caution" role="note">This project’s client is archived. The project is read-only until the client is unarchived.</p>}
    {closed && detail.statusReason && <p className="sp-caution" role="note">{projectStatusLabels[detail.status]}: {detail.statusReason}</p>}
    {notice && <p className="sp-notice" role="status">{notice}</p>}
    {error && <p className="sp-error" role="alert">{error}</p>}
    <div className="sp-tabs pw-tabs" role="tablist" aria-label="Project sections">{tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
      {label}{key === 'tasks' && openTasks > 0 && <span className="number-tag">{openTasks}</span>}{key === 'milestones' && detail.milestones.length > 0 && <span className="number-tag">{detail.milestones.length}</span>}
      {key === 'deliverables' && detail.deliverables.length > 0 && <span className="number-tag">{detail.deliverables.length}</span>}{key === 'files' && detail.documentCount > 0 && <span className="number-tag">{detail.documentCount}</span>}</button>)}</div>
    <div key={tab} className="pw-tab-body" role="tabpanel" aria-label={tabs.find(([key]) => key === tab)![1]}>
      {tab === 'overview' && <Overview workspace={workspace} detail={detail} tasks={tasks} busy={busy} locked={locked} act={act} onOpenDeal={onOpenDeal} onOpenTab={setTab} />}
      {tab === 'timeline' && <ProjectTimeline detail={detail} tasks={tasks} />}
      {tab === 'milestones' && <Milestones workspace={workspace} detail={detail} tasks={tasks} busy={busy} locked={locked} act={act} />}
      {tab === 'deliverables' && <Deliverables workspace={workspace} detail={detail} tasks={tasks} busy={busy} locked={locked} act={act} onBreakdown={deliverable => setAssistant({ operation: 'breakdown', deliverable })} />}
      {tab === 'tasks' && <ProjectTasks detail={detail} data={data} day={day} userId={userId} members={members} locked={locked} onCommit={commitTasks} />}
      {tab === 'files' && <ProjectFiles workspace={workspace} detail={detail} tasks={tasks} locked={locked} manager={manager} onChanged={message => { void load().catch(() => undefined); setNotice(message); onChanged(message) }} />}
      {tab === 'activity' && <ProjectActivity workspace={workspace} detail={detail} revision={revision} />}
      {tab === 'portal' && <ProjectCollaboration workspace={workspace} detail={detail} userId={userId} locked={locked} initialDeliverable={initialDeliverable} onChanged={message => onChanged(message)} />}
      {tab === 'settings' && <Settings workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} onStatus={setStatusDialog} />}
    </div>
    {statusDialog && <StatusDialog detail={detail} tasks={tasks} next={statusDialog} busy={busy} onClose={() => setStatusDialog(null)}
      onConfirm={async reason => { if (await act(async () => { await setProjectStatus(workspace.id, detail.id, statusDialog, detail.version, reason); return `Status changed to ${projectStatusLabels[statusDialog].toLowerCase()}.` })) setStatusDialog(null) }} />}
    {assistant && <ProjectAssistant workspace={workspace} detail={detail} request={assistant} onClose={() => setAssistant(null)}
      onApplied={async result => { setAssistant(null); await act(async () => ({ message: result.message, workspaceChanged: result.workspaceChanged })) }} />}
  </div>
}

function StatusDialog({ detail, tasks, next, busy, onClose, onConfirm }: { detail: ProjectDetail; tasks: Data['tasks']; next: ProjectStatus; busy: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const openWork = tasks.filter(task => !task.completed && !task.cancelled).length + detail.deliverables.filter(item => item.status !== 'completed').length
    + detail.milestones.filter(item => item.status !== 'completed' && item.status !== 'cancelled').length
  const needsReason = next === 'cancelled' || (next === 'completed' && openWork > 0)
  const intro = next === 'completed' ? openWork > 0 ? `${openWork} task(s), deliverable(s) or milestone(s) are still open. You can complete the project anyway with a reason, which is kept in its history.` : 'Mark the project completed? Today becomes its completion date. Nothing is sent to the client.'
    : next === 'cancelled' ? 'Cancel the project? Its plan, files and history are kept. Give a reason; it is kept in the history.'
    : next === 'on_hold' ? 'Put the project on hold? Its health shows “On hold” until it resumes.'
    : detail.status === 'completed' || detail.status === 'cancelled' ? `Reopen the project as “${projectStatusLabels[next]}”? Its completion date is cleared.` : `Change the status to “${projectStatusLabels[next]}”?`
  return <Modal title={`${projectStatusLabels[next]}: ${detail.name}`} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void onConfirm(reason.trim()) }}>
      <p className="sp-intro">{intro}</p>
      <label>{needsReason ? 'Reason *' : 'Note (optional)'}<textarea rows={3} maxLength={1000} required={needsReason} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Keep as {projectStatusLabels[detail.status].toLowerCase()}</button><button className="primary" disabled={busy || (needsReason && !reason.trim())}>Change status</button></div>
    </form>
  </Modal>
}

function Block({ title, action, children, wide = false }: { title: string; action?: ReactNode; children: ReactNode; wide?: boolean }) {
  return <section className={`pw-block${wide ? ' is-wide' : ''}`}><div className="pw-block-head"><h3>{title}</h3>{action}</div>{children}</section>
}

// ---------- Overview ----------

function Overview({ workspace, detail, tasks, busy, locked, act, onOpenDeal, onOpenTab }: { workspace: WorkspaceSummary; detail: ProjectDetail; tasks: Data['tasks']; busy: boolean; locked: boolean; act: ProjectAct; onOpenDeal: (dealId: string) => void; onOpenTab: (tab: ProjectTab) => void }) {
  return <div className="pw-overview">
    <BriefBlock workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />
    <Schedule detail={detail} tasks={tasks} onOpenTab={onOpenTab} />
    <Budget workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} onOpenDeal={onOpenDeal} />
    <People workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />
    <NotesBlock workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />
    <Block title="How progress and health are worked out" wide>
      <ul className="pw-rules">
        <li><strong>Progress</strong> counts deliverables marked Completed when the project has deliverables; otherwise tasks marked complete (cancelled tasks don’t count). Milestones are shown separately and never mixed in. It is never typed in by hand.</li>
        <li><strong>Delayed</strong> when the target date or a milestone’s due date has passed with work still open.</li>
        <li><strong>At risk</strong> when the team marked it so, a high-priority task or a deliverable is overdue, three or more tasks are overdue, work is blocked, or a milestone due within 7 days has less than half of its work done.</li>
        <li><strong>On track</strong> otherwise. On hold, completed and cancelled projects show their status. Nothing completes or changes status on its own.</li>
      </ul>
    </Block>
  </div>
}

function BriefBlock({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ProjectDetail; busy: boolean; locked: boolean; act: ProjectAct }) {
  const [editing, setEditing] = useState(false), [description, setDescription] = useState(detail.description), [brief, setBrief] = useState<Brief>(detail.brief)
  const filled = briefFields.filter(field => detail.brief[field]?.trim())
  const sourceNote = detail.source === 'onboarding' ? `Started from what was agreed when onboarding was completed${detail.completion ? ` on ${shortDate(detail.completion.completedAt)}` : ''}, then edited by your team.`
    : detail.source === 'client' ? 'Started from the client’s confirmed services and requirements, then edited by your team.' : 'Written by your team.'
  async function save() {
    const clean = Object.fromEntries(briefFields.map(field => [field, (brief[field] ?? '').trim()]).filter(([, value]) => value)) as Brief
    if (await act(async () => { await updateProject(workspace.id, detail.id, detail.version, { description: description.trim(), brief: clean }); return 'Brief saved.' })) setEditing(false)
  }
  return <Block title="Brief" wide action={!locked && !editing && <button className="text-button" onClick={() => { setDescription(detail.description); setBrief(detail.brief); setEditing(true) }}>Edit</button>}>
    {editing ? <form className="sp-form pw-brief-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <label>Description<textarea rows={3} maxLength={4000} value={description} onChange={event => setDescription(event.target.value)} /></label>
      {briefFields.map(field => <label key={field}>{briefLabels[field]}<textarea rows={field === 'scopeSummary' ? 6 : 3} maxLength={field === 'scopeSummary' ? 8000 : 4000} value={brief[field] ?? ''}
        onChange={event => setBrief({ ...brief, [field]: event.target.value })} /></label>)}
      <p className="sp-muted">The brief is your team’s working record of what was agreed. It isn’t shown to the client.</p>
      <div className="sp-actions"><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button><button className="primary" disabled={busy}>Save brief</button></div>
    </form> : <>
      {detail.description && <p className="sp-pre pw-description">{detail.description}</p>}
      {filled.length ? <dl className="pw-brief">{filled.map(field => <div key={field}><dt>{briefLabels[field]}</dt><dd className="sp-pre">{detail.brief[field]}</dd></div>)}</dl>
        : !detail.description && <p className="sp-muted">No brief yet. Add the objectives, scope, success criteria and constraints your team works to.</p>}
      <p className="pw-source">{sourceNote}{detail.template ? ` Planned from the template “${detail.template.name}”.` : ''}</p>
    </>}
  </Block>
}

function Schedule({ detail, tasks, onOpenTab }: { detail: ProjectDetail; tasks: Data['tasks']; onOpenTab: (tab: ProjectTab) => void }) {
  const today = detail.today, until = addDays(today, 14)
  const upcoming = [
    ...detail.milestones.filter(m => m.dueDate && m.status !== 'completed' && m.status !== 'cancelled' && m.dueDate <= until).map(m => ({ kind: 'Milestone', title: m.name, date: m.dueDate!, overdue: m.overdue })),
    ...detail.deliverables.filter(d => d.dueDate && d.status !== 'completed' && d.dueDate <= until).map(d => ({ kind: 'Deliverable', title: d.title, date: d.dueDate!, overdue: d.overdue })),
    ...tasks.filter(t => !t.completed && !t.cancelled && t.due <= until).map(t => ({ kind: 'Task', title: t.notes, date: t.due, overdue: t.due < today })),
  ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10)
  return <Block title="Schedule" action={<button className="text-button" onClick={() => onOpenTab('timeline')}>Open timeline</button>}>
    <dl className="sp-dl">
      <div><dt>Start</dt><dd>{shortDate(detail.startDate)}</dd></div><div><dt>Target completion</dt><dd className={detail.overdue ? 'pw-late' : ''}>{shortDate(detail.targetDate)}</dd></div>
      {detail.completedOn && <div><dt>Completed</dt><dd>{shortDate(detail.completedOn)}</dd></div>}
    </dl>
    {detail.milestones.length > 0 && <ol className="pw-strip" aria-label="Milestones">{detail.milestones.map(m => <li key={m.id} className={`is-${m.overdue ? 'overdue' : m.status}`} title={`${m.name}: ${milestoneStatusLabels[m.status]}${m.dueDate ? `, due ${shortDate(m.dueDate)}` : ''}`}>
      <span className="pw-strip-dot" aria-hidden="true" /><span className="pw-strip-name">{m.name}</span><small>{m.dueDate ? shortDate(m.dueDate) : '—'}</small></li>)}</ol>}
    <h4>Next 14 days</h4>
    {upcoming.length ? <ul className="pw-deadlines">{upcoming.map((item, index) => <li key={index} className={item.overdue ? 'is-overdue' : ''}><time dateTime={item.date}>{shortDate(item.date)}</time><span className="sp-chip">{item.kind}</span><span>{item.title}</span>{item.overdue && <small>overdue</small>}</li>)}</ul>
      : <p className="sp-muted">Nothing due in the next two weeks.</p>}
  </Block>
}

const numberOrBlank = (value: number | null) => value === null || value === undefined ? '' : String(value)
function Budget({ workspace, detail, busy, locked, act, onOpenDeal }: { workspace: WorkspaceSummary; detail: ProjectDetail; busy: boolean; locked: boolean; act: ProjectAct; onOpenDeal: (dealId: string) => void }) {
  const [editing, setEditing] = useState(false), [form, setForm] = useState({ agreedValue: numberOrBlank(detail.agreedValue), estimatedCost: numberOrBlank(detail.estimatedCost), actualCost: numberOrBlank(detail.actualCost), currency: detail.currency })
  const used = detail.agreedValue && detail.actualCost !== null ? Math.round(100 * Number(detail.actualCost) / Number(detail.agreedValue)) : null
  return <Block title="Budget" action={!locked && !editing && <button className="text-button" onClick={() => { setForm({ agreedValue: numberOrBlank(detail.agreedValue), estimatedCost: numberOrBlank(detail.estimatedCost), actualCost: numberOrBlank(detail.actualCost), currency: detail.currency }); setEditing(true) }}>Edit</button>}>
    {editing ? <form className="sp-form" onSubmit={event => { event.preventDefault(); void act(async () => { await updateProject(workspace.id, detail.id, detail.version, { agreedValue: form.agreedValue.trim() || null, estimatedCost: form.estimatedCost.trim() || null, actualCost: form.actualCost.trim() || null, currency: form.currency.trim().toUpperCase() }); setEditing(false); return 'Budget saved.' }) }}>
      <div className="sp-row"><label>Agreed value<input inputMode="decimal" value={form.agreedValue} placeholder="Not recorded" onChange={event => setForm({ ...form, agreedValue: event.target.value })} /></label>
        <label>Currency<input maxLength={3} value={form.currency} onChange={event => setForm({ ...form, currency: event.target.value.toUpperCase() })} /></label></div>
      <div className="sp-row"><label>Estimated cost<input inputMode="decimal" value={form.estimatedCost} placeholder="Not recorded" onChange={event => setForm({ ...form, estimatedCost: event.target.value })} /></label>
        <label>Actual cost to date<input inputMode="decimal" value={form.actualCost} placeholder="Not recorded" onChange={event => setForm({ ...form, actualCost: event.target.value })} /></label></div>
      <p className="sp-muted">Amounts your team records for this project. LeadFlow doesn’t calculate them, invoice or take payments.</p>
      <div className="sp-actions"><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button><button className="primary" disabled={busy}>Save budget</button></div>
    </form> : <>
      <dl className="sp-dl">
        <div><dt>Agreed value</dt><dd>{detail.agreedValue === null ? <span className="sp-muted">Not recorded</span> : money(detail.agreedValue, detail.currency)}</dd></div>
        <div><dt>Estimated cost</dt><dd>{detail.estimatedCost === null ? <span className="sp-muted">Not recorded</span> : money(detail.estimatedCost, detail.currency)}</dd></div>
        <div><dt>Actual cost (recorded)</dt><dd>{detail.actualCost === null ? <span className="sp-muted">Not recorded</span> : money(detail.actualCost, detail.currency)}</dd></div>
        <div><dt>Budget used</dt><dd>{used === null ? <span className="sp-muted">Needs an agreed value and an actual cost</span> : `${used}% of the agreed value`}</dd></div>
      </dl>
      {detail.deal && <p className="pw-source">From the deal <button className="sp-link" onClick={() => onOpenDeal(detail.deal!.id)}>{detail.deal.title}</button>: {money(detail.deal.wonValue ?? detail.deal.value, detail.deal.currency)} for the whole deal, which can cover several projects. It isn’t this project’s value.</p>}
    </>}
  </Block>
}

function People({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ProjectDetail; busy: boolean; locked: boolean; act: ProjectAct }) {
  const [editing, setEditing] = useState(false), [services, setServices] = useState<string[]>([]), [contacts, setContacts] = useState<string[]>([])
  const linkedServices = detail.services.filter(s => s.linked), linkedContacts = detail.contacts.filter(c => c.linked)
  const toggle = (list: string[], id: string) => list.includes(id) ? list.filter(item => item !== id) : [...list, id]
  return <Block title="Services and contacts" action={!locked && !editing && <button className="text-button" onClick={() => { setServices(linkedServices.map(s => s.id)); setContacts(linkedContacts.map(c => c.id)); setEditing(true) }}>Edit</button>}>
    {editing ? <form className="sp-form" onSubmit={event => { event.preventDefault(); void act(async () => { await updateProject(workspace.id, detail.id, detail.version, { serviceIds: services, contactIds: contacts }); setEditing(false); return 'Services and contacts saved.' }) }}>
      <fieldset className="pw-checks"><legend>Agreed services this project covers</legend>{detail.services.filter(s => s.status === 'confirmed').map(s => <label key={s.id} className="cl-check-label"><input type="checkbox" checked={services.includes(s.id)} onChange={() => setServices(toggle(services, s.id))} /> {s.name}</label>)}
        {!detail.services.some(s => s.status === 'confirmed') && <p className="sp-muted">The client has no confirmed services.</p>}</fieldset>
      <fieldset className="pw-checks"><legend>Client contacts on this project</legend>{detail.contacts.map(c => <label key={c.id} className="cl-check-label"><input type="checkbox" checked={contacts.includes(c.id)} onChange={() => setContacts(toggle(contacts, c.id))} /> {c.fullName}{c.isPrimary ? ' (primary)' : ''}</label>)}
        {!detail.contacts.length && <p className="sp-muted">The client has no contacts yet.</p>}</fieldset>
      <div className="sp-actions"><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button><button className="primary" disabled={busy}>Save</button></div>
    </form> : <>
      <h4>Services</h4>{linkedServices.length ? <ul className="pw-plain">{linkedServices.map(s => <li key={s.id}><strong>{s.name}</strong>{s.agreedScope && <small className="sp-pre">{s.agreedScope}</small>}</li>)}</ul> : <p className="sp-muted">No services linked.</p>}
      <h4>Contacts</h4>{linkedContacts.length ? <ul className="pw-plain">{linkedContacts.map(c => <li key={c.id}><strong>{c.fullName}</strong>{c.email && <small><a href={`mailto:${c.email}`}>{c.email}</a></small>}</li>)}</ul> : <p className="sp-muted">No contacts linked.</p>}
    </>}
  </Block>
}

function NotesBlock({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ProjectDetail; busy: boolean; locked: boolean; act: ProjectAct }) {
  const [text, setText] = useState(detail.internalNotes)
  return <Block title="Internal notes">
    <p className="sp-muted">For your team only; never shown to the client. For dated notes, use Activity.</p>
    <textarea className="cl-textarea" aria-label="Internal notes" rows={5} maxLength={8000} value={text} disabled={locked} onChange={event => setText(event.target.value)} />
    {!locked && text !== detail.internalNotes && <div className="sp-actions"><button className="secondary" onClick={() => setText(detail.internalNotes)}>Discard</button>
      <button className="primary" disabled={busy} onClick={() => void act(async () => { await updateProject(workspace.id, detail.id, detail.version, { internalNotes: text }); return 'Notes saved.' })}>Save notes</button></div>}
  </Block>
}

// ---------- Settings ----------

function Settings({ workspace, detail, busy, locked, act, onStatus }: { workspace: WorkspaceSummary; detail: ProjectDetail; busy: boolean; locked: boolean; act: ProjectAct; onStatus: (status: ProjectStatus) => void }) {
  const initial = { name: detail.name, projectType: detail.projectType, priority: detail.priority, ownerId: detail.ownerId ?? '', startDate: detail.startDate ?? '', targetDate: detail.targetDate ?? '', tags: detail.tags.join(', ') }
  const [form, setForm] = useState(initial)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  async function save() {
    const tags = form.tags.split(',').map(tag => tag.trim()).filter(Boolean)
    await act(async () => {
      await updateProject(workspace.id, detail.id, detail.version, { name: form.name.trim(), projectType: form.projectType, priority: form.priority, ownerId: form.ownerId || null,
        startDate: form.startDate || null, targetDate: form.targetDate || null, tags })
      return 'Project details saved.'
    })
  }
  return <div className="pw-settings">
    <Block title="Details">
      <form className="sp-form" onSubmit={event => { event.preventDefault(); void save() }}>
        <label>Project name *<input required maxLength={150} value={form.name} disabled={locked} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
        <div className="sp-row">
          <label>Type<select value={form.projectType} disabled={locked} onChange={event => setForm({ ...form, projectType: event.target.value as ProjectType })}>{projectTypes.map(type => <option key={type} value={type}>{projectTypeLabels[type]}</option>)}</select></label>
          <label>Priority<select value={form.priority} disabled={locked} onChange={event => setForm({ ...form, priority: event.target.value as ProjectPriority })}>{projectPriorities.map(item => <option key={item} value={item}>{projectPriorityLabels[item]}</option>)}</select></label>
        </div>
        <label>Owner<select value={form.ownerId} disabled={locked} onChange={event => setForm({ ...form, ownerId: event.target.value })}><option value="">Unassigned</option>{detail.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <div className="sp-row">
          <label>Start date<input type="date" value={form.startDate} disabled={locked} onChange={event => setForm({ ...form, startDate: event.target.value })} /></label>
          <label>Target completion<input type="date" value={form.targetDate} min={form.startDate || undefined} disabled={locked} onChange={event => setForm({ ...form, targetDate: event.target.value })} /></label>
        </div>
        <label>Tags<input maxLength={600} value={form.tags} placeholder="e.g. retainer, phase 1" disabled={locked} onChange={event => setForm({ ...form, tags: event.target.value })} /><small>Separate tags with commas.</small></label>
        {!locked && <div className="sp-actions"><button type="button" className="secondary" disabled={!dirty} onClick={() => setForm(initial)}>Discard</button><button className="primary" disabled={busy || !dirty}>Save details</button></div>}
      </form>
    </Block>
    <Block title="Status">
      <p>Currently <ProjectStatusChip status={detail.status} /> since {shortDate(detail.statusChangedAt)}.{detail.statusReason && <span className="sp-quote">{detail.statusReason}</span>}</p>
      <p className="sp-muted">Statuses are set by people. Completing with open work, and cancelling, need a reason that stays in the history.</p>
      {!locked && <div className="pw-status-buttons">{projectStatuses.filter(status => status !== detail.status).map(status => <button key={status} className="secondary" onClick={() => onStatus(status)}>{projectStatusLabels[status]}</button>)}</div>}
    </Block>
    {!locked && <TemplatePlanner workspace={workspace} detail={detail} busy={busy} act={act} />}
    {detail.canManageTemplates && <SaveAsTemplate workspace={workspace} detail={detail} busy={busy} act={act} />}
  </div>
}

/** Adds a template's milestones, deliverables and tasks, dated from the project start, after a preview. */
function TemplatePlanner({ workspace, detail, busy, act }: { workspace: WorkspaceSummary; detail: ProjectDetail; busy: boolean; act: ProjectAct }) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null), [templateId, setTemplateId] = useState(''), [startDate, setStartDate] = useState(detail.startDate ?? detail.today)
  const [plan, setPlan] = useState<(Plan & { targetDate: string | null }) | null>(null), [error, setError] = useState('')
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    let active = true
    loadTemplates(workspace.id).then(result => { if (active) { const usable = result.templates.filter(item => !item.archived); setTemplates(usable); setTemplateId(usable[0]?.id ?? '') } }).catch(cause => { if (active) { setTemplates([]); setError(errorText(cause)) } })
    return () => { active = false }
  }, [workspace.id])
  async function preview() {
    setError(''); setPlan(null)
    try { setPlan(await templatePlan(workspace.id, templateId, startDate || null)); requestId.current = crypto.randomUUID() } catch (cause) { setError(errorText(cause)) }
  }
  return <Block title="Add milestones from a template">
    <p className="sp-muted">Adds the template’s milestones, deliverables and tasks, dated from the start date you choose. Existing work stays as it is.</p>
    {templates === null ? <p className="sp-muted">Loading templates…</p> : !templates.length ? <p className="sp-muted">No templates yet. Create them under Projects → Templates.</p> : <>
      <div className="sp-row"><label className="pw-field">Template<select value={templateId} onChange={event => { setTemplateId(event.target.value); setPlan(null) }}>{templates.map(item => <option key={item.id} value={item.id}>{item.name} ({item.milestoneCount} milestones)</option>)}</select></label>
        <label className="pw-field">Start from<input type="date" value={startDate} onChange={event => { setStartDate(event.target.value); setPlan(null) }} /></label></div>
      <div className="sp-actions"><button className="secondary" disabled={!templateId} onClick={() => void preview()}>Preview</button></div>
    </>}
    {error && <p className="sp-error" role="alert">{error}</p>}
    {plan && <div className="pw-plan-preview">
      <p>{plan.milestones.length} milestones, {plan.deliverables.length} deliverables and {plan.tasks.length} tasks, from {shortDate(startDate)} to {shortDate(plan.targetDate)}.</p>
      <ol className="pw-plain">{plan.milestones.map(m => <li key={m.ref}><strong>{m.name}</strong> <small>{shortDate(m.startDate ?? null)} – {shortDate(m.dueDate ?? null)} · {plan.deliverables.filter(d => d.milestoneRef === m.ref).length} deliverables, {plan.tasks.filter(t => t.milestoneRef === m.ref).length} tasks</small></li>)}</ol>
      <div className="sp-actions"><button className="secondary" onClick={() => setPlan(null)}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => void act(async () => { const result = await applyPlan(workspace.id, detail.id, plan, 'template', requestId.current); setPlan(null)
          return { message: result.repeated ? 'This plan was already added.' : `Added ${result.milestones} milestones, ${result.deliverables} deliverables and ${result.tasks} tasks.`, workspaceChanged: result.workspaceChanged } })}>Add to the project</button></div>
    </div>}
  </Block>
}

function SaveAsTemplate({ workspace, detail, busy, act }: { workspace: WorkspaceSummary; detail: ProjectDetail; busy: boolean; act: ProjectAct }) {
  const [name, setName] = useState(`${detail.name} template`), [requestId, setRequestId] = useState(() => crypto.randomUUID())
  return <Block title="Save as a template">
    <p className="sp-muted">Reuse this project’s milestones, deliverables and tasks for other clients. Dates become days after the start; names, clients and files aren’t copied.</p>
    <form className="pw-inline-form" onSubmit={event => { event.preventDefault(); void act(async () => { await saveProjectAsTemplate(workspace.id, detail.id, name.trim(), requestId); setRequestId(crypto.randomUUID()); return `Template “${name.trim()}” saved.` }) }}>
      <label className="pw-field">Template name<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
      <button className="secondary" disabled={busy || !name.trim()}>Save as template</button>
    </form>
  </Block>
}

function addDays(date: string, days: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }
