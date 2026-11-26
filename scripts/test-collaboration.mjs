import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createDatabase, actAs, migrationSql } from '../tests/support/database.ts'
import { memberToken, samples } from '../tests/support/clients.ts'
import { assistantRequest, createProjectsHarness } from '../tests/support/projects.ts'
import { clientToken, createCollabHarness, hubRequest, workerRequest } from '../tests/support/collaboration.ts'
// M12 client collaboration and approvals: the real migration SQL in embedded PostgreSQL, run as agency members, client
// portal accounts, other clients' accounts, another workspace and the service role. No outside service is contacted.
const failed=error=>{console.error('FAIL',error.code??'',error.message,error.where?String(error.where).slice(0,400):'',error.stack?.split('\n').filter(line=>line.includes('test-collaboration')).join(' | '));process.exit(1)}
process.on('uncaughtException',failed);process.on('unhandledRejection',failed)
const owner='11111111-1111-4111-8111-111111111111', admin='22222222-2222-4222-8222-222222222222', member='33333333-3333-4333-8333-333333333333', outsider='44444444-4444-4444-8444-444444444444'
// Client people: alice (admin), bob (member, one project), rita (reviewer) at Harbor Dental; oscar at Quiet Bakery; mallory at the other workspace's client.
const alice='a1111111-1111-4111-8111-111111111111', bob='b2222222-2222-4222-8222-222222222222', rita='c3333333-3333-4333-8333-333333333333', oscar='d4444444-4444-4444-8444-444444444444',
  mallory='e5555555-5555-4555-8555-555555555555'
const emails={[alice]:'alice@harbor.example',[bob]:'bob@harbor.example',[rita]:'rita@harbor.example',[oscar]:'oscar@bakery.example',[mallory]:'mallory@other.example'}
const W=owner, O=outsider
const db=await createDatabase([owner,admin,member,outsider])
await db.query("update auth.users set email=split_part(id::text,'-',1)||'@agency.example'")
const clientClaims={app_metadata:{account_type:'client'}}
const isClient=user=>user in emails
const one=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0]??{})[0]
const as=async(user,sql,params=[])=>{await actAs(db,user,'authenticated',isClient(user)?clientClaims:{});return one(sql,params)}
const op=async(sql,params=[])=>{await actAs(db,null,'postgres');return one(sql,params)}
const service=async(sql,params=[])=>{await actAs(db,null,'service_role');return one(sql,params)}
const fails=async(user,sql,params,expected)=>{
  if(user==='service')await actAs(db,null,'service_role');else await actAs(db,user,'authenticated',isClient(user)?clientClaims:{})
  await assert.rejects(()=>db.query(sql,params),error=>{
    if(typeof expected==='string')assert.equal(error.code,expected,`${sql}: expected ${expected}, got ${error.code} ${error.message}`);else assert.match(error.message,expected);return true})}
const id=()=>crypto.randomUUID()
const hash=token=>createHash('sha256').update(token).digest('hex')
const addDays=(date,days)=>{const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10)}
const count=async(sql,params=[])=>Number(await op(sql,params))
/** What client-hub does after creating the Auth account for an invited address. */
const createAccount=async(user)=>op('insert into auth.users(id,email) values ($1,$2) returning id',[user,emails[user]])

for(const user of [owner,admin,member,outsider])await as(user,'select public.load_workspace()')
await as(owner,"select public.set_workspace_member($1,$2,'admin')",[W,admin])
await as(owner,"select public.set_workspace_member($1,$2,'member')",[W,member])
const today=await op('select leadflow_private.project_today($1)::text',[W])

// ---------- Setup: two clients, three projects, another workspace ----------
const A=(await as(member,'select public.create_client($1,$2,$3)',[W,{name:'Harbor Dental',website:'https://harbor.example',services:[{name:'Website redesign'}]},id()])).id
const B=(await as(member,'select public.create_client($1,$2,$3)',[W,{name:'Quiet Bakery'},id()])).id
const C=(await as(outsider,'select public.create_client($1,$2,$3)',[O,{name:'Other Agency Client'},id()])).id
const templates=await as(member,'select public.project_templates_for($1)',[W])
const websiteTemplate=templates.templates.find(t=>t.starterKey==='website')
const plan=await as(member,'select public.project_template_plan($1,$2,$3)',[W,websiteTemplate.id,today])
const P1=(await as(member,'select public.create_project($1,$2,$3)',[W,{clientId:A,source:'manual',name:'Website redesign',projectType:'website',ownerId:member,startDate:today,
  agreedValue:9800,estimatedCost:4000,internalNotes:'Margin is thin; do not discount.',brief:{objectives:'Internal brief text'},plan},id()])).id
const P2=(await as(member,'select public.create_project($1,$2,$3)',[W,{clientId:A,source:'manual',name:'Local SEO'},id()])).id
const P3=(await as(member,'select public.create_project($1,$2,$3)',[W,{clientId:B,source:'manual',name:'Ordering site'},id()])).id
const PC=(await as(outsider,'select public.create_project($1,$2,$3)',[O,{clientId:C,source:'manual',name:'Their project'},id()])).id
const detail=await as(member,'select public.project_detail($1,$2)',[W,P1])
const [m1,m2]=detail.milestones, [d1,d2,d3]=detail.deliverables
assert.ok(m1&&m2&&d1&&d2&&d3,'the template plan has milestones and deliverables')

// ---------- 1. Grants ----------
const publicFunctions=(await db.query(`select p.oid::regprocedure::text as sig, p.proname from pg_proc p where p.pronamespace='public'::regnamespace
  and (p.proname like 'hub\\_%' or p.proname in ('client_portal_access_for','invite_client_user','renew_client_invitation','revoke_client_invitation','update_client_user','set_client_user_active',
    'set_project_portal','set_client_visibility','create_deliverable_version','update_deliverable_version','discard_deliverable_version','request_deliverable_review','publish_deliverable_version',
    'withdraw_deliverable_review','set_feedback_status','deliverable_collab_for','project_collab_for','project_portal_preview','collab_queue_for','project_comments_for','add_project_comment',
    'edit_project_comment','delete_project_comment','project_comment_history','mark_project_discussion_read','save_project_update','publish_project_update','delete_project_update',
    'member_notifications_for','mark_member_notifications','member_notification_settings','save_member_notification_settings','project_collab_ai_context','claim_portal_email','finish_portal_email'))`)).rows
assert.ok(publicFunctions.length>=56,`all M12 public functions exist (${publicFunctions.length})`)
const serviceOnly=new Set(['hub_invitation_status','hub_activate_invitation','claim_portal_email','finish_portal_email'])
for(const fn of publicFunctions){
  assert.equal(await op("select has_function_privilege('anon',$1,'execute')",[fn.sig]),false,`anon can't run ${fn.sig}`)
  assert.equal(await op("select has_function_privilege('authenticated',$1,'execute')",[fn.sig]),!serviceOnly.has(fn.proname),`authenticated and ${fn.sig}`)
  if(serviceOnly.has(fn.proname))assert.equal(await op("select has_function_privilege('service_role',$1,'execute')",[fn.sig]),true)
}
for(const fn of (await db.query(`select p.oid::regprocedure::text as sig from pg_proc p where p.pronamespace='leadflow_private'::regnamespace and p.proname in
  ('hub_access','hub_open_project','hub_can_see_document','queue_notification','notify_clients','accept_invitation','compose_portal_email','refresh_review_status')`)).rows)
  assert.equal(await op("select has_function_privilege('authenticated',$1,'execute')",[fn.sig]),false,`private helper ${fn.sig}`)
for(const table of ['client_users','client_invitations','deliverable_versions','deliverable_reviews','deliverable_feedback','deliverable_decisions','project_comments','project_updates','portal_notifications','portal_email_outbox'])
  assert.equal(await op(`select relrowsecurity from pg_class where oid='leadflow_private.${table}'::regclass`),true,`${table} has RLS`)

