import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { createApolloHarness, demoPeople } from './support/apollo'
import { apiOrigin, mockSupabase, signIn } from './support/supabase'
// Apollo lead generation end to end: the real UI, the real apollo Edge handler and migration SQL in embedded PostgreSQL.
// Auth, HTTP transport and Apollo's API are simulated; no request leaves the machine and no credits are used.
const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com',password:'test-password'}
let db:PGlite
test.describe.configure({timeout:150000})
test.afterEach(async()=>{await db?.close()})
async function start(page:Page,overrides:Record<string,string|undefined>={}){
 db=await createDatabase([owner.id])
 await db.query('update auth.users set email=$2 where id=$1',[owner.id,owner.email])
 await db.transaction(async tx=>{await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",[owner.id,JSON.stringify({sub:owner.id,role:'authenticated'})]);await tx.exec('set local role authenticated');await tx.query('select public.load_workspace()')})
 await mockSupabase(page,db,{users:[owner]})
 const harness=createApolloHarness(db,{APOLLO_WORKSPACE_IDS:owner.id,...overrides})
 harness.state.people=demoPeople()
 harness.state.organizations=[{id:'org-harbor',name:'Harbor Dental',primary_domain:'harbor-dental.example',website_url:'http://www.harbor-dental.example',linkedin_url:'http://www.linkedin.com/company/harbor',primary_phone:{sanitized_number:'+15125550100'}}]
 await page.route(`${apiOrigin}/functions/v1/apollo`,async route=>{
  const request=route.request()
  const response=await harness.handler(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}))
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
 await page.goto('/login');await signIn(page,owner.email)
 await page.getByRole('button',{name:'Discovery',exact:true}).click()
 return harness
}
const row=(page:Page,text:string)=>page.locator('.ap-table tbody tr',{hasText:text})

test('searches people, reveals with credit confirmation, saves to a list, receives phone numbers and tracks credits',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 const harness=await start(page)
 await expect(page.getByRole('tab',{name:'Find people'})).toHaveAttribute('aria-selected','true')
 await expect(page.locator('.ap-remaining')).toHaveText('70 / 70 credits left')
 // Filters: free-text tags, a searchable fixed list, chips and Clear all.
 await page.getByRole('combobox',{name:'Job titles',exact:true}).fill('owner');await page.keyboard.press('Enter')
 await page.getByRole('combobox',{name:'Seniority',exact:true}).fill('foun');await page.getByRole('option',{name:'Founder',exact:true}).click()
 await expect(page.getByRole('list',{name:'Selected filters'})).toContainText('Seniority: Founder')
 await page.getByRole('button',{name:'Remove Seniority filter'}).click()
 await expect(page.getByRole('list',{name:'Selected filters'})).not.toContainText('Seniority')
 await page.getByRole('button',{name:'Search people'}).click()
 await expect(page.getByRole('heading',{name:'3 people found'})).toBeVisible()
 const query=harness.state.calls.at(-1)!.query
 expect([query.getAll('person_titles[]'),query.get('per_page')]).toEqual([['owner'],'25'])
 await expect(row(page,'Avery St***e')).toContainText('Available · locked')
 await expect(row(page,'Avery St***e')).toContainText('Direct phone · locked')
 // Reveal two people: the dialog shows the most it can cost, then the emails appear.
 await row(page,'Avery St***e').getByRole('checkbox').check();await row(page,'Jordan Le***e').getByRole('checkbox').check()
 await page.getByRole('button',{name:'Reveal contact details'}).click()
 const reveal=page.getByRole('dialog',{name:'Reveal 2 people?'})
 await expect(reveal).toContainText('up to 2 credits');await expect(reveal).toContainText('70 of 70 credits left this cycle')
 await reveal.getByRole('button',{name:'Reveal for up to 2 credits'}).click()
 await expect(page.locator('.dv-summary')).toContainText('Revealed 2 of 2 · 2 credits used.')
 await expect(row(page,'Avery Stone')).toContainText('avery@harbor-dental.example')
 await expect(page.locator('.ap-remaining')).toHaveText('68 / 70 credits left')
 // Save Avery (revealed) and Sam (not revealed) to a new list.
 await row(page,'Avery Stone').getByRole('checkbox').check();await row(page,'Sam Ri***a').getByRole('checkbox').check()
 await page.getByRole('button',{name:'Save 2 to Leads'}).click()
 const saveDialog=page.getByRole('dialog',{name:'Save 2 to Leads'})
 await expect(saveDialog).toContainText('1 of these haven’t been revealed')
 await saveDialog.getByLabel('Add to a list (optional)').selectOption('new');await saveDialog.getByLabel('List name').fill('Austin owners')
 await saveDialog.getByRole('button',{name:'Save 2'}).click()
 await expect(page.locator('.dv-summary')).toContainText('2 saved to Leads and added to “Austin owners”.')
 await expect(row(page,'Avery Stone')).toContainText('In LeadFlow')
 // Phone lookup for Sam: Apollo delivers the number to the webhook later.
 await row(page,'Sam Ri***a').getByRole('checkbox').check()
 await page.getByRole('button',{name:'Reveal contact details'}).click()
 const phoneDialog=page.getByRole('dialog',{name:'Reveal 1 person?'})
 await phoneDialog.getByLabel('Also look up mobile numbers').check()
 await expect(phoneDialog).toContainText('up to 8 credits');await phoneDialog.getByRole('button',{name:'Reveal for up to 9 credits'}).click()
 await expect(page.getByText(/Waiting for Apollo to deliver 1 phone lookup/)).toBeVisible()
 await expect(row(page,'Sam Rivera')).toContainText('Looking up…')
 const token=new URL(harness.state.calls.at(-1)!.query.get('webhook_url')!).searchParams.get('token')!
 const delivered=await harness.webhook(new Request(`https://project.test/functions/v1/apollo-webhook?token=${token}`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({status:'success',credits_consumed:8,people:[{id:demoPeople()[2].id,status:'success',phone_numbers:[{sanitized_number:'+15125550103',type_cd:'mobile',status_cd:'valid_number'}]}]})}))
 expect(delivered.status).toBe(200)
 // The saved lead now has the full name and the phone; the list filter finds both leads.
 await page.getByRole('button',{name:'Leads',exact:true}).click();await page.getByRole('button',{name:'Refresh'}).click()
 await page.getByLabel('Filter by list').selectOption({label:'Austin owners (2)'})
 await expect(page.getByRole('button',{name:'View Sam Rivera'})).toBeVisible();await expect(page.getByRole('button',{name:'View Avery Stone'})).toBeVisible()
 await page.getByRole('button',{name:'View Sam Rivera'}).click()
 const lead=page.getByRole('dialog',{name:'Sam Rivera'})
 await expect(lead).toContainText('+15125550103');await expect(lead).toContainText('Found with lead discovery (Apollo)');await expect(lead).toContainText('using account primary')
 await expect(lead).toContainText('Phone number revealed through Apollo')
 await lead.getByRole('button',{name:'Close dialog'}).click()
 // Credits & accounts: ledger figures with their source.
 await page.getByRole('button',{name:'Discovery',exact:true}).click();await page.getByRole('tab',{name:'Credits & accounts'}).click()
 const card=page.locator('.ap-account',{hasText:'primary'})
 await expect(card.locator('.ap-figures')).toContainText('Used11');await expect(card.locator('.ap-figures')).toContainText('Remaining59')
 await expect(page.locator('.ap-ledger tbody tr')).toHaveCount(3)
 await expect(page.locator('.ap-ledger tbody tr').first()).toContainText('8 reported by Apollo')
 await page.getByLabel('Operation').selectOption('email_reveal');await expect(page.locator('.ap-ledger tbody tr')).toHaveCount(2)
 await card.getByRole('button',{name:'Sync credits from Apollo'}).click()
 await expect(card).toContainText('Email credits: 67 left of 70')
 await card.getByRole('button',{name:'Edit',exact:true}).click()
 const editor=page.getByRole('dialog',{name:'Edit primary'})
 await editor.getByLabel('Nickname').fill('Main team');await editor.getByLabel('Notes').fill('Paid Basic plan');await editor.getByRole('button',{name:'Save'}).click()
 await expect(page.getByRole('heading',{name:'Main team'})).toBeVisible()
 expect(errors).toEqual([])
})

