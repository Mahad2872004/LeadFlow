# M3 setup: website inquiries and email

The code is ready for configuration. No live deployment or external email delivery was performed for this milestone. You asked to set up the services yourself; use the steps below in order. Existing M1/M2 data and policies remain intact.

## 1. Configure the destination account and migrate

Use your existing Supabase project. Find the internal dashboard user's UUID in **Authentication → Users**. That is the destination workspace, not an email address. Keep public signup and anonymous sign-in disabled. The public form does not create or need a Supabase Auth account.

Apply **only** `supabase/migrations/202610180002_m3.sql` if M2 is already applied. On a new database, apply both migrations in filename order. Use the SQL editor or the Supabase CLI:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Do not run `db reset` on your existing project. The new migration is additive: a private schema holds receipts, notification jobs, and rate counters. It does not alter existing RLS or delete lead data. Keep `leadflow_private` out of the API's exposed schemas. Even if accidentally exposed, its tables have RLS enabled and no anonymous/authenticated grants or policies.

## 2. Create Cloudflare Turnstile keys

Create a Managed Turnstile widget in Cloudflare and register the hostname that serves `/inquiry` (no protocol or path). For local testing, register your local hostname or use Cloudflare's official test keys **only in a disposable local environment**. There is no CAPTCHA bypass in the application.

- Public site key → `VITE_TURNSTILE_SITE_KEY` in root `.env.local`.
- Secret key → `TURNSTILE_SECRET_KEY` in Supabase Edge Function secrets.
- `TURNSTILE_HOSTNAMES` → comma-separated allowed widget hostnames, e.g. `forms.example.com`.

The server validates the token, hostname, and `inquiry` action. Tokens expire after five minutes and are single-use; the form reloads verification after every submission attempt. See [Cloudflare server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) and [testing keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).

## 3. Configure Resend

1. Create a Resend account on the Free plan. Add a domain you own (a sending subdomain such as `mail.example.com` is suitable). Publish the DNS verification/authentication records Resend provides and wait for verification to complete.
2. Create a sending API key, restricted to your sending domain where supported. Put it in the Supabase secret `RESEND_API_KEY`, never in a `VITE_` variable.
3. Set `NOTIFICATION_FROM` to a verified sender, e.g. `LeadFlow <inquiries@mail.example.com>`.
4. Set `NOTIFICATION_TO` to the business inbox you want to notify. One recipient is supported. No visitor can choose the recipient, sender, destination account, or website identifier.

