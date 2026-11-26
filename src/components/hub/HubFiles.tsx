import { useId, useState } from 'react'
import { documentCategories, documentCategoryLabels, formatBytes, type DocumentCategory } from '../../lib/onboardingOptions'
import { hubFiles, hubRemoveFile, hubUpload, type SharedFile } from '../../lib/hub'
import { Icon } from '../Icon'
import { Empty, ErrorState, FileRow, PageHead, Section, Skeleton } from './hubShared'
import { errorText, useHub, useLoad } from './hubKit'

const contextOf = (file: SharedFile) => [file.deliverableTitle, file.versionNumber ? `version ${file.versionNumber}` : null, file.feedbackId ? 'feedback attachment' : null, file.commentId ? 'message attachment' : null,
  file.updateId ? 'update attachment' : null].filter(Boolean).join(' · ') || undefined

/** Removing is offered for the person's own uploads (the database checks it again); feedback attachments stay. */
function useMine() {
  const hub = useHub()
  return (file: SharedFile) => file.fromClient && !file.feedbackId && file.uploaderAccessId === hub.accessId
}

function UploadForm({ projectId, onUploaded }: { projectId: string; onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [category, setCategory] = useState<DocumentCategory>('other')
  const [description, setDescription] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [problem, setProblem] = useState('')
  const [status, setStatus] = useState('')
  const fileId = useId(), categoryId = useId(), descriptionId = useId()
  const busy = progress !== null
  return <form className="hb-upload" onSubmit={async event => {
    event.preventDefault()
    if (!file) { setProblem('Choose a file first.'); return }
    setProblem(''); setStatus(''); setProgress(0)
    try {
      const document = await hubUpload(projectId, file, { category, description: description.trim() }, setProgress)
      setStatus(document.status === 'available' ? `${file.name} uploaded. Your agency can see it now.` : `${file.name} uploaded.`)
      setFile(null); setDescription(''); setCategory('other'); onUploaded()
    } catch (cause) { setProblem(errorText(cause)) } finally { setProgress(null) }
  }}>
    <div className="hb-upload-drop">
      <label htmlFor={fileId} className="hb-upload-pick"><Icon name="plus" size={18} /><span>{file ? file.name : 'Choose a file to share with your agency'}</span>{file && <small>{formatBytes(file.size)}</small>}</label>
      <input id={fileId} type="file" className="hb-sr" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setProblem(''); setStatus('') }} />
    </div>
    <div className="hb-upload-fields">
      <div className="hb-field"><label htmlFor={categoryId}>Category</label>
        <select id={categoryId} value={category} disabled={busy} onChange={event => setCategory(event.target.value as DocumentCategory)}>
          {documentCategories.map(key => <option key={key} value={key}>{documentCategoryLabels[key]}</option>)}</select></div>
      <div className="hb-field is-grow"><label htmlFor={descriptionId}>Description <span className="hb-muted">(optional)</span></label>
        <input id={descriptionId} maxLength={1000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} placeholder="What is this file?" /></div>
      <button type="submit" className="hb-btn is-primary" disabled={busy || !file}>{busy ? `Uploading… ${Math.round((progress ?? 0) * 100)}%` : 'Upload'}</button>
    </div>
    {busy && <div className="hb-mini-track is-wide" aria-hidden="true"><i style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} /></div>}
    <p className="hb-hint">PDF, images, Office documents, text, CSV, ZIP, video, MP3 or PSD. Files are checked before your agency can open them. Don’t upload passwords or other credentials.</p>
    {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
    <p className={status ? 'hb-note' : 'hb-sr'} role="status" aria-live="polite">{status}</p>
  </form>
}

