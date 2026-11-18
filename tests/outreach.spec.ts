import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { createAnalysisHarness, dentalSite } from './support/analysis'
import { createOutreachHarness, draftOutput, studioSite } from './support/outreach'
import { apiOrigin, mockSupabase, signIn } from './support/supabase'
// Contacts and outreach end to end: the real UI, the real outreach and business-analysis Edge handlers and the migration SQL
// in embedded PostgreSQL. Websites, DNS and the AI provider are simulated; no request leaves the machine and nothing is sent.
const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com',password:'test-password'}
let db:PGlite
test.describe.configure({timeout:180000})
test.afterEach(async()=>{await db?.close()})
const lead=(id:string,fields:Record<string,string>={})=>({id,name:'Avery Stone',email:'',phone:'',company:'Harbor Dental',service:'Not specified',source:'Lead discovery',message:'',status:'New',createdAt:'2026-11-01T00:00:00.000Z',website:'https://harbor-dental.example/',industry:'Dental clinics',address:'',city:'Austin',region:'TX',postcode:'',country:'US',...fields})
const asOwner=async(sql:string,params:unknown[]=[])=>db.transaction(async tx=>{
 await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",[owner.id,JSON.stringify({sub:owner.id,role:'authenticated'})]);await tx.exec('set local role authenticated')
 return (await tx.query<{r:unknown}>(sql,params)).rows[0]?.r})
async function start(page:Page,overrides:Record<string,string|undefined>={}){
 db=await createDatabase([owner.id])
 await db.query('update auth.users set email=$2 where id=$1',[owner.id,owner.email])
 const current=await asOwner('select public.load_workspace() as r') as {data:{leads:unknown[]};revision:number}
 await asOwner('select public.save_workspace_for($1,$2,$3,$4) as r',[owner.id,JSON.stringify({...current.data,leads:[lead('harbor'),lead('studio',{name:'Brightpath Studio',company:'Brightpath Studio',website:'https://brightpath.example/',industry:'Marketing agencies'})]}),current.revision,crypto.randomUUID()])
 await asOwner('select public.install_starter_services($1) as r',[owner.id])
 await mockSupabase(page,db,{users:[owner]})
 const env={GEMINI_API_KEY:'gemini-test',...overrides}
 const analysis=createAnalysisHarness(db,{GEMINI_API_KEY:'gemini-test'}),outreach=createOutreachHarness(db,env)
 for(const harness of [analysis,outreach]){dentalSite(harness.state);studioSite(harness.state);harness.state.mx['harbor-dental.example']=['10 mail.harbor-dental.example.']}
 // A finished business report for Harbor Dental, made by the real pipeline before the page opens.
 const started=await analysis.handler(new Request('https://functions.test/business-analysis',{method:'POST',headers:{Origin:'http://127.0.0.1:5175','Content-Type':'application/json',Authorization:`Bearer ${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:owner.id,role:'authenticated'})).toString('base64url')}.sig`},body:JSON.stringify({workspaceId:owner.id,action:'start',leadId:'harbor',requestId:crypto.randomUUID()})}))
 expect(started.status).toBe(200)
 for(let i=0;i<20;i++){await db.query('update leadflow_private.business_analyses set next_run_at=now() where step is not null');const response=await analysis.worker(new Request('https://worker.test',{method:'POST',headers:{'x-worker-secret':analysis.config.NOTIFICATION_WORKER_SECRET!}}));if(!(await response.json()).steps?.length)break}
 for(const [name,harness] of [['business-analysis',analysis.handler],['outreach',outreach.outreach]] as const)await page.route(`${apiOrigin}/functions/v1/${name}`,async route=>{
  const request=route.request()
  const response=await harness(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}))
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
 await page.goto('/login');await signIn(page,owner.email)
 return outreach
}
async function openLead(page:Page,name:string,tab:'Contacts'|'Outreach'){
 await page.getByRole('button',{name:'Leads',exact:true}).click()
 await page.getByLabel(`View ${name}`).first().click()
 await page.getByRole('button',{name:tab,exact:true}).click()
 return page.locator('dialog#business-report')
}

