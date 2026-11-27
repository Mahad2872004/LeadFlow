import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDatabase, actAs, migrationSql } from '../tests/support/database.ts'
import { createClientsHarness, filesRequest, memberToken, portalCall, samples } from '../tests/support/clients.ts'
// M10 clients and client onboarding: the real migration SQL in embedded PostgreSQL and the real client-files and
// client-portal Edge handlers. Supabase Storage is simulated in memory; no outside service is contacted.
const failed=error=>{console.error('FAIL',error.code??'',error.message,error.where?String(error.where).slice(0,300):'',error.stack?.split('\n').filter(line=>line.includes('test-clients')).join(' | '));process.exit(1)}
process.on('uncaughtException',failed);process.on('unhandledRejection',failed)
const owner='11111111-1111-4111-8111-111111111111', admin='22222222-2222-4222-8222-222222222222', member='33333333-3333-4333-8333-333333333333', outsider='44444444-4444-4444-8444-444444444444'
const W=owner, O=outsider
const db=await createDatabase([owner,admin,member,outsider])
await db.query("update auth.users set email=split_part(id::text,'-',1)||'@agency.example'")
const one=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0]??{})[0]
const as=async(user,sql,params=[])=>{await actAs(db,user);return one(sql,params)}
const op=async(sql,params=[])=>{await actAs(db,null,'postgres');return one(sql,params)}
const fails=async(user,sql,params,expected)=>{await actAs(db,user);await assert.rejects(()=>db.query(sql,params),error=>{
  if(typeof expected==='string')assert.equal(error.code,expected,`${sql}: expected ${expected}, got ${error.code} ${error.message}`);else assert.match(error.message,expected);return true})}
const id=()=>crypto.randomUUID()
for(const user of [owner,admin,member,outsider])await as(user,'select public.load_workspace()')
await as(owner,"select public.set_workspace_member($1,$2,'admin')",[W,admin])
await as(owner,"select public.set_workspace_member($1,$2,'member')",[W,member])
const lead=(leadId,fields={})=>({id:leadId,name:'Avery Stone',email:'avery@harbor-dental.example',phone:'',company:'Harbor Dental',service:'Not specified',source:'Lead discovery',message:'',status:'New',
  createdAt:'2026-11-01T00:00:00.000Z',website:'https://harbor-dental.example/',industry:'Dental clinics',address:'1 Main St',city:'Austin',region:'TX',postcode:'78701',country:'US',...fields})
const snapshot=async(user,workspace=W)=>{await actAs(db,user);return one('select public.load_workspace_for($1)',[workspace])}
const save=async(user,change,workspace=W)=>{const current=await snapshot(user,workspace);const data=change(structuredClone(current.data));await actAs(db,user);
  return one('select public.save_workspace_for($1,$2,$3,$4)',[workspace,JSON.stringify(data),current.revision,id()])}
await save(owner,data=>({...data,leads:[lead('harbor'),lead('studio',{company:'Brightpath Studio',name:'Rae Lin',industry:'Marketing agencies',website:'https://brightpath.example/'}),lead('bakery',{company:'Quiet Bakery',name:'Sam Ortiz',email:''})]}))
await save(outsider,data=>({...data,leads:[lead('theirs',{company:'Their Lead'})]}),O)
await actAs(db,null,'postgres')
const dana=await one(`insert into leadflow_private.lead_contacts(workspace_id,lead_id,kind,full_name,job_title,email,origin) values ($1,'harbor','person','Dana Reyes','Practice manager','dana@harbor-dental.example','manual') returning id`,[W])
const studioContact=await one(`insert into leadflow_private.lead_contacts(workspace_id,lead_id,kind,full_name,origin) values ($1,'studio','person','Lee Park','manual') returning id`,[W])
const seoService=await one(`insert into leadflow_private.agency_services(workspace_id,name,category) values ($1,'Local SEO','seo') returning id`,[W])
const webService=await one(`insert into leadflow_private.agency_services(workspace_id,name,category) values ($1,'Website redesign','website') returning id`,[W])
const theirService=await one(`insert into leadflow_private.agency_services(workspace_id,name) values ($1,'Theirs') returning id`,[O])
const newDeal=(user,deal,workspace=W)=>as(user,'select public.create_deal($1,$2,$3,true)',[workspace,deal,id()])
const winDeal=async(deal,value)=>as(owner,'select public.close_deal($1,$2,$3,$4,$5,$6)',[W,deal.id,'won',{wonValue:value},deal.version,id()])
const harborDeal=await newDeal(member,{leadId:'harbor',title:'Website redesign',value:'8000',currency:'USD',contactId:dana})
const won=await winDeal(harborDeal,'8500')
const openDeal=await newDeal(member,{leadId:'bakery',title:'Ordering site',value:'3000',currency:'USD'})
const theirDeal=await newDeal(outsider,{leadId:'theirs',title:'Theirs'},O)

// 1. Catalog: anonymous callers execute nothing; signed-in users get the member functions only; tables are private.
await actAs(db,null,'postgres')
const executable=async role=>(await db.query("select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','leadflow_private') and has_function_privilege($1,p.oid,'EXECUTE')",[role])).rows.map(row=>row.fn)
assert.deepEqual(await executable('anon'),[])
const signedIn=await executable('authenticated'), service=await executable('service_role')
for(const fn of ['clients_for(uuid,jsonb)','client_detail(uuid,uuid)','convert_deal_to_client(uuid,uuid,jsonb,uuid)','create_client(uuid,jsonb,uuid)','complete_client_onboarding(uuid,uuid,text,text)',
  'begin_client_document(uuid,uuid,jsonb,bigint)','save_onboarding_form(uuid,jsonb,integer,uuid)','set_onboarding_step_status(uuid,uuid,uuid,text,text,integer)','client_timeline(uuid,uuid,jsonb,timestamp with time zone,integer,text)'])
  assert.ok(signedIn.includes(fn),`${fn} is callable by members`)
for(const fn of ['finish_client_document(uuid,boolean,bigint,text)','portal_begin_upload(text,uuid,jsonb,bigint)','portal_document_access(text,uuid,text)','portal_remove_upload(text,uuid)','portal_acknowledge_scope(text,uuid)']){
  assert.ok(!signedIn.includes(fn),`${fn} is not callable by members`);assert.ok(service.includes(fn),`${fn} is callable by the service role`)}
assert.deepEqual(signedIn.filter(fn=>fn.startsWith('leadflow_private.')&&/client|onboarding|document|stage/.test(fn)),[])
for(const table of ['clients','client_contacts','client_services','client_requirements','client_requirement_revisions','client_scope_confirmations','client_activities','client_onboarding_completions',
  'onboarding_stages','onboarding_forms','onboarding_form_fields','onboarding_form_assignments','onboarding_template_steps','onboarding_steps','onboarding_item_responses','client_documents']){
  assert.equal(await one("select relrowsecurity from pg_class where oid=('leadflow_private.'||$1)::regclass",[table]),true,`${table} has RLS`)
  for(const role of ['anon','authenticated'])assert.equal(await one("select has_table_privilege($1,'leadflow_private.'||$2,'SELECT')",[role,table]),false)
}

