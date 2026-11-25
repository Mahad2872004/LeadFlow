import type { ReactNode } from 'react'
import { Glyph, type GlyphName } from './Glyph'
import { featureStatus, type StatusKind } from './content'
import { CTA, EvidenceLabels, Eyebrow, Intro, Note, ProductPreview, ReportPreview, Status, TextLink } from './shared'
import { CodeSample, FindVisual, FollowVisual, OnboardVisual, OutreachVisual, PipelineVisual, PitchVisual, ProjectVisual } from './visuals'
import { signupOpen } from './access'

function Stage({ eyebrow, title, text, points, visual, status, reverse = false, id, children }: { eyebrow: string; title: ReactNode; text: string; points: string[]; visual: ReactNode; status?: [StatusKind, string]; reverse?: boolean; id?: string; children?: ReactNode }) {
  return (
    <section className={`mk-stage-row${reverse ? ' is-reverse' : ''}`} id={id}>
      <div data-reveal>
        <div className="mk-stage-eyebrow"><Eyebrow>{eyebrow}</Eyebrow>{status && <Status kind={status[0]}>{status[1]}</Status>}</div>
        <h2>{title}</h2>
        <p className="mk-split-text">{text}</p>
        <ul className="mk-ticks mk-ticks-sm">{points.map(point => <li key={point}><Glyph name="check" size={18} />{point}</li>)}</ul>
        {children}
      </div>
      <div className="mk-stage-visual" data-reveal>{visual}</div>
    </section>
  )
}

