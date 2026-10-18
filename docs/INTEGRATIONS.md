# Integrations Hub setup

The authenticated dashboard now includes an Integrations directory. Website forms reuse M3; Zapier, Make, n8n, and Google Sheets are documented HTTP workflows, not native OAuth connections. CRM connections remain planned. No external account is connected automatically.

## Deploy the addition

1. Keep the M2/M3 configuration in [M3-SETUP.md](M3-SETUP.md). Apply only unapplied migrations, including `202610180003_integrations.sql`, to the intended Supabase project. This migration adds a private credential table and scoped functions without replacing existing leads or changing public form access.
2. Deploy `inbound-lead`: `npx supabase functions deploy inbound-lead`. Its gateway JWT check is disabled in config.toml because it requires a separate integration bearer token. It rejects browser Origin headers; that check supplements token authentication and is not an authentication substitute.
3. Keep `EMAIL_HASH_SECRET` and `RESEND_API_KEY` in Supabase secrets. The existing protected retry worker handles webhook emails too. Supabase supplies its own service-role credential to the function; never copy that credential to browser configuration.
4. Build and deploy the frontend. Optionally set `VITE_PUBLIC_FORM_ORIGIN` to the stable deployed form origin, for example `https://leadflow-tau-five.vercel.app`. Otherwise links use the current app origin. This is public configuration, not a secret. A localhost/preview URL must not be installed on a production client website.
5. Verify `/inquiry` directly and after refresh. Keep the existing Vercel SPA rewrite, CAPTCHA validation, allowed-origin list, and RLS controls.

The hub cannot inspect server secrets. An Available guide is not proof of a configured backend. Missing migrations or network failures produce an explicit status-check error.

## Provision a workspace credential (administrator)

Create a separate credential per automation. Obtain the intended internal account UUID from Supabase Authentication. Confirm the sender and recipient; they are configured per credential so one account's submissions cannot be sent to another account's global recipient.

Run locally in a private terminal:

```powershell
node scripts/create-integration-token.mjs
```

Store the generated `token` only in the automation platform's restricted credential store or your server secret store. It is shown once by the script. Do not paste it into chat, commit it, place it in a spreadsheet, or set a VITE variable. Copy only `tokenHash` into the following SQL, run by an administrator in Supabase SQL Editor:

```sql
insert into leadflow_private.integration_keys
  (owner_id, label, provider, token_hash, notification_from, notification_to)
values
  ('YOUR_INTERNAL_ACCOUNT_UUID', 'Website automation', 'webhook',
   'GENERATED_TOKEN_HASH', 'LeadFlow <inquiries@YOUR_VERIFIED_DOMAIN>',
   'YOUR_BUSINESS_EMAIL')
returning id;
```

Replace all placeholders. Provider must be `webhook`, `zapier`, `make`, `n8n`, or `sheets`. Use a Resend-verified sender, or its restricted onboarding sender only for permitted account-email testing. Creating a credential does not verify delivery. The browser can see only ID, label, provider, revoked status, and last successful use. The private table has RLS enabled and no anonymous/authenticated table grants.

To rotate: generate a fresh token/hash, update the same credential ID using this SQL, then replace the token in the platform. Old-token requests will stop immediately, so pause the automation during the switch if needed. Retrying the same event with the new token remains idempotent because its credential ID is unchanged.

```sql
update leadflow_private.integration_keys
set token_hash = 'NEW_GENERATED_TOKEN_HASH', revoked_at = null, last_used_at = null
where id = 'EXISTING_CREDENTIAL_UUID' and owner_id = 'YOUR_INTERNAL_ACCOUNT_UUID';
```

Revoke from the hub with its confirmation step, or set `revoked_at=now()` using an administrator connection. A signed-in user can revoke only their own credentials. Do not delete a credential with retained receipts. Already queued notifications remain immutable and may still be delivered after revocation; revocation blocks new/repeated inbound requests, not the queue worker.

## Website installation

In Integrations, open Hosted inquiry form, Embeddable website form, WordPress, or Custom website. Copy the actual deployed URL or HTML/React iframe snippet. In WordPress use a Custom HTML block or a page builder HTML widget. Administrators may need to permit trusted iframes; do not disable general site security.

The iframe runs the existing real form, including CAPTCHA. Allow the **form origin**, not merely the parent website, in `INQUIRY_ALLOWED_ORIGINS`; register the form hostname in Turnstile. Configure any CSP `frame-ancestors` restrictions to permit intended parent sites. Do not sandbox the iframe into a null origin. The preview can create a real lead/email; use fictional data. Test mobile height/scrolling on the actual parent site.

Checklist selections are session-only guidance. Paste a successful submission reference into Verify a test inquiry to check that both receipt and lead belong to the signed-in workspace. This cannot verify another workspace. A historical receipt does not prove that current host settings are correct. Resetting demo data may remove the lead while retaining the original receipt, so old receipts may no longer verify.

## HTTP workflow and retries

The hub generates the endpoint from the configured Supabase URL, JSON, and a POSIX cURL example. POST to `/functions/v1/inbound-lead` with `Authorization: Bearer YOUR_INTEGRATION_TOKEN` and `Content-Type: application/json`. Use a server or automation platform, never browser JavaScript. The body contains:

