import { useMemo, useState } from 'react'
import type { Task } from '../lib/model'
import { shortDate } from '../lib/sales'
import { deliverableStatusLabels, milestoneStatusLabels, workStatusLabels, type ProjectDetail } from '../lib/projects'

type RowKind = 'project' | 'milestone' | 'deliverable' | 'task' | 'group'
type RowState = 'done' | 'overdue' | 'open'
interface Row { key: string; kind: RowKind; label: string; sub: string; start: string | null; end: string | null; state: RowState; depth: 0 | 1 | 2; status: string }
type Scale = 'auto' | 'day' | 'week' | 'month'

const dayNumber = (date: string) => { const [y, m, d] = date.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000) }
const fromDayNumber = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10)
const monthLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })

/**
 * The project's plan on a date axis: the project span, milestones (start to due), deliverables (due dates) and tasks
 * (start to due), grouped by milestone, with today marked. A clean timeline, not a scheduling engine: it shows recorded
 * dates and what each item waits for; it doesn't move dates or draw every dependency.
 */
export function ProjectTimeline({ detail, tasks }: { detail: ProjectDetail; tasks: Task[] }) {
  const [view, setView] = useState<'timeline' | 'list'>('timeline'), [scale, setScale] = useState<Scale>('auto')
  const today = detail.today
  const rows = useMemo(() => buildRows(detail, tasks), [detail, tasks])
  const dated = rows.filter(row => row.start || row.end)
  if (!dated.length) return <section className="panel pw-section"><div className="section-heading"><div><h2>Timeline</h2><p>Dates from the project, its milestones, deliverables and tasks.</p></div></div>
    <div className="empty"><h3>Nothing dated yet</h3><p>Give the project a start and target date, and add milestones, deliverables or tasks with dates to see them here.</p></div></section>
  const days = dated.flatMap(row => [row.start, row.end]).filter((date): date is string => !!date).map(dayNumber)
  const first = Math.min(...days, dayNumber(today)) - 2, last = Math.max(...days, dayNumber(today)) + 4, span = last - first + 1
  const ppd = scale === 'day' ? 28 : scale === 'week' ? 12 : scale === 'month' ? 4 : span <= 45 ? 26 : span <= 120 ? 12 : span <= 400 ? 5 : 2
  const width = span * ppd, x = (date: string) => (dayNumber(date) - first) * ppd
  const months: { label: string; left: number; width: number }[] = []
  for (let day = first; day <= last;) {
    const date = fromDayNumber(day), [y, m] = date.split('-').map(Number)
    const next = Math.min(Math.round(Date.UTC(y, m, 1) / 86400000), last + 1)
    months.push({ label: monthLabel(date), left: (day - first) * ppd, width: (next - day) * ppd }); day = next
  }
  const ticks: { label: string; left: number }[] = []
  for (let day = first; day <= last; day++) {
    const date = fromDayNumber(day), weekday = new Date(day * 86400000).getUTCDay()
    if (ppd >= 20 || (ppd >= 8 && weekday === 1)) ticks.push({ label: ppd >= 20 ? String(Number(date.slice(8))) : dayLabel(date), left: (day - first) * ppd })
  }
  const todayLeft = x(today) + ppd / 2
  return <section className="panel pw-section">
    <div className="section-heading sp-heading">
      <div><h2>Timeline</h2><p>Recorded dates from the project, its milestones, deliverables and tasks. Today is marked.</p></div>
      <div className="sp-heading-actions">
        <div className="view-toggle" role="group" aria-label="Timeline view"><button aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>Timeline</button><button aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button></div>
        {view === 'timeline' && <label className="sp-inline">Scale<select value={scale} onChange={event => setScale(event.target.value as Scale)}><option value="auto">Fit</option><option value="day">Days</option><option value="week">Weeks</option><option value="month">Months</option></select></label>}
      </div>
    </div>
    {view === 'timeline' ? <div className="pw-gantt" role="figure" aria-label={`Timeline from ${shortDate(fromDayNumber(first))} to ${shortDate(fromDayNumber(last))}`}>
      <div className="pw-gantt-legend" aria-hidden="true"><span><i className="pw-key is-open" />Outstanding</span><span><i className="pw-key is-done" />Done</span><span><i className="pw-key is-overdue" />Overdue</span><span><i className="pw-key is-today" />Today</span></div>
      <div className="pw-gantt-scroll">
        <div className="pw-gantt-grid">
          <div className="pw-gantt-row pw-gantt-axis"><div className="pw-gantt-label"><span>Plan</span></div>
            <div className="pw-gantt-track" style={{ width }}>{months.map(month => <span key={month.left} className="pw-month" style={{ left: month.left, width: month.width }}>{month.width > 40 ? month.label : ''}</span>)}
              {ticks.map(tick => <span key={tick.left} className="pw-tick" style={{ left: tick.left }}>{tick.label}</span>)}</div></div>
          {rows.map(row => <div key={row.key} className={`pw-gantt-row is-${row.kind} depth-${row.depth}`}>
            <div className="pw-gantt-label" title={row.sub ? `${row.label} — ${row.sub}` : row.label}><span>{row.label}</span>{row.sub && <small>{row.sub}</small>}</div>
            <div className="pw-gantt-track" style={{ width }}><i className="pw-today" style={{ left: todayLeft }} aria-hidden="true" />{bar(row, x, ppd)}</div>
          </div>)}
        </div>
      </div>
    </div> : <ChronologicalList rows={dated} />}
    <p className="pw-note">A simple timeline: it shows the dates your team recorded and doesn’t reschedule anything. Tasks without a start date show on their due date; dependencies appear as “after …” next to the item that waits.</p>
  </section>
}

