import { signupOpen } from './access'
export const marketingPages = {
 '/': { title: 'LeadFlow — Good conversations deserve a follow-up.', description: 'Capture website inquiries, understand each business with a website report, and keep the next follow-up in sight. A focused workspace for service businesses.' },
 '/features': { title: 'Features — LeadFlow', description: 'Lead records, business reports with evidence-backed findings, opportunities matched to your services, CSV import, follow-up tasks, and activity history.' },
 '/integrations': { title: 'Integrations — LeadFlow', description: 'Hosted forms, website embeds, WordPress installation, and authenticated HTTP workflows.' },
 '/solutions': { title: 'Solutions — LeadFlow', description: 'Practical lead management for agencies, consultants, service businesses, and small teams.' },
 '/pricing': { title: 'Pricing direction — LeadFlow', description: 'Explore proposed plans. Pricing, packaging, team access, and billing are not yet finalized.' },
 '/resources': { title: 'Resources — LeadFlow', description: 'Practical guides to capturing inquiries, keeping a useful pipeline, and following up.' },
 '/faq': { title: 'Frequently asked questions — LeadFlow', description: 'Answers about features, access, integrations, notifications, and planned capabilities.' },
 '/security': { title: 'Security — LeadFlow', description: 'Understand current authentication, account isolation, protected intake, and security limitations.' },
} as const
export type MarketingPath = keyof typeof marketingPages
export const faqs = [
 ['What does LeadFlow do?', 'LeadFlow brings inquiries, lead details, pipeline status, follow-up tasks, and activity history into one focused workspace. Before you reach out, a business report shows what a lead’s website is missing and which of your services could help. It is built for the work between a first hello and a client decision.'],
 ['Can I sign up and start immediately?', signupOpen ? 'Yes. Create an account with your email address, confirm it if asked, and name your first workspace. Existing users can sign in.' : 'Not yet. Accounts are currently provisioned by an administrator. Request access through our inquiry form; submitting a request does not create an account or guarantee availability. Existing users can sign in.'],
 ['What is a business report?', 'Open a lead that has a website and choose Business report. LeadFlow reads up to ten of its public pages, checks SEO basics, contact and booking options, measures speed with Google PageSpeed Insights, detects the tools the site runs on, and uses Google Gemini to summarize what the business does. Findings are then matched to the services you list in Settings. It usually takes one to three minutes.'],
 ['Can I use my existing website?', 'Yes. Share the hosted inquiry page or embed it with an iframe. The Integrations hub includes HTML, WordPress, and React instructions. Your website must permit the embed, and the form host needs the correct security configuration.'],
 ['Can I trust what the report says?', 'Every finding links to the evidence it rests on and is labelled observed, measured, AI interpretation, or hypothesis. “Not found” means not found on the pages analyzed, so those findings are never marked high confidence. AI interpretations are suggestions to check, and your team can mark any finding confirmed or not accurate. Reports describe what could help; they don’t promise results.'],
 ['Are Zapier, Make, and n8n connected natively?', 'They are documented HTTP workflows, not native connectors or OAuth integrations. An administrator must configure a workspace-scoped API credential, and the workflow must be tested in your platform. Platform plans and limits may apply.'],
 ['Can my team share a workspace?', 'Workspaces have owner, admin, and member roles, and each workspace’s records are visible only to its members. Inviting teammates from the app is planned; today members are added by an administrator. Do not share account credentials as a substitute for team access.'],
 ['Does LeadFlow send email or WhatsApp follow-ups?', 'Configured new inquiries can notify the business by email through Resend. Follow-up tasks are reminders inside the workspace; LeadFlow does not currently send automated client follow-ups, WhatsApp messages, or SMS.'],
 ['Is my data saved when I close the browser?', 'Yes. Lead records, tasks, and history are stored in Supabase PostgreSQL. The dashboard loads saved data after sign-in. Refresh retrieves new submissions and changes from other sessions.'],
 ['What does LeadFlow cost?', 'Pricing and packaging are not finalized. The pricing page presents a proposed direction, not a purchasable subscription. There is currently no checkout or paid billing flow.'],
 ['Can I import my existing leads?', 'Yes. Import a CSV file in Lead discovery: LeadFlow checks every row, skips duplicates of leads you already have, and shows what was imported. You can also add businesses by hand with their website and location. A general export of your leads is not available yet.'],
 ['Is LeadFlow a complete CRM?', 'It is a focused lead-management tool. Two-way CRM sync, advanced reporting, billing, shared workspaces, and granular team roles are not implemented.'],
] as const
export const featureCards = [
 { icon:'users', title:'Every inquiry, with context.', text:'Keep contact details, service interest, source, and message together. Pick up the conversation without reconstructing it.' },
 { icon:'grid', title:'A pipeline you can read.', text:'Move leads through New, Contacted, Qualified, Converted, and Lost. Search and filter when you need a closer look.' },
 { icon:'calendar', title:'A clear next step.', text:'Schedule follow-up tasks, see what is due, and mark work complete. Reopen a task when the conversation needs another touch.' },
 { icon:'clock', title:'Remember the conversation.', text:'Review activity history alongside each lead. See status changes and follow-up events in context.' },
 { icon:'arrow', title:'A front door for your website.', text:'Use a hosted form or an embed to collect structured inquiries. Required fields and verification protect the submission flow.' },
 { icon:'bell', title:'Know when an inquiry arrives.', text:'With Resend configured, a new inquiry can notify your business inbox. A delivery failure does not erase the lead.' },
 { icon:'search', title:'Know the business first.', text:'Run a business report on a lead’s website: SEO basics, contact and booking options, speed, and the tools it runs on, each finding linked to its evidence.' },
 { icon:'spark', title:'Opportunities you can act on.', text:'Findings are matched to the services you sell, with a reason, a possible benefit, and a next step. Accept, dismiss, or verify each one.' },
 { icon:'plus', title:'Bring the leads you have.', text:'Import a CSV file with duplicate checks, or add businesses by hand with their website and location.' },
] as const