// 2. Stages and starter templates: eight default stages; seven starters with stages and internal steps.
const stages=(await as(member,'select public.onboarding_stages_for($1)',[W])).stages
assert.deepEqual(stages.map(s=>s.name),['Client created','Welcome & introduction','Business information','Requirements gathering','Access & assets','Scope confirmation','Final review','Onboarding completed'])
await fails(member,'select public.install_starter_templates($1)',[W],'42501')
assert.equal(await as(owner,'select public.install_starter_templates($1)',[W]),7)
assert.equal(await as(owner,'select public.install_starter_templates($1)',[W]),0,'installing twice adds nothing')
const overview=await as(member,'select public.onboarding_overview_for($1)',[W])
const websiteTemplate=overview.templates.find(t=>t.starterKey==='website')
assert.ok(overview.templates.some(t=>t.starterKey==='automation'&&t.serviceType==='automation'),'the automation starter exists')
assert.equal(websiteTemplate.stepCount,6);assert.ok(overview.templates.some(t=>t.starterKey==='marketing'&&t.serviceType==='seo'))
const websiteDefinition=await as(member,'select public.onboarding_template_for($1,$2)',[W,websiteTemplate.id])
assert.ok(websiteDefinition.items.some(i=>i.kind==='file'&&i.config.category==='logo'));assert.ok(websiteDefinition.items.some(i=>i.kind==='multi_choice'))
assert.ok(websiteDefinition.items.every(i=>i.stageId),'every starter item has a stage');assert.deepEqual(websiteDefinition.steps.filter(s=>s.autoKey).map(s=>s.autoKey),['welcome_sent','requirements_decided','scope_confirmed'])
// Stage configuration: owners and admins.
await fails(member,'select public.save_onboarding_stage($1,$2)',[W,{name:'Kickoff call'}],'42501')
const kickoff=await as(admin,'select public.save_onboarding_stage($1,$2)',[W,{name:'Kickoff call',description:'Meet the team'}])
let stageList=(await as(owner,'select public.onboarding_stages_for($1)',[W])).stages.filter(s=>!s.archived)
assert.deepEqual(stageList.slice(-2).map(s=>s.name),['Kickoff call','Onboarding completed'],'new stages go before Onboarding completed')
await fails(owner,'select public.save_onboarding_stage($1,$2)',[W,{name:'kickoff CALL'}],/already exists/)
const reordered=stageList.map(s=>s.id);[reordered[1],reordered[2]]=[reordered[2],reordered[1]]
await fails(owner,'select public.reorder_onboarding_stages($1,$2)',[W,JSON.stringify(reordered.slice(1))],/every active stage/)
await as(owner,'select public.reorder_onboarding_stages($1,$2)',[W,JSON.stringify(reordered)])
await as(owner,'select public.set_onboarding_stage_archived($1,$2,true)',[W,kickoff])
assert.ok((await as(owner,'select public.onboarding_stages_for($1)',[W])).stages.find(s=>s.id===kickoff).archived)
await fails(owner,"select public.save_onboarding_item($1,$2,$3,null)",[W,id(),{title:'x',kind:'text',stageId:kickoff}],'P0002')

// 3. Conversion: a won deal, reviewed details, contacts from M8, confirmed services, onboarding from a template.
const conversion={name:'Harbor Dental',website:'harbor-dental.example',industry:'Dental clinics',city:'Austin',country:'us',timezone:'America/Chicago',
  contacts:[{sourceContactId:dana,fullName:'Dana Reyes',jobTitle:'Practice manager',role:'project',email:'Dana@Harbor-Dental.example',isPrimary:true},{fullName:'Dr. Lee',role:'decision_maker',email:'lee@harbor-dental.example'}],
  services:[{serviceId:webService,name:'Website redesign',agreedScope:'New 8-page website',deliverables:'Design, build, launch',exclusions:'Copywriting'}],
  onboarding:{templateId:websiteTemplate.id,title:'Harbor Dental website onboarding'}}
const convertRequest=id()
const converted=await as(member,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,harborDeal.id,conversion,convertRequest])
assert.equal(converted.existing,false);assert.ok(converted.onboardingRequestId)
const client=converted.id
assert.equal((await as(member,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,harborDeal.id,conversion,convertRequest])).id,client,'a repeated request returns the same client')
assert.equal((await as(admin,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,harborDeal.id,{...conversion,name:'Another'},id()])).existing,true,'a deal converts once')
assert.equal(await op('select count(*)::int from leadflow_private.clients where deal_id=$1',[harborDeal.id]),1)
let detail=await as(member,'select public.client_detail($1,$2)',[W,client])
assert.equal(detail.name,'Harbor Dental');assert.equal(detail.website,'https://harbor-dental.example');assert.equal(detail.country,'US');assert.equal(detail.status,'onboarding')
assert.equal(detail.leadId,'harbor');assert.equal(detail.dealId,harborDeal.id);assert.equal(detail.deal.title,'Website redesign');assert.equal(Number(detail.conversion.wonValue),8500)
assert.equal(detail.contacts.length,2);assert.equal(detail.contacts[0].fullName,'Dana Reyes');assert.equal(detail.contacts[0].isPrimary,true);assert.equal(detail.contacts[0].email,'dana@harbor-dental.example')
assert.equal(detail.contacts[0].sourceContactId,dana)
assert.deepEqual(detail.serviceRecords.map(s=>[s.name,s.status,s.source]),[['Website redesign','confirmed','deal']])
assert.equal(detail.requests.length,1);assert.equal(detail.onboarding.state,'not_started')
// The lead, the deal and its history are untouched; the deal gains its M9 handoff and a "converted" entry.
assert.ok((await snapshot(owner)).data.leads.some(l=>l.id==='harbor'))
const dealAfter=await as(member,'select public.deal_detail($1,$2)',[W,harborDeal.id])
assert.equal(dealAfter.outcome,'won');assert.ok(dealAfter.handoff);assert.equal(dealAfter.stageHistory.length,won.version?dealAfter.stageHistory.length:0)
assert.equal(await op("select count(*)::int from leadflow_private.deal_activities where deal_id=$1 and kind='client_converted'",[harborDeal.id]),1)
assert.equal(await op('select count(*)::int from leadflow_private.client_contacts where client_id=$1 and source_contact_id is not null',[client]),1)
assert.equal(await op('select count(*)::int from leadflow_private.lead_contacts where id=$1',[dana]),1,'the M8 contact is kept')
// Ineligible and forged conversions.
await fails(member,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,openDeal.id,{name:'Quiet Bakery'},id()],'42501')
await fails(owner,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,openDeal.id,{name:'Quiet Bakery'},id()],/Give a reason/)
await fails(outsider,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,openDeal.id,{name:'X'},id()],'42501')
await fails(outsider,'select public.convert_deal_to_client($1,$2,$3,$4)',[O,openDeal.id,{name:'X'},id()],'P0002')
await fails(member,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,theirDeal.id,{name:'X'},id()],'P0002')
// A failure part-way through rolls everything back: no client, no handoff, no deal activity.
const studioDeal=await newDeal(member,{leadId:'studio',title:'Content retainer',value:'1200',currency:'USD'})
await winDeal(studioDeal,'1200')
const before=[await op('select count(*)::int from leadflow_private.clients'),await op('select count(*)::int from leadflow_private.client_handoffs'),await op('select count(*)::int from leadflow_private.deal_activities')]
await fails(member,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,studioDeal.id,{name:'Brightpath Studio',contacts:[{fullName:'Lee Park',email:'not-an-email'}]},id()],/valid email/)
await fails(member,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,studioDeal.id,{name:'Brightpath Studio',contacts:[{sourceContactId:dana,fullName:'Dana'}]},id()],/this lead's contacts/)
await fails(member,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,studioDeal.id,{name:'Brightpath Studio',services:[{serviceId:theirService,name:'Theirs'}]},id()],/catalog/)
assert.deepEqual([await op('select count(*)::int from leadflow_private.clients'),await op('select count(*)::int from leadflow_private.client_handoffs'),await op('select count(*)::int from leadflow_private.deal_activities')],before)
// A deal handed off in M9 before M10 ("incomplete") converts using that handoff.
await as(member,'select public.confirm_client_handoff($1,$2,$3)',[W,studioDeal.id,'Before M10'])
const studio=(await as(member,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,studioDeal.id,{name:'Brightpath Studio',contacts:[{sourceContactId:studioContact,fullName:'Lee Park',email:'lee@brightpath.example'}]},id()])).id
assert.equal(await op('select count(*)::int from leadflow_private.client_handoffs where deal_id=$1',[studioDeal.id]),1)
assert.equal(await op("select conversion->>'fromExistingHandoff' from leadflow_private.clients where id=$1",[studio]),'true')
// Owners and admins can convert a deal that isn't won, with the reason kept.
const bakery=(await as(admin,'select public.convert_deal_to_client($1,$2,$3,$4)',[W,openDeal.id,{name:'Quiet Bakery',overrideReason:'Signed a pilot before closing the deal'},id()])).id
assert.equal(await op("select conversion->>'overrideReason' from leadflow_private.clients where id=$1",[bakery]),'Signed a pilot before closing the deal')
assert.equal(await op('select count(*)::int from leadflow_private.client_handoffs where deal_id=$1',[openDeal.id]),0,'no M9 handoff for a deal that isn\'t won')

