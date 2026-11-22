import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { createAnalysisHarness, dentalSite } from './support/analysis'
import { createOutreachHarness, studioSite } from './support/outreach'
import { apiOrigin, mockSupabase, signIn } from './support/supabase'
// The sales pipeline end to end: the real UI and the migration SQL in embedded PostgreSQL. The business report comes from
// the real analysis pipeline with simulated websites and AI; nothing leaves the machine and nothing is sent.
const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com',password:'test-password'}
let db:PGlite
test.describe.configure({timeout:240000})
test.afterEach(async()=>{await db?.close()})
const lead=(id:string,fields:Record<string,string>={})=>({id,name:'Avery Stone',email:'',phone:'',company:'Harbor Dental',service:'Not specified',source:'Lead discovery',message:'',status:'New',createdAt:'2026-11-01T00:00:00.000Z',
 website:'https://harbor-dental.example/',industry:'Dental clinics',address:'',city:'Austin',region:'TX',postcode:'',country:'US',...fields})
const asOwner=async(sql:string,params:unknown[]=[])=>db.transaction(async tx=>{
 await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",[owner.id,JSON.stringify({sub:owner.id,role:'authenticated'})]);await tx.exec('set local role authenticated')
 return (await tx.query<{r:unknown}>(sql,params)).rows[0]?.r})
