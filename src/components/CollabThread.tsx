import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { formatBytes } from '../lib/clients'
import { errorText } from '../lib/sales'
import { uploadProjectFile } from '../lib/projects'
import {
  addComment, collabTime, commentHistory, deleteComment, editComment, projectComments,
  type CollabDocument, type Comment, type CommentVisibility,
} from '../lib/collaboration'
import { AgencyFiles } from './CollabBits'

type AgencyComment = Comment<CollabDocument>
interface ThreadProps {
  workspace: WorkspaceSummary; projectId: string; clientId: string; userId: string; manager: boolean; locked: boolean
  /** No scope: the project's own discussion. */
  scope?: { deliverableId?: string; feedbackId?: string; versionId?: string }
  /** Whether a client-visible message is possible here (the deliverable is shared, for example), and why not. */
  clientAllowed: boolean; clientBlocked?: string
  /** A suggested text (from the AI assistant) to place in the composer; the person still edits and sends it. */
  draft?: { text: string; key: number } | null
  config: { maxBytes: number; extensions: string[] } | null
  emptyText: string; label: string; onChanged?: () => void
}

/**
 * A discussion with explicit visibility on every message: internal notes stay with the team, client-visible messages
 * appear on the portal. Plain text only. Authors edit their own comments (earlier text is kept); authors, owners and
 * admins can delete (the text stays in the team's history).
 */