As checked on 18 October 2026, Resend Free lists **3,000 emails/month, 100/day, and three domains**. Other applications on the same account consume the same quota. Rate limits and deliverability restrictions still apply; stay on Free and do not enable paid overages for this milestone. Recheck current limits in your account. See [pricing](https://resend.com/pricing) and [account quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits).

Resend's `onboarding@resend.dev` test sender can send only to the email address associated with your Resend account. It is not a production sender for arbitrary business recipients. See [test-domain restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain) and [domain setup](https://resend.com/docs/dashboard/domains/introduction).

The notification is plain text. It includes name, email, company, service, website identifier, and inquiry reference. The phone and full message stay in LeadFlow; neither is included in the email. There are no visitor confirmation emails, mailing lists, or other integrations.

## 4. Set server secrets and deploy the functions

Copy `supabase/.env.example` to ignored `supabase/.env.local` and fill all values. For values containing spaces, use dotenv quotes, e.g. `NOTIFICATION_FROM="LeadFlow <inquiries@mail.example.com>"`.

- `WEBSITE_OWNER_ID`: internal account UUID from step 1.
- `WEBSITE_ID`: stable lowercase identifier, e.g. `main-website` (letters, numbers, hyphens, up to 64 characters).
- `INQUIRY_ALLOWED_ORIGINS`: exact comma-separated origins, including protocol and port, with **no trailing slash**, e.g. `https://forms.example.com,http://localhost:5173`.
- `TURNSTILE_HOSTNAMES`: hostnames allowed by the widget, without protocol or port.
- `TURNSTILE_SECRET_KEY`: Cloudflare secret.
- `EMAIL_HASH_SECRET`: a random secret of at least 32 characters for keyed email quota hashes.
- `RESEND_API_KEY`, `NOTIFICATION_FROM`, `NOTIFICATION_TO`: email configuration above.
- `NOTIFICATION_WORKER_SECRET`: a different random secret of at least 32 characters, used only for the retry worker.

Generate each random secret separately using a password manager or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Hosted Edge Functions receive `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from Supabase automatically. Do not copy the service-role key into frontend configuration or the repository.

```powershell
npx supabase secrets set --env-file supabase/.env.local
npx supabase functions deploy submit-inquiry
npx supabase functions deploy retry-notifications
```

`supabase/config.toml` disables gateway JWT verification **only for these two functions**. The inquiry endpoint authenticates its public input through CAPTCHA and abuse controls, not dashboard tokens. The worker requires its server-only `x-worker-secret` header. Neither change grants anonymous database access or changes the dashboard Auth gate. See [Supabase function configuration](https://supabase.com/docs/guides/functions/function-configuration).

For local function development, with Docker and Supabase CLI installed, run `npx supabase start`, apply migrations to the disposable local database, then `npx supabase functions serve --env-file supabase/.env.local`. Use local keys and a local user UUID. Do not mix a local server URL with production secrets. The application has no development-only CAPTCHA bypass.

## 5. Run and embed the form

Keep the existing frontend Supabase URL and publishable key in root `.env.local`, and add the public widget site key:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_KEY
VITE_TURNSTILE_SITE_KEY=YOUR_PUBLIC_TURNSTILE_SITE_KEY
```

Run `npm run dev`, then open `/inquiry`. The private dashboard stays at `/`. Restart Vite after changing environment variables; rebuild after changing production configuration. Deploy `npm run build` output with SPA fallback to `index.html` so direct navigation to `/inquiry` works.

For an independent demo, open `/inquiry` in a signed-out/private browser. The form does not load dashboard Auth state or require a public key header; it sends only to the public function. On a static host, add an appropriate CSP permitting your Supabase function origin and Cloudflare scripts/frames. Keep the dashboard's framing policy restrictive; permit embedding only the public form route when supported by the host. Supply your own business identity/privacy notice before publishing.

Embed the hosted page in another website:

```html
<iframe
  src="https://forms.example.com/inquiry"
  title="Project inquiry"
  loading="lazy"
  style="display:block;width:100%;height:1600px;border:0;border-radius:16px"
></iframe>
```

The iframe's origin (`https://forms.example.com`), not its parent website, belongs in `INQUIRY_ALLOWED_ORIGINS` and the Turnstile hostname list. The iframe scrolls internally if needed; automatic cross-origin height messaging is not implemented. Host headers such as CSP `frame-ancestors` must allow the intended parent. Avoid sandboxing that removes the iframe's origin; `Origin: null` is rejected.

For a custom native website form, send a JSON POST to `SUPABASE_URL/functions/v1/submit-inquiry` with:

```json
{
  "requestId": "a-client-generated-UUID",
  "token": "fresh-Turnstile-token-with-inquiry-action",
  "website": "",
  "inquiry": {
    "name": "Alex Example",
    "email": "alex@example.com",
    "phone": "",
    "company": "Example Studio",
    "service": "Web development",
    "message": "A fictional project inquiry."
  }
}
```

`website` is the empty honeypot field, **not** the integration identifier. The destination and identifier are configured only on the server. Register the custom form's origin and hostname. Reuse the request ID and normalized details after an uncertain response, obtain a fresh CAPTCHA token, and start a new UUID only for a new inquiry. Responses never expose private leads or email status: 200 means stored, 400/422 means invalid/expired verification or input, 403 means an unapproved origin, 409 means the UUID was reused for different details, 429 means a quota, and 503 means service/configuration trouble or an unconfirmed save. Retry an unconfirmed save with the same UUID.

## Reliability and abuse controls

- All fields are normalized and validated on the server. Database checks add another validation layer. Name/email/service/message are required. Phone/company are optional. Source is always `Website`; activity identifies the server-configured website.
- Body size is capped at 16 KB while streaming. Honeypot, exact origin allowlist, hostname/action-checked Turnstile, a persisted **60 attempts/minute per website** gate, **five accepted inquiries/email/hour**, and **50 accepted inquiries/website/rolling 24 hours** bound abuse and free-tier use. Quotas are enforced in PostgreSQL, not per Edge instance. Idempotent replays do not consume accepted-inquiry quota, but still require CAPTCHA and pass the minute gate.
- Client IP headers are not trusted; email is keyed-hashed for quota bookkeeping. CORS alone is not authentication, and determined visitors can still consume shared quotas and deny service to others. These controls are suitable for a low-volume form, not volumetric DDoS protection. Monitor platform usage and enable host/platform protections as needed.
- Receipt, lead, initial activity, workspace revision, and notification job are committed atomically. A stale M2 snapshot fails rather than erasing a website inquiry. Use **Refresh** in the dashboard to retrieve new inquiries; Realtime is not enabled.
- The client retains only a random request ID and normalized-payload hash in sessionStorage, never contact details. That supports retries and same-tab reload deduplication. Separate tabs/new sessions or explicitly starting another inquiry can create a legitimate new lead with the same email; content is not globally deduplicated.
- Queue records and receipts are independent of replaceable lead rows, so ordinary M2 saves and explicit resets cannot erase delivery/idempotency state. A reset may remove a lead whose notification is still queued; the already-enqueued notification may still be sent. Receipts prevent replay from recreating intentionally reset leads. Reset is destructive and should be used only in a demo account.
- Intake is configured for one website/destination workspace per function deployment. Arbitrary client-supplied account IDs are not supported. M2's small-workspace limits still apply; monitor size and archive/export deliberately before reaching them.

## Retry worker and email operations

The inquiry handler makes one immediate delivery attempt after the lead commits. If email configuration is missing, the lead is still stored and its job stays pending. Transient provider/network failures retain the job with backoff. A provider rejection such as invalid sender/credentials marks it failed for operator attention. No email response can roll back the lead.

Invoke the worker from a trusted server/terminal. It processes at most five ready jobs per call. Keep `LEADFLOW_WORKER_SECRET` in the invoking environment's secret store:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://YOUR_PROJECT_REF.supabase.co/functions/v1/retry-notifications" `
  -Headers @{ "x-worker-secret" = $env:LEADFLOW_WORKER_SECRET }
```

For unattended recovery, configure a trusted scheduler to call it every five minutes. Store its header secret in the scheduler's secret store (or Supabase Vault if using Supabase Cron/pg_net), not in frontend code, a public cron URL, or committed SQL. No recurring job is installed by this repository. **Until a scheduler is configured, retries require this manual command or another submission replay.** Missing `RESEND_API_KEY` returns `configuration_missing`; correct the secrets and rerun the worker.

Inspect operational state in the Supabase SQL editor without selecting email contents:

```sql
select status, count(*) from leadflow_private.notification_outbox group by status;
select request_id, status, attempts, provider_id, last_error, updated_at
from leadflow_private.notification_outbox order by updated_at desc limit 50;
```

States:
- `pending`: waiting for an attempt/retry.
- `sending`: leased for two minutes; a crashed worker can be reclaimed afterward.
- `accepted`: Resend returned an email ID. **This does not confirm inbox delivery.** Check Resend's delivery event and the recipient inbox, including spam.
- `failed`: definitive provider rejection; inspect `last_error` (status code only), fix configuration, and reconcile provider records before manually requeuing.
- `uncertain`: the retry window expired; investigate before resending to avoid duplicates.

Every attempt uses an immutable email body and `leadflow/REQUEST_UUID` idempotency key. Lease IDs prevent stale workers from overwriting newer outcomes. Resend retains idempotency keys for 24 hours; automatic attempts stop after 23 hours from the first attempt. See [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys). Do not blindly reset `first_attempt_at` or delete receipts: a previous attempt may already have sent mail. There is no signed delivery-webhook integration in M3, so delivery confirmation is manual.

Changing sender/recipient secrets affects **new** jobs; existing jobs retain their original payload for safe retries. If those values were wrong, do not mutate a possibly accepted job and resend it automatically. Reconcile it first. Notification payloads contain contact data and are retained in the private queue; choose and implement an appropriate retention policy before production use. Receipt rows are retained for deduplication, rate counters expire after two days of activity, and no personal data is written to function logs by this code.

## Automated and live verification

```powershell
npm run build
npm run lint
npm run check:edge
npm run test:db
npm run test:m3
npm test
npm run test:production
```

Database tests execute both real migrations in PGlite. Edge tests execute the actual request handlers with simulated Cloudflare/Resend transport. Browser tests exercise the public form → actual Edge handler → actual PostgreSQL schema → existing dashboard → refresh flow. They also cover duplicate submission/lost response, CAPTCHA rejection, invalid inputs, private dashboard login, email failure, and mobile layout. M2 tests run against both migrations. None of these checks sends external email or verifies hosted Supabase routing/JWT handling. Production tests build with fake test environment values; run `npm run build` again before deployment.

After configuring the real project:
1. Use `/inquiry` in a signed-out browser to submit a clearly labeled fictional test inquiry with a fresh CAPTCHA token. Save its reference.
2. Sign in to the destination account. Press **Refresh**, find the lead, confirm `Website` source and integration activity, then reload/restart the frontend and verify persistence.
3. Inspect the matching outbox row. Check the Resend email ID and delivery event, and verify the configured recipient actually received it. Record what you observed; an `accepted` row alone is insufficient to claim delivery.
4. Retry the same UUID/details with a fresh token. Verify one lead, initial activity, and queue row. Retry with altered details and the same UUID; expect 409.
5. Verify malformed fields, expired/incorrect CAPTCHA, unapproved origins, and repeated submissions are rejected. In a disposable project, exercise the rate limits. Direct anon reads/writes/RPC calls to private management and ingestion functions must fail. A second account must not see this lead.
6. In a disposable project, use an invalid email credential to cause delivery failure. The form should still report the inquiry received and the lead should persist. Correct configuration and reconcile/requeue safely. Automated tests already exercise transient failures and ambiguous provider timeouts without contacting external services.
7. Verify scheduled worker execution and inspect queue failures regularly. Record hosted checks separately from local test results.

Remaining production considerations: verified business identity/privacy notice, actual hosted access checks, sender DNS, real inbox delivery, worker scheduling, queue monitoring/retention, free-tier usage, and hosting CSP/embedding policies. No production-readiness or external-delivery claim is made.
