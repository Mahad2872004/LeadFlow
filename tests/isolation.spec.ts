import { test, expect, type Page } from '@playwright/test'
import { createHarness, actor } from './support/m3'
import { apiOrigin, mockSupabase, signIn, type SupabaseMock } from './support/supabase'
// Two independent accounts, three workspaces, real migrations and the real inquiry Edge handler.
const alex={id:actor,email:'owner@example.com',password:'test-password'}
const blair={id:'22222222-2222-4222-8222-222222222222',email:'blair@example.com',password:'test-password'}
const today=new Date().toLocaleDateString('en-CA')
interface Fixture { names:string[]; credential:string }
const personal:Fixture={names:['Alpha Personal'],credential:'Alpha webhook'}
const agencyData:Fixture={names:['Agency One','Agency Two'],credential:'Agency Zapier'}
const bravo:Fixture={names:['Bravo Lead'],credential:'Bravo n8n'}
let h:Awaited<ReturnType<typeof createHarness>>,supabase:SupabaseMock,agency:string
let gate:Promise<void>|null=null,openGate=()=>{}
function snapshot(prefix:string,{names}:Fixture){
 const leads=names.map((name,index)=>({id:`${prefix}-${index}`,name,email:`${prefix}${index}@example.com`,phone:'',company:`${name} Co`,service:'Consulting',source:'Referral',message:'',status:'New',createdAt:`2026-10-1${index}T10:00:00.000Z`}))
 return {version:1,leads,tasks:[{id:`${prefix}-task`,leadId:leads[0].id,due:today,notes:`Call ${names[0]}`,completed:false}],activities:leads.map(lead=>({id:`${lead.id}-event`,leadId:lead.id,text:`${lead.name} captured`,at:lead.createdAt}))}
}
async function seed(user:string,workspace:string,prefix:string,fixture:Fixture,hash:string){
 await supabase.queryAs(user,'select public.save_workspace_for($1,$2,0,$3)',[workspace,JSON.stringify(snapshot(prefix,fixture)),crypto.randomUUID()])
 await supabase.admin("insert into leadflow_private.integration_keys(workspace_id,label,provider,token_hash,notification_from,notification_to,last_used_at) values($1,$2,'webhook',$3,'LeadFlow <n@example.com>','ops@example.com',now())",[workspace,fixture.credential,hash.repeat(64)])
}
test.beforeEach(async({page})=>{
 h=await createHarness([blair.id]);gate=null
 await h.db.query('update auth.users set email=$2 where id=$1',[blair.id,blair.email])
 await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*',route=>route.fulfill({contentType:'application/javascript',body:`window.turnstile={render(el,options){setTimeout(()=>options.callback('test-token'),0);return 'widget'},remove(){},reset(){}};`}))
 supabase=await mockSupabase(page,h.db,{users:[alex,blair],beforeRpc:async(name,args)=>{if(gate&&name==='load_workspace_for'&&args.target_workspace===agency)await gate}})
 await page.route(`${apiOrigin}/functions/v1/**`,async route=>{
  const request=route.request(),response=await h.handler(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}))
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
 ;[{id:agency}]=await supabase.queryAs<{id:string}>(alex.id,"select public.create_workspace('Agency Workspace') as id")
 await seed(alex.id,alex.id,'alpha',personal,'a');await seed(alex.id,agency,'agency',agencyData,'b');await seed(blair.id,blair.id,'bravo',bravo,'c')
})
test.afterEach(async()=>{await h.db.close()})
// Prefix match: the Follow-ups item also announces its due count.
const nav=(page:Page,name:string)=>page.getByRole('navigation').getByRole('button',{name:new RegExp(`^${name}`)}).click()
const switcher=(page:Page)=>page.getByRole('button',{name:/^Switch workspace/})
async function choose(page:Page,name:string){
 await switcher(page).click();await page.getByRole('button',{name:new RegExp(`^.{0,3}${name}`)}).click()
 await expect(switcher(page)).toHaveAccessibleName(`Switch workspace. Current workspace: ${name}`)
}
/** Every workspace-scoped screen shows this workspace's records and none of the others'. */
async function expectOnly(page:Page,mine:Fixture,others:Fixture[]){
 const foreign=others.flatMap(other=>other.names)
 await nav(page,'Overview')
 await expect(page.getByRole('button',{name:new RegExp(`^Total leads: ${mine.names.length}\\.`)})).toBeVisible()
 await expect(page.getByRole('button',{name:/^Follow-ups due: 1\./})).toBeVisible()
 await nav(page,'Leads')
 for(const name of mine.names)await expect(page.getByLabel(`Status for ${name}`)).toBeVisible()
 for(const name of foreign)await expect(page.getByLabel(`Status for ${name}`)).toHaveCount(0)
 await nav(page,'Follow-ups');await expect(page.getByText(`Call ${mine.names[0]}`)).toBeVisible()
 for(const other of others)await expect(page.getByText(`Call ${other.names[0]}`)).toHaveCount(0)
 await nav(page,'Activity');for(const name of mine.names)await expect(page.getByText(`${name} captured`)).toBeVisible()
 for(const name of foreign)await expect(page.getByText(`${name} captured`)).toHaveCount(0)
 await nav(page,'Integrations');await page.getByRole('button',{name:'View Lead submission API guide'}).click()
 await expect(page.locator('.integration-credential')).toHaveCount(1);await expect(page.locator('.integration-credential')).toContainText(mine.credential)
 await page.getByRole('button',{name:'All integrations',exact:false}).click()
}

