import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Glyph, type GlyphName } from './Glyph'
import { evidenceLabels, faqs, type StatusKind } from './content'
import { primaryLabel, signupOpen } from './access'
import { reducedMotion } from './motion'

export function Brand() {
  return (
    <a className="mk-brand" href="/" aria-label="LeadFlow home">
      <span className="mk-logo"><Glyph name="arrowUpRight" size={18} /></span>LeadFlow
    </a>
  )
}

export function CTA({ children = primaryLabel, href = '/signup', secondary = false, small = false }: { children?: ReactNode; href?: string; secondary?: boolean; small?: boolean }) {
  const className = ['mk-button', secondary && 'mk-button-secondary', small && 'mk-button-small'].filter(Boolean).join(' ')
  return <a className={className} href={href}>{children}<Glyph name="arrowRight" size={16} /></a>
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="mk-link" href={href}>{children}<Glyph name="arrowRight" size={16} /></a>
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="mk-eyebrow">{children}</p>
}

/** Page-level introduction. Renders the page's only h1. */
export function Intro({ eyebrow, title, text, children }: { eyebrow: string; title: ReactNode; text: string; children?: ReactNode }) {
  return (
    <div className="mk-intro">
      <div className="mk-wrap">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1>{title}</h1>
        <p className="mk-intro-lede">{text}</p>
        {children}
      </div>
    </div>
  )
}

export function SectionHead({ eyebrow, title, text, center = false, children }: { eyebrow: string; title: ReactNode; text?: ReactNode; center?: boolean; children?: ReactNode }) {
  return (
    <div className={`mk-head${center ? ' is-center' : ''}`} data-reveal>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2>{title}</h2>
      {text && <p className="mk-head-text">{text}</p>}
      {children}
    </div>
  )
}

export function Status({ kind, children }: { kind: StatusKind; children: ReactNode }) {
  return <span className={`mk-status is-${kind}`}>{children}</span>
}

export function Note({ title, children, icon = 'info' }: { title: string; children: ReactNode; icon?: GlyphName }) {
  return (
    <div className="mk-note">
      <Glyph name={icon} size={20} />
      <div><strong>{title}</strong><p>{children}</p></div>
    </div>
  )
}

export function FinalCTA() {
  return (
    <section className="mk-final mk-dark" aria-labelledby="final-cta-title">
      <div className="mk-wrap" data-reveal>
        <Eyebrow>Get started</Eyebrow>
        <h2 id="final-cta-title">Walk into your next call <em>already knowing.</em></h2>
        <p>See whether LeadFlow fits the way your business finds and wins clients.</p>
        <div className="mk-actions">
          <CTA />
          <CTA href="/login" secondary>Sign in</CTA>
        </div>
        <p className="mk-fine">{signupOpen ? 'No checkout required.' : 'Access by invitation. No checkout required.'}</p>
      </div>
    </section>
  )
}

export function FAQs({ short = false }: { short?: boolean }) {
  return (
    <div className="mk-faq">
      {(short ? faqs.slice(0, 6) : faqs).map(([q, a]) => (
        <details key={q}>
          <summary>{q}<span className="mk-faq-icon" aria-hidden="true"><Glyph name="plus" size={16} /></span></summary>
          <p>{a}</p>
        </details>
      ))}
    </div>
  )
}

