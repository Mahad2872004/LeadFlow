import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDatabase, actAs } from '../tests/support/database.ts'
import { apolloKeys, apolloRequest, createApolloHarness, demoPeople } from '../tests/support/apollo.ts'
import { buildQuery, parseFilters } from '../supabase/functions/_shared/apollo/filters.ts'
// Apollo.io lead generation: the real migration SQL in embedded PostgreSQL and the real apollo and apollo-webhook handlers.
// Apollo's API is simulated from its documented shapes; no request leaves the machine and no credits are used.
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
const tokenFor=id=>[encode({alg:'HS256',typ:'JWT'}),encode({sub:id,role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600}),'test-signature'].join('.')
const owner='11111111-1111-4111-8111-111111111111', member='33333333-3333-4333-8333-333333333333', outsider='44444444-4444-4444-8444-444444444444'
const W=owner, O=outsider
const db=await createDatabase([owner,member,outsider])
const one=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0]??{})[0]
const as=async(user,sql,params=[])=>{await actAs(db,user);return one(sql,params)}
const op=async(sql,params=[])=>{await actAs(db,null,'postgres');return one(sql,params)}
await as(owner,'select public.load_workspace()');await as(member,'select public.load_workspace()');await as(outsider,'select public.load_workspace()')
await as(owner,"select public.set_workspace_member($1,$2,'member')",[W,member])
// Everything the handlers log, to prove keys and contact details never appear.
const logged=[],printLog=console.log;for(const method of ['log','error','warn']){const original=console[method];console[method]=(...args)=>{logged.push(args.join(' '));if(method!=='log')original(...args)}}
let h=createApolloHarness(db,{APOLLO_WORKSPACE_IDS:W})
h.state.people=demoPeople()
h.state.organizations=[{id:'org-harbor',name:'Harbor Dental',primary_domain:'harbor-dental.example',website_url:'http://www.harbor-dental.example',linkedin_url:'http://www.linkedin.com/company/harbor',primary_phone:{sanitized_number:'+15125550100'}}]
const call=async(body,user=owner,origin)=>{const response=await h.handler(apolloRequest({workspaceId:W,...body},user&&tokenFor(user),origin));return {status:response.status,body:await response.json()}}
const apolloCalls=()=>h.state.calls.length

// 1. Catalog: anonymous callers execute nothing; account, ledger and contact writes are service-role only; tables are private.
await actAs(db,null,'postgres')
const executable=async role=>(await db.query("select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','leadflow_private') and has_function_privilege($1,p.oid,'EXECUTE')",[role])).rows.map(row=>row.fn)
assert.deepEqual(await executable('anon'),[],'Anonymous callers cannot execute any function.')
const signedIn=await executable('authenticated'),service=await executable('service_role')
const memberFunctions=['apollo_member_role(uuid)','apollo_contacts_for(uuid,jsonb)','discovery_saved_searches_for(uuid)','save_discovery_search(uuid,uuid,text,text,jsonb)','delete_discovery_search(uuid,uuid)','lead_lists_for(uuid)','create_lead_list(uuid,text)','add_leads_to_list(uuid,uuid,jsonb)','delete_lead_list(uuid,uuid)']
const serviceFunctions=['apollo_accounts_status(text[])','apollo_update_account(text,jsonb)','apollo_record_connection(text,boolean,text)','apollo_record_sync(text,jsonb,timestamp with time zone,timestamp with time zone)','apollo_reserve(text,uuid,uuid,text,numeric,jsonb,uuid,text)','apollo_settle(uuid,text,numeric,text,text,text)','apollo_store_contacts(uuid,text,jsonb,boolean)','apollo_phone_result(text,jsonb)','apollo_mark_imported(uuid,text,jsonb,uuid)','apollo_ledger_for(uuid,jsonb)']
for(const fn of memberFunctions)assert.ok(signedIn.includes(fn),fn)
for(const fn of serviceFunctions){assert.ok(!signedIn.includes(fn),`${fn} is not for signed-in users`);assert.ok(service.includes(fn),fn)}
for(const role of ['anon','authenticated']){await actAs(db,role==='anon'?null:owner,role);for(const table of ['apollo_accounts','apollo_ledger','apollo_contacts','discovery_saved_searches','lead_lists','lead_list_members'])await assert.rejects(()=>db.query(`select * from leadflow_private.${table}`),/permission denied/,`${role} ${table}`)}

