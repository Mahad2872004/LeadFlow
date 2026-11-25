import { signupOpen } from './access'
import type { GlyphName } from './Glyph'

export const marketingPages = {
 '/': { title: 'LeadFlow — Know what every lead needs before the first call', description: 'LeadFlow finds businesses worth talking to, analyzes their website with AI, drafts outreach you review, tracks every deal to won, then onboards the client and delivers the project, in one workspace.' },
 '/features': { title: 'Features — LeadFlow', description: 'Lead discovery, AI business reports with evidence-backed findings, contact discovery and outreach drafts, a sales pipeline, client onboarding with a private client link, and project delivery with milestones, tasks, timelines and health.' },
 '/integrations': { title: 'Integrations — LeadFlow', description: 'Hosted forms, website embeds, WordPress installation, authenticated HTTP workflows, and the data sources behind lead discovery and business reports.' },
 '/solutions': { title: 'Solutions — LeadFlow', description: 'How agencies, consultants, service businesses and small teams use LeadFlow to find prospects, win the work, onboard clients and deliver projects.' },
 '/pricing': { title: 'Pricing direction — LeadFlow', description: 'Explore proposed plans. Pricing, packaging, team access, and billing are not yet finalized.' },
 '/resources': { title: 'Resources — LeadFlow', description: 'Practical guides to capturing inquiries, reading business reports, keeping a useful pipeline, following up, and moving a won client into delivery.' },
 '/faq': { title: 'Frequently asked questions — LeadFlow', description: 'Answers about features, access, business reports, contacts and outreach drafts, deals, client onboarding, projects, integrations, and planned capabilities.' },
 '/security': { title: 'Security — LeadFlow', description: 'Understand current authentication, account isolation, protected intake, business report, outreach, client link and project safeguards, and security limitations.' },
} as const
export type MarketingPath = keyof typeof marketingPages

export const faqs = [
 ['What does LeadFlow do?', 'LeadFlow helps agencies and service businesses find prospects, win the work and deliver it. Find businesses through a directory search, Apollo or a CSV import. Run a business report that shows what a lead’s website is missing and which of your services could help. Find the lead’s public contacts, prepare an email, WhatsApp or LinkedIn draft based on the report, and send it yourself. Track the conversation as a deal until it is won or lost. Then convert the won deal into a client, run their onboarding through one private link, and deliver the work as a project with milestones, tasks and a timeline.'],
 ['How does LeadFlow find new leads?', 'Three ways. Search a business directory by industry and up to three locations, once your deployment’s directory servers are set up. Search people and companies through Apollo with your own Apollo API key. Or import a CSV file. Each imported lead records where it came from, and possible duplicates are flagged before import.'],
 ['What is a business report?', 'Open a lead that has a website and choose Business report. LeadFlow reads up to ten of its public pages, checks SEO basics, contact and booking options, measures speed with Google PageSpeed Insights, detects the tools the site runs on, and uses Google Gemini to summarize what the business does. Findings are then matched to the services you list in Settings. It usually takes one to three minutes.'],
 ['What happens after a deal is won?', 'Mark the deal won with its final value and close date, then choose Convert to client. One review carries over the contacts, the agreed services and, if you want, an onboarding checklist, in a single step. Your client gets one private link to fill in forms, upload files and read the confirmed scope, with no account to create. You confirm the scope as a dated record, which is not a contract or signature, and write a welcome message that you send yourself. When onboarding is complete, its confirmed scope is the starting point for a project.'],
 ['How do projects work?', 'Create a project from a completed onboarding (it starts from the confirmed scope only), from a client, or by hand, optionally from one of three starter templates or your own. Plan milestones and deliverables, and work the tasks on a board with dependencies that can’t loop. A Gantt-style timeline and a deadline calendar show what’s coming. Progress counts completed deliverables, or tasks when there are none, never a mix of both. Health is On track, At risk, Delayed or On hold, from written rules that show their reasons. Project files and notes stay internal. A client project portal, approvals, time tracking and invoicing are not available.'],
 ['Does the AI change my project?', 'No. The optional AI project assistant can summarize a project, point out risks, draft a plan or break a deliverable into tasks, using only what is recorded in the project. Everything it returns is a suggestion: nothing is added or changed until a person approves it. Client and project text is sent to Google Gemini as data, not as instructions. It needs your deployment’s Gemini key, monthly limits apply, and projects work fully without it.'],
 ['Can I trust what the report says?', 'Every finding links to the evidence it rests on and is labelled observed, measured, AI interpretation, or hypothesis. “Not found” means not found on the pages analyzed, so those findings are never marked high confidence. AI interpretations are suggestions to check, and your team can mark any finding confirmed or not accurate. Reports describe what could help; they don’t promise results.'],
 ['How does LeadFlow find a lead’s contacts?', 'Open a lead and choose Contacts. LeadFlow reads the business’s own public pages (its contact, team and about pages, and the business report), respecting robots.txt, and lists published email addresses, phone numbers, WhatsApp links and people named with a job title. If your workspace uses Apollo, you can also look up decision-makers. Every detail shows where it came from, an honest email status (only a provider can mark an email verified) and a confidence level with its reasons. LeadFlow never guesses email addresses, and details your team confirmed or edited are never overwritten.'],
 ['Can I sign up and start immediately?', signupOpen ? 'Yes. Create an account with your email address, confirm it if asked, and name your first workspace. Existing users can sign in.' : 'Not yet. Accounts are currently provisioned by an administrator. Request access through our inquiry form; submitting a request does not create an account or guarantee availability. Existing users can sign in.'],
 ['Can I use my existing website?', 'Yes. Share the hosted inquiry page or embed it with an iframe. The Integrations hub includes HTML, WordPress, and React instructions. Your website must permit the embed, and the form host needs the correct security configuration.'],
 ['Are Zapier, Make, and n8n connected natively?', 'They are documented HTTP workflows, not native connectors or OAuth integrations. An administrator must configure a workspace-scoped API credential, and the workflow must be tested in your platform. Platform plans and limits may apply.'],
 ['Can my team share a workspace?', 'Workspaces have owner, admin, and member roles, and each workspace’s records are visible only to its members. Inviting teammates from the app is planned; today members are added by an administrator. Do not share account credentials as a substitute for team access.'],
 ['Does LeadFlow send emails or WhatsApp messages for me?', 'No. LeadFlow prepares email, WhatsApp and LinkedIn drafts based on the business report. Every statement about the business is linked to a finding, and drafts that claim more than the evidence shows are refused. You edit the draft, copy it or open it in your own email or WhatsApp, and mark it as sent yourself. A new client’s welcome message works the same way. Follow-ups are reminders in your workspace, never scheduled sends. Separately, configured new inquiries can notify your business by email.'],
 ['Is my data saved when I close the browser?', 'Yes. Lead records, tasks, and history are stored in Supabase PostgreSQL. The dashboard loads saved data after sign-in. Refresh retrieves new submissions and changes from other sessions.'],
 ['What does LeadFlow cost?', 'Pricing and packaging are not finalized. The pricing page presents a proposed direction, not a purchasable subscription. There is currently no checkout or paid billing flow.'],
 ['Can I import my existing leads?', 'Yes. Import a CSV file in Lead discovery: LeadFlow checks every row, skips duplicates of leads you already have, and shows what was imported. You can also add businesses by hand with their website and location. A general export of your leads is not available yet.'],
 ['Is LeadFlow a complete CRM?', 'It covers prospecting, a sales pipeline, client onboarding and project delivery in one workspace, but it is not a full CRM or agency suite. Two-way CRM sync, invoicing, time tracking, billing, team invitations, and granular team permissions are not implemented.'],
] as const

