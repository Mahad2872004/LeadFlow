import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createDatabase, actAs, migrationSql } from '../tests/support/database.ts'
import { createOnboardingHarness, portalRequest } from '../tests/support/onboarding.ts'
// M6A client onboarding: real migration SQL in embedded PostgreSQL, plus the real client-portal and
// onboarding-reminders Edge handlers. Only the email provider is simulated.
const owner='11111111-1111-4111-8111-111111111111', admin='22222222-2222-4222-8222-222222222222', member='33333333-3333-4333-8333-333333333333', outsider='44444444-4444-4444-8444-444444444444'
const W=owner, O=outsider // Personal workspaces use their owner's ID.
const noAccess=/not found or access denied/, roleDenied=/role does not allow|Only workspace owners and admins/, denied=/permission denied/
let db=await createDatabase([owner,admin,member,outsider])
await actAs(db,null,'postgres')
for(const [id,email] of [[owner,'owner@example.com'],[admin,'admin@example.com'],[member,'member@example.com'],[outsider,'outsider@example.com']])await db.query('update auth.users set email=$2 where id=$1',[id,email])
const one=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0]??{})[0]
const as=async(user,sql,params=[])=>{await actAs(db,user);return one(sql,params)}
const op=async(sql,params=[])=>{await actAs(db,null,'postgres');return one(sql,params)}
const fails=async(user,sql,params,pattern)=>{await actAs(db,user);await assert.rejects(()=>db.query(sql,params),pattern)}
const sha=value=>createHash('sha256').update(value).digest('hex')
await as(owner,"select public.set_workspace_member($1,$2,'admin')",[W,admin])
await as(owner,"select public.set_workspace_member($1,$2,'member')",[W,member])
let h=createOnboardingHarness(db)
const portal=async(body,origin)=>{const response=await h.portal(portalRequest(body,origin));return {status:response.status,body:await response.json()}}
const worker=async(secret=h.config.NOTIFICATION_WORKER_SECRET)=>{const response=await h.reminders(new Request('https://worker.test',{method:'POST',headers:{'x-worker-secret':secret}}));return {status:response.status,body:await response.json()}}
const detail=async(request,user=member,workspace=W)=>as(user,'select public.onboarding_request_for($1,$2)',[workspace,request])
const itemNamed=async(request,title)=>(await detail(request)).items.find(item=>item.title===title)
const review=(request,item,decision,note,revision,user=member)=>as(user,'select public.review_onboarding_item($1,$2,$3,$4,$5,$6)',[W,request,item,decision,note,revision])
const setStatus=async(request,transition,user=member,reason=null)=>as(user,'select public.set_onboarding_status($1,$2,$3,$4,$5)',[W,request,transition,(await detail(request,user)).version,reason])
const issue=(request,days=30,replace=true,user=member)=>as(user,'select public.issue_onboarding_link($1,$2,$3,$4)',[W,request,days,replace])
const submit=(token,item,value,revision,isSubmit=true)=>portal({action:'open'===item?'open':'save',token,itemId:item,value,submit:isSubmit,revision})

// 1. Catalog: anonymous callers still execute nothing; the portal and worker functions are service-role only.
await actAs(db,null,'postgres')
const executable=async role=>(await db.query("select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','leadflow_private') and has_function_privilege($1,p.oid,'EXECUTE')",[role])).rows.map(row=>row.fn)
assert.deepEqual(await executable('anon'),[],'Anonymous callers cannot execute any function.')
const memberFunctions=['onboarding_overview_for(uuid)','onboarding_request_for(uuid,uuid)','onboarding_template_for(uuid,uuid)','install_starter_templates(uuid)','save_onboarding_template(uuid,jsonb,integer,uuid)','set_onboarding_template_archived(uuid,uuid,boolean)','create_onboarding_request(uuid,jsonb,uuid)','update_onboarding_request(uuid,uuid,jsonb,integer)','save_onboarding_item(uuid,uuid,jsonb,integer)','remove_onboarding_item(uuid,uuid,uuid,integer)','set_onboarding_status(uuid,uuid,text,integer,text)','review_onboarding_item(uuid,uuid,uuid,text,text,integer)','issue_onboarding_link(uuid,uuid,integer,boolean)','revoke_onboarding_links(uuid,uuid,uuid)','hand_off_onboarding(uuid,uuid,text)']
const serviceFunctions=['portal_open(text)','portal_save_item(text,uuid,jsonb,boolean,integer)','claim_onboarding_reminder(text,text)','finish_onboarding_reminder(uuid,uuid,text,text,text)']
const signedIn=await executable('authenticated')
for(const fn of memberFunctions)assert.ok(signedIn.includes(fn),fn)
for(const fn of serviceFunctions){assert.ok(!signedIn.includes(fn),`${fn} is not for signed-in users`);assert.ok((await executable('service_role')).includes(fn),fn)}
assert.ok(!signedIn.some(fn=>fn.startsWith('leadflow_private.')&&/onboarding|portal/.test(fn)),'Private onboarding helpers are not executable by clients.')
for(const role of ['anon','authenticated']){
  await actAs(db,role==='anon'?null:owner,role)
  for(const table of ['onboarding_templates','onboarding_template_items','onboarding_requests','onboarding_items','onboarding_links','onboarding_reminders','onboarding_events','onboarding_handoffs'])
    await assert.rejects(()=>db.query(`select * from leadflow_private.${table}`),denied,`${role} ${table}`)
  for(const sql of ["select public.portal_open('x')","select public.claim_onboarding_reminder('https://x.test/p','a@b.c')"])await assert.rejects(()=>db.query(sql),denied)
}
assert.equal(await op("select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='leadflow_private' and c.relname like 'onboarding%' and c.relkind='r' and not c.relrowsecurity"),0,'RLS is enabled on every onboarding table.')

