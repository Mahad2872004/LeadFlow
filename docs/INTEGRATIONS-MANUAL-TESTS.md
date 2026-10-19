# Test every LeadFlow integration manually

Use this guide with the Integrations page. “Available” means a guide is available, not that an external account has been connected. The 13 cards are not 13 independent native connectors: the four website cards share the M3 form, three developer cards share inbound-lead, and four automation guides use that endpoint. Email reuses Resend; CRM is planned.

## Start here

1. Open https://leadflow-tau-five.vercel.app/login and sign in to your internal workspace. The public root is now the marketing website; `/app` is the protected workspace entry.
2. Keep a second tab open on Leads. Use Refresh after each submission, then reload the browser to check persistence.
3. Use fictional contact data. Name each test `QA - METHOD - DATE`, service `Consulting`, message `Fictional manual integration test`. Use different example.com email addresses for distinct tests to avoid the five-inquiries/email/hour quota.
4. Successful submissions can send a real notification to the configured business recipient. Plan a small number of tests. Do not reset demo data to clean up: reset replaces workspace records.
5. Record each reference, test method, timestamp, dashboard result, and email result. An HTTP 200 or green card alone is not evidence of inbox delivery.
6. For every success, copy the reference into Integrations → the relevant guide → Verify a test inquiry. It must verify in the account you are currently using. If it does not, stop and inspect the destination account configuration.

## 1. Hosted inquiry form

1. Open Integrations → Hosted inquiry form → Open hosted form. For production the URL should be `https://leadflow-tau-five.vercel.app/inquiry`, not localhost.
2. Fill the required fields using the test data above. Optional phone/company can stay empty.
3. Complete Cloudflare verification, then select Send inquiry once.
4. Expect “Thanks for reaching out” and a reference. Save it.
5. In Leads, Refresh and search the exact test name. Expect source Website, status New, your message, and initial website activity. Reload and confirm it remains.
6. Verify the reference through the guide.
7. Negative check: leave required fields empty or use an invalid email. Expect validation and no new lead.

If Cloudflare fails, do not skip it. Check the displayed error code. `110200` means the current hostname is not authorized; `200500` means its frame could not load. Confirm the production widget hostname is `leadflow-tau-five.vercel.app` without protocol or path. Test another browser/network if challenges.cloudflare.com is blocked. A localhost test needs appropriate development widget/server configuration too. Do not put a secret key in the frontend.

## 2. Embeddable website form

1. Open Embeddable website form and copy HTML embed.
2. Paste it into a test page on a website you control. Serve the page over HTTP(S); do not rely on opening a file directly.
3. Confirm the iframe src points to the deployed `/inquiry` page. Publish the test page and open it independently of LeadFlow.
4. Submit a fictional inquiry inside the iframe. Follow the hosted-form receipt/dashboard/persistence checks.
5. Repeat the layout check at a narrow mobile width. All required fields, CAPTCHA, and submit control must be reachable by scrolling and keyboard.
6. If the iframe is refused, inspect the form host's framing policy and the parent site's CSP. Allow the intended host specifically; do not broadly disable security. The form's origin is what M3 validates, not the parent page's origin.

Pass: the real parent page renders the form and one submission creates one lead in the intended workspace. Rendering the preview alone is not a complete pass.

## 3. WordPress