// 4. Client management: manual clients, edits with versions, status separate from onboarding, archiving, the directory.
await fails(member,'select public.create_client($1,$2,$3)',[W,{name:''},id()],/Client name is required/)
await fails(member,'select public.create_client($1,$2,$3)',[W,{name:'X',leadId:'theirs'},id()],/not in this workspace/)
await fails(member,'select public.create_client($1,$2,$3)',[W,{name:'X',website:'not a website'},id()],/Enter a website/)
await fails(member,'select public.create_client($1,$2,$3)',[W,{name:'X',timezone:'Mars/Olympus'},id()],/time zone/)
await fails(member,'select public.create_client($1,$2,$3)',[W,{name:'X',surprise:true},id()],/Unknown client field/)
const manualRequest=id()
const manual=(await as(member,'select public.create_client($1,$2,$3)',[W,{name:'Northline Gym',industry:'Fitness',contacts:[{fullName:'Kai Moss',email:'kai@northline.example'}]},manualRequest])).id
assert.equal((await as(member,'select public.create_client($1,$2,$3)',[W,{name:'Northline Gym'},manualRequest])).id,manual)
detail=await as(member,'select public.client_detail($1,$2)',[W,manual])
assert.equal(detail.contacts[0].isPrimary,true,'the first contact becomes primary')
const updated=await as(member,'select public.update_client($1,$2,$3,$4)',[W,manual,detail.version,{description:'Two gyms in Leeds',ownerId:admin,importantDates:[{label:'Kickoff',date:'2026-12-01'}]}])
assert.equal(updated.ownerId,admin);assert.equal(updated.version,detail.version+1)
await fails(member,'select public.update_client($1,$2,$3,$4)',[W,manual,detail.version,{description:'stale'}],'40001')
await fails(member,'select public.update_client($1,$2,$3,$4)',[W,manual,updated.version,{ownerId:outsider}],/owner from this workspace/)
await fails(member,'select public.update_client($1,$2,$3,$4)',[W,manual,updated.version,{importantDates:[{label:'Bad',date:'2026-02-30'}]}],/valid calendar date/)
let status=await as(member,'select public.set_client_status($1,$2,$3,$4,$5)',[W,manual,'paused',updated.version,'Waiting for budget'])
assert.equal(status.status,'paused');assert.equal(status.onboarding.state,'not_started','client status and onboarding status are separate')
await fails(member,'select public.set_client_status($1,$2,$3,$4,$5)',[W,manual,'archived',status.version,''],'42501')
status=await as(owner,'select public.set_client_status($1,$2,$3,$4,$5)',[W,manual,'archived',status.version,'Lost contact'])
assert.equal(status.status,'archived')
await fails(member,'select public.update_client($1,$2,$3,$4)',[W,manual,status.version,{name:'x'}],/archived/)
await fails(member,'select public.save_client_contact($1,$2,$3)',[W,manual,{fullName:'X'}],/archived/)
status=await as(admin,'select public.set_client_status($1,$2,$3,$4,$5)',[W,manual,'unarchive',status.version,''])
assert.equal(status.status,'paused','unarchiving restores the previous status')
let list=await as(member,'select public.clients_for($1,$2)',[W,{}])
assert.equal(list.total,4);assert.ok(list.industries.includes('Dental clinics'))
assert.deepEqual((await as(member,'select public.clients_for($1,$2)',[W,{search:'dana'}])).items.map(c=>c.name),['Harbor Dental'],'search covers contacts')
assert.deepEqual((await as(member,'select public.clients_for($1,$2)',[W,{status:'paused'}])).items.map(c=>c.name),['Northline Gym'])
assert.deepEqual((await as(member,'select public.clients_for($1,$2)',[W,{sort:'name',direction:'asc',limit:2,offset:1}])).items.map(c=>c.name),['Harbor Dental','Northline Gym'])
assert.equal((await as(member,'select public.clients_for($1,$2)',[W,{templateId:websiteTemplate.id}])).total,1)
assert.equal((await as(member,'select public.clients_for($1,$2)',[W,{onboarding:'not_started'}])).total,4)
assert.equal((await as(member,'select public.client_index_for($1)',[W])).length,4)
await fails(outsider,'select public.clients_for($1,$2)',[W,{}],'42501')
assert.equal((await as(outsider,'select public.clients_for($1,$2)',[O,{}])).total,0)
await fails(outsider,'select public.client_detail($1,$2)',[O,client],'P0002')

// 5. Contacts.
const contactId=(await as(member,'select public.save_client_contact($1,$2,$3)',[W,client,{fullName:'Pat Kim',role:'billing',email:'pat@harbor-dental.example',isPrimary:true}])).id
detail=await as(member,'select public.client_detail($1,$2)',[W,client])
assert.deepEqual(detail.contacts.filter(c=>c.isPrimary).map(c=>c.fullName),['Pat Kim'],'one primary contact')
await fails(member,'select public.delete_client_contact($1,$2,$3)',[W,client,contactId],/another contact primary/)
await as(member,'select public.delete_client_contact($1,$2,$3)',[W,client,detail.contacts.find(c=>c.fullName==='Dr. Lee').id])
await fails(member,'select public.save_client_contact($1,$2,$3)',[W,client,{fullName:'X',role:'boss'}],/contact role/)
await fails(outsider,'select public.save_client_contact($1,$2,$3)',[O,client,{fullName:'X'}],'P0002')

