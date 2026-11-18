import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Glyph, type GlyphName } from './Glyph'
import { capabilities, providers, reportChecks } from './content'
import { CTA, EvidenceLabels, Eyebrow, FAQs, ProductPreview, ReportPreview, SectionHead, Status, TextLink } from './shared'
import { AnalyzeVisual, CallPrepVisual, CodeSample, FindVisual, FollowVisual, HeroAnalysis, PitchVisual } from './visuals'
import { signupOpen } from './access'

const steps: { id: string; label: string; title: string; text: string; visual: ReactNode }[] = [
  { id: 'find', label: 'Find', title: 'Find businesses worth talking to', text: 'Search a business directory by industry and location, search people and companies with your Apollo account, or import a CSV. Duplicates are caught before they reach your pipeline.', visual: <FindVisual /> },
  { id: 'analyze', label: 'Analyze', title: 'Let AI read their website', text: 'LeadFlow reads public pages, checks SEO, booking and contact options, measures speed with PageSpeed Insights and spots their tools. Gemini summarizes the business.', visual: <AnalyzeVisual /> },
  { id: 'pitch', label: 'Pitch', title: 'Lead with what they’re missing', text: 'Findings are matched to the services you sell. LeadFlow finds the lead’s public contacts and drafts an email, WhatsApp or LinkedIn message based on what it found. You review it and send it yourself.', visual: <PitchVisual /> },
  { id: 'follow', label: 'Follow through', title: 'Keep every conversation moving', text: 'Statuses, follow-up tasks and full history show what’s due today. When a deal is won, start client onboarding with a private checklist link.', visual: <FollowVisual /> },
]

