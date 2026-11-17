import type { ReactNode } from 'react'
import { Glyph, type GlyphName } from './Glyph'
import { featureStatus, type StatusKind } from './content'
import { CTA, EvidenceLabels, Eyebrow, Intro, Note, ProductPreview, ReportPreview, Status, TextLink } from './shared'
import { CodeSample, FindVisual, FollowVisual, OnboardVisual, PitchVisual } from './visuals'
import { signupOpen } from './access'

function Stage({ eyebrow, title, text, points, visual, status, reverse = false, id }: { eyebrow: string; title: ReactNode; text: string; points: string[]; visual: ReactNode; status?: [StatusKind, string]; reverse?: boolean; id?: string }) {
  return (
    <section className={`mk-stage-row${reverse ? ' is-reverse' : ''}`} id={id}>
      <div data-reveal>
        <div className="mk-stage-eyebrow"><Eyebrow>{eyebrow}</Eyebrow>{status && <Status kind={status[0]}>{status[1]}</Status>}</div>
        <h2>{title}</h2>
        <p className="mk-split-text">{text}</p>
        <ul className="mk-ticks mk-ticks-sm">{points.map(point => <li key={point}><Glyph name="check" size={18} />{point}</li>)}</ul>
      </div>
      <div className="mk-stage-visual" data-reveal>{visual}</div>
    </section>
  )
}

export function Features() {
  return <>
    <Intro eyebrow="Product" title={<>Everything between a first search <em>and a won client.</em></>}
      text="Find prospects, understand their business, pitch what they need, and follow through. Every capability below is labelled with its current status." />
    <section className="mk-wrap mk-section mk-section-flush">
      <div data-reveal><ProductPreview /></div>
    </section>
    <div className="mk-wrap mk-stages">
      <Stage eyebrow="01 · Find" title="Build a prospect list worth calling." status={['setup', 'Directory needs setup']}
        text="Three ways to bring businesses in, each with duplicate checks and a record of where every lead came from."
        points={[
          'Directory search by industry or custom niche, across up to three US, UK or Australian locations, with contact filters',
          'Apollo people and company search with your own key: the credit cost is shown before every reveal and recorded in a ledger',
          'CSV import with automatic column matching, row validation, duplicate review, and a download of rows not imported',
          'Manual entry with website, industry and address, plus search history you can reuse',
        ]}
        visual={<FindVisual />} />
      <section className="mk-stage-row mk-stage-report" id="business-reports">
        <div data-reveal>
          <div className="mk-stage-eyebrow"><Eyebrow>02 · Analyze</Eyebrow><Status kind="available">Available</Status></div>
          <h2>Their website, read for you. <em>With the evidence attached.</em></h2>
          <p className="mk-split-text">Run a report from any lead that has a website. LeadFlow checks:</p>
          <ul className="mk-ticks mk-ticks-sm">
            {['SEO basics: titles, descriptions, headings, structured data, image alt text, robots.txt, sitemap, and broken links',
              'Contact and booking: phone and email links, forms, calls to action, online booking, chat, and WhatsApp',
              'Speed and mobile: Google PageSpeed Insights scores and Core Web Vitals, on mobile and desktop',
              'Technology: the website platform, analytics, marketing, chat, and booking tools it runs on',
              'The business itself: a short summary of its services and audience, written by Google Gemini',
            ].map(item => <li key={item}><Glyph name="check" size={18} />{item}</li>)}
          </ul>
        </div>
        <div className="mk-stage-visual" data-reveal><ReportPreview /></div>
        <div className="mk-stage-full" data-reveal>
          <EvidenceLabels />
          <p className="mk-fine">Reports read public pages only and stop at logins and site protections. “Not found” means not found on the pages analyzed. Reports suggest what could help; they don’t promise results.</p>
        </div>
      </section>
      <Stage eyebrow="03 · Pitch" title="Lead with what they actually need." reverse status={['available', 'Available']}
        text="Findings are matched to the services you list in Settings → Agency services. Services aimed at the lead’s kind of business rank first."
        points={[
          'Each opportunity explains why, a possible benefit worded as a possibility, and a next step — usually a question to ask',
          'Your team can accept, dismiss, or mark opportunities as needing verification, with notes',
          'Mark any finding confirmed or not accurate, and run the report again later to see what changed',
          'Start from 11 editable starter services, from website redesign to workflow automation',
        ]}
        visual={<PitchVisual />} />
      <Stage eyebrow="04 · Follow through" title="Keep every conversation moving." status={['available', 'Available']}
        text="A pipeline you can read at a glance, and a list of what needs doing today."
        points={[
          'Five statuses: New, Contacted, Qualified, Converted and Lost, with search and combined filters',
          'Follow-up tasks with due dates; complete them, or reopen them when the conversation needs another touch',
          'Activity history alongside every lead, including where it came from',
          'Hosted inquiry form and website embeds, with email notifications through Resend when configured',
        ]}
        visual={<FollowVisual />} />
      <Stage eyebrow="05 · Onboard" title="Start the work with everything you need." reverse status={['beta', 'Beta']}
        text="When a lead becomes a client, turn the handover into a checklist instead of an email thread."
        points={[
          'Templates for paid advertising, SEO, social media management and email marketing',
          'One private, expiring, revocable client link: no client account needed',
          'Accept items, request changes, or mark them not required, then see readiness before kickoff',
        ]}
        visual={<OnboardVisual />} />
    </div>
    <section className="mk-wrap mk-section">
      <Note title="What is not included yet">Team invitations, automatic client follow-up messages or outreach from reports, advanced analytics, a general lead export, and two-way CRM sync are not current features. Activity history is a working record, not an immutable audit log.</Note>
    </section>
  </>
}

