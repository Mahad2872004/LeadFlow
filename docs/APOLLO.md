# Apollo.io lead generation

Added 1 November 2026. **Status: implemented, tested locally with a simulated Apollo API, and deployed to the hosted Supabase project.** The migration and both Edge Functions are live, but no real Apollo key has been used yet. The frontend needs a Vercel deploy.

- Migrations: [`202611010001_apollo.sql`](../supabase/migrations/202611010001_apollo.sql), [`202611010002_apollo_lead_history.sql`](../supabase/migrations/202611010002_apollo_lead_history.sql), [`202611010003_apollo_saved_results.sql`](../supabase/migrations/202611010003_apollo_saved_results.sql), [`202611010004_apollo_export.sql`](../supabase/migrations/202611010004_apollo_export.sql), each with a rollback in `supabase/rollbacks/`; rollback: [`supabase/rollbacks/202611010001_apollo.down.sql`](../supabase/rollbacks/202611010001_apollo.down.sql)
- Edge Functions: [`apollo`](../supabase/functions/apollo/handler.ts) (every action) and [`apollo-webhook`](../supabase/functions/apollo-webhook/handler.ts) (phone results from Apollo)
- Service layer: [`_shared/apollo/client.ts`](../supabase/functions/_shared/apollo/client.ts) (HTTP, errors, normalization) and [`_shared/apollo/filters.ts`](../supabase/functions/_shared/apollo/filters.ts) (every filter, shared with the browser)
- UI: [`ApolloWorkspace.tsx`](../src/components/ApolloWorkspace.tsx), [`ApolloSearch.tsx`](../src/components/ApolloSearch.tsx), [`ApolloFilters.tsx`](../src/components/ApolloFilters.tsx), [`ApolloCredits.tsx`](../src/components/ApolloCredits.tsx), [`ApolloSaved.tsx`](../src/components/ApolloSaved.tsx), [`TagSelect.tsx`](../src/components/TagSelect.tsx)
- Tests: `npm run test:apollo` ([script](../scripts/test-apollo.mjs)) and [`tests/apollo.spec.ts`](../tests/apollo.spec.ts)

## Setup

1. **Create an API key in Apollo:** Settings → Integrations → API → Create new key.
   - Either tick the endpoints listed under "Apollo endpoints used" below, or turn on **Set as master key**.
   - **Integration type:** choose **Private**, meaning internal use for your own business. *Public* is for apps offered to others, and *Reseller* is for reselling, which Apollo's standard terms don't allow.
   - Copy the key straight away.
   - **Check the plan warning on the key page.** On 1 November 2026, a Free account showed: *"These APIs aren't included in your Free plan and won't be accessible even with a master key."* The list included `people/bulk_match`, `people/match`, `mixed_people/api_search` and `mixed_companies/search`, which are every search and reveal endpoint LeadFlow uses. That warning was shown before the account was registered with a work email. Afterwards, **people search worked on the same Free account**: a real search on 1 November 2026 returned 1,768,393 people. This matches the endpoint docs, which say free accounts registered with a work email have access. Reveals (`people/bulk_match`) and company search are not yet confirmed on Free. If Apollo refuses them, LeadFlow shows "Apollo says this needs a paid Apollo plan" and charges nothing.
