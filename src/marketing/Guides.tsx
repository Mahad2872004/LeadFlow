import { Glyph, type GlyphName } from './Glyph'
import { Eyebrow, Intro, Note, TextLink } from './shared'
import { signupOpen } from './access'

const guides = [
 ['get-started', '01', 'Your first useful pipeline', signupOpen ? 'From a new account to a daily routine.' : 'A simple routine for an existing account.', [signupOpen ? 'Create an account, or sign in, and name your first workspace. A new workspace starts empty.' : 'Sign in with the account your administrator has provided. A new workspace starts empty.', 'Add a lead manually, or submit a test inquiry through your configured website form. Use fictional details when testing.', 'Read the inquiry, choose its status, and add a specific follow-up task.', 'Refresh the dashboard and reopen the lead to verify the saved details.']],
 ['connect-a-website', '02', 'Connect your website thoughtfully', 'Publish, test, then verify.', ['Open the private Integrations hub and choose Hosted, Embed, WordPress, or Custom website.', 'Use the hosted link or copy the example for your site. Verify that it points to your deployed form, not localhost.', 'The form host needs configured Supabase and Turnstile settings. Server destinations and email secrets are administrator-managed.', 'Publish the page, submit fictional details, and save the reference. Verify it in your workspace and check the lead after refresh.']],
 ['follow-up-routine', '03', 'A follow-up routine you can keep', 'Useful habits without automatic outreach.', ['Start with due and overdue tasks instead of reading the whole pipeline.', 'Write a task that describes an action: “Ask about the brief” is more useful than “Follow up”.', 'After reaching out through your usual channel, mark the draft as sent, update the lead status and complete the task. Add the suggested reminder for the next touch.', 'If the conversation needs more time, schedule the next action. LeadFlow does not send client messages for you.']],
 ['read-a-business-report', '04', 'Read a business report well', 'Evidence first, then opportunities.', ['Open a lead that has a website, choose Business report, then Analyze business. It usually takes one to three minutes, and keeps running if you close the window.', 'Start with the Overview: speed scores, a short summary, and the most important findings.', 'Check the label on each finding. Observed and measured findings come from the website and tools; AI interpretations and hypotheses are suggestions to confirm. “Not found” means not found on the pages analyzed.', 'Open the evidence behind a finding, then mark it confirmed or not accurate.', 'Accept, dismiss, or mark opportunities as needing verification, and add a note for your first conversation.']],
 ['write-outreach', '05', 'Outreach that says only what you saw', 'From contacts to a first message.', ['Open a lead that has a business report and choose Contacts, then Find contacts. Check each detail’s source and email status, confirm the right person, and mark them preferred.', 'Choose Outreach. Start from the recommended opportunity and angle, pick the channel the business actually uses, and generate a draft.', 'Read the “Based on” list: every statement should match a finding you’d be comfortable showing them. Edit freely; each edit is saved as a version.', 'Send it from your own email, WhatsApp or LinkedIn, then mark it as sent and add the follow-up reminder. Follow-up drafts are only prepared after the first message is sent.']],
 ['test-an-integration', '06', 'Know when a connection really works', 'A guide is the beginning, not the proof.', ['For server automation, obtain a scoped credential from an administrator and store it only in your server or platform credential store.', 'Keep one saved UUID per source event. Retry uncertain requests with the original UUID and content.', 'Verify the receipt in the correct workspace. Refresh and confirm the record persists.', 'Check email separately: provider acceptance is not inbox delivery. Native platform execution needs its own test.']],
] as const

export function Resources() {
  return <>
    <Intro eyebrow="Resources" title={<>A little guidance. <em>A more useful workflow.</em></>}
      text="Short, practical guides to get from a configured workspace to a repeatable daily routine." />
    <section className="mk-wrap mk-section mk-section-flush">
      <div className="mk-index">
        {guides.map(([id, n, title, sub]) => (
          <a href={'#' + id} key={id}>
            <small>Guide {n}</small>
            <h2>{title}</h2>
            <p>{sub}</p>
            <span className="mk-index-arrow"><Glyph name="arrowRight" size={18} /></span>
          </a>
        ))}
      </div>
      <div className="mk-reading">
        {guides.map(([id, n, title, sub, steps]) => (
          <article id={id} key={id}>
            <Eyebrow>Field note {n}</Eyebrow>
            <h2>{title}</h2>
            <p>{sub}</p>
            <ol className="mk-steps-list" role="list">{steps.map(step => <li key={step}>{step}</li>)}</ol>
            {id === 'get-started' && <div className="mk-actions">{signupOpen && <TextLink href="/signup">Create an account</TextLink>}<TextLink href="/login">Sign in to your workspace</TextLink></div>}
          </article>
        ))}
      </div>
    </section>
  </>
}

