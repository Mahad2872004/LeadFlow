// Contact discovery for one lead, as a job of two short steps (the same lease-and-save pattern as business analysis):
//   website → verify
// * website: contacts and channels from the lead's latest business report (its stored page evidence, cited by evidence ID),
//   then a few more pages read directly (team, leadership, about, contact) for people, addresses and details the report
//   didn't keep. robots.txt is respected; logins, CAPTCHAs and bot protection are never worked around.
// * verify: each email domain's mail servers (MX) through DNS-over-HTTPS, and phone formats for the lead's country.
//   Nothing is sent to any address.
// A verify-only job (mode "verify") re-checks the contacts it names, for "refresh" on a single contact.
import { rpc, type Runtime } from '../runtime.ts'
import { parseHtml, type Page } from '../analysis/html.ts'
import { checkUrl, safeFetch, UnsafeUrlError } from '../analysis/safeFetch.ts'
import { emailMatchesName, emailStatusFrom, extractFromHtml, extractFromPage, looksLikeName, nameKey, normalizeEmail, normalizePhone, sameOrganizationDomain,
  type ChannelCandidate, type ContactCandidate, type EmailStatus, type MailDomainCheck, type PhoneStatus } from './contacts.ts'

interface JobContact { id: string; kind: string; email: string; emailStatus: EmailStatus; emailCheckedAt: string | null; phone: string; phoneE164: string; phoneStatus: PhoneStatus; sources: { source: string; how: string; field: string }[] }
interface Job {
  id: string; workspaceId: string; leadId: string; step: string; status: string; options: { mode?: 'full' | 'verify'; contactIds?: string[] }; providers: Record<string, any>
  progress: Record<string, number>; attempts: number; leaseId: string; createdAt: string
  lead: { name: string; company: string; email: string; phone: string; website: string; country: string } | null
  analysis: { id: string; completedAt: string | null } | null
  pages: { evidenceId: string; sourceUrl: string | null; observedAt: string; value: Page }[]
  contacts: JobContact[]
}
interface StepResult { patch: Record<string, unknown>; contacts: ContactCandidate[]; channels: ChannelCandidate[]; verifications: Record<string, unknown>[]; usage: { provider: string; operation: string; quantity: number; unit: string; status: string }[] }
const limit = (runtime: Runtime, name: string, fallback: number, max: number) => { const value = Number(runtime.env(name)); return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback }
// Pages most likely to name people or list contact details.
const contactPage = /\b(team|our-team|people|staff|leadership|management|founders?|who-we-are|meet|about|contact|get-in-touch|locations?)\b/i
const contactPriority = (url: string) => /\b(team|people|staff|leadership|management|founders?|meet)\b/i.test(url) ? 0 : /\b(about|who-we-are)\b/i.test(url) ? 1 : /\b(contact|get-in-touch|locations?)\b/i.test(url) ? 2 : 3

