import { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import { filesConfig } from '../lib/clients'
import { errorText, shortDate } from '../lib/sales'
import { deliverableStatusLabels, type DeliverableStatus, type ProjectDetail } from '../lib/projects'
import {
  collabTime, conflict, decisionLabels, markDiscussionRead, projectCollab, setClientVisibility, setProjectPortal,
  type CollabDeliverableRow, type CollabDocument, type ProjectCollab, type ProjectUpdate, type ReviewStatus,
} from '../lib/collaboration'
import { AgencyFiles, ReviewChip, Switch } from './CollabBits'
import { CollabPreview } from './CollabPreview'
import { CollabThread } from './CollabThread'
import { CollabUpdates } from './CollabUpdates'
import { DeliverableReview } from './DeliverableReview'
import './ProjectCollaboration.css'

type Filter = 'all' | 'awaiting' | 'changes_requested' | 'approved' | 'rejected'
const filterLabels: [Filter, string][] = [['all', 'All'], ['awaiting', 'Awaiting client review'], ['changes_requested', 'Changes requested'], ['approved', 'Approved'], ['rejected', 'Rejected']]
const matches = (row: CollabDeliverableRow, filter: Filter) => filter === 'all' || (filter === 'awaiting' ? row.reviewStatus === 'awaiting_review' || row.reviewStatus === 'resubmitted' : row.reviewStatus === filter)

/**
 * The project's client collaboration, for the agency: whether and how it appears on the client portal, what is visible,
 * deliverable reviews, the client discussion, published updates, the client's uploads and the collaboration history.
 * The client only ever sees what is shared here; every rule is checked by the database.
 */
export function ProjectCollaboration({ workspace, detail, userId, locked, initialDeliverable = null, onChanged }: {
  workspace: WorkspaceSummary; detail: ProjectDetail; userId: string; locked: boolean; initialDeliverable?: string | null; onChanged: (message?: string) => void
}) {
  const [data, setData] = useState<ProjectCollab | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(initialDeliverable), [preview, setPreview] = useState(false), [filter, setFilter] = useState<Filter>('all')
  const [config, setConfig] = useState<{ maxBytes: number; extensions: string[] } | null>(null)
  const manager = workspace.role !== 'member'
  const load = useCallback(() => projectCollab(workspace.id, detail.id).then(value => { setData(value); setError('') }), [workspace.id, detail.id])
  useEffect(() => {
    let active = true
    projectCollab(workspace.id, detail.id).then(value => { if (active) setData(value) }).catch(cause => { if (active) setError(errorText(cause)) })
    filesConfig(workspace.id).then(value => { if (active) setConfig(value) }).catch(() => undefined)
    // Opening the tab counts as reading the client's messages.
    markDiscussionRead(workspace.id, detail.id).catch(() => undefined)
    return () => { active = false }
  }, [workspace.id, detail.id])
  const refresh = async (message?: string) => { await load().catch(cause => setError(errorText(cause))); if (message) { setNotice(message); onChanged(message) } }
  async function run(action: () => Promise<unknown>, message?: string) {
    setBusy(true); setError(''); setNotice('')
    try { await action(); await load(); if (message) { setNotice(message); onChanged(message) } return true }
    catch (cause) {
      setError(conflict(cause) ? 'This project changed in another window. It has been reloaded; check it and try again.' : errorText(cause))
      await load().catch(() => undefined); return false
    } finally { setBusy(false) }
  }
  if (!data) return <section className="panel"><p className={error ? 'sp-error sp-inset' : 'sp-loading'} role={error ? 'alert' : 'status'}>{error || 'Loading client collaboration…'}</p></section>
  const readOnly = locked || data.portal.clientArchived
  const rows = data.deliverables
  const count = (statuses: ReviewStatus[]) => rows.filter(row => statuses.includes(row.reviewStatus)).length
  const withAccess = data.people.filter(person => person.status === 'active' && person.canOpen)
  const visibleRows = rows.filter(row => matches(row, filter))
  return <div className="cb-tab">
    {readOnly && <p className="sp-caution" role="note">This project’s client is archived. Their portal is closed and this tab is read-only until the client is unarchived.</p>}
    {notice && <p className="sp-notice" role="status">{notice}</p>}
    {error && <p className="sp-error" role="alert">{error}</p>}
    <dl className="cb-strip" aria-label="Client collaboration at a glance">
      <div className="is-share"><dt>Client portal</dt><dd>{data.portal.shared ? 'Shared' : 'Not shared'}<small>{data.portal.shared ? `since ${shortDate(data.portal.sharedAt)}` : 'Only your team sees this project'}</small></dd></div>
      <div><dt>People with access</dt><dd>{withAccess.length}<small>{data.pendingInvitations ? `${data.pendingInvitations} invitation${data.pendingInvitations === 1 ? '' : 's'} pending` : 'From the client’s Portal access tab'}</small></dd></div>
      <div><dt>Awaiting review</dt><dd>{count(['awaiting_review', 'resubmitted'])}</dd></div>
      <div><dt>Changes requested</dt><dd>{count(['changes_requested'])}</dd></div>
      <div><dt>Approved</dt><dd>{count(['approved'])}</dd></div>
      <div><dt>Open feedback</dt><dd>{rows.reduce((sum, row) => sum + row.openFeedback, 0)}</dd></div>
      <div><dt>Unread client messages</dt><dd>{data.unreadClientComments}</dd></div>
    </dl>

    <SharingPanel workspace={workspace} detail={detail} data={data} busy={busy} readOnly={readOnly} run={run} onPreview={() => setPreview(true)} />
    <VisibilityPanel workspace={workspace} data={data} busy={busy} readOnly={readOnly} run={run} />

    <section className="panel" aria-labelledby="cb-review-title">
      <div className="section-heading"><div><h2 id="cb-review-title">Deliverable reviews</h2><p>Share versions with the client and ask for approval. Open a deliverable to manage its versions, reviews and feedback.</p></div></div>
      <div className="cb-filterbar"><div className="sp-segment" role="group" aria-label="Filter deliverables">{filterLabels.map(([key, label]) =>
        <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}{key !== 'all' && <span className="sr-only"> ({rows.filter(row => matches(row, key)).length})</span>}</button>)}</div></div>
      {!rows.length ? <div className="empty"><h3>No deliverables yet</h3><p>Add deliverables on the Deliverables tab; then share them with the client here.</p></div>
        : !visibleRows.length ? <p className="sp-muted sp-inset">No deliverables match this filter.</p>
        : <div className="sp-table-wrap cb-wrap"><table className="sp-table cb-table">
          <thead><tr><th>Deliverable</th><th>Client review</th><th>Latest version</th><th>Open review</th><th>Last decision</th><th>Feedback</th></tr></thead>
          <tbody>{visibleRows.map(row => <tr key={row.id}>
            <td><button className="sp-link" onClick={() => setOpen(row.id)}>{row.title}</button><small>{deliverableStatusLabels[row.status as DeliverableStatus] ?? row.status}{row.dueDate ? ` · due ${shortDate(row.dueDate)}` : ''}</small></td>
            <td><ReviewChip status={row.reviewStatus} />{!row.clientVisible && <small>Hidden from the client</small>}</td>
            <td>{row.latestVersion ? <>Version {row.latestVersion.number}<small>{row.latestVersion.published ? 'Shared' : 'Draft'}</small></> : <span className="sp-muted">None</span>}</td>
            <td>{row.openReview ? <>Version {row.openReview.versionNumber}{row.openReview.dueDate && <small>Review by {shortDate(row.openReview.dueDate)}</small>}
              <small>{row.openReview.firstViewedAt ? `Opened by ${row.openReview.firstViewedBy ?? 'the client'} ${collabTime(row.openReview.firstViewedAt)}` : 'Not opened yet'}</small></> : <span className="sp-muted">—</span>}</td>
            <td>{row.lastDecision ? <>{decisionLabels[row.lastDecision.decision]}<small>{row.lastDecision.reviewer} · v{row.lastDecision.versionNumber} · {shortDate(row.lastDecision.createdAt)}</small></> : <span className="sp-muted">—</span>}</td>
            <td>{row.openFeedback ? `${row.openFeedback} open` : <span className="sp-muted">—</span>}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    <section className="panel" aria-labelledby="cb-discussion-title">
      <div className="section-heading"><div><h2 id="cb-discussion-title">Project discussion</h2><p>Internal notes stay with your team. Messages marked visible appear on the client’s portal.</p></div></div>
      <div className="cb-section-body">
        <CollabThread workspace={workspace} projectId={detail.id} clientId={detail.clientId} userId={userId} manager={manager} locked={readOnly} config={config} label="Project discussion"
          emptyText="No messages yet." clientAllowed={data.portal.shared} clientBlocked="Share the project on the client portal to send messages the client can see." onChanged={() => void refresh()} />
      </div>
    </section>

    <CollabUpdates workspace={workspace} projectId={detail.id} clientId={detail.clientId} shared={data.portal.shared} locked={readOnly} config={config}
      updates={data.updates as ProjectUpdate<CollabDocument>[]} onChanged={refresh} />

    <div className="cb-two">
      <section className="panel" aria-labelledby="cb-uploads-title">
        <div className="section-heading"><div><h2 id="cb-uploads-title">Files from the client</h2><p>Uploaded by the client’s people on the portal.</p></div></div>
        <div className="cb-section-body"><AgencyFiles workspace={workspace} files={data.clientFiles as CollabDocument[]} onError={setError} empty="Nothing uploaded on the portal yet." /></div>
      </section>
      <section className="panel" aria-labelledby="cb-history-title">
        <div className="section-heading"><div><h2 id="cb-history-title">Collaboration history</h2><p>Sharing, reviews, decisions, feedback and messages, newest first.</p></div></div>
        <div className="cb-section-body">{!data.history.length ? <p className="sp-muted">Nothing yet.</p> : <ul className="cb-events">{data.history.map(event => <li key={event.id} className={`is-${event.actorType}`}>
          <i aria-hidden="true" /><span>{event.summary}<small>{event.actor} · {collabTime(event.at)}</small></span></li>)}</ul>}</div>
      </section>
    </div>

    {open && <DeliverableReview deliverableId={open} workspace={workspace} projectId={detail.id} clientId={detail.clientId} userId={userId} manager={manager} locked={readOnly}
      projectShared={data.portal.shared} people={data.people} config={config} onClose={() => setOpen(null)} onChanged={() => void refresh()} />}
    {preview && <CollabPreview workspace={workspace} projectId={detail.id} shared={data.portal.shared} onClose={() => setPreview(false)} />}
  </div>
}

function SharingPanel({ workspace, detail, data, busy, readOnly, run, onPreview }: {
  workspace: WorkspaceSummary; detail: ProjectDetail; data: ProjectCollab; busy: boolean; readOnly: boolean; run: (action: () => Promise<unknown>, message?: string) => Promise<boolean>; onPreview: () => void
}) {
  const { portal } = data
  const [editing, setEditing] = useState(false), [confirming, setConfirming] = useState<boolean | null>(null)
  const [summary, setSummary] = useState(portal.summary), [objectives, setObjectives] = useState(portal.objectives.join('\n'))
  const [contactName, setContactName] = useState(portal.contactName), [contactEmail, setContactEmail] = useState(portal.contactEmail)
  const startEditing = () => { setSummary(portal.summary); setObjectives(portal.objectives.join('\n')); setContactName(portal.contactName); setContactEmail(portal.contactEmail); setEditing(true) }
  async function save() {
    const ok = await run(() => setProjectPortal(workspace.id, detail.id, { summary: summary.trim(), objectives: objectives.split('\n').map(line => line.trim()).filter(Boolean),
      contactName: contactName.trim(), contactEmail: contactEmail.trim() }, portal.version), 'Client-facing overview saved.')
    if (ok) setEditing(false)
  }
  const people = data.people.filter(person => person.status === 'active' && person.canOpen).length
  return <section className="panel" aria-labelledby="cb-share-title">
    <div className="section-heading"><div><h2 id="cb-share-title">Sharing on the client portal</h2><p>The client sees this project only after you share it, and only what you mark visible.</p></div>
      <div className="cb-heading-actions"><button className="secondary" onClick={onPreview}><Icon name="search" size={15} /> Preview as client</button></div></div>
    <div className="cb-section-body cb-share">
      <div className="cb-share-state">
        <Switch checked={portal.shared} disabled={busy || readOnly} label="Share on the client portal" onChange={next => setConfirming(next)} />
        <p>{portal.shared ? `Shared since ${shortDate(portal.sharedAt)}. ${people} portal user${people === 1 ? '' : 's'} can open it.` : 'Not shared. Nobody at the client can see this project.'}</p>
        {!people && <p>Nobody at the client can open it yet: invite people from the client’s <strong>Portal access</strong> tab.</p>}
        <p className="cb-never">Never shown to the client: internal notes and comments, the brief, agreed value and costs, health and risk, tasks, internal files, hidden milestones and unshared deliverables.</p>
      </div>
      {editing ? <form className="cb-overview-form sp-form" onSubmit={event => { event.preventDefault(); void save() }}>
        <label>Overview for the client<textarea rows={4} maxLength={4000} value={summary} onChange={event => setSummary(event.target.value)} placeholder="What this project delivers, in the client’s words." /></label>
        {detail.description && !summary.trim() && <button type="button" className="text-button" onClick={() => setSummary(detail.description)}>Start from the project description</button>}
        <label>Objectives (one per line)<textarea rows={3} value={objectives} onChange={event => setObjectives(event.target.value)} /></label>
        <div className="sp-row"><label>Contact name<input maxLength={150} value={contactName} onChange={event => setContactName(event.target.value)} /></label>
          <label>Contact email<input type="email" maxLength={254} value={contactEmail} onChange={event => setContactEmail(event.target.value)} /></label></div>
        <div className="sp-actions"><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button><button className="primary" disabled={busy}>Save overview</button></div>
      </form> : <div className="cb-overview-view">
        <h4>Overview for the client</h4>{portal.summary ? <p>{portal.summary}</p> : <p className="sp-muted">Not written yet.</p>}
        {portal.objectives.length > 0 && <><h4>Objectives</h4><ul>{portal.objectives.map(item => <li key={item}>{item}</li>)}</ul></>}
        {(portal.contactName || portal.contactEmail) && <><h4>Contact</h4><p>{[portal.contactName, portal.contactEmail].filter(Boolean).join(' · ')}</p></>}
        {!readOnly && <div><button className="text-button" onClick={startEditing}>Edit overview</button></div>}
      </div>}
    </div>
    {confirming !== null && <Modal title={confirming ? 'Share this project with the client?' : 'Stop sharing this project?'} onClose={() => setConfirming(null)}>
      <p>{confirming ? 'Portal users who can open this client’s projects will see it and get a notification. They see the overview, visible milestones, shared deliverables and published updates.'
        : 'The project disappears from the client’s portal. Shared versions, reviews, feedback and messages are kept and come back if you share it again.'}</p>
      <div className="modal-actions"><button className="secondary" onClick={() => setConfirming(null)}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => { const next = confirming; setConfirming(null); void run(() => setProjectPortal(workspace.id, detail.id, { shared: next }, portal.version), next ? 'Project shared on the client portal.' : 'Project removed from the client portal.') }}>
          {confirming ? 'Share project' : 'Stop sharing'}</button></div>
    </Modal>}
  </section>
}

function VisibilityPanel({ workspace, data, busy, readOnly, run }: { workspace: WorkspaceSummary; data: ProjectCollab; busy: boolean; readOnly: boolean; run: (action: () => Promise<unknown>, message?: string) => Promise<boolean> }) {
  const [hiding, setHiding] = useState<CollabDeliverableRow | null>(null)
  const toggle = (kind: 'milestone' | 'deliverable', id: string, name: string, visible: boolean) =>
    void run(() => setClientVisibility(workspace.id, kind, id, visible), `${name} is now ${visible ? 'visible to' : 'hidden from'} the client.`)
  return <section className="panel" aria-labelledby="cb-visibility-title">
    <div className="section-heading"><div><h2 id="cb-visibility-title">What the client can see</h2><p>Milestones and deliverables stay internal until you show them.</p></div></div>
    <div className="cb-section-body cb-visibility">
      <div><h3>Milestones</h3>{!data.milestones.length ? <p className="sp-muted">No milestones.</p> : <ul className="cb-vis-list">{data.milestones.map(milestone => <li key={milestone.id}>
        <span>{milestone.name}<small>{milestone.dueDate ? `Due ${shortDate(milestone.dueDate)}` : 'No due date'}</small></span>
        <Switch small checked={milestone.clientVisible} disabled={busy || readOnly} label={<span className="sr-only">Show {milestone.name} to the client</span>}
          onChange={next => toggle('milestone', milestone.id, milestone.name, next)} /></li>)}</ul>}</div>
      <div><h3>Deliverables</h3>{!data.deliverables.length ? <p className="sp-muted">No deliverables.</p> : <ul className="cb-vis-list">{data.deliverables.map(row => <li key={row.id}>
        <span>{row.title}<small><ReviewChip status={row.reviewStatus} /></small></span>
        <Switch small checked={row.clientVisible} disabled={busy || readOnly} label={<span className="sr-only">Show {row.title} to the client</span>}
          onChange={next => next ? toggle('deliverable', row.id, row.title, true) : setHiding(row)} /></li>)}</ul>}
        <p className="sp-muted">Hiding a deliverable withdraws its open review and hides its versions and files from the client.</p></div>
    </div>
    {hiding && <Modal title={`Hide ${hiding.title} from the client?`} onClose={() => setHiding(null)}>
      <p>The client stops seeing it, its shared versions and its files.{hiding.openReview ? ' Its open review is withdrawn.' : ''} Its history is kept; share it again to show it.</p>
      <div className="modal-actions"><button className="secondary" onClick={() => setHiding(null)}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => { const row = hiding; setHiding(null); toggle('deliverable', row.id, row.title, false) }}>Hide from client</button></div>
    </Modal>}
  </section>
}
