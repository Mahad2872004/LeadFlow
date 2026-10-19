import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { sampleData } from '../src/lib/seed'
import { createDatabase } from './support/database'
import { mockSupabase, signIn, type SupabaseMock } from './support/supabase'
const actor='11111111-1111-4111-8111-111111111111'
let db:PGlite,supabase:SupabaseMock
let loseResponse=false
let failLoad=false
test.beforeEach(async({page})=>{
 db=await createDatabase([actor]);loseResponse=false;failLoad=false
 // The account existed before the workspace migration, so it already has its personal workspace.
 supabase=await mockSupabase(page,db,{users:[{id:actor,email:'test@example.com',password:'test-password'}],
  beforeRpc:name=>{if(name==='load_workspace_for'&&failLoad)return {status:503,body:{message:'Database unavailable'}}},
  afterRpc:(name,reply)=>{if(name==='save_workspace_for'&&loseResponse&&reply.status===200){loseResponse=false;return {status:503,body:{message:'Response lost after commit'}}}}})
})
test.afterEach(async()=>{await db.close()})
async function login(page:Page){
 await page.goto('/app');await expect(page.getByRole('heading',{name:'Sign in to LeadFlow'})).toBeVisible()
 await signIn(page,'test@example.com')
}
async function seed(page:Page){await page.getByRole('button',{name:'Reset demo data'}).first().click();await page.getByRole('dialog').getByRole('button',{name:'Reset demo data',exact:true}).click();await expect(page.getByLabel('Status for Olivia Bennett')).toBeVisible()}
async function add(page:Page){await page.getByRole('button',{name:'Add lead'}).first().click();await page.getByLabel('Full name').fill('M2 Prospect');await page.getByLabel('Email *',{exact:true}).fill('m2@example.com');await page.getByLabel('Service interest *').selectOption('Consulting');await page.getByLabel('Source *').selectOption('Referral');await page.getByRole('button',{name:'Create lead',exact:true}).click()}
test('private login, CRUD, filters, follow-ups, activity, refresh, reset and sign out',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
 await login(page);await expect(page.getByText('Your database workspace is empty.',{exact:false})).toBeVisible()
 await seed(page);await add(page);await expect(page.getByLabel('Status for M2 Prospect')).toBeVisible()
 await page.getByLabel('Status for M2 Prospect').selectOption('Qualified');await expect(page.getByText('M2 Prospect moved to Qualified.',{exact:false})).toBeVisible()
 await page.reload();await expect(page.getByLabel('Status for M2 Prospect')).toHaveValue('Qualified')
 await page.getByLabel('Search leads').fill('M2 Prospect');await page.getByLabel('Filter by source').selectOption('Referral');await page.getByLabel('Filter by status').selectOption('Qualified');await expect(page.getByRole('table').getByRole('row')).toHaveCount(2)
 await page.getByLabel('View M2 Prospect').click();await page.getByRole('button',{name:'Edit lead',exact:true}).click();await page.getByLabel('Company (optional)').fill('Updated company');await page.getByRole('button',{name:'Save changes'}).click();await expect(page.getByRole('dialog')).toContainText('Updated company')
 await page.getByRole('button',{name:'Add follow-up'}).click();await page.getByLabel('Notes *').fill('M2 callback');await page.getByRole('button',{name:'Schedule follow-up'}).click();await expect(page.getByRole('dialog')).toContainText('M2 callback')
 await page.getByRole('dialog').getByRole('checkbox').click();await expect(page.getByRole('dialog')).toContainText('Follow-up completed: M2 callback')
 await page.getByRole('dialog').getByRole('checkbox').click();await expect(page.getByRole('dialog')).toContainText('Follow-up reopened: M2 callback')
 await page.getByLabel('Close dialog').click();await page.reload();await page.getByLabel('View M2 Prospect').click();await expect(page.getByRole('dialog')).toContainText('Updated company');await expect(page.getByRole('dialog').getByRole('checkbox')).not.toBeChecked();await page.getByLabel('Close dialog').click()
 await page.getByRole('button',{name:'Reset demo data'}).first().click();await page.getByRole('button',{name:'Keep my data'}).click();await expect(page.getByLabel('Status for M2 Prospect')).toBeVisible()
 await seed(page);await expect(page.getByLabel('Status for M2 Prospect')).toHaveCount(0)
 await page.getByRole('button',{name:'Sign out'}).click();await expect(page.getByRole('heading',{name:'Sign in to LeadFlow'})).toBeVisible();expect(errors).toEqual([])
})
test('explicit legacy import preserves original browser records and survives a new login',async({page})=>{
 const legacy=sampleData();await page.addInitScript(data=>localStorage.setItem('leadflow.demo.v1',JSON.stringify(data)),legacy)
 await login(page);await page.getByRole('button',{name:'Import browser data'}).click();await page.getByRole('button',{name:'Confirm import'}).click();await expect(page.getByLabel('Status for Olivia Bennett')).toBeVisible()
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('leadflow.demo.v1')!))).toEqual(legacy)
 await page.getByRole('button',{name:'Sign out'}).click();await login(page);await expect(page.getByLabel('Status for Olivia Bennett')).toBeVisible();await expect(page.getByRole('button',{name:'Import browser data'})).toHaveCount(0)
})
test('lost commit response retries without duplicate leads or history',async({page})=>{
 await login(page);loseResponse=true;await add(page)
 await expect(page.getByRole('alert')).toContainText('Response lost after commit')
 await expect(page.getByLabel('Status for M2 Prospect')).toHaveCount(0)
 await page.getByRole('button',{name:'Retry saving'}).click();await expect(page.getByLabel('Status for M2 Prospect')).toBeVisible()
 const [result]=await supabase.queryAs<{snapshot:{revision:number;data:{leads:unknown[];activities:unknown[]}}}>(actor,'select public.load_workspace() as snapshot')
 expect(result.snapshot.revision).toBe(1);expect(result.snapshot.data.leads).toHaveLength(1);expect(result.snapshot.data.activities).toHaveLength(1)
})
test('stale revision does not overwrite another session; load failure can be retried',async({page})=>{
 failLoad=true;await login(page);await expect(page.getByRole('alert')).toContainText('Database unavailable');failLoad=false;await page.getByRole('button',{name:'Retry loading'}).click();await expect(page.getByLabel('Search leads')).toBeVisible()
 await supabase.queryAs(actor,'select public.save_workspace($1::jsonb,0,$2::uuid)',[JSON.stringify(sampleData()),crypto.randomUUID()])
 await add(page);await expect(page.getByRole('alert')).toContainText('another session');await page.getByRole('button',{name:'Reload workspace and discard attempt'}).click();await expect(page.getByLabel('Status for Olivia Bennett')).toBeVisible();await expect(page.getByLabel('Status for M2 Prospect')).toHaveCount(0)
})
test('mobile search, task filters and malformed legacy data remain usable',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.addInitScript(()=>localStorage.setItem('leadflow.demo.v1','broken'));await login(page);await expect(page.getByRole('alert')).toContainText('left untouched');await seed(page)
 await page.getByLabel('Search leads').fill('no-match');await expect(page.getByRole('heading',{name:'No leads found'})).toBeVisible();await page.getByRole('button',{name:'Clear filters'}).click()
 await page.getByRole('navigation').getByRole('button',{name:'Follow-ups'}).click();await page.getByLabel('Filter tasks').selectOption('Completed');await expect(page.getByRole('checkbox')).toHaveCount(0)
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await page.evaluate(()=>localStorage.getItem('leadflow.demo.v1'))).toBe('broken')
})
