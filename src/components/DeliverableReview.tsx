import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import { formatBytes } from '../lib/clients'
import { errorText, shortDate } from '../lib/sales'
import { askAssistant, deleteProjectFile, deliverableStatusLabels, type AiResult, type DeliverableStatus } from '../lib/projects'
import {
  assistantMessage, clientRoleLabels, collabTime, createVersion, decisionLabels, deliverableCollab, discardVersion, feedbackCategoryLabels, feedbackStatuses, feedbackStatusLabels,
  publishVersion, requestReview, setFeedbackStatus, updateVersionNotes, withdrawReview,
  type CollabDocument, type DeliverableCollab, type Feedback, type FeedbackStatus, type PortalPerson, type Review, type Version,
} from '../lib/collaboration'
import { AgencyFiles, ReviewChip, UploadField } from './CollabBits'
import { AssistantResult, CollabAssistant } from './CollabAssistant'
import { CollabThread } from './CollabThread'

type AgencyVersion = Version<CollabDocument>
type AgencyFeedback = Feedback<CollabDocument>
interface Context {
  workspace: WorkspaceSummary; projectId: string; clientId: string; userId: string; manager: boolean; locked: boolean; projectShared: boolean
  people: PortalPerson[]; config: { maxBytes: number; extensions: string[] } | null
}

/**
 * One deliverable's client review: versions (a draft until shared, then fixed), review requests and the client's
 * decisions on each version, feedback with replies and statuses, and the deliverable's discussion. Nothing here decides
 * for the client: only client people approve, reject or request changes, on the portal.
 */
