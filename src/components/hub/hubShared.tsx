import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { navigate } from '../../lib/navigation'
import { initials } from '../../lib/format'
import { formatBytes } from '../../lib/onboardingOptions'
import { hubDownload, hubPreview, previewableFile, type SharedFile } from '../../lib/hub'
import { errorText, timeAgo, type Tone } from './hubKit'
import { Icon, type IconName } from '../Icon'

// Shared pieces of the client portal: the signed-in context, a small data loader, links, chips, dialogs and file rows.

/** An in-app link: a real href (open in new tab works), handled without a page load. */
export function HubLink({ to, children, className, ariaLabel, ariaCurrent }: { to: string; children: ReactNode; className?: string; ariaLabel?: string; ariaCurrent?: 'page' | undefined }) {
  return <a href={to} className={className} aria-label={ariaLabel} aria-current={ariaCurrent} onClick={(event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault(); navigate(to); window.scrollTo({ top: 0 })
  }}>{children}</a>
}

export const Chip = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => <span className={`hb-chip is-${tone}`}>{children}</span>

export function Progress({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)))
  return <div className="hb-progress">
    <div className="hb-progress-head"><span>{label}</span><strong>{clamped}%</strong></div>
    <div className="hb-progress-track" role="progressbar" aria-label={label} aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${clamped}%` }} /></div>
  </div>
}

export const Avatar = ({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) => <span className={`hb-avatar is-${size}`} aria-hidden="true">{initials(name)}</span>

export function PageHead({ eyebrow, title, description, actions, back }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return <header className="hb-page-head">
    {back && <HubLink to={back.to} className="hb-back"><span aria-hidden="true">←</span> {back.label}</HubLink>}
    <div className="hb-page-head-row">
      <div className="hb-page-head-text">
        {eyebrow && <p className="hb-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="hb-lede">{description}</p>}
      </div>
      {actions && <div className="hb-page-actions">{actions}</div>}
    </div>
  </header>
}

export function Section({ title, action, children, className = '', id }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  const headingId = useId()
  return <section className={`hb-section ${className}`} aria-labelledby={headingId} id={id}>
    <div className="hb-section-head"><h2 id={headingId}>{title}</h2>{action}</div>
    {children}
  </section>
}

export const Empty = ({ icon = 'check', title, children }: { icon?: IconName; title: string; children?: ReactNode }) =>
  <div className="hb-empty"><span className="hb-empty-icon" aria-hidden="true"><Icon name={icon} size={20} /></span><p className="hb-empty-title">{title}</p>{children && <p>{children}</p>}</div>

export const Skeleton = ({ rows = 3, label = 'Loading…' }: { rows?: number; label?: string }) =>
  <div className="hb-skeleton" role="status"><span className="hb-sr">{label}</span>{Array.from({ length: rows }, (_, index) => <i key={index} style={{ width: `${92 - index * 14}%` }} />)}</div>

export const ErrorState = ({ message, onRetry }: { message: string; onRetry?: () => void }) =>
  <div className="hb-error" role="alert"><p><strong>We couldn’t load this.</strong> {message}</p>{onRetry && <button type="button" className="hb-btn is-secondary" onClick={onRetry}>Try again</button>}</div>

/** A modal dialog with focus kept inside and returned to the opener when it closes. */
export function HubDialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement
    dialog?.showModal()
    return () => { dialog?.close(); if (opener.current?.isConnected) opener.current.focus() }
  }, [])
  return <dialog ref={ref} className={`hb-dialog${wide ? ' is-wide' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')).filter(item => item.getClientRects().length > 0)
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
    <div className="hb-dialog-head"><h2 id={titleId}>{title}</h2><button type="button" className="hb-icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={16} /></button></div>
    <div className="hb-dialog-body">{children}</div>
  </dialog>
}

const fileGlyph = (extension: string) => /^(png|jpe?g|gif|webp|svg|psd)$/.test(extension) ? 'IMG' : extension === 'pdf' ? 'PDF' : /^(mp4|mov|webm)$/.test(extension) ? 'VID' : /^(zip)$/.test(extension) ? 'ZIP' : extension.slice(0, 3).toUpperCase() || 'FILE'

/** One file with preview (images and PDFs) and download, both through links that expire after a minute. */
export function FileRow({ file, context, onRemove }: { file: SharedFile; context?: ReactNode; onRemove?: () => Promise<void> }) {
  const [busy, setBusy] = useState<'' | 'preview' | 'download' | 'remove'>('')
  const [problem, setProblem] = useState('')
  const run = async (kind: 'preview' | 'download' | 'remove', action: () => Promise<void>) => {
    setBusy(kind); setProblem('')
    try { await action() } catch (cause) { setProblem(errorText(cause)) } finally { setBusy('') }
  }
  return <li className="hb-file">
    <span className={`hb-file-icon is-${fileGlyph(file.extension).toLowerCase()}`} aria-hidden="true">{fileGlyph(file.extension)}</span>
    <div className="hb-file-main">
      <strong title={file.fileName}>{file.fileName}</strong>
      <small>{formatBytes(file.size)} · {file.fromClient ? `Uploaded by ${file.uploadedBy}` : `From ${file.uploadedBy}`} · {timeAgo(file.createdAt)}{context ? <> · {context}</> : null}</small>
      {file.description && <small className="hb-file-desc">{file.description}</small>}
      {problem && <small className="hb-inline-error" role="alert">{problem}</small>}
    </div>
    <div className="hb-file-actions">
      {previewableFile(file) && <button type="button" className="hb-btn is-ghost is-sm" disabled={!!busy} onClick={() => run('preview', () => hubPreview(file.id))} aria-label={`Preview ${file.fileName}`}>{busy === 'preview' ? 'Opening…' : 'Preview'}</button>}
      <button type="button" className="hb-btn is-secondary is-sm" disabled={!!busy} onClick={() => run('download', () => hubDownload(file.id))} aria-label={`Download ${file.fileName}`}>{busy === 'download' ? 'Preparing…' : 'Download'}</button>
      {onRemove && <button type="button" className="hb-btn is-ghost is-sm is-danger" disabled={!!busy} onClick={() => { if (window.confirm(`Remove ${file.fileName}?`)) void run('remove', onRemove) }} aria-label={`Remove ${file.fileName}`}>Remove</button>}
    </div>
  </li>
}

/** A field that collects files to attach after something is created. */
export function AttachmentPicker({ files, onChange, label = 'Attach files', disabled = false }: { files: File[]; onChange: (files: File[]) => void; label?: string; disabled?: boolean }) {
  const inputId = useId()
  return <div className="hb-attach">
    <label htmlFor={inputId} className={`hb-btn is-ghost is-sm${disabled ? ' is-disabled' : ''}`}><Icon name="link" size={14} /> {label}</label>
    <input id={inputId} type="file" multiple className="hb-sr" disabled={disabled} onChange={event => { onChange([...files, ...Array.from(event.target.files ?? [])].slice(0, 10)); event.target.value = '' }} />
    {files.length > 0 && <ul className="hb-attach-list">{files.map((file, index) => <li key={`${file.name}-${index}`}>
      <span>{file.name}</span><small>{formatBytes(file.size)}</small>
      <button type="button" className="hb-icon-btn is-sm" aria-label={`Don’t attach ${file.name}`} disabled={disabled} onClick={() => onChange(files.filter((_, other) => other !== index))}><Icon name="close" size={12} /></button>
    </li>)}</ul>}
  </div>
}

