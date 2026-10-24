# Marketing-agency onboarding research and product strategy

Research date: **21 October 2026**. Status: **research and recommendation only.** No application code, schema, migration, live configuration or production data was changed. This document revisits the segment choice in [M5 research](M5-RESEARCH.md) (19 October), which targeted web-design agencies. Read it with the [product overview](../PRODUCT_OVERVIEW.md) and [roadmap](../DEVELOPMENT_ROADMAP.md).

**Labels used throughout**
- **Fact:** read on a source page, or verified in this repository.
- **Inference:** our reasoning from facts.
- **Recommendation:** a proposal, not a decision or a result.

## 1. Executive summary and recommended decision

**Recommendation:**
- Do **not** build a general onboarding suite, an access-granting tool, or another asset-collection tool. All three are adequately served:
  - Leadsie and four cheaper rivals sell one-link ad and analytics access ([N01–N09](#n01)).
  - Content Snare is mature for content and asset collection ([N21–N22](#n21)).
  - GHL, HoneyBook, Dubsado and portal products bundle everything else ([M03, M07, M08](M5-RESEARCH.md#m03); [N33–N36](#n33)).
- The one problem worth testing is **launch readiness for small retainer marketing agencies**, starting with paid-media agencies. The question is: from the moment a client signs, what exactly is still blocking the first campaign, who owns each blocker, and when is the client genuinely ready to launch?

Today that answer is spread across five or more tools: a form, a file request, an access tool, a PM board and Zapier. Leadsie's own guide recommends that stack ([N05](#n05)).

**Proposed selling point (a hypothesis):** *"Know exactly what's stopping each new client's campaign from launching, and clear it without chasing."*

What would make it different:
- **Service-specific readiness requirements** for PPC, paid social, SEO and email.
- **One client link** covering inputs, asset links, access steps and scope confirmation. Access is completed in the platforms, or through the agency's existing access tool, and then **verified by the agency**.
- **Follow-ups that stop when items are accepted**, plus internal escalation.
- **A readiness board** showing every onboarding.

**What the evidence supports, and what it doesn't:**
- **Supported:**
  - The underlying jobs are real and recurring. Access is administrator-dependent and multi-step on every major platform ([N11–N15](#n11)), and a paid tool category exists around it.
  - Missing inputs and cross-tool handoffs recur in practitioner accounts ([R01–R06, R10](M5-RESEARCH.md#r01)).
  - Some general onboarding products are drifting up-market or away from this job ([N25–N30](#n25)).
- **Not supported:**
  - That a *combined readiness product* is wanted enough to pay for.
  - That agencies can't approximate it with ClickUp, Notion or GHL plus Zapier.
  - That it would be hard to copy.
  - First-hand, marketing-agency-specific complaint evidence is thin in this round: Reddit refused automated access, and most review pages returned 403.

**Decision:**
- Keep LeadFlow primarily as **Promptly's demonstration and delivery platform**.
- Pursue the readiness wedge **only through the validation gates in §12**. Validate with a workflow benchmark, a disclosed prototype and concierge delivery before any production build.
- If the gates fail, LeadFlow stays a demonstration product, and Promptly sells *configured onboarding systems* built on existing tools as services.

Confidence in the recommendation as the best of the options considered: **medium**. Confidence that it is a defensible SaaS business: **low** (unvalidated).

## 2. Repository findings and verified current capabilities

**Checked on 21 Oct 2026** at commit `29737a9` on `main`, with a clean working tree in sync with `origin/main`. These checks were run and all passed:
- `npm run lint`
- `npm run check:edge`
- `npm run test:db`
- `npm run test:m3`
- `npm run test:integrations`
- `npm run test:tenancy`
- `npm run build`
- `npx playwright test`: **28/28 passed** in development mode

In browser tests, Supabase Auth and HTTP are simulated, but every database call runs the real migration SQL in embedded PostgreSQL. Production-build browser tests last passed on 20 October; they weren't rerun today because no code changed.

**Hosted state (verified 20 October; see [MULTI-TENANCY.md](MULTI-TENANCY.md)):**
- All six migrations are live, and the catalog matches the files exactly. The CLI migration history is missing `202610200002` and `202610200003`, which were applied outside the CLI.
- The form-aware `submit-inquiry` function is deployed.
- The public site still serves the **previous frontend**: it has no workspace switcher or per-workspace form links yet.
- Hosted sign-up is closed.

| Area | Verified capability | Relevance to agency onboarding |
| --- | --- | --- |
| Leads, follow-ups, activity | Lead create/edit/status/search/filters, dated follow-up tasks, activity history. The whole workspace is saved as one snapshot (5,000 leads, 10,000 tasks, 20,000 history items). | A won lead is a natural trigger. Tasks have no assignee, dependency or recurrence. **New onboarding state must live outside the snapshot**, which deletes and reinserts leads on each save. |
| Workspaces and roles | Multiple workspaces per user. Owner/admin/member roles enforced in the database. Members can't remove records or rewrite history. Onboarding and a switcher exist (frontend not yet deployed). | Good tenancy base. **Team invitations are not built**, and a 2–20-person agency needs them before any team workflow is useful. |
| Public intake | Per-workspace form keys; Turnstile, origin allowlist, quotas, idempotent submissions. | The public-key pattern can be reused for **scoped client links**. That requires a new token model: per-onboarding, expiring and revocable. |
| Email | Durable outbox, leased retries, provider idempotency, per-workspace recipients. | Reusable for reminders. **No scheduler is installed:** the retry worker needs an external trigger, and reminders would need cron or a worker. The sender is deployment-wide, with no per-agency verified domain. |
| Integrations | Hashed per-workspace webhook credentials for inbound leads; a Zapier/Make/n8n guide hub. | Could receive "access completed" events (Leadsie offers one webhook trigger, [N02](#n02)). No outbound connectors and no OAuth. |
| Files | **None.** No storage buckets or file policies. | An asset upload feature would add storage, malware/size policy and retention work. Start with links to the client's own storage. |
| Client access | **None.** Only internal users sign in. | A client response surface is a new security boundary: token scope, revocation, enumeration resistance. |
| UI system | Panels, modals, forms with field-level errors, skeletons, toasts, responsive sidebar and switcher, a role-aware settings page. | Fully reusable. No new frontend stack needed. |
| Test harness | PGlite migration tests with Supabase default-grant emulation; a browser emulator running real RPC SQL per user; mutation-checked security suites. | Lowers the cost of proving new security boundaries. |

**What an onboarding workflow would newly require:**
- Onboarding tables outside the snapshot, linked to leads without cascading deletes.
- Templates and items with per-item review states.
- Scoped client tokens.
- A scheduler with cancellation-safe reminders.
- Team invitations.
- Possibly file storage.
- Optionally an inbound webhook mapping for access tools.

None of this needs a new paid service, but the scheduler and file storage add operational work.

## 3. Target customer

**Recommended first buyer (a hypothesis to validate):** the owner or head of client services at an **independent paid-media agency (PPC and/or paid social) with roughly 2–20 staff**. They sell monthly retainers, onboard **at least two new clients a month**, and currently piece together a Google Form or Typeform, shared folders, an access tool (Leadsie or manual instructions), a PM board (ClickUp, Asana or Notion) and email.

**Why paid media first (inference):**
- Readiness has **objective, checkable gates**: ad-account access at the right role, GA4/GTM access, conversion tracking verified, budget and targets confirmed. Practitioner guides treat these as week-one essentials ([N37, N38](#n37)).
- A clear "ready" definition is what lets a readiness product be more than a checklist.
- The job is frequent (every new retainer) and directly delays billable delivery.

**Adjacent markets, later:** SEO, social and email agencies, using the same model with different requirement packs. Web-design agencies (the M5 segment) are adjacent: Content Snare is strongest there, and their readiness is mostly about content, not access.

**Explicitly not first:**
- Enterprise or procurement-heavy onboarding (GUIDEcx and Rocketlane territory).
- Agencies wanting a full CRM or white-label SaaS (GHL territory).
- Productized "order-a-service" shops (ManyRequests, Wayfront).
- Solo freelancers with one or two clients a quarter: too little volume for a subscription ([R07](M5-RESEARCH.md#r07)).

**Market size: not established.** Aggregator counts for NAICS 54181 conflict, and the official Census size-class table wasn't retrieved ([N45](#n45)). Don't quote a market size from this research.

## 4. Evidence of onboarding problems

**Method and limits:**
- Searches and fetches were made on 21 October.
- **Reddit refused automated access** ("domains are not accessible to our user agent"), and most G2, Capterra, GetApp and Software Advice pages returned **403**.
- Several research tracks were stopped to keep the search compact: CRMs, PM/automation tools and market size. For those, this report reuses dated **19 October M5 evidence** (IDs R01–R18, M01–M14 in [M5-RESEARCH.md](M5-RESEARCH.md)) and labels it as such.
- Vendor content shows practice and positioning. It is not evidence of pain or demand.

**Pain patterns, ranked by evidence:**

| # | Pattern | Supporting evidence | Counterevidence / limits | Confidence |
| --- | --- | --- | --- | --- |
| P1 | **Access acquisition blocks launch.** Clients must be admins, find IDs, accept requests on each platform. Ownership disputes occur at churn. | Platform docs: only admins accept Google Ads links, one owning manager, GA4 admin-only, GTM lockout advice, stale Search Console owners, 7-day Business Profile restriction ([N11–N15](#n11)). Commercial category of 5+ tools ([N01–N09](#n01)), with Leadsie at 4.8 from 73 G2 reviews ([N04](#n04)). Practitioner guides: access is week-one; "still asking for a login in week three" means the account isn't being managed ([N37](#n37)). A practitioner sells a $29 access-request template ([N17](#n17)). An agency blog documents a former agency refusing transfer ([N16](#n16)). | Independent first-hand complaints were not retrieved today. Vendor case studies ([N06](#n06)) are curated. A "13% first-time GA request failure" figure appeared only second-hand ([N40](#n40)) and is **not used**. | **Medium** that it's real and recurring; frequency and cost per agency unknown. |
| P2 | **Missing or unusable client inputs and assets delay the start.** | Practitioner threads (web design) on missing copy and assets ([R01–R03](M5-RESEARCH.md#r01)). A digital marketer's Content Snare review ([R10](M5-RESEARCH.md#r10)). Content Snare reviewers value reminders: "not stuck sending follow-ups" ([N22](#n22)). | Strongest evidence is web design, not paid media. Well served by Content Snare. | **Medium** |
| P3 | **Fragmented, multi-tool onboarding and manual handoffs.** | r/agency practitioners describe HubSpot/Airtable/Zapier, HighLevel/Make, and Leadsie + Zapier stacks ([R04–R06](M5-RESEARCH.md#r04)). Leadsie's own guide prescribes a stack of 5+ tools ([N05](#n05)). Leadsie's Zapier fires only on completion and has no actions ([N02](#n02)). | The stacks *work*. Agencies have solved this with configuration ([R04](M5-RESEARCH.md#r04)), and automation maintenance has costs ([R07](M5-RESEARCH.md#r07)). | **Medium** |
| P4 | **Ambiguous readiness:** no shared definition of "ready to launch"; tracking and conversions unverified at kickoff. | #ppcchat SOP roundup: verify conversion tracking early and document it ([N38](#n38)). Week-one access guidance ([N37](#n37)). Vendor content describes stalled launches ([N39](#n39), vendor). | Mostly guides, not complaints. No measured time-to-launch data found. | **Low–medium** |
| P5 | **Scope and expectation mismatch between sales and delivery.** | Vendor content describes sales promising one timeline and delivery expecting another ([N39](#n39), vendor). No onboarding-first product documents scope or change-request features (§5). | No independent evidence retrieved today. | **Low** |
| P6 | **Ownership and security hygiene** at start and churn (client should own accounts; stale admins). | [N14](#n14), [N16](#n16), [N37](#n37). | Narrow and platform-specific. Leadsie has partial tooling ("Access Detective"). | **Low–medium** |

**Not found:** representative frequency, average delay, cost of delay, or churn caused by onboarding, for small marketing agencies. Any number like that would be invented, so none is used.

## 5. Competitor comparison

Products are grouped **by the job they do**; not all of them are direct competitors. Prices are public-page snapshots in USD unless stated, with retrieval dates. A third-party price is marked *(3p, unverified)*.

### 5a. Product register

| ID | Product | Job / category | Target | Price snapshot | Retrieved |
| --- | --- | --- | --- | --- | --- |
| <a id="n01"></a>N01 | [Leadsie](https://www.leadsie.com/pricing) | Ad and analytics **access** via one link | Marketing agencies | Starter $59/mo ($49 annual), 3 new clients + 10 prospect audits/mo. Agency $129 ($107), 10 + 50. Pro $299 ($249), 50 + 250. Enterprise custom. | 21 Oct |
| <a id="n07"></a>N07 | [AgencyAccess](https://agencyaccess.co/pricing) | Access **plus intake questions** | Agencies | $44/$99/$199 monthly ($33/$74/$149 annual) for 5/15/50 clients a month. "Password vault" is listed as *coming soon*. | 21 Oct |
| <a id="n08"></a>N08 | [ClientInvite](https://clientinvite.com/pricing) | Access link; pricing page lists intake forms | Agencies | $15/$29/$89 monthly. Unlimited connections, API and webhooks on $89. | 21 Oct |
| <a id="n09"></a>N09 | [Digitalsero](https://digitalsero.com/pricing) | Access link | Agencies | $19–$119/mo. Webhooks on Enterprise only. | 21 Oct |
| <a id="n10"></a>N10 | [LinkMyAgency](https://linkmyagency.com/pricing) | Access link | Agencies | 27/37 per month; currency inconsistent on the page. **Pages contained injected gambling spam** (trust red flag). | 21 Oct |
| <a id="n21"></a>N21 | [Content Snare](https://contentsnare.com/pricing/) | Information and **asset collection** with reminders and per-item approval | Agencies, accountants | Basic $35 annual ($42 monthly), 20 active requests, 2 users. Plus $71 ($85), 50 requests, 5 users. Pro $119 ($143), 100 requests, 10 users. Custom from $215. Capterra's listing shows older $29/$59/$99 (aggregator; the vendor page is used). | 21 Oct |
| <a id="n24"></a>N24 | [Onthen](https://onthen.com/pricing) | Branded onboarding **checklist page** with magic links | Sales/onboarding teams; no agency focus | Free: 10 plans, 2 templates, 2 users. Pro $19 per user per month, minimum 3 users. | 21 Oct |
| <a id="n31"></a>N31 | [LaunchBay](https://launchbay.com/pricing) | Client onboarding and collaboration portal (motion.io redirects here) | Agencies among others | $19–$79 per team member per month. The page shows two inconsistent price sets. | 21 Oct |
| <a id="n25"></a>N25 | [GUIDEcx](https://guidecx.com/pricing/) | Onboarding/**implementation project management** | B2B SaaS | Sales-led, no public prices. G2 lists implementation at "2 months". | 21 Oct |
| <a id="n26"></a>N26 | [Rocketlane](https://rocketlane.com/pricing) | Onboarding and professional-services automation | B2B SaaS, with an agency landing page | $49 / $69 per member per month (annual), **minimum 5 members**. Automation-run caps per tier. | 21 Oct |
| <a id="n27"></a>N27 | [Moxo](https://moxo.com/) | Portal and "human-AI workflow automation" | Operations teams | No public price. Third-party price history shows repeated changes in Aug–Oct 2026. | 21 Oct |
| <a id="n28"></a>N28 | [Dock](https://dock.us/pricing) | Buyer and client workspaces, now "revenue enablement" | Revenue teams | Free (10 workspaces). Standard $350/mo. Premium $1,000/mo. | 21 Oct |
| <a id="n29"></a>N29 | [Process Street](https://process.st/pricing/) | Workflow checklists, now "compliance operations" | Regulated operations | Contact sales. Guests count as seats. | 21 Oct |
| <a id="n30"></a>N30 | [Arrows](https://arrows.to/resources/meet-the-new-arrows) | HubSpot-native onboarding plans; pivoted to AI sales agents | B2B sales | Unpublished. Onboarding plans "staying just as they are" (25 Aug 2026). | 21 Oct |
| <a id="n33"></a>N33 | [ManyRequests](https://www.manyrequests.com/pricing) | Productized-service portal | Creative/productized agencies | Core $59 ($39 annual). Pro $99 ($79). Enterprise from $1,000. | 21 Oct |
| <a id="n34"></a>N34 | [Assembly](https://assembly.com/pricing) (formerly Copilot, [renamed 30 Sep 2025](https://assembly.com/updates/copilot-is-now-assembly)) | Client portal plus AI app builder | Professional-services firms | Starter $29 annual / $49 monthly. Higher tiers couldn't be read cleanly (animated digits). | 21 Oct |
| <a id="n35"></a>N35 | [Wayfront](https://wayfront.com/pricing) (formerly SPP.co, [renamed 12 Feb 2026](https://wayfront.com/service-provider-pro)) | Productized-agency portal and checkout | Productized digital-marketing agencies | Base $129 ($99 annual), 5 seats. Pro $299 ($249). Plus custom. | 21 Oct |
| <a id="n36"></a>N36 | [Agency Handy](https://www.agencyhandy.com/pricing-plan/) | Agency portal and proposals | Agencies | **Three conflicting price sets** across its pages; not usable as a benchmark. | 21 Oct |
| [M03](M5-RESEARCH.md#m03) | GoHighLevel | All-in-one CRM, automation, white-label SaaS | Agencies/resellers | $97 / $297 / $497 per month, plus usage. | 19 Oct (M5) |
| [M07](M5-RESEARCH.md#m07) / [M08](M5-RESEARCH.md#m08) | Dubsado / HoneyBook | Client lifecycle (contracts, forms, portals, workflows) | Creative/service businesses | Dubsado $335–$525 per year. HoneyBook $29–$109 per month (annual equivalent). | 19 Oct (M5) |
| [M04](M5-RESEARCH.md#m04)–[M06](M5-RESEARCH.md#m06) | Zapier / Make / n8n | Automation glue | Operators/builders | Zapier from $19.99/mo. Make from $9 for 10k credits. n8n Cloud €20/€50 per month. | 19 Oct (M5) |
| <a id="n41"></a>N41–N44 | ClickUp, Asana, Monday.com, Notion | Configurable PM/workspace substitutes | Teams | ClickUp ~$7–19 per user. Asana $10.99–24.99 per user. Monday $12–19 per seat with a **3-seat minimum** and **250 automation actions/mo on Standard**. Notion ~$10–24 per user, forms on Plus. *(3p, unverified; official pages not re-checked)* | 21 Oct |
| <a id="n32"></a>N32 | Typeform / Jotform / Google Forms | Generic intake | Everyone | Typeform $28–$39/mo entry. Jotform $34–$39/mo entry. Free tiers. Google Forms file uploads require the respondent to sign in ([N20](#n20)). | 21 Oct |

### 5b. Capability matrix

Key: **Y** yes · **P** partial · **N** not found in the docs read · **HT** higher tier only · **VI** via integration · **NV** not verified (for example, a research track stopped or a page blocked).

Columns:
1. Intake and information collection
2. Brand assets and files
3. Account access and permissions
4. Reusable templates
5. Reminders and escalation
6. Internal tasks and handoffs
7. Client approvals
8. Scope and change requests
9. Timelines and milestones
10. Client portal and communication
11. Integrations
12. Setup complexity
13. Pricing restrictions
14. Agency fit

| Product | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Leadsie | N (none found) | N | **Y**: 23 named platforms, view-only audits, Meta asset creation | P | NV | N | N | N | N | P (branded link) | P: Zapier on Agency+, 1 trigger, 0 actions; API on Enterprise | Low | Monthly onboarding credits (3 on Starter) | **High** for access only |
| AgencyAccess | **Y** (questions in the access flow) | N | **Y** | P | NV | N | N | N | N | P | P (Zapier on Premium+) | Low | Clients-per-month caps | High for access plus intake |
| Content Snare | **Y** (conditional logic) | **Y** | P (generic confidential fields; no platform grants) | **Y** | **Y** client reminders; escalation NV | P (request owner, internal comments) | **Y** per item | N | P (due dates) | Y (no-login link) | Y: Zapier, Make, webhooks | Low–medium | Active-request and user caps | **High** for content and assets |
| Onthen | Y | Y | N | Y (2 on Free) | Y nudges; escalation NV | Y | NV | N | P (relative due dates) | P (one page) | P: HubSpot, webhooks | Low (vendor claim) | 3-user minimum on Pro | Medium (not agency-specific) |
| LaunchBay | Y | Y | N | Y | Y (all plans) | Y | Y (proofing) | P (contracts) | NV | Y | HT (Zapier on Standard) | NV | Per member | Medium (inconsistent pricing) |
| GUIDEcx | VI (Google Forms/Typeform) | Y | N | Y | Y; SMS HT | Y | Y (sign-off) | NV; PSA HT | **Y** (Gantt, forecasting) | Y | Y / HT (Workato on Premium) | High ("2 months") | Sales-led | **Low** (B2B SaaS) |
| Rocketlane | Y | Y | N | Y | Y; run caps | **Y** | Y | P (resource requests); budgets HT | **Y** | Y | Y | Medium–high | **5-member minimum** | Medium (heavy for 2–5 staff) |
| Moxo / Dock / Process Street | Y | Y / Y / P | N | Y | Y / Y / Y | Y | Y / P / P | NV / P / NV | P | Y / Y / P | Y / HT / Y | High ("2 months") / NV / Medium | Unpublished / $350+ / sales-led | **Low** (moving up-market or away) |
| ManyRequests | Y (per-service request forms) | Y | N | P | P (billing reminders only, per help center) | Y | Y (proofing) | P (catalog; no e-sign) | P | Y | Y (Zapier, webhooks) | NV | Seats paid | Medium (productized only) |
| Wayfront | Y (after payment) | Y | N | Y | P (one email after 24h) | Y | P | P (signature field) | P | Y (white-label) | Y (Zapier 7 triggers, 9 actions) | NV (G2 "1 month") | Seats; API add-on | Medium (productized SEO and links) |
| Assembly | Y (no conditional logic natively) | Y | N | Y; automations HT | P (fixed schedule; no internal escalation) | P; per-client staff limits HT | Y (template apps) | P (contracts; no multi-party) | P | Y | HT (API on Professional+) | NV | Contact caps | Medium (generic portal) |
| GoHighLevel | Y | NV | NV | Y | Y (workflows) | P | NV | NV | NV | Y | Y | High (learning effort, [R12](M5-RESEARCH.md#r12)) | $97+ plus usage | High for consolidators |
| Dubsado / HoneyBook | Y | NV | NV | Y | Y (workflows on higher tiers) | P | NV | Y (proposals, contracts) | P | Y | P (Zapier) | Medium ([R11](M5-RESEARCH.md#r11)) | Per plan | Medium (creative services) |
| ClickUp / Asana / Monday / Notion | Y (forms; 3p) | P (attachments) | N | Y | P (automation caps; 3p) | **Y** | P / NV | N | **Y** | P (guests) | Y | Medium (template maintenance) | Per seat; Monday 3-seat minimum (3p) | High as a **configured** substitute |
| Zapier / Make / n8n | VI | VI | VI | — | VI | VI | VI | — | — | — | **Y** | Medium–high to maintain ([R07](M5-RESEARCH.md#r07), [R13](M5-RESEARCH.md#r13)) | Tasks/credits/executions | The glue in every existing stack |

**Gap checks**, classifying each apparent gap as missing, higher-tier, configurable, or via integration:

1. **Account access** is genuinely missing from every portal, onboarding and PM product checked. It is fully served by access specialists. The gap is between categories, not within one. Building access granting is not recommended: it needs per-platform app approvals and carries security risk ([N03](#n03) shows even Leadsie needs manual client steps).
2. **Combined access + intake + assets + readiness in one agency flow.** None of the products checked documents all of these. But the combination is **configurable via integration**: an access tool, Content Snare and a PM tool joined by Zapier ([N05](#n05), [R04](M5-RESEARCH.md#r04)). The gap is setup, maintenance and visibility, not impossibility.
3. **Internal escalation** (for example, "after N overdue days, alert the account manager"):
   - not documented by Content Snare, Onthen or Assembly;
   - Moxo claims escalations only in marketing copy;
   - PM tools and Zapier can be configured to do it.
4. **Scope and change requests at onboarding:**
   - missing from onboarding-first tools;
   - higher-tier in Rocketlane;
   - proposal and contract tools (HoneyBook, Dubsado) cover scope at sale, not confirmation at kickoff.
5. **Agency-specific readiness definitions** (PPC: tracking verified, access at the right role, budget confirmed). Not found as a product feature anywhere. Generic templates exist (vendor checklist templates such as ManyRequests' digital-marketing checklist). This is **configurable** in any checklist tool, so it isn't a capability gap. It could be a *packaging and maintained-knowledge* advantage.

**Inference:** LeadFlow should not rebuild access granting, file collection or PM. The defensible space, if there is one, is the **readiness layer across those categories**: a shared definition of ready, verified by the agency and visible across all clients. Integrations or links connect it to the tools that already do each job.

## 6. Differentiation hypotheses and weighted evaluation

These are **analyst judgments, not measurements.** The framework extends M5's, with **defensibility** added as the brief requires. Scores run from 1 (weak or unfavourable) to 5 (strong or favourable); for feasibility and risk, higher means easier or safer. Total = Σ(weight × score ÷ 5), out of 100.

| Code | Criterion | Weight | What a 5 means |
| --- | --- | --- | --- |
| S | Problem severity | 12 | Blocks billable delivery, corroborated |
| F | Frequency | 8 | Every new client, many touches |
| E | Evidence strength | 12 | Broad, independent, segment-specific |
| G | Gap vs alternatives | 14 | Compelling residual gap after configuration |
| V | Measurable value | 8 | Clean baseline: minutes, days to ready |
| D | Defensibility | 8 | Hard to copy |
| T | Feasibility and architecture fit | 10 | Mostly existing LeadFlow patterns |
| R | Security and operations risk | 6 | Minimal new exposure |
| I | Promptly services fit | 10 | Strong setup and implementation demand |
| A | Recurring SaaS potential | 12 | Recurring, standardized, paid |

| Hypothesis | S | F | E | G | V | D | T | R | I | A | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **H2 Launch-readiness board:** blockers, owners, days blocked, agency-verified gates | 4 | 3 | 3 | 3 | 4 | 3 | 4 | 4 | 4 | 4 | **71.6** |
| **H6 Scope and expectations confirmed at onboarding:** goals/KPIs, deliverables, exclusions, client responsibilities | 4 | 3 | 2 | 4 | 3 | 3 | 4 | 4 | 4 | 3 | **68.0** |
| H1 Service-aware requirement packs (PPC/paid social/SEO/email) | 3 | 3 | 2 | 3 | 3 | 2 | 4 | 4 | 4 | 3 | **61.2** |
| H5 Sales-to-delivery handoff from a won LeadFlow lead | 3 | 3 | 3 | 2 | 3 | 2 | 4 | 4 | 5 | 2 | **60.4** |
| H4 Follow-ups that stop on acceptance, plus internal escalation | 3 | 4 | 3 | 2 | 4 | 2 | 3 | 3 | 3 | 3 | **58.8** |
| H3 One link that grants access itself (LeadFlow-built OAuth) plus intake and assets | 4 | 3 | 3 | 3 | 3 | 3 | 1 | 1 | 3 | 3 | **56.0** |
| H8 Ownership and access hygiene audit at start and churn | 3 | 2 | 3 | 3 | 2 | 3 | 2 | 2 | 4 | 2 | **53.2** |
| H7 Simpler all-in-one replacing 4–5 tools | 3 | 3 | 2 | 1 | 2 | 1 | 1 | 2 | 3 | 2 | **39.6** |

**Reasons behind the key scores:**
- **H2:**
  - **S4:** P1/P4 delay billable work ([N37](#n37)).
  - **E3:** evidence is guides plus platform docs plus M5 threads, with no fresh first-hand complaints.
  - **G3:** progress views exist (Onthen, GUIDEcx forecasting), but a cross-category, agency-verified readiness definition isn't documented anywhere. It is approximable in ClickUp with effort.
  - **V4:** time to launch-ready is measurable.
  - **D3:** the concept is copyable; the requirement data model and maintained packs are less trivial.
  - **T4:** reuses workspaces, roles, outbox and the form-key pattern; adds tokens and a scheduler.
- **H6:**
  - **G4:** the clearest documented absence in onboarding-first tools (§5 gap 4).
  - **E2:** independent evidence wasn't retrieved today, which is why it ranks second despite the gap.
- **H1:** cheap to build (T4) but easy to copy (D2) and weakly evidenced (E2). It's valuable as **packaging inside H2**, not as a product.
- **H5:** best fit for Promptly services (I5), but CRMs and Zapier already do it (G2).
- **H4:** reminders are table stakes; Content Snare's are praised ([N22](#n22)), so G2. Escalation is a small increment. It needs a scheduler (T3).
- **H3:** fails on T1 and R1. The access category is commoditised at $13–$299/mo ([N01–N09](#n01)), and platforms require app review and admin steps ([N03](#n03)). **Do not build.**
- **H7:** crowded by GHL, Assembly, HoneyBook, Dubsado and the portals (G1). **Do not pursue.**

**Sensitivity:**
- If H2's gap score falls to 2 (for example, a benchmark shows Content Snare plus a PM board gives the same visibility with little setup), H2 drops to 68.8. That ties H6 and removes any clear leader.
- If H6's evidence rises to 3 after manual community review, it reaches 70.4.
- Weighting services (I) at 20 would favour H5 and the configured-stack offer.
- No score overrides the absence of demonstrated paid demand. A score here means "worth testing", not "worth building".

## 7. Strongest proposed selling point

**Selling point:** *"Know exactly what's stopping each new client's campaigns from launching, and clear it without chasing."* In product terms, this combines H2, H1, H6 and a bounded H4:
- service-specific readiness requirements;
- one client link for inputs, asset links, access steps and scope confirmation;
- agency verification per item;
- follow-ups that stop on acceptance, with internal escalation;
- a board of every onboarding, ordered by days to target launch.

**Supporting evidence:**
- Each component job recurs (P1–P4).
- No checked product combines a cross-category readiness definition with agency verification (§5 gaps 2–5).
- The category leader for access describes onboarding as a stack of 5+ tools ([N05](#n05)).
- Paid budgets exist for parts of the job: access tools $49–$299/mo, Content Snare $35–$143/mo. That proves a budget category exists, **not** willingness to pay LeadFlow.

**Counterarguments (taken seriously):**
1. Configured substitutes may be good enough. ClickUp or Notion templates plus Leadsie plus Zapier already work for some agencies ([R04](M5-RESEARCH.md#r04)).
2. Readiness may depend more on client behaviour and a strong account manager than on software. Clients may ignore a better link too.
3. The concept is easy to copy. Leadsie or AgencyAccess could add a readiness board; AgencyAccess already bundles intake.
4. Volume per agency may be too low for a subscription (two to four onboardings a month). Leadsie prices per onboarding for this reason.
5. First-hand, segment-specific pain evidence is thin in this round.
6. Clients, and agencies' existing CRMs, may resist yet another link or portal.

## 8. Recommended initial scope and exclusions (if the gates pass)

**Smallest differentiated product (Stage 1 MVP), recommendation only:**
1. **Readiness templates** for **paid search and paid social**: maintained packs of required inputs, asset links, access items (platform, required role, instructions, optional link to the agency's access tool) and scope confirmations. Light editing; no builder.
2. **Start an onboarding from a won lead or manually:** choose services, target launch date, account owner; generate client items and internal items, each with an owner.
3. **One scoped client link** per onboarding: expiring, revocable, no login. The client answers, adds links, follows access instructions, and confirms the scope summary.
4. **Agency verification per item:** accepted, changes requested or waived (with a reason). **Access items count as complete only when an agency member verifies them.**
5. **Readiness board:**
   - per-client status: Ready, Blocked by client, Blocked internally;
   - the oldest blocker in days;
   - next action and owner;
   - target launch date at risk.
6. **Bounded follow-ups:** client reminders list only missing items and stop when submitted. Internal nudges go to item owners when a review is pending. Escalation to the owner after N days. Pause and cancel.
7. **Launch-ready handoff:** a summary for the team, plus an optional outbound webhook.

**Explicitly avoid:**
- Granting platform access through LeadFlow's own OAuth apps.
- **Storing passwords or credentials**.
- File hosting in the first slice (use links to the client's storage).
- Proposals, contracts, e-signature and payments.
- Reporting dashboards.
- A general workflow builder or automation engine.
- AI decisions.
- White-label custom domains.
- A CRM replacement.
- Chat and messaging portals.
- A connector catalog.
- Productized checkout.

**Prerequisites from §2:**
- team invitations;
- a scheduler;
- a client-token security model;
- non-cascading linkage to leads.

## 9. Proposed user journey: agency setup to client readiness

1. **Set up (once):**
   - Create the workspace and invite the team (invitations need building).
   - Pick the service packs you sell, then adjust items and wording.
   - Set the reminder cadence, escalation threshold and sender.
   - Optionally paste the agency's Leadsie/AgencyAccess link into access items.
2. **Client signs:** the account manager marks the lead won (or creates an onboarding), selects services and a target launch date, and assigns internal owners.
3. **Review the plan:** LeadFlow shows client items (inputs, asset links, access steps, scope confirmation) and internal items (pixel and conversion audit, campaign plan). The account manager edits and sends the link.
4. **Client completes:** one page, no login, progress saved. Access steps open platform-specific instructions or the agency's access-tool link, and the client marks them done.
5. **Agency verifies:** specialists accept items or request changes. Access becomes "verified" only when an agency member confirms it in the platform. Optionally, a Leadsie completion webhook can pre-fill this, but a person still confirms.
6. **Follow up automatically:** the client gets reminders listing only outstanding items. Internal owners get nudges. The account owner is escalated after N days blocked.
7. **Track readiness:** a board across all onboardings, sorted by risk to the target launch date.
8. **Launch-ready:** when every required item is accepted, the team gets a summary and the date is recorded. *Stage 2 starts here.*

## 10. Expansion path: scope, timelines and delivery

| Stage | Customer value | Prerequisites | Evidence needed before starting |
| --- | --- | --- | --- |
| **1. Onboarding and readiness** | Fewer chases, earlier verified launch, shared definition of ready | Invitations, scheduler, client tokens, onboarding tables outside the snapshot | §12 gates G1–G4 |
| **2. Agreed scope, deliverables, ownership and timeline** | Turns the scope confirmed at onboarding into monthly deliverables, owners and a first-90-days timeline; a change request is a new versioned confirmation | Stage 1 retention; an item/deliverable model; versioned client confirmations | Stage 1 pilots show scope disputes or creep as a recurring post-launch problem; agencies ask to keep using the confirmed scope |
| **3. Execution, approvals and collaboration** | Client approvals of ads/content, progress updates, recurring check-ins | Proofing or file storage, notification preferences, possibly integrations with PM tools | Demonstrated paid retention; evidence that LeadFlow adds value beyond existing PM tools; **otherwise integrate with PM tools rather than replace them** |

**Guardrail against an unfocused all-in-one (inference):** each stage must extend the **same object**: the client engagement, from readiness to confirmed scope to deliverables. Stop at the boundary where a mature specialist exists (reporting, PM boards, invoicing) and integrate with it instead.

**What should be SaaS and what should be Promptly services:**
- **SaaS:** readiness model, maintained service packs, client link, verification, follow-ups, board, scope confirmation.
- **Services:** agency-specific pack tailoring, CRM/PM/Zapier wiring (for example, HubSpot deal → onboarding, launch-ready → ClickUp project), migrating existing checklists, custom reporting, bespoke automations.

## 11. Pricing research and monetization hypotheses

No LeadFlow price is recommended; nothing here proves willingness to pay.

**Benchmarks from today's price pages (arithmetic only, not evidence of value):**
- Leadsie charges about **$19.67** per onboarding on Starter ($59 ÷ 3), **$12.90** on Agency ($129 ÷ 10) and **$5.98** on Pro ($299 ÷ 50).
- Content Snare starts at $35/mo for 20 active requests.
- Onthen starts at $57/mo (3 users at $19).
- Rocketlane starts at $245/mo (5 members at $49).
- Dock Standard is $350/mo.

**Hypotheses to test later:**
- **MH1:** flat workspace tiers capped by **active onboardings** per month. This is how Content Snare and Leadsie price, and it matches value per new client.
- **MH2:** price per onboarding. Good for low-volume agencies; harder to predict revenue.
- **MH3:** a Promptly setup and integration fee plus a subscription. Report setup revenue separately; it is not MRR.
- **MH4:** bundled with Promptly's custom automation retainer. Measures services value, not SaaS demand.

**Research method (later, with consent):**
- Willingness-to-pay ranges asked in pilots.
- A disclosed price on a prototype or concierge offer.
- Price tested against measured capacity value, using M5's formula ([economic measurement](M5-RESEARCH.md#economic-measurement-not-invented-roi)).

## 12. Validation plan and go/no-go gates (no interviews required to start)

**Nothing below involves contact, publishing, accounts or purchases until the owner separately approves it.**

| Test | How | Can show | Cannot show |
| --- | --- | --- | --- |
| **V1. Workflow benchmark** (desk) | Define one representative PPC onboarding with fictional data. Model it in four setups:<br>(a) Google Form + Drive + Leadsie + ClickUp + Zapier;<br>(b) Content Snare + Leadsie;<br>(c) GoHighLevel;<br>(d) the proposed LeadFlow flow.<br>Use vendor docs; any trial accounts need later approval. Count tools, setup steps, client touchpoints, and whether readiness is visible in one place. | Whether a *credible* functional or effort gap exists | Real-world adoption, frequency or willingness to pay |
| **V2. Disclosed clickable prototype** | Static screens with sample data, clearly labelled as a concept, shown in Promptly sales conversations | Comprehension, which elements prospects react to, services interest | Willingness to pay, retention |
| **V3. Concierge onboarding via Promptly** (manual) | For 1–3 consenting agencies, run their next onboardings with existing tools plus a readiness sheet maintained by Promptly | Real time-to-ready, number of chases, blockers by type, operational feasibility | Software adoption without a human; SaaS margins |
| **V4. Landing page** (not published now) | Describe the workflow; measure qualified sign-ups | Message resonance | **Not** willingness to pay; a click isn't commitment |
| **V5. Manual evidence review** | A person reads communities automated research couldn't reach (Reddit r/PPC, r/agency, r/FacebookAds) and the 15 "Marketing and Advertising" Content Snare reviews on G2 | Strengthens or weakens P1–P5 | Representative prevalence |

**Gates (proposed decision rules, not results):**
- **G1 Problem evidence:** at least 10 first-hand, segment-specific accounts of launches delayed by access, inputs or scope ambiguity, from at least 5 independent sources (V5). Otherwise stop the SaaS track.
- **G2 Credible gap:** V1 shows LeadFlow's flow needs materially less setup and fewer tools, or offers verified readiness and scope confirmation that (a)–(c) can't provide without custom automation. If setup (c) or (a) matches it at similar effort, offer it as Promptly services instead.
- **G3 Workflow completion:** in V3, at least 80% of required client items are completed or waived by the target date across at least 5 onboardings, with fewer manual chases than the agency's own baseline. Record the baseline first.
- **G4 Operational feasibility:** in an isolated environment, prove:
  - token scope and revocation;
  - reminder cancellation;
  - no duplicate reminders after a lost response;
  - cross-workspace denial;
  - a scheduler with alerting;
  - estimated cost and support per onboarding.
- **G5 Stronger demand:** at least 3 agencies commit to a paid pilot or written budget for the readiness workflow. Interest alone doesn't count.
- **G6 Recurring revenue:** at least 2 pilot agencies voluntarily pay through two billing cycles, with support time within an agreed margin.

## 13. Risks, open questions and confidence

| Risk / question | Confidence / status |
| --- | --- |
| Configured substitutes (ClickUp, Notion or GHL plus Zapier) are good enough | **Open.** It's the main risk; V1 tests it |
| Thin first-hand evidence for marketing agencies specifically (Reddit blocked, review pages 403) | **Known limitation** of this round |
| Feature is easy to copy, especially for access tools that already bundle intake (AgencyAccess) | **High risk.** Any advantage must come from execution and maintained requirement packs |
| Low onboarding volume per small agency | **Unknown.** The ≥2/month screen is a hypothesis |
| Clients ignore another link | **Unknown.** V3 measures it |
| New security surface (client tokens) and operations (scheduler, email deliverability, per-agency sender) | **Certain cost.** It's bounded, but real |
| Team invitations not built | **Certain prerequisite** |
| Market size | **Not established** |
| Third-party PM-tool prices, Moxo and GUIDEcx pricing, Process Street prices | **Unverified** |
| LinkMyAgency site integrity (spam injection) | Observed 21 Oct; a reason not to recommend or integrate with it |

**Overall confidence:**
- **Medium** that "readiness across access, inputs and scope" is the best-supported wedge among those considered.
- **Low** that it's a defensible standalone SaaS.
- **Medium–high** that it's a strong Promptly demonstration and services offer.

## 14. Recommended next milestone

**Recommended next milestone: readiness concept validation (desk and concierge), with no production feature.**
1. Complete V1 (the workflow benchmark) and V5 (manual evidence review), and record the results against gates G1–G2.
2. Draft the paid-search and paid-social readiness requirement packs as documents, with sources.
3. Prepare a disclosed prototype (V2) **design**; build it only if the owner approves.
4. Close the operational gaps on the existing product, which are worth doing whatever is decided:
   - repair the CLI migration history;
   - deploy the current frontend;
   - complete the hosted two-account checks;
   - design team invitations.

Start implementation (an M6 build) only after G1, G2 and owner approval. Otherwise, position LeadFlow as Promptly's demonstration and delivery platform and sell configured onboarding systems as services.

## Direct answer

**What problem LeadFlow should own:** *"Is this new client actually ready for us to launch, and if not, exactly what is blocking it and who owns it?"* In other words, the time from a signed retainer to a **verified, campaign-ready** client: access at the right roles, required inputs and assets, tracking verified, and scope and expectations confirmed.

**For which agencies:** independent **paid-media (PPC/paid social) agencies with about 2–20 staff**, onboarding at least two retainer clients a month, currently stitching together forms, folders, an access tool, a PM board and email.

**Why they would choose it:**
- No checked product gives a single, **agency-verified readiness definition across access, inputs and scope**:
  - access tools stop at access;
  - Content Snare stops at content;
  - B2B onboarding suites are heavy and costly;
  - all-in-ones need building from scratch.
- LeadFlow would offer preconfigured paid-media requirement packs, one client link, follow-ups that stop when items are accepted, and a readiness board. It would integrate with existing access tools rather than replace them.

**How defensible this is:** only moderately supported, and not proven. The pain evidence is real but thin for this exact segment. Configured substitutes may be good enough, and the idea is copyable.

So, until gates G1–G2 pass: **use LeadFlow primarily as Promptly's demonstration and custom-automation delivery platform.** Treat the readiness wedge as a hypothesis to validate, not a SaaS to build.

## Source register (new sources; all retrieved 2026-10-21)

M5 sources (R01–R18, M01–M14, retrieved 2026-10-19) are in [M5-RESEARCH.md](M5-RESEARCH.md#practitionerreview-evidence-register). Vendor pages are undated unless a date is shown. "3p" marks a third-party aggregator.

| ID | Source | Type | Date | Finding used |
| --- | --- | --- | --- | --- |
| N01 | [leadsie.com/pricing](https://www.leadsie.com/pricing) | Vendor | Undated | Plans, onboarding credits, gating |
| <a id="n02"></a>N02 | [help.leadsie.com/article/137](https://help.leadsie.com/article/137) | Vendor docs | Updated 2026-06-30 | Zapier on Agency+, 1 trigger, 0 actions, no abandonment event; API on Enterprise |
| <a id="n03"></a>N03 | [help.leadsie.com/article/65](https://help.leadsie.com/article/65) | Vendor docs | Updated 2026-06-04 | Ad Account and Domain need manual client steps |
| <a id="n04"></a>N04 | [G2 Leadsie](https://www.g2.com/products/leadsie/reviews) | Review platform | Modified 2026-10-17 | 4.8 from 73 reviews (rating only; review text not read) |
| <a id="n05"></a>N05 | [Leadsie: best onboarding tools](https://www.leadsie.com/blog/best-tools-for-onboarding-agency-clients) | Vendor | 2026-10-02 | Onboarding framed as a 5+ tool stack |
| <a id="n06"></a>N06 | [Leadsie case study](https://www.leadsie.com/blog/first-page-case-study) | Vendor case study | 2026-10-02 | "Access is the hardest part of onboarding a new client" (curated) |
| N07–N10 | AgencyAccess, ClientInvite, Digitalsero, LinkMyAgency pricing pages (see §5a) | Vendor | ©2025–2026 | Prices, limits, bundled intake, spam observation |
| <a id="n11"></a>N11 | [Google Ads account linking](https://support.google.com/google-ads/answer/7459601) and [ownership](https://support.google.com/google-ads/answer/7456532) | Platform docs | Undated | Admin acceptance; one owning manager; transitive ownership |
| <a id="n12"></a>N12 | [GA4 user management](https://support.google.com/analytics/answer/9305788) | Platform docs | Undated | Admin-only user addition |
| <a id="n13"></a>N13 | [GTM user permissions](https://support.google.com/tagmanager/answer/6107011) | Platform docs | Undated | Keep at least two admins to avoid lockout |
| <a id="n14"></a>N14 | [Search Console owners](https://support.google.com/webmasters/answer/7687615) | Platform docs | Undated | A deleted owner can re-verify via a lingering token |
| <a id="n15"></a>N15 | [Business Profile roles](https://support.google.com/business/answer/3403100) | Platform docs | Undated | 7-day restriction for new users |
| <a id="n16"></a>N16 | [Ideas Money Art: Google Ads ownership](https://ideasmoneyart.com/blog/google-ads-account-ownership-why-you-the-client-need-to-be-in-charge) | Independent agency blog (self-interested) | Undated (~2021) | Former agency refused to transfer the account |
| <a id="n17"></a>N17 | [PPC access guide (Gumroad)](https://emilywoodmarketing.gumroad.com/l/ppc-access-guide) | Practitioner product (search snippet) | Undated | A market exists for manual access templates; low confidence |
| <a id="n18"></a>N18 | [ToolMapHQ Leadsie review](https://toolmaphq.com/leadsie-review/) | Affiliate | 2026-09-18 | Permission issues still occur; not a CRM, PM tool or portal |
| <a id="n19"></a>N19 | [Dropbox file requests](https://help.dropbox.com/share/create-file-request) | Platform docs | Updated 2025-05-15 | No uploader account needed; 2 GB Basic limit |
| <a id="n20"></a>N20 | [Google Forms file upload](https://support.google.com/docs/answer/7322334) | Platform docs | Undated | Respondents must sign in |
| N21 | [contentsnare.com/pricing](https://contentsnare.com/pricing/) | Vendor | Undated | Plans and limits |
| <a id="n22"></a>N22 | [G2 Content Snare](https://www.g2.com/products/content-snare/reviews) | Review platform | Reviews 2024-11 to 2025-10 | 4.7 from 54. Praise for reminders and time saved. Complaints: per-comment emails, USD-only pricing, an outage. 15 reviews tagged Marketing and Advertising (unread) |
| <a id="n23"></a>N23 | Content Snare help (requests can't be placed on a website) | Vendor docs | Undated | Recommends a forms tool plus Zapier for intake |
| N24–N31 | Onthen, GUIDEcx, Rocketlane, Moxo, Dock, Process Street, Arrows, LaunchBay pages (see §5a) | Vendor (plus 3p for Moxo history) | Varies | Positioning, prices, gating, pivots |
| N32 | [typeform.com/pricing](https://www.typeform.com/pricing/), [jotform.com/pricing](https://www.jotform.com/pricing/) | Vendor | Undated | Entry prices |
| N33–N36 | ManyRequests, Assembly, Wayfront, Agency Handy pages (see §5a) | Vendor (plus Trustpilot for Wayfront and Agency Handy) | Varies | Portal capabilities; no access workflows; pricing inconsistencies |
| <a id="n37"></a>N37 | [ppc.io: PPC client onboarding](https://ppc.io/blog/ppc-client-onboarding) | Practitioner/agency blog | Undated | Client keeps ownership; access in week one; "still asking for a login in week three" means not managing |
| <a id="n38"></a>N38 | [Karooya: #ppcchat onboarding SOP](https://www.karooya.com/blog/ppcchat-client-and-account-onboarding-sop) | Community roundup | Undated | Verify conversion tracking early; document |
| <a id="n39"></a>N39 | [Fuzen: client onboarding system](https://www.fuzen.io/posts/client-onboarding-system-for-marketing-agencies) | Vendor | Undated | Access and brand files stall onboarding; sales vs delivery expectation mismatch; its cost figure is illustrative, **not used** |
| <a id="n40"></a>N40 | GatherMonk playbook citing Leadsie data | Vendor citing a vendor (search snippet) | Undated | "~13% first-time GA access requests fail": **unverified, not used** |
| N41–N44 | Third-party pricing summaries for ClickUp, Asana, Monday.com, Notion (automationatlas.io, activepieces.com, tinycommand.com, costbench.com) | 3p | 2026 | Approximate per-seat prices; Monday 3-seat minimum and 250 actions on Standard; Notion forms on Plus; **conflicting, unverified** |
| <a id="n45"></a>N45 | NAICS 54181 counts from aggregators (vantainsights.com, data.mewayz.com) | 3p | Undated | Conflicting firm and establishment counts; **not used**; official Census size-class table not retrieved |