/** A number that counts up once when it scrolls into view. Screen readers and reduced-motion visitors get the final value. */
export function CountUp({ value, suffix = '', duration = 1100 }: { value: number; suffix?: string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(() => (reducedMotion() || typeof IntersectionObserver === 'undefined' ? value : 0))
  useEffect(() => {
    const node = ref.current
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return
    let frame = 0
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      observer.disconnect()
      let start = 0
      const tick = (now: number) => {
        if (!start) start = now
        const p = Math.min(1, (now - start) / duration)
        setShown(Math.round(value * (1 - Math.pow(1 - p, 3))))
        if (p < 1) frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    }, { threshold: 0.4 })
    observer.observe(node)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [value, duration])
  return <span ref={ref} className="mk-count"><span className="mk-sr">{value}{suffix}</span><span aria-hidden="true">{shown}{suffix}</span></span>
}

export function EvidenceLabels() {
  return (
    <div className="mk-evidence">
      {evidenceLabels.map(item => (
        <article key={item.kind}>
          <span className={`mk-type mk-type-${item.kind}`}>{item.label}</span>
          <h3>{item.title}</h3>
          <p>{item.text}</p>
        </article>
      ))}
    </div>
  )
}

export function Chrome({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <div className="mk-chrome">
      <span className="mk-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="mk-crumbs">{path}</span>
      {children}
      <span className="mk-tag">Illustration</span>
    </div>
  )
}

/** A business report illustration with a fictional business. Mirrors the real report's labels; no data is loaded. */
export function ReportPreview() {
  const findings: [string, string, string][] = [
    ['High', 'Mobile pages take 5.2 s to show their main content', 'Measured'],
    ['Medium', 'The homepage has no meta description', 'Observed'],
    ['Medium', 'No online booking option found on the 6 pages analyzed', 'Observed'],
    ['Low', 'Patients may prefer to book outside office hours', 'Hypothesis'],
  ]
  return (
    <figure className="mk-window mk-report" aria-label="Example business report for a fictional dental practice">
      <Chrome path="Business report · Harbor Dental" />
      <div className="mk-report-body">
        <div className="mk-report-head">
          <div><strong>harbor-dental.example</strong><small>6 pages analyzed · Fictional example</small></div>
          <span className="mk-done"><Glyph name="check" size={13} />Completed</span>
        </div>
        <div className="mk-scores">
          <div><span>Mobile speed</span><strong className="is-poor">42</strong></div>
          <div><span>Desktop speed</span><strong className="is-ok">81</strong></div>
          <div><span>Findings</span><strong>14</strong></div>
        </div>
        <p className="mk-summary"><span className="mk-type mk-type-ai">AI interpretation</span>“A family dental practice in Austin offering checkups, whitening and implants.”</p>
        <ul className="mk-findings">
          {findings.map(([severity, title, type]) => (
            <li key={title}>
              <span className={`mk-sev is-${severity.toLowerCase()}`}>{severity}</span>
              <span>{title}</span>
              <span className={`mk-type mk-type-${type.toLowerCase()}`}>{type}</span>
            </li>
          ))}
        </ul>
        <div className="mk-opportunity">
          <div>
            <small>Opportunity · High priority</small>
            <strong>Speed up the website</strong>
            <span>Matches your service <b>Website care</b> · based on 3 findings</span>
          </div>
          <span className="mk-fake-button">Accept</span>
        </div>
      </div>
      <figcaption>Every finding in a real report links to its evidence.</figcaption>
    </figure>
  )
}

const pipelineRows = [
  ['OB', 'Olivia Bennett', 'Northline Studio', 'Website design', 'Report · 4 opportunities', 'Qualified'],
  ['JL', 'James Lee', 'Fieldwork Co.', 'Consulting', 'Analyzing…', 'New'],
  ['AM', 'Ava Mitchell', 'Sunday Goods', 'Brand identity', 'Report · 2 opportunities', 'Contacted'],
  ['PS', 'Priya Shah', 'Lumen Physio', 'SEO', 'Report · 3 opportunities', 'New'],
] as const

const followUps = [
  ['Check in on the website brief', 'Olivia Bennett · Northline Studio', 'Today'],
  ['Arrange a discovery conversation', 'James Lee · Fieldwork Co.', 'Today'],
  ['Share the speed findings', 'Ava Mitchell · Sunday Goods', 'Tomorrow'],
] as const

const projectRows = [
  ['HD', 'Website rebuild', 'Harbor Dental', 64, 'on_track', 'On track', 'Launch · 12 Dec'],
  ['SG', 'Paid ads kickoff', 'Sunday Goods', 30, 'at_risk', 'At risk', 'Campaign live · 3 Dec'],
  ['LP', 'Local SEO programme', 'Lumen Physio', 85, 'on_track', 'On track', 'Monthly report · 1 Dec'],
] as const

type PreviewView = 'pipeline' | 'projects' | 'followups'
const previewViews: { id: PreviewView; label: string; nav: string; title: string; eyebrow: string; action: string }[] = [
  { id: 'pipeline', label: 'Pipeline', nav: 'Overview', eyebrow: 'Overview', title: 'This week’s pipeline', action: 'New lead' },
  { id: 'projects', label: 'Projects', nav: 'Projects', eyebrow: 'Delivery', title: 'Projects in progress', action: 'New project' },
  { id: 'followups', label: 'Follow-ups', nav: 'Follow-ups', eyebrow: 'Follow-ups', title: 'Due today and next', action: 'New task' },
]
const previewStats = [['Total leads', 24, '+6 this week'], ['Open deals', 7, '2 closing soon'], ['Active projects', 3, '1 at risk'], ['Follow-ups due', 3, 'Today']] as const
const previewNav: [GlyphName, string][] = [['grid', 'Overview'], ['users', 'Leads'], ['compass', 'Discovery'], ['kanban', 'Sales'], ['clipboard', 'Clients'], ['briefcase', 'Projects'], ['calendar', 'Follow-ups'], ['sparkles', 'Integrations']]

/** The workspace illustration. The view switch is real; the records are fictional and nothing is loaded. */
export function ProductPreview() {
  const [view, setView] = useState<PreviewView>('pipeline')
  const current = previewViews.find(item => item.id === view) ?? previewViews[0]
  return (
    <figure className="mk-window mk-product" id="product-preview" aria-label="Illustration of the LeadFlow workspace with fictional records">
      <Chrome path={`LeadFlow / Studio workspace / ${current.nav}`} />
      <div className="mk-app">
        <div className="mk-app-side" aria-hidden="true">
          <span className="mk-app-brand"><span className="mk-logo mk-logo-sm"><Glyph name="arrowUpRight" size={14} /></span>LeadFlow</span>
          {previewNav.map(([icon, label]) => <span key={label} className={`mk-app-item${label === current.nav ? ' is-active' : ''}`}><Glyph name={icon} size={16} /><span>{label}</span></span>)}
          <span className="mk-app-ws"><b>S</b><span>Studio<small>Owner</small></span></span>
        </div>
        <div className="mk-app-main">
          <div className="mk-app-top">
            <div><small>{current.eyebrow}</small><strong>{current.title}</strong></div>
            <span className="mk-fake-button"><Glyph name="plus" size={14} />{current.action}</span>
          </div>
          <div className="mk-stats">
            {previewStats.map(([label, value, delta]) => (
              <div className="mk-stat" key={label}><span>{label}</span><strong><CountUp value={value} /></strong><small>{delta}</small></div>
            ))}
          </div>
          <div className="mk-switch" role="group" aria-label="Product preview view">
            {previewViews.map(item => (
              <button key={item.id} type="button" aria-pressed={view === item.id} onClick={() => setView(item.id)}>{item.label}<span className="mk-sr"> preview</span></button>
            ))}
          </div>
          <div className="mk-view" key={view}>
            {view === 'pipeline' && (
              <div className="mk-table">
                <div className="mk-tr mk-th"><span>Lead / company</span><span>Interest</span><span>Business report</span><span>Status</span></div>
                {pipelineRows.map(([initials, name, company, service, report, status]) => (
                  <div className="mk-tr" key={name}>
                    <div className="mk-person"><b className="mk-avatar">{initials}</b><span><strong>{name}</strong><small>{company}</small></span></div>
                    <span>{service}</span>
                    <span className={`mk-report-cell${report.startsWith('Analyzing') ? ' is-running' : ''}`}>{report.startsWith('Analyzing') ? <i className="mk-spin" /> : <Glyph name="sparkles" size={14} />}{report}</span>
                    <span><i className={`mk-pill is-${status.toLowerCase()}`}>{status}</i></span>
                  </div>
                ))}
              </div>
            )}
            {view === 'projects' && (
              <div className="mk-table">
                <div className="mk-tr mk-th"><span>Project / client</span><span>Next milestone</span><span>Progress</span><span>Health</span></div>
                {projectRows.map(([initials, name, client, progress, health, label, next]) => (
                  <div className="mk-tr" key={name}>
                    <div className="mk-person"><b className="mk-avatar">{initials}</b><span><strong>{name}</strong><small>{client}</small></span></div>
                    <span>{next}</span>
                    <span className="mk-progress-cell"><span className="mk-bar"><span style={{ width: `${progress}%` }} /></span><b>{progress}%</b></span>
                    <span><i className={`mk-health is-${health}`}>{label}</i></span>
                  </div>
                ))}
              </div>
            )}
            {view === 'followups' && (
              <ul className="mk-tasks">
                {followUps.map(([task, who, due]) => (
                  <li key={task}><span className="mk-checkbox" /><span><strong>{task}</strong><small>{who}</small></span><b className={due === 'Today' ? 'is-today' : ''}>{due}</b></li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </figure>
  )
}
