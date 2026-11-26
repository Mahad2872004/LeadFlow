import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { createAutomationHarness } from './support/automation'
import { apiOrigin, mockSupabase, signIn } from './support/supabase'
// M13 end to end: the Automation Center, a template turned into a draft, the visual builder, validation, dry run,
// publishing, a real run on the server side, history and run detail, retrying a failed run, AI drafting (simulated model)
// and the read-only view for members. Auth and HTTP are simulated; every RPC runs the real migration SQL in embedded
// PostgreSQL; the automation Edge Function runs its real handler.
const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com',password:'test-password'}
const member={id:'33333333-3333-4333-8333-333333333333',email:'member@example.com',password:'test-password'}
let db:PGlite
test.describe.configure({timeout:180000})
test.afterEach(async()=>{await db?.close()})
const as=async<T>(user:string,sql:string,params:unknown[]=[])=>db.transaction(async tx=>{
 await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",[user,JSON.stringify({sub:user,role:'authenticated'})]);await tx.exec('set local role authenticated')
 return (await tx.query<{r:T}>(sql,params)).rows[0]?.r})
const one=async(sql:string,params:unknown[]=[])=>Object.values((await db.query<Record<string,unknown>>(sql,params)).rows[0]??{})[0]
const lead=(id:string,fields:Record<string,unknown>={})=>({id,name:'Avery Stone',email:'',phone:'',company:'Harbor Dental',service:'Other',source:'Website',message:'',status:'New',
 createdAt:'2026-11-01T00:00:00.000Z',website:'https://harbor-dental.example/',industry:'Dental clinics',address:'',city:'Austin',region:'TX',postcode:'',country:'US',...fields})
const saveLeads=async(change:(leads:Record<string,unknown>[])=>Record<string,unknown>[])=>{
 const current=await as<{data:{leads:Record<string,unknown>[]};revision:number}>(owner.id,'select public.load_workspace_for($1) as r',[owner.id])
 await as(owner.id,'select public.save_workspace_for($1,$2,$3,$4) as r',[owner.id,JSON.stringify({...current.data,leads:change(current.data.leads)}),current.revision,crypto.randomUUID()])
}
/** What the scheduled worker does every minute. */
const runWorker=async()=>{for(let i=0;i<20;i++){if(!await one("select public.automation_advance(null,'{}'::jsonb)"))break}}

async function start(page:Page,{users=[owner],signInAs=owner}:{users?:typeof owner[];signInAs?:typeof owner}={}){
 db=await createDatabase(users.map(user=>user.id))
 for(const user of users)await db.query('update auth.users set email=$2 where id=$1',[user.id,user.email])
 await as(owner.id,'select public.load_workspace() as r')
 if(users.includes(member))await as(owner.id,"select public.set_workspace_member($1,$2,'member') as r",[owner.id,member.id])
 await saveLeads(()=>[lead('harbor')])
 const harness=createAutomationHarness(db)
 await mockSupabase(page,db,{users})
 await page.route(`${apiOrigin}/functions/v1/automation`,async route=>{
  const request=route.request()
  const response=await harness.automation(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}))
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
 await page.goto('/login');await signIn(page,signInAs.email)
 await expect(page.getByRole('heading',{level:1})).toBeVisible()
 await page.getByRole('button',{name:'Automations',exact:true}).click()
 await expect(page.getByRole('heading',{level:1,name:'Automations'})).toBeVisible()
 return {harness}
}
const tab=(page:Page,name:string)=>page.getByRole('tab',{name}).click()

