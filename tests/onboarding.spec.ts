import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { createOnboardingHarness } from './support/onboarding'
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
 await page.getByLabel('Full name').fill('Robin Vale');await page.getByLabel('Email *',{exact:true}).fill('robin@acme.example');await page.getByLabel('Company (optional)').fill('Acme Outdoor')
 await page.getByLabel('Service interest *').selectOption('Consulting');await page.getByLabel('Source *').selectOption('Referral');await page.getByRole('button',{name:'Create lead'}).click()
 await expect(page.getByLabel('Status for Robin Vale')).toBeVisible()
 // Empty state, then the starter templates and one custom template.
 await openOnboarding(page)
 await expect(page.getByRole('heading',{name:'Start your first client onboarding'})).toBeVisible()
 await page.getByRole('tab',{name:/^Templates/}).click();await page.getByRole('button',{name:'Add the starter templates'}).click()
 await expect(page.getByText('4 starter templates added.')).toBeVisible()
 for(const name of ['Paid advertising onboarding','SEO onboarding','Social media management onboarding','Email marketing onboarding'])await expect(page.locator('.ob-template',{hasText:name})).toBeVisible()
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
 // The portal never sends a workspace or request ID: only the token, the item and the response.
 for(const body of portalBodies)expect(Object.keys(body).every(key=>['action','token','itemId','value','submit','revision'].includes(key))).toBe(true)
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
