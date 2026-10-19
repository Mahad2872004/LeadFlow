import { test, expect, type Page } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './support/database'
import { apiOrigin, mockSupabase, signIn, type SupabaseMockOptions } from './support/supabase'
const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com',password:'test-password'}
const teammate={id:'22222222-2222-4222-8222-222222222222',email:'teammate@example.com',password:'test-password'}
let db:PGlite
test.afterEach(async()=>{await db?.close()})
/** Accounts in `existing` predate the workspace migration and so already have a personal workspace. */
async function start(page:Page,options:SupabaseMockOptions={},existing=[owner]){
 db=await createDatabase(existing.map(user=>user.id))
 for(const user of existing)await db.query('update auth.users set email=$2 where id=$1',[user.id,user.email])
 return mockSupabase(page,db,{users:existing,...options})
}
const switcher=(page:Page)=>page.getByRole('button',{name:/^Switch workspace/})
const noHorizontalScroll=(page:Page)=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)
async function addLead(page:Page,name:string){
 await page.getByRole('button',{name:'Add lead'}).first().click()
 await page.getByLabel('Full name').fill(name);await page.getByLabel('Email *',{exact:true}).fill(`${name.toLowerCase().replace(/\W+/g,'.')}@example.com`)
 await page.getByLabel('Service interest *').selectOption('Consulting');await page.getByLabel('Source *').selectOption('Referral')
 await page.getByRole('button',{name:'Create lead',exact:true}).click();await expect(page.getByLabel(`Status for ${name}`)).toBeVisible()
}
async function chooseWorkspace(page:Page,name:string){
 await switcher(page).click();await page.getByRole('button',{name:new RegExp(`^.{0,3}${name}`)}).click()
 await expect(switcher(page)).toHaveAccessibleName(`Switch workspace. Current workspace: ${name}`)
}

test('sign-up with email confirmation, resend, confirmation and first sign-in',async({page},testInfo)=>{
 const supabase=await start(page,{confirmEmail:true},[])
 await page.clock.install()
 await page.goto('/signup');await expect(page.getByRole('heading',{name:'Create your LeadFlow account'})).toBeVisible()
 await page.screenshot({path:testInfo.outputPath('signup-desktop.png')})
 await expect(page.getByText('We’ll email you a link to confirm your address.',{exact:false})).toBeVisible()
 await page.getByRole('button',{name:'Create account'}).click()
 await expect(page.getByText('Enter a valid email address.')).toBeVisible();await expect(page.getByText('Use at least 8 characters.')).toBeVisible()
 await expect(page.getByLabel('Email',{exact:true})).toBeFocused()
 await page.getByLabel('Email',{exact:true}).fill('new@example.com');await page.getByLabel('Password',{exact:true}).fill('long-password');await page.getByLabel('Confirm password').fill('different')
 await page.getByRole('button',{name:'Create account'}).click();await expect(page.getByText('The passwords don’t match.')).toBeVisible()
 await page.getByLabel('Confirm password').fill('long-password');await page.getByRole('button',{name:'Create account'}).click()
 await expect(page.getByRole('heading',{name:'Check your email'})).toBeVisible();await expect(page.getByText('new@example.com')).toBeVisible()
 await page.screenshot({path:testInfo.outputPath('check-email-desktop.png')})
 expect(supabase.signupRedirects).toEqual([new URL('/app',page.url()).href])
 await expect(page.getByRole('button',{name:/Resend email in \d+s/})).toBeDisabled()
 await page.clock.fastForward('01:01');await page.getByRole('button',{name:'Resend email'}).click()
 await expect(page.getByText('We sent another confirmation email.')).toBeVisible();expect(supabase.resent).toEqual(['new@example.com'])
 // Signing in before confirming explains what to do and can send a new link.
 await page.getByRole('link',{name:'Back to sign in'}).click();await expect(page).toHaveURL(/\/login$/)
 await signIn(page,'new@example.com','long-password')
 await expect(page.getByRole('alert')).toContainText('Confirm your email address first')
 await page.getByRole('button',{name:'Send a new confirmation link'}).click();await expect(page.getByText('We sent a new confirmation link to new@example.com.')).toBeVisible()
 supabase.confirm('new@example.com');await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await expect(page.getByRole('heading',{name:'Create your first workspace'})).toBeVisible();await expect(page).toHaveURL(/\/app$/)
})