export function Features() {
  return <>
    <Intro eyebrow="Product" title={<>Everything between a first search <em>and a delivered project.</em></>}
      text="Find prospects, understand their business, reach out, win the deal, onboard the client and deliver the project. Every capability below is labelled with its current status." />
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
      <Stage eyebrow="04 · Reach out" id="outreach" title={<>Reach the right person. <em>Say only what you saw.</em></>} status={['available', 'Available']}
        text="Open a lead’s Contacts and Outreach tabs. LeadFlow finds who to talk to on the business’s own website, then drafts a first message based on the business report, for you to review and send."
        points={[
          'Contacts from the website’s contact, team and about pages, the business report and the lead itself; Apollo decision-makers if you use Apollo',
          'Every detail shows its source, an honest email status and a confidence level with its reasons. Confirmed and edited details are never overwritten',
          'Email, WhatsApp and LinkedIn drafts in five distinct angles, with a recommended opportunity. Each statement links to the finding behind it',
          'Drafts that claim lost customers, promise results or invent earlier contact are refused. Every edit is a version you can compare and restore',
          'Copy a draft or open it in your own email or WhatsApp, then mark it as sent and add a follow-up reminder. LeadFlow never sends messages for you',
        ]}
        visual={<OutreachVisual />} />
      <Stage eyebrow="05 · Follow through" title="Keep every conversation moving." reverse status={['available', 'Available']}
        text="Lead statuses you can read at a glance, and a list of what needs doing today."
        points={[
          'Five lead statuses: New, Contacted, Qualified, Converted and Lost, with search and combined filters',
          'Follow-up tasks with due dates, types, priorities and assignees; complete, cancel or reopen them',
          'Activity history alongside every lead, including where it came from',
          'Hosted inquiry form and website embeds, with email notifications through Resend when configured',
        ]}
        visual={<FollowVisual />} />
      <Stage eyebrow="06 · Win" id="sales-pipeline" title={<>Track every deal. <em>Close it with context.</em></>} status={['available', 'Available']}
        text="A sales pipeline built on your leads, reports and outreach, not a separate CRM. Nothing moves a deal on its own: LeadFlow suggests the next stage and you decide."
        points={[
          'Create deals from a lead, a report opportunity or a sent outreach draft; the deal keeps its contact, opportunity and service',
          'A board you can drag, or drive with the keyboard and on phones, plus a sortable list and filters',
          'Log notes, calls, replies, proposals and meetings; mark deals won with the final value, or lost with a reason',
          'Analytics per period: open and weighted pipeline, win rate, average deal and sales cycle, lost reasons and sources. Currencies are never converted or added together',
          'Owners and admins rename, recolour and reorder stages and set lost reasons',
        ]}
        visual={<PipelineVisual />} />
      <Stage eyebrow="07 · Onboard" id="onboarding" reverse title={<>Turn a won deal into a client. <em>Then get ready together.</em></>} status={['available', 'Available']}
        text="Convert a won deal in one review, then run onboarding through a checklist and one private client link, instead of an email thread."
        points={[
          'Convert to client: choose which contacts carry over, confirm the agreed services with scope, deliverables and exclusions, and start onboarding, all in one step',
          'A client workspace with overview, contacts, onboarding, services and scope, documents, tasks, activity and projects',
          'Onboarding stages, reusable forms, file uploads and internal steps; the client uses one private, expiring, revocable link and needs no account',
          'Confirm the scope as a dated record of what was agreed. It is a record, not a contract or signature',
          'A welcome message drafted for you, which you copy or open in your own email and mark as sent',
          'Readiness counts the client’s items and your own steps; completing onboarding saves what the project will start from',
        ]}
        visual={<OnboardVisual />}>
        <p className="mk-fine">Optional reminder emails to clients need a configured email provider and scheduler.</p>
      </Stage>
      <Stage eyebrow="08 · Deliver" id="projects" title={<>Deliver what you agreed. <em>See what’s at risk early.</em></>} status={['available', 'New']}
        text="Projects start from the confirmed scope of a completed onboarding, from a client, or from scratch, and keep the plan, the work and the history in one place."
        points={[
          'Setup from a completed onboarding uses only confirmed services and requirements; you review the brief and plan before anything is created',
          'Three starter templates (website, digital marketing and SEO, AI automation and software) plus your own, and any project saved as a template',
          'Milestones with dependencies, deliverables with owners, and tasks on a board with dependencies that can’t loop, effort and labels',
          'A Gantt-style timeline, a deadline calendar and “My tasks”; project tasks also appear in your follow-ups',
          'Progress counts deliverables, or tasks when there are none, never a mix. Health is On track, At risk, Delayed or On hold, with its reasons',
          'Project files and internal notes stay internal: they never reach the client link',
        ]}
        visual={<ProjectVisual />}>
        <div className="mk-stage-extra">
          <div className="mk-stage-eyebrow"><strong>AI project assistant</strong><Status kind="setup">Needs setup</Status></div>
          <p>Summaries, risks, a plan or a task breakdown, from what the project records. Suggestions are added only when a person approves them. It needs your deployment’s Gemini key, and monthly limits apply.</p>
          <TextLink href="/#after-the-win">Try the interactive demos</TextLink>
        </div>
      </Stage>
    </div>
    <section className="mk-wrap mk-section">
      <Note title="What is not included yet">Sending messages from LeadFlow (drafts and welcome messages are copied or opened in your own email or WhatsApp), scheduled follow-up sequences, LinkedIn automation, team invitations, a client project portal with approvals and comments, time tracking, invoicing, resource planning, external calendar sync, e-signatures, a general lead export, and two-way CRM sync are not current features. Activity history is a working record, not an immutable audit log.</Note>
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
      ['users', 'Apollo.io', 'setup', 'Your Apollo key', 'Search people and companies, reveal emails and phone numbers after seeing the credit cost, and look up decision-makers from a lead’s Contacts. Keys stay server-side.'],
      ['compass', 'Business directory', 'setup', 'Operator setup', 'Search OpenStreetMap business data through directory servers your deployment configures. CSV import works without it.'],
      ['gauge', 'PageSpeed Insights & Gemini', 'setup', 'Optional keys', 'Speed measurements, the AI summary in business reports, AI outreach drafts and the AI project assistant. Without keys, LeadFlow reads pages itself, projects work without AI, and it says what isn’t set up.'],
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
  { name: 'Independent agencies', title: 'Pitch with proof. Deliver with a plan.', text: 'Search for businesses in a niche, run a business report on each website, and open with the opportunity that matches your services, in a drafted message to the right contact that says only what the report found. Track the deal to won, onboard the client, and run the work as a project from the scope you confirmed.', flow: ['Directory search', 'Business report', 'Outreach draft', 'Deal won', 'Onboarding', 'Project'], icon: 'sparkles' },
  { name: 'Consultants', title: 'Make room for discovery.', text: 'Keep a contact’s goals and service interest together before the first call. Track the engagement as a deal, then confirm the scope with the client before kickoff.', flow: ['New inquiry', 'Discovery call', 'Deal', 'Confirmed scope'], icon: 'users' },
  { name: 'Service businesses', title: 'Give every request a next step.', text: 'Review incoming requests, separate new opportunities from active conversations, and make a task for the ones that need attention. When a request becomes work, give the new client a checklist instead of an email thread.', flow: ['New request', 'Follow-up task', 'Client', 'Onboarding checklist'], icon: 'calendar' },
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
  { name: 'Individual', tag: 'For a focused personal pipeline.', status: ['available', 'Capabilities available'] as [StatusKind, string], items: ['Lead records, follow-ups and history', 'Business reports and opportunity matching', 'Contacts and AI outreach drafts', 'Sales pipeline and deal analytics', 'Client onboarding with a private client link', 'Projects, milestones, task board and timeline', 'CSV import, hosted form and website embeds'], note: 'Current capabilities; packaging proposed', featured: true },
  { name: 'Studio', tag: 'For a growing practice.', status: ['planned', 'Planned'] as [StatusKind, string], items: ['Proposed shared workspace', 'Proposed team invitations', 'Proposed roles and assignment'], note: 'Team features are planned', featured: false },
  { name: 'Connected', tag: 'For more connected operations.', status: ['planned', 'Planned'] as [StatusKind, string], items: ['Existing inbound API foundation', 'Proposed client project portal and approvals', 'Proposed expanded workflows'], note: 'Expanded capabilities are planned', featured: false },
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
