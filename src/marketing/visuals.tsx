import { useEffect, useState, type CSSProperties } from 'react'
import { Glyph } from './Glyph'
import { Chrome } from './shared'

// All illustrations use fictional businesses. Step names mirror the real business report pipeline.

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const START_DELAY = 600
const END = 6900
const analysisSteps = [
  { label: 'Checking the website', detail: 'Homepage reachable', at: 0, done: 800 },
  { label: 'Reading pages', detail: '8 public pages read', at: 800, done: 1900 },
  { label: 'Measuring', detail: 'PageSpeed, mobile and desktop', at: 1900, done: 2900 },
  { label: 'Interpreting', detail: 'Evidence summarized by Gemini', at: 2900, done: 5300 },
  { label: 'Matching services', detail: 'Compared with your 6 services', at: 5300, done: 6200 },
]
const summary = 'An independent physiotherapy clinic in Manchester offering sports injury rehab, massage and clinical pilates.'
const heroFindings = [
  { at: 3300, sev: 'high', title: 'No online booking found on the 8 pages analyzed', type: 'observed', label: 'Observed' },
  { at: 3800, sev: 'high', title: 'Mobile pages take 4.8 s to show their main content', type: 'measured', label: 'Measured' },
  { at: 4300, sev: 'medium', title: 'The contact form asks for 11 required fields', type: 'observed', label: 'Observed' },
  { at: 4800, sev: 'low', title: 'Evening appointments could suit office workers', type: 'hypothesis', label: 'Hypothesis' },
]
const heroOpportunities = [
  { at: 6200, priority: 'High priority', title: 'Add online booking', service: 'Booking & scheduling', basis: '2 findings', ask: 'Ask how new patients book today.' },
  { at: 6600, priority: 'Medium priority', title: 'Speed up mobile pages', service: 'Website care', basis: '1 finding', ask: 'Ask whether most visitors arrive on mobile.' },
]