export function CollabThread({ workspace, projectId, clientId, userId, manager, locked, scope = {}, clientAllowed, clientBlocked, draft, config, emptyText, label, onChanged }: ThreadProps) {
  const [comments, setComments] = useState<AgencyComment[] | null>(null), [error, setError] = useState(''), [replyTo, setReplyTo] = useState<AgencyComment | null>(null)
  const { deliverableId, feedbackId } = scope
  const load = useCallback(() => projectComments(workspace.id, projectId, { deliverableId, feedbackId }).then(value => { setComments(value as AgencyComment[]); setError('') }), [workspace.id, projectId, deliverableId, feedbackId])
  useEffect(() => {
    let active = true
    projectComments(workspace.id, projectId, { deliverableId, feedbackId }).then(value => { if (active) setComments(value as AgencyComment[]) }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, projectId, deliverableId, feedbackId])
  const refresh = async () => { await load().catch(cause => setError(errorText(cause))); onChanged?.() }
  const top = (comments ?? []).filter(comment => !comment.parentId)
  const replies = (parent: string) => (comments ?? []).filter(comment => comment.parentId === parent)
  const shared = { workspace, userId, manager, locked, onChanged: refresh, onError: setError }
  return <div className="cb-thread" aria-label={label}>
    {error && <p className="sp-error" role="alert">{error}</p>}
    {!comments ? <p className="sp-muted" role="status">Loading messages…</p> : !top.length ? <p className="sp-muted">{emptyText}</p>
      : <ul className="cb-comments">{top.map(comment => <li key={comment.id}>
        <CommentView comment={comment} {...shared} onReply={locked || comment.deleted ? undefined : () => setReplyTo(comment)} />
        {(replies(comment.id).length > 0 || replyTo?.id === comment.id) && <ul className="cb-replies">
          {replies(comment.id).map(reply => <li key={reply.id}><CommentView comment={reply} {...shared} /></li>)}
          {replyTo?.id === comment.id && <li><Composer workspace={workspace} projectId={projectId} clientId={clientId} scope={scope} parent={comment} config={config}
            clientAllowed={clientAllowed && comment.visibility === 'client'} clientBlocked={comment.visibility === 'internal' ? 'Replies to an internal note stay internal.' : clientBlocked}
            onCancel={() => setReplyTo(null)} onPosted={async () => { setReplyTo(null); await refresh() }} /></li>}
        </ul>}
      </li>)}</ul>}
    {!locked && <Composer workspace={workspace} projectId={projectId} clientId={clientId} scope={scope} config={config} clientAllowed={clientAllowed} clientBlocked={clientBlocked}
      draft={draft} onPosted={refresh} />}
  </div>
}

function CommentView({ comment, workspace, userId, manager, locked, onChanged, onError, onReply }: {
  comment: AgencyComment; workspace: WorkspaceSummary; userId: string; manager: boolean; locked: boolean; onChanged: () => Promise<void>; onError: (message: string) => void; onReply?: () => void
}) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(comment.body), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false)
  const [history, setHistory] = useState<{ body: string; action: string; at: string; by: string }[] | null>(null)
  const own = comment.authorType === 'member' && comment.memberId === userId
  const fromClient = comment.authorType === 'client'
  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    try { await action(); await onChanged(); return true } catch (cause) { onError(errorText(cause)); return false } finally { setBusy(false) }
  }
  const showHistory = () => history ? setHistory(null) : void commentHistory(workspace.id, comment.id).then(setHistory).catch(cause => onError(errorText(cause)))
  return <article className={`cb-comment is-${comment.visibility}${fromClient ? ' is-from-client' : ''}`}>
    <header className="cb-comment-head">
      <strong>{comment.author}</strong>
      <span className={`cb-tag${comment.visibility === 'client' ? ' is-client' : ''}`}>{fromClient ? 'From the client' : comment.visibility === 'client' ? 'Visible to client' : 'Internal note'}</span>
      <time dateTime={comment.createdAt}>{collabTime(comment.createdAt)}</time>
      {comment.editedAt && !comment.deleted && <span className="cb-quiet">Edited</span>}
      {(comment.revisions ?? 0) > 0 && <button type="button" className="text-button" aria-expanded={!!history} onClick={showHistory}>{history ? 'Hide history' : 'History'}</button>}
    </header>
    {comment.deleted ? <p className="cb-deleted">This comment was deleted{comment.deletedAt ? ` on ${collabTime(comment.deletedAt)}` : ''}.</p>
      : editing ? <form onSubmit={event => { event.preventDefault(); void run(() => editComment(workspace.id, comment.id, text.trim())).then(ok => { if (ok) setEditing(false) }) }}>
        <label className="sr-only" htmlFor={`edit-${comment.id}`}>Edit comment</label>
        <textarea id={`edit-${comment.id}`} rows={3} maxLength={5000} value={text} onChange={event => setText(event.target.value)} />
        <div className="cb-comment-actions"><button className="text-button" disabled={busy || !text.trim()}>Save</button><button type="button" className="text-button" onClick={() => { setEditing(false); setText(comment.body) }}>Cancel</button>
          <span className="sp-muted">The earlier text is kept in this comment’s history.</span></div>
      </form> : <p className="cb-body">{comment.body}</p>}
    {!comment.deleted && comment.files.length > 0 && <AgencyFiles workspace={workspace} files={comment.files} onError={onError} />}
    {history && <ul className="cb-history" aria-label="Earlier versions">{history.length ? history.map((entry, index) => <li key={index}>
      <strong>{entry.action === 'deleted' ? 'Deleted' : 'Before an edit'}</strong> · {entry.by} · {collabTime(entry.at)}<p>{entry.body}</p></li>) : <li>No earlier versions.</li>}</ul>}
    {!comment.deleted && !editing && !locked && <div className="cb-comment-actions">
      {onReply && <button type="button" className="text-button" onClick={onReply}>Reply</button>}
      {own && <button type="button" className="text-button" onClick={() => { setText(comment.body); setEditing(true) }}>Edit</button>}
      {(own || manager) && (confirming ? <span role="group" aria-label="Confirm delete">
        <button type="button" className="text-button" disabled={busy} onClick={() => void run(() => deleteComment(workspace.id, comment.id))}>Delete{fromClient ? ' the client’s comment' : ''}</button>{' '}
        <button type="button" className="text-button" onClick={() => setConfirming(false)}>Keep</button></span>
        : <button type="button" className="text-button" onClick={() => setConfirming(true)}>Delete</button>)}
    </div>}
  </article>
}