export function DeliverableReview({ deliverableId, onClose, onChanged, ...context }: Context & { deliverableId: string; onClose: () => void; onChanged: () => void }) {
  const { workspace, locked, projectShared } = context
  const [data, setData] = useState<DeliverableCollab | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [requesting, setRequesting] = useState(false), [withdrawing, setWithdrawing] = useState<Review | null>(null), [sharing, setSharing] = useState<AgencyVersion | null>(null)
  const load = useCallback(() => deliverableCollab(workspace.id, deliverableId).then(value => { setData(value); setError('') }), [workspace.id, deliverableId])
  useEffect(() => {
    let active = true
    deliverableCollab(workspace.id, deliverableId).then(value => { if (active) setData(value) }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, deliverableId])
  async function run(action: () => Promise<unknown>, message?: string) {
    setBusy(true); setError(''); setNotice('')
    try { await action(); await load(); if (message) setNotice(message); onChanged(); return true }
    catch (cause) { setError(errorText(cause)); await load().catch(() => undefined); return false }
    finally { setBusy(false) }
  }
  const refresh = async (message?: string) => { await load().catch(cause => setError(errorText(cause))); if (message) setNotice(message); onChanged() }
  const versions = (data?.versions ?? []) as AgencyVersion[]
  const draft = versions.find(version => !version.publishedAt) ?? null
  const openReview = data?.reviews.find(review => review.status === 'open') ?? null
  return <Modal title={data ? `Client review: ${data.title}` : 'Client review'} onClose={onClose} variant="drawer" id="cb-deliverable-review">
    {!data ? <p className={error ? 'sp-error' : 'sp-muted'} role={error ? 'alert' : 'status'}>{error || 'Loading…'}</p> : <div className="cb-dr">
      <div className="cb-dr-head"><ReviewChip status={data.reviewStatus} /><span>Internal status: {deliverableStatusLabels[data.status as DeliverableStatus] ?? data.status}</span>
        {data.dueDate && <span>· due {shortDate(data.dueDate)}</span>}<span>· {data.clientVisible ? `shared with the client${data.sharedAt ? ` since ${shortDate(data.sharedAt)}` : ''}` : 'not shared with the client'}</span></div>
      <p className="sp-muted">The client review is separate from the internal status: a deliverable can be complete internally and still wait for the client’s approval. Each decision applies to one version only.</p>
      {notice && <p className="sp-notice" role="status">{notice}</p>}
      {error && <p className="sp-error" role="alert">{error}</p>}
      {!locked && <div className="cb-dr-actions">
        {!draft && <button className="secondary" disabled={busy} onClick={() => void run(() => createVersion(workspace.id, data.id), 'Draft version started. Add its files and notes.')}>New version</button>}
        <button className="primary" disabled={busy || !!openReview || !versions.length || !projectShared} title={!projectShared ? 'Share the project on the client portal first.' : openReview ? 'Withdraw the open review first.' : undefined}
          onClick={() => setRequesting(true)}>Request client review</button>
        {openReview && <button className="secondary" disabled={busy} onClick={() => setWithdrawing(openReview)}>Withdraw review</button>}
      </div>}
      {!projectShared && <p className="sp-caution" role="note">The project isn’t shared on the client portal yet. Share it on the Client portal tab before sharing versions or asking for a review.</p>}

      <section aria-labelledby="cb-versions"><h3 id="cb-versions">Versions</h3>
        {!versions.length ? <p className="sp-muted">No versions yet. Start one, add its files, then share it or ask the client to review it.</p>
          : versions.map(version => <VersionCard key={version.id} version={version} reviews={data.reviews} {...context} busy={busy} run={run} refresh={refresh} onError={setError}
            onShare={() => setSharing(version)} />)}
      </section>

      <section aria-labelledby="cb-reviews"><h3 id="cb-reviews">Review history</h3>
        {!data.reviews.length ? <p className="sp-muted">No review requests yet.</p> : data.reviews.map(review => <ReviewCard key={review.id} review={review} />)}
      </section>

      <section aria-labelledby="cb-feedback"><h3 id="cb-feedback">Client feedback <span className="number-tag">{data.feedback.length}</span></h3>
        {!data.feedback.length ? <p className="sp-muted">No feedback from the client yet.</p>
          : (data.feedback as AgencyFeedback[]).map(item => <FeedbackCard key={item.id} feedback={item} versions={versions} clientVisible={data.clientVisible} {...context} onChanged={refresh} onError={setError} />)}
      </section>

      <section aria-labelledby="cb-discussion"><h3 id="cb-discussion">Discussion about this deliverable</h3>
        <CollabThread {...context} scope={{ deliverableId: data.id }} label="Deliverable discussion" emptyText="No messages about this deliverable yet."
          clientAllowed={data.clientVisible} clientBlocked="Share the deliverable with the client to send messages they can see." onChanged={onChanged} />
      </section>

      <CollabAssistant workspace={workspace} projectId={context.projectId} deliverableId={data.id} />
    </div>}
    {requesting && data && <RequestReviewDialog data={data} versions={versions} people={context.people} workspace={workspace} onClose={() => setRequesting(false)}
      onDone={async () => { setRequesting(false); await refresh('Review requested. The client’s reviewers were notified.') }} />}
    {withdrawing && <WithdrawDialog onClose={() => setWithdrawing(null)} busy={busy}
      onConfirm={reason => void run(() => withdrawReview(workspace.id, withdrawing.id, reason), 'Review withdrawn.').then(ok => { if (ok) setWithdrawing(null) })} />}
    {sharing && <Modal title={`Share version ${sharing.number} without a review?`} onClose={() => setSharing(null)}>
      <p>The client sees this version and its files on the portal, without being asked to approve it. After sharing, the version and its files can’t change; start a new version for later changes.</p>
      <div className="modal-actions"><button className="secondary" onClick={() => setSharing(null)}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => void run(() => publishVersion(workspace.id, sharing.id), `Version ${sharing.number} shared with the client.`).then(ok => { if (ok) setSharing(null) })}>Share version</button></div>
    </Modal>}
  </Modal>
}

