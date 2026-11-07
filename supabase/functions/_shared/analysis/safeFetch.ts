// Fetching public business websites without letting a URL reach anything private (SSRF protection).
// Every URL, and every redirect hop, is checked before it is requested:
// * http or https only, on the default ports (or 80/443/8080/8443);
// * no credentials in the URL, no single-label or internal host names (localhost, *.local, *.internal, metadata hosts);
// * IP literals and every address the name resolves to (A and AAAA, through DNS-over-HTTPS) must be public.
// Remaining risk: the runtime's own resolver could answer differently from the DNS-over-HTTPS check (DNS rebinding).
// Edge Functions can't pin the connection to the checked address; the deny-lists still stop the direct cases.
import type { Runtime } from '../runtime.ts'

export type FetchFailure = 'invalid_url' | 'blocked_address' | 'not_found' | 'dns_unavailable' | 'unreachable' | 'timeout' | 'too_many_redirects' | 'too_large' | 'unsupported_content'
export class UnsafeUrlError extends Error { kind: FetchFailure; constructor(kind: FetchFailure, message: string) { super(message); this.kind = kind } }
export interface FetchResult {
  url: string; finalUrl: string; status: number; headers: Record<string, string>; body: string; truncated: boolean; redirects: string[]; elapsedMs: number
}
export const userAgent = 'Mozilla/5.0 (compatible; LeadFlow-Analysis/1.0)'