// 2. Templates: owners and admins install and edit; installing twice adds nothing; members only read.
await fails(member,'select public.install_starter_templates($1)',[W],roleDenied)
assert.equal(await as(admin,'select public.install_starter_templates($1)',[W]),4)
assert.equal(await as(owner,'select public.install_starter_templates($1)',[W]),0,'Starter templates install once.')
let overview=await as(member,'select public.onboarding_overview_for($1)',[W])
assert.deepEqual(overview.templates.map(t=>t.serviceType).sort(),['email','paid_ads','seo','social'])
const paidTemplate=overview.templates.find(t=>t.serviceType==='paid_ads')
assert.equal(paidTemplate.itemCount,12);assert.equal(paidTemplate.requiredCount,11)
const paid=await as(member,'select public.onboarding_template_for($1,$2)',[W,paidTemplate.id])
assert.ok(paid.items.some(i=>i.kind==='access'&&/Never send passwords/.test(i.guidance)),'Access items point to provider sharing, never passwords.')
assert.ok(!JSON.stringify(paid).match(/"kind":"(password|secret)"/))
const customRequest=crypto.randomUUID(),customDefinition={name:'Local SEO sprint',serviceType:'seo',description:'Short engagement',items:[{title:'Locations',kind:'text'},{title:'Tone',kind:'choice',options:['Formal','Friendly'],required:false}]}
await fails(member,'select public.save_onboarding_template($1,$2,null,$3)',[W,JSON.stringify(customDefinition),customRequest],roleDenied)
const custom=await as(admin,'select public.save_onboarding_template($1,$2,null,$3)',[W,JSON.stringify(customDefinition),customRequest])
assert.deepEqual(await as(admin,'select public.save_onboarding_template($1,$2,null,$3)',[W,JSON.stringify(customDefinition),customRequest]),custom,'A retried template creation returns the same template.')
await fails(admin,'select public.save_onboarding_template($1,$2,null,null)',[W,JSON.stringify({...customDefinition,items:[{title:'Bad',kind:'choice',options:['Only one']}]})],/2 to 20 options/)
await fails(admin,'select public.save_onboarding_template($1,$2,null,null)',[W,JSON.stringify({...customDefinition,items:[{title:'Bad',kind:'password'}]})],/Choose a type/)
await fails(admin,'select public.save_onboarding_template($1,$2,$3,null)',[W,JSON.stringify({...customDefinition,id:custom.id}),custom.version+1],/changed in another session/)
await fails(outsider,'select public.onboarding_template_for($1,$2)',[W,custom.id],noAccess)
await fails(outsider,'select public.onboarding_template_for($1,$2)',[O,custom.id],/Template not found/)

// 3. Requests: created from a template by any member, idempotently; customising never changes the template.
const createId=crypto.randomUUID(),details={title:'Acme spring launch',clientName:'Acme Outdoor',contactName:'Robin',contactEmail:'Robin@Acme.example',templateId:paidTemplate.id,dueDate:'2026-11-15',startDate:'2026-11-01',targetKickoffDate:'2026-11-20',internalNote:'AGENCY-ONLY NOTE'}
const acme=await as(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify(details),createId])
assert.equal(await as(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify(details),createId]),acme,'A retried creation returns the same request.')
await fails(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify({...details,title:'Other'}),createId],/already created a different/)
let acmeDetail=await detail(acme)
assert.equal(acmeDetail.items.length,12);assert.equal(acmeDetail.status,'draft');assert.equal(acmeDetail.serviceType,'paid_ads');assert.equal(acmeDetail.contactEmail,'robin@acme.example');assert.equal(acmeDetail.ownerId,member)
await as(member,'select public.save_onboarding_item($1,$2,$3,$4)',[W,acme,JSON.stringify({title:'Pixel installed on checkout',kind:'access',required:true,internalNote:'Check GTM container'}),acmeDetail.version])
acmeDetail=await detail(acme);const pixel=acmeDetail.items.find(i=>i.title==='Pixel installed on checkout')
assert.equal(acmeDetail.items.length,13);assert.equal((await as(member,'select public.onboarding_template_for($1,$2)',[W,paidTemplate.id])).items.length,12,'Customising a request leaves the template unchanged.')
const templateEdit=await as(admin,'select public.onboarding_template_for($1,$2)',[W,paidTemplate.id])
await as(admin,'select public.save_onboarding_template($1,$2,$3,null)',[W,JSON.stringify({...templateEdit,items:templateEdit.items.slice(0,3)}),templateEdit.version])
assert.equal((await detail(acme)).items.length,13,'Editing a template leaves existing requests unchanged.')
await as(admin,'select public.set_onboarding_template_archived($1,$2,true)',[W,custom.id])
await fails(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify({title:'X',clientName:'Y',templateId:custom.id}),crypto.randomUUID()],/Template not found/)
await fails(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify({title:'X',clientName:'Y',ownerId:outsider}),crypto.randomUUID()],/owner from this workspace/)
await fails(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify({title:'X',clientName:'Y',secretField:1}),crypto.randomUUID()],/Unknown request field/)
await fails(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify({title:'X',clientName:'Y',startDate:'2026-12-01',targetKickoffDate:'2026-11-01'}),crypto.randomUUID()],/cannot be before/)
await fails(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify({title:'X',clientName:'Y',dueDate:'2026-02-30'}),crypto.randomUUID()],/valid calendar date/)