function VersionCard({ version, reviews, workspace, projectId, clientId, locked, config, busy, run, refresh, onError, onShare }: Context & {
  version: AgencyVersion; reviews: Review[]; busy: boolean; run: (action: () => Promise<unknown>, message?: string) => Promise<boolean>
  refresh: (message?: string) => Promise<void>; onError: (message: string) => void; onShare: () => void
}) {
  const [notes, setNotes] = useState(version.notes)
  const decisions = reviews.filter(review => review.versionId === version.id && review.decision).map(review => review.decision!)
  const isDraft = !version.publishedAt
  return <article className={`cb-card${isDraft ? ' is-draft' : ''}`} aria-label={`Version ${version.number}`}>
    <div className="cb-card-head"><strong>Version {version.number}</strong>
      <span className={`cb-tag${isDraft ? ' is-draft' : ' is-client'}`}>{isDraft ? 'Draft: internal' : `Shared ${shortDate(version.publishedAt)}`}</span></div>
    {isDraft && !locked ? <>
      <label className="sp-muted" htmlFor={`notes-${version.id}`}>What changed in this version (the client sees this)</label>
      <textarea id={`notes-${version.id}`} rows={2} maxLength={4000} value={notes} onChange={event => setNotes(event.target.value)} />
      <div className="cb-comment-actions">
        <button type="button" className="text-button" disabled={busy || notes === version.notes} onClick={() => void run(() => updateVersionNotes(workspace.id, version.id, notes.trim()), 'Notes saved.')}>Save notes</button>
        <button type="button" className="text-button" disabled={busy} onClick={onShare}>Share without review</button>
        {!version.files.length && <button type="button" className="text-button" disabled={busy} onClick={() => void run(() => discardVersion(workspace.id, version.id), 'Draft discarded.')}>Discard draft</button>}
      </div>
      <AgencyFiles workspace={workspace} files={version.files} onError={onError} onRemove={file => void run(() => deleteProjectFile(workspace.id, file.id), `${file.fileName} removed from the draft.`)} />
      <div style={{ marginTop: 8 }}><UploadField workspace={workspace} target={{ clientId, projectId, versionId: version.id }} visibility="internal" label="Add files to this version" config={config}
        onUploaded={name => void refresh(`${name} added to version ${version.number}.`)} /></div>
      {config && <p className="sp-muted">Up to {formatBytes(config.maxBytes)} each. Files are checked after upload; once the version is shared they can’t be removed.</p>}
    </> : <>
      {version.notes ? <p>{version.notes}</p> : <p className="sp-muted">No notes.</p>}
      <AgencyFiles workspace={workspace} files={version.files} onError={onError} empty="No files in this version." />
    </>}
    {decisions.map(decision => <p key={decision.id} className={`cb-decision is-${decision.decision}`}><strong>{decisionLabels[decision.decision]}</strong> by {decision.reviewer} · {collabTime(decision.createdAt)}
      {decision.comment ? <><br />“{decision.comment}”</> : null}</p>)}
  </article>
}

function ReviewCard({ review }: { review: Review }) {
  return <article className="cb-card">
    <div className="cb-card-head"><strong>Version {review.versionNumber}</strong>
      <span className={`cb-review is-${review.status === 'open' ? 'awaiting_review' : review.status}`}>{review.status === 'open' ? 'Waiting for the client' : review.status === 'withdrawn' ? 'Withdrawn' : decisionLabels[review.status]}</span></div>
    <p className="sp-muted">Requested by {review.requestedBy} · {collabTime(review.createdAt)}{review.dueDate ? ` · review by ${shortDate(review.dueDate)}` : ''}
      {review.reviewers.length ? ` · asked: ${review.reviewers.join(', ')}` : ' · any client admin or reviewer'}</p>
    <p className="sp-muted">{review.firstViewedAt ? `First opened by ${review.firstViewedBy ?? 'the client'} on ${collabTime(review.firstViewedAt)}.` : review.status === 'open' ? 'Not opened on the portal yet.' : ''}</p>
    {review.message && <p className="cb-body">“{review.message}”</p>}
    {review.decision && <p className={`cb-decision is-${review.decision.decision}`}><strong>{decisionLabels[review.decision.decision]}</strong> by {review.decision.reviewer} · {collabTime(review.decision.createdAt)}
      {review.decision.comment ? <><br />“{review.decision.comment}”</> : null}</p>}
    {review.status === 'withdrawn' && <p className="sp-muted">Withdrawn{review.closedAt ? ` ${collabTime(review.closedAt)}` : ''}{review.withdrawnReason ? `: ${review.withdrawnReason}` : ''}</p>}
  </article>
}

