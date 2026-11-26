import { useId, useRef, useState } from 'react'
import { hubAddComment, hubComments, hubDeleteComment, hubEditComment, hubUpload, type Comment } from '../../lib/hub'
import { AttachmentPicker, Avatar, Empty, ErrorState, FileRow, Skeleton } from './hubShared'
import { errorText, timeAgo, useHub, useLoad } from './hubKit'

// A conversation the client can see: a project thread, a deliverable thread or a feedback item's replies. Bodies are plain
// text (rendered with white-space: pre-wrap, never as HTML). One level of replies; people edit and delete their own.

interface Scope { deliverableId?: string; feedbackId?: string }

function Composer({ placeholder, submitLabel, onSubmit, autoFocus = false, onCancel, allowFiles = true }: {
  placeholder: string; submitLabel: string; onSubmit: (body: string, files: File[]) => Promise<void>; autoFocus?: boolean; onCancel?: () => void; allowFiles?: boolean
}) {
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const fieldId = useId()
  return <form className="hb-composer" onSubmit={async event => {
    event.preventDefault()
    if (!body.trim()) { setProblem('Write a message first.'); return }
    setBusy(true); setProblem('')
    try { await onSubmit(body, files); setBody(''); setFiles([]) } catch (cause) { setProblem(errorText(cause)) } finally { setBusy(false) }
  }}>
    <label htmlFor={fieldId} className="hb-sr">{placeholder}</label>
    <textarea id={fieldId} value={body} onChange={event => setBody(event.target.value)} placeholder={placeholder} rows={autoFocus ? 2 : 3} maxLength={5000} autoFocus={autoFocus} disabled={busy}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit() }} />
    {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
    <div className="hb-composer-row">
      {allowFiles ? <AttachmentPicker files={files} onChange={setFiles} disabled={busy} /> : <span />}
      <div className="hb-composer-actions">
        {onCancel && <button type="button" className="hb-btn is-ghost is-sm" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button type="submit" className="hb-btn is-primary is-sm" disabled={busy}>{busy ? 'Sending…' : submitLabel}</button>
      </div>
    </div>
  </form>
}

function CommentItem({ comment, mine, onReply, onChanged }: { comment: Comment; mine: boolean; onReply?: () => void; onChanged: (next: Comment) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const editId = useId()
  if (comment.deleted) return <article className="hb-comment is-deleted"><p className="hb-comment-deleted">Comment deleted</p></article>
  return <article className={`hb-comment${comment.authorType === 'member' ? ' is-agency' : ''}`}>
    <Avatar name={comment.author} size="sm" />
    <div className="hb-comment-main">
      <header>
        <strong>{comment.author}</strong>
        {comment.authorType === 'member' && <span className="hb-tag">Agency</span>}
        <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>{timeAgo(comment.createdAt)}</time>
        {comment.editedAt && <span className="hb-muted">· edited</span>}
      </header>
      {editing ? <form className="hb-edit" onSubmit={async event => {
        event.preventDefault(); setBusy(true); setProblem('')
        try { onChanged(await hubEditComment(comment.id, draft)); setEditing(false) } catch (cause) { setProblem(errorText(cause)) } finally { setBusy(false) }
      }}>
        <label htmlFor={editId} className="hb-sr">Edit your comment</label>
        <textarea id={editId} value={draft} onChange={event => setDraft(event.target.value)} rows={3} maxLength={5000} disabled={busy} autoFocus />
        {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
        <div className="hb-composer-actions"><button type="button" className="hb-btn is-ghost is-sm" onClick={() => { setEditing(false); setDraft(comment.body) }} disabled={busy}>Cancel</button>
          <button type="submit" className="hb-btn is-primary is-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form> : <p className="hb-comment-body">{comment.body}</p>}
      {comment.files.length > 0 && <ul className="hb-files is-compact">{comment.files.map(file => <FileRow key={file.id} file={file} />)}</ul>}
      {!editing && <div className="hb-comment-actions">
        {onReply && <button type="button" className="hb-text-btn" onClick={onReply}>Reply</button>}
        {mine && <>
          <button type="button" className="hb-text-btn" onClick={() => { setDraft(comment.body); setEditing(true) }}>Edit</button>
          <button type="button" className="hb-text-btn is-danger" disabled={busy} onClick={async () => {
            if (!window.confirm('Delete this comment? This can’t be undone.')) return
            setBusy(true); setProblem('')
            try { onChanged(await hubDeleteComment(comment.id)) } catch (cause) { setProblem(errorText(cause)) } finally { setBusy(false) }
          }}>Delete</button>
        </>}
        {problem && !editing && <span className="hb-inline-error" role="alert">{problem}</span>}
      </div>}
    </div>
  </article>
}

export function CommentThread({ projectId, scope = {}, emptyTitle = 'No messages yet', emptyText = 'Start the conversation with your agency.', placeholder = 'Write a message to your agency…' }: {
  projectId: string; scope?: Scope; emptyTitle?: string; emptyText?: string; placeholder?: string
}) {
  const { accessId } = useHub()
  const key = `${projectId}:${scope.deliverableId ?? ''}:${scope.feedbackId ?? ''}`
  const { data, error, loading, reload, replace } = useLoad(key, () => hubComments(projectId, scope))
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const requests = useRef(new Map<string, string>())
  const requestFor = (slot: string) => { let value = requests.current.get(slot); if (!value) { value = crypto.randomUUID(); requests.current.set(slot, value) } return value }
  const post = async (body: string, files: File[], parentId: string | null) => {
    const slot = parentId ?? 'root'
    const created = await hubAddComment(projectId, { body, deliverableId: scope.deliverableId ?? null, feedbackId: scope.feedbackId ?? null, parentId }, requestFor(slot))
    requests.current.delete(slot)
    let failedUploads = 0
    for (const file of files) { try { await hubUpload(projectId, file, { commentId: created.id }) } catch { failedUploads += 1 } }
    setReplyTo(null)
    setStatus(failedUploads ? `Message sent. ${failedUploads} file${failedUploads === 1 ? '' : 's'} couldn’t be attached.` : 'Message sent.')
    if (files.length) reload(); else replace([...(data ?? []), created])
  }
  const update = (next: Comment) => replace((data ?? []).map(comment => comment.id === next.id ? next : comment))
  if (loading) return <Skeleton rows={3} label="Loading messages…" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  const comments = data ?? []
  const roots = comments.filter(comment => !comment.parentId || !comments.some(other => other.id === comment.parentId))
  return <div className="hb-thread">
    {roots.length === 0 ? <Empty icon="chat" title={emptyTitle}>{emptyText}</Empty> : <ol className="hb-thread-list">
      {roots.map(root => {
        const replies = comments.filter(comment => comment.parentId === root.id)
        return <li key={root.id}>
          <CommentItem comment={root} mine={root.authorAccessId === accessId} onReply={root.deleted ? undefined : () => setReplyTo(replyTo === root.id ? null : root.id)} onChanged={update} />
          {(replies.length > 0 || replyTo === root.id) && <ol className="hb-replies">
            {replies.map(reply => <li key={reply.id}><CommentItem comment={reply} mine={reply.authorAccessId === accessId} onChanged={update} /></li>)}
            {replyTo === root.id && <li><Composer placeholder={`Reply to ${root.author}…`} submitLabel="Reply" autoFocus allowFiles={false} onCancel={() => setReplyTo(null)} onSubmit={(body, files) => post(body, files, root.id)} /></li>}
          </ol>}
        </li>
      })}
    </ol>}
    <Composer placeholder={placeholder} submitLabel="Send" onSubmit={(body, files) => post(body, files, null)} />
    <p className={status ? 'hb-note' : 'hb-sr'} role="status" aria-live="polite">{status}</p>
  </div>
}
