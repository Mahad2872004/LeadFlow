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
await h.db.query("insert into leadflow_private.inquiries(request_id,owner_id,website,payload_hash,email_hash) select gen_random_uuid(),$1,'quota-test','fixture','fixture' from generate_series(1,50)",[actor])
h.config.WEBSITE_ID='quota-test'
assert.equal((await h.handler(request(crypto.randomUUID(),{...input,email:'new@example.com'}))).status,429)
await h.db.close()
console.log('PASS M3: real SQL + Edge handlers, normalization, persistence, dashboard revision protection, idempotency, CAPTCHA/origin/body validation, quotas, privileged RPC isolation, provider failure/retry, duplicate email suppression, expired retry window. External providers simulated; no email sent.')
