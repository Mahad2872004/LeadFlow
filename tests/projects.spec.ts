import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { samples } from './support/clients'
import { createProjectsHarness } from './support/projects'
import { apiOrigin, mockSupabase, signIn } from './support/supabase'
// M11 end to end: a project from a completed onboarding, planning, the task board with dependencies, files, notes, the AI
// assistant (simulated model) and completion. Auth and HTTP are simulated; every RPC runs the real migration SQL in embedded
// PostgreSQL; files and the assistant go through their real Edge handlers; Storage is the in-memory stand-in.
const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com',password:'test-password'}
const member={id:'33333333-3333-4333-8333-333333333333',email:'member@example.com',password:'test-password'}
let db:PGlite
test.describe.configure({timeout:180000})
test.afterEach(async()=>{await db?.close()})
const as=async<T>(user:string,sql:string,params:unknown[]=[])=>db.transaction(async tx=>{
 await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",[user,JSON.stringify({sub:user,role:'authenticated'})]);await tx.exec('set local role authenticated')
 return (await tx.query<{r:T}>(sql,params)).rows[0]?.r})
const one=async(sql:string,params:unknown[]=[])=>Object.values((await db.query<Record<string,unknown>>(sql,params)).rows[0]??{})[0]
const noHorizontalScroll=(page:Page)=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)
const lead={id:'harbor',name:'Avery Stone',email:'',phone:'',company:'Harbor Dental',service:'Not specified',source:'Lead discovery',message:'',status:'Qualified',createdAt:'2026-11-01T00:00:00.000Z',
 website:'https://harbor-dental.example/',industry:'Dental clinics',address:'',city:'Austin',region:'TX',postcode:'',country:'US'}

/** A client whose onboarding was completed: confirmed services, requirements and scope, from a won deal. */
async function start(page:Page,{users=[owner],signInAs=owner}:{users?:typeof owner[];signInAs?:typeof owner}={}){
 db=await createDatabase(users.map(user=>user.id))
 for(const user of users)await db.query('update auth.users set email=$2 where id=$1',[user.id,user.email])
 const current=await as<{data:{leads:unknown[]};revision:number}>(owner.id,'select public.load_workspace() as r')
 await as(owner.id,'select public.save_workspace_for($1,$2,$3,$4) as r',[owner.id,JSON.stringify({...current.data,leads:[lead]}),current.revision,crypto.randomUUID()])
 if(users.includes(member))await as(owner.id,"select public.set_workspace_member($1,$2,'member') as r",[owner.id,member.id])
 const deal=await as<{id:string;version:number}>(owner.id,'select public.create_deal($1,$2,$3,true) as r',[owner.id,JSON.stringify({leadId:'harbor',title:'Website redesign',value:'8000',currency:'USD'}),crypto.randomUUID()])
 await as(owner.id,'select public.close_deal($1,$2,$3,$4,$5,$6) as r',[owner.id,deal.id,'won',JSON.stringify({wonValue:'8500'}),deal.version,crypto.randomUUID()])
 const client=(await as<{id:string}>(owner.id,'select public.convert_deal_to_client($1,$2,$3,$4) as r',[owner.id,deal.id,JSON.stringify({name:'Harbor Dental',
  contacts:[{fullName:'Dana Reyes',role:'project',email:'dana@harbor-dental.example',isPrimary:true}],
  services:[{name:'Website redesign',agreedScope:'Five pages and online booking',deliverables:'Homepage design\nBooking page',exclusions:'Copywriting'}]}),crypto.randomUUID()]))!.id
 for(const fields of [{title:'More online bookings',category:'objective'},{title:'Online booking form',category:'functional'},{title:'Client supplies photos',category:'dependency'}])
  await as(owner.id,'select public.save_client_requirement($1,$2,$3,null,$4) as r',[owner.id,client,JSON.stringify({status:'confirmed',source:'client_meeting',...fields}),crypto.randomUUID()])
 await as(owner.id,'select public.confirm_client_scope($1,$2,$3) as r',[owner.id,client,JSON.stringify({outstandingQuestions:'Which booking provider?',notes:'',sharedWithClient:false})])
 await as(owner.id,'select public.complete_client_onboarding($1,$2,$3,$4) as r',[owner.id,client,'Kickoff Monday','Kickoff agreed on a call'])
 const harness=createProjectsHarness(db)
 await mockSupabase(page,db,{users})
 for(const name of ['client-files','client-portal','project-assistant'] as const)await page.route(`${apiOrigin}/functions/v1/${name}`,async route=>{
  const request=route.request()
  const handler=name==='client-files'?harness.files:name==='client-portal'?harness.portal:harness.assistant
  const response=await handler(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}))
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
 await page.route(`${apiOrigin}/storage/v1/**`,async route=>{
  const request=route.request(),url=new URL(request.url())
  if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET, PUT, POST, OPTIONS','access-control-allow-headers':'*'}})
  const response=await harness.runtime.fetch(`${harness.config.SUPABASE_URL}${url.pathname}${url.search}`,{method:request.method(),headers:request.headers(),body:request.postDataBuffer()??undefined})
  return route.fulfill({status:response.status,headers:{'access-control-allow-origin':'*',...Object.fromEntries(response.headers)},body:Buffer.from(await response.arrayBuffer())})
 })
 await page.goto('/login');await signIn(page,signInAs.email)
 await expect(page.getByRole('heading',{level:1})).toBeVisible()
 return {harness,client}
}
const openProjects=async(page:Page)=>{await page.getByRole('button',{name:'Projects',exact:true}).click();await expect(page.getByRole('heading',{level:1,name:'Projects'})).toBeVisible()}
const tab=(page:Page,name:string)=>page.getByRole('tab',{name:new RegExp(`^${name}`)}).click()

