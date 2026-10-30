# Lead discovery (M6)

Added 31 October 2026 as the first milestone of the expanded vision. **Status: implemented and verified locally; database and function deployed to the hosted project on 31 October 2026; frontend not deployed; no provider configured.** Live discovery has never run against a real directory: every automated test uses a simulated geocoder and directory.

**Hosted rollout, 31 October 2026:**
- `202610310001` was the only pending migration. It was applied with `supabase db push`, and the migration history now matches.
- `discover-leads` was deployed (version 1, `verify_jwt: false`). No other function was redeployed.
- Smoke checks against the live function:
  - another origin gets 403;
  - a request without a session gets 401;
  - the CORS preflight gets 204;
  - a search answers 503 `not_configured`, because no `OSM_*` secrets are set.
- Anonymous calls to `import_leads`, `lead_origins_for`, `discovery_history_for`, `start_discovery_search`, `finish_discovery_search` and `remember_discovery_place` are all refused with 42501.
- `DISCOVERY_ALLOWED_ORIGINS` is not set, so the function uses `PORTAL_ALLOWED_ORIGINS`.
- No signed-in or two-account check has been run on the hosted project.

- Migration: [`supabase/migrations/202610310001_lead_discovery.sql`](../supabase/migrations/202610310001_lead_discovery.sql)
- Rollback: [`supabase/rollbacks/202610310001_lead_discovery.down.sql`](../supabase/rollbacks/202610310001_lead_discovery.down.sql)
- Edge Function: [`discover-leads`](../supabase/functions/discover-leads/handler.ts)
- Provider layer: [`supabase/functions/_shared/discovery/`](../supabase/functions/_shared/discovery/)
- UI: [`LeadDiscovery.tsx`](../src/components/LeadDiscovery.tsx) (page and history), [`DiscoverySearch.tsx`](../src/components/DiscoverySearch.tsx) (search, results, import), [`CsvImport.tsx`](../src/components/CsvImport.tsx), [`LeadForm.tsx`](../src/components/LeadForm.tsx) (manual entry), [`LeadProvenance.tsx`](../src/components/LeadProvenance.tsx) (lead details)
- Client logic: [`src/lib/discovery.ts`](../src/lib/discovery.ts), [`src/lib/leadKeys.ts`](../src/lib/leadKeys.ts), [`src/lib/csv.ts`](../src/lib/csv.ts)
- Tests: [`scripts/test-discovery.mjs`](../scripts/test-discovery.mjs) (`npm run test:discovery`), [`tests/discovery.spec.ts`](../tests/discovery.spec.ts)

## What works

| Capability | State |
|---|---|
| Ideal-customer search: industry or custom niche, up to 3 locations (US, UK, Australia) by city, state/region and postcode, radius, contact filters, results per location | Implemented. Runs only once a provider is configured. |
| Results: name, category, website, phone, public email, address, data freshness, source link, attribution, duplicate status | Implemented. A column the provider can't fill is never shown as data. |
| Filter, sort and exclude results; details dialog with copy and safe links; select one, several or all | Implemented |
| Import selected businesses, with review of possible duplicates | Implemented |
| Manual business entry (website, industry, address, city, region, postcode, country; email now optional) with a duplicate warning | Implemented |
| CSV import: upload, automatic column matching, per-row validation, duplicate review, batched idempotent import, summary, download of rows not imported | Implemented |
| Search history (criteria, counts, status, who ran it) with "Use these criteria" | Implemented |
| Provenance on each imported lead (method, provider, record, search, freshness, source link) | Implemented |
| A live provider returning real businesses | **Awaiting configuration.** The code path is tested against a simulated directory only. |

## Overture directory (default provider since 31 October 2026)

The free OpenStreetMap servers failed in live use:
- Overpass was overloaded: a 3-result query took 39 seconds, and a city query timed out.
- Nominatim answered 403 to requests from Supabase.