test('turns a template into a draft, tests it, publishes it and follows a real run',async({page})=>{
 await start(page)
 await expect(page.getByRole('heading',{name:'Automate the repetitive work'})).toBeVisible()
 await tab(page,'Templates')
 const card=page.locator('.au-card').filter({hasText:'Qualified lead follow-up'})
 await expect(card).toContainText('Lead status changed')
 await card.getByRole('button',{name:'Use template'}).click()
 // The builder: trigger, steps and the server's validation.
 await expect(page.getByLabel('Workflow name')).toHaveValue('Qualified lead follow-up')
 await expect(page.locator('.au-node').filter({hasText:'Create follow-up'})).toBeVisible()
 await expect(page.getByText('Valid',{exact:true})).toBeVisible()
 await page.locator('.au-node-button').filter({hasText:'Create follow-up'}).click()
 const title=page.getByLabel('Task title *')
 await expect(title).toHaveValue('Follow up with {{trigger.lead.name}}')
 await title.fill('Call {{trigger.lead.name}} at ')
 await page.getByLabel('Insert a variable into Task title').selectOption({label:'Company'})
 await expect(title).toHaveValue('Call {{trigger.lead.name}} at {{trigger.lead.company}}')
 await expect(page.getByText('Unsaved changes')).toBeVisible()
 // Clearing the title is an issue the server reports on the step.
 await title.fill('')
 await expect(page.locator('.au-issues')).toContainText('Task title is required')
 await expect(page.locator('.au-node.invalid')).toHaveCount(1)
 await title.fill('Call {{trigger.lead.name}} at {{trigger.lead.company}}')
 await expect(page.getByText('Valid',{exact:true})).toBeVisible()
 // Dry run against a real lead, with a value changed: nothing is created.
 await page.getByRole('button',{name:'Test',exact:true}).click()
 const drawer=page.getByRole('dialog',{name:'Test workflow'})
 await expect(drawer.getByLabel('lead.status')).toBeVisible()
 await drawer.getByLabel('lead.status').fill('Qualified')
 await drawer.getByRole('button',{name:'Run dry test'}).click()
 await expect(drawer.locator('.au-trace')).toContainText('Call Avery Stone at Harbor Dental')
 await expect(drawer).toContainText('nothing was created')
 expect(await one('select count(*)::int from public.follow_up_tasks')).toBe(0)
 await drawer.getByRole('button',{name:'Close dialog'}).click()
 // Publish (saving first) makes it active.
 await page.getByRole('button',{name:'Publish',exact:true}).click()
 const publish=page.getByRole('dialog',{name:'Publish version 1'})
 await publish.getByLabel('Version note (optional)').fill('First version')
 await publish.getByRole('button',{name:'Publish and activate'}).click()
 await expect(page.locator('.au-builder-head .au-status')).toHaveText('Active')
 await expect(page.getByText('Published version 1')).toBeVisible()
 // A real event: the lead becomes Qualified; the worker runs the workflow on the server.
 await saveLeads(leads=>leads.map(item=>({...item,status:'Qualified'})))
 await runWorker()
 expect(await one("select notes from public.follow_up_tasks where id like 'auto-%'")).toBe('Call Avery Stone at Harbor Dental')
 await page.getByRole('button',{name:'Workflows'}).click()
 await tab(page,'Execution history')
 const row=page.getByRole('row').filter({hasText:'Qualified lead follow-up'})
 await expect(row).toContainText('Completed')
 await row.getByRole('button',{name:'View'}).click()
 const run=page.getByRole('dialog',{name:/Qualified lead follow-up · v1/})
 await expect(run.locator('.au-path-log li')).toHaveCount(2)
 await expect(run.locator('.au-path-log')).toContainText('Create follow-up')
 await run.getByText('Inputs and outputs').first().click()
 await expect(run.locator('.au-path-log')).toContainText('Call Avery Stone at Harbor Dental')
 await run.getByRole('button',{name:'Close dialog'}).click()
 await tab(page,'Overview')
 await expect(page.locator('.au-metrics')).toContainText('1 active')
 await tab(page,'My workflows')
 await expect(page.locator('.au-card').filter({hasText:'Qualified lead follow-up'})).toContainText('Active')
})

