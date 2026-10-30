import assert from 'node:assert/strict'
import { createDatabase, actAs } from '../tests/support/database.ts'
import { createDiscoveryHarness, discoveryRequest, austinDirectory } from '../tests/support/discovery.ts'
// Same shape as tests/support/supabase.ts tokenFor, which Node's type stripping cannot import.
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
const tokenFor=user=>[encode({alg:'HS256',typ:'JWT'}),encode({sub:user.id,email:user.email,role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600}),'test-signature'].join('.')
// M6 lead discovery: the real migration SQL in embedded PostgreSQL and the real discover-leads handler.
// Nominatim and Overpass are simulated; no request leaves the machine.
const owner='11111111-1111-4111-8111-111111111111', member='33333333-3333-4333-8333-333333333333', outsider='44444444-4444-4444-8444-444444444444'
const W=owner, O=outsider // Personal workspaces use their owner's ID.
const db=await createDatabase([owner,member,outsider])
const one=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0]??{})[0]
const as=async(user,sql,params=[])=>{await actAs(db,user);return one(sql,params)}
const op=async(sql,params=[])=>{await actAs(db,null,'postgres');return one(sql,params)}
const fails=async(user,sql,params,pattern)=>{await actAs(db,user);await assert.rejects(()=>db.query(sql,params),pattern)}
await as(owner,'select public.load_workspace()');await as(member,'select public.load_workspace()');await as(outsider,'select public.load_workspace()')
await as(owner,"select public.set_workspace_member($1,$2,'member')",[W,member])
const load=async(user=owner,workspace=W)=>as(user,'select public.load_workspace_for($1)',[workspace])
const save=async(data,revision,user=owner,workspace=W)=>as(user,'select public.save_workspace_for($1,$2,$3,$4)',[workspace,JSON.stringify(data),revision,crypto.randomUUID()])
const importRows=(user,payload,request=crypto.randomUUID(),workspace=W)=>as(user,'select public.import_leads($1,$2,$3)',[workspace,request,JSON.stringify(payload)])
const csvRow=(key,fields)=>({key,businessName:'',contactName:'',email:'',phone:'',website:'',...fields})

// 1. Catalog: anonymous callers still execute nothing; provider-side functions are service-role only; tables are private.
await actAs(db,null,'postgres')
const executable=async role=>(await db.query("select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','leadflow_private') and has_function_privilege($1,p.oid,'EXECUTE')",[role])).rows.map(row=>row.fn)
assert.deepEqual(await executable('anon'),[],'Anonymous callers cannot execute any function.')
const signedIn=await executable('authenticated'), service=await executable('service_role')
for(const fn of ['import_leads(uuid,uuid,jsonb)','lead_origins_for(uuid)','start_discovery_search(uuid,uuid,text,jsonb)','discovery_history_for(uuid)'])assert.ok(signedIn.includes(fn),fn)
for(const fn of ['finish_discovery_search(uuid,text,integer,boolean,text)','discovery_place(text)','remember_discovery_place(text,jsonb)']){assert.ok(!signedIn.includes(fn),`${fn} is not for signed-in users`);assert.ok(service.includes(fn),fn)}
assert.ok(!signedIn.some(fn=>/lead_domain|lead_name_key|lead_phone_key|lead_place_keys|import_text/.test(fn)),'Private helpers are not executable by clients.')
for(const role of ['anon','authenticated']){
  await actAs(db,role==='anon'?null:owner,role)
  for(const table of ['lead_origins','discovery_searches','discovery_places','lead_import_requests'])await assert.rejects(()=>db.query(`select * from leadflow_private.${table}`),/permission denied/,`${role} ${table}`)
}
assert.equal(await op("select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='leadflow_private' and c.relname in ('lead_origins','discovery_searches','discovery_places','lead_import_requests') and not c.relrowsecurity"),0,'RLS is enabled on every discovery table.')