test('creates a project from the completed onboarding, plans it, works it and completes it',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 const {harness}=await start(page)
 await openProjects(page)
 // New project: the setup starts from what was agreed at onboarding completion, confirmed items only.
 await page.getByRole('button',{name:'New project'}).first().click()
 const dialog=page.getByRole('dialog',{name:'New project'})
 await dialog.getByLabel('Client *').selectOption({label:'Harbor Dental'})
 await expect(dialog.getByRole('button',{name:'The completed onboarding'})).toHaveAttribute('aria-pressed','true')
 await expect(dialog.getByLabel('Objectives')).toHaveValue(/More online bookings/)
 await expect(dialog.getByLabel('Scope summary')).toHaveValue(/Five pages and online booking/)
 await expect(dialog.getByLabel('Dependencies')).toHaveValue(/Client supplies photos/)
 await expect(dialog.getByLabel('Notes and open questions')).toHaveValue(/Which booking provider/)
 await dialog.getByLabel('Project name *').fill('Website redesign')
 await dialog.getByLabel('Agreed value for this project').fill('6500')
 await dialog.getByLabel('Start from a template').selectOption({label:'Website design & development · 10 milestones'})
 await expect(dialog.locator('.pf-plan > li')).toHaveCount(10)
 await dialog.getByLabel('Include Handover').uncheck()
 await dialog.getByRole('button',{name:'Create project'}).click()
 await expect(page.locator('.pw-head').getByRole('heading',{level:2,name:'Website redesign'})).toBeVisible()
 expect(await one("select source from leadflow_private.projects")).toBe('onboarding')
 expect(await one('select count(*)::int from leadflow_private.project_milestones')).toBe(9)
 expect(await one('select count(*)::int from public.follow_up_tasks where "projectId" is not null')).toBe(21)
 await expect(page.locator('.pw-head')).toContainText('0%')
 await expect(page.locator('.pw-head')).toContainText('On track')

 // Tasks: the board moves a task; a new task waits for another; circular dependencies are prevented.
 await tab(page,'Tasks')
 await page.getByRole('group',{name:'Task view'}).getByRole('button',{name:'Board'}).click()
 await page.getByLabel('Move Hold the kickoff meeting to').selectOption('in_progress')
 await expect.poll(()=>one(`select status from public.follow_up_tasks where notes='Hold the kickoff meeting'`)).toBe('in_progress')
 await page.getByRole('button',{name:'Add task'}).click()
 let task=page.getByRole('dialog',{name:/task/i})
 await task.getByLabel('Task *').fill('Prepare the launch checklist')
 await task.getByLabel('Priority').selectOption('high')
 await task.getByRole('group',{name:'Waits for'}).getByLabel('Build the page templates').check()
 await task.getByRole('button',{name:'Add task'}).click()
 await expect(page.locator('.pw-card',{hasText:'Prepare the launch checklist'})).toContainText('Waiting for: Build the page templates')
 expect(await one(`select "dependsOn"->>0 from public.follow_up_tasks where notes='Prepare the launch checklist'`)).toBe(await one(`select id from public.follow_up_tasks where notes='Build the page templates'`))
 await page.locator('.pw-card',{hasText:'Build the page templates'}).getByRole('button',{name:'Build the page templates'}).click()
 task=page.getByRole('dialog',{name:/task/i})
 await expect(task.getByRole('group',{name:'Waits for'}).getByLabel(/Prepare the launch checklist/)).toBeDisabled()
 await task.getByRole('button',{name:'Cancel'}).click()
 await page.getByLabel('Move Hold the kickoff meeting to').selectOption('completed')
 await expect.poll(()=>one(`select completed from public.follow_up_tasks where notes='Hold the kickoff meeting'`)).toBe(true)

 // Milestones and deliverables: complete one, see deliverables by status.
 await tab(page,'Milestones')
 await page.locator('.pw-milestone,li',{hasText:'Discovery & requirements'}).first().getByRole('button',{name:'Mark complete'}).click()
 await expect.poll(()=>one(`select status from leadflow_private.project_milestones where name='Discovery & requirements'`)).toBe('completed')
 await tab(page,'Deliverables')
 await expect(page.getByText('Homepage design').first()).toBeVisible()

 // The AI assistant suggests; nothing changes until the member adds the selected suggestions.
 harness.ai.answer=()=>({milestones:[{ref:'m1',name:'Analytics setup',startDate:'2026-12-01',dueDate:'2026-12-10'}],deliverables:[{ref:'d1',milestoneRef:'m1',title:'Analytics dashboard'}],
  tasks:[{ref:'t1',milestoneRef:'m1',deliverableRef:'d1',title:'Install analytics',dueDate:'2026-12-05'}],notes:['Which analytics tool?']})
 const milestonesBefore=await one('select count(*)::int from leadflow_private.project_milestones')
 await page.getByRole('group',{name:'AI assistant'}).getByRole('button',{name:'Suggest a plan'}).click()
 const assistant=page.getByRole('dialog').filter({hasText:'AI suggestion'})
 await assistant.getByRole('button',{name:'Suggest'}).click()
 // Suggestions are editable before they're added.
 await expect(assistant.getByLabel('Milestone name')).toHaveValue('Analytics setup')
 await expect(assistant).toContainText('What this is based on')
 await expect(assistant).toContainText('Which analytics tool?')
 expect(await one('select count(*)::int from leadflow_private.project_milestones')).toBe(milestonesBefore)
 await assistant.getByRole('button',{name:'Add selected to the project'}).click()
 await expect.poll(()=>one(`select count(*)::int from leadflow_private.project_milestones where name='Analytics setup'`)).toBe(1)
 expect(await one(`select count(*)::int from public.follow_up_tasks where notes='Install analytics'`)).toBe(1)

 // Files: a PDF through the signed upload and checks; always internal.
 await tab(page,'Files')
 await page.locator('.pw-tab-body input[type=file]').setInputFiles({name:'sitemap.pdf',mimeType:'application/pdf',buffer:Buffer.from(samples.pdf)})
 await expect.poll(()=>one(`select status from leadflow_private.client_documents where file_name='sitemap.pdf'`)).toBe('available')
 await expect(page.locator('.pw-tab-body').getByRole('button',{name:/Download/}).first()).toBeVisible()
 expect(await one(`select visibility from leadflow_private.client_documents where file_name='sitemap.pdf' and project_id is not null`)).toBe('internal')
 expect(harness.state.objects.size).toBe(1)

 // Activity: an internal note joins the project history.
 await tab(page,'Activity')
 await page.getByLabel('Add an internal note').fill('Client prefers Tuesday calls')
 await page.getByRole('button',{name:'Add note'}).click()
 await expect(page.getByText('Client prefers Tuesday calls')).toBeVisible()

 // Timeline and phone width.
 await tab(page,'Timeline')
 await expect(page.locator('.pw-tab-body')).toContainText('Wireframes')
 await page.setViewportSize({width:390,height:844})
 expect(await noHorizontalScroll(page)).toBe(true)
 await page.setViewportSize({width:1280,height:900})

 // Completing with open work needs a reason, which is kept.
 await page.locator('.pw-head').getByLabel('Status').selectOption('completed')
 const status=page.getByRole('dialog',{name:/^Completed:/})
 await expect(status.getByRole('button',{name:'Change status'})).toBeDisabled()
 await status.getByLabel('Reason *').fill('Client accepted the launch; remaining items move to a retainer')
 await status.getByRole('button',{name:'Change status'}).click()
 await expect(page.locator('.pw-head')).toContainText('Completed')
 expect(await one('select completed_on is not null from leadflow_private.projects')).toBe(true)

 // The portfolio: overview figures, the list, the calendar and the client's Projects tab.
 await page.getByRole('button',{name:'All projects'}).click()
 await tab(page,'All projects')
 await page.getByLabel(/status/i).first().selectOption('all')
 await expect(page.locator('table, .pf-list').first()).toContainText('Website redesign')
 await tab(page,'Calendar')
 await expect(page.locator('.pw-tab-body, .pf-calendar, main').first()).toBeVisible()
 await page.setViewportSize({width:390,height:844})
 expect(await noHorizontalScroll(page)).toBe(true)
 await page.setViewportSize({width:1280,height:900})
 await page.getByRole('button',{name:'Clients',exact:true}).click()
 await page.getByRole('button',{name:/Harbor Dental/}).first().click()
 await tab(page,'Projects')
 await expect(page.getByText('Website redesign').first()).toBeVisible()
 // The client's portal never shows project files or notes.
 expect(await one(`select count(*)::int from leadflow_private.client_documents where project_id is not null and visibility='shared'`)).toBe(0)
 expect(errors).toEqual([])
})