// 4. Workspace isolation: a request ID from one workspace is unusable from any other.
const outsiderRequest=await as(outsider,'select public.create_onboarding_request($1,$2,$3)',[O,JSON.stringify({title:'Outsider project',clientName:'Other client'}),crypto.randomUUID()])
for(const [sql,params] of [['select public.onboarding_request_for($1,$2)',[W,acme]],['select public.onboarding_overview_for($1)',[W]],['select public.issue_onboarding_link($1,$2,30,true)',[W,acme]],['select public.hand_off_onboarding($1,$2,null)',[W,acme]],["select public.review_onboarding_item($1,$2,$3,'accept','x',1)",[W,acme,pixel.id]]])
  await fails(outsider,sql,params,noAccess)
for(const [sql,params] of [['select public.onboarding_request_for($1,$2)',[O,acme]],['select public.issue_onboarding_link($1,$2,30,true)',[O,acme]],["select public.set_onboarding_status($1,$2,'pause',1,null)",[O,acme]]])
  await fails(outsider,sql,params,/not found in this workspace/)
await fails(member,'select public.onboarding_request_for($1,$2)',[W,outsiderRequest],/not found in this workspace/)
assert.deepEqual((await as(outsider,'select public.onboarding_overview_for($1)',[O])).requests.map(r=>r.title),['Outsider project'])
assert.ok(!(await as(member,'select public.onboarding_overview_for($1)',[W])).requests.some(r=>r.title==='Outsider project'))
await fails(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify({title:'X',clientName:'Y',templateId:custom.id.replace(/./,'0')}),crypto.randomUUID()],/Template not found/)

// 5. Lifecycle rules and optimistic concurrency.
await fails(member,"select public.set_onboarding_status($1,$2,'pause',$3,null)",[W,acme,acmeDetail.version],/A draft request cannot be paused/)
await fails(member,"select public.set_onboarding_status($1,$2,'activate',$3,null)",[W,acme,acmeDetail.version-1],/changed in another session/)
const empty=await as(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify({title:'Blank',clientName:'Blank client'}),crypto.randomUUID()])
await fails(member,"select public.set_onboarding_status($1,$2,'activate',1,null)",[W,empty],/at least one checklist item/)
await fails(member,"select public.set_onboarding_status($1,$2,'cancel',1,null)",[W,empty],roleDenied)
assert.equal((await as(admin,"select public.set_onboarding_status($1,$2,'cancel',1,'Client went elsewhere')",[W,empty])).status,'cancelled')
assert.equal((await as(admin,"select public.set_onboarding_status($1,$2,'cancel',1,null)",[W,empty])).status,'cancelled','Repeating a completed change is a no-op.')
await fails(member,"select public.set_onboarding_status($1,$2,'activate',2,null)",[W,empty],/cancelled request cannot be opened/)
await fails(member,"select public.update_onboarding_request($1,$2,'{\"title\":\"x\"}',2)",[W,empty],/cancelled and can no longer be changed/)

// 6. Client links: high-entropy, hashed at rest, scoped to one request, expiring and revocable.
const firstLink=await issue(acme)
assert.match(firstLink.token,/^lf_[0-9a-f]{64}$/)
assert.equal(await op('select count(*)::int from leadflow_private.onboarding_links where token_hash=$1',[sha(firstLink.token)]),1)
assert.equal(await op("select count(*)::int from leadflow_private.onboarding_links l where l::text like '%'||$1||'%'",[firstLink.token.slice(3)]),0,'The token itself is never stored.')
let opened=await portal({action:'open',token:firstLink.token})
assert.equal(opened.status,200);assert.equal(opened.body.onboarding.status,'draft');assert.deepEqual(opened.body.onboarding.items,[],'A draft request shows no items to the client.')
assert.equal((await setStatus(acme,'activate')).status,'active')
opened=await portal({action:'open',token:firstLink.token})
const clientView=JSON.stringify(opened.body)
assert.equal(opened.body.onboarding.items.length,13);assert.equal(opened.body.onboarding.agencyName,'Personal workspace')
for(const hidden of ['AGENCY-ONLY NOTE','Check GTM container',W,member,'member@example.com','internalNote','waiveReason','Outsider project','contactEmail'])assert.ok(!clientView.includes(hidden),`Client view must not include ${hidden}`)
assert.equal((await portal({action:'open',token:'lf_'+'0'.repeat(64)})).status,404)
assert.equal((await portal({action:'open',token:'not-a-token'})).status,404)
assert.equal((await portal({action:'open',token:firstLink.token},'https://evil.example')).status,403)
assert.equal((await portal({action:'open',token:firstLink.token.toUpperCase()})).status,404)
// Another request's item cannot be reached with this request's token.
const outsiderItem=await as(outsider,'select public.save_onboarding_item($1,$2,$3,1)',[O,outsiderRequest,JSON.stringify({title:'Outsider item',kind:'text'})])
assert.equal((await submit(firstLink.token,outsiderItem,{text:'hi'},1)).status,422)
assert.equal(await op('select response from leadflow_private.onboarding_items where id=$1',[outsiderItem]),null)
// Replacing the link stops the old one immediately; revocation and expiry are checked on every call.
const secondLink=await issue(acme)
assert.equal((await portal({action:'open',token:firstLink.token})).status,404,'A replaced link stops working.')
assert.equal((await portal({action:'open',token:secondLink.token})).status,200)
const extraLink=await issue(acme,30,false)
assert.equal((await as(member,'select public.revoke_onboarding_links($1,$2,$3)',[W,acme,extraLink.linkId])),1)
assert.equal((await portal({action:'open',token:extraLink.token})).status,404,'A revoked link stops working.')
assert.equal((await portal({action:'open',token:secondLink.token})).status,200,'Revoking one link leaves the others.')
const expiring=await issue(acme,1,false)
await op("update leadflow_private.onboarding_links set created_at=now()-interval '2 days', expires_at=now()-interval '1 second' where id=$1",[expiring.linkId])
assert.equal((await portal({action:'open',token:expiring.token})).status,404,'An expired link stops working.')
await fails(member,'select public.issue_onboarding_link($1,$2,91,true)',[W,acme],/1 to 90 days/)
const linkEvents=await op("select string_agg(detail::text,' ') from leadflow_private.onboarding_events where request_id=$1",[acme])
assert.ok(![firstLink,secondLink,extraLink].some(link=>linkEvents.includes(link.token)),'Tokens never appear in the activity history.')
const token=secondLink.token

