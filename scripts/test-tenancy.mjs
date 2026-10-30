import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createDatabase, actAs, migrations, migrationSql } from '../tests/support/database.ts'
import { businessTypes } from '../src/lib/workspaceOptions.ts'
const owner='11111111-1111-4111-8111-111111111111', admin='22222222-2222-4222-8222-222222222222', member='33333333-3333-4333-8333-333333333333', outsider='44444444-4444-4444-8444-444444444444'
const foundation=migrations.indexOf('202610200001_multi_tenant_foundation.sql')
assert.ok(foundation>0,'The multi-tenant migration must follow the M2/M3 migrations.')
const earlier=migrations.slice(0,foundation), later=migrations.slice(foundation)
// Rollbacks run newest first.
const rollbacks=readdirSync('supabase/rollbacks').filter(name=>name.endsWith('.down.sql')).sort().reverse().map(name=>readFileSync(`supabase/rollbacks/${name}`,'utf8'))
const denied=/permission denied/, noAccess=/not found or access denied/, roleDenied=/role does not allow/
const empty={version:1,leads:[],tasks:[],activities:[]}
const lead=(id,name='Test Lead')=>({id,name,email:`${id}@example.com`,phone:'',company:'',service:'Other',source:'Referral',message:'',status:'New',createdAt:'2026-10-18T00:00:00.000Z'})
const snapshotWith=(...leads)=>({version:1,leads,tasks:leads.map(l=>({id:`task-${l.id}`,leadId:l.id,due:'2026-10-21',notes:'Call back',completed:false})),activities:leads.map(l=>({id:`event-${l.id}`,leadId:l.id,text:'Lead captured',at:l.createdAt}))})
// Since 202610310001 every loaded lead also carries the optional business fields, empty unless set; its rollback removes them.
const businessFields=['website','industry','address','city','region','postcode','country']
const stored=snapshot=>({...snapshot,leads:snapshot.leads.map(l=>({...l,...Object.fromEntries(businessFields.map(key=>[key,'']))}))})
const withoutBusinessFields=workspace=>({...workspace,data:{...workspace.data,leads:workspace.data.leads.map(l=>Object.fromEntries(Object.entries(l).filter(([key])=>!businessFields.includes(key))))}})
const inquiry={name:'Website Person',email:'person@example.com',phone:'',company:'',service:'Consulting',message:'Fictional inquiry.'}
let db
const one=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0]??{})[0]
const rows=async(sql,params=[])=>(await db.query(sql,params)).rows
async function failsAtCommit(sql,pattern){await assert.rejects(()=>db.exec(`begin; ${sql}; commit;`),pattern);await db.exec('rollback')}

// 1. Existing single-owner data keeps every row and its association through the migration.
db=await createDatabase([owner,admin,member,outsider],earlier)
const ownerData=snapshotWith(lead('owner-lead')),ownerRequest=crypto.randomUUID(),legacyInquiry=crypto.randomUUID()
await actAs(db,owner);await db.query('select public.save_workspace($1,0,$2)',[JSON.stringify(ownerData),ownerRequest])
await actAs(db,admin);await db.query('select public.save_workspace($1,0,$2)',[JSON.stringify(snapshotWith(lead('admin-lead'))),crypto.randomUUID()])
await actAs(db,null,'service_role');await db.query("select public.receive_inquiry($1,'main-website',$2,$3,$4,'{}')",[owner,legacyInquiry,JSON.stringify(inquiry),'e'.repeat(64)])
// The member has a credential but never saved, so M2 never created their workspace row.
await actAs(db,null,'postgres');await db.query("insert into leadflow_private.integration_keys(owner_id,label,provider,token_hash,notification_from,notification_to) values($1,'Member automation','webhook',$2,'LeadFlow <n@example.com>','member@example.com')",[member,'c'.repeat(64)])
const tenantTables=['public.leads','public.follow_up_tasks','public.activity_history','public.workspace_requests','leadflow_private.inquiries','leadflow_private.integration_keys']
const tenants=async column=>Object.fromEntries(await Promise.all(tenantTables.map(async table=>[table,await rows(`select ${column}::text as tenant,count(*)::int as n from ${table} group by 1 order by 1`)])))
const tenantsBefore=await tenants('owner_id'),outboxBefore=await one('select count(*)::int from leadflow_private.notification_outbox')
await actAs(db,owner);const ownerSnapshot=await one('select public.load_workspace()')
await actAs(db,null,'postgres');for(const name of later)await db.exec(migrationSql(name))
assert.deepEqual(await tenants('workspace_id'),tenantsBefore,'Every row keeps its original owner as its workspace.')
assert.equal(await one('select count(*)::int from leadflow_private.notification_outbox'),outboxBefore)
assert.deepEqual(await rows("select id::text,owner_id::text,name from public.workspaces order by id"),[owner,admin,member,outsider].map(id=>({id,owner_id:id,name:'Personal workspace'})))
assert.deepEqual(await rows('select workspace_id::text,user_id::text,role from public.workspace_memberships order by user_id'),[owner,admin,member,outsider].map(id=>({workspace_id:id,user_id:id,role:'owner'})))
assert.equal(await one('select count(*)::int from public.profiles'),4);assert.equal(await one('select count(*)::int from public.workspace_settings'),4)
assert.equal(await one('select actor_id::text from public.workspace_requests where request_id=$1',[ownerRequest]),owner)
await actAs(db,owner);assert.deepEqual(withoutBusinessFields(await one('select public.load_workspace()')),ownerSnapshot,'The dashboard RPC returns the same workspace after migration, plus empty business fields.')
assert.equal(await one('select public.save_workspace($1,0,$2)',[JSON.stringify(ownerData),ownerRequest]),1,'A pre-migration save retry stays idempotent.')
await actAs(db,null,'service_role');assert.equal(await one("select public.receive_inquiry($1,'main-website',$2,$3,$4,'{}')",[owner,legacyInquiry,JSON.stringify(inquiry),'e'.repeat(64)]),legacyInquiry)
await actAs(db,null,'postgres');assert.equal(await one('select count(*)::int from public.leads where workspace_id=$1',[owner]),2,'A pre-migration inquiry retry creates no second lead.')
await db.close()