test('members plan and work projects but templates are for owners and admins',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 const {client}=await start(page,{users:[owner,member],signInAs:member})
 await as(owner.id,'select public.create_project($1,$2,$3) as r',[owner.id,JSON.stringify({clientId:client,source:'manual',name:'SEO campaign',startDate:'2026-12-01'}),crypto.randomUUID()])
 await openProjects(page)
 await tab(page,'Templates')
 await expect(page.getByText('Website design & development').first()).toBeVisible()
 await expect(page.getByRole('button',{name:/New template/i})).toHaveCount(0)
 await tab(page,'All projects')
 await page.getByRole('button',{name:'SEO campaign'}).first().click()
 await expect(page.locator('.pw-head').getByRole('heading',{level:2,name:'SEO campaign'})).toBeVisible()
 await tab(page,'Milestones')
 await page.getByRole('button',{name:'Add milestone'}).click()
 const dialog=page.getByRole('dialog').filter({has:page.getByLabel('Name *')})
 await dialog.getByLabel('Name *').fill('Technical audit')
 await dialog.getByRole('button',{name:'Save milestone'}).click()
 await expect.poll(()=>one(`select count(*)::int from leadflow_private.project_milestones where name='Technical audit'`)).toBe(1)
 await tab(page,'Settings')
 await expect(page.getByRole('button',{name:'Save as template'})).toHaveCount(0)
 expect(errors).toEqual([])
})