// 2. Snapshot saves carry the business fields; older payloads without them still save; email is optional.
const createdAt='2026-10-30T09:00:00.000Z'
const person={id:'person',name:'Robin Vale',email:'robin@acme.example',phone:'',company:'Acme',service:'Consulting',source:'Referral',message:'',status:'New',createdAt}
const business={id:'business',name:'Harbor Dental',email:'',phone:'+1 512 555 0199',company:'Harbor Dental',service:'Not specified',source:'Other',message:'',status:'New',createdAt,website:'https://harbor-dental.example/',industry:'Dental clinics',address:'1 Main St',city:'Austin',region:'TX',postcode:'78701',country:'US'}
let snapshot=await load(),revision=await save({version:1,leads:[person,business],tasks:[],activities:[]},snapshot.revision)
snapshot=await load()
const loadedPerson=snapshot.data.leads.find(lead=>lead.id==='person'),loadedBusiness=snapshot.data.leads.find(lead=>lead.id==='business')
assert.deepEqual(loadedBusiness,business,'Business fields round-trip through the snapshot.')
assert.deepEqual([loadedPerson.website,loadedPerson.city,loadedPerson.country],['','',''],'A payload without business fields stores empty values.')
await fails(owner,'select public.save_workspace_for($1,$2,$3,$4)',[W,JSON.stringify({version:1,leads:[{...business,website:'javascript:alert(1)'}],tasks:[],activities:[]}),revision,crypto.randomUUID()],/leads_website_check/)
await fails(owner,'select public.save_workspace_for($1,$2,$3,$4)',[W,JSON.stringify({version:1,leads:[{...business,email:'not-an-email'}],tasks:[],activities:[]}),revision,crypto.randomUUID()],/leads_email_check/)
await fails(owner,'select public.save_workspace_for($1,$2,$3,$4)',[W,JSON.stringify({version:1,leads:[{...business,country:'usa'}],tasks:[],activities:[]}),revision,crypto.randomUUID()],/leads_country_check/)

