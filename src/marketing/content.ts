import { signupOpen } from './access'
import type { GlyphName } from './Glyph'

export const marketingPages = {
 '/': { title: 'LeadFlow — Know what every lead needs before the first call', description: 'LeadFlow finds businesses worth talking to, analyzes their website with AI, matches what they’re missing to the services you sell, and keeps every follow-up on track.' },
 '/features': { title: 'Features — LeadFlow', description: 'Lead discovery, Apollo search, CSV import, AI business reports with evidence-backed findings, opportunities matched to your services, follow-ups and client onboarding.' },
 '/integrations': { title: 'Integrations — LeadFlow', description: 'Hosted forms, website embeds, WordPress installation, authenticated HTTP workflows, and the data sources behind lead discovery and business reports.' },
 '/solutions': { title: 'Solutions — LeadFlow', description: 'How agencies, consultants, service businesses and small teams use LeadFlow to find, understand and follow up with prospects.' },
 '/pricing': { title: 'Pricing direction — LeadFlow', description: 'Explore proposed plans. Pricing, packaging, team access, and billing are not yet finalized.' },
 '/resources': { title: 'Resources — LeadFlow', description: 'Practical guides to capturing inquiries, reading business reports, keeping a useful pipeline, and following up.' },
 '/faq': { title: 'Frequently asked questions — LeadFlow', description: 'Answers about features, access, business reports, integrations, notifications, and planned capabilities.' },
 '/security': { title: 'Security — LeadFlow', description: 'Understand current authentication, account isolation, protected intake, business report safeguards, and security limitations.' },
} as const
export type MarketingPath = keyof typeof marketingPages

export const faqs = [
 ['What does LeadFlow do?', 'LeadFlow helps agencies and service businesses find prospects, understand them, and follow up. Find businesses through a directory search, Apollo or a CSV import. Run a business report that shows what a lead’s website is missing and which of your services could help. Then keep the pipeline moving with statuses, follow-up tasks and activity history.'],
 ['How does LeadFlow find new leads?', 'Three ways. Search a business directory by industry and up to three locations, once your deployment’s directory servers are set up. Search people and companies through Apollo with your own Apollo API key. Or import a CSV file. Each imported lead records where it came from, and possible duplicates are flagged before import.'],
 ['What is a business report?', 'Open a lead that has a website and choose Business report. LeadFlow reads up to ten of its public pages, checks SEO basics, contact and booking options, measures speed with Google PageSpeed Insights, detects the tools the site runs on, and uses Google Gemini to summarize what the business does. Findings are then matched to the services you list in Settings. It usually takes one to three minutes.'],
 ['Can I trust what the report says?', 'Every finding links to the evidence it rests on and is labelled observed, measured, AI interpretation, or hypothesis. “Not found” means not found on the pages analyzed, so those findings are never marked high confidence. AI interpretations are suggestions to check, and your team can mark any finding confirmed or not accurate. Reports describe what could help; they don’t promise results.'],
 ['Can I sign up and start immediately?', signupOpen ? 'Yes. Create an account with your email address, confirm it if asked, and name your first workspace. Existing users can sign in.' : 'Not yet. Accounts are currently provisioned by an administrator. Request access through our inquiry form; submitting a request does not create an account or guarantee availability. Existing users can sign in.'],
 ['Can I use my existing website?', 'Yes. Share the hosted inquiry page or embed it with an iframe. The Integrations hub includes HTML, WordPress, and React instructions. Your website must permit the embed, and the form host needs the correct security configuration.'],
 ['Are Zapier, Make, and n8n connected natively?', 'They are documented HTTP workflows, not native connectors or OAuth integrations. An administrator must configure a workspace-scoped API credential, and the workflow must be tested in your platform. Platform plans and limits may apply.'],
 ['Can my team share a workspace?', 'Workspaces have owner, admin, and member roles, and each workspace’s records are visible only to its members. Inviting teammates from the app is planned; today members are added by an administrator. Do not share account credentials as a substitute for team access.'],
 ['Does LeadFlow send email or WhatsApp follow-ups?', 'Configured new inquiries can notify the business by email through Resend. Follow-up tasks are reminders inside the workspace; LeadFlow does not currently send automated client follow-ups, WhatsApp messages, or SMS.'],
 ['Is my data saved when I close the browser?', 'Yes. Lead records, tasks, and history are stored in Supabase PostgreSQL. The dashboard loads saved data after sign-in. Refresh retrieves new submissions and changes from other sessions.'],
 ['What does LeadFlow cost?', 'Pricing and packaging are not finalized. The pricing page presents a proposed direction, not a purchasable subscription. There is currently no checkout or paid billing flow.'],
 ['Can I import my existing leads?', 'Yes. Import a CSV file in Lead discovery: LeadFlow checks every row, skips duplicates of leads you already have, and shows what was imported. You can also add businesses by hand with their website and location. A general export of your leads is not available yet.'],
 ['Is LeadFlow a complete CRM?', 'It is a focused prospecting and lead-management tool. Two-way CRM sync, advanced reporting, billing, team invitations, and granular team permissions are not implemented.'],
] as const

/** Availability vocabulary used across the site. Keep labels factual: "available" means implemented in the app. */
export type StatusKind = 'available' | 'setup' | 'beta' | 'planned' | 'off'

export const capabilities: { icon: GlyphName; title: string; text: string; status?: [StatusKind, string]; size: 'lg' | 'md' | 'sm' }[] = [
 { icon: 'compass', size: 'lg', title: 'Search a business directory', text: 'Find businesses by industry or niche across up to three US, UK or Australian locations. Every result shows its source, data freshness and whether it’s already in your leads.', status: ['setup', 'Needs setup'] },
 { icon: 'users', size: 'sm', title: 'People and companies from Apollo', text: 'Search with your own Apollo key. See the credit cost before every reveal, with each credit tracked in a ledger.', status: ['setup', 'Your Apollo key'] },
 { icon: 'upload', size: 'sm', title: 'Bring the leads you have', text: 'Import a CSV with automatic column matching, row-by-row validation and duplicate review.' },
 { icon: 'calendar', size: 'sm', title: 'Follow-ups that don’t slip', text: 'Five clear statuses, tasks with due dates, and the full history of every lead in one place.' },
 { icon: 'globe', size: 'sm', title: 'A front door for your website', text: 'A hosted inquiry page or an embed for HTML, WordPress and React, with verification and email alerts.' },
 { icon: 'clipboard', size: 'md', title: 'Client onboarding', text: 'Checklists for paid ads, SEO, social and email marketing. Share one private, expiring link, review what the client sends, and see readiness before kickoff.', status: ['beta', 'Beta'] },
 { icon: 'code', size: 'md', title: 'An API for your stack', text: 'Send leads from Zapier, Make, n8n or your own server with scoped, revocable tokens. Retries never create duplicates.' },
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
 ['CSV lead import with duplicate review', 'available', 'Available', ''],
 ['Workspace roles (owner, admin, member)', 'available', 'Available', ''],
 ['Business directory search', 'setup', 'Needs setup', 'Your deployment configures the directory servers'],
 ['Apollo people and company search', 'setup', 'Needs setup', 'Your own Apollo API key; Apollo credits apply'],
 ['Website capture and inbound API', 'setup', 'Needs setup', 'Configuration required'],
 ['Client onboarding portal', 'beta', 'Beta', ''],
 ['Team invitations and lead assignment', 'planned', 'Planned', ''],
 ['Subscriptions and billing', 'off', 'Not available', ''],
]