// 7. Client responses: drafts, submissions, validation, retries and conflicts.
const portalItem=async title=>(await portal({action:'open',token})).body.onboarding.items.find(item=>item.title===title)
let goals=await portalItem('Business overview and goals')
let saved=await submit(token,goals.id,{text:'Draft goals'},goals.revision,false)
assert.equal(saved.status,200);assert.equal(saved.body.item.state,'not_started')
let agencyGoals=await itemNamed(acme,'Business overview and goals');assert.equal(agencyGoals.response,null);assert.equal(agencyGoals.hasDraft,true,'The agency sees that a draft exists, not its content.')
goals=await portalItem('Business overview and goals');assert.deepEqual(goals.value,{text:'Draft goals'},'The client sees their saved progress.')
saved=await submit(token,goals.id,{text:'Grow online bookings by 30%.'},goals.revision)
assert.equal(saved.body.item.state,'submitted')
assert.equal((await submit(token,goals.id,{text:'Grow online bookings by 30%.'},goals.revision)).body.item.unchanged,true,'Repeating a submission after a lost response is safe.')
assert.equal((await submit(token,goals.id,{text:'Something different'},goals.revision)).status,409,'A stale revision with new content is a conflict.')
const brand=await portalItem('Brand guidelines and logo files')
assert.equal((await submit(token,brand.id,{links:['javascript:alert(1)']},brand.revision)).status,422)
assert.match((await submit(token,brand.id,{links:['https://user:pass@drive.example.com/x']},brand.revision)).body.error,/usernames and passwords/)
assert.equal((await submit(token,brand.id,{links:[]},brand.revision)).status,422)
assert.equal((await submit(token,brand.id,{links:[' https://drive.example.com/brand ']},brand.revision)).status,200)
const access=await portalItem('Ad account access (Google Ads and/or Meta)')
assert.match((await submit(token,access.id,{granted:false},access.revision)).body.error,/Confirm that you have granted access/)
assert.equal((await submit(token,access.id,{granted:true,note:'Added your MCC'},access.revision)).status,200)
const prefs=await portalItem('Communication and approval preferences')
assert.equal((await submit(token,prefs.id,{choice:'Carrier pigeon'},prefs.revision)).status,422)
assert.equal((await submit(token,prefs.id,{choice:'Email'},prefs.revision)).status,200)
assert.equal((await portal({action:'save',token,itemId:prefs.id,value:{choice:'Email'},submit:true,revision:'1'})).status,400)

// 8. Review, rejection and resubmission; the client sees feedback but never internal notes or reasons.
let readiness=(await detail(acme)).readiness
assert.equal(readiness.state,'waiting_on_client');assert.equal(readiness.requirementsMet,false)
assert.ok(readiness.blockers.some(b=>b.title.startsWith('Ad account access')&&/agency has not confirmed/.test(b.reason)),'Access the client reports is not counted until the agency confirms it.')
agencyGoals=await itemNamed(acme,'Business overview and goals')
await fails(member,'select public.review_onboarding_item($1,$2,$3,$4,$5,$6)',[W,acme,agencyGoals.id,'request_changes','',agencyGoals.revision],/Tell the client what to change/)
await review(acme,agencyGoals.id,'request_changes','Please add your booking target per month.',agencyGoals.revision)
await fails(member,'select public.review_onboarding_item($1,$2,$3,$4,$5,$6)',[W,acme,agencyGoals.id,'accept','',agencyGoals.revision],/changed since you opened it/)
goals=await portalItem('Business overview and goals')
assert.equal(goals.state,'changes_requested');assert.equal(goals.feedback,'Please add your booking target per month.')
assert.equal((await submit(token,goals.id,{text:'Grow bookings from 100 to 130 per month.'},goals.revision)).body.item.state,'submitted')
agencyGoals=await itemNamed(acme,'Business overview and goals')
await review(acme,agencyGoals.id,'accept','Thanks!',agencyGoals.revision)
assert.equal((await submit(token,goals.id,{text:'Edit after acceptance'},(await portalItem('Business overview and goals')).revision)).status,409,'Accepted items are locked for the client.')
const existing=await itemNamed(acme,'Existing campaigns and performance references')
assert.equal(existing.required,false)
const notStarted=await itemNamed(acme,'Monthly budget and campaign priorities')
await fails(member,'select public.review_onboarding_item($1,$2,$3,$4,$5,$6)',[W,acme,notStarted.id,'accept','',notStarted.revision],/Explain why/)
await fails(member,'select public.review_onboarding_item($1,$2,$3,$4,$5,$6)',[W,acme,pixel.id,'not_required','',pixel.revision],/Give a reason/)
await review(acme,pixel.id,'not_required','SECRET-WAIVER-REASON handled in the kickoff call',pixel.revision)
assert.ok(!JSON.stringify((await portal({action:'open',token})).body).includes('SECRET-WAIVER-REASON'),'Waiver reasons are agency-only.')
let restored=await itemNamed(acme,'Pixel installed on checkout');await review(acme,pixel.id,'restore','',restored.revision)
assert.equal((await itemNamed(acme,'Pixel installed on checkout')).state,'not_started')
restored=await itemNamed(acme,'Pixel installed on checkout');await review(acme,pixel.id,'not_required','Covered by conversion tracking item',restored.revision)

