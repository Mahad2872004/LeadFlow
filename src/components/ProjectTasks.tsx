import { useState, type DragEvent } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import {
  cancelTask, createProjectTask, createsDependencyCycle, priorities, setTaskWorkStatus, toggleTask, updateProjectTask, waitingFor, workStatuses,
  type Data, type Priority, type ProjectTaskInput, type Task, type WorkStatus,
} from '../lib/model'
import { errorText, priorityLabels, shortDate, type SalesMember } from '../lib/sales'
import { workStatusLabels, type ProjectDetail } from '../lib/projects'

type Column = WorkStatus | 'completed'
const columns: Column[] = [...workStatuses, 'completed']
type StateFilter = 'open' | 'upcoming' | 'overdue' | 'completed' | 'cancelled' | 'all'
const stateLabels: Record<StateFilter, string> = { open: 'Open', upcoming: 'Upcoming', overdue: 'Overdue', completed: 'Completed', cancelled: 'Cancelled', all: 'All tasks' }
const columnOf = (task: Task): Column => task.completed ? 'completed' : task.status ?? 'todo'

/**
 * The project's tasks: the same follow-up tasks as the rest of LeadFlow, belonging to this project and its client. They
 * save with the workspace snapshot. Dependencies are other tasks of the project and never go in a circle.
 */