// ---------- 2. Invitations ----------
await fails(member,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:emails[alice],role:'admin'},id()],'42501')
await fails(alice,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:emails[alice],role:'admin'},id()],'42501')
await fails(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:'not-an-email',role:'member'},id()],/valid email/)
await fails(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:emails[bob],role:'member',projectAccess:'selected',projectIds:[P3]},id()],/projects of this client/)
await fails(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:emails[bob],role:'member',projectAccess:'selected',projectIds:[]},id()],/at least one project/)
const aliceRequest=id()
const aliceInvite=await as(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:'  Alice@Harbor.Example ',name:'Alice Moreno',role:'admin',projectAccess:'selected',projectIds:[P1],sendEmail:true},aliceRequest])
assert.match(aliceInvite.token,/^lfi_[0-9a-f]{64}$/);assert.equal(aliceInvite.invitation.email,emails[alice]);assert.equal(aliceInvite.invitation.projectAccess,'all','client admins always see every shared project')
assert.equal(await op('select token_hash from leadflow_private.client_invitations where id=$1',[aliceInvite.invitation.id]),hash(aliceInvite.token),'only the hash is stored')
const replay=await as(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:emails[alice],role:'admin'},aliceRequest])
assert.equal(replay.replayed,true);assert.equal(replay.token,null,'a replayed request never reveals the token again')
await fails(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:emails[alice],role:'member'},id()],'23505')
assert.equal(await count("select count(*) from leadflow_private.portal_email_outbox where kind='invitation' and invitation_id=$1 and status='pending'",[aliceInvite.invitation.id]),1,'the invitation email is queued, not sent')
const bobInvite=await as(owner,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:emails[bob],name:'Bob',role:'member',projectAccess:'selected',projectIds:[P1]},id()])
const ritaInvite=await as(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:emails[rita],name:'Rita',role:'reviewer'},id()])
const oscarInvite=await as(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,B,{email:emails[oscar],name:'Oscar',role:'admin'},id()])
const malloryInvite=await as(outsider,'select public.invite_client_user($1,$2,$3,$4)',[O,C,{email:emails[mallory],role:'admin'},id()])
const memberInvite=await as(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:'33333333@agency.example',role:'member'},id()])
const eveInvite=await as(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:'eve@harbor.example',role:'member'},id()])

// Status before sign-in, as client-hub asks with the service role.
await fails(alice,'select public.hub_invitation_status($1)',[hash(aliceInvite.token)],'42501')
let status=await service('select public.hub_invitation_status($1)',[hash(aliceInvite.token)])
assert.equal(status.status,'valid');assert.equal(status.email,emails[alice]);assert.equal(status.clientName,'Harbor Dental');assert.equal(status.accountExists,false)
assert.deepEqual(await service('select public.hub_invitation_status($1)',[hash('lfi_guess')]),{status:'invalid'})
assert.deepEqual(await service('select public.hub_invitation_status($1)',['not-a-hash']),{status:'invalid'})
// Revoked and expired invitations can't be used; renewing issues a new token and the old one stops working.
await as(admin,'select public.revoke_client_invitation($1,$2)',[W,eveInvite.invitation.id])
assert.equal((await service('select public.hub_invitation_status($1)',[hash(eveInvite.token)])).status,'revoked')
await op("update leadflow_private.client_invitations set expires_at=now()-interval '1 minute' where id=$1",[bobInvite.invitation.id])
assert.equal((await service('select public.hub_invitation_status($1)',[hash(bobInvite.token)])).status,'expired')
await createAccount(bob)
await fails('service','select public.hub_activate_invitation($1,$2)',[hash(bobInvite.token),bob],/expired/)
const bobRenewed=await as(admin,'select public.renew_client_invitation($1,$2,$3)',[W,bobInvite.invitation.id,false])
assert.notEqual(bobRenewed.token,bobInvite.token)
assert.equal((await service('select public.hub_invitation_status($1)',[hash(bobInvite.token)])).status,'invalid','the old link stops working')
assert.equal((await service('select public.hub_invitation_status($1)',[hash(bobRenewed.token)])).accountExists,true)
// Activation: new accounts through the service role; the account's email must be the invited address.
await createAccount(alice)
await fails('service','select public.hub_activate_invitation($1,$2)',[hash(aliceInvite.token),bob],/address this invitation was sent to/)
const aliceAccess=await service('select public.hub_activate_invitation($1,$2)',[hash(aliceInvite.token),alice])
assert.equal(aliceAccess.alreadyAccepted,false)
assert.equal((await service('select public.hub_activate_invitation($1,$2)',[hash(aliceInvite.token),alice])).alreadyAccepted,true,'activation is idempotent for the same person')
await fails('service','select public.hub_activate_invitation($1,$2)',[hash(aliceInvite.token),bob],/already used/)
assert.equal(await count("select count(*) from leadflow_private.portal_email_outbox where invitation_id=$1 and status='cancelled'",[aliceInvite.invitation.id]),1,'an accepted invitation cancels its unsent email')
const bobAccess=await service('select public.hub_activate_invitation($1,$2)',[hash(bobRenewed.token),bob])
// Existing accounts sign in and accept with the token's hash.
await createAccount(rita)
await fails(rita,'select public.hub_accept_invitation($1)',[hash(aliceInvite.token)],/already used/)
const ritaAccess=await as(rita,'select public.hub_accept_invitation($1)',[hash(ritaInvite.token)])
await createAccount(oscar);await createAccount(mallory)
const oscarAccess=await as(oscar,'select public.hub_accept_invitation($1)',[hash(oscarInvite.token)])
const malloryAccess=await as(mallory,'select public.hub_accept_invitation($1)',[hash(malloryInvite.token)])
await fails(member,'select public.hub_accept_invitation($1)',[hash(memberInvite.token)],/member of the agency/)
await fails(oscar,'select public.hub_accept_invitation($1)',[hash(eveInvite.token)],/withdrawn/)
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where recipient_type='member' and event='client_activated' and workspace_id=$1",[W]),2*4,
  'owners and admins hear about each activation (4 people, 2 admins)')

// ---------- 3. Client accounts never act inside the agency app ----------
await fails(alice,'select * from public.list_workspaces()',[],/client portal account/)
await fails(alice,'select public.create_workspace($1)',['Shadow agency'],/client portal account/)
await fails(alice,'select public.load_workspace()',[],/client portal account/)
await fails(alice,'select public.load_workspace_for($1)',[W],'42501')
await fails(alice,'select public.project_collab_for($1,$2)',[W,P1],'42501')
await fails(alice,'select public.client_portal_access_for($1,$2)',[W,A],'42501')
await fails(alice,'select public.project_detail($1,$2)',[W,P1],'42501')
assert.equal(await count('select count(*) from public.workspaces where owner_id=$1',[alice]),0,'no workspace was created for the client account')
await actAs(db,alice,'authenticated',clientClaims)
assert.equal((await db.query('select count(*)::int as n from public.workspaces')).rows[0].n,0,'RLS shows the client no workspace rows')

// ---------- 4. Nothing is visible before the agency shares it ----------
const accounts=await as(alice,'select public.hub_accounts()')
assert.deepEqual(accounts.map(x=>x.clientName),['Harbor Dental'])
let home=await as(alice,'select public.hub_home($1)',[aliceAccess.accessId])
assert.equal(home.client.name,'Harbor Dental');assert.equal(home.projects.length,0)
await fails(alice,'select public.hub_project($1)',[P1],'P0002')
await fails(alice,'select public.hub_home($1)',[oscarAccess.accessId],'P0002')
await fails(member,'select public.hub_home($1)',[aliceAccess.accessId],'P0002')

