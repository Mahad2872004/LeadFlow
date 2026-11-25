import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import type { WorkspaceSummary } from '../lib/backend'
import { describeEvent } from '../lib/onboarding'
import { dateTime, errorText } from '../lib/sales'
import { addClientNote, clientTimeline, timelineGroupLabels, timelineGroups, timelineText, type ClientDetail, type ClientTimelineGroup, type TimelineEvent } from '../lib/clients'

const groupIcon: Record<ClientTimelineGroup, IconName> = { client: 'users', onboarding: 'clipboard', scope: 'check', documents: 'copy', tasks: 'calendar', notes: 'chat' }
const describe = (event: TimelineEvent) => timelineText(event, (kind, detail, itemTitle) => describeEvent({ id: 0, kind, actorType: event.actorType, actorName: event.actorName ?? '', itemId: null, itemTitle, detail, at: event.at }))

/** Everything that happened with this client, newest first, and internal notes. Notes are never shown to the client. */
export function ClientActivity({ workspace, detail, revision }: { workspace: WorkspaceSummary; detail: ClientDetail; revision: number }) {
  const [groups, setGroups] = useState<ClientTimelineGroup[]>([]), [items, setItems] = useState<TimelineEvent[] | null>(null), [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [added, setAdded] = useState(0)
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    let active = true
    clientTimeline(workspace.id, detail.id, groups, null).then(page => { if (active) { setItems(page.items); setHasMore(page.hasMore); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, detail.id, groups, revision, added])
  async function more() {
    if (!items?.length) return
    try { const page = await clientTimeline(workspace.id, detail.id, groups, items[items.length - 1]); setItems([...items, ...page.items.filter(item => !items.some(existing => existing.id === item.id))]); setHasMore(page.hasMore) }
    catch (cause) { setError(errorText(cause)) }
  }
  async function save() {
    if (!note.trim()) return
    setBusy(true); setError('')
    // One request ID per note: a retry after a lost response doesn't add it twice.
    try { await addClientNote(workspace.id, detail.id, note.trim(), requestId.current); setNote(''); requestId.current = crypto.randomUUID(); setAdded(value => value + 1) }
    catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  const toggle = (group: ClientTimelineGroup) => setGroups(current => current.includes(group) ? current.filter(item => item !== group) : [...current, group])
  return <section className="panel cl-section">
    <div className="section-heading"><div><h2>Activity &amp; notes</h2><p>Everything that happened with {detail.name}: changes, onboarding, scope, files and tasks.</p></div></div>
    <form className="sp-composer cl-note" onSubmit={event => { event.preventDefault(); void save() }}>
      <label htmlFor="client-note">Add an internal note</label>
      <textarea id="client-note" rows={3} maxLength={4000} value={note} placeholder="Call notes, decisions, context for your team…" onChange={event => setNote(event.target.value)} />
      <div className="sp-composer-foot"><span className="sp-muted">Only your team sees notes. They can’t be edited later.</span><button className="primary" disabled={busy || !note.trim()}>Add note</button></div>
    </form>
    <div className="sp-chips cl-chips" role="group" aria-label="Show">{timelineGroups.map(group => <button key={group} aria-pressed={groups.includes(group)} onClick={() => toggle(group)}>{timelineGroupLabels[group]}</button>)}
      {groups.length > 0 && <button className="text-button" onClick={() => setGroups([])}>Show everything</button>}</div>
    {error && <p className="sp-error" role="alert">{error}</p>}
    {!items ? <p className="sp-loading" role="status">Loading activity…</p> : !items.length ? <div className="empty"><p>Nothing to show yet.</p></div>
      : <ol className="sp-events cl-events">{items.map(item => <li key={item.id} className={item.kind === 'note' ? 'is-note' : ''}>
        <span className="sp-event-icon" aria-hidden="true"><Icon name={groupIcon[item.group]} size={15} /></span>
        <div><p>{item.kind === 'note' ? <span className="sp-pre">{String(item.detail.text ?? '')}</span> : describe(item)}</p>
          <small>{item.kind === 'note' ? 'Internal note · ' : ''}{item.actorName ?? (item.source === 'task' ? 'Task' : '')}{item.actorName || item.source === 'task' ? ' · ' : ''}<time dateTime={item.at}>{dateTime(item.at)}</time></small></div>
      </li>)}</ol>}
    {hasMore && <button className="secondary sp-more" onClick={() => void more()}>Show older activity</button>}
  </section>
}
