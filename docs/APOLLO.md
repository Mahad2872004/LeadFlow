# Apollo.io lead generation

Added 1 November 2026. **Status: implemented, tested locally with a simulated Apollo API, and deployed to the hosted Supabase project.** The migration and both Edge Functions are live, but no real Apollo key has been used yet. The frontend needs a Vercel deploy.

- Migration: [`supabase/migrations/202611010001_apollo.sql`](../supabase/migrations/202611010001_apollo.sql); rollback: [`supabase/rollbacks/202611010001_apollo.down.sql`](../supabase/rollbacks/202611010001_apollo.down.sql)
- Edge Functions: [`apollo`](../supabase/functions/apollo/handler.ts) (every action) and [`apollo-webhook`](../supabase/functions/apollo-webhook/handler.ts) (phone results from Apollo)
- Service layer: [`_shared/apollo/client.ts`](../supabase/functions/_shared/apollo/client.ts) (HTTP, errors, normalization) and [`_shared/apollo/filters.ts`](../supabase/functions/_shared/apollo/filters.ts) (every filter, shared with the browser)
- UI: [`ApolloWorkspace.tsx`](../src/components/ApolloWorkspace.tsx), [`ApolloSearch.tsx`](../src/components/ApolloSearch.tsx), [`ApolloFilters.tsx`](../src/components/ApolloFilters.tsx), [`ApolloCredits.tsx`](../src/components/ApolloCredits.tsx), [`ApolloSaved.tsx`](../src/components/ApolloSaved.tsx), [`TagSelect.tsx`](../src/components/TagSelect.tsx)
- Tests: `npm run test:apollo` ([script](../scripts/test-apollo.mjs)) and [`tests/apollo.spec.ts`](../tests/apollo.spec.ts)

## Setup

1. **Create an API key in Apollo:** Settings → Integrations → API → Create new key. Either tick the endpoints listed under "Apollo endpoints used" below, or turn on **Set as master key**. Apollo's docs say free accounts need a work email for API access.
2. **Set the secrets** for the Edge Functions. Replace the placeholders, and keep each value on one line:
   ```powershell
   npx supabase secrets set --project-ref fzgxpwmqzmvgmijviaar "APOLLO_API_KEYS=primary:YOUR_APOLLO_KEY" "APOLLO_WORKSPACE_IDS=YOUR_WORKSPACE_ID"
   ```

   | Secret | Required | Value |
   |---|---|---|
   | `APOLLO_API_KEYS` | Yes, or `APOLLO_API_KEY` | Comma-separated `label:key` pairs, for example `primary:abc123,client-b:def456`. Labels use lowercase letters, numbers, `-` and `_`, and become the account IDs shown in LeadFlow. |
   | `APOLLO_API_KEY` | Alternative | One key; its account is called `default`. |
   | `APOLLO_WORKSPACE_IDS` | Yes | Comma-separated workspace IDs allowed to use Apollo, or `*` for all. A personal workspace's ID is its owner's user ID; the "not switched on" screen shows it. Apollo's terms allow use only for your own internal business, so don't list customers' workspaces. |
   | `DISCOVERY_ALLOWED_ORIGINS` | Already set | The app's origin, shared with lead discovery. |
   | `APOLLO_WEBHOOK_BASE_URL` | No | Defaults to `SUPABASE_URL`. It must be HTTPS for phone reveals. |

   No frontend (`VITE_`) variable is needed, and keys are never stored in the database or sent to the browser. Secrets take effect without redeploying.
3. **Add your first account:** open Discovery → Apollo → **Credits & accounts**. The account appears with its label.
   - Choose **Test connection**. This is a free call to Apollo's usage-stats endpoint.
   - Then choose **Sync credits from Apollo**.
   - Choose **Edit** to set a nickname, the monthly allowance (default 70), the reset day and notes.
4. **Search:** choose **Find people**, pick filters, then **Search people**.

