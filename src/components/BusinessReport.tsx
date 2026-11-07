import { useEffect, useMemo, useRef, useState } from 'react'
import { advanceAnalysis, analysesFor, analysisConfig, analysisReport, AnalysisRequestError, cancelAnalysis, categoryLabels, findingTypeHelp, findingTypeLabels, isActive, opportunityLabels,
  opportunityStatusLabels, progressOf, setFindingVerification, setOpportunityStatus, startAnalysis, statusLabels,
  type AnalysisConfig, type AnalysisSummary, type Category, type Evidence, type Finding, type Opportunity, type OpportunityStatus, type Report } from '../lib/analysis'
import { normalizeWebsite, type Lead } from '../lib/model'
import { dateLabel } from '../lib/format'
import type { WorkspaceSummary } from '../lib/backend'
import './BusinessReport.css'

type Tab = 'overview' | 'findings' | 'opportunities' | 'evidence' | 'details'
const stages: { label: string; statuses: string[] }[] = [
  { label: 'Check the website', statuses: ['queued', 'validating'] }, { label: 'Read pages', statuses: ['crawling'] }, { label: 'Measure', statuses: ['measuring'] },
  { label: 'Interpret', statuses: ['analyzing'] }, { label: 'Match services', statuses: ['matching'] },
]
const providerNames: Record<string, string> = { site: 'Website check', apify: 'Apify crawler', crawl: 'Direct page reader', pagespeed: 'PageSpeed Insights', ai: 'AI interpretation' }
const providerStatus: Record<string, string> = { ok: 'Done', running: 'Running', retrying: 'Retrying', failed: 'Failed', partial: 'Partly done', not_configured: 'Not set up', limit_reached: 'Monthly limit reached',
  timeout: 'Timed out', empty: 'Nothing returned', skipped: 'Skipped', not_found: 'Not found', blocked: 'Blocked', requires_auth: 'Login required', temporarily_unavailable: 'Unavailable', unreachable: 'Unreachable', dns_unavailable: 'DNS unavailable' }
