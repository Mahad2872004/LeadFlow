import { useId, useRef, useState } from 'react'
import { dateLabel } from '../../lib/format'
import { decisionLabels, feedbackCategories, feedbackCategoryLabels, feedbackStatusLabels, type FeedbackCategory, type FeedbackStatus } from '../../lib/collaboration'
import { hubAddFeedback, hubDecide, hubDeliverable, hubReviewLabels, hubUpload, type Feedback, type HubDeliverable, type Review, type Version } from '../../lib/hub'
import { Icon } from '../Icon'
import { CommentThread } from './HubComments'
import { AttachmentPicker, Chip, Empty, ErrorState, FileRow, HubDialog, PageHead, Section, Skeleton } from './hubShared'
import { dueText, errorText, feedbackTone, reviewTone, timeAgo, useHub, useLoad } from './hubKit'

// The review experience: see each shared version, then approve it, request changes with structured feedback, or reject it.
// Every decision applies to one version only and is recorded once (request IDs make retries safe).

const clientFeedbackStatus = (status: FeedbackStatus) => status === 'clarification_requested' ? 'Question for you' : feedbackStatusLabels[status]
interface DraftItem { key: string; title: string; category: FeedbackCategory; body: string; files: File[] }
const blankItem = (): DraftItem => ({ key: crypto.randomUUID(), title: '', category: 'design', body: '', files: [] })

/** Uploads each item's files to the feedback created for it (matched by title, in order). Returns how many failed. */
async function attachToFeedback(projectId: string, items: DraftItem[], created: Feedback[]) {
  const unused = [...created]
  let failed = 0
  for (const item of items) {
    const index = unused.findIndex(feedback => feedback.title === item.title.trim())
    const match = index >= 0 ? unused.splice(index, 1)[0] : null
    for (const file of item.files) {
      if (!match) { failed += 1; continue }
      try { await hubUpload(projectId, file, { feedbackId: match.id }) } catch { failed += 1 }
    }
  }
  return failed
}

function FeedbackItemFields({ item, index, total, disabled, onChange, onRemove }: { item: DraftItem; index: number; total: number; disabled: boolean; onChange: (next: DraftItem) => void; onRemove: () => void }) {
  const titleId = useId(), categoryId = useId(), bodyId = useId()
  return <fieldset className="hb-feedback-item">
    <legend>{total > 1 ? `Change ${index + 1}` : 'What needs to change'}</legend>
    <div className="hb-field-row">
      <div className="hb-field is-grow"><label htmlFor={titleId}>Title</label><input id={titleId} required maxLength={150} value={item.title} disabled={disabled} placeholder="e.g. Make the booking button more visible" onChange={event => onChange({ ...item, title: event.target.value })} /></div>
      <div className="hb-field"><label htmlFor={categoryId}>Type</label><select id={categoryId} value={item.category} disabled={disabled} onChange={event => onChange({ ...item, category: event.target.value as FeedbackCategory })}>
        {feedbackCategories.map(key => <option key={key} value={key}>{feedbackCategoryLabels[key]}</option>)}</select></div>
    </div>
    <div className="hb-field"><label htmlFor={bodyId}>Details <span className="hb-muted">(optional)</span></label><textarea id={bodyId} rows={3} maxLength={4000} value={item.body} disabled={disabled} placeholder="Where, what and why — the more specific, the faster it’s fixed." onChange={event => onChange({ ...item, body: event.target.value })} /></div>
    <div className="hb-feedback-item-foot">
      <AttachmentPicker files={item.files} onChange={files => onChange({ ...item, files })} disabled={disabled} label="Attach screenshots or files" />
      {total > 1 && <button type="button" className="hb-text-btn is-danger" disabled={disabled} onClick={onRemove}>Remove</button>}
    </div>
  </fieldset>
}