- `requestId`: a UUID generated and persisted once per source event, reused on retries.
- `inquiry`: required `name`, `email`, `service`, `message`; optional `phone`, `company`.
- Service: Website design, Web development, Brand identity, Consulting, or Other.

Normalization and limits match M3. Requests are bounded to 16 KB. Quotas: 60 attempts/minute/credential, five accepted inquiries/email/hour/integration, and a webhook workspace cap of 50 accepted inquiries in 24 hours (including website inquiries when counting existing receipts). Existing public-form quotas also remain active. These application quotas do not replace platform-level traffic/cost monitoring.

A 200 with `reference` confirms persistence, not inbox delivery. Identical normalized content and UUID return the existing receipt without a second lead/outbox record. Changed content using that UUID returns 409. Invalid credentials return 401; browser Origin returns 403; malformed/invalid data returns 400/422; throttling returns 429. On timeouts or 503, storage may already have succeeded: retry the original payload/UUID. Back off on 429. Never create a new UUID simply to retry email delivery.

Webhook leads use the existing `Other` source and record the administrator-configured integration label in activity history; the durable receipt links the credential. Callers cannot choose workspace, source, recipient, or sender. Existing revision checks protect against stale dashboard saves overwriting newly received leads.

## Platform guides

- **Zapier:** trigger on the source event, persist a UUID, then Webhooks by Zapier Custom Request with POST and raw nested JSON. Protect the authorization header and limit editor/log access. Verify one fictional event before enabling. [Official Webhooks instructions](https://help.zapier.com/hc/en-us/articles/8496326446989-Send-webhooks-in-Zaps). Webhooks availability depends on the plan; no subscription is required by this application itself.
- **Make:** trigger, persist the UUID, HTTP Make a request, POST JSON, protected bearer credential, map inquiry fields, run once, then schedule. Handle non-2xx responses. [Official HTTP documentation](https://apps.make.com/http).
- **n8n:** trigger, persist the UUID, HTTP Request node with Generic Credential Type / Header Auth (`Authorization`), POST JSON, test then activate. [Official HTTP Request documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/).
- **Google Sheets:** use one of those platforms to watch new rows. Columns contain requestId and inquiry fields, never the token. Persist the UUID in the row once. Retrying a row reuses it; editing a submitted row is not a lead-update operation. There is no native Google OAuth or two-way sync.

Platform screens, subscription requirements, and quotas can change. Consult those providers before enabling workflows. No paid dependency or native connector has been added.

## Status meaning and email

Available means a guide exists. Needs configuration means required frontend values or successful credential evidence are missing. Connected for developer cards requires an active credential with successful server use; it does not certify an external account or current network health. Hosted form Connected requires receipt verification in the current hub session. Planned means not implemented. Automation entries remain guides even after an HTTP submission.

Email metadata shows provider-accepted, waiting, and needs-attention counts for the signed-in workspace only. Provider acceptance is not inbox delivery. Follow M3 sender setup, quotas, protected retry scheduling, and monitoring instructions. Notification failure preserves the lead. Secret values and inquiry contents are not returned by the metadata RPC.

## Verification

Run `npm run build`, `npm run lint`, `npm run check:edge`, `npm run test:db`, `npm run test:m3`, `npm run test:integrations`, `npm test`, and `npm run test:production`. After production-mode tests, run `npm run build` again before deploying (tests use fake configuration).

The integration handler tests execute actual migration SQL in PGlite and simulate provider transport. They cover token authentication, browser rejection, normalized validation, replay/conflict, one lead/notification, sender isolation, credential revocation/rotation, owner isolation, anonymous denials, stale dashboard saves, and delivery failure. Browser tests cover directory, guides, clipboard feedback, receipt verification, evidence failure, revocation, and responsive layouts alongside M2/M3 regressions.

Before releasing, on a disposable hosted project:

1. Apply migrations/deploy functions and confirm sign-out blocks the hub/private records.
2. Provision account A's credential, submit fictional data, verify its reference, then inspect Leads and refresh. Repeat the same request; confirm only one lead and notification.
3. With account B, confirm A's credential metadata and receipt are inaccessible and A's credential cannot be revoked. Anonymous calls to all new private RPCs/tables must fail.
4. Rotate/revoke A's token; verify old/revoked tokens return 401. Test invalid inputs and altered UUID replays.
5. Test the hosted form and embedding on the real website with actual Turnstile. Confirm actual recipient inbox delivery separately, then simulate provider failure in a test environment and check that the lead persists and queued retries recover.
6. Enable one chosen automation only after verifying its actual platform execution, persistent requestId, credential protection, and error handling.

No live migration, deployment, platform connection, real CAPTCHA validation, or external email delivery is established by the local automated checks. The application has no automatic receipt cleanup, outbound CRM sync, or native OAuth. Monitor private queue/receipt growth and failed deliveries operationally.

For a per-card walkthrough, expected results, retry tests, and the latest live-check notes, use [Test every integration manually](INTEGRATIONS-MANUAL-TESTS.md).
