import { test, expect, type Page } from '@playwright/test'
import { createHarness, actor } from './support/m3'
let h:Awaited<ReturnType<typeof createHarness>>
let unavailable=false
const jwt=[{alg:'HS256',typ:'JWT'},{sub:actor,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'test'].map(x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64url')).join('.')
const user={id:actor,email:'owner@example.com',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()}
test.beforeEach(async({page})=>{
 h=await createHarness();unavailable=false
 await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*',route=>route.fulfill({contentType:'application/javascript',body:`window.turnstile={render(){return 'test-widget'},remove(){},reset(){}};`}))
 await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{(window as unknown as {copied:string}).copied=value}}}))
 await page.route('http://127.0.0.1:54329/**',async route=>{
  const req=route.request(),url=req.url()
  if(url.includes('/auth/v1/token'))return route.fulfill({json:{access_token:jwt,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,user}})
  if(url.includes('/auth/v1/user'))return route.fulfill({json:user})
  const name=url.split('/').at(-1)!
  if(!['load_workspace','integration_overview','verify_integration_receipt','revoke_integration'].includes(name))return route.fulfill({status:404,json:{error:'Unexpected endpoint'}})
  if(name==='integration_overview'&&unavailable)return route.fulfill({status:500,json:{message:'Unavailable'}})
  const args=req.postDataJSON()??{},values=name==='verify_integration_receipt'?[args.submission_id]:name==='revoke_integration'?[args.credential_id]:[]
  try{const result=await h.db.query<{result:unknown}>(`select public.${name}(${values.map((_,i)=>`$${i+1}`).join(',')}) as result`,values);return route.fulfill({json:result.rows[0].result})}
  catch(error){return route.fulfill({status:400,json:{message:(error as Error).message}})}
 })
})
test.afterEach(async()=>{await h.db.close()})
async function openHub(page:Page){
 await page.goto('/');await page.getByLabel('Email',{exact:true}).fill('owner@example.com');await page.getByLabel('Password').fill('test-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Integrations',exact:true}).click();await expect(page.getByRole('button',{name:'Refresh connection evidence'})).toBeEnabled()
}
test('directory filters, install snippets, copy feedback and responsive layouts',async({page},testInfo)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 await openHub(page);await expect(page.locator('.integration-card')).toHaveCount(13)
 await page.getByRole('button',{name:'Automation',exact:true}).click();await expect(page.locator('.integration-card')).toHaveCount(3)
 await page.getByLabel('Search integrations').fill('no such platform');await expect(page.getByText('No integrations found')).toBeVisible();await page.getByRole('button',{name:'Clear integration filters'}).click()
 for(const width of [360,768,1440]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath(`integrations-${width}.png`),fullPage:true})}
 await page.getByRole('button',{name:'View WordPress guide'}).click();await expect(page.getByRole('heading',{name:'Install on your website'})).toBeVisible()
 await expect(page.getByLabel('Hosted form URL',{exact:true})).toHaveValue(new URL('/inquiry',page.url()).href)
 await page.getByRole('button',{name:'Preview form',exact:true}).click()
 await expect(page.frameLocator('iframe[title="LeadFlow inquiry form preview"]').getByRole('heading',{name:'A good project starts with a conversation.'})).toBeVisible()
 await page.getByRole('button',{name:'Hide preview',exact:true}).click()
 await page.getByRole('button',{name:'Copy HTML embed',exact:true}).click();await expect(page.getByText('Copied to clipboard.')).toBeVisible()
 expect(await page.evaluate(()=>(window as unknown as {copied:string}).copied)).toContain('/inquiry')
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied')}}}))
 await page.getByRole('button',{name:'Copy React embed',exact:true}).click();await expect(page.getByText('Copy unavailable.',{exact:false})).toBeVisible()
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('install-mobile.png'),fullPage:true})
 expect(errors).toEqual([])
})
test('real receipt verification is scoped and email evidence does not claim delivery',async({page})=>{
 const reference=crypto.randomUUID()
 const response=await h.handler(new Request('http://127.0.0.1:54329/functions/v1/submit-inquiry',{method:'POST',headers:{Origin:'http://127.0.0.1:5175','Content-Type':'application/json'},body:JSON.stringify({requestId:reference,token:'test-token',inquiry:{name:'Test Prospect',email:'test@example.com',service:'Consulting',message:'Fictional inquiry.'}})}))
 expect(response.status).toBe(200)
 await openHub(page);await page.getByRole('button',{name:'View Hosted inquiry form guide'}).click();await page.getByLabel('Submission reference').fill(crypto.randomUUID());await page.getByRole('button',{name:'Verify in this workspace'}).click();await expect(page.getByRole('alert')).toContainText('No matching inquiry')
 await page.getByLabel('Submission reference').fill(reference);await page.getByRole('button',{name:'Verify in this workspace'}).click();await expect(page.getByText('Website inquiry verified',{exact:false})).toBeVisible();await expect(page.locator('.integration-detail-heading .integration-status')).toHaveText('Connected')
 await page.getByRole('button',{name:'All integrations',exact:false}).click();await page.getByRole('button',{name:'View Email notifications guide'}).click();await expect(page.getByText('1 provider-accepted')).toBeVisible();await expect(page.getByText('“Accepted” is not inbox delivery.',{exact:false})).toBeVisible()
})
test('credential evidence and confirmed revocation, unavailable metadata recovery',async({page})=>{
 await h.db.query("insert into leadflow_private.integration_keys(owner_id,label,provider,token_hash,notification_from,notification_to,last_used_at) values($1,'Test workflow','n8n',$2,'LeadFlow <sender@example.com>','owner@example.com',now())",[actor,'a'.repeat(64)])
 await openHub(page);await expect(page.locator('.integration-card').filter({has:page.getByRole('heading',{name:'Lead submission API',exact:true})})).toContainText('Connected')
 await expect(page.locator('.integration-card').filter({has:page.getByRole('heading',{name:'n8n',exact:true})})).toContainText('Available')
 await page.getByRole('button',{name:'View Lead submission API guide'}).click();await page.getByRole('button',{name:'Revoke',exact:true}).click();await page.getByRole('button',{name:'Confirm revoke'}).click();await expect(page.locator('.integration-credential')).toContainText('Revoked');await expect(page.locator('.integration-detail-heading .integration-status')).toHaveText('Needs configuration')
 await page.getByRole('button',{name:'All integrations',exact:false}).click();unavailable=true;await page.getByRole('button',{name:'Refresh connection evidence'}).click();await expect(page.getByRole('alert')).toContainText('Connection evidence is unavailable');unavailable=false;await page.getByRole('button',{name:'Retry connection check'}).click();await expect(page.getByRole('alert')).toHaveCount(0)
})