function ChangesDialog({ deliverable, review, onClose, onDone }: { deliverable: HubDeliverable; review: Review; onClose: () => void; onDone: (next: HubDeliverable, note: string) => void }) {
  const [items, setItems] = useState<DraftItem[]>([blankItem()])
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const request = useRef(crypto.randomUUID())
  const commentId = useId()
  return <HubDialog title={`Request changes to version ${review.versionNumber}`} onClose={() => { if (!busy) onClose() }} wide>
    <form className="hb-form" onSubmit={async event => {
      event.preventDefault()
      const filled = items.filter(item => item.title.trim())
      if (!filled.length && !comment.trim()) { setProblem('Add at least one change, or describe what you need in the comment.'); return }
      setBusy(true); setProblem('')
      try {
        const next = await hubDecide(review.id, { decision: 'changes_requested', comment: comment.trim(), feedback: filled.map(item => ({ title: item.title.trim(), body: item.body.trim(), category: item.category })) }, request.current)
        const created = next.feedback.filter(feedback => feedback.reviewId === review.id && feedback.authorAccessId === next.accessId)
        const failed = await attachToFeedback(deliverable.projectId, filled, created)
        onDone(filled.some(item => item.files.length) ? await hubDeliverable(deliverable.id) : next, failed ? `Changes requested. ${failed} attachment${failed === 1 ? '' : 's'} couldn’t be uploaded; add them to the feedback below.` : 'Changes requested. Your agency has been notified.')
      } catch (cause) { setProblem(errorText(cause)); setBusy(false) }
    }}>
      <p className="hb-muted">List each change separately so your agency can track and confirm it. You’ll be able to review the revised version.</p>
      {items.map((item, index) => <FeedbackItemFields key={item.key} item={item} index={index} total={items.length} disabled={busy}
        onChange={next => setItems(items.map(other => other.key === item.key ? next : other))} onRemove={() => setItems(items.filter(other => other.key !== item.key))} />)}
      {items.length < 20 && <button type="button" className="hb-btn is-ghost is-sm" disabled={busy} onClick={() => setItems([...items, blankItem()])}><Icon name="plus" size={14} /> Add another change</button>}
      <div className="hb-field"><label htmlFor={commentId}>Overall comment <span className="hb-muted">(optional)</span></label><textarea id={commentId} rows={2} maxLength={4000} value={comment} disabled={busy} onChange={event => setComment(event.target.value)} /></div>
      {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
      <div className="hb-dialog-actions"><button type="button" className="hb-btn is-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="hb-btn is-warning" disabled={busy}>{busy ? 'Sending…' : 'Request changes'}</button></div>
    </form>
  </HubDialog>
}

function ApproveDialog({ deliverable, review, version, onClose, onDone }: { deliverable: HubDeliverable; review: Review; version: Version | undefined; onClose: () => void; onDone: (next: HubDeliverable, note: string) => void }) {
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const request = useRef(crypto.randomUUID())
  const commentId = useId()
  return <HubDialog title={`Approve version ${review.versionNumber}?`} onClose={() => { if (!busy) onClose() }}>
    <form className="hb-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setProblem('')
      try { onDone(await hubDecide(review.id, { decision: 'approved', comment: comment.trim(), feedback: [] }, request.current), `You approved version ${review.versionNumber}. Your agency has been notified.`) }
      catch (cause) { setProblem(errorText(cause)); setBusy(false) }
    }}>
      <div className="hb-confirm">
        <p>You’re approving <strong>{deliverable.title}</strong>, <strong>version {review.versionNumber}</strong>{version?.files.length ? ', with these files:' : '.'}</p>
        {version && version.files.length > 0 && <ul>{version.files.map(file => <li key={file.id}><Icon name="clipboard" size={14} /> {file.fileName}</li>)}</ul>}
        <p className="hb-muted">Your approval applies to this version only and is recorded with your name and the time. If your agency changes the work later, they’ll ask you to review the new version.</p>
      </div>
      <div className="hb-field"><label htmlFor={commentId}>Comment <span className="hb-muted">(optional)</span></label><textarea id={commentId} rows={2} maxLength={4000} value={comment} disabled={busy} onChange={event => setComment(event.target.value)} /></div>
      {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
      <div className="hb-dialog-actions"><button type="button" className="hb-btn is-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="hb-btn is-success" disabled={busy}>{busy ? 'Approving…' : `Approve version ${review.versionNumber}`}</button></div>
    </form>
  </HubDialog>
}