// 2. Catalog: RLS on every table, and no client privilege beyond the intended allowlist.
db=await createDatabase([owner,admin,member,outsider])
assert.deepEqual(await rows("select c.oid::regclass::text as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','leadflow_private') and c.relkind in ('r','p') and not c.relrowsecurity"),[],'RLS is enabled on every table.')
const tablePrivileges=(await rows(`select r.role||' '||p.privilege||' '||c.oid::regclass::text as grant from pg_class c join pg_namespace n on n.oid=c.relnamespace
 cross join (values ('anon'),('authenticated')) r(role) cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
 where n.nspname in ('public','leadflow_private') and c.relkind in ('r','p','v','m')
 and (has_table_privilege(r.role,c.oid,p.privilege) or (p.privilege in ('SELECT','INSERT','UPDATE','REFERENCES') and has_any_column_privilege(r.role,c.oid,p.privilege)))`)).map(row=>row.grant).sort()
assert.deepEqual(tablePrivileges,['activity_history','follow_up_tasks','leads','profiles','workspace_memberships','workspace_requests','workspace_settings','workspaces'].map(table=>`authenticated SELECT ${table}`).sort(),'Clients can only select, and only through RLS.')
const executable=async role=>(await rows("select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','leadflow_private') and has_function_privilege($1,p.oid,'EXECUTE')",[role])).map(row=>row.fn).sort()
assert.deepEqual(await executable('anon'),[],'Anonymous callers cannot execute any function.')
assert.deepEqual(await executable('authenticated'),['create_workspace(text,text,uuid)','inquiry_form_for(uuid)','integration_overview()','integration_overview_for(uuid)','leadflow_private.member_workspace_ids()','leadflow_private.visible_profile_ids()','leave_workspace(uuid)','list_workspace_members(uuid)','list_workspaces()','load_workspace()','load_workspace_for(uuid)','remove_workspace_member(uuid,uuid)','revoke_integration(uuid)','revoke_integration_for(uuid,uuid)','save_workspace(jsonb,bigint,uuid)','save_workspace_for(uuid,jsonb,bigint,uuid)','set_workspace_member(uuid,uuid,text)','update_inquiry_form(uuid,boolean,text,boolean)','update_profile(text)','update_workspace(uuid,text,text,text)','verify_integration_receipt(uuid)','verify_integration_receipt_for(uuid,uuid)',
 // Client onboarding (202610250001): role-checked like the rest; the portal and reminder functions are service-role only.
 'onboarding_overview_for(uuid)','onboarding_request_for(uuid,uuid)','onboarding_template_for(uuid,uuid)','install_starter_templates(uuid)','save_onboarding_template(uuid,jsonb,integer,uuid)','set_onboarding_template_archived(uuid,uuid,boolean)','create_onboarding_request(uuid,jsonb,uuid)','update_onboarding_request(uuid,uuid,jsonb,integer)','save_onboarding_item(uuid,uuid,jsonb,integer)','remove_onboarding_item(uuid,uuid,uuid,integer)','set_onboarding_status(uuid,uuid,text,integer,text)','review_onboarding_item(uuid,uuid,uuid,text,text,integer)','issue_onboarding_link(uuid,uuid,integer,boolean)','revoke_onboarding_links(uuid,uuid,uuid)','hand_off_onboarding(uuid,uuid,text)',
 // Lead discovery (202610310001): imports, provenance and history; provider-side functions are service-role only.
 'import_leads(uuid,uuid,jsonb)','lead_origins_for(uuid)','start_discovery_search(uuid,uuid,text,jsonb)','discovery_history_for(uuid)'].sort(),'Signed-in users get exactly the dashboard functions.')
for(const fn of ['portal_open(text)','portal_save_item(text,uuid,jsonb,boolean,integer)','claim_onboarding_reminder(text,text)','finish_onboarding_reminder(uuid,uuid,text,text,text)'])assert.ok((await executable('service_role')).includes(fn),fn)
for(const fn of ['receive_workspace_inquiry(uuid,text,uuid,jsonb,text,jsonb)','receive_form_inquiry(uuid,uuid,jsonb,text,text)','receive_inquiry(uuid,text,uuid,jsonb,text,jsonb)','receive_webhook(text,uuid,jsonb,text)'])assert.ok((await executable('service_role')).includes(fn),fn)
assert.deepEqual(await rows("select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','leadflow_private') and p.prosecdef and not coalesce('search_path=\"\"'=any(p.proconfig),false)"),[],'Every security-definer function pins an empty search path.')