const methodGroups: { title: string; text: string; items: [GlyphName, string, StatusKind, string, string, string?][] }[] = [
  {
    title: 'Capture inquiries from your website',
    text: 'Start with a link or an embed. No changes to how your website is built.',
    items: [
      ['link', 'Hosted inquiry form', 'available', 'Available method', 'Share a standalone inquiry page. No website code changes needed beyond adding a link.', '/resources#connect-a-website'],
      ['globe', 'Website embed', 'available', 'Available method', 'Place the existing form inside a page using the provided iframe. Verify the published page and its mobile layout.', '/resources#connect-a-website'],
      ['layers', 'WordPress', 'available', 'Installation guide', 'Use a Custom HTML block or your page builder’s HTML widget. Your host must permit trusted iframes.', '/resources#connect-a-website'],
      ['code', 'Custom HTML or React', 'available', 'Installation guide', 'Use the HTML snippet or React iframe component on your contact page. Keep private API credentials server-side.', '/resources#connect-a-website'],
    ],
  },
  {
    title: 'Automate from your stack',
    text: 'Server-to-server lead submission with scoped credentials.',
    items: [
      ['zap', 'Zapier, Make & n8n', 'setup', 'HTTP setup guides', 'Map source events into authenticated requests. Each event needs a stable UUID and workspace credential. No native OAuth connection is included.', '/resources#test-an-integration'],
      ['key', 'API & inbound webhook', 'setup', 'Server integration', 'Submit validated lead data using a scoped bearer credential. Retries are deduplicated; credentials support revocation and rotation.', '/resources#test-an-integration'],
      ['grid', 'Google Sheets', 'setup', 'Via automation', 'Send new rows through a configured automation platform. This is one-way intake, not native Google sync.', '/resources#test-an-integration'],
    ],
  },
  {
    title: 'Data sources and notifications',
    text: 'The services behind lead discovery, business reports and alerts.',
    items: [
      ['mail', 'Email notifications', 'setup', 'Resend configuration', 'Notify a business inbox after a new inquiry is stored. Sender verification and server-side configuration are required.'],
      ['users', 'Apollo.io', 'setup', 'Your Apollo key', 'Search people and companies, then reveal emails and phone numbers after seeing the credit cost. Keys stay server-side.'],
      ['compass', 'Business directory', 'setup', 'Operator setup', 'Search OpenStreetMap business data through directory servers your deployment configures. CSV import works without it.'],
      ['gauge', 'PageSpeed Insights & Gemini', 'setup', 'Optional keys','Speed measurements and the AI summary in business reports. Without keys, LeadFlow reads pages itself and says what isn’t set up.'],
      ['database', 'CRM synchronization', 'planned', 'Planned', 'Native CRM connections and two-way data sync are not implemented.'],
    ],
  },
]

