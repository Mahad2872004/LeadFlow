import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Glyph, type GlyphName } from './Glyph'
import { capabilities, productFacts, providers, reportChecks, type CapabilityId, type StatusKind } from './content'
import { CountUp, CTA, EvidenceLabels, Eyebrow, FAQs, ProductPreview, ReportPreview, SectionHead, Status, TextLink } from './shared'
import { AnalyzeVisual, CallPrepVisual, CodeSample, FindVisual, OnboardVisual, OutreachVisual, PipelineVisual, ProjectVisual, HeroAnalysis } from './visuals'
import { DeliverDemo, OnboardDemo, WinDemo } from './Demos'
import { reducedMotion, useInView } from './motion'
import { signupOpen } from './access'

const steps: { id: string; label: string; title: string; text: string; visual: ReactNode; demo?: boolean }[] = [
  { id: 'find', label: 'Find', title: 'Find businesses worth talking to', text: 'Search a business directory by industry and location, search people and companies with your Apollo account, or import a CSV. Duplicates are caught before they reach your pipeline.', visual: <FindVisual /> },
  { id: 'analyze', label: 'Analyze', title: 'Let AI read their website', text: 'LeadFlow reads public pages, checks SEO, booking and contact options, measures speed with PageSpeed Insights and spots their tools. Gemini summarizes the business, and findings are matched to the services you sell.', visual: <AnalyzeVisual /> },
  { id: 'reach', label: 'Reach out', title: 'Reach the right person with what you saw', text: 'LeadFlow finds the lead’s public contacts and drafts an email, WhatsApp or LinkedIn message based on the report. You review it and send it yourself.', visual: <OutreachVisual /> },
  { id: 'win', label: 'Win', title: 'Track every deal to won', text: 'Turn interest into deals on a pipeline board. Log calls, meetings and proposals, mark deals won or lost with a reason, and read win rate and pipeline value per currency.', visual: <PipelineVisual />, demo: true },
  { id: 'onboard', label: 'Onboard', title: 'Onboard the client without the email thread', text: 'Convert a won deal into a client in one review. The client fills in forms and uploads files through one private link; you confirm the scope and send your welcome message yourself.', visual: <OnboardVisual />, demo: true },
  { id: 'deliver', label: 'Deliver', title: 'Deliver the project you agreed', text: 'Start a project from the confirmed scope. Plan milestones, deliverables and tasks from a template, then follow progress and health on a board, a timeline and a calendar.', visual: <ProjectVisual />, demo: true },
]

const STAGE_MS = 7000

/** Six-stage walkthrough. Arrow-key tabs; an optional autoplay that pauses on hover and focus, stops when the visitor picks a
 *  stage, and never runs with reduced motion. */