test('two users and three workspaces stay isolated across switching and refresh',async({page})=>{
 await page.goto('/login');await signIn(page,alex.email)
 await expect(switcher(page)).toHaveAccessibleName('Switch workspace. Current workspace: Personal workspace')
 await expectOnly(page,personal,[agencyData,bravo])
 await choose(page,'Agency Workspace');await expectOnly(page,agencyData,[personal,bravo])
 await page.reload();await expect(switcher(page)).toHaveAccessibleName('Switch workspace. Current workspace: Agency Workspace')
 await expectOnly(page,agencyData,[personal,bravo])
 await choose(page,'Personal workspace');await expectOnly(page,personal,[agencyData,bravo])
 // The second account sees only its own workspace, and the database refuses Alex's workspace IDs.
 await page.getByRole('button',{name:'Sign out'}).click();await signIn(page,blair.email)
 await expectOnly(page,bravo,[personal,agencyData])
 await switcher(page).click();await expect(page.locator('.workspace-option')).toHaveCount(1);await page.keyboard.press('Escape')
 const refused=await page.evaluate(async({apiOrigin,targets})=>{
  const key=Object.keys(localStorage).find(name=>/^sb-.*-auth-token$/.test(name))!,token=JSON.parse(localStorage.getItem(key)!).access_token
  const call=(name:string,body:object)=>fetch(`${apiOrigin}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:'test-public-key',Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(response=>response.status)
  const statuses:number[]=[]
  for(const target of targets)for(const [name,body] of [['load_workspace_for',{}],['integration_overview_for',{}],['inquiry_form_for',{}],['verify_integration_receipt_for',{submission_id:crypto.randomUUID()}],['save_workspace_for',{payload:{version:1,leads:[],tasks:[],activities:[]},expected_revision:1,request_id:crypto.randomUUID()}]] as const)statuses.push(await call(name,{target_workspace:target,...body}))
  return statuses
 },{apiOrigin,targets:[alex.id,agency]})
 expect(refused).toEqual(Array(10).fill(403))
 expect(await supabase.admin<{n:number}>('select count(*)::int as n from public.leads where workspace_id=any($1)',[[alex.id,agency]])).toEqual([{n:3}])
})

test('switching never shows the previous workspace and loads it once',async({page},testInfo)=>{
 await page.goto('/login');await signIn(page,alex.email);await nav(page,'Leads')
 await expect(page.getByLabel('Status for Alpha Personal')).toBeVisible()
 gate=new Promise(resolve=>{openGate=resolve})
 const before=supabase.rpcLog.length
 await choose(page,'Agency Workspace')
 // While the new workspace is loading, nothing from the previous one remains on screen.
 await expect(page.getByText('Loading your workspace…')).toBeAttached()
 for(const name of [...personal.names,...agencyData.names])await expect(page.getByLabel(`Status for ${name}`)).toHaveCount(0)
 await expect(page.getByText('Alpha Personal')).toHaveCount(0)
 openGate();gate=null
 await expect(page.getByLabel('Status for Agency One')).toBeVisible();await expect(page.getByLabel('Status for Alpha Personal')).toHaveCount(0)
 const after=supabase.rpcLog.slice(before)
 expect(after.filter(call=>call.args.target_workspace&&call.args.target_workspace!==agency)).toEqual([])
 // Development mode's StrictMode runs effects twice; the production build loads exactly once.
 const loads=after.filter(call=>call.name==='load_workspace_for').length
 expect(String(testInfo.project.use.baseURL).includes(':4175')?loads===1:loads>=1&&loads<=2).toBe(true)
 expect(after.filter(call=>call.name==='list_workspaces')).toEqual([])
})

test('each workspace form delivers to that workspace and notifies its recipient',async({page})=>{
 await page.goto('/login');await signIn(page,alex.email);await choose(page,'Agency Workspace')
 await nav(page,'Integrations');await page.getByRole('button',{name:'View Hosted inquiry form guide'}).click()
 const settings=page.getByRole('region',{name:'This workspace’s form'})
 await expect(settings).toContainText('Accepting inquiries.');await expect(settings).toContainText('owner@example.com')
 await settings.getByLabel('Notification recipient').fill('agency-leads@example.com');await settings.getByRole('button',{name:'Save recipient'}).click()
 await expect(settings.getByText('Notifications will go to the new recipient.')).toBeVisible()
 const link=await page.getByLabel('Hosted form URL',{exact:true}).inputValue()
 const [{key}]=await supabase.admin<{key:string}>('select id::text as key from leadflow_private.inquiry_forms where workspace_id=$1',[agency])
 expect(link).toBe(new URL(`/inquiry?form=${key}`,page.url()).href);expect(link).not.toContain(agency)
 await page.goto(link)
 await page.getByLabel('Your name *').fill('Form Prospect');await page.getByLabel('Email address *').fill('form-prospect@example.com')
 await page.getByLabel('What can we help with? *').selectOption('Consulting');await page.getByLabel('Tell us a little more *').fill('Fictional inquiry through the agency form.')
 await page.getByRole('button',{name:'Send inquiry'}).click();await expect(page.getByRole('heading',{name:'Thanks for reaching out.'})).toBeVisible()
 const [stored]=await supabase.admin<{workspace_id:string;email:{to:string[];text:string}}>("select l.workspace_id::text,o.email from public.leads l join leadflow_private.notification_outbox o on o.request_id::text=l.id where l.name='Form Prospect'")
 expect(stored.workspace_id).toBe(agency);expect(stored.email.to).toEqual(['agency-leads@example.com']);expect(stored.email.text).toContain('Workspace: Agency Workspace')
 await page.goto('/app');await expect(switcher(page)).toHaveAccessibleName('Switch workspace. Current workspace: Agency Workspace')
 await nav(page,'Leads');await expect(page.getByLabel('Status for Form Prospect')).toHaveValue('New')
 await choose(page,'Personal workspace');await expect(page.getByLabel('Status for Form Prospect')).toHaveCount(0)
 // A turned-off form refuses new inquiries without revealing anything about the workspace.
 await choose(page,'Agency Workspace');await nav(page,'Integrations');await page.getByRole('button',{name:'View Hosted inquiry form guide'}).click()
 await settings.getByRole('button',{name:'Turn off form'}).click();await expect(settings).toContainText('Turned off.')
 await page.goto(link);await page.getByLabel('Your name *').fill('Late Prospect');await page.getByLabel('Email address *').fill('late@example.com')
 await page.getByLabel('What can we help with? *').selectOption('Consulting');await page.getByLabel('Tell us a little more *').fill('Sent after the form was turned off.')
 await page.getByRole('button',{name:'Send inquiry'}).click();await expect(page.getByRole('alert')).toContainText('not accepting inquiries')
 expect(await supabase.admin<{n:number}>("select count(*)::int as n from public.leads where name='Late Prospect'")).toEqual([{n:0}])
})

test('members can add and update but the database keeps removals and form settings to owners and admins',async({page})=>{
 await supabase.queryAs(alex.id,"select public.set_workspace_member($1,$2,'member')",[agency,blair.id])
 await page.goto('/login');await signIn(page,blair.email);await choose(page,'Agency Workspace')
 await expect(page.getByRole('button',{name:'Reset demo data'})).toHaveCount(0)
 await nav(page,'Leads');await page.getByLabel('Status for Agency One').selectOption('Contacted');await expect(page.getByRole('status').filter({hasText:'Agency One moved to Contacted.'})).toBeVisible()
 await nav(page,'Integrations');await page.getByRole('button',{name:'View Hosted inquiry form guide'}).click()
 const settings=page.getByRole('region',{name:'This workspace’s form'})
 await expect(settings).toContainText('Only owners and admins can change this form.');await expect(settings.getByRole('button')).toHaveCount(0)
 await nav(page,'Settings');await expect(page.getByRole('region',{name:'Your access'})).toContainText('Remove leads or follow-ups, or reset demo data: not allowed')
 const attempts=await page.evaluate(async({apiOrigin,agency})=>{
  const key=Object.keys(localStorage).find(name=>/^sb-.*-auth-token$/.test(name))!,token=JSON.parse(localStorage.getItem(key)!).access_token
  const call=(name:string,body:object)=>fetch(`${apiOrigin}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:'test-public-key',Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async response=>({status:response.status,message:(await response.json().catch(()=>({}))).message}))
  const current=await fetch(`${apiOrigin}/rest/v1/rpc/load_workspace_for`,{method:'POST',headers:{apikey:'test-public-key',Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({target_workspace:agency})}).then(response=>response.json())
  return {
   reset:await call('save_workspace_for',{target_workspace:agency,payload:{version:1,leads:[],tasks:[],activities:[]},expected_revision:current.revision,request_id:crypto.randomUUID()}),
   history:await call('save_workspace_for',{target_workspace:agency,payload:{...current.data,activities:current.data.activities.slice(1)},expected_revision:current.revision,request_id:crypto.randomUUID()}),
   form:await call('update_inquiry_form',{target_workspace:agency,form_enabled:false}),
  }
 },{apiOrigin,agency})
 expect([attempts.reset.status,attempts.reset.message]).toEqual([403,'Only workspace owners and admins can remove leads or follow-ups.'])
 expect([attempts.history.status,attempts.history.message]).toEqual([403,'Members can add to the activity history but not change or remove it.'])
 expect([attempts.form.status,attempts.form.message]).toEqual([403,'Your workspace role does not allow this action.'])
 expect(await supabase.admin<{n:number}>('select count(*)::int as n from public.leads where workspace_id=$1',[agency])).toEqual([{n:2}])
})