/** Availability vocabulary used across the site. Keep labels factual: "available" means implemented in the app. */
export type StatusKind = 'available' | 'setup' | 'beta' | 'planned' | 'off'

// Ordered and sized so the grid has no gaps. Six columns (lg 4, md 3, sm 2): 4+2 · 2+4 · 3+3 · 4+2 · 2+2+2.
// Two columns (lg spans both, md and sm one each): lg · sm sm · lg · md md · lg · sm sm · sm sm. One column below 640 px.
export type CapabilityId = 'directory' | 'apollo' | 'csv' | 'outreach' | 'pipeline' | 'clients' | 'projects' | 'assistant' | 'followups' | 'api' | 'website'
export const capabilities: { id: CapabilityId; icon: GlyphName; title: string; text: string; status?: [StatusKind, string]; size: 'lg' | 'md' | 'sm' }[] = [
 { id: 'directory', icon: 'compass', size: 'lg', title: 'Search a business directory', text: 'Find businesses by industry or niche across up to three US, UK or Australian locations. Every result shows its source, data freshness and whether it’s already in your leads.', status: ['setup', 'Needs setup'] },
 { id: 'apollo', icon: 'users', size: 'sm', title: 'People and companies from Apollo', text: 'Search with your own Apollo key. See the credit cost before every reveal, with each credit tracked in a ledger.', status: ['setup', 'Your Apollo key'] },
 { id: 'csv', icon: 'upload', size: 'sm', title: 'Bring the leads you have', text: 'Import a CSV with automatic column matching, row-by-row validation and duplicate review.' },
 { id: 'outreach', icon: 'mail', size: 'lg', title: 'Contacts and outreach drafts', text: 'Find the public contacts behind a lead, each with its source and an honest email status. Then draft an email, WhatsApp or LinkedIn message based on what the report found. You review and send it; LeadFlow never does.' },
 { id: 'pipeline', icon: 'kanban', size: 'md', title: 'A sales pipeline that stays honest', text: 'Deals from leads, report opportunities or sent outreach, on a board you can drive with a keyboard. Won and lost with reasons, meetings and calls, and analytics per currency.' },
 { id: 'clients', icon: 'clipboard', size: 'md', title: 'Client workspace and onboarding', text: 'Convert a won deal in one review. Onboarding stages, forms and file uploads through one private client link, a confirmed scope on record, and readiness before kickoff.' },
 { id: 'projects', icon: 'briefcase', size: 'lg', title: 'Projects and delivery', text: 'Start from the confirmed scope of a completed onboarding. Milestones, deliverables, a task board with dependencies, a timeline and a calendar, with progress and health computed from written rules.', status: ['available', 'New'] },
 { id: 'assistant', icon: 'sparkles', size: 'sm', title: 'AI project assistant', text: 'Summaries, risks, plans and task breakdowns from recorded facts. Suggestions only, until you approve them.', status: ['setup', 'Needs setup'] },
 { id: 'followups', icon: 'calendar', size: 'sm', title: 'Follow-ups that don’t slip', text: 'Tasks with due dates, types and assignees, reminders after you send a message, and the full history of every lead.' },
 { id: 'api', icon: 'code', size: 'sm', title: 'An API for your stack', text: 'Send leads from Zapier, Make, n8n or your own server with scoped, revocable tokens. Retries never create duplicates.' },
 { id: 'website', icon: 'globe', size: 'sm', title: 'A front door for your website', text: 'A hosted inquiry page or an embed for HTML, WordPress and React, with verification and email alerts.' },
]

