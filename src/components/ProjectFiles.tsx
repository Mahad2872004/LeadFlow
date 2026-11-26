import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import type { Task } from '../lib/model'
import { documentCategories, documentCategoryLabels, filesConfig, formatBytes, isAttachment, updateDocument, type DocumentCategory } from '../lib/clients'
import { errorText, shortDate } from '../lib/sales'
import { deleteProjectFile, downloadProjectFile, previewable, previewProjectFile, projectDocuments, uploadProjectFile, type ProjectDetail, type ProjectDocument } from '../lib/projects'

interface Upload { key: string; name: string; progress: number; error: string }

/**
 * The project's files in M10's private storage: uploaded here, linked to a milestone, deliverable or task, checked after
 * upload, opened through links that expire after a minute. Files are internal unless shared (M12): shared files appear on the
 * client portal for people who can open the project, once the project is shared. Attachments follow what they belong to.
 */
export function ProjectFiles({ workspace, detail, tasks, locked, manager, onChanged }: { workspace: WorkspaceSummary; detail: ProjectDetail; tasks: Task[]; locked: boolean; manager: boolean; onChanged: (message: string) => void }) {
  const [files, setFiles] = useState<{ project: ProjectDocument[]; client: ProjectDocument[] } | null>(null), [config, setConfig] = useState<{ maxBytes: number; extensions: string[] } | null>(null)
  const [configError, setConfigError] = useState(''), [error, setError] = useState(''), [uploads, setUploads] = useState<Upload[]>([]), [busy, setBusy] = useState(false)
  const [category, setCategory] = useState<DocumentCategory>('other'), [milestoneId, setMilestoneId] = useState(''), [deliverableId, setDeliverableId] = useState(''), [taskId, setTaskId] = useState('')
  const [filter, setFilter] = useState(''), [removing, setRemoving] = useState<ProjectDocument | null>(null), [visibility, setVisibility] = useState<'internal' | 'shared'>('internal')
  const input = useRef<HTMLInputElement>(null)
  const load = useCallback(() => projectDocuments(workspace.id, detail.id).then(setFiles).catch(cause => setError(errorText(cause))), [workspace.id, detail.id])
  useEffect(() => {
    let active = true
    projectDocuments(workspace.id, detail.id).then(value => { if (active) setFiles(value) }).catch(cause => { if (active) setError(errorText(cause)) })
    filesConfig(workspace.id).then(value => { if (active) setConfig(value) }).catch(cause => { if (active) setConfigError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, detail.id])
  const milestoneName = new Map(detail.milestones.map(m => [m.id, m.name])), deliverableName = new Map(detail.deliverables.map(d => [d.id, d.title])), taskName = new Map(tasks.map(t => [t.id, t.notes]))
  const linkText = (file: ProjectDocument) => [file.milestoneId && milestoneName.get(file.milestoneId), file.deliverableId && deliverableName.get(file.deliverableId), file.taskId && taskName.get(file.taskId)].filter(Boolean).join(' · ')
  async function upload(chosen: FileList | null) {
    if (!chosen?.length) return
    setError('')
    for (const file of [...chosen].slice(0, 10)) {
      const key = crypto.randomUUID(), extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      const refuse = (message: string) => setUploads(list => [...list, { key, name: file.name, progress: 0, error: message }])
      if (config && !config.extensions.includes(extension)) { refuse('This type of file can’t be uploaded.'); continue }
      if (config && file.size > config.maxBytes) { refuse(`Larger than ${formatBytes(config.maxBytes)}.`); continue }
      if (!file.size) { refuse('The file is empty.'); continue }
      setUploads(list => [...list, { key, name: file.name, progress: 0, error: '' }])
      try {
        await uploadProjectFile(workspace.id, { clientId: detail.clientId, projectId: detail.id, milestoneId: milestoneId || null, deliverableId: deliverableId || null, taskId: taskId || null }, file, { category, description: '', visibility },
          fraction => setUploads(list => list.map(item => item.key === key ? { ...item, progress: fraction } : item)))
        setUploads(list => list.filter(item => item.key !== key))
        onChanged(`${file.name} uploaded.`)
      } catch (cause) { setUploads(list => list.map(item => item.key === key ? { ...item, error: errorText(cause) } : item)) }
    }
    if (input.current) input.current.value = ''
    await load()
  }
  async function share(file: ProjectDocument) {
    setBusy(true); setError('')
    try {
      const next = file.visibility === 'shared' ? 'internal' : 'shared'
      await updateDocument(workspace.id, file.id, { visibility: next })
      await load()
      onChanged(next === 'shared' ? `${file.fileName} is shared with the client portal.` : `${file.fileName} is for your team only.`)
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  const open = (file: ProjectDocument) => void (previewable(file) ? previewProjectFile(workspace.id, file.id) : downloadProjectFile(workspace.id, file.id)).catch(cause => setError(errorText(cause)))
  const visible = (files?.project ?? []).filter(file => !filter || (filter.startsWith('m:') ? file.milestoneId === filter.slice(2) : filter.startsWith('d:') ? file.deliverableId === filter.slice(2) : file.category === filter))
  return <section className="panel pw-section">
    <div className="section-heading"><div><h2>Files</h2><p>Designs, reports, exports and anything else for this project. Files are for your team unless you share them: shared files appear on the client portal for people who can open this project, once the project is shared there.</p></div></div>
    {!locked && <div className="cl-upload pw-upload">
      <div className="sp-row sp-row-3">
        <label>Category<select value={category} onChange={event => setCategory(event.target.value as DocumentCategory)}>{documentCategories.map(item => <option key={item} value={item}>{documentCategoryLabels[item]}</option>)}</select></label>
        {detail.milestones.length > 0 && <label>Milestone<select value={milestoneId} onChange={event => setMilestoneId(event.target.value)}><option value="">None</option>{detail.milestones.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
        {detail.deliverables.length > 0 && <label>Deliverable<select value={deliverableId} onChange={event => setDeliverableId(event.target.value)}><option value="">None</option>{detail.deliverables.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>}
        {tasks.length > 0 && <label>Task<select value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">None</option>{tasks.filter(t => !t.cancelled).map(t => <option key={t.id} value={t.id}>{t.notes.slice(0, 80)}</option>)}</select></label>}
        <label>Who can see it<select value={visibility} onChange={event => setVisibility(event.target.value as 'internal' | 'shared')}><option value="internal">Your team only</option><option value="shared">Shared with the client portal</option></select></label>
        <label className="cl-file-pick">Files<input ref={input} type="file" multiple disabled={!!configError} accept={config?.extensions.map(item => `.${item}`).join(',')} onChange={event => void upload(event.target.files)} /></label>
      </div>
      <p className="sp-muted">{configError ? `Uploads aren’t available: ${configError}` : config ? `Up to ${formatBytes(config.maxBytes)} each: ${config.extensions.join(', ')}. Each file is checked after upload and can be opened once the check passes.` : 'Checking upload settings…'} Never upload passwords or credential files.</p>
      {uploads.length > 0 && <ul className="cl-uploads">{uploads.map(item => <li key={item.key} className={item.error ? 'is-error' : ''}><span>{item.name}</span>
        {item.error ? <><span role="alert">{item.error}</span><button className="text-button" onClick={() => setUploads(list => list.filter(entry => entry.key !== item.key))}>Dismiss</button></>
          : <span className="cl-progress" role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuenow={Math.round(item.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(item.progress * 100)}%` }} /></span>}</li>)}</ul>}
    </div>}
    {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    {files && files.project.length > 0 && <div className="filters"><select aria-label="Filter files" value={filter} onChange={event => setFilter(event.target.value)}><option value="">All project files</option>
      <optgroup label="Category">{documentCategories.map(item => <option key={item} value={item}>{documentCategoryLabels[item]}</option>)}</optgroup>
      {detail.milestones.length > 0 && <optgroup label="Milestone">{detail.milestones.map(m => <option key={m.id} value={`m:${m.id}`}>{m.name}</option>)}</optgroup>}
      {detail.deliverables.length > 0 && <optgroup label="Deliverable">{detail.deliverables.map(d => <option key={d.id} value={`d:${d.id}`}>{d.title}</option>)}</optgroup>}</select>
      <span className="results" role="status">{visible.length} file{visible.length === 1 ? '' : 's'}</span></div>}
    {!files ? <p className="sp-loading" role="status">Loading files…</p> : !visible.length ? <div className="empty"><h3>{files.project.length ? 'No files match' : 'No project files yet'}</h3><p>{files.project.length ? 'Choose another filter.' : 'Upload files here and link them to a milestone, deliverable or task.'}</p></div>
      : <div className="sp-table-wrap"><table className="sp-table pw-files">
        <thead><tr><th>File</th><th>Linked to</th><th>Client</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{visible.map(file => <tr key={file.id}>
          <td><strong className="cl-file-name">{file.fileName}</strong><small>{documentCategoryLabels[file.category]} · {formatBytes(file.size)}{file.description ? ` · ${file.description}` : ''}</small></td>
          <td>{linkText(file) || <span className="sp-muted">The project</span>}</td>
          <td>{file.fromPortal ? <span className="cl-pill is-confirmed">From the client</span> : isAttachment(file) ? <span className="cl-pill">With its {file.versionId ? 'version' : file.commentId ? 'comment' : file.feedbackId ? 'feedback' : 'update'}</span>
            : file.visibility === 'shared' ? <span className="cl-pill is-confirmed">Shared</span> : <span className="cl-pill">Team only</span>}
            {!locked && !file.fromPortal && !isAttachment(file) && file.status === 'available' && <button className="text-button" disabled={busy} onClick={() => void share(file)}>{file.visibility === 'shared' ? 'Make team only' : 'Share with client'}</button>}</td>
          <td>{shortDate(file.createdAt)}<small>{file.uploadedBy ?? 'A team member'}</small></td>
          <td className="cl-doc-actions">{file.status === 'pending' ? <span className="sp-muted">Being checked…</span> : <>
            <button className="text-button" onClick={() => open(file)}><Icon name="arrow" size={14} /> {previewable(file) ? 'Preview' : 'Download'}</button>
            {previewable(file) && <button className="text-button" onClick={() => void downloadProjectFile(workspace.id, file.id).catch(cause => setError(errorText(cause)))}>Download</button>}
            {!locked && (manager || file.uploaderType === 'member') && <button className="text-button" onClick={() => setRemoving(file)}>Delete</button>}</>}</td>
        </tr>)}</tbody>
      </table></div>}
    {files && files.client.length > 0 && <div className="pw-client-files">
      <h3>The client’s files</h3><p className="sp-muted">From onboarding and the client’s workspace, for reference. Manage them on the client.</p>
      <ul className="pw-plain">{files.client.map(file => <li key={file.id}><span><strong className="cl-file-name">{file.fileName}</strong><small>{documentCategoryLabels[file.category]} · {formatBytes(file.size)}{file.itemTitle ? ` · answer to “${file.itemTitle}”` : ''}{file.uploaderType === 'client' ? ' · from the client' : ''}</small></span>
        <button className="text-button" onClick={() => open(file)}>{previewable(file) ? 'Preview' : 'Download'}</button></li>)}</ul>
    </div>}
    {removing && <Modal title={`Delete ${removing.fileName}?`} onClose={() => setRemoving(null)}>
      <p>The file is deleted from storage and can’t be opened again. The deletion is recorded in the project’s history.</p>
      {!manager && <p className="sp-muted">You can delete files you uploaded; owners and admins can delete any file.</p>}
      <div className="modal-actions"><button className="secondary" onClick={() => setRemoving(null)}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => { setBusy(true); setError(''); void deleteProjectFile(workspace.id, removing.id).then(async () => { const name = removing.fileName; setRemoving(null); await load(); onChanged(`${name} deleted.`) })
          .catch(cause => { setError(errorText(cause)); setRemoving(null) }).finally(() => setBusy(false)) }}>Delete file</button></div>
    </Modal>}
  </section>
}