export function Integrations() {
  return <>
    <Intro eyebrow="Integrations" title={<>Your website stays. <em>Your pipeline gets clearer.</em></>}
      text="Start with a form. Add server automation when you need it. Choose the method that fits your existing tools." />
    <section className="mk-wrap mk-section mk-section-flush">
      <Note title="Available method does not mean connected.">Each installation needs configuration and a test. The private hub provides copyable examples and workspace receipt verification. Platform subscriptions and limits may vary.</Note>
      <div className="mk-groups">
        {methodGroups.map(group => (
          <div key={group.title} className="mk-group" data-reveal>
            <div className="mk-group-head"><h2>{group.title}</h2><p>{group.text}</p></div>
            <div className="mk-methods">
              {group.items.map(([icon, name, kind, state, text, href]) => (
                <article className="mk-method" key={name}>
                  <div className="mk-card-top"><span className="mk-card-icon"><Glyph name={icon} size={20} /></span><Status kind={kind}>{state}</Status></div>
                  <h3>{name}</h3>
                  <p>{text}</p>
                  {href && <TextLink href={href}>Read the setup overview</TextLink>}
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
    <section className="mk-section mk-section-tint">
      <div className="mk-wrap mk-split">
        <div data-reveal>
          <Eyebrow>For developers</Eyebrow>
          <h2>One endpoint. <em>Safe to retry.</em></h2>
          <p className="mk-split-text">POST validated inquiries with a workspace-scoped bearer token from your server or automation platform. Reusing a request ID with the same details returns the original receipt; changing the details returns 409.</p>
          <ul className="mk-ticks mk-ticks-sm">
            {['Tokens are stored only as hashes and can be rotated or revoked', 'A 200 response confirms storage, not email delivery', 'Browser requests are refused: use the hosted form on websites'].map(point => <li key={point}><Glyph name="check" size={18} />{point}</li>)}
          </ul>
          <div className="mk-actions">
            <CTA href="/app">Open your workspace</CTA>
            <CTA href="/inquiry" secondary>View the public form</CTA>
          </div>
          <p className="mk-fine">The hub requires an existing account. The public form is real: submissions may notify the configured business.</p>
        </div>
        <div className="mk-dark mk-code-card" data-reveal><CodeSample /></div>
      </div>
    </section>
  </>
}

const solutions: { name: string; title: string; text: string; flow: string[]; icon: GlyphName; status?: string }[] = [
  { name: 'Independent agencies', title: 'Pitch with proof, not guesses.', text: 'Search for businesses in a niche, run a business report on each website, and open with the opportunity that matches your services. Qualify the lead, then schedule the scope conversation.', flow: ['Directory search', 'Business report', 'Opportunity', 'Qualified', 'Scope follow-up'], icon: 'sparkles' },
  { name: 'Consultants', title: 'Make room for discovery.', text: 'Keep a contact’s goals and service interest together before the first call. Record the lead’s progress and set a reminder to reconnect.', flow: ['New inquiry', 'Contacted', 'Discovery follow-up'], icon: 'users' },
  { name: 'Service businesses', title: 'Give every request a next step.', text: 'Review incoming requests, separate new opportunities from active conversations, and make a task for the ones that need attention.', flow: ['New request', 'Review', 'Follow-up task'], icon: 'calendar' },
  { name: 'Small teams', title: 'A focused starting point.', text: 'Workspaces have owner, admin, and member roles, and records stay with the workspace. Inviting teammates from the app and assigning leads are planned.', flow: ['Workspace roles today', 'Invitations planned'], icon: 'grid', status: 'Invitations planned' },
]

export function Solutions() {
  return <>
    <Intro eyebrow="Solutions" title={<>Different kinds of work. <em>The same need for clarity.</em></>}
      text="Practical examples of how LeadFlow can fit a service business. These are illustrative workflows, not customer case studies." />
    <section className="mk-wrap mk-section mk-section-flush">
      <div className="mk-solutions">
        {solutions.map((item, i) => (
          <article className="mk-solution" key={item.name} data-reveal>
            <span className="mk-solution-icon"><Glyph name={item.icon} size={26} /></span>
            <div>
              <div className="mk-stage-eyebrow"><Eyebrow>{`0${i + 1} · ${item.name}`}</Eyebrow>{item.status && <Status kind="planned">{item.status}</Status>}</div>
              <h2>{item.title}</h2>
              <p>{item.text}</p>
              <p className="mk-flow"><span className="mk-sr">Typical flow: </span>{item.flow.map((stage, n) => <span key={stage}>{n > 0 && <Glyph name="arrowRight" size={12} />}<b>{stage}</b></span>)}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  </>
}

const plans = [
  { name: 'Individual', tag: 'For a focused personal pipeline.', status: ['available', 'Capabilities available'] as [StatusKind, string], items: ['Lead records, pipeline and follow-ups', 'Business reports and opportunity matching', 'CSV import with duplicate review', 'Hosted form and website embeds'], note: 'Current capabilities; packaging proposed', featured: true },
  { name: 'Studio', tag: 'For a growing practice.', status: ['planned', 'Planned'] as [StatusKind, string], items: ['Proposed shared workspace', 'Proposed team invitations', 'Proposed roles and assignment'], note: 'Team features are planned', featured: false },
  { name: 'Connected', tag: 'For more connected operations.', status: ['planned', 'Planned'] as [StatusKind, string], items: ['Existing inbound API foundation', 'Proposed expanded workflows', 'Proposed advanced reporting'], note: 'Expanded capabilities are planned', featured: false },
]

export function Pricing() {
  return <>
    <Intro eyebrow="Pricing" title={<>Simple pricing is the plan. <em>We’re still shaping it.</em></>}
      text="The plans below are proposed packaging, not offers for sale. Prices, limits, and availability will be confirmed before any paid launch." />
    <section className="mk-wrap mk-section mk-section-flush">
      <Note title="Provisional · No checkout or billing is active.">{signupOpen ? 'Creating an account does not purchase or activate a plan, and no payment is collected.' : 'Request access to discuss your workflow. No plan is purchased or activated by submitting an inquiry.'}</Note>
      <div className="mk-plans">
        {plans.map(plan => (
          <article className={`mk-plan${plan.featured ? ' is-featured mk-dark' : ''}`} key={plan.name} data-reveal>
            <div className="mk-card-top"><span className="mk-plan-label">Proposed plan</span><Status kind={plan.status[0]}>{plan.status[1]}</Status></div>
            <h2>{plan.name}</h2>
            <p>{plan.tag}</p>
            <div className="mk-price"><strong>Price to be announced</strong><span>Confirmed before any paid launch</span></div>
            <ul>{plan.items.map(item => <li key={item}><Glyph name={plan.featured ? 'checkCircle' : 'clock'} size={18} />{item}</li>)}</ul>
            <p className="mk-fine">{plan.note}</p>
            {plan.featured ? <CTA>{signupOpen ? 'Get started' : 'Discuss access'}</CTA> : <CTA href="/inquiry" secondary>Tell us what you need</CTA>}
          </article>
        ))}
      </div>
      <div className="mk-compare" data-reveal>
        <div className="mk-compare-head"><h2>What exists today, and what comes later.</h2><p>Statuses describe the application, not a service-level commitment.</p></div>
        {featureStatus.map(([feature, kind, label, note]) => (
          <div className="mk-compare-row" key={feature}>
            <strong>{feature}</strong>
            <span className="mk-compare-state"><Status kind={kind}>{label}</Status>{note && <small>{note}</small>}</span>
          </div>
        ))}
      </div>
      <p className="mk-fine">Hosting, email delivery, AI, data and automation providers have their own quotas and terms. No unlimited usage or service-level commitment is offered here.</p>
    </section>
  </>
}
