export const marketingPages = {
 '/': { title: 'LeadFlow — Good conversations deserve a follow-up.', description: 'Capture website inquiries, organize your leads, and keep the next follow-up in sight. A focused workspace for service businesses.' },
 '/features': { title: 'Features — LeadFlow', description: 'Lead records, pipeline statuses, follow-up tasks, and activity history for service businesses.' },
 '/integrations': { title: 'Integrations — LeadFlow', description: 'Hosted forms, website embeds, WordPress installation, and authenticated HTTP workflows.' },
 '/solutions': { title: 'Solutions — LeadFlow', description: 'Practical lead management for agencies, consultants, service businesses, and small teams.' },
 '/pricing': { title: 'Pricing direction — LeadFlow', description: 'Explore proposed plans. Pricing, packaging, team access, and billing are not yet finalized.' },
 '/resources': { title: 'Resources — LeadFlow', description: 'Practical guides to capturing inquiries, keeping a useful pipeline, and following up.' },
 '/faq': { title: 'Frequently asked questions — LeadFlow', description: 'Answers about features, access, integrations, notifications, and planned capabilities.' },
 '/security': { title: 'Security — LeadFlow', description: 'Understand current authentication, account isolation, protected intake, and security limitations.' },
 '/signup': { title: 'Request access — LeadFlow', description: 'Accounts are administrator-provisioned. Request access or sign in to an existing workspace.' },
} as const
export type MarketingPath = keyof typeof marketingPages
export const faqs = [
 ['What does LeadFlow do?', 'LeadFlow brings inquiries, lead details, pipeline status, follow-up tasks, and activity history into one focused workspace. It is built for the work between a first hello and a client decision.'],
 ['Can I sign up and start immediately?', 'Not yet. Accounts are currently provisioned by an administrator. Request access through our inquiry form; submitting a request does not create an account or guarantee availability. Existing users can sign in.'],
 ['Can I use my existing website?', 'Yes. Share the hosted inquiry page or embed it with an iframe. The Integrations hub includes HTML, WordPress, and React instructions. Your website must permit the embed, and the form host needs the correct security configuration.'],
 ['Are Zapier, Make, and n8n connected natively?', 'They are documented HTTP workflows, not native connectors or OAuth integrations. An administrator must configure a workspace-scoped API credential, and the workflow must be tested in your platform. Platform plans and limits may apply.'],
 ['Can my team share a workspace?', 'Shared workspaces, team invitations, and role-based collaboration are planned. Today each signed-in account has its own isolated records. Do not share account credentials as a substitute for team access.'],
 ['Does LeadFlow send email or WhatsApp follow-ups?', 'Configured new inquiries can notify the business by email through Resend. Follow-up tasks are reminders inside the workspace; LeadFlow does not currently send automated client follow-ups, WhatsApp messages, or SMS.'],
 ['Is my data saved when I close the browser?', 'Yes. Lead records, tasks, and history are stored in Supabase PostgreSQL. The dashboard loads saved data after sign-in. Refresh retrieves new submissions and changes from other sessions.'],
 ['What does LeadFlow cost?', 'Pricing and packaging are not finalized. The pricing page presents a proposed direction, not a purchasable subscription. There is currently no checkout or paid billing flow.'],
 ['Can I bring my earlier demo data?', 'The app can explicitly import valid records from its earlier browser demo when the database workspace is empty. It does not silently replace existing data. General CSV imports and exports are not part of the current interface.'],
 ['Is LeadFlow a complete CRM?', 'It is a focused lead-management tool. Two-way CRM sync, advanced reporting, billing, shared workspaces, and granular team roles are not implemented.'],
] as const
export const featureCards = [
 { icon:'users', title:'Every inquiry, with context.', text:'Keep contact details, service interest, source, and message together. Pick up the conversation without reconstructing it.' },
 { icon:'grid', title:'A pipeline you can read.', text:'Move leads through New, Contacted, Qualified, Converted, and Lost. Search and filter when you need a closer look.' },
 { icon:'calendar', title:'A clear next step.', text:'Schedule follow-up tasks, see what is due, and mark work complete. Reopen a task when the conversation needs another touch.' },
 { icon:'clock', title:'Remember the conversation.', text:'Review activity history alongside each lead. See status changes and follow-up events in context.' },
 { icon:'arrow', title:'A front door for your website.', text:'Use a hosted form or an embed to collect structured inquiries. Required fields and verification protect the submission flow.' },
 { icon:'bell', title:'Know when an inquiry arrives.', text:'With Resend configured, a new inquiry can notify your business inbox. A delivery failure does not erase the lead.' },
] as const