/** Elapsed illustration time in ms. Runs once; reduced-motion users see the finished state. */
function useTimeline() {
  const [run, setRun] = useState(0)
  const [elapsed, setElapsed] = useState(() => (reducedMotion() ? END : 0))
  useEffect(() => {
    if (reducedMotion()) return
    let frame = 0
    let start = 0
    const tick = (now: number) => {
      if (!start) start = now
      const next = Math.max(0, Math.min(END, now - start - START_DELAY))
      setElapsed(next)
      if (next < END) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [run])
  return [elapsed, () => { setElapsed(0); setRun(value => value + 1) }] as const
}

export function HeroAnalysis() {
  const [t, replay] = useTimeline()
  const progress = Math.round(Math.min(1, t / analysisSteps[analysisSteps.length - 1].done) * 100)
  const current = analysisSteps.find(step => t >= step.at && t < step.done)
  const measured = t >= 2900
  const typed = summary.slice(0, Math.max(0, Math.floor((t - 3000) / 20)))
  const finished = t >= END
  return (
    <figure className="mk-glow-frame" aria-label="Illustration: LeadFlow analyzing the website of a fictional physiotherapy clinic">
      <div className="mk-window mk-hero-window">
        <Chrome path="Leads / Brightline Physio / Business report">
          {finished && !reducedMotion() && <button type="button" className="mk-replay" onClick={replay}><Glyph name="replay" size={14} />Replay</button>}
        </Chrome>
        <div className="mk-analysis">
          <div className="mk-an-side">
            <div className="mk-lead">
              <b className="mk-avatar mk-avatar-lg">BP</b>
              <div><strong>Brightline Physio</strong><small>Physiotherapy · Manchester, UK</small></div>
            </div>
            <div className="mk-lead-meta">
              <span className="mk-mono">brightline-physio.example</span>
              <span className="mk-chips"><i>Discovery</i><i className="mk-pill is-new">New</i></span>
            </div>
            <div className="mk-progress">
              <div className="mk-progress-top"><span>{finished || progress === 100 ? 'Analysis complete' : current?.label ?? 'Starting…'}</span><b>{progress}%</b></div>
              <div className="mk-bar"><span style={{ width: `${progress}%` }} /></div>
            </div>
            <ol className="mk-an-steps" role="list">
              {analysisSteps.map(step => {
                const state = t >= step.done ? 'done' : t >= step.at ? 'active' : 'pending'
                return (
                  <li key={step.label} className={`is-${state}`}>
                    <span className="mk-step-icon">{state === 'done' ? <Glyph name="check" size={12} /> : state === 'active' ? <i className="mk-spin" /> : null}</span>
                    <span><strong>{step.label}</strong><small>{step.detail}</small></span>
                  </li>
                )
              })}
            </ol>
          </div>
          <div className="mk-an-main">
            <div className="mk-scores">
              <div><span>Mobile speed</span>{measured ? <strong className="is-poor mk-pop">38</strong> : <i className="mk-skeleton" />}</div>
              <div><span>Desktop speed</span>{measured ? <strong className="is-ok mk-pop">79</strong> : <i className="mk-skeleton" />}</div>
              <div><span>Findings</span>{t >= 4800 ? <strong className="mk-pop">12</strong> : <i className="mk-skeleton" />}</div>
            </div>
            <div className={`mk-summary-box${t >= 2900 ? ' is-on' : ''}`}>
              <span className="mk-type mk-type-ai"><Glyph name="sparkles" size={12} />AI interpretation</span>
              <p>{typed}{t >= 3000 && typed.length < summary.length && <i className="mk-caret" />}{t < 3000 && <i className="mk-skeleton mk-skeleton-line" />}</p>
            </div>
            <ul className="mk-findings">
              {heroFindings.map(f => (
                <li key={f.title} className={t >= f.at ? 'is-in' : ''}>
                  <span className={`mk-sev is-${f.sev}`}>{f.sev}</span>
                  <span>{f.title}</span>
                  <span className={`mk-type mk-type-${f.type}`}>{f.label}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="mk-an-opps">
            <div className="mk-an-opps-head"><Glyph name="target" size={15} />Opportunities<small>Matched to your services</small></div>
            {heroOpportunities.map(o => (
              <div key={o.title} className={`mk-opp-card${t >= o.at ? ' is-in' : ''}`}>
                <small className={o.priority.startsWith('High') ? 'is-high' : ''}>{o.priority}</small>
                <strong>{o.title}</strong>
                <span>Matches <b>{o.service}</b> · {o.basis}</span>
                <p>{o.ask}</p>
                <div className="mk-opp-actions"><span className="mk-fake-button">Accept</span><span className="mk-fake-button is-ghost">Needs verification</span></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </figure>
  )
}

export function FindVisual() {
  const rows = [
    ['Lone Star Smiles', 'Dentist · Austin, TX', 'lonestarsmiles.example', 'new'],
    ['Harbor Dental', 'Dentist · Austin, TX', 'harbor-dental.example', 'dup'],
    ['Cedar Park Family Dental', 'Dentist · Cedar Park, TX', 'cedarparkdental.example', 'new'],
    ['Bright Bay Orthodontics', 'Orthodontist · Round Rock, TX', 'brightbay.example', 'new'],
  ] as const
  return (
    <div className="mk-mock" role="img" aria-label="Illustration: a directory search for dentists in three Texas locations, with one result already in your leads">
      <div className="mk-search">
        <Glyph name="search" size={16} />
        <span className="mk-chip">Dentists</span><span className="mk-chip">Austin, TX</span><span className="mk-chip">Round Rock, TX</span><span className="mk-chip is-soft">Has website</span>
      </div>
      <ul className="mk-results">
        {rows.map(([name, meta, site, state]) => (
          <li key={name}>
            <span className={`mk-checkbox${state === 'new' ? ' is-checked' : ''}`}>{state === 'new' && <Glyph name="check" size={11} />}</span>
            <span className="mk-result-name"><strong>{name}</strong><small>{meta} · {site}</small></span>
            {state === 'dup' ? <span className="mk-badge is-amber">Already a lead</span> : <span className="mk-badge is-green">New</span>}
          </li>
        ))}
      </ul>
      <div className="mk-mock-foot"><span>4 found · OpenStreetMap · data from 2026</span><span className="mk-fake-button">Import 3</span></div>
      <div className="mk-mock-aside"><span><Glyph name="users" size={14} />Apollo</span><span><Glyph name="upload" size={14} />CSV import</span><span><Glyph name="plus" size={14} />Manual entry</span></div>
    </div>
  )
}

export function AnalyzeVisual() {
  const checks = [
    ['file', 'SEO basics', 'No meta description on the homepage', 'observed', 'Observed'],
    ['calendar', 'Contact & booking', 'No online booking found', 'observed', 'Observed'],
    ['gauge', 'Speed', 'Mobile 42 · Desktop 81', 'measured', 'Measured'],
    ['layers', 'Technology', 'WordPress · Google Analytics', 'observed', 'Observed'],
    ['sparkles', 'Business summary', 'Family dental practice: checkups, whitening, implants', 'ai', 'AI interpretation'],
  ] as const
  return (
    <div className="mk-mock" role="img" aria-label="Illustration: the checks in a business report, each labelled observed, measured or AI interpretation">
      <div className="mk-mock-head"><span><strong>Business report</strong><small>harbor-dental.example · 6 pages</small></span><span className="mk-done"><Glyph name="check" size={13} />Completed</span></div>
      <ul className="mk-checks-list">
        {checks.map(([icon, label, value, kind, kindLabel]) => (
          <li key={label}>
            <span className="mk-check-icon"><Glyph name={icon} size={16} /></span>
            <span><strong>{label}</strong><small>{value}</small></span>
            <span className={`mk-type mk-type-${kind}`}>{kindLabel}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function PitchVisual() {
  return (
    <div className="mk-mock mk-pitch" role="img" aria-label="Illustration: an opportunity matched to your booking service, with its reasons, a possible benefit and a first question">
      <div className="mk-pitch-top"><small>Opportunity</small><span className="mk-badge is-red">High priority</span></div>
      <strong className="mk-pitch-title">Add online booking</strong>
      <span className="mk-pitch-match"><Glyph name="target" size={14} />Matches your service <b>Booking &amp; scheduling</b></span>
      <div className="mk-pitch-block">
        <small>Why</small>
        <p><span className="mk-type mk-type-observed">Observed</span>No online booking option found on the 6 pages analyzed</p>
        <p><span className="mk-type mk-type-hypothesis">Hypothesis</span>Patients may prefer to book outside office hours</p>
      </div>
      <div className="mk-pitch-block"><small>Possible benefit</small><p>Could make it easier for new patients to book after hours.</p></div>
      <div className="mk-pitch-block is-ask"><small>Ask first</small><p>“How do new patients book an appointment today?”</p></div>
      <div className="mk-opp-actions"><span className="mk-fake-button">Accept</span><span className="mk-fake-button is-ghost">Needs verification</span><span className="mk-fake-button is-text">Dismiss</span></div>
    </div>
  )
}

export function OutreachVisual() {
  return (
    <div className="mk-mock mk-outreach" role="img" aria-label="Illustration: a contact found on the business’s website with a likely valid email, and an email draft whose observation is linked to a finding in the report">
      <div className="mk-mock-head"><div><strong>Contacts &amp; outreach</strong><small>Harbor Dental · Austin, TX</small></div><span className="mk-badge is-green">2 contacts</span></div>
      <div className="mk-contact-row">
        <span className="mk-avatar">AS</span>
        <span><strong>Dr. Avery Stone</strong><small>Owner · named on the About page</small></span>
        <span className="mk-badge is-green">High confidence</span>
      </div>
      <div className="mk-contact-row">
        <span className="mk-avatar"><Glyph name="mail" size={14} /></span>
        <span><strong>hello@harbor-dental.example</strong><small>Email link on the Contact page</small></span>
        <span className="mk-badge is-amber">Likely valid</span>
      </div>
      <div className="mk-draft">
        <div className="mk-draft-top"><span className="mk-chip"><Glyph name="mail" size={13} />Email</span><span className="mk-chip is-soft">Consultative</span><span className="mk-chip is-soft">Version 2 · edited</span></div>
        <p className="mk-draft-subject">A question about booking at Harbor Dental</p>
        <p>Hi Avery, I couldn’t find an online booking option on the pages I looked at. How do new patients book today?</p>
        <p className="mk-draft-basis"><span className="mk-type mk-type-observed">Observed</span>Based on: no online booking option found</p>
      </div>
      <div className="mk-mock-foot"><span><Glyph name="lock" size={13} />You review and send it. Nothing is sent from LeadFlow.</span><span className="mk-fake-button is-ghost">Copy</span></div>
    </div>
  )
}

export function FollowVisual() {
  const stages = [['New', 6, 'new'], ['Contacted', 4, 'contacted'], ['Qualified', 3, 'qualified'], ['Converted', 2, 'converted']] as const
  const tasks = [
    ['Share the speed findings with Harbor Dental', 'Today'],
    ['Ask Lone Star Smiles how patients book', 'Tomorrow'],
    ['Send the online booking proposal', 'Friday'],
  ]
  return (
    <div className="mk-mock" role="img" aria-label="Illustration: a pipeline by status with follow-up tasks due today, tomorrow and Friday">
      <div className="mk-pipeline">
        {stages.map(([label, count, kind]) => <span key={label} className={`is-${kind}`} style={{ flexGrow: count }}><b>{count}</b>{label}</span>)}
      </div>
      <ul className="mk-tasks">
        {tasks.map(([task, due]) => (
          <li key={task}><span className="mk-checkbox" /><span><strong>{task}</strong></span><b className={due === 'Today' ? 'is-today' : ''}>{due}</b></li>
        ))}
      </ul>
      <div className="mk-mock-foot"><span><Glyph name="trophy" size={14} />Interested? Track it as a deal</span><span className="mk-fake-button is-ghost">New deal</span></div>
    </div>
  )
}

export function PipelineVisual() {
  const columns = [
    ['Interested', [['Fieldwork Co.', 'Consulting sprint', '$2,500']]],
    ['Proposal sent', [['Lumen Physio', 'Local SEO', '£1,200 / mo'], ['Sunday Goods', 'Paid ads setup', '$3,000']]],
    ['Won', [['Harbor Dental', 'Online booking build', '$4,800']]],
  ] as const
  return (
    <div className="mk-mock mk-win" role="img" aria-label="Illustration: a sales pipeline board with deals in Interested, Proposal sent and Won, a lost reason and win-rate analytics">
      <div className="mk-mock-head"><span><strong>Sales pipeline</strong><small>Board · 3 open deals · USD and GBP kept apart</small></span><span className="mk-badge is-green">Win rate 60%</span></div>
      <div className="mk-mini-board">
        {columns.map(([name, deals]) => (
          <div key={name} className={`mk-mini-col${name === 'Won' ? ' is-won' : ''}`}>
            <span className="mk-mini-col-head">{name}<b>{deals.length}</b></span>
            {deals.map(([company, title, value]) => (
              <span key={company} className="mk-deal"><strong>{company}</strong><small>{title}</small><b>{value}</b></span>
            ))}
          </div>
        ))}
      </div>
      <div className="mk-mock-foot"><span><Glyph name="info" size={14} />Lost: Northline Studio · reason “Budget moved to next year”</span><span className="mk-fake-button">Convert to client</span></div>
    </div>
  )
}

export function OnboardVisual() {
  const items = [['Brand assets uploaded', 'Client · 3 files', 'ok'], ['Booking hours form', 'Client · submitted, accepted', 'ok'], ['Scope confirmed', 'Agency · a record, not a contract', 'ok'], ['Website hosting access', 'Client · changes requested', 'info'], ['Welcome message marked sent', 'Agency · you send it yourself', 'clock']] as const
  const stages = ['Welcome', 'Business info', 'Requirements', 'Access', 'Scope', 'Final review']
  return (
    <div className="mk-mock" role="img" aria-label="Illustration: a client onboarding checklist for a fictional dental practice, with stages, client and agency items and readiness">
      <div className="mk-mock-head"><span><strong>Harbor Dental · Website kickoff</strong><small>Client link active · expires in 14 days</small></span><span className="mk-badge is-amber">Agency steps left</span></div>
      <div className="mk-stage-dots" aria-hidden="true">{stages.map((stage, i) => <span key={stage} className={i < 4 ? 'is-done' : i === 4 ? 'is-current' : ''}><i />{stage}</span>)}</div>
      <ul className="mk-checks-list">
        {items.map(([label, state, tone]) => (
          <li key={label}>
            <span className={`mk-check-icon${tone === 'ok' ? ' is-ok' : ''}`}><Glyph name={tone === 'clock' ? 'clock' : tone === 'info' ? 'info' : 'check'} size={16} /></span>
            <span><strong>{label}</strong><small>{state}</small></span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ProjectVisual() {
  const milestones = [['Discovery', 0, 18, 1], ['Design', 14, 40, 1], ['Build', 36, 78, .45], ['Launch', 80, 92, 0]] as const
  return (
    <div className="mk-mock mk-project" role="img" aria-label="Illustration: a project for a fictional dental practice with 60 percent progress from deliverables, health at risk because a high-priority task is overdue, and a timeline of four milestones">
      <div className="mk-mock-head"><span><strong>Harbor Dental · Website rebuild</strong><small>From completed onboarding · Target 12 Dec</small></span><span className="mk-health is-at_risk">At risk</span></div>
      <div className="mk-project-progress"><span>Progress <b>60%</b></span><small>3 of 5 deliverables completed</small></div>
      <div className="mk-bar mk-bar-lg"><span style={{ width: '60%' }} /></div>
      <p className="mk-reason"><Glyph name="info" size={14} />A high-priority task is overdue: <b>Booking page build</b></p>
      <div className="mk-gantt">
        {milestones.map(([name, from, to, done]) => (
          <div key={name} className="mk-gantt-row">
            <span>{name}</span>
            <span className="mk-gantt-track"><i style={{ left: `${from}%`, width: `${to - from}%` }}><em style={{ width: `${done * 100}%` }} /></i></span>
          </div>
        ))}
        <span className="mk-gantt-today" style={{ '--today': .58 } as CSSProperties}>Today</span>
      </div>
      <div className="mk-mock-foot"><span><Glyph name="sparkles" size={14} />AI suggestion: split “Booking page build” into 3 tasks</span><span className="mk-fake-button is-ghost">Review</span></div>
    </div>
  )
}

/** What an owner sees before a call: the report boiled down to three facts and an opening question. */
export function CallPrepVisual() {
  const facts = [['Mobile speed', '42 / 100', 'is-poor'], ['Online booking', 'Not found', ''], ['Best match', 'Booking & scheduling', 'is-match']] as const
  return (
    <div className="mk-mock mk-prep" role="img" aria-label="Illustration: call notes for a fictional dental practice, with three findings and a suggested opening question">
      <div className="mk-prep-head">
        <b className="mk-avatar">HD</b>
        <span><strong>Harbor Dental</strong><small>Discovery call · today, 2:30 pm</small></span>
        <i className="mk-pill is-qualified">Qualified</i>
      </div>
      <ul className="mk-prep-facts">{facts.map(([label, value, tone]) => <li key={label}><span>{label}</span><b className={tone}>{value}</b></li>)}</ul>
      <div className="mk-pitch-block is-ask"><small>Open with</small><p>“How do new patients book an appointment today?”</p></div>
    </div>
  )
}

/** The inbound lead API request, matching docs/INTEGRATIONS.md. */
export function CodeSample() {
  return (
    <div className="mk-code">
      <div className="mk-code-bar"><span>POST /functions/v1/inbound-lead</span><span>cURL</span></div>
      <pre tabIndex={0} aria-label="Example inbound lead request"><code>
        <span className="tok-c"># Server-side only. Reuse the requestId on retries.</span>{'\n'}
        <span className="tok-k">curl</span> -X POST <span className="tok-s">"$LEADFLOW_URL/functions/v1/inbound-lead"</span> \{'\n'}
        {'  '}-H <span className="tok-s">"Authorization: Bearer $LEADFLOW_INTEGRATION_TOKEN"</span> \{'\n'}
        {'  '}-H <span className="tok-s">"Content-Type: application/json"</span> \{'\n'}
        {'  '}-d <span className="tok-s">'{'{'}</span>{'\n'}
        {'    '}<span className="tok-p">"requestId"</span>: <span className="tok-s">"6f1c2a9e-4b7d-4e0a-9c1f-2d8e5b3a7c10"</span>,{'\n'}
        {'    '}<span className="tok-p">"inquiry"</span>: {'{'}{'\n'}
        {'      '}<span className="tok-p">"name"</span>: <span className="tok-s">"Jordan Fields"</span>,{'\n'}
        {'      '}<span className="tok-p">"email"</span>: <span className="tok-s">"jordan@example.com"</span>,{'\n'}
        {'      '}<span className="tok-p">"service"</span>: <span className="tok-s">"Website design"</span>,{'\n'}
        {'      '}<span className="tok-p">"message"</span>: <span className="tok-s">"We need a faster site before spring."</span>{'\n'}
        {'    '}{'}'}{'\n'}
        {'  '}<span className="tok-s">{'}'}'</span>{'\n'}
        {'\n'}
        <span className="tok-c"># 200 → {'{'} "ok": true, "reference": "…", "message": "Inquiry received." {'}'}</span>
      </code></pre>
    </div>
  )
}