const blockedNames = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i
const metadataNames = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'kubernetes.default'])
function ipv4Private(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b, c] = parts
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
}
function ipv6Private(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  const mapped = ip.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? ip.match(/^::(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return ipv4Private(mapped[1])
  // URL parsing rewrites ::ffff:10.0.0.1 as ::ffff:a00:1, so the hexadecimal form of mapped and compatible addresses is checked too.
  const hexMapped = ip.match(/^(?:0*:)*:?(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMapped && /^(?:0*:)*:(?:ffff:)?[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(ip)) {
    const high = parseInt(hexMapped[1], 16), low = parseInt(hexMapped[2], 16)
    return ipv4Private(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  if (ip.startsWith('2002:')) { const [, high = '0', low = '0'] = ip.split(':'); const h = parseInt(high || '0', 16), l = parseInt(low || '0', 16); return ipv4Private(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`) }
  if (ip === '::' || ip === '::1' || /^0+(:0+)*:?:?1?$/.test(ip)) return true
  const first = parseInt(ip.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || ip.startsWith('2001:db8') || ip.startsWith('64:ff9b') || ip.startsWith('100::')
}
const isIPv4 = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
/** True for addresses that must never be fetched. Exported for tests. */
export const privateAddress = (ip: string) => ip.includes(':') ? ipv6Private(ip) : ipv4Private(ip)

/** Parses and checks a URL without network access. Throws UnsafeUrlError with a reason. */
export function checkUrl(input: string): URL {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new UnsafeUrlError('invalid_url', 'This isn’t a valid web address.') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeUrlError('invalid_url', 'Only http and https websites can be analyzed.')
  if (url.username || url.password) throw new UnsafeUrlError('invalid_url', 'Website addresses with a user name or password can’t be analyzed.')
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new UnsafeUrlError('blocked_address', 'Only websites on standard web ports can be analyzed.')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[') || host.includes(':')) { if (ipv6Private(host)) throw new UnsafeUrlError('blocked_address', 'This address points to a private network.') }
  else if (isIPv4(host)) { if (ipv4Private(host)) throw new UnsafeUrlError('blocked_address', 'This address points to a private network.') }
  // Decimal, octal or hex IPv4 forms ("2130706433", "0x7f.1") are normalized by URL; anything numeric-looking left over is refused.
  else if (/^[0-9.x]+$/i.test(host)) throw new UnsafeUrlError('blocked_address', 'This address points to a private network.')
  else if (!host.includes('.') || blockedNames.test(host) || metadataNames.has(host)) throw new UnsafeUrlError('blocked_address', 'This address isn’t a public website.')
  url.hash = ''
  return url
}

interface DohAnswer { Status?: number; Answer?: { type: number; data: string }[] }
/** Resolves a host name through DNS-over-HTTPS and refuses it if any address is private. */
export async function checkResolution(runtime: Runtime, host: string, cache: Map<string, true>) {
  if (cache.has(host) || isIPv4(host) || host.includes(':') || host.startsWith('[')) return
  const resolver = runtime.env('ANALYSIS_DNS_RESOLVER') || 'https://cloudflare-dns.com/dns-query'
  const addresses: string[] = []
  let notFound = 0
  for (const type of ['A', 'AAAA']) {
    let body: DohAnswer
    try {
      const response = await runtime.fetch(`${resolver}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(String(response.status))
      body = await response.json()
    } catch { throw new UnsafeUrlError('dns_unavailable', 'The website’s address couldn’t be checked right now.') }
    if (body.Status === 3) notFound++
    for (const answer of body.Answer ?? []) if ((answer.type === 1 || answer.type === 28) && typeof answer.data === 'string') addresses.push(answer.data)
  }
  if (!addresses.length) throw new UnsafeUrlError('not_found', notFound ? 'This domain doesn’t exist.' : 'This domain has no web server address.')
  if (addresses.some(privateAddress)) throw new UnsafeUrlError('blocked_address', 'This domain points to a private network.')
  cache.set(host, true)
}

/** GET a public URL, checking every redirect hop, with a size limit and a timeout. Never sends cookies or credentials. */
export async function safeFetch(runtime: Runtime, input: string, options: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; accept?: string; dnsCache?: Map<string, true> } = {}): Promise<FetchResult> {
  const started = Date.now(), maxBytes = options.maxBytes ?? 1_500_000, redirects: string[] = [], dnsCache = options.dnsCache ?? new Map()
  let url = checkUrl(input)
  for (let hop = 0; ; hop++) {
    await checkResolution(runtime, url.hostname.toLowerCase(), dnsCache)
    let response: Response
    try {
      response = await runtime.fetch(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { 'User-Agent': userAgent, Accept: options.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15000) } as RequestInit)
    } catch (error) {
      throw new UnsafeUrlError((error as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable', (error as Error).name === 'TimeoutError' ? 'The website took too long to answer.' : 'The website couldn’t be reached.')
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel().catch(() => {})
      if (hop >= (options.maxRedirects ?? 5)) throw new UnsafeUrlError('too_many_redirects', 'The website redirects too many times.')
      redirects.push(url.href)
      url = checkUrl(new URL(response.headers.get('location')!, url).href)
      continue
    }
    const headers: Record<string, string> = {}
    for (const [name, value] of response.headers) if (['content-type', 'server', 'x-powered-by', 'x-robots-tag', 'content-language', 'strict-transport-security', 'x-generator', 'via', 'set-cookie'].includes(name)) headers[name] = name === 'set-cookie' ? '(set)' : value.slice(0, 300)
    const type = (headers['content-type'] ?? '').toLowerCase()
    if (type && !/text\/|html|xml|json/.test(type)) { await response.body?.cancel().catch(() => {}); return { url: input, finalUrl: url.href, status: response.status, headers, body: '', truncated: false, redirects, elapsedMs: Date.now() - started } }
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0, truncated = false
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          if (length + value.length > maxBytes) { chunks.push(value.slice(0, maxBytes - length)); length = maxBytes; truncated = true; await reader.cancel(); break }
          chunks.push(value); length += value.length
        }
      } catch { /* A body cut off mid-way is still analyzed as far as it got. */ truncated = true }
    }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return { url: input, finalUrl: url.href, status: response.status, headers, body: new TextDecoder().decode(bytes), truncated, redirects, elapsedMs: Date.now() - started }
  }
}