// ---------- 5. Sharing the project ----------
const portal0=await as(member,'select public.project_collab_for($1,$2)',[W,P1])
assert.equal(portal0.portal.shared,false);assert.equal(portal0.people.length,3)
await fails(member,'select public.set_project_portal($1,$2,$3,$4)',[W,P1,{shared:true,contactEmail:'nope'},portal0.portal.version],/valid email/)
const shared=await as(member,'select public.set_project_portal($1,$2,$3,$4)',[W,P1,{shared:true,summary:'A faster site with online booking.',objectives:['Online booking',' ','More enquiries'],
  contactName:'Dana from the agency',contactEmail:'dana@agency.example'},portal0.portal.version])
assert.equal(shared.shared,true)
await fails(member,'select public.set_project_portal($1,$2,$3,$4)',[W,P1,{summary:'stale'},portal0.portal.version],'40001')
home=await as(alice,'select public.hub_home($1)',[aliceAccess.accessId])
assert.deepEqual(home.projects.map(p=>p.name),['Website redesign'],'only shared projects')
let page=await as(alice,'select public.hub_project($1)',[P1])
assert.equal(page.summary,'A faster site with online booking.');assert.deepEqual(page.objectives,['Online booking','More enquiries'])
assert.equal(page.contact.email,'dana@agency.example');assert.deepEqual(page.services,[])
const pageText=JSON.stringify(page)
for(const secret of ['9800','4000','Margin is thin','Internal brief text','agreedValue','health','internal'])assert.ok(!pageText.includes(secret),`the client never sees ${secret}`)
assert.equal(page.milestones.length,0,'milestones are hidden until shown');assert.equal(page.deliverables.length,0,'deliverables are hidden until shared')
assert.ok((await as(bob,'select public.hub_project($1)',[P1])).name)
assert.ok((await as(rita,'select public.hub_project($1)',[P1])).name)
await fails(oscar,'select public.hub_project($1)',[P1],'P0002')
await fails(mallory,'select public.hub_project($1)',[P1],'P0002')
assert.equal((await as(mallory,'select public.hub_home($1)',[malloryAccess.accessId])).projects.length,0,"another agency's client sees none of this workspace's projects")
await fails(alice,'select public.hub_project($1)',[P2],'P0002')
await fails(alice,'select public.hub_project($1)',[PC],'P0002')
await as(member,'select public.set_project_portal($1,$2,$3,null)',[W,P2,{shared:true}])
assert.ok((await as(alice,'select public.hub_project($1)',[P2])).name,'client admins see every shared project')
await fails(bob,'select public.hub_project($1)',[P2],'P0002')
assert.ok((await as(rita,'select public.hub_project($1)',[P2])).name,'"all projects" access covers new shares')
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where client_user_id=$1 and event='project_shared'",[aliceAccess.accessId]),2)
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where client_user_id=$1 and event='project_shared'",[bobAccess.accessId]),1,'only people who can open the project hear about it')
// Milestones and deliverables are shown one by one.
await as(member,'select public.set_client_visibility($1,$2,$3,$4)',[W,'milestone',m1.id,true])
page=await as(alice,'select public.hub_project($1)',[P1])
assert.deepEqual(page.milestones.map(m=>m.id),[m1.id]);assert.equal(page.nextMilestone.id,m1.id)
await fails(alice,'select public.hub_deliverable($1)',[d1.id],'P0002')
await fails(member,'select public.set_client_visibility($1,$2,$3,$4)',[W,'task',d1.id,true],/milestone or a deliverable/)
await fails(outsider,'select public.set_client_visibility($1,$2,$3,$4)',[O,'milestone',m1.id,true],'P0002')


// ---------- 6. Versions, reviews and decisions ----------
/** A file as client-files creates it, then marked checked as the service role would after inspecting it. */
const memberFile=async(user,details,ok=true)=>{const created=await as(user,'select public.begin_client_document($1,$2,$3,$4)',[W,A,details,26214400])
  if(ok)await service('select public.finish_client_document($1,true,null,null)',[created.id]);return created.id}
