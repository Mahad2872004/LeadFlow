import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { createClientsHarness, samples } from './support/clients'
import { apiOrigin, mockSupabase, signIn } from './support/supabase'
// M10 end to end: converting a won deal into a client, the client workspace, documents through signed Storage URLs and
// completion. Auth and HTTP are simulated; every RPC runs the real migration SQL in embedded PostgreSQL, files go through
// the real client-files Edge handler, and Storage is the in-memory stand-in from tests/support/clients.ts.
const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com',password:'test-password'}
const member={id:'33333333-3333-4333-8333-333333333333',email:'member@example.com',password:'test-password'}
let db:PGlite
test.describe.configure({timeout:180000})
test.afterEach(async()=>{await db?.close()})
const lead=(id:string,fields:Record<string,string>={})=>({id,name:'Avery Stone',email:'avery@harbor-dental.example',phone:'',company:'Harbor Dental',service:'Not specified',source:'Lead discovery',message:'',status:'Qualified',createdAt:'2026-11-01T00:00:00.000Z',
 website:'https://harbor-dental.example/',industry:'Dental clinics',address:'',city:'Austin',region:'TX',postcode:'',country:'US',...fields})
const as=async<T>(user:string,sql:string,params:unknown[]=[])=>db.transaction(async tx=>{
 await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",[user,JSON.stringify({sub:user,role:'authenticated'})]);await tx.exec('set local role authenticated')
 return (await tx.query<{r:T}>(sql,params)).rows[0]?.r})
const one=async(sql:string,params:unknown[]=[])=>Object.values((await db.query<Record<string,unknown>>(sql,params)).rows[0]??{})[0]
const noHorizontalScroll=(page:Page)=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)

/** Owner's workspace with two leads, a lead contact, a catalog service, the starter templates and a won deal. */
async function start(page:Page,{users=[owner],signInAs=owner}:{users?:typeof owner[];signInAs?:typeof owner}={}){
 db=await createDatabase(users.map(user=>user.id))
 for(const user of users)await db.query('update auth.users set email=$2 where id=$1',[user.id,user.email])
 const current=await as<{data:{leads:unknown[]};revision:number}>(owner.id,'select public.load_workspace() as r')
 await as(owner.id,'select public.save_workspace_for($1,$2,$3,$4) as r',[owner.id,JSON.stringify({...current.data,leads:[lead('harbor'),lead('bakery',{name:'Sam Ortiz',company:'Quiet Bakery',website:'',industry:'Bakeries',email:''})]}),current.revision,crypto.randomUUID()])
 if(users.includes(member))await as(owner.id,"select public.set_workspace_member($1,$2,'member') as r",[owner.id,member.id])
 const dana=await one(`insert into leadflow_private.lead_contacts(workspace_id,lead_id,kind,full_name,job_title,email,origin) values ($1,'harbor','person','Dana Reyes','Practice manager','dana@harbor-dental.example','manual') returning id`,[owner.id])
 const web=await one(`insert into leadflow_private.agency_services(workspace_id,name,category) values ($1,'Website redesign','website') returning id`,[owner.id])
 await as(owner.id,'select public.install_starter_templates($1) as r',[owner.id])
 const deal=await as<{id:string;version:number}>(owner.id,'select public.create_deal($1,$2,$3,true) as r',[owner.id,JSON.stringify({leadId:'harbor',title:'Website redesign',value:'8000',currency:'USD',contactId:dana}),crypto.randomUUID()])
 // Deals get their service from a report opportunity; set it directly, as an opportunity would.
 await db.query('update leadflow_private.deals set service_id=$2, service_name=$3 where id=$1',[deal.id,web,'Website redesign'])
 await as(owner.id,'select public.close_deal($1,$2,$3,$4,$5,$6) as r',[owner.id,deal.id,'won',JSON.stringify({wonValue:'8500'}),deal.version,crypto.randomUUID()])
 const harness=createClientsHarness(db)
 await mockSupabase(page,db,{users})
 for(const name of ['client-files','client-portal'] as const)await page.route(`${apiOrigin}/functions/v1/${name}`,async route=>{
  const request=route.request()
  const handler=name==='client-files'?harness.files:harness.portal
  const response=await handler(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}))
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
 // The browser sends signed Storage requests to the app's Supabase origin; they reach the simulated Storage service.
 await page.route(`${apiOrigin}/storage/v1/**`,async route=>{
  const request=route.request(),url=new URL(request.url())
  // Supabase Storage answers the browser's CORS preflight for signed uploads.
  if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET, PUT, POST, OPTIONS','access-control-allow-headers':'*'}})
  const response=await harness.runtime.fetch(`${harness.config.SUPABASE_URL}${url.pathname}${url.search}`,{method:request.method(),headers:request.headers(),body:request.postDataBuffer()??undefined})
  return route.fulfill({status:response.status,headers:{'access-control-allow-origin':'*',...Object.fromEntries(response.headers)},body:Buffer.from(await response.arrayBuffer())})
 })
 await page.goto('/login');await signIn(page,signInAs.email)
 await expect(page.getByRole('heading',{level:1})).toBeVisible()
 return {harness,deal}
}
const openClients=async(page:Page)=>{await page.getByRole('button',{name:'Clients',exact:true}).click();await expect(page.getByRole('heading',{level:1,name:'Clients'})).toBeVisible()}
const tab=(page:Page,name:string)=>page.getByRole('tab',{name:new RegExp(`^${name}`)}).click()

