import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
let db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
grant usage on schema public,auth to anon,authenticated;
grant execute on all functions in schema auth to anon,authenticated;
insert into auth.users values ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');`)
await db.exec(readFileSync('supabase/migrations/202610180001_m2.sql','utf8'))
await db.exec(readFileSync('supabase/migrations/202610180002_m3.sql','utf8'))
 await db.exec(readFileSync('supabase/migrations/202610180003_integrations.sql','utf8'))
const userA='11111111-1111-4111-8111-111111111111', userB='22222222-2222-4222-8222-222222222222'
async function asUser(id,role='authenticated') { await db.exec(`reset role; set role ${role}; select set_config('request.jwt.claim.sub','${id}',false); select set_config('request.jwt.claims','{}',false);`) }
const empty={version:1,leads:[],tasks:[],activities:[]}
const lead={id:'legacy-lead',name:'Test Lead',email:'test@example.com',phone:'',company:'',service:'Other',source:'Website',message:'',status:'New',createdAt:'2026-10-18T00:00:00.000Z'}
const data={version:1,leads:[lead],tasks:[{id:'task',leadId:lead.id,due:'2026-10-19',notes:'Call back',completed:false}],activities:[{id:'event',leadId:lead.id,text:'Lead captured',at:lead.createdAt}]}
async function save(payload,revision,id=crypto.randomUUID()){return (await db.query('select public.save_workspace($1::jsonb,$2::bigint,$3::uuid) as revision',[JSON.stringify(payload),revision,id])).rows[0].revision}
async function load(){return (await db.query('select public.load_workspace() as snapshot')).rows[0].snapshot}
async function denied(operation,pattern){await assert.rejects(operation,pattern)}
await asUser('', 'anon')
for(const table of ['leads','follow_up_tasks','activity_history','workspaces','workspace_requests']) await denied(()=>db.query(`select * from public.${table}`),/permission denied/)
await denied(load,/permission denied/)
await denied(()=>save(data,0),/permission denied/)
await asUser(userA)
assert.deepEqual(await load(),{revision:0,data:empty})
const request=crypto.randomUUID()
assert.equal(await save(data,0,request),1)
assert.equal(await save(data,0,request),1)
assert.deepEqual(await load(),{revision:1,data})
await denied(()=>save(empty,0,request),/different data/)
await denied(()=>save(empty,0),/another session/)
for(const table of ['leads','follow_up_tasks','activity_history','workspaces','workspace_requests']) {
 await denied(()=>db.query(`delete from public.${table}`),/permission denied/)
 await denied(()=>db.query(`update public.${table} set owner_id='${userB}'`),/permission denied/)
 await denied(()=>db.query(`insert into public.${table}(owner_id) values ('${userB}')`),/permission denied/)
}
await asUser(userB)
assert.deepEqual(await load(),{revision:0,data:empty})
for(const table of ['leads','follow_up_tasks','activity_history','workspaces','workspace_requests']) assert.equal((await db.query(`select * from public.${table}`)).rows.length,0)
await save({...empty,leads:[{...lead,name:'Other owner'}]},0)
await asUser(userA)
assert.equal((await load()).data.leads[0].name,'Test Lead')
await denied(()=>save({...data,tasks:[{...data.tasks[0],leadId:'missing'}]},1),/foreign key/)
await denied(()=>save({...data,leads:[{...lead,email:'invalid'}]},1),/check constraint/)
await denied(()=>save({...data,leads:[lead,lead]},1),/unique constraint/)
await denied(()=>save({...data,tasks:[{...data.tasks[0],due:'2026-02-30'}]},1),/date\/time|out of range/)
assert.deepEqual(await load(),{revision:1,data})
const edited={...data,leads:[{...lead,status:'Qualified',name:'Updated'}],tasks:[{...data.tasks[0],completed:true}],activities:[...data.activities,{id:'event-2',leadId:lead.id,text:'Follow-up completed',at:'2026-10-18T01:00:00.000Z'}]}
await save(edited,1)
assert.equal((await load()).data.tasks[0].completed,true)
await save({...edited,tasks:[{...edited.tasks[0],completed:false}]},2)
assert.equal((await load()).data.tasks[0].completed,false)
await save(empty,3)
assert.deepEqual(await load(),{revision:4,data:empty})
await asUser(userB)
assert.equal((await load()).data.leads.length,1)
await db.exec(`select set_config('request.jwt.claims','{"is_anonymous":true}',false)`)
await denied(load,/internal account/)
await denied(()=>save(empty,1),/internal account/)
await asUser('')
await denied(load,/internal account/)
const persisted=await db.dumpDataDir()
await db.close()
db=new PGlite({loadDataDir:persisted})
await asUser(userB)
assert.equal((await load()).data.leads[0].name,'Other owner')
await db.close()
console.log('PASS: migration, database restart from saved image, round trips, edits, follow-ups, deletion/reset, idempotency, conflict detection, transaction rollback, validation, grants, RLS owner isolation, and unauthenticated RPC rejection.')
