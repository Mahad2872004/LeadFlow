import { test, expect } from '@playwright/test'
import { marketingPages } from '../src/marketing/content'
const routes=Object.keys(marketingPages)
test('all public pages, metadata and internal destinations work without authentication',async({page})=>{
 const errors:string[]=[],privateRequests:string[]=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/rest/v1/**',route=>{privateRequests.push(route.request().url());return route.abort()})
 const allowed=new Set([...routes,'/app','/login','/inquiry'])
 for(const path of routes){
  await page.goto(path)
  await expect(page.locator('main h1')).toHaveCount(1)
  await expect(page.locator('main h1')).toBeVisible()
  await expect(page).toHaveTitle(marketingPages[path as keyof typeof marketingPages].title)
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content',marketingPages[path as keyof typeof marketingPages].description)
  const links=await page.locator('.marketing a').evaluateAll(nodes=>nodes.map(node=>({href:(node as HTMLAnchorElement).href,text:node.textContent?.trim()})))
  for(const link of links){const url=new URL(link.href);expect(allowed.has(url.pathname),`${path}: ${link.text} → ${url.pathname}`).toBe(true);if(url.hash&&url.pathname===path)await expect(page.locator(`[id="${url.hash.slice(1)}"]`)).toHaveCount(1)}
  await page.reload();await expect(page.locator('main h1')).toBeVisible()
 }
 expect(privateRequests).toEqual([]);expect(errors).toEqual([])
})
test('navigation, preview, FAQs, access request and protected entry points',async({page})=>{
 await page.goto('/')
 await page.getByRole('link',{name:'Take a closer look'}).click();await expect(page).toHaveURL(/#product-preview$/)
 await page.getByRole('button',{name:'Follow-ups preview'}).click();await expect(page.getByText('Check in on the website brief')).toBeVisible()
 await page.getByRole('button',{name:'Pipeline preview'}).click();await expect(page.getByText('Olivia Bennett')).toBeVisible()
 await page.getByRole('link',{name:'Features',exact:true}).first().click();await expect(page).toHaveURL(/\/features$/)
 await page.getByRole('link',{name:'FAQ',exact:true}).click();await page.locator('summary').filter({hasText:'Can my team share a workspace?'}).click();await expect(page.getByText('Shared workspaces, team invitations, and role-based collaboration are planned.',{exact:false})).toBeVisible()
 await page.getByRole('link',{name:'Request access',exact:true}).first().click();await expect(page).toHaveURL(/\/signup$/);await expect(page.getByText('No account is created automatically.',{exact:false})).toBeVisible()
 await page.route('https://challenges.cloudflare.com/**',route=>route.fulfill({contentType:'application/javascript',body:'window.turnstile={render(){return "test"},remove(){}}'}))
 await page.getByRole('link',{name:'Send an access inquiry'}).click();await expect(page).toHaveURL(/\/inquiry\?topic=leadflow-access$/)
 await expect(page.getByLabel('Tell us a little more *')).toHaveValue(/request access to LeadFlow/)
 for(const path of ['/app','/login','/app/integrations']){await page.goto(path);await expect(page.getByRole('heading',{name:'Sign in to LeadFlow'})).toBeVisible();await expect(page.getByRole('button',{name:'Add lead'})).toHaveCount(0);await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content','noindex,nofollow')}
 await page.getByRole('link',{name:'Back to LeadFlow',exact:false}).click();await expect(page).toHaveURL(/\/$/)
 await page.goto('/missing-page');await expect(page.getByText('404 · PAGE NOT FOUND')).toBeVisible()
})
test('mobile menu, keyboard and responsive pages',async({page},testInfo)=>{
 await page.emulateMedia({reducedMotion:'reduce'})
 for(const width of [360,768,1440]){
  await page.setViewportSize({width,height:1000})
  for(const path of routes){await page.goto(path);await expect(page.locator('main h1')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${path} at ${width}`).toBe(true)}
  await page.goto('/');await expect(page.locator('main h1')).toBeVisible();await page.screenshot({path:testInfo.outputPath(`marketing-home-${width}.png`),fullPage:true})
 }
 await page.setViewportSize({width:360,height:800});await page.goto('/')
 await expect(page.locator('main h1')).toBeVisible()
 await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Skip to content'})).toBeFocused()
 await page.getByRole('button',{name:'Open navigation'}).click();await expect(page.getByRole('navigation',{name:'Website navigation'})).toBeVisible()
 await page.getByRole('navigation').getByRole('link',{name:'Pricing',exact:true}).focus();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Open navigation'})).toBeFocused();await expect(page.getByRole('navigation')).toBeHidden()
 await page.getByRole('button',{name:'Open navigation'}).click();await page.getByRole('navigation').getByRole('link',{name:'Pricing',exact:true}).click();await expect(page.getByText('Provisional · No checkout or billing is active.')).toBeVisible();await expect(page.getByRole('navigation')).toBeHidden()
})