// 3. Roles, memberships and workspace-scoped data.
await actAs(db,owner)
const team=await one("select public.create_workspace('  Agency team  ')")
assert.equal(await one('select name from public.workspaces where id=$1',[team]),'Agency team')
await db.query("select public.set_workspace_member($1,$2,'admin')",[team,admin])
await db.query("select public.set_workspace_member($1,$2,'member')",[team,member])
const workspacesOf=async user=>{await actAs(db,user);return rows('select id::text,role from public.list_workspaces()')}
assert.deepEqual(await workspacesOf(owner),[{id:owner,role:'owner'},{id:team,role:'owner'}])
assert.deepEqual(await workspacesOf(admin),[{id:admin,role:'owner'},{id:team,role:'admin'}])
assert.deepEqual(await workspacesOf(member),[{id:member,role:'owner'},{id:team,role:'member'}])
assert.deepEqual(await workspacesOf(outsider),[{id:outsider,role:'owner'}])

// Members share one workspace's data; personal and team data stay separate.
const teamData=snapshotWith(lead('team-lead','Team Prospect')),teamRequest=crypto.randomUUID()
await actAs(db,member);assert.equal(await one('select public.save_workspace_for($1,$2,0,$3)',[team,JSON.stringify(teamData),teamRequest]),1)
await actAs(db,admin);assert.deepEqual(await one('select public.load_workspace_for($1)',[team]),{revision:1,data:stored(teamData)})
await assert.rejects(()=>db.query('select public.save_workspace_for($1,$2,0,$3)',[team,JSON.stringify(empty),crypto.randomUUID()]),/another session/,'A stale save from another member cannot overwrite newer data.')
await actAs(db,owner);await db.query('select public.save_workspace($1,0,$2)',[JSON.stringify(snapshotWith(lead('personal-lead','Personal Prospect'))),crypto.randomUUID()])
assert.deepEqual((await one('select public.load_workspace()')).data.leads.map(l=>l.name),['Personal Prospect'])
const crossLinked={...teamData,tasks:[...teamData.tasks,{id:'cross',leadId:'personal-lead',due:'2026-10-22',notes:'Cross-workspace link',completed:false}]}
await assert.rejects(()=>db.query('select public.save_workspace_for($1,$2,1,$3)',[team,JSON.stringify(crossLinked),crypto.randomUUID()]),/foreign key/,'A team task cannot reference a lead in another workspace.')
await actAs(db,null,'postgres');assert.equal(await one('select actor_id::text from public.workspace_requests where request_id=$1',[teamRequest]),member)

// Integrations: the credential or server configuration chooses the workspace, never the caller.
const teamKey=await one("insert into leadflow_private.integration_keys(workspace_id,label,provider,token_hash,notification_from,notification_to) values($1,'Team webhook','webhook',$2,'LeadFlow <n@example.com>','team-inbox@example.com') returning id",[team,'d'.repeat(64)])
const teamInquiry=crypto.randomUUID(),hookSubmission=crypto.randomUUID()
await actAs(db,null,'service_role')
await db.query("select public.receive_workspace_inquiry($1,'team-site',$2,$3,$4,'{}')",[team,teamInquiry,JSON.stringify(inquiry),'f'.repeat(64)])
await db.query('select public.receive_webhook($1,$2,$3,$4)',['d'.repeat(64),hookSubmission,JSON.stringify({...inquiry,email:'hook@example.com'}),'9'.repeat(64)])
await actAs(db,null,'postgres')
assert.deepEqual(await rows('select workspace_id::text,source from public.leads where id in ($1,$2) order by source',[teamInquiry,hookSubmission]),[{workspace_id:team,source:'Other'},{workspace_id:team,source:'Website'}])
assert.equal(await one('select count(*)::int from public.leads where workspace_id=$1',[owner]),1,'Team intake never reaches the owner\'s personal workspace.')
await actAs(db,member)
const overview=await one('select public.integration_overview_for($1)',[team])
assert.equal(overview.credentials[0].label,'Team webhook');assert.equal(overview.email.pending,2)
for(const secret of ['d'.repeat(64),'team-inbox@example.com'])assert.equal(JSON.stringify(overview).includes(secret),false)
assert.equal((await one('select public.verify_integration_receipt_for($1,$2)',[team,teamInquiry])).channel,'Website')
assert.equal((await one('select public.verify_integration_receipt_for($1,$2)',[team,hookSubmission])).channel,'Webhook')
await assert.rejects(()=>db.query('select public.revoke_integration_for($1,$2)',[team,teamKey]),roleDenied)
await actAs(db,owner)
await assert.rejects(()=>db.query('select public.verify_integration_receipt($1)',[teamInquiry]),/No matching inquiry/,'The personal-workspace RPC cannot see team receipts.')
await db.query('select public.revoke_integration($1)',[teamKey])
await actAs(db,null,'postgres');assert.equal(await one('select revoked_at from leadflow_private.integration_keys where id=$1',[teamKey]),null)