// 3. CSV import: any member may import; rows are validated; existing leads are never changed.
const csvRequest=crypto.randomUUID()
const csvPayload={method:'csv',rows:[
  csvRow('r1',{businessName:'Pine & Co',contactName:'Sam Pine',email:'SAM@pine.example',website:'https://pine.example',city:'Leeds',country:'gb',notes:'Met at expo\nfollow up'}),
  csvRow('r2',{businessName:'Acme',email:'robin@acme.example'}), // same email as an existing lead: always skipped
  csvRow('r3',{businessName:'Harbour Dental Annex',website:'http://www.harbor-dental.example/contact'}), // same website: needs review
  csvRow('r4',{businessName:'Harbor  Dental!',city:'austin'}), // same name and city: needs review
  csvRow('r5',{businessName:'New Leaf',phone:'(512) 555-0199'}), // same phone: needs review
  csvRow('r6',{businessName:'Pine and Co Duplicate',email:'sam@pine.example'}), // duplicate within this file
  csvRow('r7',{businessName:'Quiet Studio'}),
]}
let result=await importRows(member,csvPayload,csvRequest)
assert.deepEqual(result.imported.map(row=>row.key),['r1','r7'])
assert.deepEqual(result.skipped.map(row=>[row.key,row.reason,row.blocking]),[['r2','same_email',true],['r3','same_website',false],['r4','same_name_and_location',false],['r5','same_phone',false],['r6','same_email',true]])
assert.equal(result.skipped.find(row=>row.key==='r3').leadId,'business','A skipped row points at the lead it matched.')
assert.equal(result.skipped.find(row=>row.key==='r6').leadId,result.imported[0].leadId,'Rows are checked against rows imported earlier in the same file.')
assert.deepEqual(await importRows(member,csvPayload,csvRequest),result,'Retrying with the same request ID returns the first result without importing again.')
await fails(member,'select public.import_leads($1,$2,$3)',[W,csvRequest,JSON.stringify({...csvPayload,rows:csvPayload.rows.slice(0,1)})],/already used for different rows/)
snapshot=await load()
assert.equal(snapshot.revision,revision+1,'An import advances the revision once.')
const pine=snapshot.data.leads.find(lead=>lead.id===result.imported[0].leadId),quiet=snapshot.data.leads.find(lead=>lead.id===result.imported[1].leadId)
assert.deepEqual([pine.name,pine.company,pine.email,pine.website,pine.country,pine.source,pine.service,pine.status,pine.message],['Sam Pine','Pine & Co','sam@pine.example','https://pine.example','GB','CSV import','Not specified','New','Met at expo\nfollow up'])
assert.deepEqual([quiet.name,quiet.company,quiet.email],['Quiet Studio','Quiet Studio',''],'A business without a contact uses the business name.')
assert.deepEqual(snapshot.data.leads.find(lead=>lead.id==='business'),business,'Matched existing leads are unchanged.')
assert.ok(snapshot.data.activities.some(event=>event.leadId===pine.id&&event.text==='Lead imported from a CSV file'))
// Reviewed duplicates can be imported deliberately; exact matches cannot.
result=await importRows(owner,{method:'csv',rows:[csvRow('again-website',{...csvPayload.rows[2],key:'again-website',allowDuplicate:true}),csvRow('again-email',{businessName:'Acme',email:'robin@acme.example',allowDuplicate:true})]})
assert.deepEqual([result.imported.map(row=>row.key),result.skipped.map(row=>row.reason)],[['again-website'],['same_email']])
// A stale tab cannot overwrite an import: its snapshot revision is out of date.
await fails(owner,'select public.save_workspace_for($1,$2,$3,$4)',[W,JSON.stringify(snapshot.data),snapshot.revision,crypto.randomUUID()],/changed in another session/)
// Invalid rows are rejected with the row reference; nothing from that batch is stored.
const before=(await load()).data.leads.length
for(const [fields,pattern] of [[{businessName:'Bad site',website:'ftp://files.example'},/Row bad: the website/],[{businessName:'Bad email',email:'nope'},/Row bad: the email/],[{businessName:'Bad phone',phone:'12'},/Row bad: the phone/],[{businessName:''},/Row bad: add a business or contact name/],[{businessName:'Bad\u0007name'},/control characters/],[{businessName:'Bad country',country:'USA'},/country must be at most 2/],[{businessName:'Bad country',country:'U1'},/two-letter country/],[{businessName:'Bad source',source:'Billboard'},/listed source/]])
  await fails(owner,'select public.import_leads($1,$2,$3)',[W,crypto.randomUUID(),JSON.stringify({method:'csv',rows:[csvRow('ok',{businessName:'Valid row'}),csvRow('bad',fields)]})],pattern)
assert.equal((await load()).data.leads.length,before,'A rejected batch stores nothing.')
await fails(owner,'select public.import_leads($1,$2,$3)',[W,crypto.randomUUID(),JSON.stringify({method:'csv',rows:Array.from({length:251},(_,i)=>csvRow(`r${i}`,{businessName:`Biz ${i}`}))})],/between 1 and 250/)
await fails(owner,'select public.import_leads($1,$2,$3)',[W,crypto.randomUUID(),JSON.stringify({method:'scrape',rows:[csvRow('r',{businessName:'X'})]})],/Unknown import method/)
// Isolation: outsiders cannot import into, or read the provenance of, another workspace.
await fails(outsider,'select public.import_leads($1,$2,$3)',[W,crypto.randomUUID(),JSON.stringify(csvPayload)],/not found or access denied/)
await fails(outsider,'select public.lead_origins_for($1)',[W],/not found or access denied/)
await fails(outsider,'select public.discovery_history_for($1)',[W],/not found or access denied/)
await fails(outsider,'select public.start_discovery_search($1,$2,$3,$4)',[W,crypto.randomUUID(),'openstreetmap','{}'],/not found or access denied/)
await actAs(db,null,'anon');await assert.rejects(()=>db.query('select public.import_leads($1,$2,$3)',[W,crypto.randomUUID(),JSON.stringify(csvPayload)]),/permission denied/)
// The outsider's own workspace is unaffected and separate: the same rows import there.
result=await importRows(outsider,{method:'csv',rows:[csvPayload.rows[0]]},crypto.randomUUID(),O)
assert.equal(result.imported.length,1,'Duplicate checks are per workspace.')
const origins=await as(member,'select public.lead_origins_for($1)',[W])
assert.ok(origins.every(origin=>origin.method==='csv')&&origins.some(origin=>origin.leadId===pine.id))
assert.ok(!(await as(owner,'select public.lead_origins_for($1)',[W])).some(origin=>origin.leadId===(result.imported[0].leadId)),'Origins never cross workspaces.')