To add another account, add another `label:key` pair to `APOLLO_API_KEYS`. To remove one, delete its pair; its history stays.

## Apollo endpoints used

Checked against docs.apollo.io on 1 November 2026. The base URL is `https://api.apollo.io/api/v1` and the key goes in the `x-api-key` header.

| Endpoint | Used for | Credits (Apollo's docs) |
|---|---|---|
| `POST /mixed_people/api_search` | Find people | 0. Returns no emails or phones, and last names are masked. |
| `POST /mixed_companies/search` | Find companies | 1 per page (up to 100 results). The docs conflict on free-plan access; a "paid plans only" answer is shown to the user as is. |
| `POST /people/bulk_match` | Reveal up to 10 people by ID | 1 per matched person (name, work email, profile), plus 8 per mobile number found. The response reports `credits_consumed`. |
| `POST /usage_stats/credit_usage_stats` | Sync credits | 0. Apollo's balance per credit type and the current billing cycle. |
| `POST /usage_stats/api_usage_stats` | Test connection | 0 |

**Phone numbers:** phone reveals send `reveal_phone_number=true` and a per-reveal HTTPS `webhook_url`. Apollo returns the email part immediately and sends the numbers to `apollo-webhook` minutes later, which records them and the credits Apollo reports.

**Rate limits:** Apollo's limit for free plans is 50 calls a minute per endpoint. LeadFlow paces each account to 60 calls a minute across all its actions, and reports Apollo's 429 responses with Apollo's `retry-after`. Only free calls (people search and usage stats) are retried automatically, and only once.

## Filters

Every filter is defined once in `filters.ts`, with its exact Apollo parameter.
- **People:** job titles (with "include similar"), excluded titles, seniority, keywords, person name, email status, person location (and excluded), company HQ location (and excluded), company domains, industries, company size, revenue, NAICS and SIC codes, technologies used (any, all, none), jobs being hired for, job locations, number of open jobs, job posting dates, and headcount growth with its period.
- **Companies:** name, domains, industries, keyword tags (and excluded), size, revenue, NAICS and SIC codes, HQ location (and excluded), technologies (any), latest round amount, total funding, latest round date, plus the hiring and growth filters.

**Not offered, because Apollo's API has no such parameter:**
- departments;
- a separate management-level filter (seniority covers it);
- funding filters on people search;
- a phone-availability filter (results show it instead);
- funding stage;
- "all of" and "none of" technologies on company search.

These are listed in the filter panel too.

**Values Apollo matches exactly:**
- Industry names are lowercase, for example `marketing & advertising`.
- Technology IDs use underscores, for example `wordpress_org`. LeadFlow converts spaces and dots automatically.

## Credits

- **The ledger:** `leadflow_private.apollo_ledger` records every credit-using request LeadFlow makes. Each entry stores the account, workspace, operation, the people it was for, the estimate, the credits, how they were known, the status, Apollo's request ID, any error and the time.
- **How credits are known:**
  - *reported*: Apollo's `credits_consumed`.
  - *documented*: Apollo's published fixed rate, for example 1 credit per company search page.
  - *estimated*: still pending, or the outcome is unknown.
- **No overspending:** before calling Apollo, a reservation locks the account row and checks the remaining allowance, so two reveals at once cannot overspend. Remaining credits never go below zero.
- **No double charges:** each operation ID is used once. A retry after a lost response returns the stored outcome without calling Apollo again. A request that times out after being sent is recorded as *outcome unknown*, and its estimate stays counted.
- **Cycles:** usage counts from the current cycle's start.
  - After **Sync credits from Apollo**, the cycle is Apollo's real billing cycle (`current_credit_cycle`).
  - Until then, it restarts on the reset day you set (not assumed to be the 1st).
  - History is kept across cycles.
- **Two kinds of figures:** the dashboard shows LeadFlow's ledger (allowance, used, remaining, usage %, and email, phone and search splits) next to Apollo's own reported balances. Apollo's figures also include credits used outside LeadFlow, so the two can differ.

## Multiple accounts, and what isn't built

Several accounts can be configured, for example separate teams or paid plans. You choose which one Discovery uses, and LeadFlow never switches accounts on its own.

**Automatic rotation to whichever account still has credits was deliberately not built.** Apollo's Terms of Service §4.2 say: *"You may not open multiple accounts for your use under a self-serve offering or otherwise take any actions which would allow you to circumvent the credit or rate limits which apply to self-serve offerings."* §3 also prohibits "any measure intended to circumvent limitations to purchased credits". For more credits, upgrade the Apollo plan and raise the allowance in **Edit**.

## Saving to LeadFlow

- **How saving works:** **Save to Leads** goes through `import_leads` as the signed-in user, so workspace membership and the duplicate rules apply as for any import. The same Apollo person or company is never saved twice.
- **What a lead records:** origin `apollo_people` or `apollo_organizations` (person or organization ID), the search, the account used, and when contact details were revealed. The lead details show all of this.
- **Leads saved before revealing:** these keep the masked name, such as "Sam Ri***a". A later reveal fills in the name, an empty email and an empty phone, and adds a history entry. Existing values are never overwritten.
- **What goes where:** job title, LinkedIn URL and the Apollo ID go in the lead's notes, because leads have no title field yet.
- **Lists:** saving can add leads to a new or existing list. The Leads page filters by list. Campaigns don't exist in LeadFlow yet.

## Security

- Each request checks:
  1. the origin;
  2. the session token, which the database validates;
  3. workspace membership (`apollo_member_role` runs as the caller);
  4. the `APOLLO_WORKSPACE_IDS` allowlist.
- Owners and admins edit and test accounts; any member searches, reveals and saves.
- All new tables are in `leadflow_private`, with RLS on and no client privileges.
- Revealed contacts are private to the workspace that revealed them.
- In the ledger, other workspaces' entries show counts, not names.
- Webhook URLs carry a random one-time token; only its SHA-256 hash is stored, and repeated deliveries change nothing.
- Logs contain the action, account label, outcome and HTTP status only. Tests assert that no key, email, phone number or token is logged.

## Limitations

- **Not live-tested:** no request has gone to the real Apollo API. Everything was tested against a simulator built from the documented shapes. Use the first real search and reveal to confirm free-plan access, especially for company search.
- **People search returns little:** names (masked), title, company name, and "has email", "has phone" and "has location" flags. Seniority, department, location and the company domain are not returned until a reveal.
- **Company search returns little:** no industry, size, location or description. Apollo's paid organization enrichment would add these, and isn't used.
- **No polling fallback for phones:** if a phone number doesn't arrive, its ledger entry stays *Waiting for Apollo* with its estimate counted.
- **Search limits:** results are capped at 50,000 (500 pages). LeadFlow's existing search limits also apply: 6 new searches a minute per person and 60 an hour per workspace. Page changes don't count toward these.

## Verification (1 November 2026)

Every check below was run on 1 November 2026 and passed:
- `npm run test:apollo`: grants, filter validation and exact query strings, access control, search, credits, idempotency, concurrency, webhooks, saving, lists, saved searches, log hygiene, rollback and re-apply.
- `npm run lint`, `npx tsc -b`, `npm run check:edge` and `npm run build`.
- `test:db`, `test:m3`, `test:integrations`, `test:tenancy`, `test:onboarding` and `test:discovery`.
- Browser tests, including 3 new Apollo journeys.

**Changes to existing tests:**
- `test-tenancy` lists the new member functions.
- The discovery browser tests open the "Find businesses" tab, because Discovery now opens on Apollo.

**Live checks on the hosted project:**
- 403 for another origin, 401 without a session, and 204 for CORS preflight.
- The webhook refuses unknown tokens.
- Anonymous calls to the new database functions are refused.