const one=async(sql:string,params:unknown[]=[])=>Object.values((await db.query<Record<string,unknown>>(sql,params)).rows[0]??{})[0]
async function start(page:Page,{report=false}={}){
 db=await createDatabase([owner.id])
 await db.query('update auth.users set email=$2 where id=$1',[owner.id,owner.email])
 const current=await asOwner('select public.load_workspace() as r') as {data:{leads:unknown[]};revision:number}
 await asOwner('select public.save_workspace_for($1,$2,$3,$4) as r',[owner.id,JSON.stringify({...current.data,leads:[lead('harbor'),lead('studio',{name:'Rae Lin',company:'Brightpath Studio',website:'https://brightpath.example/',industry:'Marketing agencies'})]}),current.revision,crypto.randomUUID()])
 const analysis=createAnalysisHarness(db,{GEMINI_API_KEY:'gemini-test'}),outreach=createOutreachHarness(db,{GEMINI_API_KEY:'gemini-test'})
 for(const harness of [analysis,outreach]){dentalSite(harness.state);studioSite(harness.state)}
 if(report){
  // A finished business report for Harbor Dental, made by the real pipeline before the page opens.
  await asOwner('select public.install_starter_services($1) as r',[owner.id])
  const token=`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:owner.id,role:'authenticated'})).toString('base64url')}.sig`
  const started=await analysis.handler(new Request('https://functions.test/business-analysis',{method:'POST',headers:{Origin:'http://127.0.0.1:5175','Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({workspaceId:owner.id,action:'start',leadId:'harbor',requestId:crypto.randomUUID()})}))
  expect(started.status).toBe(200)
  for(let i=0;i<20;i++){await db.query('update leadflow_private.business_analyses set next_run_at=now() where step is not null');const response=await analysis.worker(new Request('https://worker.test',{method:'POST',headers:{'x-worker-secret':analysis.config.NOTIFICATION_WORKER_SECRET!}}));if(!(await response.json()).steps?.length)break}
  expect(await one("select count(*)::int from leadflow_private.business_opportunities where lead_id='harbor'")).toBeGreaterThan(0)
 }
 await mockSupabase(page,db,{users:[owner]})
 for(const [name,harness] of [['business-analysis',analysis.handler],['outreach',outreach.outreach]] as const)await page.route(`${apiOrigin}/functions/v1/${name}`,async route=>{
  const request=route.request()
  const response=await harness(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}))
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
 await page.goto('/login');await signIn(page,owner.email)
 await expect(page.getByRole('heading',{level:1})).toBeVisible()
}
const column=(page:Page,name:string)=>page.locator('.sp-column').filter({has:page.getByRole('heading',{name,exact:true})})
async function createDeal(page:Page,fields:{lead?:string;title:string;value?:string;probability?:string}){
 const form=page.getByRole('dialog',{name:'New deal'})
 if(fields.lead)await form.getByLabel('Lead *').selectOption({label:fields.lead})
 await form.getByLabel('Title').fill(fields.title)
 if(fields.value)await form.getByLabel('Value').fill(fields.value)
 if(fields.probability)await form.getByLabel('Probability %').fill(fields.probability)
 await form.getByRole('button',{name:'Create deal'}).click()
 const detail=page.locator('dialog#deal-detail')
 await expect(detail.getByRole('heading',{name:fields.title})).toBeVisible()
 return detail
}

test('runs deals through the pipeline: create, move, record, schedule, close, hand off and analyse',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 await start(page,{report:true})
 await page.getByRole('button',{name:'Sales pipeline',exact:true}).click()
 await expect(page.getByRole('heading',{name:'No deals yet'})).toBeVisible()

 // A deal from the pipeline, for the studio lead.
 await page.getByRole('button',{name:'Create your first deal'}).click()
 let detail=await createDeal(page,{lead:'Brightpath Studio · Rae Lin',title:'Content retainer',value:'1,200',probability:'40'})
 await expect(detail.locator('.sp-facts')).toContainText('$1,200')
 await expect(detail.locator('.sp-facts')).toContainText('40%')
 await detail.getByRole('button',{name:'Close dialog'}).click()
 const card=page.locator('.sp-card').filter({hasText:'Content retainer'})
 await expect(column(page,'New prospect').locator('.sp-card')).toHaveCount(1)
 await expect(page.locator('.sp-summary')).toContainText('$1.2K')
 await expect(page.locator('.sp-summary')).toContainText('$480')
 // Ten columns scroll inside the board; the page itself never scrolls sideways.
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true)
 expect(await page.locator('.sp-board').evaluate(board=>board.scrollWidth>board.clientWidth)).toBe(true)

 // Moving: the Move menu (keyboard and touch), then drag and drop. Each move is saved with a history entry.
 await card.getByLabel('Move Content retainer to').selectOption({label:'Move to Contacted'})
 await expect(column(page,'Contacted').locator('.sp-card')).toHaveCount(1)
 await expect.poll(()=>one("select count(*)::int from leadflow_private.deal_stage_history h join leadflow_private.deals d on d.id=h.deal_id where d.title='Content retainer'")).toBe(2)
 await card.dragTo(column(page,'Qualified').locator('.sp-column-list'))
 await expect(column(page,'Qualified').locator('.sp-card')).toHaveCount(1)
 await expect.poll(()=>one("select s.name from leadflow_private.deals d join leadflow_private.sales_stages s on s.id=d.stage_id where d.title='Content retainer'")).toBe('Qualified')

 // A deal from a business report opportunity keeps the link; a second one for the same opportunity is pointed out.
 await page.getByRole('button',{name:'Leads',exact:true}).click()
 await page.getByLabel('View Avery Stone').first().click()
 await page.getByRole('button',{name:'Business report',exact:true}).click()
 const report=page.locator('dialog#business-report')
 await report.getByRole('tab',{name:/^Opportunities/}).click()
 const opportunity=report.locator('.br-opportunity').first(),opportunityTitle=(await opportunity.locator('h4').textContent())!
 await opportunity.getByRole('button',{name:'Create deal'}).click()
 const form=page.getByRole('dialog',{name:'New deal'})
 await expect(form.getByLabel('Opportunity from the business report')).toHaveValue(/[0-9a-f-]{36}/)
 await expect(form.getByLabel('Lead *')).toBeDisabled()
 await form.getByLabel('Value').fill('4500')
 await form.getByRole('button',{name:'Create deal'}).click()
 detail=page.locator('dialog#deal-detail')
 await expect(detail.getByRole('heading',{name:opportunityTitle})).toBeVisible()
 await expect(detail.locator('.sp-card-block').filter({has:page.getByRole('heading',{name:'Opportunity',exact:true})})).toContainText('From the business report')
 await detail.getByRole('button',{name:'Close dialog'}).click()
 await page.getByLabel('View Avery Stone').first().click()
 await expect(page.locator('.sp-lead-deals')).toContainText(opportunityTitle)
 await page.locator('.sp-lead-deals').getByRole('button',{name:'New deal'}).click()
 const choices=form.getByLabel('Opportunity from the business report')
 await expect(choices.locator('option')).not.toHaveCount(1)
 await choices.selectOption({label:(await choices.locator('option').allTextContents()).find(text=>text.startsWith(opportunityTitle))!})
 await form.getByRole('button',{name:'Create deal'}).click()
 await expect(form.getByRole('alert')).toContainText('already has an open deal')
 await form.getByRole('button',{name:'Open existing deal'}).click()
 detail=page.locator('dialog#deal-detail')
 await expect(detail.getByRole('heading',{name:opportunityTitle})).toBeVisible()
 expect(await one("select count(*)::int from leadflow_private.deals where lead_id='harbor'")).toBe(1)

 // Recording a reply suggests the Replied stage; nothing moves until it's confirmed.
 await detail.getByRole('tab',{name:'Timeline'}).click()
 await detail.getByRole('button',{name:'Record a reply'}).click()
 await detail.getByLabel('Details').fill('Asked for pricing and a call next week')
 await detail.getByRole('button',{name:'Save reply'}).click()
 await expect(detail.locator('.sp-composer .sp-notice')).toHaveText('Reply recorded.')
 await expect(detail.locator('.sp-events')).toContainText('Positive reply recorded via Email')
 await expect(detail.locator('.sp-suggest')).toContainText('Move to Replied?')
 expect(await one("select s.name from leadflow_private.deals d join leadflow_private.sales_stages s on s.id=d.stage_id where d.lead_id='harbor'")).toBe('New prospect')
 await detail.locator('.sp-suggest').getByRole('button',{name:'Move to Replied'}).click()
 await expect(detail.locator('.sp-detail-who .sp-stage')).toHaveText('Replied')
 await detail.getByRole('button',{name:'Log a call'}).click()
 await detail.getByLabel('Outcome').selectOption('callback_requested')
 await detail.getByLabel('Next action').fill('Call back on Tuesday')
 await detail.getByRole('button',{name:'Save call'}).click()
 await expect(detail.locator('.sp-events')).toContainText('Call logged · callback requested')
 await detail.getByRole('button',{name:'Stage changes'}).click()
 await detail.getByRole('button',{name:'Notes & calls'}).click()

 // A follow-up and a meeting on the deal. The follow-up is the same task the Follow-ups page shows.
 await detail.getByRole('tab',{name:/^Follow-ups & meetings/}).click()
 await detail.getByRole('button',{name:'Add follow-up'}).click()
 await detail.getByLabel('Type').selectOption('proposal')
 await detail.getByLabel('Priority').selectOption('high')
 await detail.getByLabel('Notes *').fill('Send the SEO proposal')
 await detail.getByRole('button',{name:'Schedule follow-up'}).click()
 await expect(detail.locator('.sp-tasks')).toContainText('Send the SEO proposal')
 await expect(detail.locator('.sp-tasks')).toContainText('Prepare a proposal · High priority')
 await detail.getByRole('button',{name:'Schedule meeting'}).click()
 const tomorrow=new Date(Date.now()+26*3600_000),local=`${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}T10:30`
 await detail.getByLabel('Starts *').fill(local)
 await detail.getByLabel('Meeting link').fill('https://meet.example/harbor')
 await detail.locator('.sp-subform').getByRole('button',{name:'Schedule meeting'}).click()
 await expect(detail.locator('.sp-meetings')).toContainText('Call with')
 await expect(detail.locator('.sp-suggest')).toContainText('Move to Meeting scheduled?')
 await detail.locator('.sp-suggest').getByRole('button',{name:'Move to Meeting scheduled'}).click()
 await expect(detail.locator('.sp-detail-head .sp-stage').first()).toHaveText('Meeting scheduled')

 // Won: the final value is confirmed; the handoff is a separate, single, explicit step.
 await detail.getByRole('tab',{name:'Overview'}).click()
 await detail.getByRole('button',{name:'Mark as won'}).click()
 const won=page.getByRole('dialog',{name:/^Mark “.*” as won$/})
 await expect(won.getByLabel(/^Final value/)).toHaveValue('4500')
 await won.getByLabel(/^Final value/).fill('4800')
 await won.getByRole('button',{name:'Mark as won'}).click()
 await expect(detail.locator('.sp-detail-head .sp-stage').first()).toHaveText('Won')
 await expect(detail.locator('.sp-facts')).toContainText('$4,800')
 expect(await one('select count(*)::int from leadflow_private.client_handoffs')).toBe(0)
 await detail.getByRole('button',{name:'Hand off to client work…'}).click()
 await detail.getByLabel('Note for the delivery team').fill('Kick-off in January')
 await detail.getByRole('button',{name:'Confirm handoff'}).click()
 await expect(detail.locator('.sp-handoff')).toContainText('Handed off to client work')
 expect(await one('select count(*)::int from leadflow_private.client_handoffs')).toBe(1)
 await expect(detail.getByRole('button',{name:'Reopen deal'})).toHaveCount(0)
 await detail.getByRole('button',{name:'Start client onboarding'}).click()
 await expect(page.getByRole('heading',{level:1,name:'Client onboarding'})).toBeVisible()
 const onboarding=page.getByRole('dialog',{name:'New client onboarding'})
 await expect(onboarding.getByLabel('Client name *')).toHaveValue('Harbor Dental')
 await onboarding.getByRole('button',{name:'Close dialog'}).click()

 // Lost from the board: a reason from the list is required.
 await page.getByRole('button',{name:'Sales pipeline',exact:true}).click()
 await card.getByLabel('Move Content retainer to').selectOption({label:'Mark as Lost…'})
 const lost=page.getByRole('dialog',{name:'Mark “Content retainer” as lost'})
 await expect(lost.getByRole('button',{name:'Mark as lost'})).toBeDisabled()
 await lost.getByLabel('Reason *').selectOption('Budget constraints')
 await lost.getByRole('button',{name:'Mark as lost'}).click()
 await expect(column(page,'Lost').locator('.sp-card')).toContainText(['Content retainer'])
 await expect(column(page,'Won').locator('.sp-column-head')).toContainText('$4.8K')

 // The list view: sorted by value, with stages and owners.
 await page.getByRole('button',{name:'List',exact:true}).click()
 await page.getByLabel('Filter by outcome').selectOption('all')
 await page.getByRole('button',{name:'Value',exact:true}).click()
 await expect(page.locator('.sp-table tbody tr').first()).toContainText(opportunityTitle)
 await expect(page.locator('.sp-table tbody tr')).toHaveCount(2)

 // Follow-ups: the deal's task, with its type and a link back to the deal.
 await page.getByRole('button',{name:/^Follow-ups/}).click()
 await page.getByLabel('Filter tasks').selectOption('Deals')
 const task=page.locator('.task').filter({hasText:'Send the SEO proposal'})
 await expect(task).toContainText('Prepare a proposal')
 await task.getByRole('button',{name:'Deal'}).click()
 await expect(page.locator('dialog#deal-detail').getByRole('heading',{name:opportunityTitle})).toBeVisible()
 await page.locator('dialog#deal-detail').getByRole('button',{name:'Close dialog'}).click()

 // Analytics: one won and one lost in the period, per currency, with the small-sample caution.
 await page.getByRole('button',{name:'Sales analytics',exact:true}).click()
 const figures=page.locator('.sp-summary')
 await expect(figures).toContainText('50%')
 await expect(figures).toContainText('1 won of 2 closed (won + lost)')
 await expect(figures).toContainText('$4.8K')
 await expect(page.locator('.sp-caution')).toContainText('Only 2 deals closed in this period')
 await expect(page.locator('.sp-bars').filter({hasText:'Budget constraints'})).toBeVisible()
 await page.getByLabel('Period').selectOption('custom')
 await page.getByLabel('From',{exact:true}).fill('2020-01-01');await page.getByLabel('To',{exact:true}).fill('2020-01-31')
 await expect(figures).toContainText('No deals closed in this period')
 expect(errors).toEqual([])
})

test('a failed move is undone, outreach suggests a stage only on request, and stages are configurable',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 await start(page)
 // Outreach marked as sent offers a deal, then a stage, and changes nothing until asked.
 await db.query(`insert into leadflow_private.outreach_drafts(id,workspace_id,lead_id,channel,angle,status,subject,body) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,'studio','email','opportunity','ready','A quick idea','Hello Rae')`,[owner.id])
 await db.query(`insert into leadflow_private.outreach_draft_versions(draft_id,workspace_id,version,origin,subject,body,angle) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,1,'generated','A quick idea','Hello Rae','opportunity')`,[owner.id])
 await page.getByRole('button',{name:'Leads',exact:true}).click()
 await page.getByLabel('View Rae Lin').first().click()
 await page.getByRole('button',{name:'Outreach',exact:true}).click()
 const dialog=page.locator('dialog#business-report'),editor=dialog.locator('.ow-editor')
 await editor.getByRole('button',{name:'Mark as sent…'}).click()
 await editor.getByRole('button',{name:'I sent it: mark as sent'}).click()
 await expect(dialog.locator('.sp-suggest')).toContainText('Track this conversation as a deal?')
 await dialog.locator('.sp-suggest').getByRole('button',{name:'Create deal'}).click()
 let detail=await createDeal(page,{title:'Studio website'})
 await expect(detail.locator('.sp-detail-head .sp-stage')).toHaveText('New prospect')
 expect(await one("select source||':'||(source_draft_id is not null)::text from leadflow_private.deals where title='Studio website'")).toBe('outreach:true')
 await detail.getByRole('tab',{name:'Outreach'}).click()
 await expect(detail.locator('.sp-drafts')).toContainText('Started this deal')
 await detail.getByRole('button',{name:'Open outreach studio'}).click()
 await editor.getByRole('button',{name:'They replied'}).click()
 await expect(dialog.locator('.sp-suggest')).toContainText('Studio website')
 await dialog.locator('.sp-suggest').getByRole('button',{name:'Move to Replied'}).click()
 await expect(dialog.locator('.sp-suggest')).toHaveCount(0)
 expect(await one("select s.name from leadflow_private.deals d join leadflow_private.sales_stages s on s.id=d.stage_id where d.title='Studio website'")).toBe('Replied')
 await dialog.getByRole('button',{name:'Close dialog'}).click()
 await page.keyboard.press('Escape')

 // A move that loses a race with another window is undone and explained.
 await page.getByRole('button',{name:'Sales pipeline',exact:true}).click()
 const card=page.locator('.sp-card').filter({hasText:'Studio website'})
 await expect(column(page,'Replied').locator('.sp-card')).toHaveCount(1)
 await db.query("update leadflow_private.deals set version=version+1 where title='Studio website'")
 await card.getByLabel('Move Studio website to').selectOption({label:'Move to Interested'})
 await expect(page.locator('.sp-panel .sp-error')).toContainText('changed in another window')
 await expect(column(page,'Replied').locator('.sp-card')).toHaveCount(1)
 await expect(column(page,'Interested').locator('.sp-card')).toHaveCount(0)
 await card.getByLabel('Move Studio website to').selectOption({label:'Move to Interested'})
 await expect(column(page,'Interested').locator('.sp-card')).toHaveCount(1)

 // Pipeline settings: rename, add, reorder and archive a stage with its deals moved to another.
 await page.getByRole('button',{name:'Pipeline settings'}).click()
 const settings=page.getByRole('dialog',{name:'Pipeline settings'})
 await settings.getByLabel('Name of Qualified').fill('Qualified fit')
 await settings.locator('li').filter({has:page.getByLabel('Name of Qualified')}).getByRole('button',{name:'Save'}).click()
 await expect(settings.locator('.sp-notice')).toHaveText('Qualified fit saved.')
 await settings.getByLabel('New stage').fill('Discovery call')
 await settings.getByRole('button',{name:'Add stage'}).click()
 await expect(settings.locator('.sp-notice')).toHaveText('Discovery call added.')
 await settings.getByRole('button',{name:'Move Discovery call up'}).click()
 await expect(settings.locator('.sp-notice')).toHaveText('Stage order saved.')
 await settings.locator('li').filter({has:page.getByLabel('Name of Interested')}).getByRole('button',{name:'Archive'}).click()
 await expect(settings.getByRole('button',{name:'Archive stage'})).toBeDisabled()
 await settings.getByLabel('Move deals to').selectOption({label:'Discovery call'})
 await settings.getByRole('button',{name:'Archive stage'}).click()
 await expect(settings.locator('.sp-notice')).toHaveText('Interested archived.')
 await expect(settings.locator('.sp-archived')).toContainText('Interested')
 await settings.getByRole('button',{name:'Close dialog'}).click()
 const headings=await page.locator('.sp-column-head h3').allTextContents()
 expect(headings).toEqual(['New prospect','Qualified fit','Contacted','Replied','Meeting scheduled','Proposal sent','Discovery call','Negotiation','Won','Lost'])
 await expect(column(page,'Discovery call').locator('.sp-card')).toHaveCount(1)
 await card.getByRole('button',{name:'Open deal Studio website'}).click()
 detail=page.locator('dialog#deal-detail')
 await expect(detail.locator('.sp-history')).toContainText('Interested → Discovery call')
 expect(errors).toEqual([])
})

test('the board works on a phone: columns scroll sideways and the Move menu replaces dragging',async({page})=>{
 await page.setViewportSize({width:390,height:844})
 await start(page)
 await asOwner("select public.create_deal($1,$2,$3,false) as r",[owner.id,JSON.stringify({leadId:'studio',title:'Phone deal',value:'900'}),crypto.randomUUID()])
 await page.getByRole('button',{name:'Sales pipeline',exact:true}).click()
 const card=page.locator('.sp-card').filter({hasText:'Phone deal'})
 await expect(card).toBeVisible()
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true)
 expect(await page.locator('.sp-board').evaluate(board=>board.scrollWidth>board.clientWidth)).toBe(true)
 await card.getByLabel('Move Phone deal to').selectOption({label:'Move to Qualified'})
 await expect(column(page,'Qualified').locator('.sp-card')).toHaveCount(1)
})