// 4. The discover-leads handler.
const h=createDiscoveryHarness(db)
const call=async(body,token=tokenFor({id:owner,email:'owner@example.com'}),origin)=>{const response=await h.handler(discoveryRequest(body,token,origin));return {status:response.status,body:response.status===204?null:await response.json(),headers:response.headers}}
const criteria={category:'dental',locations:[{country:'US',region:'TX',city:'Austin'}],require:[],limit:50}
// Earlier searches are aged past the per-minute quota, which has its own check below. Order is preserved.
const age=()=>op("update leadflow_private.discovery_searches set created_at=created_at-interval '61 seconds'")
const search=async(extra={},token,{throttle=true}={})=>{if(throttle)await age();return call({action:'search',workspaceId:W,searchId:crypto.randomUUID(),provider:'openstreetmap',criteria,...extra},token)}
h.state.places.austin={osm_type:'relation',osm_id:113314,lat:'30.27',lon:'-97.74'}
h.state.places['78701']={osm_type:'node',osm_id:5,lat:'30.27',lon:'-97.74'}
h.state.elements=austinDirectory()

assert.equal((await call({action:'status'},null,'https://evil.example')).status,403,'Other websites are refused.')
const preflight=await h.handler(new Request('https://functions.test/discover-leads',{method:'OPTIONS',headers:{Origin:'http://127.0.0.1:5175'}}))
assert.equal(preflight.status,204);assert.match(preflight.headers.get('Access-Control-Allow-Headers'),/authorization/)
assert.equal((await call({action:'status'},null)).status,401,'Unauthenticated requests are refused.')
let response=await call({action:'status'})
assert.equal(response.status,200)
const osm=response.body.providers.find(provider=>provider.id==='openstreetmap')
assert.equal(osm.configured,true);assert.deepEqual(osm.capabilities.filters,['website','phone','email'])
assert.ok(!JSON.stringify(response.body).includes('test-server-key')&&!JSON.stringify(response.body).includes(h.config.OSM_USER_AGENT)&&!JSON.stringify(response.body).includes('directory.test'),'Status never reveals settings or secrets.')
// Invalid criteria never reach the provider.
for(const [bad,pattern] of [[{...criteria,category:'casinos'},/business type/],[{...criteria,locations:[]},/between 1 and 3 locations/],[{...criteria,locations:[{country:'FR',city:'Paris'}]},/supported country/],[{...criteria,locations:[{country:'US'}]},/city or postcode/],[{...criteria,require:['rating']},/does not support/],[{...criteria,category:'custom',keyword:'x"];out;'},/niche/],[{...criteria,limit:5000},/between 10 and 100/]]){
  response=await search({criteria:bad})
  assert.equal(response.status,422,JSON.stringify(bad));assert.match(response.body.error,pattern)
}
assert.equal(h.state.directoryQueries.length+h.state.geocoderCalls.length,0,'Invalid searches make no provider requests.')
assert.equal((await search({},'not.a-valid.token-at-all')).status,401,'An invalid token is refused by the database.')
assert.equal((await search({workspaceId:O})).status,403,'Searching another workspace is refused.')
assert.equal((await search({provider:'google_places'})).status,422)

