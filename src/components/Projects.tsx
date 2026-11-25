import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { MetricCard } from './MetricCard'
import { HealthBadge, PriorityChip, ProgressBar, ProjectStatusChip } from './ProjectBits'
import { NewProjectDialog } from './NewProjectDialog'
import { ProjectCalendar } from './ProjectCalendar'
import { ProjectTemplates } from './ProjectTemplates'
import type { WorkspaceSummary } from '../lib/backend'
import { taskState } from '../lib/dates'
import { setTaskWorkStatus, toggleTask, waitingFor, workStatuses, type Data, type Task, type WorkStatus } from '../lib/model'
import { errorText, shortDate, dateTime, type SalesMember } from '../lib/sales'
import type { ClientIndexEntry } from '../lib/clients'
import {
  healthLabels, healthStates, listProjects, projectIndex, projectPriorities, projectPriorityLabels, projectsDashboard, projectStatuses, projectStatusLabels, projectTypeLabels, projectTypes,
  workStatusLabels, type HealthState, type ProjectFilters, type ProjectIndexEntry, type ProjectPage, type ProjectPriority, type ProjectType, type ProjectsDashboard,
} from '../lib/projects'
import './Projects.css'

export type PortfolioTab = 'overview' | 'projects' | 'my_tasks' | 'calendar' | 'templates'
const tabs: [PortfolioTab, string][] = [['overview', 'Overview'], ['projects', 'All projects'], ['my_tasks', 'My tasks'], ['calendar', 'Calendar'], ['templates', 'Templates']]
const pageSize = 25
const baseFilters: ProjectFilters = { search: '', status: 'open', health: '', clientId: '', ownerId: '', priority: '', projectType: '', sort: 'updated', direction: 'desc' }
const kindLabels = { project: 'Project target', milestone: 'Milestone', deliverable: 'Deliverable', task: 'Task' } as const

/**
 * Projects: the delivery overview, every project, the signed-in member's project tasks, a deadline calendar and
 * reusable templates. Opening a project shows its workspace (ProjectWorkspace). Every figure comes from the database.
 */
