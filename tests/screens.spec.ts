import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { apiOrigin, mockSupabase, signIn } from './support/supabase'
import { createAnalysisHarness, dentalSite } from './support/analysis'
import { austinDirectory, createDiscoveryHarness } from './support/discovery'
import { createApolloHarness, demoPeople } from './support/apollo'
import { createOnboardingHarness } from './support/onboarding'

// Visual review only: walks every app screen with simulated services and saves full-page screenshots.
// Run with `npx playwright test --config playwright.screens.config.ts`. Not part of `npm test`.
const owner = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com', password: 'test-password' }
const dir = process.env.SCREENS_DIR ?? 'test-results/screens'
const widths = (process.env.SCREENS_WIDTHS ?? '1440,390').split(',').map(Number)
const only = process.env.SCREENS_ONLY?.split(',')
const origin = `http://127.0.0.1:${process.env.SCREENS_PORT ?? '5176'}`
const origins = { DISCOVERY_ALLOWED_ORIGINS: origin, PORTAL_ALLOWED_ORIGINS: origin, PORTAL_URL: `${origin}/client-portal` }
let db: PGlite
test.describe.configure({ timeout: 900000 })
test.afterEach(async () => { await db?.close() })

async function shot(page: Page, name: string) {
  if (only && !only.some(prefix => name.startsWith(prefix))) return
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/${name}-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: widths[0], height: 900 })
}
let current: Page
async function step(name: string, body: () => Promise<void>) {
  // Close anything a previous step left open so navigation is never blocked by a dialog.
  for (let i = 0; i < 3 && await current?.locator('dialog[open]').count(); i++) await current.keyboard.press('Escape')
  try { await test.step(name, body) } catch (error) { console.log(`SCREEN STEP FAILED: ${name}: ${(error as Error).message.split('\n')[0]}`) }
}
const rpc = (sql: string, params: unknown[] = []) => db.transaction(async tx => {
  await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)", [owner.id, JSON.stringify({ sub: owner.id, role: 'authenticated' })])
  await tx.exec('set local role authenticated')
  return (await tx.query(sql, params)).rows
})
const pagespeedBody = (strategy: string, score: number) => ({ lighthouseResult: { finalUrl: 'https://harbor-dental.example/', fetchTime: '2026-11-08T10:00:00.000Z', categories: { performance: { score }, seo: { score: 0.92 } }, audits: { 'largest-contentful-paint': { numericValue: strategy === 'mobile' ? 5200 : 2100 }, 'first-contentful-paint': { numericValue: 1900 }, 'cumulative-layout-shift': { numericValue: 0.05 }, 'speed-index': { numericValue: 4000 }, 'total-blocking-time': { numericValue: 350 }, viewport: { score: 1 } } }, loadingExperience: { metrics: {} } })
async function routeFunction(page: Page, name: string, handler: (request: Request) => Promise<Response>) {
  await page.route(`${apiOrigin}/functions/v1/${name}`, async route => {
    const request = route.request()
    const response = await handler(new Request(request.url(), { method: request.method(), headers: request.headers(), body: request.method() === 'POST' ? request.postData() : undefined }))
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
  })
}
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click()