test('shows branch paths and drafts a workflow with AI without saving anything',async({page})=>{
 const {harness}=await start(page)
 await tab(page,'Templates')
 await page.locator('.au-card').filter({hasText:'Client feedback triage'}).getByRole('button',{name:'Use template'}).click()
 await expect(page.locator('.au-path-head').filter({hasText:'Design change'})).toBeVisible()
 await expect(page.locator('.au-path-head').filter({hasText:'Technical issue'})).toBeVisible()
 await expect(page.locator('.au-path-head').filter({hasText:'Otherwise'})).toBeVisible()
 await page.getByRole('button',{name:'Workflows'}).click()
 // The AI assistant proposes; the person reviews. Nothing is saved until they save.
 harness.ai.answer=()=>({name:'Analyze new leads',summary:'Starts a business report for each new lead with a website.',sideEffects:[],unsupported:['Sending emails to leads'],
  definitionJson:JSON.stringify({trigger:{type:'lead.created',config:{},filter:{match:'all',conditions:[{path:'trigger.lead.hasWebsite',op:'is_true'}]}},
   steps:[{id:'n1',type:'action',action:'analysis.start',label:'Analyze the website',inputs:{subject:'trigger.lead.id'}}]})})
 const before=Number(await one('select count(*) from leadflow_private.automation_workflows'))
 await page.getByRole('button',{name:'Describe with AI'}).click()
 const dialog=page.getByRole('dialog',{name:'Describe an automation'})
 await dialog.getByLabel('What should happen?').fill('When a new lead with a website arrives, analyze it and email the lead.')
 await dialog.getByRole('button',{name:'Draft workflow'}).click()
 await expect(dialog.locator('.au-draft')).toContainText('Analyze new leads')
 await expect(dialog.locator('.au-draft')).toContainText('Sending emails to leads')
 await expect(dialog.locator('.au-draft')).toContainText('Trigger: Lead created · 1 step')
 expect(Number(await one('select count(*) from leadflow_private.automation_workflows'))).toBe(before)
 await dialog.getByRole('button',{name:'Review in builder'}).click()
 await expect(page.getByLabel('Workflow name')).toHaveValue('Analyze new leads')
 await expect(page.locator('.au-node').filter({hasText:'Analyze the website'})).toBeVisible()
 expect(Number(await one('select count(*) from leadflow_private.automation_workflows'))).toBe(before)
})

test('members see workflows and history but cannot change them',async({page})=>{
 await start(page,{users:[owner,member],signInAs:member})
 await expect(page.getByRole('button',{name:'New workflow'})).toHaveCount(0)
 await tab(page,'Templates')
 await expect(page.locator('.au-card').first()).toBeVisible()
 await expect(page.getByRole('button',{name:'Use template'})).toHaveCount(0)
})

test('retries a failed run from the failed step after the record is fixed',async({page})=>{
 await start(page)
 const created=await as<{id:string}>(owner.id,'select public.automation_save_workflow($1,null,$2,$3,$4,null,$5) as r',[owner.id,'Analyze new leads','',JSON.stringify({trigger:{type:'lead.created',config:{},filter:null},steps:[
  {id:'n1',type:'action',action:'task.create',label:'Research task',inputs:{subject:'trigger.lead.id',title:'Research {{trigger.lead.name}}',due:{mode:'days',days:1}}},
  {id:'n2',type:'action',action:'analysis.start',label:'Start report',inputs:{subject:'trigger.lead.id'}}]}),crypto.randomUUID()])
 const detail=await as<{version:number}>(owner.id,'select public.automation_workflow_detail($1,$2) as r',[owner.id,created!.id])
 await as(owner.id,'select public.automation_publish($1,$2,$3,$4) as r',[owner.id,created!.id,detail!.version,''])
 await saveLeads(leads=>[...leads,lead('nosite',{name:'Nora Site',website:''})])
 await runWorker()
 await tab(page,'Failed executions')
 const row=page.getByRole('row').filter({hasText:'Analyze new leads'})
 await expect(row).toContainText('Failed')
 await expect(row).toContainText('Start report')
 await expect(row).toContainText('website')
 await row.getByRole('button',{name:'View'}).click()
 const run=page.getByRole('dialog',{name:/Analyze new leads/})
 await expect(run.locator('.au-path-log li').first()).toContainText('Completed')
 // Fix the lead, then retry: the run continues at the failed step; the task isn't created twice.
 await saveLeads(leads=>leads.map(item=>item.id==='nosite'?{...item,website:'https://nora.example/'}:item))
 await run.getByRole('button',{name:'Retry from failed step'}).click()
 await expect(run.locator('.au-run-head')).toContainText('Completed')
 expect(await one(`select count(*)::int from public.follow_up_tasks where "leadId"='nosite'`)).toBe(1)
 expect(await one("select count(*)::int from leadflow_private.business_analyses where lead_id='nosite'")).toBe(1)
})