// A valid search: normalized, attributed, deduplicated and recorded without its results.
response=await search()
assert.equal(response.status,200,JSON.stringify(response.body))
assert.deepEqual(response.body.results.map(result=>result.name),['Barton Creek Family Dentistry','Bluebonnet Dental','Lone Star Smiles','Unreliable Data Dental'],'Nameless elements are skipped; results are sorted.')
const blue=response.body.results.find(result=>result.name==='Bluebonnet Dental'),star=response.body.results.find(result=>result.name==='Lone Star Smiles'),bad=response.body.results.find(result=>result.name==='Unreliable Data Dental')
assert.deepEqual([blue.website,blue.phone,blue.email,blue.address,blue.city,blue.region,blue.postcode,blue.country,blue.category,blue.providerRef,blue.sourceUrl,blue.sourceUpdatedAt],
  ['https://bluebonnet-dental.example/','+1 512-555-0101','hello@bluebonnet-dental.example','12 Congress Ave','Austin','TX','78701','US','Dental clinics','node/101','https://www.openstreetmap.org/node/101','2026-09-01T10:00:00.000Z'])
assert.deepEqual([star.website,star.phone,star.providerRef],['https://www.lonestarsmiles.example/','(512) 555-0102','way/202'],'contact:* tags are read too.')
assert.deepEqual([bad.website,bad.phone,bad.email],['','',''],'Unusable values are dropped, not repaired.')
assert.match(response.body.attribution.text,/OpenStreetMap contributors/);assert.equal(response.body.nextCursor,null);assert.equal(response.body.truncated,false)
assert.match(h.state.directoryQueries[0],/area\(id:3600113314\)/);assert.match(h.state.directoryQueries[0],/nwr\["amenity"="dentist"\]\["name"\]\(area\.searchArea\);nwr\["healthcare"="dentist"\]/)
assert.ok(h.state.upstreamHeaders.every(headers=>headers.get('User-Agent')===h.config.OSM_USER_AGENT),'Every upstream request identifies the application.')
assert.ok(!h.state.upstreamHeaders.some(headers=>headers.get('Authorization')||headers.get('apikey')),'No LeadFlow credential is sent to the provider.')
let history=await as(member,'select public.discovery_history_for($1)',[W])
assert.deepEqual([history[0].status,history[0].resultCount,history[0].provider,history[0].criteria.category,history[0].mine],['completed',4,'openstreetmap','dental',false])
assert.ok(!JSON.stringify(history).includes('Bluebonnet'),'History keeps criteria and counts, not provider results.')
const geocodes=h.state.geocoderCalls.length
response=await search({criteria:{...criteria,require:['website','phone']}})
assert.equal(h.state.geocoderCalls.length,geocodes,'Geocoder answers are cached.')
assert.match(h.state.directoryQueries.at(-1),/\[~"\^\(website\|contact:website\)\$"~"\."\]\[~"\^\(phone\|contact:phone\)\$"~"\."\]/,'Contact filters are applied by the provider query.')
// A postcode searches around a point; custom niches match by name among businesses.
response=await search({criteria:{...criteria,category:'custom',keyword:'Smile studio',radiusKm:3,locations:[{country:'US',postcode:'78701'}]}})
assert.equal(response.status,200);assert.match(h.state.directoryQueries.at(-1),/nwr\["name"~"Smile studio",i\]\[~"\^\(shop\|office\|amenity\|craft\|healthcare\|leisure\)\$"~"\."\]\(around:3000,30\.27,-97\.74\)/)
// Truncation: more matches than the per-location limit are reported, never silently dropped.
h.state.elements=Array.from({length:12},(_,i)=>({type:'node',id:1000+i,tags:{amenity:'dentist',name:`Dentist ${String(i).padStart(2,'0')}`}}))
response=await search({criteria:{...criteria,limit:10}})
assert.deepEqual([response.body.results.length,response.body.truncated],[10,true]);assert.match(response.body.warnings[0],/more than 10 matches/)
// Empty results.
h.state.elements=[]
response=await search();assert.deepEqual([response.status,response.body.results],[200,[]])
// Provider failures: rate limits are reported, overloaded servers are retried once, timeouts explained; history records each.
h.state.elements=austinDirectory()
h.state.directoryFailures=[429];response=await search()
assert.deepEqual([response.status,response.body.retryAfter],[429,30])
h.state.directoryFailures=[504];response=await search()
assert.equal(response.status,200,'One overloaded answer is retried.')
h.state.directoryFailures=[504,503];response=await search()
assert.equal(response.status,503);assert.match(response.body.error,/busy/)
h.state.directoryRemark='runtime error: Query timed out in "query" at line 1 after 21 seconds.';response=await search()
assert.equal(response.status,503);assert.match(response.body.error,/too much data/);h.state.directoryRemark=''
response=await search({criteria:{...criteria,locations:[{country:'US',city:'Atlantis'}]}})
assert.equal(response.status,422);assert.match(response.body.error,/couldn’t find Atlantis, US/)
response=await search({criteria:{...criteria,locations:[{country:'US',city:'Atlantis'},{country:'US',region:'TX',city:'Austin'}]}})
assert.equal(response.status,200);assert.match(response.body.warnings[0],/Atlantis/,'A missing location is a warning when others are found.')
history=await as(owner,'select public.discovery_history_for($1)',[W])
assert.deepEqual(history.slice(0,6).map(item=>[item.status,item.failure]),[['completed',null],['failed','location_not_found'],['failed','timeout'],['failed','unavailable'],['completed',null],['failed','rate_limited']])
// Missing configuration: honest status, no upstream calls.
const unconfigured=createDiscoveryHarness(db,{OSM_OVERPASS_URL:undefined,OSM_USER_AGENT:'curl'})
const status=await (await unconfigured.handler(discoveryRequest({action:'status'},tokenFor({id:owner,email:'o@example.com'})))).json()
assert.deepEqual([status.providers[0].configured,status.providers[0].missing],[false,['OSM_OVERPASS_URL','OSM_USER_AGENT']])
response=await unconfigured.handler(discoveryRequest({action:'search',workspaceId:W,searchId:crypto.randomUUID(),provider:'openstreetmap',criteria},tokenFor({id:owner,email:'o@example.com'})))
assert.equal(response.status,503);assert.equal((await response.json()).code,'not_configured')
assert.equal(unconfigured.state.geocoderCalls.length+unconfigured.state.directoryQueries.length,0)
const serverless=createDiscoveryHarness(db,{SUPABASE_SERVICE_ROLE_KEY:undefined})
assert.equal((await serverless.handler(discoveryRequest({action:'status'},tokenFor({id:owner,email:'o@example.com'})))).status,503)
// Quotas: six searches per person per minute.
await op('delete from leadflow_private.discovery_searches')
for(let i=0;i<6;i++)assert.equal((await search({},undefined,{throttle:false})).status,200)
response=await search({},undefined,{throttle:false});assert.equal(response.status,429);assert.match(response.body.error,/Search limit/)
const reused=crypto.randomUUID()
await op('delete from leadflow_private.discovery_searches')
assert.equal((await search({searchId:reused})).status,200);assert.equal((await search({searchId:reused})).status,409,'A search ID cannot be reused.')