LeadFlow therefore searches its own copy of **Overture Maps places**, loaded into `leadflow_private.directory_places` (migration `202610310002`). Searches run in Postgres through `directory_search`, with no outside call and no rate limit.

**Licence and attribution:**
- The data is CDLA Permissive 2.0, or Apache 2.0 for Foursquare-sourced records. It has no share-alike obligation and may be stored.
- Results credit "Overture Maps Foundation" and link to its attribution page.

**Categories:** each LeadFlow category maps to Overture taxonomy IDs found in the data, for example `dental_clinic`, `attorney_or_law_firm`, `marketing_agency`, `contractor` and `gym`. The list is `overtureCategories` in [`overture.ts`](../supabase/functions/_shared/discovery/overture.ts).

**Loading:** `npm run directory:load` ([`scripts/load-overture.mjs`](../scripts/load-overture.mjs)).
- It reads Overture's public S3 data with DuckDB.
- It keeps records with confidence ≥ 0.5 that are not permanently closed.
- It removes duplicates from different sources by name and postcode, normalizes values, and uploads them in batches with the service-role key.
- It then deletes the loaded countries' rows from older releases.
- Options: `--countries US,GB,AU`, `--regions TX,CA`, `--categories dental,legal` and `--dry-run` (prints counts and an estimated size; writes nothing).
- It needs `SUPABASE_SERVICE_ROLE_KEY` in the environment.
- Overture keeps a release for only 60 days, so re-run it monthly.

**Measured on 31 October 2026:** a Texas dry run for dentists found 15,737 businesses after duplicates were removed (about 5 MB). It took 13 minutes, mostly scanning Overture's US files. Loading all three countries with every category may need more space than a free Supabase plan's 500 MB, so check with `--dry-run` first.

**Search behaviour:**
- A city matches the address town, and the state when given (full US and Australian state names are accepted). Nearby suburbs are separate towns.
- A postcode searches the chosen radius around the average position of businesses with that postcode.
- UK searches ignore the region.
- Records have no public page, so provenance keeps the Overture ID and the source's update date.

The OpenStreetMap provider below is still in the code. It appears only if its `OSM_*` settings are present.

## Provider decision (original, OpenStreetMap)

Checked on 31 October 2026 against the official pages. This is not legal advice.

**Google Places API (New): not used for importing.** Google's Places policies say "You must not pre-fetch, cache, or store Places API content beyond the allowed exceptions", and only `place_id` may be stored indefinitely. Earlier research quotes the Maps Platform terms §3.2.3(a): customers will not "copy and save business names, addresses, or user reviews". Copying Places results into lead records, which is this milestone's core action, therefore conflicts with the terms. Text Search also returns at most 60 results per query, and requesting website or phone bills at the Enterprise tier ($35 per 1,000 after 1,000 free a month). A live, display-only Google search that stores only `place_id` could still be added later as a separate provider, after legal review.

**OpenStreetMap (Nominatim + Overpass): implemented as the first provider.**
- The data is © OpenStreetMap contributors under the ODbL, which permits storage with attribution.
- Coverage and fields:
  - US, UK and Australia are covered.
  - Fields are name, category, website, phone, public business email, address and last-edited date.
  - There are no ratings, review counts or company size, so no filters for them are offered.
- **The public servers are not a production backend.** The Overpass wiki says "Commercial use should use self-hosted or paid Overpass servers". Nominatim's policy limits use to 1 request a second, requires an identifying User-Agent and caching, and requires that the server can be switched.
- LeadFlow therefore ships **with no default endpoints**: discovery stays off until an operator chooses servers whose terms fit their use. This adds no paid dependency silently.
- **Open question for counsel:** whether storing OpenStreetMap records (which include phone and email) in customer CRMs creates an ODbL "derivative database" that is "publicly used" and so triggers share-alike. The OSMF geocoding guideline's safe harbour covers names, addresses and coordinates only.

Next candidates are described in the expanded-vision lead source research:
- Overture Maps Places extracts, which are storable;
- UK Companies House and Australia's ABN Lookup, which are official registers but have no phone or website;
- a Google live-only pattern.

