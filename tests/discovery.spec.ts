import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { createDatabase } from './support/database'
import { austinDirectory, createDiscoveryHarness } from './support/discovery'
import { apiOrigin, mockSupabase, signIn } from './support/supabase'
// Lead discovery end to end. Auth and HTTP transport are simulated; every RPC runs the real migration SQL in
// embedded PostgreSQL, and searches go through the real discover-leads handler with a simulated directory.
const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com',password:'test-password'}
let db:PGlite
test.describe.configure({timeout:120000})
test.afterEach(async()=>{await db?.close()})
async function rpc<T>(user:string,text:string,params:unknown[]=[]){
 return db.transaction(async tx=>{await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",[user,JSON.stringify({sub:user,role:'authenticated'})]);await tx.exec('set local role authenticated');return (await tx.query<{result:T}>(text,params)).rows[0].result})
}
async function start(page:Page,overrides:Record<string,string|undefined>={},users=[owner]){
 db=await createDatabase(users.map(user=>user.id))
 for(const user of users)await db.query('update auth.users set email=$2 where id=$1',[user.id,user.email])
 await rpc(owner.id,'select public.load_workspace()')
 await mockSupabase(page,db,{users})
 const harness=createDiscoveryHarness(db,overrides)
 harness.state.places.austin={osm_type:'relation',osm_id:113314,lat:'30.27',lon:'-97.74',boundingbox:['30.0986648','30.5168629','-97.9383829','-97.5684083']}
 harness.state.elements=austinDirectory()
 await page.route(`${apiOrigin}/functions/v1/discover-leads`,async route=>{
  const request=route.request()
  const response=await harness.handler(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}))
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
 return harness
}
const existing=(rows:Record<string,string>[])=>rpc(owner.id,'select public.import_leads($1,$2,$3)',[owner.id,crypto.randomUUID(),JSON.stringify({method:'csv',rows:rows.map((row,index)=>({key:`seed-${index}`,...row}))})])
async function openDiscovery(page:Page){await page.getByRole('button',{name:'Discovery',exact:true}).click();await expect(page.getByRole('heading',{name:'Lead discovery',level:1})).toBeVisible()}
const noHorizontalScroll=(page:Page)=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)
const resultRow=(page:Page,name:string)=>page.locator('.dv-table tbody tr',{hasText:name})

test('finds businesses, reviews duplicates, imports the chosen ones with provenance, and reopens a search from history',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 const harness=await start(page)
 await existing([{businessName:'Bluebonnet Dental Group',contactName:'Avery Stone',website:'https://bluebonnet-dental.example/about'}])
 await page.goto('/login');await signIn(page,owner.email);await openDiscovery(page)
 await expect(page.getByRole('heading',{name:'Who are you looking for?'})).toBeVisible()
 await expect(page.getByLabel('Industry or niche')).toHaveValue('dental')
 // Validation before any request is spent.
 await page.getByRole('button',{name:'Find businesses'}).click()
 await expect(page.getByRole('alert')).toContainText('Enter a city or postcode for location 1.')
 expect(harness.state.directoryQueries).toHaveLength(0)
 await page.getByLabel('City or town').fill('Austin');await page.getByLabel('State (optional)').fill('TX')
 await page.getByLabel('Has a website').check()
 await page.getByRole('button',{name:'Find businesses'}).click()
 await expect(page.getByRole('heading',{name:/4 businesses found/})).toBeVisible()
 expect(harness.state.directoryQueries[0]).toContain('website|contact:website')
 await expect(page.getByRole('link',{name:/OpenStreetMap contributors/})).toHaveAttribute('href','https://www.openstreetmap.org/copyright')
 await expect(resultRow(page,'Bluebonnet Dental')).toContainText('Possible duplicate')
 await expect(resultRow(page,'Lone Star Smiles')).toContainText('New')
 await expect(resultRow(page,'Lone Star Smiles')).toContainText(/Updated (Mar 15, 2025|15 Mar 2025)/)
 await expect(resultRow(page,'Barton Creek Family Dentistry')).toContainText('No public contact details')
 // Details: real values only, safe links, copy actions, freshness and source.
 await resultRow(page,'Lone Star Smiles').getByRole('button',{name:'Details'}).click()
 const detail=page.getByRole('dialog',{name:'Lone Star Smiles'})
 await expect(detail.getByRole('link',{name:'https://www.lonestarsmiles.example/'})).toHaveAttribute('rel',/noopener/)
 await expect(detail.getByText('Not provided by this source')).toHaveCount(1)
 await expect(detail).toContainText(/Source record last updated (Mar 15, 2025|15 Mar 2025)/)
 await expect(detail.getByRole('button',{name:'Copy phone number'})).toBeVisible()
 await detail.getByRole('button',{name:'Close dialog'}).click()
 // Exclude an irrelevant result, then select everything that is left.
 await resultRow(page,'Unreliable Data Dental').getByRole('button',{name:'Exclude'}).click()
 await expect(resultRow(page,'Unreliable Data Dental')).toHaveCount(0)
 await expect(page.getByRole('button',{name:'Excluded (1)'})).toBeVisible()
 await page.getByLabel('Select all shown businesses').check()
 await page.getByRole('button',{name:'Add 3 to LeadFlow'}).click()
 const review=page.getByRole('dialog',{name:'Review possible duplicates'})
 await expect(review).toContainText('Same website as an existing lead: Avery Stone · Bluebonnet Dental Group')
 await review.getByRole('button',{name:'Add 2 to LeadFlow'}).click()
 await expect(page.locator('.dv-summary')).toContainText('Added 2 to Leads.')
 await expect(page.locator('.toast')).toContainText('2 businesses were added to your leads.')
 await expect(resultRow(page,'Lone Star Smiles')).toContainText('In LeadFlow')
 await expect(resultRow(page,'Lone Star Smiles').getByRole('checkbox')).toBeDisabled()
 await expect(resultRow(page,'Bluebonnet Dental')).toContainText('Possible duplicate')
 // The imported lead carries its business details and provenance.
 await page.getByRole('button',{name:'Leads',exact:true}).click()
 await page.getByRole('button',{name:'View Lone Star Smiles'}).click()
 const lead=page.getByRole('dialog',{name:'Lone Star Smiles'})
 await expect(lead).toContainText('lonestarsmiles.example');await expect(lead).toContainText('Dental clinics')
 await expect(lead).toContainText('Found with lead discovery (OpenStreetMap)')
 await expect(lead.getByRole('link',{name:'View source record'})).toHaveAttribute('href','https://www.openstreetmap.org/way/202')
 await expect(lead).toContainText('Lead imported from lead discovery')
 await lead.getByRole('button',{name:'Close dialog'}).click()
 // History keeps criteria and counts, and reopens them.
 await openDiscovery(page);await page.getByRole('tab',{name:'Search history'}).click()
 const entry=page.locator('.dv-history li').first()
 await expect(entry).toContainText('Dental clinics in Austin, TX, United States');await expect(entry).toContainText('4 results');await expect(entry).toContainText('has a website')
 await entry.getByRole('button',{name:'Use these criteria'}).click()
 await expect(page.getByLabel('City or town')).toHaveValue('Austin');await expect(page.getByLabel('Has a website')).toBeChecked()
 expect(errors).toEqual([])
})