const severityLabel = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' }
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'Something went wrong. Try again.'
const ms = (value: number | null | undefined) => value === null || value === undefined ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`
const score = (value: number | null | undefined) => value === null || value === undefined ? null : Math.round(value * 100)

/** One-line description of an evidence item, from the facts it holds. */
function evidenceSummary(item: Evidence): string {
  const v = item.value
  switch (item.kind) {
    case 'page': return `${v.title || 'Untitled page'} · ${v.kind} page${v.hasHtml === false ? ' (text only, from the crawler)' : ''}${typeof v.wordCount === 'number' ? ` · ${v.wordCount} words` : ''}`
    case 'technology': return `${v.name} (${v.category}) · matched “${String(v.signature).slice(0, 80)}”`
    case 'http_check': return v.status ? `HTTP ${v.status}${v.redirects?.length ? ` after ${v.redirects.length} redirect(s)` : ''}${v.finalUrl && v.finalUrl !== v.requestedUrl ? ` → ${v.finalUrl}` : ''}` : `${v.outcome}: ${v.detail ?? ''}`
    case 'robots_txt': return v.found ? `robots.txt found${v.disallowAll ? ', blocks all crawlers' : ''}${v.sitemaps?.length ? `, lists ${v.sitemaps.length} sitemap(s)` : ''}` : `No robots.txt (HTTP ${v.status ?? '—'})`
    case 'sitemap': return v.found ? `Sitemap found with ${v.urlCount} URLs` : `No sitemap at ${(v.checked ?? []).join(', ')}`
    case 'link_check': return `${v.checked} internal links checked, ${(v.broken ?? []).length} broken`
    case 'social_profiles': return (v.profiles ?? []).length ? `Linked profiles: ${(v.profiles as { network: string }[]).map(p => p.network).join(', ')}` : 'No social profile links found'
    case 'pagespeed': return `${v.strategy === 'mobile' ? 'Mobile' : 'Desktop'} · performance ${score(v.performanceScore) ?? '—'}/100 · LCP ${ms(v.lcpMs)} · CLS ${v.cls ?? '—'}`
    default: return item.kind
  }
}
function EvidenceValue({ item }: { item: Evidence }) {
  const v = item.value
  if (item.kind === 'page') return <dl className="br-kv">
    {[['Title', v.title], ['Meta description', v.description || 'None'], ['Main headings', (v.h1 ?? []).join(' · ') || 'None'], ['Canonical', v.canonical || 'None'], ['Viewport', v.viewport || 'None'],
      ['Images', `${v.images} (${v.imagesMissingAlt} without alt text)`], ['Forms', `${v.forms}${v.formFields?.length ? ` (fields: ${v.formFields.join(', ')})` : ''}`],
      ['Phone links', (v.tel ?? []).join(', ') || 'None'], ['Email links', (v.mailto ?? []).join(', ') || 'None'], ['Calls to action', (v.ctas ?? []).slice(0, 8).join(' · ') || 'None'],
      ['Structured data', (v.jsonLdTypes ?? []).join(', ') || 'None']].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value ?? '—')}</dd></div>)}
    {v.text && <div><dt>Text excerpt</dt><dd className="br-quote">{String(v.text).slice(0, 600)}{String(v.text).length > 600 ? '…' : ''}</dd></div>}
  </dl>
  if (item.kind === 'link_check' && v.broken?.length) return <ul className="br-plain">{(v.broken as { url: string; status: number }[]).map(link => <li key={link.url}>{link.url} → {link.status || 'no answer'}</li>)}</ul>
  if (item.kind === 'pagespeed') return <dl className="br-kv">
    {[['Performance score', `${score(v.performanceScore) ?? '—'}/100`], ['SEO score', `${score(v.seoScore) ?? '—'}/100`], ['Largest Contentful Paint (lab)', ms(v.lcpMs)], ['First Contentful Paint (lab)', ms(v.fcpMs)],
      ['Total Blocking Time (lab)', ms(v.tbtMs)], ['Cumulative Layout Shift (lab)', v.cls ?? '—'], ['Real-visit LCP', ms(v.field?.lcpMs)], ['Real-visit INP', ms(v.field?.inpMs)], ['Measured', v.fetchTime ? new Date(v.fetchTime).toLocaleString() : '—']]
      .map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}
  </dl>
  if (item.kind === 'robots_txt' && v.excerpt) return <pre className="br-pre">{v.excerpt}</pre>
  return <pre className="br-pre">{JSON.stringify(v, null, 2).slice(0, 3000)}</pre>
}

function Progress({ report }: { report: AnalysisSummary }) {
  const current = stages.findIndex(stage => stage.statuses.includes(report.status))
  return <div className="br-progress" role="status" aria-live="polite">
    <div className="br-progress-head"><strong>{statusLabels[report.status]}…</strong><span>{report.pagesAnalyzed ? `${report.pagesAnalyzed} page${report.pagesAnalyzed === 1 ? '' : 's'} read so far` : 'Starting'}</span></div>
    <div className="br-bar" aria-hidden><i style={{ width: `${Math.round(progressOf(report) * 100)}%` }} /></div>
    <ol className="br-stages">{stages.map((stage, index) => <li key={stage.label} className={index < current ? 'done' : index === current ? 'current' : ''}>{stage.label}</li>)}</ol>
    {Object.entries(report.providers).filter(([, state]) => ['running', 'retrying'].includes(state.status)).map(([name, state]) => <p key={name} className="br-muted">{providerNames[name] ?? name}: {state.detail}</p>)}
    <p className="br-muted">Usually one to three minutes. You can close this window; the analysis keeps running and the report will be here when you come back.</p>
  </div>
}

function FindingCard({ finding, evidence, canReview, onVerify, onShowEvidence }: { finding: Finding; evidence: Map<string, Evidence>; canReview: boolean; onVerify: (status: Finding['verificationStatus']) => void; onShowEvidence: (id: string) => void }) {
  const cited = finding.evidenceIds.map(id => evidence.get(id)).filter((item): item is Evidence => !!item)
  return <article className={`br-finding sev-${finding.severity}`}>
    <header><span className={`br-sev ${finding.severity}`}>{severityLabel[finding.severity]}</span><h4>{finding.title}</h4></header>
    <div className="br-tags"><span className={`br-type ${finding.findingType}`} title={findingTypeHelp[finding.findingType]}>{findingTypeLabels[finding.findingType]}</span>
      <span className="br-tag">Confidence: {finding.confidence}</span>{finding.opportunityType && <span className="br-tag">{opportunityLabels[finding.opportunityType]}</span>}
      {finding.verificationStatus !== 'unverified' && <span className={`br-tag verify-${finding.verificationStatus}`}>{finding.verificationStatus === 'verified' ? 'Verified by your team' : 'Disputed by your team'}</span>}</div>
    {finding.description && <p>{finding.description}</p>}
    {finding.businessRelevance && <p className="br-muted"><strong>Why it matters:</strong> {finding.businessRelevance}</p>}
    {finding.recommendedAction && <p className="br-muted"><strong>Suggested next step:</strong> {finding.recommendedAction}</p>}
    <details className="br-cites"><summary>Evidence ({cited.length})</summary><ul>{cited.map(item => <li key={item.id}><button className="br-link" onClick={() => onShowEvidence(item.id)}>{item.ref}</button> {evidenceSummary(item)}{item.sourceUrl && <> · <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{item.sourceUrl.replace(/^https?:\/\//, '').slice(0, 60)}</a></>}</li>)}</ul></details>
    {canReview && <label className="br-verify">Your check<select value={finding.verificationStatus} onChange={event => onVerify(event.target.value as Finding['verificationStatus'])}>
      <option value="unverified">Not checked</option><option value="verified">Confirmed</option><option value="disputed">Not accurate</option></select></label>}
  </article>
}

function OpportunityCard({ opportunity, findings, onStatus, onNotes, busy }: { opportunity: Opportunity; findings: Map<string, Finding>; onStatus: (status: OpportunityStatus) => void; onNotes: (notes: string) => void; busy: boolean }) {
  const [notes, setNotes] = useState(opportunity.notes)
  const basis = opportunity.findingIds.map(id => findings.get(id)).filter((item): item is Finding => !!item)
  return <article className={`br-opportunity status-${opportunity.status}`}>
    <header><div><span className={`br-sev ${opportunity.priority}`}>{severityLabel[opportunity.priority]} priority</span><h4>{opportunity.title}</h4>
      <p className="br-service">{opportunity.serviceId ? <>Matches your service <strong>{opportunity.serviceName}</strong></> : <span className="br-muted">{opportunity.serviceName || 'No matching service in your catalog'}</span>} · {opportunityLabels[opportunity.opportunityType]}</p></div>
      <span className={`br-status ${opportunity.status}`}>{opportunityStatusLabels[opportunity.status]}</span></header>
    <p>{opportunity.why}</p>
    <p className="br-muted"><strong>Possible benefit:</strong> {opportunity.benefit}</p>
    <p className="br-muted"><strong>Next action:</strong> {opportunity.nextAction}</p>
    <p className="br-muted">Confidence: {opportunity.confidence} · Based on {basis.length} finding{basis.length === 1 ? '' : 's'}: {basis.slice(0, 4).map(item => item.title).join('; ')}{basis.length > 4 ? '…' : ''}</p>
    <div className="br-actions">
      {(['accepted', 'needs_verification', 'dismissed'] as const).map(status => <button key={status} className={opportunity.status === status ? 'primary' : 'secondary'} disabled={busy}
        aria-pressed={opportunity.status === status} onClick={() => onStatus(opportunity.status === status ? 'suggested' : status)}>{status === 'accepted' ? 'Accept' : status === 'dismissed' ? 'Dismiss' : 'Needs verification'}</button>)}
    </div>
    <label className="br-notes">Notes<textarea rows={2} maxLength={2000} value={notes} placeholder="What you’ll mention, what to check first…" onChange={event => setNotes(event.target.value)}
      onBlur={() => { if (notes !== opportunity.notes) onNotes(notes) }} /></label>
  </article>
}

/** The business intelligence report for one lead: start, progress, findings with evidence, opportunities, history. */
export function BusinessReport({ workspace, lead, onEditLead }: { workspace: WorkspaceSummary; lead: Lead; onEditLead: () => void }) {
  const [history, setHistory] = useState<AnalysisSummary[] | null>(null)
  const [report, setReport] = useState<Report | null>(null)
  const [previous, setPrevious] = useState<Report | null>(null)
  const [config, setConfig] = useState<AnalysisConfig | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false), [confirmRecent, setConfirmRecent] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [categoryFilter, setCategoryFilter] = useState<Category | ''>(''), [typeFilter, setTypeFilter] = useState('')
  const [openEvidence, setOpenEvidence] = useState('')
  const requestId = useRef(crypto.randomUUID())
  const website = normalizeWebsite(lead.website ?? '')

  async function loadHistory(select?: string) {
    const items = await analysesFor(workspace.id, lead.id)
    setHistory(items)
    const target = select ?? items[0]?.id
    if (target) setReport(await analysisReport(workspace.id, target))
    return items
  }
  useEffect(() => {
    let active = true
    analysesFor(workspace.id, lead.id).then(async items => {
      if (!active) return
      setHistory(items)
      if (items[0]) { const first = await analysisReport(workspace.id, items[0].id); if (active) setReport(first) }
    }).catch(cause => { if (active) { setHistory([]); setError(errorText(cause)) } })
    analysisConfig(workspace.id).then(value => { if (active) setConfig(value) }).catch(() => { /* Availability is informational. */ })
    return () => { active = false }
  }, [workspace.id, lead.id])

  // While an analysis runs, keep asking the server to run its next step. Closing the window stops this; the worker continues.
  const running = report && isActive(report) ? report.id : null
  useEffect(() => {
    if (!running) return
    let active = true, failures = 0
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const next = await advanceAnalysis(workspace.id, running)
        if (!active) return
        failures = 0; setReport(next)
        setHistory(items => items?.map(item => item.id === next.id ? { ...item, status: next.status, step: next.step } : item) ?? items)
        if (!isActive(next)) { setNotice(next.status === 'completed' ? 'Analysis complete.' : next.status === 'partial' ? 'Analysis finished with some parts missing. See Details.' : ''); void loadHistory(next.id).catch(() => null); return }
      } catch (cause) { failures++; if (active && failures >= 3) setError(errorText(cause)) }
      if (active) timer = setTimeout(tick, failures ? 8000 : 2500)
    }
    timer = setTimeout(tick, 1200)
    return () => { active = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, workspace.id])

  // The previous finished report, to show what was resolved or is new since then.
  const previousId = report && !isActive(report) ? report.previousId : null
  useEffect(() => {
    let active = true
    setPrevious(null)
    if (previousId) analysisReport(workspace.id, previousId).then(value => { if (active) setPrevious(value) }).catch(() => null)
    return () => { active = false }
  }, [workspace.id, previousId])

  async function start(force = false) {
    setBusy(true); setError(''); setNotice(''); setConfirmRecent('')
    try {
      const started = await startAnalysis(workspace.id, { leadId: lead.id, requestId: requestId.current, force })
      requestId.current = crypto.randomUUID()
      await loadHistory(started.id); setTab('overview')
      if (started.existing) setNotice('An analysis for this lead was already running; showing it.')
    } catch (cause) {
      if (cause instanceof AnalysisRequestError && cause.code === 'recent') { requestId.current = crypto.randomUUID(); setConfirmRecent(cause.message) }
      else { if (!(cause instanceof AnalysisRequestError) || cause.status !== 0) requestId.current = crypto.randomUUID(); setError(errorText(cause)) }
    } finally { setBusy(false) }
  }
  async function cancel() {
    if (!report) return
    setBusy(true); setError('')
    try { await cancelAnalysis(workspace.id, report.id); await loadHistory(report.id); setNotice('Analysis stopped.') } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  async function updateOpportunity(opportunity: Opportunity, status: OpportunityStatus | null, notes: string | null) {
    if (!report) return
    setBusy(true); setError('')
    try {
      await setOpportunityStatus(workspace.id, opportunity.id, status, notes)
      setReport({ ...report, opportunities: report.opportunities.map(item => item.id === opportunity.id ? { ...item, status: status ?? item.status, notes: notes ?? item.notes } : item) })
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  async function verify(finding: Finding, status: Finding['verificationStatus']) {
    if (!report) return
    setError('')
    try { await setFindingVerification(workspace.id, finding.id, status); setReport({ ...report, findings: report.findings.map(item => item.id === finding.id ? { ...item, verificationStatus: status } : item) }) }
    catch (cause) { setError(errorText(cause)) }
  }
  function showEvidence(id: string) { setTab('evidence'); setOpenEvidence(id); setTimeout(() => document.getElementById(`ev-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60) }

  const evidence = useMemo(() => new Map((report?.evidence ?? []).map(item => [item.id, item])), [report])
  const findings = useMemo(() => new Map((report?.findings ?? []).map(item => [item.id, item])), [report])
  const comparison = useMemo(() => {
    if (!report || !previous) return null
    const now = new Set(report.findings.filter(item => item.source !== 'ai').map(item => item.key)), before = new Set(previous.findings.filter(item => item.source !== 'ai').map(item => item.key))
    return { resolved: previous.findings.filter(item => item.source !== 'ai' && !now.has(item.key)), added: report.findings.filter(item => item.source !== 'ai' && !before.has(item.key)), at: previous.createdAt }
  }, [report, previous])
  const pagespeed = (strategy: string) => report?.evidence.find(item => item.kind === 'pagespeed' && item.value.strategy === strategy)?.value
  const technologies = report?.evidence.filter(item => item.kind === 'technology') ?? []
  const counts = { high: 0, medium: 0, low: 0, info: 0 }
  for (const finding of report?.findings ?? []) counts[finding.severity]++
  const visibleFindings = (report?.findings ?? []).filter(item => (!categoryFilter || item.category === categoryFilter) && (!typeFilter || item.findingType === typeFilter))
  const usedCategories = [...new Set((report?.findings ?? []).map(item => item.category))]

  if (history === null) return <div className="br-loading" role="status"><i className="skeleton skeleton-title" /><i className="skeleton skeleton-panel" /></div>

  const providerChips = config && <ul className="br-providers" aria-label="Available analysis tools">
    <li className="ok">Website reader{config.providers.crawler.provider === 'apify' ? ` · Apify, up to ${config.providers.crawler.maxPages} pages` : ` · up to ${config.providers.crawler.maxPages} pages`}</li>
    <li className={config.providers.pagespeed.configured ? 'ok' : 'off'}>PageSpeed Insights{config.providers.pagespeed.configured ? '' : ' · not set up'}</li>
    <li className={config.providers.ai.configured ? 'ok' : 'off'}>AI interpretation{config.providers.ai.configured ? ' · Gemini' : ' · not set up'}</li>
    <li className="ok">Technology detection</li>
  </ul>

  if (!website) return <div className="br-empty"><h3>Add a website to analyze this business</h3><p>Business analysis reads the lead’s public website. {lead.company || lead.name} doesn’t have one yet.</p>
    <button className="primary" onClick={onEditLead}>Edit lead</button></div>

  if (!report) return <div className="br-empty">
    <p className="eyebrow">BUSINESS INTELLIGENCE</p>
    <h3>Analyze {lead.company || lead.name}’s website</h3>
    <p>LeadFlow reads the public pages of <a href={website} target="_blank" rel="noopener noreferrer nofollow">{website.replace(/^https?:\/\//, '')}</a>, measures speed with PageSpeed Insights, detects the technology it uses, and matches what it finds to your agency services. Every finding links to the evidence behind it.</p>
    {providerChips}
    {error && <p className="br-error" role="alert">{error}</p>}
    <button className="primary" disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Analyze business'}</button>
    <p className="br-muted">Only public pages are read. Logins, CAPTCHAs and bot protection are never bypassed.</p>
  </div>

  const done = !isActive(report)
  return <div className="br">
    <div className="br-top">
      <div><a href={report.website} target="_blank" rel="noopener noreferrer nofollow" className="br-site">{report.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>
        <p className="br-muted">{done ? `Analyzed ${dateLabel(report.completedAt ?? report.createdAt)}` : `Started ${new Date(report.createdAt).toLocaleTimeString()}`} · {report.pagesAnalyzed} page{report.pagesAnalyzed === 1 ? '' : 's'} analyzed</p></div>
      <div className="br-top-actions">
        <span className={`br-state ${report.status}`}>{statusLabels[report.status]}</span>
        {history.length > 1 && <select aria-label="Report history" value={report.id} onChange={event => { setError(''); void analysisReport(workspace.id, event.target.value).then(setReport).catch(cause => setError(errorText(cause))) }}>
          {history.map((item, index) => <option key={item.id} value={item.id}>{index === 0 ? 'Latest · ' : ''}{dateLabel(item.createdAt)} · {statusLabels[item.status]}</option>)}</select>}
        {done ? <button className="secondary" disabled={busy || history.some(isActive)} onClick={() => void start()}>Analyze again</button> : <button className="secondary" disabled={busy} onClick={() => void cancel()}>Stop</button>}
      </div>
    </div>
    {notice && <p className="br-notice" role="status">{notice}</p>}
    {error && <p className="br-error" role="alert">{error}</p>}
    {confirmRecent && <div className="br-confirm" role="alert"><p>{confirmRecent}</p><div className="br-actions"><button className="secondary" onClick={() => setConfirmRecent('')}>Keep the current report</button><button className="primary" disabled={busy} onClick={() => void start(true)}>Analyze again anyway</button></div></div>}
    {!done && <Progress report={report} />}
    {report.status === 'failed' && <div className="br-failed"><h3>The analysis couldn’t finish</h3><p>{report.failure ?? 'Something went wrong while analyzing this website.'}</p><button className="secondary" disabled={busy} onClick={() => void start(true)}>Try again</button></div>}
    {report.status === 'cancelled' && <div className="br-failed"><h3>This analysis was stopped</h3><button className="secondary" disabled={busy} onClick={() => void start(true)}>Start a new analysis</button></div>}

    {(done && report.status !== 'cancelled' && (report.findings.length > 0 || report.evidence.length > 0)) && <>
      <div className="br-tabs" role="tablist">{([['overview', 'Overview'], ['findings', `Findings (${report.findings.length})`], ['opportunities', `Opportunities (${report.opportunities.length})`], ['evidence', `Evidence (${report.evidence.length})`], ['details', 'Details']] as [Tab, string][])
        .map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>

      {tab === 'overview' && <section className="br-overview">
        {report.status === 'partial' && <p className="br-notice">Some parts couldn’t be completed: {Object.entries(report.providers).filter(([, state]) => !['ok', 'not_configured', 'running'].includes(state.status)).map(([name, state]) => `${providerNames[name] ?? name} (${providerStatus[state.status] ?? state.status})`).join(', ') || 'fewer pages than expected were read'}. See Details.</p>}
        <div className="br-metrics">
          <div><span>Mobile performance</span><strong className={`score-${(score(pagespeed('mobile')?.performanceScore) ?? -1) >= 90 ? 'good' : (score(pagespeed('mobile')?.performanceScore) ?? -1) >= 50 ? 'ok' : 'poor'}`}>{score(pagespeed('mobile')?.performanceScore) ?? '—'}</strong><small>{pagespeed('mobile') ? `LCP ${ms(pagespeed('mobile')?.lcpMs)}` : 'Not measured'}</small></div>
          <div><span>Desktop performance</span><strong className={`score-${(score(pagespeed('desktop')?.performanceScore) ?? -1) >= 90 ? 'good' : (score(pagespeed('desktop')?.performanceScore) ?? -1) >= 50 ? 'ok' : 'poor'}`}>{score(pagespeed('desktop')?.performanceScore) ?? '—'}</strong><small>{pagespeed('desktop') ? `LCP ${ms(pagespeed('desktop')?.lcpMs)}` : 'Not measured'}</small></div>
          <div><span>Findings</span><strong>{report.findings.length}</strong><small>{counts.high} high · {counts.medium} medium · {counts.low} low</small></div>
          <div><span>Opportunities</span><strong>{report.opportunities.length}</strong><small>{report.opportunities.filter(item => item.status === 'accepted').length} accepted</small></div>
        </div>
        <div className="br-columns">
          <div className="br-card">
            <h3>The business</h3>
            {report.overview.ai?.summary ? <p>{report.overview.ai.summary.text} <span className="br-type ai_interpretation" title={findingTypeHelp.ai_interpretation}>AI</span></p> : <p className="br-muted">{config?.providers.ai.configured === false ? 'Add a Gemini API key to get a written summary.' : 'No summary was produced.'}</p>}
            <dl className="br-kv">
              <div><dt>Name</dt><dd>{report.overview.facts?.name.value || '—'}</dd></div>
              {report.overview.facts?.category.value && <div><dt>Category</dt><dd>{report.overview.facts.category.value}</dd></div>}
              {!!report.overview.facts?.contact.phones.length && <div><dt>Phone on website</dt><dd>{report.overview.facts.contact.phones.join(', ')}</dd></div>}
              {!!report.overview.facts?.contact.emails.length && <div><dt>Email on website</dt><dd>{report.overview.facts.contact.emails.join(', ')}</dd></div>}
              {!!report.overview.ai?.mainServices.length && <div><dt>Main services <span className="br-type ai_interpretation">AI</span></dt><dd>{report.overview.ai.mainServices.map(item => item.text).join(' · ')}</dd></div>}
              {!!report.overview.ai?.audienceIndicators.length && <div><dt>Audience <span className="br-type ai_interpretation">AI</span></dt><dd>{report.overview.ai.audienceIndicators.map(item => item.text).join(' · ')}</dd></div>}
              {report.overview.ai?.positioning && <div><dt>Positioning <span className="br-type ai_interpretation">AI</span></dt><dd>{report.overview.ai.positioning.text}</dd></div>}
            </dl>
            {!!technologies.length && <><h4>Technology detected</h4><ul className="br-chips">{technologies.map(item => <li key={item.id} title={`Matched “${item.value.signature}”`}>{item.value.name}</li>)}</ul></>}
          </div>
          <div className="br-card">
            <h3>Top opportunities</h3>
            {report.opportunities.length ? <ol className="br-top-list">{report.opportunities.slice(0, 4).map(item => <li key={item.id}><button className="br-link" onClick={() => setTab('opportunities')}>{item.title}</button><span className="br-muted"> · {item.serviceId ? item.serviceName : opportunityLabels[item.opportunityType]} · {item.priority} priority</span></li>)}</ol>
              : <p className="br-muted">No opportunities were found.</p>}
            <h3>Most important findings</h3>
            <ol className="br-top-list">{report.findings.filter(item => item.severity === 'high' || item.severity === 'medium').slice(0, 5).map(item => <li key={item.id}><span className={`br-dot ${item.severity}`} aria-hidden />{item.title}</li>)}</ol>
            {comparison && <><h3>Since the previous report</h3><p className="br-muted">Compared with {dateLabel(comparison.at)}: {comparison.resolved.length} resolved, {comparison.added.length} new.</p>
              {!!comparison.resolved.length && <ul className="br-plain">{comparison.resolved.slice(0, 5).map(item => <li key={item.id}>✓ {item.title}</li>)}</ul>}
              {!!comparison.added.length && <ul className="br-plain">{comparison.added.slice(0, 5).map(item => <li key={item.id}>＋ {item.title}</li>)}</ul>}</>}
          </div>
        </div>
      </section>}

      {tab === 'findings' && <section>
        <div className="br-filters">
          <select aria-label="Filter by category" value={categoryFilter} onChange={event => setCategoryFilter(event.target.value as Category | '')}><option value="">All categories</option>{usedCategories.map(item => <option key={item} value={item}>{categoryLabels[item]}</option>)}</select>
          <select aria-label="Filter by type" value={typeFilter} onChange={event => setTypeFilter(event.target.value)}><option value="">All types</option>{Object.entries(findingTypeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
          <span className="br-muted">Observed and measured findings come from the website and tools. AI interpretations and hypotheses are suggestions to check.</span>
        </div>
        {usedCategories.filter(category => !categoryFilter || category === categoryFilter).map(category => {
          const items = visibleFindings.filter(item => item.category === category)
          return items.length ? <div key={category} className="br-group"><h3>{categoryLabels[category]} <span className="number-tag">{items.length}</span></h3>
            {items.map(item => <FindingCard key={item.id} finding={item} evidence={evidence} canReview onVerify={status => void verify(item, status)} onShowEvidence={showEvidence} />)}</div> : null
        })}
        {!visibleFindings.length && <p className="br-muted">No findings match these filters.</p>}
      </section>}

      {tab === 'opportunities' && <section>
        <p className="br-muted">Suggestions based on the findings and your agency services. They describe what could help, not promised results.</p>
        {report.opportunities.map(item => <OpportunityCard key={item.id} opportunity={item} findings={findings} busy={busy} onStatus={status => void updateOpportunity(item, status, null)} onNotes={notes => void updateOpportunity(item, null, notes)} />)}
        {!report.opportunities.length && <p className="br-muted">No opportunities were found.</p>}
      </section>}

      {tab === 'evidence' && <section className="br-evidence">
        <p className="br-muted">Everything collected during this analysis. Findings cite these items by reference.</p>
        {report.evidence.map(item => <details key={item.id} id={`ev-${item.id}`} open={openEvidence === item.id} onToggle={event => { if ((event.target as HTMLDetailsElement).open) setOpenEvidence(item.id) }}>
          <summary><span className="br-ref">{item.ref}</span><span>{evidenceSummary(item)}</span><span className="br-muted">{item.provider}</span></summary>
          <div className="br-evidence-body">{item.sourceUrl && <p><a href={item.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{item.sourceUrl}</a></p>}<p className="br-muted">Collected {new Date(item.observedAt).toLocaleString()}</p><EvidenceValue item={item} /></div>
        </details>)}
      </section>}

      {tab === 'details' && <section className="br-details">
        <h3>How this report was made</h3>
        <table className="br-table"><thead><tr><th>Step</th><th>Result</th><th>Details</th></tr></thead><tbody>
          {Object.entries(report.providers).map(([name, state]) => <tr key={name}><td>{providerNames[name] ?? name}</td><td><span className={`br-pstate ${state.status}`}>{providerStatus[state.status] ?? state.status}</span></td><td>{state.detail ?? ''}</td></tr>)}
        </tbody></table>
        <h3>Usage</h3>
        {report.usage.length ? <table className="br-table"><thead><tr><th>Provider</th><th>Quantity</th><th>Reported cost</th></tr></thead><tbody>
          {report.usage.map((item, index) => <tr key={index}><td>{item.provider}</td><td>{Number(item.quantity).toLocaleString()} {item.unit.replace(/_/g, ' ')}</td><td>{item.costUsd === null ? 'Not reported' : `$${Number(item.costUsd).toFixed(4)}`}</td></tr>)}
        </tbody></table> : <p className="br-muted">No paid provider was used.</p>}
        <p className="br-muted">Absence findings (“not found”) only cover the pages analyzed, so they are never marked high confidence. Performance figures are PageSpeed Insights lab measurements unless marked as real-visit data.</p>
      </section>}
    </>}
    {done && report.status !== 'cancelled' && report.status !== 'failed' && !report.findings.length && !report.evidence.length && <p className="br-muted">This analysis didn’t collect anything.</p>}
  </div>
}
