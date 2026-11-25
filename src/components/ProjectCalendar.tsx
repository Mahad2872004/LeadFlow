import { useEffect, useMemo, useState } from 'react'
import { localDate } from '../lib/dates'
import type { WorkspaceSummary } from '../lib/backend'
import type { ClientIndexEntry } from '../lib/clients'
import { errorText, shortDate } from '../lib/sales'
import { projectCalendar, projectIndex, type CalendarItem, type ProjectIndexEntry } from '../lib/projects'

type Kind = CalendarItem['kind']
const kinds: Kind[] = ['project', 'milestone', 'deliverable', 'task']
const kindLabels: Record<Kind, string> = { project: 'Project targets', milestone: 'Milestones', deliverable: 'Deliverables', task: 'Tasks' }
const kindShort: Record<Kind, string> = { project: 'Target', milestone: 'Milestone', deliverable: 'Deliverable', task: 'Task' }
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Calendar dates are local YYYY-MM-DD strings built from local date parts; never via toISOString.
const parse = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d) }
const addDays = (iso: string, days: number) => { const date = parse(iso); date.setDate(date.getDate() + days); return localDate(date) }
const mondayOf = (iso: string) => { const date = parse(iso); return addDays(iso, -((date.getDay() + 6) % 7)) }
const monthLabel = (iso: string) => parse(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
function useNarrow() {
  const query = '(max-width: 640px)'
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches)
  useEffect(() => {
    const list = window.matchMedia?.(query); if (!list) return
    const change = () => setNarrow(list.matches)
    list.addEventListener('change', change); return () => list.removeEventListener('change', change)
  }, [])
  return narrow
}

/**
 * Every project deadline in one place: project targets, milestones, deliverables and project tasks, by month or week,
 * with filters. Dates come from the database; nothing here is synced to an outside calendar.
 */
