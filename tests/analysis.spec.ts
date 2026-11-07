import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { createAnalysisHarness, dentalSite } from './support/analysis'
import { apiOrigin, mockSupabase, signIn } from './support/supabase'
// Business intelligence end to end: the real UI, the real business-analysis Edge handler and migration SQL in embedded PostgreSQL.
// Websites, DNS, PageSpeed Insights and the AI provider are simulated; no request leaves the machine and nothing is billed.
const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com',password:'test-password'}
let db:PGlite
test.describe.configure({timeout:150000})
test.afterEach(async()=>{await db?.close()})
const lead=(id:string,fields:Record<string,string>={})=>({id,name:'Avery Stone',email:'',phone:'',company:'Harbor Dental',service:'Not specified',source:'Lead discovery',message:'',status:'New',createdAt:'2026-11-01T00:00:00.000Z',website:'https://harbor-dental.example/',industry:'Dental clinics',address:'',city:'Austin',region:'TX',postcode:'',country:'US',...fields})
const pagespeedBody=(strategy:string,score:number)=>({lighthouseResult:{finalUrl:'https://harbor-dental.example/',fetchTime:'2026-11-08T10:00:00.000Z',categories:{performance:{score},seo:{score:0.92}},
 audits:{'largest-contentful-paint':{numericValue:strategy==='mobile'?5200:2100},'first-contentful-paint':{numericValue:1900},'cumulative-layout-shift':{numericValue:0.05},'speed-index':{numericValue:4000},'total-blocking-time':{numericValue:350},viewport:{score:1}}},loadingExperience:{metrics:{}}})
async function start(page:Page,overrides:Record<string,string|undefined>={}){
 db=await createDatabase([owner.id])
 await db.query('update auth.users set email=$2 where id=$1',[owner.id,owner.email])
 await db.transaction(async tx=>{
  await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",[owner.id,JSON.stringify({sub:owner.id,role:'authenticated'})]);await tx.exec('set local role authenticated')
  const current=(await tx.query<{w:{data:{leads:unknown[]},revision:number}}>('select public.load_workspace() as w')).rows[0].w
  await tx.query('select public.save_workspace_for($1,$2,$3,$4)',[owner.id,JSON.stringify({...current.data,leads:[lead('harbor'),lead('no-site',{website:'',company:'Quiet Bakery',name:'Rae Lin'})]}),current.revision,crypto.randomUUID()])
 })
 await mockSupabase(page,db,{users:[owner]})
 const harness=createAnalysisHarness(db,{GEMINI_API_KEY:'gemini-test',GOOGLE_PAGESPEED_API_KEY:'pagespeed-test',ANALYSIS_RECENT_HOURS:'24',...overrides})
 dentalSite(harness.state)
 harness.state.sites['https://harbor-dental.example/old-page/']={status:404,body:'gone'}
 harness.state.pagespeed.mobile=[{status:200,body:pagespeedBody('mobile',0.42)},{status:200,body:pagespeedBody('mobile',0.45)}]
 harness.state.pagespeed.desktop=[{status:200,body:pagespeedBody('desktop',0.81)},{status:200,body:pagespeedBody('desktop',0.83)}]
 harness.state.ai.output={overview:{summary:{text:'A family dental practice in Austin offering checkups, cleanings, whitening and implants.',evidenceRefs:['E2']},mainServices:[{text:'Implants',evidenceRefs:['E2']}],audienceIndicators:[],positioning:{text:'',evidenceRefs:[]}},
  findings:[{category:'communication',title:'Patients may ask booking questions by phone',description:'Booking is by phone only.',findingType:'hypothesis',severity:'low',confidence:'medium',evidenceRefs:['E2'],basedOnFindings:[],businessRelevance:'',recommendedAction:'Ask the practice.',opportunityType:'booking_integration'}]}
 await page.route(`${apiOrigin}/functions/v1/business-analysis`,async route=>{
  const request=route.request()
  const response=await harness.handler(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}))
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
 await page.goto('/login');await signIn(page,owner.email)
 return harness
}
async function openReport(page:Page,name:string){
 await page.getByRole('button',{name:'Leads',exact:true}).click()
 await page.getByLabel(`View ${name}`).first().click()
 await page.getByRole('button',{name:'Business report'}).click()
 return page.locator('dialog#business-report')
}

