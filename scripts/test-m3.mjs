import assert from 'node:assert/strict'
import { createHarness, actor } from '../tests/support/m3.ts'
const h=await createHarness()
const input={name:'  Test Person  ',email:' TEST@EXAMPLE.COM ',phone:'',company:'Example',service:'Consulting',message:'  A fictional test project.  '}
function request(id=crypto.randomUUID(),inquiry=input,extra={}){return new Request('https://functions.test/submit-inquiry',{method:'POST',headers:{Origin:'http://127.0.0.1:5175','Content-Type':'application/json'},body:JSON.stringify({requestId:id,inquiry,token:'test-token',website:'',...extra})})}
async function stored(){return (await h.db.query('select public.load_workspace() as snapshot')).rows[0].snapshot}
const id=crypto.randomUUID()
assert.equal((await h.handler(request(id))).status,200)
let snapshot=await stored()
assert.equal(snapshot.revision,1);assert.equal(snapshot.data.leads[0].name,'Test Person');assert.equal(snapshot.data.leads[0].email,'test@example.com');assert.equal(snapshot.data.leads[0].source,'Website');assert.match(snapshot.data.activities[0].text,/example-website/)
assert.equal((await h.handler(request(id))).status,200)
assert.equal((await stored()).data.leads.length,1);assert.equal(h.state.providerCalls.length,1)
assert.equal((await h.handler(request(id,{...input,message:'Changed'}))).status,409)
await assert.rejects(()=>h.db.query('select public.save_workspace($1::jsonb,0,$2::uuid)',[JSON.stringify({version:1,leads:[],tasks:[],activities:[]}),crypto.randomUUID()]),/another session/)
assert.equal((await h.handler(request(crypto.randomUUID(),{...input,email:'bad'}))).status,422)
assert.equal((await h.handler(request(crypto.randomUUID(),input,{website:'spam'}))).status,400)
assert.equal((await h.handler(new Request('https://functions.test',{method:'POST',headers:{Origin:'https://evil.example'}}))).status,403)
assert.equal((await h.handler(new Request('https://functions.test',{method:'GET',headers:{Origin:'http://127.0.0.1:5175'}}))).status,405)
assert.equal((await h.handler(new Request('https://functions.test',{method:'POST',headers:{Origin:'http://127.0.0.1:5175','Content-Type':'application/json'},body:'x'.repeat(17000)}))).status,400)
h.state.captchaSuccess=false;assert.equal((await h.handler(request())).status,400);h.state.captchaSuccess=true
h.state.captchaHost='evil.example';assert.equal((await h.handler(request())).status,400);h.state.captchaHost='127.0.0.1'
const secret=h.config.TURNSTILE_SECRET_KEY;delete h.config.TURNSTILE_SECRET_KEY;assert.equal((await h.handler(request())).status,503);h.config.TURNSTILE_SECRET_KEY=secret
h.state.providerStatus=500
const failedId=crypto.randomUUID();assert.equal((await h.handler(request(failedId))).status,200)
assert.equal((await stored()).data.leads.length,2)
assert.equal((await h.db.query('select status from leadflow_private.notification_outbox where request_id=$1',[failedId])).rows[0].status,'pending')
assert.equal((await h.worker(new Request('https://worker',{method:'POST'}))).status,401)
h.state.providerStatus=200
await h.db.exec("update leadflow_private.notification_outbox set next_attempt_at=now() where status='pending'")
const runWorker=()=>h.worker(new Request('https://worker',{method:'POST',headers:{'x-worker-secret':h.config.NOTIFICATION_WORKER_SECRET}}))
assert.equal((await runWorker()).status,200)
assert.equal((await h.db.query('select status from leadflow_private.notification_outbox where request_id=$1',[failedId])).rows[0].status,'accepted')
// An ambiguous timeout may already have sent the email; stable payload/key suppresses duplicates.
h.state.providerTimeout=true;const uncertainId=crypto.randomUUID();await h.handler(request(uncertainId))
h.state.providerTimeout=false;await h.db.exec("update leadflow_private.notification_outbox set next_attempt_at=now() where status='pending'")
await runWorker();assert.equal(h.state.accepted.size,3)
const attempts=h.state.providerCalls.filter(call=>call.key.endsWith(uncertainId));assert.equal(attempts.length,2);assert.equal(attempts[0].body,attempts[1].body)
h.state.providerStatus=422;const rejectedId=crypto.randomUUID();assert.equal((await h.handler(request(rejectedId))).status,200)
assert.equal((await h.db.query('select status from leadflow_private.notification_outbox where request_id=$1',[rejectedId])).rows[0].status,'failed')
h.state.providerStatus=500;const expiredId=crypto.randomUUID();await h.handler(request(expiredId))
await h.db.query("update leadflow_private.notification_outbox set first_attempt_at=now()-interval '24 hours',next_attempt_at=now() where request_id=$1",[expiredId])
const before=h.state.providerCalls.length;await runWorker();assert.equal(h.state.providerCalls.length,before)
assert.equal((await h.db.query('select status from leadflow_private.notification_outbox where request_id=$1',[expiredId])).rows[0].status,'uncertain')
assert.equal((await h.handler(request())).status,429) // five inquiries per email/hour
// Save/reset must not destroy durable deduplication receipts or notifications.
snapshot=await stored();await h.db.query('select public.save_workspace($1::jsonb,$2,$3::uuid)',[JSON.stringify(snapshot.data),snapshot.revision,crypto.randomUUID()])
assert.equal((await h.db.query('select count(*)::int as n from leadflow_private.inquiries')).rows[0].n,5)
assert.equal((await h.db.query('select count(*)::int as n from leadflow_private.notification_outbox')).rows[0].n,5)
// Client roles cannot call any privileged RPC or read the private queue.
for(const role of ['anon','authenticated']){
 await h.db.exec(`set role ${role}`)
 for(const sql of ["select * from leadflow_private.inquiries","select * from leadflow_private.notification_outbox","select * from leadflow_private.request_limits","select public.inquiry_rate_limit('x')","select public.claim_notification(null)","select public.finish_notification(null,null,'accepted',null,null)",`select public.receive_inquiry('${actor}','main',gen_random_uuid(),'{}','hash','{}')`])await assert.rejects(()=>h.db.query(sql),/permission denied/)
 await h.db.exec('reset role')
}
await h.db.exec('set role service_role');assert.equal((await h.db.query("select public.inquiry_rate_limit('service-check') as allowed")).rows[0].allowed,true);await h.db.exec('reset role')
for(let i=0;i<60;i++)assert.equal((await h.db.query("select public.inquiry_rate_limit('burst-test') as allowed")).rows[0].allowed,true)
assert.equal((await h.db.query("select public.inquiry_rate_limit('burst-test') as allowed")).rows[0].allowed,false)
// Missing email credentials must still preserve inquiries and pending notifications.
const resendKey=h.config.RESEND_API_KEY;delete h.config.RESEND_API_KEY
const pendingId=crypto.randomUUID();assert.equal((await h.handler(request(pendingId,{...input,email:'another@example.com'}))).status,200)
assert.equal((await h.db.query('select status from leadflow_private.notification_outbox where request_id=$1',[pendingId])).rows[0].status,'pending')
h.config.RESEND_API_KEY=resendKey
const claim=async()=> (await h.db.query('select public.claim_notification($1) as job',[pendingId])).rows[0].job
const leaseOne=await claim();assert.ok(leaseOne.lease_id);assert.equal(await claim(),null)
await h.db.query('update leadflow_private.notification_outbox set next_attempt_at=now() where request_id=$1',[pendingId])
const leaseTwo=await claim();assert.notEqual(leaseOne.lease_id,leaseTwo.lease_id)
await h.db.query("select public.finish_notification($1,$2,'accepted','stale',null)",[pendingId,leaseOne.lease_id])
assert.equal((await h.db.query('select status from leadflow_private.notification_outbox where request_id=$1',[pendingId])).rows[0].status,'sending')
await h.db.query("select public.finish_notification($1,$2,'accepted','current',null)",[pendingId,leaseTwo.lease_id])
// A separate website's 24-hour quota is independent of per-email quota.
await h.db.query("insert into leadflow_private.inquiries(request_id,workspace_id,website,payload_hash,email_hash) select gen_random_uuid(),$1,'quota-test','fixture','fixture' from generate_series(1,50)",[actor])
h.config.WEBSITE_ID='quota-test'
assert.equal((await h.handler(request(crypto.randomUUID(),{...input,email:'new@example.com'}))).status,429)
// WEBSITE_WORKSPACE_ID routes the form to a shared workspace and overrides the legacy WEBSITE_OWNER_ID.
await h.db.exec('set role authenticated');const team=(await h.db.query("select public.create_workspace('Agency team') as id")).rows[0].id;await h.db.exec('reset role')
h.config.WEBSITE_WORKSPACE_ID=team;h.config.WEBSITE_ID='team-website'
const teamId=crypto.randomUUID();assert.equal((await h.handler(request(teamId,{...input,email:'team@example.com'}))).status,200)
assert.equal((await h.db.query('select workspace_id from public.leads where id=$1',[teamId])).rows[0].workspace_id,team)
assert.equal((await h.db.query('select count(*)::int as n from public.leads where workspace_id=$1',[team])).rows[0].n,1)
h.config.WEBSITE_WORKSPACE_ID=crypto.randomUUID();assert.equal((await h.handler(request(crypto.randomUUID(),{...input,email:'nowhere@example.com'}))).status,503)
h.config.WEBSITE_WORKSPACE_ID='not-a-workspace';assert.equal((await h.handler(request())).status,503)
// Workspace form links: the key picks the workspace and its recipient; the legacy settings play no part.
const formOf=async workspace=>(await h.db.query('select id from leadflow_private.inquiry_forms where workspace_id=$1',[workspace])).rows[0].id
const [personalKey,teamKey]=[await formOf(actor),await formOf(team)]
await h.db.exec('set role authenticated');await h.db.query("select public.update_inquiry_form($1,null,'team-inbox@example.com')",[team]);await h.db.exec('reset role')
const outbox=async id=>(await h.db.query('select l.workspace_id,o.email from public.leads l join leadflow_private.notification_outbox o on o.request_id::text=l.id where l.id=$1',[id])).rows[0]
const personalId=crypto.randomUUID(),teamFormId=crypto.randomUUID()
assert.equal((await h.handler(request(personalId,{...input,email:'form-personal@example.com'},{form:personalKey}))).status,200)
assert.equal((await h.handler(request(teamFormId,{...input,email:'form-team@example.com'},{form:teamKey.toUpperCase()}))).status,200)
const [personalRow,teamRow]=[await outbox(personalId),await outbox(teamFormId)]
assert.equal(personalRow.workspace_id,actor);assert.deepEqual(personalRow.email.to,['owner@example.com']);assert.equal(personalRow.email.from,h.config.NOTIFICATION_FROM)
assert.equal(teamRow.workspace_id,team);assert.deepEqual(teamRow.email.to,['team-inbox@example.com']);assert.match(teamRow.email.text,/Workspace: Agency team/)
assert.equal(JSON.stringify([personalRow,teamRow]).includes(h.config.NOTIFICATION_TO),false,'Form notifications never use the deployment-wide inbox.')
assert.equal((await h.handler(request(teamFormId,{...input,email:'form-team@example.com'},{form:teamKey}))).status,200,'A retry through the same form is idempotent.')
for(const form of ['not-a-key',crypto.randomUUID(),actor,team])assert.equal((await h.handler(request(crypto.randomUUID(),{...input,email:'stray@example.com'},{form}))).status,404,`form ${form}`)
await h.db.close()
console.log('PASS M3: real SQL + Edge handlers, normalization, persistence, dashboard revision protection, idempotency, CAPTCHA/origin/body validation, quotas, privileged RPC isolation, provider failure/retry, duplicate email suppression, expired retry window, server-configured workspace routing, workspace form keys with per-workspace recipients. External providers simulated; no email sent.')