test('sign-up without confirmation goes straight to onboarding; a lost response creates one workspace',async({page},testInfo)=>{
 let lose=true
 const supabase=await start(page,{afterRpc:(name,reply)=>{if(name==='create_workspace'&&lose&&reply.status===200){lose=false;return {status:0}}}},[])
 await page.goto('/signup');await expect(page.getByText('We’ll email you a link',{exact:false})).toHaveCount(0)
 await page.getByLabel('Email',{exact:true}).fill('founder@example.com');await page.getByLabel('Password',{exact:true}).fill('long-password');await page.getByLabel('Confirm password').fill('long-password')
 await page.getByRole('button',{name:'Create account'}).click()
 await expect(page.getByRole('heading',{name:'Create your first workspace'})).toBeVisible();await expect(page.getByText('founder@example.com')).toBeVisible()
 await page.screenshot({path:testInfo.outputPath('onboarding-desktop.png')})
 await page.getByRole('button',{name:'Create workspace'}).click();await expect(page.getByText('Enter a workspace name.')).toBeVisible();await expect(page.getByLabel('Workspace name')).toBeFocused()
 await page.getByLabel('Workspace name').fill('  Northline Studio  ');await page.getByLabel('Business type').selectOption('Design studio')
 await page.getByRole('button',{name:'Create workspace'}).click()
 await expect(page.getByRole('alert')).toContainText('We couldn’t reach LeadFlow');await expect(page.getByRole('alert')).toContainText('won’t create a duplicate')
 await page.getByRole('button',{name:'Create workspace'}).click()
 await expect(switcher(page)).toHaveAccessibleName('Switch workspace. Current workspace: Northline Studio')
 await expect(page.getByRole('status').filter({hasText:'Northline Studio is ready.'})).toBeVisible()
 await expect(page.getByRole('heading',{name:'Northline Studio is ready for its first lead'})).toBeVisible()
 const [user]=[...supabase.users.values()]
 expect(await supabase.admin('select name,creation_request_id is not null as tracked from public.workspaces where owner_id=$1',[user.id])).toEqual([{name:'Northline Studio',tracked:true}])
 expect(supabase.rpcCalls.filter(name=>name==='create_workspace')).toHaveLength(2)
 await addLead(page,'First Prospect');await page.reload();await expect(page.getByLabel('Status for First Prospect')).toBeVisible()
})