2. **Set the secrets** for the Edge Functions. Replace the placeholders, and keep each value on one line:
   ```powershell
   npx supabase secrets set --project-ref fzgxpwmqzmvgmijviaar "APOLLO_API_KEYS=primary:YOUR_APOLLO_KEY" "APOLLO_WORKSPACE_IDS=YOUR_WORKSPACE_ID"
   ```

   | Secret | Required | Value |
   |---|---|---|
   | `APOLLO_API_KEYS` | Yes, or `APOLLO_API_KEY` | Comma-separated `label:key` pairs, for example `primary:abc123,client-b:def456`. Labels use letters, numbers, `-` and `_`; they're lowercased and become the account IDs shown in LeadFlow. A bare key with no label is read as the account `default`. Quotes and spaces around values are ignored. |
   | `APOLLO_API_KEY` | Alternative | One key; its account is called `default`. |
   | `APOLLO_WORKSPACE_IDS` | Yes | Comma-separated LeadFlow workspace IDs allowed to use Apollo (no spaces), or `*` for all. These are LeadFlow IDs, not Apollo IDs; see "Finding your workspace ID" below. Apollo's terms allow use only for your own internal business, so don't list customers' workspaces, and replace `*` with specific IDs if other businesses ever sign up. |
   | `DISCOVERY_ALLOWED_ORIGINS` | Already set | Every address the app runs on, comma-separated, with no spaces and no trailing `/`. It's shared with lead discovery. Include local development addresses, for example `https://leadflow-tau-five.vercel.app,http://localhost:5173`. |
   | `APOLLO_WEBHOOK_BASE_URL` | No | Defaults to `SUPABASE_URL`. It must be HTTPS for phone reveals. |

   No frontend (`VITE_`) variable is needed, and keys are never stored in the database or sent to the browser. Secrets take effect without redeploying.

   **Checking that the secrets exist:** `npx supabase secrets list --project-ref fzgxpwmqzmvgmijviaar` lists names and digests, never values. To confirm the values work, open Discovery → Apollo and use **Test connection**.

   **Finding your workspace ID:**
   - In the Supabase dashboard → SQL Editor, run `select id, name from public.workspaces order by created_at;`.
   - Or set only `APOLLO_API_KEYS`, sign in as the workspace owner, and open Discovery → Apollo. The "Apollo isn't switched on for this workspace" screen shows the ID.
3. **Add your first account:** open Discovery → Apollo → **Credits & accounts**. The account appears with its label.
   - Choose **Test connection**. This is a free call to Apollo's usage-stats endpoint.
   - Then choose **Sync credits from Apollo**.
   - Choose **Edit** to set a nickname, the monthly allowance (default 70), the reset day and notes.
4. **Search:** choose **Find people**, pick filters, then **Search people**.

To add another account, add another `label:key` pair to `APOLLO_API_KEYS`. To remove one, delete its pair; its history stays.

## Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| "We couldn't load Apollo. We couldn't reach LeadFlow." The browser's network tab shows a CORS error and a 403 preflight. | The page's address isn't in `DISCOVERY_ALLOWED_ORIGINS`. Running locally (`npm run dev`) is the usual cause. | Add the exact address from the address bar, for example `http://localhost:5173`, keeping the live site in the list. Reload. |
| "No Apollo API key has been added yet" | Neither `APOLLO_API_KEYS` nor `APOLLO_API_KEY` is set. | Set `APOLLO_API_KEYS=primary:YOUR_KEY`. |
| "The Apollo API key couldn't be read" | A key secret is set, but no key could be read from it: it's shorter than 8 characters, contains spaces or commas inside the key, or was cut off. Before the 1 November fix, this also showed as "No Apollo API key has been added yet". | Set it again on one line: `"APOLLO_API_KEYS=primary:YOUR_KEY"`, copied straight from Apollo. |
| "Apollo isn't switched on for this workspace" | This workspace's ID isn't in `APOLLO_WORKSPACE_IDS`. Older frontends also showed this for an unreadable key. | Add the ID the screen shows, or use `*`. |
| Test connection: "Apollo rejected the API key" | The key is wrong, deleted or mistyped. | Create a new key in Apollo and set it again. |
| Search or reveal: "Apollo says this needs a paid Apollo plan" | Apollo doesn't offer that endpoint on this account's plan; see step 1. Registering the account with a work email unlocked people search. | Upgrade the Apollo plan, or use Apollo's website and Import CSV in LeadFlow. |
| "This API key isn't allowed to use this Apollo endpoint" | A scoped key without that endpoint ticked. | Edit the key in Apollo: tick the endpoint, or make it a master key. |

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

## Not paying twice