// Settings and profiles.
await actAs(db,admin)
await db.query("select public.update_workspace($1,'Renamed team','Europe/London')",[team])
await assert.rejects(()=>db.query("select public.update_workspace($1,null,'Mars/Olympus_Mons')",[team]),/time zone/)
for(const name of ['   ','bad\nname','x'.repeat(101)])await assert.rejects(()=>db.query('select public.update_workspace($1,$2,null)',[team,name]),/1 to 100/)
await actAs(db,owner);await db.query("select public.update_profile('  Alex Owner  ')")
await assert.rejects(()=>db.query('select public.update_profile($1)',['x'.repeat(151)]),/150/)
await actAs(db,member)
assert.deepEqual(await rows('select w.name,s.timezone from public.workspaces w join public.workspace_settings s on s.workspace_id=w.id where w.id=$1',[team]),[{name:'Renamed team',timezone:'Europe/London'}])
assert.equal(await one('select display_name from public.profiles where id=$1',[owner]),'Alex Owner','Teammates can see each other\'s display names.')

// 4. Cross-workspace attempts: guessed or real workspace IDs from a non-member are rejected identically.
const unknown=crypto.randomUUID()
await actAs(db,outsider)
for(const target of [team,owner,unknown]){
 for(const [sql,params] of [['select public.load_workspace_for($1)',[target]],['select public.save_workspace_for($1,$2,1,$3)',[target,JSON.stringify(empty),crypto.randomUUID()]],
  ['select public.integration_overview_for($1)',[target]],['select public.verify_integration_receipt_for($1,$2)',[target,teamInquiry]],['select public.revoke_integration_for($1,$2)',[target,teamKey]],
  ["select public.update_workspace($1,'Hijacked',null)",[target]],["select public.set_workspace_member($1,$2,'admin')",[target,outsider]],
  ['select public.remove_workspace_member($1,$2)',[target,member]],['select public.leave_workspace($1)',[target]]])
  await assert.rejects(()=>db.query(sql,params),noAccess,`${sql} → ${target}`)
}
for(const [table,column] of [['workspaces','id'],['workspace_memberships','workspace_id'],['workspace_settings','workspace_id'],['leads','workspace_id'],['follow_up_tasks','workspace_id'],['activity_history','workspace_id'],['workspace_requests','workspace_id']])
 assert.equal(await one(`select count(*)::int from public.${table} where ${column}=any($1)`,[[team,owner]]),0,`An outsider reads no ${table} rows from other workspaces.`)
assert.deepEqual(await rows('select id::text from public.profiles'),[{id:outsider}])
await actAs(db,null,'postgres')
assert.deepEqual(await rows('select name,revision::int from public.workspaces where id=$1',[team]),[{name:'Renamed team',revision:3}],'Rejected attempts changed nothing.')

// Escalation attempts through the management functions.
await actAs(db,member)
for(const [sql,params] of [["select public.set_workspace_member($1,$2,'admin')",[team,member]],["select public.set_workspace_member($1,$2,'member')",[team,outsider]],
 ['select public.remove_workspace_member($1,$2)',[team,admin]],["select public.update_workspace($1,'Renamed',null)",[team]]])await assert.rejects(()=>db.query(sql,params),roleDenied,sql)
await actAs(db,admin)
await assert.rejects(()=>db.query("select public.set_workspace_member($1,$2,'admin')",[team,admin]),/own membership/)
await assert.rejects(()=>db.query("select public.set_workspace_member($1,$2,'owner')",[team,admin]),/admin or member/)
await assert.rejects(()=>db.query("select public.set_workspace_member($1,$2,'admin')",[team,member]),/Only the workspace owner can grant/)
await assert.rejects(()=>db.query("select public.set_workspace_member($1,$2,'member')",[team,owner]),/owner role cannot be changed/)
await assert.rejects(()=>db.query('select public.remove_workspace_member($1,$2)',[team,owner]),/owner cannot be removed/)
await actAs(db,owner)
await assert.rejects(()=>db.query("select public.set_workspace_member($1,$2,'owner')",[team,admin]),/admin or member/)
await assert.rejects(()=>db.query("select public.set_workspace_member($1,$2,'admin')",[team,owner]),/own membership/)
await assert.rejects(()=>db.query('select public.remove_workspace_member($1,$2)',[team,owner]),/leave_workspace/)
await assert.rejects(()=>db.query('select public.leave_workspace($1)',[team]),/owner cannot leave/)
await assert.rejects(()=>db.query("select public.set_workspace_member($1,$2,'member')",[team,unknown]),/User not found/)

// Direct table writes, private tables and private functions are closed to every client, including owners.
for(const user of [owner,member]){
 await actAs(db,user)
 for(const sql of [`insert into public.workspace_memberships(workspace_id,user_id,role) values('${team}','${outsider}','owner')`,`update public.workspace_memberships set role='owner' where user_id='${user}'`,
  `delete from public.workspace_memberships where workspace_id='${team}'`,`update public.workspaces set owner_id='${user}' where id='${team}'`,`insert into public.workspaces(id,owner_id) values(gen_random_uuid(),'${user}')`,
  `delete from public.workspaces where id='${team}'`,"update public.workspace_settings set timezone='UTC'",`insert into public.profiles(id) values('${outsider}')`,"update public.profiles set display_name='x'",
  `insert into public.leads(workspace_id,id,name,email,phone,company,service,source,message,status,"createdAt") values('${team}','x','x','x@example.com','','','Other','Other','','New',now())`,
  `update public.leads set workspace_id='${user}'`,'delete from public.activity_history',`insert into public.workspace_requests(workspace_id,request_id,payload_hash,revision) values('${team}',gen_random_uuid(),'x',9)`,
  'select * from leadflow_private.integration_keys','select * from leadflow_private.inquiries',`select leadflow_private.transfer_workspace_ownership('${team}','${user}')`,
  `select leadflow_private.require_role('${team}',array['owner'])`,`select public.receive_workspace_inquiry('${team}','x',gen_random_uuid(),'{}','x','{}')`,
  `select public.receive_inquiry('${team}','x',gen_random_uuid(),'{}','x','{}')`,`select public.receive_webhook('x',gen_random_uuid(),'{}','x')`,'select public.claim_notification(null)'])
  await assert.rejects(()=>db.query(sql),denied,sql)
}
await actAs(db,null,'anon')
for(const table of ['workspaces','workspace_memberships','workspace_settings','profiles','leads','follow_up_tasks','activity_history','workspace_requests'])await assert.rejects(()=>db.query(`select * from public.${table}`),denied,table)
for(const sql of ['select public.load_workspace()','select * from public.list_workspaces()',`select public.load_workspace_for('${team}')`,"select public.create_workspace('x')",`select public.receive_workspace_inquiry('${team}','x',gen_random_uuid(),'{}','x','{}')`])await assert.rejects(()=>db.query(sql),denied,sql)