// 2. Filters: validation and the exact query string Apollo documents (arrays as param[], ranges as param[min]/[max]).
const filters=parseFilters('people',{titles:[' Marketing  Manager ','owner','owner'],similarTitles:true,seniorities:['owner','c_suite'],personLocations:['Texas, US'],employees:['1,10','11,20'],revenue:{min:'100000',max:5000000},techAny:['WordPress.org','Google Analytics'],keywords:'',emailStatus:[],growthPeriod:'12'})
assert.deepEqual(filters,{titles:['Marketing Manager','owner'],similarTitles:true,seniorities:['owner','c_suite'],personLocations:['Texas, US'],employees:['1,10','11,20'],revenue:{min:100000,max:5000000},techAny:['wordpress_org','google_analytics']},'Values are cleaned, empties and orphaned options dropped, technology IDs normalized.')
assert.equal(buildQuery('people',filters,2,25).toString(),'person_titles%5B%5D=Marketing+Manager&person_titles%5B%5D=owner&include_similar_titles=true&person_seniorities%5B%5D=owner&person_seniorities%5B%5D=c_suite&person_locations%5B%5D=Texas%2C+US&organization_num_employees_ranges%5B%5D=1%2C10&organization_num_employees_ranges%5B%5D=11%2C20&revenue_range%5Bmin%5D=100000&revenue_range%5Bmax%5D=5000000&currently_using_any_of_technology_uids%5B%5D=wordpress_org&currently_using_any_of_technology_uids%5B%5D=google_analytics&page=2&per_page=25')
for(const [kind,input,pattern] of [['people',{},/at least one filter/],['people',{departments:['sales']},/isn’t a filter/],['people',{seniorities:['boss']},/choose from the list/],['people',{revenue:{min:5,max:1}},/minimum is above/],
  ['people',{titles:Array.from({length:51},(_,i)=>`t${i}`)},/at most 50/],['organizations',{techAll:['x']},/isn’t a filter/],['organizations',{fundingDate:{min:'2026-13-45'}},/dates like/],['people',{keywords:'a\u0000b'},/at most 200/]])
  assert.throws(()=>parseFilters(kind,input),pattern)

// 3. Access: origin, sign-in, membership and the workspace allowlist. Status never includes keys.
assert.equal((await call({action:'status'},owner,'https://evil.example')).status,403)
assert.equal((await call({action:'status'},null)).status,401)
assert.equal((await call({action:'status'},outsider)).status,403,'Non-members are refused before anything else.')
let response=await call({action:'status'})
assert.deepEqual([response.status,response.body.enabled,response.body.role,response.body.phoneReveal,response.body.accounts.map(a=>[a.id,a.configured,a.monthlyAllowance])],[200,true,'owner',true,[['primary',true,70],['second',true,70]]])
assert.ok(!JSON.stringify(response.body).includes('key-'),'Keys never reach the browser.')
const otherWorkspace=createApolloHarness(db,{APOLLO_WORKSPACE_IDS:O});response=await otherWorkspace.handler(apolloRequest({workspaceId:W,action:'status'},tokenFor(owner)))
assert.deepEqual(await response.json().then(b=>[b.enabled,b.reason,b.accounts]),[false,'workspace_not_enabled',[]],'Only allowlisted workspaces can use Apollo.')
response=await otherWorkspace.handler(apolloRequest({workspaceId:W,action:'search',accountId:'primary',kind:'people',filters:{titles:['owner']}},tokenFor(owner)))
assert.equal(response.status,403)
response=await createApolloHarness(db,{APOLLO_WORKSPACE_IDS:'*',APOLLO_API_KEYS:'',APOLLO_API_KEY:undefined}).handler(apolloRequest({workspaceId:W,action:'status'},tokenFor(owner)))
assert.equal((await response.json()).reason,'no_accounts')