export function ProjectCalendar({ workspace, clients, version, onOpenProject }: { workspace: WorkspaceSummary; clients: ClientIndexEntry[]; version: number; onOpenProject: (projectId: string) => void }) {
  const today = localDate()
  const [mode, setMode] = useState<'month' | 'week'>('month'), [anchor, setAnchor] = useState(today)
  const [clientId, setClientId] = useState(''), [projectId, setProjectId] = useState(''), [state, setState] = useState<'open' | 'done' | 'all'>('all'), [shown, setShown] = useState<Kind[]>(kinds)
  const [loaded, setLoaded] = useState<{ key: string; items: CalendarItem[] } | null>(null), [upcoming, setUpcoming] = useState<CalendarItem[] | null>(null), [projects, setProjects] = useState<ProjectIndexEntry[]>([])
  const [error, setError] = useState(''), [expanded, setExpanded] = useState<string | null>(null)
  const narrow = useNarrow()
  const [year, month] = anchor.split('-').map(Number)
  const first = `${year}-${String(month).padStart(2, '0')}-01`
  const start = mode === 'month' ? mondayOf(first) : mondayOf(anchor)
  const days = useMemo(() => {
    if (mode === 'week') return Array.from({ length: 7 }, (_, index) => addDays(start, index))
    const last = localDate(new Date(year, month, 0)), end = addDays(mondayOf(last), 6)
    const list: string[] = []
    for (let day = start; day <= end; day = addDays(day, 1)) list.push(day)
    return list
  }, [mode, start, year, month])
  const from = days[0], to = days[days.length - 1]
  const filters = useMemo(() => ({ clientId: clientId || undefined, projectId: projectId || undefined, state, kinds: shown.length === kinds.length ? undefined : shown }), [clientId, projectId, state, shown])
  useEffect(() => {
    let active = true
    projectIndex(workspace.id).then(list => { if (active) setProjects(list) }).catch(() => { /* The project filter is optional. */ })
    return () => { active = false }
  }, [workspace.id, version])
  // Results are kept with the range and filters they answer, so a stale range never shows while the next one loads.
  const rangeKey = JSON.stringify([from, to, filters, version])
  const items = loaded?.key === rangeKey ? loaded.items : null
  useEffect(() => {
    let active = true
    projectCalendar(workspace.id, from, to, filters).then(result => { if (active) { setLoaded({ key: rangeKey, items: result.items }); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, from, to, filters, rangeKey])
  useEffect(() => {
    let active = true
    projectCalendar(workspace.id, today, addDays(today, 30), { ...filters, state: 'open' }).then(result => { if (active) setUpcoming(result.items) }).catch(() => { if (active) setUpcoming([]) })
    return () => { active = false }
  }, [workspace.id, today, filters, version])
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>()
    for (const item of items ?? []) map.set(item.date, [...(map.get(item.date) ?? []), item])
    return map
  }, [items])
  const step = (direction: number) => setAnchor(mode === 'month' ? localDate(new Date(year, month - 1 + direction, 1)) : addDays(anchor, 7 * direction))
  const visibleProjects = projects.filter(project => !clientId || project.clientId === clientId)
  const label = mode === 'month' ? monthLabel(first) : `${shortDate(days[0])} – ${shortDate(days[6])}`
  const chip = (item: CalendarItem) => <button key={`${item.kind}:${item.id}`} className={`pf-cal-item is-${item.kind}${item.done ? ' is-done' : ''}${item.overdue ? ' is-overdue' : ''}`}
    title={`${kindShort[item.kind]}: ${item.title} · ${item.projectName}${item.overdue ? ' · overdue' : item.done ? ' · done' : ''}`} onClick={() => onOpenProject(item.projectId)}>
    <i aria-hidden="true" /><span>{item.title}</span><span className="sr-only">, {kindShort[item.kind]} in {item.projectName}{item.overdue ? ', overdue' : item.done ? ', done' : ''}</span></button>
  return <div className="pf-calendar-layout">
    <section className="panel pf-panel">
      <div className="pf-cal-head">
        <div className="pf-cal-nav">
          <button className="secondary" aria-label={mode === 'month' ? 'Previous month' : 'Previous week'} onClick={() => step(-1)}>‹</button>
          <button className="secondary" onClick={() => setAnchor(today)}>Today</button>
          <button className="secondary" aria-label={mode === 'month' ? 'Next month' : 'Next week'} onClick={() => step(1)}>›</button>
          <h2 aria-live="polite">{label}</h2>
        </div>
        <div className="sp-segment pf-mode" role="group" aria-label="Calendar view">
          <button aria-pressed={mode === 'month'} onClick={() => setMode('month')}>Month</button><button aria-pressed={mode === 'week'} onClick={() => setMode('week')}>Week</button></div>
      </div>
      <div className="filters pf-filters">
        <select aria-label="Filter by client" value={clientId} onChange={event => { setClientId(event.target.value); setProjectId('') }}><option value="">Any client</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select>
        <select aria-label="Filter by project" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Any project</option>{visibleProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <select aria-label="Filter by state" value={state} onChange={event => setState(event.target.value as typeof state)}><option value="all">Open and done</option><option value="open">Open only</option><option value="done">Done only</option></select>
        <div className="sp-chips pf-kinds" role="group" aria-label="Show">{kinds.map(kind => <button key={kind} aria-pressed={shown.includes(kind)} className={`is-${kind}`}
          onClick={() => setShown(current => current.includes(kind) ? (current.length > 1 ? current.filter(item => item !== kind) : current) : [...current, kind])}>{kindLabels[kind]}</button>)}</div>
      </div>
      {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
      {!items ? <p className="sp-loading" role="status">Loading deadlines…</p> : narrow ? <ol className="pf-agenda">{days.filter(day => byDay.has(day)).map(day => <li key={day}>
          <h3 className={day === today ? 'is-today' : ''}><time dateTime={day}>{parse(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</time></h3>
          <div>{byDay.get(day)!.map(chip)}</div></li>)}
          {!days.some(day => byDay.has(day)) && <li className="pf-quiet">No deadlines in this {mode}.</li>}</ol>
        : <div className={`pf-cal-grid is-${mode}`} role="table" aria-label={label}>
          <div className="pf-cal-row" role="row">{weekdays.map(day => <span key={day} className="pf-cal-weekday" role="columnheader">{day}</span>)}</div>
          {Array.from({ length: days.length / 7 }, (_, week) => <div key={week} className="pf-cal-row" role="row">{days.slice(week * 7, week * 7 + 7).map(day => {
            const list = byDay.get(day) ?? [], open = expanded === day, limit = mode === 'week' ? 12 : 3
            return <div key={day} role="cell" className={`pf-cal-cell${day.slice(0, 7) !== first.slice(0, 7) && mode === 'month' ? ' is-outside' : ''}${day === today ? ' is-today' : ''}`}>
              <span className="pf-cal-day"><time dateTime={day}>{Number(day.slice(8))}</time></span>
              {(open ? list : list.slice(0, limit)).map(chip)}
              {list.length > limit && <button className="pf-cal-more" onClick={() => setExpanded(open ? null : day)}>{open ? 'Show less' : `+${list.length - limit} more`}</button>}
            </div>
          })}</div>)}
        </div>}
      <p className="pf-legend">{kinds.map(kind => <span key={kind} className={`is-${kind}`}><i aria-hidden="true" />{kindShort[kind]}</span>)}<span className="is-overdue-key">Overdue items are marked in red; done items are struck through.</span></p>
    </section>
    <aside className="panel pf-panel pf-upcoming" aria-label="Upcoming deadlines">
      <div className="section-heading"><div><h2>Upcoming</h2><p>Open deadlines in the next 30 days.</p></div></div>
      {!upcoming ? <p className="sp-loading" role="status">Loading…</p> : !upcoming.length ? <p className="pf-quiet">Nothing due in the next 30 days.</p>
        : <ul className="pf-deadlines">{upcoming.slice(0, 20).map(item => <li key={`${item.kind}:${item.id}`}>
          <time dateTime={item.date}>{shortDate(item.date)}</time>
          <div><button className="sp-link" onClick={() => onOpenProject(item.projectId)}>{item.title}</button><small>{kindShort[item.kind]}{item.kind !== 'project' ? ` · ${item.projectName}` : ''} · {item.clientName}</small></div></li>)}</ul>}
    </aside>
  </div>
}