// Admins manage members only; removal and leaving take effect immediately.
await actAs(db,admin)
await db.query("select public.set_workspace_member($1,$2,'member')",[team,outsider])
await actAs(db,outsider);assert.equal((await one('select public.load_workspace_for($1)',[team])).data.leads.length,3)
await actAs(db,admin)
await assert.rejects(()=>db.query("select public.set_workspace_member($1,$2,'admin')",[team,outsider]),/Only the workspace owner can grant/)
await db.query('select public.remove_workspace_member($1,$2)',[team,outsider])
await actAs(db,outsider);await assert.rejects(()=>db.query('select public.load_workspace_for($1)',[team]),noAccess)
assert.equal(await one('select count(*)::int from public.leads where workspace_id=$1',[team]),0)
await actAs(db,owner);await db.query('select public.remove_workspace_member($1,$2)',[team,member])
await actAs(db,member);await assert.rejects(()=>db.query('select public.save_workspace_for($1,$2,3,$3)',[team,JSON.stringify(empty),crypto.randomUUID()]),noAccess)
assert.deepEqual(await rows('select id::text from public.list_workspaces()'),[{id:member}])
assert.deepEqual(await rows('select id::text from public.profiles'),[{id:member}],'Former teammates\' profiles are no longer visible.')
await actAs(db,admin);assert.equal(await one('select public.revoke_integration_for($1,$2)',[team,teamKey]),true);assert.equal(await one('select public.revoke_integration_for($1,$2)',[team,teamKey]),false)
await db.query('select public.leave_workspace($1)',[team]);await assert.rejects(()=>db.query('select public.load_workspace_for($1)',[team]),noAccess)
await actAs(db,null,'service_role');await assert.rejects(()=>db.query('select public.receive_webhook($1,$2,$3,$4)',['d'.repeat(64),crypto.randomUUID(),JSON.stringify(inquiry),'9'.repeat(64)]),/Invalid credential/)

// Anonymous Auth sessions and identities missing from auth.users get nothing, even with a membership.
await actAs(db,owner);await db.query("select public.set_workspace_member($1,$2,'member')",[team,member])
await actAs(db,member,'authenticated',{is_anonymous:true})
for(const sql of ['select public.load_workspace()',`select public.load_workspace_for('${team}')`,'select * from public.list_workspaces()',"select public.create_workspace('x')"])await assert.rejects(()=>db.query(sql),/internal account/,sql)
for(const table of ['workspaces','leads','workspace_memberships','profiles'])assert.equal(await one(`select count(*)::int from public.${table}`),0,table)
await actAs(db,unknown);await assert.rejects(()=>db.query('select public.load_workspace()'),/internal account/)

// Accounts created after the migration get a personal workspace on first use, as in M2.
const newcomer=crypto.randomUUID()
await actAs(db,null,'postgres');await db.query('insert into auth.users(id) values($1)',[newcomer])
await actAs(db,newcomer);assert.deepEqual(await one('select public.load_workspace()'),{revision:0,data:empty})
assert.equal(await one('select public.save_workspace($1,0,$2)',[JSON.stringify(snapshotWith(lead('new-lead'))),crypto.randomUUID()]),1)
for(let i=1;i<25;i++)await db.query('select public.create_workspace($1)',[`Workspace ${i}`])
await assert.rejects(()=>db.query("select public.create_workspace('One too many')"),/at most 25/)

// 5. Ownership invariants hold even for operator SQL; transfer is an operator-only path.
await actAs(db,null,'postgres')
await assert.rejects(()=>db.query("insert into public.workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner')",[team,outsider]),/duplicate key/)
await failsAtCommit(`update public.workspaces set owner_id='${outsider}' where id='${team}'`,/must hold its owner membership/)
await failsAtCommit(`update public.workspace_memberships set role='admin' where workspace_id='${team}' and user_id='${owner}'`,/must hold its owner membership/)
await failsAtCommit(`delete from public.workspace_memberships where workspace_id='${team}' and user_id='${owner}'`,/must hold its owner membership/)
await failsAtCommit(`update public.workspace_memberships set workspace_id='${outsider}',role='admin' where workspace_id='${team}' and user_id='${owner}'`,/must hold its owner membership/)
await assert.rejects(()=>db.query('select leadflow_private.transfer_workspace_ownership($1,$2)',[team,outsider]),/already be a workspace member/)
await db.query('select leadflow_private.transfer_workspace_ownership($1,$2)',[team,member])
assert.deepEqual(await rows('select user_id::text,role from public.workspace_memberships where workspace_id=$1 order by role desc',[team]),[{user_id:member,role:'owner'},{user_id:owner,role:'admin'}])
assert.equal(await one('select owner_id::text from public.workspaces where id=$1',[team]),member)

