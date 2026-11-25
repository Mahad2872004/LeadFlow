import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import type { ProjectAct } from './ProjectWorkspace'
import type { WorkspaceSummary } from '../lib/backend'
import type { Task } from '../lib/model'
import { dateTime, errorText, shortDate } from '../lib/sales'
import {
  deliverableStatuses, deliverableStatusLabels, entityHistory, milestoneStatuses, milestoneStatusLabels, projectPriorities, projectPriorityLabels, removeDeliverable, removeMilestone,
  reorderMilestones, saveDeliverable, saveMilestone,
  type Deliverable, type DeliverableInput, type DeliverableStatus, type Milestone, type MilestoneInput, type MilestoneStatus, type ProjectDetail, type ProjectPriority,
} from '../lib/projects'

interface PlanningProps { workspace: WorkspaceSummary; detail: ProjectDetail; tasks: Task[]; busy: boolean; locked: boolean; act: ProjectAct }
const count = (done: number, total: number, noun: string) => total ? `${done}/${total} ${noun}${total === 1 ? '' : 's'}` : `No ${noun}s`

// ---------- Milestones ----------

/** The project's milestones in order: dates, status, linked work and what each waits for. */
export function Milestones({ workspace, detail, busy, locked, act }: PlanningProps) {
  const [editing, setEditing] = useState<MilestoneInput & { version?: number } | null>(null), [removing, setRemoving] = useState<Milestone | null>(null), [history, setHistory] = useState<Milestone | null>(null)
  const names = new Map(detail.milestones.map(m => [m.id, m.name]))
  const input = (m: Milestone): MilestoneInput => ({ id: m.id, name: m.name, description: m.description, startDate: m.startDate, dueDate: m.dueDate, status: m.status, notes: m.notes, dependsOn: m.dependsOn })
  function move(index: number, by: -1 | 1) {
    const ids = detail.milestones.map(m => m.id), target = index + by
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    void act(async () => { await reorderMilestones(workspace.id, detail.id, ids); return 'Milestones reordered.' })
  }
  return <section className="panel pw-section">
    <div className="section-heading"><div><h2>Milestones <span className="number-tag">{detail.milestones.length}</span></h2><p>The project’s phases, in order. A milestone can wait for others; LeadFlow never lets that go in a circle.</p></div>
      {!locked && <button className="primary" onClick={() => setEditing({ name: '', description: '', startDate: null, dueDate: null, status: 'upcoming', notes: '', dependsOn: [] })}><Icon name="plus" size={17} /> Add milestone</button>}</div>
    {!detail.milestones.length ? <div className="empty"><h3>No milestones yet</h3><p>Add milestones by hand, from a template (Settings), or ask the AI assistant to suggest a plan.</p></div>
      : <ol className="pw-milestones">{detail.milestones.map((m, index) => <li key={m.id} className={`is-${m.overdue ? 'overdue' : m.status}`}>
        <span className="pw-step" aria-hidden="true">{m.status === 'completed' ? '✓' : index + 1}</span>
        <div className="pw-milestone-main">
          <div className="pw-row-head"><strong>{m.name}</strong><span className={`pw-pill is-${m.status}`}>{milestoneStatusLabels[m.status]}</span>{m.overdue && <span className="pw-pill is-overdue">Overdue</span>}</div>
          <p className="sp-muted">{m.startDate || m.dueDate ? `${shortDate(m.startDate)} → ${shortDate(m.dueDate)}` : 'No dates'} · {count(m.deliverables.completed, m.deliverables.total, 'deliverable')} · {count(m.tasks.completed, m.tasks.total, 'task')}
            {m.dependsOn.length > 0 && <> · after {m.dependsOn.map(id => names.get(id) ?? 'a removed milestone').join(', ')}</>}</p>
          {m.description && <p className="sp-pre pw-desc">{m.description}</p>}
          {m.notes && <p className="sp-quote">{m.notes}</p>}
        </div>
        <div className="pw-row-actions">
          {!locked && m.status !== 'completed' && m.status !== 'cancelled' && <button className="text-button" disabled={busy} onClick={() => void act(async () => { await saveMilestone(workspace.id, detail.id, { ...input(m), status: 'completed' }, m.version); return `Milestone completed: ${m.name}` })}>Mark complete</button>}
          {!locked && <button className="text-button" onClick={() => setEditing({ ...input(m), version: m.version })}>Edit</button>}
          <button className="text-button" onClick={() => setHistory(m)}>History</button>
          {!locked && <span className="pw-move" role="group" aria-label={`Move ${m.name}`}>
            <button className="icon-button" disabled={busy || index === 0} aria-label={`Move ${m.name} up`} onClick={() => move(index, -1)}>↑</button>
            <button className="icon-button" disabled={busy || index === detail.milestones.length - 1} aria-label={`Move ${m.name} down`} onClick={() => move(index, 1)}>↓</button></span>}
          {!locked && <button className="text-button" onClick={() => setRemoving(m)}>Remove</button>}
        </div>
      </li>)}</ol>}
    {editing && <MilestoneDialog milestone={editing} others={detail.milestones.filter(m => m.id !== editing.id)} busy={busy} onClose={() => setEditing(null)}
      onSave={async value => { if (await act(async () => { await saveMilestone(workspace.id, detail.id, value, editing.version ?? null); return value.id ? 'Milestone saved.' : `Milestone added: ${value.name}` })) setEditing(null) }} />}
    {removing && <Modal title={`Remove “${removing.name}”?`} onClose={() => setRemoving(null)}>
      <p>The milestone is removed. Its {removing.deliverables.total} deliverable(s) and {removing.tasks.total} task(s) stay in the project, without a milestone. The removal is kept in the history.</p>
      <div className="modal-actions"><button className="secondary" onClick={() => setRemoving(null)}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => void act(async () => { const result = await removeMilestone(workspace.id, detail.id, removing.id); setRemoving(null); return { message: `Milestone removed: ${removing.name}`, workspaceChanged: result.workspaceChanged } })}>Remove milestone</button></div>
    </Modal>}
    {history && <HistoryDialog workspace={workspace} detail={detail} kind="milestone" id={history.id} title={history.name} onClose={() => setHistory(null)} />}
  </section>
}

