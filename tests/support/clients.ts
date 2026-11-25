import type { PGlite } from '@electric-sql/pglite'
import { createClientFilesHandler } from '../../supabase/functions/client-files/handler.ts'
import { createPortalHandler } from '../../supabase/functions/client-portal/handler.ts'
import type { Runtime } from '../../supabase/functions/_shared/runtime.ts'
/**
 * The client-files and client-portal Edge handlers wired to embedded PostgreSQL, with an in-memory stand-in for Supabase
 * Storage that behaves like its REST API: a private bucket with a size limit and allowed MIME types, one-time signed
 * upload URLs, authenticated range reads, signed download URLs and deletes. RPCs made with a member's token run as that
 * member; service-role RPCs run as service_role. Nothing leaves the process.
 */
export interface StoredObject { bytes: Uint8Array; contentType: string }
export function createClientsHarness(db: PGlite, overrides: Record<string, string> = {}) {
  const config: Record<string, string> = { SUPABASE_URL: 'https://project.test', SUPABASE_SERVICE_ROLE_KEY: 'test-server-key', SUPABASE_ANON_KEY: 'test-public-key',
    DISCOVERY_ALLOWED_ORIGINS: 'http://127.0.0.1:5175,http://127.0.0.1:4175', PORTAL_ALLOWED_ORIGINS: 'http://127.0.0.1:5175,http://127.0.0.1:4175', ...overrides }
  const state = { bucket: null as null | { public: boolean; file_size_limit: number; allowed_mime_types: string[] }, objects: new Map<string, StoredObject>(),
    uploadTokens: new Map<string, string>(), downloads: [] as string[], storageDown: false, rpcCalls: [] as string[] }
  const base = `${config.SUPABASE_URL}/storage/v1`, bucketName = 'client-documents'
  const isService = (init?: RequestInit) => new Headers(init?.headers).get('Authorization') === `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`
  const rpcCall = async (name: string, init: RequestInit | undefined) => {
    state.rpcCalls.push(name)
    const token = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '') ?? ''
    let role = 'service_role', sub = ''
    if (token !== config.SUPABASE_SERVICE_ROLE_KEY) {
      try { sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; role = 'authenticated' } catch { return Response.json({ code: 'PGRST301', message: 'Invalid JWT' }, { status: 401 }) }
    }
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>, keys = Object.keys(args)
    const values = keys.map(key => typeof args[key] === 'object' && args[key] !== null ? JSON.stringify(args[key]) : args[key])
    try {
      const result = await db.transaction(async tx => {
        await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)", [sub, JSON.stringify(sub ? { sub, role } : { role })])
        await tx.exec(`set local role ${role}`)
        return (await tx.query<{ result: unknown }>(`select public.${name}(${keys.map((key, index) => `"${key}" => $${index + 1}`).join(', ')}) as result`, values)).rows[0]?.result
      })
      return result === undefined || result === null ? new Response(null, { status: 204 }) : Response.json(result)
    } catch (error) {
      const { code, message } = error as { code?: string; message: string }
      return Response.json({ code, message }, { status: code === '42501' ? 403 : 400 })
    }
  }
  const storage = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    if (state.storageDown) return new Response('unavailable', { status: 503 })
    const method = init?.method ?? 'GET', path = decodeURIComponent(url.pathname.slice('/storage/v1'.length))
    if (path === `/bucket/${bucketName}` && method === 'GET') return isService(init) && state.bucket ? Response.json({ id: bucketName, ...state.bucket }) : Response.json({ error: 'Bucket not found' }, { status: 400 })
    if (path === '/bucket' && method === 'POST') {
      if (!isService(init)) return new Response('forbidden', { status: 403 })
      if (state.bucket) return Response.json({ error: 'The resource already exists' }, { status: 409 })
      const body = JSON.parse(String(init?.body)); state.bucket = { public: body.public, file_size_limit: body.file_size_limit, allowed_mime_types: body.allowed_mime_types }
      return Response.json({ name: bucketName })
    }
    const signUpload = path.match(new RegExp(`^/object/upload/sign/${bucketName}/(.+)$`))
    if (signUpload && method === 'POST') {
      if (!isService(init)) return new Response('forbidden', { status: 403 })
      const token = `up-${crypto.randomUUID()}`; state.uploadTokens.set(token, signUpload[1])
      return Response.json({ url: `/object/upload/sign/${bucketName}/${signUpload[1].split('/').map(encodeURIComponent).join('/')}?token=${token}` })
    }
    if (signUpload && method === 'PUT') {
      const token = url.searchParams.get('token') ?? ''
      if (state.uploadTokens.get(token) !== signUpload[1]) return Response.json({ error: 'Invalid signature' }, { status: 400 })
      state.uploadTokens.delete(token)
      const bytes = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()), contentType = new Headers(init?.headers).get('content-type') ?? ''
      if (!state.bucket) return Response.json({ error: 'Bucket not found' }, { status: 400 })
      if (bytes.length > state.bucket.file_size_limit) return Response.json({ error: 'Payload too large' }, { status: 413 })
      if (!state.bucket.allowed_mime_types.includes(contentType)) return Response.json({ error: 'invalid_mime_type' }, { status: 415 })
      if (state.objects.has(signUpload[1])) return Response.json({ error: 'The resource already exists' }, { status: 409 })
      state.objects.set(signUpload[1], { bytes, contentType })
      return Response.json({ Key: `${bucketName}/${signUpload[1]}` })
    }
    const read = path.match(new RegExp(`^/object/authenticated/${bucketName}/(.+)$`))
    if (read && method === 'GET') {
      if (!isService(init)) return new Response('forbidden', { status: 403 })
      const object = state.objects.get(read[1])
      if (!object) return Response.json({ statusCode: '404', error: 'not_found' }, { status: 400 })
      const range = new Headers(init?.headers).get('Range')?.match(/^bytes=(\d+)-(\d+)$/)
      if (!range) return new Response(object.bytes, { status: 200, headers: { 'content-length': String(object.bytes.length) } })
      const end = Math.min(Number(range[2]), object.bytes.length - 1)
      return new Response(object.bytes.slice(Number(range[1]), end + 1), { status: 206, headers: { 'content-range': `bytes ${range[1]}-${end}/${object.bytes.length}` } })
    }
    const signDownload = path.match(new RegExp(`^/object/sign/${bucketName}/(.+)$`))
    if (signDownload && method === 'POST') {
      if (!isService(init)) return new Response('forbidden', { status: 403 })
      if (!state.objects.has(signDownload[1])) return Response.json({ error: 'not_found' }, { status: 400 })
      state.downloads.push(signDownload[1])
      return Response.json({ signedURL: `/object/sign/${bucketName}/${signDownload[1]}?token=dl-${crypto.randomUUID()}` })
    }
    if (path === `/object/${bucketName}` && method === 'DELETE') {
      if (!isService(init)) return new Response('forbidden', { status: 403 })
      for (const prefix of JSON.parse(String(init?.body)).prefixes as string[]) state.objects.delete(prefix)
      return Response.json([])
    }
    throw new Error(`Unexpected storage call ${method} ${url.href}`)
  }
  const runtime: Runtime = { env: name => config[name], fetch: async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== config.SUPABASE_URL) throw new Error(`Unexpected URL ${url.href}`)
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1]
    if (rpc) return rpcCall(rpc, init)
    if (url.pathname.startsWith('/storage/v1/')) return storage(url, init)
    throw new Error(`Unexpected URL ${url.href}`)
  } }
  /** What the browser does with a signed upload URL. */
  const put = (uploadUrl: string, bytes: Uint8Array, contentType: string) => runtime.fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': contentType, 'x-upsert': 'false' }, body: bytes })
  return { config, state, runtime, files: createClientFilesHandler(runtime), portal: createPortalHandler(runtime), put, base }
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
export const memberToken = (id: string) => [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub: id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }), 'test-signature'].join('.')
export const filesRequest = (body: Record<string, unknown>, token: string | null, origin = 'http://127.0.0.1:5175') =>
  new Request('https://functions.test/client-files', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
export const portalCall = (body: Record<string, unknown>, origin = 'http://127.0.0.1:5175') =>
  new Request('https://functions.test/client-portal', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
// Minimal valid file contents for the signature checks.
export const samples = {
  pdf: new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n'),
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  fakePng: new TextEncoder().encode('<script>alert(1)</script>'),
  text: new TextEncoder().encode('Brand colours: #0E7A55, #111111\n'),
}