// 6. Deletion: owners cannot be deleted while they own workspaces; deleting a workspace removes only its data.
await actAs(db,member);await db.query("select public.set_workspace_member($1,$2,'member')",[team,outsider])
await actAs(db,null,'postgres')
await assert.rejects(()=>db.query('delete from auth.users where id=$1',[outsider]),/foreign key/)
await db.query('delete from public.workspaces where owner_id=$1',[outsider]);await db.query('delete from auth.users where id=$1',[outsider])
assert.equal(await one('select count(*)::int from public.workspace_memberships where user_id=$1',[outsider]),0)
const countsBy=async target=>Object.fromEntries(await Promise.all(tenantTables.map(async table=>[table,await one(`select count(*)::int from ${table} where workspace_id=$1`,[target])])))
const ownerCounts=await countsBy(owner)
await db.query('delete from public.workspaces where id=$1',[team])
assert.deepEqual(Object.values(await countsBy(team)),tenantTables.map(()=>0))
assert.equal(await one('select count(*)::int from leadflow_private.notification_outbox o join leadflow_private.inquiries i using(request_id) where i.workspace_id=$1',[team]),0)
assert.deepEqual(await countsBy(owner),ownerCounts,'Other workspaces are untouched.')
await db.close()

// 7. Rollback refuses to discard shared workspaces; otherwise it restores the original schema without loss.
db=await createDatabase([owner,admin])
await actAs(db,owner);const shared=await one("select public.create_workspace('Shared')")
await actAs(db,null,'postgres');for(const sql of rollbacks.slice(0,-1))await db.exec(sql)
await assert.rejects(()=>db.exec(rollbacks.at(-1)),/Rollback refused/)
assert.equal(await one('select name from public.workspaces where id=$1',[shared]),'Shared')
await db.close()
db=await createDatabase([owner,admin],earlier)
await actAs(db,owner);await db.query('select public.save_workspace($1,0,$2)',[JSON.stringify(ownerData),crypto.randomUUID()])
await actAs(db,null,'service_role');await db.query("select public.receive_inquiry($1,'main-website',$2,$3,$4,'{}')",[owner,legacyInquiry,JSON.stringify(inquiry),'e'.repeat(64)])
await actAs(db,null,'postgres');await db.query("insert into leadflow_private.integration_keys(owner_id,label,provider,token_hash,notification_from,notification_to) values($1,'Owner automation','zapier',$2,'LeadFlow <n@example.com>','owner@example.com')",[owner,'a'.repeat(64)])
for(const name of later)await db.exec(migrationSql(name))
await actAs(db,owner);await db.query('select public.save_workspace($1,2,$2)',[JSON.stringify(snapshotWith(lead('owner-lead'),lead('after-migration'))),crypto.randomUUID()])
await db.query("select public.update_profile('Owner')")
const beforeRollback={workspace:withoutBusinessFields(await one('select public.load_workspace()')),integrations:await one('select public.integration_overview()')}
await actAs(db,null,'postgres');for(const sql of rollbacks)await db.exec(sql)
assert.equal(await one("select to_regclass('public.profiles')"),null);assert.equal(await one("select to_regclass('public.workspace_memberships')"),null)
assert.equal(await one('select count(*)::int from public.leads where owner_id=$1',[owner]),2)
assert.deepEqual(await rows("select proname from pg_proc where pronamespace='leadflow_private'::regnamespace or (pronamespace='public'::regnamespace and (proname in ('list_workspaces','list_workspace_members','inquiry_form_for','update_inquiry_form','receive_form_inquiry','create_workspace','update_workspace','set_workspace_member','remove_workspace_member','leave_workspace','update_profile','receive_workspace_inquiry') or proname like '%\\_for'))"),[])
await actAs(db,owner)
assert.deepEqual({workspace:await one('select public.load_workspace()'),integrations:await one('select public.integration_overview()')},beforeRollback)
assert.equal(await one('select public.save_workspace($1,3,$2)',[JSON.stringify(ownerData),crypto.randomUUID()]),4)
await actAs(db,admin);assert.equal(await one('select count(*)::int from public.leads'),0)
const afterRollback=crypto.randomUUID()
await actAs(db,null,'service_role');assert.equal(await one("select public.receive_inquiry($1,'main-website',$2,$3,$4,'{}')",[admin,afterRollback,JSON.stringify(inquiry),'e'.repeat(64)]),afterRollback)
// The foundation applies again after a rollback.
await actAs(db,null,'postgres');for(const name of later)await db.exec(migrationSql(name))
await actAs(db,owner);assert.equal((await one('select public.load_workspace()')).revision,4)
await actAs(db,admin);assert.equal((await one('select public.load_workspace()')).data.leads[0].id,afterRollback)
await db.close()

