// The analysis pipeline: one step per call, so each Edge Function invocation stays short and a slow provider (an Apify
// crawl takes minutes) is polled instead of waited on. Steps, in order:
//   validate → crawl → [crawl_wait, while an Apify run is going] → site_checks → pagespeed_mobile → pagespeed_desktop → interpret → match
// Each step returns what it produced; save_business_analysis_step stores it atomically under the step's lease. A
// provider that fails is recorded in `providers` and the pipeline moves on, so one failure never loses other results.
import { rpc, type Runtime } from '../runtime.ts'
import { detectTechnologies, pageKind, parseHtml, socialProfiles, type Detection, type Page } from './html.ts'
import { aiSchema, aiSystemPrompt, evidenceDigest, factualOverview, matchOpportunities, ruleFindings, validateAiOutput, type Evidence, type Finding, type Opportunity, type Service } from './intelligence.ts'
import { abortApifyRun, apifyConfig, apifyPages, getApifyRun, ProviderError, runPageSpeed, startApifyCrawl, type AiClient } from './providers.ts'
import { checkUrl, safeFetch, UnsafeUrlError, type FetchResult } from './safeFetch.ts'

export interface PipelineDeps { ai: AiClient | null; now?: () => number }
interface Job {
  id: string; workspaceId: string; leadId: string; website: string; status: string; step: string; providers: Record<string, any>; apifyRunId: string | null; apifyDatasetId: string | null
  pagesAnalyzed: number; attempts: number; leaseId: string; createdAt: string; lead: { name?: string; company?: string; industry?: string; city?: string; region?: string; country?: string } | null
  evidence: Evidence[]; findings: Finding[]; services: Service[]; monthUsage: Record<string, number>
}
interface StepResult { patch: Record<string, unknown>; evidence: Evidence[]; findings: Finding[]; opportunities: Opportunity[]; usage: { provider: string; quantity: number; unit: string; costUsd?: number | null }[] }
const statusOf: Record<string, string> = { validate: 'validating', crawl: 'crawling', crawl_wait: 'crawling', site_checks: 'measuring', pagespeed_mobile: 'measuring', pagespeed_desktop: 'measuring', interpret: 'analyzing', match: 'matching' }
const limit = (runtime: Runtime, name: string, fallback: number) => { const value = Number(runtime.env(name)); return Number.isInteger(value) && value > 0 ? value : fallback }

/** Evidence collected during one step, numbered after what the analysis already has. */
class Collector {
  items: Evidence[] = []
  private start: number
  constructor(start: number) { this.start = start }
  add(category: string, kind: string, sourceUrl: string | null, provider: string, value: unknown) {
    let stored = value
    // Keep each item well under the column limit: trim long page text and link lists first.
    if (JSON.stringify(stored).length > 22000 && stored && typeof stored === 'object') {
      const page = { ...(stored as Record<string, unknown>) }
      if (typeof page.text === 'string') page.text = page.text.slice(0, 1500)
      if (Array.isArray(page.internalLinks)) page.internalLinks = page.internalLinks.slice(0, 20)
      if (Array.isArray(page.externalLinks)) page.externalLinks = page.externalLinks.slice(0, 20)
      stored = page
    }
    const item: Evidence = { id: crypto.randomUUID(), ref: `E${this.start + this.items.length + 1}`, category, kind, sourceUrl: sourceUrl?.slice(0, 500) ?? null, provider, value: stored, observedAt: new Date().toISOString() }
    this.items.push(item)
    return item
  }
}
const pageForStorage = (page: Page): Page => ({ ...page, internalLinks: page.internalLinks.slice(0, 40), externalLinks: page.externalLinks.slice(0, 30) })
function addTechnologies(collector: Collector, known: Set<string>, detections: Detection[]) {
  for (const detection of detections) if (!known.has(detection.name)) { known.add(detection.name); collector.add('technology', 'technology', detection.url, 'native', detection) }
}