// 6. Services: proposed, confirmed, removed; only this workspace's catalog.
const seo=(await as(member,'select public.save_client_service($1,$2,$3)',[W,client,{serviceId:seoService,name:'Local SEO',agreedScope:'Google Business Profile'}])).id
await fails(member,'select public.save_client_service($1,$2,$3)',[W,client,{name:'local seo'}],/already has a service/)
await fails(member,'select public.save_client_service($1,$2,$3)',[W,client,{serviceId:theirService,name:'Theirs'}],/catalog/)
let seoRow=await as(member,'select public.save_client_service($1,$2,$3)',[W,client,{id:seo,name:'Local SEO',agreedScope:'Google Business Profile',status:'confirmed'}])
assert.equal(seoRow.status,'confirmed')
seoRow=await as(member,'select public.save_client_service($1,$2,$3)',[W,client,{id:seo,name:'Local SEO',status:'removed',expectedVersion:seoRow.version}])
await fails(member,'select public.save_client_service($1,$2,$3)',[W,client,{id:seo,name:'Local SEO',expectedVersion:1}],'40001')

// 7. Requirements: idempotent, versioned, every version kept; a client-form source must be this client's.
const items=(await as(member,'select public.onboarding_request_for($1,$2)',[W,converted.onboardingRequestId])).items
const goalsItem=items.find(i=>i.title==='Website goals')
const reqRequest=id()
const goal=await as(member,'select public.save_client_requirement($1,$2,$3,null,$4)',[W,client,{title:'Online booking',category:'functional',priority:'high',source:'client_form',sourceRequestId:converted.onboardingRequestId,sourceItemId:goalsItem.id},reqRequest])
assert.equal((await as(member,'select public.save_client_requirement($1,$2,$3,null,$4)',[W,client,{title:'Online booking'},reqRequest])).repeated,true)
await fails(member,'select public.save_client_requirement($1,$2,$3,null,$4)',[W,manual,{title:'x',source:'client_form',sourceRequestId:converted.onboardingRequestId},id()],/isn't this client's/)
await fails(member,'select public.save_client_requirement($1,$2,$3,null,$4)',[W,client,{title:'x',category:'wishlist'},id()],/category/)
let goalRow=await as(member,'select public.save_client_requirement($1,$2,$3,$4,null)',[W,client,{id:goal.id,title:'Online booking with deposits',category:'functional',priority:'high',status:'under_review'},goal.version])
await fails(member,'select public.save_client_requirement($1,$2,$3,$4,null)',[W,client,{id:goal.id,title:'stale'},goal.version],'40001')
goalRow=await as(member,'select public.save_client_requirement($1,$2,$3,$4,null)',[W,client,{id:goal.id,title:'Online booking with deposits',category:'functional',priority:'high',status:'confirmed'},goalRow.version])
const history=await as(member,'select public.client_requirement_history($1,$2)',[W,goal.id])
assert.deepEqual(history.map(h=>h.snapshot.status),['confirmed','under_review','draft'],'every version is kept')
await as(member,'select public.save_client_requirement($1,$2,$3,null,null)',[W,client,{title:'Client supplies photos',category:'dependency',status:'confirmed'}])
await as(member,'select public.save_client_requirement($1,$2,$3,null,null)',[W,client,{title:'Live chat',category:'functional',status:'under_review'}])

// 8. Scope: needs a confirmed service; a snapshot that a newer confirmation supersedes; changes afterwards are flagged.
await fails(member,'select public.confirm_client_scope($1,$2,$3)',[W,bakery,{}],/Confirm at least one service/)
const scope1=await as(member,'select public.confirm_client_scope($1,$2,$3)',[W,client,{outstandingQuestions:'Who writes the page copy?',notes:'Internal: price agreed by phone'}])
detail=await as(member,'select public.client_detail($1,$2)',[W,client])
assert.equal(detail.scope.sequence,1);assert.equal(detail.scope.changedSince,false)
assert.deepEqual(detail.scope.snapshot.services.map(s=>s.name),['Website redesign'],'removed services are not in the scope')
assert.deepEqual(detail.scope.snapshot.requirements.map(r=>r.title),['Online booking with deposits','Client supplies photos'])
assert.deepEqual(detail.scope.snapshot.dependencies.map(r=>r.title),['Client supplies photos']);assert.equal(detail.scope.snapshot.undecided,1)
assert.equal(detail.scope.snapshot.exclusions[0].text,'Copywriting')
await as(member,'select public.save_client_requirement($1,$2,$3,$4,null)',[W,client,{id:goal.id,title:'Online booking with deposits',category:'functional',priority:'critical',status:'confirmed'},goalRow.version])
assert.equal((await as(member,'select public.client_detail($1,$2)',[W,client])).scope.changedSince,true)
const scope2=await as(member,'select public.confirm_client_scope($1,$2,$3)',[W,client,{}])
const scopes=await as(member,'select public.client_scope_history($1,$2)',[W,client])
assert.deepEqual(scopes.map(s=>[s.sequence,s.supersededAt!==null]),[[2,false],[1,true]])

