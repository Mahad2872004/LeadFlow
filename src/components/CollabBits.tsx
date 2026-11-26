import { useState, type ReactNode } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { documentCategoryLabels, formatBytes, type DocumentCategory } from '../lib/clients'
import { errorText, shortDate } from '../lib/sales'
import { downloadProjectFile, previewable, previewProjectFile, uploadProjectFile, type ProjectFileTarget } from '../lib/projects'
import { reviewStatusLabels, type CollabDocument, type ReviewStatus } from '../lib/collaboration'
import './ProjectCollaboration.css'

/** Small pieces the agency's collaboration screens share. */
export const ReviewChip = ({ status }: { status: ReviewStatus }) => <span className={`cb-review is-${status}`}>{reviewStatusLabels[status]}</span>

export function Switch({ checked, onChange, label, disabled = false, small = false, hint }: { checked: boolean; onChange: (next: boolean) => void; label: ReactNode; disabled?: boolean; small?: boolean; hint?: string }) {
  return <label className={`cb-switch${small ? ' is-small' : ''}`} title={hint}>
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-checked={checked} onChange={event => onChange(event.target.checked)} />
    <span className="cb-switch-track" aria-hidden="true" /><span>{label}</span>
  </label>
}

/** Files the agency can open (links expire after a minute). Pending files are still being checked. */
export function AgencyFiles({ workspace, files, onError, onRemove, empty }: {
  workspace: WorkspaceSummary; files: CollabDocument[]; onError: (message: string) => void; onRemove?: (file: CollabDocument) => void; empty?: string
}) {
  if (!files.length) return empty ? <p className="sp-muted">{empty}</p> : null
  const open = (file: CollabDocument) => void (previewable(file) ? previewProjectFile(workspace.id, file.id) : downloadProjectFile(workspace.id, file.id)).catch(cause => onError(errorText(cause)))
  return <ul className="cb-files">{files.map(file => <li key={file.id}>
    <span><strong className="cl-file-name">{file.fileName}</strong> <small>{documentCategoryLabels[file.category as DocumentCategory] ?? 'File'} · {formatBytes(file.size)}
      {file.uploadedBy ? ` · ${file.uploadedBy}` : ''} · {shortDate(file.createdAt)}</small></span>
    <span className="cb-file-actions">{file.status === 'pending' ? <span className="sp-muted">Being checked…</span> : <>
      <button type="button" className="text-button" onClick={() => open(file)}>{previewable(file) ? 'Preview' : 'Download'}<span className="sr-only"> {file.fileName}</span></button>
      {previewable(file) && <button type="button" className="text-button" onClick={() => void downloadProjectFile(workspace.id, file.id).catch(cause => onError(errorText(cause)))}>Download<span className="sr-only"> {file.fileName}</span></button>}</>}
      {onRemove && <button type="button" className="text-button" onClick={() => onRemove(file)}>Remove<span className="sr-only"> {file.fileName}</span></button>}</span>
  </li>)}</ul>
}

interface Upload { key: string; name: string; progress: number; error: string }
/** A file picker that uploads straight away to a target (a draft version, a comment or a draft update), with progress. */
export function UploadField({ workspace, target, visibility, label, config, disabled, onUploaded }: {
  workspace: WorkspaceSummary; target: ProjectFileTarget; visibility: 'internal' | 'shared'; label: string; config: { maxBytes: number; extensions: string[] } | null
  disabled?: boolean; onUploaded: (name: string) => void
}) {
  const [uploads, setUploads] = useState<Upload[]>([])
  async function upload(chosen: FileList | null, input: HTMLInputElement) {
    if (!chosen?.length) return
    for (const file of [...chosen].slice(0, 10)) {
      const key = crypto.randomUUID(), extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      const refuse = (message: string) => setUploads(list => [...list, { key, name: file.name, progress: 0, error: message }])
      if (config && !config.extensions.includes(extension)) { refuse('This type of file can’t be uploaded.'); continue }
      if (config && file.size > config.maxBytes) { refuse(`Larger than ${formatBytes(config.maxBytes)}.`); continue }
      if (!file.size) { refuse('The file is empty.'); continue }
      setUploads(list => [...list, { key, name: file.name, progress: 0, error: '' }])
      try {
        await uploadProjectFile(workspace.id, target, file, { category: 'other', description: '', visibility }, fraction => setUploads(list => list.map(item => item.key === key ? { ...item, progress: fraction } : item)))
        setUploads(list => list.filter(item => item.key !== key))
        onUploaded(file.name)
      } catch (cause) { setUploads(list => list.map(item => item.key === key ? { ...item, error: errorText(cause) } : item)) }
    }
    input.value = ''
  }
  return <div>
    <label className="cl-file-pick">{label}<input type="file" multiple disabled={disabled} accept={config?.extensions.map(item => `.${item}`).join(',')} onChange={event => void upload(event.target.files, event.target)} /></label>
    {uploads.length > 0 && <ul className="cb-uploads">{uploads.map(item => <li key={item.key} className={item.error ? 'is-error' : ''}><span>{item.name}</span>
      {item.error ? <><span role="alert">{item.error}</span><button type="button" className="text-button" onClick={() => setUploads(list => list.filter(entry => entry.key !== item.key))}>Dismiss</button></>
        : <span className="cl-progress" role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuenow={Math.round(item.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(item.progress * 100)}%` }} /></span>}</li>)}</ul>}
  </div>
}