// Pages worth reading first: how the business sells and how to reach it.
const priority = ['booking', 'contact', 'services', 'about', 'pricing', 'products', 'other', 'blog']
async function nativeCrawl(runtime: Runtime, job: Job, collector: Collector, deadline: number) {
  const home = job.evidence.find(item => item.kind === 'page' && item.value.kind === 'home')?.value as Page | undefined
  if (!home) return 0
  const maxPages = limit(runtime, 'ANALYSIS_MAX_PAGES', 10)
  const done = new Set(job.evidence.filter(item => item.kind === 'page').map(item => (item.sourceUrl ?? '').replace(/\/$/, '')))
  const known = new Set(job.evidence.filter(item => item.kind === 'technology').map(item => item.value.name as string))
  const candidates = home.internalLinks.filter(link => !/\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)(\?|$)/i.test(link.url) && !done.has(link.url.replace(/\/$/, '')))
    .map(link => ({ link, kind: pageKind(link.url, link.text) }))
    .filter(candidate => candidate.kind !== 'home')
    .sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind))
  const dnsCache = new Map<string, true>()
  let fetched = 0
  for (const { link } of candidates) {
    if (done.size + fetched >= maxPages || Date.now() > deadline) break
    let result: FetchResult
    try { result = await safeFetch(runtime, link.url, { timeoutMs: 10000, dnsCache }) } catch { continue }
    if (result.status >= 400 || !result.body) continue
    const page = parseHtml(result.body, result.finalUrl, result.status)
    if (done.has(page.url.replace(/\/$/, ''))) continue
    done.add(page.url.replace(/\/$/, ''))
    collector.add('structure', 'page', page.url, 'native', pageForStorage(page))
    addTechnologies(collector, known, detectTechnologies(result.body, page.url, result.headers))
    fetched++
  }
  return fetched
}

