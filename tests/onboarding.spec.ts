import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { createOnboardingHarness } from './support/onboarding'
import { createClientsHarness, filesRequest, memberToken, samples } from './support/clients'
import { apiOrigin, mockSupabase, signIn, type SupabaseMockOptions } from './support/supabase'
// Agency UI and client portal end to end. Auth and HTTP transport are simulated; every RPC runs the real
// migration SQL in embedded PostgreSQL, and the portal goes through the real client-portal Edge handler.
const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com',password:'test-password'}
const member={id:'33333333-3333-4333-8333-333333333333',email:'member@example.com',password:'test-password'}
let db:PGlite
// Each test is a long journey across two browser pages.
test.describe.configure({timeout:120000})
test.afterEach(async()=>{await db?.close()})
const portalBodies:Record<string,unknown>[]=[]
async function start(page:Page,options:SupabaseMockOptions={},users=[owner]){
 db=await createDatabase(users.map(user=>user.id))
 for(const user of users)await db.query('update auth.users set email=$2 where id=$1',[user.id,user.email])
 const supabase=await mockSupabase(page,db,{users,...options})
 await routePortal(page)
 return supabase
}
async function routePortal(page:Page){
 const harness=createOnboardingHarness(db)
 await page.route(`${apiOrigin}/functions/v1/client-portal`,async route=>{
  const request=route.request();if(request.method()==='POST')portalBodies.push(JSON.parse(request.postData()??'{}'))
  const response=await harness.portal(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}))
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
}
async function clientPage(context:BrowserContext,url:string){const page=await context.newPage();await routePortal(page);await page.goto(url);return page}
const sql=(text:string,params:unknown[]=[])=>db.query(text,params)
/** Owner-side setup through the real RPCs, as the given user. */
async function rpc<T>(user:string,text:string,params:unknown[]=[]){
 return db.transaction(async tx=>{await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",[user,JSON.stringify({sub:user,role:'authenticated'})]);await tx.exec('set local role authenticated');return (await tx.query<{result:T}>(text,params)).rows[0].result})
}
const noHorizontalScroll=(page:Page)=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)
const item=(page:Page,title:string)=>page.locator('.ob-item',{hasText:title})
const portalItem=(page:Page,title:string)=>page.getByRole('article',{name:title})
async function openOnboarding(page:Page){await page.getByRole('button',{name:'Onboarding',exact:true}).click();await expect(page.getByRole('heading',{name:'Client onboarding',level:1})).toBeVisible()}

test('agency builds a template, starts from a lead, collects, reviews and hands off; the client completes the portal',async({page,context},testInfo)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 await start(page)
 await page.goto('/login');await signIn(page,owner.email)
 // A lead to start from.
 await page.getByRole('button',{name:'Add your first lead'}).click()
 await page.getByLabel('Name *',{exact:true}).fill('Robin Vale');await page.getByLabel('Email (optional)').fill('robin@acme.example');await page.getByLabel('Company (optional)').fill('Acme Outdoor')
 await page.getByLabel('Service interest *').selectOption('Consulting');await page.getByLabel('Source *').selectOption('Referral');await page.getByRole('button',{name:'Create lead'}).click()
 await expect(page.getByLabel('Status for Robin Vale')).toBeVisible()
 // Empty state, then the starter templates and one custom template.
 await openOnboarding(page)
 await expect(page.getByRole('heading',{name:'Start your first client onboarding'})).toBeVisible()
 await page.getByRole('tab',{name:/^Templates/}).click();await page.getByRole('button',{name:'Add the starter templates'}).click()
 // Seven since M10: the M6A four plus website, digital marketing & SEO, and automation.
 await expect(page.getByText('7 starter templates added.')).toBeVisible()
 for(const name of ['Paid advertising onboarding','SEO onboarding','Social media management onboarding','Email marketing onboarding','Website design & development onboarding','Digital marketing & SEO onboarding','AI automation & custom software onboarding'])await expect(page.locator('.ob-template-head strong').filter({hasText:new RegExp(`^${name}$`)})).toBeVisible()
 await page.getByRole('button',{name:'New template'}).click()
 const editor=page.getByRole('dialog',{name:'New template'})
 await editor.getByLabel('Template name *').fill('Launch essentials')
 await editor.getByLabel('Item title *').fill('Business goals')
 await editor.getByRole('button',{name:'Add item'}).click();await editor.getByLabel('Item title *').nth(1).fill('Brand assets');await editor.getByLabel('Response type').nth(1).selectOption('links')
 await editor.getByRole('button',{name:'Add item'}).click();await editor.getByLabel('Item title *').nth(2).fill('Google Ads access');await editor.getByLabel('Response type').nth(2).selectOption('access')
 await expect(editor.getByText('Never ask for passwords, API keys or recovery codes',{exact:false})).toBeVisible()
 await editor.getByRole('button',{name:'Add item'}).click();await editor.getByLabel('Item title *').nth(3).fill('Past reports');await editor.getByLabel('Response type').nth(3).selectOption('links');await editor.getByLabel('Required for readiness').nth(3).uncheck()
 await editor.getByRole('button',{name:'Save template'}).click()
 await expect(page.getByText('Launch essentials created.')).toBeVisible()
 // Start from the lead: the form is prefilled and the lead is linked.
 await page.getByRole('button',{name:'Leads',exact:true}).click();await page.getByLabel('View Robin Vale').click();await page.getByRole('button',{name:'Start client onboarding'}).click()
 const create=page.getByRole('dialog',{name:'New client onboarding'})
 await expect(create.getByLabel('Client name *')).toHaveValue('Acme Outdoor');await expect(create.getByLabel('Contact email (optional)')).toHaveValue('robin@acme.example')
 await create.getByLabel('Template').selectOption({label:'Launch essentials (4 items)'})
 await create.getByLabel('Client inputs due').fill('2026-11-30')
 await create.getByLabel('Instructions for the client (optional)').fill('Welcome aboard! These four things get your first campaign live.')
 await create.getByRole('button',{name:'Create onboarding'}).click()
 await expect(page.getByRole('heading',{name:'Acme Outdoor onboarding',level:2})).toBeVisible()
 await expect(page.locator('.ob-readiness .ob-badge')).toHaveText('Not open yet');await expect(page.locator('.ob-item')).toHaveCount(4)
 await expect(page.getByText('Copied from “Launch essentials”',{exact:false})).toBeVisible()
 // Customise for this client only, including an agency-only note.
 await page.getByRole('button',{name:'Add item'}).click()
 const add=page.getByRole('dialog',{name:'Add checklist item'})
 await add.getByLabel('Item title *').fill('Preferred launch day');await add.getByLabel('Response type').selectOption('choice');await add.getByLabel('Options, one per line *').fill('Monday\nWednesday');await add.getByLabel('Required for readiness').uncheck()
 await add.getByRole('button',{name:'Add item'}).click();await expect(item(page,'Preferred launch day')).toBeVisible()
 await item(page,'Google Ads access').getByRole('button',{name:'Edit item'}).click()
 await page.getByRole('dialog',{name:'Edit checklist item'}).getByLabel('Internal note (agency only)').fill('INTERNAL-ONLY: use MCC 123');await page.getByRole('button',{name:'Save item'}).click()
 await expect(item(page,'Google Ads access')).toContainText('INTERNAL-ONLY')
 await page.getByRole('button',{name:'Open to client'}).click()
 await expect(page.locator('.ob-readiness .ob-badge')).toHaveText('Waiting on client')
 await expect(page.locator('.ob-blockers li')).toHaveCount(3,{timeout:5000})
 await page.getByRole('button',{name:'Create client link'}).click()
 const url=await page.getByLabel('Copy this link now').inputValue()
 expect(url).toMatch(/\/client-portal#lf_[0-9a-f]{64}$/)
 await page.screenshot({path:testInfo.outputPath('agency-request-desktop.png'),fullPage:true})
 // The client: only their checklist, no internal notes, progress saved and validated.
 const client=await clientPage(context,url)
 await expect(client.getByRole('heading',{name:'Acme Outdoor onboarding',level:1})).toBeVisible()
 await expect(client.getByText('Welcome aboard!')).toBeVisible();await expect(client.getByText('Please never share passwords',{exact:false})).toBeVisible()
 expect(await client.content()).not.toContain('INTERNAL-ONLY')
 expect(await client.evaluate(()=>[document.querySelector('meta[name="referrer"]')?.getAttribute('content'),document.querySelector('meta[name="robots"]')?.getAttribute('content')])).toEqual(['no-referrer','noindex,nofollow'])
 await expect(client.locator('.portal-next')).toContainText('Next step: Business goals')
 await portalItem(client,'Business goals').getByLabel('Your answer').fill('More bookings')
 await portalItem(client,'Business goals').getByRole('button',{name:'Save progress'}).click()
 await expect(portalItem(client,'Business goals').getByText('Progress saved.',{exact:false})).toBeVisible()
 await client.reload();await expect(portalItem(client,'Business goals').getByLabel('Your answer')).toHaveValue('More bookings')
 await portalItem(client,'Business goals').getByRole('button',{name:'Submit for review'}).click()
 await expect(portalItem(client,'Business goals').getByText('Waiting for review')).toBeVisible()
 await portalItem(client,'Brand assets').getByLabel('Link 1').fill('drive.example.com/brand');await portalItem(client,'Brand assets').getByRole('button',{name:'Submit for review'}).click()
 await expect(portalItem(client,'Brand assets').getByRole('alert')).toContainText('must start with https://')
 await portalItem(client,'Brand assets').getByLabel('Link 1').fill('https://drive.example.com/brand');await portalItem(client,'Brand assets').getByRole('button',{name:'Submit for review'}).click()
 await expect(portalItem(client,'Brand assets').getByText('Waiting for review')).toBeVisible()
 await portalItem(client,'Google Ads access').getByRole('button',{name:'Submit for review'}).click()
 await expect(portalItem(client,'Google Ads access').getByRole('alert')).toContainText('Confirm that you have granted access')
 await portalItem(client,'Google Ads access').getByLabel('I’ve granted access using the platform’s own sharing settings').check();await portalItem(client,'Google Ads access').getByRole('button',{name:'Submit for review'}).click()
 await expect(portalItem(client,'Google Ads access').getByText('Waiting for review')).toBeVisible()
 // The agency reviews: sends one item back, accepts the links and confirms access.
 await page.getByRole('button',{name:'Check for updates'}).click()
 await expect(page.locator('.ob-readiness .ob-badge')).toHaveText('Needs review')
 await expect(page.locator('.ob-blockers')).toContainText('Client reports access granted; the agency has not confirmed it')
 await expect(item(page,'Brand assets').getByRole('link',{name:'https://drive.example.com/brand'})).toHaveAttribute('rel','noopener noreferrer nofollow')
 await item(page,'Business goals').getByRole('button',{name:'Request changes'}).click()
 await page.getByLabel('Message to the client *').fill('Please add a monthly booking target.');await page.getByRole('button',{name:'Send back to client'}).click()
 await expect(item(page,'Business goals')).toContainText('Changes requested')
 await item(page,'Brand assets').getByRole('button',{name:'Accept'}).click();await expect(item(page,'Brand assets').locator('.ob-state')).toHaveText('Accepted')
 await item(page,'Google Ads access').getByRole('button',{name:'Confirm access works'}).click();await expect(item(page,'Google Ads access')).toContainText('Access confirmed by your team')
 await expect(page.locator('.ob-readiness .ob-badge')).toHaveText('Waiting on client')
 // The client sees the feedback, acceptance and resubmits.
 await client.reload()
 await expect(portalItem(client,'Business goals').getByText('Changes requested:')).toBeVisible();await expect(portalItem(client,'Business goals')).toContainText('Please add a monthly booking target.')
 await expect(portalItem(client,'Brand assets').getByText('Accepted')).toBeVisible();await expect(portalItem(client,'Brand assets').getByLabel('Link 1')).toBeDisabled()
 await portalItem(client,'Business goals').getByLabel('Your answer').fill('From 100 to 130 bookings per month');await portalItem(client,'Business goals').getByRole('button',{name:'Resubmit for review'}).click()
 await expect(portalItem(client,'Business goals').getByText('Waiting for review')).toBeVisible()
 await client.setViewportSize({width:390,height:844});expect(await noHorizontalScroll(client)).toBe(true)
 await client.screenshot({path:testInfo.outputPath('client-portal-mobile.png'),fullPage:true})
 // Ready once every required item is accepted; the optional items still open don't block.
 await page.getByRole('button',{name:'Check for updates'}).click();await item(page,'Business goals').getByRole('button',{name:'Accept'}).click()
 await expect(page.locator('.ob-readiness .ob-badge')).toHaveText('Ready for handoff')
 await expect(page.getByText('2 of 2 optional still open',{exact:false})).toBeVisible()
 await expect(page.locator('.ob-timeline')).toContainText('Every required item is resolved: ready for handoff')
 await page.getByRole('button',{name:'Confirm readiness and hand off'}).click()
 await page.getByLabel('Handoff note (optional)').fill('Kickoff booked');await page.getByRole('button',{name:'Confirm and hand off'}).click()
 await expect(page.locator('.ob-readiness .ob-badge')).toHaveText('Handed off');await expect(page.locator('.ob-handoff')).toContainText('Kickoff booked')
 await expect(page.getByRole('button',{name:'Add item'})).toHaveCount(0)
 await expect(page.locator('.ob-meta')).toContainText('Linked leadRobin Vale')
 expect((await sql('select count(*)::int as n from leadflow_private.onboarding_handoffs')).rows[0]).toEqual({n:1})
 await client.reload();await expect(client.getByText('You’re all set')).toBeVisible()
 // The list shows the handed-off request and filters work.
 await page.getByRole('button',{name:'← All onboarding requests'}).click()
 await expect(page.getByRole('button',{name:'Open Acme Outdoor onboarding for Acme Outdoor'})).toContainText('Handed off')
 await page.getByLabel('Filter by status').selectOption('waiting_on_client');await expect(page.getByText('No onboarding requests match these filters.')).toBeVisible()
 await page.getByRole('button',{name:'Clear filters'}).first().click();await expect(page.locator('.ob-row')).toHaveCount(1)
 // The portal never sends a workspace or request ID: only the token, the item and the response (and, since M10, file and scope references).
 for(const body of portalBodies)expect(Object.keys(body).every(key=>['action','token','itemId','value','submit','revision','fileName','size','fileId','scopeId'].includes(key))).toBe(true)
 expect(errors).toEqual([])
})

test('invalid, revoked, expired, paused and closed client links; mobile agency layout',async({page,context})=>{
 await start(page)
 const ws=owner.id
 await rpc(owner.id,'select public.install_starter_templates($1) as result',[ws])
 const template=(await sql("select id from leadflow_private.onboarding_templates where starter_key='seo'")).rows[0] as {id:string}
 const request=await rpc<string>(owner.id,'select public.create_onboarding_request($1,$2,$3) as result',[ws,JSON.stringify({title:'Northwind SEO',clientName:'Northwind',templateId:template.id}),crypto.randomUUID()])
 await rpc(owner.id,"select public.set_onboarding_status($1,$2,'activate',1,null) as result",[ws,request])
 const link=await rpc<{token:string;linkId:string}>(owner.id,'select public.issue_onboarding_link($1,$2,30,true) as result',[ws,request])
 const url=`/client-portal#${link.token}`
 // Incomplete and unknown links reveal nothing.
 const client=await clientPage(context,'/client-portal')
 await expect(client.getByRole('heading',{name:'This link isn’t working'})).toBeVisible();await expect(client.getByText('This link is incomplete.')).toBeVisible()
 await client.goto(`/client-portal#lf_${'0'.repeat(64)}`);await client.reload()
 await expect(client.getByRole('heading',{name:'This link isn’t working'})).toBeVisible();await expect(client.getByText('Northwind')).toHaveCount(0)
 // A working link, then pausing, revoking and expiry.
 await client.goto(url);await client.reload();await expect(client.getByRole('heading',{name:'Northwind SEO'})).toBeVisible()
 await rpc(owner.id,"select public.set_onboarding_status($1,$2,'pause',2,null) as result",[ws,request])
 await client.reload();await expect(client.getByText('This onboarding is paused')).toBeVisible()
 await expect(portalItem(client,'Business overview and goals').getByLabel('Your answer')).toBeDisabled()
 await expect(portalItem(client,'Business overview and goals').getByRole('button',{name:'Submit for review'})).toHaveCount(0)
 await rpc(owner.id,"select public.set_onboarding_status($1,$2,'resume',3,null) as result",[ws,request])
 // The agency revokes the link from the dashboard; it stops working at once.
 await page.goto('/login');await signIn(page,owner.email);await openOnboarding(page)
 await page.getByRole('button',{name:'Open Northwind SEO for Northwind'}).click()
 await page.locator('.ob-link-list').getByRole('button',{name:'Revoke'}).click();await expect(page.getByText('Link revoked. It stops working immediately.')).toBeVisible()
 await client.reload();await expect(client.getByRole('heading',{name:'This link isn’t working'})).toBeVisible()
 const second=await rpc<{token:string;linkId:string}>(owner.id,'select public.issue_onboarding_link($1,$2,1,true) as result',[ws,request])
 await client.goto(`/client-portal#${second.token}`);await client.reload();await expect(client.getByRole('heading',{name:'Northwind SEO'})).toBeVisible()
 await sql("update leadflow_private.onboarding_links set created_at=now()-interval '2 days', expires_at=now()-interval '1 second' where id=$1",[second.linkId])
 await client.reload();await expect(client.getByRole('heading',{name:'This link isn’t working'})).toBeVisible()
 // A cancelled request shows that it is closed, without its checklist.
 const third=await rpc<{token:string}>(owner.id,'select public.issue_onboarding_link($1,$2,30,true) as result',[ws,request])
 const version=(await sql('select version from leadflow_private.onboarding_requests where id=$1',[request])).rows[0] as {version:number}
 await rpc(owner.id,"select public.set_onboarding_status($1,$2,'cancel',$3,'Client paused the project') as result",[ws,request,version.version])
 await client.goto(`/client-portal#${third.token}`);await client.reload()
 await expect(client.getByText('This onboarding has been closed')).toBeVisible();await expect(client.locator('.portal-item')).toHaveCount(0)
 expect(await client.content()).not.toContain('Client paused the project')
 // The agency views fit a phone screen.
 await page.setViewportSize({width:390,height:844})
 await page.getByRole('button',{name:'Check for updates'}).click();await expect(page.locator('.ob-readiness .ob-badge')).toHaveText('Cancelled')
 expect(await noHorizontalScroll(page)).toBe(true)
 await page.getByRole('button',{name:'← All onboarding requests'}).click();await expect(page.locator('.ob-row')).toHaveCount(1)
 expect(await noHorizontalScroll(page)).toBe(true)
 for(const width of [700,1024]){await page.setViewportSize({width,height:900});expect(await noHorizontalScroll(page),`${width}px`).toBe(true)}
})

test('members, workspace isolation, lost responses and conflicts',async({page})=>{
 let loseCreate=true
 await start(page,{afterRpc:(name,reply)=>{if(name==='create_onboarding_request'&&loseCreate&&reply.status===200){loseCreate=false;return {status:0}}}},[owner,member])
 await rpc(owner.id,"select public.set_workspace_member($1,$2,'member') as result",[owner.id,member.id])
 await rpc(owner.id,'select public.install_starter_templates($1) as result',[owner.id])
 const team=await rpc<string>(owner.id,"select public.create_workspace('Second agency') as result")
 await rpc(owner.id,'select public.create_onboarding_request($1,$2,$3) as result',[team,JSON.stringify({title:'Other workspace project',clientName:'Hidden client'}),crypto.randomUUID()])
 // A member can use templates and create requests, but not edit templates or cancel.
 await page.goto('/login');await signIn(page,member.email);await openOnboarding(page)
 await page.getByRole('tab',{name:/^Templates/}).click()
 await expect(page.getByRole('button',{name:'New template'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Archive'})).toHaveCount(0)
 await page.locator('.ob-template',{hasText:'Email marketing onboarding'}).getByRole('button',{name:'View items'}).click()
 await expect(page.getByText('Only workspace owners and admins can change templates.')).toBeVisible();await expect(page.getByRole('button',{name:'Save template'})).toHaveCount(0)
 await page.getByRole('button',{name:'Close',exact:true}).click()
 await page.locator('.ob-template',{hasText:'Email marketing onboarding'}).getByRole('button',{name:'Use template'}).click()
 const create=page.getByRole('dialog',{name:'New client onboarding'})
 await create.getByLabel('Project name *').fill('Lost response project');await create.getByLabel('Client name *').fill('Retry client')
 await create.getByRole('button',{name:'Create onboarding'}).click()
 await expect(create.getByRole('alert')).toContainText('couldn’t reach LeadFlow')
 await create.getByRole('button',{name:'Create onboarding'}).click()
 await expect(page.getByRole('heading',{name:'Lost response project',level:2})).toBeVisible()
 expect((await sql("select count(*)::int as n from leadflow_private.onboarding_requests where title='Lost response project'")).rows[0]).toEqual({n:1})
 await expect(page.getByRole('button',{name:'Cancel onboarding'})).toHaveCount(0)
 // Someone else changes the request: the stale action is refused and the latest version is shown.
 await rpc(owner.id,'select public.update_onboarding_request($1,$2,$3,1) as result',[owner.id,(await sql("select id from leadflow_private.onboarding_requests where title='Lost response project'")).rows.map(row=>(row as {id:string}).id)[0],JSON.stringify({clientName:'Renamed by owner'})])
 await page.getByRole('button',{name:'Open to client'}).click()
 await expect(page.getByRole('alert')).toContainText('changed in another session');await expect(page.getByRole('alert')).toContainText('We’ve loaded the latest version.')
 await expect(page.locator('.ob-detail-head')).toContainText('Renamed by owner')
 await page.getByRole('button',{name:'Open to client'}).click();await expect(page.locator('.ob-readiness .ob-badge')).toHaveText('Waiting on client')
 // Only this workspace's requests are listed; the other workspace's request is never requested.
 await page.getByRole('button',{name:'← All onboarding requests'}).click()
 await expect(page.locator('.ob-row')).toHaveCount(1);await expect(page.getByText('Other workspace project')).toHaveCount(0)
 // The member is removed: the next load is refused.
 await rpc(owner.id,'select public.remove_workspace_member($1,$2) as result',[owner.id,member.id])
 await page.getByRole('button',{name:'Check for updates'}).click()
 await expect(page.getByText('You don’t have access to this workspace’s onboarding.')).toBeVisible()
})

/**
 * M10 with the client-files and client-portal handlers and the in-memory Storage of tests/support/clients.ts. The browser's
 * calls to Storage (signed upload and download URLs) are routed to that store.
 */
async function routeFiles(target:Page|BrowserContext,harness:ReturnType<typeof createClientsHarness>,functions:('client-portal'|'client-files')[]){
 for(const name of functions)await target.route(`${apiOrigin}/functions/v1/${name}`,async route=>{
  const request=route.request();if(name==='client-portal'&&request.method()==='POST')portalBodies.push(JSON.parse(request.postData()??'{}'))
  const handler=name==='client-portal'?harness.portal:harness.files
  const response=await handler(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}))
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
 await target.route(`${apiOrigin}/storage/v1/**`,async route=>{
  const request=route.request(),cors={'access-control-allow-origin':'*','access-control-allow-methods':'GET, PUT, POST','access-control-allow-headers':'content-type, x-upsert, apikey, authorization'}
  if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors})
  const url=new URL(request.url())
  // Opening a signed download link: the link was signed (and recorded) by the Edge Function; serve a stand-in file.
  if(request.method()==='GET'&&url.pathname.includes('/object/sign/'))return route.fulfill({status:200,headers:{...cors,'content-type':'application/octet-stream'},body:'file'})
  const response=await harness.runtime.fetch(`${harness.config.SUPABASE_URL}${url.pathname}${url.search}`,{method:request.method(),headers:request.headers(),body:request.postDataBuffer()??undefined})
  return route.fulfill({status:response.status,headers:{...Object.fromEntries(response.headers),...cors},body:Buffer.from(await response.arrayBuffer())})
 })
}

test('M10: stages, forms, internal steps, new field types, client uploads, history, requirements and the shared scope',async({page,context},testInfo)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 await start(page)
 const ws=owner.id,harness=createClientsHarness(db)
 await routeFiles(page,harness,['client-files'])
 await routeFiles(context,harness,[])
 const client=await rpc<{id:string}>(owner.id,'select public.create_client($1,$2,$3) as result',[ws,JSON.stringify({name:'Bluebird Bakery',contacts:[{fullName:'Ana Ruiz',email:'ana@bluebird.example',isPrimary:true}]}),crypto.randomUUID()])
 await rpc(owner.id,'select public.start_client_onboarding($1,$2,$3,$4) as result',[ws,client.id,JSON.stringify({title:'Bluebird onboarding'}),crypto.randomUUID()])
 await page.goto('/login');await signIn(page,owner.email);await openOnboarding(page)
 // Stages: the eight defaults, then one added, moved and archived.
 await page.getByRole('tab',{name:'Stages'}).click()
 await expect(page.locator('.ob-stage-row')).toHaveCount(8);await expect(page.locator('.ob-stage-row').first()).toContainText('Client created')
 await page.getByRole('button',{name:'Add stage'}).click()
 const stageDialog=page.getByRole('dialog',{name:'Add stage'})
 await stageDialog.getByLabel('Stage name *').fill('Legal review');await stageDialog.getByRole('button',{name:'Add stage'}).click()
 await expect(page.getByText('Legal review added.')).toBeVisible();await expect(page.locator('.ob-stage-row')).toHaveCount(9)
 await expect(page.locator('.ob-stage-row').nth(7)).toContainText('Legal review')
 await page.getByRole('button',{name:'Move Legal review up'}).click();await expect(page.locator('.ob-stage-row').nth(6)).toContainText('Legal review')
 await page.getByRole('button',{name:'Archive Legal review'}).click();await expect(page.getByRole('heading',{name:'Archived stages'})).toBeVisible()
 // Forms: a reusable form with a heading, a short answer, several choices and a file upload.
 await page.getByRole('tab',{name:'Forms'}).click();await page.getByRole('button',{name:'New form'}).first().click()
 const editor=page.getByRole('dialog',{name:'New form'}),field=(index:number)=>editor.locator('.ob-editor-items > li').nth(index)
 await editor.getByLabel('Form name *').fill('Brand questionnaire')
 await field(0).getByLabel('Response type').selectOption('heading');await field(0).getByLabel('Heading *').fill('About your brand')
 await expect(field(0).getByLabel('Required for readiness')).toHaveCount(0)
 await editor.getByRole('button',{name:'Add field'}).click();await field(1).getByLabel('Response type').selectOption('short_text');await field(1).getByLabel('Item title *').fill('Brand name')
 await editor.getByRole('button',{name:'Add field'}).click();await field(2).getByLabel('Response type').selectOption('multi_choice');await field(2).getByLabel('Item title *').fill('Brand tone')
 await field(2).getByLabel('Options, one per line *').fill('Friendly\nFormal\nPlayful')
 await editor.getByRole('button',{name:'Add field'}).click();await field(3).getByLabel('Response type').selectOption('file');await field(3).getByLabel('Item title *').fill('Logo files');await field(3).getByLabel('Files allowed').selectOption('2')
 // Asking for secrets is flagged while editing.
 await field(1).getByLabel('Guidance for the client').fill('Also send your admin password');await expect(field(1).getByText('Never ask for passwords or secrets',{exact:false})).toBeVisible()
 await field(1).getByLabel('Guidance for the client').fill('As it appears on your website')
 await editor.getByRole('button',{name:'Save form'}).click()
 await expect(page.getByText('Brand questionnaire created.')).toBeVisible();await expect(page.locator('.ob-form-card',{hasText:'Brand questionnaire'})).toContainText('3 (3 required)')
 // Templates: the website starter has file fields and six internal steps; saving keeps them and their settings.
 await page.getByRole('tab',{name:/^Templates/}).click();await page.getByRole('button',{name:'Add the starter templates'}).click()
 await expect(page.getByText('7 starter templates added.')).toBeVisible()
 await page.locator('.ob-template',{hasText:'Website design & development onboarding'}).getByRole('button',{name:'View and edit'}).click()
 const template=page.getByRole('dialog',{name:'Edit template'})
 await expect(template.getByLabel('Step title *')).toHaveCount(6);await expect(template.getByLabel('Step title *').first()).toHaveValue('Send the welcome message')
 await expect(template.getByLabel('Completes').first()).toHaveValue('welcome_sent')
 await template.getByRole('button',{name:'Add step'}).click();await template.getByLabel('Step title *').nth(6).fill('Book the kickoff call')
 await template.getByRole('button',{name:'Save template'}).click();await expect(page.getByText('Website design & development onboarding saved.',{exact:false})).toBeVisible()
 expect((await sql("select count(*)::int as n from leadflow_private.onboarding_template_steps s join leadflow_private.onboarding_templates t on t.id=s.template_id where t.starter_key='website'")).rows[0]).toEqual({n:7})
 expect((await sql("select i.config, i.stage_id is not null as staged from leadflow_private.onboarding_template_items i join leadflow_private.onboarding_templates t on t.id=i.template_id where t.starter_key='website' and i.title='Logo files'")).rows[0]).toEqual({config:{category:'logo',maxFiles:5},staged:true})
 // The client's onboarding: add the form in a stage, plus internal steps.
 await page.getByRole('tab',{name:/^Requests/}).click()
 await expect(page.getByRole('button',{name:'Open Bluebird onboarding for Bluebird Bakery'})).toContainText('Client record')
 await page.getByRole('button',{name:'Open Bluebird onboarding for Bluebird Bakery'}).click()
 await expect(page.locator('.ob-meta')).toContainText('Client recordBluebird Bakery')
 await page.locator('.ob-side').getByRole('button',{name:'Add a form'}).click()
 const assign=page.getByRole('dialog',{name:'Add a form to this checklist'})
 await expect(assign.getByRole('combobox',{name:'Form',exact:true})).toHaveValue(/.+/);await assign.getByRole('combobox',{name:'Stage'}).selectOption({label:'Business information'})
 await assign.getByRole('button',{name:'Add form'}).click()
 await expect(page.getByText('The form “Brand questionnaire” was added: 3 fields.')).toBeVisible()
 await expect(page.locator('.ob-item')).toHaveCount(3);await expect(page.locator('.ob-display')).toContainText('About your brand')
 await expect(item(page,'Brand name')).toContainText('Business information');await expect(item(page,'Brand name')).toContainText('Form: Brand questionnaire')
 await expect(page.locator('.ob-form-list')).toContainText('Brand questionnaire')
 await page.getByRole('button',{name:'Add step'}).click()
 let stepDialog=page.getByRole('dialog',{name:'Add internal step'})
 await stepDialog.getByLabel('Step title *').fill('Check the logo files');await stepDialog.getByRole('button',{name:'Add step'}).click()
 await expect(page.locator('.ob-step',{hasText:'Check the logo files'})).toBeVisible()
 await page.getByRole('button',{name:'Add step'}).click();stepDialog=page.getByRole('dialog',{name:'Add internal step'})
 await stepDialog.getByLabel('Step title *').fill('Send the welcome message');await stepDialog.getByLabel('Completes').selectOption('welcome_sent');await stepDialog.getByRole('button',{name:'Add step'}).click()
 const autoStep=page.locator('.ob-step',{hasText:'Send the welcome message'})
 await expect(autoStep).toContainText('Completes automatically');await expect(autoStep.getByRole('button',{name:'Mark done'})).toHaveCount(0)
 await page.getByRole('button',{name:'Open to client'}).click()
 await expect(page.locator('.ob-readiness .ob-badge')).toHaveText('Waiting on client');await expect(page.locator('.ob-blockers li')).toHaveCount(5)
 await page.getByRole('button',{name:'Create client link'}).click()
 const url=await page.getByLabel('Copy this link now').inputValue()
 // The client: a heading, new field types and an upload; never the internal steps.
 const portal=await context.newPage();await routeFiles(portal,harness,['client-portal']);await portal.goto(url)
 await expect(portal.getByRole('heading',{name:'About your brand',level:3})).toBeVisible()
 expect(await portal.content()).not.toContain('Check the logo files')
 await expect(portal.locator('.portal-counts')).toContainText('3 to do')
 await portalItem(portal,'Brand name').getByLabel('Your answer').fill('Bluebird');await portalItem(portal,'Brand name').getByRole('button',{name:'Submit for review'}).click()
 await expect(portalItem(portal,'Brand name').getByText('Waiting for review')).toBeVisible()
 await portalItem(portal,'Brand tone').getByRole('button',{name:'Submit for review'}).click();await expect(portalItem(portal,'Brand tone').getByRole('alert')).toContainText('Choose at least one option')
 await portalItem(portal,'Brand tone').getByLabel('Friendly').check();await portalItem(portal,'Brand tone').getByLabel('Playful').check();await portalItem(portal,'Brand tone').getByRole('button',{name:'Submit for review'}).click()
 await expect(portalItem(portal,'Brand tone').getByText('Waiting for review')).toBeVisible()
 await portalItem(portal,'Logo files').getByLabel('Choose files to upload',{exact:false}).setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from(samples.png)})
 await expect(portalItem(portal,'Logo files').getByText('1 file uploaded and checked.',{exact:false})).toBeVisible()
 await expect(portalItem(portal,'Logo files').locator('.portal-file-list')).toContainText('logo.png')
 // A file that isn't what its name says is refused by the content check.
 await portalItem(portal,'Logo files').getByLabel('Choose a file to upload',{exact:false}).setInputFiles({name:'fake.png',mimeType:'image/png',buffer:Buffer.from(samples.fakePng)})
 await expect(portalItem(portal,'Logo files').getByRole('alert')).toContainText('fake.png')
 await expect(portalItem(portal,'Logo files').locator('.portal-file-list li')).toHaveCount(1)
 await portalItem(portal,'Logo files').getByRole('button',{name:'Submit for review'}).click();await expect(portalItem(portal,'Logo files').getByText('Waiting for review')).toBeVisible()
 // The agency reviews: downloads the upload, checks the history, records a requirement and finishes a step.
 await page.getByRole('button',{name:'Check for updates'}).click()
 await expect(page.locator('.ob-readiness .ob-badge')).toHaveText('Needs review')
 await item(page,'Logo files').getByRole('button',{name:'Download logo.png'}).click()
 await expect.poll(()=>harness.state.downloads.length).toBe(1)
 await item(page,'Brand name').getByRole('button',{name:'Accept'}).click();await expect(item(page,'Brand name').locator('.ob-state')).toHaveText('Accepted')
 await item(page,'Brand name').getByRole('button',{name:'History of Brand name'}).click()
 const history=page.getByRole('dialog',{name:'Submissions: Brand name'})
 await expect(history).toContainText('Submission 1');await expect(history).toContainText('Accepted');await expect(history).toContainText('Bluebird')
 await history.getByRole('button',{name:'Close',exact:true}).click()
 await item(page,'Brand tone').getByRole('button',{name:'Create requirement'}).click()
 const requirement=page.getByRole('dialog',{name:'Create a requirement from this answer'})
 await expect(requirement.getByLabel('Description')).toHaveValue('Friendly, Playful');await requirement.getByLabel('Category').selectOption('design')
 await requirement.getByRole('button',{name:'Add requirement'}).click();await expect(page.getByText('Requirement “Brand tone” added to Bluebird Bakery as a draft.')).toBeVisible()
 expect((await sql('select title, category, source, status, source_item_id is not null as linked from leadflow_private.client_requirements')).rows).toEqual([{title:'Brand tone',category:'design',source:'client_form',status:'draft',linked:true}])
 await page.locator('.ob-step',{hasText:'Check the logo files'}).getByRole('button',{name:'Mark done'}).click()
 await expect(page.locator('.ob-step',{hasText:'Check the logo files'}).locator('.ob-state')).toHaveText('Done')
 await expect(page.locator('.ob-stage-strip')).toContainText('Business information')
 await page.screenshot({path:testInfo.outputPath('m10-agency-request.png'),fullPage:true})
 // The agency confirms a scope and shares a file; the client sees both and acknowledges the scope.
 await rpc(owner.id,'select public.save_client_service($1,$2,$3) as result',[ws,client.id,JSON.stringify({name:'Website design',agreedScope:'A five-page website',deliverables:'Design and build',exclusions:'Copywriting',status:'confirmed'})])
 await rpc(owner.id,'select public.confirm_client_scope($1,$2,$3) as result',[ws,client.id,JSON.stringify({outstandingQuestions:'Which launch date?',notes:'INTERNAL scope note',sharedWithClient:true})])
 const token=memberToken(owner.id)
 const prepared=await (await harness.files(filesRequest({workspaceId:ws,action:'upload',clientId:client.id,fileName:'welcome-pack.pdf',size:samples.pdf.length,category:'content',visibility:'shared'},token))).json() as {document:{id:string;mimeType:string};uploadUrl:string}
 expect((await harness.put(prepared.uploadUrl,samples.pdf,prepared.document.mimeType)).ok).toBe(true)
 expect((await harness.files(filesRequest({workspaceId:ws,action:'finish',documentId:prepared.document.id},token))).status).toBe(200)
 await portal.reload()
 await expect(portal.getByRole('heading',{name:/^Files from /})).toBeVisible();await expect(portal.locator('.portal-shared')).toContainText('welcome-pack.pdf')
 await portal.locator('.portal-shared').getByRole('button',{name:'Download welcome-pack.pdf'}).click();await expect.poll(()=>harness.state.downloads.length).toBe(2)
 const scope=portal.locator('.portal-scope')
 await expect(scope).toContainText('Website design');await expect(scope).toContainText('Copywriting');await expect(scope).toContainText('Which launch date?')
 await expect(scope).toContainText('not a signature, contract or legal acceptance');expect(await portal.content()).not.toContain('INTERNAL scope note')
 await scope.getByRole('button',{name:'I’ve read this scope'}).click();await expect(scope.getByText('You acknowledged this scope on',{exact:false})).toBeVisible()
 expect((await sql('select client_acknowledged_at is not null as acknowledged from leadflow_private.client_scope_confirmations')).rows).toEqual([{acknowledged:true}])
 await portal.setViewportSize({width:390,height:844});expect(await noHorizontalScroll(portal)).toBe(true)
 await portal.screenshot({path:testInfo.outputPath('m10-client-portal-mobile.png'),fullPage:true})
 await page.setViewportSize({width:390,height:844});expect(await noHorizontalScroll(page)).toBe(true)
 for(const body of portalBodies)expect(Object.keys(body).every(key=>['action','token','itemId','value','submit','revision','fileName','size','fileId','scopeId'].includes(key))).toBe(true)
 expect(errors).toEqual([])
})