/** robots.txt rules for any crawler (*) and for LeadFlow: the paths this job must not fetch. */
export function robotsDisallows(text: string): string[] {
  const disallowed: string[] = []
  let applies = false, sawRule = false
  for (const line of text.split(/\r?\n/).map(row => row.replace(/#.*/, '').trim()).filter(Boolean)) {
    const [field, ...rest] = line.split(':'), value = rest.join(':').trim()
    if (/^user-agent$/i.test(field)) { if (sawRule) { applies = false; sawRule = false } applies = applies || value === '*' || /leadflow/i.test(value) }
    else { sawRule = true; if (applies && /^disallow$/i.test(field) && value) disallowed.push(value) }
  }
  return disallowed
}
const allowedByRobots = (url: string, disallowed: string[]) => { const path = new URL(url).pathname; return !disallowed.some(rule => path.startsWith(rule.replace(/\*.*$/, ''))) }

/** The domain's mail servers through DNS-over-HTTPS. A lookup that fails is reported as such, never as "no mail server". */
export async function checkMailDomain(runtime: Runtime, domain: string, cache: Map<string, MailDomainCheck>): Promise<MailDomainCheck> {
  const cached = cache.get(domain)
  if (cached) return cached
  const resolver = runtime.env('ANALYSIS_DNS_RESOLVER') || 'https://cloudflare-dns.com/dns-query'
  const query = async (type: string) => {
    const response = await runtime.fetch(`${resolver}?name=${encodeURIComponent(domain)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(String(response.status))
    return await response.json() as { Status?: number; Answer?: { type: number; data: string }[] }
  }
  let result: MailDomainCheck
  try {
    const mx = await query('MX')
    if (mx.Status === 3) result = { domain, outcome: 'no_domain', mx: [] }
    else {
      const hosts = (mx.Answer ?? []).filter(answer => answer.type === 15 && typeof answer.data === 'string').map(answer => answer.data.trim().split(/\s+/))
      // RFC 7505: a single MX of "0 ." means the domain accepts no mail.
      if (hosts.length === 1 && hosts[0][1] === '.') result = { domain, outcome: 'null_mx', mx: [] }
      else if (hosts.length) result = { domain, outcome: 'mx', mx: hosts.map(host => (host[1] ?? '').replace(/\.$/, '')).filter(Boolean).slice(0, 5) }
      else {
        // No MX: mail falls back to the domain's own address (RFC 5321 §5.1).
        const a = await query('A')
        result = { domain, outcome: (a.Answer ?? []).some(answer => answer.type === 1) ? 'a_only' : 'no_mail_host', mx: [] }
      }
    }
  } catch { result = { domain, outcome: 'dns_unavailable', mx: [] } }
  cache.set(domain, result)
  return result
}

/**
 * Prepares candidates for saving. Exact repeats (a footer link on every page) are dropped; everything else is merged by the
 * database one candidate at a time, so each detail keeps its own source page and method. A personal-looking address (jane@)
 * found on one page is attributed to the person named on another (Jane Doe, on the team page).
 */
function prepare(found: ContactCandidate[]): ContactCandidate[] {
  const people = found.filter(item => item.kind === 'person' && item.fullName)
  const seen = new Set<string>(), result: ContactCandidate[] = []
  for (const item of found) {
    const person = item.kind === 'business' && item.email && item.label === 'Email' ? people.find(candidate => emailMatchesName(item.email, candidate.fullName)) : undefined
    const candidate = person ? { ...item, kind: 'person' as const, label: '', fullName: person.fullName, jobTitle: person.jobTitle, role: person.role, how: 'name_match' as const } : item
    const key = [candidate.kind, candidate.email, candidate.phoneE164 || candidate.phone, candidate.whatsapp, nameKey(candidate.fullName), candidate.linkedinUrl, candidate.how].join('|')
    if (!seen.has(key)) { seen.add(key); result.push(candidate) }
  }
  // People first, so a person's email attaches to them rather than to a business inbox.
  return result.sort((a, b) => Number(b.kind === 'person') - Number(a.kind === 'person'))
}

async function runStep(runtime: Runtime, job: Job): Promise<StepResult> {
  const result = (patch: Record<string, unknown>, extra: Partial<StepResult> = {}): StepResult => ({ patch, contacts: [], channels: [], verifications: [], usage: [], ...extra })
  const website = job.lead?.website ?? '', country = job.lead?.country ?? '', now = new Date().toISOString()
  if (job.step === 'website') {
    const contacts: ContactCandidate[] = [], channels: ChannelCandidate[] = []
    // From the business report: page facts already collected, each cited by its evidence ID.
    for (const page of job.pages) {
      const found = extractFromPage(page.value, null, { website, country, source: 'website', evidenceId: page.evidenceId, analysisId: job.analysis?.id ?? null, observedAt: page.observedAt })
      contacts.push(...found.contacts); channels.push(...found.channels)
    }
    // The lead's own details (from the form, an import or Apollo) are a source too.
    const lead = job.lead
    if (lead && (lead.email || lead.phone)) {
      const email = normalizeEmail(lead.email), phone = lead.phone ? normalizePhone(lead.phone, country) : null
      const person = looksLikeName(lead.name) && nameKey(lead.name) !== nameKey(lead.company)
      contacts.push({ kind: person ? 'person' : 'business', label: person ? '' : 'Lead contact', fullName: person ? lead.name : '', jobTitle: '', role: person ? 'other' : 'general',
        email: email.valid ? email.email : '', phone: phone && phone.status !== 'invalid_format' ? phone.national || phone.original : '', phoneE164: phone?.e164 ?? '', phoneStatus: phone?.status ?? 'unverified',
        whatsapp: '', linkedinUrl: '', profileUrl: '', source: 'lead_record', how: 'lead_record', providerRef: '', sourceUrl: '', evidenceId: null, analysisId: null, observedAt: now })
    }
    let site: Record<string, unknown> = { status: 'skipped', detail: 'The lead has no website.' }, pagesRead = 0
    if (website) {
      let origin = ''
      try { origin = checkUrl(website).origin } catch (error) { site = { status: 'invalid_url', detail: error instanceof UnsafeUrlError ? error.message : 'The website address isn’t valid.' } }
      if (origin) {
        const dnsCache = new Map<string, true>(), maxPages = limit(runtime, 'CONTACT_MAX_PAGES', 5, 10), deadline = Date.now() + 40000
        let disallowed: string[] = []
        try {
          const robots = await safeFetch(runtime, `${origin}/robots.txt`, { maxBytes: 100_000, timeoutMs: 8000, accept: 'text/plain', dnsCache })
          if (robots.status === 200 && !/<html/i.test(robots.body.slice(0, 500))) disallowed = robotsDisallows(robots.body)
        } catch { /* No robots.txt answer: nothing is disallowed by it. */ }
        const queue = new Set<string>(), skipped: string[] = []
        // Pages from the report that are worth reading as HTML (names and job titles need the page structure).
        for (const page of job.pages) { if (page.sourceUrl && contactPage.test(new URL(page.sourceUrl).pathname)) queue.add(page.sourceUrl); for (const link of page.value.internalLinks ?? []) if (contactPage.test(`${link.url} ${link.text}`)) queue.add(link.url) }
        const read = async (url: string) => {
          if (!allowedByRobots(url, disallowed)) { skipped.push(url); return null }
          const fetched = await safeFetch(runtime, url, { timeoutMs: 10000, dnsCache })
          pagesRead++
          if (fetched.status >= 400 || !fetched.body || !/html/i.test(fetched.headers['content-type'] ?? 'text/html')) return null
          const found = extractFromHtml(fetched.body, fetched.finalUrl, { website, country, source: 'website', evidenceId: null, analysisId: null, observedAt: new Date().toISOString() })
          contacts.push(...found.contacts); channels.push(...found.channels)
          return fetched
        }
        try {
          if (!job.pages.length) {
            // No business report yet: start from the homepage.
            const home = await read(`${origin}/`)
            if (home) { const page = parseHtml(home.body, home.finalUrl, home.status); for (const link of page.internalLinks) if (contactPage.test(`${link.url} ${link.text}`)) queue.add(link.url); site = { status: 'ok', detail: `HTTP ${home.status}` } }
            else site = { status: 'blocked', detail: 'The homepage couldn’t be read (robots.txt, an error or not HTML).' }
          } else site = { status: 'ok', detail: `Used ${job.pages.length} page${job.pages.length === 1 ? '' : 's'} from the business report.` }
          const ordered = [...queue].filter(url => { try { return new URL(url).origin === origin } catch { return false } }).sort((a, b) => contactPriority(a) - contactPriority(b))
          for (const url of ordered) {
            if (pagesRead >= maxPages || Date.now() > deadline) break
            try { await read(url) } catch { /* One page failing doesn't stop the others. */ }
          }
          if (site.status === 'ok') site = { ...site, detail: `${site.detail} Read ${pagesRead} page${pagesRead === 1 ? '' : 's'} directly${skipped.length ? `; ${skipped.length} skipped because robots.txt disallows them` : ''}.` }
        } catch (error) {
          const failure = error instanceof UnsafeUrlError ? error : null
          site = { status: failure?.kind === 'timeout' ? 'timeout' : failure?.kind === 'blocked_address' ? 'blocked_address' : 'unreachable', detail: failure?.message ?? 'The website couldn’t be read.' }
        }
      }
    }
    const merged = prepare(contacts)
    const seenChannel = new Set<string>(), uniqueChannels = channels.filter(item => { const key = `${item.channel}|${item.value.toLowerCase()}`; if (seenChannel.has(key)) return false; seenChannel.add(key); return true })
    return result({ step: 'verify', status: 'running', providers: { site, report: job.analysis ? { status: 'ok', detail: `Business report of ${String(job.analysis.completedAt ?? '').slice(0, 10)}` } : { status: 'not_found', detail: 'No business report for this lead yet; only pages read directly were used.' } },
      progress: { pagesRead } }, { contacts: merged.slice(0, 60), channels: uniqueChannels.slice(0, 40), usage: pagesRead ? [{ provider: 'website', operation: 'read_page', quantity: pagesRead, unit: 'pages', status: 'ok' }] : [] })
  }

  if (job.step === 'verify') {
    const mode = job.options.mode ?? 'full', targets = new Set(job.options.contactIds ?? [])
    const stale = (contact: JobContact) => !contact.emailCheckedAt || Date.now() - Date.parse(contact.emailCheckedAt) > 30 * 86_400_000
    const chosen = job.contacts.filter(contact => mode === 'verify' ? targets.has(contact.id) : (contact.email && (stale(contact) || contact.emailStatus === 'unknown')) || (contact.phone && !contact.phoneE164))
    const cache = new Map<string, MailDomainCheck>(), verifications: Record<string, unknown>[] = []
    let lookups = 0, dnsFailed = false
    for (const contact of chosen.slice(0, 40)) {
      const update: Record<string, unknown> = { contactId: contact.id }
      if (contact.email) {
        const domain = contact.email.split('@')[1] ?? ''
        const before = cache.size, check = normalizeEmail(contact.email).valid ? await checkMailDomain(runtime, domain, cache) : null
        if (cache.size > before) lookups++
        if (check?.outcome === 'dns_unavailable') dnsFailed = true
        const published = contact.sources.some(source => source.source === 'website' && ['mailto', 'text', 'name_match'].includes(source.how)) && sameOrganizationDomain(domain, website)
        const provider = contact.sources.some(source => source.source === 'apollo') && ['verified', 'likely_valid', 'risky', 'invalid'].includes(contact.emailStatus) ? contact.emailStatus : null
        const status = emailStatusFrom(contact.email, check, published, provider)
        Object.assign(update, { emailStatus: status.status, emailCheck: { method: check ? 'dns_mx' : 'syntax', outcome: check?.outcome ?? 'syntax', mx: check?.mx ?? [], detail: status.detail, checkedAt: new Date().toISOString() } })
      }
      if (contact.phone && contact.phoneStatus !== 'provider_verified') {
        const phone = normalizePhone(contact.phoneE164 || contact.phone, country)
        Object.assign(update, { phoneStatus: phone.status, phoneE164: phone.e164 })
      }
      if (Object.keys(update).length > 1) verifications.push(update)
    }
    const site = job.providers.site?.status
    const dns = { status: dnsFailed ? 'failed' : 'ok', detail: dnsFailed ? 'Some mail-server lookups failed; those emails stay “unknown”. Refresh later.' : `${lookups} domain${lookups === 1 ? '' : 's'} checked for mail servers.` }
    const degraded = dnsFailed || (mode === 'full' && !!website && !['ok', 'skipped'].includes(site))
    // A website that couldn't be read is only a failure when nothing at all is known about the lead's contacts.
    const status = mode === 'full' && !['ok', 'skipped'].includes(site) && !job.contacts.length ? 'failed' : degraded ? 'partial' : 'completed'
    return result({ step: null, status, providers: { dns }, progress: { emailsChecked: verifications.filter(item => item.emailStatus).length }, ...(status === 'failed' ? { failure: job.providers.site?.detail ?? 'No contact details could be found.' } : {}) },
      { verifications, usage: lookups ? [{ provider: 'dns', operation: 'mx_lookup', quantity: lookups, unit: 'lookups', status: dnsFailed ? 'partial' : 'ok' }] : [] })
  }
  return result({ step: null, status: 'failed', failure: `Unknown step ${job.step}.` })
}

/** Claims one due contact job (or the given one), runs its next step and saves the result. Returns null when nothing was due. */
export async function advanceContactJob(runtime: Runtime, target: string | null) {
  const job = await rpc<Job | null>(runtime, 'claim_contact_discovery', { target, lease_seconds: 120 })
  if (!job) return null
  let step: StepResult
  try { step = await runStep(runtime, job) } catch (error) {
    const giveUp = job.attempts >= 6
    console.error(`contacts ${job.id} step ${job.step} error${error instanceof Error ? `: ${error.name}` : ''}`)
    step = { patch: giveUp ? { step: null, status: 'failed', failure: 'Contact discovery stopped after repeated errors. Start it again.' } : { delaySeconds: Math.min(120, 15 * job.attempts) }, contacts: [], channels: [], verifications: [], usage: [] }
  }
  const outcome = await rpc<{ outcome: string }>(runtime, 'save_contact_discovery_step', { job_id: job.id, lease: job.leaseId, patch: step.patch, contacts: step.contacts, channels: step.channels,
    verifications: step.verifications, usage: step.usage })
  console.log(`contacts ${job.id} ${job.step} -> ${step.patch.step === undefined ? job.step : step.patch.step ?? 'done'} (${outcome?.outcome ?? 'saved'})`)
  return { id: job.id, step: job.step, outcome: outcome?.outcome ?? 'saved' }
}