const v1=await as(member,'select public.create_deliverable_version($1,$2,$3)',[W,d1.id,'First design'])
assert.equal(v1.number,1);assert.equal((await as(member,'select public.create_deliverable_version($1,$2,$3)',[W,d1.id,''])).id,v1.id,'one draft at a time')
const v1File=await memberFile(member,{projectId:P1,versionId:v1.id,fileName:'homepage-v1.pdf',mimeType:'application/pdf',size:1200})
await fails(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,d1.id,{versionId:v1.id,reviewerIds:[bobAccess.accessId]},id()],/client admins or reviewers/)
await fails(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,d1.id,{versionId:v1.id,dueDate:addDays(today,-1)},id()],/from today/)
await fails(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,P3,{versionId:v1.id},id()],'P0002')
const reviewRequest=id()
let collab=await as(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,d1.id,{versionId:v1.id,message:'Please check the layout.',dueDate:addDays(today,5),reviewerIds:[ritaAccess.accessId]},reviewRequest])
assert.equal(collab.reviewStatus,'awaiting_review');assert.equal(collab.clientVisible,true);assert.ok(collab.versions[0].publishedAt)
assert.equal((await as(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,d1.id,{versionId:v1.id},reviewRequest])).reviews.length,1,'a repeated request is ignored')
await fails(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,d1.id,{versionId:v1.id},id()],/open review/)
await fails(member,'select public.begin_client_document($1,$2,$3,$4)',[W,A,{projectId:P1,versionId:v1.id,fileName:'late.pdf',mimeType:'application/pdf',size:10},1000],/already shared/)
await fails(member,'select public.delete_client_document($1,$2)',[W,v1File],/review history/)
await fails(member,'select public.update_deliverable_version($1,$2,$3)',[W,v1.id,'Changed'],/already shared/)
await fails(member,'select public.update_client_document($1,$2,$3)',[W,v1File,{visibility:'internal'}],/attached/)
assert.equal(await op('select visibility from leadflow_private.client_documents where id=$1',[v1File]),'shared')
// Each person sees what their role allows.
let aliceDeliverable=await as(alice,'select public.hub_deliverable($1)',[d1.id])
assert.equal(aliceDeliverable.versions.length,1);assert.equal(aliceDeliverable.versions[0].files[0].fileName,'homepage-v1.pdf');assert.equal(aliceDeliverable.canDecide,true,'client admins can decide')
assert.ok(!('path' in aliceDeliverable.versions[0].files[0])&&!JSON.stringify(aliceDeliverable).includes('storage'),'no storage paths reach the client')
assert.equal((await as(bob,'select public.hub_deliverable($1)',[d1.id])).canDecide,false)
assert.equal((await as(rita,'select public.hub_deliverable($1)',[d1.id])).canDecide,true)
collab=await as(member,'select public.deliverable_collab_for($1,$2)',[W,d1.id])
assert.ok(collab.reviews[0].firstViewedAt,'the agency sees when the review was first opened');assert.equal(collab.reviews[0].firstViewedBy,'Alice Moreno')
const review1=collab.reviews[0].id
await fails(bob,'select public.hub_decide($1,$2,$3)',[review1,{decision:'approved'},id()],/can't approve/)
await fails(oscar,'select public.hub_decide($1,$2,$3)',[review1,{decision:'approved'},id()],'P0002')
await fails(mallory,'select public.hub_decide($1,$2,$3)',[review1,{decision:'approved'},id()],'P0002')
await fails(member,'select public.hub_decide($1,$2,$3)',[review1,{decision:'approved'},id()],'P0002')
// A member gives feedback without deciding.
const bobFeedback=await as(bob,'select public.hub_add_feedback($1,$2,$3)',[d1.id,{title:'Logo too small',body:'Make it bigger.',category:'design'},id()])
assert.equal(bobFeedback.versionNumber,1);assert.equal(bobFeedback.status,'open')
assert.equal((await as(member,'select public.deliverable_collab_for($1,$2)',[W,d1.id])).reviewStatus,'awaiting_review','feedback alone leaves the review open')
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where user_id=$1 and event='feedback_submitted'",[member]),1,'the project owner hears about feedback')
await fails(rita,'select public.hub_decide($1,$2,$3)',[review1,{decision:'changes_requested'},id()],/Describe the changes/)
await fails(rita,'select public.hub_decide($1,$2,$3)',[review1,{decision:'maybe'},id()],/approve, request changes or reject/)
const ritaDecision=id()
aliceDeliverable=await as(rita,'select public.hub_decide($1,$2,$3)',[review1,{decision:'changes_requested',comment:'Close, a few fixes.',
  feedback:[{title:'Booking button',body:'Move it up.',category:'functional'},{title:'Typo in footer',category:'content'}]},ritaDecision])
assert.equal(aliceDeliverable.reviewStatus,'changes_requested');assert.equal(aliceDeliverable.feedback.length,3)
assert.equal((await as(rita,'select public.hub_decide($1,$2,$3)',[review1,{decision:'changes_requested',comment:'again'},ritaDecision])).feedback.length,3,'a repeated decision is ignored')
await fails(alice,'select public.hub_decide($1,$2,$3)',[review1,{decision:'approved'},id()],/closed/)
await actAs(db,null,'postgres');await assert.rejects(()=>db.query("update leadflow_private.deliverable_decisions set decision='approved' where review_id=$1",[review1]),/approval history/)
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where user_id=$1 and event='changes_requested'",[member]),1)
// The agency answers feedback and resubmits.
const [buttonFeedback]=(await as(member,'select public.deliverable_collab_for($1,$2)',[W,d1.id])).feedback.filter(f=>f.title==='Booking button')
await as(member,'select public.add_project_comment($1,$2,$3,$4)',[W,P1,{feedbackId:buttonFeedback.id,body:'Moved above the fold.',visibility:'client'},id()])
await as(member,'select public.add_project_comment($1,$2,$3,$4)',[W,P1,{feedbackId:buttonFeedback.id,body:'Check spacing with design.',visibility:'internal'},id()])
const v2=await as(member,'select public.create_deliverable_version($1,$2,$3)',[W,d1.id,'Booking button moved; footer typo fixed.'])
await memberFile(member,{projectId:P1,versionId:v2.id,fileName:'homepage-v2.pdf',mimeType:'application/pdf',size:1300})
await as(member,'select public.set_feedback_status($1,$2,$3)',[W,buttonFeedback.id,{status:'addressed',note:'Done in version 2',addressedInVersion:v2.id}])
assert.ok(await count("select count(*) from leadflow_private.portal_notifications where client_user_id=$1 and event='feedback_reply'",[ritaAccess.accessId])>=2,'the feedback author hears replies')
const feedbackThread=await as(rita,'select public.hub_comments($1,$2)',[P1,{feedbackId:buttonFeedback.id}])
assert.deepEqual(feedbackThread.map(c=>c.body),['Moved above the fold.'],'internal replies never reach the client')
collab=await as(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,d1.id,{versionId:v2.id,message:'Updated.'},id()])
assert.equal(collab.reviewStatus,'resubmitted')
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where client_user_id=$1 and event='review_resubmitted'",[aliceAccess.accessId]),1)
const review2=collab.reviews[0].id
aliceDeliverable=await as(alice,'select public.hub_decide($1,$2,$3)',[review2,{decision:'approved',comment:'Looks great.'},id()])
assert.equal(aliceDeliverable.reviewStatus,'approved');assert.equal(aliceDeliverable.reviews[0].decision.versionNumber,2);assert.equal(aliceDeliverable.reviews[0].decision.reviewer,'Alice Moreno')
assert.equal(aliceDeliverable.reviews[1].decision.decision,'changes_requested','earlier decisions stay with their version')
await fails(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,d1.id,{versionId:v2.id},id()],/already approved/)
// A new version after approval needs its own review; the approval stays with version 2.
const v3=await as(member,'select public.create_deliverable_version($1,$2,$3)',[W,d1.id,'Small copy edit'])
await fails(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,d1.id,{versionId:v1.id},id()],/newer version/)
collab=await as(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,d1.id,{versionId:v3.id},id()])
assert.equal(collab.reviewStatus,'resubmitted');assert.equal(collab.reviews[0].decision,null)
assert.equal(await count("select count(*) from leadflow_private.deliverable_decisions where version_id=$1 and decision='approved'",[v2.id]),1)
collab=await as(member,'select public.withdraw_deliverable_review($1,$2,$3)',[W,collab.reviews[0].id,'Sent too early'])
assert.equal(collab.reviewStatus,'withdrawn')
assert.ok((await as(alice,'select public.hub_deliverable($1)',[d1.id])).reviews.every(r=>r.status!=='withdrawn'),'withdrawn reviews are not shown to the client')
// Rejection needs a reason; hiding a deliverable withdraws its review and hides its files.
const w1=await as(member,'select public.create_deliverable_version($1,$2,$3)',[W,d2.id,'Wireframes'])
const w1File=await memberFile(member,{projectId:P1,versionId:w1.id,fileName:'wireframes.png',mimeType:'image/png',size:500})
collab=await as(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,d2.id,{versionId:w1.id},id()])
await fails(rita,'select public.hub_decide($1,$2,$3)',[collab.reviews[0].id,{decision:'rejected'},id()],/Comment is required/)
assert.equal((await as(rita,'select public.hub_decide($1,$2,$3)',[collab.reviews[0].id,{decision:'rejected',comment:'Wrong direction.'},id()])).reviewStatus,'rejected')
assert.equal((await as(alice,'select public.hub_document_access($1,$2)',[w1File,'download'])).fileName,'wireframes.png')
await as(member,'select public.set_client_visibility($1,$2,$3,$4)',[W,'deliverable',d2.id,false])
await fails(alice,'select public.hub_deliverable($1)',[d2.id],'P0002')
await fails(alice,'select public.hub_document_access($1,$2)',[w1File,'download'],'P0002')
assert.equal((await as(member,'select public.deliverable_collab_for($1,$2)',[W,d2.id])).reviewStatus,'not_shared')
await fails(oscar,'select public.hub_document_access($1,$2)',[v1File,'download'],'P0002')
await fails(mallory,'select public.hub_document_access($1,$2)',[v1File,'download'],'P0002')
await fails(bob,'select public.hub_document_access($1,$2)',[v1File,'finish'],'P0002')