export function ProjectTasks({ detail, data, day, userId, members, locked, onCommit }: {
  detail: ProjectDetail; data: Data; day: string; userId: string; members: SalesMember[]; locked: boolean; onCommit: (next: Data, message: string) => Promise<boolean>
}) {
  const [view, setView] = useState<'list' | 'board'>('list'), [state, setState] = useState<StateFilter>('open'), [assignee, setAssignee] = useState(''), [milestone, setMilestone] = useState(''), [deliverable, setDeliverable] = useState('')
  const [editing, setEditing] = useState<Task | 'new' | null>(null), [error, setError] = useState(''), [dragging, setDragging] = useState<string | null>(null)
  const tasks = data.tasks.filter(task => task.projectId === detail.id)
  const memberName = new Map(members.map(member => [member.id, member.name])), milestoneName = new Map(detail.milestones.map(m => [m.id, m.name])), deliverableName = new Map(detail.deliverables.map(d => [d.id, d.title]))
  const open = (task: Task) => !task.completed && !task.cancelled
  const matches = (task: Task, ignoreState = false) => (ignoreState || (state === 'all' ? true : state === 'open' ? open(task) : state === 'upcoming' ? open(task) && task.due >= day : state === 'overdue' ? open(task) && task.due < day
      : state === 'completed' ? task.completed : !!task.cancelled))
    && (!assignee || (assignee === 'me' ? task.assigneeId === userId : assignee === 'unassigned' ? !task.assigneeId : task.assigneeId === assignee))
    && (!milestone || (milestone === 'none' ? !task.milestoneId : task.milestoneId === milestone))
    && (!deliverable || (deliverable === 'none' ? !task.deliverableId : task.deliverableId === deliverable))
  const visible = tasks.filter(task => matches(task)).sort((a, b) => a.due.localeCompare(b.due))
  async function commit(build: () => Data, message: string) {
    setError('')
    try { return await onCommit(build(), message) } catch (cause) { setError(errorText(cause)); return false }
  }
  const move = (task: Task, column: Column) => { if (columnOf(task) !== column) void commit(() => setTaskWorkStatus(data, task.id, column), column === 'completed' ? `Task completed: ${task.notes}` : `“${task.notes}” moved to ${workStatusLabels[column].toLowerCase()}.`) }
  const filtered = !!(assignee || milestone || deliverable || state !== 'open')
  const row = (task: Task) => {
    const waits = waitingFor(task, tasks), overdue = open(task) && task.due < day
    return <li key={task.id} className={`pw-task${task.completed || task.cancelled ? ' is-done' : ''}${overdue ? ' is-overdue' : ''}`}>
      <input type="checkbox" checked={task.completed} disabled={locked || task.cancelled} aria-label={`${task.completed ? 'Reopen' : 'Complete'} ${task.notes}`}
        onChange={() => void commit(() => toggleTask(data, task.id), task.completed ? `Task reopened: ${task.notes}` : `Task completed: ${task.notes}`)} />
      <div className="pw-task-main">
        <div className="pw-row-head"><button className="pw-task-title" disabled={locked} onClick={() => setEditing(task)}>{task.notes}</button>
          {!task.completed && !task.cancelled && <span className={`pw-pill is-${task.status ?? 'todo'}`}>{workStatusLabels[task.status ?? 'todo']}</span>}{task.cancelled && <span className="pw-pill">Cancelled</span>}
          {task.priority === 'high' && <span className="pj-priority is-high">High</span>}{(task.labels ?? []).map(label => <span key={label} className="sp-chip">{label}</span>)}</div>
        <p className="sp-muted">{task.assigneeId ? memberName.get(task.assigneeId) ?? 'A former member' : 'Unassigned'}{task.deliverableId ? ` · ${deliverableName.get(task.deliverableId) ?? 'Removed deliverable'}` : ''}
          {task.estimateHours !== null && task.estimateHours !== undefined ? ` · ${Number(task.estimateHours)}h estimated` : ''}{task.actualHours !== null && task.actualHours !== undefined ? ` · ${Number(task.actualHours)}h spent` : ''}</p>
        {waits.length > 0 && open(task) && <p className="pw-waiting"><Icon name="clock" size={13} /> Waiting for: {waits.map(other => other.notes).join(', ')}</p>}
      </div>
      <span className={`pw-due${overdue ? ' is-overdue' : ''}`}>{task.startDate && task.startDate !== task.due ? `${shortDate(task.startDate)} → ` : ''}<time dateTime={task.due}>{shortDate(task.due)}</time>{overdue && <small>Overdue</small>}</span>
      {!locked && !task.completed && <button className="text-button" onClick={() => void commit(() => cancelTask(data, task.id), task.cancelled ? `Task restored: ${task.notes}` : `Task cancelled: ${task.notes}`)}>{task.cancelled ? 'Restore' : 'Cancel'}</button>}
    </li>
  }
  const groups: [string, string, Task[]][] = [...detail.milestones.map(m => [m.id, m.name, visible.filter(task => task.milestoneId === m.id)] as [string, string, Task[]]),
    ['none', 'Without a milestone', visible.filter(task => !task.milestoneId || !milestoneName.has(task.milestoneId))]]
  return <section className="panel pw-section">
    <div className="section-heading sp-heading"><div><h2>Tasks <span className="number-tag">{tasks.filter(open).length} open</span></h2><p>The project’s work, in the same task list as the rest of LeadFlow. Reminders only: nothing is sent.</p></div>
      <div className="sp-heading-actions">
        <div className="view-toggle" role="group" aria-label="Task view"><button aria-pressed={view === 'list'} onClick={() => setView('list')}><Icon name="list" size={15} />List</button><button aria-pressed={view === 'board'} onClick={() => setView('board')}><Icon name="columns" size={15} />Board</button></div>
        {!locked && <button className="primary" onClick={() => setEditing('new')}><Icon name="plus" size={17} /> Add task</button>}
      </div></div>
    <div className="filters">
      {view === 'list' && <select aria-label="Show tasks" value={state} onChange={event => setState(event.target.value as StateFilter)}>{(Object.keys(stateLabels) as StateFilter[]).map(key => <option key={key} value={key}>{stateLabels[key]}</option>)}</select>}
      <select aria-label="Filter by assignee" value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">Anyone</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select>
      {detail.milestones.length > 0 && <select aria-label="Filter by milestone" value={milestone} onChange={event => setMilestone(event.target.value)}><option value="">All milestones</option>{detail.milestones.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}<option value="none">No milestone</option></select>}
      {detail.deliverables.length > 0 && <select aria-label="Filter by deliverable" value={deliverable} onChange={event => setDeliverable(event.target.value)}><option value="">All deliverables</option>{detail.deliverables.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}<option value="none">No deliverable</option></select>}
      {view === 'list' && <span className="results" role="status">{visible.length} task{visible.length === 1 ? '' : 's'}</span>}
      {filtered && <button className="text-button" onClick={() => { setState('open'); setAssignee(''); setMilestone(''); setDeliverable('') }}>Clear filters</button>}
    </div>
    {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    {!tasks.length ? <div className="empty"><h3>No tasks yet</h3><p>Add tasks by hand, add a template’s plan in Settings, or break a deliverable into tasks.</p></div>
      : view === 'list' ? (!visible.length ? <div className="empty"><p>No tasks match these filters.</p></div>
        : <div className="pw-task-groups">{groups.filter(([, , items]) => items.length).map(([key, name, items]) => <section key={key} aria-label={name}><h3>{name} <span className="number-tag">{items.length}</span></h3><ul className="pw-tasks">{items.map(row)}</ul></section>)}</div>)
      : <div className="pw-board" role="list" aria-label="Task board">{columns.map(column => {
        const cards = tasks.filter(task => !task.cancelled && columnOf(task) === column && matches(task, true)).sort((a, b) => a.due.localeCompare(b.due))
        return <section key={column} role="listitem" className={`pw-column is-${column}${dragging ? ' is-droppable' : ''}`} aria-label={`${workStatusLabels[column]}: ${cards.length}`}
          onDragOver={(event: DragEvent) => { if (dragging && !locked) event.preventDefault() }}
          onDrop={(event: DragEvent) => { event.preventDefault(); const task = tasks.find(item => item.id === event.dataTransfer.getData('text/plain')); setDragging(null); if (task) move(task, column) }}>
          <h3>{workStatusLabels[column]} <span className="number-tag">{cards.length}</span></h3>
          <ul>{cards.map(task => { const waits = waitingFor(task, tasks), overdue = open(task) && task.due < day
            return <li key={task.id} className={`pw-card${overdue ? ' is-overdue' : ''}`} draggable={!locked} onDragStart={event => { event.dataTransfer.setData('text/plain', task.id); setDragging(task.id) }} onDragEnd={() => setDragging(null)}>
              <button className="pw-task-title" disabled={locked} onClick={() => setEditing(task)}>{task.notes}</button>
              <p className="sp-muted"><time dateTime={task.due}>{shortDate(task.due)}</time>{overdue && ' · overdue'}{task.assigneeId ? ` · ${memberName.get(task.assigneeId) ?? 'Former member'}` : ''}{task.priority === 'high' ? ' · high priority' : ''}</p>
              {waits.length > 0 && open(task) && <p className="pw-waiting">Waiting for: {waits.map(other => other.notes).join(', ')}</p>}
              {!locked && <select className="pw-mini-select" aria-label={`Move ${task.notes} to`} value={column} onChange={event => move(task, event.target.value as Column)}>{columns.map(item => <option key={item} value={item}>{workStatusLabels[item]}</option>)}</select>}
            </li> })}
            {!cards.length && <li className="pw-column-empty">No tasks</li>}</ul>
        </section> })}</div>}
    {editing && <TaskDialog task={editing === 'new' ? null : editing} detail={detail} tasks={tasks} members={members} day={day} onClose={() => setEditing(null)}
      onSave={async input => { const task = editing === 'new' ? null : editing
        const saved = await onCommit(task ? updateProjectTask(data, task.id, input) : createProjectTask(data, { id: detail.id, clientId: detail.clientId }, input), task ? `Task saved: ${input.title.trim()}` : `Task added: ${input.title.trim()}`)
        if (saved) setEditing(null) }} />}
  </section>
}

function TaskDialog({ task, detail, tasks, members, day, onClose, onSave }: { task: Task | null; detail: ProjectDetail; tasks: Task[]; members: SalesMember[]; day: string; onClose: () => void; onSave: (input: ProjectTaskInput) => Promise<void> }) {
  const [form, setForm] = useState<ProjectTaskInput>(() => task ? { title: task.notes, description: task.description ?? '', due: task.due, startDate: task.startDate ?? null, priority: task.priority ?? 'medium', status: task.status ?? 'todo',
      assigneeId: task.assigneeId ?? null, milestoneId: task.milestoneId ?? null, deliverableId: task.deliverableId ?? null, estimateHours: task.estimateHours ?? null, actualHours: task.actualHours ?? null,
      labels: task.labels ?? [], dependsOn: task.dependsOn ?? [] }
    : { title: '', description: '', due: day, startDate: null, priority: 'medium', status: 'todo', assigneeId: null, milestoneId: null, deliverableId: null, estimateHours: null, actualHours: null, labels: [], dependsOn: [] })
  const [labels, setLabels] = useState((task?.labels ?? []).join(', ')), [search, setSearch] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const id = task?.id ?? '__new__'
  const candidates = tasks.filter(other => other.id !== id && !other.cancelled && (!search.trim() || other.notes.toLowerCase().includes(search.trim().toLowerCase()) || form.dependsOn?.includes(other.id)))
  const deliverables = detail.deliverables.filter(d => !form.milestoneId || d.milestoneId === form.milestoneId || d.id === form.deliverableId)
  const hours = (value: string) => value.trim() === '' ? null : Number(value)
  async function submit() {
    setError(''); setBusy(true)
    try { await onSave({ ...form, labels: labels.split(',').map(label => label.trim()).filter(Boolean) }) } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <Modal title={task ? 'Edit task' : 'Add a task'} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void submit() }}>
      <label>Task *<input required maxLength={2000} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      <label>Description<textarea rows={2} maxLength={2000} value={form.description ?? ''} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
      <div className="sp-row">
        <label>Milestone<select value={form.milestoneId ?? ''} onChange={event => setForm({ ...form, milestoneId: event.target.value || null, deliverableId: null })}><option value="">No milestone</option>{detail.milestones.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label>Deliverable<select value={form.deliverableId ?? ''} onChange={event => { const chosen = detail.deliverables.find(d => d.id === event.target.value); setForm({ ...form, deliverableId: event.target.value || null, milestoneId: chosen?.milestoneId ?? form.milestoneId ?? null }) }}>
          <option value="">No deliverable</option>{deliverables.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
      </div>
      <div className="sp-row sp-row-3">
        <label>Assigned to<select value={form.assigneeId ?? ''} onChange={event => setForm({ ...form, assigneeId: event.target.value || null })}><option value="">Unassigned</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label>Priority<select value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value as Priority })}>{priorities.map(item => <option key={item} value={item}>{priorityLabels[item]}</option>)}</select></label>
        <label>Status<select value={form.status} onChange={event => setForm({ ...form, status: event.target.value as WorkStatus })}>{workStatuses.map(item => <option key={item} value={item}>{workStatusLabels[item]}</option>)}</select></label>
      </div>
      <div className="sp-row sp-row-3">
        <label>Start<input type="date" value={form.startDate ?? ''} max={form.due} onChange={event => setForm({ ...form, startDate: event.target.value || null })} /></label>
        <label>Due *<input type="date" required value={form.due} onChange={event => setForm({ ...form, due: event.target.value })} /></label>
        <label>Labels<input maxLength={330} value={labels} placeholder="design, copy" onChange={event => setLabels(event.target.value)} /></label>
      </div>
      <div className="sp-row">
        <label>Estimated hours<input inputMode="decimal" value={form.estimateHours ?? ''} onChange={event => setForm({ ...form, estimateHours: hours(event.target.value) })} /></label>
        <label>Hours spent<input inputMode="decimal" value={form.actualHours ?? ''} onChange={event => setForm({ ...form, actualHours: hours(event.target.value) })} /></label>
      </div>
      {tasks.filter(other => other.id !== id && !other.cancelled).length > 0 && <fieldset className="pw-checks pw-deps"><legend>Waits for</legend>
        {tasks.length > 10 && <input aria-label="Find a task" placeholder="Find a task…" value={search} onChange={event => setSearch(event.target.value)} />}
        <div className="pw-deps-list">{candidates.map(other => { const checked = !!form.dependsOn?.includes(other.id), loops = !checked && createsDependencyCycle(tasks, id, [...(form.dependsOn ?? []), other.id])
          return <label key={other.id} className={`cl-check-label${loops ? ' is-disabled' : ''}`} title={loops ? 'That task already waits for this one.' : undefined}>
            <input type="checkbox" checked={checked} disabled={loops} onChange={() => setForm({ ...form, dependsOn: checked ? form.dependsOn!.filter(item => item !== other.id) : [...(form.dependsOn ?? []), other.id] })} />
            {other.notes}{other.completed ? ' (done)' : ''}{loops ? ' — would make a loop' : ''}</label> })}</div>
        <small className="sp-muted">The task shows as waiting until these are complete. Tasks can’t wait for each other in a circle.</small></fieldset>}
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{task ? 'Save task' : 'Add task'}</button></div>
    </form>
  </Modal>
}