// 8. Onboarding: new accounts start with no workspace; creation is idempotent per request.
db=await createDatabase([owner])
const fresh=crypto.randomUUID(),stranger=crypto.randomUUID()
await db.query("insert into auth.users(id,email) values($1,'fresh@example.com'),($2,'stranger@example.com')",[fresh,stranger])
await db.query("update auth.users set email='owner@example.com' where id=$1",[owner])
await actAs(db,fresh)
assert.deepEqual(await rows('select * from public.list_workspaces()'),[],'New accounts get no automatic workspace.')
const creation=crypto.randomUUID()
const first=await one("select public.create_workspace('  Northline Studio  ','Design studio',$1)",[creation])
assert.equal(await one("select public.create_workspace('Northline Studio','Design studio',$1)",[creation]),first,'A retried request returns the same workspace.')
await assert.rejects(()=>db.query("select public.create_workspace('Another name','Design studio',$1)",[creation]),/already created a different workspace/)
await assert.rejects(()=>db.query("select public.create_workspace('Northline Studio','Freelancer',$1)",[creation]),/already created a different workspace/)
await assert.rejects(()=>db.query("select public.create_workspace('Typo','Space agency',$1)",[crypto.randomUUID()]),/listed business type/)
for(const type of businessTypes)await db.query('select public.create_workspace($1,$2,$3)',[`${type} workspace`,type,crypto.randomUUID()])
assert.equal(await one('select count(*)::int from public.workspaces where owner_id=$1',[fresh]),1+businessTypes.length,'Every business type offered by the UI is accepted.')
assert.deepEqual((await rows('select id::text,name,role,business_type,timezone from public.list_workspaces()'))[0],{id:first,name:'Northline Studio',role:'owner',business_type:'Design studio',timezone:'UTC'})
await db.query("select public.update_workspace($1,null,null,'Consultancy')",[first])
assert.equal(await one('select business_type from public.workspace_settings where workspace_id=$1',[first]),'Consultancy')
await db.query("select public.update_workspace($1,null,null,'')",[first])
assert.equal(await one('select business_type from public.workspace_settings where workspace_id=$1',[first]),null,'An empty business type clears it.')
await assert.rejects(()=>db.query("select public.update_workspace($1,null,null,'Space agency')",[first]),/listed business type/)
assert.deepEqual(await rows('select user_id::text,role,email from public.list_workspace_members($1)',[first]),[{user_id:fresh,role:'owner',email:'fresh@example.com'}])
// Members see teammates' emails and roles; non-members and members' edits are refused.
await actAs(db,owner);const shop=await one("select public.create_workspace('Shared shop')");await db.query("select public.set_workspace_member($1,$2,'member')",[shop,fresh])
await actAs(db,fresh)
assert.deepEqual(await rows('select user_id::text,role,email from public.list_workspace_members($1)',[shop]),[{user_id:owner,role:'owner',email:'owner@example.com'},{user_id:fresh,role:'member',email:'fresh@example.com'}])
await assert.rejects(()=>db.query("select public.update_workspace($1,'Renamed',null,null)",[shop]),roleDenied)
await assert.rejects(()=>db.query("select public.update_workspace($1,null,null,'Freelancer')",[shop]),roleDenied)
await actAs(db,stranger)
await assert.rejects(()=>db.query('select * from public.list_workspace_members($1)',[shop]),noAccess)
await assert.rejects(()=>db.query('select * from public.list_workspace_members($1)',[first]),noAccess)
assert.deepEqual(await rows('select * from public.list_workspaces()'),[])
await actAs(db,null,'anon');await assert.rejects(()=>db.query('select * from public.list_workspace_members($1)',[shop]),denied)
await db.close()

