import { useState, type ReactNode } from 'react'
import { Glyph, type GlyphName } from './Glyph'
import { evidenceLabels, faqs, type StatusKind } from './content'
import { primaryLabel, signupOpen } from './access'

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
      {(short ? faqs.slice(0, 5) : faqs).map(([q, a]) => (
        <details key={q}>
          <summary>{q}<span className="mk-faq-icon" aria-hidden="true"><Glyph name="plus" size={16} /></span></summary>
          <p>{a}</p>
        </details>
      ))}
    </div>
  )
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

export function ProductPreview() {
  const [view, setView] = useState<'pipeline' | 'followups'>('pipeline')
  const nav: [GlyphName, string][] = [['grid', 'Overview'], ['users', 'Leads'], ['compass', 'Discovery'], ['calendar', 'Follow-ups'], ['clipboard', 'Onboarding'], ['clock', 'Activity'], ['sparkles', 'Integrations']]
  return (
    <figure className="mk-window mk-product" id="product-preview" aria-label="Illustration of the LeadFlow workspace with fictional records">
      <Chrome path="LeadFlow / Studio workspace / Overview" />
      <div className="mk-app">
        <div className="mk-app-side" aria-hidden="true">
          <span className="mk-app-brand"><span className="mk-logo mk-logo-sm"><Glyph name="arrowUpRight" size={14} /></span>LeadFlow</span>
          {nav.map(([icon, label], i) => <span key={label} className={`mk-app-item${i === 0 ? ' is-active' : ''}`}><Glyph name={icon} size={16} /><span>{label}</span></span>)}
          <span className="mk-app-ws"><b>S</b><span>Studio<small>Owner</small></span></span>
        </div>
        <div className="mk-app-main">
          <div className="mk-app-top">
            <div><small>Overview</small><strong>This week’s pipeline</strong></div>
            <span className="mk-fake-button"><Glyph name="plus" size={14} />New lead</span>
          </div>
          <div className="mk-stats">
            {[['Total leads', '24', '+6 this week'], ['Reports ready', '9', '3 new'], ['Qualified', '5', '+2'], ['Follow-ups due', '3', 'Today']].map(([label, value, delta]) => (
              <div className="mk-stat" key={label}><span>{label}</span><strong>{value}</strong><small>{delta}</small></div>
            ))}
          </div>
          <div className="mk-switch" role="group" aria-label="Product preview view">
            <button type="button" aria-pressed={view === 'pipeline'} onClick={() => setView('pipeline')}>Pipeline preview</button>
            <button type="button" aria-pressed={view === 'followups'} onClick={() => setView('followups')}>Follow-ups preview</button>
          </div>
          {view === 'pipeline' ? (
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
          ) : (
            <ul className="mk-tasks">
              {followUps.map(([task, who, due]) => (
                <li key={task}><span className="mk-checkbox" /><span><strong>{task}</strong><small>{who}</small></span><b className={due === 'Today' ? 'is-today' : ''}>{due}</b></li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </figure>
  )
}