function HowItWorks() {
  const [active, setActive] = useState(0)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const keys: Record<string, number> = { ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: steps.length - 1 }
    if (!(event.key in keys)) return
    event.preventDefault()
    const next = (keys[event.key] + steps.length) % steps.length
    setActive(next)
    tabs.current[next]?.focus()
  }
  return (
    <div className="mk-how" data-reveal>
      <div className="mk-how-tabs" role="tablist" aria-label="How LeadFlow works">
        {steps.map((step, i) => (
          <button key={step.id} ref={node => { tabs.current[i] = node }} type="button" role="tab" id={`how-tab-${step.id}`}
            aria-selected={i === active} aria-controls={`how-panel-${step.id}`} tabIndex={i === active ? 0 : -1}
            className="mk-how-tab" onClick={() => setActive(i)} onKeyDown={event => onKeyDown(event, i)}>
            <span className="mk-how-n">0{i + 1}</span>
            <span className="mk-how-copy">
              <span className="mk-how-label">{step.label}</span>
              <strong>{step.title}</strong>
              <span className="mk-how-text">{step.text}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="mk-how-stage">
        {steps.map((step, i) => (
          <div key={step.id} role="tabpanel" id={`how-panel-${step.id}`} aria-labelledby={`how-tab-${step.id}`} hidden={i !== active} className="mk-how-panel">
            {step.visual}
          </div>
        ))}
      </div>
    </div>
  )
}

function Bento() {
  return (
    <div className="mk-bento">
      {capabilities.map(item => (
        <article key={item.title} className={`mk-card is-${item.size}`} data-reveal>
          <div className="mk-card-top">
            <span className="mk-card-icon"><Glyph name={item.icon} size={20} /></span>
            {item.status && <Status kind={item.status[0]}>{item.status[1]}</Status>}
          </div>
          <h3>{item.title}</h3>
          <p>{item.text}</p>
          {item.icon === 'compass' && (
            <div className="mk-card-visual mk-map" aria-hidden="true">
              {[['Dentists', 'Austin, TX'], ['Physiotherapists', 'Leeds, UK'], ['Plumbers', 'Brisbane, AU']].map(([what, where]) => <span key={where}><Glyph name="search" size={13} />{what}<i>{where}</i></span>)}
            </div>
          )}
          {item.icon === 'globe' && <div className="mk-card-visual mk-chip-row" aria-hidden="true">{['HTML', 'WordPress', 'React'].map(chip => <span key={chip} className="mk-chip">{chip}</span>)}</div>}
          {item.icon === 'mail' && (
            <div className="mk-card-visual mk-outreach-card" aria-hidden="true">
              <div className="mk-chip-row">{['Email', 'WhatsApp', 'LinkedIn'].map(chip => <span key={chip} className="mk-chip">{chip}</span>)}<span className="mk-chip is-soft">You send it</span></div>
              <p><span className="mk-type mk-type-observed">Observed</span>“I couldn’t find an online booking option on the pages I looked at…”</p>
            </div>
          )}
          {item.icon === 'clipboard' && (
            <div className="mk-card-visual" aria-hidden="true">
              <div className="mk-ready"><span>Readiness</span><b>7 of 9 items</b></div>
              <div className="mk-bar mk-bar-lg"><span style={{ width: '78%' }} /></div>
            </div>
          )}
          {item.icon === 'code' && <div className="mk-card-visual mk-inline-code" aria-hidden="true"><span>POST</span> /functions/v1/inbound-lead</div>}
        </article>
      ))}
    </div>
  )
}

const ownerPoints = [
  'Know their speed score, what’s missing and what they sell before you dial.',
  'Pitch services they actually need, with evidence you can show them.',
  'Open with a drafted message that only says what the report actually found.',
  'See what’s due today, so no conversation goes quiet by accident.',
  'Start with a form link or a CSV. No setup project.',
]
const builderPoints: [GlyphName, string][] = [
  ['database', 'PostgreSQL row-level security isolates every workspace’s records.'],
  ['key', 'Scoped API tokens, stored only as hashes, with rotation and revocation.'],
  ['shield', 'The website reader refuses private networks and stops at logins.'],
  ['sparkles', 'Website text is passed to the AI as data; its output is schema-checked and must cite real evidence.'],
  ['mail', 'Outreach drafts are checked in code: claims the evidence can’t support are refused, and nothing is ever sent for you.'],
  ['zap', 'Idempotent request IDs: retrying a request never duplicates a lead.'],
]
const uses = [
  { icon: 'compass' as GlyphName, title: 'Web and marketing agencies', text: 'See what a prospect’s website needs before the first call, and pitch the service that fixes it.', flow: ['Discovery', 'Report', 'Outreach'] },
  { icon: 'users' as GlyphName, title: 'Consultants', text: 'Keep a contact’s goals and context together, from first interest to a useful discovery call.', flow: ['Inquiry', 'Contacted', 'Discovery call'] },
  { icon: 'calendar' as GlyphName, title: 'Service businesses', text: 'Give every incoming request a clear owner and next step, so none of them goes cold.', flow: ['Request', 'Review', 'Follow-up'] },
]

export default function Home() {
  return <>
    <section className="mk-hero">
      <div className="mk-stage mk-dark">
        <div className="mk-wrap mk-hero-copy">
          <a className="mk-announce" href="/features#outreach"><b>New</b>Contacts and outreach drafts, based on the evidence<Glyph name="arrowRight" size={15} /></a>
          <h1>Know what every lead needs <em>before</em> the first call.</h1>
          <p className="mk-lede">LeadFlow finds businesses worth talking to, reads their website with AI, and matches every gap to a service you sell. Then it finds the right contact, drafts a first message for you to review, and keeps each follow-up on track.</p>
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
        <SectionHead center eyebrow="The workspace" title={<>Every lead, report and follow-up. <em>One calm place.</em></>}
          text="Leads, business reports, contacts, outreach drafts and follow-ups stay together, so the next conversation starts where the last one ended." />
        <div data-reveal><ProductPreview /></div>
      </div>
    </section>

    <section className="mk-section mk-section-tint">
      <div className="mk-wrap">
        <SectionHead eyebrow="How it works" title="From a cold list to a warm conversation."
          text="Four steps that replace a spreadsheet, a dozen browser tabs and a lot of guesswork." />
        <HowItWorks />
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

    <section className="mk-section">
      <div className="mk-wrap">
        <SectionHead eyebrow="Platform" title={<>Everything between a first search <em>and a won client.</em></>}
          text="One workspace for finding, understanding and following up, with a clear label wherever something needs setup or is still in beta." />
        <Bento />
      </div>
    </section>

    <section className="mk-section mk-section-tint">
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

    <section className="mk-section">
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