// 9. Workspace forms: each workspace's public key routes to that workspace and notifies its own recipient.
db=await createDatabase([owner,admin,member,outsider])
for(const [id,email] of [[owner,'owner@example.com'],[admin,'admin@example.com'],[member,'member@example.com'],[outsider,'outsider@example.com']])await db.query('update auth.users set email=$2 where id=$1',[id,email])
await actAs(db,owner);const studio=await one("select public.create_workspace('Studio')")
await db.query("select public.set_workspace_member($1,$2,'admin')",[studio,admin]);await db.query("select public.set_workspace_member($1,$2,'member')",[studio,member])
await actAs(db,null,'postgres')
assert.equal(await one('select count(*)::int from leadflow_private.inquiry_forms'),5,'Existing workspaces were given forms and new ones get one automatically.')
assert.equal(await one('select count(*)::int from leadflow_private.inquiry_forms where id::text in (select id::text from public.workspaces)'),0,'Form keys are never workspace IDs.')
await actAs(db,member)
const studioForm=await one('select public.inquiry_form_for($1)',[studio])
assert.deepEqual({enabled:studioForm.enabled,recipient:studioForm.recipient,notificationEmail:studioForm.notificationEmail},{enabled:true,recipient:'owner@example.com',notificationEmail:null})
await assert.rejects(()=>db.query("select public.update_inquiry_form($1,false)",[studio]),roleDenied)
await actAs(db,outsider)
for(const sql of ['select public.inquiry_form_for($1)',"select public.update_inquiry_form($1,false)"])await assert.rejects(()=>db.query(sql,[studio]),noAccess)
await actAs(db,admin)
await assert.rejects(()=>db.query("select public.update_inquiry_form($1,null,'not-an-email')",[studio]),/valid recipient/)
assert.equal((await one("select public.update_inquiry_form($1,null,'  leads@studio.example  ')",[studio])).recipient,'leads@studio.example')
await actAs(db,owner);const personalForm=await one('select public.inquiry_form_for($1)',[owner])
const formInquiry=(key,email='visitor@example.com')=>db.query("select public.receive_form_inquiry($1,$2,$3,$4,'LeadFlow <n@example.com>') as id",[key,crypto.randomUUID(),JSON.stringify({...inquiry,email}),'a'.repeat(64)]).then(result=>result.rows[0].id)
await actAs(db,null,'service_role')
const studioLead=await formInquiry(studioForm.formKey),personalLead=await formInquiry(personalForm.formKey)
await actAs(db,null,'postgres')
assert.deepEqual(await rows('select id,workspace_id::text from public.leads order by workspace_id=$1',[studio]),[{id:personalLead,workspace_id:owner},{id:studioLead,workspace_id:studio}].sort((a,b)=>Number(a.workspace_id===studio)-Number(b.workspace_id===studio)))
const studioEmail=await one('select email from leadflow_private.notification_outbox where request_id=$1',[studioLead])
assert.deepEqual(studioEmail.to,['leads@studio.example']);assert.match(studioEmail.text,/Workspace: Studio/)
assert.deepEqual((await one('select email from leadflow_private.notification_outbox where request_id=$1',[personalLead])).to,['owner@example.com'],'Each workspace notifies its own recipient.')
// Turned-off, re-keyed and unknown forms accept nothing; the old key stops working after re-keying.
await actAs(db,admin);await db.query('select public.update_inquiry_form($1,false)',[studio])
await actAs(db,null,'service_role');await assert.rejects(()=>formInquiry(studioForm.formKey),/not accepting inquiries/)
await actAs(db,admin);const rekeyed=await one('select public.update_inquiry_form($1,true,null,true)',[studio]);assert.notEqual(rekeyed.formKey,studioForm.formKey)
await actAs(db,null,'service_role')
await assert.rejects(()=>formInquiry(studioForm.formKey,'old@example.com'),/not accepting inquiries/)
await assert.rejects(()=>formInquiry(crypto.randomUUID(),'random@example.com'),/not accepting inquiries/)
assert.ok(await formInquiry(rekeyed.formKey,'new@example.com'))
for(const role of ['anon','authenticated']){await actAs(db,role==='anon'?null:owner,role);await assert.rejects(()=>formInquiry(rekeyed.formKey),denied)}

// 10. Members can add and update, but not remove leads or follow-ups or rewrite history; owners and admins can.
await actAs(db,member)
const base=await one('select public.load_workspace_for($1)',[studio])
const memberLead=lead('member-lead','Member Lead'),withMember={...base.data,leads:[...base.data.leads,memberLead],tasks:[{id:'member-task',leadId:memberLead.id,due:'2026-10-25',notes:'Call',completed:false}],activities:[{id:'member-event',leadId:memberLead.id,text:'Lead captured',at:memberLead.createdAt},...base.data.activities]}
let revision=await one('select public.save_workspace_for($1,$2,$3,$4)',[studio,JSON.stringify(withMember),base.revision,crypto.randomUUID()])
const edited={...withMember,leads:withMember.leads.map(l=>l.id==='member-lead'?{...l,status:'Contacted'}:l),tasks:withMember.tasks.map(t=>({...t,completed:true})),activities:[{id:'member-event-2',leadId:memberLead.id,text:'Status changed from New to Contacted',at:'2026-10-19T00:00:00.000Z'},...withMember.activities]}
revision=await one('select public.save_workspace_for($1,$2,$3,$4)',[studio,JSON.stringify(edited),revision,crypto.randomUUID()])
for(const [attempt,pattern] of [[{...edited,leads:edited.leads.filter(l=>l.id!=='member-lead'),tasks:[],activities:edited.activities.filter(a=>a.leadId!=='member-lead')},/remove leads or follow-ups/],
 [{...edited,tasks:[]},/remove leads or follow-ups/],
 [{...edited,activities:edited.activities.filter(a=>a.id!=='member-event')},/activity history/],
 [{...edited,activities:edited.activities.map(a=>a.id==='member-event'?{...a,text:'Rewritten'}:a)},/activity history/],
 [{version:1,leads:[],tasks:[],activities:[]},/remove leads or follow-ups/]])
 await assert.rejects(()=>db.query('select public.save_workspace_for($1,$2,$3,$4)',[studio,JSON.stringify(attempt),revision,crypto.randomUUID()]),pattern)
await actAs(db,admin)
revision=await one('select public.save_workspace_for($1,$2,$3,$4)',[studio,JSON.stringify({...edited,tasks:[]}),revision,crypto.randomUUID()])
await actAs(db,owner);await one('select public.save_workspace_for($1,$2,$3,$4)',[studio,JSON.stringify(empty),revision,crypto.randomUUID()])
await actAs(db,null,'postgres');assert.equal(await one('select count(*)::int from public.leads where workspace_id=$1',[studio]),0,'Owners and admins can still remove records and reset.')
await db.close()
console.log('PASS Tenancy: lossless migration of existing data, RLS on every table, exact client grants, owner/admin/member permissions, cross-workspace denial, escalation and direct-write denial, anonymous rejection, membership removal, ownership invariants, deletion behaviour, guarded rollback/re-apply, onboarding without automatic workspaces, idempotent workspace creation, business types, member lists, workspace-keyed public forms with per-workspace notification recipients, and member limits on removing records or rewriting history. Run in embedded PostgreSQL; hosted Supabase not contacted.')