test('finds and manages contacts, then prepares, edits, versions and tracks grounded outreach',async({page,context})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 await context.grantPermissions(['clipboard-read','clipboard-write'])
 const harness=await start(page)
 // Settings: the agency's outreach defaults and the member's own sender details.
 await page.getByRole('button',{name:'Settings',exact:true}).click()
 const settings=page.locator('.ow-settings')
 await settings.getByLabel('Agency name').fill('Northline Digital');await settings.getByLabel('Objective').selectOption('free_audit')
 await settings.getByRole('button',{name:'Save outreach settings'}).click()
 await expect(settings.getByRole('status')).toHaveText('Outreach settings saved.')
 await settings.getByLabel('Your name').fill('Morgan Hale');await settings.getByRole('button',{name:'Save my details'}).click()
 await expect(settings.getByRole('status')).toHaveText('Your sender details were saved.')
 await expect(settings.locator('.ow-usage-stats')).toContainText('AI drafting')

 // Contacts for a studio without a business report: people with titles from the team page, published addresses, channels.
 let dialog=await openLead(page,'Brightpath Studio','Contacts')
 await expect(dialog.getByRole('heading',{name:'Contacts · Brightpath Studio'})).toBeVisible()
 await dialog.getByRole('button',{name:'Find contacts'}).click()
 await expect(dialog.locator('.ow-job')).toContainText('Contact search: Completed',{timeout:60000})
 const jane=dialog.locator('.ow-contact',{hasText:'Jane Doe'})
 await expect(jane).toContainText('Founder & CEO');await expect(jane).toContainText('jane@brightpath.example')
 const info=dialog.locator('.ow-contact',{hasText:'info@brightpath.example'})
 await expect(info.locator('.ow-status').first()).toHaveText('Likely valid');await expect(info.locator('.ow-confidence')).toHaveText('High confidence')
 await info.getByText('Sources and confidence').click()
 await expect(info.locator('.ow-reasons')).toContainText('Published as a contact link on the business’s own website')
 await expect(dialog.locator('.ow-channels')).toContainText('LinkedIn company page');await expect(dialog.locator('.ow-channels')).toContainText('200 Congress Ave, Austin, TX 78701')
 await expect(dialog.locator('.ow-contacts')).not.toContainText('sales@brightpath.example')
 // Edit protects a field; confirm and prefer.
 await jane.getByRole('button',{name:'Edit'}).click()
 const form=dialog.getByRole('form',{name:'Edit contact'})
 await form.getByLabel('Job title').fill('Founder');await form.getByRole('button',{name:'Save contact'}).click()
 await expect(dialog.getByRole('status').first()).toContainText('protected from discovery')
 await jane.getByRole('button',{name:'Confirm'}).click();await expect(jane).toContainText('Confirmed')
 await jane.getByRole('button',{name:'Prefer'}).click();await expect(jane).toContainText('Preferred for outreach')
 // A manual contact, validated in the browser and the database.
 await dialog.getByRole('button',{name:'Add contact'}).click()
 const add=dialog.getByRole('form',{name:'Add a contact'})
 await add.getByLabel('Name *').fill('Priya Shah');await add.getByLabel('Phone').fill('123');await add.getByRole('button',{name:'Add contact'}).click()
 await expect(add.locator('.field-error')).toContainText('isn’t a valid phone number')
 await add.getByLabel('Phone').fill('(512) 555-0177');await add.getByRole('button',{name:'Add contact'}).click()
 await expect(dialog.locator('.ow-contact',{hasText:'Priya Shah'})).toContainText('+1 512 555 0177')
 // Closing returns to the lead's details; close those too.
 await dialog.getByRole('button',{name:'Close dialog'}).click();await page.getByRole('button',{name:'Close dialog'}).click()

 // Outreach for Harbor Dental: the report's strongest opportunity and a recommended angle.
 dialog=await openLead(page,'Avery Stone','Contacts')
 await dialog.getByRole('button',{name:'Find contacts'}).click()
 const hello=dialog.locator('.ow-contact',{hasText:'hello@harbor-dental.example'})
 await expect(hello).toBeVisible({timeout:60000})
 await hello.getByRole('button',{name:'Write outreach'}).click()
 await expect(dialog.getByRole('tab',{name:'Outreach'})).toHaveAttribute('aria-selected','true')
 const compose=dialog.locator('.ow-compose')
 await expect(compose.getByRole('combobox',{name:/^Contact/})).toHaveValue(/[0-9a-f-]{36}/)
 await expect(compose.locator('.ow-recommended')).toHaveCount(1)
 harness.drafts.outputs=[draftOutput('Hi there,\n\nI looked at harbor-dental.example and couldn’t find an online booking option on the pages I checked.\n\nWould a short, free review be useful?\n\nMorgan Hale')]
 await compose.getByRole('button',{name:'Generate draft'}).click()
 const editor=dialog.locator('.ow-editor')
 await expect(editor.getByLabel('Message')).toHaveValue(/couldn’t find an online booking option/)
 await expect(editor.locator('.ow-grounding')).toContainText('Based on the business report')
 await expect(editor).toContainText('Version 1 · Generated')
 expect(harness.drafts.requests.at(-1)!.user).toContain('name: Northline Digital')
 // Edit and save: a new version. Regenerating asks before replacing the edit, and keeps it in the history.
 await editor.getByLabel('Message').fill('Hi there,\n\nMy own wording about online booking.\n\nMorgan')
 await editor.getByRole('button',{name:'Save changes'}).click()
 await expect(editor).toContainText('Version 2 · Edited by you')
 harness.drafts.outputs=[draftOutput('Hello again, a fresh take on online booking for your patients. Open to a short call?')]
 await editor.getByRole('button',{name:'Regenerate'}).click()
 await expect(editor.locator('.br-confirm')).toContainText('You edited this draft')
 await editor.getByRole('button',{name:'Regenerate anyway'}).click()
 await expect(editor).toContainText('Version 3 · Regenerated')
 await editor.getByText('Version history (3)').click()
 await editor.locator('.ow-versions li',{hasText:'Version 2'}).getByRole('button',{name:'Compare with current'}).click()
 await expect(editor.locator('.ow-diff del').first()).toContainText('My own wording about');await expect(editor.locator('.ow-diff ins').first()).toContainText('again, a fresh take')
 // Copying never marks a draft as sent; a person does, and the lead's history records it.
 await editor.getByRole('button',{name:'Copy'}).click()
 await expect(dialog.getByRole('status').first()).toContainText('isn’t marked as sent')
 expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain('Subject: A quick note about your website')
 await expect(editor.locator('.ow-draft-status')).toHaveText('Draft')
 await editor.getByRole('button',{name:'Mark as sent…'}).click()
 await editor.getByRole('button',{name:'I sent it: mark as sent'}).click()
 await expect(editor.locator('.ow-draft-status')).toHaveText('Sent manually')
 await editor.getByRole('button',{name:/^Remind me /}).first().click()
 await expect(dialog.getByRole('status').first()).toContainText('Reminder added to Follow-ups')
 // LinkedIn invitation notes are held to LinkedIn's 200-character limit.
 await compose.getByText('LinkedIn note').click()
 harness.drafts.outputs=[draftOutput('Hi Avery, I help Austin clinics with their websites and noticed booking wasn’t visible on the pages I checked. Open to connecting?')]
 await compose.getByRole('button',{name:'Generate draft'}).click()
 await expect(editor.locator('.ow-counter')).toContainText('/ 200 characters (LinkedIn’s limit for invitation notes)')
 // A draft that claims what the evidence can't support is refused and explained.
 harness.drafts.outputs=[draftOutput('Your practice is losing patients because booking is hard.')]
 await compose.getByText('Email',{exact:true}).click();await compose.getByRole('button',{name:'Generate draft'}).click()
 await expect(dialog.getByRole('alert').first()).toContainText('which the evidence doesn’t support')
 await dialog.getByRole('button',{name:'Close dialog'}).click()
 await page.getByRole('button',{name:'Close dialog'}).click()
 await page.getByRole('button',{name:'Follow-ups',exact:true}).click()
 await expect(page.locator('main')).toContainText('Follow up on email')
 await page.getByRole('button',{name:'Activity',exact:true}).click()
 await expect(page.locator('main')).toContainText('Email marked as sent manually')
 expect(await page.content()).not.toContain('gemini-test')
 expect(errors).toEqual([])
})

test('works without an AI key: contacts and existing drafts stay usable, generation explains what’s missing',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 await start(page,{GEMINI_API_KEY:undefined})
 const dialog=await openLead(page,'Avery Stone','Outreach')
 await expect(dialog.locator('.ow-compose')).toContainText('AI drafting isn’t set up')
 await expect(dialog.getByRole('button',{name:'Generate draft'})).toBeDisabled()
 await expect(dialog.locator('.ow-empty')).toContainText('No draft selected')
 await dialog.getByRole('tab',{name:'Contacts'}).click()
 await expect(dialog.getByRole('button',{name:'Find contacts'})).toBeEnabled()
 expect(errors).toEqual([])
})