function FeedbackCard({ feedback, versions, clientVisible, onChanged, onError, ...context }: Context & {
  feedback: AgencyFeedback; versions: AgencyVersion[]; clientVisible: boolean; onChanged: (message?: string) => Promise<void>; onError: (message: string) => void
}) {
  const { workspace, projectId, locked } = context
  const [status, setStatus] = useState<FeedbackStatus>(feedback.status), [note, setNote] = useState(feedback.statusNote)
  const [addressed, setAddressed] = useState(versions.find(version => version.number === feedback.addressedInVersion)?.id ?? ''), [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false), [ai, setAi] = useState<AiResult | null>(null), [aiError, setAiError] = useState(''), [drafting, setDrafting] = useState(false)
  const [draft, setDraft] = useState<{ text: string; key: number } | null>(null), key = useRef(0)
  const changed = status !== feedback.status || note !== feedback.statusNote || addressed !== (versions.find(version => version.number === feedback.addressedInVersion)?.id ?? '')
  async function save() {
    setBusy(true)
    try { await setFeedbackStatus(workspace.id, feedback.id, { status, note: note.trim(), addressedInVersion: addressed || null }); await onChanged(`Feedback marked ${feedbackStatusLabels[status].toLowerCase()}.`) }
    catch (cause) { onError(errorText(cause)) } finally { setBusy(false) }
  }
  async function suggest() {
    setDrafting(true); setAiError(''); setAi(null)
    try { setAi(await askAssistant(workspace.id, projectId, 'response_draft', { feedbackId: feedback.id })); setOpen(true) } catch (cause) { setAiError(assistantMessage(cause)) } finally { setDrafting(false) }
  }
  return <article className="cb-card" aria-label={`Feedback: ${feedback.title}`}>
    <div className="cb-card-head"><strong>{feedback.title}</strong><span className={`cb-tag${feedback.status === 'addressed' ? ' is-client' : feedback.status === 'open' ? ' is-draft' : ''}`}>{feedbackStatusLabels[feedback.status]}</span></div>
    <div className="cb-feedback-meta"><span className="cb-tag">{feedbackCategoryLabels[feedback.category]}</span><span className="sp-muted">{feedback.author} · version {feedback.versionNumber} · {collabTime(feedback.createdAt)}</span></div>
    {feedback.body && <p className="cb-body">{feedback.body}</p>}
    <AgencyFiles workspace={workspace} files={feedback.files} onError={onError} />
    {feedback.statusNote && <p className="sp-muted">Your note to the client: {feedback.statusNote}{feedback.addressedInVersion ? ` (addressed in version ${feedback.addressedInVersion})` : ''}</p>}
    {!locked && <form className="cb-status-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <label>Status<select value={status} onChange={event => setStatus(event.target.value as FeedbackStatus)}>{feedbackStatuses.map(item => <option key={item} value={item}>{feedbackStatusLabels[item]}</option>)}</select></label>
      <label>Addressed in<select value={addressed} onChange={event => setAddressed(event.target.value)}><option value="">—</option>{versions.map(version => <option key={version.id} value={version.id}>Version {version.number}</option>)}</select></label>
      <label>Note for the client<input type="text" maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></label>
      <button className="secondary" disabled={busy || !changed}>Save</button>
    </form>}
    <div className="cb-comment-actions">
      <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide replies' : 'Replies'}</button>
      {!locked && <button type="button" className="text-button" disabled={drafting} onClick={() => void suggest()}>{drafting ? 'Drafting…' : 'Draft a reply with AI'}</button>}
    </div>
    {aiError && <p className="sp-error" role="alert">{aiError}</p>}
    {ai?.responseDraft && <><AssistantResult result={ai} />
      <div className="cb-comment-actions"><button type="button" className="text-button" onClick={() => { key.current += 1; setDraft({ text: ai.responseDraft!.body, key: key.current }); setOpen(true) }}>Use as reply draft</button>
        <span className="sp-muted">It fills the reply box; nothing is sent until you press Send.</span></div></>}
    {open && <CollabThread {...context} scope={{ deliverableId: feedback.deliverableId, feedbackId: feedback.id }} label={`Replies to ${feedback.title}`} emptyText="No replies yet."
      clientAllowed={clientVisible} clientBlocked="The deliverable isn’t shared with the client, so replies stay internal." draft={draft} onChanged={() => void onChanged()} />}
  </article>
}