// 4. People search: free, recorded in history, normalized, paginated; nothing is charged.
const searchId=crypto.randomUUID()
response=await call({action:'search',accountId:'primary',kind:'people',filters:{titles:['owner']},page:1,perPage:10,searchId},member)
assert.equal(response.status,200,JSON.stringify(response.body))
assert.deepEqual([response.body.total,response.body.totalPages,response.body.items.length],[3,1,3])
const avery=response.body.items[0]
assert.deepEqual([avery.name,avery.title,avery.organizationName,avery.hasEmail,avery.directPhone],['Avery St***e','Marketing Manager','Harbor Dental',true,'yes'])
assert.equal(response.body.items[1].directPhone,'maybe')
let last=h.state.calls.at(-1);assert.deepEqual([last.path,last.key,last.query.getAll('person_titles[]'),last.query.get('per_page')],['/mixed_people/api_search',apolloKeys.primary,['owner'],'10'])
assert.equal(await op('select count(*)::int from leadflow_private.apollo_ledger'),0,'People search costs no credits.')
assert.deepEqual(await op("select jsonb_build_object('provider',provider,'status',status,'count',result_count,'account',criteria->>'account') from leadflow_private.discovery_searches where id=$1",[searchId]),{provider:'apollo_people',status:'completed',count:3,account:'primary'})
assert.equal((await call({action:'search',accountId:'primary',kind:'people',filters:{titles:['owner']},page:501,perPage:100})).status,422,'Apollo shows at most 500 pages.')
assert.equal((await call({action:'search',accountId:'nope',kind:'people',filters:{titles:['owner']}})).status,422)
h.state.failures=[502];assert.equal((await call({action:'search',accountId:'primary',kind:'people',filters:{titles:['owner']}})).status,200,'A free search is retried once after a server error.')
h.state.failures=[429,429];response=await call({action:'search',accountId:'primary',kind:'people',filters:{titles:['owner']}})
assert.deepEqual([response.status,response.body.retryAfter,response.body.code],[429,30,'apollo_rate_limited'])
h.state.failures=[{status:403,body:{error:'Forbidden',error_details:{code:'AUTH.AUTHORIZATION.ENDPOINT_ACCESS_DENIED'}}}];response=await call({action:'search',accountId:'primary',kind:'people',filters:{titles:['owner']}})
assert.deepEqual([response.status,/tick the endpoint/.test(response.body.error)],[502,true])

// 5. Company search: 1 credit per page, only after confirmation, reserved before calling and settled once.
assert.equal((await call({action:'search',accountId:'primary',kind:'organizations',filters:{industries:['marketing & advertising']}})).status,428)
const page1=crypto.randomUUID()
response=await call({action:'search',accountId:'primary',kind:'organizations',filters:{industries:['marketing & advertising']},confirmCredits:true,operationId:page1})
assert.equal(response.status,200,JSON.stringify(response.body))
assert.deepEqual(response.body.items[0],{id:'org-harbor',name:'Harbor Dental',websiteUrl:'http://www.harbor-dental.example',primaryDomain:'harbor-dental.example',linkedinUrl:'http://www.linkedin.com/company/harbor',twitterUrl:'',facebookUrl:'',phone:'+15125550100',foundedYear:2012,publiclyTradedSymbol:'',languages:['English'],naicsCodes:['54181'],sicCodes:['7311']})
const before=apolloCalls()
assert.equal((await call({action:'search',accountId:'primary',kind:'organizations',filters:{industries:['marketing & advertising']},confirmCredits:true,operationId:page1})).status,409,'A repeated operation ID is not charged or sent again.')
assert.equal(apolloCalls(),before)
h.state.failures=[{status:403,body:{error:'Forbidden',message:'This endpoint is only available to Apollo users on paid plans.'}}]
response=await call({action:'search',accountId:'primary',kind:'organizations',filters:{orgName:'Harbor'},confirmCredits:true,operationId:crypto.randomUUID()})
assert.deepEqual([response.status,response.body.code],[502,'apollo_plan'])
const ledgerRows=async()=>{await actAs(db,null,"postgres");return (await db.query("select operation,status,credits::float,estimated_credits::float as estimate,credit_basis from leadflow_private.apollo_ledger order by created_at, operation")).rows}
assert.deepEqual((await ledgerRows()).map(r=>[r.operation,r.status,r.credits,r.credit_basis]),[['organization_search','succeeded',1,'documented'],['organization_search','failed',0,'documented']])

// 6. Email reveal: credits reserved, Apollo's credits_consumed recorded, contacts stored privately, retries replayed.
const people=demoPeople(),reveal1=crypto.randomUUID()
const subjects=[{id:people[0].id,name:'Avery St***e'},{id:people[1].id,name:'Jordan L***e'},{id:'0000000000000000deadbeef',name:'Gone P***n'}]
response=await call({action:'reveal',accountId:'primary',operationId:reveal1,people:subjects},member)
assert.equal(response.status,200,JSON.stringify(response.body))
assert.deepEqual([response.body.contacts.map(c=>[c.name,c.email]),response.body.unmatched,response.body.credits,response.body.creditBasis,response.body.phonePending],
  [[['Avery Stone','avery@harbor-dental.example'],['Jordan Lee','jordan@pine-law.example']],['0000000000000000deadbeef'],2,'reported',false])