// 5. Importing discovered businesses: provenance is kept and the same record cannot be imported twice.
response=await search()
const toRow=(business,extra={})=>({key:business.id,businessName:business.name,email:business.email,phone:business.phone,website:business.website,industry:business.category,address:business.address,city:business.city,region:business.region,postcode:business.postcode,country:business.country,providerRef:business.providerRef,sourceUrl:business.sourceUrl,sourceUpdatedAt:business.sourceUpdatedAt,discoveredAt:response.body.fetchedAt,...extra})
const discovered={method:'discovery',provider:'openstreetmap',searchId:response.body.searchId,rows:response.body.results.map(business=>toRow(business))}
result=await importRows(member,discovered)
assert.equal(result.imported.length,4)
const blueId=result.imported.find(row=>row.key==='openstreetmap:node/101').leadId
const blueOrigin=(await as(member,'select public.lead_origins_for($1)',[W])).find(origin=>origin.leadId===blueId)
assert.deepEqual([blueOrigin.method,blueOrigin.provider,blueOrigin.providerRef,blueOrigin.searchId,blueOrigin.sourceUrl],['discovery','openstreetmap','node/101',response.body.searchId,'https://www.openstreetmap.org/node/101'])
assert.equal(new Date(blueOrigin.sourceUpdatedAt).toISOString(),'2026-09-01T10:00:00.000Z')
const blueLead=(await load()).data.leads.find(lead=>lead.id===blueId)
assert.deepEqual([blueLead.name,blueLead.company,blueLead.source,blueLead.industry,blueLead.website],['Bluebonnet Dental','Bluebonnet Dental','Lead discovery','Dental clinics','https://bluebonnet-dental.example/'])
result=await importRows(member,{...discovered,rows:discovered.rows.map(row=>({...row,allowDuplicate:true}))})
assert.deepEqual([result.imported.length,new Set(result.skipped.map(row=>row.reason))],[0,new Set(['same_record'])],'The same provider record is never imported twice, even when duplicates are allowed.')
await fails(member,'select public.import_leads($1,$2,$3)',[W,crypto.randomUUID(),JSON.stringify({...discovered,searchId:crypto.randomUUID()})],/Unknown discovery search/)
await fails(member,'select public.import_leads($1,$2,$3)',[W,crypto.randomUUID(),JSON.stringify({...discovered,rows:[{...discovered.rows[0],providerRef:''}]})],/provider record is missing/)
await fails(member,'select public.import_leads($1,$2,$3)',[W,crypto.randomUUID(),JSON.stringify({...discovered,rows:[{...discovered.rows[0],sourceUrl:'http://insecure.example'}]})],/must use https/)
// Removing a lead (owners only) removes its provenance; members still cannot remove leads.
snapshot=await load()
await fails(member,'select public.save_workspace_for($1,$2,$3,$4)',[W,JSON.stringify({...snapshot.data,leads:snapshot.data.leads.filter(lead=>lead.id!==blueId),activities:snapshot.data.activities.filter(event=>event.leadId!==blueId)}),snapshot.revision,crypto.randomUUID()],/Only workspace owners and admins can remove leads/)
await save({...snapshot.data,leads:snapshot.data.leads.filter(lead=>lead.id!==blueId),activities:snapshot.data.activities.filter(event=>event.leadId!==blueId)},snapshot.revision)
assert.equal(await op('select count(*)::int from leadflow_private.lead_origins where lead_id=$1',[blueId]),0,'Provenance of a removed lead is deleted.')
result=await importRows(owner,{...discovered,searchId:response.body.searchId,rows:[discovered.rows.find(row=>row.providerRef==='node/101')]})
assert.equal(result.imported.length,1,'A removed lead can be discovered and imported again.')