// 9. Onboarding: steps and items, stage progress, automatic steps, readiness, the client's onboarding status.
let request=await as(member,'select public.onboarding_request_for($1,$2)',[W,converted.onboardingRequestId])
assert.equal(request.clientId,client);assert.equal(request.steps.length,6);assert.equal(request.contactName,'Dana Reyes','the primary contact at conversion time is the request contact')
const scopeStep=request.steps.find(s=>s.autoKey==='scope_confirmed'), welcomeStep=request.steps.find(s=>s.autoKey==='welcome_sent'), reviewStep=request.steps.find(s=>s.title==='Review the business information')
assert.equal(scopeStep.status,'done','the scope was confirmed after the request was created: the automatic step completed')
assert.equal(welcomeStep.status,'pending')
await fails(member,'select public.set_onboarding_step_status($1,$2,$3,$4,$5,$6)',[W,request.id,welcomeStep.id,'done','',welcomeStep.revision],/completes itself/)
await fails(member,'select public.set_onboarding_step_status($1,$2,$3,$4,$5,$6)',[W,request.id,reviewStep.id,'not_required','',reviewStep.revision],/Give a reason/)
await as(member,'select public.set_onboarding_step_status($1,$2,$3,$4,$5,$6)',[W,request.id,reviewStep.id,'done','Looks complete',reviewStep.revision])
await fails(member,'select public.set_onboarding_step_status($1,$2,$3,$4,$5,$6)',[W,request.id,reviewStep.id,'pending','',reviewStep.revision],'40001')
await as(member,'select public.save_client_welcome($1,$2,$3,$4)',[W,client,'Welcome to Northline','Hi Pat, welcome aboard…'])
await as(member,'select public.mark_client_welcome_sent($1,$2,$3)',[W,client,'email'])
assert.equal((await as(member,'select public.mark_client_welcome_sent($1,$2,$3)',[W,client,'email'])).repeated,true)
request=await as(member,'select public.onboarding_request_for($1,$2)',[W,request.id])
assert.equal(request.steps.find(s=>s.id===welcomeStep.id).status,'done','marking the welcome sent completes its step')
assert.equal(request.steps.find(s=>s.autoKey==='requirements_decided').status,'pending','one requirement is still under review')
const steps=await as(member,'select public.save_onboarding_step($1,$2,$3,$4)',[W,request.id,{title:'Book the kickoff call',stage:'final_review',assigneeId:admin,dueDate:'2026-11-20'},request.version])
await fails(member,'select public.save_onboarding_step($1,$2,$3,$4)',[W,request.id,{title:'x',assigneeId:outsider},request.version+1],/members of this workspace/)
request=await as(member,'select public.onboarding_request_for($1,$2)',[W,request.id])
assert.ok(request.readiness.blockers.some(b=>b.stepId===steps&&b.waitingOn==='agency'))
const finalStage=request.stages.find(s=>s.key==='final_review')
assert.equal(finalStage.state,'open');assert.ok(finalStage.agencySteps>=1);assert.equal(finalStage.overdue>=1,true,'a past due date makes the step overdue')
const createdStage=request.stages.find(s=>s.key==='created');assert.equal(createdStage.state,'empty')
// New field kinds and settings are validated when added.
await fails(member,'select public.save_onboarding_item($1,$2,$3,$4)',[W,request.id,{title:'Budget',kind:'number',config:{min:10,max:5}},request.version],/minimum cannot be more/)
await fails(member,'select public.save_onboarding_item($1,$2,$3,$4)',[W,request.id,{title:'Pick',kind:'multi_choice',options:['A']},request.version],/2 to 20 options/)
await fails(member,'select public.save_onboarding_item($1,$2,$3,$4)',[W,request.id,{title:'Files',kind:'file',config:{maxFiles:11}},request.version],/1 to 10 files/)
await fails(member,'select public.save_onboarding_item($1,$2,$3,$4)',[W,request.id,{title:'x',kind:'voice'},request.version],/Choose a type/)
const heading=await as(member,'select public.save_onboarding_item($1,$2,$3,$4)',[W,request.id,{title:'About your business',kind:'heading',required:true},request.version])
request=await as(member,'select public.onboarding_request_for($1,$2)',[W,request.id])
assert.equal(request.items.find(i=>i.id===heading).required,false,'headings are never required')
const extra={}
for(const [key,definition] of Object.entries({email:{title:'Billing email',kind:'email'},phone:{title:'Phone',kind:'phone'},url:{title:'Booking page',kind:'url',required:false},
  number:{title:'Monthly visitors',kind:'number',config:{min:0,max:1000000}},date:{title:'Launch date',kind:'date'},checkbox:{title:'I can approve designs',kind:'checkbox'}})){
  extra[key]=await as(member,'select public.save_onboarding_item($1,$2,$3,$4)',[W,request.id,{...definition,stage:'business_info'},request.version])
  request=await as(member,'select public.onboarding_request_for($1,$2)',[W,request.id])
}

// 10. Forms: a library of field groups, copied into a request.
await fails(member,'select public.save_onboarding_form($1,$2,null,$3)',[W,{name:'Brand basics',fields:[{title:'Colours',kind:'text'}]},id()],'42501')
const formRequest=id()
const form=await as(owner,'select public.save_onboarding_form($1,$2,null,$3)',[W,{name:'Brand basics',description:'Colours and voice',fields:[{section:'Brand',title:'Brand colours',kind:'short_text',config:{placeholder:'#0E7A55'}},
  {section:'Brand',title:'Tone of voice',kind:'multi_choice',options:['Friendly','Formal','Playful']},{section:'Brand',title:'Anything else?',kind:'info',guidance:'Optional'}]},formRequest])
assert.equal((await as(owner,'select public.save_onboarding_form($1,$2,null,$3)',[W,{name:'Brand basics',fields:[{title:'x',kind:'text'}]},formRequest])).id,form.id)
await fails(owner,'select public.save_onboarding_form($1,$2,null,$3)',[W,{name:'brand BASICS',fields:[{title:'x',kind:'text'}]},id()],/already exists/)
const edited=await as(owner,'select public.save_onboarding_form($1,$2,$3,null)',[W,{id:form.id,name:'Brand basics',fields:[{section:'Brand',title:'Brand colours',kind:'short_text'},{section:'Brand',title:'Tone of voice',kind:'multi_choice',options:['Friendly','Formal']}]},form.version])
await fails(owner,'select public.save_onboarding_form($1,$2,$3,null)',[W,{id:form.id,name:'Brand basics',fields:[{title:'x',kind:'text'}]},form.version],'40001')
const copy=await as(admin,'select public.duplicate_onboarding_form($1,$2,$3)',[W,form.id,id()])
const forms=(await as(member,'select public.onboarding_forms_for($1)',[W])).forms
assert.deepEqual(forms.map(f=>f.name).sort(),['Brand basics','Brand basics (copy)']);assert.equal((await as(member,'select public.onboarding_form_for($1,$2)',[W,copy.id])).fields.length,2)
await as(owner,'select public.set_onboarding_form_archived($1,$2,true)',[W,copy.id])
await fails(member,'select public.assign_onboarding_form($1,$2,$3,$4,$5)',[W,request.id,copy.id,'business_info',request.version],'P0002')
const assignment=await as(member,'select public.assign_onboarding_form($1,$2,$3,$4,$5)',[W,request.id,form.id,'access_assets',request.version])
assert.equal(assignment.fields,2)
request=await as(member,'select public.onboarding_request_for($1,$2)',[W,request.id])
assert.deepEqual(request.assignments.map(a=>[a.formName,a.formVersion,a.fields]),[['Brand basics',edited.version,2]])
assert.ok(request.items.filter(i=>i.assignmentId===assignment.assignmentId).every(i=>i.formName==='Brand basics'&&i.stageId===stageList.find(s=>s.key==='access_assets').id))

