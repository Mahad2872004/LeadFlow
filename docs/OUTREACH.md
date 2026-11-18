# Contact intelligence and AI outreach (M8)

LeadFlow can find a lead's public business contacts, show how trustworthy each detail is and where it came from, and prepare email, WhatsApp and LinkedIn drafts grounded in the lead's [business report](BUSINESS-INTELLIGENCE.md). People review, edit, copy and send every message themselves.

- **Where:** open a lead → **Contacts** or **Outreach** (tabs next to **Business report**). Settings → **Outreach** has the agency's outreach settings, each member's sender details and usage.
- **Who:** any workspace member can search contacts, add and edit them, and generate and manage drafts. Owners and admins change the workspace's outreach settings, delete any contact and erase a lead's contact data. Members delete contacts they added themselves.
- **What it never does:** send email, WhatsApp or LinkedIn messages; send connection requests; mark a message as sent on its own; guess email addresses; decode obfuscated addresses; log in, solve CAPTCHAs or work around bot protection; read pages that robots.txt disallows; scrape LinkedIn.

## Contents

1. [Contacts](#contacts)
2. [Contact discovery](#contact-discovery)
3. [Verification and confidence](#verification-and-confidence)
4. [Merging, edits and deletion](#merging-edits-and-deletion)
5. [Apollo decision-makers](#apollo-decision-makers)
6. [Outreach drafts](#outreach-drafts)
7. [Drafts, versions and status](#drafts-versions-and-status)
8. [Outreach settings](#outreach-settings)
9. [Database](#database)
10. [API](#api)
11. [Configuration](#configuration)
12. [Security and privacy](#security-and-privacy)
13. [Usage and cost controls](#usage-and-cost-controls)
14. [Tests](#tests)
15. [Deployment](#deployment)
16. [Limitations](#limitations)

## Contacts

A lead has any number of contacts of two kinds:

- **people**, such as a founder named on the team page or someone your team met;
- **business contacts**, such as a general inbox, the main phone line or a published WhatsApp number.

Each contact can have an email, a phone number (stored as written and in international E.164 form), a WhatsApp number, a LinkedIn or other profile link, a role and notes. You can also mark it:

- **primary**: the main contact for the business, one per lead;
- **preferred**: the one to reach out to, one per lead;
- **confirmed**: your team checked it.

Business channels that aren't a person or an inbox are listed separately: contact pages, contact forms, booking pages, social profiles, the LinkedIn company page, the published address and WhatsApp links.

Every contact shows:

- its **sources**: each value, where it was found (page and method), and when;
- its email and phone **status**;
- its **confidence**, with the reasons and limitations behind it;
- when it was last updated.

## Contact discovery

**Find contacts** starts a short background job for the lead. Like a business analysis, it advances one step at a time under a lease. The open tab advances it, and the `analysis-worker` continues it if the tab is closed.

| Step | What happens |
| --- | --- |
| `website` | Contacts from the lead's latest finished business report: `mailto:`, `tel:` and WhatsApp links, social and LinkedIn company links, contact forms and contact or booking pages, each cited by its evidence ID. Then up to `CONTACT_MAX_PAGES` (default 5) more pages are read directly, prioritizing team, leadership, about and contact pages, with the same SSRF-safe fetcher as the business report. Without a report, it starts from the homepage. robots.txt rules for `*` and `LeadFlow` are respected. The lead's own email and phone are a source too. |
| `verify` | The mail servers (MX records) of each email domain, through DNS-over-HTTPS, and phone formats for the lead's country. Nothing is sent to any address. |

**What counts as a contact**
- **Email addresses:** from `mailto:` links, and from page text only when the address is on the business's own domain. An address in text on another domain is too often a designer's credit or a template leftover.
- **Skipped addresses:** no-reply, privacy, abuse and postmaster addresses, image file names and placeholder domains.
- **Not decoded:** obfuscated addresses (`sales [at] example [dot] com`).
- **People:** only when a name and a job title appear together on a page: "Jane Doe" above "Founder & CEO", or "Jane Doe, Founder" on one line. A name without a title ("Dr. Avery Stone leads our practice") is not turned into a person. Headings and navigation text ("Our Team", "Practice Manager") are not names.
- **A person's email:** a personal-looking address (`jane@`, `jane.doe@`, `jdoe@`) found on any page is attached to the person of that name.
- **Personal LinkedIn profiles:** kept only when the link's text names a person listed on the same page.

**Job outcomes**
- **completed**
- **partial:** a check failed, such as mail-server lookups during a DNS outage. Details stay "Not checked".
- **failed:** only when the website couldn't be read and nothing at all is known about the lead's contacts.
- **cancelled:** someone stopped it.

**Safeguards**
- **One active search per lead:** starting another returns the running one.
- **Idempotent starts:** a repeated request ID returns the same job.
- **Recent searches:** a lead searched less than `CONTACT_RECENT_HOURS` ago (default 6) asks "Search again anyway?".
- **Per-contact refresh:** **Check again** on a contact runs a verify-only job for it.

## Verification and confidence

### Email status

| Status | When |
| --- | --- |
| Verified | A provider (Apollo) reported the address as verified. LeadFlow's own checks never produce this status. |
| Likely valid | The business publishes the address on its own website, on its own domain, and the domain has a mail server. The mailbox itself can't be confirmed without sending a message, and LeadFlow sends none. |
| Unverified | The domain accepts email, but nothing confirms this mailbox exists. |
| Invalid | The syntax is wrong, the domain doesn't exist, or it publishes a "null MX" (no mail). |
| Risky | A provider marked it so (catch-all domains, for example). |
| Not checked | Not checked yet, or the lookup failed. |

Syntax and mail-server checks never make an email "verified".

### Phone status

Phone numbers are parsed with [libphonenumber-js](https://www.npmjs.com/package/libphonenumber-js) 1.13.15, using the lead's country:

- **Valid format:** well formed for its country. This doesn't mean the line is in service.
- **Invalid format:** not a valid number for its country.
- **Not checked:** a national number without a country can't be evaluated.
- **Verified by provider:** Apollo reported it as valid.

A number is only treated as WhatsApp when the business links to it with a WhatsApp click-to-chat link, or your team enters it.

### Confidence

Confidence comes from fixed rules in `supabase/functions/_shared/outreach/contacts.ts` (`assessContact`), computed the same way in the browser and in tests. No AI produces it. Each rule adds a reason or a limitation, and both are shown.

| Rule | Effect |
| --- | --- |
| Source directness | +2 for a contact link on the business's own site, a name listed with a job title, a reveal from Apollo, or a manual entry; +1 for page text or the lead record; an Apollo search result alone adds nothing (the name is partly hidden). |
| Association with the business | +1 when the email domain matches the website; free-mail and other-domain addresses are noted as limitations. |
| Verification | +2 for provider-verified; +1 for likely valid; −1 for risky; −1 for an invalid phone format. |
| Consistency | +1 when the same detail came from two or more independent sources. |
| Freshness | −1 when last seen over a year ago; a limitation note after six months. |
| Overrides | An invalid email is always low. A contact your team confirmed is high. |

Levels: **high** at 4 points or more, **medium** at 2–3, **low** below 2.

## Merging, edits and deletion

Discovery merges, and never duplicates. A found detail is matched to an existing contact in this order:

1. provider ID;
2. email;
3. LinkedIn or profile URL;
4. for a person, the name;
5. for a business line, the phone number.

**How a found value is merged**
- **Empty field:** filled in.
- **Partly hidden Apollo name:** replaced by the full one when revealed.
- **Differs from an existing value, a field your team edited, or a confirmed contact:** never overwritten. It becomes a **suggestion** on the contact ("Business website now shows a different job title: Founder"), which you use or dismiss. A dismissed suggestion isn't made again.

**Edits:** editing a field marks it as edited, so discovery won't change it. The discovered original stays in the contact's sources.

**Deleting a contact:**
- LeadFlow remembers SHA-256 hashes of its email, business phone, provider ID and person name, so later searches don't collect it again.
- Only hashes are kept, never the details.
- Adding the same details by hand later clears the hashes.

**Delete all contact data for this lead** (owners and admins):
- removes the lead's contacts, sources, channels and searches;
- remembers their hashes;
- keeps drafts' text, but unlinks them from the contact.

## Apollo decision-makers

If Apollo is enabled for the workspace ([docs/APOLLO.md](APOLLO.md)), **Contacts → Search Apollo** runs a free Apollo people search for owners, founders, C-suite, partners, heads and directors at the lead's domain, through the existing `apollo` function: its saved pages, pacing and quotas apply. For each person:

- **Add (name partly hidden):** adds the person as shown in the search result.
- **Reveal email… → Reveal and add:** uses the existing reveal, with its 1-credit confirmation and credit ledger, then adds the revealed details.

Only person IDs come from the browser. `add_apollo_people_as_contacts` reads names, titles and emails from the workspace's own `apollo_contacts` and saved Apollo result pages, so the browser can't supply contact data or a "verified" status. Another workspace's Apollo data is never used. No new Apollo endpoint or API key is involved.

## Outreach drafts

**Outreach** prepares one message at a time.

**Choosing what to send**
1. **Choose an opportunity.** The opportunities come from the latest business report, and the recommended one is starred. You can also choose a general introduction.
2. **Choose a contact.** The preferred contact is chosen first.
3. **Choose a channel:** email, WhatsApp, a LinkedIn invitation note, or a LinkedIn message for after an invitation is accepted.
4. **Choose an angle.** There are five, each positioned differently, not reworded:
   - **Opportunity-focused** leads with the observation.
   - **Value-focused** leads with what the service helps with.
   - **Consultative** asks a genuine question.
   - **Audit-first** offers a free review.
   - **Relationship-first** is a low-pressure introduction.

**The recommendation** (`recommendOutreach`) picks the strongest opportunity using:
- its priority and confidence;
- whether its findings are observed or measured;
- whether your team verified a finding;
- whether a service matches;
- whether your team accepted it.

It then chooses an angle that fits the evidence. Hypotheses only lead to a question (consultative). Several observed opportunities suggest an audit-first message. With no usable evidence, it recommends relationship-first. **Why this recommendation** lists the reasons.

**What the AI receives**
- the agency's settings;
- the recipient;
- the business;
- the selected opportunity;
- up to eight findings as `F1…F8`, the opportunity's own first, never one your team marked "not accurate";
- the agency's active services as `S1…`;
- for follow-ups, the first message, how long ago it was sent and your notes on the conversation.

It returns structured JSON: subject, body, claims (each statement about the business with the findings it rests on) and whether the evidence was sufficient. The model is Gemini, through the same client as the business report.

**Speed and retries:**
- **Thinking level:** drafts ask for a low thinking level (`OUTREACH_AI_THINKING`). `gemini-3.6-flash` otherwise defaults to medium.
- **Time per attempt:** each attempt gets 55 seconds.
- **Retry:** one timeout or outage is retried. A second failure says so and saves nothing.
- **Refused setting:** if Gemini rejects the thinking level, the request is sent again without it.
- **Business reports:** they send no thinking level and are unchanged.

**Checks before a draft is saved** (`validateDraft`):
- **Claims must cite real findings:** each one is stored with the finding IDs, evidence IDs and source URLs behind it. Claims citing nothing real are dropped, with a warning.
- **Reference codes and IDs** never reach the message text.
- **Unsupported statements reject the draft**, recorded as failed usage: a message that says the business is losing customers or revenue, describes how it works internally ("you handle appointments manually"), promises results or percentages, refers to contact that didn't happen ("thanks for your reply", "as we discussed"), or uses pressure tactics. The user sees why and can try again or try another angle.
- **Channel limits:**
  - email: subject 120 characters, body 2,500;
  - WhatsApp: 700, no subject;
  - LinkedIn invitation note: 200 characters, LinkedIn's limit per [LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/46662), checked 19 November 2026;
  - LinkedIn message: 1,300 (LeadFlow's own limit).

  A draft over its limit is cut at a sentence end with a warning, or rejected if that would cut more than 40 %.
- **Placeholders** such as `[Your name]` are flagged.
- **Without evidence**, for example a lead without a business report, the draft is an honest general introduction, marked **General introduction**.

**Prompt-injection protection:**
- Website text, AI interpretations of it, contact names and labels, earlier messages and reply notes reach the model only inside `<untrusted_data>` fences. Fence tags inside them are removed.
- The system prompt says fenced content is data, never instructions.
- The agency's custom instructions can change style but never the rules.
- The model has no tools, and its output is validated in code.

## Drafts, versions and status

- **Versions:** every generation, edit, regeneration, duplicate and restore is kept. **Version history** compares any version with the current text word by word, and restores one as a new version.
- **Saving is guarded:** a save names the version it started from, and an edit made elsewhere in the meantime is reported instead of overwritten.
- **Regenerating** a draft you edited asks first. Regenerating creates a new version and the edit stays in the history. A message marked as sent is never regenerated; duplicate it instead.
- **Statuses:** draft, ready to send, sent manually, replied, follow-up required, archived. Only a person changes them:
  - Copying, or opening the message in an email app or a WhatsApp chat, never marks it as sent.
  - **Mark as sent…** asks for confirmation and adds an entry to the lead's activity history.
- **Follow-ups:**
  - **Reminders:** a sent message offers reminders at the workspace's follow-up intervals (default 3, 7 and 14 days). A reminder is an ordinary task in **Follow-ups**, never a scheduled send.
  - **Follow-up drafts:** **Prepare a follow-up draft** sets up follow-up 1, 2 or 3 for the same contact and opportunity. A follow-up can only be prepared once the first message is marked as sent, and is rejected if it pretends the recipient replied.

## Outreach settings

**Settings → Outreach:**

- **Workspace** (owners and admins):
  - agency name (defaults to the workspace name), description and website;
  - default sender name, role and contact details;
  - tone (professional, friendly, consultative, direct, conversational);
  - length (short, standard, detailed);
  - objective (discovery call, free review, case study, permission to send a proposal, conversation);
  - preferred call to action, words to avoid and other instructions (style only);
  - up to five case-study links;
  - up to three follow-up reminder intervals.
- **Your sender details** (every member, for themselves): name, role, contact details, tone and length. Empty fields use the workspace defaults.
- **Usage this month:** contact searches and AI drafts against their limits, provider usage, failed calls, and Apollo balances when Apollo is enabled.

## Database

Migration `supabase/migrations/202611190001_outreach_intelligence.sql`; rollback `supabase/rollbacks/202611190001_outreach_intelligence.down.sql`. Tables are all in `leadflow_private`, with RLS enabled and no client privileges.

| Table | Holds |
| --- | --- |
| `lead_contacts` | Contacts: kind, label, name, title, role, email and its status and check, phone and E.164 and status, WhatsApp, profile links, provider ID, flags, edited fields, suggestions. Unique per lead by email, by provider ID, and one primary and one preferred. |
| `lead_contact_sources` | Every value of every contact with its source, method, page, evidence and report, and time. |
| `lead_channels` | Business channels, unique per lead by type and value. |
| `contact_suppressions` | Hashes of deleted contacts' identifiers. |
| `contact_discovery_jobs` | Searches: mode, status, step, provider states, progress, lease. One active per lead; request ID unique per workspace. |
| `outreach_preferences` | Workspace settings (user null) and each member's sender details. |
| `outreach_drafts` | Drafts with their current text, claims, grounding, warnings, status and timestamps. |
| `outreach_draft_versions` | Every version, with its origin, model and token counts, the settings used and its request ID (unique, for idempotent generation). |
| `outreach_usage` | Provider usage for searches and drafts, with status; credits and balances only when a provider reports them. |

Like business analyses, contacts and drafts reference `lead_id` without a foreign key, because snapshot saves replace leads. Deleting a lead leaves its contacts and drafts in place; use **Delete all contact data for this lead** first. Drafts reference contacts, opportunities, analyses and services with `on delete set null`, and keep the contact name and opportunity title as snapshots.

## API

### Edge Function `outreach`

`POST` with the user's session token and `{ workspaceId, action, … }`. The origin must be in `DISCOVERY_ALLOWED_ORIGINS`, and membership is checked with the caller's own token (`analysis_member_role`) first.

| Action | Body | Returns |
| --- | --- | --- |
| `config` | — | Providers (AI configured, model; Apollo enabled), limits and channel limits. Never keys. |
| `discover` | `leadId`, `requestId`, `force?` | The job and the lead's contacts. 409 `code: 'recent'` · 429 `code: 'limit'` · 422 lead not in workspace. |
| `verify` | `leadId`, `requestId`, `contactIds` | A verify-only job for those contacts. |
| `advance` | `leadId`, `jobId` (the lead's latest search) | Runs the next step and returns the lead's contacts. |
| `generate` | `leadId`, `requestId`, `channel`, `angle`, `opportunityId?`, `contactId?`, `sequenceStep`, `parentId?`, `instructions?`; to regenerate: `draftId`, `expectedVersion`, `replaceEdited?` | `{ draft, existing }`. 503 `not_configured` · 409 `edited` / `stale` · 422 `unsupported_claim` / `malformed` / `too_long` · 429 `limit` / `rate_limited` · 502 provider errors. |

### Database functions

**Signed-in members** (role-checked inside):
- contacts: `lead_contacts_for`, `save_lead_contact`, `set_lead_contact_flags`, `resolve_contact_suggestion`, `delete_lead_contact`, `delete_lead_contact_data` (owners and admins), `add_apollo_people_as_contacts`, `cancel_contact_discovery`;
- settings: `outreach_preferences_for`, `save_outreach_preferences`;
- drafts: `outreach_drafts_for`, `outreach_draft_versions`, `save_outreach_draft`, `restore_outreach_draft_version`, `set_outreach_draft_status`, `duplicate_outreach_draft`, `delete_outreach_draft`;
- usage: `outreach_usage_for`.

**Service role only** (called by the Edge Functions after their checks): `start_contact_discovery`, `claim_contact_discovery`, `save_contact_discovery_step`, `outreach_context`, `save_generated_draft`, `record_outreach_usage`.

## Configuration

These are Supabase Edge Function secrets, never `VITE_` variables. No new provider key is needed: drafts use the existing `GEMINI_API_KEY`, and Apollo uses its existing keys.

| Secret | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | (existing, optional) | Draft generation. Without it, contacts and existing drafts still work, and **Generate draft** explains what's missing. |
| `OUTREACH_AI_MODEL` | `ANALYSIS_AI_MODEL`, then `gemini-3.6-flash` | Gemini model for drafts. |
| `OUTREACH_AI_THINKING` | `low` | How much Gemini reasons before writing a draft: `minimal`, `low`, `medium` or `high`. Sent as `generationConfig.thinkingConfig.thinkingLevel`, to Gemini 3 and later models only. Higher levels are slower. |
| `CONTACT_MAX_PAGES` | `5` (max 10) | Pages read directly per contact search. |
| `CONTACT_MONTHLY_LIMIT` | `60` | Contact searches per workspace per calendar month. |
| `CONTACT_MAX_CONCURRENT` | `3` | Running searches per workspace. |
| `CONTACT_RECENT_HOURS` | `6` | A newer search asks before searching again. |
| `OUTREACH_MONTHLY_LIMIT` | `300` | Generated drafts and versions per workspace per month. |
| `ANALYSIS_DNS_RESOLVER` | (existing) | DNS-over-HTTPS resolver for SSRF and mail-server checks. |
| `DISCOVERY_ALLOWED_ORIGINS`, `NOTIFICATION_WORKER_SECRET`, `APOLLO_*` | (existing) | Origins, worker authentication, Apollo. |

The function imports `libphonenumber-js` through `supabase/functions/outreach/deno.json` and `supabase/functions/analysis-worker/deno.json` (`npm:libphonenumber-js@1.13.15/min`). The browser uses the same package from `package.json`.

## Security and privacy

- **Access:**
  - All tables are private, and every client function checks workspace membership and role.
  - Contacts, channels, searches, drafts, versions and settings can't be read or changed across workspaces, even with a known ID.
  - The Edge Function reads and writes as the service role only after verifying the caller, and only for the workspace the caller belongs to.
- **Data from the browser:**
  - A phone status other than a format result can't be set from the browser.
  - Apollo contact data is read server-side from the workspace's own Apollo records.
- **Fetching:**
  - Website pages are fetched through the business report's SSRF-safe fetcher: public addresses only, every redirect checked, size and time limits. See [BUSINESS-INTELLIGENCE.md](BUSINESS-INTELLIGENCE.md#security) for the DNS-rebinding note.
  - robots.txt is respected. Logins, CAPTCHAs and bot protection are never worked around.
- **Logs:** they carry job and draft IDs, steps and outcomes, never keys, email addresses, phone numbers, names or message text. Tests assert this.
- **Keys** are read only inside the Edge Functions. `config` reports whether each provider is configured, never the key.
- **Data minimization:**
  - Only explicit contact points and people named with a job title are kept.
  - Unmonitored addresses (no-reply, privacy, abuse) are skipped.
  - A personal LinkedIn profile is kept only when a listed person's name links to it.
- **Correction and deletion:** contacts can be corrected, and deleted individually or for a whole lead. Deletions are remembered as hashes, so details aren't collected again.
- **Not built, by design:**
  - sending email or WhatsApp messages;
  - LinkedIn automation or invitations;
  - bulk sending;
  - guessing email patterns;
  - SMTP mailbox probing;
  - scraping LinkedIn or anything behind a login.

LeadFlow prepares messages; whoever sends them is responsible for the anti-spam and privacy rules of their market, such as CAN-SPAM, PECR or GDPR and the Spam Act 2003. This document isn't legal advice.

## Usage and cost controls

- **Limits:**
  - monthly contact searches, concurrent searches, recent-search confirmation and one active search per lead;
  - monthly generations, and at most 60 generations per minute per workspace (the shared rate limiter);
  - idempotent generation: a repeated request returns the saved draft without calling the AI again.
- **Refused requests cost nothing.** These checks run before the AI is called:
  - regenerating an edited draft without confirmation;
  - a stale version;
  - a sent message;
  - a follow-up before the first message is sent.
- **Recorded usage** (`outreach_usage`): pages read, mail-server lookups, and Gemini input and output tokens, including failed and refused generations. Credits and balances are recorded only when a provider reports them, never estimated.
- **Apollo:** reveals use Apollo's own ledger ([docs/APOLLO.md](APOLLO.md#credits)).

## Tests

No test contacts a real service or sends anything.

- **`npm run test:outreach`** runs the migration in embedded PostgreSQL with the real `outreach` and `analysis-worker` handlers. Websites, DNS (including MX records), Apollo data and the AI are simulated. It covers:
  - grants: exact grants and private tables;
  - normalization: email, phone (US, UK, no country, invalid) and WhatsApp;
  - extraction: people only with a name and a title; robots.txt;
  - email status and confidence rules;
  - discovery: with and without a business report, with per-detail sources and evidence citations;
  - searches: excluded addresses, idempotency, one active search per lead, recent search checks, cancellation;
  - partial searches (DNS outage, site timeout) and a failed search;
  - merging: confirmed and edited fields protected with suggestions, accepted and dismissed suggestions;
  - manual contacts: validation, duplicate email, deletion rights, deletions discovery respects, re-adding by hand;
  - Apollo: masked then revealed people, other workspaces' data ignored;
  - workspace isolation;
  - outreach settings: roles and validation;
  - recommendations and prompt fencing;
  - generation:
    - AI not configured;
    - grounded claims;
    - invented references dropped;
    - internal references stripped;
    - idempotency;
    - five kinds of unsupported claims and three malformed outputs refused, recorded as failed usage;
    - provider rate limits;
  - channels: WhatsApp without a subject, LinkedIn's 200-character limit (shortened or refused), placeholders, general introductions without evidence;
  - drafts:
    - edits as versions;
    - stale saves;
    - regenerating only after confirmation, refused before the AI is called;
    - restore;
    - manual sent status;
    - follow-ups only after sending, never pretending a reply;
    - duplicate, archive and delete rights;
  - verify refresh and the worker;
  - erasure;
  - log hygiene;
  - rollback and re-apply.
- **`tests/outreach.spec.ts`** (Playwright) runs the real UI against the real handlers and SQL. It covers:
  - outreach settings;
  - contact search on a team page with sources and confidence;
  - editing, confirming and preferring a contact;
  - a validated manual contact;
  - **Write outreach** from a contact;
  - a recommended, grounded email;
  - edit, then regenerate with the confirmation, version history and comparison;
  - copy without changing the status;
  - mark as sent, with the activity history entry and a follow-up reminder;
  - the LinkedIn character counter;
  - a refused unsupported claim;
  - working without an AI key.
- **`npm run test:tenancy`** checks the exact list of client-callable functions. **`npm run test:analysis`** now rolls back M8 before M7.

## Deployment

1. Apply the migration: `npx supabase db push --remote`, or run the migration SQL in the SQL editor.
2. Deploy the functions: `npx supabase functions deploy outreach analysis-worker`. Both include a `deno.json` that maps `libphonenumber-js/min` to npm. `supabase/config.toml` sets `verify_jwt = false` for `outreach`, as for `business-analysis`: the function checks the caller itself by passing their token to the database, and the gateway check would reject the browser's CORS preflight.
3. Optional: set `OUTREACH_AI_MODEL` and the `CONTACT_*` and `OUTREACH_MONTHLY_LIMIT` limits. `GEMINI_API_KEY` is already used by business reports.
4. The existing `leadflow-analysis-worker` Cron job (`supabase/ops/schedule-workers.sql`) also continues contact searches; no new schedule is needed.
5. Deploy the frontend.
6. In the app: **Settings → Outreach**, fill in the agency identity and your sender details. Then open a lead → **Contacts → Find contacts**, and **Outreach → Generate draft**.

To roll back: run `supabase/rollbacks/202611190001_outreach_intelligence.down.sql`, then redeploy the previous `analysis-worker`.

### Hosted rollout (19 November 2026)

**Applied to project `fzgxpwmqzmvgmijviaar`:**
- **Migration:** `npx supabase db push --remote` applied `202611190001` (a dry run first showed it as the only pending migration). `migration list` now shows it applied.
- **Functions:** `outreach` and `analysis-worker` deployed. `outreach` was deployed again after adding its `verify_jwt = false` entry. The first deploy used the default gateway check, which answered 401 before the function ran.

**Live checks, all passed:**
- **Boot:** `outreach` answers the CORS preflight from the app's origin with 204, and `analysis-worker` answers a wrong worker secret with its own 401. Both load `libphonenumber-js` through `deno.json` on the Edge runtime.
- **`outreach` refusals:** 403 for another origin, and 401 without a session or with an invalid one. These are the function's own messages, matching `business-analysis`.
- **Anonymous calls:** refused with `42501 permission denied` for `lead_contacts_for`, `outreach_usage_for`, `outreach_preferences_for`, and the service-role `claim_contact_discovery` and `record_outreach_usage`.

**Draft timeouts (same day):**
- **What happened:** the first real draft attempts failed. One Gemini call timed out at 110 seconds and the next returned "unavailable", both recorded in `outreach_usage`.
- **Fix:** drafts now request a low thinking level and allow 55 seconds per attempt, with one retry (see [Outreach drafts](#outreach-drafts)).
- **Deployed:** `outreach` was redeployed and boots.
- **Not yet confirmed:** a successful real draft hasn't been seen yet.

**Not yet done:**
- the frontend deploy;
- a signed-in contact search or draft against a real website and a real Gemini key;
- a scheduled worker run that continues a contact search.

## Limitations

- **Not live-tested end to end.** Automated checks used simulated websites, DNS, Apollo data and AI. The hosted migration and deployments are in place and pass the boot and access checks in [Hosted rollout](#hosted-rollout-19-november-2026). No real Gemini key, website, DNS resolver or Apollo account has yet been used with M8.
- **People need structure.** A name and a job title must appear together. Bios written as prose ("Jane started the studio in 2015") aren't turned into people.
- **Pages read, not the whole site.** Up to `CONTACT_MAX_PAGES` pages beyond the business report. JavaScript-only team pages may show nothing, because LeadFlow doesn't run JavaScript.
- **Mail-server checks** show that a domain accepts email, not that a mailbox exists. LeadFlow does no SMTP probing and no paid verification.
- **The LinkedIn message limit (1,300 characters)** is LeadFlow's own; LinkedIn's limit for messages wasn't verified (the help page checked returned 404). The 200-character invitation-note limit is from LinkedIn Help.
- **Snapshot leads.** Deleting a lead leaves its contacts and drafts. Erase the lead's contact data first.
- **Not built (later milestones):** sending email or WhatsApp; inbox or reply sync; LinkedIn automation; bulk outreach; sequences that send on a schedule; paid email-verification providers; a workspace-wide outreach board.