test('multiple workspaces: create, switch without reloading, keep data separate, remember the choice',async({page},testInfo)=>{
 const supabase=await start(page)
 await page.goto('/app');await expect(page).toHaveURL(/\/login$/);await signIn(page,owner.email)
 await expect(switcher(page)).toHaveAccessibleName('Switch workspace. Current workspace: Personal workspace')
 await page.evaluate(()=>{(window as unknown as {stillHere:boolean}).stillHere=true})
 await addLead(page,'Personal Prospect')
 await switcher(page).click();await page.getByRole('button',{name:'Create workspace'}).click()
 const dialog=page.getByRole('dialog',{name:'Create a workspace'});await dialog.getByLabel('Workspace name').fill('Agency Team');await dialog.getByLabel('Business type').selectOption('Marketing agency');await dialog.getByRole('button',{name:'Create workspace'}).click()
 await expect(dialog).toHaveCount(0);await expect(switcher(page)).toHaveAccessibleName('Switch workspace. Current workspace: Agency Team')
 await expect(page.getByLabel('Status for Personal Prospect')).toHaveCount(0);await addLead(page,'Team Prospect')
 await page.getByRole('navigation').getByRole('button',{name:'Leads'}).click()
 await chooseWorkspace(page,'Personal workspace')
 await expect(page.getByRole('status').filter({hasText:'Switched to Personal workspace.'})).toBeVisible()
 await expect(page.getByRole('heading',{name:'Leads',exact:true})).toBeVisible()
 await expect(page.getByLabel('Status for Personal Prospect')).toBeVisible();await expect(page.getByLabel('Status for Team Prospect')).toHaveCount(0)
 expect(await page.evaluate(()=>(window as unknown as {stillHere?:boolean}).stillHere)).toBe(true)
 // Keyboard: the menu opens on Enter, arrows move between options, Escape closes and returns focus.
 await switcher(page).focus();await page.keyboard.press('Enter')
 await expect(page.getByRole('button',{name:/Personal workspace/}).last()).toBeFocused()
 await page.keyboard.press('ArrowDown');await expect(page.getByRole('button',{name:/Agency Team/})).toBeFocused()
 await page.screenshot({path:testInfo.outputPath('switcher-desktop.png')})
 await page.keyboard.press('End');await expect(page.getByRole('button',{name:'Workspace settings'})).toBeFocused()
 await page.keyboard.press('Escape');await expect(switcher(page)).toBeFocused();await expect(page.getByRole('button',{name:'Workspace settings'})).toHaveCount(0)
 // Session and workspace choice survive a reload; data stayed in the right workspace.
 await chooseWorkspace(page,'Agency Team');await page.reload()
 await expect(switcher(page)).toHaveAccessibleName('Switch workspace. Current workspace: Agency Team');await expect(page.getByLabel('Status for Team Prospect')).toBeVisible()
 expect(await supabase.admin('select w.name,l.name as lead from public.leads l join public.workspaces w on w.id=l.workspace_id order by 1')).toEqual([{name:'Agency Team',lead:'Team Prospect'},{name:'Personal workspace',lead:'Personal Prospect'}])
 // Sign out ends the session; protected pages send you back to sign in.
 await page.getByRole('button',{name:'Sign out'}).click();await expect(page).toHaveURL(/\/login$/)
 await page.reload();await expect(page.getByRole('heading',{name:'Sign in to LeadFlow'})).toBeVisible()
 await page.goto('/app/settings');await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fsettings$/)
 await signIn(page,owner.email);await expect(page).toHaveURL(/\/app\/settings$/);await expect(switcher(page)).toBeVisible()
})