test('explains when discovery is not configured and offers the CSV and manual alternatives',async({page})=>{
 await start(page,{OSM_OVERPASS_URL:undefined})
 await page.goto('/login');await signIn(page,owner.email);await openDiscovery(page)
 await expect(page.getByRole('heading',{name:'Business search hasn’t been set up for this LeadFlow deployment'})).toBeVisible()
 await expect(page.locator('.dv-setup')).toContainText('OSM_OVERPASS_URL')
 await page.getByRole('button',{name:'Import a CSV file'}).click()
 await expect(page.getByRole('heading',{name:'Import leads from a CSV file'})).toBeVisible()
})

test('recovers from a provider failure with retry, and records both attempts',async({page})=>{
 const harness=await start(page)
 harness.state.directoryFailures=[503,503]
 await page.goto('/login');await signIn(page,owner.email);await openDiscovery(page)
 await page.getByLabel('City or town').fill('Austin')
 await page.getByRole('button',{name:'Find businesses'}).click()
 await expect(page.locator('.dv-problem')).toContainText('The business directory is busy')
 await page.getByRole('button',{name:'Try again'}).click()
 await expect(page.getByRole('heading',{name:/4 businesses found/})).toBeVisible()
 await page.getByRole('tab',{name:'Search history'}).click()
 await expect(page.locator('.dv-history li').nth(0)).toContainText('4 results')
 await expect(page.locator('.dv-history li').nth(1)).toContainText('Source unavailable')
})