// 9. Readiness: only required items count; optional items never block; the event is recorded once.
for(const item of (await portal({action:'open',token})).body.onboarding.items.filter(i=>i.required&&i.state==='not_started')){
  const value=item.kind==='text'?{text:'Answer'}:item.kind==='links'?{links:['https://example.com/asset']}:item.kind==='access'?{granted:true}:{choice:item.options[0]}
  assert.equal((await submit(token,item.id,value,item.revision)).status,200,item.title)
}
readiness=(await detail(acme)).readiness
assert.equal(readiness.state,'awaiting_review');assert.ok(readiness.blockers.every(b=>b.waitingOn==='agency'))
await fails(member,'select public.hand_off_onboarding($1,$2,null)',[W,acme],/Not ready: \d+ required item/)
for(const item of (await detail(acme)).items.filter(i=>i.required&&i.state==='submitted'))await review(acme,item.id,'accept','',item.revision)
acmeDetail=await detail(acme)
assert.equal(acmeDetail.readiness.state,'ready');assert.equal(acmeDetail.readiness.percent,100);assert.equal(acmeDetail.readiness.requiredWaived,1)
assert.equal(acmeDetail.items.find(i=>i.title===existing.title).state,'not_started','The optional item is still outstanding, and does not block.')
assert.equal(acmeDetail.readiness.optionalOutstanding,1)
const readyEvents=async()=>op("select count(*)::int from leadflow_private.onboarding_events where request_id=$1 and kind='became_ready'",[acme])
assert.equal(await readyEvents(),1);assert.ok(acmeDetail.readySince)
// Sending an accepted item back loses readiness, and accepting it again records readiness again.
let landing=acmeDetail.items.find(i=>i.title==='Landing pages and creative assets')
await review(acme,landing.id,'request_changes','Please add the summer landing page.',landing.revision)
acmeDetail=await detail(acme);assert.equal(acmeDetail.readiness.state,'waiting_on_client');assert.equal(acmeDetail.readySince,null)
assert.equal(await op("select count(*)::int from leadflow_private.onboarding_events where request_id=$1 and kind='readiness_lost'",[acme]),1)
landing=await portalItem('Landing pages and creative assets');await submit(token,landing.id,{links:['https://example.com/summer']},landing.revision)
landing=await itemNamed(acme,'Landing pages and creative assets');await review(acme,landing.id,'accept','',landing.revision)
assert.equal(await readyEvents(),2)
// Paused requests are never actively ready, and cannot be handed off.
await setStatus(acme,'pause')
assert.equal((await detail(acme)).readiness.state,'paused')
assert.equal((await portal({action:'open',token})).body.onboarding.status,'paused')
assert.equal((await submit(token,existing.id,{links:['https://example.com/report']},(await portalItem(existing.title)).revision)).status,409,'Paused requests do not accept responses.')
await fails(member,'select public.hand_off_onboarding($1,$2,null)',[W,acme],/Only an open request can be handed off/)
await setStatus(acme,'resume')
assert.equal(await readyEvents(),2,'Resuming does not record readiness a second time.')

// 10. Handoff: once, auditable, and final. Nothing external is triggered.
const handoff=await as(member,"select public.hand_off_onboarding($1,$2,'Kickoff booked for 20 Nov')",[W,acme])
assert.equal(handoff.repeated,false)
assert.equal((await as(admin,'select public.hand_off_onboarding($1,$2,null)',[W,acme])).id,handoff.id,'Repeating a handoff returns the original one.')
assert.equal(await op('select count(*)::int from leadflow_private.onboarding_handoffs where request_id=$1',[acme]),1)
acmeDetail=await detail(acme)
assert.equal(acmeDetail.status,'completed');assert.equal(acmeDetail.readiness.state,'handed_off');assert.equal(acmeDetail.handoff.id,handoff.id)
const summary=await op('select summary from leadflow_private.onboarding_handoffs where id=$1',[handoff.id])
assert.equal(summary.items.length,13);assert.equal(summary.items.find(i=>i.title==='Business overview and goals').response.text,'Grow bookings from 100 to 130 per month.')
assert.equal(summary.items.find(i=>i.title===existing.title).response,null,'Only accepted responses are copied into the handoff.')
opened=(await portal({action:'open',token})).body.onboarding
assert.equal(opened.status,'completed');assert.ok(opened.confirmedAt)
await fails(member,"select public.update_onboarding_request($1,$2,'{\"title\":\"x\"}',$3)",[W,acme,acmeDetail.version],/handed off and can no longer be changed/)
await fails(admin,"select public.set_onboarding_status($1,$2,'cancel',$3,null)",[W,acme,acmeDetail.version],/handed-off request cannot be cancelled/)
await fails(member,'select public.issue_onboarding_link($1,$2,30,true)',[W,acme],/handed off/)
assert.equal(h.state.providerCalls.length,0,'No email or external action was triggered by the handoff.')