function bar(row: Row, x: (date: string) => number, ppd: number) {
  if (row.kind === 'group') return null
  const text = `${row.label}: ${row.start && row.end && row.start !== row.end ? `${shortDate(row.start)} – ${shortDate(row.end)}` : shortDate(row.end ?? row.start)} · ${row.state === 'done' ? 'done' : row.state === 'overdue' ? 'overdue' : row.status}`
  if (!row.end && !row.start) return <span className="sr-only">{row.label}: no dates</span>
  const pointOnly = row.kind === 'deliverable' || !row.start || (row.kind === 'milestone' && row.start === row.end)
  if (pointOnly) {
    const at = x((row.end ?? row.start)!) + ppd / 2
    return <span className={`pw-diamond is-${row.kind} is-${row.state}`} style={{ left: at }} title={text}><span className="sr-only">{text}</span></span>
  }
  const left = x(row.start!), end = x(row.end ?? row.start!) + ppd
  return <span className={`pw-bar is-${row.kind} is-${row.state}`} style={{ left, width: Math.max(end - left, 4) }} title={text}><span className="sr-only">{text}</span></span>
}

function ChronologicalList({ rows }: { rows: Row[] }) {
  const items = rows.filter(row => row.kind !== 'group').map(row => ({ ...row, date: row.end ?? row.start! })).sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind))
  const kindLabel: Record<RowKind, string> = { project: 'Project', milestone: 'Milestone', deliverable: 'Deliverable', task: 'Task', group: '' }
  return <ol className="pw-chrono">{items.map(item => <li key={item.key} className={`is-${item.state}`}>
    <time dateTime={item.date}>{shortDate(item.date)}</time><span className="sp-chip">{kindLabel[item.kind]}</span>
    <span className="pw-chrono-title">{item.label}{item.sub && <small>{item.sub}</small>}</span>
    <span className={`pw-state is-${item.state}`}>{item.state === 'done' ? 'Done' : item.state === 'overdue' ? 'Overdue' : item.status}</span>
  </li>)}</ol>
}

function buildRows(detail: ProjectDetail, tasks: Task[]): Row[] {
  const today = detail.today
  const state = (done: boolean, end: string | null): RowState => done ? 'done' : end && end < today ? 'overdue' : 'open'
  const live = tasks.filter(task => !task.cancelled)
  const taskName = new Map(live.map(task => [task.id, task.notes]))
  const milestoneName = new Map(detail.milestones.map(m => [m.id, m.name]))
  const after = (ids: string[] | undefined, names: Map<string, string>) => { const list = (ids ?? []).map(id => names.get(id)).filter(Boolean); return list.length ? `after ${list.join(', ')}` : '' }
  const taskRow = (task: Task, depth: 1 | 2): Row => ({ key: `t-${task.id}`, kind: 'task', label: task.notes, sub: [after(task.dependsOn, taskName), task.completed ? '' : workStatusLabels[task.status ?? 'todo']].filter(Boolean).join(' · '),
    start: task.startDate ?? null, end: task.due, state: state(task.completed, task.due), depth, status: task.completed ? 'Completed' : workStatusLabels[task.status ?? 'todo'] })
  const rows: Row[] = [{ key: 'project', kind: 'project', label: detail.name, sub: 'Project', start: detail.startDate, end: detail.completedOn ?? detail.targetDate,
    state: state(detail.status === 'completed', detail.targetDate), depth: 0, status: detail.status.replace('_', ' ') }]
  const known = new Set(detail.milestones.map(m => m.id))
  for (const m of detail.milestones) {
    rows.push({ key: `m-${m.id}`, kind: 'milestone', label: m.name, sub: [after(m.dependsOn, milestoneName), milestoneStatusLabels[m.status]].filter(Boolean).join(' · '), start: m.startDate ?? m.dueDate, end: m.dueDate ?? m.startDate,
      state: m.status === 'cancelled' ? 'done' : state(m.status === 'completed', m.dueDate), depth: 0, status: milestoneStatusLabels[m.status] })
    for (const d of detail.deliverables.filter(item => item.milestoneId === m.id)) rows.push(deliverableRow(d, state))
    for (const task of live.filter(item => item.milestoneId === m.id).sort((a, b) => a.due.localeCompare(b.due))) rows.push(taskRow(task, 1))
  }
  const looseDeliverables = detail.deliverables.filter(d => !d.milestoneId || !known.has(d.milestoneId))
  const looseTasks = live.filter(task => !task.milestoneId || !known.has(task.milestoneId)).sort((a, b) => a.due.localeCompare(b.due))
  if (looseDeliverables.length || looseTasks.length) {
    rows.push({ key: 'loose', kind: 'group', label: 'Without a milestone', sub: '', start: null, end: null, state: 'open', depth: 0, status: '' })
    for (const d of looseDeliverables) rows.push(deliverableRow(d, state))
    for (const task of looseTasks) rows.push(taskRow(task, 1))
  }
  return rows
}
function deliverableRow(d: ProjectDetail['deliverables'][number], state: (done: boolean, end: string | null) => RowState): Row {
  return { key: `d-${d.id}`, kind: 'deliverable', label: d.title, sub: `Deliverable · ${deliverableStatusLabels[d.status]}`, start: null, end: d.dueDate, state: state(d.status === 'completed', d.dueDate), depth: 1, status: deliverableStatusLabels[d.status] }
}