test('settings: owners edit details; members are read-only and the database refuses their edits',async({page})=>{
 const supabase=await start(page,{},[owner,teammate])
 const [{id:shared}]=await supabase.queryAs<{id:string}>(owner.id,"select public.create_workspace('Shared Studio','Consultancy',null) as id")
 await supabase.queryAs(owner.id,"select public.set_workspace_member($1,$2,'member')",[shared,teammate.id])
 await supabase.admin("insert into leadflow_private.integration_keys(workspace_id,label,provider,token_hash,notification_from,notification_to) values($1,'Shared webhook','webhook',$2,'LeadFlow <n@example.com>','team@example.com')",[shared,'b'.repeat(64)])
 await page.goto('/login');await signIn(page,owner.email);await chooseWorkspace(page,'Shared Studio')
 await page.getByRole('navigation').getByRole('button',{name:'Settings'}).click();await expect(page.getByRole('heading',{name:'Workspace settings'})).toBeVisible()
 const members=page.getByRole('region',{name:'Members'})
 await expect(members.getByRole('listitem')).toHaveCount(2);await expect(members).toContainText('owner@example.com');await expect(members).toContainText('teammate@example.com');await expect(members.getByText('You',{exact:true})).toHaveCount(1)
 await expect(page.getByText('Team invitations aren’t available yet.')).toBeVisible();await expect(page.getByRole('button',{name:/invite/i})).toHaveCount(0)
 const details=page.getByRole('region',{name:'Workspace details'})
 await expect(details.getByRole('button',{name:'Save changes'})).toBeDisabled()
 await details.getByLabel('Workspace name').fill('');await details.getByRole('button',{name:'Save changes'}).click();await expect(details.getByText('Enter a workspace name.')).toBeVisible()
 await details.getByLabel('Workspace name').fill('Shared Studio HQ');await details.getByLabel('Business type').selectOption('Design studio');await details.getByLabel('Time zone').selectOption('Europe/London')
 await details.getByRole('button',{name:'Save changes'}).click();await expect(details.getByText('Workspace details saved.')).toBeVisible()
 await expect(switcher(page)).toHaveAccessibleName('Switch workspace. Current workspace: Shared Studio HQ')
 expect(await supabase.admin('select w.name,s.business_type,s.timezone from public.workspaces w join public.workspace_settings s on s.workspace_id=w.id where w.id=$1',[shared])).toEqual([{name:'Shared Studio HQ',business_type:'Design studio',timezone:'Europe/London'}])
 await page.getByRole('button',{name:'Sign out'}).click();await signIn(page,teammate.email);await chooseWorkspace(page,'Shared Studio HQ')
 await page.getByRole('navigation').getByRole('button',{name:'Settings'}).click()
 await expect(details.getByLabel('Workspace name')).toBeDisabled();await expect(details.getByRole('button',{name:'Save changes'})).toHaveCount(0)
 await expect(details.getByText('Only owners and admins can change workspace details.')).toBeVisible();await expect(page.getByRole('region',{name:'Your access'})).toContainText('Member')
 await page.getByRole('navigation').getByRole('button',{name:'Integrations'}).click();await page.getByRole('button',{name:'View Lead submission API guide'}).click()
 await expect(page.locator('.integration-credential')).toContainText('Shared webhook');await expect(page.getByText('Owners and admins can revoke')).toBeVisible();await expect(page.getByRole('button',{name:'Revoke',exact:true})).toHaveCount(0)
 // The hidden controls are not the protection: the member's own token is refused by the database.
 const attempt=await page.evaluate(async({apiOrigin,shared,self})=>{
  const key=Object.keys(localStorage).find(name=>/^sb-.*-auth-token$/.test(name))!,token=JSON.parse(localStorage.getItem(key)!).access_token
  const call=(name:string,body:object)=>fetch(`${apiOrigin}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:'test-public-key',Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async response=>({status:response.status,message:(await response.json().catch(()=>({}))).message}))
  return {rename:await call('update_workspace',{target_workspace:shared,workspace_name:'Hijacked'}),promote:await call('set_workspace_member',{target_workspace:shared,target_user:self,member_role:'admin'})}
 },{apiOrigin,shared,self:teammate.id})
 expect(attempt.rename).toEqual({status:403,message:'Your workspace role does not allow this action.'})
 expect(attempt.promote).toEqual({status:403,message:'Your workspace role does not allow this action.'})
 expect(await supabase.admin('select w.name,m.role from public.workspaces w join public.workspace_memberships m on m.workspace_id=w.id where w.id=$1 and m.user_id=$2',[shared,teammate.id])).toEqual([{name:'Shared Studio HQ',role:'member'}])
})

test('unauthorized access and failures: removed membership, tampered workspace choice, open redirects, errors',async({page})=>{
 let failList=true
 // The outage lasts until cleared below (development StrictMode runs the first load twice).
 const supabase=await start(page,{beforeRpc:name=>{if(name==='list_workspaces'&&failList)return {status:503,body:{message:'Service unavailable'}}}},[owner,teammate])
 const [{id:shared}]=await supabase.queryAs<{id:string}>(owner.id,"select public.create_workspace('Owner Only') as id")
 await page.goto('/login?next=https://evil.example/phish');await signIn(page,teammate.email,'wrong-password')
 await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect.')
 // Remembering a workspace the user does not belong to only selects; the database never returns it.
 await page.evaluate(({id,key})=>localStorage.setItem(key,id),{id:shared,key:`leadflow.workspace.${teammate.id}`})
 await signIn(page,teammate.email)
 await expect(page.getByRole('heading',{name:'We couldn’t load your workspaces'})).toBeVisible();await expect(page.getByRole('alert')).toHaveText('Service unavailable')
 failList=false;await page.getByRole('button',{name:'Try again'}).click()
 await expect(page).toHaveURL(/\/app$/);await expect(switcher(page)).toHaveAccessibleName('Switch workspace. Current workspace: Personal workspace')
 await switcher(page).click();await expect(page.getByRole('button',{name:/Owner Only/})).toHaveCount(0);await page.keyboard.press('Escape')
 // Access removed while the workspace is open: the next request is refused and the list recovers.
 await supabase.queryAs(owner.id,"select public.set_workspace_member($1,$2,'member')",[shared,teammate.id])
 await page.getByRole('button',{name:'Sign out'}).click();await signIn(page,teammate.email);await chooseWorkspace(page,'Owner Only')
 await supabase.queryAs(owner.id,'select public.remove_workspace_member($1,$2)',[shared,teammate.id])
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Workspace not found or access denied.')
 await page.getByRole('button',{name:'Refresh workspace list'}).click()
 await expect(switcher(page)).toHaveAccessibleName('Switch workspace. Current workspace: Personal workspace')
})

test('sign-up follows the project configuration when accounts are closed',async({page})=>{
 await start(page,{signupEnabled:false},[])
 await page.goto('/signup');await expect(page.getByRole('heading',{name:'New accounts aren’t open yet'})).toBeVisible()
 await expect(page.getByRole('link',{name:'Send an access inquiry'})).toHaveAttribute('href','/inquiry?topic=leadflow-access')
 await page.evaluate(()=>{(window as unknown as {stillHere:boolean}).stillHere=true})
 await page.getByRole('link',{name:'I already have an account'}).click();await expect(page).toHaveURL(/\/login$/)
 expect(await page.evaluate(()=>(window as unknown as {stillHere?:boolean}).stillHere)).toBe(true)
 // If the settings cannot be read, the form is shown and the server's refusal switches to the same message.
 await page.route(`${apiOrigin}/auth/v1/settings`,route=>route.abort('failed'))
 await page.getByRole('link',{name:'Create an account'}).click();await expect(page.getByRole('heading',{name:'Create your LeadFlow account'})).toBeVisible()
 await page.getByLabel('Email',{exact:true}).fill('new@example.com');await page.getByLabel('Password',{exact:true}).fill('long-password');await page.getByLabel('Confirm password').fill('long-password')
 await page.getByRole('button',{name:'Create account'}).click();await expect(page.getByRole('heading',{name:'New accounts aren’t open yet'})).toBeVisible()
})

test('mobile onboarding, switcher and settings fit small screens',async({page},testInfo)=>{
 await page.setViewportSize({width:360,height:800})
 await start(page,{},[])
 await page.goto('/signup');expect(await noHorizontalScroll(page)).toBe(true)
 await page.getByLabel('Email',{exact:true}).fill('mobile@example.com');await page.getByLabel('Password',{exact:true}).fill('long-password');await page.getByLabel('Confirm password').fill('long-password')
 await page.getByRole('button',{name:'Create account'}).click();await expect(page.getByRole('heading',{name:'Create your first workspace'})).toBeVisible()
 expect(await noHorizontalScroll(page)).toBe(true);await page.screenshot({path:testInfo.outputPath('onboarding-360.png'),fullPage:true})
 await page.getByLabel('Workspace name').fill('A Particularly Long Workspace Name For Small Screens');await page.getByRole('button',{name:'Create workspace'}).click()
 await expect(switcher(page)).toBeVisible();await switcher(page).click();await expect(page.getByRole('button',{name:'Create workspace'})).toBeVisible()
 expect(await noHorizontalScroll(page)).toBe(true);await page.screenshot({path:testInfo.outputPath('switcher-360.png'),fullPage:true})
 await page.getByRole('button',{name:'Workspace settings'}).click();await expect(page.getByRole('heading',{name:'Workspace settings'})).toBeVisible()
 await expect(page.getByRole('region',{name:'Members'}).getByText('mobile@example.com')).toBeVisible()
 // Every main-navigation item stays reachable, and the current page is in view.
 await expect(page.getByRole('navigation').getByRole('button',{name:'Settings'})).toBeInViewport()
 expect(await noHorizontalScroll(page)).toBe(true);await page.screenshot({path:testInfo.outputPath('settings-360.png'),fullPage:true})
 for(const width of [768,1440]){await page.setViewportSize({width,height:900});expect(await noHorizontalScroll(page)).toBe(true);await page.screenshot({path:testInfo.outputPath(`settings-${width}.png`),fullPage:true})}
})
