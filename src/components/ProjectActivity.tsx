import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import type { WorkspaceSummary } from '../lib/backend'
import { dateTime, errorText } from '../lib/sales'
import { addProjectNote, projectTimeline, timelineGroupLabels, timelineGroups, type ProjectDetail, type ProjectEvent, type ProjectTimelineGroup } from '../lib/projects'

const groupIcon: Record<ProjectTimelineGroup, IconName> = { project: 'clipboard', planning: 'columns', tasks: 'calendar', files: 'copy', notes: 'chat' }

/** Everything that happened on the project, newest first, and internal notes. Notes never reach the client. */
export function ProjectActivity({ workspace, detail, revision }: { workspace: WorkspaceSummary; detail: ProjectDetail; revision: number }) {
  const [groups, setGroups] = useState<ProjectTimelineGroup[]>([]), [items, setItems] = useState<ProjectEvent[] | null>(null), [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [added, setAdded] = useState(0)
  // One request ID per note: a retry after a lost response doesn't add it twice.
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    let active = true
    projectTimeline(workspace.id, detail.id, groups, null).then(page => { if (active) { setItems(page.items); setHasMore(page.hasMore); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, detail.id, groups, revision, added])
  async function more() {
    if (!items?.length) return
    try { const page = await projectTimeline(workspace.id, detail.id, groups, items[items.length - 1]); setItems([...items, ...page.items.filter(item => !items.some(existing => existing.id === item.id))]); setHasMore(page.hasMore) }
    catch (cause) { setError(errorText(cause)) }
  }
  async function save() {
    if (!note.trim()) return
    setBusy(true); setError('')
    try { await addProjectNote(workspace.id, detail.id, note.trim(), requestId.current); setNote(''); requestId.current = crypto.randomUUID(); setAdded(value => value + 1) }
    catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  const toggle = (group: ProjectTimelineGroup) => setGroups(current => current.includes(group) ? current.filter(item => item !== group) : [...current, group])
  return <section className="panel pw-section">
    <div className="section-heading"><div><h2>Activity</h2><p>Status and detail changes, milestones, deliverables, tasks, files and notes on {detail.name}.</p></div></div>
    <form className="sp-composer cl-note" onSubmit={event => { event.preventDefault(); void save() }}>
      <label htmlFor="project-note">Add an internal note</label>
      <textarea id="project-note" rows={3} maxLength={4000} value={note} placeholder="Decisions, blockers, context for the team…" onChange={event => setNote(event.target.value)} />
      <div className="sp-composer-foot"><span className="sp-muted">Internal: never shown to the client. Notes can’t be edited later.</span><button className="primary" disabled={busy || !note.trim()}>Add note</button></div>
    </form>
    <div className="sp-chips cl-chips" role="group" aria-label="Show">{timelineGroups.map(group => <button key={group} aria-pressed={groups.includes(group)} onClick={() => toggle(group)}>{timelineGroupLabels[group]}</button>)}
      {groups.length > 0 && <button className="text-button" onClick={() => setGroups([])}>Show everything</button>}</div>
    {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    {!items ? <p className="sp-loading" role="status">Loading activity…</p> : !items.length ? <div className="empty"><p>Nothing to show yet.</p></div>
      : <ol className="sp-events cl-events">{items.map(item => <li key={item.id} className={item.kind === 'note' ? 'is-note' : ''}>
        <span className="sp-event-icon" aria-hidden="true"><Icon name={groupIcon[item.group]} size={15} /></span>
        <div><p>{item.kind === 'note' ? <span className="sp-pre">{String(item.detail.text ?? '')}</span> : item.summary}</p>
          <small>{item.kind === 'note' ? 'Internal note · ' : ''}{item.actorName ? `${item.actorName} · ` : ''}<time dateTime={item.at}>{dateTime(item.at)}</time></small></div>
      </li>)}</ol>}
    {hasMore && <button className="secondary sp-more" onClick={() => void more()}>Show older activity</button>}
  </section>
}