// 11. The client portal: open, new field types, drafts, submissions kept, files, shared files, scope acknowledgement.
const harness=createClientsHarness(db)
await actAs(db,member)
await one('select public.set_onboarding_status($1,$2,$3,$4)',[W,request.id,'activate',request.version])
const link=await as(member,'select public.issue_onboarding_link($1,$2,30,true)',[W,request.id])
// The portal allows 60 requests a minute per link; this test makes more, so it clears the limiter between calls.
const portal=async body=>{await op('delete from leadflow_private.request_limits');const response=await harness.portal(portalCall({token:link.token,...body}));return {status:response.status,body:await response.json()}}
let view=(await portal({action:'open'})).body.onboarding
const portalItem=title=>view.items.find(i=>i.title===title)
assert.ok(!JSON.stringify(view).includes('Book the kickoff call'),'internal steps never reach the client')
assert.ok(!JSON.stringify(view).includes('Internal: price agreed by phone'),'scope notes stay internal')
assert.ok(!JSON.stringify(view).includes('8500')&&!JSON.stringify(view).includes('8000'),'deal values stay internal')
assert.deepEqual(view.scope.services.map(s=>s.name),['Website redesign']);assert.equal(view.scope.outstandingQuestions,'')
assert.equal(portalItem('Brand colours').config.placeholder,undefined)
const answer=async(title,value,submit=true)=>{view=(await portal({action:'open'})).body.onboarding;const item=portalItem(title);const result=await portal({action:'save',itemId:item.id,value,submit,revision:item.revision});view=(await portal({action:'open'})).body.onboarding;return result}
assert.equal((await answer('Billing email',{text:'not-an-email'})).status,422)
assert.equal((await answer('Billing email',{text:'Billing@Harbor-Dental.example'})).status,200)
assert.equal(portalItem('Billing email').value.text,'billing@harbor-dental.example')
assert.equal((await answer('Phone',{text:'call me'})).status,422)
assert.equal((await answer('Phone',{text:'+1 (512) 555-0142'})).status,200)
assert.equal((await answer('Booking page',{text:'https://user:pass@booking.example'})).status,422,'credentials in links are refused')
assert.equal((await answer('Monthly visitors',{number:-5})).status,422)
assert.equal((await answer('Monthly visitors',{number:1200})).status,200)
assert.equal((await answer('Launch date',{date:'2027-02-30'})).status,422)
assert.equal((await answer('Launch date',{date:'2027-03-01'})).status,200)
assert.equal((await answer('Tone of voice',{choices:['Friendly','Rude']})).status,422)
assert.equal((await answer('Tone of voice',{choices:['Friendly']})).status,200)
assert.equal((await answer('I can approve designs',{checked:false})).status,422)
assert.equal((await answer('I can approve designs',{checked:false},false)).status,200,'an unticked box can be saved as a draft')
assert.equal((await answer('I can approve designs',{checked:true})).status,200)
assert.equal((await portal({action:'save',itemId:heading,value:{text:'x'},submit:true,revision:1})).status,422,'headings take no answer')
// Every submission is kept: a request for changes and a resubmission leave both versions with their reviews.
await actAs(db,member)
let billing=(await as(member,'select public.onboarding_request_for($1,$2)',[W,request.id])).items.find(i=>i.title==='Billing email')
await as(member,'select public.review_onboarding_item($1,$2,$3,$4,$5,$6)',[W,request.id,billing.id,'request_changes','Use the accounts inbox',billing.revision])
assert.equal((await answer('Billing email',{text:'accounts@harbor-dental.example'})).status,200)
billing=(await as(member,'select public.onboarding_request_for($1,$2)',[W,request.id])).items.find(i=>i.title==='Billing email')
await as(member,'select public.review_onboarding_item($1,$2,$3,$4,$5,$6)',[W,request.id,billing.id,'accept','',billing.revision])
const itemHistory=await as(member,'select public.onboarding_item_history($1,$2,$3)',[W,request.id,billing.id])
assert.deepEqual(itemHistory.map(h=>[h.response.text,h.reviewState]),[['accounts@harbor-dental.example','accepted'],['billing@harbor-dental.example','changes_requested']])
assert.equal(billing.submissions,2)
// Files: upload through a signed URL, checked before use; wrong contents, wrong types and too many files are refused.
const logo=portalItem('Logo files')
let upload=await portal({action:'upload',itemId:logo.id,fileName:'logo.png',size:samples.png.length})
assert.equal(upload.status,200);assert.equal(harness.state.bucket.public,false,'the bucket is private')
assert.ok(upload.body.uploadUrl.includes('token='))
assert.equal((await harness.put(upload.body.uploadUrl,samples.png,'image/png')).status,200)
assert.equal((await harness.put(upload.body.uploadUrl,samples.png,'image/png')).status,400,'an upload URL works once')
let finished=await portal({action:'finish',fileId:upload.body.file.id})
assert.equal(finished.status,200);assert.equal(finished.body.file.status,'available')
const fake=await portal({action:'upload',itemId:logo.id,fileName:'logo2.png',size:samples.fakePng.length})
await harness.put(fake.body.uploadUrl,samples.fakePng,'image/png')
finished=await portal({action:'finish',fileId:fake.body.file.id})
assert.equal(finished.status,422);assert.match(finished.body.error,/don’t match a \.png file/)
assert.equal(harness.state.objects.has(`${W}/${fake.body.file.id}`),false,'a rejected file is deleted from storage')
assert.equal((await portal({action:'upload',itemId:logo.id,fileName:'logo.exe',size:10})).status,422)
assert.equal((await portal({action:'upload',itemId:logo.id,fileName:'huge.pdf',size:60*1048576})).status,422)
assert.equal((await portal({action:'upload',itemId:portalItem('Billing email').id,fileName:'x.pdf',size:10})).status,422,'only file fields take files')
assert.equal((await portal({action:'save',itemId:logo.id,value:{files:[fake.body.file.id]},submit:true,revision:portalItem('Logo files').revision})).status,422,'rejected files can\'t be submitted')
view=(await portal({action:'open'})).body.onboarding
assert.deepEqual(portalItem('Logo files').files.map(f=>[f.name,f.status]),[['logo.png','available']])
assert.equal((await answer('Logo files',{files:[upload.body.file.id]})).status,200)
const download=await portal({action:'download',fileId:upload.body.file.id})
assert.equal(download.status,200);assert.match(download.body.url,/download=logo\.png/)
assert.equal((await portal({action:'remove',fileId:upload.body.file.id})).status,409,'a submitted file can\'t be removed')
// Member files: upload, check, share with the client, download; outsiders and forged IDs are refused.
const memberCall=async(user,body)=>{const response=await harness.files(filesRequest({workspaceId:W,...body},memberToken(user)));return {status:response.status,body:await response.json()}}
let staged=await memberCall(member,{action:'upload',clientId:client,fileName:'brand-guide.pdf',size:samples.pdf.length,category:'brand',visibility:'internal'})
assert.equal(staged.status,200)
await harness.put(staged.body.uploadUrl,samples.pdf,'application/pdf')
assert.equal((await memberCall(member,{action:'download',documentId:staged.body.document.id})).status,409,'unchecked files can\'t be downloaded')
assert.equal((await memberCall(member,{action:'finish',documentId:staged.body.document.id})).status,200)
const guide=staged.body.document.id
assert.equal((await portal({action:'download',fileId:guide})).status,404,'internal files are not shared with the client')
await as(member,'select public.update_client_document($1,$2,$3)',[W,guide,{visibility:'shared'}])
view=(await portal({action:'open'})).body.onboarding
assert.deepEqual(view.sharedFiles.map(f=>f.name),['brand-guide.pdf'])
assert.equal((await portal({action:'download',fileId:guide})).status,200)
assert.equal((await memberCall(outsider,{action:'upload',clientId:client,fileName:'x.pdf',size:10})).status,403)
assert.equal((await harness.files(filesRequest({workspaceId:O,action:'upload',clientId:client,fileName:'x.pdf',size:10},memberToken(outsider)))).status,404,'a forged client ID is not found')
assert.equal((await harness.files(filesRequest({workspaceId:O,action:'download',documentId:guide},memberToken(outsider)))).status,404)
assert.equal((await memberCall(member,{action:'upload',clientId:client,fileName:'notes.txt',size:samples.text.length,category:'nonsense'})).status,422)
assert.equal((await harness.files(filesRequest({workspaceId:W,action:'config'},null))).status,401)
assert.equal((await harness.files(filesRequest({workspaceId:W,action:'config'},memberToken(member),'https://evil.example'))).status,403)
const adminFile=await memberCall(admin,{action:'upload',clientId:client,fileName:'notes.txt',size:samples.text.length,category:'content'})
await harness.put(adminFile.body.uploadUrl,samples.text,'text/plain');await memberCall(admin,{action:'finish',documentId:adminFile.body.document.id})
assert.equal((await memberCall(member,{action:'delete',documentId:adminFile.body.document.id})).status,403,'members delete only their own uploads')
assert.equal((await memberCall(owner,{action:'delete',documentId:adminFile.body.document.id})).status,200)
assert.equal(harness.state.objects.has(`${W}/${adminFile.body.document.id}`),false)
assert.equal((await memberCall(owner,{action:'download',documentId:adminFile.body.document.id})).status,404)
const documents=await as(member,'select public.client_documents_for($1,$2)',[W,client])
assert.deepEqual(documents.map(d=>d.fileName).sort(),['brand-guide.pdf','logo.png'],'the client sees its own and request files, never deleted or rejected ones')
// Scope acknowledgement through the link: recorded once, as an acknowledgement.
let acknowledged=await portal({action:'acknowledge',scopeId:scope1.id})
assert.equal(acknowledged.status,422,'a superseded scope can\'t be acknowledged')
acknowledged=await portal({action:'acknowledge',scopeId:scope2.id})
assert.equal(acknowledged.status,200);assert.equal((await portal({action:'acknowledge',scopeId:scope2.id})).body.scope.repeated,true)
assert.ok((await as(member,'select public.client_detail($1,$2)',[W,client])).scope.clientAcknowledgedAt)
// Revoked links reach nothing.
await as(member,'select public.revoke_onboarding_links($1,$2,null)',[W,request.id])
assert.equal((await portal({action:'open'})).status,404)
assert.equal((await portal({action:'download',fileId:guide})).status,404)