test('converts a won deal into a client and runs onboarding to completion',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 const {harness}=await start(page)
 await openClients(page)
 await expect(page.getByRole('heading',{name:'No clients yet'})).toBeVisible()

 // New client → from a won deal → review: the lead, deal, contact, service and a recommended template carry over.
 await page.getByRole('button',{name:'New client'}).first().click()
 const create=page.getByRole('dialog',{name:'New client'})
 await expect(create.getByRole('button',{name:'From a won deal'})).toHaveAttribute('aria-pressed','true')
 await expect(create.getByLabel('Won deal')).toContainText('Website redesign · Harbor Dental')
 await create.getByRole('button',{name:'Review and convert…'}).click()
 const convert=page.getByRole('dialog',{name:'Convert to client'})
 await expect(convert.getByLabel('Client name *')).toHaveValue('Harbor Dental')
 await expect(convert.locator('.cl-review')).toContainText('$8,500')
 await expect(convert.getByLabel('Contact name')).toHaveValue('Dana Reyes')
 await expect(convert.getByLabel('Service *')).toHaveValue('Website redesign')
 await expect(convert.getByLabel('Start onboarding with')).toContainText('(recommended)')
 const recommended=await convert.getByLabel('Start onboarding with').evaluate(select=>(select as HTMLSelectElement).selectedOptions[0].text)
 expect(recommended).toMatch(/Website.*\(recommended\)/)
 await convert.getByRole('button',{name:'Convert to client'}).click()

 // The client opens on its new onboarding checklist. One client, one handoff, the deal untouched.
 await expect(page.locator('.cl-head').getByRole('heading',{level:2,name:'Harbor Dental'})).toBeVisible()
 await expect(page.getByRole('tab',{name:/^Onboarding/})).toHaveAttribute('aria-selected','true')
 expect(await one('select count(*)::int from leadflow_private.clients')).toBe(1)
 expect(await one('select count(*)::int from leadflow_private.client_handoffs')).toBe(1)
 expect(await one("select count(*)::int from leadflow_private.client_contacts where full_name='Dana Reyes' and is_primary")).toBe(1)
 expect(await one("select count(*)::int from leadflow_private.client_services where name='Website redesign' and status='confirmed'")).toBe(1)
 expect(await one("select count(*)::int from leadflow_private.onboarding_requests where client_id is not null and status='draft'")).toBe(1)
 expect(await one("select outcome from leadflow_private.deals")).toBe('won')

 // Overview: the welcome message is written here and marked sent once sent elsewhere; that completes its internal step.
 await tab(page,'Overview')
 const welcome=page.locator('.sp-card-block',{has:page.getByRole('heading',{name:'Welcome message'})})
 await expect(welcome.getByLabel('Subject')).toHaveValue(/Harbor Dental/)
 await expect(welcome.getByLabel('Message')).toHaveValue(/Hi Dana/)
 await expect(welcome).toContainText('LeadFlow doesn’t send it')
 await welcome.getByRole('button',{name:'Save draft'}).click()
 await expect(page.locator('.sp-notice').first()).toContainText('Welcome message saved')
 await welcome.getByRole('button',{name:'Mark as sent…'}).click()
 await welcome.getByLabel('Sent by').selectOption('email')
 await welcome.getByRole('button',{name:'Confirm it was sent'}).click()
 await expect(welcome).toContainText('Marked as sent by email')
 await expect(welcome).toContainText('delivery isn’t tracked')
 expect(await one("select count(*)::int from leadflow_private.onboarding_steps where auto_key='welcome_sent' and status='done' and done_by is null")).toBe(1)
 const checklist=page.locator('.cl-checklist')
 await expect(checklist.locator('li.is-met')).toContainText(['A primary contact','At least one confirmed service'])

 // Services & scope: a requirement, confirmed, then the scope confirmation (an internal record, not a contract).
 await tab(page,'Services & scope')
 await expect(page.locator('.cl-services')).toContainText('Website redesign')
 await page.getByRole('button',{name:'Add requirement'}).click()
 const requirement=page.getByRole('dialog',{name:'Add a requirement'})
 await requirement.getByLabel('Title *').fill('Online booking')
 await requirement.getByLabel('Status').selectOption('confirmed')
 await requirement.getByRole('button',{name:'Save requirement'}).click()
 await expect(page.locator('.cl-requirements')).toContainText('Online booking')
 await page.getByRole('button',{name:'Confirm scope…'}).click()
 const scope=page.getByRole('dialog',{name:'Confirm the scope'})
 await expect(scope).toContainText('not a contract, signature or legal acceptance')
 await scope.getByLabel('Outstanding questions').fill('Which booking provider?')
 await scope.getByRole('button',{name:'Confirm scope'}).click()
 await expect(page.locator('.sp-notice').first()).toContainText('Scope confirmed (version 1)')
 await expect(page.locator('.cl-scope-summary')).toContainText('Online booking')

 // Contacts: add one and make them primary.
 await tab(page,'Contacts')
 await page.getByRole('button',{name:'Add contact'}).click()
 const contact=page.getByRole('dialog',{name:'Add a contact'})
 await contact.getByLabel('Full name *').fill('Sam Lee');await contact.getByLabel('Email',{exact:true}).fill('sam@harbor-dental.example')
 await contact.getByLabel('Role').selectOption('billing');await contact.getByRole('button',{name:'Save contact'}).click()
 await expect(page.locator('.cl-contacts')).toContainText('Sam Lee')
 await page.locator('.cl-contacts li',{hasText:'Sam Lee'}).getByRole('button',{name:'Make primary'}).click()
 await expect(page.locator('.cl-contacts li',{hasText:'Sam Lee'})).toContainText('Primary')
 expect(await one("select full_name from leadflow_private.client_contacts where is_primary")).toBe('Sam Lee')

 // Documents: a real PDF uploads through a signed URL and passes the signature check; a script named .png is refused.
 await tab(page,'Documents')
 await expect(page.locator('.cl-upload')).toContainText('Up to 25 MB each')
 await page.getByLabel(/^Category/).selectOption('brand')
 await page.getByLabel('Files').setInputFiles({name:'brand-guide.pdf',mimeType:'application/pdf',buffer:Buffer.from(samples.pdf)})
 const row=page.locator('.cl-docs tr',{hasText:'brand-guide.pdf'})
 await expect(row).toContainText('Brand guidelines');await expect(row).toContainText('Team only')
 expect(harness.state.objects.size).toBe(1)
 expect(await one("select status from leadflow_private.client_documents where file_name='brand-guide.pdf'")).toBe('available')
 await page.getByLabel('Files').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from(samples.fakePng)})
 await expect(page.locator('.cl-uploads li.is-error')).toContainText('logo.png')
 expect(await one("select status from leadflow_private.client_documents where file_name='logo.png'")).toBe('rejected')
 expect(harness.state.objects.size,'the refused file is deleted from storage').toBe(1)
 const popup=page.context().waitForEvent('page')
 await row.getByRole('button',{name:'Download'}).click()
 await (await popup).close()
 expect(harness.state.downloads).toHaveLength(1)
 await row.getByRole('button',{name:'Edit'}).click()
 const edit=page.getByRole('dialog',{name:'Edit brand-guide.pdf'})
 await edit.getByLabel('Who can see it').selectOption('shared');await edit.getByRole('button',{name:'Save'}).click()
 await expect(row).toContainText('Shared with client')

 // Tasks: the standard onboarding tasks, in the same follow-up list as lead tasks.
 await tab(page,'Tasks')
 await page.getByRole('button',{name:'Plan standard tasks (5)'}).click()
 await expect(page.locator('.task-list .task')).toHaveCount(5)
 expect(await one('select count(*)::int from public.follow_up_tasks where "clientId" is not null and "leadId" is null')).toBe(5)
 // The box reflects the saved task, so it turns on once the save completes.
 await page.getByRole('checkbox',{name:'Complete Send the welcome message'}).click()
 await expect(page.getByRole('checkbox',{name:'Reopen Send the welcome message'})).toBeChecked()
 await expect(page.locator('.task.done')).toHaveCount(1)
 await page.getByRole('button',{name:'Follow-ups',exact:true}).click()
 await page.getByLabel('Filter tasks').selectOption('Clients')
 await expect(page.locator('.task-list .task')).toHaveCount(4)
 await page.locator('.task',{hasText:'Confirm the agreed scope'}).getByRole('button',{name:/Harbor Dental/}).click()
 await expect(page.locator('.cl-head').getByRole('heading',{level:2,name:'Harbor Dental'})).toBeVisible()
 await expect(page.getByRole('tab',{name:/^Tasks/})).toHaveAttribute('aria-selected','true')

 // Activity & notes: an internal note joins the client's history.
 await tab(page,'Activity')
 await page.getByLabel('Add an internal note').fill('Prefers calls after 3pm')
 await page.getByRole('button',{name:'Add note'}).click()
 await expect(page.locator('.cl-events .is-note')).toContainText('Prefers calls after 3pm')
 await expect(page.locator('.cl-events')).toContainText('Welcome message marked as sent')
 await expect(page.locator('.cl-events')).toContainText('File uploaded: brand-guide.pdf')

 // Completion: the checklist isn't open yet, so the owner completes it by exception, with a reason that is kept.
 await tab(page,'Overview')
 await expect(page.locator('.cl-checklist li:not(.is-met)')).toContainText(['Onboarding checklists complete'])
 await page.getByRole('button',{name:'Complete anyway…'}).click()
 await page.getByLabel('Reason *').fill('Kickoff agreed on a call; the checklist follows')
 await page.getByRole('button',{name:'Complete onboarding',exact:true}).click()
 await expect(page.getByRole('heading',{name:'Onboarding completed'})).toBeVisible()
 await expect(page.locator('.sp-caution').first()).toContainText('Kickoff agreed on a call')
 await tab(page,'Projects')
 await expect(page.getByText('Project delivery is the next milestone (M11)')).toBeVisible()
 await expect(page.locator('.cl-projects')).toContainText('Website redesign')

 // Archive (owners and admins): read-only, links revoked; unarchive restores the status it had.
 await page.getByRole('button',{name:'Archive…'}).click()
 await page.getByRole('dialog',{name:'Archive Harbor Dental?'}).getByRole('button',{name:'Archive client'}).click()
 await expect(page.locator('.sp-caution',{hasText:'This client is archived'})).toBeVisible()
 await tab(page,'Contacts');await expect(page.getByRole('button',{name:'Add contact'})).toHaveCount(0)
 await page.getByRole('button',{name:'Unarchive'}).click()
 await page.getByRole('dialog',{name:'Unarchive Harbor Dental?'}).getByRole('button',{name:'Unarchive client'}).click()
 await expect(page.locator('.sp-caution',{hasText:'This client is archived'})).toHaveCount(0)

 // The deal shows its client; converting again isn't offered.
 await page.locator('.cl-facts').getByRole('button',{name:'Website redesign'}).click()
 const detail=page.locator('dialog#deal-detail')
 await expect(detail.locator('.sp-handoff')).toContainText('Converted to the client Harbor Dental')
 await expect(detail.getByRole('button',{name:'Convert to client…'})).toHaveCount(0)
 await expect(detail.getByRole('button',{name:'Reopen deal'})).toHaveCount(0)
 await detail.getByRole('button',{name:'Open client'}).click()
 await expect(detail).toHaveCount(0)
 await expect(page.locator('.cl-head').getByRole('heading',{level:2,name:'Harbor Dental'})).toBeVisible()

 // Phone width: the workspace fits without sideways scrolling.
 await page.setViewportSize({width:390,height:844})
 expect(await noHorizontalScroll(page)).toBe(true)
 await page.setViewportSize({width:1280,height:900})

 // The directory and the dashboard count what the database recorded.
 await page.getByRole('button',{name:'All clients'}).click()
 const directory=page.locator('.cl-table tbody tr',{hasText:'Harbor Dental'})
 await expect(directory).toContainText('Onboarded');await expect(directory).toContainText('Sam Lee');await expect(directory).toContainText('Website redesign')
 await expect(page.getByRole('button',{name:/^Clients: 1\./})).toBeVisible()
 await page.setViewportSize({width:390,height:844})
 expect(await noHorizontalScroll(page)).toBe(true)
 await page.getByLabel('Search clients').fill('nothing like this')
 await expect(page.getByRole('heading',{name:'No clients match'})).toBeVisible()
 expect(errors).toEqual([])
})

