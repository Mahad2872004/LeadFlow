import { useEffect, useState } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { errorText, shortDate } from '../lib/sales'
import { collabQueue, collabTime, decisionLabels, type CollabQueue, type QueueItem } from '../lib/collaboration'
import { ReviewChip } from './CollabBits'
import './ProjectCollaboration.css'

type Filter = 'awaiting' | 'changes_requested' | 'approved' | 'rejected' | 'messages' | 'pending'
const filters: [Filter, string][] = [['awaiting', 'Awaiting client review'], ['changes_requested', 'Changes requested'], ['approved', 'Approved'], ['rejected', 'Rejected'],
  ['messages', 'Unread client messages'], ['pending', 'Pending client actions']]
const pick = (item: QueueItem, filter: Filter) => filter === 'awaiting' ? item.reviewStatus === 'awaiting_review' || item.reviewStatus === 'resubmitted'
  : filter === 'pending' ? !!item.openReview : item.reviewStatus === filter

/**
 * Client reviews across every project: what waits for the client, what came back, and which projects have unread client
 * messages. Opening a row opens the project's Client portal tab (and the deliverable's review).
 */
export function ReviewQueue({ workspace, version, onOpen }: { workspace: WorkspaceSummary; version: number; onOpen: (projectId: string, deliverableId?: string) => void }) {
  const [data, setData] = useState<CollabQueue | null>(null), [error, setError] = useState(''), [chosen, setFilter] = useState<Filter | null>(null)
  useEffect(() => {
    let active = true
    collabQueue(workspace.id).then(value => { if (active) { setData(value); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, version])
  if (error) return <p className="sp-error" role="alert">{error}</p>
  if (!data) return <section className="panel"><p className="sp-loading" role="status">Loading client reviews…</p></section>
  const counts = Object.fromEntries(filters.map(([key]) => [key, key === 'messages' ? data.conversations.length : data.deliverables.filter(item => pick(item, key)).length])) as Record<Filter, number>
  // Until someone picks a filter, open on what most likely needs the agency: changes, messages, then waiting reviews.
  const filter: Filter = chosen ?? (['changes_requested', 'messages', 'awaiting', 'rejected', 'approved', 'pending'] as Filter[]).find(key => counts[key] > 0) ?? 'awaiting'
  const rows = data.deliverables.filter(item => pick(item, filter))
  return <section className="panel" aria-labelledby="cb-queue-title">
    <div className="section-heading"><div><h2 id="cb-queue-title">Client reviews</h2><p>Deliverables shared with clients for review, and client messages you haven’t read. Client decisions are made on the client portal only.</p></div></div>
    <div className="cb-filterbar"><div className="sp-segment" role="group" aria-label="Show">{filters.map(([key, label]) =>
      <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label} <span aria-hidden="true">({counts[key]})</span><span className="sr-only">, {counts[key]}</span></button>)}</div></div>
    {filter === 'messages' ? !data.conversations.length ? <div className="empty"><h3>No unread client messages</h3><p>Messages clients send on the portal appear here until you open the project’s Client portal tab.</p></div>
      : <div className="sp-table-wrap cb-wrap"><table className="sp-table">
        <thead><tr><th>Project</th><th>Client</th><th>Unread</th><th>Latest</th></tr></thead>
        <tbody>{data.conversations.map(item => <tr key={item.projectId}>
          <td><button className="sp-link" onClick={() => onOpen(item.projectId)}>{item.projectName}</button></td><td>{item.clientName}</td><td>{item.unread}</td><td>{collabTime(item.lastAt)}</td>
        </tr>)}</tbody></table></div>
    : !rows.length ? <div className="empty"><h3>Nothing here</h3><p>{data.deliverables.length ? 'Choose another filter.' : 'Share a deliverable with a client and request a review from the project’s Client portal tab.'}</p></div>
    : <div className="sp-table-wrap cb-wrap"><table className="sp-table cb-table">
      <thead><tr><th>Deliverable</th><th>Client</th><th>Review</th><th>Dates</th><th>Last decision</th><th>Feedback</th></tr></thead>
      <tbody>{rows.map(item => <tr key={item.id}>
        <td><button className="sp-link" onClick={() => onOpen(item.projectId, item.id)}>{item.title}</button><small>{item.projectName}</small></td>
        <td>{item.clientName}</td>
        <td><ReviewChip status={item.reviewStatus} />{item.openReview && <small>Version {item.openReview.versionNumber}</small>}</td>
        <td>{item.openReview ? <>Requested {shortDate(item.openReview.createdAt)}{item.openReview.dueDate && <small>Review by {shortDate(item.openReview.dueDate)}</small>}
          <small>{item.openReview.firstViewedAt ? `Opened ${collabTime(item.openReview.firstViewedAt)}` : 'Not opened yet'}</small></> : <>Updated {shortDate(item.updatedAt)}</>}</td>
        <td>{item.lastDecision ? <>{decisionLabels[item.lastDecision.decision]}<small>{item.lastDecision.reviewer} · v{item.lastDecision.versionNumber}</small></> : <span className="sp-muted">—</span>}</td>
        <td>{item.openFeedback ? `${item.openFeedback} open` : <span className="sp-muted">—</span>}</td>
      </tr>)}</tbody></table></div>}
  </section>
}