last=h.state.calls.at(-1);assert.deepEqual([last.path,last.query.get('reveal_phone_number'),last.body],['/people/bulk_match',null,{details:subjects.map(s=>({id:s.id}))}])
const revealCalls=apolloCalls()
response=await call({action:'reveal',accountId:'primary',operationId:reveal1,people:subjects},member)
assert.deepEqual([response.status,response.body.replayed,response.body.contacts.length],[200,true,2],'A retry returns the stored outcome.')
assert.equal(apolloCalls(),revealCalls,'A retry never calls Apollo or charges again.')
assert.equal(await op("select count(*)::int from leadflow_private.apollo_ledger where operation='email_reveal'"),1)
let contacts=await as(member,'select public.apollo_contacts_for($1,$2)',[W,JSON.stringify([people[0].id])])
assert.deepEqual([contacts[0].email,contacts[0].accountId,!!contacts[0].emailRevealedAt],['avery@harbor-dental.example','primary',true])
assert.deepEqual(await as(outsider,'select public.apollo_contacts_for($1,$2)',[O,JSON.stringify([people[0].id])]),[],'Revealed contacts are private to the workspace that revealed them.')
await actAs(db,outsider);await assert.rejects(()=>db.query('select public.apollo_contacts_for($1,$2)',[W,JSON.stringify([people[0].id])]),/access denied/)
assert.equal((await call({action:'reveal',accountId:'primary',operationId:crypto.randomUUID(),people:Array.from({length:11},(_,i)=>({id:`a${i}`,name:'x'}))})).status,422)

// 7. Saving: through import_leads as the user, with provenance, the account used, a list, and duplicate protection.
const list=await as(member,"select public.create_lead_list($1,'Austin dental')",[W])
assert.equal(await as(member,"select public.create_lead_list($1,'  austin DENTAL ')",[W]),list,'List names are unique per workspace, ignoring case.')
const personRow=(person,extra={})=>({key:`person:${person.id}`,providerRef:`person:${person.id}`,businessName:person.organization,contactName:extra.contactName??person.first_name,email:extra.email??'',phone:'',website:`https://${person.domain}`,
  industry:'',address:'',city:'Austin',region:'TX',postcode:'',country:'US',notes:`Title: ${person.title}`,discoveredAt:new Date().toISOString()})
const saveId=crypto.randomUUID()
response=await call({action:'save',accountId:'primary',kind:'people',searchId,requestId:saveId,listId:list,rows:[personRow(people[0],{contactName:'Avery Stone',email:'avery@harbor-dental.example'}),personRow(people[2],{contactName:'Sam Ri***a'})]},member)
assert.equal(response.status,200,JSON.stringify(response.body))
assert.deepEqual([response.body.imported.length,response.body.listed],[2,2])
let origins=await as(member,'select public.lead_origins_for($1)',[W])
const averyOrigin=origins.find(o=>o.providerRef===`person:${people[0].id}`)
assert.deepEqual([averyOrigin.provider,averyOrigin.accountRef,!!averyOrigin.emailRevealedAt,averyOrigin.searchId],['apollo_people','primary',true,searchId])
response=await call({action:'save',accountId:'primary',kind:'people',requestId:crypto.randomUUID(),rows:[personRow(people[0])]},member)
assert.deepEqual(response.body.skipped.map(s=>s.reason),['same_record'],'The same Apollo person is never saved twice.')
assert.equal((await call({action:'save',accountId:'primary',kind:'people',requestId:crypto.randomUUID(),rows:[{...personRow(people[1]),providerRef:'org:x'}]})).status,422)
let lists=await as(member,'select public.lead_lists_for($1)',[W]);assert.deepEqual(lists.map(l=>[l.name,l.leadIds.length]),[['Austin dental',2]])
await actAs(db,member);await assert.rejects(()=>db.query('select public.delete_lead_list($1,$2)',[W,list]),/role does not allow/)
await actAs(db,outsider);await assert.rejects(()=>db.query('select public.add_leads_to_list($1,$2,$3)',[W,list,'[]']),/access denied/)

