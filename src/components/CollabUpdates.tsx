import { useRef, useState } from 'react'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import { errorText } from '../lib/sales'
import { deleteProjectFile } from '../lib/projects'
import { collabTime, conflict, deleteUpdate, publishUpdate, saveUpdate, type CollabDocument, type ProjectUpdate } from '../lib/collaboration'
import { AgencyFiles, UploadField } from './CollabBits'

type AgencyUpdate = ProjectUpdate<CollabDocument>

/**
 * Updates the agency publishes to the client. Drafts stay internal; publishing notifies the client. Internal activity
 * never becomes an update by itself. A published update can be corrected: it shows as corrected and the earlier text is kept.
 */
export function CollabUpdates({ workspace, projectId, clientId, shared, locked, updates, config, onChanged }: {
  workspace: WorkspaceSummary; projectId: string; clientId: string; shared: boolean; locked: boolean; updates: AgencyUpdate[]
  config: { maxBytes: number; extensions: string[] } | null; onChanged: (message?: string) => Promise<void>
}) {
  const [editing, setEditing] = useState<AgencyUpdate | 'new' | null>(null), [previewing, setPreviewing] = useState<AgencyUpdate | null>(null)
  const [publishing, setPublishing] = useState<AgencyUpdate | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function run(action: () => Promise<unknown>, message?: string) {
    setBusy(true); setError('')
    try { await action(); await onChanged(message); return true } catch (cause) { setError(errorText(cause)); return false } finally { setBusy(false) }
  }
  const drafts = updates.filter(item => item.status === 'draft'), published = updates.filter(item => item.status === 'published')
  return <section className="panel" aria-labelledby="cb-updates-title">
    <div className="section-heading"><div><h2 id="cb-updates-title">Updates for the client</h2><p>Short posts the client reads on their portal, such as “Design phase started”. Drafts stay internal until you publish.</p></div>
      {!locked && <div className="cb-heading-actions"><button className="secondary" onClick={() => setEditing('new')}>New update</button></div>}</div>
    <div className="cb-section-body">
      {error && <p className="sp-error" role="alert">{error}</p>}
      {!updates.length ? <p className="sp-muted">No updates yet.</p> : <ul className="cb-updates">
        {[...drafts, ...published].map(update => <li key={update.id} className={`cb-update${update.status === 'draft' ? ' is-draft' : ''}`}>
          <div className="cb-update-head"><h4>{update.title}</h4>
            <span className={`cb-tag${update.status === 'draft' ? ' is-draft' : ' is-client'}`}>{update.status === 'draft' ? 'Draft: internal' : 'Published'}</span></div>
          <p className="cb-update-meta">{update.status === 'published' ? `Published ${collabTime(update.publishedAt)}` : `Drafted by ${update.author}`}
            {update.correctedAt ? ` · corrected ${collabTime(update.correctedAt)}${update.revisions ? ` (${update.revisions} earlier version${update.revisions === 1 ? '' : 's'} kept)` : ''}` : ''}</p>
          {update.body && <p className="cb-body">{update.body}</p>}
          <AgencyFiles workspace={workspace} files={update.files} onError={setError}
            onRemove={!locked && update.status === 'draft' ? file => void run(() => deleteProjectFile(workspace.id, file.id), `${file.fileName} removed.`) : undefined} />
          {!locked && update.status === 'draft' && <div style={{ marginTop: 8 }}><UploadField workspace={workspace} target={{ clientId, projectId, updateId: update.id }} visibility="internal" label="Attach files"
            config={config} onUploaded={name => void onChanged(`${name} attached.`)} /></div>}
          {!locked && <div className="cb-comment-actions">
            <button type="button" className="text-button" onClick={() => setEditing(update)}>{update.status === 'draft' ? 'Edit' : 'Correct'}</button>
            {update.status === 'draft' && <>
              <button type="button" className="text-button" onClick={() => setPreviewing(update)}>Preview</button>
              <button type="button" className="text-button" disabled={busy || !shared} title={shared ? undefined : 'Share the project on the client portal first.'} onClick={() => setPublishing(update)}>Publish to client</button>
              <button type="button" className="text-button" disabled={busy} onClick={() => void run(() => deleteUpdate(workspace.id, update.id), 'Draft deleted.')}>Delete draft</button></>}
          </div>}
        </li>)}</ul>}
      {!shared && drafts.length > 0 && <p className="sp-muted">Share the project on the client portal before publishing.</p>}
    </div>
    {editing && <UpdateEditor workspace={workspace} projectId={projectId} update={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
      onSaved={async message => { setEditing(null); await onChanged(message) }} />}
    {previewing && <Modal title="Preview update" onClose={() => setPreviewing(null)}>
      <p className="sp-intro">How the update appears on the client’s portal once published.</p>
      <div className="cb-preview"><span className="cb-preview-label">Project update</span><h4>{previewing.title}</h4>{previewing.body && <p>{previewing.body}</p>}
        {previewing.files.length > 0 && <p>{previewing.files.length} attached file{previewing.files.length === 1 ? '' : 's'}: {previewing.files.map(file => file.fileName).join(', ')}</p>}</div>
      <div className="modal-actions"><button className="secondary" onClick={() => setPreviewing(null)}>Close</button></div>
    </Modal>}
    {publishing && <Modal title={`Publish “${publishing.title}”?`} onClose={() => setPublishing(null)}>
      <p>The client’s portal users who can open this project will see the update and get a notification. Published updates can be corrected later, not deleted.</p>
      <div className="modal-actions"><button className="secondary" onClick={() => setPublishing(null)}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => void run(() => publishUpdate(workspace.id, publishing.id), 'Update published to the client.').then(ok => { if (ok) setPublishing(null) })}>Publish</button></div>
    </Modal>}
  </section>
}

function UpdateEditor({ workspace, projectId, update, onClose, onSaved }: { workspace: WorkspaceSummary; projectId: string; update: AgencyUpdate | null; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [title, setTitle] = useState(update?.title ?? ''), [body, setBody] = useState(update?.body ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const requestId = useRef(crypto.randomUUID())
  async function save() {
    setBusy(true); setError('')
    try {
      await saveUpdate(workspace.id, projectId, update?.id ?? null, { title: title.trim(), body: body.trim() }, update?.version ?? null, update ? null : requestId.current)
      await onSaved(update ? update.status === 'published' ? 'Update corrected.' : 'Draft saved.' : 'Draft created.')
    } catch (cause) { setError(conflict(cause) ? 'This update changed in another window. Close this and try again.' : errorText(cause)) } finally { setBusy(false) }
  }
  return <Modal title={update ? update.status === 'published' ? 'Correct a published update' : 'Edit draft update' : 'New update for the client'} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void save() }}>
      {update?.status === 'published' && <p className="sp-caution" role="note">The client already sees this update. Saving marks it as corrected; the earlier text is kept for your team.</p>}
      <label>Title *<input required maxLength={150} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>Update<textarea rows={6} maxLength={8000} value={body} onChange={event => setBody(event.target.value)} /></label>
      <p className="sp-muted">Plain text. Write for the client: avoid internal notes, costs or names of other clients.</p>
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !title.trim()}>{update ? 'Save' : 'Save draft'}</button></div>
    </form>
  </Modal>
}