const controls: [GlyphName, string, string][] = [
 ['users', 'Account access', `The internal dashboard uses Supabase Auth. ${signupOpen ? 'Anyone can create an account through sign-up; an account sees only the workspaces it belongs to.' : 'Current accounts are administrator-provisioned.'} Signing out removes access to the private dashboard; public marketing and inquiry pages remain available.`],
 ['database', 'Record isolation', 'Database row-level security and role-checked database functions limit each workspace’s records to its members. Workspaces have owner, admin and member roles. Inviting teammates is not available yet.'],
 ['shield', 'Protected inquiry intake', 'Public submissions go through an Edge Function with input validation, Turnstile checks, and quotas. The public form does not receive permission to read private leads. Duplicate request IDs help prevent duplicate records.'],
 ['key', 'Server-side credentials', 'Privileged Supabase, Turnstile, and email credentials remain server-side. Server integrations use scoped tokens stored as hashes, with revocation and rotation. Browser code uses public configuration only.'],
 ['layers', 'Persistence and delivery', 'Lead data is stored in Supabase PostgreSQL. Notification delivery uses a separate queue so email failures do not delete leads. Operational monitoring and retry-worker configuration remain necessary.'],
 ['sparkles', 'Business reports', 'Business reports read only a lead’s public web pages. Every address is checked before it is fetched, and private or internal networks are refused. LeadFlow does not log in, solve CAPTCHAs, or get around bot protection. Page facts and short text excerpts are sent to Google Gemini to write the summary, and website text is treated as data, so instructions hidden in a page can’t change the report. Provider keys stay on the server.'],
 ['mail', 'Contacts and outreach drafts', 'Contacts come only from a business’s own public pages (respecting robots.txt), its business report, the lead record and, optionally, your Apollo account. Email addresses are never guessed, and each detail keeps its source. A deleted contact is remembered only as a hash, so it isn’t collected again. Drafts pass website text to Gemini as data, every claim must cite a finding, and LeadFlow never sends a message: you do.'],
 ['info', 'Limits and responsibilities', 'Deployment configuration matters. This site does not claim SOC 2, ISO certification, GDPR compliance, an independent audit, or guaranteed uptime. Retention, exports, deletion requests, backup verification, and incident procedures require operator policies and operational work. Activity history is not an immutable security log.'],
]

export function Security() {
  return <>
    <Intro eyebrow="Security" title={<>Public inquiries. <em>Private lead records.</em></>}
      text="A plain-language account of the current implementation. These are architectural controls, not a claim of certification or an independent security audit." />
    <section className="mk-wrap mk-section mk-section-flush">
      <div className="mk-sec">
        <aside className="mk-sec-aside mk-dark">
          <span className="mk-card-icon"><Glyph name="shield" size={22} /></span>
          <h2>Trust starts with specifics.</h2>
          <p>We explain both the controls in place and the work that remains.</p>
          <TextLink href="/faq">Common questions</TextLink>
        </aside>
        <div className="mk-sec-grid">
          {controls.map(([icon, title, text]) => (
            <article key={title} className={title === 'Business reports' || title === 'Limits and responsibilities' ? 'is-wide' : ''} data-reveal>
              <span className="mk-card-icon"><Glyph name={icon} size={20} /></span>
              <h2>{title}</h2>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </div>
      <Note title="Data minimization matters." icon="lock">Use lead records for business contact details and inquiry context. Do not submit passwords, payment details, or sensitive personal information. {signupOpen ? 'Contact us if you have specific data requirements.' : 'Discuss your data requirements before requesting access.'}</Note>
    </section>
  </>
}
