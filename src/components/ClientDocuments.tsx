import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import { errorText, shortDate } from '../lib/sales'
import {
  clientDocuments, deleteDocument, documentCategories, documentCategoryLabels, downloadDocument, filesConfig, formatBytes, updateDocument, uploadDocument,
  type ClientDetail, type ClientDocument, type DocumentCategory, isAttachment } from '../lib/clients'

interface Upload { key: string; name: string; progress: number; error: string }

/**
 * The client's files: uploaded by the team here, or by the client through their onboarding link. Files are private;
 * downloads use links that expire after a minute. “Shared” files appear on the client’s onboarding page.
 */
export function ClientDocuments({ workspace, detail, locked, manager, onChanged }: { workspace: WorkspaceSummary; detail: ClientDetail; locked: boolean; manager: boolean; onChanged: (message: string) => void }) {
  const [documents, setDocuments] = useState<ClientDocument[] | null>(null), [config, setConfig] = useState<{ maxBytes: number; extensions: string[] } | null>(null), [configError, setConfigError] = useState('')
  const [error, setError] = useState(''), [uploads, setUploads] = useState<Upload[]>([]), [category, setCategory] = useState<DocumentCategory>('other'), [visibility, setVisibility] = useState<'internal' | 'shared'>('internal')
  const [filter, setFilter] = useState<DocumentCategory | ''>(''), [editing, setEditing] = useState<ClientDocument | null>(null), [removing, setRemoving] = useState<ClientDocument | null>(null), [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const load = useCallback(() => clientDocuments(workspace.id, detail.id).then(setDocuments).catch(cause => setError(errorText(cause))), [workspace.id, detail.id])
  useEffect(() => {
    let active = true
    clientDocuments(workspace.id, detail.id).then(value => { if (active) setDocuments(value) }).catch(cause => { if (active) setError(errorText(cause)) })
    filesConfig(workspace.id).then(value => { if (active) setConfig(value) }).catch(cause => { if (active) setConfigError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, detail.id])
  async function upload(files: FileList | null) {
    if (!files?.length) return
    setError('')
    const chosen = [...files].slice(0, 10)
    for (const file of chosen) {
      const key = crypto.randomUUID()
      const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (config && !config.extensions.includes(extension)) { setUploads(list => [...list, { key, name: file.name, progress: 0, error: 'This type of file can’t be uploaded.' }]); continue }
      if (config && file.size > config.maxBytes) { setUploads(list => [...list, { key, name: file.name, progress: 0, error: `Larger than ${formatBytes(config.maxBytes)}.` }]); continue }
      if (!file.size) { setUploads(list => [...list, { key, name: file.name, progress: 0, error: 'The file is empty.' }]); continue }
      setUploads(list => [...list, { key, name: file.name, progress: 0, error: '' }])
      try {
        await uploadDocument(workspace.id, detail.id, file, { category, description: '', visibility }, fraction => setUploads(list => list.map(item => item.key === key ? { ...item, progress: fraction } : item)))
        setUploads(list => list.filter(item => item.key !== key))
        onChanged(`${file.name} uploaded.`)
      } catch (cause) { setUploads(list => list.map(item => item.key === key ? { ...item, error: errorText(cause) } : item)) }
    }
    if (input.current) input.current.value = ''
    await load()
  }
  async function run(action: () => Promise<string>) {
    setBusy(true); setError('')
    try { const message = await action(); await load(); onChanged(message); return true } catch (cause) { setError(errorText(cause)); return false } finally { setBusy(false) }
  }
  const visible = (documents ?? []).filter(item => !filter || item.category === filter)
  return <section className="panel cl-section">
    <div className="section-heading"><div><h2>Documents</h2><p>Brand assets, briefs, references and anything else for this client. Private to your workspace; “shared” files also appear on the client’s onboarding page.</p></div></div>
    {!locked && <div className="cl-upload">
      <div className="sp-row sp-row-3">
        <label>Category<select value={category} onChange={event => setCategory(event.target.value as DocumentCategory)}>{documentCategories.map(item => <option key={item} value={item}>{documentCategoryLabels[item]}</option>)}</select></label>
        <label>Who can see it<select value={visibility} onChange={event => setVisibility(event.target.value as 'internal' | 'shared')}><option value="internal">Your team only</option><option value="shared">Shared with the client</option></select></label>
        <label className="cl-file-pick">Files<input ref={input} type="file" multiple disabled={!!configError} accept={config?.extensions.map(item => `.${item}`).join(',')} onChange={event => void upload(event.target.files)} /></label>
      </div>
      <p className="sp-muted">{configError ? `Uploads aren’t available: ${configError}` : config ? `Up to ${formatBytes(config.maxBytes)} each: ${config.extensions.join(', ')}. Every file is checked after upload; it can be downloaded once the check passes.` : 'Checking upload settings…'} Never upload passwords or credential files.</p>
      {uploads.length > 0 && <ul className="cl-uploads">{uploads.map(item => <li key={item.key} className={item.error ? 'is-error' : ''}>
        <span>{item.name}</span>{item.error ? <><span role="alert">{item.error}</span><button className="text-button" onClick={() => setUploads(list => list.filter(entry => entry.key !== item.key))}>Dismiss</button></>
          : <span className="cl-progress" role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuenow={Math.round(item.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(item.progress * 100)}%` }} /></span>}</li>)}</ul>}
    </div>}
    {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    {documents && documents.length > 0 && <div className="filters"><select aria-label="Filter documents by category" value={filter} onChange={event => setFilter(event.target.value as DocumentCategory | '')}><option value="">All categories</option>{documentCategories.map(item => <option key={item} value={item}>{documentCategoryLabels[item]}</option>)}</select><span className="results" role="status">{visible.length} file{visible.length === 1 ? '' : 's'}</span></div>}
    {!documents ? <p className="sp-loading" role="status">Loading documents…</p> : !visible.length ? <div className="empty"><h3>{documents.length ? 'No files in this category' : 'No documents yet'}</h3><p>{documents.length ? 'Choose another category.' : 'Upload files here, or add a file field to the client’s onboarding checklist so they can upload them.'}</p></div>
      : <div className="sp-table-wrap"><table className="sp-table cl-docs">
        <thead><tr><th>File</th><th>Category</th><th>Who can see it</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{visible.map(item => <tr key={item.id}>
          <td><strong className="cl-file-name">{item.fileName}</strong><small>{formatBytes(item.size)}{item.projectName ? ` · project “${item.projectName}”` : ''}{item.itemTitle ? ` · answer to “${item.itemTitle}”` : ''}{item.description ? ` · ${item.description}` : ''}</small></td>
          <td>{documentCategoryLabels[item.category]}</td>
          <td>{item.visibility === 'shared' ? <span className="cl-pill is-confirmed">Shared with client</span> : <span className="cl-pill">Team only</span>}</td>
          <td>{shortDate(item.createdAt)}<small>{item.uploaderType === 'client' ? 'By the client' : item.uploadedBy ?? 'A team member'}</small></td>
          <td className="cl-doc-actions">{item.status === 'pending' ? <span className="sp-muted">Being checked…</span> : <>
            <button className="text-button" onClick={() => void downloadDocument(workspace.id, item.id).catch(cause => setError(errorText(cause)))}><Icon name="arrow" size={14} /> Download</button>
            {!locked && <button className="text-button" onClick={() => setEditing(item)}>Edit</button>}
            {!locked && (manager || item.uploaderType === 'member') && <button className="text-button" onClick={() => setRemoving(item)}>Delete</button>}</>}</td>
        </tr>)}</tbody>
      </table></div>}
    {editing && <EditDocument document={editing} busy={busy} onClose={() => setEditing(null)}
      onSave={async changes => { if (await run(async () => { await updateDocument(workspace.id, editing.id, changes); return `${editing.fileName} updated.` })) setEditing(null) }} />}
    {removing && <Modal title={`Delete ${removing.fileName}?`} onClose={() => setRemoving(null)}>
      <p>The file is deleted from storage and can’t be downloaded again. The deletion is recorded in the client’s history. Files that are part of an accepted checklist answer can’t be deleted until changes are requested on that answer.</p>
      {!manager && <p className="sp-muted">You can delete files you uploaded; owners and admins can delete any file.</p>}
      <div className="modal-actions"><button className="secondary" onClick={() => setRemoving(null)}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => void run(async () => { await deleteDocument(workspace.id, removing.id); setRemoving(null); return `${removing.fileName} deleted.` })}>Delete file</button></div>
    </Modal>}
  </section>
}

function EditDocument({ document, busy, onClose, onSave }: { document: ClientDocument; busy: boolean; onClose: () => void; onSave: (changes: Pick<ClientDocument, 'category' | 'description' | 'visibility'>) => Promise<void> }) {
  const [category, setCategory] = useState(document.category), [description, setDescription] = useState(document.description), [visibility, setVisibility] = useState(document.visibility)
  return <Modal title={`Edit ${document.fileName}`} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void onSave({ category, description: description.trim(), visibility }) }}>
      <div className="sp-row"><label>Category<select value={category} onChange={event => setCategory(event.target.value as DocumentCategory)}>{documentCategories.map(item => <option key={item} value={item}>{documentCategoryLabels[item]}</option>)}</select></label>
        <label>Who can see it<select value={visibility} disabled={isAttachment(document)} onChange={event => setVisibility(event.target.value as 'internal' | 'shared')}><option value="internal">Your team only</option><option value="shared">Shared with the client</option></select></label></div>
      {document.projectId && <p className="sp-muted">This file belongs to the project “{document.projectName}”. {isAttachment(document)
        ? 'It’s attached to a version, comment, feedback item or update, and is shared with it.'
        : 'Shared project files appear on the client portal for people who can open that project, never on onboarding links.'}</p>}
      {document.uploaderType === 'client' && visibility === 'shared' && <p className="sp-muted">Files the client uploaded already appear with their answer; “shared” lists files from your team on their page.</p>}
      <label>Description<textarea rows={2} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Save</button></div>
    </form>
  </Modal>
}