1. In WordPress create a draft test page. Add a Custom HTML block (or your page builder's HTML widget).
2. Paste the HTML embed copied from LeadFlow. Preview the page and check that WordPress preserved the iframe.
3. If your account/host strips it, ask the WordPress administrator to allow this trusted embed; do not switch off site security.
4. Publish to a test URL when ready. Open the page while signed out of WordPress, preferably in another browser profile.
5. Submit the `QA - WordPress` inquiry. Verify its reference, source Website, dashboard record, and persistence.
6. Check mobile layout and keyboard access. An editor preview is insufficient: test the public page.

Requires a real WordPress site and permission to publish. LeadFlow has no WordPress plugin or WordPress API authentication.

## 4. Custom website (HTML / React)

HTML: follow the embed steps above on your actual contact page.

React:

1. Open Custom website and copy React embed into a `ContactForm` component in your existing React project.
2. Render `<ContactForm />` on a test route. The snippet's iframe src must be the deployed form URL.
3. Build the website; check there are no JSX/build errors. Deploy the test route.
4. Submit `QA - React`, then verify its reference and dashboard persistence.
5. Check mobile height/scrolling and focus. No Supabase service key or webhook credential belongs in this React component.

This embeds the existing M3 form; it does not wire arbitrary existing form fields to LeadFlow. Connecting a different server-rendered form requires server-to-server API work described below.

## Shared prerequisite for methods 5–11

Before Zapier, Make, n8n, API, inbound webhook, examples, or Google Sheets can submit successfully:

1. Apply the Integrations migration and deploy inbound-lead. See [administrator setup](INTEGRATIONS.md#deploy-the-addition).
2. Have an administrator provision a separate workspace credential for the intended method, including its verified sender and intended notification recipient. Follow [credential provisioning](INTEGRATIONS.md#provision-a-workspace-credential-administrator). No credential is automatically created by clicking a guide.
3. Store the raw token in the platform credential store/server environment. Use the generated hash only in the database. Do not use a dashboard password, Supabase public key, or service-role key as this token.
4. Copy Webhook endpoint from the guide. In this project it is `https://fzgxpwmqzmvgmijviaar.supabase.co/functions/v1/inbound-lead`; check that your deployed app is still using this project before sending.
5. Generate one UUID for each new event, save it, and reuse it for retries. In PowerShell run `[guid]::NewGuid().ToString()`.
6. Build the following JSON using that UUID. Replace the requestId placeholder before sending. Optional fields may be empty. Supported services are Website design, Web development, Brand identity, Consulting, Other.

```json
{
  "requestId": "REPLACE_WITH_A_NEW_UUID",
  "inquiry": {
    "name": "QA - METHOD - DATE",
    "email": "method-test@example.com",
    "phone": "",
    "company": "Fictional Test Studio",
    "service": "Consulting",
    "message": "Fictional manual integration test."
  }
}
```

Successful HTTP intake must return 200 with `ok: true` and the same reference. The lead source is Other and activity names the configured integration. Verify it in the dashboard and reload. Repeat the exact body/UUID: expect 200 but no second lead. Change the message while keeping the UUID: expect 409. Correct the original content before retrying. Never generate a fresh UUID solely to recover from a timeout.

## 5. Zapier

1. Use a test trigger such as a new spreadsheet row containing the saved UUID and inquiry fields. Test the trigger so those fields are available.
2. Add Webhooks by Zapier → Custom Request. Set method POST and the LeadFlow endpoint.
3. Put the nested JSON above in Data and map the trigger fields, including the saved UUID. Ensure the result is valid JSON and does not wrap the object in a string.
4. Set headers `Content-Type: application/json` and `Authorization: Bearer YOUR_INTEGRATION_TOKEN`. Restrict who can view/edit the Zap and its run history. Do not include an Origin header.
5. Test the action once. Check HTTP 200, reference, dashboard record, and persistence. Retest with the identical trigger event to check deduplication.
6. Enable only after a passing test; run one fresh source event and verify it again.

This uses a documented HTTP action, not a native LeadFlow app. Zapier currently lists this action on Professional, Team, and Enterprise, not Free. Do not purchase a subscription just for this test; skip if unavailable. [Official instructions](https://help.zapier.com/hc/en-us/articles/8496326446989-Send-webhooks-in-Zap-workflows).

## 6. Make

1. Create a test scenario with a trigger supplying the saved event UUID and inquiry fields.
2. Add HTTP → Make a request (current HTTP version).
3. Configure API key authentication through Credentials/keychain: header name `Authorization`, value `Bearer YOUR_INTEGRATION_TOKEN`. Keep the credential out of the JSON body.
4. Select POST, paste the LeadFlow HTTPS endpoint, select application/json body, and map the nested payload above. Use the structured JSON builder when mapping free text to preserve escaping.
5. Run once. Inspect the response and perform the shared receipt/dashboard/replay checks.
6. Add handling for non-2xx responses before scheduling. A retry must retain the original UUID and body.

[Official HTTP documentation](https://apps.make.com/http). This is an HTTP scenario, not a native LeadFlow connector.

## 7. n8n

1. Create a workflow with Manual Trigger and Edit Fields for a first test. Set the saved UUID and fictional inquiry fields; do not generate a fresh UUID on every replay.
2. Add HTTP Request with POST and the LeadFlow endpoint.
3. Select Generic Credential Type → Header Auth. Store name `Authorization`, value `Bearer YOUR_INTEGRATION_TOKEN` in a credential.
4. Enable Send Body, choose JSON, and configure the nested payload. Content-Type must be application/json. Do not send Origin.
5. Execute once; inspect HTTP response, verify the reference and persistent lead. Re-execute the same payload to check no duplicate.
6. Replace Manual Trigger with your intended event trigger only after passing. Persist requestId with that event before the request node; configure failure handling before activating.

[Official HTTP Request documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/).

## 8. Lead submission API

Use a server-side HTTP client or Postman desktop. This endpoint intentionally rejects requests containing a browser Origin header.

1. Set method POST and paste the endpoint from the guide.
2. In Authorization select Bearer Token and use the workspace integration token. Use the client's private/local secret storage, not a shared/exported collection value.
3. Select Body → raw → JSON, paste the shared payload, and substitute a new saved UUID.
4. Send once. Check 200, reference, lead details, source Other, activity label, and persistence.
5. Resend unchanged: 200 and no second lead. Edit message with the same UUID: 409.
6. Use another new UUID with invalid email: 422 and no new lead. Remove Authorization: 401. Restore the token afterwards.
7. Do not test quotas by flooding production; quota checks run in the local automated suite.

## 9. Inbound webhook

This is the same API endpoint, not a second delivery system or an outbound event subscription.

1. First complete the API test above.
2. In your source system's webhook settings, set the POST destination, protected bearer header, and JSON mapping.
3. Confirm the source can persist a UUID per event and reuse the exact payload for retries. A provider that cannot send custom headers or stable UUIDs needs a server adapter; it will not work simply by pasting this URL.
4. Trigger one fictional source event. Verify the returned reference and persistent dashboard lead.
5. Replay that same event once. Confirm exactly one lead/outbox receipt. Keep the source's retry policy bounded; back off on 429 and reuse the original body after uncertain responses.

## 10. Request examples

1. Open Request examples. Copy JSON payload and inspect its UUID and fields.
2. Use it in the API test above. Each new inquiry requires a new saved UUID; re-copying a guide's example during the same session is not guaranteed to generate a new one.
3. Alternatively copy Server cURL into a POSIX shell with the token in `LEADFLOW_INTEGRATION_TOKEN`. That snippet uses POSIX quoting and is not a paste-as-is PowerShell command. On Windows, Postman is the simpler manual route.
4. Compare the actual response with Success response. Verify reference and dashboard record rather than treating the example text as a real receipt.

## 11. Google Sheets

1. Create a private test sheet with columns requestId, name, email, phone, company, service, message. Never place the credential in a cell.
2. Add one fictional row with a generated UUID saved as plain text, not a volatile formula.
3. Choose one configured platform (Zapier, Make, or n8n) and its new-row trigger. Connect Google through that platform with access only to the intended sheet.
4. Map the row into the shared nested JSON and use that platform's HTTP steps above.
5. Run the row once and verify the reference, dashboard lead, and persistence. Replay the same row to check deduplication.
6. Add a second row with a different UUID and confirm a second lead. Editing a previously sent row is not a lead update; reusing its UUID with changed data should return 409.

This is one-way row intake, not native Google OAuth or two-way synchronization within LeadFlow.

## 12. Email notifications

1. Confirm server-only Resend configuration and a verified sender. Website notifications use M3 secrets; webhook notifications use the sender/recipient assigned to their credential. Follow [M3 setup](M3-SETUP.md).
2. Submit one successful hosted-form or API test and save its reference.
3. Verify the lead first. Open Integrations → Email notifications after returning to the directory and refreshing connection evidence.
4. Check queue evidence. Provider-accepted means Resend accepted the request, not that an inbox received it.
5. Inspect the configured business inbox and spam folder for the matching reference; inspect Resend's delivery record when available. Record inbox receipt separately from provider acceptance.
6. Replay the original API event unchanged and confirm no duplicate notification. Do not resubmit with a new UUID to retry email.
7. Delivery-failure/retry tests run locally with a simulated provider outage. Do not deliberately break production credentials. Use a separate staging environment if testing an actual outage/retry worker.

## 13. CRM integrations

1. Open CRM integrations.
2. Confirm Planned and the explanation that native OAuth, export, and two-way sync are absent.
3. The webhook guide can support one-way intake from a CRM that supplies the required authentication and payload. Test that separately as method 9.

There is no native CRM connection to verify or enable in this milestone.

## What each failure means

- Cloudflare client error: verification has not succeeded; fix widget hostname/browser/network before trying server changes.
- 400/422: fix invalid request/fields. Never strip validation to make the test pass.
- 401: missing, invalid, or revoked integration token (or private access attempted without a dashboard session).
- 403 on inbound-lead: browser Origin supplied; use hosted form for browser traffic.
- 404: function not deployed or wrong endpoint.
- 409: reused UUID with different content; do not overwrite the original event.
- 429: quota; wait/back off rather than generating new UUIDs.
- 503/timeout: outcome may be uncertain. Retry the same body/UUID, then inspect the matching receipt.

For repeatable negative live checks, run `node scripts/check-live-integrations.mjs`. It sends only malformed/unauthorized requests and prints statuses, not keys or lead records. It does not establish that valid intake or email delivery works.

## Latest live check — 19 October 2026

The hosted form accepted `QA - Hosted Form - 2026-10-19` with reference `8047af35-dcd4-45d8-abc0-cb53d00aba1a`. The lead was visible in the signed-in dashboard with source Website and status New, survived a full reload, and passed the workspace receipt check. The email view showed one provider-accepted notification, zero waiting, and zero needing attention. The business owner confirmed receipt in the inbox during this conversation. Inbox delivery is user-confirmed; it was not inspected through an email connector.

Six live negative probes passed: missing webhook token (401), browser webhook Origin (403), missing worker secret (401), missing public-form CAPTCHA (400), anonymous integration overview (401), and anonymous receipt verification (401). These establish rejection behavior, not successful API intake.

The live workspace contains a `Website automation` credential with no verified request. Its raw token was not available for a successful live API test. Actual WordPress publishing, external React-site builds, Zapier/Make/n8n executions, and Google Sheets triggers have not been tested; use the relevant procedures above after configuring those accounts. CRM remains planned.

## If you did not save the Website automation token

This is needed only for server/automation intake. The hosted form does not need it. LeadFlow stores a fingerprint (hash), so a forgotten original token cannot be recovered. Replacing it invalidates the previous token; update any existing automation before resuming it.

1. In a private terminal in the LeadFlow project, run `node scripts/create-integration-token.mjs`. It prints `token` and `tokenHash`.
2. Save `token` in a password manager under “LeadFlow Website automation”. Keep it private. You will use it as the Bearer Token in Postman or a platform credential store. Do not put it in a VITE variable or send it in chat.
3. Open your Supabase project → SQL Editor. Find the existing row without revealing secrets:

```sql
select id, owner_id, label, provider, revoked_at, last_used_at
from leadflow_private.integration_keys
where label = 'Website automation';
```

4. Identify the row belonging to your account. If there are multiple rows, compare `owner_id` with your user UUID under Supabase Authentication → Users. Copy that row's `id`.
5. In a new query replace BOTH placeholders below: the new `tokenHash` from step 1 and the exact credential row ID from step 4. Paste the hash, not the raw `lf_...` token. Keep the existing owner/sender/recipient unchanged.

```sql
update leadflow_private.integration_keys
set token_hash = 'PASTE_NEW_TOKEN_HASH',
    revoked_at = null,
    last_used_at = null
where id = 'PASTE_EXACT_CREDENTIAL_ID'
returning id, label;
```

6. Run it once and confirm exactly the intended row is returned. If no row is returned, check the ID rather than creating extra credentials.
7. Follow method 8 (Lead submission API): use the saved raw token as Bearer Token and send one fictional test. Verify its reference and persistent lead. Then refresh the Integrations directory; the API card should show Connected based on that successful request.
8. If you want me to run that live test, store the raw token in an ignored local file, for example `supabase/.env.local` with `LEADFLOW_INTEGRATION_TOKEN=...`, and tell me the file location only. That file is for local/server tools; never commit it, expose it to Vite, or bundle it into the app. Do not copy unrelated production secrets into a local Supabase runtime.

This rotation was NOT performed during verification. Your existing credential remains unchanged.


## Automated checks completed — 19 October 2026

All 14 browser tests passed against production assets, including opening every directory guide and submitting the copied iframe from a second real local origin through the actual handler and SQL test harness. The original 12-test development suite and the new focused embed test also passed. Database, M3 handler, integration handler, lint, and Edge TypeScript checks passed. CAPTCHA, Auth transport, and email provider transport in those automated tests are simulated; the successful live hosted-form check and user-confirmed inbox receipt above are separate evidence.

The successful embed test verifies local cross-origin behavior. It does not verify WordPress permissions, a customer's CSP, an external React project, or third-party platform credentials. Those require the manual environment-specific steps in this guide.
