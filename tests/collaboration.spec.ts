import { test, expect, type Browser, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
import { createDatabase, actAs } from './support/database'
import { mockSupabase, signIn, type TestUser } from './support/supabase'
import { createCollabHarness, routeCollabFunctions, type CollabHarness } from './support/collaboration'
import { samples } from './support/clients'

// M12 end to end: the agency invites a client person, shares a project and sends a version for review; the client sets up
// their account from the invitation, requests changes, sees only client-visible replies and approves the next version.
// Real database functions throughout; Storage, Auth admin and email are the in-process stand-ins from tests/support.
const owner: TestUser = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@agency.example', password: 'test-password' }
const oscar: TestUser = { id: 'd4444444-4444-4444-8444-444444444444', email: 'oscar@bakery.example', password: 'test-password', appMetadata: { account_type: 'client' } }
let db: PGlite | undefined
test.afterEach(async () => { await db?.close(); db = undefined })

async function seed() {
  const database = db = await createDatabase([owner.id])
  const one = async <T = any>(user: string | null, sql: string, params: unknown[] = [], role = 'authenticated', claims: Record<string, unknown> = {}) => {
    await actAs(database, user, role, claims)
    const row = (await database.query(sql, params)).rows[0] as Record<string, unknown> | undefined
    return (row ? Object.values(row)[0] : undefined) as T
  }
  await one(null, 'update auth.users set email=$2 where id=$1', [owner.id, owner.email], 'postgres')
  await one(owner.id, 'select public.load_workspace()')
  const W = owner.id, id = () => crypto.randomUUID()
  const today = await one<string>(null, 'select leadflow_private.project_today($1)::text', [W], 'postgres')
  const A = (await one(owner.id, 'select public.create_client($1,$2,$3)', [W, { name: 'Harbor Dental', services: [{ name: 'Website redesign' }] }, id()])).id
  const B = (await one(owner.id, 'select public.create_client($1,$2,$3)', [W, { name: 'Quiet Bakery' }, id()])).id
  const templates = await one(owner.id, 'select public.project_templates_for($1)', [W])
  const plan = await one(owner.id, 'select public.project_template_plan($1,$2,$3)', [W, templates.templates.find((t: { starterKey: string }) => t.starterKey === 'website').id, today])
  const P = (await one(owner.id, 'select public.create_project($1,$2,$3)', [W, { clientId: A, source: 'manual', name: 'Website redesign', projectType: 'website', ownerId: owner.id,
    startDate: today, agreedValue: 9800, internalNotes: 'Margin is thin.', plan }, id()])).id
  const detail = await one(owner.id, 'select public.project_detail($1,$2)', [W, P])
  // Oscar already has an account and access to the other client only.
  const invite = await one(owner.id, 'select public.invite_client_user($1,$2,$3,$4)', [W, B, { email: oscar.email, role: 'admin' }, id()])
  await one(null, 'insert into auth.users(id,email) values ($1,$2)', [oscar.id, oscar.email], 'postgres')
  await one(oscar.id, 'select public.hub_accept_invitation($1)', [createHash('sha256').update(invite.token).digest('hex')], 'authenticated', { app_metadata: { account_type: 'client' } })
  await actAs(database, null, 'postgres')
  return { P, milestone: detail.milestones[0] as { id: string; name: string }, deliverable: detail.deliverables[0] as { id: string; title: string },
    query: <T = any>(sql: string, params: unknown[] = []) => one<T>(null, sql, params, 'postgres') }
}
async function openPage(browser: Browser, harness: CollabHarness, users: TestUser[], errors: string[]) {
  const context = await browser.newContext(), page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const mock = await mockSupabase(page, db!, { users })
  await routeCollabFunctions(page, harness, mock)
  return Object.assign(page, { supabase: mock })
}
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

test('agency invites and shares; the client requests changes, sees only shared replies and approves the next version', async ({ browser }) => {
  test.setTimeout(240_000)
  const { P, milestone, deliverable, query } = await seed()
  const harness = createCollabHarness(db!), errors: string[] = []
  const agency = await openPage(browser, harness, [owner], errors)
  await agency.goto('/login')
  await signIn(agency, owner.email)

  // 1. Invite a client admin from the client's Portal access tab; the link is shown once.
  await agency.locator('.nav-item', { hasText: 'Clients' }).click()
  await agency.getByRole('button', { name: 'Harbor Dental' }).first().click()
  await agency.getByRole('tab', { name: 'Portal access' }).click()
  await agency.getByRole('button', { name: 'Invite someone' }).click()
  const inviteDialog = agency.getByRole('dialog', { name: 'Invite someone from Harbor Dental' })
  await inviteDialog.getByLabel('Email *').fill('alice@harbor.example')
  await inviteDialog.getByLabel('Name').fill('Alice Moreno')
  await inviteDialog.getByLabel('Role').selectOption('admin')
  await inviteDialog.getByRole('button', { name: 'Create invitation' }).click()
  const link = (await agency.locator('.cb-link-box code').textContent())!
  expect(link).toMatch(/\/portal\/invite#lfi_[0-9a-f]{64}$/)
  expect(await query("select token_hash from leadflow_private.client_invitations where email='alice@harbor.example'")).toBe(createHash('sha256').update(link.split('#')[1]).digest('hex'))
  await agency.getByRole('button', { name: 'Done' }).click()

  // 2. Share the project and show one milestone.
  await agency.locator('.nav-item', { hasText: 'Projects' }).click()
  await agency.getByRole('tab', { name: 'All projects' }).click()
  await agency.getByRole('button', { name: 'Website redesign' }).first().click()
  await agency.getByRole('tab', { name: 'Client portal' }).click()
  // The switch's track is drawn over its checkbox; people (and this test) click the label.
  await agency.locator('label.cb-switch').filter({ has: agency.getByRole('switch', { name: 'Share on the client portal' }) }).click()
  await agency.getByRole('dialog', { name: 'Share this project with the client?' }).getByRole('button', { name: 'Share project' }).click()
  await expect(agency.getByText(/^Shared since/)).toBeVisible()
  await agency.locator('label.cb-switch').filter({ has: agency.getByRole('switch', { name: `Show ${milestone.name} to the client` }) }).click()
  await expect.poll(() => query('select client_visible from leadflow_private.project_milestones where id=$1', [milestone.id])).toBe(true)

  // 3. A draft version with a file, then a review request with a preview of what the client receives.
  await agency.getByRole('button', { name: deliverable.title, exact: true }).first().click()
  const review = agency.getByRole('dialog', { name: `Client review: ${deliverable.title}` })
  await review.getByRole('button', { name: 'New version' }).click()
  await review.getByLabel(/What changed in this version/).fill('First homepage concept')
  await review.getByRole('button', { name: 'Save notes' }).click()
  await review.getByLabel('Add files to this version').setInputFiles({ name: 'homepage-v1.pdf', mimeType: 'application/pdf', buffer: Buffer.from(samples.pdf) })
  await expect.poll(() => query("select status from leadflow_private.client_documents where file_name='homepage-v1.pdf'")).toBe('available')
  await expect(review).toContainText('homepage-v1.pdf')
  await review.getByRole('button', { name: 'Request client review' }).click()
  const request = agency.getByRole('dialog', { name: `Request client review: ${deliverable.title}` })
  await request.getByLabel('Message or review instructions').fill('Please check the layout.')
  await expect(request.getByLabel('What the client receives')).toContainText('homepage-v1.pdf')
  await request.getByRole('button', { name: 'Send for review' }).click()
  await expect(review).toContainText('Awaiting client review')
  await review.getByRole('button', { name: 'Close dialog' }).first().click()

  // 4. The client opens the invitation, sets a password and lands in the portal.
  const client = await openPage(browser, harness, [], errors)
  await client.goto(link)
  await expect(client.getByRole('heading', { name: 'Set up your account' })).toBeVisible()
  expect(client.url()).not.toContain('lfi_')
  await client.getByLabel('New password').fill('a-strong-password')
  await client.getByLabel('Confirm password').fill('a-strong-password')
  await client.getByRole('button', { name: 'Create account and open the portal' }).click()
  await expect(client.getByRole('heading', { name: /Alice/ })).toBeVisible()
  expect(harness.accounts.get('alice@harbor.example')?.appMetadata).toEqual({ account_type: 'client' })
  await client.goto(`/portal/projects/${P}`)
  await expect(client.getByRole('heading', { name: 'Website redesign', level: 1 })).toBeVisible()
  await expect(client.locator('body')).not.toContainText('Margin is thin')
  await expect(client.locator('body')).not.toContainText('9,800')

  // 5. The client requests changes on version 1.
  await client.goto(`/portal/projects/${P}/deliverables/${deliverable.id}`)
  await expect(client.getByRole('heading', { name: 'Version 1 is ready for your review' })).toBeVisible()
  await expect.poll(() => query('select first_viewed_at is not null from leadflow_private.deliverable_reviews where deliverable_id=$1', [deliverable.id])).toBe(true)
  await client.getByRole('button', { name: 'Request changes' }).click()
  const changes = client.getByRole('dialog', { name: 'Request changes to version 1' })
  await changes.getByLabel('Title').fill('Booking button is hard to find')
  await changes.getByLabel(/Details/).fill('Put it in the header.')
  await changes.getByRole('button', { name: 'Request changes' }).click()
  await expect(client.getByText('Changes requested. Your agency has been notified.')).toBeVisible()

  // 6. The agency replies to the client, adds an internal note, and sends version 2.
  await agency.getByRole('button', { name: deliverable.title, exact: true }).first().click()
  await expect(review).toContainText('Booking button is hard to find')
  await expect(review).toContainText('Changes requested')
  await review.getByRole('button', { name: 'Replies' }).first().click()
  const replies = review.getByLabel('Replies to Booking button is hard to find')
  await replies.getByLabel('Who sees it').selectOption('client')
  await replies.getByPlaceholder('Write a message the client will see…').fill('Moved into the sticky header.')
  await replies.getByRole('button', { name: 'Send to client' }).click()
  await expect(replies).toContainText('Moved into the sticky header.')
  await replies.getByLabel('Who sees it').selectOption('internal')
  await replies.getByPlaceholder('Write an internal note for your team…').fill('Check spacing with design.')
  await replies.getByRole('button', { name: 'Add note' }).click()
  await expect(replies).toContainText('Check spacing with design.')
  await review.getByRole('button', { name: 'New version' }).click()
  await review.getByLabel(/What changed in this version/).fill('Booking button in the header')
  await review.getByRole('button', { name: 'Save notes' }).click()
  await review.getByLabel('Add files to this version').setInputFiles({ name: 'homepage-v2.pdf', mimeType: 'application/pdf', buffer: Buffer.from(samples.pdf) })
  await expect.poll(() => query("select status from leadflow_private.client_documents where file_name='homepage-v2.pdf'")).toBe('available')
  await expect(review).toContainText('homepage-v2.pdf')
  await review.getByRole('button', { name: 'Request client review' }).click()
  await request.getByRole('button', { name: 'Send for review' }).click()
  await expect(review).toContainText('Resubmitted')
  await review.getByRole('button', { name: 'Close dialog' }).first().click()

  // 7. The client sees only the client-visible reply, and approves version 2 after a confirmation naming its file.
  await client.reload()
  await expect(client.getByRole('heading', { name: 'Version 2 is ready for your review' })).toBeVisible()
  await client.getByRole('button', { name: 'Replies' }).first().click()
  await expect(client.getByText('Moved into the sticky header.')).toBeVisible()
  await expect(client.locator('body')).not.toContainText('Check spacing with design.')
  await client.getByRole('button', { name: 'Approve', exact: true }).click()
  const approve = client.getByRole('dialog', { name: 'Approve version 2?' })
  await expect(approve).toContainText('homepage-v2.pdf')
  await approve.getByRole('button', { name: /^Approve/ }).click()
  await expect(client.getByText('You approved version 2. Your agency has been notified.')).toBeVisible()
  expect((await db!.query<{ decision: string; number: number }>(`select d.decision, v.number from leadflow_private.deliverable_decisions d
    join leadflow_private.deliverable_versions v on v.id = d.version_id order by d.created_at`)).rows.map(row => [row.decision, row.number])).toEqual([['changes_requested', 1], ['approved', 2]])

  // 8. The agency hears about it and sees it in the review queue.
  await agency.getByRole('button', { name: 'Notifications', exact: true }).click()
  await expect(agency.getByRole('dialog', { name: 'Notifications' })).toContainText(`Approved: ${deliverable.title}`)
  await agency.keyboard.press('Escape')
  await agency.locator('.nav-item', { hasText: 'Projects' }).click()
  await agency.getByRole('tab', { name: 'Client reviews' }).click()
  await agency.getByRole('button', { name: /^Approved/ }).click()
  await expect(agency.getByRole('button', { name: deliverable.title, exact: true })).toBeVisible()

  // 9. The portal fits a phone, and a client account can't use the agency app.
  await client.setViewportSize({ width: 360, height: 780 })
  for (const path of ['/portal', `/portal/projects/${P}`, `/portal/projects/${P}/deliverables/${deliverable.id}`, '/portal/files', '/portal/settings']) {
    await client.goto(path)
    await expect(client.locator('.hb-page, main').first()).toBeVisible()
    await client.waitForTimeout(300)
    expect(await noHorizontalScroll(client), `${path} fits 360px`).toBe(true)
  }
  await client.goto('/app')
  await expect(client.getByRole('heading', { name: 'This is a client portal account' })).toBeVisible()
  expect(errors).toEqual([])
})

test('another client can\'t open the project by URL, and password recovery goes through Supabase Auth', async ({ browser }) => {
  const { P, deliverable, query } = await seed()
  await query('update leadflow_private.projects set portal_shared=true, portal_shared_at=now() where id=$1', [P])
  const harness = createCollabHarness(db!), errors: string[] = []
  const page = await openPage(browser, harness, [oscar], errors)
  await page.goto('/portal')
  await expect(page.getByRole('heading', { name: 'Sign in to your client portal' })).toBeVisible()
  await signIn(page, oscar.email)
  await expect(page.getByRole('heading', { name: /Oscar|Good/ })).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Website redesign')
  await page.goto(`/portal/projects/${P}`)
  await expect(page.getByText('This project isn’t shared with you, or your access changed.')).toBeVisible()
  await page.goto(`/portal/projects/${P}/deliverables/${deliverable.id}`)
  await expect(page.getByText('This deliverable isn’t shared with you any more, or your access changed.')).toBeVisible()
  // Forgot password: the request goes to Supabase Auth with the portal's reset page as the redirect.
  await page.getByRole('button', { name: 'Sign out', exact: true }).last().click()
  await page.goto('/portal/forgot')
  const recover = await openRecoveryForm(page)
  await recover.fill(oscar.email)
  await page.getByRole('button', { name: /Send/ }).click()
  await expect(page.getByText(/If an account exists/)).toBeVisible()
  expect(page.supabase.recoveries).toEqual([{ email: oscar.email, redirectTo: `${new URL(page.url()).origin}/portal/reset` }])
  expect(errors).toEqual([])
})
async function openRecoveryForm(page: Page) {
  const field = page.getByLabel('Email', { exact: true })
  await expect(field).toBeVisible()
  return field
}