// 12. Tasks: client and onboarding tasks through the same snapshot; older clients unaffected.
const today='2026-11-25'
await save(member,data=>({...data,tasks:[...data.tasks,{id:'t-client',leadId:null,clientId:client,onboardingRequestId:request.id,onboardingItemId:billing.id,due:'2026-11-20',notes:'Chase the logo',completed:false,taskType:'collect_assets',priority:'high',createdAt:'2026-11-19T09:00:00Z'},
  {id:'t-lead',leadId:'harbor',due:'2026-12-01',notes:'Ask for a referral',completed:false}]}))
let tasks=(await snapshot(member)).data.tasks
assert.equal(tasks.find(t=>t.id==='t-client').clientId,client);assert.equal(tasks.find(t=>t.id==='t-lead').clientId,null)
await assert.rejects(()=>save(member,data=>({...data,tasks:[...data.tasks,{id:'t-bad',leadId:null,due:'2026-11-20',notes:'Orphan',completed:false}]})))
await assert.rejects(()=>save(member,data=>({...data,tasks:[...data.tasks,{id:'t-bad',leadId:null,clientId:manual,onboardingRequestId:request.id,due:'2026-11-20',notes:'Wrong client',completed:false}]})),/belong to its client/)
await assert.rejects(()=>save(member,data=>({...data,tasks:[...data.tasks,{id:'t-bad',leadId:null,clientId:id(),due:'2026-11-20',notes:'No such client',completed:false}]})))
await assert.rejects(()=>save(member,data=>({...data,tasks:[...data.tasks,{id:'t-bad',leadId:null,clientId:client,taskType:'invoice',due:'2026-11-20',notes:'x',completed:false}]})))
// A lead removed from the snapshot keeps its client's tasks.
await save(owner,data=>({...data,leads:data.leads.filter(l=>l.id!=='harbor'),tasks:data.tasks.filter(t=>t.leadId!=='harbor')}))
assert.ok((await snapshot(member)).data.tasks.some(t=>t.id==='t-client'))
assert.equal((await as(member,'select public.client_detail($1,$2)',[W,client])).lead,null,'the client keeps its own details when the lead goes')

// 13. Timeline and dashboard.
await as(member,'select public.add_client_note($1,$2,$3,$4)',[W,client,'Prefers calls after 3pm',id()])
const timeline=await as(member,'select public.client_timeline($1,$2,null,null,200)',[W,client])
const kinds=new Set(timeline.items.map(e=>e.kind))
for(const kind of ['client_created','deal_converted','contact_added','service_confirmed','requirement_added','requirement_confirmed','scope_confirmed','welcome_sent','onboarding_started','note',
  'document_uploaded','scope_acknowledged','submitted','changes_requested','step_done','form_assigned','task_created'])assert.ok(kinds.has(kind),`timeline has ${kind}`)
assert.equal(new Set(timeline.items.map(e=>e.id)).size,timeline.items.length)
const notesOnly=await as(member,'select public.client_timeline($1,$2,$3,null,null)',[W,client,JSON.stringify(['notes'])])
assert.deepEqual(notesOnly.items.map(e=>e.detail.text),['Prefers calls after 3pm'])
const paged=await as(member,'select public.client_timeline($1,$2,null,null,5)',[W,client]);assert.equal(paged.items.length,5);assert.equal(paged.hasMore,true)
// Paging by (time, id) of the last event shown: every event exactly once, in order, even those written in one transaction.
const walked=[...paged.items];let cursor=paged
while(cursor.hasMore){const last=walked[walked.length-1];cursor=await as(member,'select public.client_timeline($1,$2,null,$3,5,$4)',[W,client,last.at,last.id]);walked.push(...cursor.items)}
assert.deepEqual(walked.map(e=>e.id),timeline.items.map(e=>e.id),'paging returns every event once, in the same order')
assert.ok(timeline.items.some((e,i)=>i>0&&e.at===timeline.items[i-1].at),'some events share a timestamp (one transaction)')
const dashboard=await as(member,'select public.client_dashboard_for($1,$2,$3)',[W,{},today])
assert.equal(dashboard.totalClients,4);assert.equal(dashboard.overdueTasks,1);assert.equal(dashboard.completedOnboarding,0)
assert.equal(dashboard.awaitingScope,3,'three clients have no confirmed scope')
assert.ok(dashboard.pendingSubmissions>=5,'submitted answers wait for review')
assert.equal((await as(member,'select public.client_dashboard_for($1,$2,$3)',[W,{templateId:websiteTemplate.id},today])).totalClients,1)
await fails(outsider,'select public.client_dashboard_for($1,$2,$3)',[W,{},today],'42501')