export function Projects({ workspace, data, day, userId, members, clients, version, initialTab = 'overview', onOpenProject, onOpenClient, onWorkspaceChanged, onCommit, onChanged }: {
  workspace: WorkspaceSummary; data: Data; day: string; userId: string; members: SalesMember[]; clients: ClientIndexEntry[]; version: number; initialTab?: PortfolioTab
  onOpenProject: (projectId: string) => void; onOpenClient: (clientId: string) => void; onWorkspaceChanged: () => Promise<void>
  onCommit: (next: Data, message: string) => Promise<boolean>; onChanged: (message?: string) => void
}) {
  const [tab, setTab] = useState<PortfolioTab>(initialTab), [filters, setFilters] = useState<ProjectFilters>(baseFilters), [creating, setCreating] = useState(false)
  const [taskView, setTaskView] = useState<TaskView>('open'), [created, setCreated] = useState(0)
  const reload = version + created
  const showList = (patch: Partial<ProjectFilters>) => { setFilters({ ...baseFilters, ...patch }); setTab('projects') }
  return <div className="pf-page">
    <div className="pf-toolbar">
      <div className="sp-tabs pf-tabs" role="tablist" aria-label="Projects sections">{tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
      <button className="primary" onClick={() => setCreating(true)}><Icon name="plus" size={17} /> New project</button>
    </div>
    <div key={tab} role="tabpanel" aria-label={tabs.find(([key]) => key === tab)![1]}>
      {tab === 'overview' && <Overview workspace={workspace} version={reload} onOpenProject={onOpenProject} onShow={showList} onNew={() => setCreating(true)} onTasks={view => { setTaskView(view); setTab('my_tasks') }} />}
      {tab === 'projects' && <ProjectList workspace={workspace} members={members} clients={clients} version={reload} filters={filters} onFilters={setFilters} onOpenProject={onOpenProject} onOpenClient={onOpenClient} onNew={() => setCreating(true)} />}
      {tab === 'my_tasks' && <MyTasks workspace={workspace} data={data} day={day} userId={userId} version={reload} view={taskView} onView={setTaskView} onOpenProject={onOpenProject} onCommit={onCommit} />}
      {tab === 'calendar' && <ProjectCalendar workspace={workspace} clients={clients} version={reload} onOpenProject={onOpenProject} />}
      {tab === 'templates' && <ProjectTemplates workspace={workspace} onChanged={message => onChanged(message)} />}
    </div>
    {creating && <NewProjectDialog workspace={workspace} members={members} clients={clients} start={{}} onClose={() => setCreating(false)}
      onCreated={(result, name) => { setCreating(false); setCreated(value => value + 1); if (result.workspaceChanged) void onWorkspaceChanged(); onChanged(`Project “${name}” created.`); onOpenProject(result.id) }} />}
  </div>
}

// ---------- Overview ----------

function Overview({ workspace, version, onOpenProject, onShow, onNew, onTasks }: {
  workspace: WorkspaceSummary; version: number; onOpenProject: (id: string) => void; onShow: (patch: Partial<ProjectFilters>) => void; onNew: () => void; onTasks: (view: TaskView) => void
}) {
  const [dashboard, setDashboard] = useState<ProjectsDashboard | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    projectsDashboard(workspace.id).then(value => { if (active) { setDashboard(value); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, version])
  if (error) return <p className="sp-error" role="alert">{error}</p>
  if (!dashboard) return <section className="panel"><p className="sp-loading" role="status">Loading projects…</p></section>
  if (!dashboard.total) return <section className="panel pf-empty-panel"><div className="empty">
    <h3>No projects yet</h3>
    <p>Start a project from a client’s completed onboarding, from a client’s confirmed scope, or from scratch. Projects hold the milestones, deliverables, tasks and files of the work you deliver.</p>
    <button className="primary" onClick={onNew}><Icon name="plus" size={17} /> New project</button></div></section>
  return <>
    <div className="stats pf-stats" aria-label="Projects at a glance">
      <MetricCard label="Projects" value={dashboard.total} hint={`${dashboard.byStatus.cancelled ?? 0} cancelled`} icon="grid" onClick={() => onShow({ status: 'all' })} />
      <MetricCard label="Active" value={dashboard.active} hint="Not started, in progress or at risk" icon="spark" accent onClick={() => onShow({ status: 'open' })} />
      <MetricCard label="In planning" value={dashboard.planning} hint="Being set up" icon="clipboard" onClick={() => onShow({ status: 'planning' })} />
      <MetricCard label="At risk" value={dashboard.atRisk} hint="From the health rules" icon="bell" onClick={() => onShow({ status: 'open', health: 'at_risk' })} />
      <MetricCard label="Delayed" value={dashboard.delayed} hint="Target or milestone date passed" icon="clock" onClick={() => onShow({ status: 'open', health: 'delayed' })} />
      <MetricCard label="On hold" value={dashboard.onHold} hint="Paused by the team" icon="history" onClick={() => onShow({ status: 'on_hold' })} />
      <MetricCard label="Completed" value={dashboard.completed} hint="Marked complete by the team" icon="check" onClick={() => onShow({ status: 'completed' })} />
      <MetricCard label="Overdue projects" value={dashboard.overdue} hint={`${dashboard.overdueTasks} overdue task${dashboard.overdueTasks === 1 ? '' : 's'} across projects`} icon="calendar"
        onClick={() => onShow({ status: 'open', sort: 'target', direction: 'asc' })} />
    </div>
    <div className="pf-glance">
      <section className="panel"><div className="section-heading"><div><h2>Needs attention</h2><p>Projects the health rules mark as delayed or at risk, and why.</p></div></div>
        {dashboard.attention.length ? <ul className="pf-attention">{dashboard.attention.map(item => <li key={item.projectId}>
          <button className="sp-link" onClick={() => onOpenProject(item.projectId)}>{item.name}</button>
          <HealthBadge health={{ state: item.health, reasons: item.reasons }} showReasons /></li>)}</ul>
          : <p className="pf-quiet">Nothing is delayed or at risk.</p>}
      </section>
      <section className="panel"><div className="section-heading"><div><h2>Upcoming deadlines</h2><p>Project targets, milestones and deliverables due in the next 14 days.</p></div>
        <button className="text-button" onClick={() => onTasks('upcoming')}>My upcoming tasks</button></div>
        {dashboard.upcoming.length ? <ul className="pf-deadlines">{dashboard.upcoming.map(item => <li key={`${item.kind}:${item.id}`}>
          <time dateTime={item.date}>{shortDate(item.date)}</time>
          <div><button className="sp-link" onClick={() => onOpenProject(item.projectId)}>{item.title}</button><small>{kindLabels[item.kind]}{item.kind !== 'project' ? ` · ${item.projectName}` : ''}</small></div></li>)}</ul>
          : <p className="pf-quiet">No deadlines in the next 14 days.</p>}
      </section>
    </div>
    <section className="panel"><div className="section-heading"><div><h2>Recent project activity</h2><p>The latest changes across projects. Internal notes stay inside each project.</p></div></div>
      {dashboard.recent.length ? <ol className="pf-recent">{dashboard.recent.map(item => <li key={item.id}>
        <div><p>{item.summary}</p><small><button className="sp-link" onClick={() => onOpenProject(item.projectId)}>{item.projectName}</button>{item.actorName ? ` · ${item.actorName}` : ''} · <time dateTime={item.at}>{dateTime(item.at)}</time></small></div></li>)}</ol>
        : <p className="pf-quiet">No activity yet.</p>}
    </section>
  </>
}

// ---------- All projects ----------

function ProjectList({ workspace, members, clients, version, filters, onFilters, onOpenProject, onOpenClient, onNew }: {
  workspace: WorkspaceSummary; members: SalesMember[]; clients: ClientIndexEntry[]; version: number; filters: ProjectFilters; onFilters: (filters: ProjectFilters) => void
  onOpenProject: (id: string) => void; onOpenClient: (id: string) => void; onNew: () => void
}) {
  const [offset, setOffset] = useState(0), [page, setPage] = useState<ProjectPage | null>(null), [error, setError] = useState('')
  const set = (patch: Partial<ProjectFilters>) => { onFilters({ ...filters, ...patch }); setOffset(0) }
  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      listProjects(workspace.id, { ...filters, limit: pageSize, offset }).then(value => { if (active) { setPage(value); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    }, filters.search ? 250 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [workspace.id, filters, offset, version])
  const filtered = !!(filters.search || filters.health || filters.clientId || filters.ownerId || filters.priority || filters.projectType || filters.status !== 'open')
  const header = (key: NonNullable<ProjectFilters['sort']>, label: string) => <th aria-sort={filters.sort === key ? (filters.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
    <button className="sp-sort" onClick={() => set(filters.sort === key ? { direction: filters.direction === 'asc' ? 'desc' : 'asc' } : { sort: key, direction: key === 'name' || key === 'target' ? 'asc' : 'desc' })}>{label}{filters.sort === key && <span aria-hidden="true">{filters.direction === 'asc' ? ' ↑' : ' ↓'}</span>}</button></th>
  const usable = clients.filter(client => client.status !== 'archived' || client.id === filters.clientId)
  return <section className="panel pf-panel">
    <div className="section-heading sp-heading"><div><h2>All projects {page && <span className="number-tag">{page.total}</span>}</h2><p>Status is set by your team; health and progress are calculated from recorded work.</p></div></div>
    <div className="filters pf-filters">
      <label className="search"><Icon name="search" size={18} /><input aria-label="Search projects" placeholder="Search name, client or tag…" value={filters.search ?? ''} onChange={event => set({ search: event.target.value })} /></label>
      <select aria-label="Filter by status" value={filters.status} onChange={event => set({ status: event.target.value as ProjectFilters['status'] })}>
        <option value="open">Open (not completed or cancelled)</option>{projectStatuses.map(status => <option key={status} value={status}>{projectStatusLabels[status]}</option>)}<option value="all">Everything</option></select>
      <select aria-label="Filter by health" value={filters.health} onChange={event => set({ health: event.target.value as HealthState | '' })}><option value="">Any health</option>
        {healthStates.filter(state => state !== 'completed' && state !== 'cancelled').map(state => <option key={state} value={state}>{healthLabels[state]}</option>)}</select>
      {usable.length > 0 && <select aria-label="Filter by client" value={filters.clientId} onChange={event => set({ clientId: event.target.value })}><option value="">Any client</option>{usable.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select>}
      {members.length > 1 && <select aria-label="Filter by owner" value={filters.ownerId} onChange={event => set({ ownerId: event.target.value })}><option value="">Any owner</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select>}
      <select aria-label="Filter by priority" value={filters.priority} onChange={event => set({ priority: event.target.value as ProjectPriority | '' })}><option value="">Any priority</option>{projectPriorities.map(item => <option key={item} value={item}>{projectPriorityLabels[item]}</option>)}</select>
      <select aria-label="Filter by type" value={filters.projectType} onChange={event => set({ projectType: event.target.value as ProjectType | '' })}><option value="">Any type</option>{projectTypes.map(item => <option key={item} value={item}>{projectTypeLabels[item]}</option>)}</select>
      {page && <span className="results" role="status">{page.total} project{page.total === 1 ? '' : 's'}</span>}
      {filtered && <button className="text-button" onClick={() => { onFilters(baseFilters); setOffset(0) }}>Clear filters</button>}
    </div>
    {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    {!page ? <p className="sp-loading" role="status">Loading projects…</p>
      : !page.items.length ? <div className="empty">{filtered ? <><h3>No projects match</h3><p>Try another search or filter.</p></> : <><h3>No open projects</h3><p>Create a project for a client to plan and track its delivery.</p><button className="secondary" onClick={onNew}>New project</button></>}</div>
      : <>
        <div className="sp-table-wrap"><table className="sp-table pf-table">
          <thead><tr>{header('name', 'Project')}<th>Status</th><th>Health</th><th>Progress</th>{header('target', 'Target date')}<th>Owner</th><th>Next deadline</th>{header('updated', 'Updated')}</tr></thead>
          <tbody>{page.items.map(project => <tr key={project.id}>
            <td><button className="sp-link pf-name" onClick={() => onOpenProject(project.id)}>{project.name}</button>
              <small><button className="pf-client-link" onClick={() => onOpenClient(project.clientId)}>{project.clientName}</button> · {projectTypeLabels[project.projectType]} <PriorityChip priority={project.priority} /></small></td>
            <td><ProjectStatusChip status={project.status} /></td>
            <td><HealthBadge health={project.health} /></td>
            <td><ProgressBar progress={project.progress} compact /></td>
            <td className={project.overdue ? 'is-late' : ''}>{project.status === 'completed' ? <small>Completed {shortDate(project.completedOn)}</small> : project.targetDate ? <>{shortDate(project.targetDate)}{project.overdue && <small>Overdue</small>}</> : <span className="sp-muted">Not set</span>}</td>
            <td>{project.ownerName ?? <span className="sp-muted">Unassigned</span>}</td>
            <td>{project.nextDeadline ? <>{shortDate(project.nextDeadline.date)}<small>{project.nextDeadline.title}</small></> : <span className="sp-muted">None</span>}</td>
            <td><small>{shortDate(project.updatedAt)}</small></td>
          </tr>)}</tbody>
        </table></div>
        {page.total > pageSize && <div className="sp-pager"><span>{page.offset + 1}–{Math.min(page.offset + page.items.length, page.total)} of {page.total}</span>
          <button className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous</button>
          <button className="secondary" disabled={offset + pageSize >= page.total} onClick={() => setOffset(offset + pageSize)}>Next</button></div>}
      </>}
  </section>
}

// ---------- My tasks ----------

type TaskView = 'open' | 'today' | 'overdue' | 'upcoming' | 'completed'
const taskViews: [TaskView, string][] = [['open', 'Open'], ['today', 'Due today'], ['overdue', 'Overdue'], ['upcoming', 'Upcoming'], ['completed', 'Completed']]

function MyTasks({ workspace, data, day, userId, version, view, onView, onOpenProject, onCommit }: {
  workspace: WorkspaceSummary; data: Data; day: string; userId: string; version: number; view: TaskView; onView: (view: TaskView) => void
  onOpenProject: (id: string) => void; onCommit: (next: Data, message: string) => Promise<boolean>
}) {
  const [projects, setProjects] = useState<ProjectIndexEntry[]>([]), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    projectIndex(workspace.id).then(list => { if (active) setProjects(list) }).catch(() => { /* Project names are optional here. */ })
    return () => { active = false }
  }, [workspace.id, version])
  const names = useMemo(() => new Map(projects.map(project => [project.id, project.name])), [projects])
  const mine = data.tasks.filter(task => task.projectId && task.assigneeId === userId)
  const shown = mine.filter(task => {
    const state = taskState(task, day)
    switch (view) {
      case 'completed': return task.completed
      case 'today': return state === 'Due today'
      case 'overdue': return state === 'Overdue'
      case 'upcoming': return state === 'Upcoming'
      default: return !task.completed && !task.cancelled
    }
  }).toSorted((a, b) => view === 'completed' ? (b.completedAt ?? '').localeCompare(a.completedAt ?? '') : a.due.localeCompare(b.due))
  async function commit(next: Data, message: string) { setError(''); try { await onCommit(next, message) } catch (cause) { setError(errorText(cause)) } }
  return <section className="panel pf-panel">
    <div className="section-heading sp-heading"><div><h2>My tasks</h2><p>Project tasks assigned to you, from every project. Tasks are assigned in each project’s Tasks tab.</p></div></div>
    <div className="sp-segment pf-views" role="group" aria-label="Show">{taskViews.map(([key, label]) => <button key={key} aria-pressed={view === key} onClick={() => onView(key)}>
      {label}{key !== 'completed' && key !== 'open' ? ` (${mine.filter(task => taskState(task, day) === ({ today: 'Due today', overdue: 'Overdue', upcoming: 'Upcoming' } as const)[key]).length})` : ''}</button>)}</div>
    {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    {!mine.length ? <div className="empty"><h3>No project tasks assigned to you</h3><p>When someone assigns you a task in a project, it shows here with its project and due date. You can also find all tasks on the Follow-ups page.</p></div>
      : !shown.length ? <div className="empty"><p>Nothing in this view.</p></div>
      : <ul className="pf-tasks">{shown.map(task => <MyTask key={task.id} task={task} tasks={data.tasks} day={day} project={names.get(task.projectId!) ?? 'Project'} onOpenProject={() => onOpenProject(task.projectId!)}
          onToggle={() => void commit(toggleTask(data, task.id), task.completed ? 'Task reopened.' : 'Task completed.')}
          onStatus={status => void commit(setTaskWorkStatus(data, task.id, status), `Task moved to ${workStatusLabels[status].toLowerCase()}.`)} />)}</ul>}
  </section>
}

function MyTask({ task, tasks, day, project, onOpenProject, onToggle, onStatus }: { task: Task; tasks: Task[]; day: string; project: string; onOpenProject: () => void; onToggle: () => void; onStatus: (status: WorkStatus | 'completed') => void }) {
  const state = taskState(task, day), blockers = waitingFor(task, tasks)
  return <li className={`pf-task${task.completed || task.cancelled ? ' is-done' : ''}`}>
    <input type="checkbox" checked={task.completed} disabled={task.cancelled} aria-label={`${task.completed ? 'Reopen' : 'Complete'} ${task.notes}`} onChange={onToggle} />
    <div className="pf-task-main">
      <strong>{task.notes}</strong>
      <small><button className="pf-client-link" onClick={onOpenProject}>{project}</button>{task.priority === 'high' ? ' · High priority' : ''}{task.estimateHours ? ` · ${task.estimateHours} h estimated` : ''}</small>
      {blockers.length > 0 && !task.completed && <small className="pf-blocked">Waiting for: {blockers.map(item => item.notes).join(', ')}</small>}
    </div>
    {!task.completed && !task.cancelled && <select aria-label={`Status of ${task.notes}`} value={task.status ?? 'todo'} onChange={event => onStatus(event.target.value as WorkStatus | 'completed')}>
      {workStatuses.map(status => <option key={status} value={status}>{workStatusLabels[status]}</option>)}<option value="completed">{workStatusLabels.completed}</option></select>}
    <span className={'due-date task-state ' + state.toLowerCase().replace(' ', '-')}><span>{state}</span><time dateTime={task.due}>{shortDate(task.due)}</time></span>
  </li>
}

