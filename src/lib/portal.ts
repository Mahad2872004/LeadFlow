import type { DocumentCategory, ItemConfig, ItemKind, ItemState, RequestStatus, ResponseValue } from './onboardingOptions'
// Client portal. The browser sends the link token to the client-portal Edge Function, which hashes it; the
// database finds the single request it belongs to. Nothing in the request chooses a workspace.
export interface PortalFile { id: string; name: string; size: number; status: 'available' | 'pending' }
export interface PortalItem {
  id: string; section: string; title: string; guidance: string; kind: ItemKind; options: string[]; required: boolean; dueDate: string | null; state: ItemState; value: ResponseValue | null
  hasDraft: boolean; submittedAt: string | null; revision: number; feedback: string | null
  /** M10: field settings, the stage name, and (file fields) the client's uploads. */
  config?: ItemConfig; stage?: string | null; files?: PortalFile[] | null
}
export interface SharedFile { id: string; name: string; size: number; category: DocumentCategory; description: string }
/** The agreed scope, when the agency shares it. Acknowledging it is not a signature or legal acceptance. */
export interface PortalScope {
  id: string; version: number; confirmedAt: string; acknowledgedAt: string | null; outstandingQuestions: string
  services: { name: string; agreedScope: string; deliverables: string; exclusions: string }[]; requirements: { title: string; description: string; category: string }[]
}
export interface PortalView {
  agencyName: string; title: string; clientName: string; status: RequestStatus; linkExpiresAt: string; instructions: string; dueDate: string | null; allAccepted: boolean; confirmedAt: string | null; items: PortalItem[]
  sharedFiles?: SharedFile[]; scope?: PortalScope | null
}
export class PortalError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status } }
export async function portalCall<T>(body: Record<string, unknown>): Promise<T> {
  const endpoint = import.meta.env.VITE_SUPABASE_URL
  if (!endpoint) throw new PortalError('Onboarding isn’t available right now. Please try again later.', 503)
  let response: Response
  try { response = await fetch(`${endpoint}/functions/v1/client-portal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000) }) }
  catch { throw new PortalError('We couldn’t reach your checklist. Check your connection and try again; nothing you saved has been lost.', 0) }
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.ok !== true) throw new PortalError(typeof result.error === 'string' ? result.error : 'Something went wrong. Please try again.', response.status)
  return result as T
}

/**
 * Storage URLs are signed by an Edge Function, whose own address for Storage can differ from the browser's (in local
 * development it is an internal host). Only the path and query of a signed URL are used, on this app's Supabase origin.
 */
export function storageUrl(signed: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL
  const url = new URL(signed)
  if (!base || !url.pathname.startsWith('/storage/v1/')) return url.toString()
  return `${new URL(base).origin}${url.pathname}${url.search}`
}
/** Sends the file straight to Storage with a one-time signed URL; the file never passes through LeadFlow's functions. */
export async function putSignedFile(uploadUrl: string, file: Blob, contentType: string, onProgress?: (fraction: number) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // XMLHttpRequest, not fetch, because only it reports upload progress.
    const request = new XMLHttpRequest()
    request.open('PUT', storageUrl(uploadUrl))
    request.setRequestHeader('Content-Type', contentType)
    request.setRequestHeader('x-upsert', 'false')
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
    if (key) request.setRequestHeader('apikey', key)
    request.timeout = 15 * 60 * 1000
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded / event.total) }
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new PortalError(request.status === 413 ? 'The file is larger than the upload limit.' : 'The upload didn’t finish. Try again.', request.status))
    request.onerror = () => reject(new PortalError('The upload was interrupted. Check your connection and try again.', 0))
    request.ontimeout = () => reject(new PortalError('The upload took too long. Try again on a faster connection.', 0))
    request.send(file)
  })
}
/** Starts a download from a short-lived signed link, without opening a new page. */
export function openDownload(url: string) {
  const link = document.createElement('a')
  link.href = storageUrl(url); link.rel = 'noopener noreferrer'; link.target = '_blank'
  document.body.append(link); link.click(); link.remove()
}
/** Uploads one file for a file field: prepare (the database checks the link and item), send, then the upload check. */
export async function portalUpload(token: string, itemId: string, file: File, onProgress?: (fraction: number) => void): Promise<PortalFile> {
  const prepared = await portalCall<{ file: { id: string; mimeType: string }; uploadUrl: string }>({ token, action: 'upload', itemId, fileName: file.name, size: file.size })
  await putSignedFile(prepared.uploadUrl, file, prepared.file.mimeType, onProgress)
  const finished = await portalCall<{ file: PortalFile }>({ token, action: 'finish', fileId: prepared.file.id })
  return finished.file
}
export const portalDownload = (token: string, fileId: string) => portalCall<{ url: string }>({ token, action: 'download', fileId }).then(result => openDownload(result.url))
export const portalRemoveFile = (token: string, fileId: string) => portalCall<{ ok: true }>({ token, action: 'remove', fileId })
export const portalAcknowledgeScope = (token: string, scopeId: string) => portalCall<{ scope: { acknowledgedAt: string } }>({ token, action: 'acknowledge', scopeId })