- **Saved result pages (migration `202611010003`):**
  - Every page fetched from Apollo is saved for the workspace for 90 days, up to 1,000 pages.
  - Repeating a search, or opening a page already fetched, shows the saved page with "Saved results from … No credits used." Filters in a different order count as the same search.
  - **Refresh from Apollo** fetches again. For company search that costs 1 credit, after confirmation.
  - Company search asks for the credit only when Apollo actually has to be called.
  - Leaving the Apollo tab and coming back restores the last results from saved pages. This never calls Apollo.
- **No re-reveals:** people already revealed in the workspace are skipped, in the browser and on the server, so they're never sent to Apollo or charged again. A phone lookup is skipped for anyone whose phone was already looked up.
- **Hide saved results:** "Hide people already in LeadFlow" (or companies) on the results table removes anyone already saved.
- **Website column:** people search doesn't return a website. The company website appears after a reveal (Apollo's company domain) and is saved on the lead.

## Export, and reopening an export

- **Export all found (CSV)**, on Find people or Find companies (migration `202611010004`):
  - It exports every person or company Apollo has found in this workspace, once each, taken from the saved result pages.
  - For people, it adds every revealed email and phone, including people whose result pages have expired.
  - People columns: Apollo person ID, name, title, company, company domain, email, email status, phone and type, LinkedIn, city, state and country, when the email and phone were revealed, whether Apollo has an email or direct phone, whether the person is already in LeadFlow, and Apollo's update date.
  - Companies get their own columns.
  - At most the newest 20,000 records are included. Cells that start with `=`, `+`, `-` or `@` are prefixed so spreadsheets don't run them as formulas, and the file starts with a byte-order mark so Excel reads accents correctly.
- **Open an export** (Find people): choose a file with an "Apollo person ID" column, such as a LeadFlow export, even one edited in a spreadsheet.
  - Its people (up to 5,000) load into the results table with their current reveal status from the database.
  - No search runs and no credits are used.
  - **Select not yet revealed** picks everyone still to reveal. Revealing then uses the Apollo ID only, and people already revealed are skipped.
- **What's stored where:**
  - Saved leads, revealed contact details and the credit history are kept permanently in the database.
  - Search result pages are kept for 90 days, up to 1,000 per workspace.
  - Export a CSV to keep a list of people you haven't revealed or saved for longer.

## Saving to LeadFlow

- **How saving works:** **Save to Leads** goes through `import_leads` as the signed-in user, so workspace membership and the duplicate rules apply as for any import. The same Apollo person or company is never saved twice.
- **What a lead records:** origin `apollo_people` or `apollo_organizations` (person or organization ID), the search, the account used, and when contact details were revealed. The lead details show all of this.
- **Leads saved before revealing:** these keep the masked name, such as "Sam Ri***a". A later reveal fills in the name, an empty email and an empty phone, and adds a history entry. Existing values are never overwritten.
- **What goes where:** job title, Apollo's email status (such as "verified"), LinkedIn URL and the Apollo ID go in the lead's notes, because leads have no title field yet. The name is the most complete one Apollo returns: its `name` field can be abbreviated ("Jennifer L") while `first_name` and `last_name` are whole.
- **History:** a saved lead's history says "Saved from Apollo (account …)". Migration `202611010002` also rewords Apollo leads saved earlier.
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

- **Partly live-tested:** people search was confirmed against the real Apollo API on 1 November 2026 (Free account, work email). Reveals, phone webhooks and company search have so far been tested only against the simulator built from Apollo's documented shapes.
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

**Setup follow-ups, 1 November 2026:**
- `APOLLO_API_KEYS`, `APOLLO_WORKSPACE_IDS` and `DISCOVERY_ALLOWED_ORIGINS` were confirmed set by name.
- Only `https://leadflow-tau-five.vercel.app` was an allowed origin at that point; local addresses were refused.
- Key parsing was relaxed (bare key, quotes and spaces), and a specific "couldn't be read" status was added. `test:apollo` covers both, and the `apollo` function was redeployed.
