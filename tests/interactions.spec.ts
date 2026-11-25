import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { mockSupabase, signIn } from './support/supabase'

// App-wide feedback: toasts that can be held and dismissed, page and list entrances, and
// count-up figures. Reduced motion turns every movement off and shows final values at once.
const actor = '11111111-1111-4111-8111-111111111111'
let db: PGlite | undefined
test.afterEach(async () => { await db?.close(); db = undefined })

async function start(page: Page) {
  const database = db = await createDatabase([actor])
  await mockSupabase(page, database, { users: [{ id: actor, email: 'test@example.com', password: 'test-password' }] })
  await page.goto('/app')
  await expect(page.getByRole('heading', { name: 'Sign in to LeadFlow' })).toBeVisible()
  await signIn(page, 'test@example.com')
  await page.getByRole('button', { name: 'Reset demo data' }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: 'Reset demo data', exact: true }).click()
  await expect(page.getByLabel('Status for Olivia Bennett')).toBeVisible()
}
const nav = (page: Page, name: string) => page.locator('.nav-item', { hasText: name })
const statPairs = (page: Page) => page.locator('.stat-card').evaluateAll(cards => cards.map(card => [/: (\d+)\./.exec(card.getAttribute('aria-label') ?? '')?.[1], card.querySelector('strong')?.textContent]))

test('a toast confirms a change, holds while pointed at or focused, closes on request or by itself, and stays in the notification center', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await start(page)
  const toast = page.locator('.toast')
  await page.getByLabel('Status for Olivia Bennett').selectOption('Contacted')
  await expect(toast).toContainText('Olivia Bennett moved to Contacted.')
  await expect(toast.locator('.toast-timer')).toHaveCount(1)

  await toast.hover()
  await expect(toast).toHaveClass(/is-held/)
  await expect(toast.locator('.toast-timer')).toHaveCount(0)
  await page.mouse.move(0, 0)
  await expect(toast).not.toHaveClass(/is-held/)
  await expect(toast.locator('.toast-timer')).toHaveCount(1)

  const dismiss = toast.getByRole('button', { name: 'Dismiss message', exact: true })
  await dismiss.focus()
  await expect(toast).toHaveClass(/is-held/)
  await page.keyboard.press('Enter')
  await expect(toast).toHaveCount(0)

  // Closing the toast keeps the message in the history.
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Notifications', exact: true })).toContainText('Olivia Bennett moved to Contacted.')
  await page.keyboard.press('Escape')

  // Left alone, the next toast closes by itself.
  await page.getByLabel('Status for Olivia Bennett').selectOption('Qualified')
  await expect(toast).toContainText('Olivia Bennett moved to Qualified.')
  await expect(toast).toHaveCount(0, { timeout: 12_000 })
  expect(errors).toEqual([])
})

test('pages arrive with motion and figures count up to their real values; reduced motion shows everything at once', async ({ page }) => {
  await start(page)
  await nav(page, 'Leads').click()
  expect(await page.locator('.content').evaluate(element => element.getAnimations().length)).toBeGreaterThan(0)
  await nav(page, 'Overview').click()
  await expect(page.locator('.stat-card').first()).toBeVisible()
  await expect.poll(async () => (await statPairs(page)).every(([label, shown]) => label !== undefined && label === shown)).toBe(true)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await nav(page, 'Leads').click()
  await expect(page.getByLabel('Status for Olivia Bennett')).toBeVisible()
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  await nav(page, 'Overview').click()
  await expect(page.locator('.stat-card').first()).toBeVisible()
  const pairs = await statPairs(page)
  expect(pairs.length).toBeGreaterThan(0)
  for (const [label, shown] of pairs) expect(shown).toBe(label)
})