function MilestoneDialog({ milestone, others, busy, onClose, onSave }: { milestone: MilestoneInput; others: Milestone[]; busy: boolean; onClose: () => void; onSave: (value: MilestoneInput) => Promise<void> }) {
  const [form, setForm] = useState(milestone)
  const toggle = (id: string) => setForm({ ...form, dependsOn: form.dependsOn.includes(id) ? form.dependsOn.filter(item => item !== id) : [...form.dependsOn, id] })
  const invalidDates = !!(form.startDate && form.dueDate && form.startDate > form.dueDate)
  return <Modal title={milestone.id ? `Edit “${milestone.name}”` : 'Add a milestone'} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); if (!invalidDates) void onSave({ ...form, name: form.name.trim() }) }}>
      <label>Name *<input required maxLength={150} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label>Description<textarea rows={2} maxLength={2000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
      <div className="sp-row sp-row-3">
        <label>Start<input type="date" value={form.startDate ?? ''} onChange={event => setForm({ ...form, startDate: event.target.value || null })} /></label>
        <label>Due<input type="date" value={form.dueDate ?? ''} min={form.startDate ?? undefined} onChange={event => setForm({ ...form, dueDate: event.target.value || null })} /></label>
        <label>Status<select value={form.status} onChange={event => setForm({ ...form, status: event.target.value as MilestoneStatus })}>{milestoneStatuses.map(status => <option key={status} value={status}>{milestoneStatusLabels[status]}</option>)}</select></label>
      </div>
      {invalidDates && <p className="sp-error" role="alert">The due date is before the start date.</p>}
      {others.length > 0 && <fieldset className="pw-checks"><legend>Waits for</legend>{others.map(m => <label key={m.id} className="cl-check-label"><input type="checkbox" checked={form.dependsOn.includes(m.id)} onChange={() => toggle(m.id)} /> {m.name}</label>)}</fieldset>}
      <label>Notes<textarea rows={2} maxLength={2000} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || invalidDates}>Save milestone</button></div>
    </form>
  </Modal>
}

// ---------- Deliverables ----------