test('imports a CSV file with column mapping, row validation, duplicate review and a file of rows not imported',async({page})=>{
 await start(page)
 await existing([{businessName:'Existing Co',contactName:'Pat Doe',email:'pat@existing.example',website:'https://existing.example'}])
 await page.goto('/login');await signIn(page,owner.email);await openDiscovery(page);await page.getByRole('tab',{name:'Import CSV'}).click()
 const csv=['Company,Contact,E-mail,Website,City,Country,Notes',
  'Pine & Co,Sam Pine,sam@pine.example,pine.example,Leeds,United Kingdom,"Met at expo, keen"',
  'Quiet Studio,,,,Sydney,AU,',
  'Bad Email Ltd,Lee,not-an-email,,,,',
  'Existing Co,Pat Doe,PAT@existing.example,,,,',
  'Existing Annex,,,www.existing.example/annex,,,',
  'Pine Copy,,sam@pine.example,,,,',
  '"=HYPERLINK(""x"")",,,,,,'].join('\r\n')
 await page.locator('input[type=file]').setInputFiles({name:'expo-leads.csv',mimeType:'text/csv',buffer:Buffer.from(csv)})
 await expect(page.getByText('expo-leads.csv')).toBeVisible()
 await expect(page.getByLabel('Column for Business name')).toHaveValue('0');await expect(page.getByLabel('Column for Email')).toHaveValue('2')
 await expect(page.getByLabel('Column for Phone')).toHaveValue('-1')
 await page.getByRole('button',{name:'Review rows'}).click()
 await expect(page.getByRole('button',{name:/^3\s*Ready/})).toBeVisible()
 await expect(page.getByRole('button',{name:/^1\s*Possible duplicate/})).toBeVisible()
 await expect(page.getByRole('button',{name:/^2\s*Already in LeadFlow/})).toBeVisible()
 await expect(page.getByRole('button',{name:/^1\s*Needs fixing/})).toBeVisible()
 await page.getByRole('button',{name:/Needs fixing/}).click()
 await expect(page.locator('.dv-preview')).toContainText('“not-an-email” is not a valid email address.')
 await page.getByLabel(/Also import the 1 possible duplicate/).check()
 await page.getByRole('button',{name:'Import 4 leads'}).click()
 await expect(page.locator('.dv-summary')).toContainText('4 leads imported from expo-leads.csv. 3 rows weren’t imported.')
 const download=page.waitForEvent('download')
 await page.getByRole('button',{name:'Download rows not imported'}).click()
 const file=await readFile(await (await download).path(),'utf8')
 expect(file.split('\r\n')[0]).toBe('Company,Contact,E-mail,Website,City,Country,Notes,LeadFlow issue')
 expect(file).toContain('Bad Email Ltd');expect(file).toContain('Same email as an existing lead')
 await page.getByRole('button',{name:'Leads',exact:true}).click()
 await expect(page.getByRole('button',{name:'View Sam Pine'})).toBeVisible()
 await expect(page.getByRole('button',{name:'View =HYPERLINK("x")'})).toBeVisible()
 await page.getByRole('button',{name:'View Quiet Studio'}).click()
 await expect(page.getByRole('dialog',{name:'Quiet Studio'})).toContainText('Imported from a CSV file')
 await expect(page.getByRole('dialog',{name:'Quiet Studio'})).toContainText('Sydney, Australia')
})

test('adds a business manually with optional email and warns before creating a duplicate; the page fits a phone',async({page})=>{
 await start(page)
 await page.goto('/login');await signIn(page,owner.email);await openDiscovery(page)
 await page.getByRole('button',{name:'Add a business manually'}).click()
 const form=page.getByRole('dialog',{name:'Capture a new lead'})
 await form.getByLabel('Name *',{exact:true}).fill('Harbor Dental')
 await form.getByLabel('Service interest *').selectOption('Not specified');await form.getByLabel('Source *').selectOption('Lead discovery')
 await form.getByText('Business details').click()
 await form.getByLabel('Website',{exact:true}).fill('not a site')
 await form.getByRole('button',{name:'Create lead'}).click()
 await expect(form.getByRole('alert')).toContainText('Enter a website such as https://example.com.')
 await form.getByLabel('Website',{exact:true}).fill('harbor-dental.example');await form.getByLabel('City',{exact:true}).fill('Austin');await form.getByLabel(/^Country/).selectOption('US')
 await form.getByRole('button',{name:'Create lead'}).click()
 await expect(page.locator('.toast')).toContainText('Harbor Dental was added to your leads.')
 await page.getByRole('button',{name:'Add a business manually'}).click()
 await form.getByLabel('Name *',{exact:true}).fill('Harbor Dental Annex')
 await form.getByLabel('Service interest *').selectOption('Not specified');await form.getByLabel('Source *').selectOption('Other')
 await form.getByText('Business details').click();await form.getByLabel('Website',{exact:true}).fill('https://www.harbor-dental.example/annex')
 await form.getByRole('button',{name:'Create lead'}).click()
 await expect(form.getByRole('alert')).toContainText('Same website as an existing lead: Harbor Dental')
 await form.getByRole('button',{name:'Create anyway'}).click()
 await expect(page.locator('.toast')).toContainText('Harbor Dental Annex was added to your leads.')
 const leads=await rpc<{data:{leads:{name:string;website:string;email:string;country:string}[]}}>(owner.id,'select public.load_workspace() as result')
 expect(leads.data.leads.map(lead=>[lead.name,lead.website,lead.email,lead.country]).sort((a,b)=>a[0].localeCompare(b[0]))).toEqual([['Harbor Dental','https://harbor-dental.example/','','US'],['Harbor Dental Annex','https://www.harbor-dental.example/annex','','']])
 // Phone width: search and results stay within the screen.
 await page.setViewportSize({width:390,height:844})
 await page.getByLabel('City or town').fill('Austin');await page.getByRole('button',{name:'Find businesses'}).click()
 await expect(page.getByRole('heading',{name:/4 businesses found/})).toBeVisible()
 expect(await noHorizontalScroll(page)).toBe(true)
 await resultRow(page,'Lone Star Smiles').getByRole('checkbox').check()
 await expect(page.getByRole('button',{name:'Add 1 to LeadFlow'})).toBeInViewport()
})