// ---------- 7. Comments ----------
const internalNote=await as(member,'select public.add_project_comment($1,$2,$3,$4)',[W,P1,{body:'Client is slow to reply.'},id()])
assert.equal(internalNote.visibility,'internal','agency comments are internal by default')
const welcome=await as(member,'select public.add_project_comment($1,$2,$3,$4)',[W,P1,{body:'Welcome to your project space!',visibility:'client'},id()])
await fails(member,'select public.add_project_comment($1,$2,$3,$4)',[W,P1,{body:'x',visibility:'client',parentId:internalNote.id},id()],/stay internal/)
await fails(member,'select public.add_project_comment($1,$2,$3,$4)',[W,P1,{body:'x',visibility:'client',deliverableId:d2.id},id()],/Share the deliverable/)
let thread=await as(alice,'select public.hub_comments($1)',[P1])
assert.deepEqual(thread.map(c=>c.body),['Welcome to your project space!'])
const xss='<img src=x onerror=alert(1)> **bold**'
const aliceComment=await as(alice,'select public.hub_add_comment($1,$2,$3)',[P1,{body:xss,parentId:welcome.id},id()])
assert.equal(aliceComment.body,xss,'comments are stored and returned as plain text');assert.equal(aliceComment.visibility,'client')
await fails(alice,'select public.hub_add_comment($1,$2,$3)',[P1,{body:'peek',parentId:internalNote.id},id()],'P0002')
await fails(alice,'select public.hub_add_comment($1,$2,$3)',[P1,{body:'hi',deliverableId:d2.id},id()],'P0002')
await fails(oscar,'select public.hub_add_comment($1,$2,$3)',[P1,{body:'hi'},id()],'P0002')
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where user_id=$1 and event='client_commented'",[member]),1)
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where client_user_id=$1 and event='comment_added' and dedupe_key=$2",[bobAccess.accessId,'comment:'+aliceComment.id]),1)
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where client_user_id=$1 and dedupe_key=$2",[aliceAccess.accessId,'comment:'+aliceComment.id]),0,'nobody is notified of their own comment')
await fails(bob,'select public.hub_edit_comment($1,$2)',[aliceComment.id,'hijack'],'P0002')
await fails(bob,'select public.hub_delete_comment($1)',[welcome.id],'P0002')
assert.equal((await as(alice,'select public.hub_edit_comment($1,$2)',[aliceComment.id,'Thanks!'])).body,'Thanks!')
assert.equal((await as(alice,'select public.hub_delete_comment($1)',[aliceComment.id])).deleted,true)
const history=await as(member,'select public.project_comment_history($1,$2)',[W,aliceComment.id])
assert.deepEqual(history.map(h=>[h.action,h.body]),[['deleted','Thanks!'],['edited',xss]],'the agency keeps edit and delete history')
assert.ok(!(await as(alice,'select public.hub_comments($1)',[P1])).some(c=>c.body==='Thanks!'))
await fails(admin,'select public.edit_project_comment($1,$2,$3)',[W,welcome.id,'Not mine'],'42501')
assert.equal((await as(admin,'select public.delete_project_comment($1,$2)',[W,internalNote.id])).deleted,true,'owners and admins can remove any comment')
await as(bob,'select public.hub_add_comment($1,$2,$3)',[P1,{body:'When is launch?'},id()])
let overview=await as(member,'select public.project_collab_for($1,$2)',[W,P1])
assert.equal(overview.unreadClientComments,1,'deleted comments are not unread')
let queue=await as(member,'select public.collab_queue_for($1)',[W])
assert.equal(queue.conversations[0].projectId,P1)
await as(member,'select public.mark_project_discussion_read($1,$2)',[W,P1])
assert.equal((await as(member,'select public.project_collab_for($1,$2)',[W,P1])).unreadClientComments,0)
assert.equal((await as(owner,'select public.project_collab_for($1,$2)',[W,P1])).unreadClientComments,1,'read state is per member')
assert.ok(!queue.deliverables.some(x=>x.id===d1.id&&x.reviewStatus==='withdrawn'),'withdrawn deliverables leave the review queue')

// Writes are limited per person and minute.
for(let i=0;i<18;i++)await as(oscar,'select public.hub_add_comment($1,$2,$3)',[P3,{body:`Message ${i}`},id()]).catch(()=>{})
await fails(oscar,'select public.hub_add_comment($1,$2,$3)',[P3,{body:'one more'},id()],'P0002')
await as(member,'select public.set_project_portal($1,$2,$3,null)',[W,P3,{shared:true}])
for(let i=0;i<20;i++)await as(oscar,'select public.hub_add_comment($1,$2,$3)',[P3,{body:`Message ${i}`},id()])
await fails(oscar,'select public.hub_add_comment($1,$2,$3)',[P3,{body:'one too many'},id()],/Too many requests/)
await as(member,'select public.set_project_portal($1,$2,$3,null)',[W,P3,{shared:false}])

// ---------- 8. Updates ----------
const draft=await as(member,'select public.save_project_update($1,$2,null,$3,null,$4)',[W,P1,{title:'Design phase started',body:'We started the designs.'},id()])
assert.equal((await as(alice,'select public.hub_project($1)',[P1])).updates.length,0,'drafts stay internal')
const published=await as(member,'select public.publish_project_update($1,$2)',[W,draft.id])
assert.equal(published.status,'published')
await fails(member,'select public.publish_project_update($1,$2)',[W,draft.id],/already published/)
assert.deepEqual((await as(alice,'select public.hub_project($1)',[P1])).updates.map(u=>u.title),['Design phase started'])
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where client_user_id=$1 and event='update_published'",[bobAccess.accessId]),1)
const corrected=await as(member,'select public.save_project_update($1,$2,$3,$4,$5)',[W,P1,draft.id,{title:'Design phase started',body:'We started the homepage designs.'},published.version])
assert.equal(corrected.revisions,1);assert.ok(corrected.correctedAt)
await fails(member,'select public.delete_project_update($1,$2)',[W,draft.id],/can be corrected/)
const p3Update=await as(member,'select public.save_project_update($1,$2,null,$3)',[W,P3,{title:'Kickoff'}])
await fails(member,'select public.publish_project_update($1,$2)',[W,p3Update.id],/Share the project/)

