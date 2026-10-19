# LeadFlow product overview

Updated: 19 October 2026, M5. This file did not previously exist in this checkout. It separates shipped implementation from a proposed product direction; it does not authorize new development.

## Product today

LeadFlow is a focused lead-management application with a public marketing website. Internal users sign in through Supabase Auth, capture/edit leads, manage statuses and follow-up tasks, and review history. PostgreSQL is the primary data store. Public inquiries use an Edge Function with validation, Turnstile and quotas; business notifications use Resend with a durable outbox. An inbound lead endpoint supports administrator-provisioned, owner-scoped bearer credentials.

The public website is `/`; private workspace entry is `/app` or `/login`. `/signup` is an invitation/access inquiry, not self-service account creation. `/inquiry` is a real configured form. The integrations directory provides shared form/embed methods, HTTP setup guides and receipt evidence, not 13 native connected applications.

Each account has isolated records. There are no shared agency memberships/roles, client portal, subscription billing, contract/payment lifecycle, asset collection or general automation engine. Follow-ups are tasks for a person; they are not automatic client messages. Activity history is not an immutable audit log. Current pricing page packaging is provisional. The [audit](docs/M5-AUDIT.md) records verified behavior and production limits.

## Two business goals, measured separately

1. **Promptly implementation credibility:** demonstrate a real UI, persistent database, access boundaries, input validation, integrations, duplicate-safe intake and recoverable notifications. Potential future evidence includes attributable implementation inquiries and paid project outcomes. No client-acquisition result is claimed yet.
2. **Repeatable SaaS:** earn continuing payment for a standardized recurring job with manageable support costs. No paid LeadFlow demand, retention, or finalized subscription price has been established. Implementation revenue must not be counted as subscription revenue.

## M5 decision

Keep the current product working and use it as Promptly's portfolio/implementation asset. Investigate **website kickoff readiness** for 2–10-person web-design agencies with repeated project starts and missing client content. The proposed workflow collects brief answers and asset links, tracks agency acceptance, reminds clients about missing items and marks a request ready for handoff.

This recommendation narrows the original broad “signed client to project delivery” hypothesis. It does not approve rebuilding LeadFlow as an onboarding suite. [Research and comparison](docs/M5-RESEARCH.md) finds recurring content delays but strong substitutes, especially Content Snare and Onthen. The hypothesized advantage is a preconfigured website-specific process with visible exceptions and low setup burden; that advantage is **not validated**. Existing-tool implementation may be the better business.

## Intended first customer, if validated

An agency owner/project coordinator who delivers repeatable marketing websites, uses email and existing asset folders, and regularly reconciles missing information manually. At least two project starts per month is a proposed screening threshold, not a market finding. Agencies needing shared employee access, complex procurement, ad-account permission acquisition, creative proofing or an all-in-one CRM are outside the first slice.

## Proposed positioning — internal draft only

Possible hypothesis statement: “Help small web-design agencies see what is missing before kickoff, collect it in one place, and hand over a reviewed brief.” It must be presented as a workflow under investigation until implemented and verified. Do not publish “automatically starts your projects,” time-saving percentages, customer logos, a subscription price, or availability claims from M5.

If approved later, preserve the current visual system and routes. Explain the narrow use case on Home/Solutions, distinguish current lead management from the new capability on Features, describe only the supported method on Integrations, and keep future functionality marked. Keep existing access-request/sign-in links; do not invent a Connect or checkout flow.

## Scope boundaries

Preserve current leads, forms, follow-ups, history, owner isolation, sample/import/reset workflows, integration API, notification queue and marketing site. A new workflow would be additive. No AI, billing, broad OAuth catalog, general automation builder, reporting suite, file-hosting service, password collection, or multi-tenant rewrite is part of M5 or the proposed initial MVP.

Next decision is whether the narrow readiness workflow beats configured substitutes for a real target customer. [Go/no-go rules](docs/M5-RESEARCH.md#evidence-gates-and-next-decision) and [M6/M7 gates](DEVELOPMENT_ROADMAP.md) govern that choice. Until approved, public positioning and application behavior remain unchanged.