// 11. Reminders: bounded, idempotent, durable, and stopped by every stopping rule.
const remindable=async(title,extra={})=>{
  const id=await as(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify({title,clientName:'Reminder client',contactName:'Sam',contactEmail:'sam@client.example',templateId:paidTemplate.id,reminderIntervalDays:3,reminderMax:2,...extra}),crypto.randomUUID()])
  await setStatus(id,'activate');return {id,link:await issue(id)}
}
const due=id=>op("update leadflow_private.onboarding_requests set next_reminder_at=now()-interval '1 second' where id=$1",[id])
const reminderRows=id=>op("select coalesce(json_agg(json_build_object('sequence',sequence,'status',status,'email',email,'attempts',attempts,'link',link_id) order by sequence),'[]') from leadflow_private.onboarding_reminders where request_id=$1",[id])
const r1=await remindable('Reminder project')
let r1Detail=await detail(r1.id)
assert.ok(r1Detail.reminders.nextAt);assert.equal(r1Detail.reminders.blockedBy,null)
assert.ok(Math.abs(new Date(r1Detail.reminders.nextAt)-Date.now()-3*86400000)<60000,'The first reminder waits one interval after activation.')
assert.deepEqual((await worker()).body.outcomes,[],'Nothing is sent before a reminder is due.')
assert.equal((await worker('wrong-secret-of-sufficient-length-1234')).status,401)
// Missing delivery configuration claims nothing, so no reminder is used up.
await due(r1.id);delete h.config.PORTAL_URL
assert.equal((await worker()).status,503);assert.deepEqual(await reminderRows(r1.id),[])
h.config.PORTAL_URL='http://127.0.0.1:5175/client-portal'
let run=await worker()
assert.deepEqual(run.body.outcomes,['accepted'])
let sent=h.state.providerCalls.at(-1),email=JSON.parse(sent.body)
// Section 3 cut this template down to its first three (required) items.
assert.deepEqual(email.to,['sam@client.example']);assert.equal(email.subject,'Reminder: 3 items needed for Reminder project')
assert.match(email.text,/- Business overview and goals\n- Main point of contact and approver\n- Target audience and geographic market/)
assert.ok(!/password:|AGENCY-ONLY/.test(email.text))
const reminderToken=email.text.match(/client-portal#(lf_[0-9a-f]{64})/)[1]
assert.equal((await portal({action:'open',token:reminderToken})).body.onboarding.title,'Reminder project','The reminder link opens the same request.')
let rows=await reminderRows(r1.id)
assert.equal(rows.length,1);assert.equal(rows[0].status,'accepted');assert.equal(rows[0].email,null,'The email and its token are cleared once the outcome is final.')
assert.match(sent.key,/^leadflow-onboarding\/[0-9a-f-]{36}$/)
assert.deepEqual((await worker()).body.outcomes,[],'Running the worker again sends nothing new.')
assert.equal(await op('select reminders_scheduled from leadflow_private.onboarding_requests where id=$1',[r1.id]),1)
await assert.rejects(()=>op("insert into leadflow_private.onboarding_reminders(workspace_id,request_id,sequence,recipient,item_count) values($1,$2,1,'x@y.z',1)",[W,r1.id]),/duplicate key/,'One row per reminder number.')
// Transient provider failure: retried later with the same body and idempotency key.
await due(r1.id);h.state.providerStatus=500
assert.deepEqual((await worker()).body.outcomes,['pending'])
rows=await reminderRows(r1.id);assert.equal(rows[1].status,'pending');assert.ok(rows[1].email,'A pending reminder keeps its exact email for the retry.')
h.state.providerStatus=200
assert.deepEqual((await worker()).body.outcomes,[],'Retries wait for their backoff.')
await op("update leadflow_private.onboarding_reminders set next_attempt_at=now() where request_id=$1 and status='pending'",[r1.id])
assert.deepEqual((await worker()).body.outcomes,['accepted'])
const attempts=h.state.providerCalls.filter(call=>call.key===h.state.providerCalls.at(-1).key)
assert.equal(attempts.length,2);assert.equal(attempts[0].body,attempts[1].body)
// The maximum is a hard stop.
r1Detail=await detail(r1.id);assert.equal(r1Detail.reminders.scheduled,2);assert.equal(r1Detail.reminders.nextAt,null);assert.equal(r1Detail.reminders.blockedBy,'max_reached')
await op("update leadflow_private.onboarding_requests set next_reminder_at=now()-interval '1 second' where id=$1",[r1.id])
assert.deepEqual((await worker()).body.outcomes,['skipped']);assert.equal((await reminderRows(r1.id)).length,2)
assert.equal(r1Detail.reminders.history.length,2)
// Pausing stops a queued retry, and resuming restarts the interval instead of sending at once.
const r2=await remindable('Pause project')
await due(r2.id);h.state.providerStatus=503;await worker();h.state.providerStatus=200
assert.equal((await reminderRows(r2.id))[0].status,'pending')
await setStatus(r2.id,'pause')
rows=await reminderRows(r2.id);assert.equal(rows[0].status,'cancelled');assert.equal(rows[0].email,null)
await op("update leadflow_private.onboarding_reminders set next_attempt_at=now() where request_id=$1",[r2.id])
let before=h.state.providerCalls.length;assert.deepEqual((await worker()).body.outcomes,[]);assert.equal(h.state.providerCalls.length,before)
await setStatus(r2.id,'resume')
assert.ok(new Date((await detail(r2.id)).reminders.nextAt)>Date.now()+2*86400000)
// Cancellation race: a reminder already with the provider when the request is paused is recorded truthfully.
await due(r2.id)
await actAs(db,null,'service_role');const racing=await one("select public.claim_onboarding_reminder('http://127.0.0.1:5175/client-portal','LeadFlow <onboarding@example.com>')")
await setStatus(r2.id,'pause')
await actAs(db,null,'service_role');await db.query("select public.finish_onboarding_reminder($1,$2,'accepted','provider-race',null)",[racing.id,racing.lease_id])
rows=await reminderRows(r2.id);assert.equal(rows[1].status,'accepted')
assert.match(await op('select last_error from leadflow_private.onboarding_reminders where id=$1',[racing.id]),/after the request stopped/)
const r3=await remindable('Stale lease project')
await due(r3.id);await actAs(db,null,'service_role');const leased=await one("select public.claim_onboarding_reminder('http://127.0.0.1:5175/client-portal','LeadFlow <onboarding@example.com>')")
await db.query("select public.finish_onboarding_reminder($1,$2,'accepted','stale',null)",[leased.id,crypto.randomUUID()])
assert.equal(await op('select status from leadflow_private.onboarding_reminders where id=$1',[leased.id]),'sending','Only the current lease can record an outcome.')
await setStatus(r3.id,'pause')
await actAs(db,null,'service_role');await db.query("select public.finish_onboarding_reminder($1,$2,'pending','provider_http_500','provider_http_500')",[leased.id,leased.lease_id])
assert.equal(await op('select status from leadflow_private.onboarding_reminders where id=$1',[leased.id]),'cancelled','A failed send after cancellation is not retried.')
// Permanent provider refusal is visible and revokes that reminder's link.
const r4=await remindable('Refused project')
await due(r4.id);h.state.providerStatus=422;assert.deepEqual((await worker()).body.outcomes,['failed']);h.state.providerStatus=200
rows=await reminderRows(r4.id);assert.equal(rows[0].status,'failed');assert.equal(rows[0].email,null)
assert.ok(await op('select revoked_at is not null from leadflow_private.onboarding_links where id=$1',[rows[0].link]))
assert.equal((await detail(r4.id)).reminders.history[0].lastError,'provider_http_422')
assert.equal(await op("select count(*)::int from leadflow_private.onboarding_events where request_id=$1 and kind='reminder_failed'",[r4.id]),1)
// Ambiguous provider outcome: retried with the same key, then marked uncertain after the 23-hour window.
const r5=await remindable('Uncertain project')
await due(r5.id);h.state.providerTimeout=true;assert.deepEqual((await worker()).body.outcomes,['pending']);h.state.providerTimeout=false
await op("update leadflow_private.onboarding_reminders set first_attempt_at=now()-interval '24 hours', next_attempt_at=now() where request_id=$1",[r5.id])
before=h.state.providerCalls.length;await worker();assert.equal(h.state.providerCalls.length,before)
rows=await reminderRows(r5.id);assert.equal(rows[0].status,'uncertain');assert.equal(rows[0].email,null)
// Stopping rules: nothing outstanding for the client, only items awaiting agency review, revoked or expired links, no recipient, disabled.
const r6=await remindable('Stopping rules project')
for(const item of (await detail(r6.id)).items.filter(i=>i.required))await review(r6.id,item.id,'not_required','Handled offline',item.revision)
assert.equal((await detail(r6.id)).reminders.blockedBy,'nothing_outstanding');assert.equal((await detail(r6.id)).reminders.nextAt,null)
const r7=await remindable('Awaiting review project')
for(const item of (await portal({action:'open',token:r7.link.token})).body.onboarding.items.filter(i=>i.required)){
  const value=item.kind==='text'?{text:'Answer'}:item.kind==='links'?{links:['https://example.com/a']}:item.kind==='access'?{granted:true}:{choice:item.options[0]}
  await submit(r7.link.token,item.id,value,item.revision)
}
assert.equal((await detail(r7.id)).reminders.blockedBy,'nothing_outstanding','Items waiting for the agency do not trigger client reminders.')
const r8=await remindable('Revoked project')
await as(member,'select public.revoke_onboarding_links($1,$2,null)',[W,r8.id])
assert.equal((await detail(r8.id)).reminders.blockedBy,'no_link')
await due(r8.id);assert.deepEqual((await worker()).body.outcomes,['skipped']);assert.deepEqual(await reminderRows(r8.id),[])
const r9=await remindable('Expired link project')
await op("update leadflow_private.onboarding_links set created_at=now()-interval '40 days', expires_at=now()+interval '30 minutes' where request_id=$1",[r9.id])
await due(r9.id);assert.deepEqual((await worker()).body.outcomes,['skipped']);assert.deepEqual(await reminderRows(r9.id),[])
assert.equal(await op("select detail->>'reason' from leadflow_private.onboarding_events where request_id=$1 and kind='reminder_skipped'",[r9.id]),'no unexpired client link')
const r10=await remindable('No email project',{contactEmail:''})
assert.equal((await detail(r10.id)).reminders.blockedBy,'no_email')
const r11=await remindable('Disabled project',{reminderIntervalDays:null})
assert.equal((await detail(r11.id)).reminders.blockedBy,'disabled')
await fails(member,'select public.update_onboarding_request($1,$2,$3,$4)',[W,r11.id,JSON.stringify({reminderIntervalDays:1}),(await detail(r11.id)).version],/every 2 to 14 days/)
await fails(member,'select public.update_onboarding_request($1,$2,$3,$4)',[W,r11.id,JSON.stringify({reminderMax:6}),(await detail(r11.id)).version],/between 1 and 5/)
// Pausing while a retry is queued: cancelled reminders are never claimed. (Lock contention itself, where the
// worker skips a request row a member holds, needs two connections and is not exercised by single-connection PGlite.)
const r12=await remindable('Locked project')
await due(r12.id);h.state.providerStatus=500;await worker();h.state.providerStatus=200
await op("update leadflow_private.onboarding_reminders set next_attempt_at=now() where request_id=$1",[r12.id])
await setStatus(r12.id,'pause')
assert.deepEqual((await worker()).body.outcomes,[],'Cancelled reminders are never claimed.')
assert.equal(await op("select count(*)::int from leadflow_private.onboarding_reminders where status in ('pending','sending')"),0)

// 12. Snapshot compatibility: whole-workspace saves and resets never touch onboarding records.
const leadId='lead-for-onboarding'
const snapshot=await as(owner,'select public.load_workspace_for($1)',[W])
const lead={id:leadId,name:'Lead Person',email:'lead@example.com',phone:'',company:'Lead Co',service:'Consulting',source:'Referral',message:'',status:'Converted',createdAt:'2026-10-20T00:00:00.000Z'}
let revision=await as(owner,'select public.save_workspace_for($1,$2,$3,$4)',[W,JSON.stringify({...snapshot.data,leads:[lead,...snapshot.data.leads]}),snapshot.revision,crypto.randomUUID()])
const linked=await as(member,'select public.create_onboarding_request($1,$2,$3)',[W,JSON.stringify({title:'From lead',clientName:'Lead Co',leadId}),crypto.randomUUID()])
await fails(outsider,'select public.create_onboarding_request($1,$2,$3)',[O,JSON.stringify({title:'Cross',clientName:'Cross',leadId}),crypto.randomUUID()],/not in this workspace/)
assert.equal((await detail(linked)).leadExists,true)
const onboardingCounts=()=>op("select json_build_object('requests',(select count(*) from leadflow_private.onboarding_requests),'items',(select count(*) from leadflow_private.onboarding_items),'events',(select count(*) from leadflow_private.onboarding_events),'links',(select count(*) from leadflow_private.onboarding_links),'handoffs',(select count(*) from leadflow_private.onboarding_handoffs))")
const countsBefore=await onboardingCounts()
revision=await as(owner,'select public.save_workspace_for($1,$2,$3,$4)',[W,JSON.stringify({...snapshot.data,leads:[{...lead,name:'Edited'},...snapshot.data.leads]}),revision,crypto.randomUUID()])
assert.deepEqual(await onboardingCounts(),countsBefore,'Saving the lead snapshot (delete and reinsert) keeps every onboarding record.')
await as(owner,'select public.save_workspace_for($1,$2,$3,$4)',[W,JSON.stringify({version:1,leads:[],tasks:[],activities:[]}),revision,crypto.randomUUID()])
assert.deepEqual(await onboardingCounts(),countsBefore,'Resetting or removing leads keeps every onboarding record.')
assert.equal((await detail(linked)).leadExists,false,'A removed lead is reported, not silently relinked.')
assert.deepEqual(Object.keys((await as(owner,'select public.load_workspace_for($1)',[W])).data).sort(),['activities','leads','tasks','version'],'The snapshot format is unchanged.')

// 13. Membership changes take effect immediately; deleting a workspace removes only its onboarding data.
await as(owner,'select public.remove_workspace_member($1,$2)',[W,member])
await fails(member,'select public.onboarding_request_for($1,$2)',[W,acme],noAccess)
await fails(member,'select public.issue_onboarding_link($1,$2,30,true)',[W,r11.id],noAccess)
const outsiderCount=await op('select count(*)::int from leadflow_private.onboarding_requests where workspace_id=$1',[O])
await op('delete from public.workspaces where id=$1',[O])
assert.equal(await op('select count(*)::int from leadflow_private.onboarding_requests where workspace_id=$1',[O]),0);assert.equal(outsiderCount,1)
assert.equal(await op("select count(*)::int from leadflow_private.onboarding_items i where not exists (select 1 from leadflow_private.onboarding_requests r where r.id=i.request_id)"),0)
assert.ok(await op('select count(*)::int from leadflow_private.onboarding_requests where workspace_id=$1',[W])>10,'Other workspaces keep their onboarding data.')
await db.close()

// 14. Rollback removes only onboarding objects and the migration applies again.
db=await createDatabase([owner])
await actAs(db,owner);await db.query('select public.install_starter_templates($1)',[owner])
await db.query('select public.save_workspace_for($1,$2,0,$3)',[owner,JSON.stringify({version:1,leads:[lead],tasks:[],activities:[]}),crypto.randomUUID()])
await actAs(db,null,'postgres');await db.exec(readFileSync('supabase/rollbacks/202610250001_client_onboarding.down.sql','utf8'))
assert.equal(await one("select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='leadflow_private' and c.relname like 'onboarding%'"),0)
assert.equal(await one("select count(*)::int from pg_proc where proname like '%onboarding%' or proname like 'portal\\_%'"),0)
assert.equal(await one('select count(*)::int from public.leads'),1,'Leads are kept.')
await db.exec(migrationSql('202610250001_client_onboarding.sql'))
await actAs(db,owner);assert.equal(await one('select public.install_starter_templates($1)',[owner]),4)
await db.close()
console.log('PASS Onboarding: exact client grants, starter and custom templates, request customisation independent of templates, workspace isolation, owner/lead validation, lifecycle and version conflicts, hashed expiring revocable client links scoped to one request, no internal fields in the client view, drafts/submissions/validation/retries, review and resubmission, deterministic readiness with optional items and agency-confirmed access, single auditable handoff, bounded idempotent reminders with retries, lease safety, cancellation races and every stopping rule, snapshot save/reset compatibility, membership removal, workspace deletion and rollback/re-apply. Embedded PostgreSQL and real Edge handlers; email provider simulated; no hosted service contacted.')