test('analyzes a lead’s website: progress, evidence-backed findings, matched opportunities, review and reanalysis',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 const harness=await start(page)
 // The catalog: starter services, edited and extended in Settings.
 await page.getByRole('button',{name:'Settings',exact:true}).click()
 const services=page.locator('.svc-panel')
 await expect(services).toContainText('No services yet.')
 await services.getByRole('button',{name:'Add starter services'}).click()
 await expect(services.locator('.svc-list > li')).toHaveCount(11)
 await services.getByRole('button',{name:'Add service'}).click()
 const form=page.getByRole('dialog',{name:'Add a service'})
 await form.getByLabel('Name *').fill('Dental website care');await form.getByLabel('Performance').check();await form.getByLabel(/Best for/).fill('dental')
 await form.getByLabel(/Internal notes/).fill('Margin 40%');await form.getByRole('button',{name:'Save service'}).click()
 await expect(services.locator('.svc-list > li',{hasText:'Dental website care'})).toContainText('Internal: Margin 40%')
 // A lead without a website explains what’s missing.
 let report=await openReport(page,'Rae Lin')
 await expect(report).toContainText('Add a website to analyze this business')
 await report.getByRole('button',{name:'Close dialog'}).click();await page.getByRole('button',{name:'Close dialog'}).click()
 // Start: available tools are listed, then the analysis runs to completion while the report is open.
 report=await openReport(page,'Avery Stone')
 await expect(report.getByRole('heading',{name:'Analyze Harbor Dental’s website'})).toBeVisible()
 await expect(report.getByRole('list',{name:'Available analysis tools'})).toContainText('PageSpeed Insights')
 await expect(report.getByRole('list',{name:'Available analysis tools'})).not.toContainText('not set up')
 await report.getByRole('button',{name:'Analyze business'}).click()
 await expect(report.locator('.br-state')).toHaveText('Completed',{timeout:60000})
 await expect(report.getByRole('status')).toContainText('Analysis complete.')
 // Overview: measured scores, a labelled AI summary, detected technology, top opportunities.
 await expect(report.locator('.br-metrics')).toContainText('Mobile performance42')
 await expect(report.locator('.br-metrics')).toContainText('Desktop performance81')
 await expect(report).toContainText('A family dental practice in Austin')
 await expect(report.locator('.br-chips')).toContainText('WordPress')
 // Findings: grouped, typed, with confidence, evidence links and a verification control.
 await report.getByRole('tab',{name:/Findings/}).click()
 const description=report.locator('.br-finding',{hasText:'The homepage has no meta description'})
 await expect(description).toContainText('Observed');await expect(description).toContainText('Confidence: high')
 const booking=report.locator('.br-finding',{hasText:'No online booking option found'})
 await expect(booking).toContainText('Confidence: medium')
 await expect(report.locator('.br-finding',{hasText:'Patients may ask booking questions by phone'})).toContainText('Hypothesis')
 await description.locator('summary',{hasText:/^Evidence \(\d+\)$/}).click()
 await description.getByRole('button',{name:'E2',exact:true}).click()
 await expect(report.getByRole('tab',{name:/Evidence/})).toHaveAttribute('aria-selected','true')
 await expect(report.locator('.br-evidence details[open]')).toContainText('Meta description')
 await report.getByRole('tab',{name:/Findings/}).click()
 await description.getByLabel('Your check').selectOption('verified')
 await expect(description).toContainText('Verified by your team')
 await report.getByLabel('Filter by type').selectOption('measured')
 await expect(report.locator('.br-finding').first()).toContainText('Measured')
 // Opportunities: matched to the catalog; accepted with a note, and the choice is saved.
 await report.getByRole('tab',{name:/Opportunities/}).click()
 const speed=report.locator('.br-opportunity',{hasText:'Speed up the website'})
 await expect(speed).toContainText('Matches your service Dental website care')
 await speed.getByRole('button',{name:'Accept'}).click()
 await expect(speed.locator('.br-status')).toHaveText('Accepted')
 await speed.getByLabel('Notes').fill('Lead with the mobile score');await speed.getByLabel('Notes').blur()
 await expect.poll(async()=>(await db.query<{notes:string;status:string}>("select notes,status from leadflow_private.business_opportunities where opportunity_type='performance'")).rows[0]).toEqual({notes:'Lead with the mobile score',status:'accepted'})
 // Details: what each provider did and the usage it caused; no keys anywhere in the page.
 await report.getByRole('tab',{name:'Details'}).click()
 await expect(report.locator('.br-table').first()).toContainText('PageSpeed Insights')
 await expect(report.locator('.br-table').nth(1)).toContainText('gemini')
 expect(await page.content()).not.toContain('pagespeed-test')
 // Reanalysis: a recent report asks first, then a new report compares with the previous one.
 await report.getByRole('button',{name:'Analyze again'}).click()
 await expect(report.locator('.br-confirm')).toContainText('was analyzed')
 harness.state.sites['https://harbor-dental.example/old-page/']={status:200,body:'<html><title>Old</title></html>'}
 await report.getByRole('button',{name:'Analyze again anyway'}).click()
 await expect(report.getByLabel('Report history').locator('option')).toHaveCount(2)
 await expect(report.getByLabel('Report history').locator('option').first()).toHaveText(/^Latest · .* · Completed$/,{timeout:60000})
 await expect(report.locator('.br-state')).toHaveText('Completed')
 await expect(report).toContainText('Since the previous report')
 await expect(report.locator('.br-columns')).toContainText('✓ 1 broken internal link found')
 await report.getByLabel('Report history').selectOption({index:1})
 await report.getByRole('tab',{name:/Opportunities/}).click()
 await expect(report.locator('.br-opportunity',{hasText:'Speed up the website'}).locator('.br-status')).toHaveText('Accepted')
 expect(errors).toEqual([])
})

test('explains websites that can’t be analyzed and keeps working without optional providers',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 const harness=await start(page,{GEMINI_API_KEY:undefined,GOOGLE_PAGESPEED_API_KEY:undefined})
 harness.state.sites['https://harbor-dental.example/']={status:403,body:'<html><title>Just a moment...</title>cf-chl</html>'}
 const report=await openReport(page,'Avery Stone')
 await expect(report.getByRole('list',{name:'Available analysis tools'})).toContainText('PageSpeed Insights · not set up')
 await expect(report.getByRole('list',{name:'Available analysis tools'})).toContainText('AI interpretation · not set up')
 await report.getByRole('button',{name:'Analyze business'}).click()
 await expect(report.locator('.br-state')).toHaveText('Failed',{timeout:30000})
 await expect(report.locator('.br-failed')).toContainText('bot protection')
 // The site comes back: a retry completes with rule-based findings only.
 dentalSite(harness.state)
 await report.getByRole('button',{name:'Try again'}).click()
 await expect(report.locator('.br-state')).toHaveText('Completed',{timeout:60000})
 await expect(report).toContainText('Add a Gemini API key to get a written summary.')
 await expect(report.locator('.br-metrics')).toContainText('Not measured')
 await report.getByRole('tab',{name:'Details'}).click()
 await expect(report.locator('.br-table').first()).toContainText('Not set up')
 expect(errors).toEqual([])
})
