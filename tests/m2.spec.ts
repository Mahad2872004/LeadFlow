import { test, expect, type Page } from '@playwright/test'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { sampleData } from '../src/lib/seed'
const actor='11111111-1111-4111-8111-111111111111'
let db:PGlite
let loseResponse=false
let failLoad=false
const jwt=[{alg:'HS256',typ:'JWT'},{sub:actor,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'test'].map(x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64url')).join('.')
const user={id:actor,email:'test@example.com',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()}
test.beforeEach(async({page})=>{
 db=new PGlite();loseResponse=false;failLoad=false
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select '${actor}'::uuid $$;
 create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
 insert into auth.users values('${actor}');`)
 await db.exec(readFileSync('supabase/migrations/202610180001_m2.sql','utf8'))
 await db.exec(readFileSync('supabase/migrations/202610180002_m3.sql','utf8'))
 await db.exec(readFileSync('supabase/migrations/202610180003_integrations.sql','utf8'))
 await db.exec('set role authenticated')
 await page.route('http://127.0.0.1:54329/**',async route=>{
  const url=route.request().url()
  if(url.includes('/auth/v1/token'))return route.fulfill({json:{access_token:jwt,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,user}})
  if(url.includes('/auth/v1/logout'))return route.fulfill({status:204})
  if(url.includes('/auth/v1/user'))return route.fulfill({json:user})
  try{
   if(url.endsWith('/rpc/load_workspace')){
    if(failLoad)return route.fulfill({status:503,json:{message:'Database unavailable'}})
    const result=await db.query<{snapshot:unknown}>('select public.load_workspace() as snapshot')
    return route.fulfill({json:result.rows[0].snapshot})
   }
   if(url.endsWith('/rpc/save_workspace')){
    const body=route.request().postDataJSON()
    const result=await db.query<{revision:number}>('select public.save_workspace($1::jsonb,$2::bigint,$3::uuid) as revision',[JSON.stringify(body.payload),body.expected_revision,body.request_id])
    if(loseResponse){loseResponse=false;return route.fulfill({status:503,json:{message:'Response lost after commit'}})}
    return route.fulfill({json:result.rows[0].revision})
   }
   return route.fulfill({status:404,json:{message:'Unexpected endpoint'}})
  }catch(error){return route.fulfill({status:409,json:{message:(error as Error).message}})}
 })
})
test.afterEach(async()=>{await db.close()})
async function login(page:Page){
 await page.goto('/app');await expect(page.getByRole('heading',{name:'Sign in to LeadFlow'})).toBeVisible()
 await page.getByLabel('Email',{exact:true}).fill('test@example.com');await page.getByLabel('Password').fill('test-password');await page.getByRole('button',{name:'Sign in',exact:true}).click()
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
 const result=await db.query<{snapshot:{revision:number;data:{leads:unknown[];activities:unknown[]}}}>('select public.load_workspace() as snapshot')
 expect(result.rows[0].snapshot.revision).toBe(1);expect(result.rows[0].snapshot.data.leads).toHaveLength(1);expect(result.rows[0].snapshot.data.activities).toHaveLength(1)
})
test('stale revision does not overwrite another session; load failure can be retried',async({page})=>{
 failLoad=true;await login(page);await expect(page.getByRole('alert')).toContainText('Database unavailable');failLoad=false;await page.getByRole('button',{name:'Retry loading'}).click();await expect(page.getByLabel('Search leads')).toBeVisible()
 await db.query('select public.save_workspace($1::jsonb,0,$2::uuid)',[JSON.stringify(sampleData()),crypto.randomUUID()])
 await add(page);await expect(page.getByRole('alert')).toContainText('another session');await page.getByRole('button',{name:'Reload workspace and discard attempt'}).click();await expect(page.getByLabel('Status for Olivia Bennett')).toBeVisible();await expect(page.getByLabel('Status for M2 Prospect')).toHaveCount(0)
})
test('mobile search, task filters and malformed legacy data remain usable',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.addInitScript(()=>localStorage.setItem('leadflow.demo.v1','broken'));await login(page);await expect(page.getByRole('alert')).toContainText('left untouched');await seed(page)
 await page.getByLabel('Search leads').fill('no-match');await expect(page.getByRole('heading',{name:'No leads found'})).toBeVisible();await page.getByRole('button',{name:'Clear filters'}).click()
 await page.getByRole('navigation').getByRole('button',{name:'Follow-ups'}).click();await page.getByLabel('Filter tasks').selectOption('Completed');await expect(page.getByRole('checkbox')).toHaveCount(0)
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await page.evaluate(()=>localStorage.getItem('leadflow.demo.v1'))).toBe('broken')
})
