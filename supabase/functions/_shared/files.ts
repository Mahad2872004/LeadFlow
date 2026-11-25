import type { Runtime } from './runtime.ts'

/**
 * Client documents in a private Supabase Storage bucket. Files are never public: uploads and downloads use short-lived
 * signed URLs, created only after the database has checked access. Each upload is checked once stored (size and the
 * file's content signature against its extension) before it can be downloaded; downloads are always attachments, so
 * nothing uploaded is rendered or run in the browser. Keep the types in step with leadflow_private.document_type_allowed.
 */
export const documentBucket = 'client-documents'
type Signature = (head: Uint8Array) => boolean
const startsWith = (head: Uint8Array, bytes: number[], offset = 0) => bytes.every((byte, index) => head[offset + index] === byte)
const ascii = (text: string) => [...text].map(character => character.charCodeAt(0))
const zip: Signature = head => startsWith(head, [0x50, 0x4b, 0x03, 0x04])
const ole: Signature = head => startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const isoMedia: Signature = head => startsWith(head, ascii('ftyp'), 4)
// Plain text must be valid UTF-8 with no NUL bytes in its first block; it is still only ever downloaded as an attachment.
const text: Signature = head => { if (head.includes(0)) return false; try { new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 3))); return true } catch { return false } }
export const documentTypes: Record<string, { mime: string; signature: Signature }> = {
  pdf: { mime: 'application/pdf', signature: head => startsWith(head, ascii('%PDF-')) },
  png: { mime: 'image/png', signature: head => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { mime: 'image/jpeg', signature: head => startsWith(head, [0xff, 0xd8, 0xff]) },
  jpeg: { mime: 'image/jpeg', signature: head => startsWith(head, [0xff, 0xd8, 0xff]) },
  gif: { mime: 'image/gif', signature: head => startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a')) },
  webp: { mime: 'image/webp', signature: head => startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8) },
  txt: { mime: 'text/plain', signature: text },
  csv: { mime: 'text/csv', signature: text },
  md: { mime: 'text/markdown', signature: text },
  doc: { mime: 'application/msword', signature: ole },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', signature: zip },
  xls: { mime: 'application/vnd.ms-excel', signature: ole },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', signature: zip },
  ppt: { mime: 'application/vnd.ms-powerpoint', signature: ole },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', signature: zip },
  zip: { mime: 'application/zip', signature: zip },
  mp4: { mime: 'video/mp4', signature: isoMedia },
  mov: { mime: 'video/quicktime', signature: isoMedia },
  webm: { mime: 'video/webm', signature: head => startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]) },
  mp3: { mime: 'audio/mpeg', signature: head => startsWith(head, ascii('ID3')) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) },
  psd: { mime: 'image/vnd.adobe.photoshop', signature: head => startsWith(head, ascii('8BPS')) },
}
/** The type LeadFlow stores for a file name, from its extension only: browsers' declared types are not trusted. */
export function documentType(fileName: string) {
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(fileName)?.[1]?.toLowerCase() ?? ''
  const type = documentTypes[extension]
  return type ? { extension, mime: type.mime } : null
}
/** The configured upload limit in bytes: DOCUMENT_MAX_MB (default 25), never above 50 MB. */
export const maxDocumentBytes = (runtime: Runtime) => { const mb = Number(runtime.env('DOCUMENT_MAX_MB')); return Math.round((Number.isFinite(mb) && mb > 0 ? Math.min(mb, 50) : 25) * 1048576) }