/** What the project delivers, with internal delivery statuses. Client review and approval aren't part of M11. */
export function Deliverables({ workspace, detail, busy, locked, act, onBreakdown }: PlanningProps & { onBreakdown: (deliverable: Deliverable) => void }) {
  const [view, setView] = useState<'list' | 'status'>('list'), [milestone, setMilestone] = useState(''), [editing, setEditing] = useState<{ input: DeliverableInput; version: number | null } | null>(null)
  const [removing, setRemoving] = useState<Deliverable | null>(null), [history, setHistory] = useState<Deliverable | null>(null)
  const names = new Map(detail.milestones.map(m => [m.id, m.name]))
  const visible = detail.deliverables.filter(d => !milestone || (milestone === 'none' ? !d.milestoneId : d.milestoneId === milestone))
  const input = (d: Deliverable): DeliverableInput => ({ id: d.id, title: d.title, description: d.description, milestoneId: d.milestoneId, ownerId: d.ownerId, dueDate: d.dueDate, priority: d.priority, status: d.status, notes: d.notes, clientServiceId: d.clientServiceId })
  const setStatus = (d: Deliverable, status: DeliverableStatus) => void act(async () => { await saveDeliverable(workspace.id, detail.id, { ...input(d), status }, d.version, null); return `“${d.title}” moved to ${deliverableStatusLabels[status].toLowerCase()}.` })
  const row = (d: Deliverable) => <li key={d.id} className={d.overdue ? 'is-overdue' : `is-${d.status}`}>
    <div className="pw-deliverable-main">
      <div className="pw-row-head"><strong>{d.title}</strong><span className={`pw-pill is-${d.status}`}>{deliverableStatusLabels[d.status]}</span>{(d.priority === 'high' || d.priority === 'critical') && <span className={`pj-priority is-${d.priority}`}>{projectPriorityLabels[d.priority]}</span>}{d.overdue && <span className="pw-pill is-overdue">Overdue</span>}</div>
      <p className="sp-muted">{d.milestoneId ? names.get(d.milestoneId) ?? 'Milestone removed' : 'No milestone'} · due {shortDate(d.dueDate)} · {d.ownerName ?? 'Unassigned'} · {count(d.tasks.completed, d.tasks.total, 'task')}{d.files ? ` · ${d.files} file${d.files === 1 ? '' : 's'}` : ''}{d.serviceName ? ` · ${d.serviceName}` : ''}</p>
      {d.description && <p className="sp-pre pw-desc">{d.description}</p>}
    </div>
    <div className="pw-row-actions">
      {!locked && <select className="pw-mini-select" aria-label={`Status of ${d.title}`} value={d.status} disabled={busy} onChange={event => setStatus(d, event.target.value as DeliverableStatus)}>{deliverableStatuses.map(status => <option key={status} value={status}>{deliverableStatusLabels[status]}</option>)}</select>}
      {!locked && <button className="text-button" onClick={() => setEditing({ input: input(d), version: d.version })}>Edit</button>}
      {!locked && d.status !== 'completed' && <button className="text-button" onClick={() => onBreakdown(d)}><Icon name="spark" size={14} /> Break into tasks</button>}
      <button className="text-button" onClick={() => setHistory(d)}>History</button>
      {!locked && <button className="text-button" onClick={() => setRemoving(d)}>Remove</button>}
    </div>
  </li>
  return <section className="panel pw-section">
    <div className="section-heading sp-heading"><div><h2>Deliverables <span className="number-tag">{detail.deliverables.length}</span></h2><p>What the project produces. Statuses are internal; “Ready for client review” doesn’t send anything or ask the client to approve.</p></div>
      <div className="sp-heading-actions">
        <div className="view-toggle" role="group" aria-label="Deliverable view"><button aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button><button aria-pressed={view === 'status'} onClick={() => setView('status')}>By status</button></div>
        {!locked && <button className="primary" onClick={() => setEditing({ input: { title: '', description: '', milestoneId: null, ownerId: null, dueDate: null, priority: 'medium', status: 'not_started', notes: '', clientServiceId: null }, version: null })}><Icon name="plus" size={17} /> Add deliverable</button>}
      </div></div>
    {detail.deliverables.length > 0 && detail.milestones.length > 0 && <div className="filters"><select aria-label="Filter deliverables by milestone" value={milestone} onChange={event => setMilestone(event.target.value)}><option value="">All milestones</option>{detail.milestones.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}<option value="none">No milestone</option></select><span className="results" role="status">{visible.length} shown</span></div>}
    {!detail.deliverables.length ? <div className="empty"><h3>No deliverables yet</h3><p>List what you’ll hand over: designs, pages, reports, integrations. Progress is counted from completed deliverables.</p></div>
      : !visible.length ? <div className="empty"><p>No deliverables for this milestone.</p></div>
      : view === 'list' ? <ul className="pw-deliverables">{visible.map(row)}</ul>
      : <div className="pw-status-groups">{deliverableStatuses.map(status => { const group = visible.filter(d => d.status === status); return group.length ? <section key={status} aria-label={deliverableStatusLabels[status]}><h3>{deliverableStatusLabels[status]} <span className="number-tag">{group.length}</span></h3><ul className="pw-deliverables">{group.map(row)}</ul></section> : null })}</div>}
    {editing && <DeliverableDialog detail={detail} value={editing.input} busy={busy} onClose={() => setEditing(null)}
      onSave={async (value, requestId) => { if (await act(async () => { await saveDeliverable(workspace.id, detail.id, value, editing.version, requestId); return value.id ? 'Deliverable saved.' : `Deliverable added: ${value.title}` })) setEditing(null) }} />}
    {removing && <Modal title={`Remove “${removing.title}”?`} onClose={() => setRemoving(null)}>
      <p>The deliverable is removed. Its {removing.tasks.total} task(s) and {removing.files} file(s) stay in the project. The removal is kept in the history.</p>
      <div className="modal-actions"><button className="secondary" onClick={() => setRemoving(null)}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => void act(async () => { const result = await removeDeliverable(workspace.id, detail.id, removing.id); setRemoving(null); return { message: `Deliverable removed: ${removing.title}`, workspaceChanged: result.workspaceChanged } })}>Remove deliverable</button></div>
    </Modal>}
    {history && <HistoryDialog workspace={workspace} detail={detail} kind="deliverable" id={history.id} title={history.title} onClose={() => setHistory(null)} />}
  </section>
}