function RejectDialog({ deliverable, review, onClose, onDone }: { deliverable: HubDeliverable; review: Review; onClose: () => void; onDone: (next: HubDeliverable, note: string) => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const request = useRef(crypto.randomUUID())
  const reasonId = useId()
  return <HubDialog title={`Reject version ${review.versionNumber}?`} onClose={() => { if (!busy) onClose() }}>
    <form className="hb-form" onSubmit={async event => {
      event.preventDefault()
      if (!reason.trim()) { setProblem('Tell your agency why, so they know what to do next.'); return }
      setBusy(true); setProblem('')
      try { onDone(await hubDecide(review.id, { decision: 'rejected', comment: reason.trim(), feedback: [] }, request.current), `You rejected version ${review.versionNumber}. Your agency has been notified.`) }
      catch (cause) { setProblem(errorText(cause)); setBusy(false) }
    }}>
      <p>Rejecting says <strong>{deliverable.title}</strong> (version {review.versionNumber}) isn’t the right direction. If it only needs changes, use <em>Request changes</em> instead.</p>
      <div className="hb-field"><label htmlFor={reasonId}>Reason</label><textarea id={reasonId} rows={4} required maxLength={4000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></div>
      {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
      <div className="hb-dialog-actions"><button type="button" className="hb-btn is-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="hb-btn is-danger" disabled={busy}>{busy ? 'Rejecting…' : `Reject version ${review.versionNumber}`}</button></div>
    </form>
  </HubDialog>
}

function AddFeedbackDialog({ deliverable, onClose, onDone }: { deliverable: HubDeliverable; onClose: () => void; onDone: (note: string) => void }) {
  const [item, setItem] = useState<DraftItem>(blankItem())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const request = useRef(crypto.randomUUID())
  const latest = deliverable.versions[0]
  return <HubDialog title="Add feedback" onClose={() => { if (!busy) onClose() }} wide>
    <form className="hb-form" onSubmit={async event => {
      event.preventDefault()
      if (!item.title.trim()) { setProblem('Give your feedback a short title.'); return }
      setBusy(true); setProblem('')
      try {
        const created = await hubAddFeedback(deliverable.id, { title: item.title.trim(), body: item.body.trim(), category: item.category, versionId: latest?.id }, request.current)
        const failed = await attachToFeedback(deliverable.projectId, [item], [created])
        onDone(failed ? `Feedback sent. ${failed} attachment${failed === 1 ? '' : 's'} couldn’t be uploaded.` : 'Feedback sent. Your agency has been notified.')
      } catch (cause) { setProblem(errorText(cause)); setBusy(false) }
    }}>
      <p className="hb-muted">On version {latest?.number ?? '—'}. Feedback doesn’t approve or reject the work; it goes to your agency and to whoever reviews it.</p>
      <FeedbackItemFields item={item} index={0} total={1} disabled={busy} onChange={setItem} onRemove={() => undefined} />
      {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
      <div className="hb-dialog-actions"><button type="button" className="hb-btn is-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="hb-btn is-primary" disabled={busy}>{busy ? 'Sending…' : 'Send feedback'}</button></div>
    </form>
  </HubDialog>
}

function FeedbackCard({ feedback, projectId }: { feedback: Feedback; projectId: string }) {
  const [open, setOpen] = useState(feedback.status === 'clarification_requested')
  return <li className="hb-feedback">
    <div className="hb-feedback-head">
      <div><strong>{feedback.title}</strong><small>{feedbackCategoryLabels[feedback.category]} · version {feedback.versionNumber} · {feedback.author} · {timeAgo(feedback.createdAt)}</small></div>
      <Chip tone={feedbackTone(feedback.status)}>{clientFeedbackStatus(feedback.status)}</Chip>
    </div>
    {feedback.body && <p className="hb-prose">{feedback.body}</p>}
    {(feedback.statusNote || feedback.addressedInVersion) && <p className="hb-agency-note"><Icon name="chat" size={14} /> <span>{feedback.statusNote}{feedback.addressedInVersion ? `${feedback.statusNote ? ' · ' : ''}Addressed in version ${feedback.addressedInVersion}` : ''}</span></p>}
    {feedback.files.length > 0 && <ul className="hb-files is-compact">{feedback.files.map(file => <FileRow key={file.id} file={file} />)}</ul>}
    <button type="button" className="hb-text-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide replies' : 'Replies'}</button>
    {open && <div className="hb-feedback-thread"><CommentThread projectId={projectId} scope={{ feedbackId: feedback.id }} emptyTitle="No replies yet" emptyText="Your agency’s replies about this feedback appear here." placeholder="Reply about this feedback…" /></div>}
  </li>
}

const decisionTone = (decision: string) => decision === 'approved' ? 'success' : decision === 'rejected' ? 'danger' : 'warning'

export function DeliverablePage({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const hub = useHub()
  const { data, error, loading, reload, replace } = useLoad(`deliverable:${deliverableId}`, () => hubDeliverable(deliverableId))
  const [dialog, setDialog] = useState<'' | 'approve' | 'changes' | 'reject' | 'feedback'>('')
  const [note, setNote] = useState('')
  const [shownVersion, setShownVersion] = useState<string | null>(null)
  if (loading) return <div className="hb-page"><Skeleton rows={3} /><Skeleton rows={5} /></div>
  if (error || !data) return <div className="hb-page"><PageHead back={{ to: `/portal/projects/${projectId}/deliverables`, label: 'Deliverables' }} title="Deliverable unavailable" />
    <ErrorState message={error === 'Not found.' ? 'This deliverable isn’t shared with you any more, or your access changed.' : error ?? ''} onRetry={error === 'Not found.' ? undefined : reload} /></div>
  const open = data.reviews.find(review => review.status === 'open')
  const latestDecision = data.reviews.find(review => review.decision)?.decision
  const underReview = open ? data.versions.find(version => version.id === open.versionId) : undefined
  const selected = data.versions.find(version => version.id === (shownVersion ?? open?.versionId ?? data.versions[0]?.id))
  const decisionFor = (version: Version) => data.reviews.find(review => review.versionId === version.id && review.decision)?.decision
  const finish = (next: HubDeliverable | null, message: string) => { setDialog(''); setNote(message); if (next) replace(next); else reload(); hub.refreshUnread() }
  return <div className="hb-page">
    <PageHead back={{ to: `/portal/projects/${data.projectId}/deliverables`, label: data.projectName }} eyebrow="Deliverable" title={data.title}
      actions={<Chip tone={reviewTone(data.reviewStatus)}>{hubReviewLabels[data.reviewStatus]}</Chip>}
      description={[data.latestVersion ? `Version ${data.latestVersion}` : null, data.dueDate ? `Due ${dateLabel(data.dueDate)}` : null, data.completed ? 'Delivered' : null].filter(Boolean).join(' · ') || undefined} />
    <div className={note ? 'hb-notice is-success' : 'hb-sr'} role="status" aria-live="polite">{note && <><Icon name="check" size={16} /><p>{note}</p>
      <button type="button" className="hb-icon-btn is-sm" aria-label="Dismiss message" onClick={() => setNote('')}><Icon name="close" size={12} /></button></>}</div>
    {open ? <section className="hb-review-panel" aria-labelledby="hb-review-title">
      <div className="hb-review-panel-head">
        <span className="hb-review-badge" aria-hidden="true"><Icon name="check" size={20} /></span>
        <div><h2 id="hb-review-title">Version {open.versionNumber} is ready for your review</h2>
          <p className="hb-muted">Requested by {open.requestedBy} {timeAgo(open.createdAt)} · <span className={dueText(open.dueDate).includes('overdue') ? 'hb-late' : ''}>{dueText(open.dueDate)}</span>{open.reviewers.length ? ` · assigned to ${open.reviewers.join(', ')}` : ''}</p></div>
      </div>
      {open.message && <blockquote className="hb-agency-message"><p>{open.message}</p></blockquote>}
      {data.canDecide ? <div className="hb-decide">
        <button type="button" className="hb-btn is-success" onClick={() => setDialog('approve')}><Icon name="check" size={16} /> Approve</button>
        <button type="button" className="hb-btn is-warning" onClick={() => setDialog('changes')}>Request changes</button>
        <button type="button" className="hb-btn is-ghost is-danger" onClick={() => setDialog('reject')}>Reject</button>
      </div> : <div className="hb-decide is-feedback">
        <p className="hb-muted">{data.role === 'member' ? 'Your role can comment and give feedback; approvals are made by your organization’s reviewers and admins.' : 'This review was assigned to someone else. You can still add feedback.'}</p>
        {data.canGiveFeedback && <button type="button" className="hb-btn is-primary" onClick={() => setDialog('feedback')}>Add feedback</button>}
      </div>}
    </section> : <section className="hb-review-panel is-quiet">
      {latestDecision ? <p><Chip tone={decisionTone(latestDecision.decision)}>{decisionLabels[latestDecision.decision]}</Chip> Version {latestDecision.versionNumber} · {latestDecision.reviewer} · {dateLabel(latestDecision.createdAt)}{latestDecision.comment ? <span className="hb-quote">“{latestDecision.comment}”</span> : null}</p>
        : <p className="hb-muted">{data.versions.length ? 'Shared with you for information. Your agency will ask when they need a decision.' : 'Your agency hasn’t shared files for this deliverable yet.'}</p>}
      {data.canGiveFeedback && <button type="button" className="hb-btn is-secondary is-sm" onClick={() => setDialog('feedback')}>Add feedback</button>}
    </section>}
    {data.description && <Section title="About this deliverable"><p className="hb-prose">{data.description}</p></Section>}
    <Section title="Versions">
      {data.versions.length === 0 ? <Empty icon="clipboard" title="No versions shared yet" /> : <div className="hb-versions">
        {data.versions.length > 1 && <div className="hb-version-tabs" role="tablist" aria-label="Versions">
          {data.versions.map(version => <button key={version.id} type="button" role="tab" aria-selected={selected?.id === version.id} className={selected?.id === version.id ? 'is-active' : ''} onClick={() => setShownVersion(version.id)}>
            v{version.number}{version.id === underReview?.id ? <i className="hb-dot-inline is-info" aria-label="under review" /> : decisionFor(version) ? <i className={`hb-dot-inline is-${decisionTone(decisionFor(version)!.decision)}`} aria-label={decisionLabels[decisionFor(version)!.decision]} /> : null}
          </button>)}
        </div>}
        {selected && <article className="hb-version" role={data.versions.length > 1 ? 'tabpanel' : undefined}>
          <header><h3>Version {selected.number}</h3>
            <small>Shared {selected.publishedAt ? dateLabel(selected.publishedAt) : ''} by {selected.createdBy}</small>
            {selected.id === underReview?.id ? <Chip tone="info">Under review</Chip> : decisionFor(selected) ? <Chip tone={decisionTone(decisionFor(selected)!.decision)}>{decisionLabels[decisionFor(selected)!.decision]}</Chip> : null}
          </header>
          {selected.notes && <div className="hb-version-notes"><p className="hb-eyebrow">What changed</p><p className="hb-prose">{selected.notes}</p></div>}
          {selected.files.length ? <ul className="hb-files">{selected.files.map(file => <FileRow key={file.id} file={file} />)}</ul> : <p className="hb-muted">No files in this version.</p>}
        </article>}
      </div>}
    </Section>
    <Section title={`Feedback${data.feedback.length ? ` (${data.feedback.length})` : ''}`}>
      {data.feedback.length ? <ul className="hb-feedback-list">{data.feedback.map(feedback => <FeedbackCard key={feedback.id} feedback={feedback} projectId={data.projectId} />)}</ul>
        : <Empty icon="chat" title="No feedback yet">Feedback you and your colleagues give appears here, with your agency’s replies.</Empty>}
    </Section>
    {data.reviews.length > 0 && <Section title="Review history">
      <ol className="hb-history">{data.reviews.map(review => <li key={review.id}>
        <span className={`hb-history-dot is-${review.decision ? decisionTone(review.decision.decision) : 'info'}`} aria-hidden="true" />
        <div><strong>Version {review.versionNumber}</strong> · review requested {dateLabel(review.createdAt)} by {review.requestedBy}
          {review.decision ? <p><Chip tone={decisionTone(review.decision.decision)}>{decisionLabels[review.decision.decision]}</Chip> by {review.decision.reviewer} on {dateLabel(review.decision.createdAt)}
            {review.decision.comment && <span className="hb-quote">“{review.decision.comment}”</span>}</p> : <p className="hb-muted">Waiting for a decision</p>}
        </div>
      </li>)}</ol>
    </Section>}
    <Section title="Discussion"><CommentThread projectId={data.projectId} scope={{ deliverableId: data.id }} emptyText="Questions or comments about this deliverable go here." placeholder="Write about this deliverable…" /></Section>
    {dialog === 'approve' && open && <ApproveDialog deliverable={data} review={open} version={underReview} onClose={() => setDialog('')} onDone={finish} />}
    {dialog === 'changes' && open && <ChangesDialog deliverable={data} review={open} onClose={() => setDialog('')} onDone={finish} />}
    {dialog === 'reject' && open && <RejectDialog deliverable={data} review={open} onClose={() => setDialog('')} onDone={finish} />}
    {dialog === 'feedback' && <AddFeedbackDialog deliverable={data} onClose={() => setDialog('')} onDone={message => finish(null, message)} />}
  </div>
}