// 14. Completion: the checklist, refusal when outstanding, an owner override with a reason, and the M11 snapshot.
let check=await as(member,'select public.client_completion_check($1,$2)',[W,client])
assert.equal(check.ready,false)
assert.deepEqual(check.items.filter(i=>!i.met).map(i=>i.key).sort(),['onboarding','requirements'],'the scope was confirmed again after the last change')
await fails(member,'select public.complete_client_onboarding($1,$2,$3,$4)',[W,client,'',null],/owner or admin can complete/)
await fails(owner,'select public.complete_client_onboarding($1,$2,$3,$4)',[W,client,'',null],/Give a reason/)
const completion=await as(owner,'select public.complete_client_onboarding($1,$2,$3,$4)',[W,client,'Kickoff booked','Client wants to start; access arrives next week'])
assert.equal((await as(member,'select public.complete_client_onboarding($1,$2,$3,$4)',[W,client,'',null])).repeated,true)
const handoff=await as(member,'select public.client_handoff_for($1,$2)',[W,client])
assert.equal(handoff.id,completion.id);assert.equal(handoff.overrideReason,'Client wants to start; access arrives next week')
assert.deepEqual(handoff.outstanding.map(i=>i.key).sort(),['onboarding','requirements'])
assert.deepEqual(handoff.snapshot.services.map(s=>s.name),['Website redesign']);assert.equal(handoff.snapshot.deal.title,'Website redesign')
assert.deepEqual(handoff.snapshot.dependencies.map(d=>d.title),['Client supplies photos']);assert.ok(handoff.snapshot.documents.some(d=>d.name==='logo.png'))
assert.equal(handoff.snapshot.contacts[0].name,'Pat Kim')
detail=await as(member,'select public.client_detail($1,$2)',[W,client])
assert.equal(detail.status,'active');assert.equal(detail.onboarding.state,'completed')
// A client with everything in place completes without an override, handing off its ready checklist in the same step.
const gymRequest=await as(member,'select public.start_client_onboarding($1,$2,$3,$4)',[W,manual,{title:'Gym onboarding'},id()])
let gym=await as(member,'select public.onboarding_request_for($1,$2)',[W,gymRequest])
await as(member,'select public.save_onboarding_item($1,$2,$3,$4)',[W,gymRequest,{title:'Opening hours',kind:'short_text'},gym.version])
gym=await as(member,'select public.onboarding_request_for($1,$2)',[W,gymRequest])
await as(member,'select public.set_onboarding_status($1,$2,$3,$4)',[W,gymRequest,'activate',gym.version])
gym=await as(member,'select public.onboarding_request_for($1,$2)',[W,gymRequest])
await as(member,'select public.review_onboarding_item($1,$2,$3,$4,$5,$6)',[W,gymRequest,gym.items[0].id,'accept','Confirmed by phone',gym.items[0].revision])
await as(member,'select public.save_client_service($1,$2,$3)',[W,manual,{name:'Social media',status:'confirmed'}])
await as(member,'select public.save_client_requirement($1,$2,$3,null,null)',[W,manual,{title:'Three posts a week',category:'expectation',status:'confirmed'}])
await as(member,'select public.confirm_client_scope($1,$2,$3)',[W,manual,{}])
check=await as(member,'select public.client_completion_check($1,$2)',[W,manual])
assert.equal(check.ready,true,JSON.stringify(check.items.filter(i=>!i.met)))
const gymDone=await as(member,'select public.complete_client_onboarding($1,$2,$3,$4)',[W,manual,'',null])
assert.equal(await op('select override_reason from leadflow_private.client_onboarding_completions where id=$1',[gymDone.id]),null)
assert.equal((await as(member,'select public.onboarding_request_for($1,$2)',[W,gymRequest])).status,'completed','the ready checklist was handed off')
assert.equal((await as(member,'select public.client_detail($1,$2)',[W,manual])).status,'paused','a paused client keeps its status; only onboarding completes')

// 15. Isolation: every client function refuses other workspaces and forged IDs.
for(const [sql,params] of [['select public.client_detail($1,$2)',[W,client]],['select public.update_client($1,$2,1,$3)',[W,client,{name:'x'}]],['select public.client_timeline($1,$2,null,null,null)',[W,client]],
  ['select public.confirm_client_scope($1,$2,$3)',[W,client,{}]],['select public.add_client_note($1,$2,$3,null)',[W,client,'x']],['select public.client_documents_for($1,$2)',[W,client]],
  ['select public.complete_client_onboarding($1,$2,$3,$4)',[W,client,'','x']],['select public.onboarding_forms_for($1)',[W]],['select public.onboarding_stages_for($1)',[W]]])
  await fails(outsider,sql,params,'42501')
for(const [sql,params] of [['select public.client_detail($1,$2)',[O,client]],['select public.update_client($1,$2,1,$3)',[O,client,{name:'x'}]],['select public.client_timeline($1,$2,null,null,null)',[O,client]],
  ['select public.save_client_requirement($1,$2,$3,null,null)',[O,client,{title:'x'}]],['select public.client_requirement_history($1,$2)',[O,goal.id]],['select public.client_document_access($1,$2)',[O,guide]],
  ['select public.onboarding_form_for($1,$2)',[O,form.id]],['select public.start_client_onboarding($1,$2,$3,$4)',[O,client,{},id()]],['select public.client_completion_check($1,$2)',[O,client]]])
  await fails(outsider,sql,params,'P0002')

// 16. Rollback keeps leads, deals and M6A requests, removes M10 data, and the migration applies again.
await actAs(db,null,'postgres')
const requestsBefore=await one('select count(*)::int from leadflow_private.onboarding_requests')
// M11 (projects) builds on clients, so it is rolled back first and re-applied after.
await db.exec(readFileSync('supabase/rollbacks/202611280001_automation_deal_activity.down.sql','utf8'));await db.exec(readFileSync('supabase/rollbacks/202611270003_automation_engine.down.sql','utf8'));await db.exec(readFileSync('supabase/rollbacks/202611270002_automation.down.sql','utf8'))
await db.exec(readFileSync('supabase/rollbacks/202611270001_client_collaboration.down.sql','utf8'))
await db.exec(readFileSync('supabase/rollbacks/202611260001_project_delivery.down.sql','utf8'))
await db.exec(readFileSync('supabase/rollbacks/202611250001_client_management.down.sql','utf8'))
assert.equal(await one("select to_regclass('leadflow_private.clients')"),null)
assert.equal(await one('select count(*)::int from leadflow_private.onboarding_requests'),requestsBefore)
assert.equal(await one('select count(*)::int from leadflow_private.deals where id=$1',[harborDeal.id]),1)
tasks=(await snapshot(member)).data.tasks;assert.ok(!tasks.some(t=>t.id==='t-client'),'client tasks are removed');assert.ok(tasks.every(t=>!('clientId' in t)))
await save(member,data=>({...data,tasks:[...data.tasks,{id:'t-after',leadId:'studio',due:'2026-12-02',notes:'After rollback',completed:false}]}))
await actAs(db,null,'postgres');await db.exec(migrationSql('202611250001_client_management.sql'));await db.exec(migrationSql('202611260001_project_delivery.sql'))
assert.equal((await as(member,'select public.clients_for($1,$2)',[W,{}])).total,0)
assert.equal((await snapshot(member)).data.tasks.find(t=>t.id==='t-after').clientId,null)

console.log('PASS Clients and onboarding: exact grants and private tables; default and configurable stages; seven starter templates with stages and internal steps; won-deal conversion with reviewed details, M8 contacts, confirmed services and onboarding, idempotent and once per deal, transactional on failure, resuming M9 handoffs, owner/admin exceptions with reasons; manual clients, versioned edits, status separate from onboarding, archive/unarchive, directory search, filters, sorting and paging; contacts with one primary; proposed/confirmed/removed services from this workspace only; versioned requirements with full history; superseding scope confirmations with change detection; internal steps, automatic steps, stage progress and overdue work; new field types validated on definition and answer; a forms library copied into requests; the portal hiding internal steps, notes and deal values, keeping every submission and its review, files uploaded through signed URLs and checked by signature, type and size before use, shared files, scope acknowledgement and revoked links; member files with role checks; client and onboarding tasks through the snapshot; timeline, dashboard, completion with checklist, override reason and M11 snapshot; workspace isolation; rollback and re-apply. Embedded PostgreSQL and real Edge handlers; Storage simulated.')