// ---------- 9. Files ----------
const sharedFile=await memberFile(member,{projectId:P1,fileName:'brand-guide.pdf',mimeType:'application/pdf',size:900,visibility:'shared'})
const internalFile=await memberFile(member,{projectId:P1,fileName:'costing.pdf',mimeType:'application/pdf',size:900,visibility:'internal'})
const p2File=await memberFile(member,{projectId:P2,fileName:'seo-plan.pdf',mimeType:'application/pdf',size:900,visibility:'shared'})
assert.equal((await as(alice,'select public.hub_document_access($1,$2)',[sharedFile,'download'])).fileName,'brand-guide.pdf')
assert.equal((await as(bob,'select public.hub_document_access($1,$2)',[sharedFile,'download'])).fileName,'brand-guide.pdf')
await fails(alice,'select public.hub_document_access($1,$2)',[internalFile,'download'],'P0002')
await fails(bob,'select public.hub_document_access($1,$2)',[p2File,'download'],'P0002')
await fails(oscar,'select public.hub_document_access($1,$2)',[sharedFile,'download'],'P0002')
let files=await as(alice,'select public.hub_files($1,$2)',[aliceAccess.accessId,P1])
assert.ok(files.some(f=>f.fileName==='brand-guide.pdf')&&files.some(f=>f.fileName==='homepage-v2.pdf'));assert.ok(!files.some(f=>['costing.pdf','wireframes.png','seo-plan.pdf'].includes(f.fileName)))
assert.ok((await as(alice,'select public.hub_files($1)',[aliceAccess.accessId])).some(f=>f.fileName==='seo-plan.pdf'),'the all-files view covers every project the person can open')
assert.ok(!(await as(bob,'select public.hub_files($1)',[bobAccess.accessId])).some(f=>f.fileName==='seo-plan.pdf'))
await fails(rita,'select public.hub_begin_document($1,$2,$3)',[P1,{fileName:'notes.pdf',mimeType:'application/pdf',size:10},1000],/feedback and comments only/)
const ritaAttachment=await as(rita,'select public.hub_begin_document($1,$2,$3)',[P1,{fileName:'markup.png',mimeType:'image/png',size:10,feedbackId:buttonFeedback.id},1000])
await fails(rita,'select public.hub_begin_document($1,$2,$3)',[P1,{fileName:'x.png',mimeType:'image/png',size:10,feedbackId:bobFeedback.id},1000],'P0002')
await fails(bob,'select public.hub_begin_document($1,$2,$3)',[P1,{fileName:'evil.exe',mimeType:'application/octet-stream',size:10},1000],/can't be uploaded/)
await fails(bob,'select public.hub_begin_document($1,$2,$3)',[P1,{fileName:'big.pdf',mimeType:'application/pdf',size:5000},1000],/up to/)
const bobUpload=await as(bob,'select public.hub_begin_document($1,$2,$3)',[P1,{fileName:'photos.zip',mimeType:'application/zip',size:2000,category:'image',stageId:id()},26214400])
assert.match(bobUpload.path,/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/)
assert.equal((await as(bob,'select public.hub_document_access($1,$2)',[bobUpload.id,'finish'])).status,'pending')
await fails(alice,'select public.hub_document_access($1,$2)',[bobUpload.id,'finish'],'P0002')
await service('select public.finish_client_document($1,true,null,null)',[bobUpload.id])
await service('select public.finish_client_document($1,true,null,null)',[ritaAttachment.id])
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where user_id=$1 and event='client_file_uploaded'",[member]),2)
overview=await as(member,'select public.project_collab_for($1,$2)',[W,P1])
assert.ok(overview.clientFiles.some(f=>f.fileName==='photos.zip'&&f.uploadedBy==='Bob'&&f.fromPortal))
assert.ok(overview.history.some(h=>h.kind==='client_file_uploaded'&&h.actor==='Bob'))
assert.equal((await as(alice,'select public.hub_document_access($1,$2)',[bobUpload.id,'download'])).fileName,'photos.zip','teammates see client uploads')
await fails(rita,'select public.hub_remove_document($1)',[ritaAttachment.id],/stay with it/)
await fails(alice,'select public.hub_remove_document($1)',[bobUpload.id],'P0002')
assert.equal((await as(bob,'select public.hub_remove_document($1)',[bobUpload.id])).path,bobUpload.path)
await fails(admin,'select public.delete_client_document($1,$2)',[W,ritaAttachment.id],/review history/)

// ---------- 10. Notifications and email ----------
let notes=await as(bob,'select public.hub_notifications($1)',[bobAccess.accessId])
assert.ok(notes.unread>0);assert.ok(notes.items.every(n=>n.title))
await fails(alice,'select public.hub_notifications($1)',[bobAccess.accessId],'P0002')
assert.equal(await as(bob,'select public.hub_mark_notifications($1,$2)',[bobAccess.accessId,[notes.items[0].id]]),1)
await as(bob,'select public.hub_mark_notifications($1)',[bobAccess.accessId])
assert.equal((await as(bob,'select public.hub_notifications($1)',[bobAccess.accessId])).unread,0)
const memberNotes=await as(member,'select public.member_notifications_for($1)',[W])
assert.ok(memberNotes.unread>=5);assert.ok(memberNotes.items.some(n=>n.event==='deliverable_approved'))
await as(member,'select public.mark_member_notifications($1)',[W])
assert.equal((await as(member,'select public.member_notifications_for($1)',[W])).unread,0)
await fails(outsider,'select public.member_notifications_for($1)',[W],'42501')
// Dedupe keys make a retried event notify once.
await op("select leadflow_private.queue_notification($1,'client',$2,$3,'comment_added',$4,null,'Same','','/portal','dedupe-test',$5)",[W,alice,aliceAccess.accessId,P1,emails[alice]])
await op("select leadflow_private.queue_notification($1,'client',$2,$3,'comment_added',$4,null,'Same','','/portal','dedupe-test',$5)",[W,alice,aliceAccess.accessId,P1,emails[alice]])
assert.equal(await count("select count(*) from leadflow_private.portal_notifications where user_id=$1 and dedupe_key='dedupe-test'",[alice]),1)
assert.equal(await count("select count(*) from leadflow_private.portal_email_outbox o join leadflow_private.portal_notifications n on n.id=o.notification_id where n.dedupe_key='dedupe-test'"),1)
// Preferences decide which notifications also send email.
const settings=await as(rita,'select public.hub_settings($1)',[ritaAccess.accessId])
assert.ok(settings.emailEvents.includes('review_requested'));assert.equal(settings.client.name,'Harbor Dental')
await as(rita,'select public.hub_save_settings($1,$2)',[ritaAccess.accessId,{name:'Rita Q',emailEvents:['update_published','not_an_event']}])
assert.deepEqual((await as(rita,'select public.hub_settings($1)',[ritaAccess.accessId])).emailEvents,['update_published'])
await as(member,'select public.save_member_notification_settings($1,$2)',[W,[]])
const v4=await as(member,'select public.create_deliverable_version($1,$2,$3)',[W,d3.id,'Content draft'])
await as(member,'select public.request_deliverable_review($1,$2,$3,$4)',[W,d3.id,{versionId:v4.id},id()])
const ritaReviewNote=await op("select id from leadflow_private.portal_notifications where client_user_id=$1 and event='review_requested' and deliverable_id=$2",[ritaAccess.accessId,d3.id])
const aliceReviewNote=await op("select id from leadflow_private.portal_notifications where client_user_id=$1 and event='review_requested' and deliverable_id=$2",[aliceAccess.accessId,d3.id])
assert.ok(ritaReviewNote&&aliceReviewNote,'both get the in-app notification')
assert.equal(await count('select count(*) from leadflow_private.portal_email_outbox where notification_id=$1',[ritaReviewNote]),0,'no email for events turned off')
assert.equal(await count('select count(*) from leadflow_private.portal_email_outbox where notification_id=$1',[aliceReviewNote]),1)
const decideD3=(await as(member,'select public.deliverable_collab_for($1,$2)',[W,d3.id])).reviews[0].id
await as(alice,'select public.hub_decide($1,$2,$3)',[decideD3,{decision:'approved'},id()])
const approvedNote=await op("select id from leadflow_private.portal_notifications where user_id=$1 and event='deliverable_approved' and deliverable_id=$2",[member,d3.id])
assert.equal(await count('select count(*) from leadflow_private.portal_email_outbox where notification_id=$1',[approvedNote]),0,'members turn email off per event too')
// The worker claims, composes once and records the outcome; revoked people get no email.
await fails(alice,"select public.claim_portal_email('https://app.example','LeadFlow <hi@app.example>')",[],'42501')
await fails('service',"select public.claim_portal_email('javascript:alert(1)','x@y.z')",[],/not configured/)
assert.ok(await count("select count(*) from leadflow_private.portal_email_outbox where status='pending'")>3)
let job=await service("select public.claim_portal_email('https://app.example','LeadFlow <hi@app.example>')")
assert.ok(job.lease_id&&job.email.subject&&job.email.to.length===1)
assert.match(job.email.text,/https:\/\/app\.example\/(portal|app)/);assert.ok(!job.email.html.includes('<script'))
await service("select public.finish_portal_email($1,$2,'accepted','re_123',null)",[job.id,job.lease_id])
assert.equal(await op('select status from leadflow_private.portal_email_outbox where id=$1',[job.id]),'accepted')
assert.deepEqual(await op('select payload from leadflow_private.portal_email_outbox where id=$1',[job.id]),{})
job=await service("select public.claim_portal_email('https://app.example','LeadFlow <hi@app.example>')")
await service("select public.finish_portal_email($1,$2,'pending',null,'provider_unreachable')",[job.id,job.lease_id])
assert.equal(await op('select status from leadflow_private.portal_email_outbox where id=$1',[job.id]),'uncertain','an unknown outcome is retried later with the same key')
await service("select public.finish_portal_email($1,$2,'accepted','late',null)",[job.id,job.lease_id])
assert.equal(await op('select status from leadflow_private.portal_email_outbox where id=$1',[job.id]),'uncertain','a finished lease is ignored')
const pendingInvite=await as(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:'new.person@harbor.example',role:'reviewer',sendEmail:true},id()])
await op("update leadflow_private.portal_email_outbox set next_attempt_at=now()+interval '1 day' where invitation_id is distinct from $1",[pendingInvite.invitation.id])
job=await service("select public.claim_portal_email('https://app.example/','LeadFlow <hi@app.example>')")
assert.ok(job.email.text.includes(`https://app.example/portal/invite#${pendingInvite.token}`),'the invitation email carries the single-use link')
assert.match(job.email.subject,/invited you to the Harbor Dental client portal/)
await service("select public.finish_portal_email($1,$2,'failed',null,'provider_http_422')",[job.id,job.lease_id])
assert.deepEqual(await op('select payload from leadflow_private.portal_email_outbox where id=$1',[job.id]),{},'the token leaves the outbox once the outcome is final')