export const evidenceLabels = [
 { kind: 'observed', label: 'Observed', title: 'Seen on the site.', text: 'Read directly from the website’s pages or files.' },
 { kind: 'measured', label: 'Measured', title: 'Numbers from a tool.', text: 'Measured by a tool such as PageSpeed Insights.' },
 { kind: 'ai', label: 'AI interpretation', title: 'Helpful, never final.', text: 'Gemini’s reading of the evidence. A suggestion to check.' },
 { kind: 'hypothesis', label: 'Hypothesis', title: 'Ask, don’t assume.', text: 'A possibility worth asking about, not a fact.' },
] as const

export const reportChecks = ['SEO basics', 'Contact & booking', 'Speed & Core Web Vitals', 'Technology', 'Business summary'] as const

export const providers = ['Google Gemini', 'PageSpeed Insights', 'OpenStreetMap', 'Apollo.io', 'Resend', 'Supabase'] as const

export const featureStatus: [string, StatusKind, string, string][] = [
 ['Lead management, follow-up tasks and history', 'available', 'Available', ''],
 ['Business reports and opportunity matching', 'available', 'Available', 'Monthly analysis limits apply'],
 ['Contact discovery with sources and email status', 'available', 'Available', 'From public websites and business reports; Apollo optional'],
 ['AI outreach drafts for email, WhatsApp and LinkedIn', 'available', 'Available', 'You review and send every message; monthly limits apply'],
 ['Sales pipeline, deals and analytics', 'available', 'Available', 'Won and lost with reasons; currencies are never converted'],
 ['Client management and onboarding', 'available', 'Available', 'One private, expiring client link per checklist; you send the welcome message yourself'],
 ['Projects and delivery', 'available', 'New', 'Milestones, deliverables, task board, timeline, calendar, progress and health'],
 ['CSV lead import with duplicate review', 'available', 'Available', ''],
 ['Workspace roles (owner, admin, member)', 'available', 'Available', ''],
 ['Business directory search', 'setup', 'Needs setup', 'Your deployment configures the directory servers'],
 ['Apollo people and company search', 'setup', 'Needs setup', 'Your own Apollo API key; Apollo credits apply'],
 ['Website capture and inbound API', 'setup', 'Needs setup', 'Configuration required'],
 ['AI project assistant', 'setup', 'Needs setup', 'Your deployment’s Gemini key; monthly limits; suggestions need your approval'],
 ['Onboarding reminder emails', 'setup', 'Needs setup', 'A configured email provider and scheduler'],
 ['Team invitations and lead assignment', 'planned', 'Planned', ''],
 ['Client project portal and approvals', 'planned', 'Planned', 'Project files and notes are internal today'],
 ['Sending messages from LeadFlow', 'off', 'Not available', 'Drafts and welcome messages are copied or opened in your own email or WhatsApp'],
 ['Time tracking and invoicing', 'off', 'Not available', ''],
 ['Subscriptions and billing', 'off', 'Not available', ''],
]

/** Product facts shown with counters on the home page. Keep them true to the app (see docs/MARKETING.md). */
export const productFacts: [number, string][] = [
 [10, 'public pages read for each business report, by default'],
 [11, 'editable starter services to match findings against'],
 [8, 'default onboarding stages, renamed to fit your process'],
 [3, 'starter project templates, plus the ones you save'],
]