async function runStep(runtime: Runtime, deps: PipelineDeps, job: Job): Promise<StepResult> {
  const collector = new Collector(job.evidence.length)
  const result = (patch: Record<string, unknown>, extra: Partial<StepResult> = {}): StepResult => {
    const next = patch.step === undefined ? job.step : patch.step as string | null
    return { patch: { ...(next ? { status: statusOf[next] ?? job.status } : {}), ...patch }, evidence: collector.items, findings: [], opportunities: [], usage: [], ...extra }
  }
  const hasPageSpeed = !!(runtime.env('GOOGLE_PAGESPEED_API_KEY') ?? '').trim()
  const afterChecks = hasPageSpeed ? 'pagespeed_mobile' : 'interpret'

  if (job.step === 'validate') {
    let fetched: FetchResult
    try { fetched = await safeFetch(runtime, job.website) } catch (error) {
      const failure = error instanceof UnsafeUrlError ? error : new UnsafeUrlError('unreachable', 'The website couldn’t be reached.')
      // A single failed request doesn't prove a site is gone: network problems are retried before concluding.
      if (['unreachable', 'timeout', 'dns_unavailable'].includes(failure.kind) && job.attempts < 3) return result({ delaySeconds: 30 * job.attempts, providers: { site: { status: 'retrying', detail: failure.message } } })
      collector.add('availability', 'http_check', job.website, 'native', { requestedUrl: job.website, finalUrl: null, status: null, redirects: [], outcome: failure.kind, detail: failure.message })
      const final = ['invalid_url', 'blocked_address', 'not_found'].includes(failure.kind)
      const message = failure.kind === 'not_found' ? `${failure.message} Check the website address on the lead.` : failure.kind === 'blocked_address' || failure.kind === 'invalid_url' ? failure.message
        : `${failure.message} Tried ${job.attempts} times; the site may be down temporarily. Retry later.`
      return result(final || !hasPageSpeed ? { step: null, status: 'failed', failure: message, providers: { site: { status: failure.kind, detail: message } } }
        : { step: 'pagespeed_mobile', providers: { site: { status: failure.kind, detail: message } } })
    }
    const type = fetched.headers['content-type'] ?? '', challenge = /cf-chl|captcha|just a moment|attention required|access denied|bot detection/i.test(fetched.body.slice(0, 20000))
    const outcome = fetched.status >= 200 && fetched.status < 300 && /html/i.test(type || 'text/html') && fetched.body ? 'ok'
      : fetched.status === 401 ? 'requires_auth' : [403, 429].includes(fetched.status) || challenge ? 'blocked' : fetched.status >= 500 ? 'temporarily_unavailable' : 'error'
    if (outcome === 'temporarily_unavailable' && job.attempts < 3) return result({ delaySeconds: 30 * job.attempts, providers: { site: { status: 'retrying', detail: `The website answered HTTP ${fetched.status}.` } } })
    collector.add('availability', 'http_check', job.website, 'native', { requestedUrl: job.website, finalUrl: fetched.finalUrl, status: fetched.status, redirects: fetched.redirects,
      outcome, elapsedMs: fetched.elapsedMs, server: fetched.headers.server ?? null, contentType: type || null, truncated: fetched.truncated })
    const details: Record<string, string> = { requires_auth: 'The website asks for a login, which LeadFlow doesn’t bypass.', blocked: 'The website blocks automated visits (bot protection), which LeadFlow doesn’t bypass.',
      temporarily_unavailable: `The website answered HTTP ${fetched.status} repeatedly.`, error: `The homepage answered HTTP ${fetched.status}${type && !/html/i.test(type) ? ` with ${type}` : ''}.` }
    if (outcome !== 'ok') return result(hasPageSpeed ? { step: 'pagespeed_mobile', providers: { site: { status: outcome, detail: details[outcome] } } }
      : { step: null, status: 'failed', failure: details[outcome], providers: { site: { status: outcome, detail: details[outcome] } } })
    const page = parseHtml(fetched.body, fetched.finalUrl, fetched.status)
    page.kind = 'home'
    collector.add('structure', 'page', page.url, 'native', pageForStorage(page))
    addTechnologies(collector, new Set(), detectTechnologies(fetched.body, page.url, fetched.headers))
    return result({ step: 'crawl', pagesAnalyzed: 1, providers: { site: { status: 'ok', detail: `HTTP ${fetched.status}${fetched.redirects.length ? ` after ${fetched.redirects.length} redirect(s)` : ''}` } } })
  }

  if (job.step === 'crawl' || job.step === 'crawl_fallback') {
    const config = apifyConfig(runtime.env), monthlyPages = limit(runtime, 'ANALYSIS_MONTHLY_PAGE_LIMIT', 500)
    const usedPages = job.monthUsage['apify:pages'] ?? 0
    if (job.step === 'crawl' && config && usedPages + config.maxPages <= monthlyPages) {
      try {
        const run = await startApifyCrawl(runtime, config, job.website)
        return result({ step: 'crawl_wait', delaySeconds: 15, apifyRunId: run.runId, apifyDatasetId: run.datasetId || null,
          providers: { apify: { status: 'running', detail: `Run ${run.runId} started (${config.crawlerType}, up to ${config.maxPages} pages).` } } },
          { usage: [{ provider: 'apify', quantity: 1, unit: 'runs' }] })
      } catch (error) {
        job.providers.apify = { status: 'failed', detail: error instanceof ProviderError ? error.message : 'Apify couldn’t start the crawl.' }
      }
    }
    const apify = job.step === 'crawl_fallback' ? job.providers.apify : config ? job.providers.apify ?? { status: 'limit_reached', detail: `This month’s crawl budget (${monthlyPages} pages) is used up.` } : { status: 'not_configured', detail: 'APIFY_API_TOKEN isn’t set; LeadFlow read the pages itself.' }
    const fetched = await nativeCrawl(runtime, job, collector, Date.now() + 45000)
    const total = job.pagesAnalyzed + fetched
    return result({ step: 'site_checks', pagesAnalyzed: total, providers: { apify, crawl: { status: 'ok', detail: `LeadFlow read ${total} page${total === 1 ? '' : 's'} directly.` } } })
  }

  if (job.step === 'crawl_wait') {
    const config = apifyConfig(runtime.env)
    if (!config || !job.apifyRunId) return result({ step: 'crawl_fallback', providers: { apify: { status: 'failed', detail: 'The Apify run can’t be checked: the token was removed.' } } })
    let run
    try { run = await getApifyRun(runtime, config, job.apifyRunId) } catch (error) {
      if (error instanceof ProviderError && ['unavailable', 'timeout', 'rate_limited'].includes(error.kind) && job.attempts < 30) return result({ delaySeconds: 30 })
      return result({ step: 'crawl_fallback', providers: { apify: { status: 'failed', detail: error instanceof ProviderError ? error.message : 'The Apify run couldn’t be checked.' } } })
    }
    const age = ((deps.now?.() ?? Date.now()) - Date.parse(job.createdAt)) / 1000
    if (['READY', 'RUNNING'].includes(run.status)) {
      if (age < config.timeoutSecs + 180) return result({ delaySeconds: 15 })
      await abortApifyRun(runtime, config, run.runId)
      return result({ step: 'crawl_fallback', providers: { apify: { status: 'timeout', detail: 'The Apify crawl took too long and was stopped; LeadFlow read the pages itself.' } } })
    }
    if (run.status !== 'SUCCEEDED') {
      return result({ step: 'crawl_fallback', providers: { apify: { status: 'failed', detail: `The Apify run ended with status ${run.status}; LeadFlow read the pages itself.` } } },
        { usage: run.usageUsd !== null ? [{ provider: 'apify', quantity: 0, unit: 'pages', costUsd: run.usageUsd }] : [] })
    }
    let crawled
    try { crawled = await apifyPages(runtime, config, run.datasetId || job.apifyDatasetId || '', job.website) } catch (error) {
      if (error instanceof ProviderError && ['unavailable', 'timeout', 'rate_limited'].includes(error.kind) && job.attempts < 30) return result({ delaySeconds: 30 })
      return result({ step: 'crawl_fallback', providers: { apify: { status: 'failed', detail: error instanceof ProviderError ? error.message : 'The crawled pages couldn’t be retrieved.' } } })
    }
    const usage = [{ provider: 'apify', quantity: crawled.pages.length, unit: 'pages', costUsd: run.usageUsd }]
    if (!crawled.pages.length) return result({ step: 'crawl_fallback', providers: { apify: { status: 'empty', detail: 'The Apify crawl returned no readable pages; LeadFlow read the pages itself.' } } }, { usage })
    // The homepage read directly (with HTML) is kept; crawler copies of pages already read are skipped.
    const known = new Set(job.evidence.filter(item => item.kind === 'page').map(item => (item.sourceUrl ?? '').replace(/\/$/, '')))
    let added = 0
    for (const page of crawled.pages) if (!known.has(page.url.replace(/\/$/, ''))) { known.add(page.url.replace(/\/$/, '')); collector.add('structure', 'page', page.url, 'apify', page); added++ }
    return result({ step: 'site_checks', pagesAnalyzed: job.pagesAnalyzed + added, providers: { apify: { status: 'ok', detail: `Crawled ${crawled.pages.length} page${crawled.pages.length === 1 ? '' : 's'}${crawled.skipped ? `, skipped ${crawled.skipped} empty, duplicate or off-site` : ''}.${run.usageUsd !== null ? ` Apify reported $${run.usageUsd.toFixed(3)}.` : ''}` } } }, { usage })
  }

  if (job.step === 'site_checks') {
    const check = job.evidence.find(item => item.kind === 'http_check'), origin = new URL(check?.value.finalUrl ?? job.website).origin
    const dnsCache = new Map<string, true>()
    let sitemaps: string[] = []
    try {
      const robots = await safeFetch(runtime, `${origin}/robots.txt`, { maxBytes: 100_000, timeoutMs: 8000, accept: 'text/plain', dnsCache })
      const text = robots.status === 200 && !/<html/i.test(robots.body.slice(0, 500)) ? robots.body : ''
      let disallowAll = false, inStar = false
      for (const line of text.split(/\r?\n/).map(row => row.replace(/#.*/, '').trim())) {
        const [field, ...rest] = line.split(':'), value = rest.join(':').trim()
        if (/^user-agent$/i.test(field)) inStar = value === '*'
        else if (inStar && /^disallow$/i.test(field) && value === '/') disallowAll = true
        else if (/^sitemap$/i.test(field) && /^https?:\/\//.test(value) && sitemaps.length < 3) sitemaps.push(value)
      }
      collector.add('seo', 'robots_txt', `${origin}/robots.txt`, 'native', { status: robots.status, found: !!text, disallowAll, sitemaps, excerpt: text.slice(0, 500) })
    } catch { /* robots.txt couldn't be checked; no finding is made from that. */ }
    if (!sitemaps.length) sitemaps = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]
    const checked: string[] = []
    let sitemapFound: { url: string; urlCount: number } | null = null
    for (const url of sitemaps) {
      try { checkUrl(url) } catch { continue }
      checked.push(url)
      try {
        const response = await safeFetch(runtime, url, { maxBytes: 2_000_000, timeoutMs: 8000, accept: 'application/xml,text/xml', dnsCache })
        if (response.status === 200 && /<(urlset|sitemapindex)\b/i.test(response.body)) { sitemapFound = { url: response.finalUrl, urlCount: (response.body.match(/<loc>/gi) ?? []).length }; break }
      } catch { /* try the next location */ }
    }
    if (checked.length) collector.add('seo', 'sitemap', sitemapFound?.url ?? checked[0], 'native', { found: !!sitemapFound, checked, urlCount: sitemapFound?.urlCount ?? 0 })
    const pages = job.evidence.filter(item => item.kind === 'page')
    const fetchedUrls = new Set(pages.map(item => (item.sourceUrl ?? '').replace(/\/$/, '')))
    const links = [...new Set(pages.flatMap(item => (item.value.internalLinks ?? []) as { url: string }[]).map(link => link.url))]
      .filter(url => !fetchedUrls.has(url.replace(/\/$/, '')) && !/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4)(\?|$)/i.test(url)).slice(0, limit(runtime, 'ANALYSIS_LINK_CHECKS', 8))
    const broken: { url: string; status: number }[] = []
    let verified = 0
    const deadline = Date.now() + 30000
    for (const url of links) {
      if (Date.now() > deadline) break
      try { const response = await safeFetch(runtime, url, { maxBytes: 2048, timeoutMs: 8000, dnsCache }); verified++; if (response.status >= 400 && response.status !== 401 && response.status !== 403 && response.status !== 429) broken.push({ url, status: response.status }) }
      catch { /* not counted either way */ }
    }
    if (verified) collector.add('seo', 'link_check', origin, 'native', { checked: verified, broken })
    if (pages.length) collector.add('social', 'social_profiles', origin, 'native', { profiles: socialProfiles(pages.map(item => item.value as Page)) })
    return result({ step: afterChecks })
  }

  if (job.step === 'pagespeed_mobile' || job.step === 'pagespeed_desktop') {
    const strategy = job.step === 'pagespeed_mobile' ? 'mobile' : 'desktop', next = strategy === 'mobile' ? 'pagespeed_desktop' : 'interpret'
    const target = job.evidence.find(item => item.kind === 'http_check')?.value.finalUrl ?? job.website
    const state = { ...(job.providers.pagespeed ?? {}) }
    try {
      const measured = await runPageSpeed(runtime, target, strategy)
      collector.add('performance', 'pagespeed', measured.finalUrl, 'pagespeed', measured)
      state[strategy] = 'ok'
      return result({ step: next, providers: { pagespeed: { ...state, status: state.mobile === 'failed' || state.desktop === 'failed' ? 'partial' : 'ok', detail: `Measured by PageSpeed Insights on ${measured.fetchTime.slice(0, 10)}.` } } },
        { usage: [{ provider: 'pagespeed', quantity: 1, unit: 'requests' }] })
    } catch (error) {
      const failure = error instanceof ProviderError ? error : new ProviderError('failed', 'PageSpeed Insights failed.')
      // One retry after a short wait for temporary problems; then the measurement is reported as unavailable.
      if (['rate_limited', 'unavailable', 'timeout'].includes(failure.kind) && !state[`${strategy}Retried`]) return result({ delaySeconds: 60, providers: { pagespeed: { ...state, [`${strategy}Retried`]: true } } },
        { usage: [{ provider: 'pagespeed', quantity: 1, unit: 'requests' }] })
      state[strategy] = 'failed'
      return result({ step: next, providers: { pagespeed: { ...state, status: state.mobile === 'ok' || state.desktop === 'ok' ? 'partial' : 'failed', detail: failure.message } } },
        { usage: [{ provider: 'pagespeed', quantity: 1, unit: 'requests' }] })
    }
  }

  if (job.step === 'interpret') {
    const rules = ruleFindings(job.evidence)
    const facts = factualOverview(job.evidence, job.lead, job.website)
    let ai: ReturnType<typeof validateAiOutput>['overview'] = null, aiFindings: Finding[] = [], aiState: Record<string, unknown>
    const usage: StepResult['usage'] = []
    const pages = job.evidence.filter(item => item.kind === 'page').length
    if (!deps.ai) aiState = { status: 'not_configured', detail: 'GEMINI_API_KEY isn’t set; the report has rule-based findings only.' }
    else if (!pages) aiState = { status: 'skipped', detail: 'No website content was collected to interpret.' }
    else {
      try {
        const response = await deps.ai({ system: aiSystemPrompt, user: evidenceDigest(job.evidence, rules, job.lead, job.website), schema: aiSchema, maxTokens: 16000 })
        const checked = validateAiOutput(response.output, job.evidence, rules)
        ai = checked.overview; aiFindings = checked.findings
        aiState = { status: 'ok', detail: `${response.model}: ${checked.findings.length} interpretation${checked.findings.length === 1 ? '' : 's'} kept${checked.dropped ? `, ${checked.dropped} dropped for missing or invalid evidence` : ''}.` }
        usage.push({ provider: response.provider, quantity: response.inputTokens, unit: 'input_tokens' }, { provider: response.provider, quantity: response.outputTokens, unit: 'output_tokens' })
      } catch (error) {
        aiState = { status: 'failed', detail: error instanceof ProviderError ? error.message : 'The AI interpretation failed; the report has rule-based findings only.' }
      }
    }
    return result({ step: 'match', overview: { facts, ai }, providers: { ai: aiState } }, { findings: [...rules, ...aiFindings], usage })
  }

  if (job.step === 'match') {
    const opportunities = job.findings.length ? matchOpportunities(job.findings, job.services, job.lead?.industry ?? '') : []
    const site = job.providers.site?.status
    const degraded = ['apify', 'pagespeed', 'ai'].some(name => ['failed', 'partial', 'limit_reached', 'timeout', 'empty'].includes(job.providers[name]?.status))
    const status = site !== 'ok' && !job.findings.length ? 'failed' : site !== 'ok' || degraded || job.pagesAnalyzed < 2 ? 'partial' : 'completed'
    return result({ step: null, status, ...(status === 'failed' ? { failure: job.providers.site?.detail ?? 'Nothing could be analyzed.' } : {}) }, { opportunities })
  }
  return result({ step: null, status: 'failed', failure: `Unknown step ${job.step}.` })
}

/** Claims one due analysis (or the given one), runs its next step and saves the result. Returns null when nothing was due. */
export async function advanceAnalysis(runtime: Runtime, deps: PipelineDeps, target: string | null) {
  const job = await rpc<Job | null>(runtime, 'claim_business_analysis', { target, lease_seconds: 170 })
  if (!job) return null
  let step: StepResult
  try { step = await runStep(runtime, deps, job) } catch (error) {
    // An unexpected error: retry later with backoff, and give up after many attempts.
    const giveUp = job.attempts >= 40
    console.error(`analysis ${job.id} step ${job.step} error${error instanceof Error ? `: ${error.name}` : ''}`)
    step = { patch: giveUp ? { step: null, status: 'failed', failure: 'The analysis stopped after repeated errors. Start it again.' } : { delaySeconds: Math.min(300, 20 * job.attempts) }, evidence: [], findings: [], opportunities: [], usage: [] }
  }
  const outcome = await rpc<string>(runtime, 'save_business_analysis_step', { analysis_id: job.id, lease: job.leaseId, patch: step.patch, evidence: step.evidence,
    findings: step.findings, opportunities: step.opportunities, usage: step.usage })
  console.log(`analysis ${job.id} ${job.step} -> ${step.patch.step === undefined ? job.step : step.patch.step ?? 'done'} (${outcome})`)
  return { id: job.id, step: job.step, outcome, next: step.patch.step === undefined ? job.step : step.patch.step as string | null }
}