export function ProjectFiles({ projectId, canUpload }: { projectId: string; canUpload: boolean }) {
  const hub = useHub()
  const mine = useMine()
  const { data, error, loading, reload } = useLoad(`files:${hub.accessId}:${projectId}`, () => hubFiles(hub.accessId, projectId))
  const fromAgency = (data ?? []).filter(file => !file.fromClient), fromTeam = (data ?? []).filter(file => file.fromClient)
  return <div className="hb-stack">
    {canUpload ? <Section title="Share a file"><UploadForm projectId={projectId} onUploaded={reload} /></Section>
      : <p className="hb-muted">Your role can view and download files here, and attach files to your feedback and messages.</p>}
    {loading ? <Skeleton rows={4} label="Loading files…" /> : error ? <ErrorState message={error} onRetry={reload} /> : <>
      <Section title="From your agency">{fromAgency.length ? <ul className="hb-files">{fromAgency.map(file => <FileRow key={file.id} file={file} context={contextOf(file)} />)}</ul>
        : <Empty icon="clipboard" title="No files shared yet">Files and deliverable versions your agency shares appear here.</Empty>}</Section>
      <Section title="From your team">{fromTeam.length ? <ul className="hb-files">{fromTeam.map(file => <FileRow key={file.id} file={file} context={contextOf(file)}
          onRemove={mine(file) ? async () => { await hubRemoveFile(file.id); reload() } : undefined} />)}</ul>
        : <Empty icon="plus" title="Nothing uploaded yet">{canUpload ? 'Upload brand assets, content or anything your agency asked for.' : 'Files your colleagues upload appear here.'}</Empty>}</Section>
    </>}
  </div>
}

export function FilesPage() {
  const hub = useHub()
  const mine = useMine()
  const { data, error, loading, reload } = useLoad(`files:${hub.accessId}`, () => hubFiles(hub.accessId))
  const [project, setProject] = useState('')
  const [query, setQuery] = useState('')
  const projectFilterId = useId(), searchId = useId()
  if (loading) return <div className="hb-page"><Skeleton rows={5} label="Loading files…" /></div>
  if (error || !data) return <div className="hb-page"><ErrorState message={error ?? ''} onRetry={reload} /></div>
  const projects = Array.from(new Map(data.filter(file => file.projectId).map(file => [file.projectId!, file.projectName ?? 'Project'])).entries())
  const needle = query.trim().toLowerCase()
  const shown = data.filter(file => (!project || (project === 'general' ? !file.projectId : file.projectId === project)) && (!needle || `${file.fileName} ${file.description} ${file.deliverableTitle ?? ''}`.toLowerCase().includes(needle)))
  const groups = new Map<string, SharedFile[]>()
  for (const file of shown) { const key = file.projectName ?? 'Shared with your organization'; groups.set(key, [...(groups.get(key) ?? []), file]) }
  return <div className="hb-page">
    <PageHead eyebrow={hub.clientName} title="Files & documents" description="Everything shared between you and your agency. Download links expire after a minute; open them again any time." />
    <div className="hb-filters">
      <div className="hb-field"><label htmlFor={searchId}>Search</label><input id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="File name or description" /></div>
      <div className="hb-field"><label htmlFor={projectFilterId}>Project</label>
        <select id={projectFilterId} value={project} onChange={event => setProject(event.target.value)}>
          <option value="">All projects</option>
          {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          {data.some(file => !file.projectId) && <option value="general">Shared with your organization</option>}
        </select></div>
      <p className="hb-muted" role="status">{shown.length} file{shown.length === 1 ? '' : 's'}</p>
    </div>
    {shown.length === 0 ? <Empty icon="clipboard" title={data.length ? 'No files match' : 'No files yet'}>{data.length ? 'Try another search or project.' : 'Files your agency shares, and files your team uploads, appear here.'}</Empty>
      : Array.from(groups.entries()).map(([name, files]) => <Section key={name} title={name}>
        <ul className="hb-files">{files.map(file => <FileRow key={file.id} file={file} context={contextOf(file)} onRemove={mine(file) ? async () => { await hubRemoveFile(file.id); reload() } : undefined} />)}</ul>
      </Section>)}
  </div>
}
