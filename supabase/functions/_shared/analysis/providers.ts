// External analysis providers. Each normalizes its own API into internal shapes; nothing outside this file reads an
// Apify, PageSpeed or AI response directly. Keys come from Edge Function secrets and are never logged or returned.
import type { Runtime } from '../runtime.ts'
import { pageFromCrawler, type Page } from './html.ts'

export type ProviderFailureKind = 'not_configured' | 'auth' | 'credits' | 'not_found' | 'rate_limited' | 'unavailable' | 'timeout' | 'invalid' | 'failed'
export class ProviderError extends Error { kind: ProviderFailureKind; constructor(kind: ProviderFailureKind, message: string) { super(message); this.kind = kind } }
const positive = (value: string | undefined, fallback: number, max: number) => { const number = Number(value); return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback }

// ---------- Apify Website Content Crawler ----------
// Checked against apify.com/apify/website-content-crawler and docs.apify.com/api/v2 on 8 November 2026.
export interface ApifyConfig { token: string; actorId: string; crawlerType: string; maxPages: number; maxDepth: number; timeoutSecs: number; memoryMb: number; maxChargeUsd: number }
export function apifyConfig(env: Runtime['env']): ApifyConfig | null {
  const token = (env('APIFY_API_TOKEN') ?? '').trim()
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(token)) return null
  const actorId = (env('APIFY_WEBSITE_CRAWLER_ACTOR_ID') || 'apify~website-content-crawler').trim().replace('/', '~')
  return { token, actorId: /^[A-Za-z0-9._-]+~[A-Za-z0-9._-]+$|^[A-Za-z0-9]{10,30}$/.test(actorId) ? actorId : 'apify~website-content-crawler',
    // "cheerio" is the raw HTTP crawler (cheapest); "playwright:adaptive" renders JavaScript where needed.
    crawlerType: /^[a-z:]{3,30}$/.test(env('APIFY_CRAWLER_TYPE') ?? '') ? env('APIFY_CRAWLER_TYPE')! : 'cheerio',
    maxPages: positive(env('ANALYSIS_MAX_PAGES'), 10, 50), maxDepth: positive(env('ANALYSIS_MAX_DEPTH'), 2, 5), timeoutSecs: positive(env('APIFY_RUN_TIMEOUT_SECS'), 300, 1800),
    memoryMb: [1024, 2048, 4096].includes(Number(env('APIFY_MEMORY_MB'))) ? Number(env('APIFY_MEMORY_MB')) : 2048,
    maxChargeUsd: Number(env('APIFY_MAX_CHARGE_USD')) > 0 ? Math.min(Number(env('APIFY_MAX_CHARGE_USD')), 20) : 0.5 }
}
async function apifyRequest<T>(runtime: Runtime, config: ApifyConfig, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await runtime.fetch(`https://api.apify.com/v2${path}`, { ...init, headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(30000) })
  } catch (error) { throw new ProviderError((error as Error).name === 'TimeoutError' ? 'timeout' : 'unavailable', 'Apify couldn’t be reached.') }
  const body = await response.json().catch(() => null) as { data?: unknown; error?: { type?: string; message?: string } } | unknown[] | null
  if (response.ok) return body as T
  const error = !Array.isArray(body) && body && typeof body === 'object' && 'error' in body ? body.error ?? {} : {}
  const type = String(error.type ?? '')
  if (response.status === 401 || /token/.test(type)) throw new ProviderError('auth', 'Apify rejected the API token.')
  if (response.status === 402 || /not-enough-usage|payment|plan-required|limit-reached/.test(type)) throw new ProviderError('credits', 'Apify reports that the account doesn’t have enough credit or plan access for this run.')
  if (response.status === 404) throw new ProviderError('not_found', 'Apify couldn’t find this Actor or run. Check APIFY_WEBSITE_CRAWLER_ACTOR_ID.')
  if (response.status === 429) throw new ProviderError('rate_limited', 'Apify is rate-limiting requests right now.')
  if (response.status === 400) throw new ProviderError('invalid', `Apify didn’t accept the crawl settings${error.message ? `: ${String(error.message).slice(0, 160)}` : '.'}`)
  throw new ProviderError('unavailable', `Apify had a problem (HTTP ${response.status}).`)
}
export interface ApifyRun { runId: string; datasetId: string; status: string; usageUsd: number | null }
const runOf = (data: Record<string, unknown>): ApifyRun => {
  if (typeof data.id !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(data.id)) throw new ProviderError('failed', 'Apify returned an unexpected answer.')
  return { runId: data.id, datasetId: typeof data.defaultDatasetId === 'string' ? data.defaultDatasetId : '', status: String(data.status ?? ''),
    usageUsd: typeof data.usageTotalUsd === 'number' ? data.usageTotalUsd : null }
}
/** Starts a crawl of one site and returns at once; the run is polled later. */
export async function startApifyCrawl(runtime: Runtime, config: ApifyConfig, website: string): Promise<ApifyRun> {
  const query = new URLSearchParams({ timeout: String(config.timeoutSecs), memory: String(config.memoryMb), maxTotalChargeUsd: String(config.maxChargeUsd) })
  const input = { startUrls: [{ url: website }], crawlerType: config.crawlerType, maxCrawlPages: config.maxPages, maxCrawlDepth: config.maxDepth, maxConcurrency: 3,
    requestTimeoutSecs: 30, respectRobotsTxtFile: true, useSitemaps: false, proxyConfiguration: { useApifyProxy: true } }
  const body = await apifyRequest<{ data: Record<string, unknown> }>(runtime, config, `/actors/${config.actorId}/runs?${query}`, { method: 'POST', body: JSON.stringify(input) })
  return runOf(body.data ?? {})
}
export const getApifyRun = async (runtime: Runtime, config: ApifyConfig, runId: string) => runOf((await apifyRequest<{ data: Record<string, unknown> }>(runtime, config, `/actor-runs/${runId}`)).data ?? {})
export const abortApifyRun = (runtime: Runtime, config: ApifyConfig, runId: string) => apifyRequest(runtime, config, `/actor-runs/${runId}/abort`, { method: 'POST' }).catch(() => null)
/** The crawled pages, normalized. Items without a URL or text are skipped; duplicates by URL are dropped. */
/** The run's pages, normalized. Duplicates, empty or malformed items, and pages on other sites (when site is given) are skipped. */
export async function apifyPages(runtime: Runtime, config: ApifyConfig, datasetId: string, site?: string): Promise<{ pages: Page[]; skipped: number }> {
  const hostOf = (value: string) => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' } }
  const siteHost = site ? hostOf(site) : ''
  if (!/^[A-Za-z0-9]{1,40}$/.test(datasetId)) throw new ProviderError('failed', 'Apify returned no dataset for this run.')
  const items = await apifyRequest<unknown[]>(runtime, config, `/datasets/${datasetId}/items?${new URLSearchParams({ format: 'json', clean: 'true', limit: String(config.maxPages), fields: 'url,crawl,metadata,text' })}`)
  if (!Array.isArray(items)) throw new ProviderError('failed', 'Apify returned an unexpected dataset.')
  const pages: Page[] = [], seen = new Set<string>()
  let skipped = 0
  for (const raw of items) {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const crawl = (item.crawl ?? {}) as Record<string, unknown>, metadata = (item.metadata ?? {}) as Record<string, unknown>
    const url = typeof crawl.loadedUrl === 'string' ? crawl.loadedUrl : typeof item.url === 'string' ? item.url : ''
    const text = typeof item.text === 'string' ? item.text : ''
    if (!/^https?:\/\//.test(url) || !text.trim() || (siteHost && hostOf(url) !== siteHost)) { skipped++; continue }
    const key = url.replace(/[#?].*$/, '').replace(/\/$/, '')
    if (seen.has(key)) { skipped++; continue }
    seen.add(key)
    const openGraph: Record<string, string> = {}
    if (Array.isArray(metadata.openGraph)) for (const entry of metadata.openGraph) { const pair = entry as Record<string, unknown>; if (typeof pair.property === 'string' && typeof pair.content === 'string' && /^og:/.test(pair.property)) openGraph[pair.property] = pair.content.slice(0, 300) }
    const text$ = (value: unknown) => typeof value === 'string' ? value : ''
    pages.push(pageFromCrawler({ url, title: text$(metadata.title), description: text$(metadata.description), canonical: text$(metadata.canonicalUrl), lang: text$(metadata.languageCode),
      openGraph, text, status: typeof crawl.httpStatusCode === 'number' ? crawl.httpStatusCode : null }))
  }
  return { pages, skipped }
}

// ---------- Google PageSpeed Insights v5 ----------
export interface PageSpeedResult {
  strategy: 'mobile' | 'desktop'; finalUrl: string; fetchTime: string; performanceScore: number | null; seoScore: number | null
  lcpMs: number | null; fcpMs: number | null; cls: number | null; speedIndexMs: number | null; tbtMs: number | null
  field: { lcpMs: number | null; inpMs: number | null; cls: number | null; fcpMs: number | null; overall: string | null }
  viewportAudit: boolean | null
}
export async function runPageSpeed(runtime: Runtime, website: string, strategy: 'mobile' | 'desktop'): Promise<PageSpeedResult> {
  const key = (runtime.env('GOOGLE_PAGESPEED_API_KEY') ?? '').trim()
  if (!key) throw new ProviderError('not_configured', 'PageSpeed Insights isn’t configured.')
  const query = new URLSearchParams({ url: website, strategy: strategy.toUpperCase(), key })
  query.append('category', 'PERFORMANCE'); query.append('category', 'SEO')
  let response: Response
  try { response = await runtime.fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${query}`, { signal: AbortSignal.timeout(80000) }) }
  catch (error) { throw new ProviderError((error as Error).name === 'TimeoutError' ? 'timeout' : 'unavailable', 'PageSpeed Insights took too long or couldn’t be reached.') }
  const body = await response.json().catch(() => null) as Record<string, any> | null
  if (!response.ok) {
    const message = String(body?.error?.message ?? '').slice(0, 200)
    if (response.status === 429) throw new ProviderError('rate_limited', 'PageSpeed Insights quota reached. Try again later.')
    if (response.status === 400 && /API key/i.test(message)) throw new ProviderError('auth', 'PageSpeed Insights rejected the API key.')
    if (response.status === 403) throw new ProviderError('auth', 'PageSpeed Insights refused the API key (check that the API is enabled).')
    throw new ProviderError('failed', message ? `PageSpeed Insights couldn’t test this page: ${message.replace(/key=[^&\s]+/g, 'key=…')}` : `PageSpeed Insights failed (HTTP ${response.status}).`)
  }
  const lighthouse = body?.lighthouseResult ?? {}
  if (lighthouse.runtimeError?.code && lighthouse.runtimeError.code !== 'NO_ERROR') throw new ProviderError('failed', `PageSpeed Insights couldn’t test this page (${String(lighthouse.runtimeError.code).slice(0, 60)}).`)
  const audits = lighthouse.audits ?? {}, number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
  const audit = (id: string) => number(audits[id]?.numericValue)
  const field = body?.loadingExperience?.metrics ?? {}, percentile = (id: string) => number(field[id]?.percentile)
  const clsField = percentile('CUMULATIVE_LAYOUT_SHIFT_SCORE')
  return { strategy, finalUrl: String(lighthouse.finalUrl ?? body?.id ?? website).slice(0, 400), fetchTime: String(lighthouse.fetchTime ?? body?.analysisUTCTimestamp ?? new Date().toISOString()),
    performanceScore: number(lighthouse.categories?.performance?.score), seoScore: number(lighthouse.categories?.seo?.score),
    lcpMs: audit('largest-contentful-paint'), fcpMs: audit('first-contentful-paint'), cls: audit('cumulative-layout-shift'), speedIndexMs: audit('speed-index'), tbtMs: audit('total-blocking-time'),
    // Field data (real visitors, from the Chrome UX Report) exists only for sites with enough traffic. CLS percentile is reported x100.
    field: { lcpMs: percentile('LARGEST_CONTENTFUL_PAINT_MS'), inpMs: percentile('INTERACTION_TO_NEXT_PAINT'), cls: clsField === null ? null : clsField / 100,
      fcpMs: percentile('FIRST_CONTENTFUL_PAINT_MS'), overall: typeof body?.loadingExperience?.overall_category === 'string' ? body.loadingExperience.overall_category : null },
    viewportAudit: typeof audits.viewport?.score === 'number' ? audits.viewport.score === 1 : null }
}

// ---------- AI interpretation (Gemini) ----------
/** Injected by the Edge Function entry point (gemini.ts). Tests pass a fake. */
export interface AiRequest { system: string; user: string; schema: Record<string, unknown>; maxTokens: number }
export interface AiResponse { output: unknown; provider: string; inputTokens: number; outputTokens: number; model: string }
export type AiClient = (request: AiRequest) => Promise<AiResponse>