// 8. Phone reveal: an HTTPS webhook URL with a one-time token; credits stay pending until Apollo delivers; replays change nothing.
const samLead=response=await as(owner,'select public.load_workspace()');const sam=samLead.data.leads.find(l=>l.name==='Sam Ri***a')
assert.ok(sam,'A person saved before revealing keeps the masked name.')
const reveal2=crypto.randomUUID()
response=await call({action:'reveal',accountId:'primary',operationId:reveal2,people:[{id:people[0].id,name:'Avery Stone'},{id:people[2].id,name:'Sam Ri***a'}],phone:true})
assert.deepEqual([response.status,response.body.phonePending],[200,true])
last=h.state.calls.at(-1);const webhookUrl=new URL(last.query.get('webhook_url'))
assert.deepEqual([last.query.get('reveal_phone_number'),webhookUrl.origin+webhookUrl.pathname],['true','https://project.test/functions/v1/apollo-webhook'])
const token=webhookUrl.searchParams.get('token');assert.match(token,/^lf_[0-9a-f]{64}$/)
assert.equal(await op("select count(*)::int from leadflow_private.apollo_ledger where webhook_token_hash is not null and webhook_token_hash <> $1",[token]),1,'Only the token’s hash is stored.')
let phoneEntry=(await ledgerRows()).find(r=>r.operation==='phone_reveal');assert.deepEqual([phoneEntry.status,phoneEntry.estimate,phoneEntry.credits],['pending',16,null])
let workspace=await as(owner,'select public.load_workspace()');const samAfterEmail=workspace.data.leads.find(l=>l.id===sam.id)
assert.equal(samAfterEmail.name,'Sam Rivera','Revealing replaces a masked name on a saved lead.')
assert.ok(workspace.data.activities.some(a=>a.leadId===sam.id&&a.text==='Contact details revealed through Apollo'))
const deliver=async(tokenValue,payload)=>{const res=await h.webhook(new Request(`https://project.test/functions/v1/apollo-webhook?token=${tokenValue}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));return res.status}
const payload={status:'success',total_requested_enrichments:2,unique_enriched_records:1,missing_records:1,credits_consumed:8,people:[
  {id:people[2].id,status:'success',phone_numbers:[{raw_number:'(512) 555-0103',sanitized_number:'+15125550103',type_cd:'mobile',status_cd:'valid_number',dnc_status_cd:null}]},
  {id:'not-requested-person',status:'success',phone_numbers:[{sanitized_number:'+19999999999'}]}]}
assert.equal(await deliver('lf_'+'0'.repeat(64),payload),404,'An unknown token is refused.')
assert.equal(await deliver('bad',payload),404)
assert.equal(await deliver(token,payload),200)
phoneEntry=(await ledgerRows()).find(r=>r.operation==='phone_reveal');assert.deepEqual([phoneEntry.status,phoneEntry.credits,phoneEntry.credit_basis],['succeeded',8,'reported'])
workspace=await as(owner,'select public.load_workspace()')
assert.equal(workspace.data.leads.find(l=>l.id===sam.id).phone,'+15125550103','The phone number fills the saved lead’s empty phone.')
contacts=await as(owner,'select public.apollo_contacts_for($1,$2)',[W,JSON.stringify([people[2].id,'not-requested-person'])])
assert.deepEqual(contacts.map(c=>[c.id,c.phones.map(p=>p.number)]),[[people[2].id,['+15125550103']]],'Only people the reveal asked for are stored.')
assert.equal(await deliver(token,{...payload,credits_consumed:99,people:[{id:people[2].id,phone_numbers:[{sanitized_number:'+10000000000'}]}]}),200,'A repeated delivery is accepted…')
assert.equal((await ledgerRows()).find(r=>r.operation==='phone_reveal').credits,8,'…and changes nothing.')

// 9. Credits: allowance, concurrency, unknown outcomes, Apollo sync and cycles. Balances never go negative.
assert.equal((await call({action:'update_account',accountId:'second',changes:{monthlyAllowance:10}},member)).status,403,'Only owners and admins change accounts.')
response=await call({action:'update_account',accountId:'second',changes:{monthlyAllowance:10,nickname:'Client B',notes:'Separate team account',resetDay:5}})
assert.deepEqual([response.status,response.body.account.monthlyAllowance,response.body.account.nickname,response.body.account.cycleSource],[200,10,'Client B','reset_day'])
assert.equal((await call({action:'update_account',accountId:'second',changes:{resetDay:31}})).status,422)
// Two reveals at once that each need 6 of the 10 credits: the account lock lets only one through.
let release;h.state.hold=new Promise(resolve=>{release=resolve})
const six=Array.from({length:6},(_,i)=>({id:`aaaaaaaaaaaaaaaaaaaaaaa${i}`,name:'x'}))
const concurrent=[call({action:'reveal',accountId:'second',operationId:crypto.randomUUID(),people:six}),call({action:'reveal',accountId:'second',operationId:crypto.randomUUID(),people:six})]
await new Promise(resolve=>setTimeout(resolve,200));release();h.state.hold=null
const statuses=(await Promise.all(concurrent)).map(r=>r.status).sort()
assert.deepEqual(statuses,[200,402],'Concurrent reveals cannot overspend an account.')
let second=(await call({action:'status'})).body.accounts.find(a=>a.id==='second')
assert.deepEqual([second.used,second.usedEmail],[0,0],'No matches: Apollo reported 0 credits.')
response=await call({action:'reveal',accountId:'second',operationId:crypto.randomUUID(),people:[{id:people[1].id,name:'Jordan'},{id:people[0].id,name:'Avery'}],phone:true})
assert.equal(response.status,402,'The phone estimate (8 per person) must fit too: 2 + 16 is more than 10.')
assert.match(response.body.error,/16 needed at most, 8 left of 10/)
assert.equal(await op("select count(*)::int from leadflow_private.apollo_ledger where account_id='second' and status='pending'"),0,'A refused reveal leaves nothing pending.')
h.state.failures=['timeout']
response=await call({action:'reveal',accountId:'second',operationId:crypto.randomUUID(),people:[{id:people[1].id,name:'Jordan'}]})
assert.equal(response.status,503)
second=(await call({action:'status'})).body.accounts.find(a=>a.id==='second')
assert.equal(second.used,1,'An unknown outcome keeps its estimate until resolved, so the balance stays conservative.')
assert.equal((await call({action:'update_account',accountId:'second',changes:{active:false}})).body.account.active,false)
response=await call({action:'reveal',accountId:'second',operationId:crypto.randomUUID(),people:[{id:people[1].id,name:'Jordan'}]})
assert.deepEqual([response.status,/switched off/.test(response.body.error)],[402,true])
response=await call({action:'sync_credits',accountId:'primary'},member)
assert.deepEqual([response.status,response.body.account.synced.lead_credit,response.body.account.cycleSource],[200,{limit:70,consumed:3,leftOver:67},'apollo'])
await op("update leadflow_private.apollo_ledger set created_at='2026-09-01' where account_id='primary' and operation='organization_search' and status='succeeded'")
let primary=(await call({action:'status'})).body.accounts.find(a=>a.id==='primary')
assert.deepEqual([primary.used,primary.usedEmail,primary.usedPhone,primary.usedSearch],[12,4,8,0],'Usage counts the current cycle only; history before it is kept but not counted.')
assert.equal(await op('select count(*)::int from leadflow_private.apollo_ledger'),8,'History is kept across cycles.')
response=await call({action:'test_connection',accountId:'primary'})
assert.equal(response.status,200);assert.equal(h.state.calls.at(-1).path,'/usage_stats/api_usage_stats')
assert.equal((await call({action:'test_connection',accountId:'primary'},member)).status,403)
const badKey=createApolloHarness(db,{APOLLO_WORKSPACE_IDS:W,APOLLO_API_KEYS:'primary:key-revoked-0123456789'})
response=await badKey.handler(apolloRequest({workspaceId:W,action:'test_connection',accountId:'primary'},tokenFor(owner)))
assert.deepEqual([response.status,(await response.json()).code],[502,'apollo_unauthorized'])
assert.match((await call({action:'status'})).body.accounts.find(a=>a.id==='primary').lastConnectionError,/rejected the API key/)

// 10. Ledger: filters, and other workspaces' subjects are hidden.
response=await call({action:'ledger',filters:{accountId:'primary',operation:'phone_reveal'}})
assert.deepEqual(response.body.entries.map(e=>[e.operation,e.status,e.creditBasis,e.subjects.length]),[['phone_reveal','succeeded','reported',2]])
const outsiderHarness=createApolloHarness(db,{APOLLO_WORKSPACE_IDS:O})
response=await outsiderHarness.handler(apolloRequest({workspaceId:O,action:'ledger',filters:{operation:'email_reveal',accountId:'primary'}},tokenFor(outsider)))
const foreign=(await response.json()).entries[0];assert.deepEqual([foreign.thisWorkspace,foreign.subjects[0].name],[false,'2 from another workspace'])

// 11. Saved searches: any member saves and reuses; only the creator, an owner or an admin deletes.
const saved=crypto.randomUUID()
assert.equal(await as(member,"select public.save_discovery_search($1,$2,'Austin owners','apollo_people',$3)",[W,saved,JSON.stringify({filters:{titles:['owner']},kind:'people'})]),saved)
await as(member,"select public.save_discovery_search($1,$2,'Austin owners (renamed)','apollo_people',$3)",[W,saved,JSON.stringify({filters:{titles:['owner','ceo']},kind:'people'})])
let savedList=await as(owner,'select public.discovery_saved_searches_for($1)',[W])
assert.deepEqual(savedList.map(s=>[s.name,s.criteria.filters.titles,s.mine]),[['Austin owners (renamed)',['owner','ceo'],false]])
await actAs(db,outsider);await assert.rejects(()=>db.query("select public.save_discovery_search($1,$2,'Hijack','apollo_people','{}')",[O,saved]),/not found/,'Another workspace cannot overwrite a saved search by ID.')
const ownerSaved=crypto.randomUUID();await as(owner,"select public.save_discovery_search($1,$2,'Owner search','apollo_people','{}')",[W,ownerSaved])
await actAs(db,member);await assert.rejects(()=>db.query('select public.delete_discovery_search($1,$2)',[W,ownerSaved]),/belongs to a teammate/)
await as(owner,'select public.delete_discovery_search($1,$2)',[W,saved])
assert.equal((await as(owner,'select public.discovery_saved_searches_for($1)',[W])).length,1)

// 12. Logs never contain API keys, emails or phone numbers.
const logText=logged.join('\n')
for(const secret of [apolloKeys.primary,apolloKeys.second,'avery@harbor-dental.example','+15125550103',token])assert.ok(!logText.includes(secret),`Logs must not contain ${secret.slice(0,12)}…`)
assert.ok(/apollo reveal primary ok matched 2\/3/.test(logText),'Logs record the action, account and outcome.')

// 13. Snapshot saves keep lists and Apollo origins; rollback keeps leads; the migration re-applies.
workspace=await as(owner,'select public.load_workspace()')
await as(owner,'select public.save_workspace($1,$2,$3)',[JSON.stringify(workspace.data),workspace.revision,crypto.randomUUID()])
assert.equal((await as(owner,'select public.lead_lists_for($1)',[W]))[0].leadIds.length,2,'Lists survive snapshot saves (leads keep their IDs).')
const leadCount=await op('select count(*)::int from public.leads')
await actAs(db,null,'postgres');await db.exec(readFileSync('supabase/rollbacks/202611010001_apollo.down.sql','utf8'))
assert.equal(await op("select to_regclass('leadflow_private.apollo_ledger')"),null);assert.equal(await op('select count(*)::int from public.leads'),leadCount,'Rollback keeps every lead.')
await db.exec(readFileSync('supabase/migrations/202611010001_apollo.sql','utf8'))
assert.equal((await as(owner,'select public.lead_lists_for($1)',[W])).length,0)

printLog('PASS Apollo: exact grants and private tables, filter validation and Apollo query construction, origin/sign-in/membership/workspace allowlist, keys never returned or logged, free people search with history and pagination limits, retries for free calls only, rate-limit/plan/permission errors, company search credits with confirmation and once-only operation IDs, email reveals with Apollo-reported credits and replayed retries, workspace-private contacts, saving through import_leads with provenance, account and lists, duplicate protection, phone reveals via one-time hashed webhook tokens with idempotent delivery, masked names and empty fields filled on saved leads, allowance enforcement under concurrency, unknown outcomes counted conservatively, inactive accounts, Apollo credit sync and billing cycles, history kept across cycles, connection tests, ledger filtering and cross-workspace redaction, saved searches, lists, and rollback/re-apply. Embedded PostgreSQL; Apollo simulated; no external service contacted.')