test('members convert won deals but need an owner for exceptions, archiving and early completion',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 await start(page,{users:[owner,member],signInAs:member})
 // A deal that isn't won can't be converted by a member.
 const open=await as<{id:string}>(owner.id,'select public.create_deal($1,$2,$3,true) as r',[owner.id,JSON.stringify({leadId:'bakery',title:'Ordering site',value:'3000',currency:'USD'}),crypto.randomUUID()])
 await openClients(page)
 await page.getByRole('button',{name:'New client'}).first().click()
 await page.getByRole('dialog',{name:'New client'}).getByRole('button',{name:'Review and convert…'}).click()
 const convert=page.getByRole('dialog',{name:'Convert to client'})
 await convert.getByLabel('Start onboarding with').selectOption('')
 await convert.getByRole('button',{name:'Convert to client'}).click()
 await expect(page.locator('.cl-head').getByRole('heading',{level:2,name:'Harbor Dental'})).toBeVisible()
 // Members don't see archive or early completion.
 await expect(page.getByRole('button',{name:'Archive…'})).toHaveCount(0)
 await expect(page.getByRole('button',{name:'Complete anyway…'})).toHaveCount(0)
 await expect(page.locator('.cl-checklist').locator('..')).toContainText('An owner or admin can complete it anyway')
 // A client added by hand, linked to a lead; the lead's details fill in.
 await page.getByRole('button',{name:'All clients'}).click()
 await page.getByRole('button',{name:'New client'}).first().click()
 const create=page.getByRole('dialog',{name:'New client'})
 // With every won deal converted, the dialog starts on "Add by hand"; the deal tab says why.
 await expect(create.getByRole('button',{name:'Add by hand'})).toHaveAttribute('aria-pressed','true')
 await create.getByRole('button',{name:'From a won deal'}).click()
 await expect(create.getByText('Every won deal is already a client.')).toBeVisible()
 await create.getByRole('button',{name:'Add by hand'}).click()
 await create.getByLabel('From a lead (optional)').selectOption('bakery')
 await expect(create.getByLabel('Client name *')).toHaveValue('Quiet Bakery')
 await create.getByLabel('Service (optional)').fill('Ordering website')
 await create.getByRole('button',{name:'Add client'}).click()
 await expect(page.locator('.cl-head').getByRole('heading',{level:2,name:'Quiet Bakery'})).toBeVisible()
 expect(await one("select count(*)::int from leadflow_private.client_services s join leadflow_private.clients c on c.id=s.client_id where c.name='Quiet Bakery' and s.status='proposed'")).toBe(1)
 // The open deal can't be converted by a member: the database refuses even if the UI were bypassed.
 const refused=await as(member.id,'select public.convert_deal_to_client($1,$2,$3,$4) as r',[owner.id,open.id,JSON.stringify({name:'Quiet Bakery 2',contacts:[],services:[]}),crypto.randomUUID()]).catch((error:{code:string})=>error.code)
 expect(refused).toBe('42501')
 expect(await one('select count(*)::int from leadflow_private.clients')).toBe(2)
 expect(errors).toEqual([])
})