function Composer({ workspace, projectId, clientId, scope, parent, config, clientAllowed, clientBlocked, draft, onCancel, onPosted }: {
  workspace: WorkspaceSummary; projectId: string; clientId: string; scope: { deliverableId?: string; feedbackId?: string; versionId?: string }; parent?: AgencyComment
  config: { maxBytes: number; extensions: string[] } | null; clientAllowed: boolean; clientBlocked?: string; draft?: { text: string; key: number } | null
  onCancel?: () => void; onPosted: () => Promise<void>
}) {
  const [body, setBody] = useState(''), [visibility, setVisibility] = useState<CommentVisibility>('internal'), [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), requestId = useRef<string | null>(null), fileInput = useRef<HTMLInputElement>(null)
  const lastDraft = useRef<number | null>(null)
  // A new AI suggestion fills the box once; it is never sent without the person pressing Send.
  useEffect(() => {
    if (draft && draft.key !== lastDraft.current) { lastDraft.current = draft.key; setBody(draft.text) }
  }, [draft])
  const effective: CommentVisibility = clientAllowed ? visibility : 'internal'
  async function send() {
    const text = body.trim()
    if (!text || busy) return
    const tooBig = config ? files.find(file => file.size > config.maxBytes) : undefined
    if (tooBig) { setError(`${tooBig.name} is larger than ${formatBytes(config!.maxBytes)}.`); return }
    setBusy(true); setError('')
    requestId.current ??= crypto.randomUUID()
    try {
      const created = await addComment(workspace.id, projectId, { body: text, visibility: effective, deliverableId: scope.deliverableId ?? null, feedbackId: scope.feedbackId ?? null,
        versionId: scope.versionId ?? null, parentId: parent?.id ?? null }, requestId.current)
      requestId.current = null
      const failed: string[] = []
      for (const file of files) {
        try { await uploadProjectFile(workspace.id, { clientId, projectId, commentId: created.id }, file, { category: 'other', description: '', visibility: effective === 'client' ? 'shared' : 'internal' }) }
        catch (cause) { failed.push(`${file.name}: ${errorText(cause)}`) }
      }
      setBody(''); setFiles([]); if (fileInput.current) fileInput.current.value = ''
      if (failed.length) setError(`The message was sent, but some files weren’t attached. ${failed.join(' ')}`)
      await onPosted()
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  const id = `${parent?.id ?? scope.feedbackId ?? scope.deliverableId ?? projectId}-composer`
  return <form className={`cb-composer${effective === 'client' ? ' is-client' : ''}`} onSubmit={event => { event.preventDefault(); void send() }}>
    <label className="sr-only" htmlFor={id}>{parent ? `Reply to ${parent.author}` : 'New message'}</label>
    <textarea id={id} rows={3} maxLength={5000} placeholder={parent ? `Reply to ${parent.author}…` : effective === 'client' ? 'Write a message the client will see…' : 'Write an internal note for your team…'}
      value={body} onChange={event => setBody(event.target.value)} />
    <div className="cb-composer-foot">
      <label className="sp-inline">Who sees it<select value={effective} disabled={!clientAllowed} onChange={event => setVisibility(event.target.value as CommentVisibility)}>
        <option value="internal">Internal note: your team only</option><option value="client">Visible to the client</option></select></label>
      <label className="cb-attach">Attach<input ref={fileInput} type="file" multiple accept={config?.extensions.map(item => `.${item}`).join(',')} onChange={event => setFiles([...(event.target.files ?? [])].slice(0, 5))} /></label>
      <span className="sp-actions">{onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancel</button>}
        <button className="primary" disabled={busy || !body.trim()}>{busy ? 'Sending…' : effective === 'client' ? 'Send to client' : 'Add note'}</button></span>
    </div>
    {!clientAllowed && clientBlocked && <p className="cb-composer-note">{clientBlocked}</p>}
    {effective === 'client' && <p className="cb-composer-note">The client’s portal users who can open this project will see this message and get a notification.</p>}
    {error && <p className="sp-error" role="alert">{error}</p>}
  </form>
}