function RequestReviewDialog({ workspace, data, versions, people, onClose, onDone }: {
  workspace: WorkspaceSummary; data: DeliverableCollab; versions: AgencyVersion[]; people: PortalPerson[]; onClose: () => void; onDone: () => Promise<void>
}) {
  const approved = new Set(data.reviews.filter(review => review.decision?.decision === 'approved').map(review => review.versionId))
  const latestShared = versions.filter(version => version.publishedAt).sort((a, b) => b.number - a.number)[0]
  const candidates = versions.filter(version => !approved.has(version.id) && (!version.publishedAt || version.id === latestShared?.id) && !versions.some(other => other.publishedAt && other.number > version.number))
  const [versionId, setVersionId] = useState(candidates[0]?.id ?? ''), [message, setMessage] = useState(''), [dueDate, setDueDate] = useState(''), [reviewers, setReviewers] = useState<string[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), requestId = useRef(crypto.randomUUID())
  const eligible = people.filter(person => person.status === 'active' && person.canOpen && (person.role === 'admin' || person.role === 'reviewer'))
  const version = versions.find(item => item.id === versionId)
  async function send() {
    setBusy(true); setError('')
    try { await requestReview(workspace.id, data.id, { versionId, message: message.trim(), dueDate: dueDate || null, reviewerIds: reviewers }, requestId.current); await onDone() }
    catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <Modal title={`Request client review: ${data.title}`} onClose={onClose}>
    {!candidates.length ? <><p>There’s no version to send for review. Start a new version (an approved version can’t be reviewed again).</p>
      <div className="modal-actions"><button className="secondary" onClick={onClose}>Close</button></div></> :
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void send() }}>
      <p className="sp-intro">The client is asked to approve, request changes or reject this version. A draft is shared now and can’t change afterwards. The deliverable becomes visible to the client.</p>
      <label>Version<select value={versionId} onChange={event => setVersionId(event.target.value)}>{candidates.map(item => <option key={item.id} value={item.id}>Version {item.number}{item.publishedAt ? ' (already shared)' : ' (draft)'} · {item.files.length} file{item.files.length === 1 ? '' : 's'}</option>)}</select></label>
      <label>Message or review instructions<textarea rows={3} maxLength={4000} value={message} onChange={event => setMessage(event.target.value)} placeholder="What should the client look at?" /></label>
      <label>Review by (optional)<input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} /></label>
      <fieldset className="cb-reviewers"><legend>Who decides (optional)</legend>
        {!eligible.length ? <p className="sp-muted">No client admins or reviewers can open this project yet. Any who get access can decide; invite them from the client’s Portal access tab.</p>
          : eligible.map(person => <label key={person.id} className="cb-check"><input type="checkbox" checked={reviewers.includes(person.id)}
            onChange={event => setReviewers(event.target.checked ? [...reviewers, person.id] : reviewers.filter(item => item !== person.id))} />{person.name || person.email} · {clientRoleLabels[person.role]}</label>)}
        <small>Leave all unticked to let any client admin or reviewer with access decide. Client admins can always decide.</small>
      </fieldset>
      <div className="cb-preview" aria-label="What the client receives">
        <span className="cb-preview-label">What the client receives</span>
        <h4>Ready for your review: {data.title}</h4>
        <p>Version {version?.number ?? '—'}{dueDate ? ` · please review by ${shortDate(dueDate)}` : ''}</p>
        {version?.notes && <p>What changed: {version.notes}</p>}
        {message.trim() && <p>“{message.trim()}”</p>}
        <p>{version?.files.length ? `Files: ${version.files.map(file => file.fileName).join(', ')}` : 'No files: the client reviews the notes only.'}</p>
        <p className="sp-muted">Notified: {reviewers.length ? 'everyone with access (the people you chose decide)' : 'everyone at the client who can open this project'}. Email goes out only to people who turned it on, and only when email delivery is configured.</p>
      </div>
      {version?.files.some(file => file.status === 'pending') && <p className="sp-caution" role="note">Some files are still being checked. Wait for them before sending.</p>}
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !versionId}>{busy ? 'Sending…' : 'Send for review'}</button></div>
    </form>}
  </Modal>
}

function WithdrawDialog({ busy, onClose, onConfirm }: { busy: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return <Modal title="Withdraw the review request?" onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); onConfirm(reason.trim()) }}>
      <p className="sp-intro">The client can no longer decide on this version. The request stays in your review history; the client stops seeing it.</p>
      <label>Reason (kept for your team)<input maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Keep the review open</button><button className="primary" disabled={busy}>Withdraw review</button></div>
    </form>
  </Modal>
}
