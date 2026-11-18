import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { mockSupabase, signIn } from './support/supabase'

// Dark mode: follows the system by default, can be switched and remembered, and never reaches the marketing site
// or the embeddable inquiry form.
const owner = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com', password: 'test-password' }
let db: PGlite | undefined
test.afterEach(async () => { await db?.close(); db = undefined })
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? null)

async function start(page: Page) {
  const database = db = await createDatabase([owner.id])
  await database.query('update auth.users set email=$2 where id=$1', [owner.id, owner.email])
  await mockSupabase(page, database, { users: [owner] })
  await page.goto('/login')
}

test('the app follows the system theme until the user picks one, and remembers the choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await start(page)
  expect(await theme(page)).toBe('dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => theme(page)).toBe('light')

  await signIn(page, owner.email)
  await page.getByRole('button', { name: 'Switch to dark theme' }).click()
  expect(await theme(page)).toBe('dark')
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(245, 247, 246)')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible()
  expect(await theme(page)).toBe('dark')

  // The command menu can hand the choice back to the system setting.
  await page.keyboard.press('Control+K')
  const menu = page.getByRole('dialog', { name: 'Command menu' })
  await menu.getByRole('combobox').fill('system')
  await menu.getByRole('option', { name: /Match system theme/ }).click()
  await expect(menu).toHaveCount(0)
  await expect.poll(() => theme(page)).toBe('light')
  expect(await page.evaluate(() => localStorage.getItem('leadflow.theme'))).toBeNull()
})

test('the marketing site and the inquiry form stay light', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => localStorage.setItem('leadflow.theme', 'dark'))
  await page.goto('/')
  await expect(page.locator('main h1')).toBeVisible()
  expect(await theme(page)).toBeNull()
  await page.goto('/inquiry')
  await expect(page.getByRole('heading', { name: 'A good project starts with a conversation.' })).toBeVisible()
  expect(await theme(page)).toBeNull()
})