function DeliverableDialog({ detail, value, busy, onClose, onSave }: { detail: ProjectDetail; value: DeliverableInput; busy: boolean; onClose: () => void; onSave: (value: DeliverableInput, requestId: string | null) => Promise<void> }) {
  const [form, setForm] = useState(value)
  const requestId = useRef(value.id ? null : crypto.randomUUID())
  const services = detail.services.filter(s => s.status === 'confirmed' || s.id === form.clientServiceId)
  return <Modal title={value.id ? `Edit “${value.title}”` : 'Add a deliverable'} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void onSave({ ...form, title: form.title.trim() }, requestId.current) }}>
      <label>Title *<input required maxLength={200} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      <label>Description<textarea rows={3} maxLength={4000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
      <div className="sp-row">
        <label>Milestone<select value={form.milestoneId ?? ''} onChange={event => setForm({ ...form, milestoneId: event.target.value || null })}><option value="">No milestone</option>{detail.milestones.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label>Responsible<select value={form.ownerId ?? ''} onChange={event => setForm({ ...form, ownerId: event.target.value || null })}><option value="">Unassigned</option>{detail.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      </div>
      <div className="sp-row sp-row-3">
        <label>Due<input type="date" value={form.dueDate ?? ''} onChange={event => setForm({ ...form, dueDate: event.target.value || null })} /></label>
        <label>Priority<select value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value as ProjectPriority })}>{projectPriorities.map(item => <option key={item} value={item}>{projectPriorityLabels[item]}</option>)}</select></label>
        <label>Status<select value={form.status} onChange={event => setForm({ ...form, status: event.target.value as DeliverableStatus })}>{deliverableStatuses.map(status => <option key={status} value={status}>{deliverableStatusLabels[status]}</option>)}</select></label>
      </div>
      {form.status === 'ready_for_review' && <p className="sp-muted">An internal status: LeadFlow doesn’t send it to the client or collect approvals yet.</p>}
      {services.length > 0 && <label>Service<select value={form.clientServiceId ?? ''} onChange={event => setForm({ ...form, clientServiceId: event.target.value || null })}><option value="">Not tied to a service</option>{services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
      <label>Internal notes<textarea rows={2} maxLength={2000} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Save deliverable</button></div>
    </form>
  </Modal>
}

function HistoryDialog({ workspace, detail, kind, id, title, onClose }: { workspace: WorkspaceSummary; detail: ProjectDetail; kind: 'milestone' | 'deliverable'; id: string; title: string; onClose: () => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof entityHistory>> | null>(null), [error, setError] = useState('')
  useEffect(() => { let active = true; entityHistory(workspace.id, detail.id, kind, id).then(value => { if (active) setItems(value) }).catch(cause => { if (active) setError(errorText(cause)) }); return () => { active = false } }, [workspace.id, detail.id, kind, id])
  return <Modal title={`History · ${title}`} onClose={onClose}>
    {error ? <p className="sp-error" role="alert">{error}</p> : !items ? <p className="sp-muted" role="status">Loading…</p> : !items.length ? <p className="sp-muted">No changes recorded yet.</p>
      : <ol className="sp-events pw-history">{items.map(item => <li key={item.id}><span className="sp-event-icon" aria-hidden="true"><Icon name="clock" size={14} /></span><div><p>{item.summary}</p><small>{item.actorName ?? 'LeadFlow'} · <time dateTime={item.at}>{dateTime(item.at)}</time></small></div></li>)}</ol>}
  </Modal>
}