That research is in `docs/expanded-vision-research/`, currently kept in the git stash (see the M6 report).

## Setup

1. Apply the migration (after `202610250001`), then deploy the function:
   ```sh
   npx supabase db push
   npx supabase functions deploy discover-leads
   ```
   `supabase/config.toml` sets `verify_jwt = false` for this function. The handler authenticates instead by passing the caller's token to the database, and a gateway JWT check would also reject the browser's unauthenticated CORS preflight.
2. Set the function secrets. Names are listed in `supabase/.env.example`.

   | Secret | Purpose |
   |---|---|
   | `DISCOVERY_ALLOWED_ORIGINS` | Comma-separated origins of the LeadFlow app, e.g. `https://leadflow-tau-five.vercel.app`. If unset, the function falls back to `PORTAL_ALLOWED_ORIGINS`, then `INQUIRY_ALLOWED_ORIGINS`. Set it explicitly. |
   | `OSM_NOMINATIM_URL` | Base URL of a Nominatim server, e.g. a self-hosted one or a commercial host. The public `https://nominatim.openstreetmap.org/` is permitted only for moderate, user-triggered use within its policy. |
   | `OSM_OVERPASS_URL` | Full interpreter URL of a self-hosted or paid Overpass server, ending in `/api/interpreter`. |
   | `OSM_USER_AGENT` | An application-specific User-Agent with a contact, e.g. `LeadFlow/1.0 (ops@yourdomain.example)`. |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | Provided automatically on hosted Supabase. If the project has no legacy anon key, set `SUPABASE_PUBLISHABLE_KEY`. |
3. Without these secrets, the page shows "Business search hasn't been set up". Owners and admins also see the names of the missing settings (never their values). CSV import and manual entry still work.
4. Show the attribution wherever results appear. The UI already does this, and every imported lead links to its source record.

## How it works

```mermaid
sequenceDiagram
  participant B as Browser (member)
  participant F as discover-leads
  participant D as Postgres
  participant P as Provider
  B->>F: search {workspaceId, searchId, criteria} + user token
  F->>F: validate criteria against provider capabilities
  F->>D: start_discovery_search (as the user: membership + quotas, records criteria)
  F->>P: geocode (cached 30 days) and search, server-side, identifying User-Agent
  F->>D: finish_discovery_search (service role: status and count only)
  F-->>B: normalized results + attribution (not stored)
  B->>D: import_leads(workspace, requestId, rows) as the user
  D-->>B: imported / skipped with reasons; revision advanced
```

### Provider interface

[`types.ts`](../supabase/functions/_shared/discovery/types.ts) defines `DiscoveryProvider`:
- `capabilities`: countries, categories, custom niche support, the filters it can really apply, maximum locations and results, pagination (`none` or `cursor`), the fields it returns, attribution and plain-language notes. The UI is built from these, so unsupported filters never appear.
- `missingConfiguration(env)`: names of missing settings.
- `search(context, criteria, cursor)`: returns `DiscoveredBusiness[]`, `truncated`, `nextCursor` and `warnings`, or throws a `ProviderError` of kind `rate_limited`, `unavailable`, `timeout`, `location_not_found` or `bad_response`.

The context supplies `fetch`, `sleep`, a shared per-minute budget (`rateSlot`), and a place cache. Provider code never touches leads, workspaces or authorization.

The OpenStreetMap provider:
- looks up each location with Nominatim's structured search;
- searches inside the place's boundary, or around a postcode (or a city mapped only as a point, at least 10 km);
- maps categories to documented tags (for example `amenity=dentist`/`healthcare=dentist` and `office=lawyer`);
- applies the contact filters in the query, and matches custom niches against names among shops, offices, amenities, crafts, healthcare and leisure places.