export class StorageError extends Error { constructor(message: string) { super(message) } }
const base = (runtime: Runtime) => `${runtime.env('SUPABASE_URL')}/storage/v1`
const auth = (runtime: Runtime) => { const key = runtime.env('SUPABASE_SERVICE_ROLE_KEY') ?? ''; return { apikey: key, Authorization: `Bearer ${key}` } }
const objectPath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** Creates the private bucket with its size and type limits on first use; Storage enforces both on every upload. */
export async function ensureBucket(runtime: Runtime) {
  const existing = await runtime.fetch(`${base(runtime)}/bucket/${documentBucket}`, { headers: auth(runtime), signal: AbortSignal.timeout(10000) })
  if (existing.ok) { await existing.body?.cancel(); return }
  await existing.body?.cancel()
  const created = await runtime.fetch(`${base(runtime)}/bucket`, { method: 'POST', headers: { ...auth(runtime), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ id: documentBucket, name: documentBucket, public: false, file_size_limit: maxDocumentBytes(runtime), allowed_mime_types: [...new Set(Object.values(documentTypes).map(type => type.mime))] }) })
  const body = await created.text()
  if (!created.ok && !/already exists|Duplicate/i.test(body)) throw new StorageError('The document store isn’t set up.')
}
/** A URL the browser can PUT the file to once, for a path the database chose. */
export async function signedUploadUrl(runtime: Runtime, path: string) {
  const response = await runtime.fetch(`${base(runtime)}/object/upload/sign/${documentBucket}/${objectPath(path)}`, { method: 'POST', headers: auth(runtime), signal: AbortSignal.timeout(10000) })
  const body = await response.json().catch(() => ({})) as { url?: string }
  if (!response.ok || typeof body.url !== 'string' || !body.url.includes('token=')) throw new StorageError('The upload couldn’t be prepared.')
  return `${base(runtime)}${body.url}`
}
/** A download link valid for 60 seconds, always served as an attachment under the file's own name. */
export async function signedDownloadUrl(runtime: Runtime, path: string, fileName: string) {
  const response = await runtime.fetch(`${base(runtime)}/object/sign/${documentBucket}/${objectPath(path)}`, { method: 'POST', headers: { ...auth(runtime), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 60 }), signal: AbortSignal.timeout(10000) })
  const body = await response.json().catch(() => ({})) as { signedURL?: string }
  if (!response.ok || typeof body.signedURL !== 'string') throw new StorageError('The file couldn’t be opened.')
  return `${base(runtime)}${body.signedURL}${body.signedURL.includes('?') ? '&' : '?'}download=${encodeURIComponent(fileName)}`
}
export async function removeObject(runtime: Runtime, path: string) {
  const response = await runtime.fetch(`${base(runtime)}/object/${documentBucket}`, { method: 'DELETE', headers: { ...auth(runtime), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [path] }), signal: AbortSignal.timeout(10000) })
  await response.body?.cancel()
  return response.ok
}
/**
 * Checks a stored upload: it exists, is within the limit, and starts with the signature its extension requires. A file
 * that fails is deleted from storage. Only the first 4 KB is read.
 */
export async function inspectUpload(runtime: Runtime, path: string, extension: string): Promise<{ ok: true; size: number } | { ok: false; reason: string }> {
  const type = documentTypes[extension]
  if (!type) return { ok: false, reason: 'This type of file isn’t allowed.' }
  const response = await runtime.fetch(`${base(runtime)}/object/authenticated/${documentBucket}/${objectPath(path)}`, { headers: { ...auth(runtime), Range: 'bytes=0-4095' }, signal: AbortSignal.timeout(20000) })
  if (response.status === 400 || response.status === 404) { await response.body?.cancel(); return { ok: false, reason: 'The upload didn’t finish. Try again.' } }
  if (!response.ok) { await response.body?.cancel(); throw new StorageError('The upload couldn’t be checked.') }
  const total = Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] ?? (response.status === 200 ? response.headers.get('content-length') : NaN))
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let length = 0
  if (reader) { try { while (length < 4096) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); length += value.length } } finally { await reader.cancel().catch(() => undefined) } }
  const head = new Uint8Array(Math.min(length, 4096)); let offset = 0
  for (const chunk of chunks) { const part = chunk.subarray(0, head.length - offset); head.set(part, offset); offset += part.length; if (offset >= head.length) break }
  const size = Number.isFinite(total) && total > 0 ? total : length
  let problem: string | null = null
  if (size < 1) problem = 'The file is empty.'
  else if (size > maxDocumentBytes(runtime)) problem = `Files can be up to ${Math.round(maxDocumentBytes(runtime) / 1048576)} MB.`
  else if (!type.signature(head)) problem = `This file’s contents don’t match a .${extension} file.`
  if (problem) { await removeObject(runtime, path).catch(() => false); return { ok: false, reason: problem } }
  return { ok: true, size }
}
