import { test, expect, type Page } from '@playwright/test'
import { createHarness, actor } from './support/m3'
import { apiOrigin, mockSupabase } from './support/supabase'
let h:Awaited<ReturnType<typeof createHarness>>
let loseResponse=false
test.beforeEach(async({page})=>{
 h=await createHarness();loseResponse=false
 // Only the external CAPTCHA UI/service and email service are simulated.
 await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*',route=>route.fulfill({contentType:'application/javascript',body:`window.turnstile={render(el,options){el.innerHTML='<span>Test verification complete</span>';setTimeout(()=>options.callback('test-token'),0);return 'widget'},remove(){},reset(){}};`}))
 await mockSupabase(page,h.db,{users:[{id:actor,email:'owner@example.com',password:'test-password'}]})
 await page.route(`${apiOrigin}/functions/v1/**`,async route=>{
  const req=route.request(),url=req.url()
  const response=await h.handler(new Request(url,{method:req.method(),headers:req.headers(),body:req.method()==='POST'?req.postData():undefined}))
  if(loseResponse&&response.ok&&req.method()==='POST'){loseResponse=false;return route.abort('failed')}
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
})
test.afterEach(async()=>{await h.db.close()})
async function fill(page:Page){
 await page.getByLabel('Your name *').fill('  Website Prospect  ');await page.getByLabel('Email address *').fill('PUBLIC@EXAMPLE.COM');await page.getByLabel('Company (optional)').fill('Example Studio');await page.getByLabel('What can we help with? *').selectOption('Web development');await page.getByLabel('Tell us a little more *').fill('A fictional website inquiry for verification.')
}
test('public form through Edge handler to database, private dashboard and refresh',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('/inquiry');await expect(page.getByRole('heading',{name:'A good project starts with a conversation.'})).toBeVisible();await expect(page.getByRole('button',{name:'Sign out'})).toHaveCount(0)
 await fill(page);await page.getByRole('button',{name:'Send inquiry'}).click();await expect(page.getByRole('heading',{name:'Thanks for reaching out.'})).toBeVisible()
 const leads=await h.db.query<{email:string;source:string}>('select email,source from public.leads');expect(leads.rows).toEqual([{email:'public@example.com',source:'Website'}]);expect(h.state.accepted.size).toBe(1)
 await page.goto('/app');await expect(page.getByRole('heading',{name:'Sign in to LeadFlow'})).toBeVisible();await expect(page.getByLabel('Search leads')).toHaveCount(0)
 await page.getByLabel('Email',{exact:true}).fill('owner@example.com');await page.getByLabel('Password').fill('test-password');await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await expect(page.getByLabel('Status for Website Prospect')).toHaveValue('New');await page.reload();await expect(page.getByLabel('Status for Website Prospect')).toHaveValue('New')
 await page.getByLabel('View Website Prospect').click();await expect(page.getByRole('dialog')).toContainText('Website inquiry received (example-website)');await expect(page.getByRole('dialog')).toContainText('A fictional website inquiry')
 expect(errors).toEqual([])
})
test('lost response, repeat submission and provider outage keep exactly one lead',async({page})=>{
 h.state.providerStatus=500;loseResponse=true;await page.goto('/inquiry');await fill(page);await page.getByRole('button',{name:'Send inquiry'}).click();await expect(page.getByRole('alert')).toContainText('could not confirm')
 await page.getByRole('button',{name:'Send inquiry'}).click();await expect(page.getByRole('heading',{name:'Thanks for reaching out.'})).toBeVisible()
 expect((await h.db.query('select * from public.leads')).rows).toHaveLength(1);expect((await h.db.query('select * from leadflow_private.notification_outbox')).rows).toHaveLength(1)
 expect((await h.db.query<{status:string}>('select status from leadflow_private.notification_outbox')).rows[0].status).toBe('pending')
 await expect(page.getByText('email sent',{exact:false})).toHaveCount(0)
 // Reload loses form fields, but the saved hash/reference still deduplicates the same inquiry.
 await page.reload();await fill(page);await page.getByRole('button',{name:'Send inquiry'}).click();await expect(page.getByRole('heading',{name:'Thanks for reaching out.'})).toBeVisible();expect((await h.db.query('select * from public.leads')).rows).toHaveLength(1)
})
test('mobile validation, CAPTCHA rejection and recovery',async({page})=>{
 await page.setViewportSize({width:360,height:800});await page.goto('/inquiry');await fill(page)
 await page.getByLabel('Phone (optional)').fill('not a phone');await page.getByRole('button',{name:'Send inquiry'}).click();await expect(page.getByRole('alert')).toContainText('valid phone')
 await page.getByLabel('Phone (optional)').fill('');h.state.captchaSuccess=false;await page.getByRole('button',{name:'Send inquiry'}).click();await expect(page.getByRole('alert')).toContainText('Verification expired or failed')
 expect((await h.db.query('select * from public.leads')).rows).toHaveLength(0)
 h.state.captchaSuccess=true;await page.getByRole('button',{name:'Send inquiry'}).click();await expect(page.getByRole('heading',{name:'Thanks for reaching out.'})).toBeVisible()
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.screenshot({path:'test-results/inquiry-mobile-success.png',fullPage:true})
})
test('public inquiry layout fits desktop and mobile',async({page})=>{
 for(const width of [360,1440]){await page.setViewportSize({width,height:1000});await page.goto('/inquiry');await expect(page.getByRole('button',{name:'Send inquiry'})).toBeEnabled();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/inquiry-${width}.png`,fullPage:true})}
})
