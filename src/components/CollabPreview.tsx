import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import { errorText, shortDate } from '../lib/sales'
import { projectTypeLabels, type ProjectType } from '../lib/projects'
import { collabTime, portalPreview, type PortalPreview } from '../lib/collaboration'
import { ReviewChip } from './CollabBits'

const statusWords: Record<string, string> = { planning: 'Planning', not_started: 'Not started', in_progress: 'In progress', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled', upcoming: 'Upcoming' }

/** Exactly what the client's portal shows for this project, from the same database function's data. */
export function CollabPreview({ workspace, projectId, shared, onClose }: { workspace: WorkspaceSummary; projectId: string; shared: boolean; onClose: () => void }) {
  const [preview, setPreview] = useState<PortalPreview | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    portalPreview(workspace.id, projectId).then(value => { if (active) setPreview(value) }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, projectId])
  return <Modal title="Preview as the client" onClose={onClose}>
    <p className="sp-intro">{shared ? 'This is what people at the client see on their portal today.' : 'The project isn’t shared yet. Once you share it, the client sees this.'}
      {' '}Internal notes, the brief, money, health and anything not marked visible are never shown.</p>
    {error && <p className="sp-error" role="alert">{error}</p>}
    {!preview ? !error && <p className="sp-muted" role="status">Loading the preview…</p> : <div className="cb-pv">
      <div className="cb-pv-hero">
        <small>{preview.agencyName} · {preview.clientName}</small>
        <h3>{preview.name}</h3>
        <small>{projectTypeLabels[preview.category as ProjectType] ?? preview.category} · {statusWords[preview.status] ?? preview.status} · {shortDate(preview.startDate)} → {shortDate(preview.targetDate)}</small>
        <span className="cb-pv-bar" role="progressbar" aria-label={`${preview.progress}% complete`} aria-valuenow={preview.progress} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${preview.progress}%` }} /></span>
        <small>{preview.progress}% complete{preview.nextMilestone ? ` · Next: ${preview.nextMilestone.name} (${shortDate(preview.nextMilestone.dueDate)})` : ''}</small>
      </div>
      <section><h4>About this project</h4>{preview.summary ? <p>{preview.summary}</p> : <p className="sp-muted">No overview written for the client yet.</p>}</section>
      {preview.objectives.length > 0 && <section><h4>Objectives</h4><ul>{preview.objectives.map(item => <li key={item}>{item}</li>)}</ul></section>}
      {preview.services.length > 0 && <section><h4>Agreed services</h4><ul>{preview.services.map(item => <li key={item}>{item}</li>)}</ul></section>}
      {preview.contact && <section><h4>Your contact</h4><p>{preview.contact.name}{preview.contact.email ? ` · ${preview.contact.email}` : ''}</p></section>}
      <section><h4>Milestones</h4>{preview.milestones.length ? <ul>{preview.milestones.map(item => <li key={item.id}>{item.name} · {statusWords[item.status] ?? item.status} · due {shortDate(item.dueDate)}</li>)}</ul>
        : <p className="sp-muted">No milestones shown to the client.</p>}</section>
      <section><h4>Deliverables</h4>{preview.deliverables.length ? <ul>{preview.deliverables.map(item => <li key={item.id}>{item.title} <ReviewChip status={item.reviewStatus} />
        {item.latestVersion ? <span className="sp-muted"> · version {item.latestVersion}</span> : null}</li>)}</ul>
        : <p className="sp-muted">No deliverables shared yet.</p>}</section>
      <section><h4>Updates</h4>{preview.updates.length ? <ul>{preview.updates.map(item => <li key={item.id}><strong>{item.title}</strong> · {collabTime(item.publishedAt)}{item.correctedAt ? ' · corrected' : ''}</li>)}</ul>
        : <p className="sp-muted">No published updates.</p>}</section>
    </div>}
    <div className="modal-actions"><button className="secondary" onClick={onClose}>Close preview</button></div>
  </Modal>
}