Overpass has no pagination, so each location returns at most the chosen limit (10–100). The response says when more matched (`truncated` and a warning) instead of silently dropping them. Values that don't fit a lead are dropped, never repaired: invalid URLs, phone numbers or emails become empty. Overpass 429 responses are reported with a 30-second wait; 502–504 and network errors are retried once; time-outs are explained.

Mapped tags are best effort. `craft=builder` and `office=construction_company` (construction) are not confirmed as documented values.

### Adding a provider

1. Implement `DiscoveryProvider` in `supabase/functions/_shared/discovery/<name>.ts`. Normalize with `normalize.ts`, and throw `ProviderError` for upstream failures.
2. Read its settings from `env`, and return the names of any that are missing from `missingConfiguration`. Never return values.
3. Declare only fields and filters the provider really supplies, and its attribution.
4. Check its terms. If they don't allow storing a field, don't return it in `DiscoveredBusiness`, because whatever is returned can be imported. A display-only provider needs a different import path.
5. Add it to `registry.ts`. Give it a label in `providerLabels` in `LeadProvenance.tsx`.
6. Add handler tests modelled on section 4 of `scripts/test-discovery.mjs`, with a simulated upstream.

## Data model (migration 202610310001)

- **`public.leads`:**
  - New columns, each defaulting to `''`: `website` (http/https, ≤300), `industry`, `address`, `city`, `region`, `postcode`, and `country` (ISO 3166-1 alpha-2).
  - `email` may now be empty.
  - New service `Not specified`; new sources `Lead discovery` and `CSV import`.
  - `save_workspace_for` is replaced to carry the new columns. Older payloads without them store empty values.
- **`leadflow_private.lead_origins`:** import provenance keyed by lead ID, with no foreign key because snapshot saves replace leads. It is unique per workspace and provider record. Snapshot saves delete origins whose lead is gone.
- **`leadflow_private.discovery_searches`:** history. It stores the criteria (≤4 KB), status, count and failure type; provider results are never stored.
- **`leadflow_private.discovery_places`:** geocoder cache, 30 days, shared because it holds public place lookups only.
- **`leadflow_private.lead_import_requests`:** idempotency receipts for imports.

All new tables have RLS enabled and no client privileges.

**Future analysis** (website audits, SEO, opportunity detection) should live in its own tables that reference `(workspace_id, lead_id)` the same way, so a report attaches to a lead without another lead record and without re-running discovery. M6 adds no analysis fields.

## API