// 6. Browser-side rules: duplicate keys match the SQL that enforces them, and CSV parsing, mapping, validation and export.
// The app's modules use extensionless imports, as Vite allows; resolve them for Node.
const { registerHooks } = await import('node:module')
registerHooks({ resolve(specifier, context, next) { if (/^\.\.?\//.test(specifier) && !/\.\w+$/.test(specifier)) { try { return next(`${specifier}.ts`, context) } catch { /* not a TypeScript module */ } } return next(specifier, context) } })
const keys = await import('../src/lib/leadKeys.ts'), csvLib = await import('../src/lib/csv.ts')
await actAs(db,null,'postgres')
for (const website of ['https://www.Example.com/path', 'http://example.com:8080/x', 'https://shop.example.co.uk', 'https://WWW.example.org?x=1', ''])
  assert.equal(keys.domainOf(website), await one('select leadflow_private.lead_domain($1)', [website]), website)
for (const phone of ['+1 (512) 555-0100', '512 555 0100', '0123', '+44 20 7946 0958', ''])
  assert.equal(keys.phoneKey(phone), await one('select leadflow_private.lead_phone_key($1)', [phone]), phone)
for (const [business, city, postcode] of [['Pine & Co.', 'Leeds', 'LS1 4AP'], ['  ', 'Leeds', ''], ['Café Rouge', 'São Paulo', ''], ['Acme', '', '']])
  assert.deepEqual(keys.placeKeys(business, city, postcode), await one('select leadflow_private.lead_place_keys($1,$2,$3)', [business, city, postcode]), business)
assert.deepEqual(csvLib.parseCsv('﻿Name;Notes\r\n"Pine; Co";"Line one\nline ""two"""\r\n\r\n;x'), [['Name', 'Notes'], ['Pine; Co', 'Line one\nline "two"'], ['', 'x']], 'BOM, semicolons, quotes, embedded newlines, blank lines.')
assert.throws(() => csvLib.parseCsv('a,b\n"open,2'), /never closes/)
assert.equal(csvLib.toCsv([['=SUM(A1)', '+1', '-2', '@x', 'plain, "quoted"']]), "'=SUM(A1),'+1,'-2,'@x,\"plain, \"\"quoted\"\"\"\r\n", 'Exported cells cannot run as spreadsheet formulas.')
const mapping = csvLib.guessMapping(['Company Name', 'E-mail', 'ZIP', 'Lead source', 'name'])
assert.deepEqual([mapping.businessName, mapping.email, mapping.postcode, mapping.source, mapping.contactName, mapping.phone], [0, 1, 2, 3, 4, -1])
const prepared = csvLib.prepareRows([['Pine', 'SAM@PINE.EXAMPLE', 'LS1', 'referral', 'Sam'], ['', '', '', '', ''], ['Bad', 'x@', '', 'Billboard', '']], mapping)
assert.deepEqual([prepared[0].row.email, prepared[0].row.source, prepared[0].row.contactName, prepared[0].line], ['sam@pine.example', 'Referral', 'Sam', 2])
assert.deepEqual(prepared[1].errors, ['Add a business or contact name.'])
assert.deepEqual([prepared[2].row, prepared[2].errors.length], [null, 2], 'Every problem in a row is reported.')

// 7. Rollback keeps every lead (a placeholder .invalid address where the old schema needs an email), and the migration re-applies.
const { readFileSync } = await import('node:fs')
const countBefore=await op('select count(*)::int from public.leads'),blank=await op("select count(*)::int from public.leads where email=''")
assert.ok(blank>0)
await actAs(db,null,'postgres');await db.exec(readFileSync('supabase/rollbacks/202610310001_lead_discovery.down.sql','utf8'))
assert.equal(await op('select count(*)::int from public.leads'),countBefore,'Rollback keeps every lead.')
assert.equal(await op("select count(*)::int from public.leads where email like 'no-email+%@leadflow.invalid'"),blank)
assert.equal(await op("select count(*)::int from public.leads where service='Not specified' or source in ('Lead discovery','CSV import')"),0)
assert.equal(await op("select to_regclass('leadflow_private.lead_origins')"),null)
snapshot=await load();assert.equal(snapshot.data.leads[0].website,undefined)
await save(snapshot.data,snapshot.revision)
await actAs(db,null,'postgres');await db.exec(readFileSync('supabase/migrations/202610310001_lead_discovery.sql','utf8'))
snapshot=await load();assert.equal(snapshot.data.leads.length,await op('select count(*)::int from public.leads where workspace_id=$1',[W]));assert.equal(snapshot.data.leads[0].website,'')

console.log('PASS Lead discovery: exact grants and private tables, business fields through snapshot saves, optional email, idempotent CSV and discovery imports with server-side duplicate rules, existing-lead protection, stale-tab protection, row validation, workspace isolation, provenance cleanup, the discover-leads handler (origin/auth/membership, criteria validation, configuration status without secrets, normalization, attribution, contact filters, caching, truncation, empty results, rate limits, retries, timeouts, unknown locations, quotas), browser/SQL duplicate-key parity, CSV parsing, mapping, validation and formula-safe export, and rollback/re-apply. Embedded PostgreSQL; directory and geocoder simulated; no external service contacted.')