test('app screens', async ({ page }) => {
  current = page
  db = await createDatabase([owner.id])
  await db.query('update auth.users set email=$2 where id=$1', [owner.id, owner.email])
  await rpc('select public.load_workspace()')
  await mockSupabase(page, db, { users: [owner] })
  const analysis = createAnalysisHarness(db, { ...origins, GEMINI_API_KEY: 'gemini-test', GOOGLE_PAGESPEED_API_KEY: 'pagespeed-test', ANALYSIS_RECENT_HOURS: '24' })
  dentalSite(analysis.state)
  analysis.state.pagespeed.mobile = [{ status: 200, body: pagespeedBody('mobile', 0.42) }]
  analysis.state.pagespeed.desktop = [{ status: 200, body: pagespeedBody('desktop', 0.81) }]
  analysis.state.ai.output = { overview: { summary: { text: 'A family dental practice in Austin offering checkups, cleanings, whitening and implants.', evidenceRefs: ['E2'] }, mainServices: [{ text: 'Implants', evidenceRefs: ['E2'] }], audienceIndicators: [], positioning: { text: '', evidenceRefs: [] } }, findings: [{ category: 'communication', title: 'Patients may ask booking questions by phone', description: 'Booking is by phone only.', findingType: 'hypothesis', severity: 'low', confidence: 'medium', evidenceRefs: ['E2'], basedOnFindings: [], businessRelevance: '', recommendedAction: 'Ask the practice.', opportunityType: 'booking_integration' }] }
  const discovery = createDiscoveryHarness(db, origins)
  discovery.state.places.austin = { osm_type: 'relation', osm_id: 113314, lat: '30.27', lon: '-97.74', boundingbox: ['30.0986648', '30.5168629', '-97.9383829', '-97.5684083'] }
  discovery.state.elements = austinDirectory()
  const apollo = createApolloHarness(db, { ...origins, APOLLO_WORKSPACE_IDS: owner.id })
  apollo.state.people = demoPeople()
  const onboarding = createOnboardingHarness(db, origins)
  await routeFunction(page, 'business-analysis', request => analysis.handler(request))
  await routeFunction(page, 'discover-leads', request => discovery.handler(request))
  await routeFunction(page, 'apollo', request => apollo.handler(request))
  await routeFunction(page, 'client-portal', request => onboarding.portal(request))
  await page.route('https://challenges.cloudflare.com/**', route => route.fulfill({ contentType: 'application/javascript', body: 'window.turnstile={render(){return "test"},remove(){}}' }))

  await step('signed-out pages', async () => {
    await page.goto('/login'); await expect(page.getByRole('heading', { name: 'Sign in to LeadFlow' })).toBeVisible(); await shot(page, 'auth-login')
    await page.goto('/signup'); await page.waitForTimeout(600); await shot(page, 'auth-signup')
    await page.goto('/inquiry'); await page.waitForTimeout(600); await shot(page, 'inquiry')
    await page.goto('/client-portal#lf_' + '0'.repeat(64)); await page.waitForTimeout(1200); await shot(page, 'portal-invalid')
  })
  await page.goto('/login'); await signIn(page, owner.email)
  await step('empty overview', async () => { await expect(page.getByText('Your database workspace is empty.', { exact: false })).toBeVisible(); await shot(page, 'overview-empty') })
  await step('seed', async () => {
    await page.getByRole('button', { name: 'Reset demo data' }).first().click(); await page.getByRole('dialog').getByRole('button', { name: 'Reset demo data', exact: true }).click()
    await expect(page.getByLabel('Status for Olivia Bennett')).toBeVisible()
    await rpc('select public.import_leads($1,$2,$3)', [owner.id, crypto.randomUUID(), JSON.stringify({ method: 'csv', rows: [{ key: 'seed-0', businessName: 'Harbor Dental', contactName: 'Avery Stone', website: 'https://harbor-dental.example/', industry: 'Dental clinics', city: 'Austin' }] })])
    await page.reload(); await expect(page.getByRole('heading', { name: 'Pipeline snapshot' })).toBeVisible()
  })
  await step('overview', async () => shot(page, 'overview'))
  await step('leads', async () => { await nav(page, 'Leads'); await shot(page, 'leads') })
  await step('lead detail', async () => { await page.getByLabel('View Olivia Bennett').first().click(); await expect(page.getByRole('dialog')).toBeVisible(); await shot(page, 'lead-detail'); await page.getByLabel('Close dialog').click() })
  await step('lead form', async () => { await page.getByRole('button', { name: 'Add lead' }).first().click(); await expect(page.getByRole('dialog', { name: 'Capture a new lead' })).toBeVisible(); await shot(page, 'lead-form'); await page.getByRole('button', { name: 'Cancel', exact: true }).click() })
  await step('followups', async () => { await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Follow-ups/ }).click(); await shot(page, 'followups') })
  await step('activity', async () => { await nav(page, 'Activity'); await shot(page, 'activity') })
  await step('notifications', async () => { await page.getByRole('button', { name: 'Notifications', exact: true }).click(); await page.waitForTimeout(300); await shot(page, 'notifications'); await page.keyboard.press('Escape') })
  await step('discovery find', async () => {
    await nav(page, 'Discovery'); await page.getByRole('tab', { name: 'Find businesses' }).click(); await shot(page, 'discovery-find')
    await page.getByLabel('City or town').fill('Austin'); await page.getByLabel('State (optional)').fill('TX'); await page.getByLabel('Has a website').check()
    await page.getByRole('button', { name: 'Find businesses' }).click(); await expect(page.getByRole('heading', { name: /businesses found/ })).toBeVisible(); await shot(page, 'discovery-results')
  })
  await step('discovery csv', async () => { await page.getByRole('tab', { name: 'Import CSV' }).click(); await shot(page, 'discovery-csv') })
  await step('discovery history', async () => { await page.getByRole('tab', { name: 'Search history' }).click(); await shot(page, 'discovery-history') })
  await step('apollo', async () => {
    await page.getByRole('tab', { name: 'Apollo' }).click(); await page.waitForTimeout(800); await shot(page, 'apollo')
    await page.getByRole('combobox', { name: 'Job titles', exact: true }).fill('owner'); await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Search people' }).click(); await expect(page.getByRole('heading', { name: /people found/ })).toBeVisible(); await shot(page, 'apollo-results')
  })
  await step('onboarding', async () => {
    await nav(page, 'Onboarding'); await expect(page.getByRole('heading', { name: 'Client onboarding', level: 1 })).toBeVisible(); await shot(page, 'onboarding-empty')
    await page.getByRole('tab', { name: /^Templates/ }).click(); await page.getByRole('button', { name: 'Add the starter templates' }).click(); await expect(page.getByText('4 starter templates added.')).toBeVisible(); await shot(page, 'onboarding-templates')
    await nav(page, 'Leads'); await page.getByLabel('View Olivia Bennett').first().click(); await page.getByRole('button', { name: 'Start client onboarding' }).click()
    const create = page.getByRole('dialog', { name: 'New client onboarding' }); await shot(page, 'onboarding-new')
    await create.getByLabel('Template').selectOption({ index: 1 }); await create.getByRole('button', { name: 'Create onboarding' }).click()
    await expect(page.locator('.ob-item').first()).toBeVisible(); await shot(page, 'onboarding-request')
    await page.getByRole('button', { name: 'Open to client' }).click(); await page.getByRole('button', { name: 'Create client link' }).click()
    const url = await page.getByLabel('Copy this link now').inputValue(); await shot(page, 'onboarding-link')
    const client = await page.context().newPage(); await client.route('https://challenges.cloudflare.com/**', route => route.abort())
    await routeFunction(client, 'client-portal', request => onboarding.portal(request))
    await client.goto(url); await client.waitForTimeout(1500); await shot(client, 'portal'); await client.close()
  })
  await step('integrations', async () => { await nav(page, 'Integrations'); await page.waitForTimeout(500); await shot(page, 'integrations') })
  await step('settings', async () => { await nav(page, 'Settings'); await page.waitForTimeout(500); await shot(page, 'settings') })
  await step('business report', async () => {
    await nav(page, 'Leads'); await page.getByLabel('View Avery Stone').first().click(); await page.getByRole('button', { name: 'Business report' }).click()
    const report = page.locator('dialog#business-report'); await expect(report).toBeVisible(); await shot(page, 'report-start')
    await report.getByRole('button', { name: 'Analyze business' }).click(); await expect(report.locator('.br-state')).toHaveText('Completed', { timeout: 90000 }); await shot(page, 'report-done')
  })
})