**Edge Function `discover-leads`** (POST, JSON; the browser's `Authorization: Bearer <session token>`; origin must be allowed):
- `{ "action": "status" }` returns `{ providers: [{ id, label, configured, missing, capabilities }] }`.
- `{ "action": "search", workspaceId, searchId (new UUID), provider, criteria }` returns `{ searchId, provider, fetchedAt, criteria, results, truncated, nextCursor, warnings, attribution }`.
- Errors:
  - 400: malformed request;
  - 401: no or expired session;
  - 403: not a member, or origin not allowed;
  - 409: reused search ID;
  - 422: invalid criteria or no location found;
  - 429: LeadFlow quota or provider rate limit, with `retryAfter`;
  - 502/503: provider failure, or `code: "not_configured"`.

**Database functions:**

| Function | Who may call it | Purpose |
|---|---|---|
| `import_leads(target_workspace, request_id, payload)` | Any member | Appends 1–250 rows. Same provider record or same email is always skipped. Same website domain, same phone (last 9 digits) or same name with the same city/postcode is skipped unless the row has `allowDuplicate` after review. Rows are also checked against earlier rows in the batch. Existing leads are never changed. The workspace revision advances. A retry with the same request ID returns the stored result; a different payload under that ID fails with 23505. |
| `lead_origins_for(target_workspace)` | Any member | Provenance of leads that still exist. |
| `start_discovery_search(target_workspace, search_id, provider, criteria)` | Any member, through the function | Quotas: 6 searches per person per minute and 60 per workspace per hour. |
| `discovery_history_for(target_workspace)` | Any member | The last 25 searches. Runs unfinished after 2 minutes are reported as interrupted. |
| `finish_discovery_search`, `discovery_place`, `remember_discovery_place` | Service role only | Outcome recording and the geocoder cache. |

Upstream budgets are shared across all workspaces through the existing `inquiry_rate_limit`: at most 60 geocoder and 60 directory calls a minute.

## Security notes

- Membership is checked in the database for every search, import and read. The workspace ID in a request only selects a workspace.
- Members can import, but only owners and admins can remove leads, as before.
- Provider endpoints and the User-Agent are server-side secrets. The status response lists missing setting names only, and tests assert that no secret or endpoint appears in it.
- No LeadFlow credential is sent to providers.
- Criteria are validated against the provider's capabilities, and custom niches are restricted to letters, numbers, spaces, `&`, `'` and `-` before they reach the Overpass query.
- Imported fields are validated again in SQL (lengths, control characters, email, phone, http(s) website, country code), on top of table constraints.
- External links open with `noopener noreferrer`, and website links also carry `nofollow`. Only normalized http(s) URLs become links.
- The CSV file of rows not imported prefixes cells starting with `= + - @` so spreadsheets don't run them as formulas.
- Logs record only the search ID and failure type.

## Known limitations

- **No live provider has been exercised.** Results quality, Overpass query cost on large cities and Nominatim matching of region names are unverified.
- OpenStreetMap coverage is uneven and community-maintained. Discovered email addresses are rare; there are no ratings, reviews or company size.
- One result page per location (no pagination). A city without a mapped boundary is searched as a point with at least a 10 km radius.
- The client keeps results in memory only. Leaving the page discards them; history keeps the criteria.
- Duplicate checks match exact normalized keys only. There is no fuzzy matching (for example "St" against "Street"), and a manually created lead (snapshot save) is only warned about, not blocked.
- The CSV import is limited to 2 MB and 2,000 rows, imported in batches of 250. A failed batch can be retried safely, but batches already done stay imported.
- On rollback, leads without an email get a placeholder `no-email+…@leadflow.invalid` address, because the earlier schema requires one.
- Accounts and data-protection duties (for example legitimate-interest assessments for UK/EU contacts) are the agency's responsibility. The import screen reminds users, but nothing is enforced.

## Verification (31 October 2026, local)

Every check below was run on 31 October 2026 and passed:
- `npm run lint`, `npx tsc -b`, `npm run check:edge` and `npm run build`;
- `npm run test:db`, `test:m3`, `test:integrations`, `test:tenancy`, `test:onboarding` and the new `test:discovery`;
- `npx playwright test`: 36/36 on the final two consecutive runs, including 5 new discovery tests;
- `npm run test:production`: 36/36.

**Intermittent failures:** two earlier full development runs each had one failure, in different pre-existing tests:
- the onboarding journey;
- the integrations receipt test, which timed out at sign-in while the Vite dev server logged "@vitejs/plugin-react can't detect preamble".

Both passed on rerun. Neither failure appeared in the production-build runs.

**How it was tested:** real migration SQL in PGlite (PostgreSQL), and the real `discover-leads` handler in Node and in the browser tests. Auth, HTTP transport, Nominatim and Overpass were simulated.

**Changes to existing tests:**
- `test-db` and `test-tenancy` now expect the empty business fields on loaded leads.
- `test-tenancy` expects the four new member functions in the exact grant list.
- Browser tests use the renamed "Name \*" and "Email (optional)" labels.
- Three mobile layout tests caught the eighth navigation item overflowing. The navigation now scrolls within itself below 850 px and keeps the current section in view.

## Deferred (not in M6)

- AI website audits, SEO/UX/performance analysis, opportunity detection and service matching.
- Contact enrichment, email finding or verification.
- Outreach of any kind: email generation, sequences, WhatsApp, LinkedIn or bulk messaging.
- Further providers (Overture extracts, company registers, Google live search).
- Pagination, saved search alerts and map views.
- Team permission changes.