// ---------- 11. Roles, revocation and archiving ----------
await fails(member,'select public.set_client_user_active($1,$2,false)',[W,bobAccess.accessId],'42501')
await as(admin,'select public.set_client_user_active($1,$2,false)',[W,bobAccess.accessId])
await fails(bob,'select public.hub_project($1)',[P1],'P0002')
await fails(bob,'select public.hub_home($1)',[bobAccess.accessId],'P0002')
assert.deepEqual(await as(bob,'select public.hub_accounts()'),[])
assert.equal(await count("select count(*) from leadflow_private.portal_email_outbox o join leadflow_private.portal_notifications n on n.id=o.notification_id where n.client_user_id=$1 and o.status in ('pending','uncertain')",[bobAccess.accessId]),0,
  'unsent emails to a revoked person are cancelled')
await as(admin,'select public.set_client_user_active($1,$2,true)',[W,bobAccess.accessId])
const bobRow=(await as(admin,'select public.client_portal_access_for($1,$2)',[W,A])).people.find(p=>p.id===bobAccess.accessId)
await as(admin,'select public.update_client_user($1,$2,$3,$4)',[W,bobAccess.accessId,{role:'reviewer',projectAccess:'all'},bobRow.version])
await fails(admin,'select public.update_client_user($1,$2,$3,$4)',[W,bobAccess.accessId,{role:'member'},bobRow.version],'40001')
assert.ok((await as(bob,'select public.hub_project($1)',[P2])).name,'access changes apply immediately')
await fails(admin,'select public.update_client_user($1,$2,$3,$4)',[O,bobAccess.accessId,{role:'admin'},null],'42501')
await fails(outsider,'select public.update_client_user($1,$2,$3,$4)',[O,bobAccess.accessId,{role:'admin'},null],'P0002')
await op("update leadflow_private.clients set status='archived' where id=$1",[A])
assert.deepEqual(await as(alice,'select public.hub_accounts()'),[],'archived clients close their portal')
await fails(alice,'select public.hub_project($1)',[P1],'P0002')
await op("update leadflow_private.clients set status='active' where id=$1",[A])
assert.ok((await as(alice,'select public.hub_project($1)',[P1])).name)

// ---------- 12. Preview, queue and AI context ----------
const preview=await as(member,'select public.project_portal_preview($1,$2)',[W,P3])
assert.equal(preview.name,'Ordering site');assert.equal(preview.clientName,'Quiet Bakery')
await fails(alice,'select public.project_portal_preview($1,$2)',[W,P1],'42501')
queue=await as(member,'select public.collab_queue_for($1)',[W])
assert.ok(queue.deliverables.some(x=>x.id===d3.id&&x.reviewStatus==='approved'))
const ai=await as(member,'select public.project_collab_ai_context($1,$2,$3)',[W,P1,d1.id])
assert.equal(ai.deliverables[0].feedback.length,3);assert.ok(ai.comments.length>0)
await fails(alice,'select public.project_collab_ai_context($1,$2,$3)',[W,P1,null],'42501')
await fails(outsider,'select public.project_collab_ai_context($1,$2,$3)',[W,P1,null],'42501')

// ---------- 13. client-hub Edge Function ----------
const harness=createCollabHarness(db)
const hubCall=async(body,token,origin)=>{const response=await harness.hub(hubRequest(body,token,origin));return {status:response.status,body:await response.json().catch(()=>null)}}
assert.equal((await hubCall({action:'invitation',token:'lfi_'+'0'.repeat(64)},null,'https://evil.example')).status,403,'other websites are refused')
assert.equal((await hubCall({action:'invitation',token:'not-a-token'},null)).status,404)
assert.equal((await hubCall({action:'invitation',token:'lfi_'+'0'.repeat(64)},null)).body.status,'invalid')
const ninaInvite=await as(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,A,{email:'nina@harbor.example',name:'Nina',role:'member',projectAccess:'selected',projectIds:[P1]},id()])
let hubResult=await hubCall({action:'invitation',token:ninaInvite.token},null)
assert.equal(hubResult.status,200);assert.equal(hubResult.body.status,'valid');assert.equal(hubResult.body.email,'nina@harbor.example');assert.equal(hubResult.body.accountExists,false)
assert.equal((await hubCall({action:'activate',token:ninaInvite.token,name:'Nina',password:'short'},null)).status,422)
hubResult=await hubCall({action:'activate',token:ninaInvite.token,name:'Nina',password:'a-long-password'},null)
assert.equal(hubResult.status,200);assert.equal(hubResult.body.email,'nina@harbor.example')
const nina=harness.accounts.get('nina@harbor.example')
assert.equal(nina.appMetadata.account_type,'client','accounts created from invitations are marked as client accounts');assert.equal(nina.name,'Nina')
emails[nina.id]='nina@harbor.example'
assert.match((await hubCall({action:'activate',token:ninaInvite.token,password:'a-long-password'},null)).body.error,/already used/,'the invitation works once')
const ritaAtBakery=await as(admin,'select public.invite_client_user($1,$2,$3,$4)',[W,B,{email:emails[rita],role:'member'},id()])
hubResult=await hubCall({action:'activate',token:ritaAtBakery.token,password:'whatever-123'},null)
assert.equal(hubResult.status,409);assert.equal(hubResult.body.code,'account_exists','existing accounts sign in to accept instead')
await fails(nina.id,'select * from public.list_workspaces()',[],/client portal account/)
assert.deepEqual((await as(nina.id,'select public.hub_accounts()')).map(x=>x.clientName),['Harbor Dental'])
// Files: uploads are checked before they count; every action asks the database as the client first.
const ninaToken=clientToken(nina.id)
assert.equal((await hubCall({action:'upload',projectId:P1,fileName:'brief.pdf',size:samples.pdf.length},null)).status,401)
hubResult=await hubCall({action:'upload',projectId:P1,fileName:'brief.pdf',size:samples.pdf.length,category:'content',description:'Our brief'},ninaToken)
assert.equal(hubResult.status,200)
assert.equal((await harness.put(hubResult.body.uploadUrl,samples.pdf,'application/pdf')).status,200)
const ninaFile=hubResult.body.document.id
hubResult=await hubCall({action:'finish',documentId:ninaFile},ninaToken)
assert.equal(hubResult.status,200);assert.equal(hubResult.body.document.status,'available')
assert.equal((await hubCall({action:'download',documentId:ninaFile},clientToken(alice))).status,200,'teammates on the project can download')
assert.equal((await hubCall({action:'preview',documentId:ninaFile},clientToken(alice))).status,200)
assert.equal((await hubCall({action:'download',documentId:ninaFile},clientToken(oscar))).status,404,'other clients get "not found"')
assert.equal((await hubCall({action:'download',documentId:ninaFile},clientToken(mallory))).status,404)
assert.equal((await hubCall({action:'upload',projectId:P2,fileName:'x.pdf',size:10},ninaToken)).status,404,'projects outside the person\'s access are not found')
assert.equal((await hubCall({action:'upload',projectId:P1,fileName:'notes.pdf',size:10},clientToken(rita))).status,403,'reviewers attach files to feedback only')
assert.equal((await hubCall({action:'upload',projectId:P1,fileName:'tool.exe',size:10},ninaToken)).status,422)
hubResult=await hubCall({action:'upload',projectId:P1,fileName:'logo.png',size:samples.fakePng.length},ninaToken)
await harness.put(hubResult.body.uploadUrl,samples.fakePng,'image/png')
assert.equal((await hubCall({action:'finish',documentId:hubResult.body.document.id},ninaToken)).status,422,'a file whose content doesn\'t match its type is rejected')
assert.equal(await op('select status from leadflow_private.client_documents where id=$1',[hubResult.body.document.id]),'rejected')
assert.equal((await hubCall({action:'remove',documentId:ninaFile},clientToken(alice))).status,404,'only the uploader removes a file')
const ninaPath=await op('select storage_path from leadflow_private.client_documents where id=$1',[ninaFile])
assert.equal((await hubCall({action:'remove',documentId:ninaFile},ninaToken)).status,200)
assert.equal(harness.state.objects.has(ninaPath),false,'the stored object is removed')
assert.equal((await hubCall({action:'download',documentId:ninaFile},clientToken(alice))).status,404)