test('saves and reuses filters, runs a company search only after confirming the credit, and fits a phone',async({page})=>{
 const harness=await start(page)
 await page.getByRole('combobox',{name:'Job titles',exact:true}).fill('owner');await page.keyboard.press('Enter')
 // Locations: a long suggestion list, and anything typed can be added.
 await page.locator('.ap-group summary',{hasText:/^Location/}).click()
 const location=page.getByRole('combobox',{name:'Person location',exact:true})
 await location.fill('chicago');await expect(page.getByRole('option',{name:'Chicago, US'})).toBeVisible()
 await location.fill('Lake Tahoe');await page.getByRole('option',{name:'Add “Lake Tahoe”'}).click()
 await expect(page.getByRole('list',{name:'Selected filters'})).toContainText('Person location: Lake Tahoe')
 await page.getByRole('button',{name:'Remove Person location filter'}).click()
 await page.getByRole('button',{name:'Save these filters'}).click()
 await page.getByRole('dialog',{name:'Save these filters'}).getByLabel('Name').fill('Owners')
 await page.getByRole('dialog',{name:'Save these filters'}).getByRole('button',{name:'Save'}).click()
 // Search, export everything found, then open the export again and reveal the rest without searching.
 await page.getByRole('button',{name:'Search people'}).click()
 await expect(page.getByRole('heading',{name:'3 people found'})).toBeVisible()
 const download=page.waitForEvent('download')
 await page.getByRole('button',{name:'Export everything found'}).click()
 const file=await download
 const text=(await readFile(await file.path(),'utf8')).replace(/^\uFEFF/,'')
 expect(text.split('\r\n')[0]).toContain('Apollo person ID,Name,Title,Company')
 expect(text).toContain('Avery St***e')
 await expect(page.locator('.dv-summary')).toContainText('Exported 3 people, 0 with revealed contact details.')
 const searches=harness.state.calls.length
 await page.getByLabel('Open a LeadFlow Apollo export').setInputFiles({name:'my-apollo-leads.csv',mimeType:'text/csv',buffer:Buffer.from(text)})
 await expect(page.getByText('Showing 3 people from my-apollo-leads.csv. No search was run and no credits were used.')).toBeVisible()
 expect(harness.state.calls.length).toBe(searches)
 await page.getByRole('button',{name:'Select not yet revealed'}).click()
 await page.getByRole('button',{name:'Reveal contact details'}).click()
 await page.getByRole('dialog',{name:'Reveal 3 people?'}).getByRole('button',{name:'Reveal for up to 3 credits'}).click()
 await expect(page.locator('.dv-summary')).toContainText('Revealed 3 of 3 · 3 credits used.')
 await expect(row(page,'Avery Stone')).toContainText('harbor-dental.example')
 await page.getByRole('button',{name:'Select not yet revealed'}).click()
 await expect(page.getByRole('button',{name:'Reveal contact details'})).toHaveCount(0)
 // Sessions: each search stays switchable until cleared; switching uses saved results, not Apollo.
 await page.getByRole('combobox',{name:'Job titles',exact:true}).fill('ceo');await page.keyboard.press('Enter')
 await page.getByRole('button',{name:'Search people'}).click()
 const sessions=page.getByRole('list',{name:'Your searches'})
 await expect(sessions.getByRole('listitem')).toHaveCount(2)
 await expect(sessions.getByRole('listitem').first()).toContainText('Job titles: owner, ceo')
 const before=harness.state.calls.length
 await sessions.getByRole('button',{name:/^Job titles: owner \d/}).click()
 await expect(page.getByText(/Saved results from .* No credits used\./)).toBeVisible()
 expect(harness.state.calls.length).toBe(before)
 await expect(page.getByRole('list',{name:'Selected filters'})).not.toContainText('ceo')
 // Export this search: every page, one file.
 await page.getByRole('button',{name:'Export this search'}).click()
 const exportDialog=page.getByRole('dialog',{name:'Export this search'})
 await expect(exportDialog).toContainText('None, people search is free')
 const searchDownload=page.waitForEvent('download')
 await exportDialog.getByRole('button',{name:'Start export'}).click()
 const searchFile=(await readFile(await (await searchDownload).path(),'utf8')).replace(/^\uFEFF/,'')
 expect(searchFile.trim().split('\r\n')).toHaveLength(4)
 await expect(page.locator('.dv-summary')).toContainText('Exported 3 people from this search.')
 // Clear results removes the current search; Clear all removes the rest.
 await page.getByRole('button',{name:'Clear results'}).click()
 await expect(page.getByRole('heading',{name:'Choose filters, then search'})).toBeVisible()
 await expect(sessions.getByRole('listitem')).toHaveCount(1)
 await page.getByRole('button',{name:'Clear all searches'}).click()
 await expect(page.getByRole('list',{name:'Your searches'})).toHaveCount(0)
 await page.getByRole('tab',{name:'Saved & recent'}).click()
 await expect(page.locator('.ap-saved li',{hasText:'Owners'})).toContainText('Job titles: owner')
 await page.locator('.ap-saved li',{hasText:'Owners'}).getByRole('button',{name:'Use filters'}).click()
 await expect(page.getByRole('list',{name:'Selected filters'})).toContainText('Job titles: owner')
 await page.getByRole('tab',{name:'Find companies'}).click()
 await page.getByRole('combobox',{name:'Industries',exact:true}).fill('marketing');await page.getByRole('option',{name:'marketing & advertising'}).click()
 await page.getByRole('button',{name:'Search companies'}).click()
 const confirm=page.getByRole('dialog',{name:'Use 1 credit for this page?'})
 const calls=harness.state.calls.length
 await confirm.getByRole('button',{name:'Cancel'}).click()
 expect(harness.state.calls.length).toBe(calls)
 await page.getByRole('button',{name:'Search companies'}).click();await page.getByRole('button',{name:'Use 1 credit and search'}).click()
 await expect(page.getByRole('heading',{name:'1 company found'})).toBeVisible()
 await expect(row(page,'Harbor Dental')).toContainText('+15125550100')
 await expect(page.locator('.ap-remaining')).toHaveText('66 / 70 credits left')
 // Leaving and coming back shows the same page from saved results, without another credit.
 const callsBefore=harness.state.calls.length
 await page.getByRole('tab',{name:'Find people'}).click();await page.getByRole('tab',{name:'Find companies'}).click()
 await expect(page.getByText(/Saved results from .* No credits used./)).toBeVisible()
 await expect(row(page,'Harbor Dental')).toBeVisible()
 await page.getByRole('button',{name:'Search companies'}).click()
 await expect(page.getByRole('dialog',{name:'Use 1 credit for this page?'})).toHaveCount(0)
 expect(harness.state.calls.length).toBe(callsBefore)
 await expect(page.locator('.ap-remaining')).toHaveText('66 / 70 credits left')
 await page.setViewportSize({width:390,height:844})
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.getByRole('tab',{name:'Credits & accounts'}).click()
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})

test('explains how to connect Apollo when this workspace is not enabled',async({page})=>{
 await start(page,{APOLLO_WORKSPACE_IDS:'22222222-2222-4222-8222-222222222222'})
 await expect(page.getByRole('heading',{name:'Apollo isn’t switched on for this workspace'})).toBeVisible()
 await expect(page.locator('.dv-setup-detail')).toContainText(owner.id)
 await page.getByRole('tab',{name:'Import CSV'}).click()
 await expect(page.getByRole('heading',{name:'Import leads from a CSV file'})).toBeVisible()
})