function HowItWorks({ active, setActive, auto, setAuto }: { active: number; setActive: (index: number) => void; auto: boolean; setAuto: (on: boolean) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const fill = useRef<HTMLSpanElement | null>(null)
  const elapsed = useRef(0)
  const [canPlay] = useState(() => !reducedMotion())
  const [hover, setHover] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const inView = useInView(root, 0.35)
  const playing = canPlay && auto && !hover && !focusIn && inView

  useEffect(() => { elapsed.current = 0 }, [active])
  useEffect(() => {
    if (!playing) return
    let frame = 0
    let last = 0
    const tick = (now: number) => {
      if (last) elapsed.current += Math.min(100, now - last)
      last = now
      const progress = Math.min(1, elapsed.current / STAGE_MS)
      if (fill.current) fill.current.style.transform = `scaleX(${progress})`
      if (progress >= 1) { setActive((active + 1) % steps.length); return }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, active, setActive])

  const choose = (index: number) => { setAuto(false); setActive(index) }
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const keys: Record<string, number> = { ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: steps.length - 1 }
    if (!(event.key in keys)) return
    event.preventDefault()
    const next = (keys[event.key] + steps.length) % steps.length
    choose(next)
    tabs.current[next]?.focus()
  }
  const pauseOn = {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocusIn(true),
    onBlur: (event: FocusEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusIn(false) },
  }
  return (
    <div className="mk-how" ref={root} data-reveal data-autoplay={!canPlay || !auto ? 'off' : playing ? 'playing' : 'paused'}>
      <div className="mk-how-side">
        <div className="mk-how-tabs" role="tablist" aria-label="How LeadFlow works" {...pauseOn}>
          {steps.map((step, i) => (
            <button key={step.id} ref={node => { tabs.current[i] = node }} type="button" role="tab" id={`how-tab-${step.id}`}
              aria-selected={i === active} aria-controls={`how-panel-${step.id}`} tabIndex={i === active ? 0 : -1}
              className="mk-how-tab" onClick={() => choose(i)} onKeyDown={event => onKeyDown(event, i)}>
              <span className="mk-how-n">0{i + 1}</span>
              <span className="mk-how-copy">
                <span className="mk-how-label">{step.label}</span>
                <strong>{step.title}</strong>
                <span className="mk-how-text">{step.text}</span>
              </span>
              {i === active && canPlay && auto && <span className="mk-how-timer" aria-hidden="true"><span ref={fill} /></span>}
            </button>
          ))}
        </div>
        {canPlay && (
          <button type="button" className="mk-how-toggle" onClick={() => setAuto(!auto)}>
            <Glyph name={auto ? 'pause' : 'play'} size={14} />{auto ? 'Pause the walkthrough' : 'Play the walkthrough'}
          </button>
        )}
      </div>
      <div className="mk-how-stage" {...pauseOn}>
        {steps.map((step, i) => (
          <div key={step.id} role="tabpanel" id={`how-panel-${step.id}`} aria-labelledby={`how-tab-${step.id}`} hidden={i !== active} className="mk-how-panel">
            {step.visual}
            {step.demo && <a className="mk-how-try" href="#after-the-win">Try it below: an interactive demo<Glyph name="arrowRight" size={14} /></a>}
          </div>
        ))}
      </div>
    </div>
  )
}

function CardVisual({ id }: { id: CapabilityId }) {
  switch (id) {
    case 'directory': return (
      <div className="mk-card-visual mk-map" aria-hidden="true">
        {[['Dentists', 'Austin, TX'], ['Physiotherapists', 'Leeds, UK'], ['Plumbers', 'Brisbane, AU']].map(([what, where]) => <span key={where}><Glyph name="search" size={13} />{what}<i>{where}</i></span>)}
      </div>
    )
    case 'website': return <div className="mk-card-visual mk-chip-row" aria-hidden="true">{['HTML', 'WordPress', 'React'].map(chip => <span key={chip} className="mk-chip">{chip}</span>)}</div>
    case 'outreach': return (
      <div className="mk-card-visual mk-outreach-card" aria-hidden="true">
        <div className="mk-chip-row">{['Email', 'WhatsApp', 'LinkedIn'].map(chip => <span key={chip} className="mk-chip">{chip}</span>)}<span className="mk-chip is-soft">You send it</span></div>
        <p><span className="mk-type mk-type-observed">Observed</span>“I couldn’t find an online booking option on the pages I looked at…”</p>
      </div>
    )
    case 'pipeline': return (
      <div className="mk-card-visual" aria-hidden="true">
        <div className="mk-stage-strip">{([['Interested', 4], ['Proposal', 3], ['Won', 2]] as const).map(([label, count]) => <span key={label} className={label === 'Won' ? 'is-won' : ''} style={{ flexGrow: count }}><b>{count}</b>{label}</span>)}</div>
      </div>
    )
    case 'clients': return (
      <div className="mk-card-visual" aria-hidden="true">
        <div className="mk-ready"><span>Readiness</span><b>7 of 9 items</b></div>
        <div className="mk-bar mk-bar-lg"><span style={{ width: '78%' }} /></div>
      </div>
    )
    case 'projects': return (
      <div className="mk-card-visual mk-proj-card" aria-hidden="true">
        <div className="mk-proj-top"><span><strong>Website rebuild</strong><small>Harbor Dental · 3 of 5 deliverables</small></span><i className="mk-health is-on_track">On track</i></div>
        <div className="mk-bar mk-bar-lg"><span style={{ width: '60%' }} /></div>
        <ol className="mk-proj-steps">{['Discovery', 'Design', 'Build', 'Launch'].map((name, i) => <li key={name} className={i < 2 ? 'is-done' : i === 2 ? 'is-current' : ''}>{name}</li>)}</ol>
      </div>
    )
    case 'assistant': return (
      <div className="mk-card-visual mk-ai-card" aria-hidden="true">
        <span className="mk-type mk-type-ai"><Glyph name="sparkles" size={12} />Suggestion</span>
        <p>Split “Booking page build” into 3 tasks</p>
        <span className="mk-chip is-soft">Added only when you approve</span>
      </div>
    )
    case 'api': return <div className="mk-card-visual mk-inline-code" aria-hidden="true"><span>POST</span> /functions/v1/inbound-lead</div>
    default: return null
  }
}

function Bento() {
  return (
    <div className="mk-bento">
      {capabilities.map(item => (
        <article key={item.id} className={`mk-card is-${item.size}`} data-reveal>
          <div className="mk-card-top">
            <span className="mk-card-icon"><Glyph name={item.icon} size={20} /></span>
            {item.status && <Status kind={item.status[0]}>{item.status[1]}</Status>}
          </div>
          <h3>{item.title}</h3>
          <p>{item.text}</p>
          <CardVisual id={item.id} />
        </article>
      ))}
    </div>
  )
}

const demos: { id: string; n: string; stage: string; icon: GlyphName; title: string; text: string; status: [StatusKind, string]; href: string; link: string; demo: ReactNode; wide?: boolean }[] = [
  { id: 'demo-win', n: '01', stage: 'Win', icon: 'trophy', title: 'Close the deal. Keep the context.', text: 'Mark the deal won, then convert it: contacts, the agreed service and an onboarding checklist are created together, in one review.', status: ['available', 'Available'], href: '/features#sales-pipeline', link: 'How the sales pipeline works', demo: <WinDemo /> },
  { id: 'demo-onboard', n: '02', stage: 'Onboard', icon: 'clipboard', title: 'Know when you’re ready to start.', text: 'The client answers forms and uploads files through one private link. Readiness counts both their items and your own steps.', status: ['available', 'Available'], href: '/features#onboarding', link: 'How onboarding works', demo: <OnboardDemo /> },
  { id: 'demo-deliver', n: '03', stage: 'Deliver', icon: 'briefcase', title: 'See progress and health, with the reasons.', text: 'Move tasks across the board and watch progress, the timeline and health follow the same rules as the app. Try making the high-priority task overdue, then finish it.', status: ['available', 'New'], href: '/features#projects', link: 'How projects work', demo: <DeliverDemo />, wide: true },
]

function AfterTheWin() {
  return (
    <section className="mk-section" id="after-the-win">
      <div className="mk-wrap">
        <SectionHead eyebrow="New · Clients and delivery" title={<>The deal is won. <em>Now deliver it.</em></>}
          text="LeadFlow now follows the work past the first conversation: a sales pipeline, client onboarding with a private client link, and projects that start from the scope you confirmed. Try each step below." />
        <div className="mk-demos">
          {demos.map(item => (
            <article key={item.id} id={item.id} className={`mk-demo${item.wide ? ' is-wide' : ''}`} aria-labelledby={`${item.id}-title`} data-reveal>
              <div className="mk-demo-copy">
                <div className="mk-card-top">
                  <span className="mk-demo-step"><Glyph name={item.icon} size={16} />{item.n} · {item.stage}</span>
                  <Status kind={item.status[0]}>{item.status[1]}</Status>
                </div>
                <h3 id={`${item.id}-title`}>{item.title}</h3>
                <p>{item.text}</p>
              </div>
              {item.demo}
              <div className="mk-demo-foot"><TextLink href={item.href}>{item.link}</TextLink></div>
            </article>
          ))}
        </div>
        <p className="mk-fine mk-center">Demos run in your browser with fictional data. In the app, LeadFlow never sends the welcome message or signs anything for you: the scope confirmation is a record, not a contract.</p>
      </div>
    </section>
  )
}

const ownerPoints = [
  'Know their speed score, what’s missing and what they sell before you dial.',
  'Pitch services they actually need, with evidence you can show them.',
  'Open with a drafted message that only says what the report actually found.',
  'See which deals are moving, what’s due today, and why a project is at risk.',
  'Turn a won deal into a client, a checklist and a project without retyping a thing.',
]
const builderPoints: [GlyphName, string][] = [
  ['database', 'PostgreSQL row-level security and role-checked functions isolate every workspace’s records.'],
  ['key', 'Scoped API tokens, stored only as hashes, with rotation and revocation.'],
  ['shield', 'The website reader refuses private networks and stops at logins.'],
  ['sparkles', 'Website and client text is passed to the AI as data; its output is schema-checked and must cite real evidence.'],
  ['mail', 'Outreach drafts are checked in code: claims the evidence can’t support are refused, and nothing is ever sent for you.'],
  ['lock', 'A client link opens only its own checklist; project files and notes are always internal.'],
  ['zap', 'Idempotent request IDs: retrying a request never duplicates a lead, client or project.'],
]
const uses = [
  { icon: 'compass' as GlyphName, title: 'Web and marketing agencies', text: 'See what a prospect’s website needs before the first call, pitch the service that fixes it, and deliver it as a project.', flow: ['Report', 'Outreach', 'Deal', 'Project'] },
  { icon: 'users' as GlyphName, title: 'Consultants', text: 'Keep a contact’s goals and context together, from first interest to a confirmed scope and a kickoff.', flow: ['Inquiry', 'Discovery call', 'Client', 'Onboarding'] },
  { icon: 'calendar' as GlyphName, title: 'Service businesses', text: 'Give every incoming request a clear owner and next step, and every new client a checklist instead of an email thread.', flow: ['Request', 'Follow-up', 'Client', 'Delivery'] },
]

export default function Home() {
  const [active, setActive] = useState(0)
  const [auto, setAuto] = useState(true)
  const pick = (index: number) => { setAuto(false); setActive(index) }
  return <>
    <section className="mk-hero">
      <div className="mk-stage mk-dark">
        <div className="mk-wrap mk-hero-copy">
          <a className="mk-announce" href="#after-the-win"><b>New</b>Client onboarding and project delivery<Glyph name="arrowRight" size={15} /></a>
          <h1>Know what every lead needs <em>before</em> the first call.</h1>
          <p className="mk-lede">LeadFlow finds businesses worth talking to, reads their website with AI, and matches every gap to a service you sell. Draft the first message, track the deal to won, then onboard the client and deliver the project, all in one workspace.</p>
          <ol className="mk-hero-flow" aria-label="The LeadFlow lifecycle">
            {steps.map((step, i) => <li key={step.id}><a href="#how-it-works" onClick={() => pick(i)}>{step.label}</a></li>)}
          </ol>
          <div className="mk-actions">
            <CTA />
            <CTA href="#product-preview" secondary>Take a closer look</CTA>
          </div>
          <ul className="mk-hero-points">
            <li><Glyph name="check" size={16} />Evidence behind every finding</li>
            <li><Glyph name="check" size={16} />Public website pages only</li>
            <li><Glyph name="check" size={16} />{signupOpen ? 'No checkout required' : 'Invitation access, no checkout'}</li>
          </ul>
        </div>
      </div>
      <div className="mk-wrap mk-hero-visual"><HeroAnalysis /></div>
    </section>

    <section className="mk-providers" aria-label="Services LeadFlow works with">
      <div className="mk-wrap">
        <p>Works with</p>
        <ul>{providers.map(name => <li key={name}>{name}</li>)}</ul>
      </div>
    </section>

    <section className="mk-section">
      <div className="mk-wrap">
        <SectionHead center eyebrow="The workspace" title={<>Every lead, deal and project. <em>One calm place.</em></>}
          text="Leads, business reports, outreach drafts, deals, clients and projects stay together, so the next conversation starts where the last one ended." />
        <div data-reveal><ProductPreview /></div>
      </div>
    </section>

    <section className="mk-section mk-section-tint" id="how-it-works">
      <div className="mk-wrap">
        <SectionHead eyebrow="How it works" title="From a cold list to a delivered project."
          text="Six stages that replace a spreadsheet, a dozen browser tabs, an onboarding email thread and a separate project tracker." />
        <HowItWorks active={active} setActive={setActive} auto={auto} setAuto={setAuto} />
      </div>
    </section>

    <section className="mk-night mk-dark" id="business-reports">
      <div className="mk-wrap mk-section">
        <div className="mk-split">
          <div data-reveal>
            <Eyebrow>AI business reports</Eyebrow>
            <h2>Know the business. <em>Before you reach out.</em></h2>
            <p className="mk-split-text">Open a lead and run a report. In one to three minutes LeadFlow reads up to ten public pages, measures mobile and desktop speed with Google PageSpeed Insights, detects the tools the site runs on, and uses Google Gemini to write a short summary of the business.</p>
            <p className="mk-split-text">Every finding links to the evidence behind it and says whether it was observed, measured or interpreted. Opportunities are matched to the services you sell, so you know what to offer, and why.</p>
            <ul className="mk-check-chips">{reportChecks.map(check => <li key={check}><Glyph name="check" size={14} />{check}</li>)}</ul>
            <div className="mk-actions"><CTA href="/features#business-reports" secondary>See how reports work</CTA></div>
          </div>
          <div data-reveal><ReportPreview /></div>
        </div>
        <div data-reveal><EvidenceLabels /></div>
        <p className="mk-fine mk-center">Public pages only. No logins, no getting around site protections, and nothing is sent to the business.</p>
      </div>
    </section>

    <AfterTheWin />

    <section className="mk-section mk-section-tint">
      <div className="mk-wrap">
        <SectionHead eyebrow="Platform" title={<>Everything between a first search <em>and a delivered project.</em></>}
          text="One workspace for finding, winning, onboarding and delivering, with a clear label wherever something needs setup or is new." />
        <Bento />
        <div className="mk-facts">
          {productFacts.map(([value, text]) => (
            <div className="mk-fact" key={text} data-reveal><strong><CountUp value={value} /></strong><span>{text}</span></div>
          ))}
        </div>
      </div>
    </section>

    <section className="mk-section">
      <div className="mk-wrap">
        <SectionHead center eyebrow="Built for both sides of the table" title={<>Clear enough for owners. <em>Solid enough for engineers.</em></>} />
        <div className="mk-duo">
          <article className="mk-duo-card mk-duo-owner" data-reveal>
            <span className="mk-duo-label"><Glyph name="target" size={16} />For owners and sales leads</span>
            <h3>Walk into every call prepared.</h3>
            <ul className="mk-ticks">{ownerPoints.map(point => <li key={point}><Glyph name="checkCircle" size={20} />{point}</li>)}</ul>
            <CallPrepVisual />
            <div className="mk-duo-foot"><TextLink href="/solutions">See how teams use it</TextLink></div>
          </article>
          <article className="mk-duo-card mk-duo-dev mk-dark" data-reveal>
            <span className="mk-duo-label"><Glyph name="code" size={16} />For technical teams</span>
            <h3>Inspectable by design.</h3>
            <ul className="mk-ticks">{builderPoints.map(([icon, point]) => <li key={point}><Glyph name={icon} size={20} />{point}</li>)}</ul>
            <CodeSample />
            <div className="mk-duo-foot"><TextLink href="/security">Security details</TextLink><TextLink href="/integrations">Integration methods</TextLink></div>
          </article>
        </div>
      </div>
    </section>

    <section className="mk-section mk-section-tint">
      <div className="mk-wrap">
        <SectionHead eyebrow="Who it’s for" title="Made for businesses that sell expertise.">
          <div className="mk-head-link"><TextLink href="/solutions">Explore use cases</TextLink></div>
        </SectionHead>
        <div className="mk-uses">
          {uses.map(use => (
            <article key={use.title} className="mk-use" data-reveal>
              <span className="mk-card-icon"><Glyph name={use.icon} size={20} /></span>
              <h3>{use.title}</h3>
              <p>{use.text}</p>
              <p className="mk-flow"><span className="mk-sr">Typical flow: </span>
                {use.flow.map((stage, i) => <span key={stage}>{i > 0 && <Glyph name="arrowRight" size={12} />}<b>{stage}</b></span>)}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>

    <section className="mk-section mk-faq-section">
      <div className="mk-wrap mk-faq-wrap">
        <div data-reveal>
          <Eyebrow>FAQ</Eyebrow>
          <h2>Questions, answered straight.</h2>
          <p className="mk-split-text">What LeadFlow does today, how to get access, and what is still ahead.</p>
          <div className="mk-head-link"><TextLink href="/faq">All frequently asked questions</TextLink></div>
        </div>
        <FAQs short />
      </div>
    </section>
  </>
}