// ---------- 14. portal-notifications worker ----------
assert.equal((await harness.worker(workerRequest('wrong'))).status,401)
const pendingBefore=await count("select count(*) from leadflow_private.portal_email_outbox where status in ('pending','uncertain')")
assert.ok(pendingBefore>0)
const unconfigured=createCollabHarness(db,{APP_URL:''})
assert.equal((await unconfigured.worker(workerRequest('w'.repeat(40)))).status,503,'without an app address nothing is claimed')
assert.equal(await count("select count(*) from leadflow_private.portal_email_outbox where status in ('pending','uncertain')"),pendingBefore)
await op("update leadflow_private.portal_email_outbox set next_attempt_at=now() where status in ('pending','uncertain')")
harness.email.failWith=500
let workerRun=await (await harness.worker(workerRequest('w'.repeat(40)))).json()
assert.ok(workerRun.outcomes.includes('pending'),'a provider outage leaves emails to retry')
const retryKeys=await count("select count(*) from leadflow_private.portal_email_outbox where status='uncertain' and attempts=1")
assert.ok(retryKeys>0)
harness.email.failWith=null
await op("update leadflow_private.portal_email_outbox set next_attempt_at=now() where status in ('pending','uncertain')")
for(let run=0;run<5;run++)workerRun=await (await harness.worker(workerRequest('w'.repeat(40)))).json()
assert.equal(await count("select count(*) from leadflow_private.portal_email_outbox where status in ('pending','uncertain','sending')"),0,'every queued email is processed')
assert.ok(harness.email.sent.length>0);assert.ok(harness.email.sent.every(item=>item.key.startsWith('leadflow-portal/')))
assert.equal(new Set(harness.email.sent.map(item=>item.key)).size,harness.email.sent.length,'one email per job, even after retries')
// Emails composed in an earlier run keep their first body (and sender), so a retry is identical for the provider.
assert.ok(harness.email.sent.every(item=>/@app\.example>$/.test(String(item.body.from))&&Array.isArray(item.body.to)&&item.body.to.length===1))
assert.ok(harness.email.sent.some(item=>String(item.body.text).includes('http://127.0.0.1:5175/portal')),'client emails link to the portal')
assert.ok(!harness.email.sent.some(item=>JSON.stringify(item.body).includes('Margin is thin')),'internal notes never appear in emails')
assert.equal(await count("select count(*) from leadflow_private.portal_email_outbox where status='accepted' and payload<>'{}'::jsonb"),0)

// ---------- 15. Collaboration assistant ----------
const projects=createProjectsHarness(db)
const ask=async(body,token=memberToken(member))=>{const response=await projects.assistant(assistantRequest({workspaceId:W,projectId:P1,...body},token));return {status:response.status,body:await response.json()}}
projects.ai.answer=()=>({overview:'The client asked for two layout changes.',groups:[{category:'design',points:[{text:'Enlarge the logo',basedOn:['F1','F999']},{text:'Unsupported idea',basedOn:[]}]},{category:'pricing',points:[]}]})
let answer=await ask({action:"feedback_summary",deliverableId:d1.id})
assert.equal(answer.status,200);assert.equal(answer.body.operation,'feedback_summary')
assert.deepEqual(answer.body.feedbackSummary.groups.map(g=>[g.category,g.points.length]),[['design',1]]);assert.deepEqual(answer.body.feedbackSummary.groups[0].points[0].basedOn,['F1'])
assert.equal(answer.body.warnings.length,1,'points without recorded facts are left out and reported')
let sent=projects.ai.calls.at(-1)
assert.match(sent.user,/<project_data>/);assert.ok(!/<img|<script/i.test(sent.user.split('<project_data>')[1].split('</project_data>')[0]),'client text stays escaped inside the data block')
assert.match(sent.system,/Never say feedback is resolved/)
assert.equal((await ask({action:'response_draft'})).status,400)
projects.ai.answer=()=>({body:'Thanks, we moved the booking button above the fold in version 2.',basedOn:['F2']})
answer=await ask({action:'response_draft',feedbackId:buttonFeedback.id})
assert.equal(answer.status,200);assert.match(answer.body.responseDraft.body,/booking button/)
sent=projects.ai.calls.at(-1)
assert.ok(!sent.user.includes('Check spacing with design.'),'internal notes never reach a reply draft')
assert.ok(sent.user.includes('Moved above the fold.'),'client-visible replies are context')
assert.equal((await ask({action:'response_draft',feedbackId:id()})).status,404)
assert.equal((await ask({action:'review_prep'})).status,400)
projects.ai.answer=()=>({changed:[{text:'Booking button moved',basedOn:['F3']}],addressed:[],unresolved:[{text:'Footer typo',basedOn:['F4']}]})
answer=await ask({action:'review_prep',deliverableId:d1.id})
assert.equal(answer.status,200);assert.equal(answer.body.reviewPrep.unresolved.length,1)
projects.ai.answer=()=>({overview:'',decisions:[],openQuestions:[]})
assert.equal((await ask({action:'discussion_summary'})).status,422,'empty answers are rejected')
assert.equal((await ask({action:'feedback_summary'},clientToken(alice))).status,403,'client accounts can\'t use the agency assistant')
const unconfiguredAssistant=await projects.unconfigured(assistantRequest({workspaceId:W,projectId:P1,action:'discussion_summary'},memberToken(member)))
assert.equal(unconfiguredAssistant.status,503)
assert.ok(await count("select count(*) from leadflow_private.outreach_usage where operation like 'project_%' and workspace_id=$1",[W])>=4,'every assistant request is counted')

// ---------- 16. Rollback keeps projects, deliverables and files; the migration applies again ----------
await actAs(db,null,'postgres')
const filesBefore=await count("select count(*) from leadflow_private.client_documents where status='available'")
await db.exec(readFileSync('supabase/rollbacks/202611270001_client_collaboration.down.sql','utf8'))
assert.equal(await op("select to_regclass('leadflow_private.client_users')::text"),null)
assert.equal(await op("select to_regprocedure('public.hub_home(uuid)')::text"),null)
assert.equal(await count("select count(*) from leadflow_private.client_documents where status='available'"),filesBefore,'files stay as internal project files')
assert.equal(await count("select count(*) from leadflow_private.client_documents where project_id is not null and visibility<>'internal'"),0)
assert.ok((await as(member,'select public.project_detail($1,$2)',[W,P1])).deliverables.length>=3,'projects and deliverables keep working')
await actAs(db,null,'postgres');await db.exec(migrationSql('202611270001_client_collaboration.sql'))
const again=await as(member,'select public.project_collab_for($1,$2)',[W,P1])
assert.equal(again.portal.shared,false);assert.equal(again.people.length,0)
await fails(alice,'select public.hub_project($1)',[P1],'P0002')

console.log('PASS Client collaboration: exact grants and RLS; single-use, hashed, expiring, renewable and revocable invitations; client accounts refused by every agency function; nothing visible until shared; per-person project access; versioned reviews with immutable decisions; feedback, replies and internal notes kept apart; plain-text comments with edit history; published and corrected updates; file access per project, deliverable, version and attachment; deduplicated notifications and preference-aware email outbox; client-hub activation and checked uploads; the email worker; the collaboration assistant; rollback and re-apply.')
